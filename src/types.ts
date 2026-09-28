export interface CryptoCoin {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  fully_diluted_valuation: number | null;
  total_volume: number;
  high_24h: number;
  low_24h: number;
  price_change_24h: number;
  price_change_percentage_24h: number;
  price_change_percentage_7d_in_currency?: number;
  price_change_percentage_30d_in_currency?: number;
  circulating_supply: number;
  total_supply: number | null;
  max_supply: number | null;
  ath: number;
  ath_change_percentage: number;
  ath_date: string;
  atl: number;
  category: string;
  consensus?: string;
  launch_year?: number;
  description?: string;
  whitepaper_summary?: string;
  use_cases?: string[];
  key_risks?: string[];
  tokenomics_summary?: string;
  risk_profile?: 'Conservative' | 'Moderate' | 'High Volatility';
  primary_use_case?: string;
  technical_summary?: string;
  risks?: string[];
  price_change_percentage_7d?: number;
  /** Real candle-derived analysis, when it could be fetched (marketAnalysisService). */
  analysis?: import('./services/marketAnalysisService').CoinAnalysis;
  /** Binance Futures 8-hour funding rate in percent (e.g. 0.01 = 0.01% / 8h). */
  funding_rate?: number;
  funding_time?: number;
  micro?: {
    currentHourGreen: boolean;
    hourlyChangePct: number;
    consecutiveRedHours: number;
    threeHourChangePct: number;
  };
}

export interface AIAnalysisResult {
  summary: string;
  investorThesis?: string;
  traderThesis?: string;
  riskScore?: number;
  timestamp: string;
}

export interface PricePoint {
  timestamp: number;
  date: string;
  price: number;
  volume: number;
  sma20?: number;
  sma50?: number;
  rsi?: number;
}

export interface WatchlistNote {
  coinId: string;
  tag: 'Long-term Invest' | 'Swing Trade' | 'Learn Tokenomics' | 'High Risk Speculation' | 'DeFi Yield';
  notes: string;
  entryTarget?: number;
  exitTarget?: number;
  stopLoss?: number;
  updatedAt: string;
}

export interface PaperTrade {
  id: string;
  coinId: string;
  coinSymbol: string;
  coinName: string;
  type: 'BUY' | 'SELL';
  strategy: 'Investment (DCA/HODL)' | 'Trade (Technical)' | 'Weekly DCA' | 'Macro Cycle Hold' | 'Infrastructure Fundamental' | string;
  amount: number;
  entryPrice: number;
  currentPrice: number;
  timestamp: string;
  notes?: string;
}

export interface LearningLesson {
  id: string;
  category: 'Fundamentals' | 'Trading & TA' | 'Risk & Security' | 'Tokenomics';
  title: string;
  summary: string;
  readTime: string;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  content: {
    heading: string;
    body: string;
    keyTakeaways: string[];
    investingTakeaway: string;
    tradingTakeaway: string;
  }[];
  quiz: {
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
  };
}

export interface VolumeProfile {
  poc: number; // Point of Control (Highest volume price)
  hvnHigh: number; // High Volume Node upper attraction band
  hvnLow: number; // High Volume Node lower attraction band
  hvnUpper?: number;
  hvnLower?: number;
  lvnGap1: number; // Low Volume Node / Slippage gap
  lvnGap2: number;
  lvnFloor?: number;
  avwapCycle: number; // Anchored VWAP to macro cycle low / halving
  avwapBreakout: number; // Anchored VWAP to local breakout
  anchoredVwapBreakout?: number;
  anchoredVwapStatus?: string;
}

export interface OrthogonalFactors {
  derivativesPositioning: {
    score: number; // 0-100
    weight: number; // 0.30
    fundingRateZScore: number; // -3.0 to +3.0
    openInterestDelta24hPct: number;
    leverageRegime: 'Deep Short Squeeze Potential' | 'Healthy Neutral Leverage' | 'Long Overcrowding Warning' | 'Extreme Liquidation Cascade Risk';
  };
  onChainValuation: {
    score: number; // 0-100
    weight: number; // 0.25
    mvrvZScore: number; // 0.5 to 4.5+
    realizedPrice: number;
    valuationRegime: 'Deep Value (Accumulation)' | 'Fair Market Cost Basis' | 'Stretched / Distribution Zone';
  };
  macroLiquidity: {
    score: number; // 0-100
    weight: number; // 0.20
    stablecoinSupplyVelocity30d: number; // net mint/burn %
    btcDominanceTrend: 'Altseason Liquidity Injection' | 'BTC Consolidation' | 'BTC Liquidity Absorption';
    macroRegime: 'Expansive Capital Inflow' | 'Neutral Liquidity' | 'Tightening Capital Drain';
  };
  priceTechnicalsBreadth: {
    score: number; // 0-100
    weight: number; // 0.25
    adx14: number; // Trend strength
    regimeMode: 'Trend-Following (Momentum Expansion)' | 'Mean-Reversion (Range Chop)' | 'Volatility Squeeze';
    sectorAdvanceDeclineRatio: number;
    volumeProfilePocProximityPct: number; // % distance from POC
  };
}

export interface OrderBookLiquidity {
  bidDepth2PctUSD: number;
  askDepth2PctUSD: number;
  estimatedSlippagePct: number;
  slippageWarning: boolean;
  marketImpactTier: 'Ultra Deep (Institutional)' | 'Deep Liquid' | 'Moderate (Watch Slippage)' | 'Thin (High Impact Risk)';
  executionAdvice?: string;
}

export interface VolatilityAdaptiveTranches {
  atr14d: number;
  atr14dPct: number;
  dailySigmaPct: number;
  tranche1: {
    label: string;
    percent: number;
    targetPrice: number;
    allocationUSD: number;
    rationale: string;
    description?: string;
    units?: number;
  };
  tranche2: {
    label: string;
    percent: number;
    targetPrice: number; // Entry - 1.5 * ATR
    allocationUSD: number;
    atrMultiple: number;
    distancePct: number;
    rationale: string;
    description?: string;
    units?: number;
  };
  tranche3: {
    label: string;
    percent: number;
    targetPrice: number; // Entry - 3.0 * ATR or nearest LVN/Major Support
    allocationUSD: number;
    atrMultiple: number;
    distancePct: number;
    rationale: string;
    description?: string;
    units?: number;
  };
}

export interface HistoricalSignalAudit {
  timingBucket: 'Prime Accumulation (Score >= 75)' | 'Fair Range (50-74)' | 'Overextended / Dip (Score < 50)';
  sampleSizeSignals: number;
  forward7dMeanReturn: number;
  forward30dMeanReturn: number;
  forward90dMeanReturn: number;
  winRatePct: number;
  profitFactor: number;
  maxAdverseExcursionMeanPct: number; // Average max drawdown before profit target
  confidenceLevel: 'High (95% CI)' | 'Robust (90% CI)' | 'Moderate';
}

export interface PortfolioRiskAssessment {
  selectedCoinIds: string[];
  totalBudgetUSD: number;
  averagePairwiseCorrelation: number; // e.g. 0.88
  diversificationIndex: number; // 0-100 (higher = better orthogonal spread)
  concentrationRisk: 'Low (Well Diversified)' | 'Moderate (Cluster Warning)' | 'Extreme (High Co-Movement Bet)';
  correlationWarnings: { pair: string; correlation: number; recommendation: string }[];
  riskParityAllocations: {
    coinId: string;
    symbol: string;
    name: string;
    category: string;
    dailySigmaPct: number;
    baseWeightPct: number;
    correlationDiscountPct: number;
    finalWeightPct: number;
    allocatedUSD: number;
  }[];
}

export interface WebhookAlertConfig {
  id: string;
  coinId: string;
  symbol: string;
  type: 'TRANCHE_2_HIT' | 'TRANCHE_3_HIT' | 'FUNDING_SQUEEZE' | 'POC_BREAKOUT' | 'SLIPPAGE_ALERT';
  targetPrice: number;
  webhookUrl?: string;
  channel: 'In-App' | 'Telegram' | 'Discord' | 'Custom Webhook';
  triggered: boolean;
  timestamp: string;
}

export interface BulkTimingSignal {
  coinId: string;
  symbol: string;
  name: string;
  category: string;
  currentPrice: number;
  marketCap: number;
  timingScore: number; // 0 to 100 (Orthogonally weighted)
  verdict: 'Prime DCA Accumulation' | 'Momentum Breakout' | 'Fair Range / Hold' | 'Overextended / Wait for Dip' | 'Downtrend / High Risk';
  perspective: 'investing' | 'trading';
  estimatedFairValue: number;
  fairValueDiscountPercent: number; // negative = undervalued (cheap), positive = overvalued (expensive)
  fairEntryRange: { min: number; max: number };
  fairExitRange: { min: number; max: number };
  invalidationPrice: number;
  riskRewardRatio: number;
  rsi14: number;
  trend200d: 'Above 200d SMA (Strong)' | 'Near 200d SMA (Rebound Zone)' | 'Below 200d SMA (Oversold/Discount)';
  volatilityRank: 'Low' | 'Medium' | 'High' | 'Extreme';
  orthogonalFactors: OrthogonalFactors;
  volumeProfile: VolumeProfile;
  orderBookLiquidity: OrderBookLiquidity;
  volatilityTranches: VolatilityAdaptiveTranches;
  historicalAudit: HistoricalSignalAudit;
  recommendedTranches: {
    tranche1: { label: string; percent: number; targetPrice: number; description: string };
    tranche2: { label: string; percent: number; targetPrice: number; description: string };
    tranche3: { label: string; percent: number; targetPrice: number; description: string };
  };
  suggestedAllocationUSD?: number;
  keyReasoning: string;
}

export interface BulkMarketOverviewStats {
  overallTimingScore: number; // 0-100
  marketRegime: 'Deep Accumulation (Prime Buying)' | 'Healthy Bull Momentum' | 'Selective Distribution' | 'Overheated Euphoria' | 'Capitulation Panic';
  isGoodTimeToInvest: boolean;
  isGoodTimeToTrade: boolean;
  investingVerdictText: string;
  tradingVerdictText: string;
  fairValueMarketAvgDiscount: number;
  coinsInPrimeBuyZone: number;
  coinsInMomentumBreakout: number;
  coinsOverheated: number;
  orthogonalFactors: OrthogonalFactors;
  sectorBreakdown: {
    sector: string;
    coinsCount: number;
    avgChange24h: number;
    avgChange7d: number;
    avgRsi: number;
    timingScore: number;
    status: 'Accumulate' | 'Momentum' | 'Neutral' | 'Overheated';
  }[];
}

export interface MarketSentiment {
  fearGreedIndex: number;
  sentimentLabel: 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';
  btcDominance: number;
  totalMarketCap: number;
  total24hVolume: number;
}
