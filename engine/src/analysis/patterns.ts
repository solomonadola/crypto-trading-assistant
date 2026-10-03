// Chart reading on one timeframe, for the dashboard: how the trend reads,
// classic patterns (triangles, rectangles, wedges, channels, double tops and
// bottoms) and a Wyckoff accumulation or distribution range. These are
// heuristics that describe the chart; the engine's entry rules do not use them.
//
// All of it works on closed candles only, measured in ATRs so the same rules
// fit any coin and timeframe.
import type { Candle } from '../../../shared/types';
import { adx, atr, ema, sma, swingPivots, type Pivot } from './indicators';
import { analyzeStructure, type Trend } from './structure';

const PIVOT_K = 3;

// ---------------------------------------------------------------- trend

export interface TrendRead {
  direction: 'up' | 'down' | 'range';
  /** Strong: structure, EMAs and slope all agree and ADX is at least 25. Null in a range. */
  strength: 'strong' | 'weak' | null;
  /** Higher highs and higher lows (up), the reverse (down), or neither. */
  structure: Trend;
  adx: number | null;
  /** EMA20's change over the last 10 candles, in ATRs. */
  slopeAtr: number;
  detail: string;
}

/** Up or down when at least two of structure, EMA stack (price > EMA20 > EMA50) and EMA20 slope agree and none disagree. */
export function readTrend(c: Candle[]): TrendRead | null {
  const n = c.length;
  if (n < 60) return null;
  const high = c.map((x) => x.high);
  const low = c.map((x) => x.low);
  const close = c.map((x) => x.close);
  const i = n - 1;
  const a = atr(high, low, close, 14)[i];
  const e20 = ema(close, 20);
  const e50 = ema(close, 50)[i];
  const slopeAtr = a > 0 ? (e20[i] - e20[i - 10]) / a : 0;
  const ax = adx(high, low, close, 14).adx[i];
  const structure = analyzeStructure({ high, low, close }, PIVOT_K).trend;

  const up = [structure === 'up', close[i] > e20[i] && e20[i] > e50, slopeAtr > 0.2];
  const down = [structure === 'down', close[i] < e20[i] && e20[i] < e50, slopeAtr < -0.2];
  const nUp = up.filter(Boolean).length;
  const nDown = down.filter(Boolean).length;
  const direction = nUp >= 2 && nDown === 0 ? 'up' : nDown >= 2 && nUp === 0 ? 'down' : 'range';
  const adxValue = Number.isFinite(ax) ? ax : null;
  const strength = direction === 'range' ? null : (direction === 'up' ? nUp : nDown) === 3 && (adxValue ?? 0) >= 25 ? 'strong' : 'weak';

  const parts = [
    structure === 'up' ? 'higher highs and higher lows' : structure === 'down' ? 'lower highs and lower lows' : 'no clean swing sequence',
    close[i] > e20[i] && e20[i] > e50 ? 'price above EMA20 above EMA50' : close[i] < e20[i] && e20[i] < e50 ? 'price below EMA20 below EMA50' : 'EMAs mixed',
    `EMA20 ${slopeAtr >= 0 ? 'rising' : 'falling'} ${Math.abs(slopeAtr).toFixed(1)} ATR over 10 candles`,
    adxValue === null ? null : `ADX ${adxValue.toFixed(0)}`,
  ].filter(Boolean);
  return { direction, strength, structure, adx: adxValue, slopeAtr, detail: parts.join('; ') };
}

// ---------------------------------------------------------------- patterns

export type PatternKind =
  | 'ascending_triangle' | 'descending_triangle' | 'symmetrical_triangle' | 'rectangle'
  | 'rising_wedge' | 'falling_wedge' | 'ascending_channel' | 'descending_channel'
  | 'double_top' | 'double_bottom';

export interface Line { t1: number; p1: number; t2: number; p2: number }

export interface ChartPattern {
  kind: PatternKind;
  label: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  /** Open time of the pattern's first candle. */
  from: number;
  /** Resistance side (for a double top: the tops). Runs from its first pivot to the last candle. */
  upper: Line;
  /** Support side (for a double top: the neckline). */
  lower: Line;
  touches: { upper: number; lower: number };
  status: 'forming' | 'broke_up' | 'broke_down';
  /** The pattern's height projected from the breakout: where a measured move would aim. Null while forming. */
  target: number | null;
  detail: string;
}

const LABEL: Record<PatternKind, string> = {
  ascending_triangle: 'Ascending triangle', descending_triangle: 'Descending triangle', symmetrical_triangle: 'Symmetrical triangle',
  rectangle: 'Rectangle', rising_wedge: 'Rising wedge', falling_wedge: 'Falling wedge',
  ascending_channel: 'Ascending channel', descending_channel: 'Descending channel', double_top: 'Double top', double_bottom: 'Double bottom',
};
const BIAS: Record<PatternKind, ChartPattern['bias']> = {
  ascending_triangle: 'bullish', descending_triangle: 'bearish', symmetrical_triangle: 'neutral', rectangle: 'neutral',
  rising_wedge: 'bearish', falling_wedge: 'bullish', ascending_channel: 'bullish', descending_channel: 'bearish',
  double_top: 'bearish', double_bottom: 'bullish',
};

/** Pattern lines that fit pivots within this many ATRs. */
const FIT_ATR = 0.35;
/** A line moving less than this many ATRs over the whole pattern counts as flat. */
const FLAT_ATR = 0.75;
/** A close this many ATRs beyond a line is a breakout. */
const BREAK_ATR = 0.2;
/** Breakouts older than this many candles are history, not a pattern to show. */
const MAX_AGE_AFTER_BREAK = 20;
const LOOKBACK = 120;

interface Fit { slope: number; intercept: number }
const at = (f: Fit, i: number) => f.intercept + f.slope * i;

function fitLine(points: Pivot[]): Fit {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.index, 0) / n;
  const my = points.reduce((s, p) => s + p.price, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) { num += (p.index - mx) * (p.price - my); den += (p.index - mx) ** 2; }
  const slope = den ? num / den : 0;
  return { slope, intercept: my - slope * mx };
}

/** First close beyond the lines from `from` on: the breakout's index and side. */
function breakout(close: number[], from: number, up: Fit, lo: Fit, a: number): { index: number; side: 'up' | 'down' } | null {
  for (let i = from; i < close.length; i++) {
    if (close[i] > at(up, i) + BREAK_ATR * a) return { index: i, side: 'up' };
    if (close[i] < at(lo, i) - BREAK_ATR * a) return { index: i, side: 'down' };
  }
  return null;
}

/** Triangles, rectangles, wedges and channels: lines through the latest swing highs and lows. */
function linePattern(c: Candle[], pivots: Pivot[], a: number): ChartPattern | null {
  const n = c.length;
  const close = c.map((x) => x.close);
  const recent = pivots.filter((p) => p.index >= n - LOOKBACK);
  const allHighs = recent.filter((p) => p.type === 'high');
  const allLows = recent.filter((p) => p.type === 'low');
  // The most pivots that still fit a line, from 4 down to 2 on each side.
  for (let mh = Math.min(4, allHighs.length); mh >= 2; mh--) {
    for (let ml = Math.min(4, allLows.length); ml >= 2; ml--) {
      const highs = allHighs.slice(-mh);
      const lows = allLows.slice(-ml);
      // The two sides must overlap in time.
      if (highs[0].index > lows[lows.length - 1].index || lows[0].index > highs[highs.length - 1].index) continue;
      const up = fitLine(highs);
      const lo = fitLine(lows);
      if (highs.some((p) => Math.abs(p.price - at(up, p.index)) > FIT_ATR * a)) continue;
      if (lows.some((p) => Math.abs(p.price - at(lo, p.index)) > FIT_ATR * a)) continue;
      const start = Math.min(highs[0].index, lows[0].index);
      const lastPivot = Math.max(highs[highs.length - 1].index, lows[lows.length - 1].index);
      const end = n - 1;
      const len = end - start;
      if (len < 15) continue;
      const h0 = at(up, start) - at(lo, start);
      const h1 = at(up, end) - at(lo, end);
      if (h0 < 1.5 * a || h1 <= 0) continue;   // too thin, or the lines have already crossed
      // No close through either line while the pattern was being drawn.
      if (breakout(close.slice(0, lastPivot + 1), start, up, lo, a)) continue;
      const brk = breakout(close, lastPivot + 1, up, lo, a);
      if (brk && end - brk.index > MAX_AGE_AFTER_BREAK) continue;

      const dU = (up.slope * len) / a;
      const dL = (lo.slope * len) / a;
      const flatU = Math.abs(dU) < FLAT_ATR;
      const flatL = Math.abs(dL) < FLAT_ATR;
      const narrowing = h1 < 0.75 * h0;
      const parallel = h1 >= 0.75 * h0 && h1 <= 1.25 * h0;
      const kind: PatternKind | null =
        flatU && flatL ? 'rectangle'
        : flatU && dL > 0 ? 'ascending_triangle'
        : dU < 0 && flatL ? 'descending_triangle'
        : dU < 0 && dL > 0 ? 'symmetrical_triangle'
        : dU > 0 && dL > 0 ? (narrowing ? 'rising_wedge' : parallel ? 'ascending_channel' : null)
        : dU < 0 && dL < 0 ? (narrowing ? 'falling_wedge' : parallel ? 'descending_channel' : null)
        : null;
      if (!kind) continue;

      const t = (i: number) => c[i].openTime;
      const status = brk ? (brk.side === 'up' ? 'broke_up' : 'broke_down') : 'forming';
      const target = !brk ? null : brk.side === 'up' ? at(up, brk.index) + h0 : at(lo, brk.index) - h0;
      return {
        kind, label: LABEL[kind], bias: BIAS[kind], from: t(start),
        // Each line from its own first swing point to the last candle.
        upper: { t1: t(highs[0].index), p1: at(up, highs[0].index), t2: t(end), p2: at(up, end) },
        lower: { t1: t(lows[0].index), p1: at(lo, lows[0].index), t2: t(end), p2: at(lo, end) },
        touches: { upper: highs.length, lower: lows.length },
        status, target,
        detail: `${highs.length} swing highs and ${lows.length} swing lows on two lines over ${len} candles` +
          (brk ? `; closed ${brk.side === 'up' ? 'above resistance' : 'below support'} ${end - brk.index} candles ago` : '; price still inside'),
      };
    }
  }
  return null;
}

/** Two tops (or bottoms) at about the same price with a clear dip (or rally) between them. */
function doublePattern(c: Candle[], pivots: Pivot[], a: number, side: 'top' | 'bottom'): ChartPattern | null {
  const n = c.length;
  const close = c.map((x) => x.close);
  const ext = pivots.filter((p) => p.type === (side === 'top' ? 'high' : 'low'));
  if (ext.length < 2) return null;
  const [p1, p2] = ext.slice(-2);
  if (p2.index - p1.index < 8 || p2.index < n - 40) return null;
  if (Math.abs(p1.price - p2.price) > 0.5 * a) return null;
  const between = c.slice(p1.index + 1, p2.index);
  const neck = side === 'top' ? Math.min(...between.map((x) => x.low)) : Math.max(...between.map((x) => x.high));
  const level = side === 'top' ? Math.max(p1.price, p2.price) : Math.min(p1.price, p2.price);
  const depth = Math.abs(level - neck);
  if (depth < 1.5 * a) return null;
  let brk: number | null = null;
  for (let i = p2.index + 1; i < n; i++) {
    // Closing beyond the tops (bottoms) cancels the pattern.
    if (side === 'top' ? close[i] > level + BREAK_ATR * a : close[i] < level - BREAK_ATR * a) return null;
    if (brk === null && (side === 'top' ? close[i] < neck - BREAK_ATR * a : close[i] > neck + BREAK_ATR * a)) brk = i;
  }
  if (brk !== null && n - 1 - brk > MAX_AGE_AFTER_BREAK) return null;
  const kind = side === 'top' ? 'double_top' : 'double_bottom';
  const t1 = c[p1.index].openTime;
  const t2 = c[n - 1].openTime;
  const peaks = { t1, p1: level, t2, p2: level };
  const neckline = { t1, p1: neck, t2, p2: neck };
  return {
    kind, label: LABEL[kind], bias: BIAS[kind], from: t1,
    upper: side === 'top' ? peaks : neckline,
    lower: side === 'top' ? neckline : peaks,
    touches: side === 'top' ? { upper: 2, lower: 1 } : { upper: 1, lower: 2 },
    status: brk === null ? 'forming' : side === 'top' ? 'broke_down' : 'broke_up',
    target: brk === null ? null : side === 'top' ? neck - depth : neck + depth,
    detail: `${side === 'top' ? 'tops' : 'bottoms'} ${p2.index - p1.index} candles apart within ${(Math.abs(p1.price - p2.price) / a).toFixed(1)} ATR; ` +
      (brk === null ? `neckline ${side === 'top' ? 'below' : 'above'} not broken yet` : `closed through the neckline ${n - 1 - brk} candles ago`),
  };
}

export function findPatterns(c: Candle[]): ChartPattern[] {
  if (c.length < 60) return [];
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14)[c.length - 1];
  if (!(a > 0)) return [];
  const pivots = swingPivots(c.map((x) => x.high), c.map((x) => x.low), PIVOT_K);
  return [linePattern(c, pivots, a), doublePattern(c, pivots, a, 'top'), doublePattern(c, pivots, a, 'bottom')]
    .filter((p): p is ChartPattern => p !== null);
}

// ---------------------------------------------------------------- Wyckoff

export type WyckoffEventName = 'SC' | 'BC' | 'AR' | 'ST' | 'Spring' | 'UTAD' | 'Test' | 'SOS' | 'SOW' | 'LPS' | 'LPSY';

export interface WyckoffEvent { name: WyckoffEventName; time: number; price: number; why: string }

export interface WyckoffRange {
  kind: 'accumulation' | 'distribution';
  /**
   * A: the old trend stopped (climax and automatic reaction). B: building the
   * range (secondary test). C: the shakeout (spring or upthrust). D: the
   * breakout (sign of strength or weakness). E: trending away from the range.
   */
  phase: 'A' | 'B' | 'C' | 'D' | 'E';
  top: number;
  bottom: number;
  /** Open time of the climax candle. */
  from: number;
  events: WyckoffEvent[];
  detail: string;
}

interface Bars { time: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }
interface RawEvent { name: 'climax' | 'AR' | 'ST' | 'shakeout' | 'Test' | 'breakout' | 'LP'; index: number; price: number; why: string }
interface RawRange { phase: WyckoffRange['phase']; top: number; bottom: number; climax: number; events: RawEvent[] }

const MAX_CLIMAX_AGE = 250;

/**
 * Accumulation read on the bars as given; distribution is the same read on
 * the bars turned upside down. The latest selling climax that a trading range
 * grew from: a high-volume, wide candle making a new low after a decline,
 * then the automatic rally (the range top), a secondary test of the low on
 * less volume, a spring (a dip under the range that closes back inside), a
 * sign of strength (a close above the range on above-average volume) and the
 * last point of support (a pullback that holds near the old top).
 */
function accumulation(b: Bars): RawRange | null {
  const n = b.close.length;
  const a = atr(b.high, b.low, b.close, 14);
  const vAvg = sma(b.volume, 20);
  for (let i = n - 6; i >= Math.max(50, n - MAX_CLIMAX_AGE); i--) {
    const ai = a[i];
    if (!(ai > 0) || !(vAvg[i - 1] > 0)) continue;
    // Selling climax.
    if (b.volume[i] < 2 * vAvg[i - 1] || b.high[i] - b.low[i] < 1.5 * ai) continue;
    if (b.close[i - 20] - b.low[i] < 4 * ai) continue;
    const window = b.low.slice(i - 50, Math.min(n, i + 6));
    if (b.low[i] > Math.min(...window)) continue;
    // Automatic rally: the highest high in the next 20 candles.
    let j = i + 1;
    for (let k = i + 1; k <= Math.min(n - 1, i + 20); k++) if (b.high[k] > b.high[j]) j = k;
    const bottom = b.low[i];
    const top = b.high[j];
    if (top - bottom < 2 * ai || j > n - 3) continue;
    // A trading range, not a spike and its unwind: at most 8 ATRs tall, measured before the climax widened the ATR.
    if (top - bottom > 8 * (a[i - 1] > 0 ? a[i - 1] : ai)) continue;

    const events: RawEvent[] = [
      { name: 'climax', index: i, price: bottom, why: `volume ${(b.volume[i] / vAvg[i - 1]).toFixed(1)}x average on a ${((b.high[i] - b.low[i]) / ai).toFixed(1)} ATR candle at a new low after a decline` },
      { name: 'AR', index: j, price: top, why: 'the rally after the climax: sets the top of the range' },
    ];
    const has = (name: RawEvent['name']) => events.find((e) => e.name === name);
    // "Near the low": within a fifth of the range's height, or 0.75 ATR when that is more.
    const near = (ak: number) => Math.max(0.75 * ak, 0.2 * (top - bottom));
    let failed = false;
    let below = 0;
    for (let k = j + 1; k < n; k++) {
      const ak = a[k] > 0 ? a[k] : ai;
      // Closing well under the range and staying there: the range failed, the decline went on.
      below = b.close[k] < bottom - 0.5 * ak ? below + 1 : 0;
      if (below >= 3 && !has('breakout')) { failed = true; break; }
      if (!has('ST') && !has('shakeout') && !has('breakout') && k >= j + 2 && b.low[k] <= bottom + near(ak) && b.low[k] >= bottom - 0.1 * ak && b.volume[k] < b.volume[i]) {
        events.push({ name: 'ST', index: k, price: b.low[k], why: 'back to the climax low on less volume' });
      }
      if (!has('shakeout') && !has('breakout') && b.low[k] < bottom - 0.1 * ak) {
        const back = [k, k + 1, k + 2, k + 3].find((m) => m < n && b.close[m] > bottom);
        if (back !== undefined) events.push({ name: 'shakeout', index: k, price: b.low[k], why: `dipped under the range and closed back inside${back > k ? ` ${back - k} candles later` : ''}` });
      }
      const shake = has('shakeout');
      if (shake && !has('Test') && !has('breakout') && k >= shake.index + 2 && b.low[k] > shake.price && b.low[k] <= bottom + near(ak) && b.volume[k] < b.volume[shake.index]) {
        events.push({ name: 'Test', index: k, price: b.low[k], why: 'retested the shakeout low on less volume and held' });
      }
      // A breakout counts once the range has had time to build (15 candles after the rally).
      if (!has('breakout') && k >= j + 15 && b.close[k] > top + 0.2 * ak && b.volume[k] > (vAvg[k] || 0)) {
        events.push({ name: 'breakout', index: k, price: b.close[k], why: 'closed above the range on above-average volume' });
      }
      const brk = has('breakout');
      if (brk && !has('LP') && k > brk.index && k + 1 < n && b.low[k] < b.low[k - 1] && b.low[k] <= b.low[k + 1] && b.low[k] >= top - 0.75 * ak) {
        events.push({ name: 'LP', index: k, price: b.low[k], why: 'pullback after the breakout that held near the old range top' });
      }
    }
    if (failed) continue;
    const brk = has('breakout');
    // A trading range, not a trend passing through: most closes from the rally to the breakout stay in the box.
    const inRange = b.close.slice(j, brk ? brk.index : n);
    const inside = inRange.filter((x, m) => {
      const am = a[j + m] > 0 ? a[j + m] : ai;
      return x >= bottom - 0.5 * am && x <= top + 0.5 * am;
    }).length;
    if (inside < 0.8 * inRange.length) continue;
    // A range left long ago is history.
    if (brk && n - 1 - brk.index > 60) continue;
    const last = b.close[n - 1];
    const phase = last > top + (top - bottom) ? 'E' : brk ? 'D' : has('shakeout') ? 'C' : has('ST') ? 'B' : 'A';
    return { phase, top, bottom, climax: i, events: events.sort((x, y) => x.index - y.index) };
  }
  return null;
}

const NAMES: Record<'accumulation' | 'distribution', Record<RawEvent['name'], WyckoffEventName>> = {
  accumulation: { climax: 'SC', AR: 'AR', ST: 'ST', shakeout: 'Spring', Test: 'Test', breakout: 'SOS', LP: 'LPS' },
  distribution: { climax: 'BC', AR: 'AR', ST: 'ST', shakeout: 'UTAD', Test: 'Test', breakout: 'SOW', LP: 'LPSY' },
};
const DISTRIBUTION_WHY: Record<RawEvent['name'], (why: string) => string> = {
  climax: (w) => w.replace('new low after a decline', 'new high after a rise'),
  AR: () => 'the drop after the climax: sets the bottom of the range',
  ST: () => 'back to the climax high on less volume',
  shakeout: (w) => w.replace('dipped under', 'pushed above'),
  Test: () => 'retested the upthrust high on less volume and failed',
  breakout: () => 'closed below the range on above-average volume',
  LP: () => 'bounce after the breakdown that stalled near the old range bottom',
};
const PHASE_TEXT: Record<WyckoffRange['phase'], string> = {
  A: 'phase A: the old trend has stopped',
  B: 'phase B: building the range',
  C: 'phase C: the shakeout has happened, waiting for the breakout',
  D: 'phase D: broke out of the range',
  E: 'phase E: trending away from the range',
};

export function findWyckoff(c: Candle[]): WyckoffRange | null {
  if (c.length < 60) return null;
  const time = c.map((x) => x.openTime);
  const volume = c.map((x) => x.volume);
  const acc = accumulation({ time, volume, high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close) });
  // Upside down: highs become lows, so a buying climax reads as a selling climax.
  const dist = accumulation({ time, volume, high: c.map((x) => -x.low), low: c.map((x) => -x.high), close: c.map((x) => -x.close) });
  const pick = acc && (!dist || acc.climax >= dist.climax) ? { kind: 'accumulation' as const, r: acc } : dist ? { kind: 'distribution' as const, r: dist } : null;
  if (!pick) return null;
  const { kind, r } = pick;
  const flip = kind === 'distribution' ? -1 : 1;
  const events = r.events.map((e) => ({
    name: NAMES[kind][e.name],
    time: time[e.index],
    price: e.price * flip,
    why: kind === 'distribution' ? DISTRIBUTION_WHY[e.name](e.why) : e.why,
  }));
  const top = kind === 'distribution' ? -r.bottom : r.top;
  const bottom = kind === 'distribution' ? -r.top : r.bottom;
  return {
    kind, phase: r.phase, top, bottom, from: time[r.climax], events,
    detail: `Possible ${kind}, ${PHASE_TEXT[r.phase]}. Found: ${events.map((e) => e.name).join(', ')}.`,
  };
}

// ---------------------------------------------------------------- together

export interface ChartReading {
  tf: string;
  /** Open time of the last closed candle read. */
  asOf: number;
  trend: TrendRead | null;
  patterns: ChartPattern[];
  wyckoff: WyckoffRange | null;
}

export function readChart(c: Candle[], tf: string): ChartReading {
  return { tf, asOf: c[c.length - 1]?.openTime ?? 0, trend: readTrend(c), patterns: findPatterns(c), wyckoff: findWyckoff(c) };
}
