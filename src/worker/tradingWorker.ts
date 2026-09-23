// Must be first: the data layer below keeps its working state in localStorage.
import { saveStateNow, STATE_FILE } from './memoryStorage';
import { db, FIRESTORE_WRITES_ENABLED, getFirestoreHealth, FirestoreHealth } from '../lib/firebase';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
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
} from '../services/automatedFeedService';
import { closeTradeAt } from '../services/cycleEngineService';
import { CryptoCoin } from '../types';
import { scanLiveMarketEntries, deploySignalToAutomatedFeed } from '../services/entryScannerService';
import { calculateBankrollState } from '../services/bankrollService';
import { catchUpOpenTrades } from '../services/catchUpService';
import { computePacing, selectAutoPilotCandidate, manualDeployBlockReason, findExcessOpenTrades } from '../services/autopilotEngine';
import { isCounted, isClosed } from '../services/metrics';
import { AutomatedTradeRecord } from '../types/automatedFeed';

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
 *   WORKER_FLUSH_MINUTES=1    how often changes are written to / checked against Firestore
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
const FLUSH_EVERY_MS = Math.max(1, Number(process.env.WORKER_FLUSH_MINUTES) || 1) * 60_000;
const FULL_RECONCILE_EVERY_MS = 24 * 3_600_000;
const AUTOPILOT_KEY = 'cryptostudy_worker_autopilot';
const MAX_PRICE_AGE_MS = 120_000;
const RESUBSCRIBE_AFTER_MS = 60_000;

let isWorkerRunning = false;
let disabledReason: string | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let fullReconcileTimer: ReturnType<typeof setInterval> | null = null;
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

// One at a time: ticks, actions, flushes.
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
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

const bootId = Math.random().toString(36).slice(2, 10);
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
  return exclusive(runTick).finally(() => { isTickInFlight = false; });
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
      const counted = current.filter(isCounted);
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
  return exclusive(async () => {
    const pending = getPendingWriteCount();
    if (!pending) return 0;
    const written = await flushPendingWrites();
    const f = getLastFlush();
    if (f.error) logEvent(`Firestore save failed after ${written} of ${pending}; kept for the next save: ${f.error}`, 'warn');
    else if (written) logEvent(`Saved ${written} change(s) to Firestore`);
    return written;
  });
}

/**
 * One sync round: write what is queued, then compare with Firestore (changes
 * since the last round, or every trade when `full`) - pulling trades Firestore
 * has newer, queueing trades the server has newer - and write those too.
 */
export function syncWithFirestore(full = false): Promise<ReconcileResult | null> {
  return exclusive(async () => {
    if (!hasConfirmedTradeList()) return null;
    await flushPendingWrites();
    const r = await reconcileWithFirestore(full);
    if (r.pushed) await flushPendingWrites();
    const f = getLastFlush();
    if (r.error) logEvent(`Firestore check failed: ${r.error}`, 'warn');
    else if (r.pulled || r.pushed) logEvent(`Firestore ${r.full ? 'full ' : ''}check: pulled ${r.pulled} newer from Firestore, pushed ${r.pushed} newer from the server`);
    if (f.error) logEvent(`Firestore save failed; kept for the next round: ${f.error}`, 'warn');
    return r;
  });
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
  return exclusive(async () => {
    const trade = findTrade(id);
    if (trade.status !== 'OPEN') throw new ActionError(`${trade.symbol} is already closed`);
    const price = trade.currentPrice || trade.entryPrice;
    const closed = closeTradeAt(trade, price, reason === 'time_decay' ? 'CLOSED_TIME_DECAY' : 'CLOSED_MANUAL');
    await updateAutomatedTrade(closed, true);
    logEvent(`${trade.symbol} closed by request (${reason}) at ${price}`, 'info');
    return closed;
  });
}

/** Excludes a trade from statistics, or counts it again. */
export function setTradeExcluded(id: string, excluded: boolean) {
  return exclusive(async () => {
    const trade = findTrade(id);
    const updated = {
      ...trade,
      excludedFromStats: excluded,
      excludedReason: excluded ? 'Excluded from statistics in the Data Health panel' : '',
    };
    await updateAutomatedTrade(updated, true);
    logEvent(`${trade.symbol} ${excluded ? 'excluded from' : 'counted in'} statistics by request`);
    return updated;
  });
}

/** Opens a position in `symbol` from the server's own latest scan (manual deploy). */
export function deploySymbol(symbol: string) {
  return exclusive(async () => {
    if (!hasConfirmedTradeList()) throw new ActionError('The trade list is still loading');
    if (!lastCoins.length) throw new ActionError('No prices yet; try again in 30 seconds');
    const signal = scanLiveMarketEntries(lastCoins, 'FUTURES_1_2D').find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
    if (!signal) throw new ActionError(`No current signal for ${symbol}`);
    const counted = loadLocalTrades().filter(isCounted);
    const bankroll = calculateBankrollState(counted);
    const blocked = manualDeployBlockReason(signal, counted, bankroll);
    if (blocked) throw new ActionError(blocked);
    const trade = await deploySignalToAutomatedFeed(signal, bankroll.trancheSizeUSD);
    logEvent(`Deployed $${trade.positionSizeUSD.toFixed(2)} into ${signal.symbol} by request`, 'success');
    return trade;
  });
}

/** Rebuilds the list from a full Firestore read (after edits made directly in Firestore). */
export function resyncFromFirestore() {
  return exclusive(async () => {
    const ok = await forceFullResync();
    logEvent(ok ? 'Rebuilt the trade list from Firestore' : 'Rebuild from Firestore failed; list unchanged', ok ? 'info' : 'warn');
    return ok;
  });
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

  // Sync auto-pilot setting with Firestore config so all browsers and servers stay identical
  if (FIRESTORE_WRITES_ENABLED) {
    try {
      const configRef = doc(db, 'crypto_automated_config', 'autopilot');
      configUnsubscribe = onSnapshot(configRef, (snap) => {
        // Defensive: only a document snapshot has exists()/data().
        const data = typeof snap?.exists === 'function' && snap.exists() && typeof snap.data === 'function'
          ? snap.data()
          : null;
        if (typeof data?.enabled === 'boolean' && data.enabled !== isAutoPilot) {
          isAutoPilot = data.enabled;
          try {
            localStorage.setItem(AUTOPILOT_KEY, String(data.enabled));
            saveStateNow();
          } catch {}
          logEvent(`Auto-pilot synced from Firestore: ${data.enabled ? 'on' : 'off'}`);
        }
      }, (err) => {
        console.warn('[TradingWorker] Firestore autopilot config listener:', err?.message || err);
      });
    } catch (err) {
      console.warn('[TradingWorker] Setup Firestore config listener error:', err);
    }
  }

  subscribe();
  logEvent(`Started: tick every ${intervalMs / 1000}s, Firestore sync every ${FLUSH_EVERY_MS / 60_000} min, ` +
    `auto-pilot ${isAutoPilot ? 'on' : 'off'}, state file ${STATE_FILE}`);
  // Resumed from the state file (no Firestore read was needed to build the
  // list): compare every trade now, to catch anything changed meanwhile.
  if (hasConfirmedTradeList()) syncWithFirestore(true).catch((e) => console.error('Startup sync error:', e));
  flushTimer = setInterval(() => { syncWithFirestore(false).catch((e) => console.error('Sync error:', e)); }, FLUSH_EVERY_MS);
  fullReconcileTimer = setInterval(() => { syncWithFirestore(true).catch((e) => console.error('Sync error:', e)); }, FULL_RECONCILE_EVERY_MS);
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
  intervalTimer = flushTimer = fullReconcileTimer = null;
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

export function getInstanceId(): string {
  return bootId;
}

export function getWorkerStatus(): WorkerStatus {
  return {
    instanceId: bootId,
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
    sync: {
      firestore: getFirestoreHealth(),
      pendingWrites: getPendingWriteCount(),
      lastFlushAt: getLastFlush().at || null,
      lastFlushWritten: getLastFlush().written,
      lastFlushError: getLastFlush().error,
      flushEveryMs: FLUSH_EVERY_MS,
      lastReconcile: getLastReconcile(),
      stateFile: STATE_FILE,
    },
    recentLogs: recentLogs.slice(0, 20),
  };
}
