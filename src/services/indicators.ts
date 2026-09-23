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
  /** A candle has closed back up after the pullback (the "reclaim"). */
  reclaimed: boolean;
}

/**
 * A pullback inside an uptrend: price rose from a swing low to a swing high,
 * then came back part of the way without losing that low. `reclaimed` is the
 * confirmation a level-based entry waits for - the last candle closing back
 * above the previous candle's high.
 */
export function pullbackState(candles: Candle[], lookback = 2): PullbackState {
  const none: PullbackState = { isPullback: false, retracement: 0, reclaimed: false };
  if (candles.length < lookback * 2 + 3) return none;
  const s = structureFrom(candles, lookback);
  if (s.lastSwingHigh === null || s.lastSwingLow === null) return none;
  if (!(s.lastSwingHigh > s.lastSwingLow)) return none;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const impulse = s.lastSwingHigh - s.lastSwingLow;
  if (!(impulse > 0)) return none;

  const retracement = (s.lastSwingHigh - last.c) / impulse;
  return {
    isPullback: retracement > 0.1 && retracement < 1 && last.l >= s.lastSwingLow,
    retracement: +retracement.toFixed(3),
    reclaimed: last.c > prev.h,
  };
}
