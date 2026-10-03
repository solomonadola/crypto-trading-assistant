// Coin speed groups (ENGINE_PLAN.md Section 18.2): measured from the coin's 1h
// ATR as a percent of price, so a coin moves between groups as it calms down
// or wakes up. Each group has its own risk, stop buffer, max hold and
// simulated slippage. Pure.
import type { EngineConfig } from './config';

export type SpeedGroup = 'calm' | 'normal' | 'wild';

/** The group for a 1h ATR of `atr1hPct` percent of price; `normal` when unknown. */
export function speedOf(atr1hPct: number | null, cfg: EngineConfig['speed']): SpeedGroup {
  if (atr1hPct === null || !Number.isFinite(atr1hPct)) return 'normal';
  if (atr1hPct < cfg.calm_below_atr_1h_pct) return 'calm';
  if (atr1hPct > cfg.wild_above_atr_1h_pct) return 'wild';
  return 'normal';
}

export function speedSettings(cfg: EngineConfig, group: SpeedGroup | undefined) {
  return cfg.speed.groups[group ?? 'normal'];
}

/** Simulation costs for a coin of this group: its own slippage. */
export function costsFor(cfg: EngineConfig, group: SpeedGroup | undefined): EngineConfig['sim'] {
  return { ...cfg.sim, slippage_pct: speedSettings(cfg, group).slippage_pct };
}

/** Round-trip fees and slippage, percent of notional. */
export const roundTripPct = (costs: EngineConfig['sim']) => 2 * (costs.taker_fee_pct + costs.slippage_pct);

/** Reward:risk after the round-trip costs: (distance to the target less the costs) / distance to the stop. */
export function netRewardRisk(entry: number, stop: number, target: number, costPct: number): number {
  const risk = Math.abs(entry - stop);
  return risk > 0 ? (Math.abs(target - entry) - (costPct / 100) * entry) / risk : 0;
}
