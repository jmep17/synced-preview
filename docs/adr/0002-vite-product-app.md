# ADR-0002: Vite + React product app

Date: 2026-08-18 · Status: accepted

## Context

The validated prototypes (agent/host bridge, ADR 0001) had no build tooling:
a hand-rolled `node:http` server compiled the Host at startup. Migrating to a
real product app required choosing a framework for the consuming app that
renders the Host.

## Decision

Vite + React (JavaScript/JSX), plain SPA, npm workspaces (`app`, `fixtures`).

- The app is a client-side tool (iframes + postMessage); SSR adds nothing
  and complicates the multi-origin dev story.
- Vite bundles locally via esbuild/rollup — consistent with the Trap 3
  finding (docs/research.md Part 5): CDN ESM builds silently break
  react-aria popovers; always bundle locally.
- Existing code is already React 18 `.jsx`; minimal churn.
- `dev-proxy/Caddyfile` already assumes Vite panes (5173/5174).

The vendorable component stays plain React (peer dep: react only),
self-contained in `app/src/components/synced-preview/`. It keeps
`'use client'` (harmless in Vite, needed when vendored into Next.js App
Router).

The Agent's canonical source lives inside the component folder — it is half
of the wire protocol (ADR 0001) — and is served from the app origin by an
inline Vite plugin (dev middleware + unhashed `generateBundle` emit). Never
copy it into `public/`: duplicate copies drift.

Fixtures stay separate node processes (ports 4401–4404), not Vite
middleware: cross-origin-ness is the point of the bridge.

## Considered options

- **Next.js** — rejected: no SSR benefit, complicates multi-origin dev; the
  parity argument is void since the component vendors as plain React.
- **Keep the hand-rolled node:http host** — rejected: no HMR, no build story.

Evidence: docs/research.md Parts 5–6.
