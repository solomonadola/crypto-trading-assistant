import { describe, expect, it } from 'vitest';
import { readSwingStructure } from '../src/analysis/swingStructure';
import { findPump, watchCoin } from '../src/analysis/pumpWatch';
import type { Candle } from '../../shared/types';

const T0 = Date.UTC(2026, 0, 1);
const H = 3_600_000;

/**
 * 1h candles whose closes run in straight lines through the turning points
 * [index, price]; wicks reach `wick` (a share of the price) beyond the body.
 * `vol(i)` is each candle's USDT volume.
 */
function path(points: [number, number][], vol: (i: number) => number = () => 1e6, wick = 0.002): Candle[] {
  const closes: number[] = [];
  for (let s = 0; s + 1 < points.length; s++) {
    const [i0, p0] = points[s];
    const [i1, p1] = points[s + 1];
    for (let i = i0; i < i1; i++) closes.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
  }
  closes.push(points[points.length - 1][1]);
  return closes.map((close, i) => {
    const open = i ? (closes[i - 1] + close) / 2 : close;
    return {
      symbol: 'METUSDT', tf: '1h', openTime: T0 + i * H, closeTime: T0 + (i + 1) * H - 1,
      open, close, high: Math.max(open, close) * (1 + wick), low: Math.min(open, close) * (1 - wick),
      volume: vol(i) / close, quoteVolume: vol(i), trades: 1,
    };
  });
}

/** A quiet zigzag base around 1.0 for `n` candles. */
const base = (n: number): [number, number][] => Array.from({ length: n / 4 + 1 }, (_, k) => [k * 4, k % 2 ? 1.01 : 0.99] as [number, number]);

describe('swing structure', () => {
  it('names a staircase up HH/HL with BOS up and a protected low', () => {
    const pts: [number, number][] = [[0, 100]];
    for (let k = 1; k <= 30; k++) pts.push([k * 6, pts[pts.length - 1][1] + (k % 2 ? 6 : -2)]);
    const s = readSwingStructure(path(pts), '1h')!;
    expect(s.trend).toBe('up');
    const labels = s.swings.map((x) => x.label).filter(Boolean);
    expect(labels.every((l) => l === 'HH' || l === 'HL')).toBe(true);
    expect(s.breaks.at(-1)).toMatchObject({ kind: 'BOS', dir: 'up' });
    expect(s.breakDown!.price).toBeLessThan(path(pts).at(-1)!.close);
  });

  it('calls the first break against an uptrend a CHoCH', () => {
    const pts: [number, number][] = [[0, 100]];
    for (let k = 1; k <= 20; k++) pts.push([k * 6, pts[pts.length - 1][1] + (k % 2 ? 6 : -2)]);
    const top = pts[pts.length - 1][1];
    pts.push([pts[pts.length - 1][0] + 15, top - 30]);
    const s = readSwingStructure(path(pts), '1h')!;
    expect(s.trend).toBe('down');
    expect(s.breaks.filter((b) => b.dir === 'down')[0]).toMatchObject({ kind: 'CHoCH' });
  });

  it('only uses the candles given (no look-ahead)', () => {
    const pts: [number, number][] = [[0, 100]];
    for (let k = 1; k <= 30; k++) pts.push([k * 6, pts[pts.length - 1][1] + (k % 2 ? 6 : -2)]);
    const c = path(pts);
    const early = readSwingStructure(c.slice(0, 120), '1h')!;
    const later = readSwingStructure(c, '1h')!;
    // Over the candles both show (the last 160 of the longer read).
    const from = c[c.length - 160].openTime;
    const t = c[119].openTime;
    const shared = (bs: typeof early.breaks) => bs.filter((b) => b.time >= from && b.time <= t);
    expect(shared(early.breaks).length).toBeGreaterThan(0);
    expect(shared(later.breaks)).toEqual(shared(early.breaks));
  });
});

describe('pump watch', () => {
  // A thin base on $200k an hour, then a run of +60% in 12 hours on 20x the volume.
  const vol = (i: number) => (i < 100 ? 2e5 : 4e6);
  const pump = path([...base(100), [112, 1.6]], vol);

  it('stays quiet on a calm coin', () => {
    const c = path(base(160));
    const w = watchCoin('X', c, readSwingStructure(c, '1h'), null);
    expect(w.pump).toBeNull();
    expect(w.level).toBe('ok');
  });

  it('finds a pump marking up and warns about a thin base', () => {
    const p = findPump(pump)!;
    expect(p.phase).toBe('markup');
    expect(p.runPct).toBeGreaterThan(50);
    expect(p.volumeX).toBeGreaterThan(10);
    const w = watchCoin('X', pump, readSwingStructure(pump, '1h'), null);
    expect(w.warnings.map((x) => x.code)).toEqual(expect.arrayContaining(['pump_markup', 'thin_base']));
  });

  it('calls a stall under the high distribution, then a deep pullback an unwind', () => {
    const stall = path([...base(100), [112, 1.6], [118, 1.52], [122, 1.56]], vol);
    expect(findPump(stall)!.phase).toBe('distribution');
    const unwind = path([...base(100), [112, 1.6], [124, 1.3]], vol);
    const s = readSwingStructure(unwind, '1h');
    const w = watchCoin('X', unwind, s, null);
    expect(w.pump!.phase).toBe('unwind');
    expect(w.level).toBe('danger');
    expect(w.warnings[0].code).toBe('pump_unwinding');
  });

  it('flags a blow-off: a long upper wick on heavy volume at the top', () => {
    const c = path([...base(100), [112, 1.6]], vol);
    const top = c[c.length - 1];
    c[c.length - 1] = { ...top, high: top.close * 1.15, quoteVolume: 3e7 };
    expect(findPump(c)!.phase).toBe('blowoff');
  });
});
