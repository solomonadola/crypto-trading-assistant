/**
 * localStorage for Node, backed by a JSON file, installed before the data
 * layer loads.
 *
 * The data layer keeps its working copy of the trade list, the sync cursor,
 * queued writes and the Firestore quota guard in localStorage. In the server
 * that storage lives in memory and is mirrored to WORKER_STATE_FILE (default
 * data/worker-state.json), so that:
 *  - a restart resumes from the file with a changes-only sync instead of
 *    re-reading the whole history (one read per trade ever made), and
 *  - with Firestore unreadable (daily quota spent, outage) the worker can go
 *    on trading from a list it has already confirmed, queueing its writes.
 *
 * About 3 KB per trade; the whole history is kept, because portfolio value is
 * calculated from every closed trade. On hosts with a temporary disk (Cloud
 * Run) the file lasts until the instance restarts, after which the worker does
 * one full read, as it would without the file.
 *
 * Import this module first; ES modules evaluate imports in order.
 */
import fs from 'node:fs';
import path from 'node:path';

export const STATE_FILE = process.env.WORKER_STATE_FILE || path.join(process.cwd(), 'data', 'worker-state.json');
const SAVE_DELAY_MS = 2000;

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

const store = new Map<string, string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): void {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) if (typeof v === 'string') store.set(k, v);
      console.log(`[Storage] Resumed from ${STATE_FILE} (${store.size} keys)`);
    }
  } catch {
    // no file yet, or unreadable: start empty and sync from Firestore
  }
}

/** Writes the state file now. Atomic: a crash mid-write leaves the old file. */
export function saveStateNow(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(store)));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.warn(`[Storage] Could not save ${STATE_FILE}:`, err instanceof Error ? err.message : err);
  }
}

function scheduleSave(): void {
  if (!saveTimer) saveTimer = setTimeout(saveStateNow, SAVE_DELAY_MS);
}

if (!usable()) {
  if (process.env.WORKER_STATE_FILE !== 'off') load();
  const persist = process.env.WORKER_STATE_FILE !== 'off' ? scheduleSave : () => {};
  const memory: Storage = {
    get length() { return store.size; },
    clear: () => { store.clear(); persist(); },
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => { store.delete(k); persist(); },
    setItem: (k, v) => { store.set(k, String(v)); persist(); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: memory, configurable: true, writable: true });
}
