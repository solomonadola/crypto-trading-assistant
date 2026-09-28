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
  syncOpenTradesWithLivePrices,
  isTradeListAuthoritative,
  setServerFeedActive,
  setLocalWritesAllowed,
} from './services/automatedFeedService';
import { scanLiveMarketEntries, deploySignalToAutomatedFeed } from './services/entryScannerService';
import { catchUpOpenTrades } from './services/catchUpService';
import { BacktestLabView } from './components/BacktestLabView';
import { computePacing, selectAutoPilotCandidate, manualDeployBlockReason } from './services/autopilotEngine';
import { fetchServerStatus, pullServerTrades, resetServerFeed, serverApiUrl, serverAction, ServerStatus } from './services/serverFeed';
import { closeTradeAt } from './services/cycleEngineService';
import { StatusStrip, CatchUpStatus } from './components/StatusStrip';
import { DataHealthPanel } from './components/DataHealthPanel';
import { checkDataHealth } from './services/dataHealth';
import { visibleTrades } from './services/metrics';
import { calculateBankrollState } from './services/bankrollService';
import { AUTOPILOT_CONFIG, setAllowShorts } from './config/autopilot';
import { STRATEGY_PROFILES, STRATEGY_PROFILE_EVENT, StrategyProfileId, getActiveStrategyProfile, setActiveStrategyProfile } from './config/geometry';
import {
  evaluateBtcMacroRegime,
  evaluateMarketActivityRadar,
  evaluateRecentLossCircuitBreaker,
  getAutoPilotPacingInfo,
} from './services/marketRegimeService';
import { fetchLiveMarketCoins, buildPriceMap, getLastTickerFetchTime } from './services/binanceService';
import { getFirestoreHealth } from './lib/firebase';
import { Zap, CheckCircle2, AlertCircle } from 'lucide-react';

// Without a reachable 24/7 server a browser only displays the trades (from
// Firebase) and changes nothing. Two traders writing one history - a browser
// that could not see the server, plus the server - is what produced duplicate
// positions and more than 10 open. VITE_BROWSER_TRADING=on lets a browser trade
// on its own again (for running without any server).
const BROWSER_TRADING = import.meta.env.VITE_BROWSER_TRADING !== 'off';
setLocalWritesAllowed(true);
const NO_SERVER_MESSAGE =
  'The trading server is not reachable, so changes will sync directly to Firebase Firestore.';

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
  // What every screen, slot count and statistic uses: every open position,
  // plus the closed records not excluded in the Data Health panel.
  const trades = useMemo(() => visibleTrades(allTrades), [allTrades]);
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

  const [allowShorts, setAllowShortsState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cryptostudy_autopilot_shorts') === 'true';
    } catch {
      return false;
    }
  });

  // Is a 24/7 server worker trading right now? Only a worker that has
  // completed a tick in the last two minutes counts. A server that answers but
  // is not ticking (Cloud Run throttles CPU between requests, a crashed loop,
  // no Firestore) must not silence the browser, or nothing trades at all.
  const [serverState, setServerState] = useState<ServerStatus>({ active: true, serverOnline: true, lastTickAt: null, instanceId: null, buildId: null, warning: null });
  const serverActiveRef = useRef(true);
  serverActiveRef.current = serverState.active || serverState.serverOnline;

  useEffect(() => {
    let mounted = true;
    const checkServer = async () => {
      const next = await fetchServerStatus();
      if (!mounted) return;
      // While the server trades or is online, its list is what every copy shows (and no
      // Firestore reads are made here); if it stops, back to Firestore.
      const isFeedSource = next.active || next.serverOnline;
      if (isFeedSource !== serverActiveRef.current) {
        serverActiveRef.current = isFeedSource;
        setServerFeedActive(isFeedSource);
        if (isFeedSource) {
          resetServerFeed();
        }
      }
      if (isFeedSource) {
        await pullServerTrades().catch(() => {});
      }
      // Sync auto-pilot toggle state from server across all devices in real time
      if (typeof next.isAutoPilot === 'boolean') {
        setIsAutoPilot((curr) => {
          if (curr !== next.isAutoPilot) {
            try {
              localStorage.setItem('cryptostudy_autopilot', String(next.isAutoPilot));
            } catch {}
            return next.isAutoPilot!;
          }
          return curr;
        });
      }
      if (typeof next.allowShorts === 'boolean') {
        setAllowShortsState((curr) => {
          if (curr !== next.allowShorts) {
            try {
              localStorage.setItem('cryptostudy_autopilot_shorts', String(next.allowShorts));
            } catch {}
            setAllowShorts(next.allowShorts!);
            return next.allowShorts!;
          }
          return curr;
        });
      }
      if (next.strategyProfile && next.strategyProfile in STRATEGY_PROFILES &&
          next.strategyProfile !== getActiveStrategyProfile().id) {
        setActiveStrategyProfile(next.strategyProfile as StrategyProfileId);
        window.dispatchEvent(new Event(STRATEGY_PROFILE_EVENT));
      }
      setServerState(next);
    };
    checkServer();
    const interval = setInterval(checkServer, 4000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Real-time synchronization of auto-pilot state across open browser tabs / webpages
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'cryptostudy_autopilot' && e.newValue !== null) {
        setIsAutoPilot(e.newValue === 'true');
      }
    };
    window.addEventListener('storage', handleStorage);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel('cryptostudy_autopilot_sync');
        channel.onmessage = (event) => {
          if (typeof event.data?.enabled === 'boolean') {
            setIsAutoPilot(event.data.enabled);
            try {
              localStorage.setItem('cryptostudy_autopilot', String(event.data.enabled));
            } catch {}
          }
        };
      } catch {}
    }

    return () => {
      window.removeEventListener('storage', handleStorage);
      channel?.close();
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
      // Instantly broadcast to all other open tabs in the same browser
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          const ch = new BroadcastChannel('cryptostudy_autopilot_sync');
          ch.postMessage({ enabled: nextVal });
          ch.close();
        } catch {}
      }
      if (serverState.active) {
        fetch(serverApiUrl('/api/autopilot'), {
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

  const handleToggleAllowShorts = useCallback(() => {
    setAllowShortsState((prev) => {
      const nextVal = !prev;
      try {
        localStorage.setItem('cryptostudy_autopilot_shorts', String(nextVal));
      } catch (e) {
        console.warn('Failed to save allowShorts setting:', e);
      }
      setAllowShorts(nextVal);
      fetch(serverApiUrl('/api/autopilot/shorts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowShorts: nextVal }),
      }).catch(() => {});
      showNotification(
        nextVal
          ? '📉 Shorting Enabled: Auto-pilot will take both Long & Short opportunities'
          : '📈 Long-Only Mode: Auto-pilot will only take Long trades',
        'info'
      );
      return nextVal;
    });
  }, [showNotification]);

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
  // The shared computation, so the monthly loss cap applies here as it does on
  // the server, measured on this account's equity.
  const pacingInfo = useMemo(
    () => computePacing(coins, trades, isAutoPilot, bankroll.totalSlots, bankroll.totalPortfolioValueUSD),
    [coins, trades, isAutoPilot, bankroll.totalSlots, bankroll.totalPortfolioValueUSD]
  );

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

      // The 24/7 worker is evaluating trades: this copy only displays them,
      // from the server's list. Evaluating here as well would put two writers
      // on the same positions.
      if (serverActiveRef.current) {
        await pullServerTrades();
        return;
      }
      // No server: display only (the Firebase listener keeps the list current).
      if (!BROWSER_TRADING) return;
      // Database first: act only on the list Firestore has delivered.
      if (!isTradeListAuthoritative()) return;

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

  // While the 24/7 server is in charge, every open page follows its list
  // closely: a pull every 5 seconds (only the trades changed since the last
  // one - usually nothing, a few KB at most), so pages open in different
  // places show the same within seconds. Paused while the tab is hidden; the
  // pull on becoming visible (below) catches up at once.
  useEffect(() => {
    if (!serverState.active) return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      pullServerTrades().catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [serverState.active]);

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
    const blocked = manualDeployBlockReason(signal, trades, bankroll);
    if (blocked) {
      showNotification(blocked, 'warn');
      return;
    }
    const sym = signal.symbol.toUpperCase();

    // The server is the source of truth: it opens the trade from its own scan.
    if (serverActiveRef.current) {
      const r = await serverAction('/api/deploy', { symbol: sym });
      if (r.ok) {
        showNotification(`Deployed $${Number(r.result?.positionSizeUSD || 0).toFixed(2)} into ${signal.symbol}.`, 'success');
      } else {
        // Never opened here as well: the server may have opened it anyway (a
        // lost reply), or refused it for a reason this page cannot see.
        showNotification(r.error || 'The server refused the deploy.', 'warn');
      }
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
    if (!BROWSER_TRADING) return;
    if (!isTradeListAuthoritative()) return;
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


  // Exclude a trade from statistics (or include it again).
  const handleSetExcluded = async (trade: AutomatedTradeRecord, excluded: boolean) => {
    const r = await serverAction(`/api/trades/${encodeURIComponent(trade.id)}/exclude`, { excluded });
    if (r.ok) {
      if (r.result) {
        setAllTrades((prev) => prev.map((t) => (t.id === trade.id ? r.result : t)));
      }
      showNotification(excluded ? `${trade.symbol} trade excluded from statistics.` : `${trade.symbol} trade counted in statistics again.`, 'info');
      return;
    }
    showNotification(r.error || (r.unreachable ? 'Trading server is reconnecting. Please retry in a few moments.' : 'The server refused the change.'), 'warn');
  };

  // Close trade manually
  const handleCloseTrade = async (trade: AutomatedTradeRecord, reason: string) => {
    const r = await serverAction(`/api/trades/${encodeURIComponent(trade.id)}/close`, { reason: 'manual' });
    if (r.ok) {
      if (r.result) {
        setAllTrades((prev) => prev.map((t) => (t.id === trade.id ? r.result : t)));
      }
      showNotification(`Closed position for ${trade.symbol}. Slot freed and cash returned to bankroll.`, 'info');
      return;
    }
    showNotification(r.error || (r.unreachable ? 'Trading server is reconnecting. Please retry in a few moments.' : 'The server refused the close.'), 'warn');
  };

  // Recycle zombie trade
  const handleRecycleZombieTrade = async (trade: AutomatedTradeRecord) => {
    const r = await serverAction(`/api/trades/${encodeURIComponent(trade.id)}/close`, { reason: 'time_decay' });
    if (r.ok) {
      if (r.result) {
        setAllTrades((prev) => prev.map((t) => (t.id === trade.id ? r.result : t)));
      }
      showNotification(`Recycled stagnant trade ${trade.symbol} to liquid treasury cash!`, 'success');
      return;
    }
    showNotification(r.error || (r.unreachable ? 'Trading server is reconnecting. Please retry in a few moments.' : 'The server refused the recycle.'), 'warn');
  };

  // Reset trades: wipes Firebase and server memory to start completely fresh
  const handleResetTrades = async () => {
    if (!window.confirm('Reset all trades and start completely fresh? This will permanently delete all trade records from Firebase and reset your balance to $100.')) {
      return;
    }
    showNotification('Clearing all Firebase data and resetting engine...', 'info');
    try {
      const r = await serverAction('/api/reset', {});
      if (r.ok) {
        setAllTrades([]);
        try {
          localStorage.removeItem('crypto_automated_trades_local_fallback');
          localStorage.removeItem('crypto_automated_trades_pending_writes');
          localStorage.removeItem('crypto_automated_trades_sync_cursor');
          localStorage.removeItem('crypto_automated_trades_full_sync_at');
        } catch {}
        showNotification('All data cleared from Firebase! Fresh $100 bankroll started.', 'success');
        return;
      }
      // If serverAction returned non-ok, fall back to direct client-side Firestore wipe
      await resetTradesToDefault();
      setAllTrades([]);
      showNotification('Trades and Firebase data reset to clean fresh state.', 'success');
    } catch (err: any) {
      console.warn('Reset error, falling back to direct wipe:', err);
      await resetTradesToDefault();
      setAllTrades([]);
      showNotification('Reset completed directly against Firebase.', 'success');
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
        // Green when server worker has Firestore connected, or when direct Firestore is healthy.
        isFirebaseLive={serverState.active ? serverState.firestoreStatus === 'ok' : getFirestoreHealth() === 'ok'}
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
        displayOnly={!serverState.active && !BROWSER_TRADING}
        serverWarning={serverState.warning}
        firestoreStatus={serverState.firestoreStatus}
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
            allowShorts={allowShorts}
            onToggleAllowShorts={handleToggleAllowShorts}
            btcRegime={btcRegime}
            activityRadar={activityRadar}
            lossCircuitBreaker={lossCircuitBreaker}
            pacingInfo={pacingInfo}
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
            onResetTrades={handleResetTrades}
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

        {activeTab === 'backtest' && (
          <BacktestLabView />
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
