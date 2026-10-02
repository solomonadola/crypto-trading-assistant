import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { dealingRange, liquidityLevels, zoneAllows } from '../src/analysis/liquidity';
import { series, type Context } from '../src/strategy/context';
import type { Pivot } from '../src/analysis/indicators';
import type { Candle } from '../../shared/types';

const cfg = loadConfig('engine/config/config.yaml');
const u = (iso: string) => Date.parse(iso);
const H = 3_600_000;
const T = u('2026-07-15T12:00Z');   // summer: London 07:00-11:00 local = 06:00-10:00 UTC

/** 15m candles from 2026-07-14 00:00 to T, flat at 100 except the given highs and lows (by open time). */
function m15(marks: Record<string, { high?: number; low?: number }>): Candle[] {
  const out: Candle[] = [];
  for (let open = u('2026-07-14T00:00Z'); open + 900_000 <= T; open += 900_000) {
    const m = marks[new Date(open).toISOString().slice(0, 16) + 'Z'] ?? {};
    out.push({ symbol: 'SOLUSDT', tf: '15m', openTime: open, closeTime: open + 900_000, open: 100, high: m.high ?? 100.5, low: m.low ?? 99.5, close: 100, volume: 1, quoteVolume: 100, trades: 1 });
  }
  return out;
}

const hourly = (n: number, tf: Candle['tf'], ms: number): Candle[] => Array.from({ length: n }, (_, i) => {
  const closeTime = T - (n - 1 - i) * ms;
  return { symbol: 'SOLUSDT', tf, openTime: closeTime - ms, closeTime, open: 100, high: 101, low: 99, close: 100, volume: 1, quoteVolume: 100, trades: 1 };
});

function ctx(over: Partial<Context> = {}): Context {
  return {
    symbol: 'SOLUSDT', t: T, config: cfg, price: 100,
    m15: series(m15({})), h1: series(hourly(48, '1h', H)), h4: series(hourly(30, '4h', 4 * H)),
    atr1h: [2], pivots1h: [], pivots4h: [],
    ...over,
  } as unknown as Context;
}

const pivot = (type: 'high' | 'low', index: number, price: number): Pivot => ({ type, index, price, confirmedAt: index + 3 });
const level = (c: Context, name: string) => liquidityLevels(c).find((l) => l.name === name);

describe('liquidity levels', () => {
  const chart = m15({
    '2026-07-14T05:00Z': { high: 110 }, '2026-07-14T20:00Z': { low: 90 },       // yesterday: PDH 110, PDL 90
    '2026-07-15T03:00Z': { high: 105 }, '2026-07-15T02:00Z': { low: 98 },       // Asian range 105 / 98
    '2026-07-15T08:30Z': { high: 106 }, '2026-07-15T09:00Z': { low: 97 },       // London range 106 / 97, sweeping the Asian range
    '2026-07-15T11:00Z': { low: 96.5 },                                         // after London: under the London low
  });
  const c = ctx({ m15: series(chart) });

  it('previous day, Asian and London ranges, each with when it formed', () => {
    expect(level(c, 'PDH')).toMatchObject({ side: 'buy', price: 110, formedAt: u('2026-07-15T00:00Z'), brokenAt: null });
    expect(level(c, 'PDL')).toMatchObject({ side: 'sell', price: 90, brokenAt: null });
    expect(level(c, 'asian_high')).toMatchObject({ price: 105, formedAt: u('2026-07-15T08:00Z') });
    expect(level(c, 'asian_low')).toMatchObject({ price: 98 });
    expect(level(c, 'london_high')).toMatchObject({ price: 106, formedAt: u('2026-07-15T10:00Z'), brokenAt: null });
    expect(level(c, 'london_low')).toMatchObject({ price: 97 });
  });

  it('records the first 15m candle that traded through each level', () => {
    expect(level(c, 'asian_high')!.brokenAt).toBe(u('2026-07-15T08:45Z'));
    expect(level(c, 'asian_low')!.brokenAt).toBe(u('2026-07-15T09:15Z'));
    expect(level(c, 'london_low')!.brokenAt).toBe(u('2026-07-15T11:15Z'));
  });

  it('no Asian range before 08:00 UTC, no London range before 11:00 London time', () => {
    const early = ctx({ t: u('2026-07-15T07:00Z'), m15: series(chart.filter((x) => x.closeTime <= u('2026-07-15T07:00Z'))) });
    expect(level(early, 'asian_high')).toBeUndefined();
    expect(level(early, 'london_high')).toBeUndefined();
    expect(level(early, 'PDH')).toBeDefined();
  });

  it('equal highs: two 1h swings within 0.1 x ATR, the higher of them', () => {
    const eq = ctx({ pivots1h: [pivot('high', 30, 104), pivot('high', 40, 104.15), pivot('high', 20, 103)] });
    expect(level(eq, 'EQH')).toMatchObject({ price: 104.15, formedAt: T - 4 * H });
    expect(level(ctx({ pivots1h: [pivot('high', 30, 104), pivot('high', 40, 104.5)] }), 'EQH')).toBeUndefined();   // 0.5 apart: not equal
  });
});

describe('premium and discount', () => {
  const ranged = (price: number) => ctx({ price, pivots4h: [pivot('high', 10, 120), pivot('low', 15, 80)] });

  it('the 4h dealing range between the last swing high and low', () => {
    expect(dealingRange(ranged(90))).toEqual({ high: 120, low: 80, position: 0.25 });
    expect(dealingRange(ctx())).toBeNull();
  });

  it('longs in discount (<= 0.48), shorts in premium (>= 0.52), nothing at equilibrium', () => {
    expect(zoneAllows(dealingRange(ranged(90)), 'long')).toBe(true);
    expect(zoneAllows(dealingRange(ranged(90)), 'short')).toBe(false);
    expect(zoneAllows(dealingRange(ranged(100)), 'long')).toBe(false);
    expect(zoneAllows(dealingRange(ranged(100)), 'short')).toBe(false);
    expect(zoneAllows(dealingRange(ranged(115)), 'short')).toBe(true);
    expect(zoneAllows(null, 'long')).toBe(false);
  });
});
