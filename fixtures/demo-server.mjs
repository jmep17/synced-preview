// Dev-only fixture servers for the synced-preview bridge. Not vendored.
//
//   node fixtures/demo-server.mjs            # origin-keyed mock (the fix)
//   node fixtures/demo-server.mjs --shared-mock   # reproduce the desync
//
// Serves four origins (the host is the Vite app on :5173, started separately
// via `pnpm dev` — its panes embed these):
//   :4401  demo app, branch A ("main")
//   :4402  demo app, branch B ("feature/team-v2") — deliberately divergent
//   :4403  stateful mock backend both apps call
//   :4404  stub GitHub API (branch picker demo, offline + deterministic)
//
// The demo app is compiled fresh at startup with esbuild, minified — the
// hostile no-testids case, directly comparable to docs/research.md Part 5.
// Pane pages load the agent from the Vite origin, exercising the real
// serving path (the serve-sync-agent plugin in app/vite.config.js).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import esbuild from 'esbuild';
import { createMockStore } from './origin-keyed-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP_ORIGIN = process.env.SP_APP_ORIGIN || 'http://localhost:5173';
const PORT_A = 4401, PORT_B = 4402, PORT_MOCK = 4403, PORT_GH = 4404;
// --shared-mock reproduces the stateful-shared-mock desync; default is the
// origin-keyed fix.
const SHARED = process.argv.includes('--shared-mock');

const appBuild = await esbuild.build({
  entryPoints: [join(here, 'demo-app.jsx')],
  bundle: true, minify: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const BUNDLE = appBuild.outputFiles[0].text;

const BRANCHES = {
  A: { id: 'A', label: 'main', accent: '#4f46e5',
       inviteLabel: 'Add member', extraMenuItem: false, frontCard: null },
  B: { id: 'B', label: 'feature/team-v2', accent: '#0d9488',
       inviteLabel: 'Invite teammate', extraMenuItem: true,
       frontCard: { name: 'Hedy Lamarr', role: 'Wireless' } },
};

const APP_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, sans-serif; color: #1e293b; background: #f8fafc; }
  .app { display: flex; flex-direction: column; height: 100vh; }
  .app-head { display: flex; align-items: center; gap: 18px; padding: 10px 16px; background: #fff; border-bottom: 1px solid #e2e8f0; flex: none; }
  .brand { font-weight: 700; font-size: 15px; }
  .badge { margin-left: 8px; font-size: 10.5px; padding: 2px 7px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; vertical-align: 1px; }
  nav { display: flex; gap: 4px; }
  nav a { padding: 6px 10px; border-radius: 6px; color: #475569; text-decoration: none; }
  nav a.on { background: color-mix(in srgb, var(--accent) 12%, white); color: var(--accent); font-weight: 600; }
  .view { padding: 14px 16px; flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 12px; color: #64748b; font-weight: 600; }
  .field input { padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; width: 180px; background: #fff; }
  .field input[data-focused] { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
  .btn { padding: 8px 14px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; font: inherit; cursor: pointer; color: #1e293b; }
  .btn[data-hovered] { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, white); }
  .btn[data-pressed] { transform: translateY(1px); background: color-mix(in srgb, var(--accent) 14%, white); }
  .btn[data-focus-visible] { outline: 2px solid var(--accent); outline-offset: 2px; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary[data-hovered] { filter: brightness(1.12); color: #fff; }
  .btn.icon { width: 34px; height: 34px; padding: 0; border-radius: 999px; font-style: italic; font-weight: 700; }
  .member-list { flex: 1; min-height: 120px; overflow: auto; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; display: flex; flex-direction: column; }
  .member-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: none; border-bottom: 1px solid #f1f5f9; background: #fff; font: inherit; text-align: left; cursor: pointer; flex: none; }
  .member-row[data-hovered] { background: color-mix(in srgb, var(--accent) 8%, white); }
  .member-row[data-pressed] { background: color-mix(in srgb, var(--accent) 16%, white); }
  .member-row[data-focus-visible] { outline: 2px solid var(--accent); outline-offset: -2px; }
  .avatar { width: 28px; height: 28px; border-radius: 999px; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 12px; flex: none; }
  .m-name { font-weight: 600; }
  .m-role { margin-left: auto; color: #64748b; font-size: 12px; }
  .popover, .tooltip { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, .14); }
  .menu { min-width: 175px; padding: 4px; outline: none; }
  .menu-item { padding: 8px 10px; border-radius: 6px; cursor: pointer; outline: none; }
  .menu-item[data-focused], .menu-item[data-hovered] { background: var(--accent); color: #fff; }
  .tooltip { padding: 6px 10px; font-size: 12px; max-width: 220px; }
  .tablist { display: flex; gap: 4px; border-bottom: 1px solid #e2e8f0; }
  .tab { padding: 8px 12px; cursor: pointer; border-bottom: 2px solid transparent; color: #64748b; outline: none; }
  .tab[data-selected] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .tab[data-hovered] { color: var(--accent); }
  .tab[data-focus-visible] { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tabpanel { padding: 14px 0; display: flex; flex-direction: column; gap: 14px; outline: none; }
  .switch { display: flex; align-items: center; gap: 8px; cursor: pointer; width: fit-content; }
  .switch .indicator { width: 34px; height: 20px; border-radius: 999px; background: #cbd5e1; transition: background .15s; position: relative; flex: none; }
  .switch .indicator::before { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 999px; background: #fff; transition: transform .15s; }
  .switch[data-selected] .indicator { background: var(--accent); }
  .switch[data-selected] .indicator::before { transform: translateX(14px); }
  .switch[data-hovered] .indicator { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, white); }
  .switch[data-focus-visible] .indicator { outline: 2px solid var(--accent); outline-offset: 2px; }
  .app-status { font: 11px/1.4 ui-monospace, monospace; padding: 6px 12px; background: #0f172a; color: #94a3b8; white-space: nowrap; overflow-x: auto; flex: none; }
`;

function appPage(branch) {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>demo app ' + branch.id + '</title>',
    // The agent goes in <head>, exactly as an app-under-test would include it.
    // Served by the Vite dev server (or preview) — the real serving path.
    '<script src="' + APP_ORIGIN + '/sync-agent.js"></' + 'script>',
    '<script>window.__BRANCH__=' + JSON.stringify(branch) + ';' +
      'window.__MOCK_URL__="http://localhost:' + PORT_MOCK + '";</' + 'script>',
    '<style>:root{--accent:' + branch.accent + '}</style>',
    '<style>' + APP_CSS + '</style>',
    '</head><body><div id="root" style="padding:20px;color:#94a3b8;font:13px system-ui">Booting compiled React app…</div>',
    '<script>' + BUNDLE + '\nwindow.__mountApp(window.__BRANCH__);</' + 'script>',
    '</body></html>',
  ].join('\n');
}

createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(appPage(BRANCHES.A));
}).listen(PORT_A);

createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(appPage(BRANCHES.B));
}).listen(PORT_B);

/* ---------- stateful mock server (the shared backend both branches call) ---------- */

const BASE_MEMBERS = [
  { name: 'Ada Lovelace', role: 'Engineering' },
  { name: 'Grace Hopper', role: 'Compilers' },
  { name: 'Alan Turing', role: 'Research' },
  { name: 'Katherine Johnson', role: 'Research' },
  { name: 'Margaret Hamilton', role: 'Engineering' },
  { name: 'Radia Perlman', role: 'Networking' },
  { name: 'Barbara Liskov', role: 'Research' },
  { name: 'Frances Allen', role: 'Compilers' },
  { name: 'Annie Easley', role: 'Engineering' },
  { name: 'Mary Jackson', role: 'Aerodynamics' },
];

const mock = createMockStore({ shared: SHARED, seed: () => ({ members: BASE_MEMBERS.slice() }) });

createServer((req, res) => {
  // CORS: reflect the caller's origin (cannot be '*' if credentials ever
  // matter, and reflecting is what makes Origin available to key on).
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  res.setHeader('content-type', 'application/json; charset=utf-8');

  const store = mock.storeFor(req);
  if (req.url === '/members' && req.method === 'GET') {
    res.end(JSON.stringify({ members: store.members, mode: mock.mode }));
  } else if (req.url === '/members' && req.method === 'POST') {
    store.members = [...store.members, { name: 'New Member ' + (store.members.length + 1), role: 'Pending' }];
    res.end(JSON.stringify({ members: store.members, mode: mock.mode }));
  } else if (req.url === '/reset' && req.method === 'POST') {
    store.members = BASE_MEMBERS.slice();
    res.end(JSON.stringify({ members: store.members, mode: mock.mode }));
  } else {
    res.writeHead(404); res.end('{}');
  }
}).listen(PORT_MOCK);

/* ---------- stub GitHub API (branch picker demo, offline + deterministic) ---------- */

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

console.log('synced-preview fixtures (host = Vite app, ' + APP_ORIGIN + '):');
console.log('  app A http://localhost:' + PORT_A + '/');
console.log('  app B http://localhost:' + PORT_B + '/');
console.log('  mock  http://localhost:' + PORT_MOCK + '/  (' + mock.mode + ')');
console.log('  gh    http://localhost:' + PORT_GH + '/  (stub GitHub API)');
