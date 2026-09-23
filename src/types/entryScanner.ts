import { OrderFlowMetrics } from './orderFlow';

export type EntryStrategyArchetype = 
  | 'EMA_PULLBACK_4H'
  | 'VOLATILITY_SQUEEZE'
  | 'MEAN_REVERSION_DIP'
  | 'BEARISH_RESISTANCE_REJECTION'
  | 'BEARISH_EMA_BREAKDOWN';

export const MAJOR_COINS = new Set(['BTC', 'ETH', 'BNB', 'SOL']);
export const MAX_MAJOR_COIN_SLOTS = 3;
// Meme coins share one cap (MAX_MEME_COIN_SLOTS): they tend to flush together.
// The scanned coins now follow trading volume (config/universe.ts), so new
// memes can appear; add them here or they count as ordinary alts.
export const MEME_COINS = new Set([
  'DOGE', 'PEPE', 'WIF', 'SHIB', 'BONK', 'POPCAT', 'FLOKI', 'MEME', 'BOME', 'NEIRO',
  'TRUMP', 'PENGU', 'MUBARAK', 'PNUT', 'TURBO', 'PEOPLE', 'ACT', 'DOGS', 'NOT', '1000SATS', '1MBABYDOGE', 'BROCCOLI714', 'TST',
]);
export const MAX_MEME_COIN_SLOTS = 2;
export const COIN_REENTRY_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes cooldown

export type ScannerTradingMode = 'FUTURES_1_2D' | 'MACRO_1_2W' | 'SPOT_1_2W';

export interface FuturesContext {
  tradingMode: ScannerTradingMode;
  dailyMa7: number;
  distToDailyMa7Pct: number;
  dailyMa25?: number;
  distToDailyMa25Pct?: number;
  ma7Slope?: 'RISING_SUPPORT' | 'FALLING_CEILING' | 'FLAT';
  overheadResistancePrice: number;
  distToResistancePct?: number;
  /** SWING_LEVEL: a real level from clustered 4h swings (marketAnalysisService). */
  resistanceType: 'SWING_LEVEL' | 'DAILY_MA7' | '4H_21_EMA' | '24H_RANGE_HIGH' | 'NONE';
  suggestedLeverage: string; // e.g. "3x - 5x"
  liquidationBufferPct: number; // e.g. 18.5%
  isCeilingBlocked: boolean; // true if Long is blocked by overhead resistance
  rejectionZoneName?: string; // e.g. "Daily MA(7) Resistance Rejection"
}

export type EntrySignalStatus = 
  | 'TRIGGERED' 
  | 'STAGING_AT_SUPPORT'
  | 'FORMING' 
  | 'WATCHLIST' 
  | 'INHIBITED'
  | 'REJECTED';

export type SetupQualityRating = 'A+' | 'A' | 'B' | 'C' | 'DISQUALIFIED';

export type ExecutionDecision = 'TRADE_TRIGGERED' | 'WAIT_CONFIRMATION' | 'REJECT_HOSTILE_REGIME' | 'WATCHLIST_ONLY';

export interface StrategyCheckpoint {
  id: string;
  name: string;
  requiredRule: string;
  currentValue: string;
  passed: boolean;
  explanation: string;
  weight?: number; // Institutional scoring weight (e.g. 20 pts)
  earnedScore?: number;
  pillarCategory?: 'STRUCTURE' | 'MICRO_1H' | 'WHALE_FLOW' | 'MTA_CONFLUENCE' | 'TRADE_GEOMETRY';
}

export interface PillarScores {
  structure: number;      // max 20 pts
  micro1h: number;        // max 20 pts
  whaleOrderFlow: number; // max 20 pts
  mtaConfluence: number;  // max 20 pts
  tradeGeometry: number;  // max 20 pts
}

/** Why a real-level gate rejected an entry, and the measurements behind it. */
export interface LevelGate {
  passed: boolean;
  reason?: string;
  distToSupportAtr?: number | null;
  distToResistanceAtr?: number | null;
  trend?: string;
  /** False when no candle analysis was available, so the gates could not run. */
  measured: boolean;
}

export interface EntrySignalResult {
  /** Real-level gate: whether price is at a level worth entering (config/entry.ts). */
  levelGate?: LevelGate;
  id: string;
  coinId: string;
  symbol: string;
  coinName: string;
  image?: string;
  currentPrice: number;
  priceChange24hPct: number;
  volume24hUSD: number;
  
  // Trade Direction: LONG or SHORT
  direction: 'LONG' | 'SHORT';
  
  // Strategy Classification
  archetype: EntryStrategyArchetype;
  archetypeName: string;
  archetypeDescription: string;
  score: number; // 0 to 100
  status: EntrySignalStatus;
  setupQuality?: SetupQualityRating;
  executionDecision?: ExecutionDecision;
  disqualificationReason?: string;
  timeframe: string; // e.g. "4-Hour / 1-2W Cycle" or "Binance Futures (1-2D)"
  
  // Trading Mode (Futures 1-2D Swings vs Macro 1-2W Cycles)
  tradingMode?: ScannerTradingMode;
  futuresContext?: FuturesContext;

  // Dual-Score Directional Conviction (Anti-Jitter Diagnostic Engine)
  directionalConviction?: {
    bullishScore: number;
    bearishScore: number;
    bias: 'LONG' | 'SHORT' | 'NEUTRAL';
    primaryDriver: string;
    ma7Slope: 'RISING_SUPPORT' | 'FALLING_CEILING' | 'FLAT';
  };

  // Unified 5-Pillar Score Breakdown (20 pts each = 100 pts total)
  pillarScores?: PillarScores;

  // Micro-Timeframe Execution Confirmation (Anti-Falling-Knife Gate)
  microConfirmation?: {
    isGreenReversal: boolean;
    consecutiveRedCandles: number;
    hourlyChangePct: number;
    statusSummary: string;
  };

  // Multi-Timeframe Confluence (MTA)
  timeframeConfluence?: {
    dailyTrend: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
    fourHourStructure: 'EXPANDING' | 'TESTING_SUPPORT' | 'OVERBOUGHT' | 'BREAKDOWN';
    oneHourImpulse: 'WICK_REJECTION' | 'GREEN_IMPULSE' | 'BEARISH_DRAG' | 'CHOP';
    fifteenMinSqueeze?: 'BREAKOUT' | 'COMPRESSED' | 'EXPANDING' | 'CHOP';
    fiveMinFlow?: 'BUY_DOMINANT' | 'SELL_DOMINANT' | 'NEUTRAL';
    fourHourAligned?: boolean;
    oneHourAligned?: boolean;
    fifteenMinAligned?: boolean;
    fiveMinAligned?: boolean;
    alignedCount?: number; // 0 to 4
    confluenceRating: 'A+' | 'A' | 'B' | 'C' | 'DISQUALIFIED';
  };

  // Price Action & Candlestick Structure
  priceAction?: {
    high24h: number;
    low24h: number;
    rangeSpreadPct: number;
    lowerWickAbsorptionPct: number; // % distance bounced off 24h low
    rangeLocationPct: number; // 0-100% (position within 24h high-low spread)
    hasAbsorptionWick: boolean;
  };

  // Real-Time Order Flow & Taker Buy vs Sell Volume
  orderFlow?: OrderFlowMetrics;

  // Signal Stability & Consistency Engine (Anti-Jitter Rule #1)
  stability?: {
    ageMinutes: number; // How long signal has been sustained
    consistencyScore: number; // 0-100 score of signal stability
    stabilityTier: 'VETERAN_ANCHOR' | 'ESTABLISHED' | 'RECENT_CONFIRMED' | 'JUST_FORMING';
    heldCyclesCount: number; // Number of consecutive scan cycles >= threshold
    firstTriggeredAt: number; // Timestamp ms
    isBattleTested: boolean; // >= 15m without falling below threshold
    label: string; // e.g. "Veteran Anchor (45m)"
  };

  // Live Quantitative Metrics
  indicators: {
    rsi14: number;
    volumeSurgeRatio: number; // e.g. 1.45x (24h vs 20d)
    distanceToEma21Pct: number; // e.g. -1.2%
    distanceToEma200Pct: number; // e.g. +8.4%
    fourHourEma21: number;
    fourHourEma50: number;
    dailyEma200: number;
    bollingerBandwidthPct: number; // e.g. 3.2%
    bollingerUpper: number;
    bollingerLower: number;
    bollingerMiddle: number;
    stagnationDecile: number; // 1-10
    atrValue: number;
    atrPct: number; // e.g. 3.8%
    volatilityClassification: 'LOW_BETA_MEGA_CAP' | 'MODERATE_CYCLE' | 'HIGH_BETA_EXPANSION' | 'EXTREME_VOLATILITY';
    momentumState: 'ACCELERATING' | 'HEALTHY_PULLBACK' | 'CONSOLIDATING' | 'EXHAUSTED';
  };

  // Structured Execution Plan (Pre-calculated for $10 Micro-Tranche)
  tradePlan: {
    suggestedTrancheUSD: number; // e.g. $10.00
    suggestedUnits: number;
    entryPrice: number;
    stopLossPrice: number;
    stopLossPct: number;
    riskAmountUSD: number; // e.g. $0.40 on a $10 position
    tier1Price: number;
    tier1Pct: number;
    tier1RewardUSD: number;
    tier2Price: number;
    tier2Pct: number;
    tier2RewardUSD: number;
    tier3TargetPrice: number;
    tier3Pct: number;
    rewardRiskRatio: number; // e.g. 3.4
    breakevenRatchetPrice: number; // Entry + buffer
    atrMultiplierStop: number; // e.g. 1.25x ATR
    atrMultiplierTier1: number; // e.g. 1.15x ATR
    atrMultiplierTier2: number; // e.g. 2.30x ATR
    volatilityRating: string;
  };

  // Checkpoints Breakdown
  checkpoints: StrategyCheckpoint[];

  // Multi-Factor Trade Quality & Institutional Ranking Engine
  rankOrder?: number; // 1 = #1 Top Pick, 2 = #2 Runner-Up, etc.
  isTopPick?: boolean; // True if #1 best coin to trade right now
  tradeQualityScore?: number; // Composite institutional rank score factoring all tiebreakers
  topPickHighlights?: string[]; // Comparative reasons why this setup beat other candidates

  // Rationale & Context
  aiRationale: string;
  recommendedAction: string;
}

export interface MarketRegimeGate {
  regime: 'RISK_ON_BULLISH' | 'NEUTRAL_CONSOLIDATION' | 'RISK_OFF_DOWNTREND' | 'EXTREME_SELLOFF_DUMP';
  allowsAltcoinEntries: boolean;
  allowsAltcoinShorts?: boolean;
  regimeDirectionBias?: 'LONGS_FAVORED' | 'SHORTS_FAVORED' | 'SELECTIVE_EITHER' | 'CASH_PREFERRED';
  blockReason?: string;
  btcPrice: number;
  btcChange24h: number;
  btcChange7d: number;
  btcRsi14: number;
  btcDistToEma21Pct: number;
  btcDistToEma200Pct: number;
  btcTrendState: 'STRONG_BULL' | 'CONSOLIDATING' | 'HEALTHY_PULLBACK' | 'BREAKDOWN_DUMP';
  macroGateScore: number; // 0-100 (100 = prime bull regime, < 45 = alt long gate closed)
}

export interface ScannerSummaryStats {
  totalScanned: number;
  triggeredCount: number;
  formingCount: number;
  veteranAnchorsCount: number; // Count of battle-tested >=15m signals
  averageScore: number;
  topPickSymbol: string;
  topPickSignal?: EntrySignalResult;
  marketRegime: 'BULLISH_TREND_EXPANSION' | 'CONSOLIDATION_SQUEEZE' | 'RISK_OFF_DIP';
  macroGate?: MarketRegimeGate;
}
