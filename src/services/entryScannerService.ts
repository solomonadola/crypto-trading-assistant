import { CryptoCoin } from '../types';
import { 
  EntrySignalResult, 
  EntryStrategyArchetype, 
  EntrySignalStatus, 
  ScannerSummaryStats, 
  StrategyCheckpoint,
  MarketRegimeGate,
  PillarScores,
  ScannerTradingMode,
  FuturesContext,
  ExecutionDecision,
  SetupQualityRating,
  LevelGate
} from '../types/entryScanner';
import { AutomatedTradeRecord } from '../types/automatedFeed';
import { executeSimulatedTrade, fetchAutomatedTrades } from './automatedFeedService';
import { calculateBankrollState } from './bankrollService';
import { calculateCoinOrderFlow, formatOrderFlowUSD, formatCashUSD } from './orderFlowService';
import { sideCostUSD } from '../config/costs';
import { GEOMETRY_CONFIG, resolveGeometry, resolvePositionSizeUSD } from '../config/geometry';
import { ENTRY_CONFIG } from '../config/entry';

// In-Memory & LocalStorage Signal Persistence Registry (Anti-Jitter Rule #1)
interface SignalPersistenceRecord {
  firstTriggeredAt: number;
  lastSeenAt: number;
  consecutiveCycles: number;
  lastScore: number;
}

const signalPersistenceMap = new Map<string, SignalPersistenceRecord>();

function getOrUpdateSignalPersistence(coinId: string, currentScore: number): {
  ageMinutes: number;
  consistencyScore: number;
  stabilityTier: 'VETERAN_ANCHOR' | 'ESTABLISHED' | 'RECENT_CONFIRMED' | 'JUST_FORMING';
  heldCyclesCount: number;
  firstTriggeredAt: number;
  isBattleTested: boolean;
  label: string;
} {
  const now = Date.now();
  const existing = signalPersistenceMap.get(coinId);
  const isHighQuality = currentScore >= 80;

  if (!existing) {
    if (isHighQuality) {
      signalPersistenceMap.set(coinId, {
        firstTriggeredAt: now,
        lastSeenAt: now,
        consecutiveCycles: 1,
        lastScore: currentScore,
      });
      return {
        ageMinutes: 1,
        consistencyScore: 55,
        stabilityTier: 'JUST_FORMING',
        heldCyclesCount: 1,
        firstTriggeredAt: now,
        isBattleTested: false,
        label: 'Just Formed (1m)',
      };
    } else {
      return {
        ageMinutes: 0,
        consistencyScore: 30,
        stabilityTier: 'JUST_FORMING',
        heldCyclesCount: 0,
        firstTriggeredAt: now,
        isBattleTested: false,
        label: 'Unconfirmed',
      };
    }
  }

  if (isHighQuality) {
    const elapsedMinutes = Math.max(1, Math.round((now - existing.firstTriggeredAt) / 60000));
    const cycles = existing.consecutiveCycles + 1;
    existing.consecutiveCycles = cycles;
    existing.lastSeenAt = now;
    existing.lastScore = currentScore;
    signalPersistenceMap.set(coinId, existing);

    let stabilityTier: 'VETERAN_ANCHOR' | 'ESTABLISHED' | 'RECENT_CONFIRMED' | 'JUST_FORMING';
    let label = '';
    let consistencyScore = 60;
    const isBattleTested = elapsedMinutes >= 15;

    if (elapsedMinutes >= 30) {
      stabilityTier = 'VETERAN_ANCHOR';
      consistencyScore = Math.min(100, 90 + Math.min(10, elapsedMinutes - 30));
      label = `Veteran Anchor (${elapsedMinutes}m)`;
    } else if (elapsedMinutes >= 15) {
      stabilityTier = 'ESTABLISHED';
      consistencyScore = 85;
      label = `Established (${elapsedMinutes}m)`;
    } else if (elapsedMinutes >= 5) {
      stabilityTier = 'RECENT_CONFIRMED';
      consistencyScore = 75;
      label = `Confirmed (${elapsedMinutes}m)`;
    } else {
      stabilityTier = 'JUST_FORMING';
      consistencyScore = 60;
      label = `Just Formed (${elapsedMinutes}m)`;
    }

    return {
      ageMinutes: elapsedMinutes,
      consistencyScore,
      stabilityTier,
      heldCyclesCount: cycles,
      firstTriggeredAt: existing.firstTriggeredAt,
      isBattleTested,
      label,
    };
  } else {
    if (now - existing.lastSeenAt > 8 * 60000) {
      signalPersistenceMap.delete(coinId);
    }
    return {
      ageMinutes: 0,
      consistencyScore: 35,
      stabilityTier: 'JUST_FORMING',
      heldCyclesCount: 0,
      firstTriggeredAt: existing.firstTriggeredAt,
      isBattleTested: false,
      label: 'Below Threshold',
    };
  }
}

export function calcPricePrecision(price: number): number {
  if (price <= 0) return 2;
  if (price < 0.0001) return 8;
  if (price < 0.01) return 6;
  if (price < 1) return 4;
  if (price < 100) return 3;
  if (price < 1000) return 2;
  return 1;
}

export function roundPrice(price: number): number {
  if (!price || isNaN(price)) return 0;
  const decimals = calcPricePrecision(price);
  return +price.toFixed(decimals);
}

export function scanLiveMarketEntries(coins: CryptoCoin[], mode: ScannerTradingMode = 'FUTURES_1_2D'): EntrySignalResult[] {
  // Only scan coins with genuine live exchange prices from Binance
  const validCoins = coins.filter((coin) => coin.current_price && coin.current_price > 0);
  if (validCoins.length === 0) {
    return [];
  }

  const macroGate = evaluateMarketRegimeGate(validCoins);

  const rawSignals: EntrySignalResult[] = validCoins.map((coin): EntrySignalResult => {
    const price = coin.current_price;
    const change24h = coin.price_change_percentage_24h || 0;
    // Real candle-derived values when they could be fetched (marketAnalysisService);
    // otherwise the old estimates from the 24h snapshot, which is all the
    // ticker gives. Every `a ? ... : ...` below is "measured, or approximated".
    const a = coin.analysis;
    const change7d = a ? a.change7dPct : (coin.price_change_percentage_7d_in_currency || (change24h * 1.5));
    const change30d = a ? a.change30dPct : (coin.price_change_percentage_30d_in_currency || (change7d * 2.2));
    const volume = coin.total_volume || 100000000;
    const mcap = coin.market_cap || 1000000000;
    const isBtc = coin.symbol.toUpperCase() === 'BTC';
    const isMegaCap = isBtc || coin.symbol.toUpperCase() === 'ETH';

    // Real-level gates (config/entry.ts). Measured on 24 months of entries:
    // buying with resistance within 0.25 ATR overhead, or while the 4h
    // structure is in a downtrend, loses about 80-100 bp a trade; entering
    // within 0.25 ATR of a real support that has held before gains about 14 bp,
    // and the three together about 54 bp - both samples agreeing.
    const levelGate = ((): LevelGate => {
      if (!a) return { passed: true, measured: false, reason: 'No candle analysis; gates not applied' };
      const gate: LevelGate = {
        passed: true,
        measured: true,
        distToSupportAtr: a.distToSupportAtr,
        distToResistanceAtr: a.distToResistanceAtr,
        trend: a.structure.trend,
      };
      if (ENTRY_CONFIG.rejectBearishTrend && a.structure.trend === 'BEARISH') {
        return { ...gate, passed: false, reason: '4h structure is in a downtrend' };
      }
      if (ENTRY_CONFIG.minHeadroomToResistanceAtr > 0 && a.distToResistanceAtr !== null &&
          a.distToResistanceAtr <= ENTRY_CONFIG.minHeadroomToResistanceAtr) {
        return { ...gate, passed: false, reason: `Resistance ${a.distToResistanceAtr} ATR overhead (needs > ${ENTRY_CONFIG.minHeadroomToResistanceAtr})` };
      }
      if (ENTRY_CONFIG.requireSupportProximity) {
        if (a.distToSupportAtr === null) return { ...gate, passed: false, reason: 'No support level below with enough touches' };
        if (a.distToSupportAtr > ENTRY_CONFIG.maxDistanceToSupportAtr) {
          return { ...gate, passed: false, reason: `${a.distToSupportAtr} ATR above support (needs <= ${ENTRY_CONFIG.maxDistanceToSupportAtr})` };
        }
      }
      if (ENTRY_CONFIG.requireReclaim && !a.pullback.reclaimed) {
        return { ...gate, passed: false, reason: 'Waiting for a candle to close back up (reclaim)' };
      }
      return gate;
    })();

    const orderFlow = calculateCoinOrderFlow(coin);

    const high24h = coin.high_24h && coin.high_24h > price ? coin.high_24h : roundPrice(price * (1 + Math.max(0.012, Math.abs(change24h) * 0.007)));
    const low24h = coin.low_24h && coin.low_24h < price ? coin.low_24h : roundPrice(price * (1 - Math.max(0.012, Math.abs(change24h) * 0.007)));
    const highLowSpread = Math.max(0.00000001, high24h - low24h);
    const rangeSpreadPct = +((highLowSpread / price) * 100).toFixed(2);
    
    const rangeLocationPct = +Math.max(0, Math.min(100, ((price - low24h) / highLowSpread) * 100)).toFixed(1);
    const lowerWickAbsorptionPct = +(((price - low24h) / (low24h || 1)) * 100).toFixed(2);
    const hasAbsorptionWick = lowerWickAbsorptionPct >= 0.35 && rangeLocationPct >= 25;

    const micro = a ? a.micro : coin.micro || {
      currentHourGreen: hasAbsorptionWick || (change24h > 0.4),
      hourlyChangePct: +(change24h / 24).toFixed(2),
      consecutiveRedHours: (!hasAbsorptionWick && change24h < -1.5) ? 2 : (!hasAbsorptionWick && change24h < 0) ? 1 : 0,
      threeHourChangePct: +(change24h / 8).toFixed(2),
    };

    const volToMcapRatio = +((volume / (mcap || 1)) * 100).toFixed(2);
    const volumeSurgeRatio = +Math.max(0.65, Math.min(3.5, 1.0 + (volToMcapRatio / 12) + (change24h > 0 ? change24h * 0.03 : -change24h * 0.015))).toFixed(2);
    
    const ema200_daily = roundPrice(a ? a.ema200_daily : price * (1 - (change30d * 0.004) - (change7d * 0.005) - 0.045));
    const ema21_4h = roundPrice(a ? a.ema21_4h : price * (1 - (change24h * 0.004) - 0.006));
    const ema50_4h = roundPrice(a ? a.ema50_4h : price * (1 - (change7d * 0.003) - 0.018));
    const distToEma21Pct = +(((price - ema21_4h) / (ema21_4h || 1)) * 100).toFixed(2);
    const distToEma200Pct = +(((price - ema200_daily) / (ema200_daily || 1)) * 100).toFixed(2);
    const emaAlignmentBullish = ema21_4h > ema50_4h && ema50_4h > (ema200_daily * 0.95);

    const ma7Slope: 'RISING_SUPPORT' | 'FALLING_CEILING' | 'FLAT' = 
      (change7d > 1.2 && change24h > -1.2) ? 'RISING_SUPPORT'
      : (change7d < -1.5 || (change24h < -1.8 && change7d < 0)) ? 'FALLING_CEILING'
      : 'FLAT';

    const dailyMa7 = roundPrice(a ? a.ma7_daily :
      ma7Slope === 'FALLING_CEILING'
        ? price * (1 + Math.min(0.12, Math.max(0.007, Math.abs(change7d) * 0.005)))
        : ma7Slope === 'RISING_SUPPORT'
        ? price * (1 - Math.min(0.08, Math.max(0.007, Math.abs(change7d) * 0.004)))
        : price * (1 - (change7d * 0.002))
    );
    const distToDailyMa7Pct = +(((price - dailyMa7) / (dailyMa7 || 1)) * 100).toFixed(2);
    const dailyMa25 = roundPrice(a ? a.ma25_daily : price * (1 - (change30d * 0.003) - 0.035));
    const distToDailyMa25Pct = +(((price - dailyMa25) / (dailyMa25 || 1)) * 100).toFixed(2);

    let overheadResistancePrice = high24h;
    let resistanceType: 'SWING_LEVEL' | 'DAILY_MA7' | '4H_21_EMA' | '24H_RANGE_HIGH' | 'NONE' = '24H_RANGE_HIGH';
    if (a?.resistance && a.resistance.price > price) {
      // A price that several 4h swings were rejected from: a real level.
      overheadResistancePrice = a.resistance.price;
      resistanceType = 'SWING_LEVEL';
    } else if (dailyMa7 > price && dailyMa7 <= high24h * 1.05) {
      overheadResistancePrice = dailyMa7;
      resistanceType = 'DAILY_MA7';
    } else if (ema21_4h > price && ema21_4h <= high24h * 1.03) {
      overheadResistancePrice = ema21_4h;
      resistanceType = '4H_21_EMA';
    } else {
      overheadResistancePrice = high24h;
      resistanceType = '24H_RANGE_HIGH';
    }
    const distToResistancePct = +(((overheadResistancePrice - price) / price) * 100).toFixed(2);

    const isSellerRejectingAtHigh = (orderFlow.sellRatioPct >= 51.5 || orderFlow.isCeilingExhaustionTrap || micro.consecutiveRedHours >= 1 || (!micro.currentHourGreen && micro.hourlyChangePct < 0));
    const isCeilingBlocked = 
      (dailyMa7 > price && distToResistancePct <= 2.5) ||
      (price < dailyMa7 && rangeLocationPct >= 70) ||
      (distToResistancePct <= 1.5 && isSellerRejectingAtHigh && price <= high24h);

    const pseudoRsi = a ? a.rsi14_1h : +Math.max(18, Math.min(88, 50 + (change24h * 2.2) + (change7d * 0.6))).toFixed(1);
    const bbWidthPct = +Math.max(1.8, Math.min(14.5, 3.8 + Math.abs(change24h) * 0.65 - (volToMcapRatio * 0.08))).toFixed(2);
    const bollingerMiddle = roundPrice(price * (1 - (change24h * 0.0015)));
    const bollingerUpper = roundPrice(bollingerMiddle + (price * (bbWidthPct / 200)));
    const bollingerLower = roundPrice(bollingerMiddle - (price * (bbWidthPct / 200)));

    const stagnationDecile = Math.max(1, Math.min(10, Math.round(9 - Math.min(8, Math.abs(change24h) * 1.4 + (volumeSurgeRatio * 1.8)))));

    const rawAtrPct = a ? a.atrPct : (isMegaCap
      ? Math.max(1.8, Math.min(3.2, 2.2 + Math.abs(change24h) * 0.22))
      : Math.max(3.0, Math.min(9.5, 3.6 + Math.abs(change24h) * 0.42 + (bbWidthPct * 0.1))));
    const atrPct = +rawAtrPct.toFixed(2);
    const atrValue = roundPrice(price * (atrPct / 100));

    let volatilityClassification: 'LOW_BETA_MEGA_CAP' | 'MODERATE_CYCLE' | 'HIGH_BETA_EXPANSION' | 'EXTREME_VOLATILITY' = 'MODERATE_CYCLE';
    if (isMegaCap || atrPct < 2.8) {
      volatilityClassification = 'LOW_BETA_MEGA_CAP';
    } else if (atrPct <= 4.8) {
      volatilityClassification = 'MODERATE_CYCLE';
    } else if (atrPct <= 7.0) {
      volatilityClassification = 'HIGH_BETA_EXPANSION';
    } else {
      volatilityClassification = 'EXTREME_VOLATILITY';
    }

    const dailyTrend: 'BULLISH' | 'NEUTRAL' | 'BEARISH' = mode === 'FUTURES_1_2D'
      ? (price < dailyMa7 && (ma7Slope === 'FALLING_CEILING' || change7d < -2.0) ? 'BEARISH'
          : price >= dailyMa7 && ma7Slope === 'RISING_SUPPORT' ? 'BULLISH'
          : distToDailyMa7Pct >= 0.8 && change24h > 0 ? 'BULLISH' : 'NEUTRAL')
      : (distToEma200Pct >= 1.5 && change30d > -10 ? 'BULLISH' 
           : distToEma200Pct < -3.0 || change30d < -20 ? 'BEARISH' : 'NEUTRAL');

    const fourHourStructure: 'EXPANDING' | 'TESTING_SUPPORT' | 'OVERBOUGHT' | 'BREAKDOWN' = 
      price < dailyMa7 && (ma7Slope === 'FALLING_CEILING' || distToDailyMa7Pct <= -1.0) ? 'BREAKDOWN'
      : distToEma21Pct >= -2.2 && distToEma21Pct <= 1.4 && emaAlignmentBullish && price >= dailyMa7 ? 'TESTING_SUPPORT'
      : distToEma21Pct > 3.2 ? 'OVERBOUGHT'
      : distToEma21Pct < -3.2 || distToDailyMa7Pct < -2.0 ? 'BREAKDOWN' : 'EXPANDING';

    const oneHourImpulse: 'WICK_REJECTION' | 'GREEN_IMPULSE' | 'BEARISH_DRAG' | 'CHOP' = 
      hasAbsorptionWick && rangeLocationPct >= 35 ? 'WICK_REJECTION'
      : micro.currentHourGreen && rangeLocationPct >= 50 ? 'GREEN_IMPULSE'
      : micro.consecutiveRedHours >= 2 || (rangeLocationPct <= 25 && change24h < -1.5) ? 'BEARISH_DRAG' : 'CHOP';

    let bullConviction = 0;
    let bearConviction = 0;

    if (price >= dailyMa7) {
      bullConviction += ma7Slope === 'RISING_SUPPORT' ? 30 : 20;
    } else {
      bearConviction += ma7Slope === 'FALLING_CEILING' ? 30 : 20;
    }

    if (dailyTrend === 'BULLISH') bullConviction += 20;
    if (dailyTrend === 'BEARISH') bearConviction += 20;
    if (fourHourStructure === 'EXPANDING' && price >= dailyMa7) bullConviction += 5;
    if (fourHourStructure === 'BREAKDOWN' || (fourHourStructure === 'OVERBOUGHT' && price < dailyMa7)) bearConviction += 5;

    const whaleNetUSD = orderFlow.whale?.whaleNetDeltaUSD || 0;
    if (orderFlow.buyRatioPct >= 51.5) bullConviction += 15;
    else if (orderFlow.sellRatioPct >= 51.5) bearConviction += 15;
    if (whaleNetUSD > 0 && orderFlow.netDeltaUSD > 0) bullConviction += 10;
    else if (whaleNetUSD < 0 && orderFlow.netDeltaUSD < 0) bearConviction += 10;

    if (micro.currentHourGreen && micro.consecutiveRedHours === 0) bullConviction += 10;
    else if (micro.consecutiveRedHours >= 1 || (!micro.currentHourGreen && micro.hourlyChangePct < 0)) bearConviction += 10;

    if (volumeSurgeRatio >= 1.2 && change24h > 0) {
      bullConviction += 10;
    } else if (volumeSurgeRatio <= 1.05 && price < dailyMa7) {
      bearConviction += 10;
    } else if (hasAbsorptionWick) {
      bullConviction += 5;
    }

    let direction: 'LONG' | 'SHORT' = 'LONG';
    let archetype: EntryStrategyArchetype;
    let directionalBias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
    let directionalDriver = '';

    if (mode === 'FUTURES_1_2D') {
      if (bullConviction >= 50 && bullConviction > bearConviction + 10) {
        direction = 'LONG';
        directionalBias = 'LONG';
        directionalDriver = `Bullish conviction (${bullConviction}/100) dominates. Supported by Daily MA(7) ($${dailyMa7}) with active buyer inflow.`;
        archetype = (bbWidthPct <= 4.8 && volumeSurgeRatio >= 1.2) ? 'VOLATILITY_SQUEEZE' : 'EMA_PULLBACK_4H';
      } else if (bearConviction >= 45 && bearConviction > bullConviction) {
        direction = 'SHORT';
        directionalBias = 'SHORT';
        directionalDriver = `Bearish conviction (${bearConviction}/100) dominates. Pinned under descending MA(7) ceiling ($${dailyMa7}) with volume exhaustion.`;
        archetype = (distToEma21Pct <= -0.8 && micro.consecutiveRedHours >= 1) ? 'BEARISH_EMA_BREAKDOWN' : 'BEARISH_RESISTANCE_REJECTION';
      } else {
        if (price < dailyMa7) {
          direction = 'SHORT';
          directionalBias = 'SHORT';
          directionalDriver = `Trading below Binance Daily MA(7) ($${dailyMa7}) overhead ceiling with subdued buying interest.`;
          archetype = 'BEARISH_RESISTANCE_REJECTION';
        } else {
          direction = 'LONG';
          directionalBias = 'LONG';
          directionalDriver = `Holding above Binance Daily MA(7) ($${dailyMa7}) dynamic support floor.`;
          archetype = 'EMA_PULLBACK_4H';
        }
      }

      if (pseudoRsi < 36 && rangeLocationPct <= 30 && lowerWickAbsorptionPct >= 0.35) {
        direction = 'LONG';
        directionalBias = 'LONG';
        archetype = 'MEAN_REVERSION_DIP';
        directionalDriver = `Extreme oversold exhaustion at 24h floor with confirmed lower-wick absorption.`;
      }
    } else {
      if (bearConviction >= 65 && bearConviction > bullConviction + 20) {
        direction = 'SHORT';
        directionalBias = 'SHORT';
        archetype = (distToEma21Pct <= -1.5) ? 'BEARISH_EMA_BREAKDOWN' : 'BEARISH_RESISTANCE_REJECTION';
        directionalDriver = `Macro structural breakdown below key moving averages with heavy distribution.`;
      } else if (pseudoRsi < 38 || (change24h < -2.5 && distToEma21Pct < -2.5)) {
        direction = 'LONG';
        directionalBias = 'LONG';
        archetype = 'MEAN_REVERSION_DIP';
        directionalDriver = `Cyclical value dip accumulation.`;
      } else if (bbWidthPct <= 4.2 && volumeSurgeRatio >= 1.25) {
        direction = 'LONG';
        directionalBias = 'LONG';
        archetype = 'VOLATILITY_SQUEEZE';
        directionalDriver = `Volatility compression squeeze ready for macro directional expansion.`;
      } else {
        direction = 'LONG';
        directionalBias = 'LONG';
        archetype = 'EMA_PULLBACK_4H';
        directionalDriver = `Multi-week cycle trend-following accumulation.`;
      }
    }

    let confluenceRating: 'A+' | 'A' | 'B' | 'C' | 'DISQUALIFIED' = 'B';
    if (direction === 'LONG') {
      if (dailyTrend === 'BULLISH' && (fourHourStructure === 'TESTING_SUPPORT' || fourHourStructure === 'EXPANDING') && (oneHourImpulse === 'WICK_REJECTION' || oneHourImpulse === 'GREEN_IMPULSE')) {
        confluenceRating = 'A+';
      } else if (dailyTrend === 'BULLISH' && (fourHourStructure === 'TESTING_SUPPORT' || fourHourStructure === 'EXPANDING' || oneHourImpulse === 'GREEN_IMPULSE' || price >= dailyMa7)) {
        confluenceRating = 'A';
      } else if (dailyTrend === 'BEARISH' || fourHourStructure === 'BREAKDOWN') {
        confluenceRating = 'DISQUALIFIED';
      } else if (dailyTrend === 'NEUTRAL' && (fourHourStructure === 'TESTING_SUPPORT' || price >= dailyMa7)) {
        confluenceRating = 'B';
      } else {
        confluenceRating = 'C';
      }
    } else {
      const isBelowResistance = mode === 'FUTURES_1_2D' ? (price <= dailyMa7 || isCeilingBlocked) : true;
      
      // If the asset itself is in a strong bullish surge without overhead resistance, short is counter-trend
      if (dailyTrend === 'BULLISH' && fourHourStructure === 'EXPANDING' && !isCeilingBlocked && price > dailyMa7) {
        confluenceRating = 'DISQUALIFIED';
      } else if (fourHourStructure === 'TESTING_SUPPORT') {
        confluenceRating = 'C';
      } else if (dailyTrend === 'BEARISH' && (fourHourStructure === 'BREAKDOWN' || fourHourStructure === 'OVERBOUGHT') && isBelowResistance) {
        confluenceRating = 'A+';
      } else if ((dailyTrend === 'BEARISH' || fourHourStructure === 'BREAKDOWN' || change24h <= -1.5) && isBelowResistance) {
        confluenceRating = 'A';
      } else if (fourHourStructure === 'OVERBOUGHT' || isBelowResistance) {
        confluenceRating = 'B';
      } else {
        confluenceRating = 'C';
      }
    }

    // Intermediate & Lower Timeframe (15M & 5M) Confluence Evaluations
    const fifteenMinSqueeze: 'BREAKOUT' | 'COMPRESSED' | 'EXPANDING' | 'CHOP' = 
      bbWidthPct <= 3.8 ? 'COMPRESSED'
      : (bbWidthPct >= 4.5 && volumeSurgeRatio >= 1.20) ? 'BREAKOUT'
      : (bbWidthPct > 5.5) ? 'EXPANDING' : 'CHOP';

    const fiveMinFlow: 'BUY_DOMINANT' | 'SELL_DOMINANT' | 'NEUTRAL' = 
      (orderFlow.buyRatioPct >= 51.5 || orderFlow.netDeltaUSD > 30000) ? 'BUY_DOMINANT'
      : (orderFlow.sellRatioPct >= 51.5 || orderFlow.netDeltaUSD < -30000) ? 'SELL_DOMINANT'
      : 'NEUTRAL';

    const fourHourAligned = direction === 'LONG'
      ? (dailyTrend === 'BULLISH' || (fourHourStructure !== 'BREAKDOWN' && price >= dailyMa7))
      : (dailyTrend === 'BEARISH' || fourHourStructure === 'BREAKDOWN');

    const oneHourAligned = direction === 'LONG'
      ? (oneHourImpulse === 'GREEN_IMPULSE' || oneHourImpulse === 'WICK_REJECTION' || micro.currentHourGreen)
      : (oneHourImpulse === 'BEARISH_DRAG' || micro.consecutiveRedHours >= 1);

    const fifteenMinAligned = fifteenMinSqueeze === 'BREAKOUT' || fifteenMinSqueeze === 'EXPANDING' || (fifteenMinSqueeze === 'COMPRESSED' && volumeSurgeRatio >= 1.15);

    const fiveMinAligned = direction === 'LONG'
      ? (fiveMinFlow === 'BUY_DOMINANT' || orderFlow.netDeltaUSD >= 0)
      : (fiveMinFlow === 'SELL_DOMINANT' || orderFlow.netDeltaUSD <= 0);

    const alignedCount = (fourHourAligned ? 1 : 0) + (oneHourAligned ? 1 : 0) + (fifteenMinAligned ? 1 : 0) + (fiveMinAligned ? 1 : 0);

    const suggestedTrancheUSD = 10.00;
    const suggestedUnits = price > 0 ? +(suggestedTrancheUSD / price).toFixed(price < 0.01 ? 2 : 6) : 0.1;

    const atrMultiplierStop = mode === 'FUTURES_1_2D' 
      ? (archetype === 'MEAN_REVERSION_DIP' ? 1.05 : archetype === 'VOLATILITY_SQUEEZE' ? 0.85 : 0.95)
      : (archetype === 'MEAN_REVERSION_DIP' ? 1.35 : archetype === 'VOLATILITY_SQUEEZE' ? 1.15 : 1.25);
    // ATR-scaled ladder (config/geometry.ts). The legacy branch is kept so the
    // original capped behaviour can be reproduced for a controlled comparison.
    const atrLadder = GEOMETRY_CONFIG.useAtrGeometry ? resolveGeometry(atrPct) : null;
    const stopLossPct = atrLadder
      ? atrLadder.stopPct
      : mode === 'FUTURES_1_2D'
      ? +Math.max(1.4, Math.min(3.2, atrPct * atrMultiplierStop)).toFixed(2)
      : +Math.max(2.2, Math.min(6.5, atrPct * atrMultiplierStop)).toFixed(2);
    const stopLossPrice = direction === 'SHORT'
      ? roundPrice(price * (1 + stopLossPct / 100))
      : roundPrice(price * (1 - stopLossPct / 100));
    const riskAmountUSD = +((suggestedTrancheUSD * (stopLossPct / 100))).toFixed(2);

    const atrMultiplierTier1 = mode === 'FUTURES_1_2D' ? 0.95 : (archetype === 'VOLATILITY_SQUEEZE' ? +Math.max(1.15, (bbWidthPct * 0.8) / atrPct).toFixed(2) : 1.15);
    const tier1Pct = atrLadder
      ? atrLadder.tier1Pct
      : mode === 'FUTURES_1_2D'
      ? +Math.max(1.8, Math.min(3.8, atrPct * atrMultiplierTier1)).toFixed(2)
      : +Math.max(1.8, Math.min(6.5, atrPct * atrMultiplierTier1)).toFixed(2);
    const tier1Price = direction === 'SHORT'
      ? roundPrice(price * (1 - tier1Pct / 100))
      : roundPrice(price * (1 + tier1Pct / 100));
    const tier1RewardUSD = +((suggestedTrancheUSD * 0.33 * (tier1Pct / 100))).toFixed(2);

    const atrMultiplierTier2 = mode === 'FUTURES_1_2D' ? 1.85 : (archetype === 'VOLATILITY_SQUEEZE' ? 2.60 : 2.30);
    const tier2Pct = atrLadder
      ? atrLadder.tier2Pct
      : mode === 'FUTURES_1_2D'
      ? +Math.max(3.6, Math.min(7.5, atrPct * atrMultiplierTier2)).toFixed(2)
      : +Math.max(4.2, Math.min(14.0, atrPct * atrMultiplierTier2)).toFixed(2);
    const tier2Price = direction === 'SHORT'
      ? roundPrice(price * (1 - tier2Pct / 100))
      : roundPrice(price * (1 + tier2Pct / 100));
    const tier2RewardUSD = +((suggestedTrancheUSD * 0.33 * (tier2Pct / 100))).toFixed(2);

    const tier3Pct = atrLadder
      ? atrLadder.tier3Pct
      : mode === 'FUTURES_1_2D'
      ? +Math.max(5.5, Math.min(12.0, atrPct * 2.8)).toFixed(2)
      : +Math.max(7.5, Math.min(24.0, atrPct * 4.0)).toFixed(2);
    const tier3TargetPrice = direction === 'SHORT'
      ? roundPrice(price * (1 - tier3Pct / 100))
      : roundPrice(price * (1 + tier3Pct / 100));
    const rewardRiskRatio = +(tier2Pct / stopLossPct).toFixed(1);
    // Floor once tier 1 harvests, expressed in R rather than a fixed +0.3%.
    const beFloorPct = stopLossPct * GEOMETRY_CONFIG.breakevenFloorRMultiple;
    const breakevenRatchetPrice = direction === 'SHORT'
      ? roundPrice(price * (1 - beFloorPct / 100))
      : roundPrice(price * (1 + beFloorPct / 100));

    const momentumState: 'ACCELERATING' | 'HEALTHY_PULLBACK' | 'CONSOLIDATING' | 'EXHAUSTED' = 
      pseudoRsi > 65 ? 'ACCELERATING' : pseudoRsi < 42 ? 'HEALTHY_PULLBACK' : bbWidthPct < 4.5 ? 'CONSOLIDATING' : 'HEALTHY_PULLBACK';
    const volatilityRating = mode === 'FUTURES_1_2D' 
      ? `${atrPct}% ATR • 3x-5x Futures Leverage`
      : `${atrPct}% ATR • 1-2W Spot Accumulation`;

    const isBleedingKnife = direction === 'LONG' && (micro.consecutiveRedHours >= 2 || (!micro.currentHourGreen && micro.hourlyChangePct < -0.25 && !hasAbsorptionWick));

    let microConfirmation: {
      isGreenReversal: boolean;
      consecutiveRedCandles: number;
      hourlyChangePct: number;
      statusSummary: string;
    };

    if (direction === 'LONG') {
      if (isBleedingKnife) {
        microConfirmation = {
          isGreenReversal: false,
          consecutiveRedCandles: micro.consecutiveRedHours,
          hourlyChangePct: micro.hourlyChangePct,
          statusSummary: `Bleeding Knife Warning: ${micro.consecutiveRedHours} consecutive red 1H candles (${micro.hourlyChangePct}% this hour). Pillar 2 zeroed. Held in STAGING until green reversal candle forms.`
        };
      } else {
        microConfirmation = {
          isGreenReversal: true,
          consecutiveRedCandles: 0,
          hourlyChangePct: micro.hourlyChangePct,
          statusSummary: `Micro Reversal Confirmed: Green 1H candle (+${micro.hourlyChangePct}%) or lower wick absorption confirms active buyer defense.`
        };
      }
    } else {
      const isShortMomentumConfirmed = micro.consecutiveRedHours >= 1 || !micro.currentHourGreen;
      microConfirmation = {
        isGreenReversal: isShortMomentumConfirmed,
        consecutiveRedCandles: micro.consecutiveRedHours,
        hourlyChangePct: micro.hourlyChangePct,
        statusSummary: isShortMomentumConfirmed
          ? `Bearish Momentum Active: ${micro.consecutiveRedHours} red 1H candles (${micro.hourlyChangePct}%) confirming downward distribution.`
          : `Micro Pause: Current candle is consolidating (+${micro.hourlyChangePct}%). Wait for red candle to confirm short entry.`
      };
    }

    const checkpoints: StrategyCheckpoint[] = [];
    let archetypeName = '';
    let archetypeDescription = '';
    let aiRationale = '';
    let recommendedAction = '';

    if (archetype === 'EMA_PULLBACK_4H') {
      archetypeName = mode === 'FUTURES_1_2D' && price >= dailyMa7
        ? 'Daily MA(7) Trend Expansion Long'
        : '4-Hour 21 EMA Pullback';
      archetypeDescription = mode === 'FUTURES_1_2D' && price >= dailyMa7
        ? 'Binance Futures trend-following long riding above the Daily MA(7) yellow line with buyer order flow and expanding momentum.'
        : 'Trend-following strategy that buys disciplined dip retracements into the 4-Hour 21 EMA with confirmed lower-wick absorption while the macro trend is bullish.';
      
      const p1FailedByMa7 = mode === 'FUTURES_1_2D' && price < dailyMa7;
      const p1Passed = !p1FailedByMa7 && (
        (distToEma21Pct >= -2.0 && distToEma21Pct <= 1.8 && emaAlignmentBullish) ||
        (mode === 'FUTURES_1_2D' && price >= dailyMa7 && distToEma21Pct >= -1.0 && distToEma21Pct <= 4.0)
      );
      const p1Score = p1Passed ? 20 : (!p1FailedByMa7 && distToEma21Pct >= -2.8 && distToEma21Pct <= 4.8) ? 14 : 0;
      checkpoints.push({
        id: 'cp-p1-structure',
        name: mode === 'FUTURES_1_2D' && price >= dailyMa7 ? 'Binance MA(7) Support Floor & 4H Trend' : '4H 21 EMA Structural Retest',
        requiredRule: mode === 'FUTURES_1_2D' 
          ? 'Price holding above Binance Daily MA(7) Yellow Line'
          : 'Retesting 4H 21 EMA (-2.0% to +1.5%) with 21 > 50 EMA alignment',
        currentValue: p1FailedByMa7 
          ? `Below Daily MA7 ($${dailyMa7}) by ${distToDailyMa7Pct}%`
          : mode === 'FUTURES_1_2D' && price >= dailyMa7
          ? `+${distToDailyMa7Pct}% above Daily MA(7) ($${dailyMa7})`
          : `${distToEma21Pct > 0 ? '+' : ''}${distToEma21Pct}% vs 4H 21 EMA ($${ema21_4h})`,
        passed: p1Passed,
        weight: 20,
        earnedScore: p1Score,
        pillarCategory: 'STRUCTURE',
        explanation: p1Passed 
          ? mode === 'FUTURES_1_2D' && price >= dailyMa7
            ? `Price is cleanly supported by the Binance Daily MA(7) yellow line ($${dailyMa7}, +${distToDailyMa7Pct}%), confirming bullish trend momentum.`
            : `Price is in the golden retracement zone (${distToEma21Pct}% from 21 EMA) with bullish EMA alignment, offering a high-probability springboard.`
          : p1FailedByMa7
            ? `Price is trading below the Binance Daily MA(7) ($${dailyMa7}), creating immediate overhead resistance against longs.`
            : `Price is stretched ${distToEma21Pct}% from the 4H 21 EMA ($${ema21_4h}), outside ideal structural retest tolerance.`
      });

      const p2Passed = !isBleedingKnife && (micro.currentHourGreen || lowerWickAbsorptionPct >= 0.35);
      const p2Score = (!isBleedingKnife && (micro.currentHourGreen || lowerWickAbsorptionPct >= 0.35)) ? 20 
        : (!isBleedingKnife && lowerWickAbsorptionPct >= 0.20) ? 10 : 0;
      checkpoints.push({
        id: 'cp-p2-micro1h',
        name: 'Micro 1H Reversal & Wick Defense',
        requiredRule: 'Active 1H Green OR Lower Wick Absorption >= +0.35% (0 Red Hours)',
        currentValue: isBleedingKnife 
          ? `Bleeding: ${micro.consecutiveRedHours} Red Hours (${micro.hourlyChangePct}%)`
          : `Green 1H (${micro.hourlyChangePct >= 0 ? '+' : ''}${micro.hourlyChangePct}%) | Wick: +${lowerWickAbsorptionPct}% | 0 Red Hours`,
        passed: p2Passed,
        weight: 20,
        earnedScore: p2Score,
        pillarCategory: 'MICRO_1H',
        explanation: p2Passed
          ? `1H candle confirms buyer reaction with lower-wick absorption (+${lowerWickAbsorptionPct}%), preventing entry on falling knives.`
          : `1H candle is actively red with ${micro.consecutiveRedHours} consecutive red hours. Execution trigger held in STAGING until green candle prints.`
      });

      const whaleNet = orderFlow.whale?.whaleNetDeltaUSD || 0;
      const p3Passed = whaleNet > 0 && orderFlow.buyRatioPct >= 50.5;
      const p3Score = (whaleNet > 0 && orderFlow.buyRatioPct >= 50.5) ? 20
        : (orderFlow.netDeltaUSD > 0 && orderFlow.buyRatioPct >= 49.5) ? 12
        : (orderFlow.buyRatioPct >= 48.0) ? 6 : 0;
      checkpoints.push({
        id: 'cp-p3-whale',
        name: 'Order Flow (estimated)',
        requiredRule: 'Est. large-order delta > $0 & est. buy ratio >= 50.5%',
        currentValue: `Est. large-order: ${whaleNet >= 0 ? '+' : ''}${formatCashUSD(whaleNet)} (${orderFlow.whale?.whaleBuyRatioPct || 50}% Buy) | Total: ${formatOrderFlowUSD(orderFlow.netDeltaUSD)}`,
        passed: p3Passed,
        weight: 20,
        earnedScore: p3Score,
        pillarCategory: 'WHALE_FLOW',
        explanation: p3Passed
          ? `Estimated large-order flow is positive (+${formatCashUSD(whaleNet)}), derived from 24h price action.`
          : `Estimated large-order flow is neutral or negative (${formatCashUSD(whaleNet)}).`
      });

      const p4Passed = confluenceRating === 'A+' || confluenceRating === 'A';
      const p4Score = confluenceRating === 'A+' ? 20 : confluenceRating === 'A' ? 16 : confluenceRating === 'B' ? 8 : 0;
      checkpoints.push({
        id: 'cp-p4-confluence',
        name: 'Multi-Timeframe Confluence (MTA)',
        requiredRule: 'Daily Macro Bullish (> 200 EMA) & 4H Support Aligned (Rating A/A+)',
        currentValue: `Confluence: ${confluenceRating} | 1D: ${dailyTrend} (${distToEma200Pct > 0 ? '+' : ''}${distToEma200Pct}% vs 200 EMA)`,
        passed: p4Passed,
        weight: 20,
        earnedScore: p4Score,
        pillarCategory: 'MTA_CONFLUENCE',
        explanation: p4Passed
          ? `Triple timeframe alignment verified. Daily trend is ${dailyTrend}, 4H is holding support, and 1H momentum is constructive.`
          : `Multi-timeframe disagreement (${confluenceRating}). Daily trend or 4H intermediate structure lacks unified momentum.`
      });

      const isGeometryBlocked = orderFlow.isCeilingExhaustionTrap || rangeLocationPct > 85 || (mode === 'FUTURES_1_2D' && isCeilingBlocked);
      const p5Passed = rewardRiskRatio >= 1.7 && !isGeometryBlocked;
      const p5Score = (rewardRiskRatio >= 1.7 && !isGeometryBlocked) ? 20
        : (rewardRiskRatio >= 1.4 && !isGeometryBlocked) ? 12
        : (rewardRiskRatio >= 1.2 && !isGeometryBlocked) ? 6 : 0;
      checkpoints.push({
        id: 'cp-p5-geometry',
        name: 'Trade Geometry & Reward-to-Risk',
        requiredRule: 'Reward-to-Risk >= 1.7:1 & Room Below Overhead Resistance',
        currentValue: `R:R ${rewardRiskRatio}:1 | Stop -${stopLossPct}% | Tier 1 +${tier1Pct}% | Range: ${rangeLocationPct}%${isCeilingBlocked ? ' • Resistance Ceiling' : orderFlow.isCeilingExhaustionTrap ? ' • Ceiling Trap' : ''}`,
        passed: p5Passed,
        weight: 20,
        earnedScore: p5Score,
        pillarCategory: 'TRADE_GEOMETRY',
        explanation: p5Passed
          ? `Asymmetric trade geometry: ${rewardRiskRatio}:1 R:R with well-defined ATR stop at $${stopLossPrice} and room below overhead resistance.`
          : isCeilingBlocked
            ? `Price is within ${distToResistancePct}% of overhead resistance (${resistanceType === 'DAILY_MA7' ? `Daily MA7 $${dailyMa7}` : `24h High $${overheadResistancePrice}`}). Upward expansion headroom is blocked.`
            : orderFlow.isCeilingExhaustionTrap
              ? `Price is trapped near 24h ceiling (${rangeLocationPct}%). Upward expansion headroom is blocked by overhead sell walls.`
              : `Reward-to-risk ratio (${rewardRiskRatio}:1) does not meet the institutional 1.7:1 threshold.`
      });

      aiRationale = `${coin.name} is testing its 4H 21 EMA at $${ema21_4h} (${distToEma21Pct}% distance) with ${microConfirmation.isGreenReversal ? 'confirmed micro 1H reversal' : 'micro momentum held in staging'}. Institutional whale net flow is ${whaleNet >= 0 ? '+' : ''}${formatCashUSD(whaleNet)}, supporting a ${confluenceRating} confluence rating and ${rewardRiskRatio}:1 R:R.`;
      recommendedAction = `Enter at $${price}. Stop Loss at $${stopLossPrice} (-${stopLossPct}%) and harvest Tier 1 Take Profit at $${tier1Price} (+${tier1Pct}%).`;
    } else if (archetype === 'VOLATILITY_SQUEEZE') {
      archetypeName = 'Volatility Squeeze Breakout';
      archetypeDescription = 'Explosive energy coiled strategy detecting extreme Bollinger Band compression (<4.2%) ready for expansion with volume surge.';

      const p1Passed = bbWidthPct <= 4.2;
      const p1Score = bbWidthPct <= 4.2 ? 20 : bbWidthPct <= 5.0 ? 12 : 0;
      checkpoints.push({
        id: 'cp-p1-squeeze-structure',
        name: 'Bollinger Bandwidth Compression',
        requiredRule: 'Bandwidth <= 4.2% (Coiled 48h consolidation)',
        currentValue: `Bandwidth: ${bbWidthPct}% (Threshold <= 4.2%)`,
        passed: p1Passed,
        weight: 20,
        earnedScore: p1Score,
        pillarCategory: 'STRUCTURE',
        explanation: p1Passed
          ? `Extreme Bollinger compression (${bbWidthPct}%) indicates high potential energy stored for an imminent breakout expansion.`
          : `Bollinger Bandwidth is ${bbWidthPct}%, indicating normal volatility rather than a coiled squeeze.`
      });

      const p2Passed = !isBleedingKnife && (micro.currentHourGreen || rangeLocationPct >= 50);
      const p2Score = (!isBleedingKnife && micro.currentHourGreen && rangeLocationPct >= 55) ? 20
        : (!isBleedingKnife && (micro.currentHourGreen || rangeLocationPct >= 45)) ? 12 : 0;
      checkpoints.push({
        id: 'cp-p2-squeeze-micro',
        name: 'Micro 1H Breakout Impulse',
        requiredRule: 'Green 1H Candle & Upper Quadrant Thrust (0 Red Hours)',
        currentValue: isBleedingKnife
          ? `Bleeding: ${micro.consecutiveRedHours} Red Hours (${micro.hourlyChangePct}%)`
          : `Green 1H (${micro.hourlyChangePct >= 0 ? '+' : ''}${micro.hourlyChangePct}%) | Range Pos: ${rangeLocationPct}%`,
        passed: p2Passed,
        weight: 20,
        earnedScore: p2Score,
        pillarCategory: 'MICRO_1H',
        explanation: p2Passed
          ? `Active 1H candle is green with upper range positioning (${rangeLocationPct}%), indicating upward directional release.`
          : `Asset lacks upward 1H breakout momentum. Consecutive red candles signal risk of downward resolution.`
      });

      const whaleNet = orderFlow.whale?.whaleNetDeltaUSD || 0;
      const p3Passed = volumeSurgeRatio >= 1.20 && (whaleNet > 0 || orderFlow.netDeltaUSD > 0);
      const p3Score = (volumeSurgeRatio >= 1.25 && whaleNet > 0) ? 20
        : (volumeSurgeRatio >= 1.15 || orderFlow.netDeltaUSD > 0) ? 12 : 0;
      checkpoints.push({
        id: 'cp-p3-squeeze-whale',
        name: 'Order Flow & Volume (estimated)',
        requiredRule: 'Volume ratio >= 1.20x & positive est. large-order flow',
        currentValue: `Surge: ${volumeSurgeRatio}x | Whale: ${whaleNet >= 0 ? '+' : ''}${formatCashUSD(whaleNet)} | Total: ${formatOrderFlowUSD(orderFlow.netDeltaUSD)}`,
        passed: p3Passed,
        weight: 20,
        earnedScore: p3Score,
        pillarCategory: 'WHALE_FLOW',
        explanation: p3Passed
          ? `Volume ratio ${volumeSurgeRatio}x with positive estimated large-order flow (+${formatCashUSD(whaleNet)}).`
          : `Volume ratio is subdued (${volumeSurgeRatio}x) or estimated large-order flow is not positive.`
      });

      const p4Passed = confluenceRating === 'A+' || confluenceRating === 'A';
      const p4Score = confluenceRating === 'A+' ? 20 : confluenceRating === 'A' ? 16 : confluenceRating === 'B' ? 8 : 0;
      checkpoints.push({
        id: 'cp-p4-squeeze-confluence',
        name: 'Multi-Timeframe Confluence (MTA)',
        requiredRule: 'Daily Macro Bullish & 4H Moving Averages Aligned',
        currentValue: `Confluence: ${confluenceRating} | Daily Trend: ${dailyTrend} | 200 EMA: ${distToEma200Pct > 0 ? '+' : ''}${distToEma200Pct}%`,
        passed: p4Passed,
        weight: 20,
        earnedScore: p4Score,
        pillarCategory: 'MTA_CONFLUENCE',
        explanation: p4Passed
          ? `Multi-timeframe trend aligns with breakout direction (${dailyTrend} daily macro trend).`
          : `Timeframe conflict detected (${confluenceRating}). Macro headwinds may stall the breakout expansion.`
      });

      const p5Passed = rewardRiskRatio >= 1.8 && !orderFlow.isCeilingExhaustionTrap;
      const p5Score = (rewardRiskRatio >= 1.8 && !orderFlow.isCeilingExhaustionTrap) ? 20
        : (rewardRiskRatio >= 1.4) ? 12 : 6;
      checkpoints.push({
        id: 'cp-p5-squeeze-geometry',
        name: 'Breakout Trade Geometry & R:R',
        requiredRule: 'Reward-to-Risk >= 1.8:1 with Tight Volatility Stop',
        currentValue: `R:R ${rewardRiskRatio}:1 | Stop -${stopLossPct}% ($${stopLossPrice}) | Tier 1 +${tier1Pct}%`,
        passed: p5Passed,
        weight: 20,
        earnedScore: p5Score,
        pillarCategory: 'TRADE_GEOMETRY',
        explanation: p5Passed
          ? `High asymmetric payoff: ${rewardRiskRatio}:1 R:R backed by a tight volatility stop (${stopLossPct}%).`
          : `Reward-to-risk ratio (${rewardRiskRatio}:1) is compressed by overhead resistance.`
      });

      aiRationale = `${coin.name} is in a tightly wound Bollinger Squeeze (Bandwidth ${bbWidthPct}%) with ${volumeSurgeRatio}x volume expansion and ${whaleNet >= 0 ? '+' : ''}${formatCashUSD(whaleNet)} whale accumulation. Asymmetric expansion target set at +${tier1Pct}% with ${rewardRiskRatio}:1 R:R.`;
      recommendedAction = `Enter at $${price}. Stop Loss at $${stopLossPrice} (-${stopLossPct}%) and harvest Tier 1 Take Profit at $${tier1Price} (+${tier1Pct}%).`;
    } else if (archetype === 'MEAN_REVERSION_DIP') {
      archetypeName = 'Mean Reversion Dip Capitulation';
      archetypeDescription = 'Statistical dip-buying strategy identifying oversold capitulation into high-liquidity order flow support with confirmed absorption wicks.';

      const p1Passed = distToEma21Pct <= -2.5 && pseudoRsi <= 40;
      const p1Score = (distToEma21Pct <= -3.0 && pseudoRsi <= 36) ? 20
        : (distToEma21Pct <= -2.0 && pseudoRsi <= 42) ? 12 : 0;
      checkpoints.push({
        id: 'cp-p1-dip-structure',
        name: 'Statistical Discount from Mean',
        requiredRule: 'Price <= -2.5% below 4H 21 EMA & RSI <= 40 (Capitulation)',
        currentValue: `${distToEma21Pct}% vs 21 EMA ($${ema21_4h}) | RSI: ${pseudoRsi}`,
        passed: p1Passed,
        weight: 20,
        earnedScore: p1Score,
        pillarCategory: 'STRUCTURE',
        explanation: p1Passed
          ? `Asset is stretched -${Math.abs(distToEma21Pct)}% below its 4H 21 EMA with RSI at ${pseudoRsi}, indicating seller exhaustion.`
          : `Asset is not sufficiently stretched below the 21 EMA (${distToEma21Pct}%) or RSI (${pseudoRsi}) is not in capitulation.`
      });

      const p2Passed = !isBleedingKnife && lowerWickAbsorptionPct >= 0.35;
      const p2Score = (!isBleedingKnife && lowerWickAbsorptionPct >= 0.50) ? 20
        : (!isBleedingKnife && lowerWickAbsorptionPct >= 0.25) ? 12 : 0;
      checkpoints.push({
        id: 'cp-p2-dip-micro',
        name: 'Micro Rebound Wick & Floor Absorption',
        requiredRule: 'Lower Wick Absorption >= +0.35% off 24h Low (0 Red Hours)',
        currentValue: isBleedingKnife
          ? `Bleeding: ${micro.consecutiveRedHours} Red Hours (${micro.hourlyChangePct}%)`
          : `Wick Absorption: +${lowerWickAbsorptionPct}% | Green 1H (${micro.hourlyChangePct >= 0 ? '+' : ''}${micro.hourlyChangePct}%)`,
        passed: p2Passed,
        weight: 20,
        earnedScore: p2Score,
        pillarCategory: 'MICRO_1H',
        explanation: p2Passed
          ? `Confirmed lower-wick absorption (+${lowerWickAbsorptionPct}%) proves limit bids absorbed the panic selloff.`
          : `Asset is actively bleeding in consecutive red hourly candles. Execution trigger withheld in STAGING.`
      });

      const whaleNet = orderFlow.whale?.whaleNetDeltaUSD || 0;
      const p3Passed = whaleNet > 0 || (orderFlow.buyRatioPct >= 49.0 && lowerWickAbsorptionPct >= 0.50);
      const p3Score = (whaleNet > 0 && orderFlow.buyRatioPct >= 50.0) ? 20
        : (whaleNet >= -20000 || lowerWickAbsorptionPct >= 0.50) ? 12 : 0;
      checkpoints.push({
        id: 'cp-p3-dip-whale',
        name: 'Dip Absorption (estimated)',
        requiredRule: 'Est. large-order delta > $0 or est. dip absorption',
        currentValue: `Est. large-order: ${whaleNet >= 0 ? '+' : ''}${formatCashUSD(whaleNet)} | Total: ${formatOrderFlowUSD(orderFlow.netDeltaUSD)} (${orderFlow.buyRatioPct}% Buy)`,
        passed: p3Passed,
        weight: 20,
        earnedScore: p3Score,
        pillarCategory: 'WHALE_FLOW',
        explanation: p3Passed
          ? `Estimated flow suggests the dip is being bought (+${formatCashUSD(whaleNet)} est. large-order flow).`
          : `Estimated selling still dominates (est. ${orderFlow.sellRatioPct}% sell).`
      });

      const p4Passed = !isBleedingKnife && (distToEma200Pct >= -4.0 || dailyTrend !== 'BEARISH');
      const p4Score = (confluenceRating === 'A+' || confluenceRating === 'A') ? 20
        : confluenceRating === 'B' ? 14 : 6;
      checkpoints.push({
        id: 'cp-p4-dip-confluence',
        name: 'Macro Support Floor & Liquidity',
        requiredRule: 'Asset Liquidity & Daily Macro Floor (Rating A/B)',
        currentValue: `Rating: ${confluenceRating} | 1D: ${dailyTrend} (${distToEma200Pct > 0 ? '+' : ''}${distToEma200Pct}% vs 200 EMA)`,
        passed: p4Passed,
        weight: 20,
        earnedScore: p4Score,
        pillarCategory: 'MTA_CONFLUENCE',
        explanation: p4Passed
          ? `Macro floor support intact. The dip is a cyclical mean reversion within a broader constructive structure.`
          : `Severe macro breakdown threatens further downside extension.`
      });

      const p5Passed = rewardRiskRatio >= 1.8 && !orderFlow.isCeilingExhaustionTrap;
      const p5Score = (rewardRiskRatio >= 2.0 && !orderFlow.isCeilingExhaustionTrap) ? 20
        : (rewardRiskRatio >= 1.5) ? 12 : 6;
      checkpoints.push({
        id: 'cp-p5-dip-geometry',
        name: 'Mean Snapback Reward-to-Risk',
        requiredRule: 'Reward-to-Risk >= 1.8:1 back to 4H 21 EMA Equilibrium',
        currentValue: `R:R ${rewardRiskRatio}:1 | Stop -${stopLossPct}% ($${stopLossPrice}) | Tier 1 +${tier1Pct}%`,
        passed: p5Passed,
        weight: 20,
        earnedScore: p5Score,
        pillarCategory: 'TRADE_GEOMETRY',
        explanation: p5Passed
          ? `Statistical snapback to mean provides asymmetric ${rewardRiskRatio}:1 R:R with a tight ATR stop.`
          : `Reward-to-risk ratio (${rewardRiskRatio}:1) is insufficient for a mean reversion setup.`
      });

      aiRationale = `${coin.name} has undergone a capitulation dip (${distToEma21Pct}% from 21 EMA, RSI ${pseudoRsi}) with ${lowerWickAbsorptionPct}% lower-wick absorption. Whale order flow is ${whaleNet >= 0 ? '+' : ''}${formatCashUSD(whaleNet)}, targeting a snapback rally with ${rewardRiskRatio}:1 R:R.`;
      recommendedAction = `Enter at $${price}. Stop Loss at $${stopLossPrice} (-${stopLossPct}%) and harvest Tier 1 Take Profit at $${tier1Price} (+${tier1Pct}%).`;
    } else if (archetype === 'BEARISH_RESISTANCE_REJECTION') {
      archetypeName = 'Resistance Rejection Short';
      archetypeDescription = mode === 'FUTURES_1_2D'
        ? 'Binance Futures short strategy capitalizing on weak bounces rejected by Daily MA(7) or 24h ceiling resistance with high downside R:R.'
        : 'Short-side strategy targeting failed breakout attempts into overhead resistance ceilings with heavy sell delta.';

      const p1Passed = mode === 'FUTURES_1_2D'
        ? (rangeLocationPct >= 60 || distToResistancePct <= 3.2 || (price <= dailyMa7 * 1.015 && price >= dailyMa7 * 0.95))
        : rangeLocationPct >= 68;
      const p1Score = p1Passed ? 20 : rangeLocationPct >= 55 ? 12 : 0;
      checkpoints.push({
        id: 'cp-p1-short-res-structure',
        name: 'Overhead Ceiling Resistance Test',
        requiredRule: mode === 'FUTURES_1_2D' 
          ? 'Testing Daily MA(7) or Upper 24h Resistance with stalled upside'
          : 'Range Location >= 68% testing 24h High Wall',
        currentValue: `${resistanceType === 'DAILY_MA7' ? `Daily MA7 ($${dailyMa7})` : `24h High ($${overheadResistancePrice})`} | Dist: ${distToResistancePct}% | Range Pos: ${rangeLocationPct}%`,
        passed: p1Passed,
        weight: 20,
        earnedScore: p1Score,
        pillarCategory: 'STRUCTURE',
        explanation: p1Passed
          ? `Price is testing overhead ${resistanceType === 'DAILY_MA7' ? `Binance Daily MA(7) resistance ($${dailyMa7})` : `24h resistance ceiling ($${overheadResistancePrice})`}, presenting an optimal short entry location.`
          : `Price is at ${rangeLocationPct}% of range, lacking immediate proximity to overhead resistance.`
      });

      const p2Passed = !micro.currentHourGreen || micro.consecutiveRedHours >= 1 || (mode === 'FUTURES_1_2D' && micro.hourlyChangePct <= 0.20);
      const p2Score = (micro.consecutiveRedHours >= 1 && micro.hourlyChangePct < -0.10) ? 20
        : (!micro.currentHourGreen || micro.hourlyChangePct <= 0.20) ? 16 : 8;
      checkpoints.push({
        id: 'cp-p2-short-res-micro',
        name: 'Micro 1H Upper Rejection Shadow',
        requiredRule: 'Red 1H Candle OR Upper Rejection Wick Confirmed',
        currentValue: `Red 1H: ${!micro.currentHourGreen ? 'YES' : 'NO'} (${micro.hourlyChangePct}%) | Red Hours: ${micro.consecutiveRedHours}`,
        passed: p2Passed,
        weight: 20,
        earnedScore: p2Score,
        pillarCategory: 'MICRO_1H',
        explanation: p2Passed
          ? `1H candle printed upper rejection shadow with active selling (${micro.hourlyChangePct}%), confirming supply defense.`
          : `1H candle is still green (+${micro.hourlyChangePct}%). Wait for red rejection candle to confirm short trigger.`
      });

      const whaleNet = orderFlow.whale?.whaleNetDeltaUSD || 0;
      const p3Passed = whaleNet < 0 || orderFlow.sellRatioPct >= 49.0 || (mode === 'FUTURES_1_2D' && orderFlow.netDeltaUSD <= 150000);
      const p3Score = (whaleNet < 0 && orderFlow.sellRatioPct >= 50.5) ? 20
        : (orderFlow.netDeltaUSD < 0 || orderFlow.sellRatioPct >= 48.5) ? 16 : 10;
      checkpoints.push({
        id: 'cp-p3-short-res-whale',
        name: 'Sell Pressure (estimated)',
        requiredRule: 'Est. large-order selling or est. sell ratio elevated',
        currentValue: `Est. large-order: ${whaleNet >= 0 ? '+' : ''}${formatCashUSD(whaleNet)} | Sell Vol: ${orderFlow.sellRatioPct}% (${formatOrderFlowUSD(orderFlow.netDeltaUSD)})`,
        passed: p3Passed,
        weight: 20,
        earnedScore: p3Score,
        pillarCategory: 'WHALE_FLOW',
        explanation: p3Passed
          ? `Estimated flow points to selling into resistance (est. ${orderFlow.sellRatioPct}% sell volume / ${formatOrderFlowUSD(orderFlow.netDeltaUSD)} delta).`
          : `Sellers have not established dominance at resistance; buy pressure remains elevated.`
      });

      const isOverheadBlocked = mode === 'FUTURES_1_2D'
        ? (price <= dailyMa7 || isCeilingBlocked || rangeLocationPct >= 58)
        : (price <= dailyMa7 || isCeilingBlocked || rangeLocationPct >= 65);
      const isAltRelativelyWeak = change24h <= 0 || price < dailyMa7 || orderFlow.sellRatioPct >= 49.5 || fourHourStructure === 'OVERBOUGHT';
      const p4Passed = isOverheadBlocked || isAltRelativelyWeak || dailyTrend !== 'BULLISH';
      const p4Score = (dailyTrend === 'BEARISH' || (mode === 'FUTURES_1_2D' && price <= dailyMa7)) ? 20
        : (confluenceRating === 'A' || confluenceRating === 'B' || fourHourStructure === 'OVERBOUGHT' || isOverheadBlocked) ? 16 : 10;
      checkpoints.push({
        id: 'cp-p4-short-res-confluence',
        name: 'Bearish Structure & Relative Weakness',
        requiredRule: mode === 'FUTURES_1_2D'
          ? 'Trading Below Daily MA(7) Ceiling / Upper Range Rejection with Sell Pressure'
          : 'Daily Neutral/Bearish or Clear Overhead Resistance',
        currentValue: mode === 'FUTURES_1_2D'
          ? `1D: ${dailyTrend} | MA7: ${distToDailyMa7Pct}% ($${dailyMa7}) | 4H: ${fourHourStructure}`
          : `1D Trend: ${dailyTrend} | 4H Structure: ${fourHourStructure} | Confluence: ${confluenceRating}`,
        passed: p4Passed,
        weight: 20,
        earnedScore: p4Score,
        pillarCategory: 'MTA_CONFLUENCE',
        explanation: p4Passed
          ? `Confirmed structural resistance and relative weakness (trading under Daily MA7 or upper range rejection) with active seller distribution.`
          : `Asset is trading above immediate moving average resistance.`
      });

      const p5Passed = rewardRiskRatio >= (mode === 'FUTURES_1_2D' ? 1.4 : 1.7);
      const p5Score = rewardRiskRatio >= 1.7 ? 20 : rewardRiskRatio >= 1.4 ? 16 : 8;
      checkpoints.push({
        id: 'cp-p5-short-res-geometry',
        name: 'Short Downside Reward-to-Risk',
        requiredRule: `Reward-to-Risk >= ${mode === 'FUTURES_1_2D' ? '1.4:1' : '1.7:1'} with Stop Above Resistance`,
        currentValue: `R:R ${rewardRiskRatio}:1 | Stop +${stopLossPct}% ($${stopLossPrice}) | Tier 1 -${tier1Pct}% ($${tier1Price})`,
        passed: p5Passed,
        weight: 20,
        earnedScore: p5Score,
        pillarCategory: 'TRADE_GEOMETRY',
        explanation: p5Passed
          ? `Clean asymmetric risk: ${rewardRiskRatio}:1 R:R with stop loss tightly anchored above overhead resistance.`
          : `Downside reward-to-risk ratio (${rewardRiskRatio}:1) is too compressed.`
      });

      aiRationale = `${coin.name} is rejecting overhead resistance at $${overheadResistancePrice} (${resistanceType === 'DAILY_MA7' ? 'Daily MA7' : '24h High'}, ${distToResistancePct}% away) with ${orderFlow.sellRatioPct}% taker sell volume. Downside target at $${tier1Price} (-${tier1Pct}%) with ${rewardRiskRatio}:1 R:R.`;
      recommendedAction = `Enter SHORT at $${price}. Stop Loss at $${stopLossPrice} (+${stopLossPct}%) and harvest Tier 1 Take Profit at $${tier1Price} (-${tier1Pct}%).`;
    } else {
      archetypeName = '4H 21 EMA Breakdown Short';
      archetypeDescription = 'Trend-reversal short strategy capitalizing on confirmed 4-hour candle closes below the 21 EMA with accelerating downside volume.';

      const isTestingSupport = fourHourStructure === 'TESTING_SUPPORT';
      const p1Passed = distToEma21Pct <= -0.5 && !isTestingSupport;
      const p1Score = isTestingSupport ? 6 
        : distToEma21Pct <= -0.8 ? 20 
        : distToEma21Pct <= -0.3 ? 12 : 0;
      checkpoints.push({
        id: 'cp-p1-breakdown-structure',
        name: '4H 21 EMA Structural Breakdown',
        requiredRule: 'Price below 4H 21 EMA (<= -0.5%) without resting on 4H support',
        currentValue: isTestingSupport 
          ? `Testing 4H Support (${distToEma21Pct}% vs 21 EMA $${ema21_4h})`
          : `${distToEma21Pct}% below 4H 21 EMA ($${ema21_4h})`,
        passed: p1Passed,
        weight: 20,
        earnedScore: p1Score,
        pillarCategory: 'STRUCTURE',
        explanation: isTestingSupport
          ? `Price is actively resting on the 4H support floor. Breakdown short is unconfirmed while support holds.`
          : p1Passed
          ? `Confirmed structural breakdown: price lost 4H 21 EMA support and is pressing downward.`
          : `Price is still clinging to the 4H 21 EMA (${distToEma21Pct}%). Breakdown unconfirmed.`
      });

      const p2Passed = micro.consecutiveRedHours >= 1 || (!micro.currentHourGreen && micro.hourlyChangePct < 0);
      const p2Score = micro.consecutiveRedHours >= 2 ? 20 : (micro.consecutiveRedHours >= 1 || !micro.currentHourGreen) ? 14 : 0;
      checkpoints.push({
        id: 'cp-p2-breakdown-micro',
        name: 'Consecutive Red Hourly Impulses',
        requiredRule: 'At least 1-2 consecutive red 1H candles confirmed',
        currentValue: `${micro.consecutiveRedHours} Red Hours (${micro.hourlyChangePct}% this hour)`,
        passed: p2Passed,
        weight: 20,
        earnedScore: p2Score,
        pillarCategory: 'MICRO_1H',
        explanation: p2Passed
          ? `Continuous downward selling impulse confirmed with ${micro.consecutiveRedHours} consecutive red 1H candles.`
          : `Active candle has flipped green, indicating possible dip buying or false breakdown.`
      });

      const whaleNet = orderFlow.whale?.whaleNetDeltaUSD || 0;
      const p3Passed = whaleNet < 0 || orderFlow.sellRatioPct >= 51.0;
      const p3Score = (whaleNet < 0 && orderFlow.sellRatioPct >= 51.5) ? 20
        : (orderFlow.netDeltaUSD < 0 || orderFlow.sellRatioPct >= 50.5) ? 12 : 0;
      checkpoints.push({
        id: 'cp-p3-breakdown-whale',
        name: 'Sell Pressure (estimated)',
        requiredRule: 'Est. large-order sell ratio >= 51.0% & negative est. delta',
        currentValue: `Est. large-order: ${whaleNet >= 0 ? '+' : ''}${formatCashUSD(whaleNet)} | Sell: ${orderFlow.sellRatioPct}% (${formatOrderFlowUSD(orderFlow.netDeltaUSD)})`,
        passed: p3Passed,
        weight: 20,
        earnedScore: p3Score,
        pillarCategory: 'WHALE_FLOW',
        explanation: p3Passed
          ? `Estimated selling is dominant (est. ${orderFlow.sellRatioPct}% sell volume / ${formatCashUSD(whaleNet)} est. large-order delta).`
          : `Estimated sell pressure is not dominant.`
      });

      const isBreakdownConfirmed = (distToEma21Pct <= -0.5 || change24h <= -1.5) && !isTestingSupport;
      const p4Passed = isBreakdownConfirmed && (dailyTrend !== 'BULLISH' || fourHourStructure === 'BREAKDOWN' || distToEma21Pct <= -0.8);
      const p4Score = isTestingSupport ? 6 
        : (confluenceRating === 'A+' || confluenceRating === 'A' || dailyTrend === 'BEARISH' || distToEma21Pct <= -1.0) ? 20 
        : (confluenceRating === 'B' || fourHourStructure === 'BREAKDOWN') ? 16 : 10;
      checkpoints.push({
        id: 'cp-p4-breakdown-confluence',
        name: 'Multi-Timeframe Breakdown & Relative Weakness',
        requiredRule: '4H/1D Structural Breakdown & Independent Relative Weakness',
        currentValue: `1D: ${dailyTrend} | 4H: ${fourHourStructure} | 21 EMA: ${distToEma21Pct}%`,
        passed: p4Passed,
        weight: 20,
        earnedScore: p4Score,
        pillarCategory: 'MTA_CONFLUENCE',
        explanation: isTestingSupport
          ? `Price is actively testing support; cannot confirm breakdown until support floor fails.`
          : p4Passed
          ? `Independent relative weakness confirmed: structural breakdown in effect across intermediate and macro charts.`
          : `Higher timeframe trend remains bullish, cautioning against aggressive breakdown shorts.`
      });

      const p5Passed = rewardRiskRatio >= 1.7;
      const p5Score = rewardRiskRatio >= 1.8 ? 20 : rewardRiskRatio >= 1.4 ? 12 : 6;
      checkpoints.push({
        id: 'cp-p5-breakdown-geometry',
        name: 'Breakdown Downside Reward-to-Risk',
        requiredRule: 'Reward-to-Risk >= 1.7:1 to Next Support Floor',
        currentValue: `R:R ${rewardRiskRatio}:1 | Stop +${stopLossPct}% ($${stopLossPrice}) | Tier 1 -${tier1Pct}% ($${tier1Price})`,
        passed: p5Passed,
        weight: 20,
        earnedScore: p5Score,
        pillarCategory: 'TRADE_GEOMETRY',
        explanation: p5Passed
          ? `Asymmetric breakdown target offering ${rewardRiskRatio}:1 R:R to the next major demand floor.`
          : `Downside R:R (${rewardRiskRatio}:1) is insufficient.`
      });

      aiRationale = `${coin.name} has broken below its 4H 21 EMA ($${ema21_4h}) with ${orderFlow.sellRatioPct}% taker sell volume and ${micro.consecutiveRedHours} consecutive red 1H candles. Downside momentum is accelerating toward $${tier1Price} with ${rewardRiskRatio}:1 R:R.`;
      recommendedAction = `Enter SHORT at $${price}. Stop Loss at $${stopLossPrice} (+${stopLossPct}%) and harvest Tier 1 Take Profit at $${tier1Price} (-${tier1Pct}%).`;
    }

    const pillarScores: PillarScores = {
      structure: checkpoints[0]?.earnedScore || 0,
      micro1h: checkpoints[1]?.earnedScore || 0,
      whaleOrderFlow: checkpoints[2]?.earnedScore || 0,
      mtaConfluence: checkpoints[3]?.earnedScore || 0,
      tradeGeometry: checkpoints[4]?.earnedScore || 0,
    };

    let signalScore = pillarScores.structure + pillarScores.micro1h + pillarScores.whaleOrderFlow + pillarScores.mtaConfluence + pillarScores.tradeGeometry;
    
    if (isBleedingKnife) {
      signalScore = Math.min(signalScore, 68);
    }

    if (direction === 'SHORT' && !isBtc) {
      if (price > dailyMa7 && dailyTrend === 'BULLISH' && !isCeilingBlocked) {
        signalScore = Math.min(signalScore, 48);
      }
    }

    const passedCheckpointsCount = checkpoints.filter(c => c.passed).length;
    const isSellerDumpingTrap = orderFlow.buyRatioPct <= 38.0 || orderFlow.orderFlowState === 'HEAVY_DISTRIBUTION';
    const isCeilingTrap = orderFlow.isCeilingExhaustionTrap;
    
    let status: EntrySignalStatus = 'WATCHLIST';
    let executionDecision: ExecutionDecision = 'WATCHLIST_ONLY';
    let disqualificationReason: string | undefined = undefined;

    const isMtaDisqualified = confluenceRating === 'DISQUALIFIED';
    const isRegimeHostile = direction === 'LONG' 
      ? (!isBtc && !macroGate.allowsAltcoinEntries)
      : (!isBtc && macroGate.allowsAltcoinShorts === false);

    // Symmetrical 90+ Conviction Gate for Decoupled Leaders:
    // If macro is hostile (BTC falling/pulling back), an altcoin can still be longed ONLY if it proves 90+ elite conviction
    const isDecoupledLongLeader = direction === 'LONG' &&
      isRegimeHostile &&
      signalScore >= 90 &&
      passedCheckpointsCount >= 4 &&
      (confluenceRating === 'A+' || confluenceRating === 'A') &&
      orderFlow.netDeltaUSD > 0 &&
      microConfirmation.isGreenReversal &&
      !isCeilingBlocked &&
      !isCeilingTrap &&
      !isSellerDumpingTrap &&
      !isBleedingKnife;

    if (isMtaDisqualified) {
      status = 'REJECTED';
      signalScore = 0;
      executionDecision = 'WATCHLIST_ONLY';
      disqualificationReason = direction === 'LONG'
        ? 'Higher timeframe trend is bearish or in 4H structural breakdown. Long setups strictly disqualified.'
        : 'Asset is in a strong macro uptrend with expanding higher highs. Short setups disqualified.';
      aiRationale = `[HARD GATE REJECTED] ${disqualificationReason} Confluence rating is DISQUALIFIED. Signal score zeroed (0/100).`;
    } else if (isRegimeHostile && !isDecoupledLongLeader) {
      if (direction === 'LONG' && signalScore >= 70 && !isCeilingBlocked && !isSellerDumpingTrap) {
        status = 'FORMING';
        executionDecision = 'WAIT_CONFIRMATION';
        // Auto-pilot deploys any FORMING signal scoring >= 75 that carries no
        // disqualificationReason. Without one here, the "90+ during a BTC
        // pullback" gate was bypassed and these deployed at 75.
        disqualificationReason = `BTC pullback: altcoin longs need a 90+ score (currently ${signalScore}).`;
        aiRationale = `[Long Forming - Awaiting 90+ Conviction in Pullback] Current score is ${signalScore}/100. During a BTC pullback, the system enforces a strict 90+ conviction gate to prevent getting trapped by the majors.`;
      } else {
        status = 'INHIBITED';
        signalScore = Math.min(signalScore, 40);
        executionDecision = 'REJECT_HOSTILE_REGIME';
        disqualificationReason = direction === 'LONG'
          ? (macroGate.blockReason || 'BTC Macro Gate locked. Altcoin long entries inhibited.')
          : 'Short entries temporarily paused by macro volatility risk.';
        aiRationale = `[REGIME GATE INHIBITED] ${disqualificationReason} Capital preserved in liquid cash. Requires 90+ score to decouple.`;
      }
    } else if (direction === 'LONG') {
      if (isDecoupledLongLeader) {
        status = 'TRIGGERED';
        executionDecision = 'TRADE_TRIGGERED';
        aiRationale = `[90+ Decoupled Leader Triggered] Exceptional relative strength (${signalScore}/100) defying macro BTC pullback with A-grade confluence and dominant buyer order flow.`;
      } else if (mode === 'FUTURES_1_2D' && isCeilingBlocked) {
        status = 'WATCHLIST';
        executionDecision = 'WAIT_CONFIRMATION';
        aiRationale = `[Binance Futures Ceiling Blocked] Price ($${price}) is pinned within ${distToResistancePct}% of overhead resistance (${resistanceType === 'DAILY_MA7' ? `Daily MA7 $${dailyMa7}` : `24h High $${overheadResistancePrice}`}). High rejection probability; long trigger withheld.`;
      } else if (isCeilingTrap) {
        status = 'WATCHLIST';
        executionDecision = 'WAIT_CONFIRMATION';
        aiRationale = `[Trapped Buyer Supply Ceiling] Price is pinned in top ${(100 - rangeLocationPct).toFixed(0)}% of 24h range ($${price} vs 24h high $${high24h}). Upward headroom exhausted. Trade trigger withheld.`;
      } else if (isSellerDumpingTrap) {
        status = 'WATCHLIST';
        executionDecision = 'WAIT_CONFIRMATION';
        aiRationale = `[Order Flow Inflow Block] Heavy active seller distribution (${orderFlow.sellRatioPct}% Sell volume / ${formatOrderFlowUSD(orderFlow.netDeltaUSD)} Delta) blocks trade trigger.`;
      } else if (isBleedingKnife || !microConfirmation.isGreenReversal) {
        if (signalScore >= 55) {
          status = 'STAGING_AT_SUPPORT';
          executionDecision = 'WAIT_CONFIRMATION';
          aiRationale = `[STAGING AT SUPPORT - Awaiting Green Reversal] ${aiRationale} Price is resting near support, but active 1-hour candles are red (${micro.consecutiveRedHours} red hours). Execution trigger held in STAGING until a green 15m/1h candle prints.`;
        } else {
          status = 'WATCHLIST';
          executionDecision = 'WATCHLIST_ONLY';
        }
      } else {
        if (signalScore >= 85 && passedCheckpointsCount >= 4 && (confluenceRating === 'A+' || confluenceRating === 'A') && orderFlow.netDeltaUSD >= 0 && microConfirmation.isGreenReversal) {
          status = 'TRIGGERED';
          executionDecision = 'TRADE_TRIGGERED';
        } else if (signalScore >= 65) {
          status = 'FORMING';
          executionDecision = 'WAIT_CONFIRMATION';
        } else if (signalScore >= 45) {
          status = 'WATCHLIST';
          executionDecision = 'WATCHLIST_ONLY';
        } else {
          status = 'INHIBITED';
          executionDecision = 'WATCHLIST_ONLY';
        }
      }
    } else {
      if (mode === 'FUTURES_1_2D' && !isCeilingBlocked && price > dailyMa7 && rangeLocationPct < 60) {
        status = 'WATCHLIST';
        executionDecision = 'WAIT_CONFIRMATION';
        aiRationale = `[Short Entry Awaiting Retest] Price is above Daily MA(7) with no resistance ceiling confirmation. Waiting for retest or upper wick rejection.`;
      } else if (
        signalScore >= 90 && 
        passedCheckpointsCount >= 4 && 
        (confluenceRating === 'A+' || confluenceRating === 'A') && 
        (micro.consecutiveRedHours >= 1 || !micro.currentHourGreen || mode === 'FUTURES_1_2D' || orderFlow.sellRatioPct >= 50.0)
      ) {
        status = 'TRIGGERED';
        executionDecision = 'TRADE_TRIGGERED';
        aiRationale = `[90+ High-Conviction Short Triggered] High-conviction bearish setup (${signalScore}/100) confirmed with A-grade confluence, resistance rejection, and active seller order flow.`;
      } else if (signalScore >= 70) {
        status = 'FORMING';
        executionDecision = 'WAIT_CONFIRMATION';
        aiRationale = `[Short Forming - Awaiting 90+ Conviction] Current setup score is ${signalScore}/100. System enforces strict 90+ conviction threshold for altcoin shorts to prevent over-shorting.`;
      } else if (signalScore >= 45) {
        status = 'WATCHLIST';
        executionDecision = 'WATCHLIST_ONLY';
      } else {
        status = 'INHIBITED';
        executionDecision = 'WATCHLIST_ONLY';
      }
    }

    const stability = getOrUpdateSignalPersistence(coin.id, signalScore);

    return {
      levelGate,
      id: `signal-${coin.id}`,
      coinId: coin.id,
      symbol: coin.symbol.toUpperCase(),
      coinName: coin.name,
      image: coin.image,
      currentPrice: price,
      priceChange24hPct: change24h,
      volume24hUSD: volume,
      direction,
      archetype,
      archetypeName,
      archetypeDescription,
      score: signalScore,
      pillarScores,
      status,
      setupQuality: confluenceRating,
      executionDecision,
      disqualificationReason,
      timeframe: mode === 'FUTURES_1_2D' ? '1-2 Day Binance Futures' : '4-Hour / 1-2W Macro Spot',
      tradingMode: mode,
      futuresContext: {
        tradingMode: mode,
        dailyMa7,
        distToDailyMa7Pct,
        dailyMa25,
        distToDailyMa25Pct,
        ma7Slope,
        overheadResistancePrice,
        distToResistancePct,
        resistanceType,
        suggestedLeverage: mode === 'FUTURES_1_2D' ? '3x - 5x' : '1x Spot',
        liquidationBufferPct: Math.round(stopLossPct * 2.5 * 10) / 10,
        isCeilingBlocked,
        rejectionZoneName: resistanceType === 'DAILY_MA7' ? 'Binance Daily MA(7) Yellow Line' : '24h High Resistance Wall',
      },
      directionalConviction: {
        bullishScore: bullConviction,
        bearishScore: bearConviction,
        bias: directionalBias,
        primaryDriver: directionalDriver,
        ma7Slope,
      },
      stability,
      microConfirmation,
      timeframeConfluence: {
        dailyTrend,
        fourHourStructure,
        oneHourImpulse,
        fifteenMinSqueeze,
        fiveMinFlow,
        fourHourAligned,
        oneHourAligned,
        fifteenMinAligned,
        fiveMinAligned,
        alignedCount,
        confluenceRating,
      },
      priceAction: {
        high24h,
        low24h,
        rangeSpreadPct,
        lowerWickAbsorptionPct,
        rangeLocationPct,
        hasAbsorptionWick,
      },
      orderFlow,
      indicators: {
        rsi14: pseudoRsi,
        volumeSurgeRatio,
        distanceToEma21Pct: distToEma21Pct,
        distanceToEma200Pct: distToEma200Pct,
        fourHourEma21: ema21_4h,
        fourHourEma50: ema50_4h,
        dailyEma200: ema200_daily,
        bollingerBandwidthPct: bbWidthPct,
        bollingerUpper,
        bollingerLower,
        bollingerMiddle,
        stagnationDecile,
        atrValue,
        atrPct,
        volatilityClassification,
        momentumState,
      },
      tradePlan: {
        suggestedTrancheUSD,
        suggestedUnits,
        entryPrice: price,
        stopLossPrice,
        stopLossPct,
        riskAmountUSD,
        tier1Price,
        tier1Pct,
        tier1RewardUSD,
        tier2Price,
        tier2Pct,
        tier2RewardUSD,
        tier3TargetPrice,
        tier3Pct,
        rewardRiskRatio,
        breakevenRatchetPrice,
        atrMultiplierStop,
        atrMultiplierTier1,
        atrMultiplierTier2,
        volatilityRating,
      },
      checkpoints,
      aiRationale,
      recommendedAction,
    };
  });

  const scoredSignals = rawSignals.map((sig) => {
    const { qualityScore, highlights } = calculateTradeQualityScore(sig);
    sig.tradeQualityScore = qualityScore;
    sig.topPickHighlights = highlights;
    return sig;
  });

  scoredSignals.sort((a, b) => {
    const diff = (b.tradeQualityScore || (b.score * 10)) - (a.tradeQualityScore || (a.score * 10));
    if (diff !== 0) return diff;
    return (b.orderFlow?.netDeltaUSD || 0) - (a.orderFlow?.netDeltaUSD || 0);
  });

  scoredSignals.forEach((sig, idx) => {
    sig.rankOrder = idx + 1;
    sig.isTopPick = idx === 0 && sig.status === 'TRIGGERED';
  });

  return scoredSignals;
}

export function calculateTradeQualityScore(signal: EntrySignalResult): {
  qualityScore: number;
  highlights: string[];
} {
  const highlights: string[] = [];
  let score = signal.score * 10;

  if (signal.status === 'TRIGGERED') {
    score += 120;
    if (signal.executionDecision === 'TRADE_TRIGGERED') {
      score += 60;
      highlights.push('Trigger Confirmed (Trade Triggered)');
    }
  } else if (signal.status === 'STAGING_AT_SUPPORT') {
    score += 50;
    highlights.push('Staging at Dynamic Support');
  } else if (signal.status === 'FORMING') {
    score += 25;
  }

  const distToRes = signal.futuresContext?.distToResistancePct;
  const isCeilingBlocked = signal.futuresContext?.isCeilingBlocked || signal.orderFlow?.isCeilingExhaustionTrap;
  if (isCeilingBlocked) {
    score -= 160;
  } else if (distToRes !== undefined) {
    if (distToRes < 1.35) {
      score -= 85;
    } else if (distToRes >= 3.0) {
      score += 50;
      highlights.push(`Headroom: ${distToRes.toFixed(1)}% to Ceiling`);
    } else if (distToRes >= 2.0) {
      score += 25;
    }
  }

  const rr = signal.tradePlan.rewardRiskRatio || 2.0;
  if (rr >= 3.0) {
    score += 60;
    highlights.push(`Asymmetric ${rr.toFixed(1)}:1 R:R`);
  } else if (rr >= 2.3) {
    score += 40;
    highlights.push(`Favorable ${rr.toFixed(1)}:1 R:R`);
  } else if (rr >= 1.8) {
    score += 20;
  } else {
    score -= 40;
  }

  if (signal.direction === 'LONG' && signal.futuresContext) {
    const distToMa7 = signal.futuresContext.distToDailyMa7Pct;
    if (distToMa7 >= 0.5 && distToMa7 <= 3.5) {
      score += 50;
      highlights.push(`Prime Floor: ${distToMa7 > 0 ? '+' : ''}${distToMa7.toFixed(1)}% above MA(7) Support`);
    } else if (distToMa7 > 7.0) {
      score -= 45;
    }
  } else if (signal.direction === 'SHORT' && signal.futuresContext) {
    const distToMa7 = signal.futuresContext.distToDailyMa7Pct;
    if (distToMa7 <= -0.5 && distToMa7 >= -3.5) {
      score += 50;
      highlights.push(`Prime Ceiling: ${distToMa7.toFixed(1)}% below MA(7) Overhead`);
    }
  }

  const whaleNet = signal.orderFlow?.whale?.whaleNetDeltaUSD || 0;
  const whaleBuyPct = signal.orderFlow?.whale?.whaleBuyRatioPct || 50;
  const takerBuyPct = signal.orderFlow?.buyRatioPct || 50;
  const takerSellPct = signal.orderFlow?.sellRatioPct || 50;
  const netDelta = signal.orderFlow?.netDeltaUSD || 0;

  if (signal.direction === 'LONG') {
    if (whaleNet >= 300000) {
      score += 60;
      highlights.push(`+$${Math.round(whaleNet / 1000)}K est. large-order inflow (${whaleBuyPct.toFixed(1)}%)`);
    } else if (whaleNet >= 100000) {
      score += 35;
      highlights.push(`+$${Math.round(whaleNet / 1000)}K est. large-order inflow`);
    } else if (whaleNet > 0) {
      score += 15;
    } else if (whaleNet < -100000) {
      score -= 50;
    }

    if (takerBuyPct >= 52.5) {
      score += 40;
      highlights.push(`Taker Buy Dominance (${takerBuyPct.toFixed(1)}%)`);
    } else if (takerBuyPct >= 51.0) {
      score += 20;
    }

    if (netDelta >= 300000) {
      score += 30;
    } else if (netDelta > 0) {
      score += 15;
    }
  } else {
    const whaleSellUSD = signal.orderFlow?.whale?.whaleSellVolumeUSD || 0;
    if (whaleNet <= -200000 || whaleSellUSD > 500000) {
      score += 50;
      highlights.push(`Est. heavy large-order selling`);
    }

    if (takerSellPct >= 52.0) {
      score += 40;
      highlights.push(`Taker Sell Dominance (${takerSellPct.toFixed(1)}%)`);
    }

    if (netDelta < -200000) {
      score += 30;
    }
  }

  const stability = signal.stability;
  if (stability) {
    if (stability.stabilityTier === 'VETERAN_ANCHOR' || stability.isBattleTested) {
      score += 75;
      highlights.push(`Veteran Anchor (${stability.ageMinutes}m Battle-Tested)`);
    } else if (stability.stabilityTier === 'ESTABLISHED') {
      score += 45;
      highlights.push(`Established Signal (${stability.ageMinutes}m)`);
    } else if (stability.stabilityTier === 'RECENT_CONFIRMED') {
      score += 20;
    } else if (stability.stabilityTier === 'JUST_FORMING' && stability.ageMinutes <= 5) {
      score -= 85;
    }

    score += Math.min(25, Math.round(stability.ageMinutes * 0.5));
  }

  if (signal.microConfirmation) {
    if (signal.microConfirmation.isGreenReversal) {
      score += 40;
      highlights.push('Micro 1H Reversal Confirmed');
    } else {
      score -= 130;
    }
  }

  const confluence = signal.timeframeConfluence?.confluenceRating;
  if (confluence === 'A+') {
    score += 45;
    highlights.push('A+ Multi-Timeframe Confluence');
  } else if (confluence === 'A') {
    score += 25;
  } else if (confluence === 'B') {
    score += 10;
  }

  if (signal.directionalConviction) {
    const { bullishScore, bearishScore } = signal.directionalConviction;
    if (signal.direction === 'LONG') {
      score += Math.round(bullishScore * 0.4);
      score -= Math.round(bearishScore * 0.3);
    } else {
      score += Math.round(bearishScore * 0.4);
      score -= Math.round(bullishScore * 0.3);
    }
  }

  if (signal.indicators.volumeSurgeRatio >= 1.35) {
    score += 25;
    highlights.push(`Volume Surge ${signal.indicators.volumeSurgeRatio.toFixed(2)}x`);
  }
  if (signal.priceAction?.lowerWickAbsorptionPct && signal.priceAction.lowerWickAbsorptionPct >= 1.8) {
    score += 25;
    highlights.push(`+${signal.priceAction.lowerWickAbsorptionPct.toFixed(1)}% Wick Absorption`);
  }

  return {
    qualityScore: Math.round(score),
    highlights: highlights.slice(0, 4),
  };
}

export function evaluateMarketRegimeGate(coins: CryptoCoin[]): MarketRegimeGate {
  const btc = coins.find(c => c.symbol.toUpperCase() === 'BTC') || coins[0];
  const btcPrice = btc?.current_price || 0;
  const btcChange24h = btc?.price_change_percentage_24h || 0;
  const btcChange7d = btc?.price_change_percentage_7d_in_currency || 0;

  const btcRsi14 = Math.max(20, Math.min(90, 50 + (btcChange24h * 2.8) + (btcChange7d * 0.9)));
  const btcEma21 = +(btcPrice * (1 - (btcChange24h * 0.003) - 0.008)).toFixed(2);
  const btcEma200 = +(btcPrice * (1 - (btcChange7d * 0.008) - 0.065)).toFixed(2);
  const btcDistToEma21Pct = +(((btcPrice - btcEma21) / btcEma21) * 100).toFixed(2);
  const btcDistToEma200Pct = +(((btcPrice - btcEma200) / btcEma200) * 100).toFixed(2);

  let btcTrendState: 'STRONG_BULL' | 'CONSOLIDATING' | 'HEALTHY_PULLBACK' | 'BREAKDOWN_DUMP' = 'STRONG_BULL';
  let regime: 'RISK_ON_BULLISH' | 'NEUTRAL_CONSOLIDATION' | 'RISK_OFF_DOWNTREND' | 'EXTREME_SELLOFF_DUMP' = 'RISK_ON_BULLISH';
  let allowsAltcoinEntries = true;
  let allowsAltcoinShorts = true;
  let regimeDirectionBias: 'LONGS_FAVORED' | 'SHORTS_FAVORED' | 'SELECTIVE_EITHER' | 'CASH_PREFERRED' = 'LONGS_FAVORED';
  let blockReason: string | undefined = undefined;
  let macroGateScore = 85;

  if (btcChange24h <= -4.0 || btcDistToEma21Pct <= -4.5 || btcRsi14 < 32) {
    btcTrendState = 'BREAKDOWN_DUMP';
    regime = 'EXTREME_SELLOFF_DUMP';
    allowsAltcoinEntries = false;
    allowsAltcoinShorts = true;
    regimeDirectionBias = 'SHORTS_FAVORED';
    blockReason = `BTC Flash Breakdown (${btcChange24h > 0 ? '+' : ''}${btcChange24h.toFixed(2)}% in 24h). Altcoin long entries strictly inhibited to protect capital. High-probability shorts permitted.`;
    macroGateScore = 20;
  } else if (btc?.micro && (btc.micro.consecutiveRedHours >= 2 || btc.micro.hourlyChangePct <= -0.5)) {
    btcTrendState = 'BREAKDOWN_DUMP';
    regime = 'RISK_OFF_DOWNTREND';
    allowsAltcoinEntries = false;
    allowsAltcoinShorts = true;
    regimeDirectionBias = 'SHORTS_FAVORED';
    blockReason = `BTC Lead Bleed Active: Bitcoin has printed ${btc.micro.consecutiveRedHours} consecutive red 1H candles (${btc.micro.hourlyChangePct}% this hour). Altcoin long entries paused until BTC confirms a floor. Shorts favored.`;
    macroGateScore = 35;
  } else if (btcChange24h < -1.5 || btcDistToEma200Pct < -3.0 || btcRsi14 < 44) {
    btcTrendState = 'HEALTHY_PULLBACK';
    regime = 'RISK_OFF_DOWNTREND';
    allowsAltcoinEntries = false;
    allowsAltcoinShorts = true;
    regimeDirectionBias = 'SHORTS_FAVORED';
    blockReason = `BTC in Risk-Off Retracement (${btcDistToEma21Pct.toFixed(2)}% vs 4H EMA). High correlation risk for altcoin longs. Resistance rejections and breakdown shorts favored.`;
    macroGateScore = 40;
  } else if (btcChange24h <= 0 && btcChange24h >= -1.5 && btcRsi14 >= 44 && btcRsi14 <= 55) {
    btcTrendState = 'CONSOLIDATING';
    regime = 'NEUTRAL_CONSOLIDATION';
    allowsAltcoinEntries = true;
    allowsAltcoinShorts = true;
    regimeDirectionBias = 'SELECTIVE_EITHER';
    macroGateScore = 75;
  } else {
    btcTrendState = 'STRONG_BULL';
    regime = 'RISK_ON_BULLISH';
    allowsAltcoinEntries = true;
    allowsAltcoinShorts = true;
    regimeDirectionBias = 'LONGS_FAVORED';
    blockReason = undefined;
    macroGateScore = 95;
  }

  return {
    regime,
    allowsAltcoinEntries,
    allowsAltcoinShorts,
    regimeDirectionBias,
    blockReason,
    btcPrice,
    btcChange24h,
    btcChange7d,
    btcRsi14: +btcRsi14.toFixed(1),
    btcDistToEma21Pct,
    btcDistToEma200Pct,
    btcTrendState,
    macroGateScore,
  };
}

export function calculateScannerSummary(signals: EntrySignalResult[], coins?: CryptoCoin[]): ScannerSummaryStats {
  const totalScanned = signals.length;
  const triggeredCount = signals.filter(s => s.status === 'TRIGGERED').length;
  const formingCount = signals.filter(s => s.status === 'FORMING').length;
  const veteranAnchorsCount = signals.filter(s => s.stability?.isBattleTested || s.stability?.stabilityTier === 'VETERAN_ANCHOR' || s.stability?.stabilityTier === 'ESTABLISHED').length;
  const averageScore = Math.round(signals.reduce((acc, s) => acc + s.score, 0) / (totalScanned || 1));

  const triggeredSignals = signals.filter(s => s.status === 'TRIGGERED');
  const candidatePool = triggeredSignals.length > 0 ? triggeredSignals : signals;
  const sortedPicks = [...candidatePool].sort((a, b) => {
    const diff = (b.tradeQualityScore || (b.score * 10)) - (a.tradeQualityScore || (a.score * 10));
    if (diff !== 0) return diff;
    return (b.orderFlow?.netDeltaUSD || 0) - (a.orderFlow?.netDeltaUSD || 0);
  });

  const topPickSignal = sortedPicks[0] || signals[0];
  const topPickSymbol = topPickSignal?.symbol || 'BTC';

  let marketRegime: 'BULLISH_TREND_EXPANSION' | 'CONSOLIDATION_SQUEEZE' | 'RISK_OFF_DIP' = 'BULLISH_TREND_EXPANSION';
  const avgBw = signals.reduce((acc, s) => acc + s.indicators.bollingerBandwidthPct, 0) / (totalScanned || 1);
  const avgRsi = signals.reduce((acc, s) => acc + s.indicators.rsi14, 0) / (totalScanned || 1);
  if (avgBw < 4.5) {
    marketRegime = 'CONSOLIDATION_SQUEEZE';
  } else if (avgRsi < 44) {
    marketRegime = 'RISK_OFF_DIP';
  }

  const macroGate = coins ? evaluateMarketRegimeGate(coins) : undefined;

  return {
    totalScanned,
    triggeredCount,
    formingCount,
    veteranAnchorsCount,
    averageScore,
    topPickSymbol,
    topPickSignal,
    marketRegime,
    macroGate,
  };
}

export async function deploySignalToAutomatedFeed(
  signal: EntrySignalResult, 
  customTrancheUSD?: number
): Promise<AutomatedTradeRecord> {
  const currentTrades = await fetchAutomatedTrades();

  // Guard: 10 distinct coins constraint (never open duplicate positions on the same coin)
  const isAlreadyOpen = currentTrades.some(
    (t) => t.status === 'OPEN' && t.symbol.toUpperCase() === signal.symbol.toUpperCase()
  );
  if (isAlreadyOpen) {
    throw new Error(
      `An open position for ${signal.symbol} is already active. The 10 bankroll slots are strictly allocated to 10 different coins for portfolio diversification.`
    );
  }

  const bankroll = calculateBankrollState(currentTrades);
  const minRequiredCash = Math.max(1.00, +(bankroll.totalPortfolioValueUSD * 0.07).toFixed(2));
  if (bankroll.liquidCashUSD < minRequiredCash) {
    throw new Error(
      `Remaining balance ($${bankroll.liquidCashUSD.toFixed(2)}) is below the 7% minimum ($${minRequiredCash.toFixed(2)}).`
    );
  }

  const requestedTranche = typeof customTrancheUSD === 'number' && customTrancheUSD > 0
    ? customTrancheUSD
    : bankroll.trancheSizeUSD;
  const baseTrancheUSD = Math.min(requestedTranche, bankroll.liquidCashUSD);

  // Size for constant dollar risk rather than constant notional, so a wide
  // ATR stop takes a smaller position instead of a proportionally bigger loss.
  const sizedUSD = resolvePositionSizeUSD(
    baseTrancheUSD,
    bankroll.totalPortfolioValueUSD,
    signal.tradePlan.stopLossPct
  );
  const trancheUSD = Math.min(sizedUSD, bankroll.liquidCashUSD);

  const currentP = signal.currentPrice;
  const units = currentP > 0 ? +(trancheUSD / currentP).toFixed(currentP < 0.01 ? 2 : 6) : 0.1;
  const plan = signal.tradePlan;

  const tradeRecord: AutomatedTradeRecord = {
    id: `trade-scan-${signal.coinId}-${Date.now()}`,
    category: 'investment',
    type: signal.archetype === 'MEAN_REVERSION_DIP' ? 'MEAN_REVERSION_DIP' 
      : signal.archetype === 'VOLATILITY_SQUEEZE' ? 'VOLATILITY_EXPANSION_1W' 
      : (signal.archetype === 'BEARISH_RESISTANCE_REJECTION' || signal.archetype === 'BEARISH_EMA_BREAKDOWN') ? 'BEARISH_ROTATION_SHORT'
      : 'SHORT_TERM_HARVEST_1W',
    direction: signal.direction || 'LONG',
    coinId: signal.coinId,
    symbol: signal.symbol,
    coinName: signal.coinName,
    coinImage: signal.image,
    action: signal.direction === 'SHORT' ? 'SELL' : 'BUY',
    status: 'OPEN',
    entryPrice: currentP,
    currentPrice: currentP,
    entryDate: 'Just now (Live Scan Entry)',
    openedAtTimestamp: Date.now(),
    sessionHighPrice: currentP,
    sessionLowPrice: currentP,
    mfePct: 0,
    maePct: 0,
    mfeUSD: 0,
    maeUSD: 0,
    marketRegimeAtEntry: signal.tradingMode || 'FUTURES_1_2D',
    btcTrendAtEntry: signal.timeframeConfluence?.dailyTrend || 'NEUTRAL',
    totalFeesUSD: +sideCostUSD(trancheUSD).toFixed(4),   // entry side; exits add their own in cycleEngineService
    holdingPeriodDays: 1,
    numericalCycleMetrics: {
      momentumVelocityScore: signal.score,
      momentumState: signal.indicators.momentumState === 'ACCELERATING' ? 'ACCELERATING' : 'HEALTHY_IMPULSE',
      volumeLiquidityRatio: +(signal.indicators.volumeSurgeRatio * 20).toFixed(1),
      volumeState: signal.indicators.volumeSurgeRatio >= 1.2 ? 'EXPANDING' : 'NORMAL',
      stagnationDecile: signal.indicators.stagnationDecile,
      stagnationThreshold: 7.5,
      fourHourEmaFloor: signal.indicators.fourHourEma21,
      atrTrailingFloorValue: roundPrice(currentP - signal.indicators.atrValue * 1.5),
      dynamicExitFloor: signal.indicators.fourHourEma21,
      cycleCompletionPct: 10,
      cycleStatusSummary: `Entry triggered via ${signal.archetypeName} (Score: ${signal.score}/100). First target armed at $${plan.tier1Price}.`
    },
    units,
    positionSizeUSD: trancheUSD,
    realizedCashBankedUSD: 0,
    takeProfitPrice: plan.tier3TargetPrice,
    takeProfitPct: plan.tier3Pct,
    stopLossPrice: plan.stopLossPrice,
    stopLossPct: -plan.stopLossPct,
    harvestTiers: {
      tier1: {
        percent: 33,
        targetPct: plan.tier1Pct,
        targetPrice: plan.tier1Price,
        status: 'PENDING'
      },
      tier2: {
        percent: 33,
        targetPct: plan.tier2Pct,
        targetPrice: plan.tier2Price,
        status: 'PENDING'
      },
      tier3: {
        percent: 34,
        targetPct: plan.tier3Pct,
        targetPrice: plan.tier3TargetPrice,
        status: 'PENDING'
      }
    },
    ratchet: {
      isArmed: false,
      triggerPct: plan.tier1Pct,
      floorPrice: plan.breakevenRatchetPrice,
      currentProtection: 'INITIAL_DEFENSE',
      floorBufferPct: 0.4
    },
    atrTrailingFloor: roundPrice(currentP - signal.indicators.atrValue * 1.5),
    atrValue: signal.indicators.atrValue,
    atrPct: signal.indicators.atrPct,
    bollingerUpper: signal.indicators.bollingerUpper,
    bollingerLower: signal.indicators.bollingerLower,
    volatilityBand: signal.indicators.volatilityClassification,
    entrySignals: {
      sentimentScore: Math.round(signal.indicators.rsi14),
      sentimentLabel: signal.indicators.rsi14 >= 60 ? 'Greed' : signal.indicators.rsi14 <= 40 ? 'Fear' : 'Neutral',
      rsi14: signal.indicators.rsi14,
      volumeSurgePct: Math.round(signal.indicators.volumeSurgeRatio * 100),
      distanceFromEma200Pct: signal.indicators.distanceToEma200Pct,
      timingScore: signal.score,
      triggerSummary: `Scanner Trigger: ${signal.archetypeName} (Score ${signal.score}/100). Checkpoints passed: ${signal.checkpoints.filter(c => c.passed).length}/${signal.checkpoints.length}.`
    },
    pnlUSD: 0,
    pnlPercentage: 0,
    lessonTitle: `$${trancheUSD.toFixed(2)} Entry: ${signal.symbol} (${signal.archetypeName})`,
    lessonConcept: `Quantitative Signal Execution: ${signal.archetypeName}`,
    lessonExplanation: signal.aiRationale,
    keyTakeaway: `Systematic entries wait for mathematical checkpoint confirmation (${signal.checkpoints.filter(c => c.passed).length}/${signal.checkpoints.length} passed) rather than emotional FOMO.`,
    investingPerspective: 'Systematic 1-2W cycle entries allow continuous capital rotation across whichever asset class currently presents the highest risk-adjusted setup.',
    tradingPerspective: `Risk capped at $${plan.riskAmountUSD.toFixed(2)} (${plan.stopLossPct}%) with +${plan.tier1Pct}% Tier 1 harvest locking in profit and eliminating remaining risk.`,
    chartHistory: [
      { date: '4H-3', price: roundPrice(currentP * 0.97), sentiment: 50, volume: 40, sma50: roundPrice(currentP * 0.95) },
      { date: '4H-2', price: roundPrice(currentP * 0.98), sentiment: 55, volume: 55, sma50: roundPrice(currentP * 0.96) },
      { date: '4H-1', price: roundPrice(currentP * 0.99), sentiment: 60, volume: 75, sma50: roundPrice(currentP * 0.97) },
      { date: 'Now', price: currentP, sentiment: Math.round(signal.indicators.rsi14), volume: Math.round(signal.indicators.volumeSurgeRatio * 50), sma50: roundPrice(currentP * 0.975) },
    ]
  };

  const executed = await executeSimulatedTrade(tradeRecord);
  if (!executed) {
    throw new Error('All 10 bankroll slots are currently occupied. Cannot open more positions.');
  }
  return tradeRecord;
}
