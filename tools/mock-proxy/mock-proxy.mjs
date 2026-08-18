// mock-proxy: a standalone, dependency-free dev tool that auto-detects API
// endpoints from live traffic and serves suitable, origin-keyed mocks.
//
// Built for live-compare: two panes (leader + mirror) show two branch
// builds of the same app under test side by side and mirror every
// interaction between them. Both panes are real running apps making real
// API calls. Pointing both at ONE shared mock backend double-applies every
// mutation (once per pane) and desyncs the panes. This tool fixes that by
// keying mutable state by the request's `Origin` header, the same fix
// documented in ../../prototype-crossorigin/IMPLEMENT-ORIGIN-KEYED-MOCK.md.
//
// Usage:
//   node mock-proxy.mjs --port 4500 [--target http://localhost:8080] \
//     [--mocks ./mocks.json] [--no-save]
//
// Zero dependencies: node: built-ins only, so this folder can be copied
// whole into any app's dev tooling, the same vendoring model as the
// synced-preview component itself.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^[0-9]+$/;

// ---------- path pattern collapsing ----------

/** Collapse numeric-id and UUID path segments to `:id`. Query strings are
 * not part of `path` (callers strip them before calling this). */
export function collapsePath(path) {
  if (path === '' || path === '/') return path || '/';
  const segments = path.split('/');
  const collapsed = segments.map((seg) => {
    if (seg === '') return seg;
    if (DIGITS_RE.test(seg) || UUID_RE.test(seg)) return ':id';
    return seg;
  });
  return collapsed.join('/');
}

function isItemPattern(pattern) {
  const segs = pattern.split('/');
  return segs[segs.length - 1] === ':id';
}

function collectionOf(pattern) {
  if (!isItemPattern(pattern)) return pattern;
  const segs = pattern.split('/');
  segs.pop();
  return segs.join('/') || '/';
}

function lastSegment(path) {
  const segs = path.split('/').filter(Boolean);
  return segs[segs.length - 1];
}

// ---------- registry factory ----------

export function createRegistry() {
  // /__mock/endpoints listing: keyed "METHOD pathPattern" -> entry.
  const endpoints = new Map();
  // Collection metadata for array-shaped (or single-array-prop) resources:
  // collectionPath -> { arrayKey, baselineItems, source, contentType }.
  const collections = new Map();

  function registerEndpoint(method, pathPattern, patch) {
    const key = `${method} ${pathPattern}`;
    const existing = endpoints.get(key);
    const entry = existing || {
      method,
      pathPattern,
      hits: 0,
      status: 200,
      contentType: 'application/json; charset=utf-8',
      source: 'synthesized',
      stateful: false,
      body: null,
    };
    Object.assign(entry, patch);
    entry.hits += 1;
    endpoints.set(key, entry);
    return entry;
  }

  function touchEndpoint(method, pathPattern) {
    const key = `${method} ${pathPattern}`;
    const entry = endpoints.get(key);
    if (entry) entry.hits += 1;
    return entry;
  }

  function list() {
    return [...endpoints.values()]
      .map((e) => ({
        method: e.method,
        pathPattern: e.pathPattern,
        hits: e.hits,
        source: e.source,
        status: e.status,
        contentType: e.contentType,
        stateful: e.stateful,
      }))
      .sort((a, b) => (a.pathPattern + a.method).localeCompare(b.pathPattern + b.method));
  }

  return { endpoints, collections, registerEndpoint, touchEndpoint, list };
}

// ---------- origin-keyed mutable state (adapted from origin-keyed-store.mjs) ----------
// Rules (see IMPLEMENT-ORIGIN-KEYED-MOCK.md): key by the Origin header only
// (requests with no Origin share '__no-origin__'); every stateful read AND
// write goes through this accessor; never deduplicate requests.

export function createOriginStore() {
  const stores = new Map(); // originKey -> Map<collectionPath, {items, nextId}>

  function originKeyFor(req) {
    return req.headers.origin || '__no-origin__';
  }

  function collectionState(originKey, collectionPath, baselineItems) {
    if (!stores.has(originKey)) stores.set(originKey, new Map());
    const perOrigin = stores.get(originKey);
    if (!perOrigin.has(collectionPath)) {
      const items = structuredClone(baselineItems || []);
      const maxId = items.reduce((m, it) => {
        const n = Number(it && it.id);
        return Number.isFinite(n) && n > m ? n : m;
      }, 0);
      perOrigin.set(collectionPath, { items, nextId: maxId + 1 });
    }
    return perOrigin.get(collectionPath);
  }

  function resetOrigin(originKey) {
    stores.delete(originKey);
  }

  function resetAll() {
    stores.clear();
  }

  return { stores, originKeyFor, collectionState, resetOrigin, resetAll };
}

// ---------- JSON body helpers ----------

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf) {
  if (!buf || buf.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false, value: undefined };
  }
}

function sendJson(res, status, obj, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

// Detect array-shaped bodies: root array, or an object with exactly one
// array-valued property (the demo's `{ members: [...] }` shape).
function detectArrayShape(value) {
  if (Array.isArray(value)) return { arrayKey: null, items: value };
  if (value && typeof value === 'object') {
    const arrayProps = Object.keys(value).filter((k) => Array.isArray(value[k]));
    if (arrayProps.length === 1) return { arrayKey: arrayProps[0], items: value[arrayProps[0]] };
  }
  return null;
}

function wrapItems(arrayKey, items) {
  if (arrayKey === null) return items;
  return { [arrayKey]: items };
}

// ---------- upstream proxy (record mode) ----------

function proxyUpstream(targetBase, req, bodyBuf) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(req.url, targetBase);
    const isHttps = targetUrl.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    const upstreamReq = doRequest(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
        timeout: 10000,
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          resolve({
            status: upstreamRes.statusCode,
            contentType: upstreamRes.headers['content-type'] || 'application/octet-stream',
            body: Buffer.concat(chunks),
          });
        });
        upstreamRes.on('error', reject);
      }
    );
    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('upstream request timed out'));
    });
    upstreamReq.on('error', reject);
    if (bodyBuf && bodyBuf.length > 0) upstreamReq.write(bodyBuf);
    upstreamReq.end();
  });
}

// ---------- persistence ----------

function saveRegistry(registry, mocksPath) {
  const data = {
    endpoints: registry.list().map((e) => {
      const full = registry.endpoints.get(`${e.method} ${e.pathPattern}`);
      return { ...e, body: full.body };
    }),
    collections: Object.fromEntries(
      [...registry.collections.entries()].sort(([a], [b]) => a.localeCompare(b))
    ),
  };
  const tmp = mocksPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, mocksPath);
}

function loadRegistry(registry, mocksPath) {
  if (!existsSync(mocksPath)) return;
  try {
    const data = JSON.parse(readFileSync(mocksPath, 'utf8'));
    for (const e of data.endpoints || []) {
      registry.endpoints.set(`${e.method} ${e.pathPattern}`, { ...e });
    }
    for (const [k, v] of Object.entries(data.collections || {})) {
      registry.collections.set(k, v);
    }
  } catch (err) {
    console.warn(`mock-proxy: failed to load ${mocksPath}: ${err.message}`);
  }
}

// ---------- request handling ----------

async function handleRequest(req, res, ctx) {
  const { registry, originStore, target, noSave, mocksPath } = ctx;
  const url = new URL(req.url, 'http://internal');
  const pathname = url.pathname;

  // CORS on every response (rule: reflect Origin, not '*'; Vary: Origin).
  const originHeader = req.headers.origin;
  if (originHeader) {
    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Admin routes, never proxied.
  if (pathname.startsWith('/__mock/')) {
    const originKey = originStore.originKeyFor(req);
    if (pathname === '/__mock/endpoints' && req.method === 'GET') {
      sendJson(res, 200, registry.list());
      return;
    }
    if (pathname === '/__mock/reset' && req.method === 'POST') {
      originStore.resetOrigin(originKey);
      sendJson(res, 200, { reset: originKey });
      return;
    }
    if (pathname === '/__mock/reset-all' && req.method === 'POST') {
      originStore.resetAll();
      sendJson(res, 200, { reset: 'all' });
      return;
    }
    sendJson(res, 404, { error: 'unknown admin route' });
    return;
  }

  const method = req.method;
  const bodyBuf = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    ? await readRequestBody(req)
    : Buffer.alloc(0);

  const pattern = collapsePath(pathname);
  const itemShaped = isItemPattern(pattern);
  const collectionPath = collectionOf(pattern);
  const rawId = itemShaped ? lastSegment(pathname) : null;
  const originKey = originStore.originKeyFor(req);
  const endpointKey = `${method} ${pattern}`;

  const persistSoon = () => {
    if (!noSave) saveRegistry(registry, mocksPath);
  };

  // ---- GET ----
  if (method === 'GET') {
    if (itemShaped) {
      const coll = registry.collections.get(collectionPath);
      if (coll) {
        const state = originStore.collectionState(originKey, collectionPath, coll.baselineItems);
        const item = state.items.find((it) => String(it.id) === String(rawId));
        registry.registerEndpoint(method, pattern, {
          status: 200,
          contentType: coll.contentType,
          source: coll.source,
          stateful: true,
          body: null,
        });
        sendJson(res, 200, item || { id: rawId });
        return;
      }
      const known = registry.endpoints.get(endpointKey);
      if (known) {
        registry.touchEndpoint(method, pattern);
        res.writeHead(known.status, { 'content-type': known.contentType });
        res.end(known.body === null ? '' : known.body);
        return;
      }
      if (target) {
        try {
          const up = await proxyUpstream(target, req, bodyBuf);
          registry.registerEndpoint(method, pattern, {
            status: up.status,
            contentType: up.contentType,
            source: 'recorded',
            stateful: false,
            body: up.body.toString('utf8'),
          });
          res.writeHead(up.status, { 'content-type': up.contentType });
          res.end(up.body);
        } catch (err) {
          sendJson(res, 502, { error: 'upstream request failed', detail: err.message });
        }
        return;
      }
      registry.registerEndpoint(method, pattern, {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        source: 'synthesized',
        stateful: false,
        body: null,
      });
      sendJson(res, 200, { id: rawId });
      return;
    }

    // Collection-shaped GET.
    const coll = registry.collections.get(pattern);
    if (coll) {
      const state = originStore.collectionState(originKey, pattern, coll.baselineItems);
      registry.registerEndpoint(method, pattern, {
        status: 200,
        contentType: coll.contentType,
        source: coll.source,
        stateful: true,
        body: null,
      });
      sendJson(res, 200, wrapItems(coll.arrayKey, state.items), coll.contentType);
      return;
    }
    const known = registry.endpoints.get(endpointKey);
    if (known) {
      registry.touchEndpoint(method, pattern);
      res.writeHead(known.status, { 'content-type': known.contentType });
      res.end(known.body === null ? '' : known.body);
      return;
    }
    if (target) {
      try {
        const up = await proxyUpstream(target, req, bodyBuf);
        const parsed = parseJsonBody(up.body);
        const shape = parsed.ok ? detectArrayShape(parsed.value) : null;
        if (shape) {
          registry.collections.set(pattern, {
            arrayKey: shape.arrayKey,
            baselineItems: shape.items,
            source: 'recorded',
            contentType: up.contentType,
          });
          registry.registerEndpoint(method, pattern, {
            status: up.status,
            contentType: up.contentType,
            source: 'recorded',
            stateful: true,
            body: null,
          });
        } else {
          registry.registerEndpoint(method, pattern, {
            status: up.status,
            contentType: up.contentType,
            source: 'recorded',
            stateful: false,
            body: up.body.toString('utf8'),
          });
        }
        res.writeHead(up.status, { 'content-type': up.contentType });
        res.end(up.body);
      } catch (err) {
        sendJson(res, 502, { error: 'upstream request failed', detail: err.message });
      }
      return;
    }
    // Synthesize: treat as a fresh empty collection.
    registry.collections.set(pattern, {
      arrayKey: null,
      baselineItems: [],
      source: 'synthesized',
      contentType: 'application/json; charset=utf-8',
    });
    registry.registerEndpoint(method, pattern, {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      source: 'synthesized',
      stateful: true,
      body: null,
    });
    const state = originStore.collectionState(originKey, pattern, []);
    sendJson(res, 200, state.items);
    return;
  }

  // ---- Non-GET: parse JSON body once ----
  const parsedBody = parseJsonBody(bodyBuf);

  // ---- POST ----
  if (method === 'POST') {
    const cp = itemShaped ? collectionPath : pattern;
    let coll = registry.collections.get(cp);
    const known = registry.endpoints.get(`POST ${pattern}`);
    if (coll) {
      const state = originStore.collectionState(originKey, cp, coll.baselineItems);
      if (!parsedBody.ok) {
        registry.registerEndpoint('POST', pattern, { status: 204, stateful: true, source: coll.source, body: null });
        res.writeHead(204);
        res.end();
        return;
      }
      const newItem = { ...(parsedBody.value || {}), id: state.nextId };
      state.nextId += 1;
      state.items.push(newItem);
      registry.registerEndpoint('POST', pattern, {
        status: 201,
        contentType: coll.contentType,
        source: coll.source,
        stateful: true,
        body: null,
      });
      persistSoon();
      sendJson(res, 201, newItem, coll.contentType);
      return;
    }
    if (known) {
      registry.touchEndpoint('POST', pattern);
      res.writeHead(known.status, { 'content-type': known.contentType });
      res.end(known.body === null ? '' : known.body);
      return;
    }
    if (target) {
      try {
        const up = await proxyUpstream(target, req, bodyBuf);
        registry.registerEndpoint('POST', pattern, {
          status: up.status,
          contentType: up.contentType,
          source: 'recorded',
          stateful: false,
          body: up.body.toString('utf8'),
        });
        res.writeHead(up.status, { 'content-type': up.contentType });
        res.end(up.body);
      } catch (err) {
        sendJson(res, 502, { error: 'upstream request failed', detail: err.message });
      }
      return;
    }
    if (!parsedBody.ok) {
      registry.registerEndpoint('POST', pattern, { status: 204, stateful: false, source: 'synthesized', body: null });
      res.writeHead(204);
      res.end();
      return;
    }
    // Establish this as a fresh stateful collection, then apply the POST.
    registry.collections.set(cp, {
      arrayKey: null,
      baselineItems: [],
      source: 'synthesized',
      contentType: 'application/json; charset=utf-8',
    });
    const state = originStore.collectionState(originKey, cp, []);
    const newItem = { ...(parsedBody.value || {}), id: state.nextId };
    state.nextId += 1;
    state.items.push(newItem);
    registry.registerEndpoint('POST', pattern, {
      status: 201,
      contentType: 'application/json; charset=utf-8',
      source: 'synthesized',
      stateful: true,
      body: null,
    });
    sendJson(res, 201, newItem);
    return;
  }

  // ---- PUT / PATCH ----
  if (method === 'PUT' || method === 'PATCH') {
    const cp = itemShaped ? collectionPath : pattern;
    const coll = registry.collections.get(cp);
    if (itemShaped && coll) {
      const state = originStore.collectionState(originKey, cp, coll.baselineItems);
      const idx = state.items.findIndex((it) => String(it.id) === String(rawId));
      let merged;
      if (idx >= 0) {
        merged = { ...state.items[idx], ...(parsedBody.ok ? parsedBody.value : {}), id: state.items[idx].id };
        state.items[idx] = merged;
      } else {
        merged = { ...(parsedBody.ok ? parsedBody.value : {}), id: rawId };
        state.items.push(merged);
      }
      registry.registerEndpoint(method, pattern, {
        status: 200,
        contentType: coll.contentType,
        source: coll.source,
        stateful: true,
        body: null,
      });
      persistSoon();
      sendJson(res, 200, merged, coll.contentType);
      return;
    }
    const known = registry.endpoints.get(endpointKey);
    if (known) {
      registry.touchEndpoint(method, pattern);
      res.writeHead(known.status, { 'content-type': known.contentType });
      res.end(known.body === null ? '' : known.body);
      return;
    }
    if (target) {
      try {
        const up = await proxyUpstream(target, req, bodyBuf);
        registry.registerEndpoint(method, pattern, {
          status: up.status,
          contentType: up.contentType,
          source: 'recorded',
          stateful: false,
          body: up.body.toString('utf8'),
        });
        res.writeHead(up.status, { 'content-type': up.contentType });
        res.end(up.body);
      } catch (err) {
        sendJson(res, 502, { error: 'upstream request failed', detail: err.message });
      }
      return;
    }
    if (!parsedBody.ok) {
      registry.registerEndpoint(method, pattern, { status: 204, stateful: false, source: 'synthesized', body: null });
      res.writeHead(204);
      res.end();
      return;
    }
    registry.registerEndpoint(method, pattern, {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      source: 'synthesized',
      stateful: false,
      body: null,
    });
    sendJson(res, 200, parsedBody.value ?? {});
    return;
  }

  // ---- DELETE ----
  if (method === 'DELETE') {
    const cp = itemShaped ? collectionPath : pattern;
    const coll = registry.collections.get(cp);
    if (itemShaped && coll) {
      const state = originStore.collectionState(originKey, cp, coll.baselineItems);
      const idx = state.items.findIndex((it) => String(it.id) === String(rawId));
      if (idx >= 0) state.items.splice(idx, 1);
      registry.registerEndpoint(method, pattern, {
        status: 204,
        contentType: coll.contentType,
        source: coll.source,
        stateful: true,
        body: null,
      });
      persistSoon();
      res.writeHead(204);
      res.end();
      return;
    }
    const known = registry.endpoints.get(endpointKey);
    if (known) {
      registry.touchEndpoint(method, pattern);
      res.writeHead(known.status, { 'content-type': known.contentType });
      res.end(known.body === null ? '' : known.body);
      return;
    }
    if (target) {
      try {
        const up = await proxyUpstream(target, req, bodyBuf);
        registry.registerEndpoint(method, pattern, {
          status: up.status,
          contentType: up.contentType,
          source: 'recorded',
          stateful: false,
          body: up.body.toString('utf8'),
        });
        res.writeHead(up.status, { 'content-type': up.contentType });
        res.end(up.body);
      } catch (err) {
        sendJson(res, 502, { error: 'upstream request failed', detail: err.message });
      }
      return;
    }
    registry.registerEndpoint(method, pattern, {
      status: 204,
      contentType: 'application/json; charset=utf-8',
      source: 'synthesized',
      stateful: false,
      body: null,
    });
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 405, { error: 'method not allowed' });
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { port: undefined, target: undefined, mocks: './mocks.json', noSave: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--mocks') args.mocks = argv[++i];
    else if (a === '--no-save') args.noSave = true;
  }
  return args;
}

export function createApp({ target, mocksPath = './mocks.json', noSave = false } = {}) {
  const registry = createRegistry();
  const originStore = createOriginStore();
  if (existsSync(mocksPath)) loadRegistry(registry, mocksPath);
  const ctx = { registry, originStore, target, noSave, mocksPath };
  const server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error', detail: err.message });
      else res.end();
    });
  });
  return { server, registry, originStore, ctx };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.port || !Number.isInteger(args.port)) {
    console.error('mock-proxy: --port <integer> is required');
    process.exit(1);
  }
  const mocksPath = resolvePath(args.mocks);
  const { server, registry } = createApp({
    target: args.target,
    mocksPath,
    noSave: args.noSave,
  });

  let saveInterval;
  if (!args.noSave) {
    saveInterval = setInterval(() => saveRegistry(registry, mocksPath), 30000);
    saveInterval.unref();
  }

  function shutdown() {
    if (!args.noSave) {
      try {
        saveRegistry(registry, mocksPath);
      } catch (err) {
        console.warn(`mock-proxy: failed to save ${mocksPath}: ${err.message}`);
      }
    }
    if (saveInterval) clearInterval(saveInterval);
    server.close(() => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(args.port, () => {
    console.log('mock-proxy:');
    console.log(`  url    http://localhost:${args.port}/`);
    console.log(`  mode   ${args.target ? `record → ${args.target}` : 'synthesize'}`);
    console.log(`  mocks  ${mocksPath}${args.noSave ? ' (not persisted, --no-save)' : ''}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
