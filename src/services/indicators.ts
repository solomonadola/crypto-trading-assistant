/**
 * Indicators and price structure, computed from real candles (candleService).
 *
 * Every function here is pure, so the live scanner and the offline replay can
 * use the same code on the same data and agree. Tested in
 * tools/test-indicators.mjs against hand-worked series.
 */
import { Candle } from './candleService';

/** Exponential moving average of the last value. Null when there is not enough history. */
export function ema(values: number[], period: number): number | null {
  if (!values.length || period < 1 || values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with the simple average of the first `period` values (Wilder's start).
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Wilder's RSI over `period` (0-100). Null when there is not enough history. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/** Average true range in price units (Wilder). Null when there is not enough history. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const tr = (i: number) => Math.max(
    candles[i].h - candles[i].l,
    Math.abs(candles[i].h - candles[i - 1].c),
    Math.abs(candles[i].l - candles[i - 1].c),
  );
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr(i);
  a /= period;
  for (let i = period + 1; i < candles.length; i++) a = (a * (period - 1) + tr(i)) / period;
  return a;
}

export interface Pivot {
  index: number;
  time: number;
  price: number;
  kind: 'HIGH' | 'LOW';
}

/**
 * Swing points: a candle whose high is the highest (or low the lowest) of the
 * `lookback` candles either side of it. The last `lookback` candles cannot be
 * pivots yet - a swing is only a swing once price has moved away from it.
 */
export function swingPivots(candles: Candle[], lookback = 2): Pivot[] {
  const out: Pivot[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, time: candles[i].t, price: candles[i].h, kind: 'HIGH' });
    if (isLow) out.push({ index: i, time: candles[i].t, price: candles[i].l, kind: 'LOW' });
  }
  return out;
}

export interface Level {
  price: number;
  /** How many separate swings formed this level. */
  touches: number;
  /** Time of the most recent touch. */
  lastTouch: number;
  kind: 'SUPPORT' | 'RESISTANCE';
}

/**
 * Levels: swing points clustered together when they sit within `tolerance`
 * (a price distance, normally a fraction of ATR). A price that several swings
 * share is a level; a lone swing is just a wick, so levels with one touch are
 * kept but reported as such and callers can require two.
 *
 * A level is support or resistance by where it sits relative to the current
 * price, not by whether it was formed from highs or lows: broken support
 * becomes resistance, which is exactly what the clustering shows.
 */
export function levelsFrom(candles: Candle[], tolerance: number, lookback = 2): Level[] {
  if (!candles.length || !(tolerance > 0)) return [];
  const price = candles[candles.length - 1].c;
  const pivots = swingPivots(candles, lookback).sort((a, b) => a.price - b.price);

  // Measured from the cluster's own anchor, not from the last pivot added:
  // comparing with the previous pivot lets a dense run of swings chain into one
  // level spanning the whole range (a live BTC check produced a "50-touch"
  // support 3.6 ATR wide, which is not a level).
  const clusters: Array<{ anchor: number; prices: number[]; lastTouch: number }> = [];
  for (const p of pivots) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(p.price - last.anchor) <= tolerance) {
      last.prices.push(p.price);
      last.lastTouch = Math.max(last.lastTouch, p.time);
    } else {
      clusters.push({ anchor: p.price, prices: [p.price], lastTouch: p.time });
    }
  }

  return clusters.map((c) => {
    const level = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
    return {
      price: level,
      touches: c.prices.length,
      lastTouch: c.lastTouch,
      kind: level <= price ? 'SUPPORT' : 'RESISTANCE',
    } as Level;
  });
}

/** The nearest level below the price (support) or above it (resistance). */
export function nearestLevel(price: number, levels: Level[], kind: 'SUPPORT' | 'RESISTANCE', minTouches = 1): Level | null {
  const candidates = levels.filter((l) => l.kind === kind && l.touches >= minTouches &&
    (kind === 'SUPPORT' ? l.price <= price : l.price >= price));
  if (!candidates.length) return null;
  return candidates.reduce((best, l) =>
    Math.abs(price - l.price) < Math.abs(price - best.price) ? l : best);
}

export type Trend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

/** Trend from EMA stacking: price above a rising 21 over 50 is bullish, and the reverse. */
export function trendFromEmas(closes: number[]): Trend {
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const price = closes[closes.length - 1];
  if (e21 === null || e50 === null || !(price > 0)) return 'NEUTRAL';
  if (price > e21 && e21 > e50) return 'BULLISH';
  if (price < e21 && e21 < e50) return 'BEARISH';
  return 'NEUTRAL';
}

export interface Structure {
  trend: Trend;
  /** Successive swing highs and lows both rising (an uptrend's shape). */
  higherHighs: boolean;
  higherLows: boolean;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
}

export function structureFrom(candles: Candle[], lookback = 2): Structure {
  const closes = candles.map((c) => c.c);
  const pivots = swingPivots(candles, lookback);
  const highs = pivots.filter((p) => p.kind === 'HIGH').slice(-2);
  const lows = pivots.filter((p) => p.kind === 'LOW').slice(-2);
  return {
    trend: trendFromEmas(closes),
    higherHighs: highs.length === 2 && highs[1].price > highs[0].price,
    higherLows: lows.length === 2 && lows[1].price > lows[0].price,
    lastSwingHigh: highs.length ? highs[highs.length - 1].price : null,
    lastSwingLow: lows.length ? lows[lows.length - 1].price : null,
  };
}

export interface PullbackState {
  /** Price has come back from a recent swing high without breaking the prior swing low. */
  isPullback: boolean;
  /** How far back from the high, as a fraction of the impulse that preceded it. */
  retracement: number;
  /** Whether price is actively falling (red candle / ongoing downward momentum into support). */
  isActiveFalling: boolean;
  /** A candle has closed back up after the pullback, confirming the support level held. */
  reclaimed: boolean;
  /** Reclaim completed on the prior candle and current candle is holding: safe to join continuation. */
  isLateJoinCandidate: boolean;
}

/**
 * A pullback inside an uptrend: price rose from a swing low to a swing high,
 * then came back part of the way without losing that low.
 *
 * `isActiveFalling`: indicates price is currently falling knives into support without confirmation.
 * `reclaimed`: the confirmation a level-based entry waits for - candle closing green or above previous high.
 * `isLateJoinCandidate`: pullback completed 1 candle ago and price remains close to support.
 */
export function pullbackState(candles: Candle[], lookback = 2): PullbackState {
  const none: PullbackState = {
    isPullback: false,
    retracement: 0,
    isActiveFalling: false,
    reclaimed: false,
    isLateJoinCandidate: false,
  };
  if (candles.length < lookback * 2 + 3) return none;
  const s = structureFrom(candles, lookback);
  if (s.lastSwingHigh === null || s.lastSwingLow === null) return none;
  if (!(s.lastSwingHigh > s.lastSwingLow)) return none;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles.length >= 3 ? candles[candles.length - 3] : null;
  const impulse = s.lastSwingHigh - s.lastSwingLow;
  if (!(impulse > 0)) return none;

  const retracement = (s.lastSwingHigh - last.c) / impulse;
  const isPullback = retracement > 0.08 && retracement < 1.05 && last.l >= s.lastSwingLow * 0.995;

  // Volume confirmation on reclaim:
  // Calculate 20-period average volume to ensure institutional defense
  const volWindow = candles.slice(-21, -1);
  const avgVol = volWindow.length > 0 
    ? volWindow.reduce((acc, c) => acc + (c.v || 0), 0) / volWindow.length 
    : 0;
  const isVolumeConfirmed = avgVol > 0 ? (last.v >= avgVol * 1.15) : true;

  // Immediate reclaim: current candle closed above previous candle's high, OR
  // strong green bounce candle that engulfed the previous close and is closing near highs
  const isImmediateReclaim = (
    last.c > prev.h || (
      last.c > last.o &&
      last.c > prev.c &&
      last.l >= s.lastSwingLow &&
      (last.h - last.c) <= (last.c - last.l) * 1.5
    )
  ) && isVolumeConfirmed;

  // Late join: prior candle completed the reclaim, and current candle is consolidating / continuing
  const prevReclaimed = prev2 ? (prev.c > prev2.h || (prev.c > prev.o && prev.c > prev2.c)) : false;
  const isLateJoinCandidate = isPullback && !isImmediateReclaim && prevReclaimed && (last.c >= prev.o);

  const reclaimed = isImmediateReclaim || isLateJoinCandidate;
  const isActiveFalling = isPullback && !reclaimed && (last.c < last.o || last.c < prev.c);

  return {
    isPullback,
    retracement: +retracement.toFixed(3),
    isActiveFalling,
    reclaimed,
    isLateJoinCandidate,
  };
}

export interface InducementState {
  hasInducement: boolean;
  status: 'IDM_SWEPT' | 'IDM_ACTIVE_TRAP' | 'DIRECT_STRUCTURAL_TOUCH' | 'NO_INDUCEMENT';
  inducementPrice: number | null;
  inducementTimeframe?: '1H';
  majorLevelPrice: number | null;
  sweepCandleTime: number | null;
  sweepDepthPct?: number | null;
  sweepVolumeRatio?: number | null;
  isSafeToEnter: boolean;
  summary: string;
}

/**
 * Smart Money Concept (SMC) Inducement & Liquidity Sweep Detection:
 * Identifies internal minor swing pivots formed above major structural support (or below resistance).
 * If price bounces prematurely off an internal pivot without having swept it, flags it as an
 * Inducement Trap (IDM_ACTIVE_TRAP) to prevent entering right before retail stops get harvested.
 */
export function evaluateInducement(
  price: number,
  candles: Candle[],
  majorLevel: Level | null,
  atrValue: number,
  direction: 'LONG' | 'SHORT' = 'LONG'
): InducementState {
  if (!candles || candles.length < 10 || !(price > 0) || !(atrValue > 0)) {
    return {
      hasInducement: false,
      status: 'NO_INDUCEMENT',
      inducementPrice: null,
      inducementTimeframe: '1H',
      majorLevelPrice: majorLevel ? majorLevel.price : null,
      sweepCandleTime: null,
      sweepDepthPct: null,
      sweepVolumeRatio: null,
      isSafeToEnter: true,
      summary: 'Insufficient candles for inducement analysis.',
    };
  }

  const lastCandle = candles[candles.length - 1];
  const volWindow = candles.slice(-21, -1);
  const avgVol = volWindow.length > 0 
    ? volWindow.reduce((acc, c) => acc + (c.v || 0), 0) / volWindow.length 
    : 0;

  if (direction === 'LONG') {
    const majorSupportPrice = majorLevel ? majorLevel.price : null;

    // If price is already right at the major structural support (within 0.20 ATR),
    // it's touching institutional bids directly, not hanging in no-man's-land.
    if (majorSupportPrice && Math.abs(price - majorSupportPrice) <= atrValue * 0.20) {
      return {
        hasInducement: false,
        status: 'DIRECT_STRUCTURAL_TOUCH',
        inducementPrice: null,
        inducementTimeframe: '1H',
        majorLevelPrice: majorSupportPrice,
        sweepCandleTime: null,
        sweepDepthPct: null,
        sweepVolumeRatio: null,
        isSafeToEnter: true,
        summary: `Direct touch of primary ${majorLevel?.touches ?? 2}-touch support ($${majorSupportPrice.toFixed(4)}). Pristine structural bounce.`,
      };
    }

    // Find minor swing lows in the last 16 hourly candles
    const recentCandles = candles.slice(-16);
    const pivots = swingPivots(recentCandles, 1).filter((p) => p.kind === 'LOW');

    // Look for an internal swing low that sits ABOVE major support
    // (between 0.15 ATR and 1.20 ATR above major support, and below current price)
    const candidates = pivots.filter((p) => {
      if (majorSupportPrice) {
        return p.price > majorSupportPrice + atrValue * 0.15 && p.price < price;
      }
      return p.price < price && (price - p.price) <= atrValue * 1.0;
    });

    if (candidates.length === 0) {
      return {
        hasInducement: false,
        status: 'NO_INDUCEMENT',
        inducementPrice: null,
        inducementTimeframe: '1H',
        majorLevelPrice: majorSupportPrice,
        sweepCandleTime: null,
        sweepDepthPct: null,
        sweepVolumeRatio: null,
        isSafeToEnter: true,
        summary: 'No unswept internal inducement low detected.',
      };
    }

    // Most recent internal low is the primary inducement
    const idm = candidates[candidates.length - 1];
    const idmPrice = idm.price;

    // Check if any candle AFTER this pivot's creation swept below its low
    const candlesAfterIdm = recentCandles.filter((c) => c.t > idm.time);
    const sweepCandle = candlesAfterIdm.find((c) => c.l < idmPrice);

    if (sweepCandle) {
      const sweepDepthPct = idmPrice > 0 ? +(((idmPrice - sweepCandle.l) / idmPrice) * 100).toFixed(2) : 0;
      const sweepVolumeRatio = avgVol > 0 ? +((sweepCandle.v || 0) / avgVol).toFixed(2) : 1.0;

      // It swept below the inducement low. Did price reclaim back above it?
      if (lastCandle.c >= idmPrice || (lastCandle.c > lastCandle.o && lastCandle.c >= sweepCandle.c)) {
        return {
          hasInducement: true,
          status: 'IDM_SWEPT',
          inducementPrice: idmPrice,
          inducementTimeframe: '1H',
          majorLevelPrice: majorSupportPrice,
          sweepCandleTime: sweepCandle.t,
          sweepDepthPct,
          sweepVolumeRatio,
          isSafeToEnter: true,
          summary: `Inducement low at $${idmPrice.toFixed(4)} swept (-${sweepDepthPct}% flush, ${sweepVolumeRatio}x volume)! Resting stops cleared; green reclaim confirmed.`,
        };
      } else {
        return {
          hasInducement: true,
          status: 'IDM_ACTIVE_TRAP',
          inducementPrice: idmPrice,
          inducementTimeframe: '1H',
          majorLevelPrice: majorSupportPrice,
          sweepCandleTime: sweepCandle.t,
          sweepDepthPct,
          sweepVolumeRatio,
          isSafeToEnter: false,
          summary: `Sweep in progress beneath $${idmPrice.toFixed(4)} (-${sweepDepthPct}%). Waiting for green reclaim candle.`,
        };
      }
    }

    // If candles have NOT swept below idmPrice, and price is bouncing prematurely:
    // Retail is buying a premature bounce. High trap risk.
    return {
      hasInducement: true,
      status: 'IDM_ACTIVE_TRAP',
      inducementPrice: idmPrice,
      inducementTimeframe: '1H',
      majorLevelPrice: majorSupportPrice,
      sweepCandleTime: null,
      sweepDepthPct: null,
      sweepVolumeRatio: null,
      isSafeToEnter: false,
      summary: `Premature bounce above unswept inducement low ($${idmPrice.toFixed(4)}). High risk of stop-hunt sweep into major support ($${majorSupportPrice ? majorSupportPrice.toFixed(4) : 'below'}).`,
    };
  }

  // SHORT side
  const majorResistancePrice = majorLevel ? majorLevel.price : null;
  if (majorResistancePrice && Math.abs(price - majorResistancePrice) <= atrValue * 0.20) {
    return {
      hasInducement: false,
      status: 'DIRECT_STRUCTURAL_TOUCH',
      inducementPrice: null,
      inducementTimeframe: '1H',
      majorLevelPrice: majorResistancePrice,
      sweepCandleTime: null,
      sweepDepthPct: null,
      sweepVolumeRatio: null,
      isSafeToEnter: true,
      summary: `Direct touch of primary resistance ($${majorResistancePrice.toFixed(4)}).`,
    };
  }

  const recentCandles = candles.slice(-16);
  const pivots = swingPivots(recentCandles, 1).filter((p) => p.kind === 'HIGH');
  const candidates = pivots.filter((p) => {
    if (majorResistancePrice) {
      return p.price < majorResistancePrice - atrValue * 0.15 && p.price > price;
    }
    return p.price > price && (p.price - price) <= atrValue * 1.0;
  });

  if (candidates.length === 0) {
    return {
      hasInducement: false,
      status: 'NO_INDUCEMENT',
      inducementPrice: null,
      inducementTimeframe: '1H',
      majorLevelPrice: majorResistancePrice,
      sweepCandleTime: null,
      sweepDepthPct: null,
      sweepVolumeRatio: null,
      isSafeToEnter: true,
      summary: 'No unswept internal inducement high detected.',
    };
  }

  const idm = candidates[candidates.length - 1];
  const idmPrice = idm.price;
  const candlesAfterIdm = recentCandles.filter((c) => c.t > idm.time);
  const sweepCandle = candlesAfterIdm.find((c) => c.h > idmPrice);

  if (sweepCandle) {
    const sweepDepthPct = idmPrice > 0 ? +(((sweepCandle.h - idmPrice) / idmPrice) * 100).toFixed(2) : 0;
    const sweepVolumeRatio = avgVol > 0 ? +((sweepCandle.v || 0) / avgVol).toFixed(2) : 1.0;

    if (lastCandle.c <= idmPrice) {
      return {
        hasInducement: true,
        status: 'IDM_SWEPT',
        inducementPrice: idmPrice,
        inducementTimeframe: '1H',
        majorLevelPrice: majorResistancePrice,
        sweepCandleTime: sweepCandle.t,
        sweepDepthPct,
        sweepVolumeRatio,
        isSafeToEnter: true,
        summary: `Inducement high at $${idmPrice.toFixed(4)} swept (+${sweepDepthPct}% flush, ${sweepVolumeRatio}x volume)! Early short stops cleared; bearish reclaim confirmed.`,
      };
    }
    return {
      hasInducement: true,
      status: 'IDM_ACTIVE_TRAP',
      inducementPrice: idmPrice,
      inducementTimeframe: '1H',
      majorLevelPrice: majorResistancePrice,
      sweepCandleTime: sweepCandle.t,
      sweepDepthPct,
      sweepVolumeRatio,
      isSafeToEnter: false,
      summary: `Upside sweep in progress above $${idmPrice.toFixed(4)} (+${sweepDepthPct}%). Waiting for red rejection close.`,
    };
  }

  return {
    hasInducement: true,
    status: 'IDM_ACTIVE_TRAP',
    inducementPrice: idmPrice,
    inducementTimeframe: '1H',
    majorLevelPrice: majorResistancePrice,
    sweepCandleTime: null,
    sweepDepthPct: null,
    sweepVolumeRatio: null,
    isSafeToEnter: false,
    summary: `Premature drop below unswept inducement high ($${idmPrice.toFixed(4)}). High risk of stop-hunt sweep higher.`,
  };
}
