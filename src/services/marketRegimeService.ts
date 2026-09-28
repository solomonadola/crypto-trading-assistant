import { CryptoCoin } from '../types';
import { outcome, netPnlUSD } from './metrics';
import { EntrySignalResult } from '../types/entryScanner';
import { AutomatedTradeRecord } from '../types/automatedFeed';
import { AUTOPILOT_CONFIG } from '../config/autopilot';

export interface BtcMacroRegime {
  btcPrice: number;
  btc24hChangePct: number;
  status: 'BULLISH_EXPANSION' | 'HEALTHY_CONSOLIDATION' | 'NEUTRAL_CHOP' | 'DEFENSIVE_PULLBACK' | 'HEAVY_DUMP';
  safetyRating: 'SAFE_FOR_LONGS' | 'CAUTION_REDUCED_RISK' | 'LOCK_ALL_LONGS';
  rationale: string;
  allowNewLongs: boolean;
  allowNewShorts: boolean;
  favoredDirection: 'LONGS_ONLY' | 'SHORTS_ONLY' | 'BOTH_ALIGNED' | 'DEFENSIVE_HOLD';
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

  // Macro trend indicators from real candle analysis (if available)
  const btcAnalysis = btc?.analysis;
  const isBelowDailyMa25 = btcAnalysis?.ma25_daily ? btcPrice < btcAnalysis.ma25_daily : false;
  const isBelowDailyMa7 = btcAnalysis?.ma7_daily ? btcPrice < btcAnalysis.ma7_daily : false;
  const isBtcMacroBearish = (isBelowDailyMa25 && isBelowDailyMa7) || (btcAnalysis?.structure?.trend === 'BEARISH');

  // Heavy dump: hourly drop > 1.2%, 24h drop > 2.8%, or sustained macro downtrend with negative momentum
  if (btcHourly < -1.2 || btcChange < -2.8 || (isBtcMacroBearish && btcChange < -0.8)) {
    return {
      btcPrice,
      btc24hChangePct: btcChange,
      status: 'HEAVY_DUMP',
      safetyRating: 'LOCK_ALL_LONGS',
      rationale: isBtcMacroBearish
        ? `Bitcoin is in a sustained macro downtrend below daily MA(25) & MA(7) with negative momentum. Altcoin Long entries locked to prevent bear market bleed; breakdown Shorts aligned.`
        : `Bitcoin experiencing aggressive sell-off (${btcChange.toFixed(1)}% 24h, ${btcHourly.toFixed(1)}% 1h). Altcoin Long entries strictly paused; only breakdown Shorts aligned.`,
      allowNewLongs: false,
      allowNewShorts: true,
      favoredDirection: 'SHORTS_ONLY',
      recommendedMaxExposurePct: 30
    };
  }

  // Macro Bearish Consolidation: Price is below major daily moving averages, preventing naive long deployments
  if (isBtcMacroBearish && btcChange <= 1.0) {
    return {
      btcPrice,
      btc24hChangePct: btcChange,
      status: 'DEFENSIVE_PULLBACK',
      safetyRating: 'CAUTION_REDUCED_RISK',
      rationale: `Bitcoin remains structurally below Daily MA(25) ($${btcAnalysis?.ma25_daily?.toFixed(0) || 'N/A'}). Long deployments restricted to exceptional A+ setups; Shorts permitted on breakdown.`,
      allowNewLongs: false,
      allowNewShorts: true,
      favoredDirection: 'SHORTS_ONLY',
      recommendedMaxExposurePct: 50
    };
  }

  // Defensive pullback: hourly drop > 0.5% or 24h drop > 1.0%
  if (btcHourly < -0.5 || btcChange < -1.0) {
    return {
      btcPrice,
      btc24hChangePct: btcChange,
      status: 'DEFENSIVE_PULLBACK',
      safetyRating: 'CAUTION_REDUCED_RISK',
      rationale: `Bitcoin pulling back (${btcChange.toFixed(1)}% 24h). Only A+ setups (Score ≥ 85) strictly aligned with trend allowed. Shorts locked to avoid squeeze risk.`,
      allowNewLongs: true,
      allowNewShorts: false,
      favoredDirection: 'LONGS_ONLY',
      recommendedMaxExposurePct: 60
    };
  }

  if (btcChange >= 1.5 && btcHourly >= 0) {
    return {
      btcPrice,
      btc24hChangePct: btcChange,
      status: 'BULLISH_EXPANSION',
      safetyRating: 'SAFE_FOR_LONGS',
      rationale: `Bitcoin in strong upward impulse (+${btcChange.toFixed(1)}%). Shorts locked to avoid squeeze risk; Longs favored.`,
      allowNewLongs: true,
      allowNewShorts: false,
      favoredDirection: 'LONGS_ONLY',
      recommendedMaxExposurePct: 100
    };
  }

  return {
    btcPrice,
    btc24hChangePct: btcChange,
    status: 'HEALTHY_CONSOLIDATION',
    safetyRating: 'SAFE_FOR_LONGS',
    rationale: `Bitcoin consolidating stably (${btcChange >= 0 ? '+' : ''}${btcChange.toFixed(1)}%). Normal selective deployments active for aligned long setups.`,
    allowNewLongs: true,
    allowNewShorts: false,
    favoredDirection: 'LONGS_ONLY',
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
  // 1. Post-US / CME & Binance Funding Rollover Dead Gap (21:00 - 01:00 UTC)
  // US cash markets closed, Binance daily rollover and funding fee settlement active, Asia not yet open.
  if (hours >= 21 || hours === 0) {
    return {
      sessionName: 'Rollover Dead Gap (21:00 - 01:00 UTC)',
      zone: 'DEAD_ZONE',
      utcTimeStr,
      isWeekend: false,
      isDeadZone: true,
      badgeLabel: 'Rollover Dead Gap',
      badgeColor: 'rose',
      description: 'US closed, Binance daily funding settlement active. Order book depth drops 50% with high stop-hunt wick risk.'
    };
  }

  // 2. Pre-London / European Open Lull (05:30 - 07:00 UTC)
  // Asian desks winding down / lunch, European institutions have not yet arrived.
  if ((hours === 5 && minutes >= 30) || hours === 6) {
    return {
      sessionName: 'Pre-London Lull (05:30 - 07:00 UTC)',
      zone: 'DEAD_ZONE',
      utcTimeStr,
      isWeekend: false,
      isDeadZone: true,
      badgeLabel: 'Pre-London Lull',
      badgeColor: 'amber',
      description: 'Asian volume tapering, London desks not yet online. High fakeout and low breakout follow-through risk.'
    };
  }

  // 3. Peak Liquidity Overlap: London & New York (13:00 - 16:30 UTC)
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

  // 4. US / New York Session (16:30 - 21:00 UTC)
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

  // 5. London / Europe Open (07:00 - 13:00 UTC)
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

  // 6. Asia Session (01:00 - 05:30 UTC)
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
  // Triggered if average 24h market volatility is below 3.2% OR fewer than 4 active coins moving (±3%)
  const isConsolidationLocked = avgVol < 3.2 || activeCoins.length < 4;

  if (isConsolidationLocked) {
    return {
      activityLevel: 'QUIET_CHOP',
      avgVolatilityPct: avgVol,
      activePairsCount: activeCoins.length,
      isConsolidationLocked: true,
      liquiditySession: session,
      badgeLabel: 'Chop Lock (<3.2%)',
      badgeColor: 'blue',
      rationale: `Low volatility compression (avg ±${avgVol}%, only ${activeCoins.length} active pairs moving). Market lacks expansion follow-through.`,
      guidance: '100% Cash Defense: Strict Consolidation Lock active. Auto-Pilot will not fire trades until volatility expands above 3.2%.'
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
    const isLoss = outcome(t) === 'LOSS' || t.exitReason === 'STOP_LOSS_HIT';
    return isRecent && isLoss;
  }).sort((a, b) => (b.closedAtTimestamp || 0) - (a.closedAtTimestamp || 0));

  const count = recentLosses.length;
  const totalLossUSD = +(recentLosses.reduce((acc, t) => acc + Math.abs(netPnlUSD(t)), 0)).toFixed(2);

  // Protective loss circuit breaker:
  // Trips if 2 or more stop-outs occurred in the last 2 hours OR recent loss >= $1.20.
  // Enforces a 45-minute cool-down shield to halt deployment into hostile/choppy markets.
  const isEligibleToTrip = count >= 2 || totalLossUSD >= 1.20;
  const latestLossTime = recentLosses[0]?.closedAtTimestamp || (recentLosses[0]?.openedAtTimestamp ? recentLosses[0].openedAtTimestamp + 1800000 : now);
  const cooldownDurationMs = 45 * 60 * 1000;
  const cooldownUntil = latestLossTime + cooldownDurationMs;
  const isTripped = isEligibleToTrip && now < cooldownUntil;
  const minutesRemaining = isTripped ? Math.max(1, Math.ceil((cooldownUntil - now) / 60000)) : 0;

  return {
    isTripped,
    recentLossesCount: count,
    recentLossUSD: totalLossUSD,
    cooldownUntil: isTripped ? cooldownUntil : 0,
    minutesRemaining,
    reason: isTripped
      ? `Anti-Chop Shield Active: ${count} stop-out(s) in last 2h (-$${totalLossUSD.toFixed(2)}). Pausing new entries for ${minutesRemaining}m to prevent chop bleeding.`
      : count > 0
      ? `${count} recent stop-out(s) in last 2h (-$${totalLossUSD.toFixed(2)}). Cooldown passed; selective scanning resumed.`
      : `Zero stop-outs in last 2h. System operating in optimal win regime.`
  };
}

export interface MonthlyRiskBudgetInfo {
  isExhausted: boolean;
  maxMonthlyRiskBudgetUSD: number;
  currentMonthNetPnLUSD: number;
  currentMonthLossPct: number;
  remainingRiskBudgetUSD: number;
  budgetUtilizationPct: number;
  monthName: string;
  statusBadge: string;
  statusColor: string;
  reason: string;
}

/**
 * Evaluates the Monthly Risk Budget (-6.0% maximum monthly drawdown circuit breaker).
 * Protects portfolio capital during hostile chop cycles.
 */
export function evaluateMonthlyRiskBudget(
  trades: AutomatedTradeRecord[],
  startingCapitalUSD: number = 1000,
  maxMonthlyRiskCapPct: number = 6.0
): MonthlyRiskBudgetInfo {
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth();
  const startOfMonthMs = Date.UTC(curYear, curMonth, 1, 0, 0, 0, 0);

  const monthTrades = trades.filter((t) => {
    if (t.status === 'OPEN') return false;
    const closedAt = t.closedAtTimestamp || (t.openedAtTimestamp ? t.openedAtTimestamp + 3600000 : 0);
    return closedAt >= startOfMonthMs;
  });

  const currentMonthNetPnLUSD = monthTrades.reduce((acc, t) => acc + netPnlUSD(t), 0);
  const maxMonthlyRiskBudgetUSD = +(startingCapitalUSD * (maxMonthlyRiskCapPct / 100)).toFixed(2);
  const currentMonthLossUSD = currentMonthNetPnLUSD < 0 ? Math.abs(currentMonthNetPnLUSD) : 0;
  const currentMonthLossPct = +((currentMonthLossUSD / startingCapitalUSD) * 100).toFixed(2);
  const remainingRiskBudgetUSD = +(Math.max(0, maxMonthlyRiskBudgetUSD - currentMonthLossUSD)).toFixed(2);
  const budgetUtilizationPct = Math.min(100, +((currentMonthLossUSD / maxMonthlyRiskBudgetUSD) * 100).toFixed(1));

  const isExhausted = currentMonthLossPct >= maxMonthlyRiskCapPct;
  const monthName = now.toLocaleString('en-US', { month: 'short', year: 'numeric' });

  return {
    isExhausted,
    maxMonthlyRiskBudgetUSD,
    currentMonthNetPnLUSD: +currentMonthNetPnLUSD.toFixed(2),
    currentMonthLossPct,
    remainingRiskBudgetUSD,
    budgetUtilizationPct,
    monthName,
    statusBadge: isExhausted
      ? 'Monthly Risk Cap Reached'
      : currentMonthNetPnLUSD >= 0
      ? `+$${currentMonthNetPnLUSD.toFixed(2)} Profit`
      : `${budgetUtilizationPct}% Risk Spent`,
    statusColor: isExhausted ? 'rose' : currentMonthNetPnLUSD >= 0 ? 'emerald' : budgetUtilizationPct > 60 ? 'amber' : 'blue',
    reason: isExhausted
      ? `Monthly Risk Budget Exceeded (-${currentMonthLossPct}% vs -${maxMonthlyRiskCapPct}% cap). Capital Preservation Lock is active for ${monthName}. Auto-Pilot will resume on the 1st of next month.`
      : currentMonthNetPnLUSD >= 0
      ? `${monthName} net PnL is +$${currentMonthNetPnLUSD.toFixed(2)}. Full $${maxMonthlyRiskBudgetUSD} risk budget available.`
      : `${monthName} drawdown is -$${currentMonthLossUSD.toFixed(2)} (-${currentMonthLossPct}%). $${remainingRiskBudgetUSD} risk budget remains before defense lock.`
  };
}

export type AutoPilotPacingState = 
  | 'SLOTS_FULL'
  | 'MONTHLY_RISK_CAP_LOCKED'
  | 'LOSS_STREAK_COOLDOWN'
  | 'BTC_ARMOR_PAUSE'
  | 'BTC_PULLBACK_CAUTION'
  | 'CONSOLIDATION_LOCK'
  | 'DEAD_ZONE_PAUSE'
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
  btcRegime: BtcMacroRegime;
  monthlyRiskBudget?: MonthlyRiskBudgetInfo;
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
  activityRadar: MarketActivityRadar,
  monthlyRiskBudget?: MonthlyRiskBudgetInfo
): AutoPilotPacingInfo {
  const base = ((): Omit<AutoPilotPacingInfo, 'btcRegime' | 'monthlyRiskBudget'> => {
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

    if (monthlyRiskBudget?.isExhausted) {
      return {
        state: 'MONTHLY_RISK_CAP_LOCKED',
        headline: `Monthly Risk Budget Cap Reached (-${monthlyRiskBudget.currentMonthLossPct}%)`,
        badge: 'Monthly Defense Lock',
        badgeColor: 'rose',
        explanation: monthlyRiskBudget.reason,
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
        headline: 'BTC Flash-Crash Armor Active (Shorts Only)',
        badge: 'BTC Armor Engaged',
        badgeColor: 'rose',
        explanation: `Bitcoin is experiencing aggressive downside velocity (${btcRegime.btc24hChangePct.toFixed(1)}% 24h). Altcoin Long entries are locked to prevent knife-catching; only confirmed breakdown Shorts are allowed.`,
        isDeployingAllowed: true
      };
    }

    if (activityRadar.isConsolidationLocked) {
      return {
        state: 'CONSOLIDATION_LOCK',
        headline: 'Strict Consolidation Lock (100% Cash Defense)',
        badge: 'Chop Lock (<3.0%)',
        badgeColor: 'blue',
        explanation: `Market is in low-volatility sideways compression (avg 24h volatility is ±${activityRadar.avgVolatilityPct}%). Breakout follow-through is low. Auto-Pilot is locked 100% in cash to prevent bleed until volatility expands above 3.0%.`,
        isDeployingAllowed: false
      };
    }

    if (AUTOPILOT_CONFIG.enforceSessionFilter && activityRadar.liquiditySession.isDeadZone) {
      return {
        state: 'DEAD_ZONE_PAUSE',
        headline: `${activityRadar.liquiditySession.sessionName} (${activityRadar.liquiditySession.utcTimeStr})`,
        badge: activityRadar.liquiditySession.badgeLabel,
        badgeColor: 'amber',
        explanation: `${activityRadar.liquiditySession.description} Auto-Pilot is paused to prevent false breakouts and thin order book slippage. Normal execution resumes at liquid session open.`,
        isDeployingAllowed: false
      };
    }

    if (btcRegime.status === 'DEFENSIVE_PULLBACK') {
      return {
        state: 'BTC_PULLBACK_CAUTION',
        headline: 'BTC Pullback Caution (Score ≥ 85 Required)',
        badge: 'BTC Caution (85+)',
        badgeColor: 'amber',
        explanation: `Bitcoin is in a corrective pullback (${btcRegime.btc24hChangePct.toFixed(1)}% 24h). Auto-Pilot requires strict A+ conviction (score ≥ 85) to enter.`,
        isDeployingAllowed: true
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
  })();

  return {
    ...base,
    btcRegime,
    monthlyRiskBudget
  };
}

