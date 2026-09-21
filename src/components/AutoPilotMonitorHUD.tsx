import React from 'react';
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
  Lock
} from 'lucide-react';
import { 
  BtcMacroRegime, 
  AutoPilotCandidateRank, 
  MarketActivityRadar,
  RecentLossCircuitBreaker,
  AutoPilotPacingInfo
} from '../services/marketRegimeService';
import { BankrollState, AutomatedTradeRecord } from '../types/automatedFeed';
import { MAJOR_COINS, MAX_MAJOR_COIN_SLOTS, MEME_COINS, MAX_MEME_COIN_SLOTS } from '../types/entryScanner';

interface AutoPilotMonitorHUDProps {
  isAutoPilot: boolean;
  onToggleAutoPilot: () => void;
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
            <div className="flex items-center gap-2">
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
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              Autonomous execution engine evaluating 5 safety checkpoints and dynamic <strong className="text-stone-200">Capital ÷ 10 (${bankroll.trancheSizeUSD.toFixed(2)})</strong> compounding.
            </p>
          </div>
        </div>

        {/* Master Auto-Pilot Toggle Button */}
        <div className="flex items-center gap-3 self-start lg:self-center">
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

      {/* Auto-Pilot Execution & Pacing Diagnostic Strip */}
      {pacingInfo && (
        <div className={`p-3.5 rounded-xl border transition-all ${
          pacingInfo.state === 'LOSS_STREAK_COOLDOWN'
            ? 'bg-rose-950/40 border-rose-800/60 shadow-[0_0_15px_rgba(244,63,94,0.15)]'
            : pacingInfo.state === 'BTC_ARMOR_PAUSE'
            ? 'bg-amber-950/40 border-amber-800/60'
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
                ) : pacingInfo.state === 'BTC_ARMOR_PAUSE' ? (
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
              10-Slot Compounding Capacity
            </span>
            <span className="font-mono text-stone-200 font-bold">{openCount} / {totalSlots} Used</span>
          </div>

          {/* Slot Dots */}
          <div className="grid grid-cols-10 gap-1 pt-1">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                title={i < openCount ? `Slot ${i + 1}: Active Trade` : `Slot ${i + 1}: Free Cash Slot ($${bankroll.trancheSizeUSD.toFixed(2)})`}
                className={`h-2 rounded-sm transition-colors ${
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
            <span title="Quality altcoins have 5+ slots reserved for steady momentum trends">
              Alts: <strong className="text-emerald-400 font-mono">{altTradesCount} (5+ res)</strong>
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
                        <span className="text-[10px] text-stone-400 block">{sig.archetypeName}</span>
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
