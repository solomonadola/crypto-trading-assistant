import React from 'react';
import { formatRatio } from '../services/metrics';
import { 
  Zap, 
  Activity, 
  Layers, 
  BookOpen, 
  Database, 
  TrendingUp, 
  ShieldCheck, 
  RefreshCw, 
  Send, 
  BarChart3, 
  Target,
  Bot,
  History,
  FlaskConical,
} from 'lucide-react';
import { AutomatedTradeRecord, BankrollState } from '../types/automatedFeed';
import { calculateStrategyVerification } from '../services/bankrollService';
import { formatCashUSD } from '../services/orderFlowService';
import { getActiveStrategyProfile } from '../config/geometry';

export type ActiveTab = 'scanner' | 'bankroll' | 'history' | 'metrics' | 'backtest' | 'orderflow' | 'lessons' | 'firebase';

interface HeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  bankroll: BankrollState;
  trades?: AutomatedTradeRecord[];
  isFirebaseLive: boolean;
  onRefreshLiveFeed: () => void;
  isRefreshing: boolean;
  onOpenDeployModal: () => void;
  onOpenMetricsModal?: () => void;
  isAutoPilot?: boolean;
  onToggleAutoPilot?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  bankroll,
  trades = [],
  isFirebaseLive,
  onRefreshLiveFeed,
  isRefreshing,
  onOpenDeployModal,
  onOpenMetricsModal,
  isAutoPilot = false,
  onToggleAutoPilot,
}) => {
  const verification = calculateStrategyVerification(trades);

  return (
    <header id="main-header" className="sticky top-0 z-40 w-full border-b border-stone-800 bg-stone-950/90 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          
          {/* Brand Identity */}
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Zap className="w-5 h-5" />
              <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-stone-100">CryptoStudy Lab</h1>
                <span className="hidden md:inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-stone-800 text-stone-300 border border-stone-700/60">
                  Smart Trading Bot
                </span>
              </div>
              <p className="text-xs text-stone-400 hidden sm:block">
                Paper-trading lab: tests strategies after costs
              </p>
            </div>
          </div>

          {/* Quick Metrics Direct-Click Badge */}
          <button
            id="header-quick-metrics-btn"
            onClick={() => {
              if (onOpenMetricsModal) onOpenMetricsModal();
              else setActiveTab('metrics');
            }}
            title="Win Rate (% of winning trades) and Profit-to-Loss Ratio"
            className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-stone-800 border border-amber-500/40 text-xs transition-all shadow-sm group cursor-pointer"
          >
            <BarChart3 className="w-3.5 h-3.5 text-amber-400 group-hover:scale-110 transition-transform" />
            <span className="font-semibold text-stone-300">Bot Results:</span>
            {verification.sampleSize === 0 ? (
              <span className="text-stone-400">No closed trades yet</span>
            ) : (
              <>
                <span className="font-bold text-emerald-400" title="Share of closed trades that made money after fees">{verification.winRatePct}% Win Rate</span>
                <span className="text-stone-600">·</span>
                <span className="font-bold text-amber-400" title="Payoff ratio: average net win divided by average net loss">{formatRatio(verification.payoffRatio)}:1 Payoff</span>
              </>
            )}
            <span className="text-[10px] text-stone-400 underline decoration-stone-600 underline-offset-2 ml-1">
              View Stats
            </span>
          </button>

          {/* Bankroll Mini Status Banner */}
          <div className="hidden xl:flex items-center gap-3 px-3 py-1.5 rounded-lg bg-stone-900 border border-stone-800 text-xs">
            <div className="flex items-center gap-1.5" title="Total current account balance">
              <span className="text-stone-400 font-medium">Balance:</span>
              <span className="font-semibold text-stone-100">{formatCashUSD(bankroll.totalPortfolioValueUSD)}</span>
            </div>
            <span className="text-stone-700">|</span>
            <div className="flex items-center gap-1" title="Available cash ready to trade">
              <span className="text-stone-400">Cash:</span>
              <span className="font-semibold text-emerald-400">${bankroll.liquidCashUSD.toFixed(2)}</span>
            </div>
            <span className="text-stone-700">|</span>
            <div className="flex items-center gap-1" title={`Open trade slots (${bankroll.totalSlots} high-conviction trades at $${bankroll.trancheSizeUSD.toFixed(0)} each)`}>
              <span className="text-stone-400">Open Slots:</span>
              <span className={`font-semibold ${bankroll.availableSlots > 0 ? 'text-amber-400' : 'text-stone-500'}`}>
                {bankroll.activeTradesCount}/{bankroll.totalSlots}
              </span>
            </div>
          </div>

          {/* Quick Actions & Live Trigger */}
          <div className="flex items-center gap-2">
            {/* Active Strategy Profile Badge */}
            <div 
              title={getActiveStrategyProfile().description}
              className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-semibold cursor-help"
            >
              <Target className="w-3.5 h-3.5 text-amber-400" />
              <span>{getActiveStrategyProfile().shortName}</span>
            </div>

            {onToggleAutoPilot && (
              <button
                id="header-autopilot-btn"
                onClick={onToggleAutoPilot}
                title={isAutoPilot ? 'Auto-Pilot is ON: The bot enters and exits trades automatically for you' : 'Auto-Pilot is OFF: Click to let the bot trade automatically'}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  isAutoPilot
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm'
                    : 'bg-stone-900 text-stone-400 border border-stone-800 hover:text-stone-200'
                }`}
              >
                <Bot className={`w-3.5 h-3.5 ${isAutoPilot ? 'text-emerald-400 animate-pulse' : 'text-stone-400'}`} />
                <span className="hidden sm:inline">Auto-Pilot:</span>
                <span className={isAutoPilot ? 'text-emerald-300' : 'text-stone-400'}>{isAutoPilot ? 'ON' : 'OFF'}</span>
              </button>
            )}

            <button
              id="refresh-live-feed-btn"
              onClick={onRefreshLiveFeed}
              disabled={isRefreshing}
              title="Refresh live prices from Binance"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-stone-900 hover:bg-stone-800 text-stone-300 border border-stone-700/80 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-amber-400' : 'text-stone-400'}`} />
              <span className="hidden sm:inline">{isRefreshing ? 'Checking...' : 'Refresh Prices'}</span>
            </button>

            <button
              id="header-deploy-button"
              onClick={onOpenDeployModal}
              title="Cloud Database Sync Settings"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 hover:bg-amber-400 text-stone-950 shadow-sm transition-all"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Cloud Sync</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation with Simple Plain-English Names */}
        <nav id="navigation-tabs" className="flex space-x-1 border-t border-stone-800/80 py-2 overflow-x-auto no-scrollbar" aria-label="Tabs">
          <button
            id="tab-scanner"
            onClick={() => setActiveTab('scanner')}
            title="Scan Binance coins to find top buy and sell trade setups"
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              activeTab === 'scanner'
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/60'
            }`}
          >
            <Activity className="w-4 h-4" />
            <span>1. Market Scanner</span>
          </button>

          <button
            id="tab-bankroll"
            onClick={() => setActiveTab('bankroll')}
            title="See your active open trades, available money, and closed profit log"
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              activeTab === 'bankroll'
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/60'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>2. My Trades & Money</span>
            {bankroll.activeTradesCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300">
                {bankroll.activeTradesCount} Active
              </span>
            )}
          </button>

          <button
            id="tab-history"
            onClick={() => setActiveTab('history')}
            title="Track completed trades with exit reasons, holding times, and final PnL percentages"
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              activeTab === 'history'
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/60'
            }`}
          >
            <History className="w-4 h-4 text-amber-400" />
            <span>3. Trade History</span>
            {trades.filter(t => t.status !== 'OPEN').length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-stone-800 text-stone-300">
                {trades.filter(t => t.status !== 'OPEN').length} Closed
              </span>
            )}
          </button>

          <button
            id="tab-metrics"
            onClick={() => setActiveTab('metrics')}
            title="Track win rates, profit graphs, and strategy statistics"
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              activeTab === 'metrics'
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/60'
            }`}
          >
            <BarChart3 className="w-4 h-4 text-amber-400" />
            <span className="font-semibold">4. Results & Stats</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300">
              {verification.winRatePct}% Win Rate
            </span>
          </button>

          <button
            id="tab-backtest"
            onClick={() => setActiveTab('backtest')}
            title="Replay the auto-pilot over historical Binance candles"
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              activeTab === 'backtest'
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/60'
            }`}
          >
            <FlaskConical className="w-4 h-4" />
            <span>Backtest Lab</span>
          </button>

          <button
            id="tab-orderflow"
            onClick={() => setActiveTab('orderflow')}
            title="Estimated buy/sell pressure, calculated from 24h price action"
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              activeTab === 'orderflow'
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/60'
            }`}
          >
            <TrendingUp className="w-4 h-4" />
            <span>5. Buyer vs Seller Flow</span>
          </button>

          <button
            id="tab-lessons"
            onClick={() => setActiveTab('lessons')}
            title="Simple explanations of why the bot buys, sells, and protects your money"
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              activeTab === 'lessons'
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/60'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            <span>6. Trading Lessons</span>
          </button>

          <button
            id="tab-firebase"
            onClick={() => setActiveTab('firebase')}
            title="Cloud storage status"
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              activeTab === 'firebase'
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/60'
            }`}
          >
            <Database className="w-4 h-4" />
            <span>Cloud Database</span>
            <span className={`w-2 h-2 rounded-full ${isFirebaseLive ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
          </button>
        </nav>
      </div>
    </header>
  );
};

