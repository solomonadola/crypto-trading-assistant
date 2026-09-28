import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { clusterLevels, tradeIdea } from '../src/analysis/levels';
import { series, type Context } from '../src/strategy/context';
import type { Pivot } from '../src/analysis/indicators';
import type { Zone } from '../src/analysis/zones';
import type { TrendState } from '../src/analysis/trendState';
import type { Candle } from '../../shared/types';

const cfg = loadConfig('engine/config/config.yaml');
const T = Date.UTC(2026, 8, 28, 10, 0);
const flat = (n: number, v: number) => new Array<number>(n).fill(v);
const pivot = (type: 'high' | 'low', index: number, price: number): Pivot => ({ type, index, price, confirmedAt: index + 3 });
const candle = (i: number, o: number, h: number, l: number, c: number, tf: Candle['tf']): Candle => {
  const ms = tf === '15m' ? 900_000 : 3_600_000;
  const closeTime = T - (59 - i) * ms;
  return { symbol: 'SOLUSDT', tf, openTime: closeTime - ms, closeTime, open: o, high: h, low: l, close: c, volume: 100, quoteVolume: 100 * c, trades: 1 };
};
const state = (s: string) => ({ state: s as TrendState, emaAligned: true, tradable: s === 'strong' || s === 'pullback' });
const zone = (over: Partial<Zone>): Zone => ({
  id: 'z', symbol: 'SOLUSDT', tf: '1h', type: 'demand', low: 96, high: 97, baseStart: 0, createdAt: 0,
  impulseStrength: 2, touches: 0, status: 'fresh', invalidatedAt: null, score: 2, ...over,
});

/**
 * Price 100, 1h ATR 2 (merge tolerance 1). 1h candles all today (no previous
 * day range), VWAP and EMAs far away unless a test places them.
 */
function ctx(over: Partial<Context> = {}, long = 'pullback', short = 'reversed'): Context {
  const today = (i: number) => ({ ...candle(i, 100, 100.5, 99.5, 100, '1h'), openTime: T - 3_600_000 + i, closeTime: T + i });
  return {
    symbol: 'SOLUSDT', t: T, config: cfg,
    analysis: { symbol: 'SOLUSDT', asOf: T, structure: { '4h': null, '1h': null, '15m': null }, ema4h: { fast: 90, slow: 80, close: 100 }, long: state(long), short: state(short), zones: [] },
    h4: series([]), h1: series(Array.from({ length: 60 }, (_, i) => today(i))), m15: series(Array.from({ length: 60 }, (_, i) => candle(i, 100, 100.5, 99.5, 100, '15m'))),
    price: 100, atr1h: flat(60, 2), atr15m: flat(60, 1),
    ema1h: { 20: flat(60, 300), 50: flat(60, 300) }, ema15m20: flat(60, 100), vwap15m: flat(60, 300),
    rsi15m: flat(60, 50), rvol15m: flat(60, 1), adx1h: flat(60, 30), chop1h: flat(60, 40), bbw1h: flat(60, 0.02),
    pivots1h: [], pivots15m: [], pivots4h: [], btcChange1hPct: 0, btcAnalysis: null, funding: null,
    ...over,
  };
}

describe('key levels', () => {
  it('merges levels within the tolerance and sums their weight', () => {
    const c = clusterLevels([
      { price: 95, source: 'a', weight: 1 }, { price: 95.8, source: 'b', weight: 1 }, { price: 99, source: 'c', weight: 2 }, { price: 110, source: 'd', weight: 1 },
    ], 100, 1);
    expect(c.map((l) => [Number(l.price.toFixed(2)), l.sources, l.strength, l.kind])).toEqual([
      [95.4, ['a', 'b'], 2, 'support'], [99, ['c'], 2, 'support'], [110, ['d'], 1, 'resistance'],
    ]);
  });
});

describe('trade plan', () => {
  // A fresh demand zone 96-97 under a 1h swing low at 96.2, resistance clusters at 104 and 108.
  const longCtx = () => {
    const c = ctx({ pivots1h: [pivot('low', 30, 96.2), pivot('high', 40, 104), pivot('high', 50, 108)], vwap15m: flat(60, 104.3) });
    c.analysis.zones = [zone({})];
    return c;
  };

  it('long: enters from the strongest support below, stop beyond it, targets at resistance with R after costs', () => {
    const idea = tradeIdea(longCtx(), []);
    expect(idea.bias).toBe('long');
    const p = idea.plan!;
    expect(p.status).toBe('wait');
    // Zone 96-97 plus the swing low at 96.2 merge; the area widens by half the tolerance each side.
    expect(p.entryLow).toBeCloseTo(95.5, 9);
    expect(p.entryHigh).toBeCloseTo(97.5, 9);
    expect(p.entry).toBeCloseTo(96.5, 9);
    expect(p.stop).toBeCloseTo(95.5 - cfg.exits.stop_buffer_atr * 2, 9);
    expect(p.targets.map((t) => Number(t.price.toFixed(2)))).toEqual([104.15, 108]);   // swing high 104 and VWAP 104.3, equal weight
    const risk = 96.5 - p.stop!;
    const costR = (0.2 / 100) * 96.5 / risk;
    expect(p.targets[1].r).toBeCloseTo((108 - 96.5) / risk - costR, 9);
    expect(p.targets[0].sources).toEqual(['1h swing high', 'daily VWAP']);
  });

  it('in the entry area when price is inside it; armed when the engine armed that side', () => {
    const c = longCtx();
    c.price = 97;
    expect(tradeIdea(c, []).plan!.status).toBe('in_zone');
    expect(tradeIdea(c, ['long']).plan!.status).toBe('armed');
    expect(tradeIdea(c, ['short']).plan!.status).toBe('in_zone');
  });

  it('short mirrors long', () => {
    const c = ctx({ pivots1h: [pivot('high', 30, 103.8), pivot('low', 40, 96), pivot('low', 50, 92)] }, 'reversed', 'pullback');
    c.analysis.zones = [zone({ type: 'supply', low: 103, high: 104 })];
    const p = tradeIdea(c, []).plan!;
    expect(p.direction).toBe('short');
    expect(p.entryLow).toBeCloseTo(102.5, 9);
    expect(p.entryHigh).toBeCloseTo(104.5, 9);
    expect(p.stop).toBeCloseTo(104.5 + cfg.exits.stop_buffer_atr * 2, 9);
    expect(p.targets.map((t) => t.price)).toEqual([96, 92]);
  });

  it('a short never enters from a demand zone, even with price inside it', () => {
    // Price 100 inside a demand zone 99-101; resistance from a 1h swing high at 104.
    const c = ctx({ pivots1h: [pivot('low', 40, 92), pivot('high', 50, 104)] }, 'reversed', 'pullback');
    c.analysis.zones = [zone({ type: 'demand', low: 99, high: 101 })];
    const p = tradeIdea(c, []).plan!;
    expect(p.entryLow).toBeCloseTo(103.5, 9);
    expect(p.status).toBe('wait');
  });

  it('no plan without a trend; no_level when nothing is in reach', () => {
    expect(tradeIdea(ctx({}, 'none', 'none'), [])).toMatchObject({ bias: 'none', plan: null });
    const far = ctx({ pivots1h: [pivot('low', 30, 80), pivot('high', 40, 104)] });
    expect(tradeIdea(far, []).plan).toMatchObject({ status: 'no_level', entry: null });
  });

  it('fibonacci, EMA and VWAP levels alone are never targets', () => {
    const c = longCtx();
    c.ema1h = { 20: flat(60, 101.5), 50: flat(60, 300) };
    const targets = tradeIdea(c, []).plan!.targets;
    expect(targets.every((t) => t.sources.some((s) => !/^fib |EMA|VWAP/.test(s)))).toBe(true);
  });

  it('says when the plan breaks the engine\'s limits', () => {
    const fits = tradeIdea(longCtx(), []).plan!;
    expect(fits.meetsRules).toBe(true);                     // 1.66% stop, first target 4.7R
    const c = longCtx();
    c.pivots1h = [...c.pivots1h, pivot('high', 55, 98.5)];  // resistance 1.25R above the entry
    const tight = tradeIdea(c, []).plan!;
    expect(tight.meetsRules).toBe(false);
    expect(tight.note).toMatch(/under the 2R minimum/);
  });
});
