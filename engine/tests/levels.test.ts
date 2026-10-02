import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { clusterLevels, tradeIdea } from '../src/analysis/levels';
import { series, type Context } from '../src/strategy/context';
import type { Pivot } from '../src/analysis/indicators';
import type { Zone } from '../src/analysis/zones';
import type { TrendState } from '../src/analysis/trendState';
import type { Candle } from '../../shared/types';

const cfg = loadConfig('engine/config/config.yaml');
// Tested at fixed limits, whatever the live config uses.
cfg.exits.min_rr = 2;
cfg.exits.max_stop_pct = 2.5;
const T = Date.UTC(2026, 8, 28, 10, 0);
const flat = (n: number, v: number) => new Array<number>(n).fill(v);
const pivot = (type: 'high' | 'low', index: number, price: number): Pivot => ({ type, index, price, confirmedAt: index + 3 });
const candle = (i: number, o: number, h: number, l: number, c: number, tf: Candle['tf']): Candle => {
  const ms = tf === '15m' ? 900_000 : 3_600_000;
  const closeTime = T - (59 - i) * ms;
  return { symbol: 'SOLUSDT', tf, openTime: closeTime - ms, closeTime, open: o, high: h, low: l, close: c, volume: 100, quoteVolume: 100 * c, trades: 1 };
};
const state = (s: string) => ({ state: s as TrendState, emaAligned: true, tradable: s === 'strong' || s === 'pullback' });
const zone = (over: Partial<Zone>): Zone => ({
  id: 'z', symbol: 'SOLUSDT', tf: '1h', type: 'demand', low: 96, high: 97, baseStart: 0, createdAt: 0,
  impulseStrength: 2, touches: 0, status: 'fresh', invalidatedAt: null, score: 2, ...over,
});

/**
 * Price 100, 1h ATR 2 (merge tolerance 1). 1h candles all today (no previous
 * day range), VWAP and EMAs far away unless a test places them.
 */
function ctx(over: Partial<Context> = {}, long = 'pullback', short = 'reversed'): Context {
  const today = (i: number) => ({ ...candle(i, 100, 100.5, 99.5, 100, '1h'), openTime: T - 3_600_000 + i, closeTime: T + i });
  return {
    symbol: 'SOLUSDT', t: T, config: cfg,
    analysis: { symbol: 'SOLUSDT', asOf: T, structure: { '4h': null, '1h': null, '15m': null }, ema4h: { fast: 90, slow: 80, close: 100 }, long: state(long), short: state(short), zones: [], fvgs: [], profiles: [], trendMeter: { '4h': { structure: null, supertrend: null, line: null }, '1h': { structure: null, supertrend: null, line: null }, '15m': { structure: null, supertrend: null, line: null } }, adx1h: null },
    h4: series([]), h1: series(Array.from({ length: 60 }, (_, i) => today(i))), m15: series(Array.from({ length: 60 }, (_, i) => candle(i, 100, 100.5, 99.5, 100, '15m'))),
    price: 100, atr1h: flat(60, 2), atr15m: flat(60, 1),
    ema1h: { 20: flat(60, 300), 50: flat(60, 300) }, ema15m20: flat(60, 100), vwap15m: flat(60, 300),
    rsi15m: flat(60, 50), rvol15m: flat(60, 1), adx1h: flat(60, 30), chop1h: flat(60, 40), bbw1h: flat(60, 0.02),
    pivots1h: [], pivots15m: [], pivots4h: [], btcChange1hPct: 0, btcAnalysis: null, funding: null,
    ...over,
  };
}

describe('key levels', () => {
  it('merges levels within the tolerance and sums their weight', () => {
    const c = clusterLevels([
      { price: 95, source: 'a', weight: 1 }, { price: 95.8, source: 'b', weight: 1 }, { price: 99, source: 'c', weight: 2 }, { price: 110, source: 'd', weight: 1 },
    ], 100, 1);
    expect(c.map((l) => [Number(l.price.toFixed(2)), l.sources, l.strength, l.kind])).toEqual([
      [95.4, ['a', 'b'], 2, 'support'], [99, ['c'], 2, 'support'], [110, ['d'], 1, 'resistance'],
    ]);
  });
});

describe('key levels, dense', () => {
  it('a run of levels each close to the next does not chain into one wide cluster', () => {
    const run = Array.from({ length: 20 }, (_, i) => ({ price: 90 + i * 0.6, source: `s${i}`, weight: 1 }));
    const c = clusterLevels(run, 100, 1);
    expect(c.length).toBeGreaterThanOrEqual(10);
    for (const l of c) expect(Math.max(...l.sources.map((s) => 90 + Number(s.slice(1)) * 0.6)) - Math.min(...l.sources.map((s) => 90 + Number(s.slice(1)) * 0.6))).toBeLessThanOrEqual(1);
  });
});

describe('trade plan', () => {
  // A fresh demand zone 96-97 under a 1h swing low at 96.2, resistance clusters at 104 and 108.
  const longCtx = () => {
    const c = ctx({ pivots1h: [pivot('low', 30, 96.2), pivot('high', 40, 104), pivot('high', 50, 108)], vwap15m: flat(60, 104.3) });
    c.analysis.zones = [zone({})];
    return c;
  };

  it('long: enters from the strongest support below, stop beyond it, one take-profit with R after costs', () => {
    const idea = tradeIdea(longCtx(), { armed: [], entryBlock: null });
    expect(idea.bias).toBe('long');
    const p = idea.plan!;
    expect(p.status).toBe('wait');
    // Zone 96-97 plus the swing low at 96.2 merge; the area widens by half the tolerance each side.
    expect(p.entryLow).toBeCloseTo(95.5, 9);
    expect(p.entryHigh).toBeCloseTo(97.5, 9);
    expect(p.entry).toBeCloseTo(96.5, 9);
    expect(p.stop).toBeCloseTo(95.5 - cfg.exits.stop_buffer_atr * 2, 9);
    // One take-profit: the first level ahead, swing high 104 and VWAP 104.3 (equal weight), however far.
    expect(p.targets).toHaveLength(1);
    expect(p.targets.map((t) => Number(t.price.toFixed(2)))).toEqual([104.15]);
    expect(p.targets[0]).toMatchObject({ label: 'TP', sources: ['1h swing high', 'daily VWAP'] });
    expect(p.targetPct).toBeCloseTo((p.targets[0].price / 96.5 - 1) * 100, 9);
    const risk = 96.5 - p.stop!;
    const costR = (0.2 / 100) * 96.5 / risk;
    expect(p.targets[0].r).toBeCloseTo((p.targets[0].price - 96.5) / risk - costR, 9);
  });

  it('with no level ahead, the take-profit is the fixed percentage', () => {
    const c = ctx({ pivots1h: [pivot('low', 30, 96.2)] });
    c.analysis.zones = [zone({ type: 'demand', low: 96, high: 97 })];
    const p = tradeIdea(c, { armed: [], entryBlock: null }).plan!;
    expect(p.entry).not.toBeNull();
    expect(p.targets[0].sources).toEqual([`+${cfg.exits.fixed_target_pct}% target`]);
    expect(p.targets[0].price).toBeCloseTo(p.entry! * (1 + cfg.exits.fixed_target_pct / 100), 9);
  });

  it('a signal needs the take-profit at least 3% away and at least 2R', () => {
    const c = longCtx();
    c.pivots1h = [...c.pivots1h, pivot('high', 55, 98.5)];   // a level 2.07% above the entry (1.25R): the TP
    const p = tradeIdea(c, { armed: [], entryBlock: null }).plan!;
    expect(p.meetsRules).toBe(false);
    expect(p.note).toMatch(/under the 3% minimum/);
    expect(p.note).toMatch(/Not a signal/);
  });

  it('in the entry area when price is inside it; armed when the engine armed that side', () => {
    const c = longCtx();
    c.price = 97;
    expect(tradeIdea(c, { armed: [], entryBlock: null }).plan!.status).toBe('in_zone');
    expect(tradeIdea(c, { armed: ['long'], entryBlock: null }).plan!.status).toBe('armed');
    expect(tradeIdea(c, { armed: ['short'], entryBlock: null }).plan!.status).toBe('in_zone');
  });

  it('stages: waiting for retest, then confirmation, then confirmed (taken or skipped) and in the trade', () => {
    expect(tradeIdea(longCtx(), { armed: [], entryBlock: null }).plan).toMatchObject({ status: 'wait', confirmation: null });
    const c = longCtx();
    c.price = 97;
    const taken = { direction: 'long' as const, time: c.t, taken: true, reason: null };
    const idea = tradeIdea(c, { armed: [], entryBlock: null, confirmed: [taken] });
    expect(idea.plan).toMatchObject({ status: 'confirmed', confirmation: { time: c.t, taken: true, reason: null } });
    expect(idea.checklist.find((x) => x.label.startsWith('Confirmation'))!.ok).toBe(true);
    expect(tradeIdea(c, { armed: [], entryBlock: null, confirmed: [taken], inTrade: ['long'] }).plan!.status).toBe('in_trade');
    const skipped = tradeIdea(c, { armed: [], entryBlock: null, confirmed: [{ ...taken, taken: false, reason: 'filter_chop' }] }).plan!;
    expect(skipped.status).toBe('confirmed');
    expect(skipped.note).toContain('skipped it (filter chop)');
    // A confirmation on the other side does not count.
    expect(tradeIdea(c, { armed: [], entryBlock: null, confirmed: [{ ...taken, direction: 'short' }] }).plan!.status).toBe('in_zone');
  });

  it('short mirrors long', () => {
    const c = ctx({ pivots1h: [pivot('high', 30, 103.8), pivot('low', 40, 96), pivot('low', 50, 92)] }, 'reversed', 'pullback');
    c.analysis.zones = [zone({ type: 'supply', low: 103, high: 104 })];
    const p = tradeIdea(c, { armed: [], entryBlock: null }).plan!;
    expect(p.direction).toBe('short');
    expect(p.entryLow).toBeCloseTo(102.5, 9);
    expect(p.entryHigh).toBeCloseTo(104.5, 9);
    expect(p.stop).toBeCloseTo(104.5 + cfg.exits.stop_buffer_atr * 2, 9);
    expect(p.targets.map((t) => t.price)).toEqual([96]);   // one TP: the first support below
  });

  it('a short never enters from a demand zone, even with price inside it', () => {
    // Price 100 inside a demand zone 99-101; resistance from a 1h swing high at 104.
    const c = ctx({ pivots1h: [pivot('low', 40, 92), pivot('high', 50, 104)] }, 'reversed', 'pullback');
    c.analysis.zones = [zone({ type: 'demand', low: 99, high: 101 })];
    const p = tradeIdea(c, { armed: [], entryBlock: null }).plan!;
    expect(p.entryLow).toBeCloseTo(103.5, 9);
    expect(p.status).toBe('wait');
  });

  it('no plan without a trend; no_level when nothing is in reach', () => {
    expect(tradeIdea(ctx({}, 'none', 'none'), { armed: [], entryBlock: null })).toMatchObject({ bias: 'none', plan: null });
    const far = ctx({ pivots1h: [pivot('low', 30, 80), pivot('high', 40, 104)] });
    expect(tradeIdea(far, { armed: [], entryBlock: null }).plan).toMatchObject({ status: 'no_level', entry: null });
  });

  it('fibonacci, EMA and VWAP levels alone are never targets', () => {
    const c = longCtx();
    c.ema1h = { 20: flat(60, 101.5), 50: flat(60, 300) };
    const targets = tradeIdea(c, { armed: [], entryBlock: null }).plan!.targets;
    expect(targets.every((t) => t.sources.some((s) => !/^fib |EMA|VWAP/.test(s)))).toBe(true);
  });

  it('says when the plan breaks the engine\'s limits', () => {
    const fits = tradeIdea(longCtx(), { armed: [], entryBlock: null }).plan!;
    expect(fits.meetsRules).toBe(true);                     // 1.66% stop, first target 4.7R
    const c = longCtx();
    c.pivots1h = [...c.pivots1h, pivot('high', 55, 98.5)];  // resistance 1.25R above the entry
    const tight = tradeIdea(c, { armed: [], entryBlock: null }).plan!;
    expect(tight.meetsRules).toBe(false);
    expect(tight.note).toMatch(/under the 2R minimum/);
  });
});

describe('checklist and levels to wait for', () => {
  const longCtx = () => {
    const c = ctx({ pivots1h: [pivot('low', 30, 96.2), pivot('high', 40, 104), pivot('high', 50, 108)], vwap15m: flat(60, 104.3), funding: 0.0001, btcChange1hPct: -0.5 });
    c.analysis.zones = [zone({})];
    c.analysis.structure = { '4h': { trend: 'up', broken: null, protectedLow: 90, protectedHigh: null, highs: [], lows: [] }, '1h': { trend: 'down', broken: null, protectedLow: null, protectedHigh: 110, highs: [], lows: [] }, '15m': null };
    c.analysis.adx1h = 24;
    return c;
  };

  it('marks each condition met, not met or pending, for the plan direction', () => {
    const idea = tradeIdea(longCtx(), { armed: [], entryBlock: 'session_ending' });
    expect(idea.checklistFor).toBe('long');
    const byLabel = Object.fromEntries(idea.checklist.map((i) => [i.label, i.ok]));
    expect(byLabel['4h trend up']).toBe(true);
    expect(byLabel['1h trend up too']).toBe(false);
    expect(byLabel['Trend strong enough (1h ADX ≥ 20)']).toBe(true);
    expect(byLabel['Entries open now (session)']).toBe(false);
    expect(byLabel['Retest: price in the entry area']).toBe(false);
    expect(byLabel['Confirmation: 15m close back in the trend direction']).toBeNull();
    expect(byLabel['Stop within 2.5%']).toBe(true);
    expect(byLabel['Funding not against the trade']).toBe(true);
    expect(byLabel['BTC not moving against it (1h)']).toBe(true);
  });

  it('with a plan: buy area, invalidation, targets and the breakout level, nearest first', () => {
    const w = tradeIdea(longCtx(), { armed: [], entryBlock: null }).watch;
    expect(w.map((x) => x.kind)).toContain('entry');
    expect(w.map((x) => x.kind)).toContain('invalidation');
    expect(w.filter((x) => x.kind === 'target').length).toBeGreaterThan(0);
    for (let i = 1; i < w.length; i++) expect(Math.abs(w[i].distancePct)).toBeGreaterThanOrEqual(Math.abs(w[i - 1].distancePct));
  });

  it('without a trend: the range top and bottom to watch', () => {
    const c = ctx({ pivots1h: [pivot('low', 30, 96), pivot('high', 40, 104)] }, 'none', 'none');
    const w = tradeIdea(c, { armed: [], entryBlock: null }).watch;
    // Both 4% away: a tie, so compare without order. Retracement levels (fib 0.5/0.618 at 100/99.1) are not range edges.
    expect(Object.fromEntries(w.map((x) => [x.kind, x.price]))).toEqual({ range_bottom: 96, range_top: 104 });
  });

  it('quality: checklist, reward:risk, stage and the rules; confirmed ranks above waiting', () => {
    const c = longCtx();
    const waiting = tradeIdea(c, { armed: [], entryBlock: null });
    c.price = 97;
    const confirmed = tradeIdea(c, { armed: [], entryBlock: null, confirmed: [{ direction: 'long', time: c.t, taken: true, reason: null }] });
    const skipped = tradeIdea(c, { armed: [], entryBlock: null, confirmed: [{ direction: 'long', time: c.t, taken: false, reason: 'filter_chop' }] });
    for (const i of [waiting, confirmed, skipped]) { expect(i.quality).toBeGreaterThanOrEqual(0); expect(i.quality).toBeLessThanOrEqual(100); }
    expect(confirmed.quality).toBeGreaterThan(skipped.quality);
    expect(tradeIdea(ctx({}, 'none', 'none'), { armed: [], entryBlock: null }).quality).toBeLessThanOrEqual(50);   // no plan: checklist only
  });

  it('if a level breaks: the next key levels beyond it, nearest first', () => {
    const c = ctx({ pivots1h: [pivot('low', 20, 92), pivot('low', 30, 96), pivot('high', 40, 104), pivot('high', 45, 110)] }, 'none', 'none');
    const w = tradeIdea(c, { armed: [], entryBlock: null }).watch;
    expect(w.find((x) => x.kind === 'range_top')!.ifBroken!.map((n) => n.price)).toEqual([110]);
    expect(w.find((x) => x.kind === 'range_bottom')!.ifBroken!.map((n) => n.price)).toEqual([92]);
    const withPlan = tradeIdea(longCtx(), { armed: [], entryBlock: null }).watch;
    for (const x of withPlan.filter((x) => x.kind === 'target')) for (const n of x.ifBroken ?? []) expect(n.price).toBeGreaterThan(x.price);
  });
});
