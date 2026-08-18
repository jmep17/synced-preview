# Embedding interactive web-app previews & side-by-side diffing

Researched 2026-08-18 against primary sources (official docs, GitHub, npm registry, WHATWG/W3C specs, MDN). npm "last publish" dates pulled from registry.npmjs.org on 2026-08-18. Claims that could not be traced to a primary source are marked **unverified**.

## TL;DR / Recommendations

**Part 1 — embedding an interactive preview**

- **You control the embedded code** → sandboxed `<iframe>` with `srcdoc` or a `blob:` URL. Zero dependencies, fully interactive, and (if you omit `sandbox` or scope it carefully) same-origin, so the parent can read the preview's DOM. This is the only option that gives you both interactivity *and* programmatic access.
- **You need to run a whole JS project in-browser** → **Sandpack** (`@codesandbox/sandpack-react`, Apache-2.0, free, self-hostable bundler) for frontend templates; **WebContainers** (`@webcontainer/api`, MIT package but **paid license required for commercial production use**, needs COOP/COEP cross-origin isolation) for real Node.js.
- **Component-level React preview** → **react-live** (renders into the host DOM, no isolation) or **react-frame-component** (same-origin iframe for style isolation).
- **Arbitrary third-party URL** → plain iframe is the *only* option, and it works only if the target does not send `X-Frame-Options` / CSP `frame-ancestors`. No library can bypass that; it is enforced by the browser.

**Part 2 — side-by-side + diff**

- **Pixel diff in-browser**: **pixelmatch** — takes raw RGBA arrays, "compatible with ImageData from canvas", zero dependencies, ISC.
- **DOM diff in-browser**: **diffDOM** (returns a diff object; LGPL-3.0 — check acceptability) or serialize with **rrweb-snapshot** and diff the JSON yourself. **morphdom** patches but does not report.
- **CI-grade**: Playwright `toHaveScreenshot` (pixelmatch under the hood) or BackstopJS. Commercial clouds (Chromatic, Percy, Argos) all have ~5,000-screenshot free tiers.
- **Interaction sync between two panes**: nothing off-the-shelf syncs two *arbitrary* iframes. Browsersync `ghostMode` mirrors clicks/scrolls/forms across browsers viewing the *same* Browsersync URL; Polypane (commercial desktop browser) syncs its own panes; rrweb live-mode mirrors into a second pane but the mirror is a script-disabled replay, not a live app. For two same-origin iframes you write a small event-forwarding bridge yourself.

**Part 3 — the composable stack**: two same-origin sandboxed iframes (srcdoc/blob or same-origin URLs) → parent reads both `contentDocument`s → DOM diff (diffDOM / rrweb-snapshot) and/or DOM-to-canvas render (html-to-image) → pixelmatch on the two `ImageData`s → overlay. Interaction mirroring via a capture-phase listener in pane A re-dispatched in pane B (synthetic events are `isTrusted:false`, so default actions may not fire). For cross-origin third-party apps, in-browser capture is impossible; fall back to server-side Playwright or Chrome-only Element Capture. **Part 5 validates the mirroring bridge empirically** — a working prototype (`prototype-synced-preview.html`) mirrors clicks, hovers, menus/portals, typing, navigation, and scroll between two compiled React 18 + react-aria-components apps, including graceful degradation when the two DOMs diverge. **Part 6 removes the same-origin constraint**: the same bridge re-validated cross-origin (agent script in each pane + postMessage routing, ~15 ms added latency) as a Next.js-compatible React component on branch `prototype/crossorigin-component`.

---

## Part 1 — Embedding an interactive web-app preview

| Option | What it is | Isolation model | Interactive | License / pricing | Last release (npm) | Key limitation |
|---|---|---|---|---|---|---|
| Plain `<iframe>` + `sandbox`/`allow` | Browser primitive | Separate browsing context; `sandbox` forces opaque origin unless `allow-same-origin` | Yes | n/a | n/a | Target can refuse framing (XFO / `frame-ancestors`); cross-origin DOM sealed |
| `srcdoc` / `blob:` iframe | Self-contained inline document | Iframe; same-origin with creator unless sandboxed | Yes | n/a | n/a | Content must be self-contained; `about:srcdoc` relative-URL quirks |
| Sandpack (`@codesandbox/sandpack-react`) | CodeSandbox's in-browser bundler + editor/preview components | Preview runs in an iframe on a different (sub)domain | Yes | Apache-2.0, free; bundler self-hostable | 2.20.0, 2025-02-14 | Preview iframe is cross-origin by design → no DOM access from host |
| WebContainers (`@webcontainer/api`) | Node.js runtime in the browser tab | Dev-server URL loaded into an iframe | Yes | MIT package; **commercial production use requires paid license** | 1.6.4, 2026-04-14 | Host page must be cross-origin isolated (COOP/COEP); Chromium-first |
| StackBlitz SDK (`@stackblitz/sdk`) | Embeds StackBlitz IDE+preview via iframe | Cross-origin iframe to stackblitz.com | Yes, incl. VM control API | MIT SDK | 1.11.1, 2026-07-02 | Projects live in browser memory unless forked; depends on stackblitz.com |
| CodeSandbox Define API + embed | HTTP API creating sandboxes on the fly; iframe embed | Cross-origin iframe to codesandbox.io | Yes | Free tier (hosted service) | n/a (HTTP API) | Hosted-only; classed under (legacy) browser sandboxes docs |
| react-live | Live-edited React component preview | **Same DOM as host** — no iframe | Yes | MIT | 4.1.8, 2024-11-19 | Zero isolation: `new Function` eval in page context; Sucrase-only transforms |
| react-runner | react-live alternative (same author ecosystem) | Same DOM as host | Yes | MIT | 1.0.5, 2024-06-05 | Same non-isolation; slower release cadence |
| react-frame-component | Render React children into an iframe | Same-origin iframe (srcdoc bootstrap) | Yes | MIT | 5.3.2, 2026-03-29 | Origin-sensitive libs (Maps, Recaptcha) misbehave inside |
| single-spa | Micro-frontend orchestrator | **Shared DOM + global scope** | Yes | MIT | 6.0.3, 2024-09-29 | No style/JS isolation — you manage it |
| Module Federation (`@module-federation/enhanced`) | Runtime code sharing between builds | Shared JS context/DOM (dependency reuse) | Yes | MIT | 2.8.2, 2026-08-06 | Both apps must be built for federation; no isolation |
| Web Fragments / "piercing" | Cloudflare-backed fragments architecture | JS in separate context, **DOM shared with host** | Yes | MIT, beta | n/a (GitHub) | Beta; requires fragment-aware server rendering |

### Baseline: plain iframe + `sandbox` / `allow`

- `sandbox` applies all restrictions by default; tokens (`allow-scripts`, `allow-forms`, `allow-popups`, `allow-same-origin`, …) lift them selectively. Spec: sandboxed content "is treated as being from a unique opaque origin" unless `allow-same-origin` is present — https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox
- MDN warning: with same-origin content, combining `allow-scripts` + `allow-same-origin` lets the embedded document remove its own `sandbox` attribute, i.e. no security gain — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- `allow` sets a Permissions Policy (camera, fullscreen, …) *on top of* the `Permissions-Policy` header — same MDN page.
- Parent scripting: `iframe.contentWindow` / `contentDocument` work only same-origin; cross-origin you get only `postMessage` plus a short whitelist of window/location members — https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy
- Third-party sites can refuse embedding: `X-Frame-Options: DENY|SAMEORIGIN` (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options) and the modern replacement CSP `frame-ancestors` (`'none'`/`'self'`/hosts; every ancestor in a nested chain must match) — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors. Nothing running in your page can override these.

What a library "adds on top" of this baseline is: getting *runnable code* into the frame (bundling, Node emulation, editor UI), not the embedding itself — everything below ultimately renders into an iframe except react-live/single-spa/Module Federation/Web Fragments, which trade isolation for same-DOM composition.

### `srcdoc` iframes and `blob:` URLs (self-contained previews)

- `srcdoc` "gives the content of the page"; takes priority over `src` — https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-srcdoc. The `about:srcdoc` page resolves relative URLs against the embedding document's URL — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- `blob:` URL origin: "The origin of a blob URL is always the same as that of the environment that created the URL, as long as the URL hasn't been revoked yet" — File API spec §8.3.1, https://w3c.github.io/FileAPI/#originOfBlobURL. So a blob-URL iframe is same-origin with its creator → full `contentDocument` access. Revoke with `URL.revokeObjectURL` to avoid leaks — https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static
- Both are fully interactive (they are real documents). Add `sandbox` to *remove* trust — but note that flips them to an opaque origin (spec above), which also removes your DOM access.

### Sandpack — `@codesandbox/sandpack-react`

- "A component toolkit for creating live-running code editing experiences, powered by the online bundler used on CodeSandbox" — https://sandpack.codesandbox.io/docs
- Architecture: "The bundler evaluates and transpiles all files in an iFrame under a different subdomain" — https://sandpack.codesandbox.io/docs/advanced-usage/bundlers (hosted at `https://sandpack-bundler.codesandbox.io`; self-hosting supported via `bundlerURL` — https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler)
- Clients: `SandpackRuntime` (web frameworks), `SandpackNode` (Nodebox: Node.js runtime, enables Vite/Next.js templates since Sandpack 2.0), `SandpackStatic` — each mounts into an iframe you supply — https://sandpack.codesandbox.io/docs/advanced-usage/client
- Interactivity: full — the preview is the running app in its iframe.
- License: Apache-2.0 (npm). Last publish `@codesandbox/sandpack-react` 2.20.0 on 2025-02-14; `@codesandbox/sandpack-client` 2.19.8 on 2024-09-12 (registry.npmjs.org) — ~18 months since last release.
- Limitation: the deliberately cross-origin preview iframe means the host page cannot reach the preview DOM directly (same-origin policy, MDN above); communication is via the Sandpack client protocol.

### StackBlitz WebContainers — `@webcontainer/api`

- "WebContainers are a browser-based runtime for executing Node.js applications and operating system commands, entirely inside your browser tab" — https://webcontainers.io/guides/introduction
- Embedding the preview: listen for `server-ready` and point an iframe at the returned URL: `webcontainerInstance.on('server-ready', (port, url) => (iframeEl.src = url))` — https://webcontainers.io/guides/quickstart
- Hard requirement: the embedding page must be cross-origin isolated — `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin` (SharedArrayBuffer) — https://webcontainers.io/guides/quickstart
- Browser support: "fully supported in Chrome and most Chromium-based browsers"; Firefox alpha; Safari ≥16.4 beta-ish (older Safari lacks `Atomics.waitAsync`, "cannot be polyfilled"); docs warn limited cross-origin isolation support "may block third-party assets in preview windows" — https://webcontainers.io/guides/browser-support
- Licensing: npm package MIT, but "Licensing is required for *production* usage of the API in a commercial, for-profit setting"; prototypes/PoCs exempt; sales-negotiated pricing — https://webcontainers.io/enterprise
- Last publish: 1.6.4, 2026-04-14 (registry.npmjs.org).

### StackBlitz SDK embed — `@stackblitz/sdk`

- 3 kB SDK to "programmatically create StackBlitz projects to be opened in a new window or embedded in your docs"; `embedProject` / `embedProjectId` / `embedGithubProject` each **replace a given element with an iframe** and resolve to a VM instance for programmatic control — https://developer.stackblitz.com/platform/api/javascript-sdk
- Options: `openFile`, `view` (editor/preview), `clickToLoad`, `terminalHeight`, … (same page). Fully interactive (it is the real IDE+app in the iframe).
- "New projects are not persisted on StackBlitz, and only live in the browser's memory — unless a user forks the project" — same page.
- MIT; last publish 1.11.1, 2026-07-02 (registry.npmjs.org). No pricing on the SDK docs page (WebContainers-powered projects inherit the WebContainers licensing above when you use that API directly; embed-only usage terms **unverified**).

### CodeSandbox Define API / embed

- Endpoint: `https://codesandbox.io/api/v1/sandboxes/define`, GET or POST. Main argument `files` (`content`, optional `isBinary`); `json=1` returns `{"sandbox_id": …}` instead of redirecting; `embed=1` redirects to the embed; `query` passes embed options (e.g. `view=preview&runonclick=1`); GET uses compressed `parameters` from `codesandbox/lib/api/define`'s `getParameters` — docs source: https://github.com/codesandbox/docs/blob/main/packages/projects-docs/pages/learn/browser-sandboxes/cli-api.mdx (rendered at https://codesandbox.io/docs/learn/browser-sandboxes/cli-api; the rendered site 403'd automated fetching, so quotes come from the docs repo via Context7)
- Embedding: iframe pointed at `https://codesandbox.io/p/sandbox/<id>?file=...` — https://github.com/codesandbox/docs/blob/main/packages/projects-docs/pages/learn/browser-sandboxes/embedding.mdx
- Docs file these under "browser sandboxes" (the pre-VM product); `environment: "server"` in the define body targets VM sandboxes (per docs search results; **exact current support unverified**).
- Interactive: yes (embed is the running sandbox). Hosted-only; you depend on codesandbox.io availability and its embed chrome.

### react-live (and react-runner) — component-level previews

- "React Live brings you the ability to render React components with editable source code and live preview"; default mode treats the code block as a functional component body; `noInline` + `render()` for multi-component code; `scope` injects globals — https://github.com/FormidableLabs/react-live/blob/master/docs/introduction.mdx, /docs/usage.md
- Transpiler: "react-live … ships with Sucrase" (not configurable; `transformCode` prop as escape hatch) — https://github.com/FormidableLabs/react-live/blob/master/docs/faq.md
- Execution: evaluated with `new Function(...scopeKeys, code)(...scopeValues)` in the **host page's JS context** — source: https://github.com/FormidableLabs/react-live/blob/master/packages/react-live/src/utils/transpile/evalCode.ts. No iframe, no isolation: preview shares DOM, CSS, and globals with your app.
- MIT; last publish 4.1.8, 2024-11-19 (registry.npmjs.org). `react-runner` (MIT, 1.0.5, 2024-06-05) is the same category with import-statement support (**feature claim unverified against docs**).

### react-frame-component

- "This component allows you to encapsulate your entire React application or per component in an iFrame"; bootstraps the iframe via `srcdoc` and mounts children into it; `head`, `initialContent`, `mountTarget`, `useFrame()` hook expose the frame's window/document — https://github.com/ryanseddon/react-frame-component
- Isolation: same-origin iframe → CSS isolation with full parent scriptability. Caveat from README: origin-dependent libraries (Recaptcha, Google Maps) can break; `dangerouslyUseDocWrite` workaround is "unperformant and unrecommended".
- MIT; last publish 5.3.2, 2026-03-29 (registry.npmjs.org).

### Micro-frontend composition: single-spa, Module Federation, piercing/fragments

These embed *cooperating* apps in the same page, not arbitrary ones:

- **single-spa**: registers applications with `bootstrap`/`mount`/`unmount` lifecycles; multiple frameworks "on the same page without page refreshing"; **shared DOM and global scope, no iframes**; style isolation and shared-dependency coordination (import maps) are on you — https://single-spa.js.org/docs/getting-started-overview/. MIT; last publish 6.0.3, 2024-09-29.
- **Module Federation**: "an architectural pattern for the decentralization of JavaScript applications"; runtime code/dependency sharing across separately built apps; Webpack/Rspack/Vite/Rsbuild/Metro support — https://module-federation.io/guide/start/index.html. Federated modules execute in the host's JS context (that is the mechanism of dependency reuse; the docs page does not spell out "same context" verbatim — **explicit wording unverified**). MIT; `@module-federation/enhanced` 2.8.2, 2026-08-06.
- **Piercing / Web Fragments** (Cloudflare): server-rendered fragment HTML is streamed/"pierced" into the legacy app's DOM — "combines HTML/DOM produced by server-side rendered micro-frontend fragments with HTML/DOM produced by a legacy client-side rendered application" — https://blog.cloudflare.com/fragment-piercing/ and https://blog.cloudflare.com/better-micro-frontends/. The successor library **web-fragments** executes each fragment's "client-side JavaScript in separate JavaScript context, while enabling them to share the same DOM document, browser navigation and history"; MIT, explicitly **beta**, Cloudflare-sponsored — https://github.com/web-fragments/web-fragments
- Trade-off vs iframes (all three): no browser-enforced security/style boundary and both sides must be built for it — in exchange you get one DOM (shared routing, no double scrollbars, direct DOM diffing is trivial because everything is in your document).

---

## Part 2 — Side-by-side display + diff detection

### Pixel/visual diff engines

| Tool | Runs in browser? | Inputs | Engine/notes | License | Last publish (npm) |
|---|---|---|---|---|---|
| pixelmatch | **Yes** (and Node) | Raw RGBA `Uint8Array`/`Uint8ClampedArray`/`Buffer`; "compatible with ImageData" | Zero-dep, ~few hundred LOC; `threshold`, `includeAA`, `diffMask` | ISC | 7.2.0, 2026-04-29 |
| Resemble.js | **Yes** (canvas) / Node (node-canvas) | Image data, data URIs, buffers, ImageData | ignoreAntialiasing / ignoreColors / bounding boxes; author: "ultra low-maintenance mode" | MIT | 5.0.0, 2023-06-06 |
| odiff | **No** — native binary (+ `odiff-bin` Node bindings) | PNG/JPEG/WebP/TIFF files | OCaml→Zig w/ SIMD; benchmarks ~6-7x pixelmatch on full-page shots | MIT | 4.5.0, 2026-07-23 |
| looks-same | **No** — "Pure node.js library for comparing png images" | File paths or PNG buffers | CIEDE2000 color tolerance; ignores blinking text caret & antialiasing by default; testplane (ex-Hermione) ecosystem | MIT | 10.0.1, 2025-08-18 |
| Playwright `toHaveScreenshot` | No — Node test runner | Live page (it screenshots itself) | "Playwright Test uses the pixelmatch library"; auto-baselines on first run (waits for two consecutive identical shots); `maxDiffPixels`, `threshold`, `mask`, `stylePath` | Apache-2.0 | 1.62.1, 2026-07-30 |
| BackstopJS | No — Node CLI/Docker | URLs + scenario/viewport config | Captures via Puppeteer or Playwright, diffs with Resemble.js, interactive HTML report w/ scrubber; interaction scripts (hover/click) before capture | MIT | 6.3.25, 2024-09-07 |
| reg-suit | No — Node CLI (CI) | Directories of images (does **not** capture) | Diff engine x-img-diff-js ("structural analysis", optional WebAssembly client-side rendering); plugins: S3/GCS storage, git-hash keys, GitHub/GitLab/Slack notify | MIT | 0.14.5, 2025-08-26 |
| Chromatic | Cloud service | Storybook/Playwright/Cypress builds | Free 5,000 snapshots/mo; Starter $179/mo (35k), Pro $399/mo (85k); Chrome/Safari/Firefox/Edge | Commercial (CLI MIT) | CLI 18.2.0, 2026-08-11 |
| Percy (BrowserStack) | Cloud service | **DOM snapshots** uploaded, re-rendered in cloud browsers, then diffed | Free 5,000 screenshots/mo; SDKs for Storybook/Playwright/Selenium | Commercial (CLI MIT) | @percy/cli 1.32.6, 2026-08-06 |
| Argos | Cloud service | Screenshots uploaded from CI | Hobby free 5,000/mo; Pro $100/mo (35k, then $0.004/shot); GitHub/GitLab integration | Commercial (CLI MIT) | @argos-ci/cli 6.9.0, 2026-08-13 |

Sources: https://github.com/mapbox/pixelmatch, https://github.com/rsmbl/Resemble.js, https://github.com/dmtrKovalenko/odiff, https://github.com/gemini-testing/looks-same, https://playwright.dev/docs/test-snapshots, https://github.com/garris/BackstopJS, https://github.com/reg-viz/reg-suit, https://www.chromatic.com/pricing, https://www.browserstack.com/percy, https://argos-ci.com/pricing; publish dates registry.npmjs.org.

In-browser pixelmatch usage (from its README): get `ImageData` from two canvases of equal size, call `pixelmatch(img1.data, img2.data, diff.data, w, h, {threshold})`, `putImageData` the diff — https://github.com/mapbox/pixelmatch

### DOM capture & diffing

| Tool | What it does | Browser? | Inputs | License | Last publish |
|---|---|---|---|---|---|
| rrweb / rrweb-snapshot | Serializes DOM to JSON with node ids; records incremental mutations (MutationObserver); replays by rebuilding the DOM in a sandboxed iframe | **Yes** | Live `document` | MIT | 2.1.1, 2026-07-21 |
| diffDOM | "Abstraction of differences between DOM elements as a 'diff' object"; `diff`/`apply`/`undo`; also diffs its virtual-DOM objects without DOM access | **Yes** + Node | DOM nodes, HTML strings, vdom objects | **LGPL-3.0** | 5.2.1, 2025-10-04 |
| dom-compare | "NodeJS module to compare two DOM-trees"; difference collection, GroupingReporter (XPath-grouped), canonical XML printing | Node (xmldom) | DOM trees | MIT | 0.6.0, **2019-10-14 — effectively unmaintained** |
| morphdom | "Morph an existing DOM node tree to match a target"; patches in place, **does not report diffs** | **Yes** | Real DOM node + target node/HTML string | MIT | 2.7.8, 2026-01-14 |

Sources: https://github.com/rrweb-io/rrweb, https://github.com/fiduswriter/diffDOM, https://github.com/Olegas/dom-compare, https://github.com/patrick-steele-idem/morphdom.

rrweb replay nuance: replay rebuilds the page in a sandboxed iframe and blocks script execution — the guide's `UNSAFE_replayCanvas` option "adds `allow-scripts` to the replay iframe and opts out of the sandbox script-execution protection, which is unsafe" — https://github.com/rrweb-io/rrweb/blob/master/guide.md. So a replay pane *looks* interactive (recorded interactions play back) but is not a live app.

WHATWG-serialized HTML alternative: `element.outerHTML`/`XMLSerializer` on both `contentDocument`s, then string/tree diff — no library needed for capture; normalization (attribute order, whitespace) is the hard part (dom-compare's canonical form addressed exactly this, but it is Node/xmldom and stale).

### Synchronized side-by-side browsing

- **Browsersync `ghostMode`**: "Clicks, Scrolls & Form inputs on any device will be mirrored to all others" — options `clicks`/`scroll`/`location`/`forms`, each default true — https://browsersync.io/docs/options. Works across browsers/devices viewing the **same Browsersync-served URL** (injected socket script), not across two different apps in one page. Apache-2.0; 3.0.4, 2025-04-02.
- **Polypane** (commercial desktop browser): "By default Polypane syncs the following user interactions and events: navigation, scroll, hover, click, keypress, input, change" across its panes — https://polypane.app/docs/synced-interactions/. Paid product, 14-day free trial (pricing page); it is an app, not an embeddable library.
- **rrweb live-mode**: `new Replayer(events, { liveMode: true })`, `replayer.startLive(Date.now() - BUFFER_MS)`, push events with `addEvent` as they arrive over your transport (websocket) — https://github.com/rrweb-io/rrweb/blob/master/docs/recipes/live-mode.md. Gives you a real-time *mirror* of pane A inside pane B — but the mirror is a replay (scripts blocked, above), so B is not independently interactive.
- **Two arbitrary iframes**: nothing packaged found (**absence is hard to prove — treat as "none found"**). The building blocks are: capture-phase listeners in pane A → `postMessage` → `dispatchEvent` of a synthetic event in pane B. Constraint: synthetic events have `isTrusted: false` and browsers generally don't run default actions for them (a scripted `click` "won't navigate a link or submit a form in the way a real user click would") — https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted. Practical mirroring therefore re-implements effects (set `.value`, call `.click()` on elements, set `scrollTop`) rather than replaying raw events — which is exactly what Browsersync's ghost mode and rrweb do on their side of the wire.

---

## Part 3 — Composing "two interactive apps side by side with diff highlighting"

### Recipe A (most capable): two same-origin sandboxed iframes + DOM diff + pixelmatch

Works when you control/serve both apps (previews you generate, two builds of your own app, two branches behind your proxy):

1. **Embed**: two `<iframe>`s via `srcdoc`, `blob:` URLs, or same-origin URLs (e.g. reverse-proxy both versions under your origin). Blob iframes are same-origin with the creator (File API §8.3.1, https://w3c.github.io/FileAPI/#originOfBlobURL); same-origin means full `contentDocument` access (https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy). Do **not** rely on `sandbox` for security here: adding `sandbox` without `allow-same-origin` gives an opaque origin and kills DOM access (https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox), while `allow-scripts allow-same-origin` on same-origin content is self-defeating (MDN iframe warning).
2. **Mirror interaction**: capture-phase listeners in pane A, forward via `postMessage`, re-apply in pane B (element lookup by selector/rrweb node id; `isTrusted:false` caveat above). Or record pane A with `@rrweb/record` and drive a rrweb live-mode replayer as a third "ghost" pane (https://github.com/rrweb-io/rrweb/blob/master/docs/recipes/live-mode.md) — accepting that the ghost is non-interactive.
3. **DOM diff**: serialize both `contentDocument`s with rrweb-snapshot (JSON with node ids) or diff directly with diffDOM (`dd.diff(bodyA, bodyB)` → machine-readable ops you can render as highlights; apply/undo supported) — https://github.com/fiduswriter/diffDOM. LGPL-3.0: fine as a dependency for most uses, but check your policy.
4. **Pixel diff, all in-browser**: there is **no** general DOM-screenshot API in the web platform; html2canvas explicitly "does not make an actual screenshot, but builds the screenshot based on the information available on the page" (https://github.com/niklasvh/html2canvas README) and is frozen at 1.4.1 (2022-01-22, npm). Prefer **html-to-image** (1.11.13, 2025-02-14): clones the node, inlines styles/fonts/images, wraps it in an SVG `<foreignObject>` data URL, draws to canvas — https://github.com/bubkoo/html-to-image. Then `getImageData` both canvases and run **pixelmatch** (ImageData-compatible, https://github.com/mapbox/pixelmatch); paint the diff `ImageData` onto an overlay canvas positioned over either pane.

**Constraints on step 4, each cited:**
- Cross-origin images/fonts inside the preview without CORS headers won't render (html-to-image README) and any cross-origin pixel drawn without CORS approval **taints** the canvas: `getImageData`/`toBlob`/`toDataURL`/`captureStream` then throw `SecurityError` — https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image. Fix: serve assets same-origin or with CORS + `crossorigin="anonymous"`.
- A `<canvas>` already tainted inside the captured subtree makes rendering fail (html-to-image README: "the canvas is tainted... rendering will rather not succeed").
- Huge DOMs can exceed browser data-URI limits (html-to-image README).
- foreignObject rendering is a *re-render*, not the compositor's pixels: cross-browser fidelity differences are expected (html2canvas README's "may not be 100% accurate" applies to the whole approach).

### Recipe B: two Sandpack instances

`<SandpackProvider>` twice with variant A/B files; the previews are fully interactive apps. The preview iframes are cross-origin by design ("iFrame under a different subdomain", https://sandpack.codesandbox.io/docs/advanced-usage/bundlers), so the host cannot read their DOM or pixels (same-origin policy + canvas taint, cited above). Workaround that keeps everything in-browser: **add rrweb to the sandboxed app itself** (it's just an npm dependency of the preview code) and `postMessage` snapshots/events out to the host, then diff snapshots host-side (rrweb-snapshot JSON) — the host never touches the cross-origin DOM directly, so no policy is violated. Pixel diffing of Sandpack previews from the host is not possible in-browser; do it in CI with Playwright screenshots instead.

### Recipe C: two WebContainers

Only if you need real Node.js servers for both variants. Costs: COOP/COEP on your page (`require-corp` blocks cross-origin subresources/frames that don't send CORP or use `credentialless` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy — which can break *other* embeds on the same page), Chromium-first support (https://webcontainers.io/guides/browser-support), and a commercial license for production (https://webcontainers.io/enterprise). Preview iframes are cross-origin → same instrumentation-from-inside approach as Recipe B. Running two instances simultaneously: memory-heavy; per-tab instance limits **unverified**.

### Recipe D: third-party sites you don't control

- Embedding at all depends on the target not sending `X-Frame-Options`/`frame-ancestors` (MDN, cited in Part 1) — most auth-bearing production sites do send them.
- If it embeds, you still get no DOM and no pixels (same-origin policy; canvas taint). In-browser pixel capture of a live cross-origin iframe exists only via screen-capture surfaces: `getDisplayMedia` + **Element Capture** (`RestrictionTarget.fromElement` + `track.restrictTo`) — Chrome 132+ desktop only, element must form its own stacking context — https://developer.chrome.com/docs/web-platform/element-capture (behavior for cross-origin iframe targets not explicitly documented — **unverified**; capture prompts the user).
- The robust route is out-of-browser: Playwright drives both URLs, mirrors inputs programmatically, `toHaveScreenshot`/pixelmatch or odiff for diffs — all Node/CI (https://playwright.dev/docs/test-snapshots, https://github.com/dmtrKovalenko/odiff).

### Bottom-line pairings

| Goal | Pick |
|---|---|
| Diff two generated previews, all in-browser | srcdoc/blob iframes + diffDOM (DOM) + html-to-image→pixelmatch (pixels) |
| Diff two npm-project variants in-browser | 2× Sandpack + rrweb-snapshot smuggled out via postMessage |
| Live mirror pane while user drives one app | @rrweb/record → websocket/BroadcastChannel → Replayer liveMode |
| Diff two deployed apps incl. third-party | Playwright in CI (toHaveScreenshot / odiff), or Chromatic/Percy/Argos free tiers |

---

## Sources

Specs / platform:
- WHATWG HTML, iframe `sandbox`/`srcdoc` — https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox / #attr-iframe-srcdoc
- W3C File API §8.3.1 origin of blob URLs — https://w3c.github.io/FileAPI/#originOfBlobURL
- MDN: iframe — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe · Same-origin policy — https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy · X-Frame-Options — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options · frame-ancestors — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors · CORS-enabled images / tainted canvas — https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image · createObjectURL — https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static · Event.isTrusted — https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted · COEP — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy
- Chrome Element Capture — https://developer.chrome.com/docs/web-platform/element-capture

Part 1:
- Sandpack — https://sandpack.codesandbox.io/docs, /docs/advanced-usage/bundlers, /docs/advanced-usage/client, /docs/guides/hosting-the-bundler
- WebContainers — https://webcontainers.io/guides/introduction, /guides/quickstart, /guides/browser-support, /enterprise
- StackBlitz SDK — https://developer.stackblitz.com/platform/api/javascript-sdk
- CodeSandbox docs (repo) — https://github.com/codesandbox/docs (cli-api.mdx, embedding.mdx)
- react-live — https://github.com/FormidableLabs/react-live (docs/faq.md, docs/usage.md, src evalCode.ts)
- react-frame-component — https://github.com/ryanseddon/react-frame-component
- single-spa — https://single-spa.js.org/docs/getting-started-overview/
- Module Federation — https://module-federation.io/guide/start/index.html
- Cloudflare fragments/piercing — https://blog.cloudflare.com/better-micro-frontends/, https://blog.cloudflare.com/fragment-piercing/, https://github.com/web-fragments/web-fragments

Part 2:
- https://github.com/mapbox/pixelmatch · https://github.com/rsmbl/Resemble.js · https://github.com/dmtrKovalenko/odiff · https://github.com/gemini-testing/looks-same · https://playwright.dev/docs/test-snapshots · https://github.com/garris/BackstopJS · https://github.com/reg-viz/reg-suit · https://www.chromatic.com/pricing · https://www.browserstack.com/percy · https://argos-ci.com/pricing
- https://github.com/rrweb-io/rrweb (guide.md, docs/recipes/live-mode.md) · https://github.com/fiduswriter/diffDOM · https://github.com/Olegas/dom-compare · https://github.com/patrick-steele-idem/morphdom
- https://browsersync.io/docs/options · https://polypane.app/docs/synced-interactions/
- https://github.com/niklasvh/html2canvas · https://github.com/bubkoo/html-to-image

All version numbers and publish dates: registry.npmjs.org, retrieved 2026-08-18.

---

## Part 4 — Embedding DevTools on the embedded app (follow-up 2026-08-18)

All options require script access to the embedded app (inject a `<script>`). Third-party pages you can't script are out.

| Package | What you get | Where UI lives | Version / status | License |
|---|---|---|---|---|
| **chii** | Full Chrome DevTools frontend (Elements, Console, Network, Sources…) | Same page, iframe — `<script src=".../target.js" embedded="true">` | 1.15.5, 2025-08 (npm) | MIT |
| **chobitsu** | CDP implemented in JS — wire your own hosted devtools-frontend via `sendRawMessage`/`setOnMessage` | Your choice (postMessage bridge) | Active; powers chii | MIT |
| **eruda** | DevTools panel (console, elements, network, resources) injected into the page itself | Inside the embedded app | 3.4.3, 2025-06 (npm) | MIT |
| **vConsole** | Console-focused mobile panel (Tencent) | Inside the embedded app | 3.15.1, 2023-06 — stale | MIT |
| **react-devtools-inline** | Official React DevTools: backend in preview iframe, frontend component in host app | Host app (postMessage "wall") | 7.0.1, 2025-10 (npm) | MIT |
| **SandpackConsole** | Console output from Sandpack preview via Sandpack protocol; pair with console-feed for richer rendering | Host app | Part of sandpack-react | Apache-2.0 |

Key facts, cited:
- chii embedded mode: "embed devtools in the same page using iframe… setting an extra embedded attribute on the script element" — https://chii.liriliri.io/docs/ . Demo: https://chii.liriliri.io/playground/test/demo.html?embedded=true
- react-devtools-inline: backend `initialize(window)` "must be called before React is loaded"; backend must not `activate` until frontend init done; default transport `window.postMessage` — https://github.com/facebook/react/blob/main/packages/react-devtools-inline/README.md . Built for CodeSandbox/StackBlitz-style embedding.
- SandpackConsole: "Sandpack runs the console directly into the iframe… all console messages pass through the Sandpack protocol"; doesn't render nested objects; docs recommend `useSandpackConsole` + console-feed — https://sandpack.codesandbox.io/docs/advanced-usage/components
- eruda/vconsole npm dates from registry.npmjs.org (2026-08-18).

---

## Part 5 — Prototype: synced branch previews with mirrored interactions (2026-08-18)

Recipe A's interaction-mirroring bridge, built and tested. Two files in this repo:

- **`prototype-synced-preview.html`** — self-contained, throwaway prototype. Two same-origin iframes run branch A ("main") and branch B ("feature/team-v2") of a demo app; a capture-phase listener in the leader pane serializes events and replays them in the mirror. Devtools chrome around the panes: viewport presets, zoom, element inspector (shows the target descriptor + whether it resolves in the other branch), per-pane console capture, ghost cursor, divergence log, guided walkthrough scenarios.
- **`prototype-synced-preview.app.jsx`** — source of the demo app, compiled with esbuild (`--bundle --minify`, production React 18.3.1 + react-aria-components 1.5.0) and inlined into the HTML. Built as a *compiled* app on purpose: minified output, no `data-testid`s, framework-generated ids — the hostile case for target resolution.

Everything below is **empirical**: observed in Chrome 151 (macOS) on 2026-08-18, driving the prototype over `http://localhost` with real (trusted) input plus the prototype's synthetic walkthroughs. The prototype itself is the primary source; re-run it to re-verify.

### What mirrors correctly (verified)

| Interaction | Mechanism | Result |
|---|---|---|
| Clicks / presses (react-aria `usePress`) | replay `pointerover/move/down/up` + `click` on the resolved target | onPress fires exactly once in the mirror; no de-dupe needed with react-aria-components 1.5.0 |
| Hover styling (`data-hovered`) + `TooltipTrigger` | replay bubbling `pointerover`/`pointerout` (React synthesizes enter/leave from over/out) | rows highlight and tooltips open/close in both panes |
| Menu popover through a React portal into `document.body` | target resolution by role/accessible-name survives the portal | menu opens/actions fire in both panes |
| Controlled `TextField` typing | native value-setter + dispatched `input` event (the mirror never needs keyboard focus) | filter text + filtered list identical in both panes |
| Keyboard menu navigation | each `keydown` replays onto the element that held focus in the leader | ArrowDown/Enter select the same item in the mirror even with focus blocked — only the focus-ring highlight is missing |
| Hash navigation | replayed anchor click + `hashchange` backstop (idempotent, loop-safe) | both apps change route |
| Scroll | offsets mirrored as *fractions* of the scrollable range | panes align even though branch B's list is one card longer |
| Checkbox/switch toggles | replayed clicks may double-toggle via label activation; the captured `input` event carries `checked` and converges the mirror to the leader's state | single visible toggle, states equal |

### Divergence behavior (the point of the exercise)

Target descriptors carry an ordered strategy list: stable `id` → `data-testid` → role + accessible name → tag + text (+index) → structural `nth-of-type` path. Framework-generated ids (React `useId` `:r1:`, `react-aria-*`) are deliberately excluded — both panes generate them in render order, so a divergent branch silently shifts them onto the *wrong* element.

- Branch B renamed a button ("Add member" → "Invite teammate"): text lookup fails, structural fallback still finds it → mirrored, logged as a warning ("matched by structure only").
- Branch B-only menu item ("Archive team"): nothing resolves → NO MATCH logged; the panes' status lines visibly desync (and the mirror's stale open menu is itself part of the desync). Exactly the failure mode a comparison tool must surface, not hide.
- Branch B inserted a list item at the top: `nth-of-type` paths shift, but aria-label resolution rescues every row; fraction-based scroll stays aligned.

### Traps found while building (each cost real debugging)

1. **`inert` does not protect the leader's focus.** Chrome does not propagate a parent-page `inert` (on the pane wrapper) into the iframe's document for *programmatic* `focus()` — react-aria in the mirror calls `element.focus()` internally (press management, menu autofocus) and each call steals top-level focus from the leader, killing typing and focus styling there. Fix: patch `HTMLElement.prototype.focus` inside the mirror window to a no-op while it's mirroring ("focus shadowing"). MDN documents `inert` as blocking focus *within* the subtree (https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert); the cross-frame-boundary gap is empirical.
2. **react-aria re-dispatches events synchronously.** Without a re-entrancy guard around the replay call, capture → replay → react-aria's synchronous re-dispatch → capture again recursed to a stack overflow — and because the capture listener runs inside the app's own dispatch, the exception corrupted React's event handling. Guard replays with a depth flag and wrap the capture handler in try/catch.
3. **esm.sh builds of react-aria-components break overlays.** Loaded as ESM from esm.sh (`react-aria-components@1.5.0?deps=react@18.3.1,react-dom@18.3.1`), Menu popovers and Tooltips silently never opened — with fully trusted input, no mirroring involved, no console errors (`?bundle-deps` didn't help; cause consistent with context/state duplication across the CDN's split chunks — **unverified**). The same app compiled locally with esbuild works completely. Don't evaluate "compiled React compatibility" through a CDN ESM build.
4. **CSS `:hover` can't be mirrored; react-aria's `data-hovered` can.** Replayed events flip react-aria's data attributes but never the CSS `:hover` pseudo-class. Apps styled via react-aria render props/data attributes mirror visually; apps styled with raw `:hover` won't. (Consistent with synthetic events being `isTrusted:false` — Part 3.)
5. **Portal unmount races produce spurious misses.** A trailing replayed `click` can arrive after the mirror's popover already closed (item unmounted) → logged NO MATCH even though the action had applied via the preceding key/pointer replay. Cosmetic, but a real tool should tolerate late events on unmounted targets.

### Verdict

Recipe A's bridge is **viable for same-origin compiled React apps**, including react-aria-components' pointer/keyboard event system, with two engineering obligations: focus shadowing in the mirror pane, and semantic target resolution (accessible names, or better, real `data-testid`s in the product) with divergence surfaced as first-class UI. Unverified beyond this setup: file:// + `srcdoc` hash routing, browsers other than Chrome, React 19, drag-and-drop, and text selection.

---

## Part 6 — Prototype: the bridge cross-origin, as a React component (2026-08-18)

Part 5's same-origin constraint dropped. Question: does the same mirroring bridge work when the two panes are **different origins** (two dev servers on different localhost ports — the visual-regression use case, where origin = scheme+host+port makes every dev server cross-origin: https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy) and the host page holds **no** `contentDocument` access?

Prototype on branch `prototype/crossorigin-component`, directory `prototype-crossorigin/`:

- **`sync-agent.js`** — runs *inside* each app-under-test (included via one script tag; inert outside an iframe). Contains `SyncCore` lifted verbatim from `prototype-synced-preview.html:350-549`, plus capture (capture-phase, passive, rAF-coalesced pointermove), local replay, local focus shadowing, local ghost cursor. All messaging pinned to the origin the script was served from (`document.currentScript.src`), both directions.
- **`SyncedPreviewProto.jsx`** — `'use client'` React component (Next.js-compatible): two iframes, postMessage router (hello/init/event/replay/result/state), leader A|B|both, divergence log, latency readout. Never touches frame DOM.
- **`local-demo.mjs`** — three-origin demo (`:4400` host, `:4401`/`:4402` branch A/B of the Part 5 compiled demo app, extracted from the prototype HTML at runtime).

Everything below is **empirical**: observed in Chrome 151 (macOS) on 2026-08-18 driving `local-demo.mjs` with real input. The prototype is the primary source; re-run it to re-verify.

### Verified cross-origin (same behaviors as Part 5)

- Controlled-TextField typing, react-aria press/click (single fire), hover via `data-hovered`, menu popovers through portals, hash navigation, switch/checkbox convergence, fraction-based scroll alignment with divergent list lengths.
- Divergence surfacing end-to-end over postMessage: `△ matched by structure only` on the relabeled button; `✕ NO MATCH` on the branch-B-only menu item — mirror's stale UI visibly desyncs, as designed.
- Leader switching mid-session (A→B), including focus-shadow flag handover via `state` messages; `both` mode wired but only spot-checked.
- Latency: **avg ~13–21 ms, max 58 ms over 113 mirrored events** (Date.now deltas, capture in leader → replay result received at host; same machine). postMessage transport is not the bottleneck.

### What changed vs the same-origin bridge

- Focus shadowing, ghost cursor, and replay move **into the agent** (host cannot reach frame DOM); host keeps routing, roles, divergence log. The Part 5 element inspector and console capture were **not ported** (inspector's cross-pane probe would need an async message round-trip; unbuilt, not blocked).
- The parent-side `inert` on the mirror wrapper still works (parent's own element) and still needs the in-frame focus patch beside it (Part 5 trap 1 unchanged).
- Injection is cooperative: the app-under-test must include the agent script tag (dev-only). No script tag → no mirroring; arbitrary third-party pages remain out of scope, consistent with Part 3.

### Unverified / open

- History-API (`pushState`) routing is not captured — only hash routing and replayed link clicks. First expected gap on real apps.
- React 19, non-Chrome browsers, HMR/dev-server websockets coexisting with the agent, `both` mode under sustained bidirectional use, N>2 panes.
- Real Next.js/Vite apps as panes (demo used the Part 5 compiled bundle); `prototype-crossorigin/README-TEST.md` is the work-PC procedure for exactly this.

### Verdict

**Cross-origin is viable.** The bridge survives the loss of `contentDocument` intact: every Part 5 mirroring behavior reproduced across origins with ~15 ms added round-trip, and the agent/host split (agent = capture+replay+focus, host = routing+divergence UI) is the natural component seam. The real component should be built on this architecture; same-origin becomes a special case, not the design center.
