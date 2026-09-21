import { AutomatedTradeRecord } from '../types/automatedFeed';
import { evaluateLiquiditySession } from './marketRegimeService';

export interface ConsolidationLossEpisode {
  id: string;
  startTimeTimestamp: number;
  endTimeTimestamp: number;
  dateStr: string;
  startTimeUTC: string;
  endTimeUTC: string;
  localTimeRange: string;
  durationMinutes: number;
  tradesCount: number;
  lossesCount: number;
  winsCount: number;
  totalLossUSD: number;
  avgLossPct: number;
  coinsAffected: string[];
  marketRegime: string;
  avgMarketVolPct?: number;
  isRecurring: boolean;
  recurringFrequency: number;
  hourBracketUTC: string; // e.g. "14:00 - 16:00 UTC"
  recommendedAction: string;
  severity: 'HIGH_BLEED' | 'MODERATE_CHOP' | 'MILD_DRAWDOWN';
}

export interface HourlyLossStat {
  hourUTC: number;
  hourLabelUTC: string;
  hourLabelLocal: string;
  sessionName: string;
  totalTrades: number;
  lossCount: number;
  winCount: number;
  winRatePct: number;
  netPnLUSD: number;
  totalLossUSD: number;
  lossRatePct: number;
  isRecurringTrap: boolean;
  episodeCount: number;
}

export interface ConsolidationLossAuditReport {
  totalEpisodesRecorded: number;
  worstWindowUTC: string;
  worstWindowLocal: string;
  worstWindowTotalLossUSD: number;
  worstWindowLossesCount: number;
  recurringTrapsCount: number;
  recurringTraps: {
    hourBracket: string;
    sessionName: string;
    episodesCount: number;
    totalLossUSD: number;
    recommendation: string;
  }[];
  hourlyDistribution: HourlyLossStat[];
  episodes: ConsolidationLossEpisode[];
}

const STORAGE_KEY = 'crypto_consolidation_loss_episodes';

/**
 * Formats a Date object to "HH:MM UTC"
 */
function formatUtcTime(date: Date): string {
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m} UTC`;
}

/**
 * Formats a Date object to local time string (e.g., "2:15 PM")
 */
function formatLocalTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Retrieves recorded episodes from localStorage
 */
export function getSavedConsolidationEpisodes(): ConsolidationLossEpisode[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('Failed to parse saved consolidation episodes:', e);
    return [];
  }
}

/**
 * Persists episodes to localStorage
 */
export function saveConsolidationEpisodes(episodes: ConsolidationLossEpisode[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(episodes));
  } catch (e) {
    console.warn('Failed to save consolidation episodes:', e);
  }
}

/**
 * Analyzes closed trades to reconstruct or discover consolidation loss episodes
 * and groups them into time-of-day clusters.
 */
export function analyzeConsolidationLosses(
  trades: AutomatedTradeRecord[],
  savedEpisodes: ConsolidationLossEpisode[] = getSavedConsolidationEpisodes()
): ConsolidationLossAuditReport {
  const closedTrades = trades
    .filter((t) => t.status !== 'OPEN' && (t.closedAtTimestamp || t.openedAtTimestamp))
    .sort((a, b) => {
      const timeA = a.closedAtTimestamp || a.openedAtTimestamp || 0;
      const timeB = b.closedAtTimestamp || b.openedAtTimestamp || 0;
      return timeA - timeB;
    });

  // 1. Hourly 24h Bucket Distribution (0 to 23 UTC)
  const hourlyMap = new Map<number, {
    trades: AutomatedTradeRecord[];
    losses: AutomatedTradeRecord[];
    wins: AutomatedTradeRecord[];
  }>();

  for (let h = 0; h < 24; h++) {
    hourlyMap.set(h, { trades: [], losses: [], wins: [] });
  }

  closedTrades.forEach((t) => {
    const closeTime = t.closedAtTimestamp || t.openedAtTimestamp || Date.now();
    const d = new Date(closeTime);
    const hour = d.getUTCHours();
    const bucket = hourlyMap.get(hour);
    if (bucket) {
      bucket.trades.push(t);
      if (t.pnlUSD < 0) {
        bucket.losses.push(t);
      } else if (t.pnlUSD > 0) {
        bucket.wins.push(t);
      }
    }
  });

  // 2. Discover episodes from trade clusters (trades closed within 2.5 hours of each other that produced losses)
  const discoveredEpisodes: ConsolidationLossEpisode[] = [];
  const CLUSTER_WINDOW_MS = 2.5 * 60 * 60 * 1000; // 2.5 hours

  let currentCluster: AutomatedTradeRecord[] = [];

  for (let i = 0; i < closedTrades.length; i++) {
    const trade = closedTrades[i];
    const tradeTime = trade.closedAtTimestamp || trade.openedAtTimestamp || 0;

    if (currentCluster.length === 0) {
      currentCluster.push(trade);
    } else {
      const prevTime = currentCluster[currentCluster.length - 1].closedAtTimestamp || currentCluster[currentCluster.length - 1].openedAtTimestamp || 0;
      if (tradeTime - prevTime <= CLUSTER_WINDOW_MS) {
        currentCluster.push(trade);
      } else {
        // Evaluate previous cluster
        evaluateAndPushCluster(currentCluster, discoveredEpisodes);
        currentCluster = [trade];
      }
    }
  }

  if (currentCluster.length > 0) {
    evaluateAndPushCluster(currentCluster, discoveredEpisodes);
  }

  // Merge discovered episodes with any manually saved / runtime tracked episodes
  const combinedMap = new Map<string, ConsolidationLossEpisode>();
  [...discoveredEpisodes, ...savedEpisodes].forEach((ep) => {
    // Key by start timestamp rounded to 15m to avoid duplicates
    const key = `${Math.floor(ep.startTimeTimestamp / (15 * 60 * 1000))}_${ep.lossesCount}`;
    if (!combinedMap.has(key)) {
      combinedMap.set(key, ep);
    }
  });

  let allEpisodes = Array.from(combinedMap.values()).sort(
    (a, b) => b.startTimeTimestamp - a.startTimeTimestamp
  );

  // Mark recurring frequency for each episode
  const hourBracketCounts = new Map<string, number>();
  allEpisodes.forEach((ep) => {
    const count = (hourBracketCounts.get(ep.hourBracketUTC) || 0) + 1;
    hourBracketCounts.set(ep.hourBracketUTC, count);
  });

  allEpisodes = allEpisodes.map((ep) => {
    const freq = hourBracketCounts.get(ep.hourBracketUTC) || 1;
    const isRecurring = freq >= 2;
    return {
      ...ep,
      isRecurring,
      recurringFrequency: freq,
      recommendedAction: isRecurring
        ? `Recurring Trap: Auto-Pilot recommends blacklisting entries during ${ep.hourBracketUTC}`
        : 'Single Chop Event: Guarded by 60m Chop Dampener'
    };
  });

  // Calculate 24h Hourly Distribution Stats
  const now = new Date();
  const hourlyDistribution: HourlyLossStat[] = [];

  for (let h = 0; h < 24; h++) {
    const b = hourlyMap.get(h)!;
    const totalTrades = b.trades.length;
    const lossCount = b.losses.length;
    const winCount = b.wins.length;
    const winRatePct = totalTrades > 0 ? +((winCount / totalTrades) * 100).toFixed(1) : 0;
    const netPnLUSD = +b.trades.reduce((acc, t) => acc + (t.pnlUSD || 0), 0).toFixed(2);
    const totalLossUSD = +b.losses.reduce((acc, t) => acc + Math.abs(t.pnlUSD || 0), 0).toFixed(2);
    const lossRatePct = totalTrades > 0 ? +((lossCount / totalTrades) * 100).toFixed(1) : 0;

    const targetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0, 0));
    const sessionInfo = evaluateLiquiditySession(targetDate);

    const hNext = (h + 1) % 24;
    const hourLabelUTC = `${String(h).padStart(2, '0')}:00 - ${String(hNext).padStart(2, '0')}:00 UTC`;
    const localDate = new Date();
    localDate.setUTCHours(h, 0, 0, 0);
    const localNext = new Date();
    localNext.setUTCHours(hNext, 0, 0, 0);
    const hourLabelLocal = `${formatLocalTime(localDate)} - ${formatLocalTime(localNext)}`;

    const episodesInHour = allEpisodes.filter(ep => {
      const epHour = new Date(ep.startTimeTimestamp).getUTCHours();
      return epHour === h;
    }).length;

    const isRecurringTrap = (lossCount >= 2 && winRatePct <= 35) || episodesInHour >= 2;

    hourlyDistribution.push({
      hourUTC: h,
      hourLabelUTC,
      hourLabelLocal,
      sessionName: sessionInfo.sessionName,
      totalTrades,
      lossCount,
      winCount,
      winRatePct,
      netPnLUSD,
      totalLossUSD,
      lossRatePct,
      isRecurringTrap,
      episodeCount: episodesInHour
    });
  }

  // Find worst loss window (3-hour rolling window with highest total loss)
  let worstWindowUTC = '21:00 - 00:00 UTC (Evening Dead Gap)';
  let worstWindowLocal = 'Evening Dead Zone';
  let maxLossUSD = 0;
  let worstLossesCount = 0;

  for (let startH = 0; startH < 24; startH++) {
    let windowLoss = 0;
    let windowLossCount = 0;
    for (let offset = 0; offset < 3; offset++) {
      const h = (startH + offset) % 24;
      const stat = hourlyDistribution[h];
      windowLoss += stat.totalLossUSD;
      windowLossCount += stat.lossCount;
    }
    if (windowLoss > maxLossUSD) {
      maxLossUSD = windowLoss;
      worstLossesCount = windowLossCount;
      const endH = (startH + 3) % 24;
      worstWindowUTC = `${String(startH).padStart(2, '0')}:00 – ${String(endH).padStart(2, '0')}:00 UTC`;
      
      const dStart = new Date();
      dStart.setUTCHours(startH, 0, 0, 0);
      const dEnd = new Date();
      dEnd.setUTCHours(endH, 0, 0, 0);
      worstWindowLocal = `${formatLocalTime(dStart)} – ${formatLocalTime(dEnd)}`;
    }
  }

  // Aggregate Recurring Traps
  const recurringTraps: ConsolidationLossAuditReport['recurringTraps'] = [];
  hourBracketCounts.forEach((count, bracket) => {
    if (count >= 2) {
      const matching = allEpisodes.filter(ep => ep.hourBracketUTC === bracket);
      const totalLoss = matching.reduce((acc, ep) => acc + Math.abs(ep.totalLossUSD), 0);
      recurringTraps.push({
        hourBracket: bracket,
        sessionName: matching[0]?.marketRegime || 'Consolidation Chop',
        episodesCount: count,
        totalLossUSD: +totalLoss.toFixed(2),
        recommendation: `Consistently unprofitable across ${count} distinct episodes. Recommended: Freeze Auto-Pilot entries during ${bracket}.`
      });
    }
  });

  return {
    totalEpisodesRecorded: allEpisodes.length,
    worstWindowUTC,
    worstWindowLocal,
    worstWindowTotalLossUSD: +maxLossUSD.toFixed(2),
    worstWindowLossesCount: worstLossesCount,
    recurringTrapsCount: recurringTraps.length,
    recurringTraps,
    hourlyDistribution,
    episodes: allEpisodes
  };
}

/**
 * Helper to turn a group of trades into an episode if it represents a consolidation loss
 */
function evaluateAndPushCluster(cluster: AutomatedTradeRecord[], output: ConsolidationLossEpisode[]) {
  const losses = cluster.filter(t => t.pnlUSD < 0);
  if (losses.length < 1) return; // Only interested in loss periods

  const startTrade = cluster[0];
  const endTrade = cluster[cluster.length - 1];

  const startTime = startTrade.closedAtTimestamp || startTrade.openedAtTimestamp || (Date.now() - 3600000);
  const endTime = endTrade.closedAtTimestamp || endTrade.openedAtTimestamp || Date.now();

  const startDate = new Date(startTime);
  const endDate = new Date(endTime);

  const durationMs = Math.max(15 * 60 * 1000, endTime - startTime);
  const durationMinutes = Math.round(durationMs / (60 * 1000));

  const totalLossUSD = +losses.reduce((acc, t) => acc + t.pnlUSD, 0).toFixed(2);
  const avgLossPct = +(losses.reduce((acc, t) => acc + t.pnlPercentage, 0) / losses.length).toFixed(2);

  const coinsAffected = Array.from(new Set(losses.map(t => t.symbol)));
  const startHour = startDate.getUTCHours();
  const endHour = Math.min(23, Math.max(startHour + 1, endDate.getUTCHours()));
  const hourBracketUTC = `${String(startHour).padStart(2, '0')}:00 – ${String(endHour + 1).padStart(2, '0')}:00 UTC`;

  const session = evaluateLiquiditySession(startDate);

  let severity: 'HIGH_BLEED' | 'MODERATE_CHOP' | 'MILD_DRAWDOWN' = 'MILD_DRAWDOWN';
  if (Math.abs(totalLossUSD) >= 1.0 || losses.length >= 3) {
    severity = 'HIGH_BLEED';
  } else if (losses.length >= 2 || Math.abs(totalLossUSD) >= 0.50) {
    severity = 'MODERATE_CHOP';
  }

  output.push({
    id: `ep_${startTime}_${losses.length}`,
    startTimeTimestamp: startTime,
    endTimeTimestamp: endTime,
    dateStr: startDate.toISOString().split('T')[0],
    startTimeUTC: formatUtcTime(startDate),
    endTimeUTC: formatUtcTime(endDate),
    localTimeRange: `${formatLocalTime(startDate)} – ${formatLocalTime(endDate)}`,
    durationMinutes,
    tradesCount: cluster.length,
    lossesCount: losses.length,
    winsCount: cluster.length - losses.length,
    totalLossUSD,
    avgLossPct,
    coinsAffected,
    marketRegime: session.isDeadZone 
      ? session.sessionName 
      : 'Sideways Consolidation Drift (<2.0% Vol)',
    isRecurring: false,
    recurringFrequency: 1,
    hourBracketUTC,
    recommendedAction: 'Sitting in 100% Cash Defense during this window',
    severity
  });
}

/**
 * Manually or automatically logs a new consolidation loss episode to permanent storage
 */
export function recordConsolidationLossEpisode(
  startTimeMs: number,
  endTimeMs: number,
  losses: AutomatedTradeRecord[],
  marketVolPct: number = 1.4,
  note?: string
): ConsolidationLossEpisode {
  const existing = getSavedConsolidationEpisodes();
  const startDate = new Date(startTimeMs);
  const endDate = new Date(endTimeMs);

  const totalLossUSD = +losses.reduce((acc, t) => acc + (t.pnlUSD || 0), 0).toFixed(2);
  const avgLossPct = losses.length > 0 
    ? +(losses.reduce((acc, t) => acc + (t.pnlPercentage || 0), 0) / losses.length).toFixed(2)
    : 0;

  const coinsAffected = Array.from(new Set(losses.map(t => t.symbol)));
  const startHour = startDate.getUTCHours();
  const endHour = Math.min(23, Math.max(startHour + 1, endDate.getUTCHours()));
  const hourBracketUTC = `${String(startHour).padStart(2, '0')}:00 – ${String(endHour + 1).padStart(2, '0')}:00 UTC`;

  const session = evaluateLiquiditySession(startDate);

  // Check how many times this hour bracket has occurred
  const freq = existing.filter(ep => ep.hourBracketUTC === hourBracketUTC).length + 1;

  const newEpisode: ConsolidationLossEpisode = {
    id: `manual_ep_${Date.now()}`,
    startTimeTimestamp: startTimeMs,
    endTimeTimestamp: endTimeMs,
    dateStr: startDate.toISOString().split('T')[0],
    startTimeUTC: formatUtcTime(startDate),
    endTimeUTC: formatUtcTime(endDate),
    localTimeRange: `${formatLocalTime(startDate)} – ${formatLocalTime(endDate)}`,
    durationMinutes: Math.round((endTimeMs - startTimeMs) / 60000),
    tradesCount: losses.length,
    lossesCount: losses.length,
    winsCount: 0,
    totalLossUSD,
    avgLossPct,
    coinsAffected,
    marketRegime: session.sessionName,
    avgMarketVolPct: marketVolPct,
    isRecurring: freq >= 2,
    recurringFrequency: freq,
    hourBracketUTC,
    recommendedAction: freq >= 2 
      ? `Recurring Trap (${freq}x): Blacklist trading during ${hourBracketUTC}`
      : 'First Occurrence: Logged for continuous pattern auditing',
    severity: Math.abs(totalLossUSD) >= 1.0 ? 'HIGH_BLEED' : 'MODERATE_CHOP'
  };

  const updated = [newEpisode, ...existing];
  saveConsolidationEpisodes(updated);
  return newEpisode;
}

/**
 * Clears recorded episodes from storage
 */
export function clearSavedConsolidationEpisodes(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('Failed to clear consolidation episodes:', e);
  }
}
