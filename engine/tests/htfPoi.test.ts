import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { armHtfPoi, chochOn, htfBiasAllows, htfPoiStillValid } from '../src/strategy/htfPoi';
import { series, type Context } from '../src/strategy/context';
import { liquidityPlan } from '../src/strategy/smc';
import { netRewardRisk } from '../src/speed';
import type { LiquidityLevel } from '../src/analysis/liquidity';
import type { Pivot } from '../src/analysis/indicators';
import type { Candle } from '../../shared/types';

const cfg = loadConfig('engine/config/config.yaml');
const H = 3_600_000;
const Q = 900_000;
const M5 = 300_000;
const T = Date.UTC(2026, 6, 15, 9, 0);
const pivot = (type: 'high' | 'low', index: number, price: number): Pivot => ({ type, index, price, confirmedAt: index + 3 });
const candle = (tf: Candle['tf'], closeTime: number, ms: number, o: number, h: number, l: number, c: number): Candle =>
  ({ symbol: 'SOLUSDT', tf, openTime: closeTime - ms, closeTime, open: o, high: h, low: l, close: c, volume: 1, quoteVolume: 100, trades: 1 });

describe('change of character on any timeframe', () => {
  /** 5m candles drifting down in lower highs (peaks at 6, 14, 22), then the given last candles. */
  const pullback = (last: [number, number, number, number][]): Candle[] => {
    const peaks: Record<number, number> = { 6: 104, 14: 102.5, 22: 101.5 };
    const bars = Array.from({ length: 30 }, (_, i): [number, number, number, number] => {
      const base = 103 - i * 0.12;
      return peaks[i] ? [base, peaks[i], base - 0.3, base] : [base, base + 0.2, base - 0.3, base];
    });
    return [...bars, ...last].map(([o, h, l, c], i) => candle('5m', T + (i + 1) * M5, M5, o, h, l, c));
  };

  it('is the first close above the latest of falling swing highs', () => {
    const swing = chochOn(pullback([[99.4, 101.8, 99.3, 101.7]]), 3, 'long');
    expect(swing).toMatchObject({ type: 'high', price: 101.5 });
  });

  it('is not a close under it, nor a second close above it', () => {
    expect(chochOn(pullback([[99.4, 101.4, 99.3, 101.3]]), 3, 'long')).toBeNull();
    expect(chochOn(pullback([[99.4, 101.8, 99.3, 101.7], [101.7, 102, 101.6, 101.9]]), 3, 'long')).toBeNull();
  });

  it('is not a short on the same candles', () => {
    expect(chochOn(pullback([[99.4, 101.8, 99.3, 101.7]]), 3, 'short')).toBeNull();
  });
});

describe('Model 4: 4h point of interest', () => {
  // A bullish 4h FVG at 97 – 98; the 4h range 90 – 120 (equilibrium 105) puts 98 in discount.
  const fvg = { id: 'g1', tf: '4h', side: 'bullish', inverse: false, top: 98, bottom: 97, createdAt: 0, status: 'open', invalidatedAt: null };
  const h1 = Array.from({ length: 260 }, (_, i) => candle('1h', T - (259 - i) * H, H, 100, 100.3, 99.7, 100));
  const h4 = Array.from({ length: 40 }, (_, i) => candle('4h', T - (39 - i) * 4 * H, 4 * H, 100, 100.4, 99.6, 100));

  /** 60 15m candles ending at T: flat at 100, the last one given. */
  function ctx(last: [number, number, number, number], over: { ema4h?: object; structure4h?: string | null; fvgs?: object[]; pivots4h?: Pivot[] } = {}): Context {
    const m15 = Array.from({ length: 60 }, (_, i) => {
      const [o, h, l, c] = i === 59 ? last : [100, 100.3, 99.7, 100];
      return candle('15m', T - (59 - i) * Q, Q, o, h, l, c);
    });
    return {
      symbol: 'SOLUSDT', t: T, config: cfg, price: m15[59].close, speed: 'normal', funding: null,
      m15: series(m15), h1: series(h1), h4: series(h4), atr15m: [1], atr1h: [2], pivots1h: [], pivots15m: [],
      pivots4h: over.pivots4h ?? [pivot('high', 10, 120), pivot('low', 15, 90)],
      analysis: {
        structure: { '4h': over.structure4h === null ? null : { trend: over.structure4h ?? 'up' } },
        ema4h: over.ema4h ?? { fast: 101, slow: 95, close: 100 },
        zones: [], fvgs: over.fvgs ?? [fvg], profiles: [],
      },
    } as unknown as Context;
  }
  const tap: [number, number, number, number] = [99, 99.1, 97.8, 98.3];

  it('follows the 4h trend: close above the 4h EMA200 and 4h structure not down for a long', () => {
    expect(htfBiasAllows(ctx(tap), 'long')).toBe(true);
    expect(htfBiasAllows(ctx(tap, { structure4h: 'down' }), 'long')).toBe(false);
    expect(htfBiasAllows(ctx(tap, { ema4h: { fast: 90, slow: 105, close: 100 } }), 'long')).toBe(false);
    expect(htfBiasAllows(ctx(tap), 'short')).toBe(false);
  });

  it('arms when a 15m candle trades into a 4h FVG, in discount, with the 4h trend', () => {
    const a = armHtfPoi(ctx(tap), 'long')!;
    expect(a).toMatchObject({ direction: 'long', armedAt: T, symbol: 'SOLUSDT' });
    expect(a.factors.map((f) => f.name)).toEqual(['4h_fvg']);
    // The gap widened by 0.5 x ATR(1h) = 1 each side.
    expect([a.areaLow, a.areaHigh]).toEqual([96, 99]);
    expect(a.expiresAt).toBe(T + cfg.htf_poi.armed_expiry_hours * H);
  });

  it('does not arm away from the gap, against the 4h trend, in premium, or on a bearish gap', () => {
    expect(armHtfPoi(ctx([100, 100.3, 99.7, 100]), 'long')).toBeNull();
    expect(armHtfPoi(ctx(tap, { structure4h: 'down' }), 'long')).toBeNull();
    expect(armHtfPoi(ctx(tap, { pivots4h: [pivot('high', 10, 99), pivot('low', 15, 90)] }), 'long')).toBeNull();
    expect(armHtfPoi(ctx(tap, { fvgs: [{ ...fvg, side: 'bearish' }] }), 'long')).toBeNull();
  });

  it('expires on time, when the 4h trend turns, or when price closes through the area', () => {
    const a = armHtfPoi(ctx(tap), 'long')!;
    expect(htfPoiStillValid(ctx(tap), a, 98.3, false)).toBeNull();
    expect(htfPoiStillValid(ctx(tap), a, 95.5, false)).toBe('left_area');
    expect(htfPoiStillValid(ctx(tap, { structure4h: 'down' }), a, 98.3, false)).toBe('trend_changed');
    expect(htfPoiStillValid({ ...ctx(tap), t: a.expiresAt }, a, 98.3, false)).toBe('expired');
    expect(htfPoiStillValid(ctx(tap), a, 98.3, true)).toBe('session_closed');
  });
});

describe('reward:risk after costs', () => {
  // Normal coins: 0.05% fee and 0.05% slippage each way, 0.2% for the round trip.
  const ctx = { config: cfg, speed: 'normal' } as unknown as Context;
  const level = (name: LiquidityLevel['name'], price: number): LiquidityLevel =>
    ({ name, price, side: 'buy', formedAt: 0, intact: true, brokenAt: null } as LiquidityLevel);

  it('takes the costs off the reward', () => {
    // Risk 2, reward 4.1, costs 0.2 (0.2% of 100): (4.1 - 0.2) / 2.
    expect(netRewardRisk(100, 98, 104.1, 0.2)).toBeCloseTo(1.95, 9);
    expect(netRewardRisk(100, 102, 95.9, 0.2)).toBeCloseTo(1.95, 9);
  });

  it('passes over a target that is 2R only before costs, for the next one', () => {
    const planned = liquidityPlan(ctx, 'long', 100, 98, [level('PDH', 104.1), level('asian_high', 106)])!;
    expect(planned.target.price).toBe(106);
    expect(netRewardRisk(100, 98, planned.plan.target, 0.2)).toBeGreaterThanOrEqual(2);
  });
});
