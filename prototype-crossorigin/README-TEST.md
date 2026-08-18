# synced-preview cross-origin prototype — test instructions

PROTOTYPE — THROWAWAY. Answers one question: **does the mirroring bridge work
cross-origin** — two dev servers on different ports, host page with no
`contentDocument` access, all traffic over `postMessage`?

Verified locally (Chrome 151, macOS, 2026-08-18) against the demo apps — see
`docs/research.md` Part 6. These instructions are for re-verifying on a work
PC against real apps.

## Files

| File | What | Where it runs |
|---|---|---|
| `SyncedPreviewProto.jsx` | Host React component (two iframes + event routing + divergence log) | Your Next.js app |
| `sync-agent.js` | Capture/replay agent (self-contained, no build) | Inside each app-under-test, via script tag |
| `local-demo.mjs` | Standalone 3-origin demo, no real apps needed | Anywhere with Node 18+ |
| `IMPLEMENT-SYNCED-PREVIEW.md` | Self-contained implementation brief for the component (host + agent + ghost dot) | Read on the work PC |
| `IMPLEMENT-ORIGIN-KEYED-MOCK.md` | Self-contained implementation brief for the mock-server fix | Read on the work PC |

## Step 0 — standalone smoke test (no work apps touched)

```sh
git clone <repo-url> && cd <repo>/prototype-crossorigin
git switch prototype/crossorigin-component   # if not already on it
npm install
node local-demo.mjs
# open http://localhost:4400/
```

Expected: both panes say "✓ agent connected"; typing in the left filter
mirrors to the right; clicking "Add member" logs `△ matched by structure
only` (branch B renamed the button); leader **B** then Actions → "Archive
team" logs `✕ NO MATCH in A`; Settings navigation and the Public-profile
switch mirror; latency counter shows ~10–30 ms avg.

The demo now includes a **stateful mock backend** (port 4403) that both demo
apps call, mirroring the live-compare architecture. Default mode is the
origin-keyed fix: clicking "Add member" once adds exactly one member to each
pane and they stay identical. Run `node local-demo.mjs --shared-mock` to see
the unfixed failure mode: one click double-applies (two new members in the
store) and the panes desync. The fix and how to apply it to the real mock
server: `IMPLEMENT-ORIGIN-KEYED-MOCK.md`.

## Step 1 — wire into your Next.js app (the host)

1. Copy `SyncedPreviewProto.jsx` into the app, e.g. `app/synced-preview/SyncedPreviewProto.jsx`.
2. Copy `sync-agent.js` into the app's `public/` directory.
3. Add a page:

```jsx
// app/synced-preview/page.jsx
import SyncedPreviewProto from './SyncedPreviewProto';

export default function Page() {
  return (
    <SyncedPreviewProto
      srcA="http://localhost:3001/"   // main-branch dev server
      srcB="http://localhost:3002/"   // target-branch dev server
      height={600}
    />
  );
}
```

The component is `'use client'`; it needs no server code, no next.config
changes, no proxy. Written as `.jsx` — works in a TS app as long as
`allowJs` isn't disabled; rename to `.tsx` and it should compile too (plain
JS, no types).

## Step 2 — inject the agent into each app-under-test

Each app shown in a pane must load the agent. Add ONE line, dev-only:

- **Next.js app-under-test** — in `app/layout.(jsx|tsx)`:

```jsx
{process.env.NODE_ENV === 'development' && (
  // eslint-disable-next-line @next/next/no-sync-scripts
  <script src="http://localhost:3000/sync-agent.js" />
)}
```

(port 3000 = wherever the HOST app runs; the agent locks its postMessage
traffic to the origin it was served from)

- **Vite app-under-test** — in `index.html` `<head>`:

```html
<script src="http://localhost:3000/sync-agent.js"></script>
```

The agent is inert unless the page is inside an iframe, so leaving it in
during normal dev is harmless — but keep the env guard anyway.

### Alternative: inject via the mock proxy (zero app changes)

If the dev servers already sit behind a mock/proxy server (the live-compare
setup), inject the tag there instead of touching each app — rewrite proxied
HTML responses:

```js
// concept — adapt to whatever the proxy is built with
if (res.getHeader('content-type')?.includes('text/html')) {
  body = body.replace(
    '</head>',
    '<script src="http://localhost:3000/sync-agent.js"></script></head>'
  );
  // strip content-length / content-encoding if you buffer + rewrite
}
```

Then point `srcA`/`srcB` at the **proxy** URLs, not the raw dev-server
ports. Same-origin proxy paths (e.g. `/preview/main/`, `/preview/branch/`)
work too — the bridge doesn't care; it was validated cross-origin, and
same-origin is the easier case.

## Step 3 — run

1. Start the two app-under-test dev servers (e.g. main worktree on :3001,
   branch worktree on :3002).
2. Start the host app (`next dev`, :3000).
3. Open `http://localhost:3000/synced-preview`.

## Step 4 — checklist (report actual vs expected)

| # | Action | Expected |
|---|---|---|
| 1 | Load page | Both panes "✓ agent connected"; left badge LEADER, right MIRROR |
| 2 | Type in a text field in A | Same text + same filtered/derived UI in B |
| 3 | Click buttons in A | Action fires once in each pane; ghost cursor dot in B |
| 4 | Open a dropdown/menu in A | Opens in both (works through React portals) |
| 5 | Hover styled rows in A | Hover styling mirrors ONLY if styled via JS/data-attributes; raw CSS `:hover` will NOT mirror (known limitation) |
| 6 | Scroll a list in A | B scrolls proportionally (fractions, survives length differences) |
| 7 | Navigate (hash or link click) in A | Both panes navigate |
| 8 | Toggle a checkbox/switch in A | Single toggle in B, end states equal |
| 9 | Click something that exists only in one branch | Divergence log: `✕ NO MATCH`; panes visibly desync (intended) |
| 10 | Renamed-label control | Divergence log: `△ matched by structure only` |
| 11 | leader A / B / both buttons | Roles flip; "both" = interact with either side |
| 12 | Latency readout | avg well under 100 ms locally |
| 13 | App errors panel | stays empty (entries = capture/replay failures — report them) |

## Known limitations (expected, do not report as failures)

- Raw CSS `:hover`/`:focus` styling doesn't mirror (synthetic events are
  `isTrusted:false`). Apps styled via data-attributes (react-aria, headless
  UI libs) mirror visually.
- Mirror pane shows no focus ring (focus is deliberately blocked there so it
  can't steal typing from the leader).
- The two panes must be variants of the *same* app — target resolution is by
  id/testid/accessible-name/text/structure.
- History-API routing (pushState) is NOT captured yet — only hash routing and
  link clicks. If your app uses a router and panes desync on navigation,
  report it: that's the next thing to build, not a surprise.
- React 18.3 validated; React 19 untested.
- SPA client-side route changes that re-render everything may produce
  spurious `△`/`✕` entries during the transition.
- **Stateful shared mock server**: every mirrored interaction fires an API
  call from BOTH panes against the one mock server, so mutations
  double-apply and panes desync through the backend even when the bridge
  mirrored correctly. Not a bridge failure. The fix (origin-keyed state) is
  specified in `IMPLEMENT-ORIGIN-KEYED-MOCK.md` and demonstrated working in
  `local-demo.mjs` (broken mode: `--shared-mock`). Until the real mock
  server has it, expect desync right after any mutation that hits the API.

## What to report back

- Checklist rows that failed, with what actually happened
- Divergence-log lines that look wrong (fired on identical UI)
- Anything in the App errors panel
- Latency avg/max after ~2 minutes of use
- React version + router + UI library of the app under test
