# Plan 002: Add a mock proxy server that auto-detects endpoints from live traffic and serves suitable, origin-keyed mocks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f0a55aa..HEAD -- tools/ prototype-crossorigin/origin-keyed-store.mjs prototype-crossorigin/IMPLEMENT-ORIGIN-KEYED-MOCK.md`
> If any of those paths changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (all new files; nothing existing is modified except `plans/README.md`)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `f0a55aa`, 2026-08-18

## Why this matters

This repo builds **synced-preview**: a React component that shows two branch
builds of the same app side by side and mirrors every interaction from a
leader pane into a mirror pane ("live-compare"). Both panes are real running
apps making real API calls. Today, pointing both panes at a real backend or a
hand-written mock server has two problems: (1) hand-maintaining mocks for
every endpoint the app calls is tedious and silently rots as the app evolves,
and (2) a shared stateful backend desyncs the panes, because every mirrored
interaction fires the same mutation from BOTH panes and it applies twice
(measured and documented in
`prototype-crossorigin/IMPLEMENT-ORIGIN-KEYED-MOCK.md`).

This plan adds a **mock proxy server**: a standalone, dependency-free Node
dev tool. The apps under test point their API base URL at it. It
auto-detects endpoints by observing the traffic that actually flows through
it — recording real responses when an upstream backend is configured,
synthesizing plausible responses when one is not — and then serves those
mocks deterministically, with mutable state keyed per requesting origin so
the two live-compare panes stay in lockstep.

**Interpretation note (assumption made by the plan author)**: "auto-detects
what endpoints are in the running applications" is implemented as
*runtime traffic observation* (the proxy learns every endpoint the running
apps actually call, on first call), NOT static scanning of app source code.
Rationale: the apps under test run on a different machine than this repo, may
be minified builds, and traffic observation captures real request/response
shapes that source scanning cannot. If the operator wanted static scanning,
STOP condition 5 applies.

## Current state

Relevant files (read all three before writing code):

- `prototype-crossorigin/origin-keyed-store.mjs` — the liftable origin-keyed
  state pattern. 20 lines. You will copy its logic (not import across
  folders — the tool must be self-contained):

  ```js
  // origin-keyed-store.mjs:12-20
  export function createMockStore({ shared = false, seed }) {
    const stores = new Map(); // origin -> state
    function storeFor(req) {
      const key = shared ? '__shared__' : (req.headers.origin || '__no-origin__');
      if (!stores.has(key)) stores.set(key, seed());
      return stores.get(key);
    }
    return { storeFor, stores, mode: shared ? 'shared' : 'origin-keyed' };
  }
  ```

- `prototype-crossorigin/IMPLEMENT-ORIGIN-KEYED-MOCK.md` — the rules the
  mock side must honor. The load-bearing ones, quoted:
  - "Key the mock server's mutable state by the **`Origin` request header**,
    creating a fresh copy of the seed state the first time a new origin
    appears."
  - "**Keep CORS reflecting the origin.** The mock must send
    `Access-Control-Allow-Origin: <the request's Origin>` (plus
    `Vary: Origin`), not `*` ... Handle `OPTIONS` preflight with 204."
  - "**Do not key by anything else.** Not IP ... not User-Agent ... not
    Referer path ... `Origin` header only."
  - "Requests WITHOUT an `Origin` header (curl, server-side calls ...) all
    share the `'__no-origin__'` store. That is acceptable."
  - "Do not deduplicate 'identical' requests inside the mock — the two
    panes' requests are supposed to both apply, once per store."

- `prototype-crossorigin/local-demo.mjs` — style exemplar for dev-server
  tooling in this repo: plain `node:http`, ESM `.mjs`, no framework, ports
  hard-coded as constants, `console.log` startup banner (see its lines
  141–210). Match this style.

Repo conventions that apply:

- `CONTEXT.md` vocabulary — use these terms exactly in code comments and
  docs: **app under test** (a page shown in a pane), **pane**, **leader /
  mirror**, **host**, **agent**. The proxy serves the apps under test; it is
  not part of the Host component.
- The synced-preview component itself must stay self-contained with peer
  deps only (`CLAUDE.md`). The mock proxy is therefore a **separate dev
  tool**, not part of the component, and must itself be dependency-free
  (Node 18+ built-ins only) so it can be copied to the work machine as a
  single folder, the same vendoring model the component uses.
- No build/lint/test tooling exists at the repo root. Use Node's built-in
  `node:test` runner; do not add npm dev-dependencies.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Node version check | `node --version` | v18 or later |
| Run the proxy | `node tools/mock-proxy/mock-proxy.mjs --port 4500` | banner printed, process stays up |
| Tests | `node --test tools/mock-proxy/` | all tests pass, exit 0 |

(No install step: the tool has zero dependencies.)

## Scope

**In scope** (the only files you should create/modify):

- `tools/mock-proxy/mock-proxy.mjs` (create) — the server + CLI
- `tools/mock-proxy/mock-proxy.test.mjs` (create) — tests
- `tools/mock-proxy/README.md` (create) — usage doc
- `plans/README.md` (status row update only)

**Out of scope** (do NOT touch, even though they look related):

- `prototype-crossorigin/**` — throwaway prototype; do not import from it,
  do not extend `local-demo.mjs` to use the new proxy.
- `prototype-synced-preview.html` / `.app.jsx` — frozen research reference.
- Injecting `sync-agent.js` into proxied HTML responses (the "inject via the
  mock proxy" idea in `prototype-crossorigin/README-TEST.md`). This proxy
  fronts the apps' **API**, not their HTML, so injection does not belong
  here. Deferred — see Maintenance notes.
- `docs/research.md` — evidence rules make edits expensive; nothing here
  changes its findings.
- Any change to the component (`SyncedPreviewProto.jsx`, `sync-agent.js`).

## Git workflow

- Branch: `advisor/002-mock-proxy-auto-detect`
- Commit per step; message style: short imperative summary line, matching
  `git log` (e.g. "Origin-keyed mock store: fix + demo + implementation
  brief"). No conventional-commit prefixes.
- Do NOT push or open a PR unless the operator instructed it.

## Design (what you are building)

One file, `tools/mock-proxy/mock-proxy.mjs`, a CLI:

```
node mock-proxy.mjs --port 4500 [--target http://localhost:8080] [--mocks ./mocks.json] [--no-save]
```

Request handling order, for every incoming request:

1. **Admin routes** (path prefix `/__mock/`, never proxied):
   - `GET /__mock/endpoints` → JSON list of detected endpoints
     (`method`, `pathPattern`, `hits`, `source: "recorded"|"synthesized"`,
     `status`, `contentType`).
   - `POST /__mock/reset` → reset the **calling origin's** mutable state
     only (per brief rule 2). `POST /__mock/reset-all` → reset every
     origin's state.
2. **CORS**: on every response, reflect `Origin` (`Access-Control-Allow-Origin:
   <origin>`, `Vary: Origin`); answer `OPTIONS` with 204 and permissive
   allow-methods/headers. (Quoted rules in Current state.)
3. **Known endpoint** (matches a registered path pattern): serve the mock
   through the origin-keyed state layer (below).
4. **Unknown endpoint, `--target` set**: proxy the request upstream
   (stream method, path, query, headers minus `host`, body), return the
   real response to the client unchanged, and **record** it: register the
   endpoint (pattern, status, content-type, response body as the mock
   template). This is auto-detection in record mode.
5. **Unknown endpoint, no `--target`**: **synthesize** a response and
   register it. Heuristics (keep them exactly this simple):
   - `GET` on a collection-shaped path (last segment not an `:id`) →
     `200 []`.
   - `GET` on an item-shaped path (last segment matched `:id`) →
     `200 {"id": "<the id>"}` — or the matching item from origin state if
     the collection was seen before.
   - `POST` → `201`, echo the JSON request body (or `{}`) with an added
     `"id"` (monotonic counter per collection).
   - `PUT`/`PATCH` → `200`, echo body merged over the stored item if one
     exists, else echo body.
   - `DELETE` → `204`, empty body.
   - Non-JSON request bodies → respond `204` for mutations, `200 {}` for GET.
   Synthesized endpoints are marked `source: "synthesized"` so the operator
   can review and hand-edit them in the mocks file.

**Path pattern collapsing** (what makes "endpoints" finite): split the path
on `/`; replace any segment that is all-digits or a UUID
(`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) with
`:id`. `/api/members/42` and `/api/members/7` are one endpoint
`GET /api/members/:id`. Query strings are ignored for matching (recorded
with the first sample only).

**Origin-keyed state layer** (what makes mocks "suitable" for live-compare):
copy the `createMockStore` pattern verbatim into the file. Seed for each new
origin = deep copy (`structuredClone`) of the recorded/synthesized baseline
per endpoint. Mutating methods (`POST`/`PUT`/`PATCH`/`DELETE`) on a
registered collection endpoint mutate the calling origin's copy:
POST appends, PUT/PATCH merges by `id`, DELETE removes by `id`. GETs read
the origin's copy. This makes one click in the leader pane and its mirrored
replay each apply exactly once to their own pane's state — the panes render
identical results. Never deduplicate requests (quoted rule).

State-layer applicability: only apply the mutable-collection behavior when
the endpoint's recorded/synthesized GET body is a JSON array, or an object
with exactly one array-valued property (e.g. `{"members": [...]}` — the
demo's shape); serve everything else verbatim (stateless), because guessing
mutation semantics for arbitrary shapes produces wrong mocks. Record which
behavior each endpoint got in `/__mock/endpoints` (`stateful: true|false`).

**Persistence**: on exit (SIGINT) and every 30 s, write the endpoint
registry to the `--mocks` file (default `./mocks.json`, pretty-printed,
stable key order so it diffs cleanly). On startup, load it if present —
recorded endpoints survive restarts and can be hand-edited. `--no-save`
disables writing. Per-origin mutable state is NOT persisted (it is session
state).

## Steps

### Step 1: Scaffold the tool and CLI

Create `tools/mock-proxy/mock-proxy.mjs`. Parse `--port` (required, integer),
`--target` (optional URL), `--mocks` (optional path, default `./mocks.json`),
`--no-save`. Use only `node:` built-ins (`http`, `fs`, `path`, `url`,
`process`). Start an `http` server; implement the CORS layer and the two
admin routes with an empty registry; print a startup banner in the
`local-demo.mjs` style (proxy URL, mode: `record → <target>` or
`synthesize`, mocks file path).

**Verify**: `node tools/mock-proxy/mock-proxy.mjs --port 4500 & sleep 1 && curl -s http://localhost:4500/__mock/endpoints` → `[]`; then
`curl -si -X OPTIONS http://localhost:4500/anything -H 'Origin: http://localhost:3001' -H 'Access-Control-Request-Method: POST' | head -5` → `204` with `Access-Control-Allow-Origin: http://localhost:3001`. Kill the server.

### Step 2: Path pattern collapsing + endpoint registry

Implement `collapsePath(path)` and the registry: `Map` keyed by
`METHOD pathPattern`, values `{ method, pathPattern, status, contentType,
body, source, hits, stateful }`. Export `collapsePath` and the registry
factory as named exports so tests can import them without starting a server
(guard server startup with the standard
`if (process.argv[1] === fileURLToPath(import.meta.url))` idiom).

**Verify**: `node --test tools/mock-proxy/` after writing the Step 2 tests
from the Test plan → those tests pass.

### Step 3: Synthesis mode (no `--target`)

Implement handling order items 3 and 5 with the synthesis heuristics and the
origin-keyed state layer (copy `createMockStore` in, adapted: seed is built
per endpoint baseline).

**Verify** (server running with `--port 4500 --no-save`, no `--target`):

```sh
curl -s http://localhost:4500/api/members -H 'Origin: http://localhost:3001'          # []
curl -s -X POST http://localhost:4500/api/members -H 'Origin: http://localhost:3001' \
  -H 'content-type: application/json' -d '{"name":"Ada"}'                             # {"name":"Ada","id":1}
curl -s http://localhost:4500/api/members -H 'Origin: http://localhost:3001'          # [{"name":"Ada","id":1}]
curl -s http://localhost:4500/api/members -H 'Origin: http://localhost:3002'          # []  ← MUST differ (origin isolation)
curl -s http://localhost:4500/__mock/endpoints | head -c 400                          # two endpoints, source "synthesized"
```

### Step 4: Record mode (`--target` set)

Implement handling order item 4: stream-proxy unknown endpoints upstream,
record the response as the endpoint's baseline. Known endpoints are served
from the registry (do NOT re-proxy once recorded — deterministic replay is
the point; the operator deletes an entry from the mocks file to re-record).
If the upstream request fails (connection refused / timeout after 10 s),
return `502` with a JSON error body and do not register anything.

**Verify**: start a throwaway upstream
(`node -e 'require("http").createServer((q,s)=>{s.setHeader("content-type","application/json");s.end(JSON.stringify({members:[{id:1,name:"Ada"}]}))}).listen(4599)'`),
run the proxy with `--target http://localhost:4599 --port 4500 --no-save`, then:

```sh
curl -s http://localhost:4500/api/members   # {"members":[{"id":1,"name":"Ada"}]}
# kill the upstream, then:
curl -s http://localhost:4500/api/members   # same body — served from the recording, upstream gone
curl -s http://localhost:4500/__mock/endpoints | head -c 300   # source "recorded", stateful true
```

### Step 5: Persistence

Implement load-on-start / save-on-exit-and-interval of the registry to the
mocks file. Atomic write (write temp file, rename).

**Verify**: run with `--mocks /tmp/mocks-test.json` (no `--no-save`), hit one
endpoint, Ctrl-C (or SIGTERM), then `cat /tmp/mocks-test.json` → contains
that endpoint. Restart with the same flag, `curl -s http://localhost:4500/__mock/endpoints` → endpoint present before any traffic.

### Step 6: README

Write `tools/mock-proxy/README.md`: what it is (one paragraph, using the
CONTEXT.md terms), the CLI flags, the two modes, how live-compare uses it
(both apps under test set their API base URL to the proxy; each pane's
requests carry its own `Origin`, so state stays per-pane), the admin routes,
the mocks-file format with a short example, and the limits (see Maintenance
notes list — copy it there in user-facing wording).

**Verify**: file exists; every CLI flag it documents appears in
`mock-proxy.mjs` (`grep -o '\-\-[a-z-]*' tools/mock-proxy/README.md | sort -u` vs the parsed flags).

## Test plan

`tools/mock-proxy/mock-proxy.test.mjs`, Node built-in runner
(`import { test } from 'node:test'; import assert from 'node:assert'`).
No existing test in the repo to model after — this file becomes the exemplar.
Unit-test pure functions by import; integration-test the server by starting
it on an ephemeral port (`server.listen(0)`) inside the test and using
global `fetch` with an explicit `Origin` header (undici's fetch does not add
one automatically; set it manually).

Cases (minimum):

1. `collapsePath`: `/api/members/42` → `/api/members/:id`; UUID segment
   collapses; `/api/members` unchanged; root `/` unchanged.
2. Synthesis: GET unknown collection → `[]` and endpoint registered as
   `synthesized`.
3. Origin isolation (the regression this tool exists to prevent): POST from
   origin A then GET from A shows 1 item, GET from origin B shows 0 items.
4. Same POST fired twice from two different origins (simulating leader +
   mirror) → each origin's GET shows exactly 1 item with the same `id`.
5. Per-origin reset: `POST /__mock/reset` with Origin A empties A only.
6. Record mode: with a stub upstream server in the test, first GET returns
   upstream body and registers it; after upstream closes, GET still returns
   the recorded body.
7. Preflight: `OPTIONS` → 204, `Access-Control-Allow-Origin` echoes, `Vary:
   Origin` present.
8. No-Origin requests share the `__no-origin__` store (two plain curls see
   each other's mutations).

**Verification**: `node --test tools/mock-proxy/` → all pass (≥8 tests),
exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node --test tools/mock-proxy/` exits 0 with ≥8 passing tests
- [ ] All Step 3 and Step 4 curl sequences produce the expected outputs
- [ ] `tools/mock-proxy/` contains exactly `mock-proxy.mjs`,
      `mock-proxy.test.mjs`, `README.md` (plus nothing else committed;
      `mocks.json` outputs are untracked — add `tools/mock-proxy/mocks.json`
      to `.gitignore` only if a stray file appears during testing)
- [ ] `grep -rn "require(\|from 'express'\|from \"express\"" tools/mock-proxy/*.mjs`
      returns no matches (ESM, zero deps)
- [ ] `git status` shows no modifications outside the in-scope list
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back (do not improvise) if:

1. `node --version` on the executing machine is below v18 (no built-in
   `fetch`/`structuredClone`/`node:test`).
2. `prototype-crossorigin/origin-keyed-store.mjs` or
   `IMPLEMENT-ORIGIN-KEYED-MOCK.md` no longer match the excerpts quoted in
   "Current state" (the origin-keying decision may have changed).
3. A `tools/` directory already exists with conflicting content.
4. Implementing streaming proxy of a response type the plan didn't
   anticipate (websockets, SSE, multipart) turns out to be required for the
   verification steps — these are explicitly unsupported; if a curl check
   somehow depends on one, the plan is wrong.
5. The operator (in review or issue comments) indicates "auto-detect" was
   meant as static source scanning of the apps' code — that is a different
   tool; do not build both.

## Maintenance notes

- **Deferred, deliberately**: HTML rewriting to inject `sync-agent.js`
  (README-TEST's "inject via the mock proxy" idea) belongs in a proxy that
  fronts the apps' **pages**, not their API. If someone later makes this
  proxy front full app origins, add injection then and revisit CORS
  (same-origin paths change the Origin header the state layer keys on —
  see IMPLEMENT-ORIGIN-KEYED-MOCK rule 4).
- **Known limits to keep documented**: no websockets/SSE/multipart; binary
  responses recorded base64 or served stateless; mutation semantics only
  inferred for array-shaped or single-array-property JSON bodies; auth
  flows (Set-Cookie, tokens) are replayed verbatim from recordings and may
  expire.
- **Reviewer focus**: the origin-keyed layer — any handler path that reads
  or writes endpoint state without going through `storeFor(req)`
  reintroduces the double-apply desync for that endpoint only (brief rule
  1: "the hardest kind to notice").
- If the real work-PC mock server later adopts this tool, the hand-written
  origin-keyed changes from `IMPLEMENT-ORIGIN-KEYED-MOCK.md` become
  redundant — retire one or the other, not both.
