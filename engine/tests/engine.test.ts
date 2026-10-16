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

  it('needs a take-profit at least min_rr (2R) away after costs: no 1:1 trades', () => {
    const e = engine();
    e.restore([], at);
    expect(() => open(e, { target: null })).toThrow(/take-profit is needed/);
    expect(() => open(e, { target: 102 })).toThrow(/at least 2R/);       // 1:1
    expect(() => open(e, { target: 104 })).toThrow(/at least 2R/);       // 2R before costs, under it after
    expect(open(e, { target: 104.5 }).map((x) => x.type)).toEqual(['order_placed', 'order_filled']);
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

describe('editing positions and live-price exits', () => {
  const at = u('2026-07-15T10:30Z');
  const open = (e: Engine, side: 'long' | 'short' = 'long') =>
    e.onCommand({ type: 'open', symbol: 'BTCUSDT', side, price: 100, time: at + 40_000, stop: side === 'long' ? 98 : 102, target: side === 'long' ? 106 : 94 });
  const started = (side: 'long' | 'short' = 'long') => {
    const e = engine((c) => { c.exits.mode = 'fixed'; });
    e.restore([], at);
    open(e, side);
    return { e, id: e.positions()[0].id };
  };

  it('moves the stop and take-profit, and the edit survives a restart', () => {
    const e = engine((c) => { c.exits.mode = 'fixed'; });
    e.restore([], at);
    const opened = open(e);
    const id = e.positions()[0].id;
    const events = e.onCommand({ type: 'modify', positionId: id, stop: 99, target: 110, price: 101 });
    expect(events.map((x) => [x.type, x.payload.stop ?? x.payload.target])).toEqual([['stop_moved', 99], ['target_moved', 110]]);
    expect(e.positions()[0]).toMatchObject({ stop: 99, target: 110 });
    const again = engine();
    again.restore([...opened, ...events], at + 60_000);
    expect(again.positions()[0]).toMatchObject({ stop: 99, target: 110 });
  });

  it('removes the take-profit with null, and leaves an unchanged level alone', () => {
    const { e, id } = started();
    const events = e.onCommand({ type: 'modify', positionId: id, target: null, price: 100 });
    expect(events.map((x) => x.type)).toEqual(['target_moved']);
    expect(e.positions()[0].target).toBeNull();
  });

  it('refuses a stop or take-profit on the wrong side of the price', () => {
    const { e, id } = started();
    expect(() => e.onCommand({ type: 'modify', positionId: id, stop: 101, price: 100 })).toThrow(/below the current price/);
    expect(() => e.onCommand({ type: 'modify', positionId: id, target: 99, price: 100 })).toThrow(/above the current price/);
    const short = started('short');
    expect(() => short.e.onCommand({ type: 'modify', positionId: short.id, stop: 99, price: 100 })).toThrow(/above the current price/);
    expect(() => e.onCommand({ type: 'modify', positionId: 'nope', stop: 90, price: 100 })).toThrow(CommandError);
  });

  it('closes at once when a live price reaches the stop, filled at that price (a gap), not the stop', () => {
    const { e } = started();
    expect(e.onCommand({ type: 'live_prices', prices: { BTCUSDT: 99 }, time: at + 50_000 })).toEqual([]);
    const closed = e.onCommand({ type: 'live_prices', prices: { BTCUSDT: 97 }, time: at + 55_000 });
    expect(closed.map((x) => [x.type, x.payload.reason, x.time])).toEqual([['position_closed', 'stop', at + 55_000]]);
    expect(Number(closed[0].payload.price)).toBeLessThan(97);   // the live price, slipped
    expect(e.positions()).toHaveLength(0);
    // The 1m candle that follows finds nothing left to close.
    expect(e.onCandles([{ symbol: 'BTCUSDT', tf: '1m', openTime: at + 60_000, closeTime: at + 120_000, open: 98, high: 98, low: 96, close: 97, volume: 1, quoteVolume: 1, trades: 1 }]).filter((x) => x.type === 'position_closed')).toEqual([]);
  });

  it('takes the take-profit at the target when a live price reaches it, for longs and shorts', () => {
    const { e } = started();
    const closed = e.onCommand({ type: 'live_prices', prices: { BTCUSDT: 106.5 }, time: at + 50_000 });
    expect(closed.map((x) => x.payload.reason)).toEqual(['target']);
    expect(Number(closed[0].payload.price)).toBeCloseTo(106 * (1 - 0.0005), 6);
    const short = started('short');
    expect(short.e.onCommand({ type: 'live_prices', prices: { BTCUSDT: 102.1 }, time: at + 50_000 }).map((x) => x.payload.reason)).toEqual(['stop']);
  });
});

describe('limit pullback orders', () => {
  const at = u('2026-07-15T10:30Z');
  const minute = (openTime: number, o: number, h: number, l: number, c: number): Candle =>
    ({ symbol: 'BTCUSDT', tf: '1m', openTime, closeTime: openTime + 59_999, open: o, high: h, low: l, close: c, volume: 1, quoteVolume: 100, trades: 1 });

  it('stays pending when market price is away from key level, then fills when price pulls back to key level', () => {
    const e = engine();
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);

    const placed = e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });
    expect(placed.map((x) => x.type)).toEqual(['order_placed']);
    expect(e.positions()).toHaveLength(0);
    expect(e.account().pendingEntries).toHaveLength(1);

    // Next candle low is 102 (no pullback to 100 yet) -> still pending
    const c1 = e.onCandles([minute(at, 105, 106, 102, 103)]);
    expect(c1.filter((x) => x.type === 'order_filled')).toHaveLength(0);
    expect(e.positions()).toHaveLength(0);

    // Next candle low is 99.8 (touches key level 100) -> fills at key level
    const c2 = e.onCandles([minute(at + 60_000, 103, 103.5, 99.8, 101)]);
    expect(c2.filter((x) => x.type === 'order_filled')).toHaveLength(1);
    expect(e.positions()).toHaveLength(1);
    expect(e.positions()[0].entryPrice).toBe(100);
  });

  it('a candle that runs through the limit and on through the stop fills it and stops it out: the loss is real', () => {
    const e = engine();
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
    e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });

    // Flash crash from 105 through the limit 100 and the stop 98 in one candle.
    const out = e.onCandles([minute(at, 105, 105, 96, 97)]);
    expect(out.map((x) => `${x.type} ${x.payload.reason ?? ''}`)).toEqual(['order_filled ', 'position_closed stop']);
    expect(e.positions()).toHaveLength(0);
    const [trade] = e.closedTrades();
    expect(trade).toMatchObject({ entryPrice: 100, reason: 'stop' });
    expect(trade.exitPrice).toBeLessThan(98);   // the stop, slipped
    expect(trade.pnl).toBeLessThan(0);
  });

  it('a limit that rested until price came to it pays the maker fee; one a candle opened through pays taker', () => {
    const filledFee = (open: number, low: number) => {
      const e = engine();
      e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
      e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });
      const fill = e.onCandles([minute(at, open, open + 0.5, low, open)]).find((x) => x.type === 'order_filled')!;
      const { qty, price } = fill.payload as { qty: number; price: number };
      return { price, ratePct: (Number(fill.payload.fee) / (qty * price)) * 100 };
    };
    // Opened at 103 above the limit and traded down to it: rested on the book, maker, at the limit's price.
    expect(filledFee(103, 99.8)).toEqual({ price: 100, ratePct: expect.closeTo(0.02, 9) });
    // Opened at 99.5, already through the limit: marketable at once, taker, at the open.
    expect(filledFee(99.5, 99.2)).toEqual({ price: 99.5, ratePct: expect.closeTo(0.05, 9) });
  });

  it('a scalp with a progress check is cut at the market when it has not been 0.5R our way by then', () => {
    const run = (peak: number) => {
      const e = engine();
      e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
      e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit', progressCheckMin: 30, progressMinR: 0.5 });
      e.onCandles([minute(at, 103, 103, 99.8, 100.2)]);   // fills at 100; risk 2, so 0.5R is 101
      expect(e.positions()).toHaveLength(1);
      const reasons: unknown[] = [];
      for (let k = 1; k <= 32; k++) {
        const high = k === 5 ? peak : 100.5;
        for (const ev of e.onCandles([minute(at + k * 60_000, 100.2, high, 99.9, 100.2)])) if (ev.type === 'order_placed' || ev.type === 'position_closed') reasons.push(ev.payload.reason);
      }
      return reasons;
    };
    // Never above 100.5 (0.25R): closed for no progress once 30 minutes have passed.
    expect(run(100.5)).toContain('no_progress');
    // Reached 101.2 (0.6R) at minute 5: it is working, so it is left alone.
    expect(run(101.2)).not.toContain('no_progress');
  });

  it("a scalp's take-profit rests on the book: filled at the target, maker, only once price trades through it", () => {
    const e = engine();
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
    e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 106, orderType: 'limit', setup: 'scalp' });
    e.onCandles([minute(at, 103, 103, 99.8, 100.2)]);   // fills at 100
    expect(e.positions()).toHaveLength(1);
    // Touching 106 is not enough: the order may sit behind others at that price.
    expect(e.onCandles([minute(at + 60_000, 100.2, 106, 100, 105.5)]).filter((x) => x.type === 'position_closed')).toHaveLength(0);
    const [closed] = e.onCandles([minute(at + 120_000, 105.5, 106.4, 105, 106.2)]).filter((x) => x.type === 'position_closed');
    const { price, qty, fee, reason } = closed.payload as { price: number; qty: number; fee: number; reason: string };
    expect(reason).toBe('target');
    expect(price).toBe(106);                                      // no slippage
    expect((fee / (qty * price)) * 100).toBeCloseTo(0.02, 9);     // the maker fee
  });

  it('a candle that opens beyond the stop never fills the limit', () => {
    const e = engine();
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
    e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });
    const out = e.onCandles([minute(at, 97, 97.5, 96, 97)]);
    expect(out.map((x) => `${x.type} ${x.payload.reason}`)).toEqual(['order_cancelled filled_beyond_stop']);
  });

  it('does not count the target in the candle that fills the limit: which came first is unknown', () => {
    const e = engine((c) => { c.exits.mode = 'fixed'; });
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
    e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 106, orderType: 'limit' });
    // Down to 99.5 and up to 107 in the same minute: filled, but not yet a win.
    const first = e.onCandles([minute(at, 104, 107, 99.5, 104)]);
    expect(first.map((x) => x.type)).toEqual(['order_filled']);
    // The next candle that reaches it takes it.
    const next = e.onCandles([minute(at + 60_000, 104, 106.5, 103, 106)]);
    expect(next.map((x) => `${x.type} ${x.payload.reason}`)).toEqual(['position_closed target']);
  });

  it('cancels if target is reached before pulling back to key level (target runaway)', () => {
    const e = engine();
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
    e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });

    // Candle flies to 111 without pulling back to 100 (low is 104)
    const out = e.onCandles([minute(at, 105, 111, 104, 110.5)]);
    expect(out.map((x) => `${x.type} ${x.payload.reason}`)).toEqual(['order_cancelled target_reached_before_fill']);
    expect(e.positions()).toHaveLength(0);
  });

  it('expires after 4 hours if price never pulls back to key level (a limit taken by hand)', () => {
    const e = engine();
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
    e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });

    // 4 hours + 1 minute later
    const futureTime = at + 4 * 3_600_000 + 60_000;
    const out = e.onCandles([minute(futureTime, 105, 106, 104, 105)]);
    expect(out.some((x) => x.type === 'order_cancelled' && x.payload.reason === 'timeout_missed_pullback')).toBe(true);
  });

  it('cancels a pending limit order manually', () => {
    const e = engine();
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
    const placed = e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });
    const orderId = placed[0].positionId!;
    expect(e.account().pendingEntries).toHaveLength(1);

    const cancelEvents = e.onCommand({ type: 'cancel', positionId: orderId });
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0].type).toBe('order_cancelled');
    expect(cancelEvents[0].payload.reason).toBe('manual_cancel');
    expect(e.account().pendingEntries).toHaveLength(0);
  });

  it('cancels a pending limit order via close command as well', () => {
    const e = engine();
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
    const placed = e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });
    const orderId = placed[0].positionId!;

    const closeEvents = e.onCommand({ type: 'close', positionId: orderId });
    expect(closeEvents).toHaveLength(1);
    expect(closeEvents[0].type).toBe('order_cancelled');
    expect(closeEvents[0].payload.reason).toBe('manual_cancel');
    expect(e.account().pendingEntries).toHaveLength(0);
  });

  it('edits a pending limit order levels and fills at the new levels', () => {
    const e = engine();
    e.onCandles([minute(at - 60_000, 104, 105.5, 103.8, 105)]);
    const placed = e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });
    const orderId = placed[0].positionId!;

    // Modify limit price to 101, stop to 99, target to 112
    const modEvents = e.onCommand({ type: 'modify_pending', positionId: orderId, entry: 101, stop: 99, target: 112, price: 105 });
    expect(modEvents.map((x) => x.type)).toEqual(['limit_moved', 'stop_moved', 'target_moved']);

    const pending = e.account().pendingEntries[0];
    expect(pending.price).toBe(101);
    expect(pending.stop).toBe(99);
    expect(pending.target).toBe(112);

    // Candle pulls back to 100.5 (below 101, so it fills)
    const fillEvents = e.onCandles([minute(at, 102, 103, 100.5, 102)]);
    expect(fillEvents.some((x) => x.type === 'order_filled')).toBe(true);
    const pos = e.positions()[0];
    expect(pos.entryPrice).toBe(101);
    expect(pos.stop).toBe(99);
    expect(pos.target).toBe(112);
  });
});

describe('limits the price is already through', () => {
  const at = u('2026-07-15T10:30Z');
  const ready = (close: number) => {
    const e = engine();
    e.onCandles([{ symbol: 'BTCUSDT', tf: '1m', openTime: at - 60_000, closeTime: at, open: close, high: close, low: close, close, volume: 1, quoteVolume: 100, trades: 1 }]);
    return e;
  };
  const limit = (e: Engine) => e.onCommand({ type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: at, stop: 98, target: 110, orderType: 'limit' });

  it('refuses a limit when the latest price is already past its stop, placing nothing', () => {
    const e = ready(97.5);
    expect(() => limit(e)).toThrow(/already below the stop 98/);
    expect(e.account().pendingEntries).toHaveLength(0);
    expect(e.positions()).toHaveLength(0);
  });

  it('fills a limit the price is already through at the latest price, not at the limit', () => {
    const e = ready(99);
    expect(limit(e).map((x) => x.type)).toEqual(['order_placed', 'order_filled']);
    expect(e.positions()[0].entryPrice).toBe(99);
  });
});

describe('scalp autopilot orders', () => {
  const at = u('2026-07-15T10:30Z');
  /** 1m candles closing every minute in (from, to], all at `price` with a 0.2-wide range. */
  const flat = (from: number, to: number, price: number): Candle[] => {
    const out: Candle[] = [];
    for (let close = from + 60_000; close <= to; close += 60_000) {
      out.push({ symbol: 'BTCUSDT', tf: '1m', openTime: close - 60_000, closeTime: close, open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 1, quoteVolume: 100, trades: 1 });
    }
    return out;
  };
  const ready = (price = 100, time = at, over: (c: EngineConfig) => void = () => {}) => {
    const e = engine(over);
    e.onCandles(flat(time - 120_000, time, price));
    return e;
  };
  const scalp = (e: Engine, over: Partial<Extract<Parameters<Engine['onCommand']>[0], { type: 'open' }>> = {}) => e.onCommand({
    type: 'open', symbol: 'BTCUSDT', side: 'long', price: 100, time: e.now(), stop: 98, target: 110, orderType: 'limit',
    note: 'Quant Autopilot [5m]: EMA20 pullback', setup: 'scalp', maxHoldMin: 120, entryTimeoutMin: 35, ...over,
  });
  const reasons = (events: TradeEvent[], type: string) => events.filter((x) => x.type === type).map((x) => `${x.payload.reason} ${iso(x.time)}`);

  it('is recorded as the scalp setup, with its max hold', () => {
    const e = ready();
    scalp(e);
    expect(e.positions()[0]).toMatchObject({ setup: 'scalp', maxHoldMin: 120 });
    expect(e.positions()[0].id).toBe(`scalp-BTCUSDT-${at}`);
  });

  it('closes at the market once held for its max hold, whatever its note says', () => {
    const e = ready();
    scalp(e, { note: 'edited by hand' });
    const out = e.onCandles(flat(at, at + 125 * 60_000, 100));
    expect(reasons(out, 'order_placed')).toEqual(['max_hold 2026-07-15T12:30Z']);
    expect(e.positions()).toHaveLength(0);
  });

  it('cancels a limit the price never comes back to after its entry timeout', () => {
    const e = ready(102);
    expect(scalp(e).map((x) => x.type)).toEqual(['order_placed']);
    const out = e.onCandles(flat(at, at + 40 * 60_000, 102));
    expect(reasons(out, 'order_cancelled')).toEqual(['timeout_missed_pullback 2026-07-15T11:06Z']);
  });

  it('refuses a stop wider than scalp_autopilot.max_stop_pct', () => {
    expect(() => scalp(ready(), { stop: 97 })).toThrow(/stop_too_wide/);
  });

  it('refuses a stop so tight the round-trip costs eat more than max_fee_drag_pct of the risk', () => {
    expect(() => scalp(ready(), { stop: 99.5 })).toThrow(/fees_too_high/);
    // The same trade by hand is the trader's call.
    expect(scalp(ready(), { stop: 99.5, setup: 'manual', maxHoldMin: undefined }).map((x) => x.type)).toEqual(['order_placed', 'order_filled']);
  });

  it('takes no new scalps at the weekend when sessions are weekdays only', () => {
    const saturday = u('2026-07-18T10:30Z');
    const e = ready(100, saturday, (c) => { c.sessions.weekdays_only = true; });
    expect(() => scalp(e)).toThrow(/session_weekend/);
  });

  it('still time-stops scalps logged before the max hold was a field, from their note', () => {
    const e = engine();
    const old = entry(e, 'old', '2026-07-15T10:30Z');
    (old.payload as Record<string, unknown>).note = 'Quant Autopilot [5m]: Sweep & reclaim';
    e.restore([old], at);
    const out = e.onCandles(flat(at, at + 125 * 60_000, 100));
    expect(reasons(out, 'order_placed')).toEqual(['max_hold 2026-07-15T12:30Z']);
  });

  it('leaves a trade by hand that merely mentions scalping to its usual exits', () => {
    const e = engine();
    const manual = entry(e, 'mine', '2026-07-15T10:30Z');
    (manual.payload as Record<string, unknown>).note = 'scalp idea, holding for the session';
    e.restore([manual], at);
    expect(reasons(e.onCandles(flat(at, at + 5 * 3_600_000, 100)), 'order_placed')).toEqual([]);
  });
});

describe('late 1m candles', () => {
  const at = u('2026-07-15T10:30Z');
  const candle = (symbol: string, close: number, low: number, price = 100): Candle =>
    ({ symbol, tf: '1m', openTime: close - 60_000, closeTime: close, open: price, high: price + 0.5, low, close: price, volume: 1, quoteVolume: 100, trades: 1 });

  it('settles a stop hit in a candle that arrived after the clock had moved on, at the stop and at its time', () => {
    const e = engine();
    e.restore([entry(e, 'p1', '2026-07-15T10:00Z', 'ETHUSDT')], at);
    // BTC's minutes come in; ETH's fetch fails twice, so the engine's clock passes ETH's missing minutes.
    e.onCandles([candle('BTCUSDT', at + 60_000, 99), candle('ETHUSDT', at + 60_000, 99.5)]);
    e.onCandles([candle('BTCUSDT', at + 120_000, 99)]);
    e.onCandles([candle('BTCUSDT', at + 180_000, 99)]);
    // ETH's 10:32 minute dipped to 97 through the stop 98, then recovered by 10:33.
    const out = e.onCandles([candle('ETHUSDT', at + 120_000, 97), candle('ETHUSDT', at + 180_000, 99.8), candle('BTCUSDT', at + 240_000, 99)]);
    const closed = out.filter((x) => x.type === 'position_closed');
    expect(closed.map((x) => [x.payload.reason, iso(x.time)])).toEqual([['stop', '2026-07-15T10:32Z']]);
    expect(Number(closed[0].payload.price)).toBeLessThanOrEqual(98);
    expect(e.positions()).toHaveLength(0);
  });

  it('settles each minute once, and never one before the position opened', () => {
    const e = engine();
    e.restore([entry(e, 'p1', '2026-07-15T10:30Z', 'ETHUSDT')], at);
    e.onCandles([candle('BTCUSDT', at + 120_000, 99), candle('ETHUSDT', at + 120_000, 99.5)]);
    // An ETH minute from before the entry that went through the stop: nothing to settle.
    expect(e.onCandles([candle('ETHUSDT', at - 60_000, 90)]).filter((x) => x.type === 'position_closed')).toEqual([]);
    // The minute already settled, handed on again: nothing either.
    expect(e.onCandles([candle('ETHUSDT', at + 120_000, 90)]).filter((x) => x.type === 'position_closed')).toEqual([]);
    expect(e.positions()).toHaveLength(1);
  });
});

describe('daily caps: the scalp autopilot has its own', () => {
  const at = u('2026-07-15T10:30Z');
  const symbols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((x) => `${x}USDT`);
  const flat = (symbol: string, close: number): Candle =>
    ({ symbol, tf: '1m', openTime: close - 60_000, closeTime: close, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1, quoteVolume: 1e9, trades: 1 });
  const ready = (over: (c: EngineConfig) => void) => {
    const e = engine((c) => { c.allocation.max_open_trades = null as unknown as number; c.allocation.max_open_risk_pct = null as unknown as number; c.allocation.max_total_exposure_pct = 100_000; over(c); });
    e.onCandles(symbols.map((s) => flat(s, at)));
    return e;
  };
  /** Opens and at once closes a trade on `symbol`, so only the daily count is left. */
  const trade = (e: Engine, symbol: string, setup: 'scalp' | 'manual', n: number) => {
    const opened = e.onCommand({ type: 'open', symbol, side: 'long', price: 100, time: at + n * 1000, stop: 98, target: 110, orderType: 'market', setup });
    e.onCommand({ type: 'close', positionId: opened[0].positionId!, price: 100, time: at + n * 1000 + 500 });
  };

  it('scalps do not use up the daily cap of the other trades, and stop at their own', () => {
    const e = ready((c) => { c.risk.max_trades_per_day = 2; c.scalp_autopilot.max_trades_per_day = 3; c.risk.cooldown_after_loss_min = 0; });
    trade(e, 'AUSDT', 'scalp', 1);
    trade(e, 'BUSDT', 'scalp', 2);
    trade(e, 'CUSDT', 'scalp', 3);
    expect(() => trade(e, 'DUSDT', 'scalp', 4)).toThrow(/max scalps per day/);
    // Three scalps today, and still both of the other trades.
    trade(e, 'EUSDT', 'manual', 5);
    trade(e, 'FUSDT', 'manual', 6);
    expect(() => trade(e, 'GUSDT', 'manual', 7)).toThrow(/max trades per day/);
  });
});

describe("the models' limit entries", () => {
  it('carry the configured fill timeout on the order', () => {
    const config = loadConfig('engine/config/config.yaml');
    expect(config.sim.limit_entry_timeout_min).toBe(30);
  });
});

describe('BTC flash crash circuit breaker', () => {
  it('triggers when BTC drops 1.5% in 5 minutes, cancelling alt long limits and blocking new longs', () => {
    const e = engine((c) => {
      c.risk.btc_circuit_breaker = {
        enabled: true,
        drop_5m_pct: -1.5,
        cooldown_min: 30,
        cancel_pending_limits: true,
      };
    });

    const start = u('2026-07-15T12:00Z');
    const initialBtc: Candle[] = [];
    const initialEth: Candle[] = [];
    for (let i = 0; i < 5; i++) {
      const close = start + i * 60_000;
      initialBtc.push({ symbol: 'BTCUSDT', tf: '1m', openTime: close - 60_000, closeTime: close, open: 100, high: 100, low: 100, close: 100, volume: 1, quoteVolume: 100, trades: 1 });
      initialEth.push({ symbol: 'ETHUSDT', tf: '1m', openTime: close - 60_000, closeTime: close, open: 10, high: 10, low: 10, close: 10, volume: 1, quoteVolume: 10, trades: 1 });
    }
    e.onCandles([...initialBtc, ...initialEth]);

    // Place a pending limit order on ETHUSDT (entry 9.5 below current price 10)
    const placed = e.onCommand({
      type: 'open',
      symbol: 'ETHUSDT',
      side: 'long',
      price: 9.5,
      time: start + 4 * 60_000,
      stop: 9.0,
      target: 11.0,
      orderType: 'limit',
      setup: 'manual',
    });
    expect(placed.map((x) => x.type)).toEqual(['order_placed']);
    expect(e.account().pendingEntries).toHaveLength(1);

    // Now BTC drops by 2.0% over the next 5 minutes (from 100 to 98)
    const dropClose = start + 5 * 60_000;
    const dropBtc: Candle = { symbol: 'BTCUSDT', tf: '1m', openTime: dropClose - 60_000, closeTime: dropClose, open: 100, high: 100, low: 97.9, close: 98, volume: 50, quoteVolume: 5000, trades: 10 };
    const dropEth: Candle = { symbol: 'ETHUSDT', tf: '1m', openTime: dropClose - 60_000, closeTime: dropClose, open: 10, high: 10, low: 9.9, close: 10, volume: 1, quoteVolume: 10, trades: 1 };

    const events = e.onCandles([dropBtc, dropEth]);
    const cancellations = events.filter((x) => x.type === 'order_cancelled');
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0].payload.reason).toBe('btc_circuit_breaker');
    expect(e.account().pendingEntries).toHaveLength(0);
    expect(e.isCircuitBreakerActive()).toBe(true);

    // Trying to open a new alt long is rejected
    expect(() => e.onCommand({
      type: 'open',
      symbol: 'ETHUSDT',
      side: 'long',
      price: 10,
      time: dropClose,
      stop: 9.5,
      target: 11.5,
      orderType: 'market',
      setup: 'manual',
    })).toThrow(/BTC circuit breaker active/);

    // After 30 minutes, circuit breaker expires
    const futureClose = dropClose + 31 * 60_000;
    e.onCandles([
      { symbol: 'BTCUSDT', tf: '1m', openTime: futureClose - 60_000, closeTime: futureClose, open: 98, high: 98, low: 98, close: 98, volume: 1, quoteVolume: 98, trades: 1 },
    ]);
    expect(e.isCircuitBreakerActive()).toBe(false);
  });

  it('blocks only altcoin longs among scalps, like every other entry path', () => {
    const e = engine((c) => {
      c.risk.btc_circuit_breaker = { enabled: true, drop_5m_pct: -1.5, cooldown_min: 30, cancel_pending_limits: true };
    });
    const start = u('2026-07-15T12:00Z');
    const bar = (symbol: string, close: number, price: number, low = price): Candle =>
      ({ symbol, tf: '1m', openTime: close - 60_000, closeTime: close, open: price, high: price, low, close: price, volume: 1, quoteVolume: price, trades: 1 });
    for (let i = 0; i < 5; i++) e.onCandles([bar('BTCUSDT', start + i * 60_000, 100), bar('ETHUSDT', start + i * 60_000, 10)]);
    const dropClose = start + 5 * 60_000;
    e.onCandles([bar('BTCUSDT', dropClose, 98, 97.9), bar('ETHUSDT', dropClose, 10)]);
    expect(e.isCircuitBreakerActive()).toBe(true);

    const scalp = (symbol: string, side: 'long' | 'short', price: number) => () => e.onCommand({
      type: 'open', symbol, side, price, time: dropClose, orderType: 'market', setup: 'scalp',
      stop: side === 'long' ? price * 0.99 : price * 1.01, target: side === 'long' ? price * 1.03 : price * 0.97,
    });
    // Other scalp checks may still refuse these; the circuit breaker must not be among the reasons.
    expect(scalp('ETHUSDT', 'long', 10)).toThrow(/circuit[ _]breaker/i);
    expect(scalp('ETHUSDT', 'short', 10)).not.toThrow(/circuit[ _]breaker/i);
    expect(scalp('BTCUSDT', 'short', 98)).not.toThrow(/circuit[ _]breaker/i);
  });
});

