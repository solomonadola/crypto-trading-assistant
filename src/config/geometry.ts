/**
 * Trade geometry: where the stop and the harvest tiers sit.
 *
 * WHY THIS EXISTS
 *
 * The original code multiplied ATR by a per-archetype factor and then clamped
 * the result:
 *
 *   stopLossPct = max(1.4, min(3.2, atrPct * 0.95))
 *
 * For every non-mega-cap, atrPct has a floor of 3.93, so 0.95 * atrPct is
 * always >= 3.73 and the 3.2 cap always binds. The same is true of the tier
 * caps. The consequence: every altcoin received an identical plan -
 * -3.2 / +3.8 / +7.5 / +12.0, R:R 2.34 - whether its true ATR was 3% or 9.5%.
 * The ATR multipliers, the archetype branching and the volatility
 * classification were all deleted before they reached an order. See AUDIT.md
 * section 2, which verifies this across a +/-20% sweep of 24h change.
 *
 * Effective stop distance was 0.34-0.81x daily ATR. Conventional placement is
 * 1.5-3x. A stop that far inside the noise band is hit by ordinary intraday
 * movement regardless of whether the entry thesis was right.
 *
 * WHAT CHANGED
 *
 * Geometry is now expressed in R - one R is the stop distance - so the reward
 * structure is explicit rather than emergent. Caps remain only as sanity
 * bounds and are wide enough not to bind in normal conditions.
 *
 * Widening the barriers is also the most reliable improvement available. Time
 * to touch a barrier scales roughly with the square of its distance, so
 * doubling the stop distance cuts rotations by roughly 4x. Turnover cost is
 * the one drag the studies showed is certain (STUDY_A_RESULTS.md); the edge is
 * not. Trading less often is therefore a better-founded change than trying to
 * predict better.
 *
 * NOTE: this reduces cost drag. It does not create edge - no exit rule can.
 * The harvest ladder returns profit factor 1.001 on a zero-drift null.
 */
export interface GeometryConfig {
  /** false restores the original capped behaviour for a controlled comparison. */
  useAtrGeometry: boolean;

  /** Stop distance as a multiple of ATR. This defines 1R. */
  stopAtrMultiple: number;

  /** Harvest tiers as multiples of R. */
  tier1RMultiple: number;
  tier2RMultiple: number;
  tier3RMultiple: number;

  /** Sanity bounds on the stop, in percent. Wide enough not to bind normally. */
  minStopPct: number;
  maxStopPct: number;

  /**
   * Where the stop moves once tier 1 is harvested, as a multiple of R above
   * entry. 0 = exact breakeven.
   *
   * This was hardcoded as entry * 1.003, i.e. +0.3%. With tier 1 at +3.8% that
   * meant a 92% retracement of the move closed the whole position - on assets
   * the scanner itself scored at 4-6% ATR, where a 3.5% pullback is the noise
   * floor rather than a reversal. It was the single mechanism turning the
   * modal winner into a scratch minutes after entry.
   */
  breakevenFloorRMultiple: number;

  /**
   * Risk-based position sizing.
   *
   * Sizing was constant in NOTIONAL (units = tranche / price), so risk per
   * trade was tranche * stopPct and varied with whatever stop the asset got.
   * Under the old flat 3.2% stop that was invisible; with genuinely
   * ATR-scaled stops a 14% BONK stop would risk 4.4x what a 4% BTC stop does.
   *
   * With this on, position size solves for constant dollar risk:
   *   positionUSD = (equity * riskPerTradePct/100) / (stopPct/100)
   * capped at the tranche so a tight stop cannot lever the book up.
   */
  useRiskBasedSizing: boolean;

  /** Dollar risk per trade as a percent of total equity. */
  riskPerTradePct: number;

  /**
   * When the stop starts following the price, as the number of harvest tiers
   * already taken: 1 = after tier 1, 2 = after tier 2, 3 = after tier 3,
   * 99 = never (the stop only steps to the fixed tier floors).
   *
   * This was effectively 3, and tier 3 sits at 3.5R, which is rarely reached -
   * so in practice the stop never followed the price. Between tiers it sat at
   * breakeven (after tier 1) or at the tier-1 price (after tier 2), however far
   * the trade ran. On a $10 position that runs +13% and falls back, a 5% ATR
   * coin (tiers at 7.5/15/26%) fills only tier 1 and exits the rest at
   * breakeven: 2.5% kept out of a 13% move.
   */
  trailAfterTier: number;

  /**
   * Trailing distance, as a multiple of ATR below the highest price reached
   * (above the lowest, for a short). Scaled by ATR for the same reason the stop
   * is: a fixed percentage is a day's range on one coin and ten minutes' noise
   * on another.
   */
  trailAtrMultiple: number;

  /**
   * Ceiling on a gap-through harvest, as a multiple of the tier's target.
   *
   * The engine harvests at max(targetPct, currentReturnPct) so a price that
   * gaps past a tier is banked at the better price. That is defensible for a
   * market order - but it was unbounded, so a single bad tick wrote a
   * permanent realizedCashBankedUSD. A spurious +700% print banks $23.10 on a
   * $10 tranche, and the old P&L clamp in bankrollService then hid it from the
   * totals rather than surfacing it.
   */
  maxGapHarvestMultiple: number;
}

export const GEOMETRY_CONFIG: GeometryConfig = {
  useAtrGeometry: true,
  stopAtrMultiple: 1.5,
  tier1RMultiple: 1.0,
  tier2RMultiple: 2.0,
  tier3RMultiple: 3.5,
  minStopPct: 1.5,
  maxStopPct: 15.0,
  breakevenFloorRMultiple: 0.1,
  trailAfterTier: 3,
  trailAtrMultiple: 1.5,
  useRiskBasedSizing: true,
  riskPerTradePct: 0.4,
  maxGapHarvestMultiple: 3.0,
};

/** Resolves the full ladder from ATR. Returns percentages. */
export function resolveGeometry(atrPct: number, cfg: GeometryConfig = GEOMETRY_CONFIG) {
  const stopPct = +Math.max(cfg.minStopPct, Math.min(cfg.maxStopPct, atrPct * cfg.stopAtrMultiple)).toFixed(2);
  return {
    stopPct,
    tier1Pct: +(stopPct * cfg.tier1RMultiple).toFixed(2),
    tier2Pct: +(stopPct * cfg.tier2RMultiple).toFixed(2),
    tier3Pct: +(stopPct * cfg.tier3RMultiple).toFixed(2),
  };
}

/**
 * Position size for a target dollar risk, capped at the tranche.
 * Returns the tranche unchanged when risk-based sizing is off.
 */
export function resolvePositionSizeUSD(
  trancheUSD: number,
  equityUSD: number,
  stopPct: number,
  cfg: GeometryConfig = GEOMETRY_CONFIG
): number {
  if (!cfg.useRiskBasedSizing || !(stopPct > 0) || !(equityUSD > 0)) return trancheUSD;
  const riskUSD = equityUSD * (cfg.riskPerTradePct / 100);
  const sized = riskUSD / (stopPct / 100);
  // Never exceed the tranche: a very tight stop must not lever the book up.
  return +Math.min(trancheUSD, Math.max(1, sized)).toFixed(2);
}

/**
 * Bounds a gap-through harvest and reports whether the cap bit, so the caller
 * can log a bad tick instead of silently banking it.
 */
export function capGapHarvest(
  targetPct: number,
  currentReturnPct: number,
  cfg: GeometryConfig = GEOMETRY_CONFIG
): { pct: number; capped: boolean } {
  const ceiling = Math.abs(targetPct) * cfg.maxGapHarvestMultiple;
  const raw = Math.max(targetPct, currentReturnPct);
  if (!Number.isFinite(raw)) return { pct: targetPct, capped: true };
  return raw > ceiling ? { pct: ceiling, capped: true } : { pct: raw, capped: false };
}
