// Model 1, sweep + CHoCH at a zone (ENGINE_PLAN.md Section 18.5). The trend
// agrees and price is in discount (long) or premium (short); price trades
// into a point of interest (a fresh or tested 1h demand zone, or an
// unmitigated 1h order block) and the setup arms. It confirms on a 15m CHoCH
// closed by a displacement candle, but only if liquidity was taken on the way:
// the inducement (the latest 15m swing low above the point of interest), a
// liquidity level, or a wick through the zone. The stop goes beyond the
// lowest low since arming plus the speed group's buffer; the one take-profit
// is the nearest opposite liquidity at 2R. Pure.
import type { Direction } from '../../../shared/types';
import { dealingRange, zoneAllows, type LiquidityLevel } from '../analysis/liquidity';
import { biasAllows } from './bias';
import { lastOf, sign, type Context } from './context';
import { choch, type Armed, type ExpiryReason } from './pullback';
import { inducement, isDisplacement, orderBlocks } from './smc';

export interface PointOfInterest {
  kind: 'zone' | 'order_block';
  id: string;
  low: number;
  high: number;
}

/** Fresh or tested 1h zones and unmitigated 1h order blocks on the trade's side. */
export function pointsOfInterest(ctx: Context, dir: Direction): PointOfInterest[] {
  const zoneType = dir === 'long' ? 'demand' : 'supply';
  const zones: PointOfInterest[] = ctx.analysis.zones
    .filter((z) => z.type === zoneType && z.status !== 'invalid')
    .map((z) => ({ kind: 'zone', id: z.id, low: z.low, high: z.high }));
  const blocks: PointOfInterest[] = orderBlocks(ctx.h1.candles, ctx.pivots1h, dir).map((b) => ({ kind: 'order_block', id: b.id, low: b.low, high: b.high }));
  return [...zones, ...blocks];
}

/** Arms when this 15m candle traded into a point of interest without closing through it. */
export function armZoneSweep(ctx: Context, dir: Direction): Armed | null {
  if (!biasAllows(ctx, dir) || !zoneAllows(dealingRange(ctx), dir)) return null;
  const atr = lastOf(ctx.atr1h);
  if (!Number.isFinite(atr)) return null;
  const m = ctx.m15;
  const n = m.close.length - 1;
  const long = dir === 'long';
  const tapped = pointsOfInterest(ctx, dir).filter((p) => (long
    ? m.low[n] <= p.high && m.close[n] >= p.low
    : m.high[n] >= p.low && m.close[n] <= p.high));
  if (!tapped.length) return null;
  // The first one reached: the highest for a long, the lowest for a short.
  const poi = tapped.sort((a, b) => sign(dir) * (b.high - a.high))[0];
  const tol = ctx.config.pullback.tolerance_atr * atr;
  const zone = poi.kind === 'zone' ? ctx.analysis.zones.find((z) => z.id === poi.id) ?? null : null;
  return {
    id: `${ctx.symbol}-${dir}-${ctx.t}`,
    symbol: ctx.symbol, direction: dir, armedAt: ctx.t,
    expiresAt: ctx.t + ctx.config.pullback.armed_expiry_hours * 3_600_000,
    price: ctx.price,
    factors: [{ name: poi.kind, level: long ? poi.high : poi.low, detail: `${poi.kind.replace('_', ' ')} ${poi.low}-${poi.high}` }],
    zone,
    areaLow: poi.low - tol,
    areaHigh: poi.high + tol,
  };
}

/** Why an armed Model 1 setup no longer stands, or null if it does. */
export function zoneSweepStillValid(ctx: Context, a: Armed, entryWindowClosed: boolean): ExpiryReason | null {
  if (ctx.t >= a.expiresAt) return 'expired';
  if (!biasAllows(ctx, a.direction)) return 'trend_changed';
  if (entryWindowClosed) return 'session_closed';
  if (a.direction === 'long' ? ctx.price < a.areaLow : ctx.price > a.areaHigh) return 'left_area';
  return null;
}

export interface ZoneSweepConfirmation {
  /** The 15m swing the CHoCH closed through. */
  level: number;
  /** What liquidity was taken: 'inducement', a liquidity level's name, 'zone_wick'; null when none was. */
  sweep: string | null;
  /** Lowest low (long) or highest high (short) since arming: the stop goes beyond it. */
  extreme: number;
}

const INDUCEMENT_LOOKBACK = 24 * 3_600_000;
const HOUR = 3_600_000;

/** The CHoCH on a displacement candle, with what was swept since arming; null while not confirmed. */
export function confirmZoneSweep(ctx: Context, a: Armed, levels: LiquidityLevel[]): ZoneSweepConfirmation | null {
  if (ctx.t <= a.armedAt) return null;
  const dir = a.direction;
  const swing = choch(ctx, dir);
  if (!swing || !isDisplacement(ctx, dir)) return null;
  const s = sign(dir);
  const long = dir === 'long';
  const m = ctx.m15;
  const n = m.close.length - 1;
  // Candles from the arming candle on.
  const since = m.candles.filter((c) => c.closeTime >= a.armedAt);
  const extreme = long ? Math.min(...since.map((c) => c.low)) : Math.max(...since.map((c) => c.high));

  let sweep: string | null = null;
  const idm = inducement(ctx, dir, long ? a.areaHigh : a.areaLow, a.armedAt, INDUCEMENT_LOOKBACK);
  if (idm && s * (idm.price - extreme) > 0) sweep = 'inducement';
  if (!sweep) {
    // A liquidity level taken around the tap (from an hour before arming) and closed back beyond.
    const level = levels.find((l) => l.side === (long ? 'sell' : 'buy') && l.brokenAt !== null && l.brokenAt >= a.armedAt - HOUR && s * (m.close[n] - l.price) > 0);
    if (level) sweep = level.name;
  }
  if (!sweep && a.zone) {
    const edge = long ? a.zone.low : a.zone.high;
    if (since.some((c) => (long ? c.low < edge && c.close >= edge : c.high > edge && c.close <= edge))) sweep = 'zone_wick';
  }
  return { level: swing.price, sweep, extreme };
}
