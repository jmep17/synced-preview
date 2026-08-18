# ADR-0001: Cross-origin agent/host bridge architecture

Date: 2026-08-18 · Status: accepted

## Context

The component's panes are dev servers of apps under test, each on its own
localhost port — always cross-origin (origin = scheme+host+port). The Part 5
bridge reached into frames via same-origin `contentDocument`; that is
architecturally impossible here.

## Decision

Split the bridge at the origin boundary:

- **Agent** (`sync-agent.js`): runs inside each app-under-test via one
  dev-only script tag. Owns capture, replay, focus shadowing, ghost cursor.
  Pins all postMessage traffic to the origin it was served from.
- **Host** (React component): owns iframes, event routing, leader/roles,
  divergence log. Never touches frame DOM.

Same-origin becomes a special case of this design, not a separate mode.

## Consequences

- Apps under test must cooperate (include the agent tag); arbitrary
  third-party pages stay out of scope.
- ~15 ms added replay latency (measured; docs/research.md Part 6) — acceptable.
- Element-inspector-style features need async message round-trips.

Evidence: docs/research.md Part 6; prototype on branch
`prototype/crossorigin-component`.
