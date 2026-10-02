// Setup A: trend pullback into a confluence area, confirmed on 15m
// (ENGINE_PLAN.md Section 8.4, v2 7.3 and 7.4). Written once for both
// directions; `sign(dir)` turns "up" into "in the trade's favour".
import type { Direction } from '../../../shared/types';
import { fibLevel, type Pivot } from '../analysis/indicators';
import type { Zone } from '../analysis/zones';
import { lastOf, sign, type Context } from './context';

export type FactorName = 'zone' | 'order_block' | 'ema' | 'fib' | 'vwap' | 'breakout_level';

export interface Factor {
  name: FactorName;
  /** The price level the factor sits at. */
  level: number;
  detail: string;
}

export interface Armed {
  id: string;
  symbol: string;
  direction: Direction;
  armedAt: number;
  expiresAt: number;
  price: number;
  factors: Factor[];
  zone: Zone | null;
  /** Price band the confluence covers, widened by the tolerance. */
  areaLow: number;
  areaHigh: number;
}

/** Arms a setup if the direction is tradable, price is pulling back, and enough factors meet at the current price. */
export function tryArm(ctx: Context, dir: Direction): Armed | null {
  const { config: cfg, price: p } = ctx;
  if (!ctx.analysis[dir].tradable) return null;
  const atr = lastOf(ctx.atr1h);
  if (!Number.isFinite(atr)) return null;
  const tol = cfg.pullback.tolerance_atr * atr;
  const s = sign(dir);
  const near = (level: number) => Math.abs(p - level) <= tol;

  // Pulling back: the last 1h close is on the near side of the last 1h swing in the trend's direction.
  const swings = ctx.pivots1h.filter((x) => x.type === (dir === 'long' ? 'high' : 'low'));
  const lastSwing = swings[swings.length - 1];
  if (!lastSwing || !(s * (lastSwing.price - lastOf(ctx.h1.close)) > 0)) return null;

  const factors: Factor[] = [];

  const zoneType = dir === 'long' ? 'demand' : 'supply';
  const zone = ctx.analysis.zones
    .filter((z) => z.type === zoneType && p >= z.low - tol && p <= z.high + tol)
    .sort((a, b) => b.score - a.score)[0] ?? null;
  if (zone) factors.push({ name: 'zone', level: dir === 'long' ? zone.high : zone.low, detail: `${zone.status} ${zoneType} ${zone.low}-${zone.high}` });

  for (const n of cfg.pullback.ema_levels) {
    const e = lastOf(ctx.ema1h[n]);
    if (Number.isFinite(e) && near(e)) { factors.push({ name: 'ema', level: e, detail: `1h EMA${n}` }); break; }
  }

  const leg = impulseLeg(ctx.pivots1h, dir);
  if (leg) {
    const a = fibLevel(leg.from.price, leg.to.price, cfg.pullback.fib_min);
    const b = fibLevel(leg.from.price, leg.to.price, cfg.pullback.fib_max);
    if (p >= Math.min(a, b) - tol && p <= Math.max(a, b) + tol) {
      factors.push({ name: 'fib', level: (a + b) / 2, detail: `${cfg.pullback.fib_min}-${cfg.pullback.fib_max} of ${leg.from.price}->${leg.to.price}` });
    }
  }

  const vwap = lastOf(ctx.vwap15m);
  if (Number.isFinite(vwap) && near(vwap)) factors.push({ name: 'vwap', level: vwap, detail: 'daily VWAP' });

  const flipped = flippedLevels(ctx, dir).find(near);
  if (flipped !== undefined) factors.push({ name: 'breakout_level', level: flipped, detail: dir === 'long' ? 'old resistance' : 'old support' });

  if (factors.length < cfg.pullback.min_confluence) return null;
  const levels = factors.map((f) => f.level).concat(zone ? [zone.low, zone.high] : []);
  return {
    id: `${ctx.symbol}-${dir}-${ctx.t}`,
    symbol: ctx.symbol, direction: dir, armedAt: ctx.t,
    expiresAt: ctx.t + cfg.pullback.armed_expiry_hours * 3_600_000,
    price: p, factors, zone,
    areaLow: Math.min(p, ...levels) - tol,
    areaHigh: Math.max(p, ...levels) + tol,
  };
}

/** The last completed impulse leg: for a long, the last 1h swing high and the swing low before it. */
export function impulseLeg(pivots: Pivot[], dir: Direction): { from: Pivot; to: Pivot } | null {
  const toType = dir === 'long' ? 'high' : 'low';
  const to = [...pivots].reverse().find((x) => x.type === toType);
  if (!to) return null;
  const from = [...pivots].reverse().find((x) => x.type !== toType && x.index < to.index);
  return from ? { from, to } : null;
}

/** Earlier 1h swing highs (long) that price has since closed above: old resistance that may now be support. */
export function flippedLevels(ctx: Context, dir: Direction): number[] {
  const type = dir === 'long' ? 'high' : 'low';
  const s = sign(dir);
  const swings = ctx.pivots1h.filter((x) => x.type === type);
  const earlier = swings.slice(0, -1).slice(-ctx.config.pullback.breakout_levels);
  return earlier
    .filter((x) => ctx.h1.close.slice(x.index + 1).some((c) => s * (c - x.price) > 0))
    .map((x) => x.price);
}

export type ExpiryReason = 'expired' | 'left_area' | 'trend_changed' | 'session_closed';

/** Why an armed setup no longer stands, or null if it does. */
export function armedStillValid(ctx: Context, a: Armed, entryWindowClosed: boolean): ExpiryReason | null {
  if (ctx.t >= a.expiresAt) return 'expired';
  if (!ctx.analysis[a.direction].tradable) return 'trend_changed';
  if (entryWindowClosed) return 'session_closed';
  if (a.direction === 'long' ? ctx.price < a.areaLow : ctx.price > a.areaHigh) return 'left_area';
  return null;
}

/**
 * The 15m change of character for `dir`: the 15m made lower highs (long), and
 * this candle is the first to close above the latest of them. Returns that
 * swing, or null. Mirrored for a short.
 */
export function choch(ctx: Context, dir: Direction): Pivot | null {
  const s = sign(dir);
  const m = ctx.m15;
  const n = m.close.length - 1;
  const swings = ctx.pivots15m.filter((x) => x.type === (dir === 'long' ? 'high' : 'low'));
  if (swings.length < 2) return null;
  const [prev, latest] = swings.slice(-2);
  if (!(s * (prev.price - latest.price) > 0)) return null;
  if (!(s * (m.close[n] - latest.price) > 0 && s * (m.close[n - 1] - latest.price) <= 0)) return null;
  return latest;
}

export interface Confirmation {
  /** The 15m swing the close went through (the CHoCH level). */
  level: number;
  confirmations: string[];
  engulfing: boolean;
  rejection: boolean;
  rvol: number;
  rsiCross: boolean;
  /** A 15m candle since arming wicked beyond the zone and closed back inside: a stop hunt. */
  liquiditySweep: boolean;
}

/**
 * The 15m change of character: during the pullback the 15m made lower highs
 * (long); this candle is the first to close above the latest of them. Plus at
 * least `confirmations_min` of engulfing/rejection, relative volume, RSI back
 * through 50.
 */
export function tryConfirm(ctx: Context, a: Armed): Confirmation | null {
  const cfg = ctx.config.trigger;
  const s = sign(a.direction);
  const m = ctx.m15;
  const n = m.close.length - 1;
  if (ctx.t <= a.armedAt) return null;
  const latest = choch(ctx, a.direction);
  if (!latest) return null;

  const from = Math.max(1, n - cfg.lookback_candles + 1);
  let engulfing = false;
  let rejection = false;
  let rsiCross = false;
  for (let i = from; i <= n; i++) {
    const body = Math.abs(m.close[i] - m.open[i]);
    const prevBodyLo = Math.min(m.open[i - 1], m.close[i - 1]);
    const prevBodyHi = Math.max(m.open[i - 1], m.close[i - 1]);
    const withTrend = s * (m.close[i] - m.open[i]) > 0;
    const prevAgainst = s * (m.close[i - 1] - m.open[i - 1]) < 0;
    if (withTrend && prevAgainst && Math.min(m.open[i], m.close[i]) <= prevBodyLo && Math.max(m.open[i], m.close[i]) >= prevBodyHi) engulfing = true;
    const lowerWick = Math.min(m.open[i], m.close[i]) - m.low[i];
    const upperWick = m.high[i] - Math.max(m.open[i], m.close[i]);
    const [wick, otherWick] = a.direction === 'long' ? [lowerWick, upperWick] : [upperWick, lowerWick];
    const reachesArea = a.direction === 'long' ? m.low[i] <= a.areaHigh : m.high[i] >= a.areaLow;
    // A rejection: the wick on the rejected side is long against the body and longer than the other wick
    // (a doji with equal wicks rejects neither side).
    if (wick > 0 && wick >= cfg.rejection_wick_body * body && wick > otherWick && reachesArea) rejection = true;
    const r0 = ctx.rsi15m[i - 1];
    const r1 = ctx.rsi15m[i];
    if (a.direction === 'long' ? r0 <= 50 && r1 > 50 : r0 >= 50 && r1 < 50) rsiCross = true;
  }
  const rv = ctx.rvol15m[n];
  const confirmations = [
    ...(engulfing || rejection ? ['reversal_candle'] : []),
    ...(rv >= cfg.rvol_min ? ['rvol'] : []),
    ...(rsiCross ? ['rsi_cross'] : []),
  ];
  if (confirmations.length < cfg.confirmations_min) return null;

  let liquiditySweep = false;
  if (a.zone) {
    for (let i = 0; i <= n; i++) {
      if (m.candles[i].closeTime <= a.armedAt - fourCandles(ctx)) continue;
      if (a.direction === 'long' ? m.low[i] < a.zone.low && m.close[i] >= a.zone.low : m.high[i] > a.zone.high && m.close[i] <= a.zone.high) liquiditySweep = true;
    }
  }
  return { level: latest.price, confirmations, engulfing, rejection, rvol: rv, rsiCross, liquiditySweep };
}

export interface TradePlan {
  entry: number;
  stop: number;
  stopDistancePct: number;
  target: number;
  /** What capped the target: the exit mode's first target or nearer resistance/support. */
  targetSource: string;
  rewardRisk: number;
}

/**
 * Stop per exits.stop_anchor: `setup` puts it beyond the zone (or the
 * pullback's extreme when no zone is part of the confluence) with a 1h-ATR
 * buffer; `swing_15m` beyond the last 15m swing low (long) before the
 * confirming candle with a 15m-ATR buffer. Target at the exit mode's first
 * objective or the nearest opposing level, whichever is closer.
 */
/** Four trigger candles (an hour on 15m), measured from the candles themselves. */
function fourCandles(ctx: Context): number {
  const c = ctx.m15.candles[ctx.m15.candles.length - 1];
  return 4 * (c.closeTime - c.openTime);
}

export function planTrade(ctx: Context, a: Armed): TradePlan {
  const cfg = ctx.config;
  const s = sign(a.direction);
  const entry = ctx.price;
  const pullbackExtreme = () => {
    const since = ctx.m15.candles.filter((c) => c.closeTime > a.armedAt - fourCandles(ctx));
    return a.direction === 'long' ? Math.min(...since.map((c) => c.low)) : Math.max(...since.map((c) => c.high));
  };
  let anchor: number;
  let buffer: number;
  if (cfg.exits.stop_anchor === 'swing_15m') {
    const n = ctx.m15.close.length - 1;
    const swing = [...ctx.pivots15m].reverse()
      .find((p) => p.type === (a.direction === 'long' ? 'low' : 'high') && p.index < n && s * (entry - p.price) > 0);
    anchor = swing ? swing.price : pullbackExtreme();
    // The coin's speed group sets the buffer (wild coins overshoot further); fixtures without one use the exits setting.
    buffer = (ctx.speed ? cfg.speed.groups[ctx.speed].stop_buffer_atr_15m : cfg.exits.stop_buffer_atr) * lastOf(ctx.atr15m);
  } else {
    anchor = a.zone ? (a.direction === 'long' ? a.zone.low : a.zone.high) : pullbackExtreme();
    buffer = cfg.exits.stop_buffer_atr * lastOf(ctx.atr1h);
  }
  const stop = anchor - s * buffer;

  // fixed: one take-profit at the first level in the way, however far (altcoins run); the fixed
  // percentage only when no level is ahead. The other modes cap their first target at it.
  const targetPct = cfg.exits.mode === 'fixed' ? cfg.exits.fixed_target_pct : cfg.exits.partial_at_pct;
  let target = entry * (1 + (s * targetPct) / 100);
  let targetSource = `${cfg.exits.mode} +${targetPct}%`;
  const opposing = opposingLevels(ctx, a.direction).filter((l) => s * (l.price - entry) > 0);
  const nearest = opposing.sort((x, y) => s * (x.price - y.price))[0];
  if (nearest && (cfg.exits.mode === 'fixed' || s * (nearest.price - target) < 0)) { target = nearest.price; targetSource = nearest.name; }
  const risk = s * (entry - stop);
  return {
    entry, stop, stopDistancePct: (risk / entry) * 100, target, targetSource,
    rewardRisk: risk > 0 ? (s * (target - entry)) / risk : 0,
  };
}

/** Levels in the way of a trade: supply zones, the previous UTC day's high and 4h swing highs for a long; mirrored for a short. */
export function opposingLevels(ctx: Context, dir: Direction): { name: string; price: number }[] {
  const out: { name: string; price: number }[] = [];
  const zoneType = dir === 'long' ? 'supply' : 'demand';
  for (const z of ctx.analysis.zones) {
    if (z.type === zoneType) out.push({ name: `${zoneType} zone`, price: dir === 'long' ? z.low : z.high });
  }
  const dayStart = Math.floor(ctx.t / 86_400_000) * 86_400_000;
  const yesterday = ctx.h1.candles.filter((c) => c.openTime >= dayStart - 86_400_000 && c.openTime < dayStart);
  if (yesterday.length) {
    out.push(dir === 'long'
      ? { name: 'previous day high', price: Math.max(...yesterday.map((c) => c.high)) }
      : { name: 'previous day low', price: Math.min(...yesterday.map((c) => c.low)) });
  }
  for (const p of ctx.pivots4h.filter((x) => x.type === (dir === 'long' ? 'high' : 'low')).slice(-3)) {
    out.push({ name: dir === 'long' ? '4h swing high' : '4h swing low', price: p.price });
  }
  return out;
}
