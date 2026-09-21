import {
  collection,
  query,
  where,
  getDocsFromServer,
  getDocs,
  setDoc,
  doc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { db, isQuotaBlocked, markQuotaExceeded, reportFirestoreResult, getFirestoreHealth, FIRESTORE_WRITES_ENABLED } from '../lib/firebase';
import { outcome } from './metrics';
import { AutomatedTradeRecord, AutomatedFeedAuditStats, StrategyVerificationReport } from '../types/automatedFeed';
import { CryptoCoin } from '../types';
import { evaluateTradeCycle } from './cycleEngineService';
import { 
  isTradeZombieStale, 
  getBankrollConfig, 
  MAX_CONCURRENT_TRADES, 
  calculateBankrollState, 
  calculateStrategyVerification 
} from './bankrollService';
import { MAJOR_COINS, MAX_MAJOR_COIN_SLOTS } from '../types/entryScanner';

const TRADES_COLLECTION = 'crypto_automated_trades';
const FIRESTORE_READ_TIMEOUT_MS = 8000;
const LOCAL_STORAGE_KEY = 'crypto_automated_trades_local_fallback';

type TradesSubscriber = (trades: AutomatedTradeRecord[]) => void;
const subscribers = new Set<TradesSubscriber>();

export interface SlotConflicts {
  /** Open trades beyond the first on the same coin (newest kept first). */
  duplicateIds: string[];
  /** Open positions in total. */
  openCount: number;
  /** True when open positions exceed MAX_CONCURRENT_TRADES. */
  overLimit: boolean;
}

/** Reports duplicate coins and over-limit open positions without changing anything. */
export function findSlotConflicts(trades: AutomatedTradeRecord[]): SlotConflicts {
  const open = trades
    .filter((t) => t.status === 'OPEN')
    .sort((a, b) => (b.openedAtTimestamp || 0) - (a.openedAtTimestamp || 0));
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const t of open) {
    const sym = t.symbol.toUpperCase();
    if (seen.has(sym)) duplicateIds.push(t.id);
    else seen.add(sym);
  }
  return { duplicateIds, openCount: open.length, overLimit: open.length > MAX_CONCURRENT_TRADES };
}

let lastConflictSignature = '';

/**
 * Previously this CLOSED any open trade beyond the per-coin or slot limits -
 * at whatever price was current, with P&L 0, writing COMPLETED to Firestore -
 * and it ran on every load, save and notification. The limits are already
 * enforced when a trade is opened (executeSimulatedTrade, auto-pilot), so a
 * conflict can only come from a race such as two browsers deploying at once;
 * closing the older real position is the worst response to that. In the live
 * history it had closed 18 positions (DUPLICATE_ASSET_CONSOLIDATED /
 * EXCESS_SLOT_REBALANCED), and on 2026-09-21 it closed a UNI and an LDO
 * position when a test run opened trades concurrently.
 *
 * It now returns the list unchanged and only reports conflicts. New entries are
 * still blocked while the limit is exceeded; existing positions run to their
 * own stops and targets.
 */
export function sanitizeActiveTrades(trades: AutomatedTradeRecord[]): AutomatedTradeRecord[] {
  const c = findSlotConflicts(trades);
  const signature = `${c.duplicateIds.join(',')}|${c.overLimit ? c.openCount : ''}`;
  if (signature !== '|' && signature !== lastConflictSignature) {
    lastConflictSignature = signature;
    console.warn(
      `[Slots] ${c.openCount} open position(s)` +
      (c.overLimit ? ` - above the ${MAX_CONCURRENT_TRADES} limit, so no new entries until some close` : '') +
      (c.duplicateIds.length ? `; duplicate coin positions: ${c.duplicateIds.join(', ')}` : '') +
      '. Nothing is closed automatically.'
    );
  }
  return trades;
}

function notifySubscribers(trades: AutomatedTradeRecord[]) {
  const sanitized = sanitizeActiveTrades(trades);
  subscribers.forEach((cb) => {
    try {
      cb(sanitized);
    } catch (e) {
      console.error('Subscriber notification error:', e);
    }
  });
}

// No window check: the 24/7 server worker installs an in-memory localStorage
// (src/worker/memoryStorage.ts) so this layer behaves the same in Node.
function safeGetLocalStorage(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
  } catch {}
  return null;
}

function safeSetLocalStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {}
}

// ---------------------------------------------------------------- database first
//
// Firestore is the record; this copy's saved list is a working cache of it.
// Two rules keep them from drifting apart:
//  1. Nothing is evaluated or deployed until Firestore has delivered the list
//     (or has clearly failed - see isTradeListAuthoritative).
//  2. A write that fails is queued and retried, not left in this browser only.
//     Queued trades survive the merge until their write lands.

const PENDING_KEY = 'crypto_automated_trades_pending_writes';
type PendingOp = 'create' | 'update';

function getPending(): Record<string, PendingOp> {
  try {
    const v = JSON.parse(safeGetLocalStorage(PENDING_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function setPending(id: string, op: PendingOp | null): void {
  const p = getPending();
  if (op) p[id] = p[id] === 'create' ? 'create' : op;   // a create stays a create
  else delete p[id];
  safeSetLocalStorage(PENDING_KEY, JSON.stringify(p));
}

/** Trades whose latest change has not reached Firestore yet. */
export function getPendingWriteCount(): number {
  return Object.keys(getPending()).length;
}

let firstSnapshotAt = 0;
let subscribedAt = 0;
const FIRESTORE_WAIT_MS = 20_000;

/**
 * May this copy act on its trade list - evaluate stops, open trades? Only once
 * Firestore has delivered it. If Firestore is known to be failing, or has not
 * answered within 20s, the saved copy is used (and its writes queue for later)
 * so an outage does not stop trading. A read-only copy is its own record.
 */
export function isTradeListAuthoritative(now: number = Date.now()): boolean {
  if (!FIRESTORE_WRITES_ENABLED || firstSnapshotAt > 0) return true;
  const health = getFirestoreHealth();
  if (health === 'denied' || health === 'quota' || health === 'offline') return true;
  return subscribedAt > 0 && now - subscribedAt > FIRESTORE_WAIT_MS;
}

function isNotFound(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('not-found') || msg.includes('no document');
}

let flushing = false;

/** Retries queued writes. A queued update for a trade deleted in Firestore is dropped: the database wins. */
export async function flushPendingWrites(): Promise<number> {
  if (flushing || !FIRESTORE_WRITES_ENABLED || isQuotaBlocked()) return 0;
  const pending = getPending();
  const ids = Object.keys(pending);
  if (!ids.length) return 0;
  flushing = true;
  let written = 0;
  try {
    const local = new Map(loadLocalTrades().map((t) => [t.id, t]));
    for (const id of ids) {
      const t = local.get(id);
      if (!t) { setPending(id, null); continue; }
      try {
        if (pending[id] === 'create') await setDoc(doc(db, TRADES_COLLECTION, id), stamped(t));
        else await updateDoc(doc(db, TRADES_COLLECTION, id), stamped(t));
        setPending(id, null);
        written++;
      } catch (err) {
        if (isNotFound(err)) { setPending(id, null); continue; }
        reportFirestoreResult(err);
        break;   // still failing; try again on the next snapshot
      }
    }
  } finally {
    flushing = false;
  }
  if (written) console.info(`[Firestore] ${written} queued write(s) saved.`);
  return written;
}

function filledTiers(t: AutomatedTradeRecord): number {
  const h = t.harvestTiers;
  return h ? [h.tier1, h.tier2, h.tier3].filter((x) => x && x.status !== 'PENDING').length : 0;
}

/**
 * Brings this copy's saved trades in line with a Firestore snapshot.
 *
 * The saved copy is what every 30s refresh evaluates and displays, and until
 * now nothing ever refreshed it from Firestore. Each browser kept its own
 * version of history: a correction made in Firestore (the two TAO trades
 * reduced from $11.57 and $11.64 to about $0) never reached a browser that
 * already had them saved, so that browser went on showing $23.21 more profit
 * than the others. Trades opened elsewhere were also invisible to its slot
 * count, which is how 13 positions came to be open against a limit of 10.
 *
 * Firestore is the record. Per trade:
 *  - closed in Firestore: Firestore's version (closes and corrections win)
 *  - closed here, open in Firestore: ours (a close whose write has not landed)
 *  - open in both: the one further along the exit ladder; on a tie ours,
 *    which has the fresher price, session high and low
 * Trades only this copy has are dropped once they are older than a few
 * minutes: Firestore includes writes still in flight, so anything older that
 * is missing was deleted or never reached it.
 */
export function mergeRemoteTrades(
  remote: AutomatedTradeRecord[],
  local: AutomatedTradeRecord[],
  now: number = Date.now(),
  pendingIds: Set<string> = new Set()
): AutomatedTradeRecord[] {
  const localById = new Map(local.map((t) => [t.id, t]));
  const remoteIds = new Set(remote.map((t) => t.id));
  const merged = remote.map((r) => pickTrade(r, localById.get(r.id), pendingIds));
  for (const l of local) {
    if (remoteIds.has(l.id)) continue;
    if (pendingIds.has(l.id) || now - (l.openedAtTimestamp || 0) < 5 * 60_000) merged.push(l);
  }
  return merged;
}

/** Which version of one trade to keep: Firestore's (r) or this copy's (l). See mergeRemoteTrades. */
function pickTrade(r: AutomatedTradeRecord, l: AutomatedTradeRecord | undefined, pendingIds: Set<string>): AutomatedTradeRecord {
  if (l && pendingIds.has(r.id)) return l;   // our change has not landed yet
  if (!l || r.status !== 'OPEN') return r;
  if (l.status !== 'OPEN') return l;
  if (filledTiers(r) > filledTiers(l)) return r;
  return { ...l, excludedFromStats: r.excludedFromStats, excludedReason: r.excludedReason };
}

function sortTrades(trades: AutomatedTradeRecord[]): AutomatedTradeRecord[] {
  return trades.sort((a, b) => {
    if (a.status === 'OPEN' && b.status !== 'OPEN') return -1;
    if (a.status !== 'OPEN' && b.status === 'OPEN') return 1;
    return (b.openedAtTimestamp || 0) - (a.openedAtTimestamp || 0);
  });
}

/**
 * Clean trades list (no sample or mock trades). Real paper trades are deployed by the user.
 */
export const SEED_TRADES: AutomatedTradeRecord[] = [];

/**
 * Trades from this browser's storage only - no network. Used by the 30s price
 * loop, which must never wait on Firestore: when storage was empty (a fresh
 * browser) the old path fell through to a Firestore read that could hang.
 */
export function loadLocalTrades(): AutomatedTradeRecord[] {
  try {
    const parsed = JSON.parse(safeGetLocalStorage(LOCAL_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? sanitizeActiveTrades(parsed) : [];
  } catch {
    return [];
  }
}

export async function fetchAutomatedTrades(forceNetwork: boolean = false): Promise<AutomatedTradeRecord[]> {
  let loadedTrades: AutomatedTradeRecord[] | null = null;

  // 1. Check local storage cache first to save read quotas
  if (!forceNetwork || isQuotaBlocked()) {
    try {
      const local = safeGetLocalStorage(LOCAL_STORAGE_KEY);
      if (local) {
        const parsed = JSON.parse(local);
        if (Array.isArray(parsed)) {
          loadedTrades = parsed;
        }
      }
    } catch (e) {
      console.warn('LocalStorage load failed:', e);
    }
  }

  // 2. Fetch from Firestore only if requested or if local storage was completely empty
  if (!loadedTrades && !isQuotaBlocked()) {
    try {
      const colRef = collection(db, TRADES_COLLECTION);
      // The SDK can retry silently instead of failing; never wait on it forever.
      const snap = await Promise.race([
        getDocs(colRef),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Firestore read timed out (offline)')), FIRESTORE_READ_TIMEOUT_MS)),
      ]);
      if (!snap.empty) {
        const trades: AutomatedTradeRecord[] = [];
        snap.forEach((docSnap) => {
          trades.push(docSnap.data() as AutomatedTradeRecord);
        });
        loadedTrades = trades;
      } else {
        loadedTrades = [];
      }
    } catch (err) {
      reportFirestoreResult(err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('resource-exhausted') || msg.toLowerCase().includes('quota')) {
        markQuotaExceeded();
      }
      console.warn('Firestore fetch fallback to local storage:', err);
    }
  }

  // 3. Fallback to localStorage if network read failed
  if (!loadedTrades) {
    try {
      const local = safeGetLocalStorage(LOCAL_STORAGE_KEY);
      if (local) {
        const parsed = JSON.parse(local);
        if (Array.isArray(parsed) && parsed.length > 0) {
          loadedTrades = parsed;
        }
      }
    } catch {}
  }

  // 4. Clean start if no data exists anywhere
  if (!loadedTrades) {
    loadedTrades = [];
  }

  const sanitized = sanitizeActiveTrades(loadedTrades);
  // Sort: Open trades first, then by openedAtTimestamp descending
  sanitized.sort((a, b) => {
    if (a.status === 'OPEN' && b.status !== 'OPEN') return -1;
    if (a.status !== 'OPEN' && b.status === 'OPEN') return 1;
    return (b.openedAtTimestamp || 0) - (a.openedAtTimestamp || 0);
  });

  safeSetLocalStorage(LOCAL_STORAGE_KEY, JSON.stringify(sanitized));

  return sanitized;
}

// ---------------------------------------------------------------- sync
//
// Reads are the free-tier constraint (50,000 a day), and every document a
// query returns is one read. Listening to the whole collection re-read the
// entire history - about 70 new trades a day, 2,000 a month - on every page
// load, again for every extra subscriber (the History tab opened a second
// listener) and again for a forced refresh. Within a couple of months a
// handful of page loads a day would have used the whole quota.
//
// Now there is one listener per copy, however many views subscribe, and it
// only asks for trades changed since this copy last synced. Every write
// stamps updatedAt with the server's clock. The whole collection is read
// only when this copy has nothing saved (a new browser, a server start), or
// once a week to pick up deletions, which a changes-only query cannot see.
// Anything that edits trades outside the app must set updatedAt too, or the
// change only arrives with the weekly full read.

const SYNC_CURSOR_KEY = 'crypto_automated_trades_sync_cursor';
const FULL_SYNC_AT_KEY = 'crypto_automated_trades_full_sync_at';
const FULL_SYNC_EVERY_MS = 7 * 86_400_000;
const CURSOR_MARGIN_MS = 5 * 60_000;        // covers clock differences between copies
const LISTENER_RENEW_MS = 12 * 3_600_000;   // keeps a long-running listener's result set small
const SYNC_RETRY_MS = 60_000;

function stamped(t: AutomatedTradeRecord): Record<string, unknown> {
  return { ...t, updatedAt: serverTimestamp() };
}

function updatedAtMs(data: Record<string, unknown>): number {
  const u = data.updatedAt as { toMillis?: () => number } | number | undefined;
  if (typeof u === 'number') return u;
  return typeof u?.toMillis === 'function' ? u.toMillis() : 0;
}

/** The trade as stored locally: the server timestamp is sync bookkeeping only. */
function fromDoc(data: Record<string, unknown>): AutomatedTradeRecord {
  const { updatedAt: _u, ...rest } = data;
  return rest as unknown as AutomatedTradeRecord;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Firestore read timed out (offline)')), ms)),
  ]);
}

function handleSyncError(err: unknown): void {
  reportFirestoreResult(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.toLowerCase().includes('resource-exhausted') || msg.toLowerCase().includes('quota')) markQuotaExceeded();
  console.warn('[Sync] Firestore unavailable; using the saved copy and retrying:', err);
}

// Read-only copies never write their own changes to Firestore, so their view
// of the database is held separately and shown as-is.
const readOnlyView = new Map<string, AutomatedTradeRecord>();

function applyFullList(remote: AutomatedTradeRecord[]): void {
  if (!FIRESTORE_WRITES_ENABLED) {
    readOnlyView.clear();
    remote.forEach((t) => readOnlyView.set(t.id, t));
    notifySubscribers(sortTrades([...readOnlyView.values()]));
    return;
  }
  const pendingIds = new Set(Object.keys(getPending()));
  const merged = sortTrades(sanitizeActiveTrades(mergeRemoteTrades(remote, loadLocalTrades(), Date.now(), pendingIds)));
  safeSetLocalStorage(LOCAL_STORAGE_KEY, JSON.stringify(merged));
  notifySubscribers(merged);
  if (pendingIds.size) flushPendingWrites().catch(() => {});
}

function applyChanges(changed: AutomatedTradeRecord[]): void {
  if (!FIRESTORE_WRITES_ENABLED) {
    changed.forEach((t) => readOnlyView.set(t.id, t));
    notifySubscribers(sortTrades([...readOnlyView.values()]));
    return;
  }
  const pendingIds = new Set(Object.keys(getPending()));
  const local = loadLocalTrades();
  const byId = new Map(local.map((t, i) => [t.id, i]));
  for (const r of changed) {
    const i = byId.get(r.id);
    if (i === undefined) local.push(r);
    else local[i] = pickTrade(r, local[i], pendingIds);
  }
  const merged = sortTrades(sanitizeActiveTrades(local));
  safeSetLocalStorage(LOCAL_STORAGE_KEY, JSON.stringify(merged));
  notifySubscribers(merged);
  if (pendingIds.size) flushPendingWrites().catch(() => {});
}

let stopListener: (() => void) | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let syncGeneration = 0;

function stopSync(): void {
  syncGeneration++;
  stopListener?.();
  stopListener = null;
  if (renewTimer) clearTimeout(renewTimer);
  if (retryTimer) clearTimeout(retryTimer);
  renewTimer = retryTimer = null;
}

function scheduleRetry(): void {
  if (retryTimer || subscribers.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (subscribers.size > 0) startSync().catch(() => {});
  }, SYNC_RETRY_MS);
}

async function startSync(): Promise<void> {
  stopSync();
  if (isQuotaBlocked()) { scheduleRetry(); return; }
  const gen = syncGeneration;
  const now = Date.now();
  let cursor = Number(safeGetLocalStorage(SYNC_CURSOR_KEY)) || 0;
  const lastFull = Number(safeGetLocalStorage(FULL_SYNC_AT_KEY)) || 0;
  const hasSaved = safeGetLocalStorage(LOCAL_STORAGE_KEY) !== null;
  const needFull = !FIRESTORE_WRITES_ENABLED || !hasSaved || !cursor || now - lastFull > FULL_SYNC_EVERY_MS;

  if (needFull) {
    try {
      const snap = await withTimeout(getDocsFromServer(collection(db, TRADES_COLLECTION)), 15_000);
      if (gen !== syncGeneration) return;
      const remote: AutomatedTradeRecord[] = [];
      snap.forEach((d) => remote.push(fromDoc(d.data())));
      reportFirestoreResult();
      if (!firstSnapshotAt) firstSnapshotAt = Date.now();
      applyFullList(remote);
      cursor = now;
      safeSetLocalStorage(SYNC_CURSOR_KEY, String(cursor));
      safeSetLocalStorage(FULL_SYNC_AT_KEY, String(now));
    } catch (err) {
      if (gen !== syncGeneration) return;
      handleSyncError(err);
      scheduleRetry();
      return;
    }
  }

  const since = Timestamp.fromMillis(Math.max(0, cursor - CURSOR_MARGIN_MS));
  const q = query(collection(db, TRADES_COLLECTION), where('updatedAt', '>', since));
  stopListener = onSnapshot(q, (snapshot) => {
    // Offline, the SDK can answer from its own cache. That is not the
    // database's answer, so it must not mark this copy as synced.
    if (snapshot.metadata?.fromCache && !firstSnapshotAt) return;
    reportFirestoreResult();
    if (!firstSnapshotAt) firstSnapshotAt = Date.now();
    const changed: AutomatedTradeRecord[] = [];
    let newest = cursor;
    snapshot.docChanges().forEach((c) => {
      if (c.type === 'removed') return;
      const data = c.doc.data();
      newest = Math.max(newest, updatedAtMs(data));
      changed.push(fromDoc(data));
    });
    if (newest > cursor) {
      cursor = newest;
      safeSetLocalStorage(SYNC_CURSOR_KEY, String(cursor));
    }
    if (changed.length) applyChanges(changed);
  }, (err) => {
    stopListener = null;
    handleSyncError(err);
    scheduleRetry();
  });
  renewTimer = setTimeout(() => { if (subscribers.size > 0) startSync().catch(() => {}); }, LISTENER_RENEW_MS);
}

/**
 * Subscribes to the trade list. The first subscriber starts the one shared
 * Firestore sync; later ones join it; the last to leave stops it.
 */
export function subscribeToAutomatedTrades(callback: (trades: AutomatedTradeRecord[]) => void): () => void {
  const first = subscribers.size === 0;
  subscribers.add(callback);
  if (!subscribedAt) subscribedAt = Date.now();

  // Shown at once so the screen is not empty, but not acted on until
  // Firestore answers (isTradeListAuthoritative).
  const saved = !FIRESTORE_WRITES_ENABLED && readOnlyView.size
    ? sortTrades([...readOnlyView.values()])
    : sortTrades(loadLocalTrades());
  Promise.resolve().then(() => callback(saved));

  if (first) startSync().catch(console.error);

  // Other tabs of this browser
  const handleStorage = (e: StorageEvent) => {
    if (e.key === LOCAL_STORAGE_KEY && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) callback(sanitizeActiveTrades(parsed));
      } catch {}
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', handleStorage);

  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) stopSync();
    if (typeof window !== 'undefined') window.removeEventListener('storage', handleStorage);
  };
}

/**
 * Open positions as the database has them right now, or null when that cannot
 * be known (read-only copy, quota, offline, slow): the caller then falls back
 * to its own saved list.
 */
async function fetchOpenTradesFromServer(): Promise<AutomatedTradeRecord[] | null> {
  if (!FIRESTORE_WRITES_ENABLED || isQuotaBlocked()) return null;
  try {
    const q = query(collection(db, TRADES_COLLECTION), where('status', '==', 'OPEN'));
    const snap = await Promise.race([
      getDocsFromServer(q),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), FIRESTORE_READ_TIMEOUT_MS)),
    ]);
    const open: AutomatedTradeRecord[] = [];
    snap.forEach((d) => open.push(d.data() as AutomatedTradeRecord));
    return open;
  } catch (err) {
    console.warn('[Bankroll Guard] Could not check open positions in the database; using this copy:', err);
    return null;
  }
}

/**
 * Executes a simulated trade and writes it into Firestore and localStorage.
 * CRITICAL GUARDS:
 * 1. Strictly enforces MAX_CONCURRENT_TRADES (10 active trades max).
 * 2. Strictly enforces balance and liquid cash limit (cannot trade more than available balance).
 * 3. Rejects duplicate open trade on the same coin symbol.
 * Returns true if executed successfully, false if blocked by limits.
 */
export async function executeSimulatedTrade(trade: AutomatedTradeRecord): Promise<boolean> {
  const currentTrades = await fetchAutomatedTrades(false);
  const sanitizedCurrent = sanitizeActiveTrades(currentTrades);
  const openTrades = sanitizedCurrent.filter((t) => t.status === 'OPEN');

  // GUARD 1: Max 10 concurrent active trades limit
  if (openTrades.length >= MAX_CONCURRENT_TRADES) {
    console.warn(`[Bankroll Guard] Blocked execution for ${trade.symbol}: 10/10 slots currently full.`);
    return false;
  }

  // GUARD 2: Prevent duplicate open position on the same asset
  if (openTrades.some((t) => t.symbol.toUpperCase() === trade.symbol.toUpperCase())) {
    console.warn(`[Bankroll Guard] Blocked execution for ${trade.symbol}: Position already open.`);
    return false;
  }

  // GUARD 3: Cap major coins (BTC, ETH, BNB, SOL) to max 3 slots (reserve at least 7 slots for alts)
  const sym = trade.symbol.toUpperCase();
  if (MAJOR_COINS.has(sym)) {
    const majorCount = openTrades.filter((t) => MAJOR_COINS.has(t.symbol.toUpperCase())).length;
    if (majorCount >= MAX_MAJOR_COIN_SLOTS) {
      console.warn(`[Bankroll Guard] Blocked execution for ${trade.symbol}: Major coins capped at ${MAX_MAJOR_COIN_SLOTS}/10 slots to preserve capital for high-beta altcoins.`);
      return false;
    }
  }

  // GUARD 1b: the same limits against the database, not just this copy. Each
  // copy used to check only its own saved list, so separate browsers filled
  // their slots independently - 13 positions were open at once, with AAVE
  // and WLD held twice. A small read (open trades only) just before opening.
  const remoteOpen = await fetchOpenTradesFromServer();
  if (remoteOpen) {
    if (remoteOpen.length >= MAX_CONCURRENT_TRADES) {
      console.warn(`[Bankroll Guard] Blocked ${trade.symbol}: database already has ${remoteOpen.length} open positions.`);
      return false;
    }
    if (remoteOpen.some((t) => t.symbol.toUpperCase() === trade.symbol.toUpperCase())) {
      console.warn(`[Bankroll Guard] Blocked ${trade.symbol}: already open in the database.`);
      return false;
    }
    if (MAJOR_COINS.has(sym) && remoteOpen.filter((t) => MAJOR_COINS.has(t.symbol.toUpperCase())).length >= MAX_MAJOR_COIN_SLOTS) {
      console.warn(`[Bankroll Guard] Blocked ${trade.symbol}: major-coin slots full in the database.`);
      return false;
    }
  }

  // GUARD 4: Must NOT exceed balance or liquid cash
  const bankroll = calculateBankrollState(sanitizedCurrent);
  const tradeSize = trade.positionSizeUSD || bankroll.trancheSizeUSD || 10.00;

  if (bankroll.liquidCashUSD < tradeSize) {
    console.warn(`[Bankroll Guard] Blocked execution for ${trade.symbol}: Insufficient liquid cash ($${bankroll.liquidCashUSD.toFixed(2)} available, $${tradeSize.toFixed(2)} required).`);
    return false;
  }

  if (bankroll.deployedCapitalUSD + tradeSize > bankroll.totalPortfolioValueUSD + 0.05) {
    console.warn(`[Bankroll Guard] Blocked execution for ${trade.symbol}: Deployed capital would exceed total portfolio balance ($${bankroll.totalPortfolioValueUSD.toFixed(2)}).`);
    return false;
  }

  // Safe to execute: persist new trade to Firestore (Milestone event)
  if (FIRESTORE_WRITES_ENABLED && isQuotaBlocked()) {
    setPending(trade.id, 'create');
  } else if (FIRESTORE_WRITES_ENABLED) {
    try {
      await setDoc(doc(db, TRADES_COLLECTION, trade.id), stamped(trade));
      reportFirestoreResult();
    } catch (err) {
      reportFirestoreResult(err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('resource-exhausted') || msg.toLowerCase().includes('quota')) {
        markQuotaExceeded();
      }
      setPending(trade.id, 'create');
      console.warn('Failed to save trade to Firestore; queued for retry:', err);
    }
  }

  // Persist to localStorage & notify all views
  const updatedTrades = [trade, ...sanitizedCurrent.filter((t) => t.id !== trade.id)];
  const sanitized = sanitizeActiveTrades(updatedTrades);

  safeSetLocalStorage(LOCAL_STORAGE_KEY, JSON.stringify(sanitized));

  notifySubscribers(sanitized);
  return true;
}

/**
 * Updates an existing trade in Firestore & localStorage, then notifies all views.
 * To strictly preserve Firebase free tier quota:
 * - syncToFirestore=false: updates local state & localStorage ONLY (used for continuous price ticks & session highs/lows)
 * - syncToFirestore=true (or status !== 'OPEN'): writes to Firestore for milestone completions, ratchets, and exits
 */
export async function updateAutomatedTrade(trade: AutomatedTradeRecord, syncToFirestore: boolean = false): Promise<void> {
  const shouldSync = syncToFirestore || trade.status !== 'OPEN';
  if (FIRESTORE_WRITES_ENABLED && shouldSync && isQuotaBlocked()) {
    setPending(trade.id, 'update');
  } else if (FIRESTORE_WRITES_ENABLED && shouldSync) {
    try {
      const docRef = doc(db, TRADES_COLLECTION, trade.id);
      await updateDoc(docRef, stamped(trade));
      setPending(trade.id, null);
    } catch (err) {
      reportFirestoreResult(err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('resource-exhausted') || msg.toLowerCase().includes('quota')) {
        markQuotaExceeded();
      }
      // Deleted in Firestore: the database wins, nothing to retry.
      if (!isNotFound(err)) setPending(trade.id, 'update');
      console.warn('Failed to update trade in Firestore; queued for retry:', err);
    }
  }

  try {
    const local = safeGetLocalStorage(LOCAL_STORAGE_KEY);
    if (local) {
      const trades: AutomatedTradeRecord[] = JSON.parse(local);
      const idx = trades.findIndex((t) => t.id === trade.id);
      if (idx >= 0) {
        trades[idx] = trade;
        const sanitized = sanitizeActiveTrades(trades);
        safeSetLocalStorage(LOCAL_STORAGE_KEY, JSON.stringify(sanitized));
        notifySubscribers(sanitized);
      }
    }
  } catch (e) {
    console.error('LocalStorage update failed:', e);
  }
}

/**
 * Evaluates all open trades against live market prices.
 * Evaluates 3-tier harvest ladders, breakeven ratchets, and zombie trade recycling.
 */
export async function evaluateLiveTrades(
  currentTrades: AutomatedTradeRecord[],
  coins: CryptoCoin[]
): Promise<{
  updatedTrades: AutomatedTradeRecord[];
  events: string[];
}> {
  const events: string[] = [];
  const updatedTrades: AutomatedTradeRecord[] = [];
  const bankrollConfig = getBankrollConfig();

  for (const trade of currentTrades) {
    if (trade.status !== 'OPEN') {
      updatedTrades.push(trade);
      continue;
    }

    const matchingCoin = coins.find((c) => c.id === trade.coinId || c.symbol.toUpperCase() === trade.symbol.toUpperCase());
    const livePrice = matchingCoin?.current_price || trade.currentPrice || trade.entryPrice;

    // First check for zombie trade auto-recycling
    if (bankrollConfig.zombieTradeRecycle?.enabled && bankrollConfig.zombieTradeRecycle.autoRecycleToCash) {
      const zombieCheck = isTradeZombieStale(trade, bankrollConfig.zombieTradeRecycle, livePrice);
      if (zombieCheck.isStale) {
        const recycledTrade: AutomatedTradeRecord = {
          ...trade,
          status: 'STOPPED',
          exitReason: 'STAGNATION_TIMEOUT',
          closedAtTimestamp: Date.now(),
          currentPrice: livePrice,
          pnlUSD: +( (trade.positionSizeUSD || 10) * (zombieCheck.movementPct / 100) ).toFixed(2),
          pnlPercentage: zombieCheck.movementPct,
          numericalCycleMetrics: {
            ...trade.numericalCycleMetrics,
            momentumVelocityScore: 25,
            momentumState: 'STAGNANT_CHOP',
            stagnationDecile: 10,
            cycleCompletionPct: 100,
            cycleStatusSummary: `Auto-Recycled to Cash: ${zombieCheck.reason}`
          } as any
        };
        // Status change is a milestone: sync to Firestore
        await updateAutomatedTrade(recycledTrade, true);
        updatedTrades.push(recycledTrade);
        events.push(`♻️ [Zombie Recycle] ${trade.symbol} auto-recycled to cash after ${zombieCheck.hoursElapsed}h flat chop (${zombieCheck.movementPct}%). Slot freed for fresh high-score setup.`);
        continue;
      }
    }

    // Mathematical cycle evaluation (Harvest ladders & ratchets)
    const evalResult = evaluateTradeCycle(trade, livePrice);
    if (evalResult.hasChanged) {
      // Milestone: trade closed, stopped, or profit tier harvested. Price fluctuations alone update locally only.
      const isMilestone = evalResult.eventTriggered !== 'NONE' || evalResult.trade.status !== trade.status;
      await updateAutomatedTrade(evalResult.trade, isMilestone);
      updatedTrades.push(evalResult.trade);
      if (evalResult.message) {
        events.push(evalResult.message);
      }
    } else {
      updatedTrades.push(trade);
    }
  }

  return { updatedTrades, events };
}

/**
 * Synchronizes open trades with live market price map from Binance.
 * Operates purely in-memory and in localStorage for regular price ticks.
 * Writes to Firestore ONLY when a milestone event (harvest tier or exit) occurs.
 */
export async function syncOpenTradesWithLivePrices(
  priceMap: Map<string, number>,
  knownTrades?: AutomatedTradeRecord[]
): Promise<{
  updatedCount: number;
  events: string[];
  /** The full list after evaluation, as saved. */
  trades: AutomatedTradeRecord[];
}> {
  const now = Date.now();
  // Retry queued writes on every refresh, not only when a snapshot arrives.
  if (getPendingWriteCount()) await flushPendingWrites();
  // Use knownTrades from caller or cached local storage — zero getDocs calls!
  let currentTrades: AutomatedTradeRecord[] = knownTrades && knownTrades.length > 0 ? [...knownTrades] : [];
  if (currentTrades.length === 0) {
    currentTrades = loadLocalTrades();
  }

  let updatedCount = 0;
  const events: string[] = [];
  const updatedTrades: AutomatedTradeRecord[] = [];
  const bankrollConfig = getBankrollConfig();

  for (const trade of currentTrades) {
    if (trade.status !== 'OPEN') {
      updatedTrades.push(trade);
      continue;
    }

    const livePrice = 
      priceMap.get(trade.symbol.toUpperCase()) ||
      priceMap.get(trade.coinId.toLowerCase()) ||
      priceMap.get(trade.coinId) ||
      trade.currentPrice ||
      trade.entryPrice;

    // Check for zombie stale trade recycling
    if (bankrollConfig.zombieTradeRecycle?.enabled && bankrollConfig.zombieTradeRecycle.autoRecycleToCash) {
      const zombieCheck = isTradeZombieStale(trade, bankrollConfig.zombieTradeRecycle, livePrice);
      if (zombieCheck.isStale) {
        const recycledTrade: AutomatedTradeRecord = {
          ...trade,
          status: 'STOPPED',
          exitReason: 'STAGNATION_TIMEOUT',
          closedAtTimestamp: Date.now(),
          lastEvaluatedAt: now,
          currentPrice: livePrice,
          pnlUSD: +( (trade.positionSizeUSD || 10) * (zombieCheck.movementPct / 100) ).toFixed(2),
          pnlPercentage: zombieCheck.movementPct,
          numericalCycleMetrics: {
            ...trade.numericalCycleMetrics,
            momentumVelocityScore: 25,
            momentumState: 'STAGNANT_CHOP',
            stagnationDecile: 10,
            cycleCompletionPct: 100,
            cycleStatusSummary: `Auto-Recycled to Cash: ${zombieCheck.reason}`
          } as any
        };
        // Status change is a milestone: write to Firestore
        await updateAutomatedTrade(recycledTrade, true);
        updatedTrades.push(recycledTrade);
        updatedCount++;
        events.push(`♻️ [Zombie Recycle] ${trade.symbol} auto-recycled to cash after ${zombieCheck.hoursElapsed}h flat chop (${zombieCheck.movementPct}%). Slot freed.`);
        continue;
      }
    }

    // Mathematical cycle evaluation (Harvest ladders & ratchets)
    const evalResult = evaluateTradeCycle(trade, livePrice);
    // Stamped before any write, so a saved state always carries the time it
    // was evaluated up to.
    const evaluated = { ...evalResult.trade, lastEvaluatedAt: now };
    if (evalResult.hasChanged) {
      // Milestone: profit tier harvested, stop loss hit, or trade completed
      const isMilestone = evalResult.eventTriggered !== 'NONE' || evalResult.trade.status !== trade.status;
      await updateAutomatedTrade(evaluated, isMilestone);
      updatedTrades.push(evaluated);
      updatedCount++;
      if (evalResult.message) {
        events.push(evalResult.message);
      }
    } else {
      updatedTrades.push(evaluated);
    }
  }

  const sanitized = sanitizeActiveTrades(updatedTrades);
  safeSetLocalStorage(LOCAL_STORAGE_KEY, JSON.stringify(sanitized));
  notifySubscribers(sanitized);
  return { updatedCount, events, trades: sanitized };
}

/**
 * Resets automated trades feed to default seed state and notifies subscribers
 */
export async function resetAutomatedTrades(): Promise<AutomatedTradeRecord[]> {
  if (FIRESTORE_WRITES_ENABLED && !isQuotaBlocked()) {
    try {
      const colRef = collection(db, TRADES_COLLECTION);
      const snap = await getDocs(colRef);
      for (const d of snap.docs) {
        await deleteDoc(doc(db, TRADES_COLLECTION, d.id));
      }
    } catch (err) {
      reportFirestoreResult(err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('resource-exhausted') || msg.toLowerCase().includes('quota')) {
        markQuotaExceeded();
      }
      console.warn('Firestore reset fallback to local storage:', err);
    }

  }
  safeSetLocalStorage(LOCAL_STORAGE_KEY, JSON.stringify([]));
  notifySubscribers([]);
  return [];
}

// Aliases for seamless component compatibility
export const loadAutomatedTrades = fetchAutomatedTrades;
export const updateTradeRecord = updateAutomatedTrade;
export const resetTradesToDefault = resetAutomatedTrades;

/**
 * Loads all completed historical trades from the trade records service
 */
// forceNetwork is ignored: the shared listener keeps the saved list current,
// and a forced read of the whole collection cost one read per trade ever made.
export async function fetchCompletedTrades(_forceNetwork: boolean = false): Promise<AutomatedTradeRecord[]> {
  const allTrades = await fetchAutomatedTrades(false);
  return allTrades.filter((t) => t.status !== 'OPEN');
}
export const loadCompletedTrades = fetchCompletedTrades;


/**
 * Aggregates summary performance statistics across all automated trades
 */
export function calculateFeedAuditStats(trades: AutomatedTradeRecord[]): AutomatedFeedAuditStats {
  const totalSimulatedTrades = trades.length;
  const openTrades = trades.filter(t => t.status === 'OPEN');
  const closedTrades = trades.filter(t => t.status !== 'OPEN');

  // Unused elsewhere, but aligned with services/metrics.ts so it cannot disagree if wired up.
  const winTrades = closedTrades.filter(t => outcome(t) === 'WIN');
  const lossTrades = closedTrades.filter(t => outcome(t) === 'LOSS');
  const winCount = winTrades.length;
  const lossCount = lossTrades.length;

  const winRatePct = closedTrades.length > 0 ? +((winCount / closedTrades.length) * 100).toFixed(1) : 0;

  const totalBankedCashUSD = +trades.reduce((acc, t) => acc + (t.realizedCashBankedUSD || 0), 0).toFixed(2);
  const totalNetProfitUSD = +trades.reduce((acc, t) => acc + (t.pnlUSD || 0), 0).toFixed(2);
  const totalInvestedUSD = +trades.reduce((acc, t) => acc + (t.positionSizeUSD || 10), 0).toFixed(2);

  const averageHoldDays = trades.length > 0 ? +(trades.reduce((acc, t) => acc + (t.holdingPeriodDays || 0), 0) / trades.length).toFixed(1) : 0;
  const activeCapitalDeployedUSD = +openTrades.reduce((acc, t) => acc + (t.positionSizeUSD || 10), 0).toFixed(2);

  const zeroRiskProtectedCount = openTrades.filter(t => t.ratchet?.isArmed).length;
  const avgMfePct = trades.length > 0 ? +(trades.reduce((acc, t) => acc + (t.mfePct || 0), 0) / trades.length).toFixed(1) : 0;
  const avgMaePct = trades.length > 0 ? +(trades.reduce((acc, t) => acc + (t.maePct || 0), 0) / trades.length).toFixed(1) : 0;

  const totalFeesPaidUSD = +trades.reduce((acc, t) => acc + (t.totalFeesUSD || 0), 0).toFixed(2);
  const grossProfitUSD = +(totalNetProfitUSD + totalFeesPaidUSD).toFixed(2);
  const profitFactor = lossTrades.length > 0
    ? +(winTrades.reduce((acc, t) => acc + (t.pnlUSD || 0), 0) / Math.abs(lossTrades.reduce((acc, t) => acc + (t.pnlUSD || 0), 0) || 1)).toFixed(2)
    : (winTrades.length > 0 ? +(winTrades.reduce((acc, t) => acc + (t.pnlUSD || 0), 0)).toFixed(2) : 0);

  return {
    totalSimulatedTrades,
    activeCapitalDeployedUSD,
    totalBankedCashUSD,
    totalNetProfitUSD,
    winRatePct,
    winCount,
    lossCount,
    averageHoldDays,
    zeroRiskProtectedCount,
    avgMfePct,
    avgMaePct,
    totalFeesPaidUSD,
    grossProfitUSD,
    profitFactor,
    totalInvestedUSD,
  };
}

/**
 * Computes the quantitative strategy verification scorecard comparing
 * active paper performance against required statistical benchmarks.
 * Directly unified with calculateStrategyVerification to guarantee 100% metric consistency across all views.
 */
export function calculateStrategyVerificationReport(trades: AutomatedTradeRecord[]): StrategyVerificationReport {
  return calculateStrategyVerification(trades);
}

