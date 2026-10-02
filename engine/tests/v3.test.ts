// Strategy v3 foundations (ENGINE_PLAN.md Section 18): speed groups, risk
// sizing, the wild-coin limit and trade management. Uses the shipped config.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { decideEntry, type RiskInput } from '../src/risk';
import { Portfolio, type EntryFill } from '../src/portfolio';
import { manage } from '../src/exits';
import { speedOf } from '../src/speed';
import { summarize } from '../src/stats';
import { series, type Context } from '../src/strategy/context';
import type { Pivot } from '../src/analysis/indicators';
import type { Candle, TradeEvent } from '../../shared/types';

const cfg = loadConfig('engine/config/config.yaml');
const u = (iso: string) => Date.parse(iso);
const flat = (n: number, v: number) => new Array<number>(n).fill(v);
const ev = (time: number, type: TradeEvent['type'], positionId: string, symbol: string, payload: Record<string, unknown>): TradeEvent =>
  ({ time, type, positionId, symbol, payload, engineVersion: 't', configHash: 't' });

describe('speed groups', () => {
  it('calm under 1% 1h ATR, wild over 2.5%, normal between and when unknown', () => {
    expect(speedOf(0.6, cfg.speed)).toBe('calm');
    expect(speedOf(1.0, cfg.speed)).toBe('normal');
    expect(speedOf(2.5, cfg.speed)).toBe('normal');
    expect(speedOf(2.6, cfg.speed)).toBe('wild');
    expect(speedOf(NaN, cfg.speed)).toBe('normal');
    expect(speedOf(null, cfg.speed)).toBe('normal');
  });
});

describe('risk sizing', () => {
  const base = (over: Partial<RiskInput> = {}): RiskInput => ({
    config: cfg, t: u('2026-07-15T10:00Z'), symbol: 'SOLUSDT', side: 'long', entry: 100, stop: 96,
    portfolio: new Portfolio(1000), priceOf: () => 100, dayStartEquity: 1000, lastHourVolume: null, rules: null, score: 5, ...over,
  });

  it('the loss at the stop, with costs, is the group\'s risk: 1% normal, 0.5% wild', () => {
    // Normal: 4% stop + 0.2% round-trip costs; $10 at risk -> $10 / 4.2% = $238.10.
    const normal = decideEntry(base({ speed: 'normal' }));
    expect(normal.ok).toBe(true);
    expect(normal.notional).toBeCloseTo((10 / 4.2) * 100, 6);
    // Wild: 0.15% slippage each side -> 0.4% costs; $5 at risk -> $5 / 4.4% = $113.64.
    expect(decideEntry(base({ speed: 'wild' })).notional).toBeCloseTo((5 / 4.4) * 100, 6);
  });

  it('at most two wild trades open', () => {
    const p = new Portfolio(1000);
    const fill = (id: string, symbol: string): TradeEvent =>
      ev(u('2026-07-15T09:00Z'), 'order_filled', id, symbol, { role: 'entry', side: 'long', qty: 0.1, price: 100, stop: 96, session: null, speed: 'wild' } satisfies EntryFill);
    p.apply(fill('a', 'PEPEUSDT'));
    expect(decideEntry(base({ portfolio: p, speed: 'wild' })).ok).toBe(true);
    p.apply(fill('b', 'WIFUSDT'));
    expect(decideEntry(base({ portfolio: p, speed: 'wild' }))).toMatchObject({ ok: false, reason: 'risk_max_speed_group' });
    expect(decideEntry(base({ portfolio: p, speed: 'normal' })).ok).toBe(true);   // other groups are not limited
  });
});

describe('v3 trade management', () => {
  const T0 = u('2026-07-15T10:00Z');
  const pos = (over = {}) => ({
    id: 'p', symbol: 'SOLUSDT', side: 'long' as const, qty: 1, initialQty: 1, entryPrice: 100, stop: 96, initialStop: 96, target: 110,
    openedAt: T0, session: null, leverage: 3, liqPrice: 70, chochLevel: null, signalId: null, speed: 'normal' as const, setup: null,
    ladderStep: -1, partialDone: false, fees: 0, funding: 0, realized: 0, pendingClose: null, ...over,
  });
  /** 15m candles: 30 before the entry, then `after` since; the last closes at `price`. */
  const ctx = (price: number, t: number, pivots15m: Pivot[] = []): Context => {
    const bars: Candle[] = Array.from({ length: 40 }, (_, i) => {
      const openTime = T0 + (i - 30) * 900_000;
      const c = i === 39 ? price : 100;
      return { symbol: 'SOLUSDT', tf: '15m', openTime, closeTime: openTime + 900_000, open: 100, high: Math.max(c, 100) + 0.1, low: 99.9, close: c, volume: 1, quoteVolume: 100, trades: 1 };
    });
    return {
      symbol: 'SOLUSDT', t, config: cfg,
      analysis: { symbol: 'SOLUSDT', asOf: 0, structure: { '4h': null, '1h': null, '15m': null }, ema4h: { fast: 1, slow: 1, close: 1 },
        long: { state: 'none', emaAligned: false, tradable: false }, short: { state: 'strong', emaAligned: true, tradable: true }, zones: [], fvgs: [], profiles: [], trendMeter: { '4h': { structure: null, supertrend: null, line: null }, '1h': { structure: null, supertrend: null, line: null }, '15m': { structure: null, supertrend: null, line: null } }, adx1h: null },
      h4: series([]), h1: series([]), m15: series(bars), price, atr1h: flat(40, 2), atr15m: flat(40, 0.5), ema1h: {}, ema15m20: flat(40, 100), vwap15m: flat(40, 100),
      rsi15m: flat(40, 50), rvol15m: flat(40, 0.1), adx1h: flat(40, 30), chop1h: flat(40, 40), bbw1h: flat(40, 0.02), pivots1h: [], pivots15m, pivots4h: [],
      btcChange1hPct: -5, btcAnalysis: null, funding: null,
    };
  };
  const swingHigh = (index: number, price: number): Pivot => ({ type: 'high', index, price, confirmedAt: index + 3 });

  it('nothing but the max hold and break-even: a reversed trend, low volume and BTC falling do not close it', () => {
    expect(manage({ ctx: ctx(100.5, T0 + 10 * 3_600_000), pos: pos(), peakPct: 0.5, candlesSinceEntry: 40 })).toEqual([]);
  });

  it('closes at the group\'s max hold: 48 h normal, 24 h wild', () => {
    expect(manage({ ctx: ctx(101, T0 + 48 * 3_600_000), pos: pos(), peakPct: 1, candlesSinceEntry: 192 })).toEqual([{ type: 'close', reason: 'max_hold' }]);
    expect(manage({ ctx: ctx(101, T0 + 47 * 3_600_000), pos: pos(), peakPct: 1, candlesSinceEntry: 188 })).toEqual([]);
    expect(manage({ ctx: ctx(101, T0 + 24 * 3_600_000), pos: pos({ speed: 'wild' }), peakPct: 1, candlesSinceEntry: 96 })).toEqual([{ type: 'close', reason: 'max_hold' }]);
  });

  it('break-even plus costs after a close through a swing high formed since the entry; once only', () => {
    const at = T0 + 3 * 3_600_000;
    // Index 34 opened after the entry (index 30 is the entry candle): a new swing high at 101; the last close 101.5 breaks it.
    expect(manage({ ctx: ctx(101.5, at, [swingHigh(34, 101)]), pos: pos(), peakPct: 1.5, candlesSinceEntry: 12 }))
      .toEqual([{ type: 'stop', stop: expect.closeTo(100 * (1 + cfg.exits.breakeven_fee_buffer_pct / 100), 9), reason: 'break-even after a new 15m BOS' }]);
    // Not yet through it, or a swing from before the entry: nothing.
    expect(manage({ ctx: ctx(100.8, at, [swingHigh(34, 101)]), pos: pos(), peakPct: 1, candlesSinceEntry: 12 })).toEqual([]);
    expect(manage({ ctx: ctx(101.5, at, [swingHigh(25, 101)]), pos: pos(), peakPct: 1.5, candlesSinceEntry: 12 })).toEqual([]);
    // Already at break-even: no second move.
    expect(manage({ ctx: ctx(101.5, at, [swingHigh(34, 101)]), pos: pos({ stop: 100.2 }), peakPct: 1.5, candlesSinceEntry: 12 })).toEqual([]);
  });
});

describe('results per model and speed group', () => {
  it('counts trades, wins, win rate and average R, overall and per group', () => {
    const r = summarize([
      { setup: 'zone_sweep', speed: 'normal', r: 2 },
      { setup: 'zone_sweep', speed: 'wild', r: -1 },
      { setup: 'session_sweep', speed: 'normal', r: 3 },
      { setup: 'session_sweep', speed: 'normal', r: -1 },
    ]);
    expect(r.all).toEqual({ key: 'all', trades: 4, wins: 2, winRate: 0.5, avgR: 0.75, totalR: 3 });
    expect(r.byModel.map((x) => [x.key, x.trades, x.avgR])).toEqual([['session_sweep', 2, 1], ['zone_sweep', 2, 0.5]]);
    expect(r.bySpeed.map((x) => [x.key, x.trades, x.wins])).toEqual([['normal', 3, 2], ['wild', 1, 0]]);
    expect(summarize([]).all).toEqual({ key: 'all', trades: 0, wins: 0, winRate: 0, avgR: 0, totalR: 0 });
  });
});
