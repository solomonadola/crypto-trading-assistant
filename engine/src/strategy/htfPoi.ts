// Model 4, 4h point of interest + lower-timeframe CHoCH. The 4h decides where
// to trade: price trades into a 4h demand zone, bullish fair value gap or
// bullish order block (long; supply, bearish gap or bearish order block for a
// short), with the 4h trend not against the trade and price in the 4h range's
// discount (long) or premium (short). The setup arms at that 15m close. It
// confirms on the first 5m or 15m change of character in the trade's
// direction: after lower highs into the zone, a close above the latest one
// (mirrored for a short). The stop goes beyond the lowest low since arming
// plus the speed group's buffer; the take-profit is the nearest opposite
// liquidity at least min_rr away. Pure.
import type { Candle, Direction } from '../../../shared/types';
import { dealingRange, zoneAllows } from '../analysis/liquidity';
import { detectZones, activeZones } from '../analysis/zones';
import { swingPivots, type Pivot } from '../analysis/indicators';
import { lastOf, sign, type Context } from './context';
import type { Armed, ExpiryReason } from './pullback';
import { orderBlocks } from './smc';

export interface HtfPoi {
  kind: 'zone' | 'fvg' | 'order_block';
  id: string;
  low: number;
  high: number;
}

const KIND_LABEL: Record<HtfPoi['kind'], string> = { zone: '4h zone', fvg: '4h FVG', order_block: '4h order block' };
const FACTOR: Record<HtfPoi['kind'], '4h_zone' | '4h_fvg' | '4h_order_block'> = { zone: '4h_zone', fvg: '4h_fvg', order_block: '4h_order_block' };

/** The 4h trend is not against the trade: 4h structure not down and the 4h close above the 4h EMA200 (long). */
export function htfBiasAllows(ctx: Context, dir: Direction): boolean {
  const { close, slow } = ctx.analysis.ema4h;
  const structure = ctx.analysis.structure['4h']?.trend ?? 'none';
  if (close === null || slow === null) return false;
  return dir === 'long' ? close > slow && structure !== 'down' : close < slow && structure !== 'up';
}

/** Active 4h demand zones, bullish 4h FVGs (fresh, tested, or bearish ones turned bullish) and unmitigated 4h order blocks for a long. */
export function htfPointsOfInterest(ctx: Context, dir: Direction): HtfPoi[] {
  const p = ctx.config.htf_poi;
  const long = dir === 'long';
  const zones = activeZones(detectZones(ctx.h4.candles, { ...ctx.config.zones, lookback_candles: p.zone_lookback_4h, max_zone_width_pct: p.zone_max_width_pct }))
    .filter((z) => z.type === (long ? 'demand' : 'supply'))
    .map((z): HtfPoi => ({ kind: 'zone', id: z.id, low: z.low, high: z.high }));
  const fvgs = ctx.analysis.fvgs
    .filter((g) => g.tf === '4h' && g.side === (long ? 'bullish' : 'bearish'))
    .map((g): HtfPoi => ({ kind: 'fvg', id: g.id, low: g.bottom, high: g.top }));
  const blocks = orderBlocks(ctx.h4.candles, ctx.pivots4h, dir)
    .map((b): HtfPoi => ({ kind: 'order_block', id: b.id, low: b.low, high: b.high }));
  return [...zones, ...fvgs, ...blocks];
}

/** Arms when this 15m candle traded into a 4h point of interest without closing through it. */
export function armHtfPoi(ctx: Context, dir: Direction): Armed | null {
  if (!htfBiasAllows(ctx, dir) || !zoneAllows(dealingRange(ctx), dir)) return null;
  const atr = lastOf(ctx.atr1h);
  if (!Number.isFinite(atr)) return null;
  const m = ctx.m15;
  const n = m.close.length - 1;
  const long = dir === 'long';
  const tapped = htfPointsOfInterest(ctx, dir).filter((p) => (long
    ? m.low[n] <= p.high && m.close[n] >= p.low
    : m.high[n] >= p.low && m.close[n] <= p.high));
  if (!tapped.length) return null;
  // The area: every point of interest tapped together (confluence), widened by the tolerance.
  const tol = ctx.config.pullback.tolerance_atr * atr;
  const low = Math.min(...tapped.map((p) => p.low));
  const high = Math.max(...tapped.map((p) => p.high));
  return {
    id: `${ctx.symbol}-htf-${dir}-${ctx.t}`,
    symbol: ctx.symbol, direction: dir, armedAt: ctx.t,
    expiresAt: ctx.t + ctx.config.htf_poi.armed_expiry_hours * 3_600_000,
    price: ctx.price,
    factors: tapped.map((p) => ({ name: FACTOR[p.kind], level: long ? p.high : p.low, detail: `${KIND_LABEL[p.kind]} ${p.low}-${p.high}` })),
    zone: null,
    areaLow: low - tol,
    areaHigh: high + tol,
  };
}

/** Why an armed Model 4 setup no longer stands, or null if it does. `price` is the latest close. */
export function htfPoiStillValid(ctx: Context, a: Armed, price: number, entryWindowClosed: boolean): ExpiryReason | null {
  if (ctx.t >= a.expiresAt) return 'expired';
  if (!htfBiasAllows(ctx, a.direction)) return 'trend_changed';
  if (entryWindowClosed) return 'session_closed';
  if (a.direction === 'long' ? price < a.areaLow : price > a.areaHigh) return 'left_area';
  return null;
}

/**
 * The change of character on these candles (any timeframe): the last two
 * swing highs fall (long), and the last candle is the first to close above
 * the latest of them. Returns that swing, or null. Mirrored for a short.
 */
export function chochOn(candles: Candle[], k: number, dir: Direction): Pivot | null {
  const n = candles.length - 1;
  if (n < 2 * k + 3) return null;
  const s = sign(dir);
  const swings = swingPivots(candles.map((c) => c.high), candles.map((c) => c.low), k)
    .filter((p) => p.type === (dir === 'long' ? 'high' : 'low') && p.confirmedAt <= n);
  if (swings.length < 2) return null;
  const [prev, latest] = swings.slice(-2);
  if (!(s * (prev.price - latest.price) > 0)) return null;
  if (!(s * (candles[n].close - latest.price) > 0 && s * (candles[n - 1].close - latest.price) <= 0)) return null;
  return latest;
}
