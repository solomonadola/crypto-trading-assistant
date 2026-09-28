import React, { useEffect, useState } from 'react';
import { serverApiUrl } from '../services/serverFeed';
import { 
  Bot, 
  ShieldAlert, 
  ShieldCheck, 
  Layers, 
  ArrowUpRight, 
  TrendingUp, 
  TrendingDown, 
  RefreshCw,
  Sparkles,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Lock,
  Target,
  Sliders
} from 'lucide-react';
import { 
  BtcMacroRegime, 
  AutoPilotCandidateRank, 
  MarketActivityRadar,
  RecentLossCircuitBreaker,
  AutoPilotPacingInfo,
  MonthlyRiskBudgetInfo,
  evaluateMonthlyRiskBudget
} from '../services/marketRegimeService';
import { BankrollState, AutomatedTradeRecord } from '../types/automatedFeed';
import { MAJOR_COINS, MAX_MAJOR_COIN_SLOTS, MEME_COINS, MAX_MEME_COIN_SLOTS } from '../types/entryScanner';
import { 
  getActiveStrategyProfile, 
  setActiveStrategyProfile, 
  STRATEGY_PROFILE_EVENT,
  STRATEGY_PROFILES, 
  StrategyProfileId 
} from '../config/geometry';

interface AutoPilotMonitorHUDProps {
  isAutoPilot: boolean;
  onToggleAutoPilot: () => void;
  allowShorts?: boolean;
  onToggleAllowShorts?: () => void;
  bankroll: BankrollState;
  btcRegime: BtcMacroRegime;
  categoryExposure: Record<string, number>;
  topCandidates: AutoPilotCandidateRank[];
  onDeployManualCandidate?: (candidate: AutoPilotCandidateRank) => void;
  activityRadar?: MarketActivityRadar;
  lossCircuitBreaker?: RecentLossCircuitBreaker;
  pacingInfo?: AutoPilotPacingInfo;
  trades?: AutomatedTradeRecord[];
}

export const AutoPilotMonitorHUD: React.FC<AutoPilotMonitorHUDProps> = ({
  isAutoPilot,
  onToggleAutoPilot,
  allowShorts = false,
  onToggleAllowShorts,
  bankroll,
  btcRegime,
  categoryExposure,
  topCandidates,
  onDeployManualCandidate,
  activityRadar,
  lossCircuitBreaker,
  pacingInfo,
  trades = [],
}) => {
  const [strategyProfileId, setStrategyProfileId] = useState<StrategyProfileId>(() => getActiveStrategyProfile().id);
  const activeProfile = STRATEGY_PROFILES[strategyProfileId] || STRATEGY_PROFILES.ASYMMETRIC_SNIPER;

  // The server opens the trades, so the choice is sent there; App.tsx applies
  // the server's profile when it reports one and announces it with this event.
  useEffect(() => {
    const onChange = () => setStrategyProfileId(getActiveStrategyProfile().id);
    window.addEventListener(STRATEGY_PROFILE_EVENT, onChange);
    return () => window.removeEventListener(STRATEGY_PROFILE_EVENT, onChange);
  }, []);

  const handleSelectStrategy = (id: StrategyProfileId) => {
    setActiveStrategyProfile(id);
    setStrategyProfileId(id);
    fetch(serverApiUrl('/api/autopilot/profile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: id }),
    }).catch(() => {});
  };

  const monthlyBudget: MonthlyRiskBudgetInfo = pacingInfo?.monthlyRiskBudget || evaluateMonthlyRiskBudget(
    trades,
    bankroll.totalPortfolioValueUSD,
    activeProfile.monthlyRiskCapPct
  );

  const isBtcDump = btcRegime.status === 'HEAVY_DUMP';
  const openCount = bankroll.activeTradesCount;
  const totalSlots = bankroll.totalSlots;
  const isFull = openCount >= totalSlots;
  const isQuietChop = activityRadar?.activityLevel === 'QUIET_CHOP';
  const isLossTripped = lossCircuitBreaker?.isTripped;

  const openTrades = trades.filter((t) => t.status === 'OPEN');
  const majorTradesCount = openTrades.filter((t) => MAJOR_COINS.has(t.symbol.toUpperCase())).length;
  const memeTradesCount = openTrades.filter((t) => MEME_COINS.has(t.symbol.toUpperCase())).length;
  const altTradesCount = Math.max(0, openCount - majorTradesCount - memeTradesCount);

  return (
    <div id="autopilot-monitor-hud" className="rounded-2xl bg-stone-900/90 border border-stone-800 p-4 sm:p-5 shadow-lg space-y-4">
      
      {/* Top Banner Row */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-stone-800">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl border flex items-center justify-center ${
            isAutoPilot 
              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.15)]' 
              : 'bg-stone-800 border-stone-700 text-stone-400'
          }`}>
            <Bot className={`w-6 h-6 ${isAutoPilot ? 'animate-pulse text-emerald-400' : 'text-stone-500'}`} />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-bold text-stone-100 flex items-center gap-2">
                Auto-Pilot Command & Control
                <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider ${
                  isAutoPilot 
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' 
                    : 'bg-stone-800 text-stone-400 border border-stone-700'
                }`}>
                  {isAutoPilot ? 'ACTIVE AUTOMATION' : 'STANDBY (MANUAL ONLY)'}
                </span>
              </h3>
              <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 font-semibold flex items-center gap-1">
                <Target className="w-3 h-3 text-amber-400" />
                {activeProfile.shortName}
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              Autonomous execution evaluating 5 checkpoints, dynamic <strong className="text-stone-200">Capital ÷ {totalSlots} (${bankroll.trancheSizeUSD.toFixed(2)})</strong> compounding, and -6% risk budget.
            </p>
          </div>
        </div>

        {/* Master Controls: Strategy Selector + Shorts + Auto-Pilot Toggle */}
        <div className="flex flex-wrap items-center gap-2.5 self-start lg:self-center">
          
          {/* Strategy Profile Switcher */}
          <div className="flex items-center p-1 rounded-xl bg-stone-950 border border-stone-800 text-xs">
            <button
              id="hud-strategy-sniper-btn"
              onClick={() => handleSelectStrategy('ASYMMETRIC_SNIPER')}
              title="Asymmetric Sniper: 1.5R (30% derisk) -> 3.0R (40% core) -> 5.0R (30% runner)"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
                strategyProfileId === 'ASYMMETRIC_SNIPER'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                  : 'text-stone-400 hover:text-stone-200'
              }`}
            >
              <Target className="w-3.5 h-3.5 text-amber-400" />
              <span>Sniper (1:3 - 1:5 R)</span>
              <span className="hidden xl:inline text-[9px] px-1 py-0.2 bg-amber-500/30 text-amber-200 rounded font-black uppercase">Rec</span>
            </button>
            <button
              id="hud-strategy-scalp-btn"
              onClick={() => handleSelectStrategy('DYNAMIC_SCALP')}
              title="Dynamic Scalp: 1.0R -> 1.8R -> 2.8R rapid rotations"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
                strategyProfileId === 'DYNAMIC_SCALP'
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40 shadow-sm'
                  : 'text-stone-400 hover:text-stone-200'
              }`}
            >
              <Zap className="w-3.5 h-3.5 text-blue-400" />
              <span>Scalp (1:1.5 R)</span>
            </button>
          </div>

          {onToggleAllowShorts && (
            <button
              id="hud-toggle-shorts-btn"
              onClick={onToggleAllowShorts}
              title={allowShorts ? 'Shorting is ENABLED: The bot deploys into both Longs & Shorts' : 'Shorting is DISABLED: The bot deploys into Longs only'}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
                allowShorts
                  ? 'bg-purple-500/15 border-purple-500/40 text-purple-300 hover:bg-purple-500/25'
                  : 'bg-stone-800/80 border-stone-700 text-stone-400 hover:bg-stone-700 hover:text-stone-300'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${allowShorts ? 'bg-purple-400 animate-pulse' : 'bg-stone-500'}`} />
              <span>{allowShorts ? 'Longs & Shorts' : 'Longs Only'}</span>
            </button>
          )}

          <button
            id="hud-toggle-autopilot-btn"
            onClick={onToggleAutoPilot}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-sm ${
              isAutoPilot
                ? 'bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-black shadow-[0_0_15px_rgba(16,185,129,0.3)]'
                : 'bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700'
            }`}
          >
            <Bot className="w-4 h-4" />
            <span>{isAutoPilot ? 'Turn Auto-Pilot OFF' : 'Activate Autonomous Auto-Pilot'}</span>
          </button>
        </div>
      </div>

      {/* Strategy Blueprint & Monthly Risk Budget Bar */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3.5 rounded-xl bg-stone-950/80 border border-stone-800/80 text-xs">
        
        {/* Left: Active 30/40/30 Asymmetric Harvest Ladder */}
        <div className="space-y-1.5 border-b md:border-b-0 md:border-r border-stone-800 pb-3 md:pb-0 md:pr-3">
          <div className="flex items-center justify-between">
            <span className="font-bold text-stone-200 flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5 text-amber-400" />
              Active Harvest Ladder ({activeProfile.shortName})
            </span>
            <span className="text-[10px] text-stone-400 uppercase font-mono">
              Stop: {activeProfile.stopAtrMultiple}× ATR
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 pt-1 text-[11px]">
            <div className="p-2 rounded-lg bg-stone-900 border border-stone-800 text-center">
              <span className="text-stone-400 block text-[10px] uppercase font-semibold">Tier 1 ({Math.round(activeProfile.tier1HarvestPct * 100)}%)</span>
              <span className="font-bold text-emerald-400">+{activeProfile.tier1RMultiple}R</span>
              <span className="text-[9px] text-stone-500 block">Derisk ➔ BE+0.5%</span>
            </div>
            <div className="p-2 rounded-lg bg-stone-900 border border-stone-800 text-center">
              <span className="text-stone-400 block text-[10px] uppercase font-semibold">Tier 2 ({Math.round(activeProfile.tier2HarvestPct * 100)}%)</span>
              <span className="font-bold text-amber-400">+{activeProfile.tier2RMultiple}R</span>
              <span className="text-[9px] text-stone-500 block">Core Target Banked</span>
            </div>
            <div className="p-2 rounded-lg bg-stone-900 border border-stone-800 text-center">
              <span className="text-stone-400 block text-[10px] uppercase font-semibold">Tier 3 ({Math.round(activeProfile.tier3HarvestPct * 100)}%)</span>
              <span className="font-bold text-purple-400">+{activeProfile.tier3RMultiple}R</span>
              <span className="text-[9px] text-stone-500 block">Trailing Runner</span>
            </div>
          </div>
        </div>

        {/* Right: Monthly Risk Budget Gauge */}
        <div className="space-y-1.5 md:pl-2">
          <div className="flex items-center justify-between">
            <span className="font-bold text-stone-200 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              Monthly Risk Budget ({monthlyBudget.monthName})
            </span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider ${
              monthlyBudget.statusColor === 'rose'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                : monthlyBudget.statusColor === 'emerald'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
            }`}>
              {monthlyBudget.statusBadge}
            </span>
          </div>

          <div className="space-y-1 pt-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-stone-400">
                Month PnL: <strong className={monthlyBudget.currentMonthNetPnLUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  {monthlyBudget.currentMonthNetPnLUSD >= 0 ? '+' : ''}${monthlyBudget.currentMonthNetPnLUSD.toFixed(2)}
                </strong>
              </span>
              <span className="text-stone-400">
                Cap: <strong className="text-stone-200">-${monthlyBudget.maxMonthlyRiskBudgetUSD}</strong> (-{activeProfile.monthlyRiskCapPct}%)
              </span>
            </div>

            {/* Visual Risk Meter */}
            <div className="w-full bg-stone-900 rounded-full h-2 overflow-hidden border border-stone-800">
              <div 
                className={`h-full rounded-full transition-all duration-500 ${
                  monthlyBudget.isExhausted 
                    ? 'bg-rose-500' 
                    : monthlyBudget.budgetUtilizationPct > 60 
                    ? 'bg-amber-500' 
                    : monthlyBudget.currentMonthNetPnLUSD >= 0
                    ? 'bg-emerald-500'
                    : 'bg-blue-500'
                }`}
                style={{ width: `${Math.max(4, Math.min(100, monthlyBudget.currentMonthNetPnLUSD >= 0 ? 100 : 100 - monthlyBudget.budgetUtilizationPct))}%` }}
              />
            </div>
            
            <p className="text-[10px] text-stone-500">
              {monthlyBudget.isExhausted 
                ? '⚠️ Monthly -6% loss cap reached. Capital Preservation Lock is active.' 
                : `$${monthlyBudget.remainingRiskBudgetUSD} risk budget remains before automatic capital defense lock.`}
            </p>
          </div>
        </div>
      </div>

      {/* Auto-Pilot Execution & Pacing Diagnostic Strip */}
      {pacingInfo && (
        <div className={`p-3.5 rounded-xl border transition-all ${
          pacingInfo.state === 'LOSS_STREAK_COOLDOWN'
            ? 'bg-rose-950/40 border-rose-800/60 shadow-[0_0_15px_rgba(244,63,94,0.15)]'
            : pacingInfo.state === 'DEAD_ZONE_PAUSE'
            ? 'bg-amber-950/40 border-amber-800/60 text-amber-200'
            : pacingInfo.state === 'BTC_ARMOR_PAUSE'
            ? 'bg-amber-950/40 border-amber-800/60'
            : pacingInfo.state === 'BTC_PULLBACK_CAUTION'
            ? 'bg-amber-950/30 border-amber-800/50'
            : pacingInfo.state === 'SLOTS_FULL'
            ? 'bg-amber-950/30 border-amber-800/50'
            : pacingInfo.state === 'QUIET_CHOP_PATIENT'
            ? 'bg-blue-950/30 border-blue-800/50'
            : 'bg-stone-950/60 border-stone-800'
        }`}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-start gap-2.5">
              <div className="pt-0.5">
                {pacingInfo.state === 'LOSS_STREAK_COOLDOWN' ? (
                  <ShieldAlert className="w-5 h-5 text-rose-400 animate-pulse" />
                ) : pacingInfo.state === 'DEAD_ZONE_PAUSE' ? (
                  <Clock className="w-5 h-5 text-amber-400" />
                ) : pacingInfo.state === 'BTC_ARMOR_PAUSE' || pacingInfo.state === 'BTC_PULLBACK_CAUTION' ? (
                  <ShieldAlert className="w-5 h-5 text-amber-400" />
                ) : pacingInfo.state === 'QUIET_CHOP_PATIENT' ? (
                  <ShieldCheck className="w-5 h-5 text-blue-400" />
                ) : (
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                )}
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-stone-100 text-sm">{pacingInfo.headline}</span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider ${
                    pacingInfo.badgeColor === 'red'
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                      : pacingInfo.badgeColor === 'rose'
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                      : pacingInfo.badgeColor === 'amber'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : pacingInfo.badgeColor === 'blue'
                      ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  }`}>
                    {pacingInfo.badge}
                  </span>
                </div>
                <p className="text-stone-300 text-xs leading-relaxed max-w-3xl">
                  {pacingInfo.explanation}
                </p>
              </div>
            </div>

            {/* 2-Hour Window Health Metric */}
            {lossCircuitBreaker && (
              <div className="flex items-center gap-2 self-end sm:self-center px-3 py-1.5 rounded-lg bg-stone-900 border border-stone-800 text-[11px] whitespace-nowrap">
                <span className="text-stone-400">Recent 2H Losses:</span>
                <span className={`font-mono font-bold ${
                  lossCircuitBreaker.recentLossesCount >= 2
                    ? 'text-rose-400'
                    : lossCircuitBreaker.recentLossesCount === 1
                    ? 'text-amber-400'
                    : 'text-emerald-400'
                }`}>
                  {lossCircuitBreaker.recentLossesCount} stop-out{lossCircuitBreaker.recentLossesCount === 1 ? '' : 's'}
                  {lossCircuitBreaker.recentLossUSD > 0 ? ` (-$${lossCircuitBreaker.recentLossUSD.toFixed(2)})` : ''}
                </span>
                {lossCircuitBreaker.isTripped && (
                  <span className="text-[10px] text-rose-400 font-bold ml-1 animate-pulse">
                    [COOLDOWN]
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3 Core Status Blocks: Slot Capacity, BTC Macro Guard, Sector Diversification */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        
        {/* 1. Slot Allocation Card */}
        <div className="p-3.5 rounded-xl bg-stone-950/70 border border-stone-800/90 space-y-2">
          <div className="flex items-center justify-between text-stone-400">
            <span className="font-semibold text-stone-300 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-amber-400" />
              {totalSlots}-Slot High Conviction Capacity
            </span>
            <span className="font-mono text-stone-200 font-bold">{openCount} / {totalSlots} Used</span>
          </div>

          {/* Slot Dots */}
          <div className={`grid gap-1.5 pt-1 ${totalSlots <= 5 ? 'grid-cols-5' : 'grid-cols-10'}`}>
            {Array.from({ length: totalSlots }).map((_, i) => (
              <div
                key={i}
                title={i < openCount ? `Slot ${i + 1}: Active Trade` : `Slot ${i + 1}: Free Cash Slot ($${bankroll.trancheSizeUSD.toFixed(2)})`}
                className={`h-2.5 rounded-sm transition-colors ${
                  i < openCount 
                    ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]' 
                    : 'bg-stone-800 border border-stone-700/60'
                }`}
              />
            ))}
          </div>

          <div className="flex items-center justify-between text-[11px] pt-1 text-stone-400">
            <span>Per Trade: <strong className="text-stone-200">${bankroll.trancheSizeUSD.toFixed(2)}</strong></span>
            <span>Available: <strong className={isFull ? 'text-amber-400' : 'text-emerald-400'}>{bankroll.availableSlots} Free</strong></span>
          </div>

          <div className="grid grid-cols-3 gap-1 text-[10px] pt-1 border-t border-stone-800/80 text-stone-400">
            <span title="Major coins (BTC, ETH, BNB, SOL) are limited to 3 concurrent slots">
              Majors: <strong className="text-purple-300 font-mono">{majorTradesCount}/{MAX_MAJOR_COIN_SLOTS}</strong>
            </span>
            <span title="Meme coins (DOGE, PEPE, WIF, BONK, etc.) are capped at 2 slots to prevent sector flush">
              Memes: <strong className="text-amber-300 font-mono">{memeTradesCount}/{MAX_MEME_COIN_SLOTS}</strong>
            </span>
            <span title="Quality altcoins can occupy remaining slots for strong momentum moves">
              Alts: <strong className="text-emerald-400 font-mono">{altTradesCount} active</strong>
            </span>
          </div>
        </div>

        {/* 2. BTC Macro Health Gate */}
        <div className={`p-3.5 rounded-xl border space-y-2 ${
          isBtcDump
            ? 'bg-rose-950/30 border-rose-500/40 text-rose-300'
            : 'bg-stone-950/70 border-stone-800/90 text-stone-300'
        }`}>
          <div className="flex items-center justify-between">
            <span className="font-semibold flex items-center gap-1.5">
              {isBtcDump ? (
                <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              )}
              BTC Flash-Crash Armor
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
              btcRegime.safetyRating === 'SAFE_FOR_LONGS'
                ? 'bg-emerald-500/20 text-emerald-300'
                : btcRegime.safetyRating === 'CAUTION_REDUCED_RISK'
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-rose-500/20 text-rose-300'
            }`}>
              {btcRegime.safetyRating.replace(/_/g, ' ')}
            </span>
          </div>

          <p className="text-[11px] text-stone-400 leading-relaxed">
            {btcRegime.rationale}
          </p>

          <div className="flex items-center justify-between text-[11px] pt-0.5 text-stone-500">
            <span>BTC: ${btcRegime.btcPrice.toLocaleString()} ({btcRegime.btc24hChangePct >= 0 ? '+' : ''}{btcRegime.btc24hChangePct.toFixed(1)}%)</span>
            <span>Long Protection: <strong className={btcRegime.allowNewLongs ? 'text-emerald-400' : 'text-rose-400'}>{btcRegime.allowNewLongs ? 'UNLOCKED' : 'PAUSED'}</strong></span>
          </div>
        </div>

        {/* 3. Sector Balance Guard */}
        <div className="p-3.5 rounded-xl bg-stone-950/70 border border-stone-800/90 space-y-2">
          <div className="flex items-center justify-between text-stone-400">
            <span className="font-semibold text-stone-300 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-indigo-400" />
              Sector Diversification Guard
            </span>
            <span className="text-[10px] text-stone-400">Max 3 per sector</span>
          </div>

          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {Object.keys(categoryExposure).length === 0 ? (
              <span className="text-[11px] text-stone-500">No active positions yet. Balanced.</span>
            ) : (
              Object.entries(categoryExposure).map(([cat, count]) => (
                <span 
                  key={cat}
                  className={`px-2 py-0.5 rounded-md text-[10px] font-medium border ${
                    count >= 3 
                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-300' 
                      : 'bg-stone-800 border-stone-700 text-stone-300'
                  }`}
                >
                  {cat}: {count}/3 {count >= 3 && '(Capped)'}
                </span>
              ))
            )}
          </div>

          <p className="text-[10px] text-stone-500 pt-0.5">
            Prevents over-exposure to single correlated categories (e.g. Meme or L1).
          </p>
        </div>

      </div>

      {/* Global Liquidity Session Clock & Market Activity Radar */}
      {activityRadar && (
        <div className="space-y-2.5">
          {/* Liquidity Session & Activity Strip */}
          <div className="p-3 rounded-xl bg-stone-950/80 border border-stone-800 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
            <div className="flex items-start sm:items-center gap-2.5 flex-wrap">
              <span className={`px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider whitespace-nowrap flex items-center gap-1.5 ${
                activityRadar.liquiditySession.zone === 'HIGH_POWER'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : activityRadar.liquiditySession.zone === 'WEEKEND_CHOP'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : activityRadar.liquiditySession.zone === 'DEAD_ZONE'
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                  : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
              }`}>
                <Clock className="w-3 h-3" />
                {activityRadar.liquiditySession.badgeLabel}
              </span>
              <div className="text-stone-300 text-[11px] leading-tight">
                <span className="font-semibold text-stone-100">{activityRadar.liquiditySession.sessionName}</span>
                <span className="text-stone-300 font-mono text-[10px] ml-1.5 bg-stone-800/90 px-1.5 py-0.5 rounded border border-stone-700/60">
                  {activityRadar.liquiditySession.utcTimeStr}
                </span>
                <span className="text-stone-400 block sm:inline sm:ml-2">{activityRadar.liquiditySession.description}</span>
              </div>
            </div>

            <div className="flex items-center gap-3 text-[10px] text-stone-400 self-end md:self-auto border-t md:border-t-0 pt-1.5 md:pt-0 border-stone-800 whitespace-nowrap">
              <span title="Dynamic Multi-Tier Selling + 1.8% Trailing Accelerations on >20% spikes" className="flex items-center gap-1 text-amber-300 font-medium">
                ⚡ Pump Capture
              </span>
              <span title="Capital ÷ 10 isolation ensures a 40% coin gap only hits total portfolio by ~4%" className="flex items-center gap-1 text-emerald-400 font-medium">
                🛡️ Slippage Firewalled
              </span>
              {activityRadar.isConsolidationLocked && (
                <span title="Market Volatility < 2.0% - 100% Cash Defense Active" className="flex items-center gap-1 text-blue-300 font-bold bg-blue-950/80 px-2 py-0.5 rounded border border-blue-800/50">
                  <Lock className="w-3 h-3 text-blue-400" />
                  100% Cash Defense
                </span>
              )}
            </div>
          </div>

          {/* Strict Consolidation Lock Active Banner */}
          {activityRadar.isConsolidationLocked && (
            <div className="p-3.5 rounded-xl bg-blue-950/30 border border-blue-800/60 shadow-[0_0_15px_rgba(59,130,246,0.08)] flex items-start gap-2.5 text-xs">
              <Lock className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-blue-200">Strict Consolidation Lock Active</span>
                  <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 text-[10px] font-mono border border-blue-500/30 font-bold">
                    Market Vol: ±{activityRadar.avgVolatilityPct}% (Threshold: &lt;2.0%)
                  </span>
                  <span className="text-stone-400 text-[10px]">
                    Active Moving Pairs: {activityRadar.activePairsCount}/18
                  </span>
                </div>
                <p className="text-stone-300 text-[11px] leading-relaxed">
                  Binance tracked pairs are in low-volatility sideways compression. Breakout follow-through is statistically absent, leading to chop stop-outs. Auto-Pilot is locked 100% in cash to eliminate bleed until volatility expands above 2.0%.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Auto-Pilot Priority Queue (Next-in-Line Candidates) */}
      <div className="pt-2">
        <div className="flex items-center justify-between text-xs text-stone-400 mb-2">
          <span className="font-bold text-stone-200 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            Auto-Pilot Signal Priority Queue (Top Ranked Setups Ready to Deploy)
          </span>
          <span className="text-[11px] text-stone-400">
            Ranked by Mathematical Conviction & Risk-Reward Ratio
          </span>
        </div>

        {topCandidates.length === 0 ? (
          <div className="p-3 rounded-xl bg-stone-950/40 border border-stone-800/60 text-center text-xs text-stone-500">
            Scanning market... No setups currently satisfy all 5 checkpoints (Score ≥ 80). Auto-Pilot is patiently standing by.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {topCandidates.slice(0, 3).map((item, idx) => {
              const sig = item.signal;
              return (
                <div
                  key={sig.id}
                  className={`p-3 rounded-xl border transition-all flex flex-col justify-between gap-2 ${
                    idx === 0 
                      ? 'bg-stone-950/90 border-amber-500/50 shadow-[0_0_12px_rgba(245,158,11,0.08)]' 
                      : 'bg-stone-950/60 border-stone-800'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black ${
                        idx === 0 ? 'bg-amber-500 text-stone-950' : 'bg-stone-800 text-stone-300'
                      }`}>
                        #{item.rank}
                      </span>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-sm text-stone-100">{sig.symbol}</span>
                          <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                            sig.direction === 'SHORT' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
                          }`}>
                            {sig.direction}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                          <span className="text-[10px] text-stone-400">{sig.archetypeName}</span>
                          {sig.inducement?.status === 'IDM_SWEPT' ? (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center gap-0.5" title={sig.inducement.summary}>
                              <Sparkles className="w-2.5 h-2.5 text-purple-400" />
                              IDM Swept
                            </span>
                          ) : sig.inducement?.status === 'IDM_ACTIVE_TRAP' ? (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30" title={sig.inducement.summary}>
                              IDM Trap
                            </span>
                          ) : sig.inducement?.status === 'DIRECT_STRUCTURAL_TOUCH' ? (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/30" title={sig.inducement.summary}>
                              Major Level
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <span className="text-xs font-black text-amber-400 block">
                        {sig.score}/100
                      </span>
                      <span className="text-[9px] text-stone-500">
                        R:R {sig.tradePlan?.rewardRiskRatio?.toFixed(1) || '2.5'}:1
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] pt-2 border-t border-stone-800/80 text-stone-400">
                    <span className="text-[10px] text-stone-500">
                      Entry: ${sig.currentPrice < 1 ? sig.currentPrice.toFixed(4) : sig.currentPrice.toFixed(2)}
                    </span>
                    {onDeployManualCandidate && (
                      <button
                        onClick={() => onDeployManualCandidate(item)}
                        disabled={isFull}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                          isFull 
                            ? 'bg-stone-800 text-stone-500 cursor-not-allowed'
                            : 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40'
                        }`}
                      >
                        {isFull ? 'Slots Full' : `Deploy up to $${bankroll.trancheSizeUSD.toFixed(2)}`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
};
