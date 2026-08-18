# synced-preview

A React component that shows two same-origin iframe previews side by side and mirrors interactions from a leader pane into a mirror pane — clicks, hover, typing, keyboard, navigation, and scroll — surfacing divergence between the two DOMs instead of hiding it.

Intended use: previewing two branches/variants of the same app and interacting with both at once.

## Status

**Pre-implementation.** The public interface is being settled; nothing here is installable yet.

What exists today:

- `prototype-synced-preview.html` — working throwaway prototype (open over `http://localhost`, verified in Chrome). Demonstrates the mirroring bridge against two compiled React 18 + react-aria-components apps.
- `docs/research.md` — the sourced research survey behind the design. Part 5 documents what the prototype proved and the traps it found.

## Planned distribution

Vendored source: the component will be a self-contained folder (peer deps only, e.g. `react`) that a consuming app copies into its `src/components/` and wires up via props. No npm publish.

## Integration steps

To be written once the component exists.
