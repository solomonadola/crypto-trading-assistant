// Trade quality score (ENGINE_PLAN.md Section 8.7, v2 7.6). Stored with each
// factor on every signal so the data can later show which factors matter.
// While allocation.sizing is `flat` it does not change position size.
import type { Armed, Confirmation, TradePlan } from './strategy/pullback';
import type { Context } from './strategy/context';

export interface Score {
  total: number;
  points: Record<string, number>;
}

export function scoreSignal(ctx: Context, a: Armed, conf: Confirmation, plan: TradePlan): Score {
  const points: Record<string, number> = {};
  const has = (name: string) => a.factors.some((f) => f.name === name);
  if (a.zone && a.zone.touches === 0) points.fresh_zone = 2;
  else if (a.zone && a.zone.touches === 1) points.tested_zone = 1;
  if (has('ema')) points.ema = 1;
  if (has('fib')) points.fib = 1;
  if (has('vwap')) points.vwap = 1;
  if (conf.engulfing || conf.rejection) points.reversal_candle = 1;
  if (conf.rvol >= ctx.config.trigger.rvol_min) points.rvol = 1;
  const btc1h = ctx.btcAnalysis?.structure['1h']?.trend;
  if (btc1h && btc1h !== (a.direction === 'long' ? 'down' : 'up')) points.btc_with_trade = 1;
  if (plan.rewardRisk >= 3) points.reward_risk_3 = 1;
  if (conf.liquiditySweep) points.liquidity_sweep = 1;
  return { total: Object.values(points).reduce((x, y) => x + y, 0), points };
}
