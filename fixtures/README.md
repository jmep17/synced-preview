# fixtures — dev-only apps-under-test + mocks

Standalone servers for exercising the synced-preview bridge without real
work apps. Not vendored, not shipped.

```sh
pnpm dev               # Vite app (:5173) + these fixtures together
# or separately:
pnpm dev:fixtures      # node fixtures/demo-server.mjs
```

Origins:

| Port | What |
|---|---|
| 4401 | demo app, branch A ("main") |
| 4402 | demo app, branch B ("feature/team-v2") — deliberately divergent |
| 4403 | stateful mock backend both apps call |
| 4404 | stub GitHub API (branch picker, offline + deterministic) |

The demo app (`demo-app.jsx`, react-aria-components) is compiled fresh at
startup with esbuild, minified — the hostile no-testids case from
`docs/research.md` Part 5. Pane pages load `sync-agent.js` from the Vite
origin (`http://localhost:5173`, override with `SP_APP_ORIGIN`), exercising
the real serving path.

## Smoke-test walkthrough

Open `http://localhost:5173/`. Expected:

- Both panes say "✓ agent connected"; left badge LEADER, right MIRROR.
- Typing in the left filter mirrors to the right.
- Clicking "Add member" logs `△ matched by structure only` (branch B renamed
  the button to "Invite teammate").
- Leader **B**, then Actions → "Archive team" logs `✕ NO MATCH in A`.
- Settings navigation and the Public-profile switch mirror.
- Opening the Actions menu opens the popover in both panes (Trap 3 canary —
  popovers must work).
- Latency counter shows ~10–30 ms avg.

## Checklist

| # | Action | Expected |
|---|---|---|
| 1 | Load page | Both panes "✓ agent connected"; left LEADER, right MIRROR |
| 2 | Type in a text field in A | Same text + same filtered UI in B |
| 3 | Click buttons in A | Action fires once in each pane; ghost cursor dot in B |
| 4 | Open a dropdown/menu in A | Opens in both (works through React portals) |
| 5 | Hover styled rows in A | Mirrors only if styled via data-attributes; raw CSS `:hover` will NOT |
| 6 | Scroll a list in A | B scrolls proportionally |
| 7 | Navigate (hash or link) in A | Both panes navigate |
| 8 | Toggle a switch in A | Single toggle in B, end states equal |
| 9 | Click a one-branch-only control | `✕ NO MATCH`; panes visibly desync (intended) |
| 10 | Renamed-label control | `△ matched by structure only` |
| 11 | leader A / B / both | Roles flip; "both" = interact with either side |
| 12 | Latency readout | avg well under 100 ms locally |
| 13 | App errors panel | stays empty |

## Shared-mock desync demo

Default mode is the origin-keyed fix: clicking "Add member" once adds
exactly one member to each pane and they stay identical.

```sh
node fixtures/demo-server.mjs --shared-mock
```

reproduces the unfixed failure mode: one click double-applies (both panes
fire the POST against one shared store) and the panes desync through the
backend even though the bridge mirrored correctly. The fix pattern is
`origin-keyed-store.mjs` — key mock state by the request's Origin header.
