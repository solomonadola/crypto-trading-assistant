import { describe, expect, it } from 'vitest';
import { analyzeStructure, type TfStructure } from '../src/analysis/structure';
import { combinedState, type Direction, type TrendState } from '../src/analysis/trendState';
import { detectZones, type Zone } from '../src/analysis/zones';
import { Engine } from '../src/core/engine';
import { loadConfig } from '../src/config';
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../../shared/types';

const config = loadConfig('engine/config/config.yaml');
const K = config.trend.swing_lookback;

/** Prices walking in straight lines between waypoints, `steps` candles per leg. */
function path(waypoints: number[], steps = 5): number[] {
  const out = [waypoints[0]];
  for (let w = 1; w < waypoints.length; w++) {
    for (let s = 1; s <= steps; s++) out.push(waypoints[w - 1] + ((waypoints[w] - waypoints[w - 1]) * s) / steps);
  }
  return out;
}

/** One candle per price: a small range around it, so swing points fall exactly on the waypoints. */
const cols = (prices: number[]) => ({ high: prices.map((p) => p + 0.1), low: prices.map((p) => p - 0.1), close: prices });

function candles(symbol: string, tf: Timeframe, prices: number[], start = Date.UTC(2026, 0, 1)): Candle[] {
  const ms = TIMEFRAME_MS[tf];
  return prices.map((p, i) => ({
    symbol, tf, openTime: start + i * ms, closeTime: start + (i + 1) * ms,
    open: p, high: p + 0.1, low: p - 0.1, close: p, volume: 100, quoteVolume: 100 * p, trades: 1,
  }));
}

/** Rising zigzag: up 4, down 2, `cycles` times, ending partway up a leg. */
const risingWaypoints = (cycles: number, start = 10) => {
  const w = [start];
  for (let i = 0; i < cycles; i++) w.push(w[w.length - 1] + 4, w[w.length - 1] + 2);
  w.push(w[w.length - 1] + 1);
  return w;
};

describe('market structure', () => {
  const up = path([10, 14, 12, 16, 14, 18, 16, 17]);

  it('rising highs and lows: up, protected by the low before the last higher high', () => {
    const s = analyzeStructure(cols(up), K);
    expect(s.trend).toBe('up');
    expect(s.broken).toBeNull();
    expect(s.highs.map((h) => h.price)).toEqual([16.1, 18.1]);
    expect(s.lows.map((l) => l.price)).toEqual([13.9, 15.9]);
    expect(s.protectedLow).toBe(13.9);
  });

  it('a close below the protected low breaks the up trend', () => {
    const s = analyzeStructure(cols(path([10, 14, 12, 16, 14, 18, 16, 17, 13.5])), K);
    expect(s.trend).toBe('none');
    expect(s.broken).toBe('up');
  });

  it('a wick below the protected low does not break it', () => {
    const c = cols(up);
    c.low[c.low.length - 2] = 13;          // wick far below 13.9, close stays at the path
    expect(analyzeStructure(c, K).trend).toBe('up');
  });

  it('after the break, a lower high and lower low confirm down', () => {
    const s = analyzeStructure(cols(path([10, 14, 12, 16, 14, 18, 16, 17, 13.5, 15.5, 12, 14])), K);
    expect(s.trend).toBe('down');
    expect(s.protectedHigh).toBe(15.6);
    expect(s.broken).toBeNull();
  });

  it('down mirrors up', () => {
    const s = analyzeStructure(cols(up.map((p) => 30 - p)), K);
    expect(s.trend).toBe('down');
    expect(s.protectedHigh).toBeCloseTo(16.1, 9);
  });

  it('too few swings: no trend', () => {
    expect(analyzeStructure(cols(path([10, 14, 12])), K)).toMatchObject({ trend: 'none', broken: null });
  });

  it('never uses a swing point before it is confirmed', () => {
    // The last higher high at 18 needs K candles after it; one candle after it, it is not a swing yet.
    const early = path([10, 14, 12, 16, 14, 18]);
    const s = analyzeStructure(cols([...early, 17.8]), K);
    expect(s.highs.map((h) => h.price)).toEqual([14.1, 16.1]);
  });
});

describe('combined trend state', () => {
  const tf = (trend: TfStructure['trend'], broken: TfStructure['broken'] = null): TfStructure =>
    ({ trend, broken, protectedLow: null, protectedHigh: null, highs: [], lows: [] });
  const cases: [Direction, TfStructure, TfStructure, TfStructure, TrendState][] = [
    ['long', tf('up'), tf('up'), tf('up'), 'strong'],
    ['long', tf('up'), tf('up'), tf('down'), 'pullback'],
    ['long', tf('up'), tf('up'), tf('none', 'up'), 'pullback'],
    ['long', tf('up'), tf('none', 'up'), tf('down'), 'weakening'],
    ['long', tf('up'), tf('none'), tf('up'), 'none'],
    ['long', tf('none', 'up'), tf('up'), tf('up'), 'transition'],
    ['long', tf('down'), tf('down'), tf('down'), 'reversed'],
    ['long', tf('none'), tf('up'), tf('up'), 'none'],
    ['short', tf('down'), tf('down'), tf('down'), 'strong'],
    ['short', tf('down'), tf('down'), tf('up'), 'pullback'],
    ['short', tf('down'), tf('none', 'down'), tf('up'), 'weakening'],
    ['short', tf('none', 'down'), tf('down'), tf('down'), 'transition'],
    ['short', tf('up'), tf('up'), tf('up'), 'reversed'],
  ];
  it.each(cases)('%s with 4h/1h/15m = %j %j %j is %s', (dir, a, b, c, want) => {
    expect(combinedState(dir, a, b, c)).toBe(want);
  });
});

describe('supply and demand zones', () => {
  const T0 = Date.UTC(2026, 0, 1);
  const bar = (o: number, h: number, l: number, c: number, volume = 100): Omit<Candle, 'openTime' | 'closeTime'> =>
    ({ symbol: 'SOLUSDT', tf: '1h', open: o, high: h, low: l, close: c, volume, quoteVolume: volume * c, trades: 1 });
  const build = (bars: Omit<Candle, 'openTime' | 'closeTime'>[]): Candle[] =>
    bars.map((b, i) => ({ ...b, openTime: T0 + i * 3_600_000, closeTime: T0 + (i + 1) * 3_600_000 }));

  // 25 ordinary candles (bodies of 1, ATR about 2), a 3-candle base, then a large high-volume impulse up.
  const ordinary = Array.from({ length: 25 }, (_, i) => (i % 2 ? bar(101, 101.5, 99.5, 100) : bar(100, 101.5, 99.5, 101)));
  const baseBars = [bar(100.2, 100.7, 99.9, 100.4), bar(100.4, 100.7, 100.0, 100.3), bar(100.3, 100.8, 100.0, 100.5)];
  const impulse = bar(100.5, 105.8, 100.4, 105.5, 400);
  const away = bar(107, 107.5, 106.5, 107);
  const visit = bar(101.5, 102, 100.3, 101);     // low into the zone, close above it
  const setup = [...ordinary, ...baseBars, impulse];
  const zonesOf = (bars: Omit<Candle, 'openTime' | 'closeTime'>[]) => detectZones(build(bars), config.zones);
  const only = (zs: Zone[]) => { expect(zs).toHaveLength(1); return zs[0]; };

  it('finds a demand zone from base to impulse', () => {
    const z = only(zonesOf(setup));
    expect(z).toMatchObject({ type: 'demand', low: 99.9, high: 100.5, touches: 0, status: 'fresh', invalidatedAt: null });
    expect(z.baseStart).toBe(T0 + 25 * 3_600_000);
    expect(z.createdAt).toBe(T0 + 29 * 3_600_000);
    expect(z.impulseStrength).toBeGreaterThan(config.zones.impulse_body_min_atr);
    expect(z.score).toBe(z.impulseStrength);
  });

  it('does not exist before the impulse candle has closed', () => {
    expect(zonesOf([...ordinary, ...baseBars])).toEqual([]);
  });

  it('needs high relative volume on the impulse', () => {
    expect(zonesOf([...ordinary, ...baseBars, { ...impulse, volume: 100 }])).toEqual([]);
  });

  it('counts each return into the zone once, and is invalid after max_touches', () => {
    const once = only(zonesOf([...setup, away, visit, visit, away]));
    expect(once).toMatchObject({ touches: 1, status: 'tested' });
    expect(once.score).toBeCloseTo(once.impulseStrength * 0.6, 12);
    const twice = only(zonesOf([...setup, away, visit, away, visit, away]));
    expect(twice).toMatchObject({ touches: 2, status: 'tested' });
    const thrice = only(zonesOf([...setup, away, visit, away, visit, away, visit]));
    expect(thrice).toMatchObject({ touches: 3, status: 'invalid', score: 0 });
  });

  it('a close below the zone invalidates it; a wick below does not', () => {
    const wick = only(zonesOf([...setup, away, bar(101, 101.5, 99, 100.8)]));
    expect(wick.status).toBe('tested');
    const closed = only(zonesOf([...setup, away, bar(101, 101.5, 99, 99.5)]));
    expect(closed.status).toBe('invalid');
    expect(closed.invalidatedAt).toBe(T0 + 31 * 3_600_000);   // candle 30 of 0..30 closes at hour 31
  });

  it('supply mirrors demand', () => {
    const mirror = (b: Omit<Candle, 'openTime' | 'closeTime'>) => ({ ...b, open: 200 - b.open, close: 200 - b.close, high: 200 - b.low, low: 200 - b.high });
    const z = only(zonesOf(setup.map(mirror)));
    expect(z.type).toBe('supply');
    expect(z.low).toBeCloseTo(99.5, 9);
    expect(z.high).toBeCloseTo(100.1, 9);
  });

  it('a zone found later has the same identity and bounds as when it first appeared', () => {
    const first = only(zonesOf(setup));
    const later = only(zonesOf([...setup, away, visit, away]));
    expect({ ...later, touches: 0, status: 'fresh', score: later.impulseStrength }).toEqual(first);
  });
});

describe('engine analysis', () => {
  const T0 = Date.UTC(2026, 0, 1);
  const rising = path(risingWaypoints(12));
  const at = (tf: Timeframe, prices: number[]) => {
    // Every timeframe's history ends at the same moment.
    const end = T0 + 1000 * TIMEFRAME_MS['4h'];
    return candles('BTCUSDT', tf, prices, end - prices.length * TIMEFRAME_MS[tf]);
  };

  function seeded() {
    const e = new Engine({ config, configHash: 't', engineVersion: 't' });
    e.seedHistory([...at('4h', rising), ...at('1h', rising), ...at('15m', rising)]);
    return e;
  }

  it('4h, 1h and 15m all rising above the 4h EMA: strong and tradable long', () => {
    const a = seeded().analysis('BTCUSDT')!;
    expect(a.structure['4h']!.trend).toBe('up');
    expect(a.long).toEqual({ state: 'strong', emaAligned: true, tradable: true });
    expect(a.short.state).toBe('reversed');
    expect(a.short.tradable).toBe(false);
  });

  it('a 15m break turns strong into pullback at that close, and does not move the clock backwards', () => {
    const e = seeded();
    const last15 = at('15m', rising).at(-1)!;
    const drop = path([last15.close, last15.close - 6], 6).slice(1);
    const next = drop.map((p, i) => ({ ...last15, openTime: last15.openTime + (i + 1) * 900_000, closeTime: last15.closeTime + (i + 1) * 900_000, open: p, high: p + 0.1, low: p - 0.1, close: p }));
    e.onCandles(next);
    const a = e.analysis('BTCUSDT')!;
    expect(a.structure['15m']!.trend).not.toBe('up');
    expect(a.long.state).toBe('pullback');
    expect(a.long.tradable).toBe(true);
    expect(a.asOf).toBe(next.at(-1)!.closeTime);
    expect(e.now()).toBe(next.at(-1)!.closeTime);
  });

  it('seeding history does not move the clock or produce events', () => {
    const e = seeded();
    expect(e.now()).toBe(0);
    expect(e.analysedSymbols()).toEqual(['BTCUSDT']);
  });
});

describe('BTC 1h change in the context', () => {
  it('is measured to the 15m close even when newer BTC minutes are stored', async () => {
    const { buildContext } = await import('../src/strategy/context');
    const e = new Engine({ config, configHash: 't', engineVersion: 't' });
    const T0 = Date.UTC(2026, 0, 1);
    const end = T0 + 1000 * TIMEFRAME_MS['4h'];
    const rising = path(risingWaypoints(12));
    e.seedHistory([...candles('SOLUSDT', '4h', rising, end - rising.length * TIMEFRAME_MS['4h']), ...candles('SOLUSDT', '1h', rising, end - rising.length * TIMEFRAME_MS['1h']), ...candles('SOLUSDT', '15m', rising, end - rising.length * TIMEFRAME_MS['15m'])]);
    // BTC minutes from 2h before the 15m close to 7 minutes after it; price 100 an hour before, 102 at the close.
    const btc = Array.from({ length: 128 }, (_, i) => end - 120 * 60_000 + i * 60_000)
      .map((open) => ({ symbol: 'BTCUSDT', tf: '1m' as const, openTime: open, closeTime: open + 60_000, open: 0, high: 0, low: 0, close: open + 60_000 === end - 3_600_000 ? 100 : open + 60_000 === end ? 102 : 101, volume: 1, quoteVolume: 1, trades: 1 }));
    e.seedHistory(btc);
    const book = (e as unknown as { market: Parameters<typeof buildContext>[0] }).market;
    expect(buildContext(book, 'SOLUSDT', end, config, null)!.btcChange1hPct).toBeCloseTo(2, 9);
  });
});
