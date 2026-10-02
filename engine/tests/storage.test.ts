import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getKv, openDb, setKv } from '../src/storage/db';
import { EventLog } from '../src/storage/eventLog';
import { SignalLog } from '../src/storage/signals';
import type { SignalRecord, TradeEvent } from '../../shared/types';

const event = (over: Partial<TradeEvent> = {}): TradeEvent => ({
  time: 1_000, positionId: 'p1', symbol: 'BTCUSDT', type: 'order_filled',
  payload: { price: 100, qty: 0.5 }, engineVersion: 'test', configHash: 'abc', ...over,
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('database', () => {
  it('migrates once and reopens an existing file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'engine-db-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'engine.db');
    const db = openDb(file);
    setKv(db, 'last_minute', '123');
    db.close();
    const again = openDb(file);
    expect(again.pragma('user_version', { simple: true })).toBe(2);
    expect(getKv(again, 'last_minute')).toBe('123');
    expect(getKv(again, 'missing')).toBeNull();
    again.close();
  });
});

describe('event log', () => {
  it('appends in order and reads back after an id', () => {
    const log = new EventLog(openDb(':memory:'));
    const [a, b] = log.append([event(), event({ type: 'stop_moved', payload: { stop: 98 } })]);
    expect(b.id).toBe(a.id! + 1);
    expect(log.lastId()).toBe(b.id);
    expect(log.after(a.id).map((e) => e.type)).toEqual(['stop_moved']);
    expect(log.after(0)[1].payload).toEqual({ stop: 98 });
    expect(log.forPosition('p1')).toHaveLength(2);
  });

  it('refuses to edit or delete a logged event', () => {
    const db = openDb(':memory:');
    new EventLog(db).append([event()]);
    expect(() => db.prepare("UPDATE trade_events SET type = 'liquidated'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM trade_events').run()).toThrow(/append-only/);
  });

  it('a failed batch writes nothing', () => {
    const db = openDb(':memory:');
    const log = new EventLog(db);
    const bad = event({ payload: undefined as unknown as Record<string, unknown> });
    // JSON.stringify(undefined) is undefined, which the NOT NULL column refuses.
    expect(() => log.append([event(), bad])).toThrow();
    expect(log.lastId()).toBe(0);
  });
});

describe('signal outcomes', () => {
  it('returns only finished signals ("outcome") since a time, oldest first', () => {
    const log = new SignalLog(openDb(':memory:'));
    const rec = (time: number, status: SignalRecord['status'], r?: number): SignalRecord =>
      ({ time, symbol: 'SOLUSDT', setup: 'session_sweep', direction: 'long', status, reason: status === 'outcome' ? 'target' : null, payload: { armedId: `a${time}`, r } });
    log.append([rec(1, 'taken'), rec(2, 'outcome', -1), rec(3, 'working'), rec(5, 'outcome', 2.5), rec(6, 'outcome', 1)]);
    expect(log.outcomes(4).map((s) => [s.time, s.payload.r])).toEqual([[5, 2.5], [6, 1]]);
    expect(log.outcomes(0)).toHaveLength(3);
  });
});
