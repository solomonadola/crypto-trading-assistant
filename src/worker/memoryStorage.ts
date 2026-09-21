/**
 * In-memory localStorage for Node, installed before the data layer loads.
 *
 * The data layer keeps its working copy of the trade list, the Firestore quota
 * guard and the bankroll settings in localStorage. Without it in Node, every
 * tick re-read the whole collection from Firestore (about 340 documents every
 * 30s, roughly 1M reads a day against a 50k free quota), the quota guard could
 * never engage, and price-tick updates - current price, session high and low,
 * which the trailing stop depends on - were lost between ticks because only
 * milestones are written to Firestore.
 *
 * Import this module first; ES modules evaluate imports in order.
 */
function usable(): boolean {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return false;
    ls.setItem('__probe', '1');
    ls.removeItem('__probe');
    return true;
  } catch {
    return false;   // e.g. newer Node's built-in storage without --localstorage-file
  }
}

if (!usable()) {
  const store = new Map<string, string>();
  const memory: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => { store.delete(k); },
    setItem: (k, v) => { store.set(k, String(v)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: memory, configurable: true, writable: true });
}

export {};
