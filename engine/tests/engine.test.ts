import { describe, expect, it } from 'vitest';
import { Engine, CommandError } from '../src/core/engine';
import { loadConfig, type EngineConfig } from '../src/config';
import type { EntryFill } from '../src/portfolio';
import type { Candle, TradeEvent } from '../../shared/types';

const u = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z';

function engine(over: (c: EngineConfig) => void = () => {}) {
  const config = loadConfig('engine/config/config.yaml');
  // These tests cover the session-end exit and whole-session entries.
  config.sessions = { ...config.sessions, exit_at_session_end: true, weekdays_only: false, killzones: [] };
  config.exits.management = 'classic';
  over(config);
  return new Engine({ config, configHash: 'test', engineVersion: 'test' });
}

/** 1m candles for `symbol` closing every minute in (from, to]. */
function minutes(from: string, to: string, symbol = 'BTCUSDT'): Candle[] {
  const out: Candle[] = [];
  for (let close = u(from) + 60_000; close <= u(to); close += 60_000) {
    out.push({ symbol, tf: '1m', openTime: close - 60_000, closeTime: close, open: 100, high: 101, low: 99, close: 100, volume: 1, quoteVolume: 100, trades: 1 });
  }
  return out;
}

/** An entry fill as the simulator will log it, with the session the engine assigns at that time. */
function entry(e: Engine, id: string, at: string, symbol = 'BTCUSDT'): TradeEvent {
  const payload: EntryFill = { role: 'entry', side: 'long', qty: 1, price: 100, stop: 98, session: e.sessions.ownerAt(u(at)) };
  return { time: u(at), positionId: id, symbol, type: 'order_filled', payload: payload as unknown as Record<string, unknown>, engineVersion: 'test', configHash: 'test' };
}

const closes = (events: TradeEvent[]) =>
  events.filter((e) => e.type === 'order_placed').map((e) => `${e.positionId} ${e.payload.reason} ${iso(e.time)}`);

describe('engine clock', () => {
  it('is the close time of the newest candle, and never goes back', () => {
    const e = engine();
    expect(e.now()).toBe(0);
    e.onCandles(minutes('2026-07-15T10:00Z', '2026-07-15T10:05Z'));
    expect(iso(e.now())).toBe('2026-07-15T10:05Z');
    e.onCandles(minutes('2026-07-15T09:00Z', '2026-07-15T09:03Z'));
    expect(iso(e.now())).toBe('2026-07-15T10:05Z');
  });
});

describe('session-end exits', () => {
  it('a London trade closes at 16:00 UTC in summer, even while New York is open', () => {
    const e = engine();
    e.restore([entry(e, 'p1', '2026-07-15T08:30Z')], u('2026-07-15T08:30Z'));
    const out = e.onCandles([...minutes('2026-07-15T08:30Z', '2026-07-15T16:10Z'), ...minutes('2026-07-15T08:30Z', '2026-07-15T16:10Z', 'ETHUSDT')]
      .sort((a, b) => a.closeTime - b.closeTime));
    expect(closes(out)).toEqual(['p1 session_end 2026-07-15T16:00Z']);
    // Filled at the open of the next minute (16:00-16:01), recorded when that candle closes.
    const closed = out.find((x) => x.type === 'position_closed')!;
    expect(iso(closed.time)).toBe('2026-07-15T16:01Z');
    expect(closed.payload.reason).toBe('session_end');
    expect(e.positions()).toEqual([]);
  });

  it('each trade closes at the end of its own session', () => {
    const e = engine();
    e.restore([
      entry(e, 'asia', '2026-07-15T02:00Z'),
      entry(e, 'london', '2026-07-15T10:00Z'),
      entry(e, 'ny', '2026-07-15T13:00Z'),
    ], u('2026-07-15T13:00Z'));
    // Replay from the first entry: the engine skips what is before its clock, so start from 13:00.
    const out = e.onCandles(minutes('2026-07-15T13:00Z', '2026-07-15T21:30Z'));
    // The Asian trade's session ended at 09:00, before the engine's clock: it closes at the first minute processed.
    expect(closes(out)).toEqual([
      'asia session_end 2026-07-15T13:01Z',
      'london session_end 2026-07-15T16:00Z',
      'ny session_end 2026-07-15T21:00Z',
    ]);
  });

  it('London DST weekend: Saturday 07:30 is an Asian trade, Sunday 07:30 a London trade', () => {
    const sat = engine();
    sat.restore([entry(sat, 'sat', '2026-03-28T07:30Z')], u('2026-03-28T07:30Z'));
    expect(closes(sat.onCandles(minutes('2026-03-28T07:30Z', '2026-03-28T17:00Z')))).toEqual(['sat session_end 2026-03-28T09:00Z']);

    const sun = engine();
    sun.restore([entry(sun, 'sun', '2026-03-29T07:30Z')], u('2026-03-29T07:30Z'));
    expect(closes(sun.onCandles(minutes('2026-03-29T07:30Z', '2026-03-29T17:00Z')))).toEqual(['sun session_end 2026-03-29T16:00Z']);
  });

  it('US DST end: a New York trade on 2 November closes at 22:00 UTC, on 31 October at 21:00', () => {
    for (const [day, close] of [['2026-10-30', '21:00'], ['2026-11-02', '22:00']]) {
      const e = engine();
      e.restore([entry(e, 'ny', `${day}T15:00Z`)], u(`${day}T15:00Z`));
      expect(closes(e.onCandles(minutes(`${day}T15:00Z`, `${day}T23:00Z`)))).toEqual([`ny session_end ${day}T${close}Z`]);
    }
  });

  it('after downtime, a trade whose session ended while down closes at the first minute processed', () => {
    const e = engine();
    e.restore([entry(e, 'p1', '2026-07-15T10:00Z')], u('2026-07-15T15:00Z'));
    expect(closes(e.onCandles(minutes('2026-07-15T17:29Z', '2026-07-15T17:30Z')))).toEqual(['p1 session_end 2026-07-15T17:30Z']);
  });

  it('asks only once, and not again after a restart', () => {
    const e = engine();
    const opened = entry(e, 'p1', '2026-07-15T10:00Z');
    e.restore([opened], u('2026-07-15T10:00Z'));
    const out = e.onCandles(minutes('2026-07-15T10:00Z', '2026-07-15T18:00Z'));
    expect(closes(out)).toHaveLength(1);

    const restarted = engine();
    restarted.restore([opened, ...out], e.now());
    expect(restarted.onCandles(minutes('2026-07-15T18:00Z', '2026-07-15T19:00Z'))).toEqual([]);
  });

  it('can be switched off', () => {
    const e = engine((c) => { c.sessions.exit_at_session_end = false; });
    e.restore([entry(e, 'p1', '2026-07-15T10:00Z')], u('2026-07-15T10:00Z'));
    expect(e.onCandles(minutes('2026-07-15T10:00Z', '2026-07-15T18:00Z'))).toEqual([]);
  });

  it('a trade with no session (sessions off) is never closed by time', () => {
    const e = engine((c) => { c.sessions.enabled = false; });
    const opened = entry(e, 'p1', '2026-07-15T10:00Z');
    expect(opened.payload.session).toBeNull();
    e.restore([opened], u('2026-07-15T10:00Z'));
    expect(e.onCandles(minutes('2026-07-15T10:00Z', '2026-07-16T10:00Z'))).toEqual([]);
  });
});

describe('replay and determinism', () => {
  it('the same inputs give identical events', () => {
    const run = () => {
      const e = engine();
      e.restore([entry(e, 'a', '2026-07-15T02:00Z'), entry(e, 'b', '2026-07-15T13:00Z')], u('2026-07-15T02:00Z'));
      return e.onCandles(minutes('2026-07-15T02:00Z', '2026-07-16T02:00Z'));
    };
    const first = run();
    expect(first.map((x) => x.type)).toEqual(['order_placed', 'position_closed', 'order_placed', 'position_closed']);
    expect(run()).toEqual(first);
  });

  it('candles already processed are ignored when replayed again', () => {
    const e = engine();
    e.restore([entry(e, 'p1', '2026-07-15T10:00Z')], u('2026-07-15T10:00Z'));
    const batch = minutes('2026-07-15T10:00Z', '2026-07-15T16:30Z');
    expect(closes(e.onCandles(batch))).toHaveLength(1);
    expect(e.onCandles(batch)).toEqual([]);
  });

  it('events carry the engine clock, version and config hash', () => {
    const e = engine();
    e.restore([entry(e, 'p1', '2026-07-15T10:00Z')], u('2026-07-15T10:00Z'));
    const [ev] = e.onCandles(minutes('2026-07-15T15:59Z', '2026-07-15T16:00Z'));
    expect(ev).toMatchObject({ time: u('2026-07-15T16:00Z'), positionId: 'p1', symbol: 'BTCUSDT', type: 'order_placed', engineVersion: 'test', configHash: 'test' });
    expect(ev.payload).toEqual({ action: 'close', orderType: 'market', reason: 'session_end', session: 'london' });
  });
});

describe('commands', () => {
  it('close acts at engine time, once', () => {
    const e = engine();
    e.restore([entry(e, 'p1', '2026-07-15T10:00Z')], u('2026-07-15T10:30Z'));
    expect(closes(e.onCommand({ type: 'close', positionId: 'p1' }))).toEqual(['p1 manual 2026-07-15T10:30Z']);
    expect(e.onCommand({ type: 'close', positionId: 'p1' })).toEqual([]);
    // Filled at the next minute's open; no session-end close follows.
    const after = e.onCandles(minutes('2026-07-15T10:30Z', '2026-07-15T17:00Z'));
    expect(after.map((x) => `${x.type} ${x.payload.reason} ${iso(x.time)}`)).toEqual(['position_closed manual 2026-07-15T10:31Z']);
  });

  it('close of an unknown position is an error', () => {
    expect(() => engine().onCommand({ type: 'close', positionId: 'nope' })).toThrow(CommandError);
  });

  it('close_all closes every position without a pending close', () => {
    const e = engine();
    e.restore([entry(e, 'a', '2026-07-15T10:00Z'), entry(e, 'b', '2026-07-15T10:05Z', 'ETHUSDT')], u('2026-07-15T11:00Z'));
    e.onCommand({ type: 'close', positionId: 'a' });
    expect(closes(e.onCommand({ type: 'close_all' }))).toEqual(['b kill 2026-07-15T11:00Z']);
  });
});

describe('manual trades', () => {
  const at = u('2026-07-15T10:30Z');
  const open = (e: Engine, over: Partial<Extract<Parameters<Engine['onCommand']>[0], { type: 'open' }>> = {}) =>
    e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at + 40_000, stop: 98, target: 106, note: 'Scalp: EMA20 pullback', ...over });
  const minute = (openTime: number, low: number): Candle =>
    ({ symbol: 'BTCUSDT', tf: '1m', openTime, closeTime: openTime + 59_999, open: 100, high: 100.5, low, close: 100, volume: 1, quoteVolume: 100, trades: 1 });

  it('fills at once at the asked price plus slippage, sized so the loss at the stop is the usual risk', () => {
    const e = engine();
    e.restore([], at);
    const events = open(e);
    expect(events.map((x) => x.type)).toEqual(['order_placed', 'order_filled']);
    const fill = events[1].payload as unknown as EntryFill & { notional: number };
    expect(events[1].time).toBe(at + 40_000);
    expect(fill.price).toBeGreaterThan(100);   // slippage against a long
    expect(fill.setup).toBe('manual');
    expect(fill.note).toBe('Scalp: EMA20 pullback');
    // 1% of the 1,000 balance lost at the stop, costs included.
    const lossPct = ((fill.price - 98) / fill.price) * 100 + 0.2;
    expect((fill.notional * lossPct) / 100).toBeCloseTo(10, 0);
    expect(e.positions()).toHaveLength(1);
  });

  it('is managed like any trade: a candle from before the entry does not stop it, a later one does', () => {
    const e = engine();
    e.restore([], at);
    open(e);
    // The 10:30 minute opened before the 10:30:40 entry: its low under the stop happened before it.
    expect(e.onCandles([minute(at, 97)]).filter((x) => x.type === 'position_closed')).toEqual([]);
    const closed = e.onCandles([minute(at + 60_000, 97.5)]).filter((x) => x.type === 'position_closed');
    expect(closed.map((x) => x.payload.reason)).toEqual(['stop']);
    const trade = e.closedTrades()[0];
    expect(trade.setup).toBe('manual');
    expect(trade.note).toBe('Scalp: EMA20 pullback');
    expect(trade.pnl).toBeLessThan(0);
  });

  it('is rebuilt from its events after a restart', () => {
    const e = engine();
    e.restore([], at);
    const events = open(e);
    const again = engine();
    again.restore(events, at + 60_000);
    expect(again.positions().map((p) => [p.symbol, p.setup, p.note])).toEqual([['BTCUSDT', 'manual', 'Scalp: EMA20 pullback']]);
  });

  it('counts against the daily limit on new trades, across coins', () => {
    const e = engine((c) => { c.risk.max_trades_per_day = 1; });
    e.restore([], at);
    open(e);
    expect(() => open(e, { symbol: 'ETHUSDT', time: at + 50_000 })).toThrow(/max trades per day/);
  });

  it('refuses a stop or target on the wrong side, a coin already held, and an engine not started', () => {
    const e = engine();
    e.restore([], at);
    expect(() => open(e, { stop: 101 })).toThrow(/stop must be below/);
    expect(() => open(e, { side: 'short', stop: 102, target: 103 })).toThrow(/target must be below/);
    open(e);
    expect(() => open(e, { time: at + 50_000 })).toThrow(/already in symbol/);
    expect(() => open(engine())).toThrow(/not started/);
  });
});

describe('closing at the mark price', () => {
  const at = u('2026-07-15T10:30Z');
  const opened = () => {
    const e = engine();
    e.restore([entry(e, 'p1', '2026-07-15T10:00Z'), entry(e, 'p2', '2026-07-15T10:05Z', 'ETHUSDT')], at);
    return e;
  };

  it('a close with a price fills at once, at that price less slippage, without waiting for a candle', () => {
    const e = opened();
    const events = e.onCommand({ type: 'close', positionId: 'p1', price: 105, time: at + 20_000 });
    expect(events.map((x) => [x.type, x.payload.reason, x.time])).toEqual([['position_closed', 'manual', at + 20_000]]);
    expect(Number(events[0].payload.price)).toBeLessThan(105);   // slippage against a long being sold
    expect(e.positions().map((p) => p.id)).toEqual(['p2']);
    expect(e.closedTrades()[0]).toMatchObject({ id: 'p1', reason: 'manual' });
  });

  it('also finishes a close that was waiting for a candle that never came', () => {
    const e = opened();
    e.onCommand({ type: 'close', positionId: 'p1' });                 // the old way: waits for the next minute
    expect(e.positions().map((p) => p.id)).toContain('p1');
    const events = e.onCommand({ type: 'close', positionId: 'p1', price: 104, time: at + 30_000 });
    expect(events.map((x) => x.type)).toEqual(['position_closed']);
    expect(e.positions().map((p) => p.id)).toEqual(['p2']);
  });

  it('kill with prices closes every position at once; one without a price waits for its next candle', () => {
    const e = opened();
    const events = e.onCommand({ type: 'kill', reason: 'manual kill', prices: { BTCUSDT: 103 }, time: at + 10_000 });
    expect(events.filter((x) => x.type === 'position_closed').map((x) => x.positionId)).toEqual(['p1']);
    expect(events.filter((x) => x.type === 'order_placed').map((x) => x.positionId)).toEqual(['p2']);
    expect(e.account().halted).not.toBeNull();
  });
});
