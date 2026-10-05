import { describe, expect, it } from 'vitest';
import { FirestoreBackup, type BackupState } from '../src/storage/firestoreBackup';
import type { TradeEvent } from '../../shared/types';

/** Just enough of Firestore for the backup: documents by path, ordered reads, batches and transactions. */
function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  let writes = 0;
  const ref = (col: string, id: string) => ({
    path: `${col}/${id}`,
    id,
    get: async () => ({ exists: docs.has(`${col}/${id}`), data: () => docs.get(`${col}/${id}`) }),
  });
  const db = {
    collection: (col: string) => ({
      doc: (id: string) => ref(col, id),
      orderBy: () => {
        const q = (after: string, n: number) => ({
          get: async () => {
            const ids = [...docs.keys()].filter((k) => k.startsWith(`${col}/`)).map((k) => k.slice(col.length + 1)).filter((id) => id > after).sort().slice(0, n);
            return { empty: !ids.length, docs: ids.map((id) => ({ id, data: () => docs.get(`${col}/${id}`) })) };
          },
        });
        return { startAfter: (after: string) => ({ limit: (n: number) => q(after, n) }) };
      },
    }),
    batch: () => {
      const pending: [string, Record<string, unknown>][] = [];
      return { set: (r: { path: string }, d: Record<string, unknown>) => pending.push([r.path, d]), commit: async () => { for (const [p, d] of pending) { docs.set(p, d); writes++; } } };
    },
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
      get: (r: { get: () => Promise<unknown> }) => r.get(),
      set: (r: { path: string }, d: Record<string, unknown>) => { docs.set(r.path, d); writes++; },
    }),
  };
  return { db, docs, writes: () => writes };
}

const make = (db: unknown, holder: string) =>
  new (FirestoreBackup as unknown as new (db: unknown, ns: string, holder: string) => FirestoreBackup)(db, 'test', holder);

const ev = (id: number, payload: Record<string, unknown> = {}): TradeEvent =>
  ({ id, time: id * 1000, positionId: 'p', symbol: 'SOLUSDT', type: 'order_filled', payload, engineVersion: 't', configHash: 't' });
const state = (clock: number, lastEventId: number): BackupState => ({ clock, lastEventId, universe: ['SOLUSDT'] });

describe('Firestore backup', () => {
  it('pushes each event once, drops undefined fields, and restores them in order', async () => {
    const f = fakeFirestore();
    const a = make(f.db, 'a');
    expect(await a.pushEvents([ev(1), ev(2, { note: undefined, qty: 1 })])).toBe(2);
    expect(await a.pushEvents([ev(1), ev(2), ev(3)])).toBe(1);
    expect(f.writes()).toBe(3);
    expect(f.docs.get('engine_test_events/000000000002')).toEqual(expect.objectContaining({ payload: { qty: 1 } }));

    const b = make(f.db, 'b');
    const all = await b.restore(0);
    expect(all.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect((await make(f.db, 'c').restore(2)).events.map((e) => e.id)).toEqual([3]);
  });

  it('restores past 500 events', async () => {
    const f = fakeFirestore();
    const a = make(f.db, 'a');
    await a.pushEvents(Array.from({ length: 1234 }, (_, i) => ev(i + 1)));
    const { events } = await make(f.db, 'b').restore(0);
    expect(events).toHaveLength(1234);
    expect(events[1233].id).toBe(1234);
  });

  it('after a restore, only events newer than what Firestore holds are written', async () => {
    const f = fakeFirestore();
    const a = make(f.db, 'a');
    await a.pushEvents([ev(1), ev(2)]);
    await a.lease(state(5, 2), 60_000, 0);
    const b = make(f.db, 'b');
    await b.restore(2);
    expect(await b.pushEvents([ev(1), ev(2), ev(3)])).toBe(1);
  });

  it('one holder at a time; the lease can be taken once it expires or is released', async () => {
    const f = fakeFirestore();
    const a = make(f.db, 'a');
    const b = make(f.db, 'b');
    expect(await a.lease(state(1, 0), 60_000, 0)).toBe(true);
    expect(await b.lease(state(1, 0), 60_000, 30_000)).toBe(false);
    expect(await a.lease(state(2, 0), 60_000, 30_000)).toBe(true);     // renewal
    expect(await b.lease(state(2, 0), 60_000, 89_999)).toBe(false);
    expect(await b.lease(state(2, 0), 60_000, 90_001)).toBe(true);     // expired
    await b.release(state(3, 0), 100_000);
    expect(await a.lease(state(3, 0), 60_000, 100_001)).toBe(true);    // released
    expect(f.docs.get('engine_test_state/engine')).toMatchObject({ holder: 'a', clock: 3, universe: ['SOLUSDT'] });
  });

  it('the state saved with the lease comes back on restore', async () => {
    const f = fakeFirestore();
    await make(f.db, 'a').lease(state(1_790_000_000_000, 7), 60_000, 0);
    const { state: s } = await make(f.db, 'b').restore(0);
    expect(s).toMatchObject({ clock: 1_790_000_000_000, lastEventId: 7, universe: ['SOLUSDT'] });
  });
});

describe('history backup and the saved state', () => {
  it('copies signal, shadow and equity rows out and puts them back with the same ids', async () => {
    const { openDb } = await import('../src/storage/db');
    const { SignalLog } = await import('../src/storage/signals');
    const { Results } = await import('../src/storage/results');
    const { HISTORY_TABLES, insertRows, lastKey, rowsAfter } = await import('../src/storage/history');
    const before = openDb(':memory:');
    new SignalLog(before).append([
      { time: 1000, symbol: 'SOLUSDT', setup: 'htf_poi', direction: 'long', status: 'armed', reason: null, payload: { a: 1 } },
      { time: 2000, symbol: 'SOLUSDT', setup: 'htf_poi', direction: 'long', status: 'taken', reason: null, payload: { b: 2 } },
    ]);
    const results = new Results(before);
    results.recordEquity({ time: 300_000, balance: 1000, equity: 1001, openPositions: 1 });
    results.recordEquity({ time: 600_000, balance: 1010, equity: 1010, openPositions: 0 });
    // An empty disk after a redeploy gets every row back, keys and all.
    const after = openDb(':memory:');
    for (const t of HISTORY_TABLES) {
      expect(insertRows(after, t, rowsAfter(before, t, 0))).toBe(rowsAfter(before, t, 0).length);
      expect(rowsAfter(after, t, 0)).toEqual(rowsAfter(before, t, 0));
      expect(lastKey(after, t)).toBe(lastKey(before, t));
    }
    expect(new SignalLog(after).recent().map((s) => s.status)).toEqual(['taken', 'armed']);
    expect(new Results(after).equity(0).map((p) => p.equity)).toEqual([1001, 1010]);
    // Putting them back twice adds nothing; only newer rows are read for the next push.
    expect(insertRows(after, HISTORY_TABLES[0], rowsAfter(before, HISTORY_TABLES[0], 0))).toBe(0);
    expect(rowsAfter(before, HISTORY_TABLES[2], 300_000).map((r) => r.time)).toEqual([600_000]);
  });

  it('a lease from an engine that has not restored yet never blanks the saved state', async () => {
    const { mergeState } = await import('../src/storage/history');
    const saved = { clock: 5000, lastEventId: 42, universe: ['QNTUSDT', 'MOVRUSDT'], watchlist: ['XLMUSDT'] };
    const blank = { clock: 0, lastEventId: 0, universe: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], watchlist: [] };
    expect(mergeState(saved, blank)).toEqual(saved);
    // A running engine that is ahead writes its own state.
    const ahead = { clock: 6000, lastEventId: 50, universe: ['ZROUSDT'], watchlist: [] };
    expect(mergeState(saved, ahead)).toEqual(ahead);
    expect(mergeState(undefined, blank)).toEqual(blank);
  });
});
