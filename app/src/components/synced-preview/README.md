# synced-preview

Two same-app iframe previews side by side; interactions in the leader pane
are mirrored into the other pane, and divergence between the two DOMs is
surfaced as first-class UI. Architecture: an agent/host bridge over
postMessage (ADR 0001); evidence base: `docs/research.md` Parts 5–6.

Two files matter:

- `SyncedPreview.jsx` — the **Host**: owns the two iframes, routes events,
  renders roles/divergence UI. Never touches frame DOM.
- `sync-agent.js` — the **Agent**: runs inside each app under test (capture,
  replay, focus shadowing, ghost cursor). Plain IIFE, no imports, no build.

## Vendoring

Copy this folder into the consuming app's `src/components/`. It is
self-contained — no imports from outside the folder; the only peer
dependency is `react` (validated on React 18.3.x; React 19 untested — stay
on 18.3.x for parity until verified).

The `'use client'` directive is present so the component works in Next.js
App Router unchanged; it is harmless elsewhere.

## Serving sync-agent.js (required)

The agent must be served **from the consuming app's origin**: it derives its
host origin from `document.currentScript.src` and pins all postMessage
traffic to it, both directions.

**Single-copy rule:** the canonical source is `sync-agent.js` in this
folder. Never keep a second copy (e.g. in `public/`) — duplicates drift.
Serve or copy from this file:

- **Vite**: an inline plugin — dev middleware for `GET /sync-agent.js` plus
  `generateBundle` emitting it unhashed. See `app/vite.config.js` in the
  source repo (`serveSyncAgent`).
- **Next.js**: copy this file into `public/` **as a build/deploy step**
  (e.g. a `prebuild` script: `cp src/components/synced-preview/sync-agent.js public/`),
  never by hand.

## Wiring an app under test

One dev-only script tag in the page shown in a pane:

```html
<script src="http://localhost:3000/sync-agent.js"></script>
```

(port = wherever the consuming app runs). The agent is inert unless the page
is inside an iframe.

## Usage

```jsx
import SyncedPreview from './components/synced-preview';

<SyncedPreview
  srcA="http://localhost:3001/"   // leader-default pane
  srcB="http://localhost:3002/"   // mirror pane
  height={600}
/>
```

Optional branch picker for pane B (replaces `srcB`):

```jsx
<SyncedPreview
  srcA="http://localhost:3001/"
  branchPicker={{
    // Must be referentially stable (module-level or useCallback).
    listBranches: async () => ({
      branches: ['main', 'feature/x'],
      defaultBranch: 'main',
      truncated: false,
    }),
    resolvePreviewUrl: branch => `http://localhost:300${branch === 'main' ? 1 : 2}/`,
    initialBranch: 'feature/x',
    // Optional: fires with the branch name (or null) whenever the user
    // changes the dropdown selection. Not fired by a listBranches-identity
    // reset (see "Repo switching" below).
    onBranchChange: branch => console.log('selected', branch),
  }}
/>
```

The component knows nothing about GitHub; a GitHub-API-shaped
`listBranches` lives in the consuming app (see `app/src/App.jsx` in the
source repo for one).

### Repo switching

Changing the `listBranches` **identity** resets all picker state (branch
list, selection, resolved pane B URL) — swap in a new `listBranches` to
point the picker at a different repo; keep it referentially stable
(`useMemo`/module-level) otherwise, or it will refetch on every render.

```jsx
// Consuming app: rebuild the picker whenever the active repo changes.
const picker = useMemo(() => ({
  listBranches: () => fetchBranches(owner, repo),
  resolvePreviewUrl: branch => resolvePreview(owner, repo, branch),
  initialBranch,
  onBranchChange: branch => updateUrl(`${owner}/${repo}`, branch),
}), [owner, repo]);

<SyncedPreview srcA={srcA} branchPicker={picker} />
```

Each repo switch produces a new `listBranches`/`resolvePreviewUrl` pair
(new function identity), which is exactly what triggers the component's
refetch-and-reset — `useMemo` keeps the pair stable within a single repo.
See `app/src/App.jsx` in the source repo for the full pattern (URL-synced
repo + branch, `owner/repo` text input).

## Known limitations

- Raw CSS `:hover`/`:focus` styling doesn't mirror (synthetic events are
  `isTrusted:false`); data-attribute styling (react-aria etc.) mirrors.
- Mirror pane shows no focus ring (focus deliberately blocked there).
- Panes must be variants of the *same* app — target resolution is by
  id/testid/accessible-name/text/structure.
- History-API routing (pushState) is not captured — only hash routing and
  link clicks.
- A stateful **shared** mock backend double-applies mutations (both panes
  fire the API call); key the mock's state by request Origin — see
  `fixtures/origin-keyed-store.mjs` in the source repo.
