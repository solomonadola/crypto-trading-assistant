import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { armZoneSweep, confirmZoneSweep } from '../src/strategy/zoneSweep';
import { orderBlocks } from '../src/strategy/smc';
import { series, type Context } from '../src/strategy/context';
import type { Armed } from '../src/strategy/pullback';
import type { Pivot } from '../src/analysis/indicators';
import type { Zone } from '../src/analysis/zones';
import type { Candle } from '../../shared/types';

const cfg = loadConfig('engine/config/config.yaml');
const H = 3_600_000;
const Q = 900_000;
const T = Date.UTC(2026, 6, 15, 9, 0);
const pivot = (type: 'high' | 'low', index: number, price: number): Pivot => ({ type, index, price, confirmedAt: index + 3 });
const candle = (tf: Candle['tf'], closeTime: number, ms: number, o: number, h: number, l: number, c: number): Candle =>
  ({ symbol: 'SOLUSDT', tf, openTime: closeTime - ms, closeTime, open: o, high: h, low: l, close: c, volume: 1, quoteVolume: 100, trades: 1 });

describe('1h order blocks', () => {
  // Flat at 100, a swing high at 102 (index 10), then at 20 a bearish candle and at 21 a bullish one closing
  // through 102, leaving a gap between 20's high and 22's low.
  function h1(over: Record<number, [number, number, number, number]> = {}): Candle[] {
    return Array.from({ length: 40 }, (_, i) => {
      const [o, h, l, c] = over[i] ?? (i > 21 ? [103.5, 104, 103, 103.5] : [100, 100.5, 99.5, 100]);
      return candle('1h', T - (39 - i) * H, H, o, h, l, c);
    });
  }
  const shape = { 10: [100, 102, 99.5, 100] as [number, number, number, number], 20: [100.5, 100.6, 99.2, 99.5] as [number, number, number, number], 21: [99.5, 103.2, 99.4, 103] as [number, number, number, number] };
  const pivots = [pivot('high', 10, 102)];

  it('the last bearish candle before a break of structure that left a gap, while untouched', () => {
    expect(orderBlocks(h1(shape), pivots, 'long')).toEqual([
      expect.objectContaining({ side: 'bullish', low: 99.2, high: 100.6, createdAt: T - 17 * H }),
    ]);
  });

  it('none once price traded back into it, without a gap, or without a break of structure', () => {
    expect(orderBlocks(h1({ ...shape, 30: [103, 103.2, 100.5, 101] }), pivots, 'long')).toEqual([]);
    expect(orderBlocks(h1({ ...shape, 22: [103, 103.5, 100.4, 103.2] }), pivots, 'long')).toEqual([]);   // 22's low (100.4) under 20's high (100.6): no gap
    expect(orderBlocks(h1({ ...shape, 21: [99.5, 101.8, 99.4, 101.7] }), pivots, 'long')).toEqual([]);   // closed under 102
  });
});

describe('Model 1: sweep + CHoCH at a zone', () => {
  const zone: Zone = { id: 'z1', symbol: 'SOLUSDT', tf: '1h', type: 'demand', low: 97, high: 98, baseStart: 0, createdAt: 0, impulseStrength: 2, touches: 0, status: 'fresh', invalidatedAt: null, score: 2 };
  const h1 = Array.from({ length: 260 }, (_, i) => { const c = 80 + (20 * i) / 259; return candle('1h', T - (259 - i) * H, H, c, c + 0.3, c - 0.3, c); });
  const h4 = Array.from({ length: 30 }, (_, i) => candle('4h', T - (29 - i) * 4 * H, 4 * H, 100, 101, 99, 100));

  /** 60 15m candles ending at T: flat at 100, then the given ones by index. */
  function ctx(marks: Record<number, [number, number, number, number]>, over: Partial<Context> = {}): Context {
    const m15 = Array.from({ length: 60 }, (_, i) => {
      const [o, h, l, c] = marks[i] ?? [100, 100.3, 99.7, 100];
      return candle('15m', T - (59 - i) * Q, Q, o, h, l, c);
    });
    return {
      symbol: 'SOLUSDT', t: T, config: cfg, price: m15[59].close, speed: 'normal', funding: null,
      m15: series(m15), h1: series(h1), h4: series(h4), atr15m: [1], atr1h: [2], pivots1h: [], pivots15m: [],
      pivots4h: [pivot('high', 10, 120), pivot('low', 15, 90)],
      analysis: { structure: { '4h': null }, zones: [zone], profiles: [] },
      ...over,
    } as unknown as Context;
  }

  it('arms when the 15m candle trades into the demand zone, in an uptrend and in discount', () => {
    const a = armZoneSweep(ctx({ 59: [99, 99.1, 97.8, 98.3] }), 'long')!;
    expect(a).toMatchObject({ direction: 'long', armedAt: T, zone: { id: 'z1' } });
    expect(a.factors.map((f) => f.name)).toEqual(['zone']);
    // The area: the zone widened by 0.5 x ATR(1h) = 1 each side.
    expect([a.areaLow, a.areaHigh]).toEqual([96, 99]);
  });

  it('does not arm away from the zone, in premium, or against the trend', () => {
    expect(armZoneSweep(ctx({ 59: [100, 100.3, 99.7, 100] }), 'long')).toBeNull();
    expect(armZoneSweep(ctx({ 59: [99, 99.1, 97.8, 98.3] }, { pivots4h: [pivot('high', 10, 99), pivot('low', 15, 90)] }), 'long')).toBeNull();
    expect(armZoneSweep(ctx({ 59: [99, 99.1, 97.8, 98.3] }), 'short')).toBeNull();
  });

  // Armed at the close of candle 50; then a CHoCH on candle 59.
  const armed: Armed = {
    id: 'a1', symbol: 'SOLUSDT', direction: 'long', armedAt: T - 9 * Q, expiresAt: T + 6 * H, price: 98.3,
    factors: [{ name: 'zone', level: 98, detail: '' }], zone, areaLow: 96, areaHigh: 99,
  };
  const chart: Record<number, [number, number, number, number]> = {
    50: [99, 99.1, 97.8, 98.3],      // the tap: low 97.8
    58: [98.7, 99, 98.5, 98.6],
    59: [98.6, 100.1, 98.5, 100],    // closes above the lower high at 99.8 on a displacement candle
  };
  const highs = [pivot('high', 40, 100.5), pivot('high', 53, 99.8)];

  it('confirms on the CHoCH with a displacement candle, the inducement having been swept', () => {
    // The inducement: a 15m swing low at 99.2, above the area, formed before arming.
    const c = confirmZoneSweep(ctx(chart, { pivots15m: [...highs, pivot('low', 45, 99.2)] }), armed, [])!;
    expect(c).toEqual({ level: 99.8, sweep: 'inducement', extreme: 97.8 });
  });

  it('reports no sweep when nothing was taken (the engine then skips it)', () => {
    expect(confirmZoneSweep(ctx(chart, { pivots15m: highs }), armed, [])).toEqual({ level: 99.8, sweep: null, extreme: 97.8 });
  });

  it('a wick through the zone counts as the sweep', () => {
    const wick = { ...chart, 52: [98.5, 98.6, 96.8, 97.5] as [number, number, number, number] };   // under 97, closed back above
    expect(confirmZoneSweep(ctx(wick, { pivots15m: highs }), armed, [])).toMatchObject({ sweep: 'zone_wick', extreme: 96.8 });
  });

  it('no confirmation without the displacement candle', () => {
    const weak = { ...chart, 59: [99.7, 100, 99.6, 99.9] as [number, number, number, number] };   // closes above 99.8, but 0.4 long
    expect(confirmZoneSweep(ctx(weak, { pivots15m: highs }), armed, [])).toBeNull();
  });
});
