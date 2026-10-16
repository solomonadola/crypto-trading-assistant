import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { killzoneSweep, type KillzoneSweepInput } from '../src/strategy/killzoneSweep';
import type { LiquidityLevel } from '../src/analysis/liquidity';
import { netRewardRisk } from '../src/speed';
import type { Candle } from '../../shared/types';

const config = loadConfig('engine/config/config.yaml').scalp_autopilot.killzone_sweep;
const T0 = Date.parse('2026-07-15T06:00Z');
const BAR = 300_000;
const bar = (i: number, open: number, high: number, low: number, close: number): Candle =>
  ({ symbol: 'ETHUSDT', tf: '5m', openTime: T0 + i * BAR, closeTime: T0 + (i + 1) * BAR - 1, open, high, low, close, volume: 1, quoteVolume: 1, trades: 1 });

/**
 * A long setup on 41 bars: quiet around 100 (bars 0-27), a wick through the Asia low at 99.5 that closes back
 * above it (bar 28), a drift (29-39), then bar 40 gaps up and closes at 101, through the 100.3 swing: the CHoCH.
 * Bars 38 (high 100.2) and 40 (low 100.4) leave a fair value gap whose middle is 100.3.
 */
function longBars(): Candle[] {
  const m: Candle[] = [];
  for (let i = 0; i < 28; i++) m.push(bar(i, 100, 100.3, 99.7, 100));
  m.push(bar(28, 100, 100.1, 99.0, 99.8));
  for (let i = 29; i < 39; i++) m.push(bar(i, 99.8, 100.2, 99.6, 100));
  m.push(bar(39, 100, 100.3, 99.9, 100.2));
  m.push(bar(40, 100.4, 101.2, 100.4, 101));
  return m;
}

const asianLow: LiquidityLevel = { name: 'asian_low', side: 'sell', price: 99.5, formedAt: T0, brokenAt: null };
const discount = { high: 120, low: 95, position: 0.2 };
/** A trend that allows either side (no filter decides anything with it). */
const anyTrend = { long: true, short: true, h4: 'none' as const };

const input = (over: Partial<KillzoneSweepInput> = {}): KillzoneSweepInput => ({
  symbol: 'ETHUSDT', market: { levels: [asianLow], range: discount, trend: anyTrend }, m5: longBars(), killzone: 'london',
  costPct: 0.12, minRr: 2, config, ...over,
});

/** The same market upside down (price 200 - p): the long setup becomes the matching short. */
const mirror = (m: Candle[]): Candle[] => m.map((c) => ({ ...c, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close }));

describe('killzoneSweep', () => {
  it('a sweep of the Asia low and a 5m CHoCH in the killzone: a long limit at the fair value gap, stop beyond the wick', () => {
    const { order } = killzoneSweep(input());
    expect(order).not.toBeNull();
    expect(order).toMatchObject({ side: 'long', tf: '5m', swept: 'Asian low', killzone: 'london' });
    expect(order!.limitPrice).toBeCloseTo(100.3, 9);
    expect(order!.stop).toBeLessThan(99.0);
    // No buy-side level ahead: a fixed 2R target after costs.
    const risk = order!.limitPrice - order!.stop;
    expect(order!.target).toBeCloseTo(order!.limitPrice + 2.001 * risk + 0.0012 * order!.limitPrice, 9);
    // At least 2R after costs, as the engine measures it: never refused for a rounding hair under.
    expect(netRewardRisk(order!.limitPrice, order!.stop, order!.target, 0.12)).toBeGreaterThanOrEqual(2);
    // A scalp: a 2-hour max hold, and cut if it is not 0.5R up after 30 minutes.
    expect(order).toMatchObject({ maxHoldMin: 120, progressCheckMin: 30, progressMinR: 0.5 });
  });

  it('the mirror image is the short, at the same distances', () => {
    const asianHigh: LiquidityLevel = { ...asianLow, name: 'asian_high', side: 'buy', price: 100.5 };
    const { order } = killzoneSweep(input({ m5: mirror(longBars()), market: { levels: [asianHigh], range: { high: 105, low: 80, position: 0.8 }, trend: anyTrend } }));
    expect(order).toMatchObject({ side: 'short', swept: 'Asian high' });
    expect(order!.limitPrice).toBeCloseTo(99.7, 9);
    expect(order!.stop).toBeGreaterThan(101.0);
  });

  it('takes a liquidity level 2 to 4R away as the target', () => {
    const { order: plain } = killzoneSweep(input());
    const risk = plain!.limitPrice - plain!.stop;
    const pdh: LiquidityLevel = { name: 'PDH', side: 'buy', price: plain!.limitPrice + 3 * risk, formedAt: T0, brokenAt: null };
    const wide = { ...config, max_rr: 4 };
    const { order } = killzoneSweep(input({ market: { levels: [asianLow, pdh], range: discount, trend: anyTrend }, config: wide }));
    expect(order!.target).toBe(pdh.price);
    // With the shipped 2R cap, a level 3R away is passed over for the fixed 2R target.
    expect(killzoneSweep(input({ market: { levels: [asianLow, pdh], range: discount, trend: anyTrend } })).order!.target).toBeCloseTo(plain!.target, 9);
  });

  it('does nothing outside the killzones', () => {
    expect(killzoneSweep(input({ killzone: null }))).toEqual({ order: null, skipped: 'outside_killzone' });
  });

  it('no long in the premium half of the 4h range', () => {
    expect(killzoneSweep(input({ market: { levels: [asianLow], range: { high: 101, low: 90, position: 0.9 }, trend: anyTrend } })).skipped).toBe('long_not_in_discount');
  });

  it('no setup when the wick did not reach a level', () => {
    const deeper = { ...asianLow, price: 98.5 };
    expect(killzoneSweep(input({ market: { levels: [deeper], range: discount, trend: anyTrend } })).skipped).toBe('no_setup');
  });

  it('no setup when a level was already broken before the sweep', () => {
    const broken = { ...asianLow, brokenAt: T0 + 5 * BAR };
    expect(killzoneSweep(input({ market: { levels: [broken], range: discount, trend: anyTrend } })).skipped).toBe('no_setup');
  });

  it('the trend filter: bias needs the 1h trend with us, strict also the 4h structure with us', () => {
    const market = (trend: { long: boolean; short: boolean; h4: 'up' | 'down' | 'none' }) => ({ levels: [asianLow], range: discount, trend });
    const bias = { ...config, trend_filter: 'bias' as const };
    const strict = { ...config, trend_filter: 'strict' as const };
    const downtrend = { long: false, short: true, h4: 'down' as const };
    // Off (shipped): the sweep long is taken whatever the trend.
    expect(killzoneSweep(input({ market: market(downtrend) })).order).not.toBeNull();
    // bias: not against a downtrend, but in an uptrend, even with a flat 4h structure.
    expect(killzoneSweep(input({ market: market(downtrend), config: bias })).skipped).toBe('against_htf_trend');
    expect(killzoneSweep(input({ market: market({ long: true, short: false, h4: 'none' }), config: bias })).order).not.toBeNull();
    // strict: the flat 4h structure is not enough; an up one is.
    expect(killzoneSweep(input({ market: market({ long: true, short: false, h4: 'none' }), config: strict })).skipped).toBe('h4_structure_not_with_us');
    expect(killzoneSweep(input({ market: market({ long: true, short: false, h4: 'up' }), config: strict })).order).not.toBeNull();
  });

  it('only the first close through the swing is the CHoCH: a later one is not a fresh signal', () => {
    const m = longBars();
    m[35] = bar(35, 100, 100.6, 99.9, 100.5);   // an earlier close above the 100.3 swing
    expect(killzoneSweep(input({ m5: m })).order).toBeNull();
  });
});
