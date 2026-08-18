'use client';
// PROTOTYPE — THROWAWAY. Cross-origin synced-preview host component.
//
// Renders two iframes pointed at two dev servers (different origins) and
// routes serialized events between the sync agents running inside them
// (sync-agent.js) over postMessage. The host never touches the frames'
// DOM — that is the point: this prototype answers whether the mirroring
// bridge works CROSS-ORIGIN.
//
// Works in Next.js App Router as a client component; plain React otherwise.

import React, { useEffect, useRef, useState } from 'react';

const LOGGABLE = new Set(['pointerdown', 'click', 'dblclick', 'keydown', 'input', 'focusin', 'hashnav']);
const hasSemantic = d => !!(d && d.strategies && d.strategies.some(s =>
  s.kind === 'aria' || s.kind === 'text' || s.kind === 'id' || s.kind === 'testid'));
function descSummary(d) {
  if (!d) return '(document)';
  const s = (d.strategies || []).find(x => x.kind === 'aria' || x.kind === 'text');
  const label = s ? '"' + (s.name || s.text) + '"' : '';
  return '<' + String(d.tag || '?').toLowerCase() + '> ' + label;
}
function safeOrigin(u) {
  try { return new URL(u, typeof window !== 'undefined' ? window.location.href : 'http://localhost').origin; }
  catch { return null; }
}
const blockedFor = (side, leader, enabled) => enabled && leader !== 'both' && side !== leader;

const S = {
  root: { display: 'flex', flexDirection: 'column', gap: 10, font: '13px/1.45 system-ui, sans-serif', color: '#1e293b' },
  bar: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '8px 10px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 10 },
  group: { display: 'flex', gap: 4, alignItems: 'center' },
  btn: on => ({ padding: '4px 10px', borderRadius: 6, border: '1px solid #cbd5e1', cursor: 'pointer', background: on ? '#4f46e5' : '#fff', color: on ? '#fff' : '#1e293b', font: 'inherit' }),
  panes: { display: 'flex', gap: 10 },
  pane: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  badge: lead => ({ alignSelf: 'flex-start', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: lead ? '#4f46e5' : '#94a3b8', color: '#fff' }),
  frameWrap: h => ({ height: h, border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', background: '#fff' }),
  iframe: { width: '100%', height: '100%', border: 'none', display: 'block' },
  mono: { font: '11px/1.5 ui-monospace, monospace', color: '#475569' },
  list: { margin: 0, padding: '6px 10px', listStyle: 'none', maxHeight: 140, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', font: '11.5px/1.6 ui-monospace, monospace' },
  select: { padding: '3px 6px', borderRadius: 6, border: '1px solid #cbd5e1', font: 'inherit', background: '#fff', maxWidth: 220 },
};

export default function SyncedPreviewProto({ srcA, srcB, height = 560, branchPicker }) {
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
  const stateRef = useRef(null);
  stateRef.current = { leader, enabled };

  // Branch picker state (pane B only; see IMPLEMENT-SYNCED-PREVIEW.md).
  const [branches, setBranches] = useState(null);
  const [defaultBranch, setDefaultBranch] = useState(null);
  const [targetBranch, setTargetBranch] = useState(branchPicker && branchPicker.initialBranch ? branchPicker.initialBranch : null);
  const [resolvedSrcB, setResolvedSrcB] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [branchErr, setBranchErr] = useState(null);
  const resolveSeq = useRef(0);

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
        let truncated = false;
        for (let page = 1; page <= 3; page++) {           // cap: 300 branches
          const r = await fetch(base + '/branches?per_page=100&page=' + page, { headers });
          if (!r.ok) throw new Error('GitHub ' + r.status + ' fetching branches');
          const batch = await r.json();
          names.push(...batch.map(b => b.name));
          if (batch.length < 100) break;
          if (page === 3) truncated = true;
        }
        if (dead) return;
        names.sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
        setDefaultBranch(def);
        setBranches(truncated ? [...names, '__truncated__'] : names);
      } catch (err) {
        if (!dead) { setBranchErr(String(err && err.message || err)); setBranches([]); }
      }
    })();
    return () => { dead = true; };
  }, [branchPicker && branchPicker.owner, branchPicker && branchPicker.repo,
      branchPicker && branchPicker.token, branchPicker && branchPicker.apiBase]);

  useEffect(() => {
    if (!branchPicker || !targetBranch) return;
    const id = ++resolveSeq.current;
    setResolving(true); setBranchErr(null);
    Promise.resolve(branchPicker.resolvePreviewUrl(targetBranch)).then(
      url => { if (resolveSeq.current === id) { setResolving(false); setResolvedSrcB(url); } },
      err => { if (resolveSeq.current === id) { setResolving(false); setBranchErr('resolvePreviewUrl: ' + String(err && err.message || err)); } }
    );
  }, [targetBranch]);

  const effectiveSrcB = branchPicker ? resolvedSrcB : srcB;
  const originA = safeOrigin(srcA);
  const originB = effectiveSrcB ? safeOrigin(effectiveSrcB) : null;

  // Reset pane B's channel/counters/log whenever its resolved URL changes —
  // divergence measured against the previous branch is meaningless for the
  // new one. Fires once on mount too; that just re-sets initial values.
  useEffect(() => {
    chan.current.B = null;
    setConnected(c => ({ ...c, B: false }));
    setCounts({ mirrored: 0, diverged: 0 });
    setLat({ n: 0, avg: 0, max: 0 });
    setLog([]);
  }, [effectiveSrcB]);

  useEffect(() => {
    const origins = { A: originA, B: originB };
    const frames = { A: frameA, B: frameB };
    const sideOf = source => {
      if (frames.A.current && source === frames.A.current.contentWindow) return 'A';
      if (frames.B.current && source === frames.B.current.contentWindow) return 'B';
      return null;
    };
    const sendTo = (side, msg) => {
      const c = chan.current[side];
      if (c) c.win.postMessage(msg, c.origin);
    };
    const addLog = (kind, side, text) => setLog(l => {
      const last = l[l.length - 1];
      if (last && last.kind === kind && last.side === side && last.text === text) {
        return [...l.slice(0, -1), { ...last, n: last.n + 1 }];
      }
      return [...l.slice(-99), { key: Date.now() + ':' + l.length, kind, side, text, n: 1 }];
    });

    const onMsg = e => {
      const side = sideOf(e.source);
      if (!side || e.origin !== origins[side]) return;
      const m = e.data;
      if (!m || !m.__sp) return;
      const { leader, enabled } = stateRef.current;

      if (m.__sp === 'hello') {
        chan.current[side] = { win: e.source, origin: origins[side] };
        setConnected(c => ({ ...c, [side]: true }));
        sendTo(side, { __sp: 'init', role: side, focusBlocked: blockedFor(side, leader, enabled), ghost: true });
      } else if (m.__sp === 'apperror') {
        setErrors(errs => [...errs.slice(-49), side + ': ' + m.msg]);
      } else if (m.__sp === 'event') {
        if (!enabled) return;
        if (leader !== 'both' && side !== leader) return;
        m.data.from = side;
        sendTo(side === 'A' ? 'B' : 'A', { __sp: 'replay', data: m.data, seq: ++seqRef.current });
      } else if (m.__sp === 'result') {
        if (m.tCap) {
          const dt = Date.now() - m.tCap;
          setLat(l => ({ n: l.n + 1, avg: (l.avg * l.n + dt) / (l.n + 1), max: Math.max(l.max, dt) }));
        }
        setCounts(c => ({ mirrored: c.mirrored + 1, diverged: c.diverged + (m.ok ? 0 : 1) }));
        if (!m.ok && LOGGABLE.has(m.type)) {
          addLog('miss', side, m.type + ' — NO MATCH in ' + side + ' for ' + descSummary(m.desc));
        } else if (m.ok && m.strategy === 'path' && hasSemantic(m.desc) && LOGGABLE.has(m.type)) {
          addLog('warn', side, m.type + ' — matched in ' + side + ' by structure only; label differs: ' + descSummary(m.desc));
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [originA, originB]);

  // Push role changes to both agents; keep parent-side inert on the mirror
  // wrapper (blocks real user input into the mirror pane; the agent's focus
  // patch handles the in-frame half — inert alone is not enough, see
  // docs/research.md Part 5 trap 1). inert is set via toggleAttribute because
  // React 18 does not support it as a prop.
  useEffect(() => {
    const wraps = { A: wrapA, B: wrapB };
    for (const side of ['A', 'B']) {
      const blocked = blockedFor(side, leader, enabled);
      if (wraps[side].current) wraps[side].current.toggleAttribute('inert', blocked);
      const c = chan.current[side];
      if (c) c.win.postMessage({ __sp: 'state', focusBlocked: blocked, ghost: true }, c.origin);
    }
  }, [leader, enabled, connected]);

  const pane = (side, ref, wrapRef, src) => {
    const lead = enabled && (leader === 'both' || leader === side);
    const showPicker = side === 'B' && branchPicker;
    return (
      <div style={S.pane}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={S.badge(lead)}>{!enabled ? 'LIVE' : leader === 'both' ? 'LIVE' : lead ? 'LEADER' : 'MIRROR'}</span>
          <span style={S.mono}>{side} {connected[side] ? '✓ agent connected' : '… waiting for agent'}{showPicker ? '' : ' · ' + src}</span>
          {showPicker && (
            <>
              <select
                value={targetBranch ?? ''}
                onChange={e => setTargetBranch(e.target.value || null)}
                disabled={branches === null}
                style={S.select}
              >
                <option value="">{branches === null ? 'loading branches…' : '— target branch —'}</option>
                {(branches ?? []).filter(n => n !== '__truncated__').map(n => (
                  <option key={n} value={n}>{n === defaultBranch ? n + ' (default)' : n}</option>
                ))}
                {(branches ?? []).includes('__truncated__') && (
                  <option value="" disabled>…more branches not listed</option>
                )}
              </select>
              {resolving && <span style={S.mono}>resolving…</span>}
              {branchErr && <span style={{ color: '#dc2626', fontSize: 11 }}>{branchErr}</span>}
            </>
          )}
        </div>
        <div ref={wrapRef} style={S.frameWrap(height)}>
          {showPicker && !src ? (
            <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#94a3b8' }}>
              select a target branch
            </div>
          ) : (
            <iframe ref={ref} src={src} style={S.iframe} title={'pane-' + side} />
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <strong>synced-preview (cross-origin prototype)</strong>
        <span style={S.group}>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> sync
          </label>
        </span>
        <span style={S.group}>
          leader:
          {['A', 'B', 'both'].map(x => (
            <button key={x} style={S.btn(leader === x)} onClick={() => setLeader(x)}>{x}</button>
          ))}
        </span>
        <span style={S.mono}>
          mirrored {counts.mirrored} · misses {counts.diverged} · latency avg {lat.avg.toFixed(1)}ms max {lat.max}ms ({lat.n})
        </span>
      </div>
      <div style={S.panes}>
        {pane('A', frameA, wrapA, srcA)}
        {pane('B', frameB, wrapB, effectiveSrcB)}
      </div>
      <div>
        <div style={{ fontWeight: 600, margin: '4px 0' }}>Divergence log</div>
        <ul style={S.list}>
          {log.length === 0 && <li style={{ color: '#94a3b8' }}>none yet — interact with the leader pane</li>}
          {log.map(e => (
            <li key={e.key} style={{ color: e.kind === 'miss' ? '#dc2626' : '#b45309' }}>
              [{e.side}] {e.kind === 'miss' ? '✕' : '△'} {e.text}{e.n > 1 ? ' ×' + e.n : ''}
            </li>
          ))}
        </ul>
      </div>
      {errors.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, margin: '4px 0', color: '#dc2626' }}>App errors</div>
          <ul style={S.list}>{errors.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
