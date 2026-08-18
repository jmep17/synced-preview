# mock-proxy

A standalone, dependency-free dev tool that watches live traffic between an
app under test and its API, auto-detects the endpoints it calls, and then
serves mocks for them — with mutable state kept separately per requesting
`Origin`, so two live-compare panes (**leader** and **mirror**, both driven
by the same [host](../../CONTEXT.md)) stay in lockstep instead of
double-applying every mirrored mutation.

It is a separate tool from the `synced-preview` component itself: it fronts
the apps under test's **API**, not their HTML, and is not vendored into the
component folder.

## Why origin-keyed state matters here

Live-compare mirrors every interaction from the leader pane into the mirror
pane. Both panes are real running apps, so a single click fires the same API
call twice — once from each pane. A shared mock backend applies that
mutation twice and the panes desync. mock-proxy keys all mutable mock state
by the calling request's `Origin` header, so each pane gets its own isolated
copy and one click produces one change per pane. See
`../../prototype-crossorigin/IMPLEMENT-ORIGIN-KEYED-MOCK.md` for the
measured before/after.

To use it with live-compare: point both apps under test's API base URL at
the proxy. Because each pane runs on its own origin (different port or
host), each pane's requests carry its own `Origin` header automatically, and
the proxy keeps their state apart with no frontend changes required.

## CLI

```
node mock-proxy.mjs --port 4500 [--target http://localhost:8080] [--mocks ./mocks.json] [--no-save]
```

| Flag | Required | Meaning |
|------|----------|---------|
| `--port` | yes | Port the proxy listens on. |
| `--target` | no | Upstream base URL. When set, unknown endpoints are proxied there and the real response is recorded as the mock ("record mode"). When omitted, unknown endpoints get a synthesized response ("synthesize mode"). |
| `--mocks` | no | Path to the mocks file (default `./mocks.json`). Loaded on startup if present; endpoints learned at runtime are written back here. |
| `--no-save` | no | Never write the mocks file (useful for throwaway/CI runs). |

## The two modes

- **Record mode** (`--target` set): the first request to an endpoint is
  proxied to the real upstream, the response is returned unchanged to the
  caller, and the endpoint (method, path pattern, status, content type,
  response shape) is registered. Every later request to that same endpoint
  is served from the recording — it is not re-proxied, so mocks stay
  deterministic even if the upstream is unavailable or removed. Delete the
  endpoint's entry from the mocks file to force it to be re-recorded.
- **Synthesize mode** (no `--target`): unknown endpoints get a plausible
  response instead of a recorded one:
  - `GET` on a collection path (e.g. `/api/members`) → `200 []`.
  - `GET` on an item path (e.g. `/api/members/42`) → the matching item from
    state, or `200 {"id": "42"}` if none exists yet.
  - `POST` → `201`, the request body echoed back with an added `"id"`.
  - `PUT`/`PATCH` → `200`, the request body merged over the stored item (or
    echoed as-is if there wasn't one).
  - `DELETE` → `204`, empty body.
  - A non-JSON request body gets `204` for mutating methods, `200 {}` for
    `GET`.

Both modes register endpoints into the same registry and serve
`/__mock/endpoints` and the origin-keyed state layer identically — the mode
only decides how an *unknown* endpoint's baseline gets established.

## Path patterns

Numeric and UUID path segments are collapsed to `:id` before matching, so
`/api/members/42` and `/api/members/7` are treated as one endpoint,
`GET /api/members/:id`. Query strings are ignored for matching.

## Stateful vs. stateless endpoints

An endpoint is treated as a **stateful collection** — origin-keyed, mutable
via `POST`/`PUT`/`PATCH`/`DELETE` — only when its baseline `GET` body is a
JSON array, or an object with exactly one array-valued property (e.g.
`{"members": [...]}`). Everything else is served back verbatim
(**stateless**) on every request, because guessing mutation semantics for
arbitrary response shapes would produce wrong mocks. Each endpoint's
`/__mock/endpoints` entry reports which behavior it got (`"stateful": true |
false`).

## Admin routes

These paths are never proxied or mocked as app endpoints:

- `GET /__mock/endpoints` — JSON list of every detected endpoint:
  `{ method, pathPattern, hits, source: "recorded"|"synthesized", status,
  contentType, stateful }`.
- `POST /__mock/reset` — resets the *calling* origin's mutable state only
  (send it with the `Origin` header of the pane you want to reset).
- `POST /__mock/reset-all` — resets every origin's mutable state.

## CORS

Every response reflects the request's `Origin` header
(`Access-Control-Allow-Origin: <origin>`, `Vary: Origin`) rather than using
`*`, because the `Origin` header is what the state layer keys on.
`OPTIONS` preflight requests get a `204` with permissive
`Access-Control-Allow-Methods` / `-Headers`.

## Mocks file format

Pretty-printed JSON, written atomically (temp file + rename) on exit and
every 30 seconds unless `--no-save` is set. Per-origin mutable state is
**not** persisted — it's session state, wiped on restart. Example:

```json
{
  "endpoints": [
    {
      "method": "GET",
      "pathPattern": "/api/members",
      "hits": 3,
      "source": "synthesized",
      "status": 200,
      "contentType": "application/json; charset=utf-8",
      "stateful": true,
      "body": null
    }
  ],
  "collections": {
    "/api/members": {
      "arrayKey": null,
      "baselineItems": [],
      "source": "synthesized",
      "contentType": "application/json; charset=utf-8"
    }
  }
}
```

You can hand-edit this file (e.g. to seed a `synthesized` collection with
realistic baseline data) — it's reloaded on the next startup.

## Limits

- No WebSockets, SSE, or multipart uploads.
- Binary responses are not specially handled — they are recorded/served as
  UTF-8 text, so non-text upstream responses may come back mangled.
- Mutation semantics (`POST`/`PUT`/`PATCH`/`DELETE` updating state) are only
  inferred for array-shaped or single-array-property JSON bodies. Everything
  else is replayed statelessly.
- Auth flows (`Set-Cookie`, bearer tokens, etc.) recorded from a real
  upstream are replayed verbatim and may expire.
- This proxy fronts APIs only. It does not rewrite or inject scripts into
  HTML responses (see the "Deferred" note in
  `../../plans/002-mock-proxy-auto-detect.md` if that's ever needed later).
