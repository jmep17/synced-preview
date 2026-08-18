# Task: implement the synced-preview live-compare component

This document is a complete, self-contained implementation brief. Follow it
literally. It assumes no knowledge of this repo. It is the companion to
`IMPLEMENT-ORIGIN-KEYED-MOCK.md` (the mock-server half); this document covers
everything else: the host component, the in-frame agent, and the visible
behaviors — including the mirrored-cursor dot in the non-leader pane.

The two source files referenced throughout ship in the same directory as this
brief and are the reference implementation, validated working cross-origin
(Chrome 151, macOS, 2026-08-18):

- `SyncedPreviewProto.jsx` — the host React component
- `sync-agent.js` — the agent that runs inside each app-under-test

## What you are building

Live-compare shows two branch builds of the same app side by side and mirrors
every user interaction from a **leader** pane into a **mirror** pane, so a
reviewer drives one build and watches both react. Divergence between the two
builds (a control that resolves differently, or not at all) is surfaced as
first-class UI, not hidden.

The two builds run on their own dev servers (different ports = different
origins), so the host page has **no** `contentDocument` access into either
iframe. Everything crosses the boundary over `postMessage`.

## Architecture (the one split that matters)

> The **agent** (inside each frame) does capture, replay, focus shadowing,
> and the ghost cursor dot — everything that touches the frame's DOM.
> The **host** (the parent page) does routing, roles, and the divergence
> log — and never touches either frame's DOM.

Flow for one interaction:

1. User acts in the leader pane. The leader's agent captures the event
   (capture-phase listener), serializes it as a **target descriptor** plus
   event payload, and posts it to the host.
2. The host checks the sender is the current leader, then forwards it to the
   other pane as a `replay` message.
3. The mirror's agent resolves the descriptor against its own DOM, replays
   the event, shows the ghost dot at the replayed coordinates, and posts a
   `result` (hit/miss + which strategy matched) back to the host.
4. The host updates counters and, on a miss or structure-only match, the
   divergence log.

## Files to copy

1. Copy `SyncedPreviewProto.jsx` into the consuming app (e.g.
   `app/synced-preview/SyncedPreviewProto.jsx`). It is `'use client'`,
   Next.js App Router compatible, plain JS (renames to `.tsx` cleanly), and
   needs no server code, config changes, or proxy.
2. Copy `sync-agent.js` into the host app's `public/` directory. It is
   self-contained, no build step, and **inert unless the page is inside an
   iframe**, so it is harmless if it leaks into normal dev.

Keep the component self-contained: one folder, no imports from outside it,
peer dependencies only (`react`). It is vendored, not npm-installed.

## Step 1 — mount the host

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

## Optional: branch picker for pane B

Instead of a fixed `srcB`, pane B can offer a dropdown that lists a GitHub
repo's branches and lets the reviewer pick the target branch to compare
against `srcA`. Pass a `branchPicker` prop instead of `srcB`:

```jsx
<SyncedPreviewProto
  srcA="http://localhost:3001/"          // pane A: the main-branch preview, unchanged
  branchPicker={{
    owner: 'acme',                        // GitHub organization or user (required)
    repo: 'webapp',                       // repository name (required)
    token: undefined,                     // optional; for private repos / rate limits
    apiBase: 'https://api.github.com',    // optional override (used by the demo's stub)
    initialBranch: undefined,             // optional; branch to auto-select on mount
    resolvePreviewUrl: (branchName) => …, // required; returns string | Promise<string>
  }}
  height={600}
/>
```

**Behavior contract:**

- Without `branchPicker`: behavior is byte-for-byte what it is today — `srcB`
  drives pane B. Backward compatible.
- With `branchPicker`: `srcB` is ignored. Pane B's header gains a native
  `<select>` listing the repo's branches (default branch first, then
  alphabetical). Selecting a branch calls `resolvePreviewUrl(branchName)`;
  the returned URL becomes pane B's iframe `src`. Until a branch is selected
  and resolved, pane B shows a placeholder ("select a target branch") instead
  of an iframe.
- On every pane B URL change: pane B's agent channel and connected flag
  reset, and the mirrored/miss counters, latency stats, and divergence log
  clear (divergence measured against the previous branch is meaningless for
  the new one). The leader setting is left alone.
- Fetch or resolve errors render as a short inline error message in pane B's
  header row. No automatic retries; re-selecting a branch retries
  resolution.

**Division of responsibility:** the Host lists branches (via the GitHub API)
and renders the selection UI. The **consuming app** owns mapping a branch
name to a running app-under-test URL, via `resolvePreviewUrl` — spinning up
branch dev servers or preview deployments is out of the component's scope.
The component cannot start dev servers or deployments; it can only ask
"given this branch name, what URL should pane B point at?"

**Security note on `token`:** it is exposed to the browser page like any
other prop. Use a fine-grained personal access token scoped to the one repo,
read-only (Contents/Metadata), short expiry, development only. Never
hardcode it — pass it from the consuming app's dev-only config.
Unauthenticated requests work for public repos, within GitHub's 60
requests/hour/IP limit.

## Step 2 — inject the agent into each app-under-test

Each app shown in a pane must load the agent. Either:

**(a) One dev-only line in the app** — Next.js `app/layout.(jsx|tsx)`:

```jsx
{process.env.NODE_ENV === 'development' && (
  // eslint-disable-next-line @next/next/no-sync-scripts
  <script src="http://localhost:3000/sync-agent.js" />
)}
```

(port 3000 = wherever the HOST app runs — the agent pins all its postMessage
traffic, both directions, to the origin it was served from)

**(b) Zero app changes** — if the dev servers already sit behind a
mock/proxy server, rewrite proxied HTML responses there instead:

```js
if (res.getHeader('content-type')?.includes('text/html')) {
  body = body.replace(
    '</head>',
    '<script src="http://localhost:3000/sync-agent.js"></script></head>'
  );
  // strip content-length / content-encoding if you buffer + rewrite
}
```

Then point `srcA`/`srcB` at the proxy URLs, not the raw dev-server ports.

## Step 3 — the mock server

Both panes make real API calls, so a shared stateful mock double-applies
every mutation and desyncs the panes through the backend. Fix it per
`IMPLEMENT-ORIGIN-KEYED-MOCK.md` (key mock state by the `Origin` request
header). Do this — the bridge cannot look correct without it.

## The message protocol

All messages are `{ __sp: <kind>, ... }`. Host↔agent, origin-checked on
both ends (`e.origin` AND `e.source` verified).

| Kind | Direction | Payload | Purpose |
|---|---|---|---|
| `hello` | agent → host | `href` | agent announces itself on load |
| `init` | host → agent | `role`, `focusBlocked`, `ghost` | first state push after hello |
| `state` | host → agent | `focusBlocked`, `ghost` | role/leader changes mid-session |
| `event` | agent → host | serialized event `data` (+`tCap` capture timestamp) | captured in the leader |
| `replay` | host → agent | `data`, `seq` | forwarded to the mirror |
| `result` | agent → host | `seq`, `tCap`, `ok`, `strategy`, `type`, `desc` | replay outcome, drives divergence log + latency |
| `apperror` | agent → host | `msg` | in-frame errors + capture/replay failures |

## Behaviors that must work

These are the validated behaviors of the reference implementation. Each maps
to specific code in the two files; keep them all when adapting.

### Target resolution (divergence-tolerant)

Descriptors carry an ordered strategy list, most stable first: stable `id`
(framework-generated ids like React `useId` `:r1:` / `react-aria-*` are
**skipped** — both panes generate them in render order, so a divergent
branch silently shifts them onto the wrong element) → `data-testid` → role +
accessible name → tag + text (+index) → structural `nth-of-type` path.
The mirror tries each in order and reports which matched.

- Match by a semantic strategy → mirrored silently.
- Match by structural path only, when semantic strategies existed →
  mirrored, logged `△ matched by structure only` (label differs between
  branches).
- No match → not mirrored, logged `✕ NO MATCH`; the panes visibly desync.
  That is the product working, not failing.

### Event capture and replay

- Capture-phase, passive listeners for: `pointerdown/up/move/over/out`,
  `click`, `dblclick`, `keydown`, `keyup`, `input`, `focusin`, `scroll`;
  plus `hashchange`.
- `pointermove` is coalesced to one per animation frame; a pending move
  flushes before any other event so ordering is preserved.
- Pointer coordinates travel as **fractions of the target's bounding rect**
  (not pixels), so panes with different layouts still hit the same spot on
  the resolved element.
- Scroll travels as fractions of the scrollable range, so lists of
  different lengths stay proportionally aligned.
- Text input: set the value through the native value setter (React reads
  controlled values through it), then dispatch `input`. The mirror never
  needs keyboard focus.
- Checkbox/radio: replayed clicks may double-toggle (label + input each get
  a click); the captured `input` event carries `checked` and converges the
  mirror to the leader's end state.
- Hash navigation: replayed link click + `hashchange` backstop, idempotent
  (skip if hash already equal) so it cannot loop.

### The mirrored-cursor dot ("ghost cursor") — required

Every non-leader pane shows a dot marking where each mirrored pointer event
landed, so the reviewer can see the interaction land in the other branch.
Spec, matching `sync-agent.js` (`moveGhost`):

- A single fixed-position element the agent creates lazily in its own
  document: 14px circle, translucent red fill, red border,
  `pointer-events: none`, max z-index, centered on the point via
  `transform: translate(-50%, -50%)`, opacity transition for fade.

```js
g.style.cssText = 'position:fixed;width:14px;height:14px;border-radius:50%;' +
  'background:rgba(220,38,38,.45);border:2px solid #dc2626;' +
  'pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);' +
  'transition:opacity .3s;';
```

- Shown after a **successful** replay that produced coordinates, at the
  replayed position (the mirror's own resolved-element rect + fractional
  offset — not the leader's raw pixels). Gate, exactly:

```js
if (res.ok && res.x != null && ghost && window.__FOCUS_BLOCKED) moveGhost(res.x, res.y);
```

- `window.__FOCUS_BLOCKED` is true precisely in non-leader panes, so the
  dot appears **only in mirror panes, never in the leader** — the leader
  has the real cursor. In `both` mode no pane is focus-blocked, so no dot
  shows anywhere; that is correct.
- Because `pointermove` is mirrored (rAF-coalesced), the dot tracks hover
  movement, not just clicks.
- Fades out after 1.5 s without pointer activity; reappears on the next
  replayed pointer event. Failed replays (`✕ NO MATCH`) show no dot —
  those go to the divergence log instead.
- Host can toggle it via the `ghost` field on `init`/`state` messages.

### Leader roles

- `leader: A | B | both`, switchable live. The host drops `event` messages
  from any pane that is not the current leader.
- On every role change the host pushes a `state` message to both agents
  (updates `focusBlocked`) and toggles `inert` on the mirror pane's wrapper
  div. `inert` is set via `toggleAttribute` — React 18 does not support it
  as a prop.
- `both` = free-drive either side; each side mirrors into the other.

### Divergence + health UI

- Divergence log: `✕`/`△` entries with pane, event type, and a
  human-readable target summary; consecutive duplicates collapse into one
  entry with a ×N counter.
- Counters: mirrored count, miss count, latency avg/max (capture timestamp
  → result received).
- App-errors panel fed by `apperror` messages (in-frame `error` and
  `unhandledrejection`, plus capture/replay exceptions).
- Per-pane connection badge driven by `hello` ("agent connected" vs
  "waiting").

## Rules you must follow while integrating

1. **Patch focus in the mirror.** Parent-side `inert` on the wrapper does
   NOT stop programmatic `element.focus()` calls made *inside* the iframe
   (react-aria makes them constantly), and each one steals top-level focus
   from the leader, killing typing there. The agent patches
   `HTMLElement.prototype.focus` to a no-op while `__FOCUS_BLOCKED` is set.
   Keep BOTH: `inert` blocks real user input into the mirror; the patch
   blocks in-frame focus theft. Either alone is insufficient.
2. **Guard replay re-entrancy.** react-aria re-dispatches events
   synchronously; replay without a `__REPLAYING` flag recurses
   capture → replay → capture to a stack overflow. Set the flag around every
   replay (and every programmatic hash change), and check it first in the
   capture handler.
3. **Wrap the capture handler in try/catch.** It runs inside the app's own
   event dispatch; an uncaught exception there corrupts React's event
   handling in the app-under-test. Report failures via `apperror` instead.
4. **Pin postMessage origins both directions.** The agent only accepts
   messages where `e.origin` is the host origin AND `e.source` is
   `window.parent`, and only posts to the host origin (derived from
   `document.currentScript.src`). The host only accepts messages whose
   source is one of its two iframes' `contentWindow`s and whose origin
   matches that pane's configured origin. Never use `'*'` for either.
5. **Never resolve targets by framework-generated ids** (`/^:|react-aria/`).
   See Target resolution above for why.
6. **Tolerate late events on unmounted targets.** A trailing replayed
   `click` can arrive after the mirror's popover already closed (portal
   unmounted) → spurious NO MATCH even though the action applied. Keep the
   divergence log noise-tolerant (the collapse-duplicates behavior helps);
   do not let a late miss crash replay.
7. **The host never touches frame DOM.** All frame-side behavior lives in
   the agent. If a feature seems to need `contentDocument`, it belongs in
   the agent behind a message.

## Acceptance checks

With both dev servers, the host app, and the (origin-keyed) mock running:

| # | Action | Expected |
|---|---|---|
| 1 | Load page | Both panes "✓ agent connected"; A badge LEADER, B badge MIRROR |
| 2 | Type in a text field in A | Same text + same derived UI in B |
| 3 | Click a button in A | Action fires once per pane; **red dot appears in B at the clicked control, fades after ~1.5 s** |
| 4 | Move the pointer around in A | Dot in B tracks the movement |
| 5 | Open a dropdown/menu in A | Opens in both (through React portals) |
| 6 | Scroll a list in A | B scrolls proportionally |
| 7 | Navigate (hash or link) in A | Both panes navigate |
| 8 | Toggle a checkbox/switch in A | Single toggle in B, end states equal |
| 9 | Interact with a control that differs between branches | `△ matched by structure only` (renamed) or `✕ NO MATCH` (missing) in the log; no dot on a miss |
| 10 | Switch leader to B, interact in B | Roles flip; dot now appears in A only |
| 11 | Set leader to `both` | Either side drives the other; no dot in either pane |
| 12 | Click a mutating control once in the leader | Both panes gain exactly one identical item (mock is origin-keyed) |
| 13 | While A is leader, click inside B | Nothing happens (inert), leader keeps focus and typing |
| 14 | Latency readout | avg well under 100 ms locally (reference measured 13–21 ms avg) |
| 15 | App errors panel | stays empty |
| 16 | (with `branchPicker`) Load page | Dropdown lists branches, default branch first + labeled; `initialBranch` preselected and resolved |
| 17 | (with `branchPicker`) Switch target branch | Pane B reloads to the newly resolved URL; mirrored/miss counters, latency, and divergence log reset; agent reconnects |
| 18 | (with `branchPicker`) GitHub fetch fails | Inline error shown in pane B's header; pane A and the rest of the UI keep working |

## What NOT to do

- Do not have the host reach into the frames (`contentDocument`,
  `contentWindow.document`) — the design assumes cross-origin where that
  access does not exist.
- Do not replace the focus patch with `inert`, `tabindex=-1`, overlays, or
  `preventDefault` on focus events — none stop in-frame programmatic
  `focus()`.
- Do not mirror by absolute pixel coordinates — different branch layouts
  make pixels land on the wrong element. Fractions of the resolved target's
  rect, always.
- Do not de-duplicate or suppress the mirror pane's API calls — the mirror
  runs its own real request/render path; the mock server isolation is the
  backend fix.
- Do not draw the ghost dot from the host over the iframe — it must live in
  the frame's own document at the mirror's own resolved coordinates,
  otherwise it lies about where the event actually landed.
- Do not hide divergence to make panes "look synced" — surfacing it is the
  product.

## Known limitations (expected — do not "fix" silently)

- Raw CSS `:hover`/`:focus` styling does not mirror (synthetic events are
  `isTrusted: false`). Apps styled via data-attributes (react-aria,
  headless UI libs) mirror visually.
- Mirror pane shows no focus ring (focus is deliberately blocked there).
- History-API (`pushState`) routing is NOT captured — only hash routing and
  replayed link clicks. First expected gap on real routed apps; if panes
  desync on navigation, that is the next feature, not a bug in this brief.
- Panes must be variants of the *same* app — resolution is by
  id/testid/accessible-name/text/structure.
- Validated on React 18.3 + Chrome; React 19 and other browsers unverified.

## Working demo of everything above (this repo)

```sh
cd prototype-crossorigin && npm install
node local-demo.mjs
# open http://localhost:4400/ — click and move the pointer in the leader
# pane and watch the dot in the mirror pane; try the leader A/B/both buttons
```
