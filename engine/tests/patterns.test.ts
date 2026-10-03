import { describe, expect, it } from 'vitest';
import { findPatterns, findWyckoff, readTrend } from '../src/analysis/patterns';
import type { Candle } from '../../shared/types';

const T0 = Date.UTC(2026, 0, 1);
const H = 3_600_000;

/**
 * Candles whose closes run in straight lines through the given turning
 * points [index, price]; each candle opens halfway from the previous close and
 * its wicks reach `wick` beyond its body.
 * `over` replaces fields of single candles (a climax's volume and range, say).
 */
function path(points: [number, number][], over: Record<number, Partial<Candle>> = {}, wick = 0.2): Candle[] {
  const closes: number[] = [];
  for (let s = 0; s + 1 < points.length; s++) {
    const [i0, p0] = points[s];
    const [i1, p1] = points[s + 1];
    for (let i = i0; i < i1; i++) closes.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
  }
  closes.push(points[points.length - 1][1]);
  return closes.map((close, i) => {
    // Halfway from the previous close, so the candle after a peak never ties its high.
    const open = i ? (closes[i - 1] + close) / 2 : close;
    return {
      symbol: 'SOLUSDT', tf: '1h', openTime: T0 + i * H, closeTime: T0 + (i + 1) * H - 1,
      open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
      volume: 100, quoteVolume: 100 * close, trades: 1, ...over[i],
    };
  });
}

/** The same candles upside down around `axis`: rallies become declines. */
const mirror = (c: Candle[], axis: number): Candle[] => c.map((x) => ({
  ...x, open: axis - x.open, close: axis - x.close, high: axis - x.low, low: axis - x.high,
}));

/** A zigzag between `lo` and `hi` every `step` candles, for `n` candles. */
const zigzag = (from: number, n: number, lo: number, hi: number, step = 5): [number, number][] =>
  Array.from({ length: Math.floor(n / step) + 1 }, (_, k) => [from + k * step, k % 2 ? hi : lo] as [number, number]);

describe('trend read', () => {
  it('reads a steady climb as an uptrend', () => {
    // Rising in steps: up 6, back 2, so swings make higher highs and higher lows.
    const pts: [number, number][] = [[0, 100]];
    for (let k = 1; k <= 30; k++) pts.push([k * 4, pts[pts.length - 1][1] + (k % 2 ? 6 : -2)]);
    const t = readTrend(path(pts))!;
    expect(t.direction).toBe('up');
    expect(t.structure).toBe('up');
    expect(t.slopeAtr).toBeGreaterThan(0.2);
  });

  it('reads a flat back-and-forth as a range', () => {
    expect(readTrend(path(zigzag(0, 120, 100, 104)))!.direction).toBe('range');
  });

  it('needs enough candles', () => {
    expect(readTrend(path([[0, 100], [30, 110]]))).toBeNull();
  });
});

describe('chart patterns', () => {
  it('finds an ascending triangle: flat highs, rising lows', () => {
    // Quiet lead-in, then highs at 110 and lows rising 100 -> 106.
    const pts: [number, number][] = [[0, 104], [50, 104], [60, 110], [70, 100], [80, 110], [90, 102], [100, 110], [110, 104], [120, 110], [130, 106], [134, 108]];
    const p = findPatterns(path(pts)).find((x) => x.kind === 'ascending_triangle');
    expect(p).toBeDefined();
    expect(p!.bias).toBe('bullish');
    expect(p!.status).toBe('forming');
    expect(p!.upper.p1).toBeCloseTo(p!.upper.p2, 0);   // flat resistance
    expect(p!.lower.p2).toBeGreaterThan(p!.lower.p1 + 3);   // rising support
  });

  it('marks the breakout and a measured-move target', () => {
    const pts: [number, number][] = [[0, 104], [50, 104], [60, 110], [70, 100], [80, 110], [90, 102], [100, 110], [110, 104], [120, 110], [130, 106], [136, 116]];
    const p = findPatterns(path(pts)).find((x) => x.kind === 'ascending_triangle')!;
    expect(p.status).toBe('broke_up');
    expect(p.target).toBeGreaterThan(115);
  });

  it('finds a double top and its neckline', () => {
    const pts: [number, number][] = [[0, 100], [40, 100], [55, 120], [70, 110], [85, 120.2], [95, 113]];
    const p = findPatterns(path(pts)).find((x) => x.kind === 'double_top');
    expect(p).toBeDefined();
    expect(p!.bias).toBe('bearish');
    expect(p!.lower.p1).toBeCloseTo(109.8, 1);   // the low between the tops
    expect(p!.status).toBe('forming');
  });

  it('finds nothing in a straight line', () => {
    expect(findPatterns(path([[0, 100], [100, 150]]))).toEqual([]);
  });
});

describe('Wyckoff', () => {
  // A decline into a selling climax at 100 (5x volume, a wide candle), the automatic rally to 112,
  // a range between about 101 and 111, a secondary test, a spring to 98, then a breakout on volume.
  const accumulation = (): Candle[] => {
    const pts: [number, number][] = [
      [0, 150], [60, 101],                                   // the decline
      [68, 112],                                             // automatic rally
      [75, 104], [82, 110], [89, 101.5],                     // secondary test near the low
      [96, 109], [103, 103], [110, 110], [116, 99],          // spring under the range...
      [117, 102], [124, 108], [130, 104], [140, 116], [146, 114],   // ...back inside, then out above
    ];
    const over: Record<number, Partial<Candle>> = {
      60: { low: 99, high: 103, volume: 500 },                // selling climax
      89: { volume: 60 },                                     // secondary test on less volume
      116: { volume: 120 },
      138: { volume: 300 }, 139: { volume: 300 }, 140: { volume: 300 },   // breakout volume
    };
    // Wicks of 1: an ATR of about 2.4, so the 14-point range is a believable 6 ATRs tall.
    return path(pts, over, 1);
  };

  it('reads an accumulation range with its events and phase', () => {
    const w = findWyckoff(accumulation())!;
    expect(w).not.toBeNull();
    expect(w.kind).toBe('accumulation');
    expect(w.bottom).toBe(99);
    expect(w.top).toBe(113);
    const names = w.events.map((e) => e.name);
    expect(names.slice(0, 2)).toEqual(['SC', 'AR']);
    expect(names).toContain('ST');
    expect(names).toContain('Spring');
    expect(names).toContain('SOS');
    expect(w.phase).toBe('D');
  });

  it('reads the same chart upside down as distribution', () => {
    const w = findWyckoff(mirror(accumulation(), 250))!;
    expect(w.kind).toBe('distribution');
    expect(w.top).toBe(151);
    const names = w.events.map((e) => e.name);
    expect(names.slice(0, 2)).toEqual(['BC', 'AR']);
    expect(names).toContain('UTAD');
    expect(names).toContain('SOW');
  });

  it('finds no range in a steady trend', () => {
    expect(findWyckoff(path([[0, 100], [150, 200]]))).toBeNull();
  });
});
