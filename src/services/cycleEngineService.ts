import { AutomatedTradeRecord, NumericalCycleMetrics } from '../types/automatedFeed';
import { roundPrice } from './entryScannerService';
import { sideCostUSD } from '../config/costs';
import { GEOMETRY_CONFIG, capGapHarvest } from '../config/geometry';

export interface CycleEvaluationResult {
  trade: AutomatedTradeRecord;
  hasChanged: boolean;
  eventTriggered?: 'TIER_1_HARVESTED' | 'TIER_2_HARVESTED' | 'TIER_3_HARVESTED' | 'STOPPED_OUT' | 'RATCHET_ENGAGED' | 'STAGNATION_EXIT' | 'NONE';
  message?: string;
}

/**
 * Institutional Math Engine for executing:
 * 1. Asymmetric 1/3rd harvest ladders (+4% Tier 1, +8% Tier 2, +15% Runner)
 * 2. Dynamic zero-risk breakeven ratchets (armed immediately when Tier 1 is touched)
 * 3. Volatility-adaptive ATR trailing floors
 * 4. Micro-trend stagnation detection & capital recycling
 * 5. MFE (Maximum Favorable Excursion) & MAE (Maximum Adverse Excursion) tracking
 */
/**
 * What each tier banks, as fractions of the position, from the percentages
 * stamped on the trade when it opened. Tier 3 banks half its share and the
 * other half trails as the runner. Trades opened before the split was stamped
 * carry 33/33/34, which is the 33/33/17 this engine always banked.
 */
export function harvestFractions(tiers?: AutomatedTradeRecord['harvestTiers']): { t1: number; t2: number; t3: number } {
  const share = (p: number | undefined, fallback: number) =>
    typeof p === 'number' && p > 0 && p <= 100 ? p / 100 : fallback;
  return {
    t1: share(tiers?.tier1.percent, 0.33),
    t2: share(tiers?.tier2.percent, 0.33),
    t3: share(tiers?.tier3.percent, 0.34) / 2,
  };
}

/** The fraction of the position still open after the tiers already banked. */
export function openFraction(tiers?: AutomatedTradeRecord['harvestTiers']): number {
  if (!tiers) return 1;
  const f = harvestFractions(tiers);
  let open = 1;
  if (tiers.tier1.status === 'HARVESTED') open -= f.t1;
  if (tiers.tier2.status === 'HARVESTED') open -= f.t2;
  if (tiers.tier3.status === 'HARVESTED') open -= f.t3;
  return Math.max(0, open);
}

export function evaluateTradeCycle(
  trade: AutomatedTradeRecord,
  livePrice: number
): CycleEvaluationResult {
  if (trade.status !== 'OPEN') {
    return { trade, hasChanged: false, eventTriggered: 'NONE' };
  }

  const updated: AutomatedTradeRecord = JSON.parse(JSON.stringify(trade));
  let hasChanged = false;
  let eventTriggered: CycleEvaluationResult['eventTriggered'] = 'NONE';
  let message = '';

  const entryP = updated.entryPrice;
  const isShort = updated.direction === 'SHORT';
  const posSize = updated.positionSizeUSD || 10.00;

  if (trade.currentPrice !== livePrice) {
    updated.currentPrice = livePrice;
    hasChanged = true;
  } else {
    updated.currentPrice = livePrice;
  }

  // Track session high/low
  if (!updated.sessionHighPrice || livePrice > updated.sessionHighPrice) {
    updated.sessionHighPrice = livePrice;
    hasChanged = true;
  }
  if (!updated.sessionLowPrice || livePrice < updated.sessionLowPrice) {
    updated.sessionLowPrice = livePrice;
    hasChanged = true;
  }

  // Calculate current PnL %
  const currentReturnPct = entryP > 0
    ? isShort 
      ? +(((entryP - livePrice) / entryP) * 100).toFixed(2)
      : +(((livePrice - entryP) / entryP) * 100).toFixed(2)
    : 0;

  // Calculate MFE and MAE
  const favorablePrice = isShort ? updated.sessionLowPrice : updated.sessionHighPrice;
  const adversePrice = isShort ? updated.sessionHighPrice : updated.sessionLowPrice;
  const mfePct = entryP > 0 ? (isShort ? +(((entryP - (favorablePrice || entryP)) / entryP) * 100).toFixed(2) : +((((favorablePrice || entryP) - entryP) / entryP) * 100).toFixed(2)) : 0;
  const maePct = entryP > 0 ? (isShort ? +((((adversePrice || entryP) - entryP) / entryP) * 100).toFixed(2) : +(((entryP - (adversePrice || entryP)) / entryP) * 100).toFixed(2)) : 0;

  updated.mfePct = Math.max(0, mfePct);
  updated.maePct = Math.max(0, maePct);
  updated.mfeUSD = +((posSize * (updated.mfePct / 100))).toFixed(2);
  updated.maeUSD = +((posSize * (updated.maePct / 100))).toFixed(2);

  // Remaining active units / position size
  let realizedBanked = updated.realizedCashBankedUSD || 0;
  const activePortion = openFraction(updated.harvestTiers);

  // Unrealized PnL on remaining open units
  const unrealizedPnLUSD = +((posSize * activePortion * (currentReturnPct / 100))).toFixed(2);
  updated.pnlPercentage = currentReturnPct;
  updated.pnlUSD = +(realizedBanked + unrealizedPnLUSD).toFixed(2);

  if (trade.pnlUSD !== updated.pnlUSD || trade.pnlPercentage !== updated.pnlPercentage) {
    hasChanged = true;
  }

  // Initialize Harvest Tiers if missing
  if (!updated.harvestTiers) {
    const t1 = updated.takeProfitPct ? +(updated.takeProfitPct * 0.35).toFixed(2) : 4.0;
    const t2 = updated.takeProfitPct ? +(updated.takeProfitPct * 0.65).toFixed(2) : 8.0;
    const t3 = updated.takeProfitPct || 15.0;

    updated.harvestTiers = {
      tier1: {
        percent: 33,
        targetPct: t1,
        targetPrice: isShort ? roundPrice(entryP * (1 - t1 / 100)) : roundPrice(entryP * (1 + t1 / 100)),
        status: 'PENDING'
      },
      tier2: {
        percent: 33,
        targetPct: t2,
        targetPrice: isShort ? roundPrice(entryP * (1 - t2 / 100)) : roundPrice(entryP * (1 + t2 / 100)),
        status: 'PENDING'
      },
      tier3: {
        percent: 34,
        targetPct: t3,
        targetPrice: isShort ? roundPrice(entryP * (1 - t3 / 100)) : roundPrice(entryP * (1 + t3 / 100)),
        status: 'PENDING'
      }
    };
    hasChanged = true;
  }

  // Initialize Ratchet if missing
  if (!updated.ratchet) {
    // Floor expressed in R (stop distance) rather than a fixed +/-0.3%.
    const beFloorPct = Math.abs(updated.stopLossPct || 3.2) * GEOMETRY_CONFIG.breakevenFloorRMultiple;
    updated.ratchet = {
      isArmed: false,
      triggerPct: updated.harvestTiers.tier1.targetPct,
      floorPrice: isShort
        ? roundPrice(entryP * (1 - beFloorPct / 100))
        : roundPrice(entryP * (1 + beFloorPct / 100)),
      currentProtection: 'INITIAL_DEFENSE',
      floorBufferPct: +beFloorPct.toFixed(2)
    };
    hasChanged = true;
  }

  // EARLY BREAKEVEN DEFENSE (Before Tier 1):
  // If trade achieved favorable excursion (MFE) >= 1.8% (or >= 60% of Tier 1 target),
  // and hasn't yet harvested Tier 1, move stop loss to Entry Price (or slight buffer) so a strong
  // push that stalls does not collapse into a full stop loss.
  if (updated.status === 'OPEN' && (!updated.harvestTiers || updated.harvestTiers.tier1.status === 'PENDING')) {
    const t1Target = updated.harvestTiers?.tier1.targetPct || 3.8;
    const earlyBeThreshold = Math.max(1.8, +(t1Target * 0.6).toFixed(2));
    
    if (updated.mfePct >= earlyBeThreshold && !updated.ratchet?.isArmed) {
      const beFloorPct = 0.2; // +0.2% above entry to cover exchange fee
      const earlyBeFloor = isShort
        ? roundPrice(entryP * (1 - beFloorPct / 100))
        : roundPrice(entryP * (1 + beFloorPct / 100));
      
      const isMoreProtective = isShort ? earlyBeFloor < updated.stopLossPrice : earlyBeFloor > updated.stopLossPrice;
      if (isMoreProtective) {
        updated.stopLossPrice = earlyBeFloor;
        updated.stopLossPct = entryP > 0
          ? +(((isShort ? entryP - earlyBeFloor : earlyBeFloor - entryP) / entryP) * 100).toFixed(2)
          : 0;
        if (updated.ratchet) {
          updated.ratchet.isArmed = true;
          updated.ratchet.currentProtection = 'ZERO_RISK_LOCKED';
        }
        hasChanged = true;
        eventTriggered = 'RATCHET_ENGAGED';
        message = `🛡️ [Early Defense] ${updated.symbol} hit +${updated.mfePct.toFixed(1)}% MFE. Stop moved to breakeven ($${updated.stopLossPrice}) to lock out downside risk.`;
      }
    }
  }

  const fractions = harvestFractions(updated.harvestTiers);

  // EVALUATE HARVEST TIERS
  // Tier 1 Check - Uses effective return to capture instant pumps (+10% to +50% god candles)
  if (updated.harvestTiers.tier1.status === 'PENDING') {
    const reached = isShort 
      ? livePrice <= updated.harvestTiers.tier1.targetPrice 
      : livePrice >= updated.harvestTiers.tier1.targetPrice;
    if (reached) {
      updated.harvestTiers.tier1.status = 'HARVESTED';
      // Capture actual market price if an instant pump exceeded the target
      const gap1 = capGapHarvest(updated.harvestTiers.tier1.targetPct, currentReturnPct);
      if (gap1.capped) {
        console.warn(`[CycleEngine] {1} ${updated.symbol} reported +${currentReturnPct}% at tier 1 - implausible, capped to +${gap1.pct}%. Check the price feed for this symbol.`.replace('{1} ',''));
      }
      const effectiveTier1Pct = gap1.pct;
      // Net of the exit cost on the fraction actually traded.
      const t1Cost = sideCostUSD(posSize * fractions.t1);
      const harvestGain = +(posSize * fractions.t1 * (effectiveTier1Pct / 100)).toFixed(2);   // gross; cost tracked in totalFeesUSD
      updated.totalFeesUSD = +((updated.totalFeesUSD || 0) + t1Cost).toFixed(4);
      realizedBanked += harvestGain;
      updated.realizedCashBankedUSD = +realizedBanked.toFixed(2);

      // ARM RATCHET: Move stop loss to breakeven + buffer
      updated.ratchet.isArmed = true;
      updated.ratchet.currentProtection = 'ZERO_RISK_LOCKED';
      updated.stopLossPrice = updated.ratchet.floorPrice;
      // Record the real distance to the armed floor, not a hardcoded 0.3.
      updated.stopLossPct = entryP > 0
        ? +(((isShort ? entryP - updated.ratchet.floorPrice : updated.ratchet.floorPrice - entryP) / entryP) * 100).toFixed(2)
        : 0;
      hasChanged = true;
      eventTriggered = 'TIER_1_HARVESTED';
      message = effectiveTier1Pct > updated.harvestTiers.tier1.targetPct + 2
        ? `⚡ [Instant Pump Harvest] ${updated.symbol} surged +${effectiveTier1Pct}%! Banked $${harvestGain.toFixed(2)} at market peak. Stop moved to breakeven.`
        : `Tier 1 (+${updated.harvestTiers.tier1.targetPct}%) Harvested! Banked $${harvestGain.toFixed(2)}. Breakeven Ratchet armed at $${updated.ratchet.floorPrice} (stop at breakeven).`;
    }
  }

  // Tier 2 Check - Captures accelerated pump momentum
  if (updated.harvestTiers.tier2.status === 'PENDING') {
    const reached = isShort 
      ? livePrice <= updated.harvestTiers.tier2.targetPrice 
      : livePrice >= updated.harvestTiers.tier2.targetPrice;
    if (reached) {
      updated.harvestTiers.tier2.status = 'HARVESTED';
      const gap2 = capGapHarvest(updated.harvestTiers.tier2.targetPct, currentReturnPct);
      if (gap2.capped) {
        console.warn(`[CycleEngine] {2} ${updated.symbol} reported +${currentReturnPct}% at tier 2 - implausible, capped to +${gap2.pct}%. Check the price feed for this symbol.`.replace('{2} ',''));
      }
      const effectiveTier2Pct = gap2.pct;
      const t2Cost = sideCostUSD(posSize * fractions.t2);
      const harvestGain = +(posSize * fractions.t2 * (effectiveTier2Pct / 100)).toFixed(2);
      updated.totalFeesUSD = +((updated.totalFeesUSD || 0) + t2Cost).toFixed(4);
      realizedBanked += harvestGain;
      updated.realizedCashBankedUSD = +realizedBanked.toFixed(2);

      // Ratchet moves to lock in Tier 1 profit floor
      updated.ratchet.currentProtection = 'PROFIT_PRESERVATION';
      updated.stopLossPrice = updated.harvestTiers.tier1.targetPrice;
      hasChanged = true;
      eventTriggered = 'TIER_2_HARVESTED';
      message = effectiveTier2Pct > updated.harvestTiers.tier2.targetPct + 3
        ? `🚀 [Accelerated Surge] ${updated.symbol} exploded +${effectiveTier2Pct}%! Banked $${harvestGain.toFixed(2)}. Floor locked at Tier 1 ($${updated.stopLossPrice}).`
        : `Tier 2 (+${updated.harvestTiers.tier2.targetPct}%) Harvested! Banked $${harvestGain.toFixed(2)}. Stop loss ratcheted to Tier 1 price ($${updated.stopLossPrice}).`;
    }
  }

  // Tier 3 Check - Converts into Step-Lock Trailing Runner (Captures large trends uncapped)
  if (updated.harvestTiers.tier3.status === 'PENDING') {
    const reached = isShort 
      ? livePrice <= updated.harvestTiers.tier3.targetPrice 
      : livePrice >= updated.harvestTiers.tier3.targetPrice;
    if (reached) {
      updated.harvestTiers.tier3.status = 'HARVESTED';
      // Bank half of tier 3's share, leaving the other half as a free trailing runner
      const gap3 = capGapHarvest(updated.harvestTiers.tier3.targetPct, currentReturnPct);
      if (gap3.capped) {
        console.warn(`[CycleEngine] {3} ${updated.symbol} reported +${currentReturnPct}% at tier 3 - implausible, capped to +${gap3.pct}%. Check the price feed for this symbol.`.replace('{3} ',''));
      }
      const effectiveTier3Pct = gap3.pct;
      const t3Cost = sideCostUSD(posSize * fractions.t3);
      const harvestGain = +(posSize * fractions.t3 * (effectiveTier3Pct / 100)).toFixed(2);
      updated.totalFeesUSD = +((updated.totalFeesUSD || 0) + t3Cost).toFixed(4);
      realizedBanked += harvestGain;
      updated.realizedCashBankedUSD = +realizedBanked.toFixed(2);

      // Lock stop loss firmly at Tier 2 price to guarantee banked gains
      updated.ratchet.currentProtection = 'RUNNER_TRAILING';
      const tier2Floor = updated.harvestTiers.tier2.targetPrice;
      
      // Dynamic trailing buffer: allows high-momentum bullish runners breathing room to run
      const trailingBufferPct = currentReturnPct >= 35 
        ? GEOMETRY_CONFIG.runnerParabolicBuffer35Pct 
        : currentReturnPct >= 20 
        ? GEOMETRY_CONFIG.runnerParabolicBuffer20Pct 
        : GEOMETRY_CONFIG.runnerDefaultBufferPct;
      const trailingFloor = isShort
        ? roundPrice((updated.sessionLowPrice || livePrice) * (1 + trailingBufferPct))
        : roundPrice((updated.sessionHighPrice || livePrice) * (1 - trailingBufferPct));

      updated.stopLossPrice = isShort ? Math.min(tier2Floor, trailingFloor) : Math.max(tier2Floor, trailingFloor);
      hasChanged = true;
      eventTriggered = 'TIER_3_HARVESTED';
      message = `Tier 3 (+${effectiveTier3Pct.toFixed(1)}%) Harvested! Banked $${harvestGain.toFixed(2)}. Final runner armed with dynamic ${(trailingBufferPct * 100).toFixed(1)}% trailing stop at $${updated.stopLossPrice} (uncapped upside)!`;
    }
  }

  // TRAILING STOP once the ladder has reached GEOMETRY_CONFIG.trailAfterTier.
  //
  // The stop follows the highest price reached, one trailAtrMultiple of ATR
  // behind it, and never moves backwards. Before this existed the stop sat at a
  // fixed tier floor between tiers, so a run that stalled short of the next
  // tier gave the whole move back (see the note in config/geometry.ts).
  //
  // After tier 3, bullish runners are protected by a dynamic volatility-adaptive buffer:
  // on large pumps (+20%, +35%), it secures the move with room to breathe (3.5% / 2.5%)
  // so high-momentum parabolic runners aren't shaken out by normal pullbacks.
  if (updated.status === 'OPEN' && updated.harvestTiers) {
    const tiersTaken = [updated.harvestTiers.tier1, updated.harvestTiers.tier2, updated.harvestTiers.tier3]
      .filter((t) => t && t.status === 'HARVESTED').length;

    if (tiersTaken >= GEOMETRY_CONFIG.trailAfterTier) {
      const peakPrice = isShort ? (updated.sessionLowPrice || livePrice) : (updated.sessionHighPrice || livePrice);
      // ATR in price terms; tier 1 sits at 1R = stopAtrMultiple x ATR from entry.
      const atrPrice = updated.atrValue && updated.atrValue > 0
        ? updated.atrValue
        : (entryP * (updated.harvestTiers.tier1.targetPct / 100)) / GEOMETRY_CONFIG.stopAtrMultiple;
      const trailDistance = atrPrice * GEOMETRY_CONFIG.trailAtrMultiple;

      let trailingFloor = isShort ? peakPrice + trailDistance : peakPrice - trailDistance;

      if (updated.harvestTiers.tier3.status === 'HARVESTED') {
        // Dynamic runner buffer for sustained high-run bullish trends:
        const bufferPct = currentReturnPct >= 35 
          ? GEOMETRY_CONFIG.runnerParabolicBuffer35Pct 
          : currentReturnPct >= 20 
          ? GEOMETRY_CONFIG.runnerParabolicBuffer20Pct 
          : GEOMETRY_CONFIG.runnerDefaultBufferPct;
        const pctFloor = isShort ? peakPrice * (1 + bufferPct) : peakPrice * (1 - bufferPct);
        trailingFloor = isShort ? Math.min(trailingFloor, pctFloor) : Math.max(trailingFloor, pctFloor);
      }
      trailingFloor = roundPrice(trailingFloor);

      const isMoreProtective = isShort ? trailingFloor < updated.stopLossPrice : trailingFloor > updated.stopLossPrice;
      if (isMoreProtective) {
        updated.stopLossPrice = trailingFloor;
        updated.stopLossPct = entryP > 0
          ? +(((isShort ? entryP - trailingFloor : trailingFloor - entryP) / entryP) * 100).toFixed(2)
          : 0;
        if (updated.ratchet) updated.ratchet.currentProtection = 'RUNNER_TRAILING';
        hasChanged = true;
      }
    }
  }

  // EVALUATE STOP LOSS / RATCHET HIT (With Realistic Slippage Tracking)
  if (updated.status === 'OPEN') {
    const stopHit = isShort 
      ? livePrice >= updated.stopLossPrice 
      : livePrice <= updated.stopLossPrice;

    if (stopHit) {
      updated.status = 'STOPPED';
      updated.closedAtTimestamp = Date.now();
      // Closing the remaining open fraction costs one more side of friction.
      const exitCost = sideCostUSD(posSize * activePortion);
      updated.totalFeesUSD = +((updated.totalFeesUSD || 0) + exitCost).toFixed(4);
      // pnlUSD stays GROSS. Friction lives only in totalFeesUSD; netting it here as
      // well subtracted it twice once bankrollService deducted totalFeesUSD.
      updated.pnlUSD = +(realizedBanked + (posSize * activePortion * (currentReturnPct / 100))).toFixed(2);

      if (updated.harvestTiers?.tier3.status === 'HARVESTED') {
        updated.exitReason = 'TRAILING_RUNNER_EXIT';
        eventTriggered = 'RATCHET_ENGAGED';
        message = `Trailing Runner Exited at $${livePrice}. Total realized profit secured: $${realizedBanked.toFixed(2)}.`;
      } else if (updated.ratchet?.isArmed) {
        updated.exitReason = 'RATCHET_BREAKEVEN_HIT';
        eventTriggered = 'RATCHET_ENGAGED';
        message = `Breakeven stop hit at $${livePrice}. Position closed; $${realizedBanked.toFixed(2)} was banked earlier.`;
      } else {
        updated.exitReason = 'STOP_LOSS_HIT';
        eventTriggered = 'STOPPED_OUT';
        
        // Realistic Execution Slippage Calculation:
        // If price gapped past the stop, record realistic slippage gap instead of assuming perfect fill
        const stopPrice = updated.stopLossPrice;
        const slippageGapPct = isShort 
          ? (livePrice > stopPrice && entryP > 0 ? +(((livePrice - stopPrice) / entryP) * 100).toFixed(2) : 0)
          : (livePrice < stopPrice && entryP > 0 ? +(((stopPrice - livePrice) / entryP) * 100).toFixed(2) : 0);

        const totalLossPct = Math.abs(updated.stopLossPct || 5) + slippageGapPct;
        const lossAmount = +(posSize * (totalLossPct / 100)).toFixed(2);
        updated.pnlUSD = -lossAmount;
        
        if (slippageGapPct > 0.5) {
          message = `Stop Loss executed at $${livePrice} (-${totalLossPct.toFixed(2)}%, incl. ${slippageGapPct.toFixed(1)}% market slippage gap). Loss -$${lossAmount.toFixed(2)}.`;
        } else {
          message = `Stop Loss hit at $${livePrice} (-${Math.abs(updated.stopLossPct || 5)}%). Loss -$${lossAmount.toFixed(2)}.`;
        }
      }
      hasChanged = true;
    }
  }

  // Update Numerical Cycle Metrics
  if (!updated.numericalCycleMetrics) {
    updated.numericalCycleMetrics = {
      momentumVelocityScore: 75,
      momentumState: 'HEALTHY_IMPULSE',
      volumeLiquidityRatio: 24.5,
      volumeState: 'NORMAL',
      stagnationDecile: 4,
      stagnationThreshold: 7.5,
      fourHourEmaFloor: roundPrice(entryP * 0.98),
      atrTrailingFloorValue: roundPrice(entryP * 0.96),
      dynamicExitFloor: roundPrice(entryP * 0.97),
      cycleCompletionPct: 35,
      cycleStatusSummary: `Active trade running with +${currentReturnPct}% return.`
    };
  }

  // Dynamic cycle completion calculation
  const t1Hit = updated.harvestTiers?.tier1.status === 'HARVESTED';
  const t2Hit = updated.harvestTiers?.tier2.status === 'HARVESTED';
  const compPct = updated.status === 'COMPLETED' ? 100 
    : updated.status === 'STOPPED' ? 100 
    : t2Hit ? 75 
    : t1Hit ? 45 
    : Math.max(10, Math.min(40, Math.round((currentReturnPct / (updated.takeProfitPct || 15)) * 100)));

  updated.numericalCycleMetrics.cycleCompletionPct = compPct;

  return {
    trade: updated,
    hasChanged,
    eventTriggered,
    message
  };
}

/**
 * Closes the rest of a position at `price` outside the exit ladder (manual
 * close, stagnation recycle). The same arithmetic as a stop: gross pnlUSD is
 * what was banked plus the open remainder at `price`, and closing that
 * remainder costs one more side of friction. The old manual close kept the
 * last pnlUSD and charged no exit cost, overstating net by ~15 bps of the
 * remainder.
 */
export function closeTradeAt(
  trade: AutomatedTradeRecord,
  price: number,
  exitReason: string,
  now: number = Date.now()
): AutomatedTradeRecord {
  const isShort = trade.direction === 'SHORT';
  const entry = trade.entryPrice;
  const posSize = trade.positionSizeUSD || 0;
  const returnPct = entry > 0 ? (isShort ? (entry - price) / entry : (price - entry) / entry) * 100 : 0;
  const activePortion = openFraction(trade.harvestTiers);
  const banked = trade.realizedCashBankedUSD || 0;
  return {
    ...trade,
    status: 'COMPLETED',
    exitReason: exitReason as AutomatedTradeRecord['exitReason'],
    closedAtTimestamp: now,
    exitPrice: price,
    currentPrice: price,
    pnlPercentage: +returnPct.toFixed(2),
    pnlUSD: +(banked + posSize * activePortion * (returnPct / 100)).toFixed(2),
    totalFeesUSD: +((trade.totalFeesUSD || 0) + sideCostUSD(posSize * activePortion)).toFixed(4),
  };
}

/**
 * Closes a trade the stale-trade rule recycled (open too long, flat or
 * bleeding, before tier 1). Priced like any other close: the open remainder at
 * `price` plus one more side of cost. The recycle used to write pnlUSD itself
 * and charge no exit cost, so every recycled trade looked 15 bps of its size
 * better than it was.
 */
export function recycleStaleTrade(
  trade: AutomatedTradeRecord,
  price: number,
  reason: string,
  now: number = Date.now()
): AutomatedTradeRecord {
  return {
    ...closeTradeAt(trade, price, 'STAGNATION_TIMEOUT', now),
    status: 'STOPPED',
    numericalCycleMetrics: {
      ...trade.numericalCycleMetrics,
      momentumVelocityScore: 25,
      momentumState: 'STAGNANT_CHOP',
      stagnationDecile: 10,
      cycleCompletionPct: 100,
      cycleStatusSummary: `Auto-Recycled to Cash: ${reason}`,
    } as NumericalCycleMetrics,
  };
}
