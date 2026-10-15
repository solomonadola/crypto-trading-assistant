import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getKv, openDb, setKv } from '../src/storage/db';
import { EventLog } from '../src/storage/eventLog';
import { SignalLog } from '../src/storage/signals';
import { TradeJournalStore } from '../src/storage/journal';
import { formingCandle } from '../src/feed/candleStore';
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
    expect(again.pragma('user_version', { simple: true })).toBe(3);
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

describe('forming candle', () => {
  const H = Date.UTC(2026, 9, 2, 10, 0);
  const minute = (i: number, o: number, h: number, l: number, c: number) => ({
    symbol: 'BTCUSDT', tf: '1m' as const, openTime: H + i * 60_000, closeTime: H + (i + 1) * 60_000 - 1,
    open: o, high: h, low: l, close: c, volume: 1, quoteVolume: 10, trades: 2,
  });

  it('builds the 15m candle from the minutes since it opened', () => {
    // 10:13 and 10:14 belong to the 10:00 candle; 10:15 to 10:16 to the forming 10:15 one.
    const ms = [minute(13, 1, 2, 0.5, 1.5), minute(14, 1.5, 3, 1, 2), minute(15, 2, 4, 1.8, 3), minute(16, 3, 3.5, 2.5, 2.8)];
    expect(formingCandle('15m', ms, H)).toEqual({
      symbol: 'BTCUSDT', tf: '15m', openTime: H + 15 * 60_000, closeTime: H + 30 * 60_000 - 1,
      open: 2, high: 4, low: 1.8, close: 2.8, volume: 2, quoteVolume: 20, trades: 4,
    });
  });

  it('is null when the newest closed candle already covers it, or no minute has closed', () => {
    expect(formingCandle('15m', [minute(14, 1, 2, 0.5, 1.5)], H)).toBeNull();
    expect(formingCandle('15m', [], H)).toBeNull();
  });
});

describe('trade journal store', () => {
  it('saves and retrieves journal entries with ATA reflections and ratings', () => {
    const db = openDb(':memory:');
    const store = new TradeJournalStore(db);

    expect(store.getAll()).toEqual([]);
    expect(store.get('t1')).toBeNull();

    store.save({
      tradeId: 't1',
      rating: 5,
      tags: ['Followed Rules', 'Patient Entry'],
      notes: 'Clean 4H demand tap with 5m CHoCH confirmation.',
      ata: {
        pdAlignment: 'discount',
        majorLiquidityTaken: true,
        hrlrOrLrlr: 'lrlr',
        htfTrendAligned: true,
        keyPoi: 'ob',
        shiftReason: 'Asian low swept followed by aggressive displacement.',
        invalidation: '4H candle close below 64200.',
      },
      updatedAt: 123456,
    });

    const retrieved = store.get('t1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.rating).toBe(5);
    expect(retrieved?.tags).toEqual(['Followed Rules', 'Patient Entry']);
    expect(retrieved?.notes).toBe('Clean 4H demand tap with 5m CHoCH confirmation.');
    expect(retrieved?.ata?.pdAlignment).toBe('discount');
    expect(retrieved?.ata?.majorLiquidityTaken).toBe(true);

    // Overwriting updates existing entry
    store.save({
      tradeId: 't1',
      rating: 4,
      tags: ['Followed Rules', 'Early Exit'],
      notes: 'Took profit slightly early before TP2.',
      updatedAt: 123999,
    });

    const updated = store.get('t1');
    expect(updated?.rating).toBe(4);
    expect(updated?.tags).toEqual(['Followed Rules', 'Early Exit']);
    expect(store.getAll()).toHaveLength(1);
  });
});

