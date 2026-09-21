import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Header, ActiveTab } from './components/Header';
import { ScannerView } from './components/ScannerView';
import { BankrollView } from './components/BankrollView';
import { HistoryView } from './components/HistoryView';
import { OrderFlowView } from './components/OrderFlowView';
import { LessonsView } from './components/LessonsView';
import { OverallMetricsView } from './components/OverallMetricsView';
import { AutomatedFeedView } from './components/AutomatedFeedView';
import { OverallMetricsModal } from './components/OverallMetricsModal';
import { FirebaseStatusModal } from './components/FirebaseStatusModal';
import { DeployModal } from './components/DeployModal';
import { CryptoCoin } from './types';
import { AutomatedTradeRecord, BankrollState } from './types/automatedFeed';
import { EntrySignalResult, ScannerTradingMode, MAJOR_COINS, MAX_MAJOR_COIN_SLOTS, MEME_COINS, MAX_MEME_COIN_SLOTS, COIN_REENTRY_COOLDOWN_MS } from './types/entryScanner';
import { 
  loadAutomatedTrades, 
  loadLocalTrades,
  subscribeToAutomatedTrades, 
  executeSimulatedTrade, 
  updateTradeRecord, 
  resetTradesToDefault,
  syncOpenTradesWithLivePrices
} from './services/automatedFeedService';
import { scanLiveMarketEntries, deploySignalToAutomatedFeed } from './services/entryScannerService';
import { catchUpOpenTrades } from './services/catchUpService';
import { selectAutoPilotCandidate } from './services/autopilotEngine';
import { StatusStrip, CatchUpStatus } from './components/StatusStrip';
import { DataHealthPanel } from './components/DataHealthPanel';
import { checkDataHealth } from './services/dataHealth';
import { isCounted } from './services/metrics';
import { calculateBankrollState } from './services/bankrollService';
import { AUTOPILOT_CONFIG } from './config/autopilot';
import {
  evaluateBtcMacroRegime,
  evaluateMarketActivityRadar,
  evaluateRecentLossCircuitBreaker,
  getAutoPilotPacingInfo,
} from './services/marketRegimeService';
import { fetchLiveMarketCoins, buildPriceMap, getLastTickerFetchTime } from './services/binanceService';
import { getFirestoreHealth } from './lib/firebase';
import { Zap, CheckCircle2, AlertCircle } from 'lucide-react';

// When open trades were last evaluated against the market. Persisted so a
// reopened app knows how long it was away and can replay the gap.
const LAST_EVAL_KEY = 'cryptostudy_last_trade_eval_at';
const CATCH_UP_MIN_GAP_MS = 90_000;   // normal refreshes are 30s apart; anything longer is a gap

function readLastEvalAt(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_EVAL_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeLastEvalAt(ms: number): void {
  try { localStorage.setItem(LAST_EVAL_KEY, String(ms)); } catch {}
}

function formatGap(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m} min`;
  const h = ms / 3600000;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}

export default function App() {
  const [coins, setCoins] = useState<CryptoCoin[]>([]);
  // Full history, including trades excluded in the Data Health panel.
  const [allTrades, setAllTrades] = useState<AutomatedTradeRecord[]>([]);
  // What every screen and statistic uses: excluded trades left out.
  const trades = useMemo(() => allTrades.filter(isCounted), [allTrades]);
  const dataHealth = useMemo(() => checkDataHealth(allTrades), [allTrades]);
  const [tradingMode, setTradingMode] = useState<ScannerTradingMode>('FUTURES_1_2D');
  const [activeTab, setActiveTab] = useState<ActiveTab>('scanner');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [lastPriceUpdateAt, setLastPriceUpdateAt] = useState<number | null>(null);
  const [lastCatchUp, setLastCatchUp] = useState<CatchUpStatus | null>(null);
  const [isDeployModalOpen, setIsDeployModalOpen] = useState<boolean>(false);
  const [isFirebaseModalOpen, setIsFirebaseModalOpen] = useState<boolean>(false);
  const [isMetricsModalOpen, setIsMetricsModalOpen] = useState<boolean>(false);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'info' | 'warn' } | null>(null);

  const showNotification = useCallback((message: string, type: 'success' | 'info' | 'warn' = 'info') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification((prev) => (prev?.message === message ? null : prev));
    }, 4500);
  }, []);

  // Auto-Pilot Autonomous Execution Mode (defaults to true for active auto-trading)
  const [isAutoPilot, setIsAutoPilot] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cryptostudy_autopilot') !== 'false';
    } catch {
      return true;
    }
  });

  // Is a 24/7 server worker trading right now? Only a worker that has
  // completed a tick in the last two minutes counts. A server that answers but
  // is not ticking (Cloud Run throttles CPU between requests, a crashed loop,
  // no Firestore) must not silence the browser, or nothing trades at all.
  const [serverState, setServerState] = useState<{ active: boolean; lastTickAt?: number | null }>({ active: false });
  const serverActiveRef = useRef(false);
  serverActiveRef.current = serverState.active;

  useEffect(() => {
    let mounted = true;
    const checkServer = async () => {
      let next: { active: boolean; lastTickAt?: number | null } = { active: false };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch('/api/status', { cache: 'no-store', signal: controller.signal });
          const data = res.ok ? await res.json() : null;
          const w = data?.worker;
          if (w?.workerRunning && typeof w.tickAgeMs === 'number' && w.tickAgeMs < 120_000) {
            next = { active: true, lastTickAt: Date.now() - w.tickAgeMs };
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {}
      if (mounted) setServerState(next);
    };
    checkServer();
    const interval = setInterval(checkServer, 20000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleToggleAutoPilot = useCallback(() => {
    setIsAutoPilot((prev) => {
      const nextVal = !prev;
      try {
        localStorage.setItem('cryptostudy_autopilot', String(nextVal));
      } catch (e) {
        console.warn('Failed to save autopilot setting:', e);
      }
      if (serverState.active) {
        fetch('/api/autopilot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: nextVal }),
        }).catch(() => {});
      }
      showNotification(
        nextVal
          ? '🤖 Auto-Pilot Activated: Autonomous entries and exits are now active!'
          : 'Auto-Pilot Paused: Switched to manual one-click entry confirmation.',
        nextVal ? 'success' : 'info'
      );
      return nextVal;
    });
  }, [serverState.active, showNotification]);

  // Subscribe to trade feed (Firestore or LocalStorage)
  useEffect(() => {
    const unsubscribe = subscribeToAutomatedTrades((loadedTrades) => {
      setAllTrades(loadedTrades);
    });
    return () => unsubscribe();
  }, []);

  // Initial load of live market data from Binance API (no mock data)
  useEffect(() => {
    fetchLiveMarketCoins().then((liveCoins) => {
      setCoins(liveCoins);
      setLastPriceUpdateAt(getLastTickerFetchTime() || null);
    }).catch((err) => {
      console.warn('Failed to load initial Binance market coins:', err);
    });
  }, []);

  // Compute live signals from current coin prices
  const signals = useMemo<EntrySignalResult[]>(() => {
    return scanLiveMarketEntries(coins, tradingMode);
  }, [coins, tradingMode]);

  // Compute live bankroll state from current trades
  const bankroll = useMemo<BankrollState>(() => {
    return calculateBankrollState(trades);
  }, [trades]);

  // Market regime / pacing state.
  //
  // marketRegimeService has always contained this logic, but nothing ever
  // called it: the components import the types and the props were never
  // supplied, so TradePacingDiagnosticsCard rendered null and the auto-pilot
  // deployed with no regime awareness at all. A 3.2% stop in a sub-2%
  // daily-volatility tape is a coin flip on noise, and evaluateMarketActivityRadar
  // already detects exactly that state.
  const btcRegime = useMemo(() => evaluateBtcMacroRegime(coins), [coins]);
  const activityRadar = useMemo(() => evaluateMarketActivityRadar(coins), [coins]);
  const lossCircuitBreaker = useMemo(() => evaluateRecentLossCircuitBreaker(trades), [trades]);
  const pacingInfo = useMemo(() => getAutoPilotPacingInfo(
    isAutoPilot,
    trades.filter((t) => t.status === 'OPEN').length,
    bankroll.totalSlots,
    btcRegime,
    lossCircuitBreaker,
    activityRadar,
  ), [isAutoPilot, trades, bankroll.totalSlots, btcRegime, lossCircuitBreaker, activityRadar]);

  const tradesRef = useRef(trades);
  tradesRef.current = trades;

  const coinsRef = useRef(coins);
  coinsRef.current = coins;

  // Auto-pilot burst guard. snapshotId increments only when genuinely fresh
  // prices arrive, so the deploy effect can tell a new market observation from
  // a re-render of the same one.
  const snapshotIdRef = useRef(0);
  const lastDeployAtRef = useRef(0);
  const lastDeploySnapshotRef = useRef<number>(-1);

  // Sync market data with Binance live prices
  // Start time of the refresh in progress (0 = none).
  const refreshInFlightRef = useRef(0);

  const handleRefreshLiveFeed = useCallback(async () => {
    // A visibility change and the 30s timer can fire together; one at a time.
    // The guard expires after 60s so a single stuck call cannot freeze prices.
    if (refreshInFlightRef.current && Date.now() - refreshInFlightRef.current < 60_000) return;
    refreshInFlightRef.current = Date.now();
    setIsRefreshing(true);
    try {
      const enriched = await fetchLiveMarketCoins();
      setCoins(enriched);
      snapshotIdRef.current += 1;   // marks a genuinely new market observation
      // The time the data was actually fetched - if every endpoint failed, the
      // cached prices are older than this refresh, and the status strip should say so.
      setLastPriceUpdateAt(getLastTickerFetchTime() || null);

      // The 24/7 worker is evaluating trades: this copy only displays them.
      // Evaluating here as well would put two writers on the same positions.
      if (serverActiveRef.current) return;

      const priceMap = await buildPriceMap(enriched);

      // Catch up on whatever happened while the app was closed or hidden.
      // Without this, a stop crossed while away filled at the price seen on
      // return, and a target touched and reversed was never banked.
      // Local storage only: this loop must never wait on Firestore.
      let knownTrades = loadLocalTrades();
      const lastEvalAt = readLastEvalAt();
      const now = Date.now();
      let catchUpComplete = true;
      let catchUpNote: string | null = null;
      if (lastEvalAt && now - lastEvalAt > CATCH_UP_MIN_GAP_MS && knownTrades.some((t) => t.status === 'OPEN')) {
        const cu = await catchUpOpenTrades(knownTrades, lastEvalAt, now);
        for (const t of cu.changed) {
          await updateTradeRecord(t, t.status !== 'OPEN');
        }
        knownTrades = cu.trades;
        cu.events.forEach((e) => console.info('[Catch-up]', e));
        if (cu.failedSymbols.length) {
          // Keep the old timestamp so the gap is retried, not silently lost.
          catchUpComplete = false;
          console.warn(`[Catch-up] Could not fetch candles for ${cu.failedSymbols.join(', ')}; will retry.`);
        }
        setLastCatchUp({
          at: now,
          gapMs: now - lastEvalAt,
          changed: cu.changed.length,
          closed: cu.closedCount,
          failedSymbols: cu.failedSymbols,
        });
        const away = formatGap(now - lastEvalAt);
        catchUpNote = cu.closedCount > 0
          ? `Caught up on ${away} away: ${cu.closedCount} trade${cu.closedCount === 1 ? '' : 's'} closed while the app was closed.`
          : cu.changed.length > 0
            ? `Caught up on ${away} away: ${cu.changed.length} open trade${cu.changed.length === 1 ? '' : 's'} updated.`
            : null;
      }

      const { updatedCount, events } = await syncOpenTradesWithLivePrices(priceMap, knownTrades);
      if (catchUpComplete) writeLastEvalAt(Date.now());

      if (catchUpNote) {
        showNotification(catchUpNote, 'info');
      } else if (events.length > 0) {
        showNotification(events[0], 'success');
      } else if (updatedCount > 0) {
        showNotification(`Synced ${updatedCount} open trades with live market prices.`, 'info');
      } else {
        showNotification('Live prices synchronized from market data feed.', 'info');
      }
    } catch (e) {
      console.warn('Live feed refresh error:', e);
      showNotification('Market data refreshed (offline fallback active).', 'info');
    } finally {
      refreshInFlightRef.current = 0;
      setIsRefreshing(false);
    }
  }, [showNotification]);

  // Evaluate trades as soon as the app opens and whenever the tab becomes
  // visible again, rather than waiting up to 30s. This is what triggers the
  // catch-up replay after time away.
  useEffect(() => {
    handleRefreshLiveFeed();
    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) handleRefreshLiveFeed();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [handleRefreshLiveFeed]);

  // Periodic automatic sync every 30 seconds (pauses when browser tab is inactive to protect quota and performance)
  useEffect(() => {
    const intervalId = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      handleRefreshLiveFeed();
    }, 30000);
    return () => clearInterval(intervalId);
  }, [handleRefreshLiveFeed]);

  // Active Auto-Pilot scan heartbeat: periodically re-checks market signals every 10 seconds
  const [autoPilotScanTick, setAutoPilotScanTick] = useState(0);
  useEffect(() => {
    if (!isAutoPilot) return;
    const intervalId = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setAutoPilotScanTick((prev) => prev + 1);
    }, 10000);
    return () => clearInterval(intervalId);
  }, [isAutoPilot]);

  const isDeployingRef = useRef(false);

  // Deploy signal to automated feed with strict balance and 10-trade limit checks
  const handleDeploySignal = async (signal: EntrySignalResult) => {
    const openCount = trades.filter((t) => t.status === 'OPEN').length;
    if (openCount >= 10) {
      showNotification('Maximum 10 active trades limit reached. Please wait for an existing position to exit.', 'warn');
      return;
    }

    // Guard: Prevent duplicate coin entry across the 10 slots
    const sym = signal.symbol.toUpperCase();
    if (trades.some((t) => t.status === 'OPEN' && t.symbol.toUpperCase() === sym)) {
      showNotification(
        `A position for ${signal.symbol} is already active. 10 bankroll slots are strictly reserved for 10 distinct coins for risk diversification.`,
        'warn'
      );
      return;
    }

    // Guard: Major coins cap (BTC, ETH, BNB, SOL) to max 3 slots
    const isMajor = MAJOR_COINS.has(sym);
    const openMajorCount = trades.filter((t) => t.status === 'OPEN' && MAJOR_COINS.has(t.symbol.toUpperCase())).length;
    if (isMajor && openMajorCount >= MAX_MAJOR_COIN_SLOTS) {
      showNotification(
        `Major coins (${Array.from(MAJOR_COINS).join(', ')}) are capped at 3 simultaneous slots to reserve slots for dynamic alts and memes.`,
        'warn'
      );
      return;
    }

    // Guard: Meme coins cap (DOGE, PEPE, WIF, BONK, POPCAT, FLOKI, etc.) to max 2 slots
    const isMeme = MEME_COINS.has(sym);
    const openMemeCount = trades.filter((t) => t.status === 'OPEN' && MEME_COINS.has(t.symbol.toUpperCase())).length;
    if (isMeme && openMemeCount >= MAX_MEME_COIN_SLOTS) {
      showNotification(
        `Meme coins (${Array.from(MEME_COINS).slice(0, 5).join(', ')}...) are capped at ${MAX_MEME_COIN_SLOTS} simultaneous slots to protect against sector-wide flushes while capturing explosive upside.`,
        'warn'
      );
      return;
    }

    if (!bankroll.canOpenNewTrade) {
      showNotification(bankroll.blockReason || 'Bankroll slots are currently full.', 'warn');
      return;
    }

    if (bankroll.liquidCashUSD < bankroll.trancheSizeUSD) {
      showNotification(`Insufficient cash ($${bankroll.liquidCashUSD.toFixed(2)} available, $${bankroll.trancheSizeUSD.toFixed(2)} required). Cannot trade more than available balance.`, 'warn');
      return;
    }

    if (bankroll.deployedCapitalUSD + bankroll.trancheSizeUSD > bankroll.totalPortfolioValueUSD + 0.05) {
      showNotification(`Trade would exceed total account balance ($${bankroll.totalPortfolioValueUSD.toFixed(2)}).`, 'warn');
      return;
    }

    // Cooldown status info for manual deployment
    const lastClosed = trades
      .filter((t) => t.status !== 'OPEN' && t.symbol.toUpperCase() === sym && t.closedAtTimestamp)
      .sort((a, b) => (b.closedAtTimestamp || 0) - (a.closedAtTimestamp || 0))[0];
    if (lastClosed && lastClosed.closedAtTimestamp) {
      const elapsed = Date.now() - lastClosed.closedAtTimestamp;
      if (elapsed < COIN_REENTRY_COOLDOWN_MS) {
        const minsLeft = Math.ceil((COIN_REENTRY_COOLDOWN_MS - elapsed) / 60000);
        showNotification(
          `Notice: ${sym} was closed ${Math.floor(elapsed / 60000)}m ago (20-min cooldown has ${minsLeft}m left). Manual override executing...`,
          'info'
        );
      }
    }

    try {
      const deployed = await deploySignalToAutomatedFeed(signal, bankroll.trancheSizeUSD);
      setAllTrades((prev) => [deployed, ...prev.filter((t) => t.id !== deployed.id)]);
      showNotification(`Deployed $${deployed.positionSizeUSD.toFixed(2)} into ${signal.symbol} (${signal.archetypeName})!`, 'success');
    } catch (e: any) {
      console.error('Failed to deploy signal:', e);
      showNotification(e?.message || 'Failed to deploy signal.', 'warn');
    }
  };

  // Autonomous auto-pilot. The entry decision itself lives in
  // services/autopilotEngine.ts, shared with the 24/7 server worker so both
  // make identical choices; only this loop's own guards stay here.
  useEffect(() => {
    if (!isAutoPilot) return;
    // When the 24/7 server worker is active, the server handles auto-pilot deployments
    // so the browser and server never trade concurrently.
    if (serverState.active) return;
    if (isDeployingRef.current) return;

    // One deploy per fresh price snapshot: the effect re-fires every 10s (and on
    // every trades change) against prices that only refresh every 30s.
    if (AUTOPILOT_CONFIG.oneDeployPerSnapshot &&
        lastDeploySnapshotRef.current === snapshotIdRef.current) return;

    const decision = selectAutoPilotCandidate({
      signals, trades, bankroll, pacingInfo,
      now: Date.now(),
      lastDeployAt: lastDeployAtRef.current,
    });
    const qualified = decision.signal;
    const openTrades = trades.filter((t) => t.status === 'OPEN');


    if (qualified) {
      isDeployingRef.current = true;
      lastDeployAtRef.current = Date.now();
      lastDeploySnapshotRef.current = snapshotIdRef.current;
      deploySignalToAutomatedFeed(qualified, bankroll.trancheSizeUSD)
        .then((newTrade) => {
          setAllTrades((prev) => [newTrade, ...prev.filter((t) => t.id !== newTrade.id)]);
          const symUpper = qualified.symbol.toUpperCase();
          const isMajor = MAJOR_COINS.has(symUpper);
          const isMeme = MEME_COINS.has(symUpper);
          const roleLabel = isMajor ? '⚡ Volatile Major' : isMeme ? '🎭 High-Beta Meme' : '🚀 High-Beta Alt';
          const confGrade = qualified.timeframeConfluence?.confluenceRating || 'A';
          showNotification(
            `🤖 Auto-Pilot: Deployed $${newTrade.positionSizeUSD.toFixed(2)} into ${qualified.symbol} (${roleLabel}, Score ${qualified.score}/100, MTF: ${confGrade})! Slot ${openTrades.length + 1}/10.`,
            'success'
          );
        })
        .catch((err) => {
          console.warn('Auto-pilot deployment error:', err);
        })
        .finally(() => {
          setTimeout(() => {
            isDeployingRef.current = false;
          }, 1500);
        });
    }
  }, [isAutoPilot, serverState.active, autoPilotScanTick, bankroll.canOpenNewTrade, bankroll.activeTradesCount, bankroll.liquidCashUSD, bankroll.trancheSizeUSD, bankroll.deployedCapitalUSD, bankroll.totalPortfolioValueUSD, signals, trades, pacingInfo, showNotification]);


  // Exclude a trade from statistics (or include it again). The record is kept;
  // it just stops counting toward P&L, win rate and the other figures.
  const handleSetExcluded = async (trade: AutomatedTradeRecord, excluded: boolean) => {
    const updated: AutomatedTradeRecord = {
      ...trade,
      excludedFromStats: excluded,
      // Firestore rejects undefined field values, so clear with '' rather than undefined.
      excludedReason: excluded ? 'Excluded from statistics in the Data Health panel' : '',
    };
    await updateTradeRecord(updated, true);
    setAllTrades((prev) => prev.map((t) => (t.id === trade.id ? updated : t)));
    showNotification(
      excluded ? `${trade.symbol} trade excluded from statistics.` : `${trade.symbol} trade counted in statistics again.`,
      'info'
    );
  };

  // Close trade manually
  const handleCloseTrade = async (trade: AutomatedTradeRecord, reason: string) => {
    const updated: AutomatedTradeRecord = {
      ...trade,
      status: 'COMPLETED',
      closedAtTimestamp: Date.now(),
      exitReason: 'CLOSED_MANUAL',
      exitPrice: trade.currentPrice || trade.entryPrice,
    };
    await updateTradeRecord(updated, true);
    setAllTrades((prev) => prev.map((t) => (t.id === trade.id ? updated : t)));
    showNotification(`Closed position for ${trade.symbol}. Slot freed and cash returned to bankroll.`, 'info');
  };

  // Recycle zombie trade
  const handleRecycleZombieTrade = async (trade: AutomatedTradeRecord) => {
    const updated: AutomatedTradeRecord = {
      ...trade,
      status: 'COMPLETED',
      closedAtTimestamp: Date.now(),
      exitReason: 'CLOSED_TIME_DECAY',
      exitPrice: trade.currentPrice || trade.entryPrice,
    };
    await updateTradeRecord(updated, true);
    setAllTrades((prev) => prev.map((t) => (t.id === trade.id ? updated : t)));
    showNotification(`Recycled stagnant trade ${trade.symbol} to liquid treasury cash!`, 'success');
  };

  // Reset trades
  const handleResetTrades = async () => {
    if (window.confirm('Reset all trades back to the default quantitative demonstration dataset?')) {
      await resetTradesToDefault();
      showNotification('Trades reset to default demonstration dataset.', 'info');
    }
  };

  return (
    <div id="cryptostudy-app-root" className="min-h-screen bg-stone-950 text-stone-100 font-sans flex flex-col">
      
      {/* Global Navigation Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        bankroll={bankroll}
        trades={trades}
        // Green only once Firebase has actually answered, matching the status strip.
        isFirebaseLive={getFirestoreHealth() === 'ok'}
        onRefreshLiveFeed={handleRefreshLiveFeed}
        isRefreshing={isRefreshing}
        onOpenDeployModal={() => setIsDeployModalOpen(true)}
        onOpenMetricsModal={() => setIsMetricsModalOpen(true)}
        isAutoPilot={isAutoPilot}
        onToggleAutoPilot={handleToggleAutoPilot}
      />

      <StatusStrip
        lastPriceUpdateAt={lastPriceUpdateAt}
        isRefreshing={isRefreshing}
        pacingInfo={pacingInfo}
        lastCatchUp={lastCatchUp}
        suspectRecords={dataHealth.criticalCounted}
        onOpenDataHealth={() => setActiveTab('firebase')}
        serverActive={serverState.active}
        lastServerTickAt={serverState.lastTickAt}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        
        {/* Floating Notification Toast */}
        {notification && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-stone-900 border border-amber-500/40 text-stone-100 shadow-2xl text-xs sm:text-sm animate-in fade-in slide-in-from-bottom-3 duration-200">
            {notification.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : notification.type === 'warn' ? (
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            ) : (
              <Zap className="w-4 h-4 text-amber-400 shrink-0" />
            )}
            <span>{notification.message}</span>
          </div>
        )}

        {/* Tab Views */}
        {activeTab === 'scanner' && (
          <ScannerView
            signals={signals}
            tradingMode={tradingMode}
            setTradingMode={setTradingMode}
            bankroll={bankroll}
            trades={trades}
            onDeploySignal={handleDeploySignal}
            isAutoPilot={isAutoPilot}
            onToggleAutoPilot={handleToggleAutoPilot}
          />
        )}

        {activeTab === 'bankroll' && (
          <BankrollView
            bankroll={bankroll}
            trades={trades}
            onCloseTrade={handleCloseTrade}
            onRecycleZombieTrade={handleRecycleZombieTrade}
            onResetTrades={handleResetTrades}
          />
        )}

        {activeTab === 'history' && (
          <HistoryView
            onSwitchToScanner={() => setActiveTab('scanner')}
            onSwitchToBankroll={() => setActiveTab('bankroll')}
          />
        )}

        {activeTab === 'metrics' && (
          <AutomatedFeedView
            trades={trades}
            bankroll={bankroll}
            activityRadar={activityRadar}
            lossCircuitBreaker={lossCircuitBreaker}
            pacingInfo={pacingInfo}
            onCloseTrade={handleCloseTrade}
            onRecycleZombieTrade={handleRecycleZombieTrade}
            onResetTrades={handleResetTrades}
          />
        )}

        {activeTab === 'orderflow' && (
          <OrderFlowView coins={coins} />
        )}

        {activeTab === 'lessons' && (
          <LessonsView />
        )}

        {activeTab === 'firebase' && (
          <div className="p-8 rounded-2xl bg-stone-900 border border-stone-800 text-center space-y-4 max-w-xl mx-auto my-8">
            <h3 className="text-xl font-bold text-stone-100">Firebase & Cloud Infrastructure Panel</h3>
            <p className="text-xs sm:text-sm text-stone-400 leading-relaxed">
              The shared trade history is stored in Google Cloud Firestore, so every browser running the app sees the same trades.
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => setIsFirebaseModalOpen(true)}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700 transition-colors"
              >
                Inspect Firebase Diagnostics
              </button>
              <button
                onClick={() => setIsDeployModalOpen(true)}
                className="px-4 py-2 text-xs font-bold rounded-lg bg-amber-500 hover:bg-amber-400 text-stone-950 transition-colors"
              >
                Deploy & Pre-Flight Audit
              </button>
            </div>
          </div>
        )}

        {activeTab === 'firebase' && (
          <DataHealthPanel report={dataHealth} onSetExcluded={handleSetExcluded} />
        )}
      </main>

      {/* Overall Metrics Popup Modal */}
      <OverallMetricsModal
        isOpen={isMetricsModalOpen}
        onClose={() => setIsMetricsModalOpen(false)}
        trades={trades}
        bankroll={bankroll}
      />

      {/* Firebase Status & Diagnostics Modal */}
      <FirebaseStatusModal
        isOpen={isFirebaseModalOpen}
        onClose={() => setIsFirebaseModalOpen(false)}
        tradesCount={trades.length}
      />

      {/* Deployment & Pre-flight Modal */}
      <DeployModal
        isOpen={isDeployModalOpen}
        onClose={() => setIsDeployModalOpen(false)}
        tradesCount={trades.length}
      />
    </div>
  );
}
