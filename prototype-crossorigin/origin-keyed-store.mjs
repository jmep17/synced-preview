// PROTOTYPE — but this module is the liftable piece: drop the pattern into
// the real mock server to fix stateful mocks under live-compare.
//
// Problem: mirroring fires every interaction from BOTH panes, so one shared
// stateful mock double-applies mutations and the panes desync through the
// backend. Fix: key the state store by the request's Origin header — each
// branch dev server is a distinct origin, and cross-origin fetches always
// send Origin, so each pane transparently gets isolated state.
//
// createMockStore({ shared: true }) reproduces the broken shared behavior
// (used by the demo to demonstrate the failure mode).
export function createMockStore({ shared = false, seed }) {
  const stores = new Map(); // origin -> state
  function storeFor(req) {
    const key = shared ? '__shared__' : (req.headers.origin || '__no-origin__');
    if (!stores.has(key)) stores.set(key, seed());
    return stores.get(key);
  }
  return { storeFor, stores, mode: shared ? 'shared' : 'origin-keyed' };
}
