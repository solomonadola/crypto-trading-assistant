// Market structure drawn on the chart: the swing points named HH/HL/LH/LL,
// and every break of structure. A close through the latest swing high (low)
// is a break: a BOS when it goes the trend's way (or starts a trend), a CHoCH
// (change of character) when it goes against the trend and turns it.
//
// Only closes break structure, never wicks. A swing point is known `k`
// candles after it formed (when its candle has k lower highs, or higher lows,
// on each side), so nothing here looks ahead. For the dashboard: the engine's
// entries use structure.ts.
import type { Candle } from '../../../shared/types';
import { atr, swingPivots, type Pivot } from './indicators';

export type SwingLabel = 'HH' | 'HL' | 'LH' | 'LL';

export interface SwingPoint {
  type: 'high' | 'low';
  /** Open time of the swing candle. */
  time: number;
  price: number;
  /** Against the previous swing of the same type; null for the first. */
  label: SwingLabel | null;
}

export interface StructureBreak {
  kind: 'BOS' | 'CHoCH';
  dir: 'up' | 'down';
  /** The swing level that was closed through, and its candle's open time. */
  level: number;
  from: number;
  /** Open time of the candle that closed through it. */
  time: number;
}

export interface SwingStructure {
  tf: string;
  /** Open time of the last candle read. */
  asOf: number;
  trend: 'up' | 'down' | 'none';
  /** Swing points of the last `LOOKBACK` candles, alternating high and low, oldest first. */
  swings: SwingPoint[];
  /** Breaks of the last `LOOKBACK` candles, oldest first. */
  breaks: StructureBreak[];
  /** Closing above this breaks structure up (the latest unbroken swing high). */
  breakUp: { price: number; time: number } | null;
  /** Closing below this breaks structure down. In an uptrend it is the protected low. */
  breakDown: { price: number; time: number } | null;
  detail: string;
}

/** Candles shown; older swings and breaks are left out (they still set the trend). */
const LOOKBACK = 160;

/** Swing size per timeframe: the fast charts need wider swings to show the structure, not the noise. */
export const SWING_K: Record<string, number> = { '1m': 5, '5m': 5, '15m': 4, '1h': 3, '4h': 3 };

/** Highs and lows alternating: of two highs in a row the higher stays (two lows: the lower). */
function alternate(pivots: Pivot[]): Pivot[] {
  const out: Pivot[] = [];
  for (const p of [...pivots].sort((a, b) => a.index - b.index || (a.type === 'high' ? -1 : 1))) {
    const prev = out[out.length - 1];
    if (prev && prev.type === p.type) {
      if (p.type === 'high' ? p.price > prev.price : p.price < prev.price) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

export function readSwingStructure(c: Candle[], tf: string, k = SWING_K[tf] ?? 3): SwingStructure | null {
  const n = c.length;
  if (n < 4 * k + 10) return null;
  const high = c.map((x) => x.high);
  const low = c.map((x) => x.low);
  const close = c.map((x) => x.close);
  const pivots = swingPivots(high, low, k);
  const byConfirm = [...pivots].sort((a, b) => a.confirmedAt - b.confirmedAt || a.index - b.index);

  // Walk the candles: each swing point counts from the candle that confirms it.
  let trend: SwingStructure['trend'] = 'none';
  let hi = null as Pivot | null;
  let lo = null as Pivot | null;
  const breaks: (StructureBreak & { index: number })[] = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    while (next < byConfirm.length && byConfirm[next].confirmedAt <= i) {
      const p = byConfirm[next++];
      if (p.type === 'high') hi = p;
      else lo = p;
    }
    if (hi && close[i] > hi.price && i > hi.index) {
      breaks.push({ kind: trend === 'down' ? 'CHoCH' : 'BOS', dir: 'up', level: hi.price, from: c[hi.index].openTime, time: c[i].openTime, index: i });
      trend = 'up';
      hi = null;
    } else if (lo && close[i] < lo.price && i > lo.index) {
      breaks.push({ kind: trend === 'up' ? 'CHoCH' : 'BOS', dir: 'down', level: lo.price, from: c[lo.index].openTime, time: c[i].openTime, index: i });
      trend = 'down';
      lo = null;
    }
  }

  // Names against the previous swing of the same type, on the alternating sequence the chart draws.
  const seq = alternate(pivots);
  let lastHigh: Pivot | null = null;
  let lastLow: Pivot | null = null;
  const named: (SwingPoint & { index: number })[] = seq.map((p) => {
    const prev = p.type === 'high' ? lastHigh : lastLow;
    if (p.type === 'high') lastHigh = p;
    else lastLow = p;
    const label: SwingLabel | null = !prev ? null
      : p.type === 'high' ? (p.price > prev.price ? 'HH' : 'LH')
      : (p.price > prev.price ? 'HL' : 'LL');
    return { type: p.type, time: c[p.index].openTime, price: p.price, label, index: p.index };
  });

  const since = n - LOOKBACK;
  const swings = named.filter((s) => s.index >= since).map(({ index: _, ...s }) => s);
  const shownBreaks = breaks.filter((b) => b.index >= since).map(({ index: _, ...b }) => b);
  const breakUp = hi ? { price: hi.price, time: c[hi.index].openTime } : null;
  const breakDown = lo ? { price: lo.price, time: c[lo.index].openTime } : null;

  const lastBreak = breaks[breaks.length - 1];
  const ago = lastBreak ? n - 1 - lastBreak.index : 0;
  const a = atr(high, low, close, 14)[n - 1];
  const parts = [
    trend === 'none' ? 'no break of structure yet' : `${trend === 'up' ? 'bullish' : 'bearish'} structure`,
    lastBreak ? `last ${lastBreak.kind} ${lastBreak.dir} ${ago} candle${ago === 1 ? '' : 's'} ago` : null,
    trend === 'up' && breakDown ? `holds while closes stay above the protected low ${breakDown.price}` : null,
    trend === 'down' && breakUp ? `holds while closes stay below the protected high ${breakUp.price}` : null,
    a > 0 && breakUp && breakDown ? `range to the next break ${((breakUp.price - breakDown.price) / a).toFixed(1)} ATR` : null,
  ].filter(Boolean);
  return { tf, asOf: c[n - 1].openTime, trend, swings, breaks: shownBreaks, breakUp, breakDown, detail: parts.join('; ') };
}
