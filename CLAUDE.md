# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A research-notes repository, not a codebase. It contains a single deliverable: `README.md`, a sourced survey of options for embedding interactive web-app previews and doing side-by-side/diff comparison of them. There is no build, lint, or test tooling, and it is not a git repository.

## Conventions for editing README.md

The document follows strict evidence rules (stated in its preamble). Preserve them when adding or updating content:

- Every claim is backed by a primary source (official docs, GitHub repos, npm registry, WHATWG/W3C specs, MDN) with the URL cited inline next to the claim.
- Anything that cannot be traced to a primary source is explicitly marked **unverified** — including "absence" claims (e.g. "none found" rather than "none exists").
- npm version numbers and publish dates come from registry.npmjs.org and state the retrieval date.
- Dated snapshots: the doc records when research was done (e.g. "Researched 2026-08-18"). When updating facts later, re-verify against sources and update the date rather than silently editing.

## Structure

- **TL;DR / Recommendations** at top — decision-oriented summary, kept in sync with the body.
- **Part 1** — embedding options (iframe primitives, Sandpack, WebContainers, StackBlitz/CodeSandbox, react-live, micro-frontends). Comparison table first, then per-tool sections.
- **Part 2** — diffing (pixel-diff engines, DOM capture/diff, synchronized browsing). Comparison tables with license and last-publish columns.
- **Part 3** — composed recipes (A–D) pairing embedding with diffing, plus a bottom-line pairings table.
- **Sources** — grouped link list; new citations get added here as well as inline.
- **Part 4+** — follow-up questions appended as new dated parts rather than rewritten into earlier sections.

New research follows the same pattern: append a dated part, cite inline, extend the Sources section.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — the five canonical roles used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
