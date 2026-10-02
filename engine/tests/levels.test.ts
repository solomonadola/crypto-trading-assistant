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

/**
 * A v3 context: 1h closes rising (or falling) over 260 hours, a 4h range of
 * 90-120 (or 80-110), and 15m candles over two days flat at 100 (highs 100.5,
 * lows 99.5) except a previous-day high of 106 and low of 94. Price 100.
 */
function v3Ctx(side: 'long' | 'short' = 'long', over: Partial<Context> = {}): Context {
  const H = 3_600_000;
  const h1 = Array.from({ length: 260 }, (_, i) => {
    const c = side === 'long' ? 80 + (20 * i) / 259 : 120 - (20 * i) / 259;
    const closeTime = T - (259 - i) * H;
    return { symbol: 'SOLUSDT', tf: '1h' as const, openTime: closeTime - H, closeTime, open: c, high: c + 0.3, low: c - 0.3, close: c, volume: 1, quoteVolume: 100, trades: 1 };
  });
  const h4 = Array.from({ length: 30 }, (_, i) => ({ ...candle(i, 100, 101, 99, 100, '1h'), tf: '4h' as const, openTime: T - (30 - i) * 4 * H, closeTime: T - (29 - i) * 4 * H }));
  const day = Math.floor(T / 86_400_000) * 86_400_000;
  const m15: Candle[] = [];
  for (let open = day - 86_400_000; open + 900_000 <= T; open += 900_000) {
    const pdh = open === day - 12 * H ? 106 : 100.5;
    const pdl = open === day - 6 * H ? 94 : 99.5;
    m15.push({ symbol: 'SOLUSDT', tf: '15m', openTime: open, closeTime: open + 900_000, open: 100, high: pdh, low: pdl, close: 100, volume: 1, quoteVolume: 100, trades: 1 });
  }
  const c = ctx({
    h1: series(h1), h4: series(h4), m15: series(m15), atr15m: flat(m15.length, 2), speed: 'normal',
    pivots4h: side === 'long' ? [pivot('high', 10, 120), pivot('low', 15, 90)] : [pivot('high', 10, 110), pivot('low', 15, 80)],
    ...over,
  });
  c.analysis.zones = [side === 'long' ? zone({}) : zone({ type: 'supply', low: 103, high: 104 })];
  return c;
}

describe('trade plan (the models\' rules)', () => {
  it('long: entry at the demand zone, stop beyond it plus the speed buffer, one take-profit at liquidity at 2R', () => {
    const idea = tradeIdea(v3Ctx(), { armed: [], entryBlock: null });
    expect(idea.bias).toBe('long');
    const p = idea.plan!;
    expect(p).toMatchObject({ status: 'wait', entryLow: 96, entryHigh: 97, entry: 97 });
    expect(p.stop).toBeCloseTo(96 - 0.3 * 2, 9);                      // 0.3 x ATR(15m) for a normal coin
    // The nearest intact buy-side liquidity is at 100.5 (Asian and London highs): 3.5 / 1.6 = 2.19R raw.
    expect(p.targets).toHaveLength(1);
    expect(p.targets[0]).toMatchObject({ label: 'TP', price: 100.5, sources: ['Asian high'] });
    const costR = (0.2 / 100) * 97 / 1.6;
    expect(p.targets[0].r).toBeCloseTo(3.5 / 1.6 - costR, 9);
    expect(p.targetPct).toBeCloseTo((3.5 / 97) * 100, 9);
    expect(p.meetsRules).toBe(true);
  });

  it('stages: waiting for the retest, in the zone, armed, confirmed (taken or skipped), in the trade', () => {
    const c = v3Ctx();
    expect(tradeIdea(c, { armed: [], entryBlock: null }).plan!.status).toBe('wait');
    c.price = 96.8;
    expect(tradeIdea(c, { armed: [], entryBlock: null }).plan!.status).toBe('in_zone');
    expect(tradeIdea(c, { armed: ['long'], entryBlock: null }).plan!.status).toBe('armed');
    const taken = { direction: 'long' as const, time: c.t, taken: true, reason: null };
    expect(tradeIdea(c, { armed: [], entryBlock: null, confirmed: [taken] }).plan).toMatchObject({ status: 'confirmed', confirmation: { taken: true } });
    expect(tradeIdea(c, { armed: [], entryBlock: null, confirmed: [taken], inTrade: ['long'] }).plan!.status).toBe('in_trade');
    const skipped = tradeIdea(c, { armed: [], entryBlock: null, confirmed: [{ ...taken, taken: false, reason: 'no_sweep' }] }).plan!;
    expect(skipped.note).toContain('skipped it (no sweep)');
  });

  it('not a signal outside discount, or with a stop too wide', () => {
    const premium = tradeIdea(v3Ctx('long', { pivots4h: [pivot('high', 10, 101), pivot('low', 15, 90)] }), { armed: [], entryBlock: null }).plan!;
    expect(premium.meetsRules).toBe(false);
    expect(premium.note).toMatch(/not in discount/);
    const wide = v3Ctx();
    wide.config = { ...cfg, exits: { ...cfg.exits, max_stop_pct: 1 } };
    expect(tradeIdea(wide, { armed: [], entryBlock: null }).plan!.note).toMatch(/beyond the 1% limit/);
  });

  it('short mirrors long: entry at the supply zone, take-profit at sell-side liquidity', () => {
    const p = tradeIdea(v3Ctx('short'), { armed: [], entryBlock: null }).plan!;
    expect(p).toMatchObject({ direction: 'short', entryLow: 103, entryHigh: 104, entry: 103 });
    expect(p.stop).toBeCloseTo(104.6, 9);
    expect(p.targets[0]).toMatchObject({ price: 99.5, sources: ['Asian low'] });
  });

  it('a short never enters from a demand zone; no plan without a trend', () => {
    const c = v3Ctx('short');
    c.analysis.zones = [zone({})];   // only a demand zone
    expect(tradeIdea(c, { armed: [], entryBlock: null }).plan).toMatchObject({ status: 'no_level', entry: null, targets: [] });
    expect(tradeIdea(ctx(), { armed: [], entryBlock: null })).toMatchObject({ bias: 'none', plan: null });   // 60 flat 1h candles: no trend
  });

  it('the checklist follows the models', () => {
    const idea = tradeIdea(v3Ctx('long', { funding: 0.0001 }), { armed: [], entryBlock: 'outside_killzone' });
    const ok = Object.fromEntries(idea.checklist.map((i) => [i.label, i.ok]));
    expect(ok['1h trend up: close above EMA200, EMA50 rising']).toBe(true);
    expect(ok['4h structure not down']).toBeNull();                    // unknown in this fixture
    expect(ok['In discount (4h range)']).toBe(true);
    expect(ok['Entries open now (killzone, weekday)']).toBe(false);
    expect(ok['Retest: price in the demand zone / order block']).toBe(false);
    expect(ok['Liquidity taken, then a 15m CHoCH on a displacement candle']).toBeNull();
    expect(ok['Take-profit at least 2R']).toBe(true);
    expect(ok['Take-profit at least 3% away']).toBe(true);
    expect(ok['Stop within 2.5%']).toBe(true);
    expect(ok['Funding not against the trade']).toBe(true);
  });

  it('levels to wait for: the zone, the stop, the take-profit and the sweep levels for Model 3, nearest first', () => {
    const w = tradeIdea(v3Ctx(), { armed: [], entryBlock: null }).watch;
    const kinds = w.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['entry', 'invalidation', 'target', 'sweep']));
    // Sweep levels are intact sell-side liquidity under the price: the Asian/London lows at 99.5, then the PDL at 94.
    expect(w.filter((x) => x.kind === 'sweep').map((x) => x.price)).toEqual([99.5, 99.5]);
    for (let i = 1; i < w.length; i++) expect(Math.abs(w[i].distancePct)).toBeGreaterThanOrEqual(Math.abs(w[i - 1].distancePct));
  });

  it('quality: checklist, reward:risk, stage and the rules; confirmed ranks above skipped', () => {
    const c = v3Ctx();
    c.price = 96.8;
    const confirmed = tradeIdea(c, { armed: [], entryBlock: null, confirmed: [{ direction: 'long', time: c.t, taken: true, reason: null }] });
    const skipped = tradeIdea(c, { armed: [], entryBlock: null, confirmed: [{ direction: 'long', time: c.t, taken: false, reason: 'no_sweep' }] });
    for (const i of [confirmed, skipped]) { expect(i.quality).toBeGreaterThanOrEqual(0); expect(i.quality).toBeLessThanOrEqual(100); }
    expect(confirmed.quality).toBeGreaterThan(skipped.quality);
    expect(tradeIdea(ctx(), { armed: [], entryBlock: null }).quality).toBeLessThanOrEqual(50);   // no plan: checklist only
  });
});

describe('levels to wait for without a trend', () => {
  it('the range top and bottom', () => {
    const c = ctx({ pivots1h: [pivot('low', 30, 96), pivot('high', 40, 104)] }, 'none', 'none');
    const w = tradeIdea(c, { armed: [], entryBlock: null }).watch;
    // Both 4% away: a tie, so compare without order. Retracement levels (fib 0.5/0.618 at 100/99.1) are not range edges.
    expect(Object.fromEntries(w.map((x) => [x.kind, x.price]))).toEqual({ range_bottom: 96, range_top: 104 });
  });

  it('if a level breaks: the next key levels beyond it, nearest first', () => {
    const c = ctx({ pivots1h: [pivot('low', 20, 92), pivot('low', 30, 96), pivot('high', 40, 104), pivot('high', 45, 110)] }, 'none', 'none');
    const w = tradeIdea(c, { armed: [], entryBlock: null }).watch;
    expect(w.find((x) => x.kind === 'range_top')!.ifBroken!.map((n) => n.price)).toEqual([110]);
    expect(w.find((x) => x.kind === 'range_bottom')!.ifBroken!.map((n) => n.price)).toEqual([92]);
  });
});
