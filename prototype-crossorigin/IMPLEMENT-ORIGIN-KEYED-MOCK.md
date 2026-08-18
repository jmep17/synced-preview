# Task: make the mock server origin-keyed for live-compare

This document is a complete, self-contained implementation brief. Follow it
literally. It assumes no knowledge of this repo.

## The problem you are fixing

The live-compare feature shows two branch builds of the app side by side and
mirrors every user interaction from one pane into the other. Both panes are
real running apps, so **every mirrored interaction makes its own API call**.
Both apps call the **same mock server**. Because the mock server keeps ONE
shared state store, every mutation is applied **twice** (once per pane), and
the two panes then read different, interleaved state.

Measured demonstration (2026-08-18, this repo's `local-demo.mjs`):

- Shared store, user clicks "Add member" once → store gained TWO members
  ("New Member 11" and "New Member 12"); pane A rendered 11 members, pane B
  rendered 12. The panes desynced even though event mirroring worked
  perfectly.
- Origin-keyed store, same single click → each pane's store gained exactly
  one member, both named "New Member 11". Panes identical.

## The fix (one rule)

> Key the mock server's mutable state by the **`Origin` request header**,
> creating a fresh copy of the seed state the first time a new origin
> appears.

Why this works: each branch dev server runs on its own port, and a port
difference means a different origin. Browsers automatically send the
`Origin` header on all cross-origin `fetch`/XHR requests, so each pane's API
calls arrive labeled with which pane they came from. No frontend changes are
needed.

## Reference implementation

Copy this module (it is `origin-keyed-store.mjs` in this directory, already
working in the demo):

```js
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

Usage in a plain Node `http` handler:

```js
const mock = createMockStore({ seed: () => structuredClone(SEED_STATE) });

createServer((req, res) => {
  const store = mock.storeFor(req);   // <-- per-origin state; use `store`
  // ... every read and write below uses `store`, never a module-level object
});
```

Usage as Express middleware:

```js
const mock = createMockStore({ seed: () => structuredClone(SEED_STATE) });
app.use((req, res, next) => { req.store = mock.storeFor(req); next(); });
// handlers then use req.store
```

## Rules you must follow while integrating

1. **Every stateful read AND write goes through `storeFor(req)`.** A single
   handler still touching a module-level store reintroduces the bug for that
   endpoint only — the hardest kind to notice.
2. **Reset endpoints are keyed too.** "Reset" must reset the calling
   origin's store, not all stores (unless you add an explicit reset-all).
3. **Keep CORS reflecting the origin.** The mock must send
   `Access-Control-Allow-Origin: <the request's Origin>` (plus
   `Vary: Origin`), not `*`, if any request uses credentials. Handle
   `OPTIONS` preflight with 204 and allow the methods/headers the app uses.
4. **Do not key by anything else.** Not IP (both panes share it), not
   User-Agent (identical), not Referer path (varies per page, fragmenting
   state). `Origin` header only.
5. **Fallback key**: requests WITHOUT an `Origin` header (curl, server-side
   calls, some same-origin GETs) all share the `'__no-origin__'` store. That
   is acceptable; do not try to be cleverer.
6. **Stateless endpoints need no change.** Only endpoints that read or write
   mutable state.

## Acceptance checks

Run these against the modified mock server (adjust port/paths to the real
API). Expected results assume a seed with 10 members and a POST that appends
one.

```sh
# 1. Two origins see isolated state
curl -s -X POST http://localhost:MOCKPORT/members -H 'Origin: http://localhost:3001'
curl -s http://localhost:MOCKPORT/members -H 'Origin: http://localhost:3001' # 11 items
curl -s http://localhost:MOCKPORT/members -H 'Origin: http://localhost:3002' # 10 items  ← MUST differ

# 2. Preflight passes
curl -si -X OPTIONS http://localhost:MOCKPORT/members \
  -H 'Origin: http://localhost:3001' -H 'Access-Control-Request-Method: POST' \
  | head -5   # 204, Access-Control-Allow-Origin echoed

# 3. Reset is per-origin
curl -s -X POST http://localhost:MOCKPORT/reset -H 'Origin: http://localhost:3001'
curl -s http://localhost:MOCKPORT/members -H 'Origin: http://localhost:3001' # 10 items
```

Browser-level check (the one that matters): open the live-compare page, click
a mutating control ONCE in the leader pane. Both panes must show exactly one
new item with the SAME name/id, and stay identical afterwards. If one pane
shows two new items, a handler is still using shared state (rule 1).

## What NOT to do

- Do not disable mirroring or suppress the mirror pane's API calls — the
  mirror must run its own real request/render path, that is the point of
  live-compare.
- Do not deduplicate "identical" requests inside the mock — the two panes'
  requests are supposed to both apply, once per store.
- Do not fix it in the frontend. The frontend is correct.

## Working demo of both modes (this repo)

```sh
cd prototype-crossorigin && npm install
node local-demo.mjs                # origin-keyed: panes stay identical
node local-demo.mjs --shared-mock  # broken shared mode: panes desync
# open http://localhost:4400/ and click "Add member" in the leader pane
```
