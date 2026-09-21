import { AutomatedTradeRecord, BankrollConfig, BankrollState, BankrollSlotInfo, ZombieTradeConfig } from '../types/automatedFeed';

export const DEFAULT_ZOMBIE_CONFIG: ZombieTradeConfig = {
  enabled: true,
  maxStaleHours: 24,
  maxStaleMovementPct: 0.8,
  autoRecycleToCash: true,
};

export const DEFAULT_BANKROLL_CONFIG: BankrollConfig = {
  totalBudgetUSD: 100.00,
  trancheSizeUSD: 10.00,
  compoundProfits: true,
  maxSlots: 10,
  zombieTradeRecycle: DEFAULT_ZOMBIE_CONFIG,
};

const BANKROLL_STORAGE_KEY = 'crypto_bankroll_treasury_config';

/**
 * Loads current Bankroll configuration from local persistence
 */
export function getBankrollConfig(): BankrollConfig {
  try {
    if (typeof window === 'undefined') return { ...DEFAULT_BANKROLL_CONFIG };
    const stored = localStorage.getItem(BANKROLL_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const zombieRecycle = parsed.zombieTradeRecycle || {};
      return {
        totalBudgetUSD: typeof parsed.totalBudgetUSD === 'number' && parsed.totalBudgetUSD > 0 ? parsed.totalBudgetUSD : 100.00,
        trancheSizeUSD: typeof parsed.trancheSizeUSD === 'number' && parsed.trancheSizeUSD > 0 ? parsed.trancheSizeUSD : 10.00,
        compoundProfits: typeof parsed.compoundProfits === 'boolean' ? parsed.compoundProfits : true,
        maxSlots: typeof parsed.maxSlots === 'number' && parsed.maxSlots > 0 ? parsed.maxSlots : 10,
        zombieTradeRecycle: {
          enabled: typeof zombieRecycle.enabled === 'boolean' ? zombieRecycle.enabled : DEFAULT_ZOMBIE_CONFIG.enabled,
          maxStaleHours: typeof zombieRecycle.maxStaleHours === 'number' ? zombieRecycle.maxStaleHours : DEFAULT_ZOMBIE_CONFIG.maxStaleHours,
          maxStaleMovementPct: typeof zombieRecycle.maxStaleMovementPct === 'number' ? zombieRecycle.maxStaleMovementPct : DEFAULT_ZOMBIE_CONFIG.maxStaleMovementPct,
          autoRecycleToCash: typeof zombieRecycle.autoRecycleToCash === 'boolean' ? zombieRecycle.autoRecycleToCash : DEFAULT_ZOMBIE_CONFIG.autoRecycleToCash,
        }
      };
    }
  } catch (e) {
    console.warn('Failed to load bankroll config from storage:', e);
  }
  return { ...DEFAULT_BANKROLL_CONFIG };
}

/**
 * Evaluates whether an active trade is a stagnant "zombie trade" that should be recycled to cash.
 * A trade is considered zombie if:
 * 1. Status is OPEN and has NOT harvested Tier 1 or Tier 2 yet
 * 2. It has been open for longer than maxStaleHours (e.g. 24h)
 * 3. Total price movement since entry is strictly within  maxStaleMovementPct (e.g.  0.8%)
 */
export function isTradeZombieStale(
  trade: AutomatedTradeRecord,
  customConfig?: ZombieTradeConfig,
  livePriceOverride?: number
): {
  isStale: boolean;
  hoursElapsed: number;
  movementPct: number;
  thresholdHours: number;
  thresholdMovementPct: number;
  reason: string;
} {
  const config = customConfig || getBankrollConfig().zombieTradeRecycle || DEFAULT_ZOMBIE_CONFIG;
  // Adaptive threshold: 1-2 Day Futures trades evaluate stagnation after 6h, Macro Spot after 24h
  const isFutures = Boolean(
    trade.timeframe?.includes('Futures') || 
    trade.timeframe?.includes('1-2 Day') ||
    (trade.holdingPeriodDays && trade.holdingPeriodDays <= 2) ||
    !trade.holdingPeriodDays // Default to 1-2 day futures micro-tranche pacing
  );
  const thresholdHours = customConfig?.maxStaleHours 
    ? customConfig.maxStaleHours 
    : (isFutures ? 6 : (config.maxStaleHours || 24));
  const thresholdMovementPct = customConfig?.maxStaleMovementPct 
    ? customConfig.maxStaleMovementPct 
    : (config.maxStaleMovementPct || 0.7);

  if (trade.status !== 'OPEN') {
    return {
      isStale: false,
      hoursElapsed: 0,
      movementPct: 0,
      thresholdHours,
      thresholdMovementPct,
      reason: 'Trade is already closed.'
    };
  }

  // If trade already harvested Tier 1 (+4%), it is a winner runner with trailing stop/zero risk, NOT a zombie
  if (trade.harvestTiers?.tier1.status === 'HARVESTED') {
    return {
      isStale: false,
      hoursElapsed: 0,
      movementPct: 0,
      thresholdHours,
      thresholdMovementPct,
      reason: 'Trade has already harvested profit; trailing runner active.'
    };
  }

  // Compute elapsed hours
  let hoursElapsed = 0;
  if (trade.openedAtTimestamp && trade.openedAtTimestamp > 0) {
    hoursElapsed = Math.max(0, (Date.now() - trade.openedAtTimestamp) / (1000 * 60 * 60));
  } else if (trade.holdingPeriodDays && trade.holdingPeriodDays > 0) {
    hoursElapsed = trade.holdingPeriodDays * 24;
  } else {
    // Fallback estimation
    hoursElapsed = 6;
  }

  const currentP = livePriceOverride || trade.currentPrice || trade.entryPrice;
  const movementPct = trade.entryPrice > 0 ? +(((currentP - trade.entryPrice) / trade.entryPrice) * 100).toFixed(2) : 0;
  const absMovementPct = Math.abs(movementPct);

  const isTimeExceeded = hoursElapsed >= thresholdHours;
  const isMovementFlat = absMovementPct <= thresholdMovementPct;
  const isStale = isTimeExceeded && isMovementFlat;

  let reason = '';
  if (isStale) {
    reason = `Open for ${Math.round(hoursElapsed)}h with only ${movementPct >= 0 ? '+' : ''}${movementPct}% movement (within  ${thresholdMovementPct}% stagnant range). Slot eligible for auto-recycling.`;
  } else if (isTimeExceeded) {
    reason = `Open for ${Math.round(hoursElapsed)}h, but price has expanded ${movementPct >= 0 ? '+' : ''}${movementPct}% (outside flat range).`;
  } else {
    reason = `Active for ${hoursElapsed.toFixed(1)}h of ${thresholdHours}h stale window.`;
  }

  return {
    isStale,
    hoursElapsed: +hoursElapsed.toFixed(1),
    movementPct,
    thresholdHours,
    thresholdMovementPct,
    reason
  };
}

/**
 * Persists updated Bankroll configuration
 */
export function saveBankrollConfig(config: BankrollConfig): void {
  try {
    localStorage.setItem(BANKROLL_STORAGE_KEY, JSON.stringify(config));
  } catch (e) {
    console.error('Failed to save bankroll config:', e);
  }
}

export const MAX_CONCURRENT_TRADES = 10;

/**
 * Mathematically evaluates the entire Bankroll Treasury state from raw trade records
 */
export function calculateBankrollState(
  trades: AutomatedTradeRecord[],
  customConfig?: BankrollConfig
): BankrollState {
  const config = customConfig || getBankrollConfig();
  const initialBudget = config.totalBudgetUSD || 100.00;
  const trancheSize = config.trancheSizeUSD || 10.00;
  const totalSlots = Math.min(MAX_CONCURRENT_TRADES, config.maxSlots || 10);

  const openTrades = trades.filter((t) => t.status === 'OPEN');
  const closedTrades = trades.filter((t) => t.status !== 'OPEN');
  const activeTradesCount = openTrades.length;
  const closedTradesCount = closedTrades.length;

  // 1. Deployed Capital (Cash locked in active trades)
  const deployedCapitalUSD = openTrades.reduce((acc, t) => acc + (t.positionSizeUSD || trancheSize), 0);

  // 2. Realized Cash & Closed PnL (with safety guard against corrupted legacy unit mismatches or anomalous feed jumps)
  const sanitizedRealizedBanked = (t: AutomatedTradeRecord) => {
    const rawBanked = Number(t.realizedCashBankedUSD) || 0;
    const posSize = t.positionSizeUSD || trancheSize;
    // Banked harvest cash across tiers cannot exceed 20% of position size (e.g. max $2.00 on a $10 tranche)
    const maxHarvest = posSize * 0.20;
    return Math.max(0, Math.min(maxHarvest, rawBanked));
  };

  // Closed P&L is reported as recorded.
  //
  // This previously clamped every closed trade into a window derived from its
  // own plan (max ~25% gain, ~15% loss). That silently deleted exactly the
  // observations that distinguish a trend strategy from a scalper - the tails -
  // and made win rate, expectancy and profit factor unmeasurable. If a value
  // looks impossible, that is a bug to find upstream, not to hide here.
  const sanitizedClosedPnL = (t: AutomatedTradeRecord) => {
    const rawPnl = Number(t.pnlUSD);
    if (!Number.isFinite(rawPnl)) return 0;
    const posSize = t.positionSizeUSD || trancheSize;
    if (Math.abs(rawPnl) > posSize * 2) {
      console.warn(`[Bankroll] ${t.symbol} closed P&L $${rawPnl.toFixed(2)} exceeds 2x its $${posSize.toFixed(2)} position - likely an upstream accounting bug.`);
    }
    return rawPnl;
  };

  const partialBankedCashOnOpen = openTrades.reduce((acc, t) => acc + sanitizedRealizedBanked(t), 0);
  const closedTradesPnL = closedTrades.reduce((acc, t) => acc + sanitizedClosedPnL(t), 0);
  
  // Gross Realized Harvest Gains (before Binance trading fees)
  const grossRealizedProfitUSD = +(partialBankedCashOnOpen + closedTradesPnL).toFixed(2);

  // Exchange Fees Incurred (Binance 0.10% Spot Maker/Taker round-trip on every trade rotation)
  // Fees are accumulated per fill in cycleEngineService using config/costs.ts.
  const totalFeesPaidUSD = +trades.reduce((acc, t) => {
    const fee = Number(t.totalFeesUSD);
    return acc + (Number.isFinite(fee) && fee > 0 ? fee : 0);
  }, 0).toFixed(2);

  // Net Realized Treasury Gain (Strictly after deducting all Binance trading fees)
  const totalRealizedProfitUSD = +(grossRealizedProfitUSD - totalFeesPaidUSD).toFixed(2);

  // 3. Unrealized PnL on remaining open positions (clamped to realistic bounds)
  // Unrealized = P&L on the units still open ONLY.
  //
  // cycleEngineService sets pnlUSD = realizedBanked + unrealized, and banked
  // cash for open trades is already counted in partialBankedCashOnOpen above.
  // Summing raw pnlUSD here would count harvested cash twice. The old clamp
  // bounded that error rather than fixing it.
  const unrealizedPnLUSD = +openTrades.reduce((acc, t) => {
    const rawPnl = Number(t.pnlUSD);
    if (!Number.isFinite(rawPnl)) return acc;
    return acc + (rawPnl - sanitizedRealizedBanked(t));
  }, 0).toFixed(2);

  // 4. Liquid Cash Available to deploy (Starting 100 USDT + Gross Profits - All Fees Paid - Deployed Capital)
  const rawLiquidCash = initialBudget + grossRealizedProfitUSD - totalFeesPaidUSD - deployedCapitalUSD;
  const liquidCashUSD = +Math.max(0, rawLiquidCash).toFixed(2);

  // 5. Total Portfolio Value (Equity) = Starting Budget (100 USDT) + Net Realized Gain + Unrealized PnL
  const totalPortfolioValueUSD = +(initialBudget + totalRealizedProfitUSD + unrealizedPnLUSD).toFixed(2);

  // Dynamic Compounding Tranche Sizing:
  // Automatically scales new trade tranches with Total Capital divided by 10 (or totalSlots).
  // Example: If portfolio capital is $100 -> $10.00 per trade. If capital grows to $140 -> $14.00 per trade.
  const isCompounding = config.compoundProfits !== false;
  const baseTranche = config.trancheSizeUSD || 10.00;
  const calculatedCompoundedTranche = +(totalPortfolioValueUSD / totalSlots).toFixed(2);
  const effectiveTrancheSize = isCompounding
    ? +Math.max(5.00, calculatedCompoundedTranche).toFixed(2)
    : baseTranche;

  // 6. Net Profit and Percentage (Factoring in all trading fees)
  const netProfitUSD = +(totalPortfolioValueUSD - initialBudget).toFixed(2);
  const netProfitPct = +((netProfitUSD / initialBudget) * 100).toFixed(2);

  // 7. Available Tranche Slots (strictly capped by max 10 slots and available cash)
  const remainingSlots = Math.max(0, totalSlots - activeTradesCount);
  const cashSlots = Math.floor(liquidCashUSD / effectiveTrancheSize);
  const availableSlots = Math.max(0, Math.min(remainingSlots, cashSlots));

  // 8. Health State Classification
  let healthState: 'THRIVING' | 'HEALTHY' | 'GUARDED' | 'DRAWDOWN' = 'HEALTHY';
  if (netProfitPct >= 2.0) {
    healthState = 'THRIVING';
  } else if (netProfitPct >= -1.0) {
    healthState = 'HEALTHY';
  } else if (netProfitPct >= -5.0) {
    healthState = 'GUARDED';
  } else {
    healthState = 'DRAWDOWN';
  }

  // 9. Can Open New Trade Gate - STRICT LIMITS:
  // Must NOT exceed MAX_CONCURRENT_TRADES (10)
  // Must NOT exceed available liquid cash (liquidCashUSD >= effectiveTrancheSize)
  // Must NOT exceed total portfolio balance (deployedCapitalUSD + effectiveTrancheSize <= totalPortfolioValueUSD)
  const hasSlotAvailable = activeTradesCount < totalSlots && availableSlots > 0;
  const hasSufficientCash = liquidCashUSD >= effectiveTrancheSize;
  const withinBalanceLimit = (deployedCapitalUSD + effectiveTrancheSize) <= (totalPortfolioValueUSD + 0.05);

  const canOpenNewTrade = hasSlotAvailable && hasSufficientCash && withinBalanceLimit;

  let blockReason: string | undefined;
  if (!canOpenNewTrade) {
    if (activeTradesCount >= totalSlots) {
      blockReason = `Maximum 10 concurrent active trades reached (${activeTradesCount}/10 slots filled). Waiting for a position to exit.`;
    } else if (!hasSufficientCash) {
      blockReason = `Available cash ($${liquidCashUSD.toFixed(2)}) is below required compounding tranche ($${effectiveTrancheSize.toFixed(2)} = Capital / 10).`;
    } else if (!withinBalanceLimit) {
      blockReason = `Trade would exceed total portfolio balance ($${totalPortfolioValueUSD.toFixed(2)}). Risk guard active.`;
    } else {
      blockReason = `No available slots. Cash or slot limit reached.`;
    }
  }

  // 10. Generate Visual Slot Map (exactly totalSlots = 10 slots)
  const slots: BankrollSlotInfo[] = [];
  for (let i = 0; i < totalSlots; i++) {
    if (i < openTrades.length) {
      slots.push({
        slotIndex: i + 1,
        status: 'FILLED',
        trade: openTrades[i],
        allocatedUSD: openTrades[i].positionSizeUSD || effectiveTrancheSize
      });
    } else if (i < activeTradesCount + availableSlots) {
      slots.push({
        slotIndex: i + 1,
        status: 'AVAILABLE',
        allocatedUSD: effectiveTrancheSize
      });
    } else {
      slots.push({
        slotIndex: i + 1,
        status: 'LOCKED',
        allocatedUSD: effectiveTrancheSize
      });
    }
  }

  return {
    initialBudgetUSD: initialBudget,
    trancheSizeUSD: effectiveTrancheSize,
    isCompounding,
    totalSlots,
    activeTradesCount,
    closedTradesCount,
    availableSlots,
    deployedCapitalUSD: +deployedCapitalUSD.toFixed(2),
    liquidCashUSD,
    realizedProfitUSD: totalRealizedProfitUSD,
    grossRealizedProfitUSD,
    totalFeesPaidUSD,
    unrealizedPnLUSD,
    totalPortfolioValueUSD,
    netProfitUSD,
    netProfitPct,
    healthState,
    canOpenNewTrade,
    blockReason,
    slots
  };
}

/**
 * Computes the quantitative strategy verification scorecard comparing
 * active paper performance against required statistical benchmarks.
 * Metrics are completely unified with calculateBankrollState.
 */
export function calculateStrategyVerification(
  trades: AutomatedTradeRecord[],
  customConfig?: BankrollConfig
): import('../types/automatedFeed').StrategyVerificationReport {
  const bankroll = calculateBankrollState(trades, customConfig);
  const closedTrades = trades.filter((t) => t.status !== 'OPEN');
  const sampleSize = closedTrades.length;
  const targetSampleSize = 30;
  const sampleProgressPct = Math.min(100, Math.round((sampleSize / targetSampleSize) * 100));

  // Consistent win / loss / breakeven threshold (+/- $0.01)
  const winTrades = closedTrades.filter((t) => (t.pnlUSD || 0) > 0.01);
  const lossTrades = closedTrades.filter((t) => (t.pnlUSD || 0) < -0.01);
  const breakevenTrades = closedTrades.filter((t) => Math.abs(t.pnlUSD || 0) <= 0.01);

  const winCount = winTrades.length;
  const lossCount = lossTrades.length;
  const breakevenCount = breakevenTrades.length;

  // Win / Loss Ratio: completed winning trades divided by completed losing trades
  const winLossRatio = lossCount > 0 
    ? +(winCount / lossCount).toFixed(2) 
    : (winCount > 0 ? winCount : 0);
  
  const winLossRatioFormatted = lossCount > 0
    ? `${winLossRatio.toFixed(2)}:1`
    : winCount > 0
      ? `${winCount}:0 (100% Win)`
      : '0:0';

  const winRatePct = sampleSize > 0 ? +((winCount / sampleSize) * 100).toFixed(1) : 0;
  const targetWinRatePct = 50.0;
  const winRatePassed = sampleSize > 0 && winRatePct >= targetWinRatePct;

  const totalWinUSD = winTrades.reduce((acc, t) => acc + (t.pnlUSD || 0), 0);
  const totalLossUSD = Math.abs(lossTrades.reduce((acc, t) => acc + (t.pnlUSD || 0), 0));

  const avgWinUSD = winCount > 0 ? +(totalWinUSD / winCount).toFixed(2) : 0;
  const avgLossUSD = lossCount > 0 ? +(totalLossUSD / lossCount).toFixed(2) : 0;

  // Payoff Ratio (Asymmetry: Avg Win / Avg Loss)
  const payoffRatio = avgLossUSD > 0 
    ? +(avgWinUSD / avgLossUSD).toFixed(2) 
    : (avgWinUSD > 0 ? +(avgWinUSD).toFixed(2) : 0);
  const targetPayoffRatio = 2.50;
  const payoffPassed = sampleSize > 0 && payoffRatio >= targetPayoffRatio;

  // Profit Factor (Gross Realized Gains / Gross Realized Losses)
  const grossProfitUSD = +totalWinUSD.toFixed(2);
  const grossLossUSD = +totalLossUSD.toFixed(2);

  // Total Fees and Realized Profit: consistent with bankroll state
  const totalFeesUSD = bankroll.totalFeesPaidUSD;
  const netRealizedPnLUSD = bankroll.realizedProfitUSD;
  const startingCapitalUSD = bankroll.initialBudgetUSD;

  const profitFactor = grossLossUSD > 0 
    ? +(grossProfitUSD / grossLossUSD).toFixed(2) 
    : (grossProfitUSD > 0 ? +(grossProfitUSD).toFixed(2) : 0);
  const targetProfitFactor = 1.80;
  const profitFactorPassed = sampleSize > 0 && profitFactor >= targetProfitFactor;

  // Max Drawdown: peak-to-trough from running closed cumulative PnL
  let runningPnL = 0;
  let peakPnL = 0;
  let maxDrawdownDollar = 0;

  const sortedClosed = [...closedTrades].sort(
    (a, b) => (a.closedAtTimestamp || a.openedAtTimestamp || 0) - (b.closedAtTimestamp || b.openedAtTimestamp || 0)
  );
  for (const t of sortedClosed) {
    runningPnL += (t.pnlUSD || 0);
    if (runningPnL > peakPnL) {
      peakPnL = runningPnL;
    }
    const dd = peakPnL - runningPnL;
    if (dd > maxDrawdownDollar) {
      maxDrawdownDollar = dd;
    }
  }
  const maxDrawdownPct = startingCapitalUSD > 0 ? +(Math.min(100, (maxDrawdownDollar / startingCapitalUSD) * 100)).toFixed(1) : 0;
  const targetMaxDrawdownPct = 8.0;
  const drawdownPassed = sampleSize > 0 ? maxDrawdownPct <= targetMaxDrawdownPct : false;

  // Mathematical Expectancy per $10 tranche (Strict real calculation, no mock numbers):
  const winRateDec = sampleSize > 0 ? (winCount / sampleSize) : 0;
  const lossRateDec = sampleSize > 0 ? (lossCount / sampleSize) : 0;
  const effectiveAvgWin = avgWinUSD;
  const effectiveAvgLoss = avgLossUSD;
  const avgFeePerTranche = sampleSize > 0 ? +(totalFeesUSD / sampleSize).toFixed(3) : 0;
  const expectancyUSD = sampleSize > 0
    ? +((winRateDec * effectiveAvgWin) - (lossRateDec * effectiveAvgLoss) - avgFeePerTranche).toFixed(2)
    : 0;
  const targetExpectancyUSD = 0.50; // +$0.50 per $10 slot (+5.0% edge per rotation)
  const expectancyPassed = sampleSize > 0 && expectancyUSD >= targetExpectancyUSD;

  // Zero-Risk Ratchet Rate: % of all trades that triggered Tier 1 ratchet
  const tradesWithRatchet = trades.filter(t => t.ratchet?.isArmed || t.harvestTiers?.tier1?.status === 'HARVESTED').length;
  const zeroRiskRatchetRatePct = trades.length > 0 ? +((tradesWithRatchet / trades.length) * 100).toFixed(1) : 0;
  const targetZeroRiskRatchetRatePct = 40.0;
  const ratchetPassed = trades.length > 0 && zeroRiskRatchetRatePct >= targetZeroRiskRatchetRatePct;

  let passedCount = 0;
  if (winRatePassed) passedCount++;
  if (payoffPassed) passedCount++;
  if (profitFactorPassed) passedCount++;
  if (drawdownPassed) passedCount++;
  if (expectancyPassed) passedCount++;
  if (ratchetPassed) passedCount++;

  const readinessScore = Math.round((passedCount / 6) * 100);

  let readinessStatus: 'VALIDATED_READY' | 'SAMPLE_IN_PROGRESS' | 'DEFENSIVE_REGIME_WARNING' = 'SAMPLE_IN_PROGRESS';
  let verdictSummary = '';
  let recommendation = '';

  if (sampleSize >= 20 && passedCount >= 5) {
    readinessStatus = 'VALIDATED_READY';
    verdictSummary = `Statistical Validation Passed: ${sampleSize} verified trades logged with ${winRatePct}% win rate and ${payoffRatio}x asymmetry.`;
    recommendation = 'Strategy has demonstrated verified mathematical edge across market cycles. Ready for conservative live position sizing.';
  } else if (sampleSize >= 5 && (expectancyUSD < 0 || maxDrawdownPct > 12)) {
    readinessStatus = 'DEFENSIVE_REGIME_WARNING';
    verdictSummary = `Defensive Regime Triggered: Drawdown (${maxDrawdownPct}%) or expectancy ($${expectancyUSD.toFixed(2)}) breached safety parameters.`;
    recommendation = 'System has restricted automated position sizing. Review market regime confluence before manual redeployment.';
  } else {
    readinessStatus = 'SAMPLE_IN_PROGRESS';
    verdictSummary = `Sampling Phase: ${sampleSize} of ${targetSampleSize} required closed trade cycles logged (${sampleProgressPct}% progress).`;
    recommendation = 'Maintain fixed $10 micro-tranches until N ≥ 30 sample threshold is reached to confirm statistical stability.';
  }

  return {
    sampleSize,
    targetSampleSize,
    sampleProgressPct,
    winCount,
    lossCount,
    breakevenCount,
    winLossRatio,
    winLossRatioFormatted,
    winRatePct,
    targetWinRatePct,
    winRatePassed,
    avgWinUSD,
    avgLossUSD,
    payoffRatio,
    targetPayoffRatio,
    payoffPassed,
    grossProfitUSD,
    grossLossUSD,
    totalFeesUSD,
    netRealizedPnLUSD,
    startingCapitalUSD,
    profitFactor,
    targetProfitFactor,
    profitFactorPassed,
    maxDrawdownPct,
    targetMaxDrawdownPct,
    drawdownPassed,
    expectancyUSD,
    targetExpectancyUSD,
    expectancyPassed,
    zeroRiskRatchetRatePct,
    targetZeroRiskRatchetRatePct,
    ratchetPassed,
    readinessStatus,
    readinessScore,
    verdictSummary,
    recommendation
  };
}

/**
 * Exports trades to JSON string format
 */
export function exportTradesToJSON(trades: AutomatedTradeRecord[]): string {
  return JSON.stringify(trades, null, 2);
}

/**
 * Exports trades to CSV spreadsheet string format
 */
export function exportTradesToCSV(trades: AutomatedTradeRecord[]): string {
  const headers = [
    'ID',
    'Symbol',
    'Coin Name',
    'Action',
    'Direction',
    'Status',
    'Entry Price',
    'Current Price',
    'Exit Price',
    'Position Size (USD)',
    'PnL (USD)',
    'PnL (%)',
    'Banked Cash (USD)',
    'Fees Paid (USD)',
    'Exit Reason',
    'Entry Date',
    'Holding Days'
  ];

  const rows = trades.map((t) => [
    `"${t.id}"`,
    `"${t.symbol}"`,
    `"${t.coinName}"`,
    `"${t.action}"`,
    `"${t.direction || 'LONG'}"`,
    `"${t.status}"`,
    t.entryPrice,
    t.currentPrice,
    t.exitPrice ?? '',
    t.positionSizeUSD ?? 10.0,
    t.pnlUSD ?? 0,
    t.pnlPercentage ?? 0,
    t.realizedCashBankedUSD ?? 0,
    t.totalFeesUSD ?? 0.02,
    `"${t.exitReason || ''}"`,
    `"${t.entryDate}"`,
    t.holdingPeriodDays ?? 1
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

