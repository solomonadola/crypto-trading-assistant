import { 
  collection, 
  getDocs, 
  setDoc, 
  doc, 
  updateDoc, 
  deleteDoc, 
  onSnapshot 
} from 'firebase/firestore';
import { db, isQuotaBlocked, markQuotaExceeded, authReady, getCurrentUid } from '../lib/firebase';
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
const LOCAL_STORAGE_KEY = 'crypto_automated_trades_local_fallback';

type TradesSubscriber = (trades: AutomatedTradeRecord[]) => void;
const subscribers = new Set<TradesSubscriber>();

/**
 * Sanitizes trade list so that:
 * 1. Active (OPEN) trades NEVER contain duplicate coin symbols (10 slots = 10 different coins).
 * 2. Active (OPEN) trades NEVER exceed MAX_CONCURRENT_TRADES (10).
 * Any duplicate or excess open positions are consolidated to COMPLETED.
 */
export function sanitizeActiveTrades(trades: AutomatedTradeRecord[]): AutomatedTradeRecord[] {
  // Sort trades: newest opened first
  const openTrades = trades
    .filter((t) => t.status === 'OPEN')
    .sort((a, b) => (b.openedAtTimestamp || 0) - (a.openedAtTimestamp || 0));

  const allowedOpenIds = new Set<string>();
  const seenSymbols = new Set<string>();
  let openMajorCount = 0;

  for (const t of openTrades) {
    const sym = t.symbol.toUpperCase();
    const isMajor = MAJOR_COINS.has(sym);
    if (!seenSymbols.has(sym) && allowedOpenIds.size < MAX_CONCURRENT_TRADES) {
      if (isMajor && openMajorCount >= MAX_MAJOR_COIN_SLOTS) {
        // Enforce max 3 major coins to reserve slots for dynamic altcoins
        continue;
      }
      if (isMajor) openMajorCount++;
      seenSymbols.add(sym);
      allowedOpenIds.add(t.id);
    }
  }

  return trades.map((t) => {
    if (t.status === 'OPEN' && !allowedOpenIds.has(t.id)) {
      const sym = t.symbol.toUpperCase();
      const isDuplicate = seenSymbols.has(sym);
      const exitReason = isDuplicate ? 'DUPLICATE_ASSET_CONSOLIDATED' : 'EXCESS_SLOT_REBALANCED';

      const closedTrade: AutomatedTradeRecord = {
        ...t,
        status: 'COMPLETED' as const,
        closedAtTimestamp: t.closedAtTimestamp || Date.now(),
        exitReason,
        exitPrice: t.currentPrice || t.entryPrice
      };

      // Asynchronously update Firestore so document is persisted as COMPLETED
      if (!isQuotaBlocked()) {
        try {
          updateDoc(doc(db, TRADES_COLLECTION, t.id), {
            status: 'COMPLETED',
            closedAtTimestamp: closedTrade.closedAtTimestamp,
            exitReason,
            exitPrice: closedTrade.exitPrice
          }).catch(() => {});
        } catch {}
      }
      return closedTrade;
    }
    return t;
  });
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

function safeGetLocalStorage(key: string): string | null {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
  } catch {}
  return null;
}

function safeSetLocalStorage(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {}
}

/**
 * Clean trades list (no sample or mock trades). Real paper trades are deployed by the user.
 */
export const SEED_TRADES: AutomatedTradeRecord[] = [];

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
      await authReady;
      const colRef = collection(db, TRADES_COLLECTION);
      const snap = await getDocs(colRef);
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

/**
 * Subscribes to real-time trade feed updates (Firestore or LocalStorage)
 */
export function subscribeToAutomatedTrades(callback: (trades: AutomatedTradeRecord[]) => void): () => void {
  subscribers.add(callback);

  // Fast initial load from local storage
  fetchAutomatedTrades(false).then((t) => callback(t)).catch(console.error);

  // Firestore real-time listener if available and quota not exceeded
  let unsubscribeFirestore: (() => void) | null = null;
  // Auth resolves asynchronously, so the caller may unsubscribe before the
  // listener is attached. Without this flag that listener would leak.
  let cancelled = false;
  if (!isQuotaBlocked()) {
    authReady.then(() => {
    if (cancelled) return;
    try {
      const colRef = collection(db, TRADES_COLLECTION);
      unsubscribeFirestore = onSnapshot(colRef, (snapshot) => {
        if (!snapshot.empty) {
          const trades: AutomatedTradeRecord[] = [];
          snapshot.forEach((docSnap) => trades.push(docSnap.data() as AutomatedTradeRecord));
          const sanitized = sanitizeActiveTrades(trades);
          sanitized.sort((a, b) => {
            if (a.status === 'OPEN' && b.status !== 'OPEN') return -1;
            if (a.status !== 'OPEN' && b.status === 'OPEN') return 1;
            return (b.openedAtTimestamp || 0) - (a.openedAtTimestamp || 0);
          });
          callback(sanitized);
        }
      }, (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('resource-exhausted') || msg.toLowerCase().includes('quota')) {
          markQuotaExceeded();
        }
        if (unsubscribeFirestore) {
          unsubscribeFirestore();
          unsubscribeFirestore = null;
        }
        console.warn('Firestore subscription fallback to local events:', err);
      });
    } catch {}
    });
  }

  // LocalStorage cross-tab sync listener
  const handleStorage = (e: StorageEvent) => {
    if (e.key === LOCAL_STORAGE_KEY && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) {
          const sanitized = sanitizeActiveTrades(parsed);
          callback(sanitized);
        }
      } catch {}
    }
  };
  window.addEventListener('storage', handleStorage);

  return () => {
    cancelled = true;
    subscribers.delete(callback);
    if (unsubscribeFirestore) unsubscribeFirestore();
    window.removeEventListener('storage', handleStorage);
  };
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
  if (!isQuotaBlocked()) {
    try {
      await authReady;
      const uid = getCurrentUid();
      await setDoc(doc(db, TRADES_COLLECTION, trade.id), uid ? { ...trade, ownerUid: uid } : trade);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('resource-exhausted') || msg.toLowerCase().includes('quota')) {
        markQuotaExceeded();
      }
      console.warn('Failed to save trade to Firestore, saving to localStorage:', err);
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
  if (shouldSync && !isQuotaBlocked()) {
    try {
      await authReady;
      const docRef = doc(db, TRADES_COLLECTION, trade.id);
      await updateDoc(docRef, { ...trade });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('resource-exhausted') || msg.toLowerCase().includes('quota')) {
        markQuotaExceeded();
      }
      console.warn('Failed to update trade in Firestore, updating local state:', err);
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
}> {
  // Use knownTrades from caller or cached local storage — zero getDocs calls!
  let currentTrades: AutomatedTradeRecord[] = knownTrades && knownTrades.length > 0 ? [...knownTrades] : [];
  if (currentTrades.length === 0) {
    currentTrades = await fetchAutomatedTrades(false);
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
    if (evalResult.hasChanged) {
      // Milestone: profit tier harvested, stop loss hit, or trade completed
      const isMilestone = evalResult.eventTriggered !== 'NONE' || evalResult.trade.status !== trade.status;
      await updateAutomatedTrade(evalResult.trade, isMilestone);
      updatedTrades.push(evalResult.trade);
      updatedCount++;
      if (evalResult.message) {
        events.push(evalResult.message);
      }
    } else {
      updatedTrades.push(trade);
    }
  }

  const sanitized = sanitizeActiveTrades(updatedTrades);
  safeSetLocalStorage(LOCAL_STORAGE_KEY, JSON.stringify(sanitized));
  notifySubscribers(sanitized);
  return { updatedCount, events };
}

/**
 * Resets automated trades feed to default seed state and notifies subscribers
 */
export async function resetAutomatedTrades(): Promise<AutomatedTradeRecord[]> {
  if (!isQuotaBlocked()) {
    try {
      await authReady;
      const colRef = collection(db, TRADES_COLLECTION);
      const snap = await getDocs(colRef);
      for (const d of snap.docs) {
        await deleteDoc(doc(db, TRADES_COLLECTION, d.id));
      }
    } catch (err) {
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
export async function fetchCompletedTrades(forceNetwork: boolean = false): Promise<AutomatedTradeRecord[]> {
  const allTrades = await fetchAutomatedTrades(forceNetwork);
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

  const winTrades = closedTrades.filter(t => (t.pnlUSD || 0) > 0);
  const lossTrades = closedTrades.filter(t => (t.pnlUSD || 0) < 0);
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

