import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { netPnlUSD, outcome, netReturnPct, safeRatio, formatRatio, isCounted, isClosed } from '../services/metrics';
import { 
  History, 
  Search, 
  Filter, 
  ArrowUpRight, 
  ArrowDownRight, 
  TrendingUp, 
  TrendingDown, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  AlertCircle, 
  RefreshCw, 
  Download, 
  FileSpreadsheet, 
  ChevronDown, 
  ChevronUp, 
  SlidersHorizontal,
  DollarSign,
  Percent,
  ShieldCheck,
  Target,
  Sparkles,
  Layers,
  HelpCircle,
  Database,
  X
} from 'lucide-react';
import { AutomatedTradeRecord } from '../types/automatedFeed';
import { loadCompletedTrades, subscribeToAutomatedTrades, forceResyncTrades } from '../services/automatedFeedService';
import { exportTradesToCSV, exportTradesToJSON } from '../services/bankrollService';
import { formatCashUSD } from '../services/orderFlowService';

interface HistoryViewProps {
  onSwitchToScanner?: () => void;
  onSwitchToBankroll?: () => void;
  onResetTrades?: () => void;
}

type OutcomeFilter = 'ALL' | 'WINS' | 'LOSSES' | 'BREAKEVEN';
type SortOption = 'NEWEST' | 'OLDEST' | 'HIGHEST_PNL' | 'LOWEST_PNL' | 'LARGEST_WIN';

interface ExitReasonMeta {
  label: string;
  description: string;
  badgeClass: string;
  borderClass: string;
  icon: React.ReactNode;
}

export function getExitReasonMeta(reason?: string, status?: string): ExitReasonMeta {
  const normalized = (reason || status || '').toUpperCase();

  if (normalized.includes('TAKE_PROFIT') || normalized.includes('HARVEST')) {
    return {
      label: 'Take Profit Hit',
      description: 'Position reached automated profit harvest target (Tier 1/2/3).',
      badgeClass: 'bg-emerald-500/15 text-emerald-300',
      borderClass: 'border-emerald-500/30',
      icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
    };
  }

  if (normalized.includes('STOP_LOSS') || normalized.includes('STOPPED')) {
    return {
      label: 'Stop Loss Triggered',
      description: 'Defensive risk stop was executed to cap drawdown.',
      badgeClass: 'bg-rose-500/15 text-rose-300',
      borderClass: 'border-rose-500/30',
      icon: <XCircle className="w-3.5 h-3.5 text-rose-400" />
    };
  }

  if (normalized.includes('TIME_DECAY') || normalized.includes('ZOMBIE') || normalized.includes('STALE')) {
    return {
      label: 'Stale / Stagnation Recycled',
      description: 'Recycled to liquid cash after flat movement exceeded maximum holding threshold.',
      badgeClass: 'bg-amber-500/15 text-amber-300',
      borderClass: 'border-amber-500/30',
      icon: <Clock className="w-3.5 h-3.5 text-amber-400" />
    };
  }

  if (normalized.includes('SIGNAL_REVERSAL') || normalized.includes('REVERSAL')) {
    return {
      label: 'Signal Reversal',
      description: 'Opposing technical momentum detected; protected capital by exiting early.',
      badgeClass: 'bg-purple-500/15 text-purple-300',
      borderClass: 'border-purple-500/30',
      icon: <TrendingDown className="w-3.5 h-3.5 text-purple-400" />
    };
  }

  if (normalized.includes('ORDER_FLOW') || normalized.includes('DUMP')) {
    return {
      label: 'Order Flow Distribution',
      description: 'Closed on an estimated sell-pressure signal (calculated from 24h price action; no order book is used).',
      badgeClass: 'bg-cyan-500/15 text-cyan-300',
      borderClass: 'border-cyan-500/30',
      icon: <AlertCircle className="w-3.5 h-3.5 text-cyan-400" />
    };
  }

  if (normalized.includes('MANUAL')) {
    return {
      label: 'Manual Discretionary Exit',
      description: 'Closed manually by operator override.',
      badgeClass: 'bg-blue-500/15 text-blue-300',
      borderClass: 'border-blue-500/30',
      icon: <SlidersHorizontal className="w-3.5 h-3.5 text-blue-400" />
    };
  }

  if (normalized.includes('DUPLICATE') || normalized.includes('REBALANCED')) {
    return {
      label: 'Portfolio Rebalanced',
      description: 'Consolidated to preserve 10-coin slot diversification rule.',
      badgeClass: 'bg-stone-800 text-stone-300',
      borderClass: 'border-stone-700',
      icon: <Layers className="w-3.5 h-3.5 text-stone-400" />
    };
  }

  return {
    label: reason || 'Completed Trade',
    description: 'System closed this trade cycle according to predefined rules.',
    badgeClass: 'bg-stone-800 text-stone-300',
    borderClass: 'border-stone-700',
    icon: <History className="w-3.5 h-3.5 text-stone-400" />
  };
}

export function formatDuration(openMs?: number, closeMs?: number): string {
  if (!openMs || !closeMs || closeMs <= openMs) {
    return 'Immediate';
  }
  const diffSec = Math.floor((closeMs - openMs) / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    const remHours = diffHours % 24;
    return `${diffDays}d ${remHours}h`;
  }
  if (diffHours > 0) {
    const remMin = diffMin % 60;
    return `${diffHours}h ${remMin}m`;
  }
  return `${Math.max(1, diffMin)}m`;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  onSwitchToScanner,
  onSwitchToBankroll,
  onResetTrades,
}) => {
  const [completedTrades, setCompletedTrades] = useState<AutomatedTradeRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('ALL');
  const [reasonFilter, setReasonFilter] = useState<string>('ALL');
  const [sortOption, setSortOption] = useState<SortOption>('NEWEST');
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);
  const [syncBanner, setSyncBanner] = useState<{ type: 'success' | 'info' | 'error'; text: string } | null>(null);

  // Fetch completed trades from the trade records service
  const fetchHistoricalData = useCallback(async (isUserRefresh: boolean = false) => {
    if (isUserRefresh) setIsRefreshing(true);
    try {
      const closed = await loadCompletedTrades();   // the saved list; the shared sync keeps it current
      setCompletedTrades(closed.filter(isCounted));   // excluded in Data Health
    } catch (err) {
      console.error('Failed to load completed trades history:', err);
    } finally {
      setIsLoading(false);
      if (isUserRefresh) {
        setTimeout(() => setIsRefreshing(false), 500);
      }
    }
  }, []);

  // Force re-synchronize from Firebase Firestore or trading server (clearing both browser & server caches)
  const handleForceSync = useCallback(async (directFirestore: boolean = false) => {
    setIsRefreshing(true);
    try {
      const res = await forceResyncTrades(directFirestore, true);
      // loadCompletedTrades reads the saved list the resync just refreshed:
      // no second trip to Firestore.
      const closed = await loadCompletedTrades();
      setCompletedTrades(closed.filter(isCounted));
      if (res.success) {
        const sourceName = res.source === 'firestore' ? 'Firebase Firestore' : '24/7 Cloud Trading Server';
        setSyncBanner({
          type: 'success',
          text: directFirestore
            ? `Successfully cleared browser & server trade caches and synced ${res.closedCount} completed trades (${res.count} total records) directly from ${sourceName}!`
            : `Successfully synced ${res.closedCount} completed trades (${res.count} total records) from ${sourceName}!`,
        });
      } else {
        setSyncBanner({
          type: 'error',
          text: `Sync error: ${res.error || 'Failed to sync trades'}. Fallback data active.`,
        });
      }
    } catch (err: any) {
      setSyncBanner({
        type: 'error',
        text: `Sync failed: ${err?.message || String(err)}`,
      });
    } finally {
      setIsRefreshing(false);
      setTimeout(() => {
        setSyncBanner((curr) => curr?.type === 'success' ? null : curr);
      }, 7000);
    }
  }, []);

  // Hard reset browser and server caches and pull fresh directly from Firebase Firestore
  const handleClearCacheAndSync = useCallback(async () => {
    try {
      const keysToClear = [
        'crypto_automated_trades_local_fallback',
        'crypto_automated_trades_pending_writes',
        'crypto_automated_trades_sync_cursor',
        'crypto_automated_trades_full_sync_at',
        'crypto_automated_trades_sync_version',
        'firebase_quota_blocked_until',
      ];
      for (const k of keysToClear) {
        try { localStorage.removeItem(k); } catch {}
      }
      try {
        await fetch('/api/cache/clear', { method: 'POST' }).catch(() => {});
      } catch {}
    } catch {}
    await handleForceSync(true);
  }, [handleForceSync]);

  // Initial load on mount
  useEffect(() => {
    fetchHistoricalData(false);

    // Also subscribe to real-time updates from trade records service
    const unsubscribe = subscribeToAutomatedTrades((allTrades) => {
      const closed = allTrades.filter((t) => isClosed(t) && isCounted(t));
      setCompletedTrades(closed);
    });

    return () => unsubscribe();
  }, [fetchHistoricalData]);

  // Aggregate KPI Statistics
  const stats = useMemo(() => {
    const total = completedTrades.length;
    // Shared definitions (services/metrics.ts): net of fees, one breakeven band.
    const wins = completedTrades.filter((t) => outcome(t) === 'WIN');
    const losses = completedTrades.filter((t) => outcome(t) === 'LOSS');
    const breakevens = completedTrades.filter((t) => outcome(t) === 'BREAKEVEN');

    const winCount = wins.length;
    const lossCount = losses.length;
    const winRatePct = total > 0 ? +((winCount / total) * 100).toFixed(1) : 0;

    // Was labelled Net but summed gross pnlUSD with no fees removed.
    const totalNetPnLUSD = +completedTrades.reduce((acc, t) => acc + netPnlUSD(t), 0).toFixed(2);
    const totalBankedCashUSD = +completedTrades.reduce((acc, t) => acc + (t.realizedCashBankedUSD || 0), 0).toFixed(2);
    const totalFeesUSD = +completedTrades.reduce((acc, t) => acc + (t.totalFeesUSD || 0), 0).toFixed(2);

    const grossWinUSD = wins.reduce((acc, t) => acc + netPnlUSD(t), 0);
    const grossLossUSD = Math.abs(losses.reduce((acc, t) => acc + netPnlUSD(t), 0));
    const profitFactor = +safeRatio(grossWinUSD, grossLossUSD).toFixed(2);

    const avgWinPct = wins.length > 0 ? +(wins.reduce((acc, t) => acc + netReturnPct(t), 0) / wins.length).toFixed(2) : 0;
    const avgLossPct = losses.length > 0 ? +(losses.reduce((acc, t) => acc + netReturnPct(t), 0) / losses.length).toFixed(2) : 0;

    // Reason frequency counts
    const reasonsMap = new Map<string, number>();
    completedTrades.forEach((t) => {
      const meta = getExitReasonMeta(t.exitReason, t.status);
      reasonsMap.set(meta.label, (reasonsMap.get(meta.label) || 0) + 1);
    });

    return {
      total,
      winCount,
      lossCount,
      breakevensCount: breakevens.length,
      winRatePct,
      totalNetPnLUSD,
      totalBankedCashUSD,
      totalFeesUSD,
      profitFactor,
      avgWinPct,
      avgLossPct,
      reasonsList: Array.from(reasonsMap.entries()).sort((a, b) => b[1] - a[1])
    };
  }, [completedTrades]);

  // Unique exit reason categories for dropdown
  const uniqueReasons = useMemo(() => {
    const set = new Set<string>();
    completedTrades.forEach((t) => {
      const meta = getExitReasonMeta(t.exitReason, t.status);
      set.add(meta.label);
    });
    return Array.from(set);
  }, [completedTrades]);

  // Filter and sort trades
  const filteredTrades = useMemo(() => {
    return completedTrades
      .filter((trade) => {
        // Search query filter (symbol or name)
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase().trim();
          const matchSym = trade.symbol.toLowerCase().includes(q);
          const matchName = trade.coinName.toLowerCase().includes(q);
          if (!matchSym && !matchName) return false;
        }

        // Outcome filter
        const pnl = trade.pnlUSD || 0;
        if (outcomeFilter === 'WINS' && pnl <= 0) return false;
        if (outcomeFilter === 'LOSSES' && pnl >= 0) return false;
        if (outcomeFilter === 'BREAKEVEN' && pnl !== 0) return false;

        // Reason filter
        if (reasonFilter !== 'ALL') {
          const meta = getExitReasonMeta(trade.exitReason, trade.status);
          if (meta.label !== reasonFilter) return false;
        }

        return true;
      })
      .sort((a, b) => {
        const timeA = a.closedAtTimestamp || 0;
        const timeB = b.closedAtTimestamp || 0;
        const pnlPctA = a.pnlPercentage ?? 0;
        const pnlPctB = b.pnlPercentage ?? 0;
        const pnlUsdA = a.pnlUSD ?? 0;
        const pnlUsdB = b.pnlUSD ?? 0;

        if (sortOption === 'NEWEST') return timeB - timeA;
        if (sortOption === 'OLDEST') return timeA - timeB;
        if (sortOption === 'HIGHEST_PNL') return pnlPctB - pnlPctA;
        if (sortOption === 'LOWEST_PNL') return pnlPctA - pnlPctB;
        if (sortOption === 'LARGEST_WIN') return pnlUsdB - pnlUsdA;
        return 0;
      });
  }, [completedTrades, searchQuery, outcomeFilter, reasonFilter, sortOption]);

  const handleDownloadCSV = () => {
    const csvStr = exportTradesToCSV(completedTrades);
    const blob = new Blob([csvStr], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cryptostudy-trade-history-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJSON = () => {
    const jsonStr = exportTradesToJSON(completedTrades);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cryptostudy-trade-history-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div id="history-view-root" className="space-y-6">
      
      {/* Header Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-stone-900 via-stone-900 to-stone-950 border border-stone-800 p-4 sm:p-6 shadow-lg">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="flex h-2 w-2 rounded-full bg-amber-400"></span>
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
                Trade Ledger & Exit Verification
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-100 flex items-center gap-2.5">
              <History className="w-6 h-6 text-amber-400" />
              Completed Trade History
            </h2>
            <p className="text-xs sm:text-sm text-stone-400 mt-1 max-w-2xl leading-relaxed">
              Complete chronological audit trail of all closed positions, tracking entry & exit prices, holding periods, exact exit catalysts, and net final PnL percentages.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="history-force-firebase-sync-btn"
              onClick={() => handleForceSync(true)}
              disabled={isRefreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition-colors disabled:opacity-50"
              title="Wipes browser and server working trade caches and pulls fresh records directly from Firebase Firestore"
            >
              <Database className="w-3.5 h-3.5 text-amber-400" />
              <span>Clear Caches &amp; Sync</span>
            </button>

            <button
              id="history-refresh-btn"
              onClick={() => handleForceSync(false)}
              disabled={isRefreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700 transition-colors disabled:opacity-50"
              title="Re-query latest completed trades from Cloud Server / Firestore"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-amber-400' : 'text-stone-400'}`} />
              <span>{isRefreshing ? 'Syncing...' : 'Refresh Records'}</span>
            </button>

            <button
              id="history-export-csv-btn"
              onClick={handleDownloadCSV}
              disabled={completedTrades.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700 transition-colors disabled:opacity-40"
              title="Export completed trades to CSV"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden sm:inline">Export CSV</span>
            </button>

            <button
              id="history-export-json-btn"
              onClick={handleDownloadJSON}
              disabled={completedTrades.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-amber-500 hover:bg-amber-400 text-stone-950 transition-colors disabled:opacity-40 font-bold shadow-sm"
              title="Download raw JSON trade history"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">JSON</span>
            </button>

            {onResetTrades && (
              <button
                id="history-reset-all-btn"
                onClick={onResetTrades}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition-colors"
                title="Permanently clear all data on Firebase and reset to a clean fresh balance"
              >
                <X className="w-3.5 h-3.5 text-rose-400" />
                <span>Reset All Data</span>
              </button>
            )}
          </div>
        </div>

        {/* Sync Status Banner */}
        {syncBanner && (
          <div
            className={`mt-4 p-3 rounded-xl border text-xs font-medium flex items-center justify-between gap-2 animate-fadeIn ${
              syncBanner.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : syncBanner.type === 'error'
                ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
            }`}
          >
            <div className="flex items-center gap-2">
              {syncBanner.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : syncBanner.type === 'error' ? (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              ) : (
                <Database className="w-4 h-4 text-amber-400 shrink-0" />
              )}
              <span>{syncBanner.text}</span>
            </div>
            <button
              onClick={() => setSyncBanner(null)}
              className="text-stone-400 hover:text-stone-200 p-0.5"
              aria-label="Dismiss banner"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Aggregate KPI Summary Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-6 pt-5 border-t border-stone-800/80">
          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800/70">
            <span className="text-[10px] uppercase font-semibold text-stone-400 block mb-1">Closed Trades</span>
            <div className="text-lg sm:text-xl font-bold text-stone-100 font-mono">
              {stats.total}
            </div>
            <span className="text-[10px] text-stone-500">
              {stats.winCount}W • {stats.lossCount}L • {stats.breakevensCount}BE
            </span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800/70">
            <span className="text-[10px] uppercase font-semibold text-stone-400 block mb-1">Win Rate</span>
            <div className={`text-lg sm:text-xl font-bold font-mono ${stats.winRatePct >= 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {stats.winRatePct}%
            </div>
            <span className="text-[10px] text-stone-500">
              Target: &gt;55.0%
            </span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800/70">
            <span className="text-[10px] uppercase font-semibold text-stone-400 block mb-1">Realized Net PnL</span>
            <div className={`text-lg sm:text-xl font-bold font-mono ${stats.totalNetPnLUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {stats.totalNetPnLUSD >= 0 ? '+' : ''}${stats.totalNetPnLUSD.toFixed(2)}
            </div>
            <span className="text-[10px] text-stone-500">
              Fees: -${stats.totalFeesUSD.toFixed(2)}
            </span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800/70">
            <span className="text-[10px] uppercase font-semibold text-stone-400 block mb-1">Profit Factor</span>
            <div className={`text-lg sm:text-xl font-bold font-mono ${stats.profitFactor >= 1.5 ? 'text-emerald-400' : 'text-stone-300'}`}>
              {formatRatio(stats.profitFactor)}x
            </div>
            <span className="text-[10px] text-stone-500">
              Wins/Losses Ratio
            </span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800/70">
            <span className="text-[10px] uppercase font-semibold text-stone-400 block mb-1">Average Win</span>
            <div className="text-lg sm:text-xl font-bold font-mono text-emerald-400">
              +{stats.avgWinPct}%
            </div>
            <span className="text-[10px] text-stone-500">
              Target 1 &amp; Runners
            </span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800/70">
            <span className="text-[10px] uppercase font-semibold text-stone-400 block mb-1">Average Loss</span>
            <div className="text-lg sm:text-xl font-bold font-mono text-rose-400">
              {stats.avgLossPct !== 0 ? `${stats.avgLossPct}%` : '0.00%'}
            </div>
            <span className="text-[10px] text-stone-500">
              Capped by Ratchet
            </span>
          </div>
        </div>

        {/* Exit Reason Breakdown Badges */}
        {stats.reasonsList.length > 0 && (
          <div className="mt-4 pt-3 border-t border-stone-800/60 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-stone-400 mr-1 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-amber-400" />
              Exit Catalysts:
            </span>
            {stats.reasonsList.map(([reasonLabel, count]) => {
              const isSelected = reasonFilter === reasonLabel;
              return (
                <button
                  key={reasonLabel}
                  onClick={() => setReasonFilter(isSelected ? 'ALL' : reasonLabel)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 ring-1 ring-amber-500/30'
                      : 'bg-stone-950/80 text-stone-400 border-stone-800 hover:text-stone-200'
                  }`}
                  title={`Filter history by: ${reasonLabel}`}
                >
                  {reasonLabel} <strong className="ml-1 text-stone-300">{count}</strong>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Filter Toolbar */}
      <div className="p-4 rounded-xl bg-stone-900/80 border border-stone-800 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
        
        {/* Search Bar */}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-500" />
          <input
            id="history-search-input"
            type="text"
            placeholder="Search coin (e.g. BTC, SOL, PEPE)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-stone-950 border border-stone-800 text-stone-200 placeholder-stone-600 focus:outline-none focus:border-amber-500/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300 text-[10px]"
            >
              Clear
            </button>
          )}
        </div>

        {/* Filter Pills & Selectors */}
        <div className="flex flex-wrap items-center gap-2">
          
          {/* Outcome Filter Buttons */}
          <div className="inline-flex rounded-lg bg-stone-950 p-0.5 border border-stone-800">
            {(['ALL', 'WINS', 'LOSSES', 'BREAKEVEN'] as OutcomeFilter[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setOutcomeFilter(mode)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  outcomeFilter === mode
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                {mode === 'ALL' ? 'All Results' : mode === 'WINS' ? 'Wins Only' : mode === 'LOSSES' ? 'Losses Only' : 'Breakeven'}
              </button>
            ))}
          </div>

          {/* Reason Category Dropdown */}
          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-stone-500" />
            <select
              id="history-reason-filter"
              value={reasonFilter}
              onChange={(e) => setReasonFilter(e.target.value)}
              aria-label="Filter by exit catalyst"
              className="px-2.5 py-1.5 rounded-lg bg-stone-950 border border-stone-800 text-stone-300 text-[11px] focus:outline-none focus:border-amber-500/50"
            >
              <option value="ALL">All Exit Reasons</option>
              {uniqueReasons.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          {/* Sort Selector */}
          <select
            id="history-sort-select"
            value={sortOption}
            onChange={(e) => setSortOption(e.target.value as SortOption)}
            aria-label="Sort completed trades"
            className="px-2.5 py-1.5 rounded-lg bg-stone-950 border border-stone-800 text-stone-300 text-[11px] focus:outline-none focus:border-amber-500/50"
          >
            <option value="NEWEST">Newest Closed First</option>
            <option value="OLDEST">Oldest Closed First</option>
            <option value="HIGHEST_PNL">Highest PnL %</option>
            <option value="LOWEST_PNL">Lowest PnL %</option>
            <option value="LARGEST_WIN">Largest Dollar Gain</option>
          </select>
        </div>
      </div>

      {/* Main Trade History Table / Cards */}
      {isLoading ? (
        <div className="p-12 text-center rounded-2xl bg-stone-900 border border-stone-800 space-y-3">
          <RefreshCw className="w-6 h-6 text-amber-400 animate-spin mx-auto" />
          <p className="text-sm text-stone-400">Loading historical trade records from storage...</p>
        </div>
      ) : filteredTrades.length === 0 ? (
        <div className="p-12 text-center rounded-2xl bg-stone-900 border border-stone-800 space-y-4 max-w-xl mx-auto my-6">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mx-auto">
            <History className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-stone-100">
              {completedTrades.length === 0 ? 'No Completed Trades Recorded Yet' : 'No Trades Match Current Filters'}
            </h3>
            <p className="text-xs text-stone-400 mt-1 max-w-md mx-auto leading-relaxed">
              {completedTrades.length === 0
                ? 'As active positions hit profit targets (+4% / +5%), trailing stops, or stale decay timers, they will be archived here with full exit reasons and verified PnL.'
                : 'Try adjusting your search keywords, outcome selector, or exit catalyst dropdown.'}
            </p>
          </div>

          {completedTrades.length === 0 ? (
            <div className="space-y-3 pt-2">
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  id="history-empty-force-firebase-btn"
                  onClick={() => handleForceSync(true)}
                  disabled={isRefreshing}
                  className="px-4 py-2.5 text-xs font-bold rounded-lg bg-amber-500 hover:bg-amber-400 text-stone-950 transition-colors inline-flex items-center gap-2 shadow-sm disabled:opacity-50"
                  title="Query Firebase Firestore database directly and bypass local cache"
                >
                  <Database className="w-4 h-4" />
                  <span>{isRefreshing ? 'Syncing Firebase...' : 'Force Sync from Firebase'}</span>
                </button>
                {onSwitchToScanner && (
                  <button
                    onClick={onSwitchToScanner}
                    className="px-4 py-2.5 text-xs font-semibold rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700 transition-colors"
                  >
                    Go to Market Scanner
                  </button>
                )}
                {onSwitchToBankroll && (
                  <button
                    onClick={onSwitchToBankroll}
                    className="px-4 py-2.5 text-xs font-semibold rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700 transition-colors"
                  >
                    View Active Trades
                  </button>
                )}
              </div>
              <div>
                <button
                  onClick={handleClearCacheAndSync}
                  disabled={isRefreshing}
                  className="text-[11px] text-amber-400/80 hover:text-amber-300 underline transition-colors"
                  title="Wipes local storage keys and pulls fresh copy directly from Firebase Firestore"
                >
                  Edge or Browser stuck? Clear local cache &amp; hard resync
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setSearchQuery('');
                setOutcomeFilter('ALL');
                setReasonFilter('ALL');
              }}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-stone-800 text-stone-200 hover:bg-stone-700 transition-colors"
            >
              Reset Filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          
          {/* Active Filter Count Status */}
          <div className="flex items-center justify-between text-xs text-stone-400 px-1">
            <span>
              Showing <strong className="text-stone-200">{filteredTrades.length}</strong> of <strong className="text-stone-200">{completedTrades.length}</strong> completed trades
            </span>
            <span className="text-[11px] text-stone-500">
              Click any trade row to view full execution breakdown
            </span>
          </div>

          {/* Historical Trade Records List */}
          <div className="space-y-2.5">
            {filteredTrades.map((trade) => {
              const net = netPnlUSD(trade);
              const isProfit = outcome(trade) === 'WIN';
              const isLoss = outcome(trade) === 'LOSS';
              const pnlPct = netReturnPct(trade);
              const exitMeta = getExitReasonMeta(trade.exitReason, trade.status);
              const durationStr = formatDuration(trade.openedAtTimestamp, trade.closedAtTimestamp);
              const isExpanded = expandedTradeId === trade.id;

              return (
                <div
                  key={trade.id}
                  id={`history-row-${trade.id}`}
                  className="rounded-xl bg-stone-900/80 border border-stone-800 hover:border-stone-700 transition-all overflow-hidden"
                >
                  {/* Primary Row Header */}
                  <div 
                    onClick={() => setExpandedTradeId(isExpanded ? null : trade.id)}
                    className="p-3.5 sm:p-4 cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    
                    {/* Left: Asset & Timestamps */}
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 ${
                        isProfit 
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' 
                          : isLoss 
                          ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30' 
                          : 'bg-stone-800 text-stone-400 border border-stone-700'
                      }`}>
                        {trade.symbol.slice(0, 3)}
                      </div>

                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-stone-100">{trade.coinName}</span>
                          <span className="text-xs font-mono font-semibold text-stone-400 uppercase">{trade.symbol}</span>
                          
                          <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                            trade.direction === 'SHORT' ? 'bg-purple-500/20 text-purple-300' : 'bg-blue-500/20 text-blue-300'
                          }`}>
                            {trade.direction || 'LONG'}
                          </span>

                          {/* Exit Reason Badge */}
                          <span 
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${exitMeta.badgeClass} ${exitMeta.borderClass}`}
                            title={exitMeta.description}
                          >
                            {exitMeta.icon}
                            <span>{exitMeta.label}</span>
                          </span>
                        </div>

                        <div className="flex items-center gap-2 text-[11px] text-stone-400 mt-1 flex-wrap">
                          <span className="flex items-center gap-1 text-stone-400">
                            <Clock className="w-3 h-3 text-stone-400" />
                            Duration: <strong className="text-stone-200">{durationStr}</strong>
                          </span>
                          <span className="text-stone-600">•</span>
                          <span>
                            Closed: {trade.closedAtTimestamp ? new Date(trade.closedAtTimestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : trade.exitDate || 'Recently'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Right: Pricing, Net PnL & Expand Toggle */}
                    <div className="flex items-center justify-between sm:justify-end gap-5">
                      
                      {/* Pricing Cascade */}
                      <div className="text-left sm:text-right text-xs">
                        <div className="text-stone-300 font-mono">
                          <span className="text-stone-500 text-[10px]">Entry:</span> ${trade.entryPrice} 
                          <span className="text-stone-500 mx-1">→</span>
                          <span className="text-stone-500 text-[10px]">Exit:</span> ${trade.exitPrice || trade.currentPrice}
                        </div>
                        <div className="text-[10px] text-stone-500">
                          Tranche: ${trade.positionSizeUSD?.toFixed(2) || '10.00'} • Banked: ${trade.realizedCashBankedUSD?.toFixed(2) || '0.00'}
                        </div>
                      </div>

                      {/* Final PnL Percentage & Dollars */}
                      <div className="text-right shrink-0">
                        <div className={`text-base sm:text-lg font-extrabold font-mono flex items-center justify-end gap-1 ${
                          isProfit ? 'text-emerald-400' : isLoss ? 'text-rose-400' : 'text-stone-300'
                        }`}>
                          {isProfit ? <ArrowUpRight className="w-4 h-4" /> : isLoss ? <ArrowDownRight className="w-4 h-4" /> : null}
                          <span>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</span>
                        </div>

                        <div className={`text-[11px] font-mono font-medium ${
                          isProfit ? 'text-emerald-400/80' : isLoss ? 'text-rose-400/80' : 'text-stone-400'
                        }`}>
                          {net >= 0 ? '+' : ''}${net.toFixed(2)} USD
                        </div>
                      </div>

                      {/* Chevron */}
                      <div className="text-stone-500 hover:text-stone-300">
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Trade Details Audit */}
                  {isExpanded && (
                    <div className="p-4 bg-stone-950 border-t border-stone-800/80 space-y-3 text-xs">
                      
                      {/* Reason Description & Rationale */}
                      <div className="p-3 rounded-lg bg-stone-900/90 border border-stone-800 flex items-start gap-2.5">
                        <div className="p-1 rounded bg-stone-800 shrink-0 text-amber-400 mt-0.5">
                          {exitMeta.icon}
                        </div>
                        <div>
                          <span className="font-semibold text-stone-200 block text-xs">
                            Exit Reason: {exitMeta.label}
                          </span>
                          <p className="text-[11px] text-stone-400 mt-0.5 leading-relaxed">
                            {exitMeta.description} {trade.exitReason && trade.exitReason !== exitMeta.label ? `(Internal rule ID: ${trade.exitReason})` : ''}
                          </p>
                        </div>
                      </div>

                      {/* Excursion & Execution Metrics Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                        <div className="p-2.5 rounded-lg bg-stone-900 border border-stone-800">
                          <span className="text-[10px] text-stone-400 block uppercase font-medium">Max Peak (MFE)</span>
                          <span className="font-bold text-emerald-400 font-mono text-sm">
                            +{trade.mfePct?.toFixed(2) || pnlPct.toFixed(2)}%
                          </span>
                          <span className="text-[10px] text-stone-500 block mt-0.5">Peak profit during life</span>
                        </div>

                        <div className="p-2.5 rounded-lg bg-stone-900 border border-stone-800">
                          <span className="text-[10px] text-stone-400 block uppercase font-medium">Max Drawdown (MAE)</span>
                          <span className="font-bold text-rose-400 font-mono text-sm">
                            {trade.maePct !== undefined ? `-${Math.abs(trade.maePct).toFixed(2)}%` : '0.00%'}
                          </span>
                          <span className="text-[10px] text-stone-500 block mt-0.5">Adverse excursion</span>
                        </div>

                        <div className="p-2.5 rounded-lg bg-stone-900 border border-stone-800">
                          <span className="text-[10px] text-stone-400 block uppercase font-medium">Exchange Fees</span>
                          <span className="font-bold text-stone-200 font-mono text-sm">
                            ${trade.totalFeesUSD?.toFixed(3) || '0.020'}
                          </span>
                          <span className="text-[10px] text-stone-500 block mt-0.5">0.10% Spot Maker/Taker</span>
                        </div>

                        <div className="p-2.5 rounded-lg bg-stone-900 border border-stone-800">
                          <span className="text-[10px] text-stone-400 block uppercase font-medium">Cash Banked</span>
                          <span className="font-bold text-emerald-400 font-mono text-sm">
                            ${trade.realizedCashBankedUSD?.toFixed(2) || trade.pnlUSD?.toFixed(2) || '0.00'}
                          </span>
                          <span className="text-[10px] text-stone-500 block mt-0.5">Returned to Liquid Cash</span>
                        </div>
                      </div>

                      {/* Entry Signals Snapshot if available */}
                      {trade.entrySignals && (
                        <div className="p-3 rounded-lg bg-stone-900/60 border border-stone-800 text-[11px]">
                          <span className="font-semibold text-stone-300 block mb-1.5 flex items-center gap-1.5">
                            <Target className="w-3.5 h-3.5 text-amber-400" />
                            Original Entry Signals &amp; Market Regime:
                          </span>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-stone-400">
                            <div>
                              <span className="text-[10px] text-stone-400 block">RSI (14):</span>
                              <strong className="text-stone-200 font-mono">{trade.entrySignals.rsi14?.toFixed(1) || '—'}</strong>
                            </div>
                            <div>
                              <span className="text-[10px] text-stone-400 block">Volume Surge:</span>
                              <strong className="text-stone-200 font-mono">+{trade.entrySignals.volumeSurgePct || 0}%</strong>
                            </div>
                            <div>
                              <span className="text-[10px] text-stone-400 block">Sentiment Score:</span>
                              <strong className="text-stone-200 font-mono">{trade.entrySignals.sentimentScore || '—'}/100</strong>
                            </div>
                            <div>
                              <span className="text-[10px] text-stone-400 block">Market Regime:</span>
                              <strong className="text-stone-200 font-mono">{trade.marketRegimeAtEntry || 'NORMAL'}</strong>
                            </div>
                          </div>
                        </div>
                      )}

                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
};
