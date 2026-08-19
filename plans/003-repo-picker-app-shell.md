# Plan 003: App-shell repo picker — choose which GitHub repo (and branch) drives pane B

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 992586e..HEAD -- app/src/App.jsx app/src/components/synced-preview/SyncedPreview.jsx fixtures/demo-server.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (plan 001 already merged; this builds on its result)
- **Category**: direction
- **Planned at**: commit `992586e`, 2026-08-19

## Why this matters

The synced-preview app already lets a reviewer pick a **target branch** for
pane B (plan 001, merged). But the GitHub owner/repo is frozen at dev-server
start via env vars (`VITE_GH_OWNER` / `VITE_GH_REPO` in `app/src/App.jsx`).
The requested feature: the user chooses the repo *and* the target branch in
the UI, and the choice is shareable via URL query params.

Decided design (operator-confirmed): the repo picker lives in the **app
shell** (`app/src/App.jsx`), not in the vendored component. The component
keeps its generic `listBranches` / `resolvePreviewUrl` contract and stays
GitHub-agnostic. The app shell rebuilds those two callbacks whenever the repo
changes; the component already re-fetches branches when the `listBranches`
identity changes (`SyncedPreview.jsx:97`).

Two small, backward-compatible component changes ARE required (found by
reading the code, see Step 1's rationale):

1. When `listBranches` identity changes (repo switch), the component must
   reset its picker state (`branches`, `targetBranch`, `resolvedSrcB`,
   `branchErr`, `defaultBranch`, `truncated`). Today the old repo's branch
   list, selection, and resolved pane-B URL survive the switch, and the
   resolve effect is keyed only on `targetBranch` (`SyncedPreview.jsx:107`),
   so a same-named branch in the new repo would never re-resolve.
2. An optional `onBranchChange(branchName|null)` callback in `branchPicker`,
   so the app shell can write the selected branch into the URL. Today the
   selection is component-internal state with no way to observe it.

## Current state

All excerpts as of commit `992586e`.

Relevant files:

- `app/src/App.jsx` (54 lines) — app shell. Fixed repo via env; module-level
  `listBranches` (GitHub-API-shaped, stub-compatible via `VITE_GH_API`) and
  `resolvePreviewUrl`. Mounts `SyncedPreview` with `branchPicker`.
- `app/src/components/synced-preview/SyncedPreview.jsx` (278 lines) — the
  vendored Host component. Owns the branch dropdown in pane B's header.
- `app/src/components/synced-preview/README.md` — the component's vendoring
  README documenting the `branchPicker` contract.
- `fixtures/demo-server.mjs` (185 lines) — dev fixtures: apps under test
  (:4401/:4402), stateful mock (:4403), stub GitHub API (:4404) currently
  knowing exactly one repo, `demo/webapp`.

`app/src/App.jsx:6-11` — env-frozen config:

```jsx
const SRC_A = import.meta.env.VITE_SRC_A || 'http://localhost:4401/';
const SRC_B = import.meta.env.VITE_SRC_B || 'http://localhost:4402/';
const GH_API = import.meta.env.VITE_GH_API || 'http://localhost:4404';
const GH_OWNER = import.meta.env.VITE_GH_OWNER || 'demo';
const GH_REPO = import.meta.env.VITE_GH_REPO || 'webapp';
const GH_TOKEN = import.meta.env.VITE_GH_TOKEN || null;
```

`app/src/App.jsx:13-40` — module-level callbacks (comment explains they are
module-level for referential stability; this plan replaces that mechanism
with `useMemo` keyed on the chosen repo):

```jsx
// GitHub-API-shaped branch listing lives HERE, in the consuming app — the
// component takes a generic listBranches/resolvePreviewUrl pair and knows
// nothing about GitHub. Module-level so its identity is stable (the
// component uses it as an effect dependency).
async function listBranches() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (GH_TOKEN) headers.Authorization = 'Bearer ' + GH_TOKEN;
  const base = GH_API.replace(/\/$/, '') + '/repos/' +
    encodeURIComponent(GH_OWNER) + '/' + encodeURIComponent(GH_REPO);
  const repoRes = await fetch(base, { headers });
  if (!repoRes.ok) throw new Error('GitHub ' + repoRes.status + ' fetching repo');
  const defaultBranch = (await repoRes.json()).default_branch;
  const branches = [];
  let truncated = false;
  for (let page = 1; page <= 3; page++) {           // cap: 300 branches
    const r = await fetch(base + '/branches?per_page=100&page=' + page, { headers });
    if (!r.ok) throw new Error('GitHub ' + r.status + ' fetching branches');
    const batch = await r.json();
    branches.push(...batch.map(b => b.name));
    if (batch.length < 100) break;
    if (page === 3) truncated = true;
  }
  return { branches, defaultBranch, truncated };
}

function resolvePreviewUrl(branch) {
  return branch === 'main' ? SRC_A : SRC_B;
}
```

`app/src/App.jsx:42-54` — the mount:

```jsx
export default function App() {
  return (
    <SyncedPreview
      srcA={SRC_A}
      branchPicker={{
        listBranches,
        resolvePreviewUrl,
        initialBranch: 'feature/team-v2',
      }}
      height={520}
    />
  );
}
```

`SyncedPreview.jsx:70-97` — picker state and the branch-list effect (note:
nothing resets state when `listBranches` changes):

```jsx
  // Branch picker state (pane B only).
  const [branches, setBranches] = useState(null);
  const [defaultBranch, setDefaultBranch] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [targetBranch, setTargetBranch] = useState(branchPicker && branchPicker.initialBranch ? branchPicker.initialBranch : null);
  const [resolvedSrcB, setResolvedSrcB] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [branchErr, setBranchErr] = useState(null);
  const resolveSeq = useRef(0);
  const listBranches = branchPicker && branchPicker.listBranches;

  useEffect(() => {
    if (!listBranches) return;
    let dead = false;
    (async () => {
      try {
        const { branches: names, defaultBranch: def, truncated: trunc } = await listBranches();
        if (dead) return;
        const sorted = [...names].sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
        setDefaultBranch(def ?? null);
        setTruncated(!!trunc);
        setBranches(sorted);
      } catch (err) {
        if (!dead) { setBranchErr(String(err && err.message || err)); setBranches([]); }
      }
    })();
    return () => { dead = true; };
  }, [listBranches]);
```

`SyncedPreview.jsx:99-107` — the resolve effect (keyed only on
`targetBranch`):

```jsx
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

`SyncedPreview.jsx:204-217` — the dropdown whose `onChange` must also notify
the new callback:

```jsx
              <select
                value={targetBranch ?? ''}
                onChange={e => setTargetBranch(e.target.value || null)}
                disabled={branches === null}
                style={S.select}
              >
```

`fixtures/demo-server.mjs:168-179` — the stub GitHub API (one repo only):

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

Conventions and constraints that apply (quoted so you don't need the source
docs):

- Repo `CLAUDE.md`: "**Self-contained**: the component must live in one
  folder with no imports from outside it … **Peer dependencies only** (e.g.
  `react`); no app-specific dependencies." → No new npm dependencies
  anywhere in this plan; browser `fetch` and `URLSearchParams` only.
- Repo `CLAUDE.md`: "**Single agent copy**: … Never copy it into `public/`".
  This plan never touches `sync-agent.js` or `app/vite.config.js`.
- `docs/adr/0001-cross-origin-agent-bridge.md`: the Host never touches frame
  DOM; the agent/host message protocol must not change.
- `docs/adr/0002-vite-product-app.md`: the app is a Vite + React SPA; the
  component stays plain React, GitHub-agnostic (the GitHub-shaped fetch lives
  in the consuming app — preserve that split).
- `CONTEXT.md` vocabulary (use these exact terms in names/comments):
  **Host**, **Agent**, **app under test**, **consuming app**, **Leader /
  Mirror**, **Divergence**, **target branch**. Panes are `A` and `B`.
- Style: inline style objects; the component keeps its `S` map
  (`SyncedPreview.jsx:29-42`); `App.jsx` may declare its own small style
  objects. System-ui font, slate palette, 6–10px radii.
- Comment style: sparse, explaining constraints (see the "must be
  referentially stable" comment at `SyncedPreview.jsx:51-52`). Match it.

## Commands you will need

| Purpose | Command (repo root) | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Build gate | `pnpm build` | exit 0; dist contains unhashed `sync-agent.js` |
| Dev servers | `pnpm dev` | Vite on :5173 + fixtures on :4401–:4404 |
| Existing tests | `pnpm test` | mock-proxy suite passes (unrelated to this plan; run once at the end to prove no collateral damage) |

There is no lint or typecheck tooling (`CLAUDE.md`). Verification is
`pnpm build` plus the manual acceptance table in Step 5.

## Scope

**In scope** (the only files you should modify):

- `app/src/App.jsx`
- `app/src/components/synced-preview/SyncedPreview.jsx`
- `app/src/components/synced-preview/README.md`
- `fixtures/demo-server.mjs`

**Out of scope** (do NOT touch, even though they look related):

- `app/src/components/synced-preview/sync-agent.js` — protocol unchanged.
- `app/vite.config.js` — agent-serving plugin unchanged.
- `dev-proxy/` — Caddy proxy config unrelated.
- `tools/mock-proxy/` — plan 002's tool, unrelated.
- `docs/research.md`, `CONTEXT.md`, `docs/adr/` — evidence/vocabulary docs;
  changes go through the repo's domain-modeling flow (see Maintenance notes).

## Git workflow

- Branch: `feature/repo-picker` (repo precedent: `feature/branch-selector`,
  `advisor/002-mock-proxy-auto-detect`).
- Commit per step; short imperative summary lines (repo examples: "Add GitHub
  branch picker to pane B host component", "Wire branch-picker demo: stub
  GitHub API + demo props").
- Do NOT push or open a PR unless the operator instructed it.

## New public interface (the contract to implement)

Component (`branchPicker` prop) — two additions, both optional and backward
compatible:

```jsx
branchPicker={{
  listBranches,                 // unchanged contract; NEW: changing its
                                // identity now resets all picker state
  resolvePreviewUrl,            // unchanged
  initialBranch: 'main',        // unchanged
  onBranchChange: (b) => {},    // NEW, optional: fires with the branch name
                                // (string) or null whenever the selection
                                // changes via the dropdown
}}
```

App shell (`App.jsx`) — new UI above the component:

- A repo form: one text input accepting `owner/repo` (e.g. `demo/webapp`)
  plus a "Load" button (form submit). Submitting sets the active repo.
- URL query params, read once on mount and written (via
  `history.replaceState`, no reload) on every change:
  - `?repo=owner/name` — active repo; falls back to env
    `VITE_GH_OWNER`/`VITE_GH_REPO` (`demo`/`webapp` by default).
  - `&branch=name` — selected target branch; becomes `initialBranch`; kept
    current via `onBranchChange`.
- Per-repo callbacks: `listBranches` and `resolvePreviewUrl` are built with
  `useMemo` keyed on the active `owner`/`repo` — a new repo produces new
  function identities, which is exactly what triggers the component's
  refetch-and-reset.
- Preview-URL mapping stays the consuming app's job. Mapping rule:
  - If env `VITE_PREVIEW_URL_TEMPLATE` is set (e.g.
    `https://{repo}-git-{branch}-{owner}.vercel.app/`), fill `{owner}`,
    `{repo}`, `{branch}` (branch: lowercased, non-alphanumerics collapsed to
    `-`, Vercel-style) and return it — works for any repo on such infra.
  - Else, for the two demo repos (`demo/webapp`, `demo/site`): branch equal
    to the repo's default branch → `SRC_A`, anything else → `SRC_B`.
  - Else throw `new Error('no preview mapping for <owner>/<repo> — set VITE_PREVIEW_URL_TEMPLATE')`;
    the component already renders resolve errors inline in pane B's header
    (`SyncedPreview.jsx:219`), which is the desired surfaced-not-hidden
    behavior.

Fixtures — the stub GitHub API gains a second repo `demo/site` (default
branch `main`, branches `main`, `redesign`) so repo switching is
demonstrable offline.

## Steps

### Step 1: Component — reset picker state on `listBranches` change, add `onBranchChange`

In `app/src/components/synced-preview/SyncedPreview.jsx`:

1. In the branch-list effect (`SyncedPreview.jsx:81-97`), reset picker state
   at the top of the effect body, before the async fetch — this runs exactly
   when `listBranches` identity changes, which after this plan means "the
   consuming app switched repos":

```jsx
  useEffect(() => {
    if (!listBranches) return;
    // listBranches identity change = the consuming app switched repos:
    // everything derived from the old repo is now meaningless.
    setBranches(null);
    setDefaultBranch(null);
    setTruncated(false);
    setBranchErr(null);
    setResolvedSrcB(null);
    setResolving(false);
    setTargetBranch(t => (branchPicker && branchPicker.initialBranch) ?? null);
    let dead = false;
    ...
```

   Note on the mount case: this effect already ran once on mount; the resets
   re-set initial values, matching the existing pattern documented at
   `SyncedPreview.jsx:113-115`. Note on `initialBranch`: re-reading it here
   lets the app shell pass a URL-provided branch for the first repo; use the
   functional form only if needed to avoid lint noise — there is no linter,
   so a direct `setTargetBranch(branchPicker?.initialBranch ?? null)` inside
   the effect is fine; do NOT add `branchPicker` object identity to the
   dependency array (the object literal changes every render — keying on it
   would refetch every render; keep the dependency array exactly
   `[listBranches]`).

2. Fix the stale-resolve gap: the resolve effect (`SyncedPreview.jsx:99-107`)
   currently re-runs only when `targetBranch` changes. Because step 1.1
   resets `targetBranch` on repo switch, re-selecting a branch (even a
   same-named one) is a state change from `null`, so keying on
   `targetBranch` alone remains correct after the reset. No dependency
   change needed — verify this reasoning holds when you read the live code;
   if `targetBranch` can survive a repo switch in your implementation, that
   is a bug in step 1.1.

3. In the dropdown `onChange` (`SyncedPreview.jsx:206`), notify the consuming
   app:

```jsx
onChange={e => {
  const b = e.target.value || null;
  setTargetBranch(b);
  if (branchPicker.onBranchChange) branchPicker.onBranchChange(b);
}}
```

4. Update the JSDoc block (`SyncedPreview.jsx:44-55`): document
   `onBranchChange?: (branch: string | null) => void` and the new reset
   behavior of `listBranches` identity changes.

**Verify**: `pnpm build` → exit 0.

### Step 2: App shell — repo state, URL params, per-repo callbacks

Rewrite `app/src/App.jsx`. Keep the env constants (`SRC_A`, `SRC_B`,
`GH_API`, `GH_TOKEN`; `GH_OWNER`/`GH_REPO` become the *fallback* repo).
Structure:

1. Read URL params once (module level or lazy `useState` initializer):

```jsx
const params = new URLSearchParams(window.location.search);
const initialRepo = params.get('repo') || (GH_OWNER + '/' + GH_REPO);
const initialBranchFromUrl = params.get('branch') || null;
```

2. `useState` for the active repo string (`'owner/name'`) and a small helper
   `parseRepo(s)` returning `{ owner, repo }` or `null` on malformed input
   (must contain exactly one `/`, both halves non-empty; trim whitespace).
   Malformed submit: show an inline error next to the form, do not change
   the active repo.

3. `useMemo` the callbacks, keyed on the active owner/repo:

```jsx
const picker = useMemo(() => {
  const { owner, repo } = parsed;                    // parsed active repo
  return {
    listBranches: () => fetchBranches(owner, repo),  // move today's module-level
                                                     // body into fetchBranches(owner, repo)
    resolvePreviewUrl: (branch) => resolvePreview(owner, repo, branch),
    initialBranch: /* URL branch for the initial repo, else null */,
    onBranchChange: (b) => updateUrl(owner + '/' + repo, b),
  };
}, [parsed.owner, parsed.repo]);
```

   `fetchBranches(owner, repo)` is today's `listBranches` body
   (`App.jsx:17-36`) with `GH_OWNER`/`GH_REPO` replaced by the arguments —
   keep the pagination, cap comment, `truncated` flag, and header logic
   byte-for-byte otherwise. IMPORTANT: `listBranches: () => fetchBranches(owner, repo)`
   is a NEW arrow per `useMemo` evaluation — that is intentional (new repo →
   new identity → component resets); `useMemo` keeps it stable *within* a
   repo. Preserve the spirit of the old stability comment by updating it:
   the identity is now stable per-repo via `useMemo`, and identity change is
   the repo-switch signal.

4. `resolvePreview(owner, repo, branch)` implementing the mapping rule from
   "New public interface" above. Vercel-style branch slug:
   `branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')`.
   The demo mapping needs each demo repo's default branch; hardcode
   `'main'` for both demo repos (matches the stub).

5. `updateUrl(repoStr, branch)`:

```jsx
function updateUrl(repoStr, branch) {
  const p = new URLSearchParams(window.location.search);
  p.set('repo', repoStr);
  if (branch) p.set('branch', branch); else p.delete('branch');
  history.replaceState(null, '', window.location.pathname + '?' + p.toString());
}
```

   Call it from `onBranchChange` and from the repo-form submit (with
   `branch` cleared — a branch from the old repo must not leak into the new
   repo's URL).

6. Render: a header row (match the app's existing minimal styling) with a
   form — `<input>` (defaultValue = active repo string, placeholder
   `owner/repo`), a submit button labeled `Load`, and the inline parse-error
   span — then the `<SyncedPreview>` mount below, `srcA={SRC_A}`,
   `branchPicker={picker}`, `height={520}`.

   `initialBranch`: pass `initialBranchFromUrl` only while the active repo
   is still the initial repo (simplest: keep `initialBranchFromUrl` in a
   ref and null it on the first repo-form submit).

7. `token`: keep reading `VITE_GH_TOKEN`. Do not add a token input field —
   a token pasted into a URL-synced UI risks ending up in share links; env
   only (this is the same dev-only posture plan 001 documented).

**Verify**: `pnpm build` → exit 0.

### Step 3: Fixtures — second repo in the stub GitHub API

In `fixtures/demo-server.mjs`, replace the stub's route ifs
(`demo-server.mjs:174-178`) with a small repo table so adding repos stays
one-line:

```js
const ghRepos = {
  'demo/webapp': { default_branch: 'main', branches: ['feature/team-v2', 'main'] },
  'demo/site':   { default_branch: 'main', branches: ['redesign', 'main'] },
};
```

Handler: `/repos/{owner}/{repo}` → `{ default_branch }`;
`/repos/{owner}/{repo}/branches` → `[{ name }, ...]` (keep branches listed
out of order — the Host must sort the default branch first); unknown repo →
404 `{}` (this is what exercises the app shell's error path for a repo the
stub doesn't know). Keep the CORS headers and OPTIONS handling exactly as
they are.

**Verify**: `node --check fixtures/demo-server.mjs` → exit 0.

### Step 4: Component README — document the contract additions

In `app/src/components/synced-preview/README.md`, update the `branchPicker`
documentation:

- Add `onBranchChange` with its signature and firing rule (dropdown changes
  only; not fired by programmatic resets).
- Document the new reset semantics: "changing the `listBranches` identity
  resets all picker state (branch list, selection, resolved pane B URL) —
  swap in a new `listBranches` to point the picker at a different repo; keep
  it referentially stable (useMemo/module-level) otherwise."
- Add a short "Repo switching" consuming-app example mirroring the `useMemo`
  pattern from Step 2.3.

**Verify**: `grep -c "onBranchChange" app/src/components/synced-preview/README.md` ≥ 2.

### Step 5: Manual acceptance run

`pnpm dev`, open `http://localhost:5173/`:

| # | Action | Expected |
|---|---|---|
| 1 | Load page (no query params) | Repo input shows `demo/webapp`; branch dropdown lists `main (default)` then `feature/team-v2`; URL gains `?repo=demo%2Fwebapp` (or `demo/webapp`) after first interaction |
| 2 | Select `feature/team-v2` | Pane B loads :4402, agent connects; URL now has `&branch=feature%2Fteam-v2` |
| 3 | Interact in pane A | Mirrors into pane B as before (regression check) |
| 4 | Enter `demo/site`, click Load | Dropdown clears to `loading branches…` then lists `main (default)`, `redesign`; pane B shows "select a target branch" placeholder; counters/divergence log reset; URL `repo` updated, `branch` param gone |
| 5 | Select `redesign` | Pane B loads :4402 via demo mapping; agent connects |
| 6 | Enter `demo/nope`, click Load | Inline error in pane B header (GitHub 404 from stub); pane A and leader buttons still work |
| 7 | Enter `nonsense` (no slash), click Load | Inline parse error next to the form; active repo unchanged |
| 8 | Copy URL from step 2, open in new tab | Same repo AND branch restored; pane B connects without manual selection |
| 9 | Leader buttons A/B/both | Unchanged behavior |

If any row fails, fix within the in-scope files; if a fix seems to need
`sync-agent.js` or the message protocol, that is a STOP condition.

## Test plan

`pnpm test` covers only the mock proxy; no app/component test runner exists
(scaffolding one is out of scope — see plans/README.md rejected list).
Gates:

- `pnpm build` after Steps 1 and 2.
- `node --check fixtures/demo-server.mjs` after Step 3.
- The Step 5 manual acceptance table — all 9 rows must pass.
- `pnpm test` once at the end → still passes (proves no collateral damage).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm build` exits 0
- [ ] `pnpm test` exits 0
- [ ] `node --check fixtures/demo-server.mjs` exits 0
- [ ] `grep -c "onBranchChange" app/src/components/synced-preview/SyncedPreview.jsx` ≥ 2
- [ ] `grep -c "demo/site" fixtures/demo-server.mjs` ≥ 1
- [ ] `git diff --name-only main` shows only the four in-scope files
- [ ] `git diff main -- app/src/components/synced-preview/sync-agent.js app/vite.config.js` is empty
- [ ] All 9 rows of the Step 5 manual acceptance table pass (record in commit message or PR notes)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows in-scope files changed since `992586e` and the
  "Current state" excerpts no longer match the live code.
- The feature appears to require changes to `sync-agent.js` or the
  host↔agent message protocol.
- The Step 1 reset interacts badly with the message-listener or pane-B reset
  effects (e.g. pane B fails to reconnect after a repo switch even though
  the demo app loads) — report, don't patch the protocol.
- You find yourself adding an npm dependency — the self-contained /
  peer-deps-only constraint forbids it.
- You find yourself wanting the *component* to know about repos, owners, or
  GitHub — that breaks the decided split (component = generic callbacks;
  app shell = GitHub + repo choice). Needs an operator decision.

## Maintenance notes

- **Vocabulary**: "active repo" / "repo switch" are candidate `CONTEXT.md`
  terms; adding them (and possibly an ADR for the "identity change = repo
  switch" signal) goes through the repo's domain-modeling flow, not this
  plan.
- **Review scrutiny points**: (1) the Step 1 reset must clear
  `resolvedSrcB` — a stale resolved URL keeps pane B on the old repo's
  preview while showing the new repo's branch list; (2) `onBranchChange`
  must fire only from user selection, not from the reset, or the URL's
  `branch` param gets clobbered with `null` mid-switch — the Step 1 reset
  path calls `setTargetBranch` directly and must NOT call `onBranchChange`;
  (3) tokens must stay out of URL params.
- **Deferred follow-ups**: repo autocomplete from `GET /user/repos` or
  `/orgs/{org}/repos` (needs a token; adds auth UX); per-pane repo/branch
  for pane A; persisting recent repos in `localStorage`;
  `VITE_PREVIEW_URL_TEMPLATE` per-repo overrides.
- **Interaction with future work**: if the component is vendored into a
  consuming app before this merges, re-vendor after — the `branchPicker`
  contract gains `onBranchChange` and the reset semantics.
