export interface WhaleOrderFlowMetrics {
  whaleVolumeUSD: number; // Volume from institutional orders > $100k
  whaleBuyVolumeUSD: number;
  whaleSellVolumeUSD: number;
  whaleNetDeltaUSD: number;
  whaleBuyRatioPct: number; // e.g. 68.4%
  whaleSellRatioPct: number;
  whaleImbalanceRatio: number;
  whaleState: 'AGGRESSIVE_ACCUMULATION' | 'STEADY_ACCUMULATION' | 'NEUTRAL' | 'STEADY_DISTRIBUTION' | 'HEAVY_DUMP';
  whaleShareOfTotalVolumePct: number; // e.g. 68.0%
}

export interface RetailOrderFlowMetrics {
  retailVolumeUSD: number; // Volume from smaller retail orders < $10k
  retailBuyVolumeUSD: number;
  retailSellVolumeUSD: number;
  retailNetDeltaUSD: number;
  retailBuyRatioPct: number; // e.g. 42.1%
  retailSellRatioPct: number;
  retailImbalanceRatio: number;
  retailSentiment: 'FOMO_BUYING' | 'STEADY_BUYING' | 'NEUTRAL' | 'FEAR_SELLING' | 'PANIC_DUMP';
  retailShareOfTotalVolumePct: number; // e.g. 22.0%
}

export interface SmartMoneyDivergence {
  divergenceType: 'BULLISH_INSTITUTIONAL_ABSORPTION' | 'BEARISH_INSTITUTIONAL_DISTRIBUTION' | 'CONVERGENT_BULLISH' | 'CONVERGENT_BEARISH' | 'BALANCED';
  divergenceSpreadPct: number; // Whale Buy % minus Retail Buy % (Positive = Whales more bullish than retail)
  summaryBadge: string; // e.g. "Whales +$2.1B (68%) vs Retail (45%)"
  rationale: string;
  convictionRating: 'HIGH_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'HIGH_BEARISH';
}

export interface OrderFlowMetrics {
  totalVolume24hUSD: number;
  buyVolumeUSD: number;
  sellVolumeUSD: number;
  netDeltaUSD: number; // Positive = Net Dollar Inflow, Negative = Net Dollar Outflow
  buyRatioPct: number; // e.g. 56.4%
  sellRatioPct: number; // e.g. 43.6%
  takerImbalanceRatio: number; // e.g. 1.29 (Buy/Sell)
  orderFlowState: 'HEAVY_ACCUMULATION' | 'NET_INFLOW' | 'BALANCED_CHOP' | 'NET_OUTFLOW' | 'HEAVY_DISTRIBUTION';
  cvdTrend: 'RISING' | 'FALLING' | 'NEUTRAL';
  largeBlockAbsorption: boolean; // True when price retraced but taker buy ratio >= 50% (smart bids absorbing sells)
  exhaustionDivergence?: 'BULLISH_ABSORPTION' | 'BEARISH_EXHAUSTION' | 'NONE';

  // Money-First & Institutional Range Placement Metrics:
  rangeLocationPct: number; // 0 to 100% of 24h spread (where price sits between low and high)
  isCeilingExhaustionTrap: boolean; // True if price in top 10% of 24h range despite heavy buy $ volume (Trapped Buyers)
  isFloorAccumulation: boolean; // True if price in bottom 30% of range with active dollar absorption
  capitalVelocityPerHourUSD: number; // Estimated hourly net capital inflow/outflow in USD

  // Institutional Whale vs. Retail Order Size Segmentation:
  whale?: WhaleOrderFlowMetrics;
  retail?: RetailOrderFlowMetrics;
  smartMoneyDivergence?: SmartMoneyDivergence;
}

export interface InflowOutflowCoin {
  coinId: string;
  symbol: string;
  name: string;
  image?: string;
  price: number;
  priceChange24h: number;
  totalVolumeUSD: number;
  buyVolumeUSD: number;
  sellVolumeUSD: number;
  netDeltaUSD: number;
  buyRatioPct: number;
  orderFlowState: 'HEAVY_ACCUMULATION' | 'NET_INFLOW' | 'BALANCED_CHOP' | 'NET_OUTFLOW' | 'HEAVY_DISTRIBUTION';
  largeBlockAbsorption: boolean;
  rangeLocationPct: number;
  isCeilingExhaustionTrap: boolean;
  capitalVelocityPerHourUSD: number;
}

export interface GlobalMarketOrderFlow {
  totalMarketVolumeUSD: number;
  totalBuyVolumeUSD: number;
  totalSellVolumeUSD: number;
  globalNetDeltaUSD: number;
  globalBuyRatioPct: number;
  globalSellRatioPct: number;
  dominantState: 'AGGRESSIVE_BUYING' | 'MODERATE_INFLOW' | 'BALANCED_EQUILIBRIUM' | 'MODERATE_OUTFLOW' | 'PANIC_DUMP';
  takerBuySellRatio: number;
  topInflowCoins: InflowOutflowCoin[];
  topOutflowCoins: InflowOutflowCoin[];
  absorptionCoins: InflowOutflowCoin[];
  calculatedAtTimestamp: number;
}
