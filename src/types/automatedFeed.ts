export type AutomatedActionType = 
  | 'SHORT_TERM_HARVEST_1W'
  | 'TACTICAL_CYCLE_2W'
  | 'MEAN_REVERSION_DIP'
  | 'MOMENTUM_BREAKOUT_2W'
  | 'VOLATILITY_EXPANSION_1W'
  | 'INFRASTRUCTURE_CATALYST_2W'
  | 'TACTICAL_SWING' 
  | 'CYCLICAL_DCA' 
  | 'EXTREME_FEAR_TRANCHE_DCA'
  | 'ORACLE_CCIP_ACCUMULATION'
  | 'BEARISH_ROTATION_SHORT';

export type ActionCategory = 'trade' | 'investment';

export type TradeExecutionStatus = 
  | 'OPEN' 
  | 'COMPLETED'
  | 'STOPPED'
  | 'CLOSED_TAKE_PROFIT' 
  | 'CLOSED_STOP_LOSS' 
  | 'CLOSED_SIGNAL_REVERSAL' 
  | 'CLOSED_TIME_DECAY' 
  | 'CLOSED_ORDER_FLOW_DUMP' 
  | 'CLOSED_MANUAL';

export interface ZombieTradeConfig {
  enabled: boolean; // default: true
  maxStaleHours: number; // default: 24h (stale threshold)
  maxStaleMovementPct: number; // default: 0.8% (flat boundary)
  autoRecycleToCash: boolean; // default: true
}

export interface BankrollConfig {
  totalBudgetUSD: number; // e.g. 100.00
  trancheSizeUSD: number; // e.g. 10.00
  compoundProfits?: boolean; // Dynamic compounding: tranche size = total portfolio capital / 10 (default: true)
  maxSlots?: number; // e.g. 10
  zombieTradeRecycle?: ZombieTradeConfig;
}

export interface BankrollSlotInfo {
  slotIndex: number;
  status: 'FILLED' | 'AVAILABLE' | 'LOCKED';
  trade?: AutomatedTradeRecord;
  allocatedUSD: number;
}

export interface BankrollState {
  initialBudgetUSD: number;
  trancheSizeUSD: number;
  totalSlots: number;
  activeTradesCount: number;
  closedTradesCount: number;
  availableSlots: number;
  deployedCapitalUSD: number;
  liquidCashUSD: number;
  realizedProfitUSD: number;
  grossRealizedProfitUSD?: number;
  totalFeesPaidUSD: number; // Cumulative exchange fees incurred (0.10% spot maker/taker)
  unrealizedPnLUSD: number;
  totalPortfolioValueUSD: number;
  netProfitUSD: number;
  netProfitPct: number;
  healthState: 'THRIVING' | 'HEALTHY' | 'GUARDED' | 'DRAWDOWN';
  canOpenNewTrade: boolean;
  blockReason?: string;
  isCompounding?: boolean;
  slots: BankrollSlotInfo[];
}

export interface HarvestTierInfo {
  percent: number; // e.g. 33
  targetPrice: number;
  targetPct: number; // e.g. 4.0
  status: 'HARVESTED' | 'PENDING' | 'TRIGGERED';
  realizedUSD?: number;
}

export interface BreakevenRatchetInfo {
  isArmed: boolean;
  triggerPct: number; // e.g. 3.0%
  floorPrice: number;
  currentProtection: 'ZERO_RISK' | 'INITIAL_DEFENSE' | 'TRAILING_PROFIT' | 'ZERO_RISK_LOCKED' | 'PROFIT_PRESERVATION' | 'RUNNER_TRAILING';
  floorBufferPct?: number; // e.g. 0.4%
}

export interface NumericalCycleMetrics {
  momentumVelocityScore: number; // e.g. 84 / 100
  momentumState: 'ACCELERATING' | 'HEALTHY_IMPULSE' | 'EXHAUSTION_WARNING' | 'EXHAUSTED_HARVEST' | 'EXHAUSTED' | 'STAGNANT_CHOP';
  volumeLiquidityRatio: number; // e.g. +22% vs 20d avg
  volumeState: 'EXPANDING' | 'NORMAL' | 'STAGNANT_DRAIN' | 'SURGING';
  stagnationDecile: number; // 1-10 (1 = highly active, 10 = stagnant/stale)
  stagnationThreshold: number; // e.g. 7.5 max allowed before auto-exit
  fourHourEmaFloor: number; // Dynamic 20 4H EMA structural support
  atrTrailingFloorValue: number; // Peak - (1.8 * ATR)
  dynamicExitFloor: number; // max(4h EMA, ATR floor)
  cycleCompletionPct: number; // 0-100% mathematical mission progress
  cycleStatusSummary: string; // Dynamic live numerical summary
}

export interface AutomatedFeedAuditStats {
  totalSimulatedTrades: number;
  activeCapitalDeployedUSD: number;
  totalBankedCashUSD: number;
  totalNetProfitUSD: number;
  winRatePct: number;
  winCount: number;
  lossCount: number;
  averageHoldDays: number;
  zeroRiskProtectedCount: number;
  avgMfePct: number;
  avgMaePct: number;
  totalFeesPaidUSD: number;
  grossProfitUSD: number;
  profitFactor: number;
  totalInvestedUSD: number;
}

export interface StrategyVerificationReport {
  sampleSize: number;
  targetSampleSize: number;
  sampleProgressPct: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  winLossRatio: number;
  winLossRatioFormatted: string;
  winRatePct: number;
  targetWinRatePct: number;
  winRatePassed: boolean;
  avgWinUSD: number;
  avgLossUSD: number;
  payoffRatio: number;
  targetPayoffRatio: number;
  payoffPassed: boolean;
  grossProfitUSD: number;
  grossLossUSD: number;
  totalFeesUSD: number; // Total Binance 0.10% Spot Maker/Taker fees incurred
  netRealizedPnLUSD: number; // Realized net profit after subtracting all trading fees
  startingCapitalUSD: number; // Standard starting balance (100.00 USDT)
  profitFactor: number;
  targetProfitFactor: number;
  profitFactorPassed: boolean;
  maxDrawdownPct: number;
  targetMaxDrawdownPct: number;
  drawdownPassed: boolean;
  expectancyUSD: number;
  targetExpectancyUSD: number;
  expectancyPassed: boolean;
  zeroRiskRatchetRatePct: number;
  targetZeroRiskRatchetRatePct: number;
  ratchetPassed: boolean;
  readinessStatus: 'VALIDATED_READY' | 'SAMPLE_IN_PROGRESS' | 'DEFENSIVE_REGIME_WARNING';
  readinessScore: number;
  verdictSummary: string;
  recommendation: string;
}

export interface AutomatedTradeRecord {
  id: string;
  category: ActionCategory; // 'investment'
  type: AutomatedActionType;
  coinId: string;
  symbol: string;
  coinName: string;
  coinImage?: string;
  action: 'BUY' | 'SELL';
  direction?: 'LONG' | 'SHORT'; // Direction of trade
  timeframe?: string; // e.g. '1-2 Day Binance Futures'
  status: TradeExecutionStatus;
  
  // Execution Pricing & Timestamps
  entryPrice: number;
  currentPrice: number;
  exitPrice?: number;
  entryDate: string;
  exitDate?: string;
  holdingPeriodDays?: number;
  openedAtTimestamp?: number; // Exact millisecond timestamp when trade was placed
  closedAtTimestamp?: number; // Exact millisecond timestamp when trade was closed
  
  // Offline / Inactive Session High & Low Tracking (Lifetime Peak/Trough since openedAt)
  sessionHighPrice?: number;
  sessionLowPrice?: number;
  lastAuditTimestamp?: number;
  catchUpNote?: string;
  totalFeesUSD?: number; // Total exchange fees (0.10% spot maker/taker on buys, harvests, and exits)

  // Institutional Excursion Metrics (MFE = Max Favorable Excursion, MAE = Max Adverse Excursion)
  mfePct?: number; // Maximum % favorable movement in trade's direction before closing
  maePct?: number; // Maximum % adverse movement against trade's direction
  mfeUSD?: number; // Dollar peak unrealized gain
  maeUSD?: number; // Dollar max drawdown experienced

  exitReason?: string; // Exact trigger or rule that closed the position
  marketRegimeAtEntry?: string; // Market regime state when entry was executed
  btcTrendAtEntry?: string; // BTC trend state at entry time
  executionVenue?: 'BINANCE_SPOT_LIVE' | 'BINANCE_TESTNET' | 'SIMULATED_ENGINE';
  binanceSymbol?: string;

  // Dynamic Numerical Decision & Cycle Health Vector (Replaces static calendar timer)
  numericalCycleMetrics?: NumericalCycleMetrics;

  // Position Sizing & Cash Recycling
  units: number;
  positionSizeUSD: number;
  realizedCashBankedUSD: number;

  // Short-Term Multi-Tier Profit Harvesting (Rule 1)
  harvestTiers?: {
    tier1: HarvestTierInfo;
    tier2: HarvestTierInfo;
    tier3: HarvestTierInfo;
  };

  // Dynamic Breakeven Ratchet (Rule 2)
  ratchet?: BreakevenRatchetInfo;

  // Volatility ATR Trailing Floor (Rule 3)
  atrTrailingFloor?: number;
  atrValue?: number;
  atrPct?: number; // e.g. 3.8%
  bollingerUpper?: number;
  bollingerLower?: number;
  volatilityBand?: string; // e.g. 'HIGH_BETA_EXPANSION'

  // Exit Rules (Protection & Targets)
  takeProfitPrice: number;
  takeProfitPct: number;
  stopLossPrice: number;
  stopLossPct: number;
  trailingStopPrice?: number;

  // Exact Indicator Triggers at Entry
  entrySignals: {
    sentimentScore: number;
    sentimentLabel: string;
    rsi14: number;
    volumeSurgePct: number;
    distanceFromEma200Pct: number;
    timingScore: number;
    triggerSummary: string;
  };

  // Performance
  pnlUSD: number;
  pnlPercentage: number;

  // Educational & Contextual Micro-Lesson
  lessonTitle?: string;
  lessonConcept?: string;
  lessonExplanation?: string;
  keyTakeaway?: string;
  investingPerspective?: string;
  tradingPerspective?: string;

  // Visual Chart Snapshot points
  chartHistory?: {
    date: string;
    price: number;
    sentiment: number;
    volume: number;
    sma50: number;
  }[];
}

export interface DailyEquitySnapshot {
  id: string;
  date: string;
  portfolioValueUSD: number;
  btcBenchmarkValueUSD: number;
  activePositionsCount: number;
  closedTradesCount: number;
  winRatePct: number;
  totalRealizedProfitUSD: number;
  marketSentiment: number;
}

export interface StrategyRuleDefinition {
  id: string;
  name: string;
  category: ActionCategory;
  strategyArchetype: 'Trend-Following' | 'Mean-Reversion' | 'Macro Cycle DCA' | 'Liquidity Exploitation' | 'Fundamental Fee Accrual' | 'Volatility Expansion';
  description: string;
  isActive: boolean;
  timeHorizon: string; // e.g. "2 to 7 days", "1 to 3 years"
  riskProfile: 'Conservative' | 'Moderate' | 'Aggressive / Alpha';
  entryCriteria: {
    minSentiment?: number;
    maxSentiment?: number;
    maxRsi?: number;
    minRsi?: number;
    minVolumeSurgePct?: number;
    trendRequirement: string;
    onChainCondition?: string;
    derivativesCondition?: string;
  };
  exitCriteria: {
    takeProfitPct: number;
    stopLossPct: number;
    closeOnSentimentReversal: boolean;
    maxHoldDays: number;
    trailingStopThresholdPct?: number;
    invalidationTrigger: string;
  };
  allocationPctPerTrade: number;
  historicalWinRate: number;
  profitFactor: number;
  educationalCoreConcept: string;
}
