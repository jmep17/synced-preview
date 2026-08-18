# synced-preview

A React component that shows two iframe previews side by side and mirrors interactions from a leader pane into a mirror pane — clicks, hover, typing, keyboard, navigation, and scroll — surfacing divergence between the two DOMs instead of hiding it. Panes are cross-origin; the bridge is an agent/host split over postMessage (`docs/adr/0001`).

Intended use: previewing two branches/variants of the same app and interacting with both at once.

## Status

Working product app (Vite + React, `docs/adr/0002`) with the vendorable component and dev fixtures.

- `app/src/components/synced-preview/` — the component (Host + Agent + vendoring README). Self-contained; peer dep `react` only.
- `app/` — Vite consuming app (shell, branch picker wiring, agent-serving plugin).
- `fixtures/` — dev-only apps-under-test + stateful mock + GitHub stub (see `fixtures/README.md` for the test walkthrough).
- `docs/research.md` — the sourced research survey behind the design; Parts 5–6 document the empirical findings.

## Quick start

```sh
npm install
npm run dev        # Vite app :5173 + fixtures :4401–:4404
# open http://localhost:5173
```

`npm test` runs the mock-proxy suite; `npm run build` emits `app/dist/` with an unhashed `sync-agent.js`.

## Distribution

Vendored source: copy `app/src/components/synced-preview/` into the consuming app's `src/components/` and wire it up via props. No npm publish. Integration steps: that folder's `README.md`.
