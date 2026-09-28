// Market structure on one timeframe (ENGINE_PLAN.md Section 8.2, v2 7.1).
//
// Up: the last two confirmed swing highs rise and the last two swing lows
// rise, and no candle has closed below the protected low since the latest
// higher high. The protected low is the swing low that produced that higher
// high: the last swing low before it. Down mirrors this with the protected
// high.
//
// When the protected level of the latest trend has been closed through and
// the opposite structure is not confirmed yet, the timeframe is `none` with
// `broken` naming the trend that broke. Only closes count, never wicks.
import { swingPivots, type Pivot } from './indicators';

export type Trend = 'up' | 'down' | 'none';

export interface TfStructure {
  trend: Trend;
  /** The trend whose protected level was closed through, while the opposite trend is not confirmed yet. */
  broken: 'up' | 'down' | null;
  protectedLow: number | null;
  protectedHigh: number | null;
  /** Last two confirmed swing highs and lows, oldest first. */
  highs: Pivot[];
  lows: Pivot[];
}

interface Pattern {
  dir: 'up' | 'down';
  /** Index of the latest higher high (up) or lower low (down). */
  extremeIndex: number;
  protected: Pivot | null;
}

function patternOf(highs: Pivot[], lows: Pivot[]): Pattern | null {
  if (highs.length < 2 || lows.length < 2) return null;
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  if (h2.price > h1.price && l2.price > l1.price) {
    const prot = [...lows].reverse().find((l) => l.index < h2.index) ?? null;
    return { dir: 'up', extremeIndex: h2.index, protected: prot };
  }
  if (h2.price < h1.price && l2.price < l1.price) {
    const prot = [...highs].reverse().find((h) => h.index < l2.index) ?? null;
    return { dir: 'down', extremeIndex: l2.index, protected: prot };
  }
  return null;
}

/** True if a close after `from` went through the pattern's protected level. */
function isBroken(p: Pattern, close: number[]): boolean {
  if (!p.protected) return false;
  const level = p.protected.price;
  for (let i = p.extremeIndex + 1; i < close.length; i++) {
    if (p.dir === 'up' ? close[i] < level : close[i] > level) return true;
  }
  return false;
}

/** Structure as of the last candle given. Uses only those candles. */
export function analyzeStructure(c: { high: number[]; low: number[]; close: number[] }, k: number): TfStructure {
  const pivots = swingPivots(c.high, c.low, k).sort((a, b) => a.confirmedAt - b.confirmedAt || a.index - b.index);
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  // The latest trend pattern seen as pivots were confirmed one by one.
  let last: Pattern | null = null;
  for (const p of pivots) {
    (p.type === 'high' ? highs : lows).push(p);
    const now = patternOf(highs, lows);
    if (now) last = now;
  }
  const current = patternOf(highs, lows);
  const base = { highs: highs.slice(-2), lows: lows.slice(-2) };

  if (current && !isBroken(current, c.close)) {
    return {
      ...base,
      trend: current.dir,
      broken: null,
      protectedLow: current.dir === 'up' ? current.protected?.price ?? null : null,
      protectedHigh: current.dir === 'down' ? current.protected?.price ?? null : null,
    };
  }
  const brokenTrend = current ?? last;
  const broken = brokenTrend && isBroken(brokenTrend, c.close) ? brokenTrend.dir : null;
  return { ...base, trend: 'none', broken, protectedLow: null, protectedHigh: null };
}
