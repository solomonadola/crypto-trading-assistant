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
  subscribeToAutomatedTrades, 
  executeSimulatedTrade, 
  updateTradeRecord, 
  resetTradesToDefault,
  syncOpenTradesWithLivePrices
} from './services/automatedFeedService';
import { scanLiveMarketEntries, deploySignalToAutomatedFeed } from './services/entryScannerService';
import { calculateBankrollState } from './services/bankrollService';
import { AUTOPILOT_CONFIG } from './config/autopilot';
import {
  evaluateBtcMacroRegime,
  evaluateMarketActivityRadar,
  evaluateRecentLossCircuitBreaker,
  getAutoPilotPacingInfo,
} from './services/marketRegimeService';
import { enrichCoinsWithBinance, fetchLiveMarketCoins, fetchBinanceTickers } from './services/binanceService';
import { isFirebaseInitialized } from './lib/firebase';
import { Zap, CheckCircle2, AlertCircle } from 'lucide-react';

export default function App() {
  const [coins, setCoins] = useState<CryptoCoin[]>([]);
  const [trades, setTrades] = useState<AutomatedTradeRecord[]>([]);
  const [tradingMode, setTradingMode] = useState<ScannerTradingMode>('FUTURES_1_2D');
  const [activeTab, setActiveTab] = useState<ActiveTab>('scanner');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
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

  const handleToggleAutoPilot = useCallback(() => {
    setIsAutoPilot((prev) => {
      const nextVal = !prev;
      try {
        localStorage.setItem('cryptostudy_autopilot', String(nextVal));
      } catch (e) {
        console.warn('Failed to save autopilot setting:', e);
      }
      showNotification(
        nextVal
          ? '🤖 Auto-Pilot Activated: Autonomous entries and exits are now active!'
          : 'Auto-Pilot Paused: Switched to manual one-click entry confirmation.',
        nextVal ? 'success' : 'info'
      );
      return nextVal;
    });
  }, [showNotification]);

  // Subscribe to trade feed (Firestore or LocalStorage)
  useEffect(() => {
    const unsubscribe = subscribeToAutomatedTrades((loadedTrades) => {
      setTrades(loadedTrades);
    });
    return () => unsubscribe();
  }, []);

  // Initial load of live market data from Binance API (no mock data)
  useEffect(() => {
    fetchLiveMarketCoins().then((liveCoins) => {
      setCoins(liveCoins);
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
  const handleRefreshLiveFeed = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const enriched = await fetchLiveMarketCoins();
      setCoins(enriched);
      snapshotIdRef.current += 1;   // marks a genuinely new market observation

      // Build price map for trade evaluation
      const priceMap = new Map<string, number>();
      enriched.forEach((c) => {
        if (c.current_price) {
          priceMap.set(c.symbol.toUpperCase(), c.current_price);
          priceMap.set(c.id.toLowerCase(), c.current_price);
        }
      });

      // Also enrich priceMap with full Binance tickers so any non-top-15 open trades (e.g. PEPE, AR, STRK) get live prices
      try {
        const tickers = await fetchBinanceTickers();
        tickers.forEach((t: any, pair: string) => {
          const p = parseFloat(t.lastPrice);
          if (!isNaN(p) && p > 0) {
            const sym = pair.replace(/USDT$|USD$/, '').toUpperCase();
            if (!priceMap.has(sym)) {
              priceMap.set(sym, p);
            }
          }
        });
      } catch {}

      // Pass known trades to avoid triggering getDocs from Firestore on every tick
      const { updatedCount, events } = await syncOpenTradesWithLivePrices(priceMap, tradesRef.current);
      if (events.length > 0) {
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
      setIsRefreshing(false);
    }
  }, [showNotification]);

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
      setTrades((prev) => [deployed, ...prev.filter((t) => t.id !== deployed.id)]);
      showNotification(`Successfully deployed $${bankroll.trancheSizeUSD.toFixed(2)} tranche for ${signal.symbol} (${signal.archetypeName})!`, 'success');
    } catch (e: any) {
      console.error('Failed to deploy signal:', e);
      showNotification(e?.message || 'Failed to deploy signal.', 'warn');
    }
  };

  // Autonomous Auto-Pilot Trigger: Automatically deploy qualified signals when slots are available
  // Strictly capped to max 10 active trades (10 distinct coins).
  // Enforces 20-min post-exit cooldown on closed coins.
  // Enforces max 3 major coins (BTC, ETH, BNB, SOL).
  // In times of market stall, prioritizes high-beta altcoins over sluggish mega-caps.
  useEffect(() => {
    if (!isAutoPilot) return;
    if (isDeployingRef.current) return;

    // Regime gate. Blocks new entries during consolidation lock, a BTC dump,
    // or a loss-streak cooldown - the conditions under which a sub-ATR stop is
    // most likely to be hit by noise rather than by the thesis failing.
    if (AUTOPILOT_CONFIG.enforceRegimeGates && !pacingInfo.isDeployingAllowed) return;

    // Burst guard: one deploy per fresh snapshot, and never faster than
    // minMsBetweenDeploys. Without this the effect re-fires every 10s (and on
    // every `trades` change) against a snapshot that only refreshes every 30s,
    // opening several highly-correlated positions seconds apart.
    if (AUTOPILOT_CONFIG.oneDeployPerSnapshot &&
        lastDeploySnapshotRef.current === snapshotIdRef.current) return;
    if (Date.now() - lastDeployAtRef.current < AUTOPILOT_CONFIG.minMsBetweenDeploys) return;

    const openTrades = trades.filter((t) => t.status === 'OPEN');
    if (openTrades.length >= AUTOPILOT_CONFIG.maxConcurrentTrades) return;
    if (!bankroll.canOpenNewTrade) return;
    if (bankroll.liquidCashUSD < bankroll.trancheSizeUSD) return;
    if (bankroll.deployedCapitalUSD + bankroll.trancheSizeUSD > bankroll.totalPortfolioValueUSD + 0.05) return;

    const openTradeSymbols = new Set(
      openTrades.map((t) => t.symbol.toUpperCase())
    );

    const now = Date.now();
    // 20-Minute Re-Entry Cooldown Guard: any coin closed within the last 20 mins is barred from Auto-Pilot
    const cooldownSymbols = new Set(
      trades
        .filter((t) => t.status !== 'OPEN' && t.closedAtTimestamp && (now - t.closedAtTimestamp < COIN_REENTRY_COOLDOWN_MS))
        .map((t) => t.symbol.toUpperCase())
    );

    // Current open major count (BTC, ETH, BNB, SOL) and meme count (DOGE, PEPE, WIF, BONK, etc.)
    const openMajorCount = openTrades.filter((t) => MAJOR_COINS.has(t.symbol.toUpperCase())).length;
    const openMemeCount = openTrades.filter((t) => MEME_COINS.has(t.symbol.toUpperCase())).length;

    // Filter candidates
    const eligibleCandidates = signals
      .filter((s) => !openTradeSymbols.has(s.symbol.toUpperCase()))
      .filter((s) => !cooldownSymbols.has(s.symbol.toUpperCase()))
      .filter((s) => {
        const sym = s.symbol.toUpperCase();
        const isMajor = MAJOR_COINS.has(sym);
        const isMeme = MEME_COINS.has(sym);

        // Enforce max 3 major coins cap
        if (isMajor && openMajorCount >= MAX_MAJOR_COIN_SLOTS) {
          return false;
        }

        // Enforce max 2 meme coins cap (to prevent sector-wide flush risk)
        if (isMeme && openMemeCount >= MAX_MEME_COIN_SLOTS) {
          return false;
        }

        // Short side disabled. Measured forward returns were negative in both
        // samples: in-sample t = -2.02 at 5m, and out-of-sample the short leg
        // collapsed from -38 bps (t = -4.08) to -6.65 bps (t = -1.16), i.e. it
        // was six months of alts trending, not an edge. See STUDY_A_RESULTS.md.
        if (!AUTOPILOT_CONFIG.allowShorts && s.direction === 'SHORT') {
          return false;
        }

        // Multi-Timeframe Confluence Guard: Auto-Pilot rejects disqualified or weak C-grade setups
        const confluence = s.timeframeConfluence?.confluenceRating;
        const alignedCount = s.timeframeConfluence?.alignedCount ?? 3;
        if (confluence === 'DISQUALIFIED' || confluence === 'C' || alignedCount < 2) {
          return false;
        }

        // 1. High conviction triggered setups
        if (s.status === 'TRIGGERED' && s.score >= AUTOPILOT_CONFIG.minScore) return true;
        // 2. Strong constructive setups with at least 3 checkpoints confirmed and not blocked
        if (s.status === 'FORMING' && s.score >= AUTOPILOT_CONFIG.minScore && !s.disqualificationReason) {
          const passedCount = s.checkpoints.filter((c) => c.passed).length;
          return passedCount >= 3;
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

        // Multi-Timeframe Confluence Priority: A+ and A setups first
        const confRankA = a.timeframeConfluence?.confluenceRating === 'A+' ? 2 : a.timeframeConfluence?.confluenceRating === 'A' ? 1 : 0;
        const confRankB = b.timeframeConfluence?.confluenceRating === 'A+' ? 2 : b.timeframeConfluence?.confluenceRating === 'A' ? 1 : 0;
        if (confRankB !== confRankA) return confRankB - confRankA;

        // Market Movement Evaluation:
        // Majors are considered "actively moving" if |24h change| >= 2.5%.
        // In stalls (<2.5%), high-beta alts & memes are given higher priority to capture larger swings!
        const aIsVolatileMajor = isMajorA && Math.abs(a.priceChange24hPct || 0) >= 2.5;
        const bIsVolatileMajor = isMajorB && Math.abs(b.priceChange24hPct || 0) >= 2.5;
        const aIsStallingMajor = isMajorA && !aIsVolatileMajor;
        const bIsStallingMajor = isMajorB && !bIsVolatileMajor;

        // Prefer active alts/memes or volatile majors over stalling majors
        if (!aIsStallingMajor && bIsStallingMajor) return -1;
        if (aIsStallingMajor && !bIsStallingMajor) return 1;

        // Triggered setups first
        if (a.status === 'TRIGGERED' && b.status !== 'TRIGGERED') return -1;
        if (b.status === 'TRIGGERED' && a.status !== 'TRIGGERED') return 1;

        // Higher score first
        return b.score - a.score;
      });

    const qualified = eligibleCandidates[0];

    if (qualified) {
      isDeployingRef.current = true;
      lastDeployAtRef.current = Date.now();
      lastDeploySnapshotRef.current = snapshotIdRef.current;
      deploySignalToAutomatedFeed(qualified, bankroll.trancheSizeUSD)
        .then((newTrade) => {
          setTrades((prev) => [newTrade, ...prev.filter((t) => t.id !== newTrade.id)]);
          const symUpper = qualified.symbol.toUpperCase();
          const isMajor = MAJOR_COINS.has(symUpper);
          const isMeme = MEME_COINS.has(symUpper);
          const roleLabel = isMajor ? '⚡ Volatile Major' : isMeme ? '🎭 High-Beta Meme' : '🚀 High-Beta Alt';
          const confGrade = qualified.timeframeConfluence?.confluenceRating || 'A';
          showNotification(
            `🤖 Auto-Pilot: Deployed $${bankroll.trancheSizeUSD.toFixed(2)} into ${qualified.symbol} (${roleLabel}, Score ${qualified.score}/100, MTF: ${confGrade})! Slot ${openTrades.length + 1}/10.`,
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
  }, [isAutoPilot, autoPilotScanTick, bankroll.canOpenNewTrade, bankroll.activeTradesCount, bankroll.liquidCashUSD, bankroll.trancheSizeUSD, bankroll.deployedCapitalUSD, bankroll.totalPortfolioValueUSD, signals, trades, pacingInfo, showNotification]);


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
    setTrades((prev) => prev.map((t) => (t.id === trade.id ? updated : t)));
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
    setTrades((prev) => prev.map((t) => (t.id === trade.id ? updated : t)));
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
        isFirebaseLive={isFirebaseInitialized()}
        onRefreshLiveFeed={handleRefreshLiveFeed}
        isRefreshing={isRefreshing}
        onOpenDeployModal={() => setIsDeployModalOpen(true)}
        onOpenMetricsModal={() => setIsMetricsModalOpen(true)}
        isAutoPilot={isAutoPilot}
        onToggleAutoPilot={handleToggleAutoPilot}
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
              CryptoStudy Lab connects to Google Cloud Firestore with real-time multi-device synchronization and default-deny security rules.
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
