import { describe, expect, it } from 'vitest';
import { Engine, CommandError } from '../src/core/engine';
import { loadConfig, type EngineConfig } from '../src/config';
import type { EntryFill } from '../src/portfolio';
import type { Candle, TradeEvent } from '../../shared/types';

const u = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z';

function engine(over: (c: EngineConfig) => void = () => {}) {
  const config = loadConfig('engine/config/config.yaml');
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
    expect(e.positions()[0].pendingClose).toEqual({ reason: 'session_end', placedAt: u('2026-07-15T16:00Z') });
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
    expect(first.length).toBe(2);
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
    // The pending manual close is not replaced by a session-end close.
    expect(e.onCandles(minutes('2026-07-15T10:30Z', '2026-07-15T17:00Z'))).toEqual([]);
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
