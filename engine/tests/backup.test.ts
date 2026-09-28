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
