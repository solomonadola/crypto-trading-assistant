import React, { useState } from 'react';
import { formatRatio, netPnlUSD, netReturnPct } from '../services/metrics';
import { 
  Layers, 
  Lock, 
  ShieldCheck, 
  TrendingUp, 
  TrendingDown, 
  Clock, 
  AlertCircle, 
  RefreshCw, 
  CheckCircle2, 
  Trash2,
  DollarSign,
  Zap,
  BarChart3,
  Download,
  Database,
  Target,
  FileSpreadsheet,
  FileCode,
  HelpCircle,
  Lightbulb
} from 'lucide-react';
import { AutomatedTradeRecord, BankrollState } from '../types/automatedFeed';
import { 
  isTradeZombieStale, 
  calculateStrategyVerification, 
  exportTradesToJSON, 
  exportTradesToCSV 
} from '../services/bankrollService';
import { formatCashUSD } from '../services/orderFlowService';

interface BankrollViewProps {
  bankroll: BankrollState;
  trades: AutomatedTradeRecord[];
  onCloseTrade: (trade: AutomatedTradeRecord, reason: string) => void;
  onRecycleZombieTrade: (trade: AutomatedTradeRecord) => void;
  onResetTrades: () => void;
  onRecalibrateTrade?: (trade: AutomatedTradeRecord) => void;
}

export const BankrollView: React.FC<BankrollViewProps> = ({
  bankroll,
  trades,
  onCloseTrade,
  onRecycleZombieTrade,
  onResetTrades,
  onRecalibrateTrade,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'OPEN' | 'CLOSED' | 'METRICS'>('OPEN');

  const openTrades = trades.filter((t) => t.status === 'OPEN');
  const closedTrades = trades.filter((t) => t.status !== 'OPEN');
  const verification = calculateStrategyVerification(trades);

  const handleDownloadJSON = () => {
    const jsonStr = exportTradesToJSON(trades);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cryptostudy-trades-metrics-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadCSV = () => {
    const csvStr = exportTradesToCSV(trades);
    const blob = new Blob([csvStr], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cryptostudy-trades-metrics-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div id="bankroll-view-root" className="space-y-6">
      
      {/* Treasury Header Card */}
      <div className="rounded-2xl bg-gradient-to-r from-stone-900 via-stone-900 to-stone-950 border border-stone-800 p-4 sm:p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="flex h-2 w-2 rounded-full bg-emerald-400"></span>
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                Portfolio Balance & Trade Slots
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-100">
              My Trades & Money Management
            </h2>
            <p className="text-xs sm:text-sm text-stone-400 mt-1 max-w-2xl">
              Trades are allocated using <strong>Capital ÷ 10 compounding</strong> (${bankroll.trancheSizeUSD.toFixed(2)} per slot). When a trade makes +4%, it takes partial profit and moves the stop loss to breakeven, preserving gains to compound future trades.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="reset-bankroll-trades-btn"
              onClick={onResetTrades}
              title="Clear all trade history and reset balance to $100"
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-400 hover:text-stone-200 bg-stone-950 border border-stone-800 hover:bg-stone-800 transition-colors"
            >
              Reset Trades & Balance
            </button>
          </div>
        </div>

        {/* Treasury Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-4 border-t border-stone-800/80">
          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800" title="Total Net Worth = Available Cash ($) + Value of Open Positions ($)">
            <span className="text-[10px] text-stone-400 uppercase block font-medium">Total Account Value</span>
            <span className="text-xl font-extrabold text-stone-100">
              ${bankroll.totalPortfolioValueUSD.toFixed(2)}
            </span>
            <span className={`text-[11px] font-semibold ${
              bankroll.netProfitPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}>
              {bankroll.netProfitPct >= 0 ? '+' : ''}{bankroll.netProfitPct}% Overall Return
            </span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800" title="Cash sitting uninvested, ready to enter new trades">
            <span className="text-[10px] text-stone-400 uppercase block font-medium">Available Cash (Unused)</span>
            <span className="text-xl font-extrabold text-emerald-400">
              ${bankroll.liquidCashUSD.toFixed(2)}
            </span>
            <span className="text-[11px] text-stone-500">
              {bankroll.availableSlots} Slots Free for New Trades
            </span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800" title="Capital currently tied up in active positions">
            <span className="text-[10px] text-stone-400 uppercase block font-medium">Money in Active Trades</span>
            <span className="text-xl font-extrabold text-amber-400">
              ${bankroll.deployedCapitalUSD.toFixed(2)}
            </span>
            <span className="text-[11px] text-stone-500">
              {bankroll.activeTradesCount} / {bankroll.totalSlots} Slots • ${bankroll.trancheSizeUSD.toFixed(2)}/trade
            </span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800" title="Cumulative realized gains banked into cash from closed trades and tier profit-taking">
            <span className="text-[10px] text-stone-400 uppercase block font-medium">Total Profit Taken & Kept</span>
            <span className={`text-xl font-extrabold ${
              bankroll.realizedProfitUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}>
              {bankroll.realizedProfitUSD >= 0 ? '+' : ''}${bankroll.realizedProfitUSD.toFixed(2)}
            </span>
            <span className="text-[11px] text-stone-500">
              Exchange Fees: ${bankroll.totalFeesPaidUSD.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* 10-Slot Visualizer */}
      <div className="rounded-xl bg-stone-900 border border-stone-800 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-400 mb-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span>Active Trade Slots (10 Slots • Compounding)</span>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-300 border border-amber-500/30">
              ${bankroll.trancheSizeUSD.toFixed(2)} / Tranche (Capital ÷ 10)
            </span>
          </div>
          <span className="text-amber-400 font-bold">{bankroll.activeTradesCount} / 10 Occupied</span>
        </h3>

        <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
          {bankroll.slots.map((slot) => {
            const isFilled = slot.status === 'FILLED';
            const trade = slot.trade;
            const isArmed = trade?.ratchet?.isArmed;

            return (
              <div
                key={slot.slotIndex}
                className={`flex flex-col items-center justify-center p-2.5 rounded-lg border text-center transition-all ${
                  isFilled
                    ? isArmed
                      ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                    : 'bg-stone-950 border-stone-800/80 text-stone-500'
                }`}
              >
                <span className="text-[10px] font-mono text-stone-400">#{slot.slotIndex}</span>
                {isFilled && trade ? (
                  <>
                    <span className="font-bold text-xs mt-1 truncate max-w-[50px]">{trade.symbol}</span>
                    <span className="text-[9px] mt-0.5 font-semibold">
                      {isArmed ? 'ZERO RISK' : `${trade.pnlPercentage >= 0 ? '+' : ''}${trade.pnlPercentage}%`}
                    </span>
                  </>
                ) : (
                  <span className="text-[10px] font-medium text-stone-600 mt-1">EMPTY</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Trades Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-stone-800 pb-2">
        <button
          onClick={() => setActiveSubTab('OPEN')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            activeSubTab === 'OPEN'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              : 'text-stone-400 hover:text-stone-200'
          }`}
        >
          Active Trades ({openTrades.length})
        </button>

        <button
          onClick={() => setActiveSubTab('CLOSED')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            activeSubTab === 'CLOSED'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              : 'text-stone-400 hover:text-stone-200'
          }`}
        >
          Closed Trades Log ({closedTrades.length})
        </button>

        <button
          id="subtab-metrics-audit"
          onClick={() => setActiveSubTab('METRICS')}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            activeSubTab === 'METRICS'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              : 'text-stone-400 hover:text-stone-200'
          }`}
        >
          <BarChart3 className="w-3.5 h-3.5" />
          <span>Performance & Edge Metrics</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300">
            {verification.sampleSize} Sampled
          </span>
        </button>
      </div>

      {/* Active Trades View */}
      {activeSubTab === 'OPEN' && (
        <div className="space-y-4">
          {openTrades.map((trade) => {
            const isShort = trade.direction === 'SHORT';
            const isArmed = trade.ratchet?.isArmed;
            const t1Harvested = trade.harvestTiers?.tier1.status === 'HARVESTED';
            const t2Harvested = trade.harvestTiers?.tier2.status === 'HARVESTED';
            const t3Harvested = trade.harvestTiers?.tier3.status === 'HARVESTED';
            const zombie = isTradeZombieStale(trade);

            return (
              <div
                key={trade.id}
                id={`trade-card-${trade.id}`}
                className="p-4 sm:p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-4 shadow-sm"
              >
                {/* Trade Top Bar */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-stone-800/80">
                  <div className="flex items-center gap-3">
                    {trade.coinImage ? (
                      <img src={trade.coinImage} alt={trade.symbol} className="w-9 h-9 rounded-full" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-stone-800 flex items-center justify-center font-bold text-xs text-stone-300">
                        {trade.symbol.slice(0, 2)}
                      </div>
                    )}
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-bold text-base text-stone-100">{trade.coinName} ({trade.symbol})</h4>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          isShort ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
                        }`}>
                          {trade.direction}
                        </span>
                        {t3Harvested ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                            <ShieldCheck className="w-3 h-3" />
                            UNCAPPED RUNNER (TRAILING)
                          </span>
                        ) : isArmed ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                            <ShieldCheck className="w-3 h-3" />
                            {t2Harvested ? 'STEP-LOCK TIER 1' : 'ZERO RISK LOCKED'}
                          </span>
                        ) : null}

                        {zombie.isStale ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse" title={zombie.reason}>
                            <Clock className="w-3 h-3 text-amber-400" />
                            STAGNANT ({zombie.hoursElapsed}h flat)
                          </span>
                        ) : zombie.hoursElapsed < 1.5 ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-cyan-500/10 text-cyan-300 border border-cyan-500/30" title="Recent entry: allow 1.5-2h minimum for order absorption">
                            <Clock className="w-3 h-3 text-cyan-400" />
                            {zombie.hoursElapsed}h (Accumulating)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-stone-800 text-stone-300 border border-stone-700">
                            <Clock className="w-3 h-3 text-stone-400" />
                            {zombie.hoursElapsed}h open
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-stone-400 mt-0.5">
                        Tranche: ${trade.positionSizeUSD?.toFixed(2) || '10.00'} • Entry: ${typeof trade.entryPrice === 'number' ? (trade.entryPrice < 1 ? trade.entryPrice.toFixed(4) : trade.entryPrice.toFixed(2)) : trade.entryPrice} • Live: ${typeof trade.currentPrice === 'number' ? (trade.currentPrice < 1 ? trade.currentPrice.toFixed(4) : trade.currentPrice.toFixed(2)) : trade.currentPrice}
                      </p>
                    </div>
                  </div>

                  {/* PnL Indicator */}
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <span className="text-[10px] text-stone-500 uppercase block">Current PnL</span>
                      <span className={`text-base font-extrabold ${
                        netPnlUSD(trade) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}>
                        {netPnlUSD(trade) >= 0 ? '+' : ''}${Math.abs(netPnlUSD(trade)) < 0.10 && Math.abs(netPnlUSD(trade)) > 0 ? netPnlUSD(trade).toFixed(3) : netPnlUSD(trade).toFixed(2)} ({netReturnPct(trade) >= 0 ? '+' : ''}{netReturnPct(trade).toFixed(2)}%)
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {zombie.isStale && (
                        <button
                          onClick={() => onRecycleZombieTrade(trade)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-amber-300 hover:text-amber-100 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 transition-colors cursor-pointer flex items-center gap-1 shadow-sm"
                          title={zombie.reason}
                        >
                          <RefreshCw className="w-3 h-3" />
                          Recycle Flat Slot ($10)
                        </button>
                      )}

                      {!zombie.isStale && Math.abs(trade.pnlPercentage) <= 0.45 && zombie.hoursElapsed >= 2.0 && !t1Harvested && (
                        <button
                          onClick={() => onCloseTrade(trade, 'BREAKEVEN_EXIT')}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-stone-300 hover:text-stone-100 bg-stone-800 hover:bg-stone-700 border border-stone-700 transition-colors cursor-pointer flex items-center gap-1"
                          title="Exit position around breakeven to free up this $10 slot for a fresh setup"
                        >
                          Exit Breakeven
                        </button>
                      )}

                      {onRecalibrateTrade && trade.currentPrice && Math.abs(trade.currentPrice - trade.entryPrice) / trade.entryPrice > 0.03 && (
                        <button
                          onClick={() => onRecalibrateTrade(trade)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-amber-300 hover:text-amber-100 bg-amber-500/10 hover:bg-amber-500/25 border border-amber-500/30 transition-colors cursor-pointer flex items-center gap-1"
                          title={`Re-anchor entry price to current live market ($${trade.currentPrice < 1 ? trade.currentPrice.toFixed(4) : trade.currentPrice.toFixed(2)}) and reset ladder`}
                        >
                          <RefreshCw className="w-3 h-3" />
                          Sync Entry
                        </button>
                      )}

                      <button
                        onClick={() => onCloseTrade(trade, 'MANUAL_EXIT')}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-300 hover:text-rose-100 bg-rose-500/10 hover:bg-rose-500/25 border border-rose-500/30 transition-colors cursor-pointer"
                        title="Close this trade. Auto-Pilot will pause on this coin for 5 minutes."
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>

                {/* Harvest Tiers Visual Ladder */}
                <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800">
                  <div className="flex items-center justify-between text-xs text-stone-400 mb-2">
                    <span className="font-semibold text-stone-300">3-Step Profit Taking Plan</span>
                    <span>Profit Banked in Cash: <strong className="text-emerald-400">${trade.realizedCashBankedUSD?.toFixed(2) || '0.00'}</strong></span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    {/* Tier 1 */}
                    <div className={`p-2 rounded-lg border ${
                      t1Harvested
                        ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                        : 'bg-stone-900 border-stone-800 text-stone-400'
                    }`}>
                      <div className="flex items-center justify-center gap-1">
                        {t1Harvested && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                        <span className="font-bold text-[11px]">Step 1 (Sell 33%)</span>
                      </div>
                      <span className="text-xs font-bold block mt-0.5">${trade.harvestTiers?.tier1.targetPrice}</span>
                      <span className="text-[10px] text-stone-500">+{trade.harvestTiers?.tier1.targetPct}% • Locks Zero Risk</span>
                    </div>

                    {/* Tier 2 */}
                    <div className={`p-2 rounded-lg border ${
                      t2Harvested
                        ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                        : 'bg-stone-900 border-stone-800 text-stone-400'
                    }`}>
                      <div className="flex items-center justify-center gap-1">
                        {t2Harvested && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                        <span className="font-bold text-[11px]">Step 2 (Sell 33%)</span>
                      </div>
                      <span className="text-xs font-bold block mt-0.5">${trade.harvestTiers?.tier2.targetPrice}</span>
                      <span className="text-[10px] text-stone-500">+{trade.harvestTiers?.tier2.targetPct}% • Banks Cash</span>
                    </div>

                    {/* Tier 3 */}
                    <div className={`p-2 rounded-lg border ${
                      t3Harvested
                        ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                        : 'bg-stone-900 border-stone-800 text-stone-400'
                    }`}>
                      <div className="flex items-center justify-center gap-1">
                        {t3Harvested && <CheckCircle2 className="w-3 h-3 text-amber-400" />}
                        <span className="font-bold text-[11px]">{t3Harvested ? 'Runner Active' : 'Step 3 (Sell 17%)'}</span>
                      </div>
                      <span className="text-xs font-bold block mt-0.5">${trade.harvestTiers?.tier3.targetPrice}</span>
                      <span className="text-[10px] text-stone-500">+{trade.harvestTiers?.tier3.targetPct}% • Locks T2 + Uncapped Runner</span>
                    </div>
                  </div>
                </div>

                {/* Defense & Zombie Recycle */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-stone-400 pt-1">
                  <div className="flex items-center gap-3">
                    <span title="Automatic exit if price moves against you to protect your money">
                      Safety Stop Loss: <strong className="text-rose-400">${trade.stopLossPrice} (-{trade.stopLossPct}%)</strong>
                    </span>
                    <span title="Highest profit this trade reached while open">
                      Max Profit: <strong className="text-emerald-400">+{trade.mfePct}%</strong>
                    </span>
                    <span title="Deepest pullback this trade experienced">
                      Max Dip: <strong className="text-rose-400">-{trade.maePct}%</strong>
                    </span>
                  </div>

                  {zombie.isStale && (
                    <button
                      onClick={() => onRecycleZombieTrade(trade)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-colors"
                      title={zombie.reason}
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Free Up Stagnant Slot</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {openTrades.length === 0 && (
            <div className="p-8 text-center rounded-2xl bg-stone-900 border border-stone-800 text-stone-400">
              <p className="text-sm">No active trades currently open in the 10-slot treasury.</p>
              <p className="text-xs text-stone-500 mt-1">Go to the Live Signal Scanner tab to deploy a ${bankroll.trancheSizeUSD.toFixed(2)} tranche.</p>
            </div>
          )}
        </div>
      )}

      {/* Closed Trades Log View */}
      {activeSubTab === 'CLOSED' && (
        <div className="space-y-3">
          {closedTrades.map((trade) => {
            const net = netPnlUSD(trade);
            const isProfit = net >= 0;

            return (
              <div
                key={trade.id}
                className="p-3.5 rounded-xl bg-stone-900/70 border border-stone-800 flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs ${
                    isProfit ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                  }`}>
                    {trade.symbol.slice(0, 3)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-stone-200">{trade.coinName}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-400 font-mono">
                        {trade.exitReason || 'CLOSED'}
                      </span>
                    </div>
                    <span className="text-[11px] text-stone-500">
                      Entry: ${trade.entryPrice} • Exit: ${trade.currentPrice}
                    </span>
                  </div>
                </div>

                <div className="text-right">
                  <span className={`font-bold text-sm block ${
                    isProfit ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {isProfit ? '+' : ''}${net.toFixed(2)} ({netReturnPct(trade) >= 0 ? '+' : ''}{netReturnPct(trade).toFixed(2)}%)
                  </span>
                  <span className="text-[10px] text-stone-500">
                    Banked: ${trade.realizedCashBankedUSD?.toFixed(2) || '0.00'}
                  </span>
                </div>
              </div>
            );
          })}

          {closedTrades.length === 0 && (
            <div className="p-8 text-center rounded-2xl bg-stone-900 border border-stone-800 text-stone-400">
              <p className="text-sm">No closed trades in history yet.</p>
            </div>
          )}
        </div>
      )}

      {/* Strategy Performance & Profitability Metrics Center */}
      {activeSubTab === 'METRICS' && (
        <div id="metrics-audit-panel" className="space-y-6">
          
          {/* Data Location & Persistence Card */}
          <div className="p-5 rounded-2xl bg-stone-900/90 border border-amber-500/20 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-stone-800">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
                  <Database className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-stone-100">Trade Metrics & Statistical Storage</h3>
                  <p className="text-xs text-stone-400">
                    Live cloud collection & offline-first synchronized record store
                  </p>
                </div>
              </div>

              {/* Data Export Buttons */}
              <div className="flex items-center gap-2">
                <button
                  id="export-trades-csv-btn"
                  onClick={handleDownloadCSV}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700 transition-colors"
                  title="Export all trades to CSV format for Excel, Python, or Google Sheets"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Export CSV</span>
                </button>

                <button
                  id="export-trades-json-btn"
                  onClick={handleDownloadJSON}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-stone-950 transition-colors shadow-sm"
                  title="Download complete raw JSON data structure"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download JSON</span>
                </button>
              </div>
            </div>

            {/* Storage Keys Info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-stone-950 border border-stone-800 space-y-1">
                <span className="font-semibold text-stone-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                  Cloud Firestore Storage:
                </span>
                <p className="font-mono text-[11px] text-amber-400/90 break-all">
                  /crypto_automated_trades/&#123;tradeId&#125;
                </p>
                <p className="text-[10px] text-stone-500">
                  Database: <code className="text-stone-400">ai-studio-cryptostudylab-776d55ef-45ed-4b12-9094-896c94f15aa1</code>
                </p>
              </div>

              <div className="p-3 rounded-xl bg-stone-950 border border-stone-800 space-y-1">
                <span className="font-semibold text-stone-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                  Client-Side Local Storage:
                </span>
                <p className="font-mono text-[11px] text-amber-400/90 break-all">
                  crypto_automated_trades_store
                </p>
                <p className="text-[10px] text-stone-500">
                  Resilient browser-side cache with automatic real-time sync
                </p>
              </div>
            </div>
          </div>

          {/* Statistical Verification Progress & Readiness Score */}
          <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
                    Quantitative Edge Proofing
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    verification.readinessStatus === 'VALIDATED_READY'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : verification.readinessStatus === 'SAMPLE_IN_PROGRESS'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                  }`}>
                    {verification.readinessStatus}
                  </span>
                </div>
                <h4 className="text-lg font-bold text-stone-100 mt-0.5">
                  Statistical Sample Progress ({verification.sampleSize} / {verification.targetSampleSize} Trades)
                </h4>
              </div>

              <div className="text-right">
                <span className="text-[10px] text-stone-500 uppercase block">Readiness Score</span>
                <span className="text-2xl font-black text-amber-400">{verification.readinessScore}%</span>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2 rounded-full bg-stone-950 overflow-hidden border border-stone-800">
              <div 
                className="h-full bg-gradient-to-r from-amber-500 to-emerald-400 transition-all duration-500"
                style={{ width: `${verification.sampleProgressPct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-stone-400">
              <span>{verification.sampleSize} closed historical trades</span>
              <span>Target: 20 trades for 95% confidence significance</span>
            </div>
          </div>

          {/* 6 Key Profitability & Improvement Levers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            
            {/* 1. Win Rate */}
            <div className="p-4 rounded-xl bg-stone-900 border border-stone-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-400">Win Rate %</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  verification.winRatePassed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                }`}>
                  Target: &gt;{verification.targetWinRatePct}%
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-black text-stone-100">{verification.winRatePct}%</span>
                <span className="text-xs text-stone-400">({verification.winCount}W / {verification.lossCount}L)</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Formula: <code className="text-stone-300">Wins ÷ Total Trades</code>. High win rate combined with 1/3rd harvest tiers prevents large capital drawdowns.
              </p>
            </div>

            {/* 2. Payoff Ratio */}
            <div className="p-4 rounded-xl bg-stone-900 border border-stone-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-400">Payoff Ratio (R:R)</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  verification.payoffPassed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                }`}>
                  Target: &gt;{verification.targetPayoffRatio}:1
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-black text-emerald-400">{formatRatio(verification.payoffRatio)}:1</span>
                <span className="text-xs text-stone-400">(${verification.avgWinUSD} vs ${verification.avgLossUSD})</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Formula: <code className="text-stone-300">Avg Win $ ÷ Avg Loss $</code>. Ensures winners are at least 2x the size of disciplined stop losses.
              </p>
            </div>

            {/* 3. Profit Factor */}
            <div className="p-4 rounded-xl bg-stone-900 border border-stone-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-400">Profit Factor</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  verification.profitFactorPassed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                }`}>
                  Target: &gt;{verification.targetProfitFactor}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-black text-amber-400">{formatRatio(verification.profitFactor)}</span>
                <span className="text-xs text-stone-400">(${verification.grossProfitUSD} / ${verification.grossLossUSD})</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Formula: <code className="text-stone-300">Gross Wins ÷ Gross Losses</code>. Above 1.75 indicates a resilient institutional edge.
              </p>
            </div>

            {/* 4. Mathematical Expectancy */}
            <div className="p-4 rounded-xl bg-stone-900 border border-stone-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-400">Math Expectancy / Trade</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  verification.expectancyPassed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                }`}>
                  Target: &gt;+${verification.targetExpectancyUSD.toFixed(2)}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className={`text-2xl font-black ${
                  verification.expectancyUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}>
                  {verification.expectancyUSD >= 0 ? '+' : ''}${verification.expectancyUSD}
                </span>
                <span className="text-xs text-stone-400">per $10 trade</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Formula: <code className="text-stone-300">(Win% × Win$) - (Loss% × Loss$) - Fees</code>. Positive value mathematically guarantees long-term portfolio growth.
              </p>
            </div>

            {/* 5. Zero-Risk Ratchet Rate */}
            <div className="p-4 rounded-xl bg-stone-900 border border-stone-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-400">Zero-Risk Ratchet Rate</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  verification.ratchetPassed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                }`}>
                  Target: &gt;{verification.targetZeroRiskRatchetRatePct}%
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-black text-emerald-400">{verification.zeroRiskRatchetRatePct}%</span>
                <span className="text-xs text-stone-400">risk-free conversions</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Percentage of trades that hit Tier 1 (+4%) and moved the stop loss to entry ($0 downside risk).
              </p>
            </div>

            {/* 6. Total Fees Deducted */}
            <div className="p-4 rounded-xl bg-stone-900 border border-stone-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-400">Exchange Slippage & Fees</span>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-stone-800 text-stone-300">
                  0.10% Spot Maker/Taker
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-black text-rose-400">-${verification.totalFeesUSD.toFixed(2)}</span>
                <span className="text-xs text-stone-400">USDT deducted</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Calculated on all entries, ladder harvests, and exits. Net PnL accounts for all friction.
              </p>
            </div>
          </div>

          {/* Strategy Improvement Playbook & Actionable Insights */}
          <div className="p-5 rounded-2xl bg-stone-900/90 border border-stone-800 space-y-4">
            <div className="flex items-center gap-2">
              <Lightbulb className="w-5 h-5 text-amber-400" />
              <h4 className="font-bold text-base text-stone-100">How to Use These Metrics to Improve Your Trading</h4>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              
              {/* Insight 1: MFE & Take-Profit Tuning */}
              <div className="p-3.5 rounded-xl bg-stone-950 border border-stone-800 space-y-2">
                <span className="font-bold text-amber-300 block">1. If MFE is High (+6% to +10%) but Realized PnL is Low:</span>
                <p className="text-stone-400 leading-relaxed">
                  Your entry timing was accurate, but trades are giving back profits before hitting Tier 2 (+7%). 
                  <strong> Action:</strong> Lower your Tier 1 target to +3.0% and lock in the Zero-Risk Breakeven Ratchet sooner.
                </p>
              </div>

              {/* Insight 2: MAE & Entry Pullback Tuning */}
              <div className="p-3.5 rounded-xl bg-stone-950 border border-stone-800 space-y-2">
                <span className="font-bold text-amber-300 block">2. If MAE is High (-3% to -4%) on Many Positions:</span>
                <p className="text-stone-400 leading-relaxed">
                  You are entering too early into falling momentum before the bottom forms. 
                  <strong> Action:</strong> In the Live Signal Scanner, filter strictly for setups with Whale CVD &gt; 70% and wait for a 1-hour bullish candle close before pulling the trigger.
                </p>
              </div>

              {/* Insight 3: Win Rate vs Payoff Ratio Balance */}
              <div className="p-3.5 rounded-xl bg-stone-950 border border-stone-800 space-y-2">
                <span className="font-bold text-amber-300 block">3. If Win Rate &lt; 50% but Payoff Ratio &gt; 2.5:1:</span>
                <p className="text-stone-400 leading-relaxed">
                  Your strategy is still mathematically profitable because average wins outweigh losses. Do not panic; allow the 10-slot bankroll diversification to compound across trades.
                </p>
              </div>

              {/* Insight 4: Stagnant Capital / Zombie Trades */}
              <div className="p-3.5 rounded-xl bg-stone-950 border border-stone-800 space-y-2">
                <span className="font-bold text-amber-300 block">4. If Slots Stay Trapped in Flat Chop (&gt;24 Hours):</span>
                <p className="text-stone-400 leading-relaxed">
                  Capital velocity is restricted. Use the <strong>"Recycle Stale Slot"</strong> button in the Active Trades tab to return the tranche capital to the liquid cash treasury to redeploy into high-momentum setups.
                </p>
              </div>
            </div>

            {/* Real-Time System Recommendation */}
            <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-stone-200">
              <span className="font-bold text-amber-400 text-xs block mb-1">
                Active System Recommendation:
              </span>
              <p className="text-xs text-stone-300">
                {verification.recommendation}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
