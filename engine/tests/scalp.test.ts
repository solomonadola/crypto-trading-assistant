import { describe, expect, it } from 'vitest';
import { findScalps, scalpStats, type ScalpContext, type ScalpSetup } from '../src/analysis/scalp';
import type { Candle } from '../../shared/types';

const T0 = Date.UTC(2026, 9, 1);
const M5 = 300_000;

/** 5m candles with closes on straight lines through [index, price] points (see patterns.test.ts); `over` replaces single candles' fields. */
function path(points: [number, number][], over: Record<number, Partial<Candle>> = {}): Candle[] {
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
      symbol: 'SOLUSDT', tf: '5m', openTime: T0 + i * M5, closeTime: T0 + (i + 1) * M5 - 1,
      open, close, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2,
      volume: 100, quoteVolume: 100 * close, trades: 1, ...over[i],
    };
  });
}

const zigzag = (n: number, lo: number, hi: number): [number, number][] =>
  Array.from({ length: n / 4 + 1 }, (_, k) => [k * 4, k % 2 ? hi : lo] as [number, number]);

const ctx: ScalpContext = { symbol: 'SOLUSDT', bias1h: 'range', sessionOpens: [], costPct: 0.2 };
const of = (s: ScalpSetup[], kind: ScalpSetup['kind']) => s.filter((x) => x.kind === kind);

describe('scalp setups', () => {
  // A range between 101 and 103 (swing lows at 100.8), then a candle that wicks to 100 and closes back at 101.4.
  const sweep = (after: [number, number][]) => path([...zigzag(80, 101, 103), ...after], { 81: { open: 101.2, high: 101.5, low: 100, close: 101.4 } });

  it('finds a sweep & reclaim of a swing low and follows it to its target', () => {
    const s = of(findScalps(sweep([[81, 101.4], [95, 106]]), ctx), 'sweep_reclaim').find((x) => x.time === T0 + 81 * M5)!;
    expect(s).toBeDefined();
    expect(s.side).toBe('long');
    expect(s.entry).toBe(101.4);
    expect(s.stop).toBeLessThan(100);
    // The target sits 2R plus the round-trip costs (0.2% of the entry) away: a 2R win after costs.
    expect(s.target).toBeCloseTo(s.entry + 2 * (s.entry - s.stop) + 0.002 * s.entry, 6);
    expect(s.status).toBe('target');
    expect(s.resultR).toBeCloseTo(2, 6);
    expect(s.winR).toBeCloseTo(2, 6);
    expect(s.lossR).toBeLessThan(-1);
  });

  it('records a stop when price falls through the sweep low instead', () => {
    const s = of(findScalps(sweep([[81, 101.4], [90, 97]]), ctx), 'sweep_reclaim').find((x) => x.time === T0 + 81 * M5)!;
    expect(s.status).toBe('stop');
    expect(s.resultR).toBe(s.lossR);
  });

  it('keeps a setup open until its stop or target is touched', () => {
    const s = of(findScalps(sweep([[81, 101.4], [84, 102]]), ctx), 'sweep_reclaim').find((x) => x.time === T0 + 81 * M5)!;
    expect(s.status).toBe('open');
    expect(s.resultR).toBeNull();
  });

  it('does not repeat a setup while the same one is still running', () => {
    // After the sweep, a second wick under the same low (candle 83) while the first is still open.
    const c = path([...zigzag(80, 101, 103), [81, 101.4], [84, 101.6]], { 81: { open: 101.2, high: 101.5, low: 100, close: 101.4 }, 83: { open: 101.3, high: 101.6, low: 100.1, close: 101.5 } });
    expect(of(findScalps(c, ctx), 'sweep_reclaim').filter((x) => x.time > T0 + 80 * M5)).toHaveLength(1);
  });

  it('skips setups whose stop is too close for the fees', () => {
    // Costs of 1% of price: a 1.5-point stop on 101 is under three times the costs.
    expect(of(findScalps(sweep([[81, 101.4], [95, 106]]), { ...ctx, costPct: 1 }), 'sweep_reclaim')).toEqual([]);
  });

  it('finds an opening range breakout on volume, with the stop at the range middle', () => {
    // Quiet at 100, a session opens at candle 70, its first 15 minutes span 99.8 – 101.2, then a close at 102 on volume.
    const c = path([[0, 100], [70, 100], [72, 101], [74, 101], [76, 102], [90, 104]], { 76: { volume: 400 } });
    const s = of(findScalps(c, { ...ctx, sessionOpens: [T0 + 70 * M5] }), 'orb');
    expect(s).toHaveLength(1);
    expect(s[0].side).toBe('long');
    expect(s[0].time).toBe(T0 + 76 * M5);
    const orHigh = Math.max(...c.slice(70, 73).map((x) => x.high));
    const orLow = Math.min(...c.slice(70, 73).map((x) => x.low));
    expect(s[0].stop).toBeCloseTo((orHigh + orLow) / 2, 6);
  });

  it('finds a 1m micro-scalp with tf set to 1m', () => {
    const M1 = 60_000;
    const c1m: Candle[] = path([...zigzag(80, 101, 103), [81, 101.4], [90, 106]], {
      81: { open: 101.2, high: 101.5, low: 100, close: 101.4 },
    }).map((c, i) => ({
      ...c,
      tf: '1m',
      openTime: T0 + i * M1,
      closeTime: T0 + (i + 1) * M1 - 1,
    }));
    const setups = findScalps(c1m, ctx);
    const s1m = setups.find((x) => x.kind === 'sweep_reclaim');
    expect(s1m).toBeDefined();
    expect(s1m?.tf).toBe('1m');
  });

  it('detects a volume climax reversal on high volume with absorption wick', () => {
    // Candles with volume 100, then at candle 60 volume surges to 500 with a large lower hammer wick
    const c = path([[0, 100], [60, 100], [65, 102]], {
      60: {
        open: 100.5,
        close: 101.0,
        high: 101.1,
        low: 99.5, // range 1.6, lower wick 100.5 - 99.5 = 1.0 (62.5% of range)
        volume: 500, // 5x average
      },
    });
    const s = of(findScalps(c, ctx), 'volume_climax');
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].side).toBe('long');
    expect(s[0].kind).toBe('volume_climax');
    expect(s[0].stop).toBeLessThan(99.5);
  });

  it('detects an FVG imbalance tap', () => {
    // Bullish trend where candle 58 has high 100.0, candle 59 leaps up,
    // candle 60 has low 101.2 (> high 58), candle 61 dips to 100.8 and closes green at 101.5
    const c = path([[0, 98], [55, 100], [70, 104]], {
      58: { open: 99.8, close: 100.0, high: 100.0, low: 99.6 },
      59: { open: 100.1, close: 101.8, high: 102.0, low: 100.0 },
      60: { open: 101.8, close: 102.2, high: 102.4, low: 101.2 },
      61: { open: 101.0, close: 101.8, high: 102.0, low: 100.8 },
    });
    const s = of(findScalps(c, { ...ctx, bias1h: 'up' }), 'fvg_retest');
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].side).toBe('long');
    expect(s[0].kind).toBe('fvg_retest');
  });
});

describe('scalp results', () => {
  it('counts wins, losses and R after costs per setup and in total', () => {
    const s = (kind: ScalpSetup['kind'], status: ScalpSetup['status'], resultR: number | null) => ({ kind, status, resultR }) as ScalpSetup;
    const stats = scalpStats([s('orb', 'target', 1.8), s('orb', 'stop', -1.1), s('orb', 'open', null), s('vwap_bounce', 'expired', -0.3)]);
    const orb = stats.find((x) => x.kind === 'orb')!;
    expect(orb).toMatchObject({ count: 3, closed: 2, wins: 1, losses: 1, expired: 0, winRate: 0.5 });
    expect(orb.totalR).toBeCloseTo(0.7, 6);
    const all = stats.find((x) => x.kind === 'all')!;
    expect(all).toMatchObject({ count: 4, closed: 3, wins: 1, losses: 2, expired: 1 });
    expect(all.avgR).toBeCloseTo(0.4 / 3, 6);
  });
});
