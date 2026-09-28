/**
 * Supply & Demand Trend Pullback.
 *
 * The 4h sets the direction and the zones; the 1h times the entry (and, with
 * the 1h trail, the exit).
 *
 * Trade only with the trend, and enter when price pulls back into a fresh
 * zone and shows it held. The long side, as below; the short side is the same
 * rules upside down (BTC below its average, lower highs and lower lows, a
 * supply zone above, a red close below its midpoint), computed by running the
 * long code on flipped candles, so the two sides cannot drift apart.
 *
 *   market   BTC above its 50-day average
 *   liquid   at least $50M traded in the last 24h
 *   trend    4h higher highs and higher lows, price above the 4h 50 EMA
 *   zone     the base (1-2 quiet 4h candles) before a strong 4h move up of at
 *            least 2 ATR, which price had not come back to until now
 *   trigger  price dipped into the zone, never closed below it, and the last
 *            1h candle closed green above the zone's midpoint
 *   exit     stop just under the zone, target 2R, out at market after 72h
 *
 * Pure: it sees only candles that have closed by the moment it is asked
 * (plus the price at that moment), so the backtest and live trading make the
 * same decision from the same inputs. Every rule can be switched off for a
 * backtest, to measure what each one adds.
 */
import type { Candle } from '../services/candleService';
import { atr, ema, structureFrom } from '../services/indicators';

export interface TrendPullbackConfig {
  minQuoteVolume24hUSD: number;
  /** BTC must close above this many days' simple average. 0 = no market filter. */
  btcSmaDays: number;
  /** Require 4h higher highs + higher lows and price above the 4h EMA. */
  requireTrend: boolean;
  trendEmaPeriod: number;
  /** false: enter on a pullback to the 4h 21 EMA instead of a demand zone. */
  requireZone: boolean;
  /** A move away of at least this many 4h ATR makes the base before it a zone. */
  impulseAtr: number;
  /** A base candle's range may be at most this many 4h ATR. */
  maxBaseAtr: number;
  /** How far back to look for zones, in 4h candles (90 = 15 days). */
  zoneLookback4h: number;
  /** The first touch of the zone must be this recent, in 1h candles. */
  touchWindow1h: number;
  /** Stop buffer below the zone, in 4h ATR. */
  stopBufferAtr: number;
  targetR: number;
  /** Skip when the high the pullback came from is closer than this many R. */
  minRoomR: number;
  /** Do not chase: entry at most this many 4h ATR above the zone top. */
  maxChaseAtr: number;
  /** Stop distance must fall inside these bounds (percent of price). */
  minStopPct: number;
  maxStopPct: number;
  maxHoldHours: number;

  // ---- when not to trade at all (regime) ----
  /** BTC's daily average must also be rising over this many days. 0 = off. */
  btcSmaRisingDays: number;
  /** At least this share (0-100) of liquid coins above their 4h trend EMA. 0 = off. */
  minBreadthPct: number;
  /** Only coins that beat BTC over the last 7 days. */
  requireRelativeStrength: boolean;
  /** After this many losses in a row, no entries for lossStreakPauseHours. 0 = off. */
  lossStreakLimit: number;
  lossStreakPauseHours: number;

  // ---- setup quality ----
  /** The move away from the zone must break the last swing high before it. */
  requireBreakOfStructure: boolean;
  /**
   * 'R': target at targetR. 'priorHigh': the high the pullback came from.
   * 'keyLevel': the first key level in the way - that prior high, or the bottom
   * of the nearest fresh supply zone above (mirrored for shorts), whichever is
   * nearer. All need minRoomR of room; the stop never moves.
   */
  targetMode: 'R' | 'priorHigh' | 'keyLevel';
  /**
   * Verify the turn on the 1h before entering: close beyond the pullback's last
   * 1h swing high (below its last swing low, for a short), not just a green candle.
   */
  requireLtfBreak: boolean;
  /**
   * Not fooled by inducement: (1) the pullback must have swept an internal 1h
   * swing low on its way into the zone - a zone reached with no such sweep is
   * likely the inducement itself; (2) no unswept 4h swing low may sit within
   * `liquidityBelowAtr` under the zone - price tends to run it, and the stop.
   * Mirrored for shorts.
   */
  requireInducementSwept: boolean;
  liquidityBelowAtr: number;
  /**
   * 'fixed': stop and target. 'ltfTrail': no fixed target; at +1R the stop
   * goes to entry, then trails under each new 1h swing low (over each swing
   * high, for shorts) and the trade ends when the 1h structure breaks.
   */
  exitMode: 'fixed' | 'ltfTrail';
  /**
   * Timeframes. The 4h always sets the direction (trend); zones, ATR and key
   * levels come from the zone timeframe; the trigger timeframe times the entry.
   * 240/60 is the swing version; 60/15 intraday; 15/5 a scalp.
   */
  zoneTfMinutes: number;
  triggerTfMinutes: number;
}

export const TREND_PULLBACK_CONFIG: TrendPullbackConfig = {
  minQuoteVolume24hUSD: 50_000_000,
  btcSmaDays: 50,
  requireTrend: true,
  trendEmaPeriod: 50,
  requireZone: true,
  impulseAtr: 2,
  maxBaseAtr: 1,
  zoneLookback4h: 90,
  touchWindow1h: 12,
  stopBufferAtr: 0.1,
  targetR: 2,
  minRoomR: 1.5,
  maxChaseAtr: 0.5,
  minStopPct: 0.5,
  maxStopPct: 10,
  maxHoldHours: 72,
  btcSmaRisingDays: 0,
  minBreadthPct: 0,
  requireRelativeStrength: false,
  lossStreakLimit: 0,
  lossStreakPauseHours: 24,
  requireBreakOfStructure: false,
  targetMode: 'R',
  requireLtfBreak: false,
  requireInducementSwept: false,
  liquidityBelowAtr: 1,
  exitMode: 'fixed',
  zoneTfMinutes: 240,
  triggerTfMinutes: 60,
};

export interface DemandZone {
  low: number;
  high: number;
  /** open time of the base candle: identifies the zone, so it is traded once */
  baseTime: number;
  /** the high of the move away, which the pullback came down from */
  impulseHigh: number;
  /** open time of the 4h candle that made impulseHigh: where the pullback began */
  pullbackStartTime: number;
}

export type TradeSide = 'LONG' | 'SHORT';

export interface TrendPullbackSetup {
  direction: TradeSide;
  entry: number;
  stop: number;
  target: number;
  stopPct: number;
  /** room to the high the pullback came from, in R */
  roomR: number;
  zone: DemandZone | null;
  /** identifies the level, so the same zone is not traded twice */
  key: string;
}

export interface TrendPullbackInputs {
  price: number;
  quoteVolume24hUSD: number;
  /** completed trigger-timeframe candles (1h in the swing version), oldest first */
  h1: Candle[];
  /** completed 4h candles, oldest first: the trend */
  h4: Candle[];
  /** completed zone-timeframe candles; omitted, the 4h serves as the zone timeframe */
  zoneCandles?: Candle[];
  /** completed BTC daily closes, oldest first */
  btcDailyCloses: number[];
  btcPrice: number;
  /** Share (0-100) of liquid coins above their 4h trend EMA right now. */
  breadthPct?: number;
  /** BTC's return over the last 7 days, percent. */
  btcReturn7dPct?: number;
}

export type TrendPullbackDecision =
  | { setup: TrendPullbackSetup; reason?: undefined }
  | { setup: null; reason: string };

const no = (reason: string): TrendPullbackDecision => ({ setup: null, reason });

/**
 * The market filter: longs need BTC above its daily average (and the average
 * rising, if asked); shorts need BTC below it (and falling).
 */
export function btcAllows(side: TradeSide, btcDailyCloses: number[], btcPrice: number, cfg = TREND_PULLBACK_CONFIG): boolean {
  if (cfg.btcSmaDays <= 0) return true;
  if (btcDailyCloses.length < cfg.btcSmaDays) return false;
  const sign = side === 'LONG' ? 1 : -1;
  const sma = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const now = sma(btcDailyCloses.slice(-cfg.btcSmaDays));
  if (!(sign * (btcPrice - now) > 0)) return false;
  if (cfg.btcSmaRisingDays > 0) {
    const endAgo = btcDailyCloses.length - cfg.btcSmaRisingDays;
    if (endAgo < cfg.btcSmaDays) return false;
    const before = sma(btcDailyCloses.slice(endAgo - cfg.btcSmaDays, endAgo));
    if (!(sign * (now - before) > 0)) return false;
  }
  return true;
}

/** Longs only (kept for callers written before shorts). */
export const btcAllowsLongs = (closes: number[], price: number, cfg = TREND_PULLBACK_CONFIG) => btcAllows('LONG', closes, price, cfg);

/** Whether a coin is above its 4h trend EMA: the breadth count uses this. */
export function isAboveTrendEma(h4: Candle[], price: number, cfg = TREND_PULLBACK_CONFIG): boolean {
  if (h4.length < cfg.trendEmaPeriod) return false;
  const e = ema(h4.map((c) => c.c), cfg.trendEmaPeriod);
  return e !== null && price > e;
}

/** Candles upside down: a short on these is a long on the originals. */
const flip = (c: Candle): Candle => ({ t: c.t, o: -c.o, h: -c.l, l: -c.h, c: -c.c, v: c.v });

/**
 * The most recent fresh demand zone below price: a quiet base, then a move up
 * of at least `impulseAtr` ATR within three candles, never closed below since,
 * and first revisited within the touch window (or not yet).
 */
export function findDemandZone(h4: Candle[], price: number, atr4: number, cfg = TREND_PULLBACK_CONFIG): DemandZone | null {
  const n = h4.length;
  const start = Math.max(2, n - cfg.zoneLookback4h);
  for (let k = n - 2; k >= start; k--) {
    const base = h4[k - 1];
    if (base.h - base.l > cfg.maxBaseAtr * atr4) continue;
    let impulseHigh = -Infinity;
    let impulseEnd = k;
    let maxClose = -Infinity;
    for (let j = k; j <= Math.min(n - 1, k + 2); j++) {
      if (h4[j].h > impulseHigh) { impulseHigh = h4[j].h; impulseEnd = j; }
      if (h4[j].c > maxClose) maxClose = h4[j].c;
    }
    if (maxClose - base.c < cfg.impulseAtr * atr4) continue;
    if (cfg.requireBreakOfStructure) {
      // The highest high of the 20 candles before the base: the move must clear it.
      let priorHigh = -Infinity;
      for (let j = Math.max(0, k - 21); j < k - 1; j++) if (h4[j].h > priorHigh) priorHigh = h4[j].h;
      if (!(impulseHigh > priorHigh)) continue;
    }

    // A second quiet candle before the first widens the base.
    const prev = h4[k - 2];
    const twoCandle = prev.h - prev.l <= cfg.maxBaseAtr * atr4;
    const low = twoCandle ? Math.min(base.l, prev.l) : base.l;
    const high = twoCandle
      ? Math.max(base.o, base.c, prev.o, prev.c)
      : Math.max(base.o, base.c);
    if (!(high > low) || price < low) continue;

    // Fresh: no close below it since the move, and not revisited before now,
    // except in the most recent candle(s) (the pullback being traded).
    let broken = false;
    let touchedEarly = false;
    const recentFrom = n - Math.max(1, Math.ceil((cfg.touchWindow1h * cfg.triggerTfMinutes) / cfg.zoneTfMinutes));
    for (let j = impulseEnd + 1; j < n; j++) {
      if (h4[j].c < low) { broken = true; break; }
      if (h4[j].l <= high && j < recentFrom) { touchedEarly = true; break; }
    }
    if (broken || touchedEarly) continue;
    // Highest point since the move: where the pullback came down from.
    let pullbackStartTime = h4[impulseEnd].t;
    for (let j = impulseEnd + 1; j < n; j++) if (h4[j].h > impulseHigh) { impulseHigh = h4[j].h; pullbackStartTime = h4[j].t; }
    return { low, high, baseTime: base.t, impulseHigh, pullbackStartTime };
  }
  return null;
}

/**
 * One side of the strategy. Written for a long; a short calls it with flipped
 * candles and a negated price, so every "above" becomes "below".
 */
function evaluateLongSpace(
  price: number, h1: Candle[], trendC: Candle[], h4: Candle[], cfg: TrendPullbackConfig, side: TradeSide
): { entry: number; stop: number; target: number; stopPct: number; roomR: number; zone: DemandZone | null; key: string } | string {
  // h4 here is the zone timeframe (the 4h itself in the swing version); trendC is always the 4h.
  const atr4 = atr(h4, 14);
  if (!atr4 || !(atr4 > 0)) return 'No ATR';
  const closes4 = h4.map((c) => c.c);
  const up = side === 'LONG';

  if (cfg.requireTrend) {
    const trendEma = ema(trendC.map((c) => c.c), cfg.trendEmaPeriod);
    const s = structureFrom(trendC, 2);
    if (!s.higherHighs || !s.higherLows) return up ? '4h structure is not higher highs and higher lows' : '4h structure is not lower highs and lower lows';
    if (trendEma === null || price <= trendEma) return up ? `Price under the 4h ${cfg.trendEmaPeriod} EMA` : `Price over the 4h ${cfg.trendEmaPeriod} EMA`;
  }

  let zone: DemandZone | null = null;
  let levelLow: number;
  let levelHigh: number;
  let key: string;
  let pullbackFrom: number;
  if (cfg.requireZone) {
    zone = findDemandZone(h4, price, atr4, cfg);
    if (!zone) return up ? 'No fresh demand zone below price' : 'No fresh supply zone above price';
    levelLow = zone.low;
    levelHigh = zone.high;
    key = `zone:${zone.baseTime}`;
    pullbackFrom = zone.impulseHigh;
  } else {
    const e21 = ema(closes4, 21);
    if (e21 === null) return 'No 4h EMA';
    levelLow = e21 - 0.25 * atr4;
    levelHigh = e21 + 0.25 * atr4;
    key = `ema:${h4[h4.length - 1].t}`;
    pullbackFrom = Math.max(...h4.slice(-12).map((c) => c.h));
  }

  // Into the level recently, never closed through it, and turned back.
  const recent = h1.slice(-cfg.touchWindow1h);
  const touch = recent.findIndex((c) => c.l <= levelHigh);
  if (touch < 0) return 'No pullback into the level yet';
  if (recent.slice(touch).some((c) => c.c < levelLow)) return 'Closed through the level: it failed';
  if (cfg.requireInducementSwept && zone) {
    // (1) An internal 1h swing low formed during the pullback, above the zone,
    // and taken out before price reached the zone.
    const touchTime = recent[touch].t;
    const leg = h1.filter((c) => c.t >= zone!.pullbackStartTime && c.t < touchTime);
    let swept = false;
    for (let j = 2; j < leg.length - 2 && !swept; j++) {
      const isLow = leg[j].l <= leg[j - 1].l && leg[j].l <= leg[j - 2].l && leg[j].l <= leg[j + 1].l && leg[j].l <= leg[j + 2].l;
      if (isLow && leg[j].l > levelHigh) {
        const after = h1.filter((c) => c.t > leg[j].t);
        swept = after.some((c) => c.l < leg[j].l);
      }
    }
    if (!swept) return 'Zone reached with no inducement swept: it may be the inducement';
    // (2) No unswept 4h swing low just under the zone for price to hunt.
    for (let j = 2; j < h4.length - 2; j++) {
      const c = h4[j];
      const isLow = c.l <= h4[j - 1].l && c.l <= h4[j - 2].l && c.l <= h4[j + 1].l && c.l <= h4[j + 2].l;
      if (!isLow || c.l >= levelLow || c.l < levelLow - cfg.liquidityBelowAtr * atr4) continue;
      if (!h4.slice(j + 1).some((x) => x.l < c.l)) {
        return up ? 'Unswept liquidity (a 4h swing low) just below the zone' : 'Unswept liquidity (a 4h swing high) just above the zone';
      }
    }
  }
  const last = h1[h1.length - 1];
  const mid = (levelLow + levelHigh) / 2;
  if (!(last.c > last.o && last.c > mid)) return up ? 'Waiting for a green 1h close above the level midpoint' : 'Waiting for a red 1h close below the level midpoint';
  if (cfg.requireLtfBreak) {
    // The pullback's own structure: its last 1h swing high before this candle.
    // Closing beyond it is the lower timeframe turning in the trade's direction.
    const window = h1.slice(-(cfg.touchWindow1h + 6), -1);
    let swingHigh: number | null = null;
    for (let j = window.length - 2; j >= 1; j--) {
      if (window[j].h >= window[j - 1].h && window[j].h >= window[j + 1].h) { swingHigh = window[j].h; break; }
    }
    if (swingHigh === null || !(last.c > swingHigh)) return up ? 'Waiting for the 1h to break its last swing high' : 'Waiting for the 1h to break its last swing low';
  }
  if (price > levelHigh + cfg.maxChaseAtr * atr4) return 'Already moved away from the level';

  const stop = levelLow - cfg.stopBufferAtr * atr4;
  const risk = price - stop;
  const stopPct = (risk / Math.abs(price)) * 100;
  if (!(risk > 0) || stopPct < cfg.minStopPct || stopPct > cfg.maxStopPct) return `Stop ${stopPct.toFixed(2)}% is outside the allowed range`;
  // The key level in the way: the prior swing, or an opposing zone before it.
  let keyLevel = pullbackFrom;
  if (cfg.targetMode === 'keyLevel') {
    const opposing = findDemandZone(h4.map(flip), -price, atr4, cfg);   // a supply zone above, seen upside down
    if (opposing) {
      const bottom = -opposing.high;
      if (bottom > price && bottom < keyLevel) keyLevel = bottom;
    }
  }
  const roomR = (keyLevel - price) / risk;
  if (roomR < cfg.minRoomR) return `Only ${roomR.toFixed(2)}R of room to the next key level`;
  return {
    entry: price,
    stop,
    target: cfg.exitMode === 'ltfTrail' ? Infinity : cfg.targetMode === 'R' ? price + cfg.targetR * risk : keyLevel,
    stopPct: +stopPct.toFixed(3),
    roomR: +roomR.toFixed(2),
    zone,
    key,
  };
}

export function evaluateTrendPullback(i: TrendPullbackInputs, cfg = TREND_PULLBACK_CONFIG, side: TradeSide = 'LONG'): TrendPullbackDecision {
  const up = side === 'LONG';
  if (!(i.price > 0)) return no('No price');
  if (i.quoteVolume24hUSD < cfg.minQuoteVolume24hUSD) return no('Under the 24h volume floor');
  if (!btcAllows(side, i.btcDailyCloses, i.btcPrice, cfg)) return no(up ? 'BTC below its daily average' : 'BTC above its daily average');
  // Breadth is the share of coins above their trend EMA; for shorts, the share below.
  if (cfg.minBreadthPct > 0 && (up ? (i.breadthPct ?? 0) : 100 - (i.breadthPct ?? 100)) < cfg.minBreadthPct) return no('Market breadth too weak');
  if (i.h4.length < 60 || i.h1.length < cfg.touchWindow1h + 2) return no('Not enough history');
  if (cfg.requireRelativeStrength) {
    const ago = i.h4[i.h4.length - 42];   // 42 x 4h = 7 days
    const coin7d = ago ? ((i.price - ago.c) / ago.c) * 100 : NaN;
    const btc = i.btcReturn7dPct ?? NaN;
    if (!(up ? coin7d > btc : coin7d < btc)) return no(up ? 'Weaker than BTC over 7 days' : 'Stronger than BTC over 7 days');
  }

  const zc = i.zoneCandles ?? i.h4;
  if (zc.length < 30) return no('Not enough history');
  const r = up
    ? evaluateLongSpace(i.price, i.h1, i.h4, zc, cfg, side)
    : evaluateLongSpace(-i.price, i.h1.map(flip), i.h4.map(flip), zc.map(flip), cfg, side);
  if (typeof r === 'string') return no(r);
  const back = (x: number) => (up ? x : -x);
  return {
    setup: {
      direction: side,
      entry: i.price,
      stop: back(r.stop),
      target: back(r.target),
      stopPct: r.stopPct,
      roomR: r.roomR,
      zone: r.zone && (up ? r.zone : { low: -r.zone.high, high: -r.zone.low, baseTime: r.zone.baseTime, impulseHigh: -r.zone.impulseHigh, pullbackStartTime: r.zone.pullbackStartTime }),
      key: `${side}:${r.key}`,
    },
  };
}

/**
 * The 1h trailing stop for an open trade (exitMode 'ltfTrail'): the last
 * confirmed 1h swing low for a long, swing high for a short, or null when
 * there is none. The caller only ever moves a stop in the trade's favour.
 */
export function ltfTrailLevel(h1: Candle[], side: TradeSide): number | null {
  const c = side === 'LONG' ? h1 : h1.map(flip);
  for (let j = c.length - 3; j >= 2; j--) {
    const x = c[j];
    if (x.l <= c[j - 1].l && x.l <= c[j - 2].l && x.l <= c[j + 1].l && x.l <= c[j + 2].l) return side === 'LONG' ? x.l : -x.l;
  }
  return null;
}
