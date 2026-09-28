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
 * Effective stop distance was 0.34-0.81x daily ATR, and - more to the point -
 * it was unrelated to the coin's own volatility, so the same 3.2% was a day's
 * noise on one coin and a real break on another. Every distance here is a
 * multiple of ATR for that reason.
 *
 * WHAT CHANGED
 *
 * Geometry is now expressed in R - one R is the stop distance - so the reward
 * structure is explicit rather than emergent. Caps remain only as sanity
 * bounds and are wide enough not to bind in normal conditions.
 *
 * Widening the barriers was the first change, on the argument that time to
 * touch a barrier scales roughly with the square of its distance, so a wider
 * stop cuts rotations and therefore cost. That holds when the entry carries no
 * edge, which was true of the ungated entries it was measured on.
 *
 * WHAT CHANGED AGAIN (2026-09-23)
 *
 * The level gates (src/config/entry.ts) changed the entry. An entry taken at
 * support, with room to the next resistance, does its work in the first day or
 * two; held for the 82 hours the 1.5x ATR ladder needed, the edge had decayed
 * and the trade was back to a coin flip. Measured on 16,527 gated entries over
 * 24 months out of sample (tools/sim-exits.mjs, STUDY_A_RESULTS.md addendum 4):
 *
 *   stop 1.5x ATR, 1R/2R/3.5R   -7.6bp/trade   PF 0.98   82.6h    -2.2 bp/day/slot
 *   stop 1.0x ATR, 1R/2R/3R    +32.3bp         PF 1.12   46.9h   +16.5
 *   stop 0.75x ATR, 1R/2R/3R   +37.5bp         PF 1.19   30.5h   +29.5   <- this
 *   stop 0.5x ATR, 1R/2R/3R    +31.5bp         PF 1.25   15.9h   +47.5
 *
 * 0.5x ATR earns the most per unit of time, but it rotates 1.5x a day and its
 * edge is gone by 35bp of cost per side; 0.75x ATR still pays at 25bp
 * (+17.5bp, PF 1.09) and is the best of the set at 35bp (-2.5bp). It is picked
 * for that reason, not for the highest number in the table.
 *
 * NOTE: this is not edge from the exit - no exit rule creates edge. The
 * harvest ladder returns profit factor 1.001 on a zero-drift null. It is the
 * exit that collects the entry's edge before it decays.
 */

export type StrategyProfileId = 'ASYMMETRIC_SNIPER' | 'DYNAMIC_SCALP';

export interface StrategyProfile {
  id: StrategyProfileId;
  name: string;
  shortName: string;
  badge: string;
  description: string;
  stopAtrMultiple: number;
  tier1RMultiple: number;
  tier2RMultiple: number;
  tier3RMultiple: number;
  tier1HarvestPct: number;
  tier2HarvestPct: number;
  tier3HarvestPct: number;
  breakevenFloorRMultiple: number;
  monthlyRiskCapPct: number;
}

export const STRATEGY_PROFILES: Record<StrategyProfileId, StrategyProfile> = {
  ASYMMETRIC_SNIPER: {
    id: 'ASYMMETRIC_SNIPER',
    name: 'Asymmetric Sniper (1:3 Core + 1:5 Runner)',
    shortName: 'Sniper 1:3 / 1:5 R',
    badge: '1:3 to 1:5 R',
    description: 'Institutional trend mode. 1.0x ATR stop. 1.5R (30% derisk & move stop to entry +0.5R), 3.0R (40% core target banked), 5.0R (30% parabolic runner). High monthly expectancy with low turnover.',
    stopAtrMultiple: 1.0,
    tier1RMultiple: 1.5,
    tier2RMultiple: 3.0,
    tier3RMultiple: 5.0,
    tier1HarvestPct: 0.30,
    tier2HarvestPct: 0.40,
    tier3HarvestPct: 0.30,
    breakevenFloorRMultiple: 0.5,
    monthlyRiskCapPct: 6.0,
  },
  DYNAMIC_SCALP: {
    id: 'DYNAMIC_SCALP',
    name: 'Dynamic Scalp (1:1.5 R Quick Rotations)',
    shortName: 'Scalp 1:1.5 R',
    badge: '1:1.5 R',
    description: 'Faster rotations for tight range conditions. 0.75x ATR stop, 1.0R (33%), 1.8R (33%), 2.8R (34%).',
    stopAtrMultiple: 0.75,
    tier1RMultiple: 1.0,
    tier2RMultiple: 1.8,
    tier3RMultiple: 2.8,
    tier1HarvestPct: 0.33,
    tier2HarvestPct: 0.33,
    tier3HarvestPct: 0.34,
    breakevenFloorRMultiple: 0.3,
    monthlyRiskCapPct: 8.0,
  },
};

const STRATEGY_PROFILE_STORAGE_KEY = 'crypto_scalp_strategy_profile';

/** Window event fired when the profile is changed from outside the HUD (the server's choice). */
export const STRATEGY_PROFILE_EVENT = 'strategy-profile-changed';

export function getActiveStrategyProfile(): StrategyProfile {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(STRATEGY_PROFILE_STORAGE_KEY);
      if (saved && saved in STRATEGY_PROFILES) {
        return STRATEGY_PROFILES[saved as StrategyProfileId];
      }
    }
  } catch {}
  return STRATEGY_PROFILES.ASYMMETRIC_SNIPER;
}

export function setActiveStrategyProfile(id: StrategyProfileId): StrategyProfile {
  const profile = STRATEGY_PROFILES[id] || STRATEGY_PROFILES.ASYMMETRIC_SNIPER;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STRATEGY_PROFILE_STORAGE_KEY, profile.id);
    }
  } catch {}
  GEOMETRY_CONFIG.stopAtrMultiple = profile.stopAtrMultiple;
  GEOMETRY_CONFIG.tier1RMultiple = profile.tier1RMultiple;
  GEOMETRY_CONFIG.tier2RMultiple = profile.tier2RMultiple;
  GEOMETRY_CONFIG.tier3RMultiple = profile.tier3RMultiple;
  GEOMETRY_CONFIG.breakevenFloorRMultiple = profile.breakevenFloorRMultiple;
  GEOMETRY_CONFIG.tier1HarvestPct = profile.tier1HarvestPct;
  GEOMETRY_CONFIG.tier2HarvestPct = profile.tier2HarvestPct;
  GEOMETRY_CONFIG.tier3HarvestPct = profile.tier3HarvestPct;
  return profile;
}

export interface GeometryConfig {
  /** false restores the original capped behaviour for a controlled comparison. */
  useAtrGeometry: boolean;

  /** Stop distance as a multiple of ATR. This defines 1R. */
  stopAtrMultiple: number;

  /** Harvest tiers as multiples of R. */
  tier1RMultiple: number;
  tier2RMultiple: number;
  tier3RMultiple: number;

  /**
   * Share of the position each tier covers, as fractions of the whole. Stamped
   * on each tier (as `percent`) when a trade opens, and the exit engine banks
   * what the trade was opened with, so switching profile never changes an
   * open trade. Tier 3 banks half its share and trails the other half.
   */
  tier1HarvestPct: number;
  tier2HarvestPct: number;
  tier3HarvestPct: number;

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

  /**
   * Dollar risk per trade as a percent of total equity, used only when
   * useRiskBasedSizing is on.
   *
   * It is off: every trade takes the same slot (equity / 10), which keeps the
   * capital fully deployed. The trade-off is that risk per trade then varies
   * with the coin - a stop is 0.75x ATR, so on 2026-09-23 a BTC stop was 2.1%
   * of the slot and a PUMP stop 7.0%, i.e. one trade can lose three times what
   * another does. Turning this back on would change little at this stop width:
   * the size is capped at the slot, and 0.8% of equity against a slot of 10%
   * only sizes down when the stop is wider than 8% - an ATR above about 11%.
   */
  riskPerTradePct: number;

  /**
   * When the stop starts following the price, as the number of harvest tiers
   * already taken: 1 = after tier 1, 2 = after tier 2, 3 = after tier 3,
   * 99 = never (the stop only steps to the fixed tier floors).
   *
   * This was effectively 3, and tier 3 then sat at 3.5R of a 1.5x ATR stop -
   * 5.25x ATR, rarely reached - so in practice the stop never followed the
   * price. Between tiers it sat at breakeven (after tier 1) or at the tier-1
   * price (after tier 2), however far the trade ran. With the ladder now at
   * 0.75x ATR, tier 3 is 2.25x ATR: a 5% ATR coin has tiers at 3.8/7.5/11.3%,
   * so the +13% move that used to exit at breakeven now fills all three and
   * trails the rest.
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

  /**
   * Structural Level-Aware Profit Snapping:
   * When true, take-profit targets (Tier 1 and Tier 2) snap to the nearest
   * key market structural resistance (for longs) or support (for shorts)
   * if that level is closer than the default ATR multiple.
   */
  useStructuralTakeProfit: boolean;

  /**
   * Front-run buffer in ATR when snapping to a structural level.
   * E.g. 0.08 means placing the take-profit target 0.08 * ATR in front of
   * the institutional support/resistance wall so limit/market orders fill before the bounce/rejection.
   */
  structuralFrontRunAtrBuffer: number;

  /**
   * Minimum reward-to-risk (R) multiple allowed when snapping a tier to a key level.
   * Prevents shrinking Tier 1 to a negligible gain if a level is too close to entry.
   */
  minStructuralTier1R: number;

  /**
   * Maximum trail tightening for parabolic bullish runners.
   * For strong, sustained bullish runners (gain >= 20% or >= 35%),
   * gives enough breathing room (e.g. 3.5% / 2.8%) so high-momentum trends
   * aren't prematurely stopped out by normal micro-pullback noise.
   */
  runnerParabolicBuffer20Pct: number;
  runnerParabolicBuffer35Pct: number;
  runnerDefaultBufferPct: number;
}

const defaultProfile = getActiveStrategyProfile();

export const GEOMETRY_CONFIG: GeometryConfig = {
  useAtrGeometry: true,
  stopAtrMultiple: defaultProfile.stopAtrMultiple,
  tier1RMultiple: defaultProfile.tier1RMultiple,
  tier2RMultiple: defaultProfile.tier2RMultiple,
  tier3RMultiple: defaultProfile.tier3RMultiple,
  tier1HarvestPct: defaultProfile.tier1HarvestPct,
  tier2HarvestPct: defaultProfile.tier2HarvestPct,
  tier3HarvestPct: defaultProfile.tier3HarvestPct,
  minStopPct: 2.0,       // Realistic minimum stop floor to avoid micro-whipsaws
  maxStopPct: 7.5,       // Cap at 7.5% to avoid oversized risk on ultra-volatile coins
  breakevenFloorRMultiple: defaultProfile.breakevenFloorRMultiple,
  trailAfterTier: 1,
  trailAtrMultiple: 1.0,
  useRiskBasedSizing: true, // Equal dollar risk per trade across all assets
  riskPerTradePct: 0.35,    // Risk 0.35% of portfolio equity ($0.35 on $100 bankroll) per trade
  maxGapHarvestMultiple: 3.0,
  useStructuralTakeProfit: true,
  structuralFrontRunAtrBuffer: 0.08,
  minStructuralTier1R: 0.8,
  runnerParabolicBuffer20Pct: 0.035, // 3.5% buffer for >=20% runner
  runnerParabolicBuffer35Pct: 0.025, // 2.5% buffer for >=35% runner
  runnerDefaultBufferPct: 0.04,     // 4.0% buffer for standard runner
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
