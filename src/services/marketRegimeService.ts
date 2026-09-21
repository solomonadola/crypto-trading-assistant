import { CryptoCoin } from '../types';
import { EntrySignalResult } from '../types/entryScanner';
import { AutomatedTradeRecord } from '../types/automatedFeed';

export interface BtcMacroRegime {
  btcPrice: number;
  btc24hChangePct: number;
  status: 'BULLISH_EXPANSION' | 'HEALTHY_CONSOLIDATION' | 'NEUTRAL_CHOP' | 'DEFENSIVE_PULLBACK' | 'HEAVY_DUMP';
  safetyRating: 'SAFE_FOR_LONGS' | 'CAUTION_REDUCED_RISK' | 'LOCK_ALL_LONGS';
  rationale: string;
  allowNewLongs: boolean;
  recommendedMaxExposurePct: number;
}

export interface AutoPilotCandidateRank {
  signal: EntrySignalResult;
  rank: number;
  convictionScore: number;
  rewardRiskRatio: number;
  archetype: string;
  category: string;
  isEligibleNow: boolean;
  rejectionReason?: string;
}

export interface AutoPilotHUDState {
  isAutoPilotOn: boolean;
  openSlotsUsed: number;
  totalSlots: number;
  freeSlots: number;
  trancheSizeUSD: number;
  btcRegime: BtcMacroRegime;
  categoryExposure: Record<string, number>;
  topCandidates: AutoPilotCandidateRank[];
  nextDeployActionSummary: string;
}

/**
 * Calculates real-time BTC Macro Regime to protect altcoin positions against market flash crashes.
 */
export function evaluateBtcMacroRegime(coins: CryptoCoin[]): BtcMacroRegime {
  const btc = coins.find((c) => c.symbol.toUpperCase() === 'BTC');
  const btcPrice = btc?.current_price || 0;
  const btcChange = btc?.price_change_percentage_24h ?? 0;
  const btcHourly = btc?.micro?.hourlyChangePct ?? 0;

  if (btcHourly < -2.2 || btcChange < -6.5) {
    return {
      btcPrice,
      btc24hChangePct: btcChange,
      status: 'HEAVY_DUMP',
      safetyRating: 'LOCK_ALL_LONGS',
      rationale: `Bitcoin experiencing aggressive sell-off (${btcChange.toFixed(1)}% 24h, ${btcHourly.toFixed(1)}% 1h). Altcoin Long entries strictly paused to prevent stop-outs.`,
      allowNewLongs: false,
      recommendedMaxExposurePct: 30
    };
  }

  if (btcHourly < -1.0 || btcChange < -3.0) {
    return {
      btcPrice,
      btc24hChangePct: btcChange,
      status: 'DEFENSIVE_PULLBACK',
      safetyRating: 'CAUTION_REDUCED_RISK',
      rationale: `Bitcoin pulling back (${btcChange.toFixed(1)}%). Only top A+ setups (Score ≥ 85) allowed.`,
      allowNewLongs: true,
      recommendedMaxExposurePct: 60
    };
  }

  if (btcChange >= 2.0 && btcHourly >= 0) {
    return {
      btcPrice,
      btc24hChangePct: btcChange,
      status: 'BULLISH_EXPANSION',
      safetyRating: 'SAFE_FOR_LONGS',
      rationale: `Bitcoin in strong upward impulse (+${btcChange.toFixed(1)}%). Optimal environment for altcoin trend setups.`,
      allowNewLongs: true,
      recommendedMaxExposurePct: 100
    };
  }

  return {
    btcPrice,
    btc24hChangePct: btcChange,
    status: 'HEALTHY_CONSOLIDATION',
    safetyRating: 'SAFE_FOR_LONGS',
    rationale: `Bitcoin consolidating stably (${btcChange >= 0 ? '+' : ''}${btcChange.toFixed(1)}%). Normal selective deployments active.`,
    allowNewLongs: true,
    recommendedMaxExposurePct: 100
  };
}

/**
 * Computes category diversification to prevent opening too many coins in the same sector.
 * Rule: Max 3 of the same category (e.g. Meme, Layer 1) active simultaneously.
 */
export function calculateCategoryExposure(openTrades: AutomatedTradeRecord[], coins: CryptoCoin[]): Record<string, number> {
  const coinMap = new Map(coins.map(c => [c.symbol.toUpperCase(), c.category || 'Layer 1']));
  const counts: Record<string, number> = {};

  for (const t of openTrades) {
    const cat = coinMap.get(t.symbol.toUpperCase()) || 'Layer 1';
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return counts;
}

export type LiquidityZone = 'HIGH_POWER' | 'MODERATE' | 'DEAD_ZONE' | 'WEEKEND_CHOP';

export interface LiquiditySessionInfo {
  sessionName: string;
  zone: LiquidityZone;
  utcTimeStr: string;
  isWeekend: boolean;
  isDeadZone: boolean;
  badgeLabel: string;
  badgeColor: string;
  description: string;
}

/**
 * Calculates current global financial trading session in UTC time.
 * Identifies high-liquidity overlap windows and dangerous dead zones/weekends.
 */
export function evaluateLiquiditySession(date: Date = new Date()): LiquiditySessionInfo {
  const dayOfWeek = date.getUTCDay(); // 0 is Sunday, 6 is Saturday
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const utcTimeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} UTC`;

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      sessionName: 'Weekend Lull (CME / ETFs Closed)',
      zone: 'WEEKEND_CHOP',
      utcTimeStr,
      isWeekend: true,
      isDeadZone: true,
      badgeLabel: 'Weekend Chop Trap',
      badgeColor: 'amber',
      description: 'Wall St & CME closed. Binance volume is 40-60% lower. High fakeout / wick risk.'
    };
  }

  // Monday - Friday UTC sessions
  if (hours >= 13 && (hours < 16 || (hours === 16 && minutes <= 30))) {
    return {
      sessionName: 'London & NY Overlap (Peak Daily Liquidity)',
      zone: 'HIGH_POWER',
      utcTimeStr,
      isWeekend: false,
      isDeadZone: false,
      badgeLabel: 'Peak Liquidity',
      badgeColor: 'emerald',
      description: 'Both European and American desks active. Maximum volume & reliable breakout follow-through.'
    };
  }

  if (hours >= 13 && hours < 21) {
    return {
      sessionName: 'US / New York Session (NYSE Active)',
      zone: 'HIGH_POWER',
      utcTimeStr,
      isWeekend: false,
      isDeadZone: false,
      badgeLabel: 'US Session (High Vol)',
      badgeColor: 'emerald',
      description: 'Wall Street & Spot ETF desks trading actively. Strong institutional trend continuation.'
    };
  }

  if (hours >= 7 && hours < 13) {
    return {
      sessionName: 'London / Europe Open',
      zone: 'HIGH_POWER',
      utcTimeStr,
      isWeekend: false,
      isDeadZone: false,
      badgeLabel: 'London Session',
      badgeColor: 'emerald',
      description: 'European institutions trading morning flows. Strong directional trend setup.'
    };
  }

  if (hours >= 21 || hours < 0) {
    return {
      sessionName: 'Evening Dead Gap (21:00 - 00:00 UTC)',
      zone: 'DEAD_ZONE',
      utcTimeStr,
      isWeekend: false,
      isDeadZone: true,
      badgeLabel: 'Dead Zone Gap',
      badgeColor: 'rose',
      description: 'US markets closed, Asia not yet open. Thin order books and high false breakout risk.'
    };
  }

  return {
    sessionName: 'Asia Session (Tokyo / Singapore / HK)',
    zone: 'MODERATE',
    utcTimeStr,
    isWeekend: false,
    isDeadZone: false,
    badgeLabel: 'Asia Session',
    badgeColor: 'blue',
    description: 'Asian financial centers active. Moderate liquidity with selective range trading.'
  };
}

export interface MarketActivityRadar {
  activityLevel: 'HIGH_MOMENTUM' | 'NORMAL_ACTIVE' | 'QUIET_CHOP';
  avgVolatilityPct: number;
  activePairsCount: number;
  isConsolidationLocked: boolean;
  liquiditySession: LiquiditySessionInfo;
  badgeLabel: string;
  badgeColor: string;
  rationale: string;
  guidance: string;
}

/**
 * Evaluates market-wide trading activity and volume liquidity.
 * Detects quiet chop/stagnation periods and enforces Strict Consolidation Lock (<2.0% volatility).
 */
export function evaluateMarketActivityRadar(coins: CryptoCoin[]): MarketActivityRadar {
  const session = evaluateLiquiditySession();

  const validCoins = coins.filter((c) => c.current_price && c.current_price > 0);
  if (!validCoins || validCoins.length === 0) {
    return {
      activityLevel: 'QUIET_CHOP',
      avgVolatilityPct: 0.8,
      activePairsCount: 0,
      isConsolidationLocked: true,
      liquiditySession: session,
      badgeLabel: 'Consolidation Locked (<2.0%)',
      badgeColor: 'blue',
      rationale: 'Connecting to live Binance exchange feed. Auto-Pilot sitting 100% in cash.',
      guidance: 'Preserving capital. Waiting for live exchange ticker confirmation.'
    };
  }

  // Calculate average absolute 24h volatility across tracked coins with live exchange prices
  const changes = validCoins.map(c => Math.abs(c.price_change_percentage_24h || 0));
  const avgVol = +(changes.reduce((a, b) => a + b, 0) / changes.length).toFixed(1);

  // Coins with > 3% movement in 24h
  const activeCoins = validCoins.filter(c => Math.abs(c.price_change_percentage_24h || 0) >= 3.0);

  // Strict Consolidation Lock trigger:
  // Triggered if average 24h market volatility is below 2.0% OR fewer than 3 active coins moving
  const isConsolidationLocked = avgVol < 2.0 || activeCoins.length <= 2;

  if (isConsolidationLocked) {
    return {
      activityLevel: 'QUIET_CHOP',
      avgVolatilityPct: avgVol,
      activePairsCount: activeCoins.length,
      isConsolidationLocked: true,
      liquiditySession: session,
      badgeLabel: 'Consolidation Lock (<2.0%)',
      badgeColor: 'blue',
      rationale: `Sideways compression (avg ±${avgVol}%, only ${activeCoins.length}/18 pairs moving). Market lacks breakout follow-through.`,
      guidance: '100% Cash Defense: Strict Consolidation Lock active. Auto-Pilot will not fire trades until volatility expands.'
    };
  }

  if (avgVol >= 4.5 || activeCoins.length >= 8) {
    return {
      activityLevel: 'HIGH_MOMENTUM',
      avgVolatilityPct: avgVol,
      activePairsCount: activeCoins.length,
      isConsolidationLocked: false,
      liquiditySession: session,
      badgeLabel: 'High Momentum',
      badgeColor: 'emerald',
      rationale: `Strong market-wide volatility (avg ±${avgVol}%). High breakout liquidity across ${activeCoins.length} pairs.`,
      guidance: 'Optimal trend expansion. Fast tier harvesting active.'
    };
  }

  return {
    activityLevel: 'NORMAL_ACTIVE',
    avgVolatilityPct: avgVol,
    activePairsCount: activeCoins.length,
    isConsolidationLocked: false,
    liquiditySession: session,
    badgeLabel: 'Normal Activity',
    badgeColor: 'emerald',
    rationale: `Balanced market liquidity (avg ±${avgVol}%). Healthy selective rotation across pairs.`,
    guidance: 'Standard A+ setup scanning active.'
  };
}

export interface RecentLossCircuitBreaker {
  isTripped: boolean;
  recentLossesCount: number;
  recentLossUSD: number;
  cooldownUntil: number;
  minutesRemaining: number;
  reason: string;
}

/**
 * Loss Streak Circuit Breaker (Anti-Chop Dampener):
 * Detects if 2+ trades stopped out within the last 2 hours.
 * Automatically engages a 60-minute protective throttle to stop bleeding during choppy markets.
 */
export function evaluateRecentLossCircuitBreaker(trades: AutomatedTradeRecord[]): RecentLossCircuitBreaker {
  const now = Date.now();
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;

  // Filter closed trades in the last 2 hours that resulted in a loss
  const recentLosses = trades.filter((t) => {
    if (t.status === 'OPEN') return false;
    const closedAt = t.closedAtTimestamp || (t.openedAtTimestamp ? t.openedAtTimestamp + 3600000 : 0);
    const isRecent = closedAt >= twoHoursAgo;
    const isLoss = (t.pnlUSD !== undefined && t.pnlUSD < -0.05) || t.exitReason === 'STOP_LOSS_HIT';
    return isRecent && isLoss;
  }).sort((a, b) => (b.closedAtTimestamp || 0) - (a.closedAtTimestamp || 0));

  const count = recentLosses.length;
  const totalLossUSD = +(recentLosses.reduce((acc, t) => acc + Math.abs(t.pnlUSD || 0), 0)).toFixed(2);

  // If 2 or more losses within the 2-hour window, trip the circuit breaker
  if (count >= 2) {
    const mostRecentTimestamp = recentLosses[0]?.closedAtTimestamp || now;
    const cooldownDurationMs = 60 * 60 * 1000; // 60 minutes
    const cooldownUntil = mostRecentTimestamp + cooldownDurationMs;
    const minutesRemaining = Math.max(0, Math.round((cooldownUntil - now) / 60000));

    if (minutesRemaining > 0) {
      return {
        isTripped: true,
        recentLossesCount: count,
        recentLossUSD: totalLossUSD,
        cooldownUntil,
        minutesRemaining,
        reason: `Loss Streak Dampener Active: ${count} stop-outs in last 2h (-$${totalLossUSD.toFixed(2)}). Market is in a chop whipsaw trap. Auto-Pilot paused for ${minutesRemaining}m to preserve capital.`
      };
    }
  }

  return {
    isTripped: false,
    recentLossesCount: count,
    recentLossUSD: totalLossUSD,
    cooldownUntil: 0,
    minutesRemaining: 0,
    reason: count === 1 
      ? `1 isolated stop-out in last 2h (-$${totalLossUSD.toFixed(2)}). Well within normal 10-slot variance.`
      : `Zero stop-outs in last 2h. System operating in optimal win regime.`
  };
}

export type AutoPilotPacingState = 
  | 'SLOTS_FULL'
  | 'LOSS_STREAK_COOLDOWN'
  | 'BTC_ARMOR_PAUSE'
  | 'CONSOLIDATION_LOCK'
  | 'QUIET_CHOP_PATIENT'
  | 'SCANNING_FOR_A_PLUS'
  | 'AUTO_PILOT_OFF';

export interface AutoPilotPacingInfo {
  state: AutoPilotPacingState;
  headline: string;
  badge: string;
  badgeColor: string;
  explanation: string;
  isDeployingAllowed: boolean;
}

/**
 * Computes exact reason for trade pacing so user understands why trades are (or aren't) executing.
 */
export function getAutoPilotPacingInfo(
  isAutoPilot: boolean,
  openTradesCount: number,
  maxSlots: number,
  btcRegime: BtcMacroRegime,
  lossCircuitBreaker: RecentLossCircuitBreaker,
  activityRadar: MarketActivityRadar
): AutoPilotPacingInfo {
  if (!isAutoPilot) {
    return {
      state: 'AUTO_PILOT_OFF',
      headline: 'Auto-Pilot is Paused',
      badge: 'Manual Only',
      badgeColor: 'stone',
      explanation: 'Autonomous execution is toggled off. Deploy signals manually from the scanner queue.',
      isDeployingAllowed: false
    };
  }

  if (openTradesCount >= maxSlots) {
    return {
      state: 'SLOTS_FULL',
      headline: `All ${maxSlots}/${maxSlots} Tranche Slots Occupied`,
      badge: '10/10 Slots Full',
      badgeColor: 'amber',
      explanation: `Bankroll is 100% deployed across 10 diversified assets. Auto-Pilot will open new positions as existing trades harvest tiers or exit.`,
      isDeployingAllowed: false
    };
  }

  if (lossCircuitBreaker.isTripped) {
    return {
      state: 'LOSS_STREAK_COOLDOWN',
      headline: `Protective Cooldown (${lossCircuitBreaker.minutesRemaining}m left)`,
      badge: 'Chop Shield Active',
      badgeColor: 'red',
      explanation: lossCircuitBreaker.reason,
      isDeployingAllowed: false
    };
  }

  if (btcRegime.status === 'HEAVY_DUMP') {
    return {
      state: 'BTC_ARMOR_PAUSE',
      headline: 'BTC Flash-Crash Armor Triggered',
      badge: 'BTC Armor Engaged',
      badgeColor: 'rose',
      explanation: `Bitcoin is experiencing aggressive downside velocity (${btcRegime.btc24hChangePct.toFixed(1)}% 24h). All new long entries are locked to prevent catching falling knives.`,
      isDeployingAllowed: false
    };
  }

  if (activityRadar.isConsolidationLocked) {
    return {
      state: 'CONSOLIDATION_LOCK',
      headline: 'Strict Consolidation Lock (100% Cash Defense)',
      badge: 'Consolidation Lock (<2.0%)',
      badgeColor: 'blue',
      explanation: `Binance is in tight sideways consolidation (avg 24h volatility is ±${activityRadar.avgVolatilityPct}%, with only ${activityRadar.activePairsCount}/18 pairs moving). Breakout follow-through is near 0%. Auto-Pilot is locked 100% in cash to prevent bleed until volatility expands above 2.0%.`,
      isDeployingAllowed: false
    };
  }

  if (activityRadar.activityLevel === 'QUIET_CHOP') {
    return {
      state: 'QUIET_CHOP_PATIENT',
      headline: 'Preserving Cash (Quiet Chop Doldrums)',
      badge: 'Patience Mode (85+ Required)',
      badgeColor: 'blue',
      explanation: `Market-wide trading volume is unusually low. Breakout follow-through is weak, so Auto-Pilot requires a stricter 85/100 conviction score to prevent chop losses.`,
      isDeployingAllowed: true
    };
  }

  return {
    state: 'SCANNING_FOR_A_PLUS',
    headline: 'Actively Scanning for A+ Momentum Setups',
    badge: 'Scanning (Score ≥ 80)',
    badgeColor: 'emerald',
    explanation: `Market liquidity is healthy (${activityRadar.liquiditySession.sessionName}). Auto-Pilot is continuously evaluating 18 pairs every 10 seconds for qualified entries.`,
    isDeployingAllowed: true
  };
}

