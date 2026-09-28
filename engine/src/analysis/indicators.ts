// Technical indicators over closed candles. Every function is causal: the
// value at index i uses only inputs 0..i (swing pivots report the index at
// which they became known). Values not yet defined are NaN.
import type { Candle } from '../../../shared/types';

export type Series = number[];

export interface Columns {
  openTime: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  quoteVolume: number[];
}

export function columns(candles: Candle[]): Columns {
  return {
    openTime: candles.map((c) => c.openTime),
    open: candles.map((c) => c.open),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    volume: candles.map((c) => c.volume),
    quoteVolume: candles.map((c) => c.quoteVolume),
  };
}

const nans = (n: number): Series => new Array<number>(n).fill(NaN);

/** Index of the first window of n finite values, i.e. where a seeded average can start; -1 if none. */
function firstFullWindow(values: Series, n: number): number {
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    run = Number.isFinite(values[i]) ? run + 1 : 0;
    if (run === n) return i;
  }
  return -1;
}

/** Simple moving average of the last n values. */
export function sma(values: Series, n: number): Series {
  const out = nans(values.length);
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) sum += v; else bad++;
    if (i >= n) {
      const old = values[i - n];
      if (Number.isFinite(old)) sum -= old; else bad--;
    }
    if (i >= n - 1 && bad === 0) out[i] = sum / n;
  }
  return out;
}

/** Exponential average with weight `alpha`, seeded with the SMA of the first n finite values. */
function smoothed(values: Series, n: number, alpha: number): Series {
  const out = nans(values.length);
  const seedAt = firstFullWindow(values, n);
  if (seedAt < 0) return out;
  let acc = 0;
  for (let i = seedAt - n + 1; i <= seedAt; i++) acc += values[i];
  acc /= n;
  out[seedAt] = acc;
  for (let i = seedAt + 1; i < values.length; i++) {
    acc = alpha * values[i] + (1 - alpha) * acc;
    out[i] = acc;
  }
  return out;
}

/** Exponential moving average, 2/(n+1) weighting. */
export function ema(values: Series, n: number): Series {
  return smoothed(values, n, 2 / (n + 1));
}

/** Wilder's moving average (RMA), 1/n weighting. */
export function wilder(values: Series, n: number): Series {
  return smoothed(values, n, 1 / n);
}

/** Relative Strength Index with Wilder smoothing. First value at index n. */
export function rsi(close: Series, n = 14): Series {
  const out = nans(close.length);
  if (close.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n;
  loss /= n;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = value();
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value();
  }
  return out;
}

/** True range; the first bar, with no previous close, is high - low. */
export function trueRange(high: Series, low: Series, close: Series): Series {
  return high.map((h, i) => {
    const l = low[i];
    if (i === 0) return h - l;
    const pc = close[i - 1];
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
}

/** Average True Range, Wilder smoothing. First value at index n - 1. */
export function atr(high: Series, low: Series, close: Series, n = 14): Series {
  return wilder(trueRange(high, low, close), n);
}

export interface AdxResult {
  adx: Series;
  plusDI: Series;
  minusDI: Series;
}

/** Wilder's ADX with +DI and -DI. DI values from index n, ADX from index 2n - 1. */
export function adx(high: Series, low: Series, close: Series, n = 14): AdxResult {
  const len = high.length;
  const plusDI = nans(len);
  const minusDI = nans(len);
  const dx = nans(len);
  const result = { adx: nans(len), plusDI, minusDI };
  if (len <= n) return result;

  const tr = trueRange(high, low, close);
  const pdm = nans(len);
  const mdm = nans(len);
  for (let i = 1; i < len; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
  }
  // Wilder's running sums: first = sum of bars 1..n, then S - S/n + x.
  let sTr = 0, sP = 0, sM = 0;
  for (let i = 1; i <= n; i++) { sTr += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  for (let i = n; i < len; i++) {
    if (i > n) {
      sTr = sTr - sTr / n + tr[i];
      sP = sP - sP / n + pdm[i];
      sM = sM - sM / n + mdm[i];
    }
    plusDI[i] = sTr === 0 ? 0 : (100 * sP) / sTr;
    minusDI[i] = sTr === 0 ? 0 : (100 * sM) / sTr;
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
  }
  result.adx = wilder(dx, n);
  return result;
}

/** Choppiness Index: near 100 = ranging, near 0 = trending. First value at index n. */
export function choppiness(high: Series, low: Series, close: Series, n = 14): Series {
  const out = nans(high.length);
  const tr = trueRange(high, low, close);
  const logN = Math.log10(n);
  for (let i = n; i < high.length; i++) {
    let sum = 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      sum += tr[j];
      if (high[j] > hi) hi = high[j];
      if (low[j] < lo) lo = low[j];
    }
    const range = hi - lo;
    if (range > 0) out[i] = (100 * Math.log10(sum / range)) / logN;
  }
  return out;
}

/** Bollinger Band width: (upper - lower) / middle, population standard deviation. */
export function bollingerWidth(close: Series, n = 20, k = 2): Series {
  const out = nans(close.length);
  for (let i = n - 1; i < close.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += close[j];
    const mean = sum / n;
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (close[j] - mean) ** 2;
    const sd = Math.sqrt(sq / n);
    if (mean !== 0) out[i] = (2 * k * sd) / mean;
  }
  return out;
}

/** Volume-weighted average price of typical price (H+L+C)/3, restarting at 00:00 UTC each day. */
export function vwapDaily(c: Pick<Columns, 'openTime' | 'high' | 'low' | 'close' | 'volume'>): Series {
  const out = nans(c.close.length);
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < c.close.length; i++) {
    const d = Math.floor(c.openTime[i] / 86_400_000);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (c.high[i] + c.low[i] + c.close[i]) / 3;
    pv += tp * c.volume[i];
    vol += c.volume[i];
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

/**
 * Relative volume: this bar's volume over the average of the n bars before
 * it. The current bar is left out of its own average, so a spike is measured
 * against normal volume rather than partly against itself.
 */
export function rvol(volume: Series, n = 20): Series {
  const out = nans(volume.length);
  let sum = 0;
  for (let i = 0; i < volume.length; i++) {
    if (i >= n) {
      const avg = sum / n;
      if (avg > 0) out[i] = volume[i] / avg;
      sum -= volume[i - n];
    }
    sum += volume[i];
  }
  return out;
}

export interface Pivot {
  type: 'high' | 'low';
  /** Bar that is the pivot. */
  index: number;
  /** Bar at whose close the pivot became known: index + k. Never use it earlier. */
  confirmedAt: number;
  price: number;
}

/**
 * Swing pivots: a high strictly above the highs of the k bars on each side
 * (lows mirror). Only pivots with k bars after them exist, so a pivot never
 * appears or disappears as later bars arrive. Sorted by index.
 */
export function swingPivots(high: Series, low: Series, k: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i + k < high.length; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k && (isHigh || isLow); j++) {
      if (j === i) continue;
      if (high[j] >= high[i]) isHigh = false;
      if (low[j] <= low[i]) isLow = false;
    }
    if (isHigh) out.push({ type: 'high', index: i, confirmedAt: i + k, price: high[i] });
    if (isLow) out.push({ type: 'low', index: i, confirmedAt: i + k, price: low[i] });
  }
  return out;
}

export const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786] as const;

/**
 * Retracement prices of the leg from `from` to `to`: ratio 0 is `to`, ratio 1
 * is `from`. For an up leg pass (swing low, swing high); for a down leg
 * (swing high, swing low).
 */
export function fibLevel(from: number, to: number, ratio: number): number {
  return to - (to - from) * ratio;
}

export function fibRetracement(from: number, to: number): Record<string, number> {
  return Object.fromEntries(FIB_RATIOS.map((r) => [String(r), fibLevel(from, to, r)]));
}

export interface SuperTrend {
  /** The trailing line: below price in an uptrend, above it in a downtrend. */
  line: Series;
  /** 1 up, -1 down, NaN before there is enough data. */
  dir: Series;
}

/**
 * SuperTrend: bands at (high+low)/2 +/- mult x ATR(period), each only moving
 * in the trend's favour; the trend flips when a close crosses the active band.
 */
export function supertrend(high: Series, low: Series, close: Series, period = 10, mult = 3): SuperTrend {
  const n = close.length;
  const a = atr(high, low, close, period);
  const line = nans(n);
  const dir = nans(n);
  let upper = NaN;
  let lower = NaN;
  let d = 1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i])) continue;
    const mid = (high[i] + low[i]) / 2;
    const basicUpper = mid + mult * a[i];
    const basicLower = mid - mult * a[i];
    const prevClose = i > 0 ? close[i - 1] : close[i];
    upper = Number.isFinite(upper) && !(basicUpper < upper || prevClose > upper) ? upper : basicUpper;
    lower = Number.isFinite(lower) && !(basicLower > lower || prevClose < lower) ? lower : basicLower;
    if (!Number.isFinite(dir[i - 1])) d = close[i] >= mid ? 1 : -1;
    else if (d === 1 && close[i] < lower) d = -1;
    else if (d === -1 && close[i] > upper) d = 1;
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
  }
  return { line, dir };
}

export interface BollingerBands {
  middle: Series;
  upper: Series;
  lower: Series;
}

/** Bollinger Bands: SMA(n) +/- k population standard deviations. */
export function bollingerBands(close: Series, n = 20, k = 2): BollingerBands {
  const middle = sma(close, n);
  const upper = nans(close.length);
  const lower = nans(close.length);
  for (let i = n - 1; i < close.length; i++) {
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (close[j] - middle[i]) ** 2;
    const sd = Math.sqrt(sq / n);
    upper[i] = middle[i] + k * sd;
    lower[i] = middle[i] - k * sd;
  }
  return { middle, upper, lower };
}
