# Plan 001: Add a GitHub branch selector to pane B of the synced-preview host

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat f0a55aa..HEAD -- prototype-crossorigin/SyncedPreviewProto.jsx prototype-crossorigin/local-demo.mjs prototype-crossorigin/IMPLEMENT-SYNCED-PREVIEW.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `f0a55aa`, 2026-08-18

## Why this matters

The synced-preview host currently takes two fixed URLs (`srcA`, `srcB`) and
the operator must know the target branch's preview URL up front. The requested
feature: given a GitHub organization/owner and repository, pane B gets a
dropdown listing the repo's branches, so a reviewer picks the target branch to
compare against the main branch shown in pane A. This turns the component from
"compare these two hardcoded URLs" into "compare main against any branch of
this repo", which is the component's actual product intent (README: "previewing
two branches/variants of the same app").

**Key assumption this plan is built on**: the component cannot start dev
servers or deployments, so it cannot turn a branch *name* into a running
preview *URL* by itself. The consuming app must supply that mapping via a
`resolvePreviewUrl(branchName)` callback prop. The component owns listing
branches (GitHub API) and the selection UI; the consuming app owns
branch-to-URL resolution.

## Current state

This repo is **pre-implementation** for the final component. The validated
reference implementation lives in `prototype-crossorigin/` and is what the
implementation brief tells consuming apps to vendor. This plan extends the
reference implementation and its brief; there is no other component code to
extend.

Relevant files:

- `prototype-crossorigin/SyncedPreviewProto.jsx` — the host React component.
  Renders two iframes, routes `postMessage` events between the sync agents
  inside them, renders the divergence log. Never touches frame DOM.
- `prototype-crossorigin/local-demo.mjs` — standalone demo. Serves the host on
  `:4400`, demo app "main" on `:4401`, demo app "feature/team-v2" on `:4402`,
  an origin-keyed mock API on `:4403`.
- `prototype-crossorigin/IMPLEMENT-SYNCED-PREVIEW.md` — the self-contained
  implementation brief that consuming apps follow when vendoring.
- `prototype-crossorigin/sync-agent.js` — the in-frame agent. **Not touched by
  this plan** — the feature is entirely host-side.

Excerpts as of commit `f0a55aa`:

`SyncedPreviewProto.jsx:43-57` — component signature and state:

```jsx
export default function SyncedPreviewProto({ srcA, srcB, height = 560 }) {
  const frameA = useRef(null), frameB = useRef(null), wrapA = useRef(null), wrapB = useRef(null);
  const chan = useRef({ A: null, B: null });
  const seqRef = useRef(0);
  const [leader, setLeader] = useState('A');
  const [enabled, setEnabled] = useState(true);
  const [connected, setConnected] = useState({ A: false, B: false });
  const [counts, setCounts] = useState({ mirrored: 0, diverged: 0 });
  const [lat, setLat] = useState({ n: 0, avg: 0, max: 0 });
  const [log, setLog] = useState([]);      // {key, kind, side, text, n}
  const [errors, setErrors] = useState([]);
  ...
  const originA = safeOrigin(srcA), originB = safeOrigin(srcB);
```

`SyncedPreviewProto.jsx:129-142` — the per-pane render helper (the dropdown
goes into this header row for side B):

```jsx
const pane = (side, ref, wrapRef, src) => {
  const lead = enabled && (leader === 'both' || leader === side);
  return (
    <div style={S.pane}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={S.badge(lead)}>{...}</span>
        <span style={S.mono}>{side} {connected[side] ? '✓ agent connected' : '… waiting for agent'} · {src}</span>
      </div>
      <div ref={wrapRef} style={S.frameWrap(height)}>
        <iframe ref={ref} src={src} style={S.iframe} title={'pane-' + side} />
      </div>
    </div>
  );
};
```

`local-demo.mjs:114-125` — the demo entry that mounts the host:

```js
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import SyncedPreviewProto from './SyncedPreviewProto.jsx';
createRoot(document.getElementById('root')).render(
  React.createElement(SyncedPreviewProto, {
    srcA: 'http://localhost:${PORT_A}/',
    srcB: 'http://localhost:${PORT_B}/',
    height: 520,
  })
);
`;
```

Conventions and constraints that apply (quoted so you don't need the source
docs):

- Repo `CLAUDE.md`: "**Self-contained**: the component must live in one folder
  with no imports from outside it … **Peer dependencies only** (e.g. `react`);
  no app-specific dependencies." → No new npm dependencies; use browser
  `fetch`.
- `docs/adr/0001-cross-origin-agent-bridge.md`: "**Host** (React component):
  owns iframes, event routing, leader/roles, divergence log. Never touches
  frame DOM." → The branch picker is host UI only; changing the pane B iframe
  `src` is allowed, reaching into the frame is not. `sync-agent.js` must not
  change.
- `CONTEXT.md` vocabulary (use these exact terms in names/comments): **Host**,
  **Agent**, **app under test**, **consuming app**, **Leader / Mirror**,
  **Divergence**. The two panes are `A` and `B`.
- Style: the component uses inline style objects in the `S` map
  (`SyncedPreviewProto.jsx:29-41`) — add any new styles there, matching the
  existing look (system-ui font, slate palette, 6–10px radii).

GitHub REST API facts (verified live with curl on 2026-08-18):

- `GET https://api.github.com/repos/{owner}/{repo}` → JSON object containing
  `default_branch` (e.g. `"main"`).
- `GET https://api.github.com/repos/{owner}/{repo}/branches?per_page=100&page=N`
  → JSON array of `{ name, commit, protected }`. `per_page` max is 100; a page
  shorter than `per_page` is the last page.
- Responses carry `access-control-allow-origin: *`, so unauthenticated
  browser-side `fetch` works cross-origin.
- Unauthenticated rate limit is 60 requests/hour per IP (observed
  `x-ratelimit-limit: 60`). Authenticated requests use an
  `Authorization: Bearer <token>` header.
- A renamed/moved repo returns `301` with a JSON `url` field; `fetch` follows
  redirects by default, so no special handling is needed.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `cd prototype-crossorigin && npm install` | exit 0 |
| Syntax/build check | `cd prototype-crossorigin && npx esbuild SyncedPreviewProto.jsx --bundle --external:react --external:react-dom --jsx=automatic --outfile=/dev/null` | exit 0, no errors |
| Demo (manual checks) | `cd prototype-crossorigin && node local-demo.mjs` | prints the four/five server URLs; open `http://localhost:4400/` |
| Demo build sanity | `cd prototype-crossorigin && timeout 15 node local-demo.mjs; test $? -eq 124` | server starts (killed by timeout = success; an esbuild error exits earlier with a build error message) |

There is no test, lint, or typecheck tooling in this repo (`CLAUDE.md`: "No
build, lint, or test tooling exists yet"). Verification is the esbuild build
plus the manual acceptance checks in the demo.

## Scope

**In scope** (the only files you should modify):

- `prototype-crossorigin/SyncedPreviewProto.jsx`
- `prototype-crossorigin/local-demo.mjs`
- `prototype-crossorigin/IMPLEMENT-SYNCED-PREVIEW.md`

**Out of scope** (do NOT touch, even though they look related):

- `prototype-crossorigin/sync-agent.js` — the feature is host-only; the
  agent/host message protocol does not change.
- `prototype-crossorigin/origin-keyed-store.mjs`, `demo-app.jsx` — mock/demo
  app internals, unaffected.
- `docs/research.md` — has strict evidence rules (every claim cites a primary
  source); this plan adds no research findings.
- `prototype-synced-preview.html`, `prototype-synced-preview.app.jsx` — the
  older same-origin prototype, kept frozen as reference.
- `CONTEXT.md`, `docs/adr/` — vocabulary/decision changes go through the
  repo's domain-modeling flow, not this plan (see Maintenance notes).

## Git workflow

- Branch: `feature/branch-selector` (repo precedent: `prototype/crossorigin-component`
  was a feature branch merged into `main`).
- Commit per step; message style is short imperative summary lines, no
  conventional-commit prefixes (repo examples: "Origin-keyed mock store: fix +
  demo + implementation brief", "Add CONTEXT.md glossary and ADR-0001").
- Do NOT push or open a PR unless the operator instructed it.

## New public interface (the contract to implement)

One new optional prop on the host component:

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

Behavior contract:

- **Without `branchPicker`**: behavior is byte-for-byte what it is today —
  `srcB` drives pane B. Backward compatible.
- **With `branchPicker`**: the `srcB` prop is ignored. Pane B's header gains a
  native `<select>` listing the repo's branches (default branch first, then
  alphabetical). Selecting a branch calls `resolvePreviewUrl(branchName)`; the
  returned URL becomes pane B's iframe `src`. Until a branch is selected and
  resolved, pane B shows a placeholder ("select a target branch") instead of an
  iframe.
- On every pane B URL change: pane B's agent channel and connected flag reset,
  and the mirrored/miss counters, latency stats, and divergence log clear
  (divergence measured against the previous branch is meaningless for the new
  one). The leader setting is left alone.
- Fetch or resolve errors render as a short inline error message in pane B's
  header row. No automatic retries; re-selecting a branch retries resolution.

## Steps

### Step 1: Branch-list fetching in the host

In `prototype-crossorigin/SyncedPreviewProto.jsx`:

1. Extend the signature: `({ srcA, srcB, height = 560, branchPicker })`.
2. Add state: `branches` (array of names, `null` while loading),
   `defaultBranch` (string|null), `targetBranch` (string|null, initialized to
   `branchPicker?.initialBranch ?? null`), `resolvedSrcB` (string|null),
   `resolving` (bool), `branchErr` (string|null).
3. Add a fetch effect, keyed on `branchPicker?.owner`, `branchPicker?.repo`,
   `branchPicker?.token`, `branchPicker?.apiBase`. Shape:

```jsx
useEffect(() => {
  if (!branchPicker) return;
  const { owner, repo, token, apiBase = 'https://api.github.com' } = branchPicker;
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const base = apiBase.replace(/\/$/, '') + '/repos/' +
    encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
  let dead = false;
  (async () => {
    try {
      const repoRes = await fetch(base, { headers });
      if (!repoRes.ok) throw new Error('GitHub ' + repoRes.status + ' fetching repo');
      const def = (await repoRes.json()).default_branch;
      const names = [];
      for (let page = 1; page <= 3; page++) {           // cap: 300 branches
        const r = await fetch(base + '/branches?per_page=100&page=' + page, { headers });
        if (!r.ok) throw new Error('GitHub ' + r.status + ' fetching branches');
        const batch = await r.json();
        names.push(...batch.map(b => b.name));
        if (batch.length < 100) break;
      }
      if (dead) return;
      names.sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
      setDefaultBranch(def);
      setBranches(names);
    } catch (err) {
      if (!dead) { setBranchErr(String(err && err.message || err)); setBranches([]); }
    }
  })();
  return () => { dead = true; };
}, [branchPicker && branchPicker.owner, branchPicker && branchPicker.repo,
    branchPicker && branchPicker.token, branchPicker && branchPicker.apiBase]);
```

   The 300-branch cap is deliberate; if the cap is hit (3rd page returns a full
   100), append a disabled `<option>` reading `…more branches not listed` so
   truncation is visible, per the component's "surface, never hide" principle.

**Verify**: `cd prototype-crossorigin && npx esbuild SyncedPreviewProto.jsx --bundle --external:react --external:react-dom --jsx=automatic --outfile=/dev/null` → exit 0.

### Step 2: Selection, URL resolution, and pane B rewiring

Still in `SyncedPreviewProto.jsx`:

1. Resolution effect with a latest-wins guard (the reviewer can switch
   branches while a slow `resolvePreviewUrl` is pending):

```jsx
const resolveSeq = useRef(0);
useEffect(() => {
  if (!branchPicker || !targetBranch) return;
  const id = ++resolveSeq.current;
  setResolving(true); setBranchErr(null);
  Promise.resolve(branchPicker.resolvePreviewUrl(targetBranch)).then(
    url => { if (resolveSeq.current === id) { setResolving(false); setResolvedSrcB(url); } },
    err => { if (resolveSeq.current === id) { setResolving(false); setBranchErr('resolvePreviewUrl: ' + String(err && err.message || err)); } }
  );
}, [targetBranch]);
```

2. Derive the effective pane B source and origin. Replace the current
   `const originB = safeOrigin(srcB)` (`SyncedPreviewProto.jsx:57`) with:

```jsx
const effectiveSrcB = branchPicker ? resolvedSrcB : srcB;
const originA = safeOrigin(srcA);
const originB = effectiveSrcB ? safeOrigin(effectiveSrcB) : null;
```

   The `null` guard matters: `safeOrigin(null)` would resolve `'null'` against
   `window.location.href` and return the *host page's* origin, which would let
   the message handler's `e.origin !== origins[side]` check pass for a
   same-origin `about:blank` frame. Keep `originB === null` when there is no
   URL — the existing `if (!side || e.origin !== origins[side]) return;` then
   rejects everything for pane B, which is correct.

3. Reset effect on pane B URL change (also covers switching back and forth):

```jsx
useEffect(() => {
  chan.current.B = null;
  setConnected(c => ({ ...c, B: false }));
  setCounts({ mirrored: 0, diverged: 0 });
  setLat({ n: 0, avg: 0, max: 0 });
  setLog([]);
}, [effectiveSrcB]);
```

   (It fires once on mount too; that only re-sets initial values.)

4. In the `pane(...)` helper: render pane B from `effectiveSrcB`; when
   `branchPicker` is set and `effectiveSrcB` is null, render the placeholder
   instead of the iframe inside the existing `S.frameWrap` div:

```jsx
<div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#94a3b8' }}>
  select a target branch
</div>
```

5. Add the dropdown and status text to pane B's header row (the flex div in
   the `pane` helper), only when `side === 'B' && branchPicker`:

```jsx
<select
  value={targetBranch ?? ''}
  onChange={e => setTargetBranch(e.target.value || null)}
  disabled={branches === null}
  style={S.select}
>
  <option value="">{branches === null ? 'loading branches…' : '— target branch —'}</option>
  {(branches ?? []).map(n => (
    <option key={n} value={n}>{n === defaultBranch ? n + ' (default)' : n}</option>
  ))}
</select>
{resolving && <span style={S.mono}>resolving…</span>}
{branchErr && <span style={{ color: '#dc2626', fontSize: 11 }}>{branchErr}</span>}
```

   Add `S.select` to the style map, matching the existing button styling:
   `{ padding: '3px 6px', borderRadius: 6, border: '1px solid #cbd5e1', font: 'inherit', background: '#fff', maxWidth: 220 }`.

6. Call sites: the JSX at the bottom renders
   `pane('B', frameB, wrapB, srcB)` — change to `effectiveSrcB`. Pane A is
   untouched. Nothing else reads `srcB`.

**Verify**: same esbuild command as Step 1 → exit 0.

### Step 3: Demo wiring — stub GitHub API + branchPicker props

In `prototype-crossorigin/local-demo.mjs`:

1. Add `PORT_GH = 4404` next to the existing port constants
   (`local-demo.mjs:23`). Add a stub GitHub API server so the demo runs
   offline and deterministically (same code path as the real API — only
   `apiBase` differs):

```js
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, accept');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/repos/demo/webapp') {
    res.end(JSON.stringify({ default_branch: 'main' }));
  } else if (path === '/repos/demo/webapp/branches') {
    res.end(JSON.stringify([{ name: 'feature/team-v2' }, { name: 'main' }]));
  } else { res.writeHead(404); res.end('{}'); }
}).listen(PORT_GH);
```

   (Branches deliberately listed out of order — the host must sort the default
   branch first.)

2. Replace `srcB` in the demo entry (`local-demo.mjs:114-125`) with the
   picker:

```js
React.createElement(SyncedPreviewProto, {
  srcA: 'http://localhost:${PORT_A}/',
  branchPicker: {
    owner: 'demo', repo: 'webapp',
    apiBase: 'http://localhost:${PORT_GH}',
    initialBranch: 'feature/team-v2',
    resolvePreviewUrl: (b) => b === 'main'
      ? 'http://localhost:${PORT_A}/'
      : 'http://localhost:${PORT_B}/',
  },
  height: 520,
})
```

3. Add the stub to the startup `console.log` block (`local-demo.mjs:206-210`),
   e.g. `  gh    http://localhost:4404/  (stub GitHub API)`.

**Verify**: `cd prototype-crossorigin && timeout 15 node local-demo.mjs; test $? -eq 124` → exits via timeout (build succeeded, servers started). A build error instead prints an esbuild error and exits non-zero before the timeout.

### Step 4: Manual acceptance run

Run `cd prototype-crossorigin && node local-demo.mjs`, open
`http://localhost:4400/`, and check:

| # | Action | Expected |
|---|---|---|
| 1 | Load page | Pane B header shows dropdown with `main (default)` first, then `feature/team-v2`; `feature/team-v2` pre-selected (initialBranch); pane B loads `:4402` and shows "✓ agent connected" |
| 2 | Interact in pane A (type, click) | Mirrors into pane B exactly as before the change |
| 3 | Select `main (default)` in the dropdown | Pane B reloads to `:4401`; counters, latency, and divergence log reset to zero/empty; agent reconnects |
| 4 | With both panes on main, click around in A | Interactions mirror; no `✕`/`△` entries (identical branch both sides) |
| 5 | Select `feature/team-v2` again | Pane B back on `:4402`; counters reset again; interacting with the renamed button logs `△` as before |
| 6 | Stop the demo, comment out the stub server's `.listen(PORT_GH)` line, restart, reload | Pane B header shows an inline error (fetch failed); the rest of the UI (pane A, leader buttons) still works. Revert the comment-out afterwards |
| 7 | Leader buttons A/B/both | Unchanged behavior |

If any row fails, fix within the in-scope files; if a fix seems to need
`sync-agent.js`, that is a STOP condition.

### Step 5: Document the feature in the implementation brief

In `prototype-crossorigin/IMPLEMENT-SYNCED-PREVIEW.md`, add a section
`## Optional: branch picker for pane B` between "Step 1 — mount the host" and
"Step 2 — inject the agent". It must contain, in the brief's existing style:

- The `branchPicker` prop shape from "New public interface" above, with the
  same field-by-field comments.
- The behavior contract bullets (backward compatibility; `srcB` ignored in
  picker mode; placeholder before selection; reset of channel/counters/log on
  branch switch; inline errors, no auto-retry).
- The division of responsibility, stated explicitly: the Host lists branches
  and renders selection; the **consuming app** maps branch name to a running
  app-under-test URL via `resolvePreviewUrl` (spinning up branch dev servers
  is out of the component's scope).
- A security note on `token`: it is exposed to the browser page; use a
  fine-grained personal access token scoped to the one repo, read-only
  (Contents/Metadata), short expiry, development only; never hardcode it —
  pass it from the consuming app's dev-only config. Unauthenticated works for
  public repos within 60 requests/hour/IP.
- Three new rows for the "Acceptance checks" table: initial branch list +
  preselect; branch switch resets counters/log and reconnects; fetch failure
  shows inline error without breaking pane A.

**Verify**: `grep -c "branchPicker" prototype-crossorigin/IMPLEMENT-SYNCED-PREVIEW.md` → ≥ 3.

## Test plan

No test runner exists in this repo (verified: no test tooling configured;
`CLAUDE.md` says to add commands here once scaffolded — scaffolding a test
framework is out of scope for this plan). The test plan is therefore:

- The esbuild build gate after Steps 1–2 (catches syntax/import errors).
- The demo startup gate after Step 3.
- The Step 4 manual acceptance table — all 7 rows must pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd prototype-crossorigin && npx esbuild SyncedPreviewProto.jsx --bundle --external:react --external:react-dom --jsx=automatic --outfile=/dev/null` exits 0
- [ ] `cd prototype-crossorigin && timeout 15 node local-demo.mjs; test $? -eq 124` succeeds
- [ ] `grep -c "branchPicker" prototype-crossorigin/SyncedPreviewProto.jsx` ≥ 5 and `grep -n "srcB" prototype-crossorigin/local-demo.mjs` returns no matches in the entry block (picker mode replaces it)
- [ ] `git diff --name-only` shows only the three in-scope files
- [ ] `git diff prototype-crossorigin/sync-agent.js` is empty
- [ ] All 7 rows of the Step 4 manual acceptance table pass (record the result in the commit message or PR notes)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows in-scope files changed since commit `f0a55aa` and the
  "Current state" excerpts no longer match the live code.
- The feature appears to require changes to `sync-agent.js` or the
  host↔agent message protocol — it must not; that means the design assumption
  "the branch picker is host-only" broke.
- Pane B fails to reconnect after a branch switch even though the demo app
  loads (would indicate the channel-reset in Step 2.3 interacts badly with the
  message-listener effect — report, don't patch around it by touching the
  protocol).
- You find yourself adding an npm dependency to make the GitHub fetch or the
  dropdown work — the self-contained/peer-deps-only constraint forbids it.
- The assumption "the consuming app can map a branch name to a running preview
  URL" turns out to be false for the intended consumer — that invalidates the
  `resolvePreviewUrl` contract and needs an operator decision, not a
  workaround.

## Maintenance notes

- **Vocabulary**: "target branch" is a natural new domain term. Adding it to
  `CONTEXT.md` (and possibly an ADR for the "component lists branches /
  consuming app resolves URLs" split) should go through the repo's
  domain-modeling flow — deliberately left out of this plan's scope.
- **When the real component supersedes the prototype**: carry the
  `branchPicker` prop and the brief section over; the prototype files are
  scheduled for deletion once vendored (`CLAUDE.md`).
- **Review scrutiny points**: the `originB === null` guard (Step 2.2) is
  security-relevant — a wrong fallback origin weakens the postMessage origin
  pinning that ADR-0001 requires; the latest-wins guard in Step 2.1 is what
  prevents a slow resolve from clobbering a newer selection.
- **Deferred follow-ups**: per-pane branch selection for pane A (currently
  pinned to `srcA`); auto-refresh of the branch list; pagination past 300
  branches; history-API navigation mirroring (a known pre-existing gap noted
  in the brief, unrelated to this feature).
