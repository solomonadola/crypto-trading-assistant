import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { sessionSweep } from '../src/strategy/sessionSweep';
import { Engine } from '../src/core/engine';
import { series, type Context } from '../src/strategy/context';
import type { Pivot } from '../src/analysis/indicators';
import type { Candle } from '../../shared/types';

const cfg = loadConfig('engine/config/config.yaml');
const u = (iso: string) => Date.parse(iso);
const H = 3_600_000;
const T = u('2026-07-15T09:00Z');   // the 08:45 candle has just closed
const key = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z';

type Bar = { open?: number; high?: number; low?: number; close?: number };
/** 15m candles from 2026-07-14 00:00 to `end`, flat at 100 except the given ones (by open time). */
function m15(marks: Record<string, Bar>, end = T): Candle[] {
  const out: Candle[] = [];
  for (let open = u('2026-07-14T00:00Z'); open + 900_000 <= end; open += 900_000) {
    const m = marks[key(open)] ?? {};
    out.push({ symbol: 'SOLUSDT', tf: '15m', openTime: open, closeTime: open + 900_000, open: m.open ?? 100, high: m.high ?? 100.5, low: m.low ?? 99.5, close: m.close ?? 100, volume: 1, quoteVolume: 100, trades: 1 });
  }
  return out;
}

/** 1h candles ending at `end`, closing from `from` to `to` in a straight line. */
function h1(from: number, to: number, end = T, n = 260): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = from + ((to - from) * i) / (n - 1);
    const closeTime = end - (n - 1 - i) * H;
    return { symbol: 'SOLUSDT', tf: '1h', openTime: closeTime - H, closeTime, open: c, high: c + 0.3, low: c - 0.3, close: c, volume: 1, quoteVolume: 100, trades: 1 };
  });
}
const h4 = (end = T) => Array.from({ length: 30 }, (_, i): Candle => {
  const closeTime = end - (29 - i) * 4 * H;
  return { symbol: 'SOLUSDT', tf: '4h', openTime: closeTime - 4 * H, closeTime, open: 100, high: 101, low: 99, close: 100, volume: 1, quoteVolume: 100, trades: 1 };
});
const pivot = (type: 'high' | 'low', index: number, price: number): Pivot => ({ type, index, price, confirmedAt: index + 3 });

const chart = {
  '2026-07-14T12:00Z': { high: 112 },                                    // PDH 112
  '2026-07-14T18:00Z': { low: 95 },                                      // PDL 95
  '2026-07-15T04:00Z': { high: 103 }, '2026-07-15T02:00Z': { low: 98 },  // Asian range 103 / 98
  '2026-07-15T08:15Z': { open: 99.8, high: 100, low: 97, close: 98.5 },  // sweeps the Asian low
  '2026-07-15T08:30Z': { open: 98.5, high: 98.9, low: 98.2, close: 98.6 },
  '2026-07-15T08:45Z': { open: 98.6, high: 100.4, low: 98.4, close: 100.3 },   // displacement back above 98
};

function ctx(over: Partial<Context> = {}, marks: Record<string, Bar> = chart, end = T): Context {
  const candles = m15(marks, end);
  return {
    symbol: 'SOLUSDT', t: end, config: cfg, price: candles[candles.length - 1].close, speed: 'normal', funding: null,
    m15: series(candles), h1: series(h1(80, 100, end)), h4: series(h4(end)),
    atr15m: [1], atr1h: [2], pivots1h: [], pivots4h: [pivot('high', 10, 120), pivot('low', 15, 90)],
    analysis: { structure: { '4h': null }, profiles: [{ name: '24h', val: 98.8, vah: 101, poc: 100 }] },
    ...over,
  } as unknown as Context;
}

describe('Model 3: session sweep', () => {
  it('a sweep of the Asian low, closed back above on a displacement candle, in an uptrend and in discount', () => {
    const s = sessionSweep(ctx(), 'long')!;
    expect(s).not.toBeNull();
    expect(s.swept).toMatchObject({ name: 'asian_low', price: 98 });
    expect(s.extreme).toBe(97);
    // Stop: the sweep low minus 0.3 x ATR(15m). Take-profit: the nearest buy-side level at least 2R away.
    expect(s.plan!.stop).toBeCloseTo(97 - 0.3, 9);
    expect(s.plan).toMatchObject({ entry: 100.3, target: 112, targetSource: 'PDH' });
    expect(s.plan!.rewardRisk).toBeCloseTo((112 - 100.3) / (100.3 - 96.7), 9);
    // The Asian high at 103 is nearer but under 2R, so it is passed over.
    expect(s.confluence).toContain('value_reacceptance');
  });

  it('nothing without the displacement candle', () => {
    const weak = { ...chart, '2026-07-15T08:45Z': { open: 98.6, high: 98.9, low: 98.4, close: 98.8 } };
    expect(sessionSweep(ctx({}, weak), 'long')).toBeNull();
  });

  it('nothing against the trend, or in premium', () => {
    expect(sessionSweep(ctx({ h1: series(h1(120, 100)) }), 'long')).toBeNull();
    expect(sessionSweep(ctx({ pivots4h: [pivot('high', 10, 102), pivot('low', 15, 90)] }), 'long')).toBeNull();   // 0.86 of the range
  });

  it('nothing when the level was first broken before the last hour', () => {
    // An hour later: a second dip under 98 and another displacement close above it. The Asian low was
    // first traded through at 08:15, before this window (09:00-09:45), so it is no longer intact.
    const later = {
      ...chart,
      '2026-07-15T09:15Z': { open: 100, high: 100.1, low: 97.5, close: 98.4 },
      '2026-07-15T09:30Z': { open: 98.4, high: 98.7, low: 98.2, close: 98.5 },
      '2026-07-15T09:45Z': { open: 98.5, high: 100.2, low: 98.3, close: 100.1 },
    };
    expect(sessionSweep(ctx({}, later, u('2026-07-15T10:00Z')), 'long')).toBeNull();
  });

  it('short mirrors long: a sweep of the Asian high in a downtrend, in premium, take-profit at sell-side liquidity', () => {
    const down = {
      '2026-07-14T12:00Z': { high: 112 }, '2026-07-14T18:00Z': { low: 95 },
      '2026-07-15T04:00Z': { high: 103 }, '2026-07-15T02:00Z': { low: 98 },
      '2026-07-15T08:15Z': { open: 100.2, high: 104, low: 100, close: 101.5 },      // sweeps the Asian high
      '2026-07-15T08:30Z': { open: 101.5, high: 101.8, low: 101.1, close: 101.4 },
      '2026-07-15T08:45Z': { open: 101.4, high: 101.6, low: 99.6, close: 99.7 },    // displacement back below 103
    };
    const s = sessionSweep(ctx({ h1: series(h1(120, 100)), pivots4h: [pivot('high', 10, 110), pivot('low', 15, 80)] }, down), 'short')!;
    expect(s.swept).toMatchObject({ name: 'asian_high', price: 103 });
    expect(s.plan!.stop).toBeCloseTo(104.3, 9);
    // Sell-side levels below: Asian low 98 (0.37R), PDL 95 (1.0R), 4h swing low 80 (4.3R): the first at 2R.
    expect(s.plan).toMatchObject({ target: 80, targetSource: '4h_swing_low' });
  });
});

describe('Model 3 in the engine', () => {
  // Winter, so 09:00 UTC is inside the London killzone (07:00-10:00 GMT). Thursday.
  const E = u('2026-01-15T09:00Z');
  const shift = E - T;   // move the summer chart to the winter date
  const bar = (tf: Candle['tf'], openTime: number, ms: number, o: number, h: number, l: number, c: number): Candle =>
    ({ symbol: 'SOLUSDT', tf, openTime, closeTime: openTime + ms, open: o, high: h, low: l, close: c, volume: 10, quoteVolume: 1000, trades: 1 });

  function setup(over: (c: ReturnType<typeof loadConfig>) => void = () => {}) {
    const config = loadConfig('engine/config/config.yaml');
    config.models.pullback = false;   // only the sweep model here
    over(config);
    const e = new Engine({ config, configHash: 't', engineVersion: 't' });
    const m = m15(chart).map((c) => ({ ...c, openTime: c.openTime + shift, closeTime: c.closeTime + shift }));
    // A liquid coin: $10M an hour (the engine never takes more than 1% of the last hour's volume).
    const h = h1(80, 100, E, 400).map((c) => ({ ...c, quoteVolume: 10_000_000 }));
    // 4h: flat, with one swing high at 120 and one swing low at 90 (the dealing range: price 100 is in discount).
    const four = Array.from({ length: 40 }, (_, i) => {
      const open = E - (40 - i) * 4 * H;
      return bar('4h', open, 4 * H, 100, i === 20 ? 120 : 101, i === 28 ? 90 : 99, 100);
    });
    e.seedHistory([...four, ...h, ...m.slice(0, -1)]);
    e.setUniverse(['SOLUSDT']);
    const last = m[m.length - 1];
    return { e, last };
  }
  const minute = (open: number, price: number) => bar('1m', open, 60_000, price, price + 0.05, price - 0.05, price);

  it('takes the sweep inside the killzone: a session_sweep signal and a market order', () => {
    const { e, last } = setup();
    const out = e.onCandles([minute(E - 60_000, 100.3), last]);
    const sig = e.takeSignals().find((s) => s.setup === 'session_sweep');
    expect(sig).toMatchObject({ status: 'taken', direction: 'long', payload: { model: 'session_sweep', swept: { name: 'asian_low', price: 98 }, target: { name: 'PDH' } } });
    expect(out.filter((x) => x.type === 'order_placed')).toHaveLength(1);
  });

  it('one signal per swept level: the next close does not take it again', () => {
    // A 50% minimum profit skips the first signal, so no position makes the coin busy.
    const { e, last } = setup((c) => { c.exits.min_target_pct = 50; });
    e.onCandles([minute(E - 60_000, 100.3), last]);
    expect(e.takeSignals().filter((s) => s.setup === 'session_sweep').map((s) => s.reason)).toEqual(['profit_too_small']);
    // 09:15: another displacement close above 98, with the 08:15 sweep still in the last hour.
    const next = { ...last, openTime: last.openTime + 900_000, closeTime: last.closeTime + 900_000, open: 98.6, close: 100.4, high: 100.5 };
    e.onCandles([minute(E + 14 * 60_000, 100.4), next]);
    expect(e.takeSignals().filter((s) => s.setup === 'session_sweep')).toHaveLength(0);
  });

  it('nothing outside the killzone: the same close with the London window ending at 08:30', () => {
    const { e, last } = setup((c) => { c.sessions.killzones = [{ name: 'london', tz: 'Europe/London', start: '07:00', end: '08:30' }]; });
    e.onCandles([minute(E - 60_000, 100.3), last]);
    expect(e.takeSignals().filter((s) => s.setup === 'session_sweep')).toHaveLength(0);
  });
});
