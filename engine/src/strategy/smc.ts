// Building blocks shared by the v3 models (ENGINE_PLAN.md Section 18.3 and
// 18.5): the displacement candle, the take-profit at opposite liquidity, 1h
// order blocks and the 15m inducement. Pure.
import type { Candle, Direction } from '../../../shared/types';
import type { LiquidityLevel } from '../analysis/liquidity';
import type { Pivot } from '../analysis/indicators';
import { lastOf, sign, type Context } from './context';
import type { TradePlan } from './pullback';

/** The current 15m candle closes in `dir`, is at least 1 ATR(15m) long, and its body is at least half its range. */
export function isDisplacement(ctx: Context, dir: Direction): boolean {
  const m = ctx.m15;
  const n = m.close.length - 1;
  const atr = lastOf(ctx.atr15m);
  const range = m.high[n] - m.low[n];
  const body = sign(dir) * (m.close[n] - m.open[n]);
  return Number.isFinite(atr) && range >= atr && body >= 0.5 * range;
}

/**
 * The plan for an entry at `entry` with its stop at `stop`: the one take-profit
 * is the nearest intact opposite liquidity level at least min_rr away, else the
 * nearest one (the engine then records it as skipped for its reward:risk).
 * Null when no opposite level is ahead or the stop is on the wrong side.
 */
export function liquidityPlan(ctx: Context, dir: Direction, entry: number, stop: number, levels: LiquidityLevel[]): { plan: TradePlan; target: LiquidityLevel } | null {
  const s = sign(dir);
  const risk = s * (entry - stop);
  if (!(risk > 0)) return null;
  const ahead = levels
    .filter((l) => l.side === (dir === 'long' ? 'buy' : 'sell') && l.brokenAt === null && s * (l.price - entry) > 0)
    .sort((a, b) => s * (a.price - b.price));
  const target = ahead.find((l) => (s * (l.price - entry)) / risk >= ctx.config.exits.min_rr) ?? ahead[0];
  if (!target) return null;
  return {
    target,
    plan: { entry, stop, stopDistancePct: (risk / entry) * 100, target: target.price, targetSource: target.name, rewardRisk: (s * (target.price - entry)) / risk },
  };
}

export interface OrderBlock {
  id: string;
  side: 'bullish' | 'bearish';
  low: number;
  high: number;
  /** Close time of the candle that left the gap: when the block became known. */
  createdAt: number;
}

const OB_LOOKBACK = 120;
const OB_ORIGIN_CANDLES = 5;

/**
 * Unmitigated 1h order blocks for `dir` (bullish for a long): the last
 * opposite-coloured candle before a candle that closed beyond the latest
 * confirmed 1h swing (a break of structure) and left a fair value gap, which
 * no later 1h candle has traded back into.
 */
export function orderBlocks(h1: Candle[], pivots1h: Pivot[], dir: Direction): OrderBlock[] {
  const s = sign(dir);
  const type = dir === 'long' ? 'high' : 'low';
  const n = h1.length - 1;
  const out: OrderBlock[] = [];
  for (let j = Math.max(2, n - OB_LOOKBACK); j < n; j++) {
    const c = h1[j];
    if (!(s * (c.close - c.open) > 0)) continue;
    // Break of structure: the latest swing confirmed before j, closed through by j.
    const swing = [...pivots1h].reverse().find((p) => p.type === type && p.confirmedAt < j);
    if (!swing || !(s * (c.close - swing.price) > 0) || !(s * (h1[j - 1].close - swing.price) <= 0)) continue;
    // A fair value gap around j: candle j-1 and j+1 do not overlap.
    if (!(dir === 'long' ? h1[j + 1].low > h1[j - 1].high : h1[j + 1].high < h1[j - 1].low)) continue;
    // The origin: the last opposite-coloured candle before j.
    let i = j - 1;
    while (i >= Math.max(0, j - OB_ORIGIN_CANDLES) && !(s * (h1[i].close - h1[i].open) < 0)) i--;
    if (i < Math.max(0, j - OB_ORIGIN_CANDLES)) continue;
    const ob = { low: h1[i].low, high: h1[i].high };
    // Unmitigated: nothing after the gap traded back into it.
    const touched = h1.slice(j + 2).some((x) => (dir === 'long' ? x.low <= ob.high : x.high >= ob.low));
    if (touched) continue;
    out.push({ id: `ob-${dir}-${h1[i].openTime}`, side: dir === 'long' ? 'bullish' : 'bearish', ...ob, createdAt: h1[j + 1].closeTime });
  }
  return out;
}

/**
 * The inducement for a long into a point of interest: the latest confirmed 15m
 * swing low above `poiHigh` formed in the `lookbackMs` before `before`. Taking
 * it out on the way down is the sweep Model 1 needs. Mirrored for a short.
 */
export function inducement(ctx: Context, dir: Direction, poiEdge: number, before: number, lookbackMs: number): Pivot | null {
  const m = ctx.m15.candles;
  const s = sign(dir);
  return [...ctx.pivots15m].reverse().find((p) => p.type === (dir === 'long' ? 'low' : 'high')
    && m[p.confirmedAt] && m[p.confirmedAt].closeTime <= before && m[p.index].openTime >= before - lookbackMs
    && s * (p.price - poiEdge) > 0) ?? null;
}
