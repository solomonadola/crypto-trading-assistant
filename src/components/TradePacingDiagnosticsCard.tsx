import React, { useState, useMemo, useCallback } from 'react';
import { 
  Clock, 
  Lock, 
  ShieldAlert, 
  ShieldCheck, 
  CheckCircle2, 
  Layers, 
  AlertTriangle, 
  Activity,
  Zap,
  Info,
  Calendar,
  BarChart2,
  ExternalLink
} from 'lucide-react';
import { BankrollState, AutomatedTradeRecord } from '../types/automatedFeed';
import { 
  MarketActivityRadar, 
  RecentLossCircuitBreaker, 
  AutoPilotPacingInfo 
} from '../services/marketRegimeService';
import { 
  analyzeConsolidationLosses, 
  ConsolidationLossAuditReport 
} from '../services/consolidationLossRecorderService';
import { ConsolidationLossAuditModal } from './ConsolidationLossAuditModal';

interface TradePacingDiagnosticsCardProps {
  pacingInfo?: AutoPilotPacingInfo;
  activityRadar?: MarketActivityRadar;
  lossCircuitBreaker?: RecentLossCircuitBreaker;
  bankroll?: BankrollState;
  trades?: AutomatedTradeRecord[];
}

export const TradePacingDiagnosticsCard: React.FC<TradePacingDiagnosticsCardProps> = ({
  pacingInfo,
  activityRadar,
  lossCircuitBreaker,
  bankroll,
  trades = []
}) => {
  const [isAuditModalOpen, setIsAuditModalOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const lossAuditReport = useMemo<ConsolidationLossAuditReport>(() => {
    return analyzeConsolidationLosses(trades);
  }, [trades, refreshTrigger]);

  const handleRefreshReport = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  if (!pacingInfo && !activityRadar && !lossCircuitBreaker) {
    return null;
  }

  const isConsolidationLocked = activityRadar?.isConsolidationLocked ?? false;
  const isLossTripped = lossCircuitBreaker?.isTripped ?? false;
  const activeSlots = bankroll?.activeTradesCount ?? 0;
  const totalSlots = bankroll?.totalSlots ?? 10;
  const isFull = activeSlots >= totalSlots;

  return (
    <div 
      id="trade-pacing-diagnostics-card" 
      className="p-5 rounded-2xl bg-stone-900 border border-stone-800 shadow-md space-y-4"
    >
      {/* Header & Main Status Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-stone-800/80">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <Activity className="w-4 h-4" />
            </span>
            <h3 className="text-base font-bold text-stone-100">
              Trade Activity & Market Regime Diagnostics
            </h3>
          </div>
          <p className="text-xs text-stone-400 mt-0.5">
            Real-time multi-gate audit: Explains exactly why Auto-Pilot is executing or defensively sitting in 100% cash.
          </p>
        </div>

        {pacingInfo && (
          <div className="flex items-center gap-2">
            <span className={`px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wider ${
              pacingInfo.badgeColor === 'red' || pacingInfo.badgeColor === 'rose'
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
        )}
      </div>

      {/* Primary Pacing Explanation Callout */}
      {pacingInfo && (
        <div className={`p-4 rounded-xl border transition-all ${
          pacingInfo.state === 'LOSS_STREAK_COOLDOWN'
            ? 'bg-rose-950/30 border-rose-800/60 text-rose-200 shadow-[0_0_15px_rgba(244,63,94,0.1)]'
            : pacingInfo.state === 'CONSOLIDATION_LOCK'
            ? 'bg-blue-950/30 border-blue-800/60 text-blue-200 shadow-[0_0_15px_rgba(59,130,246,0.1)]'
            : pacingInfo.state === 'SLOTS_FULL'
            ? 'bg-amber-950/25 border-amber-800/50 text-amber-200'
            : pacingInfo.state === 'BTC_ARMOR_PAUSE'
            ? 'bg-rose-950/25 border-rose-800/50 text-rose-200'
            : 'bg-stone-950/70 border-stone-800 text-stone-200'
        }`}>
          <div className="flex items-start gap-3">
            <div className="mt-0.5">
              {pacingInfo.state === 'LOSS_STREAK_COOLDOWN' ? (
                <ShieldAlert className="w-5 h-5 text-rose-400 animate-pulse" />
              ) : pacingInfo.state === 'CONSOLIDATION_LOCK' ? (
                <Lock className="w-5 h-5 text-blue-400" />
              ) : pacingInfo.state === 'SLOTS_FULL' ? (
                <Layers className="w-5 h-5 text-amber-400" />
              ) : pacingInfo.state === 'BTC_ARMOR_PAUSE' ? (
                <AlertTriangle className="w-5 h-5 text-rose-400" />
              ) : (
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-stone-100">{pacingInfo.headline}</span>
              </div>
              <p className="text-xs leading-relaxed text-stone-300">
                {pacingInfo.explanation}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* The 5 Safety & Pacing Gates Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-1">
        
        {/* Gate 1: Market Volatility (<2.0% Consolidation Lock) */}
        <div className={`p-3.5 rounded-xl border flex flex-col justify-between ${
          isConsolidationLocked 
            ? 'bg-blue-950/20 border-blue-800/60' 
            : 'bg-stone-950/80 border-stone-800/80'
        }`}>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-stone-400 uppercase font-semibold text-[10px]">1. Volatility Gate</span>
              <span className={`px-1.5 py-0.2 rounded text-[9px] font-black uppercase ${
                isConsolidationLocked ? 'bg-blue-500/20 text-blue-300' : 'bg-emerald-500/20 text-emerald-400'
              }`}>
                {isConsolidationLocked ? 'LOCKED' : 'PASS'}
              </span>
            </div>
            <div className="text-base font-black text-stone-100 font-mono">
              ±{activityRadar?.avgVolatilityPct ?? '0.0'}%
            </div>
            <div className="text-[10px] text-stone-400 leading-tight">
              Threshold: &ge; 2.0% required. Below 2.0% signals dead sideways chop.
            </div>
          </div>
          <div className="mt-2 pt-2 border-t border-stone-800/60 text-[10px] text-stone-400 font-medium">
            Active Pairs: {activityRadar?.activePairsCount ?? 0}/18
          </div>
        </div>

        {/* Gate 2: 2-Hour Loss Streak Dampener */}
        <div className={`p-3.5 rounded-xl border flex flex-col justify-between ${
          isLossTripped 
            ? 'bg-rose-950/25 border-rose-800/60' 
            : 'bg-stone-950/80 border-stone-800/80'
        }`}>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-stone-400 uppercase font-semibold text-[10px]">2. Chop Dampener</span>
              <span className={`px-1.5 py-0.2 rounded text-[9px] font-black uppercase ${
                isLossTripped ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-400'
              }`}>
                {isLossTripped ? 'TRIPPED' : 'CLEAR'}
              </span>
            </div>
            <div className="text-base font-black text-stone-100 font-mono">
              {lossCircuitBreaker?.recentLossesCount ?? 0} Losses
            </div>
            <div className="text-[10px] text-stone-400 leading-tight">
              {isLossTripped 
                ? `Paused for ${lossCircuitBreaker?.minutesRemaining ?? 0}m cooldown (-$${lossCircuitBreaker?.recentLossUSD ?? 0})`
                : 'Triggers 60m freeze if 2 stop-outs occur within 2 hours.'}
            </div>
          </div>
          <div className="mt-2 pt-2 border-t border-stone-800/60 text-[10px] text-stone-400 font-medium">
            Recent 2h Loss: -${(lossCircuitBreaker?.recentLossUSD ?? 0).toFixed(2)}
          </div>
        </div>

        {/* Gate 3: Tranche Capacity */}
        <div className={`p-3.5 rounded-xl border flex flex-col justify-between ${
          isFull 
            ? 'bg-amber-950/20 border-amber-800/60' 
            : 'bg-stone-950/80 border-stone-800/80'
        }`}>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-stone-400 uppercase font-semibold text-[10px]">3. Slot Capacity</span>
              <span className={`px-1.5 py-0.2 rounded text-[9px] font-black uppercase ${
                isFull ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-400'
              }`}>
                {isFull ? 'FULL' : 'OPEN'}
              </span>
            </div>
            <div className="text-base font-black text-stone-100 font-mono">
              {activeSlots} / {totalSlots}
            </div>
            <div className="text-[10px] text-stone-400 leading-tight">
              {isFull 
                ? 'All 10 slots active. Will open slots as targets harvest or exit.'
                : `${totalSlots - activeSlots} slot${totalSlots - activeSlots === 1 ? '' : 's'} available for new qualified setups.`}
            </div>
          </div>
          <div className="mt-2 pt-2 border-t border-stone-800/60 text-[10px] text-stone-400 font-medium">
            Liquid Cash: ${(bankroll?.liquidCashUSD ?? 0).toFixed(2)}
          </div>
        </div>

        {/* Gate 4: Global Liquidity Session */}
        <div className="p-3.5 rounded-xl bg-stone-950/80 border border-stone-800/80 flex flex-col justify-between sm:col-span-2 lg:col-span-2">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-1.5 text-stone-400 uppercase font-semibold text-[10px]">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span>4. Global Liquidity Session</span>
              </div>
              <span className={`px-1.5 py-0.2 rounded text-[9px] font-black uppercase ${
                activityRadar?.liquiditySession.zone === 'HIGH_POWER'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : activityRadar?.liquiditySession.zone === 'WEEKEND_CHOP'
                  ? 'bg-amber-500/20 text-amber-300'
                  : activityRadar?.liquiditySession.zone === 'DEAD_ZONE'
                  ? 'bg-rose-500/20 text-rose-300'
                  : 'bg-blue-500/20 text-blue-300'
              }`}>
                {activityRadar?.liquiditySession.badgeLabel ?? 'Normal'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-stone-100">
                {activityRadar?.liquiditySession.sessionName ?? 'Global Active Session'}
              </span>
              <span className="font-mono text-xs font-bold text-amber-400 bg-stone-900 px-1.5 py-0.5 rounded border border-stone-800">
                {activityRadar?.liquiditySession.utcTimeStr ?? '00:00 UTC'}
              </span>
            </div>

            <p className="text-[11px] text-stone-400 leading-relaxed">
              {activityRadar?.liquiditySession.description ?? 'Tracks worldwide institutional liquidity hours.'}
            </p>
          </div>

          <div className="mt-2 pt-2 border-t border-stone-800/60 flex items-center justify-between text-[10px] text-stone-400">
            <span>High-Volume Hours: 07:00 – 21:00 UTC</span>
            <span>Dead Gap: 21:00 – 00:00 UTC</span>
          </div>
        </div>

      </div>

      {/* Feature Section: Time-of-Day Consolidation Loss Record Mechanism */}
      <div 
        id="consolidation-loss-recorder-strip" 
        className="pt-2 border-t border-stone-800/80 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-stone-950/40 p-3.5 rounded-xl border border-stone-800/60"
      >
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20 shrink-0 mt-0.5">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-stone-100 uppercase tracking-wide">
                Consolidation Loss Recorder & Time-of-Day Audit
              </span>
              <span className="px-2 py-0.2 rounded text-[10px] font-bold uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30">
                {lossAuditReport.totalEpisodesRecorded} Episodes Logged
              </span>
              {lossAuditReport.recurringTrapsCount > 0 && (
                <span className="px-2 py-0.2 rounded text-[10px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {lossAuditReport.recurringTrapsCount} Recurring Trap{lossAuditReport.recurringTrapsCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <p className="text-[11px] text-stone-300">
              Worst Drawdown Window: <strong className="text-rose-400 font-mono">{lossAuditReport.worstWindowUTC}</strong> (Local: {lossAuditReport.worstWindowLocal}) &mdash;{' '}
              <span className="text-stone-400">
                -${lossAuditReport.worstWindowTotalLossUSD.toFixed(2)} lost across {lossAuditReport.worstWindowLossesCount} stop-outs during quiet chop.
              </span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start md:self-center shrink-0">
          <button
            onClick={() => setIsAuditModalOpen(true)}
            className="px-3 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-bold flex items-center gap-1.5 transition-colors border border-stone-700 hover:border-stone-600 shadow-sm"
          >
            <BarChart2 className="w-3.5 h-3.5 text-rose-400" />
            <span>Audit From/To Times & 24h Heatmap</span>
            <ExternalLink className="w-3 h-3 text-stone-400" />
          </button>
        </div>
      </div>

      {/* Full Detailed Audit Modal */}
      <ConsolidationLossAuditModal
        isOpen={isAuditModalOpen}
        onClose={() => setIsAuditModalOpen(false)}
        report={lossAuditReport}
        trades={trades}
        onRefreshReport={handleRefreshReport}
      />
    </div>
  );
};
