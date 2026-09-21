import React, { useState } from 'react';
import { netPnlUSD, outcome, netReturnPct, formatRatio } from '../services/metrics';
import { 
  BarChart3, 
  Layers, 
  DollarSign, 
  ShieldCheck, 
  TrendingUp, 
  RotateCcw, 
  Clock, 
  CheckCircle2, 
  Percent, 
  Zap, 
  SlidersHorizontal 
} from 'lucide-react';
import { AutomatedTradeRecord, BankrollState } from '../types/automatedFeed';
import { calculateStrategyVerification } from '../services/bankrollService';
import { StrategyMetricsScorecard } from './StrategyMetricsScorecard';
import { OverallMetricsView } from './OverallMetricsView';
import { TradePacingDiagnosticsCard } from './TradePacingDiagnosticsCard';
import { 
  MarketActivityRadar, 
  RecentLossCircuitBreaker, 
  AutoPilotPacingInfo 
} from '../services/marketRegimeService';

interface AutomatedFeedViewProps {
  trades: AutomatedTradeRecord[];
  bankroll: BankrollState;
  onCloseTrade?: (trade: AutomatedTradeRecord, reason: string) => void;
  onRecycleZombieTrade?: (trade: AutomatedTradeRecord) => void;
  onResetTrades?: () => void;
  activityRadar?: MarketActivityRadar;
  lossCircuitBreaker?: RecentLossCircuitBreaker;
  pacingInfo?: AutoPilotPacingInfo;
}

export const AutomatedFeedView: React.FC<AutomatedFeedViewProps> = ({
  trades,
  bankroll,
  onCloseTrade,
  onRecycleZombieTrade,
  onResetTrades,
  activityRadar,
  lossCircuitBreaker,
  pacingInfo,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'scorecard' | 'history' | 'analytics'>('scorecard');
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'WINS' | 'LOSSES' | 'BREAKEVEN' | 'OPEN'>('ALL');
  const verification = calculateStrategyVerification(trades);

  const filteredTrades = trades.filter((t) => {
    if (historyFilter === 'ALL') return t.status !== 'OPEN';
    if (historyFilter === 'OPEN') return t.status === 'OPEN';
    if (historyFilter === 'WINS') return t.status !== 'OPEN' && outcome(t) === 'WIN';
    if (historyFilter === 'LOSSES') return t.status !== 'OPEN' && outcome(t) === 'LOSS';
    if (historyFilter === 'BREAKEVEN') return t.status !== 'OPEN' && outcome(t) === 'BREAKEVEN';
    return true;
  });

  return (
    <div id="automated-feed-view" className="space-y-6">
      
      {/* 6-Metric Snapshot Banner */}
      <div id="automated-feed-6metric-banner" className="p-4 sm:p-5 rounded-2xl bg-stone-900 border border-stone-800 shadow-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-stone-800/80">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <BarChart3 className="w-4 h-4" />
              </span>
              <h2 className="text-base sm:text-lg font-black text-stone-100">
                Automated Feed & Target Metrics
              </h2>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              Multi-tranche bankroll parity execution with real-time statistical proofing and Binance fee tracking.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${
              verification.readinessStatus === 'VALIDATED_READY'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
            }`}>
              {verification.readinessStatus === 'VALIDATED_READY' ? '✓ Mathematical Edge Validated' : '⏳ Building CLT Sample Size'}
            </span>
          </div>
        </div>

        {/* The 6-Metric Core Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-3">
          <div className="p-3 rounded-xl bg-stone-950/80 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Starting Capital</span>
            <span className="text-base font-black text-stone-100">$100.00 <span className="text-xs font-normal text-stone-400">USDT</span></span>
            <span className="text-[10px] text-stone-400 block mt-0.5">Strict Baseline</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/80 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Liquid Cash</span>
            <span className="text-base font-black text-amber-400">${bankroll.liquidCashUSD.toFixed(2)}</span>
            <span className="text-[10px] text-stone-400 block mt-0.5">Recycled Cash</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/80 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Total Binance Fees</span>
            <span className="text-base font-black text-rose-400">-${verification.totalFeesUSD.toFixed(2)}</span>
            <span className="text-[10px] text-stone-400 block mt-0.5">0.10% Spot In/Out</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/80 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Win Rate</span>
            <span className="text-base font-black text-emerald-400">{verification.winRatePct}%</span>
            <span className="text-[10px] text-stone-400 block mt-0.5">Target ≥ 50.0%</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/80 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Payoff Ratio</span>
            <span className="text-base font-black text-amber-400">{formatRatio(verification.payoffRatio)}x</span>
            <span className="text-[10px] text-stone-400 block mt-0.5">Target ≥ 2.50x</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/80 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Sample Size (CLT)</span>
            <span className="text-base font-black text-stone-200">{verification.sampleSize} / 30</span>
            <span className="text-[10px] text-stone-400 block mt-0.5">Closed Cycles</span>
          </div>
        </div>

        {/* View Switcher Sub-Tabs */}
        <div className="flex items-center gap-1.5 mt-4 pt-3 border-t border-stone-800/80">
          <button
            onClick={() => setActiveSubTab('scorecard')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeSubTab === 'scorecard'
                ? 'bg-amber-500 text-stone-950 shadow-sm'
                : 'bg-stone-800/80 text-stone-300 hover:bg-stone-800'
            }`}
          >
            Target Metrics Scorecard
          </button>

          <button
            onClick={() => setActiveSubTab('history')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
              activeSubTab === 'history'
                ? 'bg-amber-500 text-stone-950 shadow-sm'
                : 'bg-stone-800/80 text-stone-300 hover:bg-stone-800'
            }`}
          >
            <span>Trade History Ledger</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-stone-950/40 text-stone-900">
              {verification.sampleSize} Cycles
            </span>
          </button>

          <button
            onClick={() => setActiveSubTab('analytics')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeSubTab === 'analytics'
                ? 'bg-amber-500 text-stone-950 shadow-sm'
                : 'bg-stone-800/80 text-stone-300 hover:bg-stone-800'
            }`}
          >
            Daily Performance & Analytics
          </button>
        </div>
      </div>

      {/* Trade Activity & Market Regime Diagnostics Strip */}
      <TradePacingDiagnosticsCard
        pacingInfo={pacingInfo}
        activityRadar={activityRadar}
        lossCircuitBreaker={lossCircuitBreaker}
        bankroll={bankroll}
        trades={trades}
      />

      {/* Tab Views */}
      {activeSubTab === 'scorecard' && (
        <StrategyMetricsScorecard
          trades={trades}
          bankroll={bankroll}
          onResetTrades={onResetTrades}
        />
      )}

      {activeSubTab === 'history' && (
        <div id="trade-history-ledger-panel" className="space-y-4">
          
          {/* Header & Filter Bar */}
          <div className="p-4 rounded-2xl bg-stone-900 border border-stone-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-400" />
                <h3 className="text-base font-bold text-stone-100">
                  Trade History Ledger (Closed Cycles Feed)
                </h3>
              </div>
              <p className="text-xs text-stone-400 mt-0.5">
                Every trade in this history is directly counted in the 6 Strategy Verification Benchmarks and Central Limit Theorem sample size.
              </p>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {(['ALL', 'WINS', 'LOSSES', 'BREAKEVEN', 'OPEN'] as const).map((filter) => {
                const count = filter === 'ALL' 
                  ? verification.sampleSize 
                  : filter === 'OPEN' 
                  ? trades.filter(t => t.status === 'OPEN').length
                  : filter === 'WINS' 
                  ? verification.winCount 
                  : filter === 'LOSSES' 
                  ? verification.lossCount 
                  : verification.breakevenCount;

                return (
                  <button
                    key={filter}
                    onClick={() => setHistoryFilter(filter)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      historyFilter === filter
                        ? 'bg-amber-500 text-stone-950'
                        : 'bg-stone-800 text-stone-400 hover:text-stone-200'
                    }`}
                  >
                    {filter} ({count})
                  </button>
                );
              })}
            </div>
          </div>

          {/* Trade Records List */}
          <div className="space-y-2.5">
            {filteredTrades.map((trade) => {
              const net = netPnlUSD(trade);
              const isProfit = outcome(trade) === 'WIN';
              const isBreakeven = outcome(trade) === 'BREAKEVEN';
              const isLoss = outcome(trade) === 'LOSS';
              const isOpen = trade.status === 'OPEN';

              return (
                <div
                  key={trade.id}
                  className="p-4 rounded-xl bg-stone-900 border border-stone-800 hover:border-stone-700 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs ${
                      isOpen
                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                        : isProfit
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                        : isBreakeven
                        ? 'bg-stone-800 text-amber-400 border border-stone-700'
                        : 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                    }`}>
                      {trade.symbol.slice(0, 4)}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-stone-100 text-sm">{trade.coinName}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-800 text-stone-400">
                          {isOpen ? 'ACTIVE $10 SLOT' : trade.exitReason || 'CLOSED'}
                        </span>
                        {trade.ratchet?.isArmed && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                            Ratchet Armed ✓
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-xs text-stone-400 mt-1">
                        <span>Entry: <strong className="text-stone-300">${trade.entryPrice}</strong></span>
                        <span>Exit: <strong className="text-stone-300">${trade.currentPrice}</strong></span>
                        <span className="text-rose-400/90 text-[11px]">
                          Binance Fee: -${(trade.totalFeesUSD || 0).toFixed(3)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-4 border-t sm:border-t-0 pt-2 sm:pt-0 border-stone-800">
                    <div className="text-right">
                      <span className={`text-base font-black block ${
                        isOpen
                          ? 'text-amber-400'
                          : isProfit
                          ? 'text-emerald-400'
                          : isBreakeven
                          ? 'text-stone-300'
                          : 'text-rose-400'
                      }`}>
                        {isOpen ? 'Open Unrealized' : (net >= 0 ? '+' : '') + `$${net.toFixed(2)}`}
                      </span>
                      <span className="text-xs text-stone-400 block font-mono">
                        {netReturnPct(trade) >= 0 ? '+' : ''}{netReturnPct(trade).toFixed(1)}% yield
                      </span>
                    </div>

                    <div className="text-right text-[11px] text-stone-400 hidden sm:block">
                      <span className="block font-medium text-stone-300">$10.00 Micro-Slot</span>
                      <span className="block text-[10px] text-stone-400">
                        {new Date(trade.closedAtTimestamp || trade.openedAtTimestamp || Date.now()).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredTrades.length === 0 && (
              <div className="p-8 text-center rounded-2xl bg-stone-900 border border-stone-800 text-stone-400">
                <p className="text-sm">No trades found matching the "{historyFilter}" filter.</p>
              </div>
            )}
          </div>

        </div>
      )}

      {activeSubTab === 'analytics' && (
        <OverallMetricsView
          trades={trades}
          bankroll={bankroll}
          onResetTrades={onResetTrades}
        />
      )}

    </div>
  );
};
