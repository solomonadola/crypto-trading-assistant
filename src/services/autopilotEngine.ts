import { CryptoCoin } from '../types';
import { AutomatedTradeRecord, BankrollState } from '../types/automatedFeed';
import {
  EntrySignalResult,
  MAJOR_COINS,
  MAX_MAJOR_COIN_SLOTS,
  MEME_COINS,
  MAX_MEME_COIN_SLOTS,
  COIN_REENTRY_COOLDOWN_MS,
} from '../types/entryScanner';
import { AUTOPILOT_CONFIG } from '../config/autopilot';
import { LEVEL_GATES_ACTIVE } from '../config/entry';
import {
  AutoPilotPacingInfo,
  evaluateBtcMacroRegime,
  evaluateMarketActivityRadar,
  evaluateRecentLossCircuitBreaker,
  getAutoPilotPacingInfo,
} from './marketRegimeService';

/**
 * Auto-pilot entry decision, shared by the browser (App.tsx) and the 24/7
 * server worker (src/worker/tradingWorker.ts) so both make identical choices.
 * Moved verbatim from App.tsx; only the snapshot/deploy-in-flight guards stay
 * with each caller, because they belong to the caller's own loop.
 */

/**
 * Why the level gates refuse this signal, or null if they allow it.
 *
 * Two refusals, not one. The gates were measured and failed - no entry under
 * resistance, in a 4h downtrend, or away from a support that has held, worth
 * about 54 bp a trade out of sample. Or they could not be measured at all,
 * because this coin's candles did not arrive; the scanner then marks the gate
 * `measured: false`, and with the gates on that is a refusal too. Reading an
 * unmeasured gate as a pass is what let ungated entries through whenever
 * Binance dropped a candle request, and ungated entries measure about -30 bp.
 *
 * Shared so the auto-pilot and a manual deploy cannot drift apart.
 */
export function levelGateBlockReason(signal: Pick<EntrySignalResult, 'levelGate'>): string | null {
  const gate = signal.levelGate;
  if (gate && gate.measured && !gate.passed) return `Not at a level: ${gate.reason}`;
  if (LEVEL_GATES_ACTIVE && (!gate || !gate.measured)) {
    return 'The levels for this coin could not be measured (no candle data), so the entry is not taken.';
  }
  return null;
}

/** Regime and pacing state: why auto-pilot may or may not deploy right now. */
export function computePacing(
  coins: CryptoCoin[],
  trades: AutomatedTradeRecord[],
  isAutoPilot: boolean,
  totalSlots: number
): AutoPilotPacingInfo {
  return getAutoPilotPacingInfo(
    isAutoPilot,
    trades.filter((t) => t.status === 'OPEN').length,
    totalSlots,
    evaluateBtcMacroRegime(coins),
    evaluateRecentLossCircuitBreaker(trades),
    evaluateMarketActivityRadar(coins),
  );
}

export interface AutoPilotInputs {
  signals: EntrySignalResult[];
  /** Trades that count toward statistics (excluded ones already removed). */
  trades: AutomatedTradeRecord[];
  bankroll: BankrollState;
  pacingInfo: AutoPilotPacingInfo;
  now: number;
  /** When this caller last deployed (0 = never). */
  lastDeployAt: number;
}

export interface AutoPilotDecision {
  signal: EntrySignalResult | null;
  /** Why nothing was chosen, for logs and status displays. */
  reason?: string;
}

export function selectAutoPilotCandidate(i: AutoPilotInputs): AutoPilotDecision {
  const { signals, trades, bankroll, pacingInfo, now } = i;

  // Regime gate. Blocks new entries during consolidation lock, a BTC dump,
  // or a loss-streak cooldown - the conditions under which a sub-ATR stop is
  // most likely to be hit by noise rather than by the thesis failing.
  if (AUTOPILOT_CONFIG.enforceRegimeGates && !pacingInfo.isDeployingAllowed) {
    return { signal: null, reason: pacingInfo.headline };
  }

  // Never faster than minMsBetweenDeploys (burst guard).
  if (now - i.lastDeployAt < AUTOPILOT_CONFIG.minMsBetweenDeploys) {
    return { signal: null, reason: 'Waiting between deploys' };
  }

  const openTrades = trades.filter((t) => t.status === 'OPEN');
  if (openTrades.length >= AUTOPILOT_CONFIG.maxConcurrentTrades) return { signal: null, reason: 'All slots full' };
  if (!bankroll.canOpenNewTrade) return { signal: null, reason: bankroll.blockReason || 'Cannot open a new trade' };
  const minRequiredCash = Math.max(1.00, +(bankroll.totalPortfolioValueUSD * 0.07).toFixed(2));
  if (bankroll.liquidCashUSD < minRequiredCash) {
    return { signal: null, reason: `Remaining balance ($${bankroll.liquidCashUSD.toFixed(2)}) is below 7% minimum ($${minRequiredCash.toFixed(2)})` };
  }
  const nextDeploySize = Math.min(bankroll.trancheSizeUSD, bankroll.liquidCashUSD);
  if (bankroll.deployedCapitalUSD + nextDeploySize > bankroll.totalPortfolioValueUSD + 0.05) {
    return { signal: null, reason: 'Would exceed account balance' };
  }

  const openTradeSymbols = new Set(openTrades.map((t) => t.symbol.toUpperCase()));

  // 20-minute re-entry cooldown: any coin closed within the last 20 mins is barred.
  const cooldownSymbols = new Set(
    trades
      .filter((t) => t.status !== 'OPEN' && t.closedAtTimestamp && (now - t.closedAtTimestamp < COIN_REENTRY_COOLDOWN_MS))
      .map((t) => t.symbol.toUpperCase())
  );

  const openMajorCount = openTrades.filter((t) => MAJOR_COINS.has(t.symbol.toUpperCase())).length;
  const openMemeCount = openTrades.filter((t) => MEME_COINS.has(t.symbol.toUpperCase())).length;

  // Counted so a tick that deployed nothing can say why: "no qualifying
  // signal" and "no candle data for any coin" look identical in a log and
  // mean very different things.
  let unmeasured = 0;

  const eligibleCandidates = signals
    .filter((s) => !openTradeSymbols.has(s.symbol.toUpperCase()))
    .filter((s) => !cooldownSymbols.has(s.symbol.toUpperCase()))
    .filter((s) => {
      const sym = s.symbol.toUpperCase();
      const isMajor = MAJOR_COINS.has(sym);
      const isMeme = MEME_COINS.has(sym);

      // Max 3 major coins, max 2 meme coins.
      if (isMajor && openMajorCount >= MAX_MAJOR_COIN_SLOTS) return false;
      if (isMeme && openMemeCount >= MAX_MEME_COIN_SLOTS) return false;

      // Short side disabled. Measured forward returns were negative in both
      // samples: in-sample t = -2.02 at 5m, and out-of-sample the short leg
      // collapsed from -38 bps (t = -4.08) to -6.65 bps (t = -1.16), i.e. it
      // was six months of alts trending, not an edge. See STUDY_A_RESULTS.md.
      if (!AUTOPILOT_CONFIG.allowShorts && s.direction === 'SHORT') return false;

      // Real-level gates (config/entry.ts): no entry under resistance, in a 4h
      // downtrend, or far from a support that has held - and no entry in a coin
      // whose levels could not be measured. Worth about 54 bp a trade out of
      // sample; see the note in config/entry.ts.
      if (levelGateBlockReason(s)) {
        if (!s.levelGate || !s.levelGate.measured) unmeasured++;
        return false;
      }

      // Multi-timeframe confluence guard: reject disqualified or weak C-grade setups.
      const confluence = s.timeframeConfluence?.confluenceRating;
      const alignedCount = s.timeframeConfluence?.alignedCount ?? 3;
      if (confluence === 'DISQUALIFIED' || confluence === 'C' || alignedCount < 2) return false;

      // 1. High conviction triggered setups
      if (s.status === 'TRIGGERED' && s.score >= AUTOPILOT_CONFIG.minScore) return true;
      // 2. Strong constructive setups with at least 3 checkpoints confirmed and not blocked
      if (s.status === 'FORMING' && s.score >= AUTOPILOT_CONFIG.minScore && !s.disqualificationReason) {
        return s.checkpoints.filter((c) => c.passed).length >= 3;
      }
      // 3. Staging at support with green reversal
      if (s.status === 'STAGING_AT_SUPPORT' && s.score >= AUTOPILOT_CONFIG.minScore && s.microConfirmation?.isGreenReversal) {
        return true;
      }
      return false;
    })
    .sort((a, b) => {
      const isMajorA = MAJOR_COINS.has(a.symbol.toUpperCase());
      const isMajorB = MAJOR_COINS.has(b.symbol.toUpperCase());

      // A+ and A confluence first.
      const confRankA = a.timeframeConfluence?.confluenceRating === 'A+' ? 2 : a.timeframeConfluence?.confluenceRating === 'A' ? 1 : 0;
      const confRankB = b.timeframeConfluence?.confluenceRating === 'A+' ? 2 : b.timeframeConfluence?.confluenceRating === 'A' ? 1 : 0;
      if (confRankB !== confRankA) return confRankB - confRankA;

      // Majors moving less than 2.5% in 24h rank below alts and moving majors.
      const aIsStallingMajor = isMajorA && Math.abs(a.priceChange24hPct || 0) < 2.5;
      const bIsStallingMajor = isMajorB && Math.abs(b.priceChange24hPct || 0) < 2.5;
      if (!aIsStallingMajor && bIsStallingMajor) return -1;
      if (aIsStallingMajor && !bIsStallingMajor) return 1;

      // Triggered setups first, then higher score.
      if (a.status === 'TRIGGERED' && b.status !== 'TRIGGERED') return -1;
      if (b.status === 'TRIGGERED' && a.status !== 'TRIGGERED') return 1;
      return b.score - a.score;
    });

  if (eligibleCandidates[0]) return { signal: eligibleCandidates[0] };
  return {
    signal: null,
    reason: unmeasured > 0
      ? `No qualifying signal (${unmeasured} of ${signals.length} coins had no candle data, so their levels could not be checked)`
      : 'No qualifying signal',
  };
}

/**
 * Why a manual deploy of `signal` must not go ahead, or null if it may.
 * The same limits as auto-pilot except the re-entry cooldown and signal
 * quality, which a manual deploy overrides by design. Shared by the browser
 * and the server (POST /api/deploy).
 */
export function manualDeployBlockReason(
  signal: EntrySignalResult,
  trades: AutomatedTradeRecord[],
  bankroll: BankrollState
): string | null {
  const open = trades.filter((t) => t.status === 'OPEN');
  const sym = signal.symbol.toUpperCase();
  if (open.length >= AUTOPILOT_CONFIG.maxConcurrentTrades) {
    return `Maximum ${AUTOPILOT_CONFIG.maxConcurrentTrades} open positions reached. Wait for one to close.`;
  }
  if (open.some((t) => t.symbol.toUpperCase() === sym)) {
    return `A position for ${signal.symbol} is already open (one position per coin).`;
  }
  if (MAJOR_COINS.has(sym) && open.filter((t) => MAJOR_COINS.has(t.symbol.toUpperCase())).length >= MAX_MAJOR_COIN_SLOTS) {
    return `Major coins (${Array.from(MAJOR_COINS).join(', ')}) are capped at ${MAX_MAJOR_COIN_SLOTS} open positions.`;
  }
  if (MEME_COINS.has(sym) && open.filter((t) => MEME_COINS.has(t.symbol.toUpperCase())).length >= MAX_MEME_COIN_SLOTS) {
    return `Meme coins are capped at ${MAX_MEME_COIN_SLOTS} open positions.`;
  }
  const levelBlock = levelGateBlockReason(signal);
  if (levelBlock) return levelBlock;
  if (!bankroll.canOpenNewTrade) return bankroll.blockReason || 'Bankroll slots are full.';
  const minRequiredCash = Math.max(1.00, +(bankroll.totalPortfolioValueUSD * 0.07).toFixed(2));
  if (bankroll.liquidCashUSD < minRequiredCash) {
    return `Remaining balance ($${bankroll.liquidCashUSD.toFixed(2)}) is below the 7% minimum ($${minRequiredCash.toFixed(2)} = 7% of $${bankroll.totalPortfolioValueUSD.toFixed(2)}).`;
  }
  const nextDeploySize = Math.min(bankroll.trancheSizeUSD, bankroll.liquidCashUSD);
  if (bankroll.deployedCapitalUSD + nextDeploySize > bankroll.totalPortfolioValueUSD + 0.05) {
    return `Trade would exceed the account balance ($${bankroll.totalPortfolioValueUSD.toFixed(2)}).`;
  }
  return null;
}

export type ExcessCloseReason = 'DUPLICATE_COIN_CLOSED' | 'SLOT_LIMIT_CLOSED';

/**
 * Open positions that break the limits and must be closed: a second position
 * in the same coin, then anything beyond the 10-position limit. The oldest
 * positions are kept - they were opened legitimately; the newest are the ones
 * that got through. Used by the 24/7 server only: it holds the one list every
 * copy trusts, so it cannot close a position on the strength of a stale view,
 * which is what the old browser-side clean-up did.
 */
export function findExcessOpenTrades(
  trades: AutomatedTradeRecord[],
  max: number = AUTOPILOT_CONFIG.maxConcurrentTrades
): Array<{ trade: AutomatedTradeRecord; reason: ExcessCloseReason }> {
  const open = trades
    .filter((t) => t.status === 'OPEN')
    .sort((a, b) => (a.openedAtTimestamp || 0) - (b.openedAtTimestamp || 0) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const keep: AutomatedTradeRecord[] = [];
  const excess: Array<{ trade: AutomatedTradeRecord; reason: ExcessCloseReason }> = [];
  for (const t of open) {
    const sym = t.symbol.toUpperCase();
    if (seen.has(sym)) excess.push({ trade: t, reason: 'DUPLICATE_COIN_CLOSED' });
    else { seen.add(sym); keep.push(t); }
  }
  while (keep.length > max) excess.push({ trade: keep.pop()!, reason: 'SLOT_LIMIT_CLOSED' });
  return excess;
}
