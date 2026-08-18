import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { collapsePath, createApp } from './mock-proxy.mjs';

// fetch() (undici) does not add an Origin header automatically, so tests
// that need origin-keying must set it explicitly.

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function withApp(opts, fn) {
  const { server } = createApp({ noSave: true, mocksPath: '/tmp/mock-proxy-test-unused.json', ...opts });
  const port = await listen(server);
  const base = `http://localhost:${port}`;
  try {
    await fn(base);
  } finally {
    await close(server);
  }
}

test('collapsePath collapses numeric and UUID segments', () => {
  assert.strictEqual(collapsePath('/api/members/42'), '/api/members/:id');
  assert.strictEqual(
    collapsePath('/api/members/550e8400-e29b-41d4-a716-446655440000'),
    '/api/members/:id'
  );
  assert.strictEqual(collapsePath('/api/members'), '/api/members');
  assert.strictEqual(collapsePath('/'), '/');
});

test('synthesis: GET on an unknown collection returns [] and registers a synthesized endpoint', async () => {
  await withApp({}, async (base) => {
    const res = await fetch(`${base}/api/widgets`, { headers: { Origin: 'http://localhost:3001' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), []);
    const endpoints = await (await fetch(`${base}/__mock/endpoints`)).json();
    const entry = endpoints.find((e) => e.pathPattern === '/api/widgets' && e.method === 'GET');
    assert.ok(entry, 'endpoint should be registered');
    assert.strictEqual(entry.source, 'synthesized');
  });
});

test('origin isolation: a POST from origin A is invisible to origin B', async () => {
  await withApp({}, async (base) => {
    await fetch(`${base}/api/members`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3001', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    const a = await (
      await fetch(`${base}/api/members`, { headers: { Origin: 'http://localhost:3001' } })
    ).json();
    const b = await (
      await fetch(`${base}/api/members`, { headers: { Origin: 'http://localhost:3002' } })
    ).json();
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 0);
  });
});

test('double-apply regression: same POST fired from two origins each yields exactly one item with the same id', async () => {
  await withApp({}, async (base) => {
    const postOnce = (origin) =>
      fetch(`${base}/api/members`, {
        method: 'POST',
        headers: { Origin: origin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      }).then((r) => r.json());

    const resultA = await postOnce('http://localhost:3001');
    const resultB = await postOnce('http://localhost:3002');
    assert.strictEqual(resultA.id, resultB.id);

    const a = await (
      await fetch(`${base}/api/members`, { headers: { Origin: 'http://localhost:3001' } })
    ).json();
    const b = await (
      await fetch(`${base}/api/members`, { headers: { Origin: 'http://localhost:3002' } })
    ).json();
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(a[0].id, b[0].id);
  });
});

test('POST /__mock/reset empties only the calling origin', async () => {
  await withApp({}, async (base) => {
    await fetch(`${base}/api/members`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3001', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    await fetch(`${base}/api/members`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3002', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grace' }),
    });
    await fetch(`${base}/__mock/reset`, { method: 'POST', headers: { Origin: 'http://localhost:3001' } });
    const a = await (
      await fetch(`${base}/api/members`, { headers: { Origin: 'http://localhost:3001' } })
    ).json();
    const b = await (
      await fetch(`${base}/api/members`, { headers: { Origin: 'http://localhost:3002' } })
    ).json();
    assert.strictEqual(a.length, 0);
    assert.strictEqual(b.length, 1);
  });
});

test('record mode: first GET returns and records the upstream body; later GETs replay it after upstream is gone', async () => {
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ members: [{ id: 1, name: 'Ada' }] }));
  });
  const upstreamPort = await listen(upstream);
  const target = `http://localhost:${upstreamPort}`;

  await withApp({ target }, async (base) => {
    const first = await (await fetch(`${base}/api/members`)).json();
    assert.deepStrictEqual(first, { members: [{ id: 1, name: 'Ada' }] });

    await close(upstream); // upstream is now gone

    const second = await (await fetch(`${base}/api/members`)).json();
    assert.deepStrictEqual(second, { members: [{ id: 1, name: 'Ada' }] });

    const endpoints = await (await fetch(`${base}/__mock/endpoints`)).json();
    const entry = endpoints.find((e) => e.pathPattern === '/api/members' && e.method === 'GET');
    assert.strictEqual(entry.source, 'recorded');
    assert.strictEqual(entry.stateful, true);
  });
});

test('preflight OPTIONS returns 204 and reflects Origin with Vary: Origin', async () => {
  await withApp({}, async (base) => {
    const res = await fetch(`${base}/anything`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3001', 'Access-Control-Request-Method': 'POST' },
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://localhost:3001');
    assert.strictEqual(res.headers.get('vary'), 'Origin');
  });
});

test('requests without an Origin header share the __no-origin__ store', async () => {
  await withApp({}, async (base) => {
    await fetch(`${base}/api/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    const second = await (await fetch(`${base}/api/members`)).json();
    assert.strictEqual(second.length, 1);
    assert.strictEqual(second[0].name, 'Ada');
  });
});
