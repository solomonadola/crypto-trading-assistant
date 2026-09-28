import { describe, expect, it } from 'vitest';
import { supertrend } from '../src/analysis/indicators';
import { activeFvgs, detectFvgs } from '../src/analysis/fvg';
import { volumeProfile } from '../src/analysis/volumeProfile';
import type { Candle } from '../../shared/types';

const T0 = Date.UTC(2026, 0, 1);
type Bar = [number, number, number, number, number?];   // open, high, low, close, volume
const candles = (bars: Bar[]): Candle[] => bars.map(([o, h, l, c, v = 100], i) => ({
  symbol: 'SOLUSDT', tf: '1h', openTime: T0 + i * 3_600_000, closeTime: T0 + (i + 1) * 3_600_000,
  open: o, high: h, low: l, close: c, volume: v, quoteVolume: v * c, trades: 1,
}));
/** 20 quiet candles (range 1, ATR about 1) so gap sizes are measured against a known ATR. */
const quiet: Bar[] = Array.from({ length: 20 }, () => [100, 100.5, 99.5, 100]);
const params = { min_size_atr: 0.2, lookback_candles: 150 };

describe('SuperTrend', () => {
  it('is up in a rise, flips down after a fall, and its line sits on the right side of price', () => {
    const rise = Array.from({ length: 40 }, (_, i) => 100 + i);
    const fall = Array.from({ length: 40 }, (_, i) => 139 - i * 2);
    const close = [...rise, ...fall];
    const high = close.map((c) => c + 0.5);
    const low = close.map((c) => c - 0.5);
    const st = supertrend(high, low, close, 10, 3);
    expect(st.dir[39]).toBe(1);
    expect(st.line[39]).toBeLessThan(close[39]);
    expect(st.dir[79]).toBe(-1);
    expect(st.line[79]).toBeGreaterThan(close[79]);
    expect(st.dir.slice(0, 9).every(Number.isNaN)).toBe(true);
  });

  it('values up to a bar never change when later bars are added', () => {
    const close = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 7));
    const high = close.map((c) => c + 1);
    const low = close.map((c) => c - 1);
    const full = supertrend(high, low, close);
    for (const cut of [30, 61, 99]) {
      const part = supertrend(high.slice(0, cut), low.slice(0, cut), close.slice(0, cut));
      expect(part.dir).toEqual(full.dir.slice(0, cut));
      expect(part.line).toEqual(full.line.slice(0, cut));
    }
  });
});

describe('fair value gaps', () => {
  // Candle 1 high 100.5, candle 3 low 102: a bullish gap 100.5 - 102.
  const gapUp: Bar[] = [...quiet, [100, 100.5, 99.5, 100.4], [100.4, 103, 100.4, 102.8], [102.8, 103.5, 102, 103.2]];
  const only = (bars: Bar[]) => { const g = detectFvgs(candles(bars), params); expect(g).toHaveLength(1); return g[0]; };

  it('finds a bullish gap between candle 1 high and candle 3 low', () => {
    expect(only(gapUp)).toMatchObject({ side: 'bullish', inverse: false, bottom: 100.5, top: 102, status: 'open', createdAt: T0 + 23 * 3_600_000 });
  });

  it('tested when price comes into it, filled when it trades through without closing beyond', () => {
    expect(only([...gapUp, [103, 103.2, 101.5, 102.5]]).status).toBe('tested');
    expect(only([...gapUp, [103, 103.2, 100.2, 101]]).status).toBe('filled');
  });

  it('a close beyond the far side inverts it into a bearish IFVG, which ends on a close back above', () => {
    const inverted = only([...gapUp, [103, 103.2, 99, 99.8]]);
    expect(inverted).toMatchObject({ side: 'bearish', inverse: true, status: 'inverted', invertedAt: T0 + 24 * 3_600_000 });
    expect(activeFvgs([inverted])).toHaveLength(1);
    const ended = only([...gapUp, [103, 103.2, 99, 99.8], [99.8, 102.6, 99.8, 102.4]]);
    expect(ended.status).toBe('ended');
    expect(activeFvgs([ended])).toEqual([]);
  });

  it('bearish mirrors bullish', () => {
    const gapDown: Bar[] = [...quiet, [100, 100.5, 99.5, 99.6], [99.6, 99.6, 97, 97.2], [97.2, 98, 96.5, 96.8]];
    expect(only(gapDown)).toMatchObject({ side: 'bearish', top: 99.5, bottom: 98 });
  });

  it('ignores gaps smaller than min_size_atr x ATR', () => {
    const tiny: Bar[] = [...quiet, [100, 100.5, 99.5, 100.4], [100.4, 100.7, 100.4, 100.6], [100.6, 100.8, 100.55, 100.7]];
    expect(detectFvgs(candles(tiny), params)).toEqual([]);
  });
});

describe('volume profile', () => {
  it('POC at the heaviest price, value area around it', () => {
    // Most volume traded at 100-101, a little at 104-105 and 95-96.
    const bars: Bar[] = [
      ...Array.from({ length: 10 }, (): Bar => [100.5, 101, 100, 100.5, 1000]),
      [104.5, 105, 104, 104.5, 50], [95.5, 96, 95, 95.5, 50],
    ];
    const p = volumeProfile('test', candles(bars), 10, 70)!;
    expect(p.poc).toBeGreaterThanOrEqual(100);
    expect(p.poc).toBeLessThanOrEqual(101);
    expect(p.val).toBeLessThanOrEqual(100);
    expect(p.vah).toBeGreaterThanOrEqual(101);
    expect(p.vah - p.val).toBeLessThan(3);   // 70% of the volume sits in the 100-101 cluster
    const total = p.bins.reduce((s, b) => s + b.volume, 0);
    expect(total).toBeCloseTo(10 * 1000 + 100, 6);
  });

  it('no profile without a price range', () => {
    expect(volumeProfile('flat', candles([[1, 1, 1, 1], [1, 1, 1, 1]]), 10, 70)).toBeNull();
  });
});
