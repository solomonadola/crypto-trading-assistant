import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { meanReversion, momentumContinuation, openingRangeBreakout } from '../src/strategy/alternatives';
import { series, type Context } from '../src/strategy/context';
import type { Candle } from '../../shared/types';
import type { TrendState } from '../src/analysis/trendState';

const cfg = loadConfig('engine/config/config.yaml');
const OPEN = Date.UTC(2026, 6, 15, 7, 0);    // London opens
const flat = (n: number, v: number) => new Array<number>(n).fill(v);

/** 15m candles ending at the last one's close; each [open, high, low, close]. */
function m15(bars: [number, number, number, number][], lastClose: number): Candle[] {
  return bars.map(([o, h, l, c], i) => {
    const closeTime = lastClose - (bars.length - 1 - i) * 900_000;
    return { symbol: 'SOLUSDT', tf: '15m', openTime: closeTime - 900_000, closeTime, open: o, high: h, low: l, close: c, volume: 100, quoteVolume: 100 * c, trades: 1 };
  });
}

function ctx(bars: [number, number, number, number][], t: number, over: Partial<Context> = {}, long: TrendState = 'none', short: TrendState = 'none'): Context {
  const s = series(m15(bars, t));
  const n = bars.length;
  return {
    symbol: 'SOLUSDT', t, config: cfg,
    analysis: { symbol: 'SOLUSDT', asOf: t, structure: { '4h': null, '1h': null, '15m': null }, ema4h: { fast: 1, slow: 1, close: 1 },
      long: { state: long, emaAligned: true, tradable: false }, short: { state: short, emaAligned: true, tradable: false }, zones: [],
      fvgs: [], profiles: [], trendMeter: { '4h': { structure: null, supertrend: null, line: null }, '1h': { structure: null, supertrend: null, line: null }, '15m': { structure: null, supertrend: null, line: null } }, adx1h: null },
    h4: series([]), h1: series([]), m15: s, price: bars[n - 1][3],
    atr1h: flat(n, 2), atr15m: flat(n, 1), ema1h: {}, ema15m20: flat(n, 100), vwap15m: flat(n, 100), rsi15m: flat(n, 50), rvol15m: flat(n, 1),
    adx1h: flat(n, 15), chop1h: flat(n, 50), bbw1h: flat(n, 0.02), pivots1h: [], pivots15m: [], pivots4h: [], btcChange1hPct: 0, btcAnalysis: null, funding: null,
    ...over,
  };
}

describe('opening-range breakout', () => {
  const session = { name: 'london', openTime: OPEN, closeTime: OPEN + 9 * 3_600_000, localDate: '2026-07-15' };
  const p = { rangeMinutes: 30, stopAt: 'opposite' as const, targetR: 2 };
  // Before the open, then the two range candles (high 101, low 99), then candles after.
  const before: [number, number, number, number][] = Array.from({ length: 10 }, () => [100, 100.2, 99.8, 100]);
  const range: [number, number, number, number][] = [[100, 101, 99.5, 100.5], [100.5, 100.8, 99, 100]];

  it('the first 15m close above the range goes long, stop at the far side, target 2R', () => {
    const t = OPEN + 4 * 900_000;
    const c = ctx([...before, ...range, [100, 100.9, 99.8, 100.6], [100.6, 101.6, 100.5, 101.5]], t);
    const s = openingRangeBreakout(c, session, p, false)!;
    expect(s).toMatchObject({ direction: 'long', stop: 99, level: 101 });
    expect(s.target).toBeCloseTo(101.5 + 2 * (101.5 - 99), 9);
    expect(openingRangeBreakout(c, session, { ...p, stopAt: 'mid' }, false)!.stop).toBe(100);
  });

  it('not before the range is complete, not a second time, not on a later close outside', () => {
    expect(openingRangeBreakout(ctx([...before, range[0], [100, 101.6, 100, 101.5]], OPEN + 2 * 900_000), session, p, false)).toBeNull();
    const t = OPEN + 4 * 900_000;
    const broke = ctx([...before, ...range, [100, 101.6, 100.5, 101.5], [101.5, 102.2, 101.4, 102]], t);
    expect(openingRangeBreakout(broke, session, p, false)).toBeNull();          // previous close was already outside
    expect(openingRangeBreakout(ctx([...before, ...range, [100, 100.9, 99.8, 100.6], [100.6, 101.6, 100.5, 101.5]], t), session, p, true)).toBeNull();
  });

  it('shorts on the first close below', () => {
    const c = ctx([...before, ...range, [100, 100.2, 99.2, 99.4], [99.4, 99.5, 98.4, 98.5]], OPEN + 4 * 900_000);
    expect(openingRangeBreakout(c, session, p, false)).toMatchObject({ direction: 'short', stop: 101, level: 99 });
  });
});

describe('momentum continuation', () => {
  const p = { lookback: 16, minRvol: 2, targetR: 2 };
  const base: [number, number, number, number][] = Array.from({ length: 20 }, () => [100, 100.5, 99.5, 100]);
  const breakout: [number, number, number, number] = [100, 101.2, 99.9, 101.1];

  it('needs all timeframes trending, a fresh break of the recent high, and volume', () => {
    const t = Date.UTC(2026, 6, 15, 10);
    const rv = flat(21, 1); rv[20] = 2.5;
    expect(momentumContinuation(ctx([...base, breakout], t, { rvol15m: rv }, 'strong'), p)).toMatchObject({ direction: 'long', level: 100.5 });
    expect(momentumContinuation(ctx([...base, breakout], t, { rvol15m: rv }, 'pullback'), p)).toBeNull();
    expect(momentumContinuation(ctx([...base, breakout], t, {}, 'strong'), p)).toBeNull();                // no volume
  });
});

describe('mean reversion', () => {
  const p = { bbPeriod: 20, bbStd: 2, maxAdx: 20, minR: 0.5 };
  const base: [number, number, number, number][] = Array.from({ length: 30 }, (_, i) => [100, 100.6, 99.4, i % 2 ? 100.3 : 99.7]);
  const t = Date.UTC(2026, 6, 15, 10);

  it('fades a wick below the lower band that closes back inside, target the middle band', () => {
    // Target (middle band, about 100) is only about 0.1R away (stop 97.8): allowed at minR 0.05, skipped at 0.5.
    const s = meanReversion(ctx([...base, [99.5, 99.9, 98, 99.8]], t), { ...p, minR: 0.05 })!;
    expect(s.direction).toBe('long');
    expect(s.stop).toBeCloseTo(98 - 0.2, 9);
    expect(s.target).toBeGreaterThan(99.8);
    expect(meanReversion(ctx([...base, [99.5, 99.9, 98, 99.8]], t), p)).toBeNull();
  });

  it('not in a trend, and not when the candle closes outside the band', () => {
    expect(meanReversion(ctx([...base, [99.5, 99.9, 98, 99.8]], t, { adx1h: flat(31, 30) }), p)).toBeNull();
    expect(meanReversion(ctx([...base, [99.5, 99.9, 98, 99.8]], t, {}, 'strong'), p)).toBeNull();
    expect(meanReversion(ctx([...base, [99.5, 99.6, 97.5, 98]], t), p)).toBeNull();
  });
});
