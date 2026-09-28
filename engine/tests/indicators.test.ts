import { describe, expect, it } from 'vitest';
import * as TI from 'technicalindicators';
import {
  adx, atr, bollingerWidth, choppiness, ema, fibLevel, fibRetracement, rsi, rvol, sma, swingPivots, trueRange, vwapDaily, wilder,
} from '../src/analysis/indicators';

/** Deterministic random-walk OHLCV, so failures reproduce. */
function market(n: number, seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [], volume: number[] = [], openTime: number[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o * (1 + (rand() - 0.5) * 0.04);
    const h = Math.max(o, c) * (1 + rand() * 0.01);
    const l = Math.min(o, c) * (1 - rand() * 0.01);
    open.push(o); high.push(h); low.push(l); close.push(c);
    volume.push(1000 + rand() * 5000);
    openTime.push(Date.UTC(2026, 0, 1) + i * 3_600_000);
    price = c;
  }
  return { open, high, low, close, volume, openTime };
}

/**
 * Compare the last `count` values of two series aligned at their ends. Libraries
 * differ in how they seed averages; far enough from the start that no longer shows.
 */
function expectTailClose(ours: number[], theirs: number[], count: number, tol: number) {
  expect(theirs.length).toBeGreaterThanOrEqual(count);
  for (let j = 0; j < count; j++) {
    const a = ours[ours.length - 1 - j];
    const b = theirs[theirs.length - 1 - j];
    expect(Math.abs(a - b), `value ${j} from the end: ${a} vs ${b}`).toBeLessThanOrEqual(tol);
  }
}

describe('moving averages', () => {
  it('sma by hand', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([NaN, NaN, 2, 3, 4]);
  });

  it('ema seeds with the SMA, then weights 2/(n+1)', () => {
    // seed at index 2 = 2; k = 0.5: 0.5*4 + 0.5*2 = 3; 0.5*5 + 0.5*3 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([NaN, NaN, 2, 3, 4]);
    expect(ema([2, 4, 6, 8], 2)).toEqual([NaN, 3, 3 + (2 / 3) * (6 - 3), expect.any(Number)]);
  });

  it('wilder weights 1/n', () => {
    // seed (1+2+3)/3 = 2; then (2*2 + 6)/3 = 10/3
    const w = wilder([1, 2, 3, 6], 3);
    expect(w[2]).toBe(2);
    expect(w[3]).toBeCloseTo(10 / 3, 12);
  });

  it('averages start after leading gaps', () => {
    expect(ema([NaN, NaN, 1, 2, 3], 2)).toEqual([NaN, NaN, NaN, 1.5, 1.5 + (2 / 3) * 1.5]);
  });

  it('matches technicalindicators', () => {
    const { close } = market(600);
    expectTailClose(sma(close, 20), TI.SMA.calculate({ values: close, period: 20 }), 500, 1e-9);
    expectTailClose(ema(close, 50), TI.EMA.calculate({ values: close, period: 50 }), 200, 1e-6);
  });
});

describe('rsi', () => {
  // Wilder's method on the classic worked example (StockCharts, "Relative Strength Index").
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
    46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];
  const published = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77];

  it('reproduces the worked example', () => {
    const r = rsi(closes, 14);
    expect(r.slice(0, 14).every(Number.isNaN)).toBe(true);
    // By hand: gains over the first 14 changes sum to 3.34, losses to 1.40.
    // RS = (3.34/14) / (1.40/14) = 2.385714..., RSI = 100 - 100/(1 + RS) = 70.4641.
    expect(r[14]).toBeCloseTo(70.4641, 4);
    // The published table rounds along the way (its first value is 70.53);
    // exact arithmetic stays within 0.1 of it and converges.
    published.forEach((v, j) => expect(Math.abs(r[14 + j] - v)).toBeLessThan(0.1));
  });

  it('is 100 with no losses and 50 with no movement', () => {
    expect(rsi([1, 2, 3, 4], 3)[3]).toBe(100);
    expect(rsi([5, 5, 5, 5], 3)[3]).toBe(50);
  });

  it('matches technicalindicators', () => {
    const { close } = market(600);
    expectTailClose(rsi(close, 14), TI.RSI.calculate({ values: close, period: 14 }), 500, 0.01);
  });
});

describe('volatility and trend strength', () => {
  it('true range uses the previous close', () => {
    // bar 1: h-l = 1, |h-pc| = 3, |l-pc| = 2 -> 3
    expect(trueRange([10, 13], [9, 12], [10, 12.5])).toEqual([1, 3]);
  });

  it('atr matches technicalindicators', () => {
    const { high, low, close } = market(800);
    expectTailClose(atr(high, low, close, 14), TI.ATR.calculate({ high, low, close, period: 14 }), 400, 1e-6);
  });

  it('adx and DI match technicalindicators', () => {
    const { high, low, close } = market(800);
    const ours = adx(high, low, close, 14);
    const theirs = TI.ADX.calculate({ high, low, close, period: 14 });
    expectTailClose(ours.adx, theirs.map((x) => x.adx), 400, 0.01);
    expectTailClose(ours.plusDI, theirs.map((x) => x.pdi), 400, 0.01);
    expectTailClose(ours.minusDI, theirs.map((x) => x.mdi), 400, 0.01);
  });

  it('bollinger width matches technicalindicators', () => {
    const { close } = market(300);
    const bands = TI.BollingerBands.calculate({ values: close, period: 20, stdDev: 2 });
    expectTailClose(bollingerWidth(close, 20, 2), bands.map((b) => (b.upper - b.lower) / b.middle), 250, 1e-9);
  });

  it('choppiness: a straight trend is 0, a flat range is high', () => {
    // Each bar's range stacks on the last: sum(TR) equals the whole range, so log(1) = 0.
    const n = 14;
    const up = Array.from({ length: 30 }, (_, i) => i);
    expect(choppiness(up.map((x) => x + 1), up, up.map((x) => x + 1), n)[29]).toBeCloseTo(0, 9);
    // Every bar spans the whole range: sum(TR) = n * range, so the index is 100.
    const flatH = new Array(30).fill(11), flatL = new Array(30).fill(10), flatC = new Array(30).fill(10.5);
    expect(choppiness(flatH, flatL, flatC, n)[29]).toBeCloseTo(100, 9);
  });
});

describe('volume and price levels', () => {
  it('rvol compares a bar to the average of the bars before it', () => {
    const r = rvol([10, 10, 10, 40, 10], 3);
    expect(r.slice(0, 3).every(Number.isNaN)).toBe(true);
    expect(r[3]).toBe(4);          // 40 / avg(10,10,10)
    expect(r[4]).toBe(10 / 20);    // 10 / avg(10,10,40)
  });

  it('vwap restarts at 00:00 UTC', () => {
    const day = 86_400_000;
    const v = vwapDaily({
      openTime: [0, 3_600_000, day],
      high: [11, 21, 31], low: [9, 19, 29], close: [10, 20, 30], volume: [1, 3, 5],
    });
    expect(v[0]).toBe(10);
    expect(v[1]).toBe((10 * 1 + 20 * 3) / 4);
    expect(v[2]).toBe(30);
  });

  it('fib levels of an up leg and a down leg', () => {
    expect(fibLevel(100, 200, 0.5)).toBe(150);
    expect(fibLevel(100, 200, 0.618)).toBeCloseTo(138.2, 9);
    expect(fibLevel(200, 100, 0.618)).toBeCloseTo(161.8, 9);
    expect(fibRetracement(100, 200)['0.382']).toBeCloseTo(161.8, 9);
  });
});

describe('swing pivots', () => {
  it('finds strict pivots and reports when they became known', () => {
    const high = [1, 2, 5, 2, 1, 3, 1];
    const low = [0, 1, 4, 1, 0.5, 2, 1];
    const p = swingPivots(high, low, 2);
    expect(p).toEqual([
      { type: 'high', index: 2, confirmedAt: 4, price: 5 },
      { type: 'low', index: 4, confirmedAt: 6, price: 0.5 },
    ]);
  });

  it('equal highs are not a pivot', () => {
    expect(swingPivots([1, 5, 5, 1], [0, 0, 0, 0], 1).filter((x) => x.type === 'high')).toEqual([]);
  });
});

describe('no lookahead', () => {
  const m = market(400, 11);
  const cuts = [30, 57, 120, 233, 399];
  const cases: [string, (n: number) => number[]][] = [
    ['sma', (n) => sma(m.close.slice(0, n), 20)],
    ['ema', (n) => ema(m.close.slice(0, n), 20)],
    ['rsi', (n) => rsi(m.close.slice(0, n), 14)],
    ['atr', (n) => atr(m.high.slice(0, n), m.low.slice(0, n), m.close.slice(0, n), 14)],
    ['adx', (n) => adx(m.high.slice(0, n), m.low.slice(0, n), m.close.slice(0, n), 14).adx],
    ['choppiness', (n) => choppiness(m.high.slice(0, n), m.low.slice(0, n), m.close.slice(0, n), 14)],
    ['bollingerWidth', (n) => bollingerWidth(m.close.slice(0, n), 20)],
    ['rvol', (n) => rvol(m.volume.slice(0, n), 20)],
    ['vwapDaily', (n) => vwapDaily({ openTime: m.openTime.slice(0, n), high: m.high.slice(0, n), low: m.low.slice(0, n), close: m.close.slice(0, n), volume: m.volume.slice(0, n) })],
  ];

  it.each(cases)('%s: values up to a cut do not change when later bars are added', (_name, f) => {
    const full = f(400);
    for (const cut of cuts) expect(f(cut)).toEqual(full.slice(0, cut));
  });

  it('swing pivots known by a bar are the same with or without later bars', () => {
    const full = swingPivots(m.high, m.low, 3);
    for (const cut of cuts) {
      const partial = swingPivots(m.high.slice(0, cut), m.low.slice(0, cut), 3);
      expect(partial).toEqual(full.filter((p) => p.confirmedAt < cut));
    }
  });
});
