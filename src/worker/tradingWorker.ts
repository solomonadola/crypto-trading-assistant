// Must be first: the data layer below keeps its working state in localStorage.
import { saveStateNow, STATE_FILE } from './memoryStorage';
import { FIRESTORE_WRITES_ENABLED, getFirestoreHealth } from '../lib/firebase';
import { fetchLiveMarketCoins, buildPriceMap, getLastTickerFetchTime } from '../services/binanceService';
import {
  loadLocalTrades,
  subscribeToAutomatedTrades,
  hasConfirmedTradeList,
  getPendingWriteCount,
  syncOpenTradesWithLivePrices,
  updateAutomatedTrade,
} from '../services/automatedFeedService';
import { scanLiveMarketEntries, deploySignalToAutomatedFeed } from '../services/entryScannerService';
import { calculateBankrollState } from '../services/bankrollService';
import { catchUpOpenTrades } from '../services/catchUpService';
import { computePacing, selectAutoPilotCandidate } from '../services/autopilotEngine';
import { isCounted } from '../services/metrics';
import { AutomatedTradeRecord } from '../types/automatedFeed';

/**
 * 24/7 trading worker: the browser's refresh loop, run by a server process so
 * trading continues with every browser closed. Each tick does what a visible
 * tab does every 30s - fetch prices, replay any gap, evaluate open trades,
 * run the auto-pilot - using the same services, so the decisions are the same.
 *
 * Trades live in an in-memory copy kept current by a Firestore listener, the
 * same way a browser keeps its local copy. The worker never trades until that
 * listener has delivered: on an empty or failed load it would otherwise see
 * zero open positions and fill every slot.
 *
 * Settings (environment):
 *   TRADING_WORKER=off     do not start the worker (the server still serves the app)
 *   WORKER_AUTOPILOT=off   manage open trades only, open no new ones
 * A read-only copy (VITE_FIRESTORE_WRITES=off) never starts it: its trades
 * would exist only in this process's memory.
 */

export interface WorkerLogEntry {
  time: number;
  message: string;
  level: 'info' | 'warn' | 'success';
}

export interface WorkerStatus {
  workerRunning: boolean;
  /** Why the worker is not running, when it is not. */
  disabledReason: string | null;
  isAutoPilot: boolean;
  ticksCount: number;
  lastTickAt: number | null;
  /** Milliseconds since the last completed tick, measured on the server. */
  tickAgeMs: number | null;
  lastTickDurationMs: number;
  lastDeployAt: number;
  openPositionsCount: number;
  lastTickSummary: string;
  lastDecision?: { symbol?: string; reason?: string };
  recentLogs: WorkerLogEntry[];
}

export interface TickResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  updatedCount?: number;
  events?: string[];
  deployedSymbol?: string | null;
  durationMs?: number;
  error?: string;
}

const CATCH_UP_MIN_GAP_MS = 90_000;
const CHECKPOINT_EVERY_MS = 10 * 60_000;
const MAX_PRICE_AGE_MS = 120_000;
const RESUBSCRIBE_AFTER_MS = 60_000;

let isWorkerRunning = false;
let disabledReason: string | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let subscribedAt = 0;
let isTickInFlight = false;
let ticksCount = 0;
let lastTickAt: number | null = null;
let lastTickDurationMs = 0;
let lastDeployAt = 0;
let lastCheckpointAt = 0;
let lastTickSummary = 'Waiting for the first tick';
let lastDecision: { symbol?: string; reason?: string } = {};
let isAutoPilot = process.env.WORKER_AUTOPILOT !== 'off';
let openPositionsCount = 0;
const recentLogs: WorkerLogEntry[] = [];

function logEvent(message: string, level: WorkerLogEntry['level'] = 'info') {
  recentLogs.unshift({ time: Date.now(), message, level });
  if (recentLogs.length > 50) recentLogs.pop();
  console.log(`[TradingWorker ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function subscribe() {
  unsubscribe?.();
  subscribedAt = Date.now();
  unsubscribe = subscribeToAutomatedTrades(trackChanges);
}

// ---------------------------------------------------------------- trade feed
//
// Browsers pull the trade list from here (GET /api/trades) rather than from
// Firestore. The full list is ~3 KB a trade, and open trades change on every
// tick, so a pull returns only the trades changed since the caller's last
// one: each change bumps a version number, and the caller sends back the
// version it has. bootId changes on restart, when versions start again.

const bootId = Math.random().toString(36).slice(2, 10);
let feedVersion = 0;
const tradeSignature = new Map<string, string>();
const changedAtVersion = new Map<string, number>();
const removedAtVersion = new Map<string, number>();

function trackChanges(trades: AutomatedTradeRecord[]): void {
  const seen = new Set<string>();
  for (const t of trades) {
    seen.add(t.id);
    const sig = JSON.stringify(t);
    if (tradeSignature.get(t.id) !== sig) {
      tradeSignature.set(t.id, sig);
      changedAtVersion.set(t.id, ++feedVersion);
      removedAtVersion.delete(t.id);
    }
  }
  for (const id of [...tradeSignature.keys()]) {
    if (seen.has(id)) continue;
    tradeSignature.delete(id);
    changedAtVersion.delete(id);
    removedAtVersion.set(id, ++feedVersion);
  }
}

export interface TradesFeed {
  bootId: string;
  version: number;
  full: boolean;
  trades: AutomatedTradeRecord[];
  removedIds: string[];
}

/**
 * The trade list for GET /api/trades, or null while the worker has no list
 * Firestore has confirmed (an empty list then would read as "no trades").
 * `since`/`boot` are what the caller got last time; a missing or stale pair
 * gets the full list.
 */
export function getTradesFeed(since: number, boot: string): TradesFeed | null {
  if (!isWorkerRunning || !hasConfirmedTradeList()) return null;
  trackChanges(loadLocalTrades());
  const full = boot !== bootId || !(since > 0) || since > feedVersion;
  const all = loadLocalTrades();
  return {
    bootId,
    version: feedVersion,
    full,
    trades: full ? all : all.filter((t) => (changedAtVersion.get(t.id) ?? 0) > since),
    removedIds: full ? [] : [...removedAtVersion].filter(([, v]) => v > since).map(([id]) => id),
  };
}

function skip(reason: string): TickResult {
  lastTickSummary = `Skipped: ${reason}`;
  return { success: false, skipped: true, reason };
}

export async function executeTradingTick(): Promise<TickResult> {
  if (!isWorkerRunning) return skip(disabledReason || 'Worker is not running');
  if (isTickInFlight) return skip('A tick is already running');
  isTickInFlight = true;
  const startTime = Date.now();

  try {
    // 1. Trades. 'ok': the saved list is Firestore's. If Firestore cannot be
    //    read (daily quota spent, outage), carry on from the saved list only
    //    if it was confirmed by Firestore before - this run or restored from
    //    the state file - since the worker is the only writer while it runs.
    //    Writes then go out or queue. A never-confirmed list would look like
    //    zero open positions, so without one the worker waits.
    const health = getFirestoreHealth();
    let degraded = false;
    if (health !== 'ok') {
      if (health !== 'unknown' && Date.now() - subscribedAt > RESUBSCRIBE_AFTER_MS) subscribe();
      if (health === 'unknown' || !hasConfirmedTradeList()) {
        return skip(`Waiting for Firestore (${health})`);
      }
      degraded = true;
    }

    // 2. Prices. fetchLiveMarketCoins serves the last good tickers when every
    //    endpoint fails; never evaluate stops against prices that old.
    const coins = await fetchLiveMarketCoins();
    const priceAge = Date.now() - getLastTickerFetchTime();
    if (coins.length === 0 || priceAge > MAX_PRICE_AGE_MS) {
      return skip('No fresh Binance prices');
    }
    const priceMap = await buildPriceMap(coins);

    // 3. Replay candles missed while the process was asleep or restarting.
    //    After a restart only trades stamped with lastEvaluatedAt are
    //    replayed, from that stamp (see catchUpOpenTrades).
    const now = Date.now();
    let trades = loadLocalTrades();
    const gap = lastTickAt === null || now - lastTickAt > CATCH_UP_MIN_GAP_MS;
    if (gap && trades.some((t) => t.status === 'OPEN')) {
      const cu = await catchUpOpenTrades(trades, lastTickAt ?? 0, now, { requireCheckpoint: lastTickAt === null });
      for (const t of cu.changed) await updateAutomatedTrade(t, true);
      trades = cu.trades;
      cu.events.forEach((e) => logEvent(`[Catch-up] ${e}`));
      if (cu.failedSymbols.length) logEvent(`Catch-up could not fetch candles for ${cu.failedSymbols.join(', ')}`, 'warn');
    }

    // 4. Stops, targets and ratchets at the live price.
    const sync = await syncOpenTradesWithLivePrices(priceMap, trades);
    sync.events.forEach((e) => logEvent(e, 'success'));
    const open = sync.trades.filter((t) => t.status === 'OPEN');
    openPositionsCount = open.length;

    // 5. Checkpoint. Only milestones are written as they happen; this saves
    //    each open trade's session high/low and lastEvaluatedAt so a restart
    //    resumes from here, and browsers see current figures.
    if (now - lastCheckpointAt >= CHECKPOINT_EVERY_MS) {
      for (const t of open) await updateAutomatedTrade(t, true);
      lastCheckpointAt = now;
    }

    // 6. Auto-pilot: the browser's decision, from the shared engine.
    let deployedSymbol: string | null = null;
    if (isAutoPilot) {
      const counted = sync.trades.filter(isCounted);
      const bankroll = calculateBankrollState(counted);
      const decision = selectAutoPilotCandidate({
        signals: scanLiveMarketEntries(coins, 'FUTURES_1_2D'),
        trades: counted,
        bankroll,
        pacingInfo: computePacing(coins, counted, true, bankroll.totalSlots),
        now,
        lastDeployAt,
      });
      if (decision.signal) {
        const s = decision.signal;
        lastDeployAt = now;
        try {
          const trade = await deploySignalToAutomatedFeed(s, bankroll.trancheSizeUSD);
          deployedSymbol = s.symbol;
          lastDecision = { symbol: s.symbol, reason: 'Deployed' };
          logEvent(`Deployed $${trade.positionSizeUSD.toFixed(2)} into ${s.symbol} (${s.archetypeName}, score ${s.score})`, 'success');
        } catch (err) {
          lastDecision = { symbol: s.symbol, reason: err instanceof Error ? err.message : String(err) };
          logEvent(`Deploy of ${s.symbol} blocked: ${lastDecision.reason}`, 'warn');
        }
      } else {
        lastDecision = { reason: decision.reason };
      }
    } else {
      lastDecision = { reason: 'Auto-pilot is off on the server' };
    }

    ticksCount += 1;
    lastTickAt = Date.now();
    lastTickDurationMs = lastTickAt - startTime;
    const queued = getPendingWriteCount();
    lastTickSummary = `Tick #${ticksCount}: ${open.length} open, ${sync.updatedCount} updated, ${deployedSymbol ? `deployed ${deployedSymbol}` : 'no deploy'}` +
      (degraded ? ` - Firestore ${health}: trading on the saved list, ${queued} write(s) queued` : '');
    return { success: true, updatedCount: sync.updatedCount, events: sync.events, deployedSymbol, durationMs: lastTickDurationMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logEvent(`Tick error: ${error}`, 'warn');
    lastTickSummary = `Error: ${error}`;
    return { success: false, error, durationMs: Date.now() - startTime };
  } finally {
    isTickInFlight = false;
  }
}

export function startTradingWorker(intervalMs = 30_000): void {
  if (isWorkerRunning) return;
  if (process.env.TRADING_WORKER === 'off') {
    disabledReason = 'Disabled by TRADING_WORKER=off';
  } else if (!FIRESTORE_WRITES_ENABLED) {
    disabledReason = 'Read-only copy (VITE_FIRESTORE_WRITES=off): trades would exist only in server memory';
  }
  if (disabledReason) {
    logEvent(`Not started. ${disabledReason}`, 'warn');
    return;
  }
  isWorkerRunning = true;
  subscribe();
  logEvent(`Started: tick every ${intervalMs / 1000}s, auto-pilot ${isAutoPilot ? 'on' : 'off'}, state file ${STATE_FILE}`);
  executeTradingTick().catch((e) => console.error('Worker tick error:', e));
  intervalTimer = setInterval(() => {
    executeTradingTick().catch((e) => console.error('Worker tick error:', e));
  }, intervalMs);
}

export function stopTradingWorker(): void {
  if (!isWorkerRunning) return;
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = null;
  unsubscribe?.();
  unsubscribe = null;
  isWorkerRunning = false;
  saveStateNow();
  logEvent('Stopped');
}

export function setWorkerAutoPilot(enabled: boolean): void {
  isAutoPilot = enabled;
  logEvent(`Auto-pilot ${enabled ? 'on' : 'off'}`);
}

export function getWorkerStatus(): WorkerStatus {
  return {
    workerRunning: isWorkerRunning,
    disabledReason,
    isAutoPilot,
    ticksCount,
    lastTickAt,
    tickAgeMs: lastTickAt === null ? null : Date.now() - lastTickAt,
    lastTickDurationMs,
    lastDeployAt,
    openPositionsCount,
    lastTickSummary,
    lastDecision,
    recentLogs: recentLogs.slice(0, 20),
  };
}
