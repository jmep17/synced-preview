# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone component project: **synced-preview**, a React component that renders two same-origin iframe previews side by side and mirrors interactions (clicks, hover, typing, keyboard, navigation, scroll) from a leader pane into a mirror pane, surfacing divergence between the two DOMs as first-class UI.

The component is built here and **vendored** (copied as a source folder) into a consuming app on a separate machine. It is not published to npm.

## Status

Pre-implementation. The public interface is not settled yet — see `CONTEXT.md` and `docs/adr/` once they exist (created lazily during grilling; see `docs/agents/domain.md`).

No build, lint, or test tooling exists yet. Add the commands to this file when they are scaffolded.

## Constraints

- **Self-contained**: the component must live in one folder with no imports from outside it, so it can be dropped into a consuming app's `src/components/`.
- **Peer dependencies only** (e.g. `react`); no app-specific dependencies.

## Primary sources

- `docs/research.md` — sourced survey of embedding + diffing options (researched 2026-08-18). Part 5 records the empirical findings the component is built on: what mirrors correctly, divergence behavior, and five traps (focus shadowing, re-entrancy guard, CDN ESM builds, `:hover` vs `data-hovered`, portal unmount races). Follow its evidence rules when editing it: every claim cites a primary source inline, unverifiable claims are marked **unverified**, and updated facts get re-verified with a new date rather than silently edited.
- `prototype-synced-preview.html` + `prototype-synced-preview.app.jsx` — the throwaway prototype that produced those findings. Keep as reference until the component supersedes it, then delete (git history keeps it).

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — the five canonical roles used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
