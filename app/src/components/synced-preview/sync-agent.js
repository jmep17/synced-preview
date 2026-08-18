// synced-preview — Agent (ADR 0001). Canonical source; single copy — the
// consuming app serves THIS file, never a duplicate (copies drift).
//
// Runs INSIDE each app-under-test (the pages shown in the two panes). The
// consuming app serves this file from its own origin and the app under test
// includes it with a plain script tag:
//
//   <script src="http://<consuming-app-origin>/sync-agent.js"></script>
//
// It activates only when the page is inside an iframe. All postMessage
// traffic is restricted to the origin this script was served from (= the
// consuming app's origin), both directions.
//
// SyncCore was validated same-origin (docs/research.md Part 5) and the
// cross-origin wiring validated in Part 6; treat both as evidence-backed.
(function () {
  'use strict';
  if (window === window.parent) return; // not framed — inert
  if (!document.currentScript || !document.currentScript.src) return;
  var HOST_ORIGIN;
  try { HOST_ORIGIN = new URL(document.currentScript.src).origin; } catch (e) { return; }

  /* ================================================================
     SyncCore — verbatim from prototype-synced-preview.html:350-549
     ================================================================ */
  const SyncCore = (function () {
    const POINTER = new Set(['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout']);
    const MOUSE = new Set(['click', 'dblclick']);
    const norm = t => (t || '').replace(/\s+/g, ' ').trim();

    function roleOf(el) {
      const r = el.getAttribute && el.getAttribute('role');
      if (r) return r;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      return { a: 'link', button: 'button', input: 'textbox', nav: 'navigation', select: 'listbox', textarea: 'textbox' }[tag] || null;
    }

    function accessibleName(el) {
      if (!el.getAttribute) return null;
      const al = el.getAttribute('aria-label');
      if (al) return al;
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const t = el.ownerDocument.getElementById(lb.split(/\s+/)[0]);
        if (t) return norm(t.textContent);
      }
      return null;
    }

    function structuralPath(el) {
      const path = [];
      let node = el;
      while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
        let nth = 1, sib = node;
        while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) nth++;
        path.unshift({ tag: node.tagName, nth });
        node = node.parentElement;
      }
      return path;
    }

    // Ordered strategies, most stable first. Framework-generated ids (React
    // useId ":r1:", react-aria-*) are skipped: both panes generate them in
    // render order, so a divergent branch silently shifts them onto the wrong
    // element — worse than no match.
    function describeTarget(el) {
      if (el && el.nodeType !== 1) el = el.parentElement;
      if (!el) return null;
      const d = { tag: el.tagName, strategies: [] };
      if (el.id && !/^:|react-aria/.test(el.id)) d.strategies.push({ kind: 'id', id: el.id });
      if (el.dataset && el.dataset.testid) d.strategies.push({ kind: 'testid', testid: el.dataset.testid });
      const name = accessibleName(el);
      if (name) d.strategies.push({ kind: 'aria', role: roleOf(el), name });
      const text = norm(el.textContent);
      if (text && text.length <= 48) {
        const same = Array.from(el.ownerDocument.querySelectorAll(el.tagName))
          .filter(n => norm(n.textContent) === text);
        d.strategies.push({ kind: 'text', text, index: same.indexOf(el) });
      }
      d.strategies.push({ kind: 'path', path: structuralPath(el) });
      return d;
    }

    function walkPath(doc, path) {
      let node = doc.documentElement;
      for (const step of path) {
        let child = node.firstElementChild, nth = 0, found = null;
        while (child) {
          if (child.tagName === step.tag && ++nth === step.nth) { found = child; break; }
          child = child.nextElementSibling;
        }
        if (!found) return null;
        node = found;
      }
      return node;
    }

    function resolveTarget(doc, d) {
      if (!d) return { el: null, strategy: 'none' };
      for (const s of d.strategies) {
        let el = null;
        if (s.kind === 'id') el = doc.getElementById(s.id);
        else if (s.kind === 'testid') el = doc.querySelector('[data-testid="' + CSS.escape(s.testid) + '"]');
        else if (s.kind === 'aria') {
          el = Array.from(doc.querySelectorAll(d.tag + ',[role]')).find(n =>
            accessibleName(n) === s.name && (!s.role || roleOf(n) === s.role)) || null;
        } else if (s.kind === 'text') {
          const same = Array.from(doc.querySelectorAll(d.tag)).filter(n => norm(n.textContent) === s.text);
          el = same[s.index] || same[0] || null;
        } else if (s.kind === 'path') {
          el = walkPath(doc, s.path);
          if (el && el.tagName !== d.tag) el = null;
        }
        if (el) return { el, strategy: s.kind };
      }
      return { el: null, strategy: 'none' };
    }

    function serializeEvent(e) {
      const t = e.target;
      if (e.type === 'scroll') {
        const isDoc = t.nodeType === 9;
        const el = isDoc ? t.scrollingElement : t;
        return {
          type: 'scroll',
          desc: isDoc ? { doc: true } : describeTarget(el),
          scroll: {
            fx: el.scrollWidth > el.clientWidth ? el.scrollLeft / (el.scrollWidth - el.clientWidth) : 0,
            fy: el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0,
          },
        };
      }
      const data = { type: e.type, desc: describeTarget(t) };
      if (POINTER.has(e.type) || MOUSE.has(e.type)) {
        const el = t.nodeType === 1 ? t : t.parentElement;
        const r = el.getBoundingClientRect();
        data.p = {
          fx: r.width ? (e.clientX - r.left) / r.width : 0.5,
          fy: r.height ? (e.clientY - r.top) / r.height : 0.5,
          button: e.button, buttons: e.buttons, detail: e.detail,
          pointerType: e.pointerType || 'mouse',
          pointerId: e.pointerId != null ? e.pointerId : 1,
        };
      } else if (e.type === 'keydown' || e.type === 'keyup') {
        data.k = { key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey };
      } else if (e.type === 'input') {
        data.v = { value: 'value' in t ? t.value : null, checked: 'checked' in t ? t.checked : null };
      }
      return data;
    }

    // React reads controlled-input values through the native value setter; set
    // the value behind React's back so the replayed 'input' event carries it.
    function setNativeValue(el, value) {
      let proto = Object.getPrototypeOf(el), desc = null;
      while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    }

    function replayEvent(win, data) {
      const doc = win.document;
      if (data.type === 'hashnav') {
        if (win.location.hash !== data.hash) {
          win.__REPLAYING = true;
          try { win.location.hash = data.hash; } finally { win.__REPLAYING = false; }
        }
        return { ok: true, strategy: 'hash' };
      }
      let el, strategy;
      if (data.desc && data.desc.doc) { el = doc.scrollingElement; strategy = 'doc'; }
      else { const r = resolveTarget(doc, data.desc); el = r.el; strategy = r.strategy; }
      if (!el) return { ok: false, strategy: 'none' };

      const res = { ok: true, strategy };
      win.__REPLAYING = true;
      try {
        if (data.type === 'scroll') {
          el.scrollLeft = data.scroll.fx * (el.scrollWidth - el.clientWidth);
          el.scrollTop = data.scroll.fy * (el.scrollHeight - el.clientHeight);
        } else if (data.p) {
          const r = el.getBoundingClientRect();
          const x = r.left + data.p.fx * r.width, y = r.top + data.p.fy * r.height;
          res.x = x; res.y = y;
          const init = {
            bubbles: true, cancelable: true, composed: true, view: win,
            clientX: x, clientY: y,
            button: data.p.button, buttons: data.p.buttons, detail: data.p.detail,
          };
          let ev;
          if (POINTER.has(data.type)) {
            init.pointerId = data.p.pointerId; init.pointerType = data.p.pointerType; init.isPrimary = true;
            ev = new win.PointerEvent(data.type, init);
          } else {
            ev = new win.MouseEvent(data.type, init);
          }
          el.dispatchEvent(ev);
        } else if (data.k) {
          el.dispatchEvent(new win.KeyboardEvent(data.type, {
            bubbles: true, cancelable: true, composed: true,
            key: data.k.key, code: data.k.code,
            shiftKey: data.k.shiftKey, ctrlKey: data.k.ctrlKey, altKey: data.k.altKey, metaKey: data.k.metaKey,
          }));
        } else if (data.type === 'input') {
          if (data.v && data.v.checked != null && (el.type === 'checkbox' || el.type === 'radio')) {
            // Replayed clicks may already have toggled it (label + input each get
            // a click); converge on the leader's final state either way.
            if (el.checked !== data.v.checked) el.click();
          } else if (data.v && data.v.value != null && 'value' in el) {
            setNativeValue(el, data.v.value);
            el.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true }));
          }
        } else if (data.type === 'focusin') {
          // __FOCUS_BLOCKED is honored by the focus patch installed on this
          // window (inert on the pane wrapper does NOT stop focus() calls
          // made inside the iframe's own document — they'd steal top-level
          // focus from the leader). The synthetic focusin still informs React.
          if (!win.__FOCUS_BLOCKED && el.focus) el.focus({ preventScroll: true });
          el.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true, composed: true }));
        }
      } finally { win.__REPLAYING = false; }
      return res;
    }

    return { describeTarget, resolveTarget, serializeEvent, replayEvent, setNativeValue };
  })();

  /* ================================================================
     Cross-origin wiring — the part under test.
     ================================================================ */

  var ghost = true;

  // Focus shadowing (docs/research.md Part 5, trap 1): react-aria in a mirror
  // pane calls element.focus() internally; parent-page inert cannot stop
  // calls made inside this document, so gate every focus() behind the flag
  // the host maintains via 'state' messages.
  var focusOrig = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function () {
    if (window.__FOCUS_BLOCKED) return;
    return focusOrig.apply(this, arguments);
  };

  function post(m) { window.parent.postMessage(m, HOST_ORIGIN); }

  addEventListener('error', function (e) { post({ __sp: 'apperror', msg: String(e.message || e.error) }); });
  addEventListener('unhandledrejection', function (e) { post({ __sp: 'apperror', msg: 'unhandled rejection: ' + String(e.reason) }); });

  var CAPTURED = ['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout',
                  'click', 'dblclick', 'keydown', 'keyup', 'input', 'focusin', 'scroll'];

  var pendingMove = null, moveScheduled = false;
  function send(data) { data.tCap = Date.now(); post({ __sp: 'event', data: data }); }

  // The catch matters: this listener runs inside the app's own event dispatch,
  // so an exception here would propagate into React's dispatch and corrupt it.
  function onAny(e) {
    if (window.__REPLAYING) return;
    try {
      var data = SyncCore.serializeEvent(e);
      if (e.type === 'pointermove') {
        pendingMove = data;
        if (!moveScheduled) {
          moveScheduled = true;
          requestAnimationFrame(function () {
            moveScheduled = false;
            if (pendingMove) { send(pendingMove); pendingMove = null; }
          });
        }
        return;
      }
      if (pendingMove) { send(pendingMove); pendingMove = null; }
      send(data);
    } catch (err) { post({ __sp: 'apperror', msg: 'capture failed: ' + err.message }); }
  }
  for (var i = 0; i < CAPTURED.length; i++) {
    document.addEventListener(CAPTURED[i], onAny, { capture: true, passive: true });
  }
  addEventListener('hashchange', function () {
    if (!window.__REPLAYING) send({ type: 'hashnav', hash: location.hash });
  });

  function moveGhost(x, y) {
    var g = document.getElementById('__sp_ghost');
    if (!g) {
      g = document.createElement('div');
      g.id = '__sp_ghost';
      g.style.cssText = 'position:fixed;width:14px;height:14px;border-radius:50%;background:rgba(220,38,38,.45);' +
        'border:2px solid #dc2626;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:opacity .3s;';
      document.body.appendChild(g);
    }
    g.style.left = x + 'px'; g.style.top = y + 'px'; g.style.opacity = '1';
    clearTimeout(g.__hide); g.__hide = setTimeout(function () { g.style.opacity = '0'; }, 1500);
  }

  addEventListener('message', function (e) {
    if (e.origin !== HOST_ORIGIN || e.source !== window.parent) return;
    var m = e.data;
    if (!m || !m.__sp) return;
    if (m.__sp === 'init' || m.__sp === 'state') {
      window.__FOCUS_BLOCKED = !!m.focusBlocked;
      if (m.ghost != null) ghost = !!m.ghost;
      return;
    }
    if (m.__sp === 'replay') {
      var res;
      try { res = SyncCore.replayEvent(window, m.data); }
      catch (err) { res = { ok: false, strategy: 'error' }; post({ __sp: 'apperror', msg: 'replay threw: ' + err.message }); }
      if (res.ok && res.x != null && ghost && window.__FOCUS_BLOCKED) moveGhost(res.x, res.y);
      post({ __sp: 'result', seq: m.seq, tCap: m.data.tCap, ok: res.ok, strategy: res.strategy, type: m.data.type, desc: m.data.desc });
    }
  });

  post({ __sp: 'hello', href: location.href });
})();
