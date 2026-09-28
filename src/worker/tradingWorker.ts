// Must be first: the data layer below keeps its working state in localStorage.
import { saveStateNow, STATE_FILE } from './memoryStorage';
import { db, FIRESTORE_WRITES_ENABLED, getFirestoreHealth, FirestoreHealth } from '../lib/firebase';
import { doc, setDoc, getDocFromServer } from 'firebase/firestore';
import { fetchLiveMarketCoins, buildPriceMap, getLastTickerFetchTime } from '../services/binanceService';
import {
  loadLocalTrades,
  subscribeToAutomatedTrades,
  hasConfirmedTradeList,
  getPendingWriteCount,
  syncOpenTradesWithLivePrices,
  updateAutomatedTrade,
  enableServerWriterMode,
  flushPendingWrites,
  getLastFlush,
  forceFullResync,
  reconcileWithFirestore,
  getLastReconcile,
  ReconcileResult,
  resetAutomatedTrades,
} from '../services/automatedFeedService';
import { closeTradeAt } from '../services/cycleEngineService';
import { CryptoCoin } from '../types';
import { scanLiveMarketEntries, deploySignalToAutomatedFeed } from '../services/entryScannerService';
import { calculateBankrollState } from '../services/bankrollService';
import { catchUpOpenTrades } from '../services/catchUpService';
import { computePacing, selectAutoPilotCandidate, manualDeployBlockReason, findExcessOpenTrades } from '../services/autopilotEngine';
import { visibleTrades, isClosed } from '../services/metrics';
import { getUsage, usageSummary, Usage } from '../services/firestoreMeter';
import { AutomatedTradeRecord } from '../types/automatedFeed';
import { AUTOPILOT_CONFIG, getAllowShorts, setAllowShorts } from '../config/autopilot';
import { STRATEGY_PROFILES, StrategyProfileId, getActiveStrategyProfile, setActiveStrategyProfile } from '../config/geometry';

/**
 * 24/7 trading worker: the browser's refresh loop, run by a server process so
 * trading continues with every browser closed. Each tick does what a visible
 * tab does every 30s - fetch prices, replay any gap, evaluate open trades,
 * run the auto-pilot - using the same services, so the decisions are the same.
 *
 * The server is the source of truth. Its list (in memory, mirrored to the
 * state file) is what every browser shows, and every change goes through it:
 * its own ticks and the actions browsers send (close, exclude, deploy).
 * Firestore is its backup, kept in step every minute: queued changes are
 * written, then Firestore is asked for trades changed since the last check,
 * and each trade is reconciled by revision - Firestore newer: pull it; server
 * newer: push it (reconcileWithFirestore). Every trade is compared at startup
 * from a saved state file and once a day. The worker never trades until it
 * has a list: an empty one would look like zero open positions.
 *
 * Ticks, actions and flushes run one at a time (exclusive), so an action
 * never lands in the middle of a tick and gets overwritten by it.
 *
 * Settings (environment):
 *   TRADING_WORKER=off        do not start the worker (the server still serves the app)
 *   WORKER_AUTOPILOT=off      default auto-pilot state (POST /api/autopilot changes it; kept across restarts)
 *   WORKER_FLUSH_MINUTES=5    how often Firestore is compared and written
 * A read-only copy (VITE_FIRESTORE_WRITES=off) never starts it: its trades
 * would exist only in this process's memory.
 */

export interface WorkerLogEntry {
  time: number;
  message: string;
  level: 'info' | 'warn' | 'success';
}

export interface WorkerStatus {
  /** Changes on every start; two different values seen close together mean two servers are answering. */
  instanceId: string;
  workerRunning: boolean;
  /** Why the worker is not running, when it is not. */
  disabledReason: string | null;
  isAutoPilot: boolean;
  allowShorts: boolean;
  /** The exit profile new trades open with (config/geometry.ts). */
  strategyProfile: StrategyProfileId;
  ticksCount: number;
  lastTickAt: number | null;
  /** Milliseconds since the last completed tick, measured on the server. */
  tickAgeMs: number | null;
  lastTickDurationMs: number;
  lastDeployAt: number;
  openPositionsCount: number;
  lastTickSummary: string;
  lastDecision?: { symbol?: string; reason?: string };
  sync: {
    firestore: FirestoreHealth;
    /** Changes not yet written to Firestore. */
    pendingWrites: number;
    lastFlushAt: number | null;
    lastFlushWritten: number;
    lastFlushError: string | null;
    flushEveryMs: number;
    /** Last comparison with Firestore: what was pulled (Firestore newer) and pushed (server newer). */
    lastReconcile: ReconcileResult | null;
    /** What this server has actually cost Firestore since it started. */
    usage: Usage;
    stateFile: string;
  };
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
// Session high/low and lastEvaluatedAt of open trades, saved to Firestore
// with the next flush. Hourly: the state file has them to the second, and the
// candle replay covers anything older after a restart without it.
const CHECKPOINT_EVERY_MS = 60 * 60_000;
const FLUSH_EVERY_MS = Math.max(1, Number(process.env.WORKER_FLUSH_MINUTES) || 5) * 60_000;
const FULL_RECONCILE_EVERY_MS = 24 * 3_600_000;
const AUTOPILOT_KEY = 'cryptostudy_worker_autopilot';
const MAX_PRICE_AGE_MS = 120_000;
const RESUBSCRIBE_AFTER_MS = 60_000;

let isWorkerRunning = false;
let disabledReason: string | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let fullReconcileTimer: ReturnType<typeof setInterval> | null = null;
let usageTimer: ReturnType<typeof setInterval> | null = null;
let lastCoins: CryptoCoin[] = [];
let unsubscribe: (() => void) | null = null;
let configUnsubscribe: (() => void) | null = null;
let subscribedAt = 0;
let isTickInFlight = false;
let ticksCount = 0;
let lastTickAt: number | null = null;
let lastTickDurationMs = 0;
let lastDeployAt = 0;
let lastCheckpointAt = 0;
let lastTickSummary = 'Waiting for the first tick';
let lastDecision: { symbol?: string; reason?: string } = {};
let isAutoPilot = process.env.WORKER_AUTOPILOT !== 'off';   // replaced by the saved setting on start
let openPositionsCount = 0;
const recentLogs: WorkerLogEntry[] = [];

function logEvent(message: string, level: WorkerLogEntry['level'] = 'info') {
  recentLogs.unshift({ time: Date.now(), message, level });
  if (recentLogs.length > 50) recentLogs.pop();
  console.log(`[TradingWorker ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

// One at a time: ticks, actions, flushes, protected by self-healing timeouts.
let lock: Promise<unknown> = Promise.resolve();
let lockOwner = '';
let lockAcquiredAt = 0;

export function resetWorkerLock(): void {
  lock = Promise.resolve();
  isTickInFlight = false;
  lockOwner = '';
  lockAcquiredAt = 0;
  console.log('[TradingWorker] Worker lock and tick status forcefully reset');
}

function exclusive<T>(name: string, fn: () => Promise<T>, timeoutMs = 25_000): Promise<T> {
  // If the lock has been held longer than timeoutMs, break it to prevent deadlocks
  if (lockAcquiredAt > 0 && Date.now() - lockAcquiredAt > timeoutMs) {
    console.warn(`[TradingWorker] Lock held by "${lockOwner}" for ${Date.now() - lockAcquiredAt}ms (> ${timeoutMs}ms limit). Breaking lock.`);
    lock = Promise.resolve();
  }

  const run = lock.then(async () => {
    lockOwner = name;
    lockAcquiredAt = Date.now();
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Operation "${name}" timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
    } finally {
      lockAcquiredAt = 0;
      lockOwner = '';
    }
  });

  lock = run.catch(() => {
    lockAcquiredAt = 0;
    lockOwner = '';
  });

  return run;
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

let bootId = Math.random().toString(36).slice(2, 10);
let feedVersion = 1;   // never 0: callers send 0 to ask for the full list
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
  if (!hasConfirmedTradeList()) return null;
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

let tickStartedAt = 0;

export async function executeTradingTick(): Promise<TickResult> {
  if (!isWorkerRunning) return skip(disabledReason || 'Worker is not running');
  if (isTickInFlight) {
    if (tickStartedAt > 0 && Date.now() - tickStartedAt > 35_000) {
      logEvent('Previous tick exceeded 35s. Breaking lock and recovering worker.', 'warn');
      resetWorkerLock();
    } else {
      return skip('A tick is already running');
    }
  }
  isTickInFlight = true;
  tickStartedAt = Date.now();
  return exclusive('tick', runTick, 25_000).finally(() => {
    isTickInFlight = false;
    tickStartedAt = 0;
  });
}

async function runTick(): Promise<TickResult> {
  const startTime = Date.now();
  try {
    // 1. Trades: the server's own list, built from Firestore once and then
    //    kept here (restored from the state file after a restart). Without
    //    it, wait: an empty list would look like zero open positions.
    if (!hasConfirmedTradeList()) {
      const health = getFirestoreHealth();
      if (health !== 'unknown' && Date.now() - subscribedAt > RESUBSCRIBE_AFTER_MS) subscribe();
      return skip(`Waiting for Firestore (${health}) to load the trade list`);
    }

    // 2. Prices. fetchLiveMarketCoins serves the last good tickers when every
    //    endpoint fails; never evaluate stops against prices that old.
    const coins = await fetchLiveMarketCoins();
    const priceAge = Date.now() - getLastTickerFetchTime();
    if (coins.length === 0 || priceAge > MAX_PRICE_AGE_MS) {
      return skip('No fresh Binance prices');
    }
    const priceMap = await buildPriceMap(coins);
    lastCoins = coins;

    // 3. Replay candles missed while the process was asleep or restarting.
    //    After a restart only trades stamped with lastEvaluatedAt are
    //    replayed, from that stamp (see catchUpOpenTrades).
    const now = Date.now();
    let trades = loadLocalTrades();
    const gap = lastTickAt === null || now - lastTickAt > CATCH_UP_MIN_GAP_MS;
    if (gap && trades.some((t) => !isClosed(t))) {
      const cu = await catchUpOpenTrades(trades, lastTickAt ?? 0, now, { requireCheckpoint: lastTickAt === null });
      for (const t of cu.changed) await updateAutomatedTrade(t, true);
      trades = cu.trades;
      cu.events.forEach((e) => logEvent(`[Catch-up] ${e}`));
      if (cu.failedSymbols.length) logEvent(`Catch-up could not fetch candles for ${cu.failedSymbols.join(', ')}`, 'warn');
    }

    // 4. Stops, targets and ratchets at the live price.
    const sync = await syncOpenTradesWithLivePrices(priceMap, trades);
    sync.events.forEach((e) => logEvent(e, 'success'));

    // 4b. Enforce the limits on what is already open: a second position in a
    //     coin, or more than 10 open, got in some other way (two copies
    //     trading at once before the server was in charge). The newest go, at
    //     their live price with the exit cost, like a manual close.
    let current = sync.trades;
    const excess = findExcessOpenTrades(current);
    if (excess.length) {
      for (const { trade, reason } of excess) {
        const price = trade.currentPrice || trade.entryPrice;
        await updateAutomatedTrade(closeTradeAt(trade, price, reason), true);
        logEvent(`${trade.symbol} closed at ${price}: ${reason === 'DUPLICATE_COIN_CLOSED' ? 'second position in the same coin' : 'over the 10-position limit'}`, 'warn');
      }
      current = loadLocalTrades();
    }
    const open = current.filter((t) => !isClosed(t));
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
      // Every open position plus the trusted closed records: an open trade
      // excluded from statistics still holds its slot (services/metrics.ts).
      const book = visibleTrades(current);
      const bankroll = calculateBankrollState(book);
      const decision = selectAutoPilotCandidate({
        signals: scanLiveMarketEntries(coins, 'FUTURES_1_2D'),
        trades: book,
        bankroll,
        pacingInfo: computePacing(coins, book, true, bankroll.totalSlots, bankroll.totalPortfolioValueUSD),
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

    if (getPendingWriteCount() > 0 && (sync.events.length > 0 || deployedSymbol || excess.length > 0)) {
      await flushPendingWrites().catch((e) => console.warn('Tick milestone flush error:', e));
    }

    ticksCount += 1;
    lastTickAt = Date.now();
    lastTickDurationMs = lastTickAt - startTime;
    lastTickSummary = `Tick #${ticksCount}: ${open.length} open, ${sync.updatedCount} updated, ` +
      `${deployedSymbol ? `deployed ${deployedSymbol}` : 'no deploy'}, ${getPendingWriteCount()} change(s) waiting for the next Firestore save`;
    return { success: true, updatedCount: sync.updatedCount, events: sync.events, deployedSymbol, durationMs: lastTickDurationMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logEvent(`Tick error: ${error}`, 'warn');
    lastTickSummary = `Error: ${error}`;
    return { success: false, error, durationMs: Date.now() - startTime };
  }
}

// ---------------------------------------------------------------- Firestore backup

/** Writes queued changes to Firestore now (also runs every WORKER_FLUSH_MINUTES). */
export function flushNow(): Promise<number> {
  return exclusive('flushNow', async () => {
    const pending = getPendingWriteCount();
    if (!pending) return 0;
    const written = await flushPendingWrites();
    const f = getLastFlush();
    if (f.error) logEvent(`Firestore save failed after ${written} of ${pending}; kept for the next save: ${f.error}`, 'warn');
    else if (written) logEvent(`Saved ${written} change(s) to Firestore`);
    return written;
  }, 15_000);
}

/**
 * One sync round: flushes pending writes down to Firestore.
 * When `full` is true (e.g. on manual resync or cold start), reconciles with Firestore.
 * In server-first architecture, the server memory is authoritative and writes down to Firestore with ZERO read churn.
 */
export function syncWithFirestore(full = false): Promise<ReconcileResult | null> {
  return exclusive('syncWithFirestore', async () => {
    if (!hasConfirmedTradeList()) return null;
    let r: ReconcileResult | null = null;
    if (full) {
      r = await reconcileWithFirestore(true);
    }
    await flushPendingWrites();
    const f = getLastFlush();
    if (r?.error) logEvent(`Firestore check failed: ${r.error}`, 'warn');
    else if (r && (r.pulled || r.pushed)) logEvent(`Firestore full check: pulled ${r.pulled} newer from Firestore, pushed ${r.pushed} newer from the server`);
    if (f.error) logEvent(`Firestore save failed; kept for the next round: ${f.error}`, 'warn');
    return r ?? { at: Date.now(), full: false, read: 0, pulled: 0, pushed: 0, error: null };
  }, 25_000);
}

// ---------------------------------------------------------------- actions
//
// Every change a browser asks for goes through here, so the server's list
// stays the one source of truth. Each runs exclusively and is queued for the
// next Firestore save like any other change.

export class ActionError extends Error {}

function findTrade(id: string) {
  const trade = loadLocalTrades().find((t) => t.id === id);
  if (!trade) throw new ActionError(`No trade ${id}`);
  return trade;
}

/** Closes an open trade at its latest price (manual close or stagnation recycle). */
export function closeTradeById(id: string, reason: 'manual' | 'time_decay' = 'manual') {
  return exclusive('closeTrade', async () => {
    const trade = findTrade(id);
    if (trade.status !== 'OPEN') throw new ActionError(`${trade.symbol} is already closed`);
    const price = trade.currentPrice || trade.entryPrice;
    const closed = closeTradeAt(trade, price, reason === 'time_decay' ? 'CLOSED_TIME_DECAY' : 'CLOSED_MANUAL');
    await updateAutomatedTrade(closed, true);
    await Promise.race([
      flushPendingWrites(),
      new Promise((r) => setTimeout(r, 4000)),
    ]).catch((err) => console.warn('Immediate close flush error:', err));
    logEvent(`${trade.symbol} closed by request (${reason}) at ${price}`, 'info');
    return closed;
  }, 12_000);
}

/**
 * Excludes a trade from statistics, or counts it again. Only a closed record
 * can be excluded, as in the Data Health panel: an open position holds its
 * slot and its capital whatever is said about its numbers, so excluding it
 * would only hide it from the screen while it still blocked new entries.
 */
export function setTradeExcluded(id: string, excluded: boolean) {
  return exclusive('setTradeExcluded', async () => {
    const trade = findTrade(id);
    if (excluded && trade.status === 'OPEN') {
      throw new ActionError(`${trade.symbol} is still open. Close it first, then exclude the record.`);
    }
    const updated = {
      ...trade,
      excludedFromStats: excluded,
      excludedReason: excluded ? 'Excluded from statistics in the Data Health panel' : '',
    };
    await updateAutomatedTrade(updated, true);
    await Promise.race([
      flushPendingWrites(),
      new Promise((r) => setTimeout(r, 4000)),
    ]).catch((err) => console.warn('Immediate exclude flush error:', err));
    logEvent(`${trade.symbol} ${excluded ? 'excluded from' : 'counted in'} statistics by request`);
    return updated;
  }, 12_000);
}

/** Opens a position in `symbol` from the server's own latest scan (manual deploy). */
export function deploySymbol(symbol: string) {
  return exclusive('deploySymbol', async () => {
    if (!hasConfirmedTradeList()) throw new ActionError('The trade list is still loading');
    if (!lastCoins.length) throw new ActionError('No prices yet; try again in 30 seconds');
    const signal = scanLiveMarketEntries(lastCoins, 'FUTURES_1_2D').find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
    if (!signal) throw new ActionError(`No current signal for ${symbol}`);
    const book = visibleTrades(loadLocalTrades());
    const bankroll = calculateBankrollState(book);
    const blocked = manualDeployBlockReason(signal, book, bankroll);
    if (blocked) throw new ActionError(blocked);
    const trade = await deploySignalToAutomatedFeed(signal, bankroll.trancheSizeUSD);
    await Promise.race([
      flushPendingWrites(),
      new Promise((r) => setTimeout(r, 4000)),
    ]).catch((err) => console.warn('Immediate deploy flush error:', err));
    logEvent(`Deployed $${trade.positionSizeUSD.toFixed(2)} into ${signal.symbol} by request`, 'success');
    return trade;
  }, 15_000);
}

/** Rebuilds the list from a full Firestore read (after edits made directly in Firestore or cache clear). */
export function resyncFromFirestore(clearServerCache = false) {
  return exclusive('resyncFromFirestore', async () => {
    if (clearServerCache) {
      logEvent('Wiping server-side trade cache before fresh Firestore resync...', 'info');
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('crypto_automated_trades_local_fallback');
          localStorage.removeItem('crypto_automated_trades_sync_cursor');
          localStorage.removeItem('crypto_automated_trades_full_sync_at');
          localStorage.removeItem('crypto_automated_trades_reconcile_cursor');
          localStorage.removeItem('crypto_automated_trades_sync_version');
          localStorage.removeItem('crypto_automated_trades_pending_writes');
        }
      } catch {}
      bootId = Math.random().toString(36).slice(2, 10);
      feedVersion++;
      tradeSignature.clear();
      changedAtVersion.clear();
      removedAtVersion.clear();
      saveStateNow();
    }
    const ok = await forceFullResync();
    logEvent(ok ? 'Rebuilt the trade list from Firestore' : 'Rebuild from Firestore failed; list unchanged', ok ? 'info' : 'warn');
    return ok;
  }, 25_000);
}

/**
 * Completely resets and clears all data:
 * 1. Purges all trade documents from Firestore (crypto_automated_trades)
 * 2. Wipes server memory storage and mirrors empty state to worker-state.json
 * 3. Resets all tracking versions, counters, and feeds
 * 4. Logs the event and returns success
 */
export function resetWorkerAndDatabase() {
  return exclusive('resetWorkerAndDatabase', async () => {
    logEvent('Initiating complete data reset: wiping Firestore and server state...', 'warn');
    await resetAutomatedTrades();

    // Wipe local state file and memory storage
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.clear();
      }
    } catch {}
    saveStateNow();

    // Re-initialize core tracking
    bootId = Math.random().toString(36).slice(2, 10);
    feedVersion = 1;
    tradeSignature.clear();
    changedAtVersion.clear();
    removedAtVersion.clear();
    ticksCount = 0;
    lastTickAt = null;
    lastDeployAt = 0;
    openPositionsCount = 0;
    lastDecision = {};
    lastTickSummary = 'System reset complete. Fresh start with $100 starting capital.';

    // Save fresh clean worker state
    saveStateNow();

    logEvent('System reset complete: Firestore and server memory are completely empty. Ready to trade fresh.', 'success');
    return {
      success: true,
      message: 'All data cleared from Firebase and local server. System reset fresh to $100 cash.',
      bootId,
    };
  }, 35_000);
}

export function startTradingWorker(intervalMs = 30_000): void {
  if (isWorkerRunning) return;
  if (process.env.TRADING_WORKER === 'off') {
    disabledReason = 'Disabled by TRADING_WORKER=off';
  } else if (process.env.TRADING_WORKER !== 'on' && process.env.NODE_ENV !== 'production') {
    // `npm run dev` runs this same server. Without this, every local run and
    // every AI Studio preview would be a second bot trading into the shared
    // database - the cause of duplicate positions and more than 10 open.
    // Only the deployed server (NODE_ENV=production) trades, or a run that
    // asks for it with TRADING_WORKER=on.
    disabledReason = 'Development run (NODE_ENV is not production): set TRADING_WORKER=on to trade from here';
  } else if (!FIRESTORE_WRITES_ENABLED) {
    disabledReason = 'Read-only copy (VITE_FIRESTORE_WRITES=off): trades would exist only in server memory';
  }
  if (disabledReason) {
    logEvent(`Not started. ${disabledReason}`, 'warn');
    return;
  }
  isWorkerRunning = true;
  enableServerWriterMode();
  try {
    const saved = localStorage.getItem(AUTOPILOT_KEY);
    if (saved === 'true' || saved === 'false') isAutoPilot = saved === 'true';
  } catch {}

  // One-time read of auto-pilot setting from Firestore on startup (no continuous listener)
  if (FIRESTORE_WRITES_ENABLED) {
    try {
      const configRef = doc(db, 'crypto_automated_config', 'autopilot');
      getDocFromServer(configRef).then((snap) => {
        const data = typeof snap?.exists === 'function' && snap.exists() && typeof snap.data === 'function'
          ? snap.data()
          : null;
        if (typeof data?.enabled === 'boolean') {
          isAutoPilot = data.enabled;
          try {
            localStorage.setItem(AUTOPILOT_KEY, String(data.enabled));
            saveStateNow();
          } catch {}
          logEvent(`Auto-pilot initialized from Firestore on startup: ${data.enabled ? 'on' : 'off'}`);
        }
        if (typeof data?.allowShorts === 'boolean') {
          setAllowShorts(data.allowShorts);
          logEvent(`Short trading initialized from Firestore on startup: ${data.allowShorts ? 'enabled' : 'disabled'}`);
        }
        if (typeof data?.strategyProfile === 'string' && data.strategyProfile in STRATEGY_PROFILES) {
          setActiveStrategyProfile(data.strategyProfile as StrategyProfileId);
          logEvent(`Strategy profile initialized from Firestore on startup: ${data.strategyProfile}`);
        }
      }).catch((err) => {
        console.warn('[TradingWorker] Initial Firestore autopilot config read error:', err?.message || err);
      });
    } catch (err) {
      console.warn('[TradingWorker] Setup Firestore config read error:', err);
    }
  }

  logEvent(`Started: tick every ${intervalMs / 1000}s, Firestore flush every ${FLUSH_EVERY_MS / 60_000} min, ` +
    `auto-pilot ${isAutoPilot ? 'on' : 'off'}, state file ${STATE_FILE}`);

  // One read at startup. Without a saved list, subscribe() builds it from a
  // full Firestore read (the server keeps no listener after that); resumed
  // from the state file, every trade is compared once instead. After that the
  // server runs from memory and only writes. Without the subscribe() a fresh
  // start had nothing to confirm its list, so it did not trade until a later
  // tick happened to resubscribe.
  subscribe();
  if (hasConfirmedTradeList()) syncWithFirestore(true).catch((e) => console.error('Startup Firestore read sync error:', e));
  flushTimer = setInterval(() => { flushNow().catch((e) => console.error('Flush error:', e)); }, FLUSH_EVERY_MS);
  usageTimer = setInterval(() => logEvent(`Firestore usage: ${usageSummary()}`), 3_600_000);
  executeTradingTick().catch((e) => console.error('Worker tick error:', e));
  intervalTimer = setInterval(() => {
    executeTradingTick().catch((e) => console.error('Worker tick error:', e));
  }, intervalMs);
}

export function stopTradingWorker(): void {
  if (!isWorkerRunning) return;
  if (intervalTimer) clearInterval(intervalTimer);
  if (flushTimer) clearInterval(flushTimer);
  if (fullReconcileTimer) clearInterval(fullReconcileTimer);
  if (usageTimer) clearInterval(usageTimer);
  intervalTimer = flushTimer = fullReconcileTimer = usageTimer = null;
  unsubscribe?.();
  unsubscribe = null;
  configUnsubscribe?.();
  configUnsubscribe = null;
  isWorkerRunning = false;
  saveStateNow();
  logEvent('Stopped');
}

/**
 * For server shutdown: saves queued changes to Firestore (within `timeoutMs`,
 * e.g. Cloud Run's 10s shutdown window), then stops. What does not make it
 * stays in the state file.
 */
export async function shutdownTradingWorker(timeoutMs = 8000): Promise<void> {
  if (!isWorkerRunning) return;
  await Promise.race([flushNow().catch(() => 0), new Promise((r) => setTimeout(r, timeoutMs))]);
  stopTradingWorker();
}

export function setWorkerAutoPilot(enabled: boolean): void {
  isAutoPilot = enabled;
  try {
    localStorage.setItem(AUTOPILOT_KEY, String(enabled));
    saveStateNow();
  } catch {}
  logEvent(`Auto-pilot ${enabled ? 'on' : 'off'}`);

  if (FIRESTORE_WRITES_ENABLED) {
    try {
      const configRef = doc(db, 'crypto_automated_config', 'autopilot');
      setDoc(configRef, {
        enabled,
        updatedAt: Date.now(),
        updatedBy: 'server',
      }, { merge: true }).catch((err) => {
        console.warn('[TradingWorker] Failed to write autopilot config to Firestore:', err);
      });
    } catch (err) {
      console.warn('[TradingWorker] Failed to setup Firestore autopilot setDoc:', err);
    }
  }
}

export function setWorkerAllowShorts(allowed: boolean): void {
  setAllowShorts(allowed);
  logEvent(`Short trading ${allowed ? 'enabled' : 'disabled'}`);

  if (FIRESTORE_WRITES_ENABLED) {
    try {
      const configRef = doc(db, 'crypto_automated_config', 'autopilot');
      setDoc(configRef, {
        allowShorts: allowed,
        updatedAt: Date.now(),
        updatedBy: 'server',
      }, { merge: true }).catch((err) => {
        console.warn('[TradingWorker] Failed to write allowShorts to Firestore:', err);
      });
    } catch (err) {
      console.warn('[TradingWorker] Failed to setup Firestore allowShorts setDoc:', err);
    }
  }
}

/**
 * Sets the exit profile the server opens trades with. The server is the one
 * trading, so a profile chosen in a browser has to reach it; it is kept across
 * restarts in the same config document as the auto-pilot switch. Open trades
 * keep the ladder they were opened with.
 */
export function setWorkerStrategyProfile(id: StrategyProfileId): void {
  const profile = setActiveStrategyProfile(id);
  logEvent(`Strategy profile set to ${profile.name}`);

  if (FIRESTORE_WRITES_ENABLED) {
    try {
      const configRef = doc(db, 'crypto_automated_config', 'autopilot');
      setDoc(configRef, {
        strategyProfile: profile.id,
        updatedAt: Date.now(),
        updatedBy: 'server',
      }, { merge: true }).catch((err) => {
        console.warn('[TradingWorker] Failed to write strategyProfile to Firestore:', err);
      });
    } catch (err) {
      console.warn('[TradingWorker] Failed to setup Firestore strategyProfile setDoc:', err);
    }
  }
}

export function getInstanceId(): string {
  return bootId;
}

export function getWorkerStatus(): WorkerStatus {
  return {
    instanceId: bootId,
    workerRunning: isWorkerRunning,
    disabledReason,
    isAutoPilot,
    allowShorts: AUTOPILOT_CONFIG.allowShorts,
    strategyProfile: getActiveStrategyProfile().id,
    ticksCount,
    lastTickAt,
    tickAgeMs: lastTickAt === null ? null : Date.now() - lastTickAt,
    lastTickDurationMs,
    lastDeployAt,
    openPositionsCount,
    lastTickSummary,
    lastDecision,
    sync: {
      firestore: getFirestoreHealth(),
      pendingWrites: getPendingWriteCount(),
      lastFlushAt: getLastFlush().at || null,
      lastFlushWritten: getLastFlush().written,
      lastFlushError: getLastFlush().error,
      flushEveryMs: FLUSH_EVERY_MS,
      lastReconcile: getLastReconcile(),
      usage: getUsage(),
      stateFile: STATE_FILE,
    },
    recentLogs: recentLogs.slice(0, 20),
  };
}
