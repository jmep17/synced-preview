import React, { useMemo, useRef, useState } from 'react';
import SyncedPreview from './components/synced-preview';

// Pane URLs are configurable so the shell also works against real Vite panes
// behind dev-proxy/ (VITE_SRC_A / VITE_SRC_B in app/.env.local).
const SRC_A = import.meta.env.VITE_SRC_A || 'http://localhost:4401/';
const SRC_B = import.meta.env.VITE_SRC_B || 'http://localhost:4402/';
const GH_API = import.meta.env.VITE_GH_API || 'http://localhost:4404';
const GH_OWNER = import.meta.env.VITE_GH_OWNER || 'demo';
const GH_REPO = import.meta.env.VITE_GH_REPO || 'webapp';
const GH_TOKEN = import.meta.env.VITE_GH_TOKEN || null;
// e.g. https://{repo}-git-{branch}-{owner}.vercel.app/ — when set, works for
// any repo on such infra; otherwise only the two demo repos are mapped.
const PREVIEW_URL_TEMPLATE = import.meta.env.VITE_PREVIEW_URL_TEMPLATE || null;

// GitHub-API-shaped branch listing lives HERE, in the consuming app — the
// component takes a generic listBranches/resolvePreviewUrl pair and knows
// nothing about GitHub, owners, or repos. Parametrized by owner/repo so the
// app shell can rebuild it per active repo (see the picker useMemo below).
async function fetchBranches(owner, repo) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (GH_TOKEN) headers.Authorization = 'Bearer ' + GH_TOKEN;
  const base = GH_API.replace(/\/$/, '') + '/repos/' +
    encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
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

// Demo repos' default branches, used by the fallback mapping below (matches
// the fixtures/demo-server.mjs stub).
const DEMO_DEFAULT_BRANCH = { 'demo/webapp': 'main', 'demo/site': 'main' };

function slugify(branch) {
  return branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Preview-URL mapping stays the consuming app's job — the component only
// knows the resolved URL, never how it was derived.
function resolvePreview(owner, repo, branch) {
  const key = owner + '/' + repo;
  if (PREVIEW_URL_TEMPLATE) {
    return PREVIEW_URL_TEMPLATE
      .replace('{owner}', owner)
      .replace('{repo}', repo)
      .replace('{branch}', slugify(branch));
  }
  if (key in DEMO_DEFAULT_BRANCH) {
    return branch === DEMO_DEFAULT_BRANCH[key] ? SRC_A : SRC_B;
  }
  throw new Error('no preview mapping for ' + key + ' — set VITE_PREVIEW_URL_TEMPLATE');
}

// 'owner/repo' -> { owner, repo } or null on malformed input (exactly one
// '/', both halves non-empty after trimming).
function parseRepo(s) {
  const trimmed = (s || '').trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0].trim();
  const repo = parts[1].trim();
  if (!owner || !repo) return null;
  return { owner, repo };
}

function updateUrl(repoStr, branch) {
  const p = new URLSearchParams(window.location.search);
  p.set('repo', repoStr);
  if (branch) p.set('branch', branch); else p.delete('branch');
  history.replaceState(null, '', window.location.pathname + '?' + p.toString());
}

const styles = {
  header: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14, font: '13px/1.45 system-ui, sans-serif' },
  form: { display: 'flex', gap: 8, alignItems: 'center' },
  input: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', font: 'inherit', width: 220 },
  btn: { padding: '6px 14px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#4f46e5', color: '#fff', font: 'inherit', cursor: 'pointer' },
  err: { color: '#dc2626', fontSize: 12 },
};

export default function App() {
  // Read URL params once on mount; the initial branch is only meaningful
  // while the active repo is still the repo it came from — nulled on the
  // first repo-form submit (see below).
  const initialParams = useRef(new URLSearchParams(window.location.search));
  const initialRepoStr = initialParams.current.get('repo') || (GH_OWNER + '/' + GH_REPO);
  const initialBranchRef = useRef(initialParams.current.get('branch') || null);

  const [activeRepo, setActiveRepo] = useState(() => parseRepo(initialRepoStr) || { owner: GH_OWNER, repo: GH_REPO });
  const [repoInput, setRepoInput] = useState(initialRepoStr);
  const [parseErr, setParseErr] = useState(null);

  const picker = useMemo(() => {
    const { owner, repo } = activeRepo;
    const initialBranch = initialBranchRef.current;
    return {
      listBranches: () => fetchBranches(owner, repo),
      resolvePreviewUrl: (branch) => resolvePreview(owner, repo, branch),
      initialBranch,
      onBranchChange: (b) => updateUrl(owner + '/' + repo, b),
    };
  }, [activeRepo.owner, activeRepo.repo]);

  const submitRepo = (e) => {
    e.preventDefault();
    const parsed = parseRepo(repoInput);
    if (!parsed) { setParseErr('expected owner/repo'); return; }
    setParseErr(null);
    initialBranchRef.current = null;   // old repo's branch must not leak into the new repo's URL
    setActiveRepo(parsed);
    updateUrl(parsed.owner + '/' + parsed.repo, null);
  };

  return (
    <div>
      <div style={styles.header}>
        <form style={styles.form} onSubmit={submitRepo}>
          <input
            style={styles.input}
            value={repoInput}
            onChange={e => setRepoInput(e.target.value)}
            placeholder="owner/repo"
          />
          <button type="submit" style={styles.btn}>Load</button>
          {parseErr && <span style={styles.err}>{parseErr}</span>}
        </form>
      </div>
      <SyncedPreview
        srcA={SRC_A}
        branchPicker={picker}
        height={520}
      />
    </div>
  );
}
