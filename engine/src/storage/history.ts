// The history tables a restart on an empty disk would otherwise lose: signal
// records, shadow-trade results and the equity curve. Rows are copied to the
// backup as they are and put back as they were (same ids), so a restore leaves
// the database exactly as it was. Trade events have their own path
// (EventLog, FirestoreBackup.pushEvents).
import type { DB } from './db';

export interface HistoryTable {
  /** Table name, also the backup collection's suffix. */
  name: 'signals' | 'shadow_results' | 'equity';
  /** The column that orders rows and keys them in the backup. */
  key: 'id' | 'time';
}

export const HISTORY_TABLES: HistoryTable[] = [
  { name: 'signals', key: 'id' },
  { name: 'shadow_results', key: 'id' },
  { name: 'equity', key: 'time' },
];

export type HistoryRow = Record<string, string | number | null>;

/** Rows with a key above `after`, oldest first. */
export function rowsAfter(db: DB, t: HistoryTable, after: number, limit = 2000): HistoryRow[] {
  return db.prepare(`SELECT * FROM ${t.name} WHERE ${t.key} > ? ORDER BY ${t.key} LIMIT ?`).all(after, limit) as HistoryRow[];
}

/** The newest key in the table, 0 when empty. */
export function lastKey(db: DB, t: HistoryTable): number {
  return (db.prepare(`SELECT MAX(${t.key}) AS k FROM ${t.name}`).get() as { k: number | null }).k ?? 0;
}

/** Puts rows back as they were; rows already there are kept. Returns how many were added. */
export function insertRows(db: DB, t: HistoryTable, rows: HistoryRow[]): number {
  if (!rows.length) return 0;
  let added = 0;
  db.transaction(() => {
    for (const row of rows) {
      const cols = Object.keys(row);
      added += db.prepare(`INSERT OR IGNORE INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => row[c])).changes;
    }
  })();
  return added;
}

/** The saved engine state: what a lease or release writes to the backup. */
export interface SavedState {
  clock: number;
  lastEventId: number;
  universe: string[];
  watchlist?: string[];
}

/**
 * What to write when taking or renewing the lease: this engine's state, but
 * never older than what is saved. An engine that has not restored yet (an
 * empty disk after a redeploy) would otherwise write a blank clock, the
 * default coin list and an empty watchlist over the real ones.
 */
export function mergeState(saved: Partial<SavedState> | undefined, mine: SavedState): SavedState {
  if (!saved || (saved.clock ?? 0) <= mine.clock) return mine;
  return {
    clock: saved.clock ?? 0,
    lastEventId: Math.max(saved.lastEventId ?? 0, mine.lastEventId),
    universe: saved.universe?.length ? saved.universe : mine.universe,
    watchlist: saved.watchlist ?? mine.watchlist,
  };
}
