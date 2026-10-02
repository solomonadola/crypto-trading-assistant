// Model 3, the session sweep (ENGINE_PLAN.md Section 18.4). At a 15m close
// inside a killzone: the trend agrees, price is in discount (long) or premium
// (short), a candle of the last hour took out an intact liquidity level, and
// this candle closes back beyond it as a displacement candle. The stop goes
// beyond the sweep's extreme plus the speed group's ATR buffer; the one
// take-profit is the nearest opposite liquidity level at least min_rr away.
// Pure: returns the plan; the engine applies the checks and risk.
import type { Direction } from '../../../shared/types';
import { ema } from '../analysis/indicators';
import { dealingRange, liquidityLevels, zoneAllows, type LiquidityLevel } from '../analysis/liquidity';
import type { TradePlan } from './pullback';
import { biasAllows } from './bias';
import { isDisplacement, liquidityPlan } from './smc';
import { lastOf, sign, type Context } from './context';

/** Candles that may hold the sweep: this one and the three before it (the last hour). */
export const SWEEP_WINDOW = 4;

export interface SweepSignal {
  direction: Direction;
  /** The level that was swept (for a long, the lowest one taken). */
  swept: LiquidityLevel;
  sweptAll: LiquidityLevel[];
  /** Lowest low (long) or highest high (short) of the sweep window. */
  extreme: number;
  /** null when no opposite level is ahead: recorded as a skipped signal. */
  plan: TradePlan | null;
  targetLevel: LiquidityLevel | null;
  /** Points in favour, not required (Section 18.4): value-area re-acceptance, close beyond 15m EMA50, funding. */
  confluence: string[];
}

/** The model's signal for one direction at this 15m close, or null. */
export function sessionSweep(ctx: Context, dir: Direction): SweepSignal | null {
  const m = ctx.m15;
  const n = m.close.length - 1;
  if (n < SWEEP_WINDOW + 1) return null;
  const s = sign(dir);
  const long = dir === 'long';

  // 1. Trend and premium / discount.
  if (!biasAllows(ctx, dir) || !zoneAllows(dealingRange(ctx), dir)) return null;

  // 3. Displacement: a candle in our direction, at least 1 ATR(15m) long, body at least half of it.
  if (!isDisplacement(ctx, dir)) return null;
  const atr = lastOf(ctx.atr15m);

  // 2. The sweep: a level intact before the window, traded through inside it, closed back beyond now.
  const from = n - SWEEP_WINDOW + 1;
  const windowStart = m.candles[from].openTime;
  const extreme = long ? Math.min(...m.low.slice(from)) : Math.max(...m.high.slice(from));
  const levels = liquidityLevels(ctx);
  const swept = levels.filter((l) => l.side === (long ? 'sell' : 'buy')
    && l.formedAt <= windowStart
    && l.brokenAt !== null && l.brokenAt > windowStart
    && s * (m.close[n] - l.price) > 0);
  if (!swept.length) return null;
  const level = swept.sort((a, b) => s * (a.price - b.price))[0];

  // 4. Plan: entry at this close, stop beyond the extreme, take-profit at the nearest opposite level at min_rr.
  const cfg = ctx.config;
  const buffer = cfg.speed.groups[ctx.speed ?? 'normal'].stop_buffer_atr_15m * atr;
  const planned = liquidityPlan(ctx, dir, ctx.price, extreme - s * buffer, levels);

  // Confluence.
  const confluence: string[] = [];
  const profile = ctx.analysis.profiles.find((p) => p.name === '24h');
  if (profile) {
    const edge = long ? profile.val : profile.vah;
    if (s * (edge - extreme) > 0 && s * (m.close[n] - edge) > 0) confluence.push('value_reacceptance');
  }
  const e50 = ema(m.close, 50)[n];
  if (Number.isFinite(e50) && s * (m.close[n] - e50) > 0) confluence.push('beyond_ema50_15m');
  if (ctx.funding !== null && s * ctx.funding < 0) confluence.push('funding_in_favour');

  return { direction: dir, swept: level, sweptAll: swept, extreme, plan: planned?.plan ?? null, targetLevel: planned?.target ?? null, confluence };
}
