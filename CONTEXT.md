# CONTEXT.md — synced-preview glossary

Domain terms. Use these exactly; don't drift to synonyms.

- **Host** — the React component in the consuming app: owns the two iframes,
  routes events, renders divergence UI. Never touches frame DOM.
- **Agent** — `sync-agent.js`, running inside an app under test: captures,
  replays, blocks focus, draws the ghost cursor. (Not "injected script",
  not "client".)
- **App under test** — the page shown in a pane: a branch dev server of the
  app being visually compared. Not the consuming app.
- **Consuming app** — the visual-regression app that renders the Host.
- **Leader / Mirror** — pane roles: interactions captured in the leader are
  replayed in the mirror. `both` = each pane leads for its own events.
- **Target descriptor** — serialized identity of an event target: ordered
  **strategies** (`id` → `testid` → `aria` → `text` → `path`), most stable
  first; framework-generated ids excluded.
- **Divergence** — a replay that resolved by structure only (`△`, label
  differs) or not at all (`✕` NO MATCH). Surfaced, never hidden.
- **Focus shadowing** — the agent's `HTMLElement.prototype.focus` patch,
  gated per role, preventing the mirror from stealing top-level focus
  (parent `inert` alone cannot — research Part 5 trap 1).
- **Ghost cursor** — the mirror-pane dot marking where a replayed pointer
  event landed.
- **Fixtures** — dev-only apps under test plus their mock backends
  (`fixtures/`), used to exercise the bridge without real work apps. Never
  vendored, never shipped.

Decisions: see docs/adr/. Evidence base: docs/research.md (Parts 5–6).
