# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone component project: **synced-preview**, a React component that renders two iframe previews side by side and mirrors interactions (clicks, hover, typing, keyboard, navigation, scroll) from a leader pane into a mirror pane, surfacing divergence between the two DOMs as first-class UI. The panes are cross-origin; the bridge is an agent/host split over postMessage (ADR 0001).

The component is built here and **vendored** (copied as a source folder) into a consuming app on a separate machine. It is not published to npm.

## Status

Product app up: Vite + React (ADR 0002), pnpm workspace. The vendorable component lives at `app/src/components/synced-preview/` (Host + Agent + README). Dev fixtures (apps-under-test, stateful mock, GitHub stub) live in `fixtures/` — dev-only, never vendored or shipped.

The app shell (`app/src/App.jsx`) has a URL-synced repo/branch picker (`?repo=owner/name&branch=…`): the component stays GitHub-agnostic (generic `listBranches`/`resolvePreviewUrl`; swapping the `listBranches` identity signals a repo switch), while GitHub fetching and preview-URL mapping (`VITE_PREVIEW_URL_TEMPLATE`, demo fallback) live in the shell. Implementation plans and their status live in `plans/`.

## Commands

- `pnpm install` — install all workspace dependencies
- `pnpm dev` — Vite app (:5173) + fixture servers (:4401–:4404) together; open http://localhost:5173
- `pnpm dev:app` / `pnpm dev:fixtures` — each alone
- `pnpm test` — mock-proxy suite (`node --test`)
- `pnpm build` — production build of `app/` (emits unhashed `sync-agent.js` into `dist/`)
- `node fixtures/demo-server.mjs --shared-mock` — reproduce the shared-mock desync

No lint tooling yet; add the command here when scaffolded.

## Constraints

- **Self-contained**: the component must live in one folder with no imports from outside it, so it can be dropped into a consuming app's `src/components/`.
- **Peer dependencies only** (e.g. `react`); no app-specific dependencies.
- **Single agent copy**: the canonical `sync-agent.js` is the one inside the component folder. Never copy it into `public/` or anywhere else in this repo — it is served from the app origin by the inline Vite plugin in `app/vite.config.js`. Consuming apps copy it to their static route only as a scripted build/deploy step (see the component README).
- `react-aria-components` belongs only to `fixtures/`; the `app` workspace must not depend on it.

## Primary sources

- `docs/research.md` — sourced survey of embedding + diffing options (researched 2026-08-18). Part 5 records the empirical findings the component is built on: what mirrors correctly, divergence behavior, and five traps (focus shadowing, re-entrancy guard, CDN ESM builds, `:hover` vs `data-hovered`, portal unmount races). Part 6 validates the cross-origin bridge. Follow its evidence rules when editing it: every claim cites a primary source inline, unverifiable claims are marked **unverified**, and updated facts get re-verified with a new date rather than silently edited.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — the five canonical roles used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
