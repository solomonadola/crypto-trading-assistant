import { describe, expect, it } from 'vitest';
import { loadConfig, type EngineConfig } from '../src/config';
import { series, type Context } from '../src/strategy/context';
import { armedStillValid, planTrade, tryArm, tryConfirm, type Armed, type Confirmation } from '../src/strategy/pullback';
import { runFilters } from '../src/filters';
import { scoreSignal } from '../src/scoring';
import { baseName, prefilter, rank } from '../src/scanner';
import { openDb } from '../src/storage/db';
import { SignalLog } from '../src/storage/signals';
import type { Pivot } from '../src/analysis/indicators';
import type { Zone } from '../src/analysis/zones';
import type { Candle } from '../../shared/types';

const T = Date.UTC(2026, 8, 28, 10, 0);
const cfg = loadConfig('engine/config/config.yaml');

const flat = (n: number, v: number) => new Array<number>(n).fill(v);
const pivot = (type: 'high' | 'low', index: number, price: number): Pivot => ({ type, index, price, confirmedAt: index + 3 });
const candle = (i: number, o: number, h: number, l: number, c: number, tf: Candle['tf'] = '15m', v = 100): Candle => {
  const ms = tf === '15m' ? 900_000 : 3_600_000;
  const closeTime = T - (59 - i) * ms;
  return { symbol: 'SOLUSDT', tf, openTime: closeTime - ms, closeTime, open: o, high: h, low: l, close: c, volume: v, quoteVolume: v * c, trades: 1 };
};
const view = (tradable: boolean) => ({ state: tradable ? 'pullback' : 'none', emaAligned: tradable, tradable }) as const;
const zone = (over: Partial<Zone> = {}): Zone => ({
  id: 'z1', symbol: 'SOLUSDT', tf: '1h', type: 'demand', low: 98, high: 99.5, baseStart: 0, createdAt: 0,
  impulseStrength: 2, touches: 0, status: 'fresh', invalidatedAt: null, score: 2, ...over,
});

/**
 * A long pullback context: 1h ATR 2 (tolerance 1), last 1h leg 60 -> 110
 * (its 0.5-0.618 retracement is 79-85), last 1h close 101, price 100. Every
 * factor is far away unless a test moves it next to the price.
 */
function ctx(over: Partial<Context> = {}, config: EngineConfig = cfg): Context {
  const h1 = series(Array.from({ length: 60 }, (_, i) => candle(i, 101, 102, 100, 101, '1h')));
  const m15 = series(Array.from({ length: 60 }, (_, i) => candle(i, 100, 100.5, 99.5, 100)));
  return {
    symbol: 'SOLUSDT', t: T, config,
    analysis: { symbol: 'SOLUSDT', asOf: T, structure: { '4h': null, '1h': null, '15m': null }, ema4h: { fast: 90, slow: 80, close: 100 }, long: view(true), short: view(false), zones: [] },
    h4: series([]), h1, m15, price: 100,
    atr1h: flat(60, 2), atr15m: flat(60, 1),
    ema1h: { 20: flat(60, 130), 50: flat(60, 140) }, ema15m20: flat(60, 99),
    vwap15m: flat(60, 150), rsi15m: flat(60, 55), rvol15m: flat(60, 1),
    adx1h: flat(60, 30), chop1h: flat(60, 40), bbw1h: Array.from({ length: 60 }, (_, i) => 0.01 + i * 0.001),
    pivots1h: [pivot('low', 40, 60), pivot('high', 50, 110)], pivots15m: [], pivots4h: [],
    btcChange1hPct: 0, btcAnalysis: null, funding: 0.0001,
    ...over,
  };
}

const armedAt = (c: Context, over: Partial<Armed> = {}): Armed => ({
  id: 'a1', symbol: 'SOLUSDT', direction: 'long', armedAt: c.t - 3_600_000, expiresAt: c.t + 3_600_000, price: 100,
  factors: [{ name: 'ema', level: 100, detail: '' }, { name: 'vwap', level: 100, detail: '' }], zone: null, areaLow: 98, areaHigh: 102, ...over,
});

describe('arming', () => {
  it('arms a long when two factors meet at the price during a pullback', () => {
    const a = tryArm(ctx({ ema1h: { 20: flat(60, 100.5), 50: flat(60, 140) }, vwap15m: flat(60, 99.4) }), 'long')!;
    expect(a.factors.map((f) => f.name)).toEqual(['ema', 'vwap']);
    expect(a.expiresAt - a.armedAt).toBe(cfg.pullback.armed_expiry_hours * 3_600_000);
    // Area spans the levels and the price, widened by the tolerance (0.5 x ATR 2 = 1).
    expect(a.areaLow).toBeCloseTo(98.4, 9);
    expect(a.areaHigh).toBeCloseTo(101.5, 9);
  });

  it('one factor is not enough', () => {
    expect(tryArm(ctx({ vwap15m: flat(60, 100) }), 'long')).toBeNull();
  });

  it('a factor just outside the tolerance does not count', () => {
    expect(tryArm(ctx({ ema1h: { 20: flat(60, 101.01), 50: flat(60, 140) }, vwap15m: flat(60, 100) }), 'long')).toBeNull();
  });

  it('does not arm when the direction is not tradable', () => {
    const c = ctx({ ema1h: { 20: flat(60, 100), 50: flat(60, 140) }, vwap15m: flat(60, 100) });
    c.analysis.long = view(false);
    expect(tryArm(c, 'long')).toBeNull();
  });

  it('does not arm when price is not pulling back (last 1h close above the last swing high)', () => {
    expect(tryArm(ctx({ ema1h: { 20: flat(60, 100), 50: flat(60, 140) }, vwap15m: flat(60, 100), pivots1h: [pivot('low', 40, 60), pivot('high', 50, 100.5)] }), 'long')).toBeNull();
  });

  it('counts a demand zone, the 0.5-0.618 retracement and a broken old high', () => {
    // Leg 90 -> 110: 0.5 is 100, 0.618 is 97.64. Old high 100.2 at index 20, closed above since.
    const c = ctx({
      pivots1h: [pivot('high', 20, 100.2), pivot('low', 40, 90), pivot('high', 50, 110)],
    });
    c.analysis.zones = [zone()];
    const a = tryArm(c, 'long')!;
    expect(a.factors.map((f) => f.name)).toEqual(['zone', 'fib', 'breakout_level']);
    expect(a.zone!.id).toBe('z1');
  });

  it('shorts mirror longs: supply zone, rally into it', () => {
    // Leg 110 -> 90: its 0.5-0.618 retracement is 100-102.36, around the price.
    const c = ctx({ pivots1h: [pivot('high', 40, 110), pivot('low', 50, 90)], ema1h: { 20: flat(60, 99.6), 50: flat(60, 140) } });
    c.analysis.short = view(true);
    c.analysis.long = view(false);
    c.analysis.zones = [zone({ type: 'supply', low: 100.2, high: 101 })];
    const a = tryArm(c, 'short')!;
    expect(a.direction).toBe('short');
    expect(a.factors.map((f) => f.name)).toEqual(['zone', 'ema', 'fib']);
  });
});

describe('armed setups expire', () => {
  const c = ctx();
  it.each([
    ['expired', { expiresAt: c.t }, false],
    ['left_area', { areaLow: 100.5 }, false],
    ['session_closed', {}, true],
  ] as const)('%s', (want, over, windowClosed) => {
    expect(armedStillValid(c, armedAt(c, over), windowClosed)).toBe(want);
  });

  it('trend_changed', () => {
    const t = ctx();
    t.analysis.long = view(false);
    expect(armedStillValid(t, armedAt(t), false)).toBe('trend_changed');
  });

  it('stands while nothing changed', () => {
    expect(armedStillValid(c, armedAt(c), false)).toBeNull();
  });
});

describe('15m confirmation', () => {
  /** 15m candles with lower highs at 60 (104) then 55 (102); candle 59 closes at `lastClose`. */
  function confirmCtx(lastClose: number, over: Partial<Context> = {}) {
    const bars = Array.from({ length: 60 }, (_, i) => candle(i, 100, 100.5, 99.5, 100));
    bars[58] = candle(58, 100.5, 101, 99, 99.8);   // bearish, body 99.8-100.5
    bars[59] = candle(59, 99.7, lastClose + 0.1, 99.6, lastClose);
    return ctx({ m15: series(bars), pivots15m: [pivot('high', 45, 104), pivot('high', 52, 102)], rvol15m: flat(60, 2.5), ...over });
  }

  it('the first close above the latest lower high confirms, with the confirmations found', () => {
    const c = confirmCtx(102.5);
    const conf = tryConfirm(c, armedAt(c))!;
    expect(conf.level).toBe(102);
    expect(conf.engulfing).toBe(true);
    expect(conf.confirmations).toEqual(['reversal_candle', 'rvol']);
  });

  it('a close still below the lower high does not confirm', () => {
    const c = confirmCtx(101.9);
    expect(tryConfirm(c, armedAt(c))).toBeNull();
  });

  it('needs lower highs during the pullback', () => {
    const c = confirmCtx(102.5, { pivots15m: [pivot('high', 45, 101), pivot('high', 52, 102)] });
    expect(tryConfirm(c, armedAt(c))).toBeNull();
  });

  it('needs at least one confirmation', () => {
    const bars = Array.from({ length: 60 }, (_, i) => candle(i, 100, 100.5, 99.5, 100));
    bars[59] = candle(59, 101, 102.6, 100.9, 102.5);   // not engulfing: previous candle is not bearish
    const c = ctx({ m15: series(bars), pivots15m: [pivot('high', 45, 104), pivot('high', 52, 102)] });
    expect(tryConfirm(c, armedAt(c))).toBeNull();
    const withRsi = ctx({ m15: series(bars), pivots15m: [pivot('high', 45, 104), pivot('high', 52, 102)], rsi15m: [...flat(58, 45), 48, 56] });
    expect(tryConfirm(withRsi, armedAt(withRsi))!.confirmations).toEqual(['rsi_cross']);
  });

  it('a hammer into the area is a rejection; a doji with equal wicks is not', () => {
    const bars = Array.from({ length: 60 }, (_, i) => candle(i, 100, 100.5, 99.5, 100));
    bars[58] = candle(58, 100.2, 100.3, 98.8, 100.4);  // lower wick 1.4, body 0.2, upper wick 0.1
    bars[59] = candle(59, 101, 102.6, 100.9, 102.5);
    const c = ctx({ m15: series(bars), pivots15m: [pivot('high', 45, 104), pivot('high', 52, 102)] });
    expect(tryConfirm(c, armedAt(c))).toMatchObject({ rejection: true, engulfing: false, confirmations: ['reversal_candle'] });
  });

  it('never on the candle it was armed on', () => {
    const c = confirmCtx(102.5);
    expect(tryConfirm(c, armedAt(c, { armedAt: c.t }))).toBeNull();
  });
});

/** 1h candles all below the price, so the previous day's high is not in the way. */
const lowH1 = () => series(Array.from({ length: 60 }, (_, i) => candle(i, 99, 99.5, 98.5, 99, '1h')));

describe('trade plan', () => {
  it('stop below the zone plus buffer; target at the first objective or nearer resistance', () => {
    const c = ctx({ h1: lowH1() });
    const a = armedAt(c, { zone: zone() });
    const plan = planTrade(c, a);
    expect(plan.stop).toBeCloseTo(98 - cfg.exits.stop_buffer_atr * 2, 9);
    expect(plan.target).toBeCloseTo(105, 9);                      // +5% (partial_at_pct)
    expect(plan.rewardRisk).toBeCloseTo(5 / (100 - plan.stop), 9);

    c.analysis.zones = [zone({ id: 'sup', type: 'supply', low: 103, high: 104 })];
    const capped = planTrade(c, a);
    expect(capped.target).toBe(103);
    expect(capped.targetSource).toBe('supply zone');
  });

  it('without a zone, the stop goes beyond the pullback extreme', () => {
    const bars = Array.from({ length: 60 }, (_, i) => candle(i, 100, 100.5, 99.5, 100));
    bars[57] = candle(57, 100, 100.2, 97, 99.8);
    const c = ctx({ m15: series(bars) });
    expect(planTrade(c, armedAt(c)).stop).toBeCloseTo(97 - cfg.exits.stop_buffer_atr * 2, 9);
  });
});

describe('filters', () => {
  const conf: Confirmation = { level: 99.5, confirmations: ['rvol'], engulfing: false, rejection: false, rvol: 2.5, rsiCross: false, liquiditySweep: false };
  const byName = (c: Context, a = armedAt(c), cf = conf) => Object.fromEntries(runFilters(c, a, cf).map((f) => [f.name, f]));

  it('BTC falling more than 1.5% in an hour blocks longs, not shorts', () => {
    expect(byName(ctx({ btcChange1hPct: -1.6 })).btc.pass).toBe(false);
    expect(byName(ctx({ btcChange1hPct: -1.4 })).btc.pass).toBe(true);
    const c = ctx({ btcChange1hPct: -1.6 });
    expect(byName(c, armedAt(c, { direction: 'short' })).btc.pass).toBe(true);
  });

  it('funding against the trade beyond the limit blocks it', () => {
    expect(byName(ctx({ funding: 0.0006 })).funding.pass).toBe(false);   // 0.06% > 0.05%, longs pay
    const c = ctx({ funding: 0.0006 });
    expect(byName(c, armedAt(c, { direction: 'short' })).funding.pass).toBe(true);
    expect(byName(ctx({ funding: null })).funding.pass).toBe(true);
  });

  it('too far above the 15m EMA20 is extended', () => {
    expect(byName(ctx({ ema15m20: flat(60, 96.9) })).extension.pass).toBe(false);   // 3.1 ATR
    expect(byName(ctx({ ema15m20: flat(60, 97.1) })).extension.pass).toBe(true);
  });

  it('room: a level within 2.5% ahead blocks the trade', () => {
    const c = ctx({ h1: lowH1() });
    c.analysis.zones = [zone({ type: 'supply', low: 102, high: 103 })];
    expect(byName(c).room).toMatchObject({ pass: false, detail: { nearest: 'supply zone', roomPct: 2 } });
    c.analysis.zones = [zone({ type: 'supply', low: 103, high: 104 })];
    expect(byName(c).room.pass).toBe(true);
  });

  it('chop: weak ADX fails', () => {
    expect(byName(ctx({ adx1h: flat(60, 15) }))['chop.adx'].pass).toBe(false);
  });

  it('fakeout: the trigger must close well through the level near its high, on volume', () => {
    const bars = Array.from({ length: 60 }, (_, i) => candle(i, 100, 100.5, 99.5, 100));
    bars[59] = candle(59, 99, 100.1, 98.9, 100);
    const strong = ctx({ m15: series(bars), price: 100, rvol15m: flat(60, 2.5) });
    expect(byName(strong).fakeout.pass).toBe(true);                             // 0.5 ATR through, top of range, rvol 2.5
    expect(byName(ctx({ m15: series(bars), rvol15m: flat(60, 1.9) })).fakeout.pass).toBe(false);
    expect(byName(strong, armedAt(strong), { ...conf, level: 99.95 }).fakeout.pass).toBe(false); // only 0.05 ATR through
  });
});

describe('score', () => {
  it('adds the plan\'s points', () => {
    const c = ctx();
    const a = armedAt(c, { zone: zone(), factors: [{ name: 'zone', level: 99.5, detail: '' }, { name: 'fib', level: 99, detail: '' }] });
    const conf: Confirmation = { level: 101, confirmations: ['reversal_candle', 'rvol'], engulfing: true, rejection: false, rvol: 2, rsiCross: false, liquiditySweep: true };
    const s = scoreSignal(c, a, conf, { entry: 100, stop: 97, stopDistancePct: 3, target: 110, targetSource: '', rewardRisk: 3.3 });
    expect(s.points).toEqual({ fresh_zone: 2, fib: 1, reversal_candle: 1, rvol: 1, reward_risk_3: 1, liquidity_sweep: 1 });
    expect(s.total).toBe(7);
  });
});

describe('scanner', () => {
  const info = (symbol: string, baseAsset: string) => ({ symbol, baseAsset, tickSize: 0.01, stepSize: 1, minQty: 1, minNotional: 5 });
  const t = (symbol: string, quoteVolume: number, priceChangePercent = 1) => ({ symbol, lastPrice: 1, priceChangePercent, quoteVolume });

  it('keeps liquid, non-excluded coins that have not already moved too far, by volume', () => {
    const { candidates, dropped } = prefilter(
      [t('SOLUSDT', 9e8), t('USDCUSDT', 5e9), t('THINUSDT', 1e6), t('PUMPUSDT', 2e8, 45), t('1000PEPEUSDT', 3e8), t('ODDUSDC', 1e9)],
      [info('SOLUSDT', 'SOL'), info('USDCUSDT', 'USDC'), info('THINUSDT', 'THIN'), info('PUMPUSDT', 'PUMP'), info('1000PEPEUSDT', '1000PEPE')],
      cfg.scanner);
    expect(candidates.map((c) => c.symbol)).toEqual(['SOLUSDT', '1000PEPEUSDT']);
    expect(dropped).toEqual({ excluded: 1, volume: 1, change_24h: 1 });
  });

  it('ranks by ATR% x log(volume), dropping low volatility and keeping the top max_symbols', () => {
    const dropped: Record<string, number> = {};
    const rows = rank([t('AUSDT', 1e9), t('BUSDT', 1e8), t('CUSDT', 1e8)], new Map([['AUSDT', 2.5], ['BUSDT', 4], ['CUSDT', 1]]), cfg.scanner, dropped);
    expect(rows.map((r) => r.symbol)).toEqual(['BUSDT', 'AUSDT']);
    expect(dropped).toEqual({ atr: 1 });
  });

  it('strips 1000/1M multipliers for exclusion checks', () => {
    expect(baseName('1000PEPE')).toBe('PEPE');
    expect(baseName('1MBABYDOGE')).toBe('BABYDOGE');
    expect(baseName('1INCH')).toBe('1INCH');
  });
});

describe('signal log', () => {
  it('stores, filters, summarises and prunes', () => {
    const log = new SignalLog(openDb(':memory:'));
    const s = (time: number, status: 'armed' | 'filtered', reason: string | null = null) =>
      ({ time, symbol: 'SOLUSDT', setup: 'pullback' as const, direction: 'long' as const, status, reason, payload: { x: time } });
    log.append([s(1, 'armed'), s(2, 'filtered', 'rr_too_low'), s(3, 'filtered', 'rr_too_low')]);
    expect(log.recent().map((r) => r.time)).toEqual([3, 2, 1]);
    expect(log.recent({ status: 'armed' })[0].payload).toEqual({ x: 1 });
    expect(log.summary(2)).toEqual([{ status: 'filtered', reason: 'rr_too_low', count: 2 }]);
    expect(log.prune(3)).toBe(2);
  });
});
