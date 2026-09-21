/**
 * Transaction cost model.
 *
 * Previously two different fee constants existed and disagreed:
 *   entryScannerService.ts:1640  ->  positionSize * 0.0010
 *   bankrollService.ts:203       ->  positionSize * 0.0020
 * and neither was applied to per-trade pnlUSD, which was gross. Fees were only
 * subtracted at portfolio level, so every per-trade statistic the app reported
 * (win rate, expectancy, profit factor) was measured on the wrong number.
 *
 * Replay studies put realistic round-trip friction at 20-60 bps depending on
 * the name; see STUDY_A_RESULTS.md. The defaults below are deliberately on the
 * optimistic side of that range so results are not flattered further.
 */
export interface CostModel {
  /** Taker fee per side, as a fraction of notional. Binance spot taker = 0.10%. */
  takerFeeRate: number;
  /** Half-spread paid on each side, as a fraction of notional. */
  halfSpreadRate: number;
  /** Slippage allowance per side, as a fraction of notional. */
  slippageRate: number;
}

export const COST_MODEL: CostModel = {
  takerFeeRate: 0.0010,
  halfSpreadRate: 0.0002,
  slippageRate: 0.0003,
};

/** Total cost of one side (entry OR exit) as a fraction of the notional traded. */
export function costPerSideRate(model: CostModel = COST_MODEL): number {
  return model.takerFeeRate + model.halfSpreadRate + model.slippageRate;
}

/** Round-trip cost as a fraction of notional. */
export function roundTripRate(model: CostModel = COST_MODEL): number {
  return costPerSideRate(model) * 2;
}

/**
 * Cost in USD for trading `notionalUSD` on one side.
 * A tiered exit trades a fraction of the position at a time, so callers should
 * pass the notional of that fraction, not the whole position.
 */
export function sideCostUSD(notionalUSD: number, model: CostModel = COST_MODEL): number {
  return Math.max(0, notionalUSD) * costPerSideRate(model);
}
