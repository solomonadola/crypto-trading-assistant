// Alternative entry ideas, for testing in the backtest against the pullback
// setup. Each looks at one coin at a 15m close and returns a trade or null.
// Pure. Parameters are passed in by the backtest's variants.
import type { Direction } from '../../../shared/types';
import { bollingerBands } from '../analysis/indicators';
import type { SessionInstance } from '../sessions';
import { lastOf, sign, type Context } from './context';

export interface AltSignal {
  direction: Direction;
  stop: number;
  target: number;
  /** The level broken or faded; a close back through it early counts as a failed breakout (null: no such exit). */
  level: number | null;
  detail: Record<string, number | string>;
}

const MAX_STOP_PCT = 5;   // wider stops are not scalps; skipped

function plan(ctx: Context, direction: Direction, stop: number, rMultipleOrTarget: { r: number } | { target: number }, level: number | null, detail: AltSignal['detail']): AltSignal | null {
  const s = sign(direction);
  const risk = s * (ctx.price - stop);
  if (!(risk > 0) || (risk / ctx.price) * 100 > MAX_STOP_PCT) return null;
  const target = 'r' in rMultipleOrTarget ? ctx.price + s * rMultipleOrTarget.r * risk : rMultipleOrTarget.target;
  if (!(s * (target - ctx.price) > 0)) return null;
  return { direction, stop, target, level, detail };
}

// ---------------------------------------------------------------- 1. session opening-range breakout

export interface OrbParams {
  /** Minutes after the session opens that make up the range. */
  rangeMinutes: number;
  /** Stop at the far side of the range, or at its middle. */
  stopAt: 'opposite' | 'mid';
  targetR: number;
}

/**
 * The owning session's opening range is the high and low of its first
 * `rangeMinutes`. The first 15m close outside it enters in that direction,
 * once per session per coin (`alreadyTraded` tracks that).
 */
export function openingRangeBreakout(ctx: Context, session: SessionInstance | null, p: OrbParams, alreadyTraded: boolean): AltSignal | null {
  if (!session || alreadyTraded) return null;
  const rangeEnd = session.openTime + p.rangeMinutes * 60_000;
  if (ctx.t <= rangeEnd) return null;
  const range = ctx.m15.candles.filter((c) => c.openTime >= session.openTime && c.closeTime <= rangeEnd);
  if (range.length < p.rangeMinutes / 15) return null;
  const hi = Math.max(...range.map((c) => c.high));
  const lo = Math.min(...range.map((c) => c.low));
  const n = ctx.m15.close.length - 1;
  const close = ctx.m15.close[n];
  const prev = ctx.m15.close[n - 1];
  const mid = (hi + lo) / 2;
  const detail = { rangeHigh: hi, rangeLow: lo, session: session.name };
  // Only the first close outside: the previous close was still inside.
  if (close > hi && prev <= hi) return plan(ctx, 'long', p.stopAt === 'opposite' ? lo : mid, { r: p.targetR }, hi, detail);
  if (close < lo && prev >= lo) return plan(ctx, 'short', p.stopAt === 'opposite' ? hi : mid, { r: p.targetR }, lo, detail);
  return null;
}

// ---------------------------------------------------------------- 2. momentum continuation

export interface MomentumParams {
  /** 15m candles whose highest high must be broken (16 = 4 hours). */
  lookback: number;
  minRvol: number;
  targetR: number;
}

/**
 * With 4h, 1h and 15m all trending the same way (trend state `strong`), a
 * fresh 15m close through the last `lookback` candles' high, on high relative
 * volume and near the candle's extreme. No pullback wait.
 */
export function momentumContinuation(ctx: Context, p: MomentumParams): AltSignal | null {
  const m = ctx.m15;
  const n = m.close.length - 1;
  if (n < p.lookback + 2) return null;
  const atr = lastOf(ctx.atr15m);
  const rv = ctx.rvol15m[n];
  if (!(rv >= p.minRvol) || !Number.isFinite(atr)) return null;
  const range = m.high[n] - m.low[n];
  for (const dir of ['long', 'short'] as const) {
    if (ctx.analysis[dir].state !== 'strong') continue;
    const s = sign(dir);
    const window = { from: n - p.lookback, to: n };
    const edge = dir === 'long' ? Math.max(...m.high.slice(window.from, window.to)) : Math.min(...m.low.slice(window.from, window.to));
    const fresh = s * (m.close[n] - edge) > 0 && s * (m.close[n - 1] - edge) <= 0;
    const nearExtreme = range > 0 && (dir === 'long' ? (m.close[n] - m.low[n]) / range : (m.high[n] - m.close[n]) / range) >= 0.7;
    if (!fresh || !nearExtreme) continue;
    const swing = dir === 'long' ? Math.min(m.low[n], m.low[n - 1], m.low[n - 2]) : Math.max(m.high[n], m.high[n - 1], m.high[n - 2]);
    return plan(ctx, dir, swing - s * 0.2 * atr, { r: p.targetR }, edge, { rvol: rv, breakout: edge });
  }
  return null;
}

// ---------------------------------------------------------------- 3. mean reversion at the band

export interface MeanRevParams {
  bbPeriod: number;
  bbStd: number;
  /** Only when 1h ADX is below this (no trend). */
  maxAdx: number;
  /** Skip trades whose target (the band's middle) is closer than this many R. */
  minR: number;
}

/**
 * In a range (low ADX, neither side strong): a 15m candle that wicks outside
 * the Bollinger Band and closes back inside, in the reversal's colour, fades
 * the move back to the middle band. Stop beyond the wick.
 */
export function meanReversion(ctx: Context, p: MeanRevParams): AltSignal | null {
  const adx = lastOf(ctx.adx1h);
  if (!(adx < p.maxAdx) || ctx.analysis.long.state === 'strong' || ctx.analysis.short.state === 'strong') return null;
  const m = ctx.m15;
  const n = m.close.length - 1;
  const bb = bollingerBands(m.close, p.bbPeriod, p.bbStd);
  const upper = bb.upper[n];
  const lower = bb.lower[n];
  const mid = bb.middle[n];
  const atr = lastOf(ctx.atr15m);
  if (![upper, lower, mid, atr].every(Number.isFinite)) return null;
  let sig: AltSignal | null = null;
  if (m.low[n] < lower && m.close[n] > lower && m.close[n] > m.open[n]) {
    sig = plan(ctx, 'long', m.low[n] - 0.2 * atr, { target: mid }, null, { band: lower, adx });
  } else if (m.high[n] > upper && m.close[n] < upper && m.close[n] < m.open[n]) {
    sig = plan(ctx, 'short', m.high[n] + 0.2 * atr, { target: mid }, null, { band: upper, adx });
  }
  if (!sig) return null;
  const r = Math.abs(sig.target - ctx.price) / Math.abs(ctx.price - sig.stop);
  return r >= p.minR ? sig : null;
}
