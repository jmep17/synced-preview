import React from 'react';
import SyncedPreview from './components/synced-preview';

// Pane URLs are configurable so the shell also works against real Vite panes
// behind dev-proxy/ (VITE_SRC_A / VITE_SRC_B in app/.env.local).
const SRC_A = import.meta.env.VITE_SRC_A || 'http://localhost:4401/';
const SRC_B = import.meta.env.VITE_SRC_B || 'http://localhost:4402/';
const GH_API = import.meta.env.VITE_GH_API || 'http://localhost:4404';
const GH_OWNER = import.meta.env.VITE_GH_OWNER || 'demo';
const GH_REPO = import.meta.env.VITE_GH_REPO || 'webapp';
const GH_TOKEN = import.meta.env.VITE_GH_TOKEN || null;

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
