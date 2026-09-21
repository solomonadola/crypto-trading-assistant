import React, { useState } from 'react';
import { outcome } from '../services/metrics';
import { 
  X, 
  Clock, 
  AlertTriangle, 
  ShieldAlert, 
  TrendingDown, 
  Activity, 
  Calendar, 
  Zap, 
  CheckCircle2, 
  Lock,
  RotateCcw,
  PlusCircle,
  BarChart3,
  ListFilter,
  Info
} from 'lucide-react';
import { AutomatedTradeRecord } from '../types/automatedFeed';
import { 
  ConsolidationLossAuditReport, 
  ConsolidationLossEpisode,
  clearSavedConsolidationEpisodes,
  recordConsolidationLossEpisode
} from '../services/consolidationLossRecorderService';

interface ConsolidationLossAuditModalProps {
  isOpen: boolean;
  onClose: () => void;
  report: ConsolidationLossAuditReport;
  trades: AutomatedTradeRecord[];
  onRefreshReport: () => void;
}

export const ConsolidationLossAuditModal: React.FC<ConsolidationLossAuditModalProps> = ({
  isOpen,
  onClose,
  report,
  trades,
  onRefreshReport
}) => {
  const [activeTab, setActiveTab] = useState<'episodes' | 'heatmap' | 'recurring'>('episodes');
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleManualRecord = () => {
    const recentLosses = trades.filter(t => t.status !== 'OPEN' && outcome(t) === 'LOSS').slice(0, 3);
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    
    recordConsolidationLossEpisode(
      twoHoursAgo,
      now,
      recentLosses,
      1.4,
      'Recorded during user-identified consolidation chop'
    );
    onRefreshReport();
    setSuccessNotice('Successfully recorded current 2-hour consolidation window into audit log.');
    setTimeout(() => setSuccessNotice(null), 3500);
  };

  const handleClearLogs = () => {
    if (window.confirm('Clear custom recorded consolidation episodes? (Reconstructed trade history will remain available)')) {
      clearSavedConsolidationEpisodes();
      onRefreshReport();
      setSuccessNotice('Cleared custom recorded consolidation episodes.');
      setTimeout(() => setSuccessNotice(null), 3000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div 
        id="consolidation-loss-audit-modal" 
        className="w-full max-w-4xl bg-stone-900 border border-stone-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="p-5 border-b border-stone-800 flex items-center justify-between bg-stone-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-stone-100">
                  Consolidation & Time-of-Day Loss Recorder
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-rose-500/20 text-rose-300 border border-rose-500/30">
                  {report.totalEpisodesRecorded} Episodes Logged
                </span>
              </div>
              <p className="text-xs text-stone-400 mt-0.5">
                Pinpoints exact times of day when consolidation occurred and drawdowns were concentrated.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Action Notice */}
        {successNotice && (
          <div className="mx-5 mt-4 p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successNotice}</span>
          </div>
        )}

        {/* Top Summary Banner: From Time To Time Worst Window */}
        <div className="p-5 border-b border-stone-800/80 bg-stone-900 grid grid-cols-1 sm:grid-cols-3 gap-4">
          
          <div className="p-3.5 rounded-xl bg-rose-950/20 border border-rose-800/50 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-stone-400">
              <span className="uppercase font-semibold text-[10px] text-rose-300">Worst Loss Window</span>
              <Clock className="w-3.5 h-3.5 text-rose-400" />
            </div>
            <div className="text-sm font-black text-stone-100">
              {report.worstWindowUTC}
            </div>
            <div className="text-[11px] text-stone-400">
              Local: <span className="text-stone-300 font-medium">{report.worstWindowLocal}</span>
            </div>
            <div className="text-xs font-mono font-bold text-rose-400 pt-0.5">
              -${report.worstWindowTotalLossUSD.toFixed(2)} Lost ({report.worstWindowLossesCount} stop-outs)
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-amber-950/20 border border-amber-800/50 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-stone-400">
              <span className="uppercase font-semibold text-[10px] text-amber-300">Recurring Trap Windows</span>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="text-lg font-black text-stone-100 font-mono">
              {report.recurringTrapsCount} Recurring Zone{report.recurringTrapsCount === 1 ? '' : 's'}
            </div>
            <p className="text-[11px] text-stone-400 leading-tight">
              {report.recurringTrapsCount > 0 
                ? 'Repeated consolidation drawdowns detected in identical time slots across days.'
                : 'No recurring trap windows identified yet. Single isolated chop events.'}
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-blue-950/20 border border-blue-800/50 space-y-1 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-[11px] text-stone-400">
                <span className="uppercase font-semibold text-[10px] text-blue-300">Action & Mitigation</span>
                <Lock className="w-3.5 h-3.5 text-blue-400" />
              </div>
              <div className="text-xs font-bold text-stone-200 mt-1">
                Strict Consolidation Lock
              </div>
              <p className="text-[10px] text-stone-400 mt-0.5 leading-tight">
                Locks 100% in cash whenever market volatility drops below 2.0% to prevent bleeding.
              </p>
            </div>
            <div className="flex items-center gap-2 pt-2 border-t border-stone-800/60">
              <button
                onClick={handleManualRecord}
                className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold flex items-center gap-1 transition-colors"
                title="Record recent 2-hour window into audit log"
              >
                <PlusCircle className="w-3 h-3" />
                Record Window Now
              </button>
              <button
                onClick={handleClearLogs}
                className="px-2 py-1 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-300 text-[10px] transition-colors ml-auto"
                title="Clear manually recorded episodes"
              >
                Reset
              </button>
            </div>
          </div>

        </div>

        {/* Tab Selection */}
        <div className="px-5 pt-3 border-b border-stone-800 flex items-center gap-2 bg-stone-950/30">
          <button
            onClick={() => setActiveTab('episodes')}
            className={`px-3 py-2 text-xs font-bold border-b-2 flex items-center gap-1.5 transition-colors ${
              activeTab === 'episodes'
                ? 'border-rose-500 text-rose-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <ListFilter className="w-3.5 h-3.5" />
            Consolidation Drawdown Episodes ({report.episodes.length})
          </button>
          <button
            onClick={() => setActiveTab('heatmap')}
            className={`px-3 py-2 text-xs font-bold border-b-2 flex items-center gap-1.5 transition-colors ${
              activeTab === 'heatmap'
                ? 'border-rose-500 text-rose-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            24-Hour Time-of-Day Loss Heatmap
          </button>
          <button
            onClick={() => setActiveTab('recurring')}
            className={`px-3 py-2 text-xs font-bold border-b-2 flex items-center gap-1.5 transition-colors ${
              activeTab === 'recurring'
                ? 'border-rose-500 text-rose-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Recurring Danger Traps ({report.recurringTraps.length})
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          
          {/* TAB 1: Episodes Log */}
          {activeTab === 'episodes' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-stone-400 pb-1">
                <span>Chronological log of exact time windows where consolidation losses occurred:</span>
                <span className="text-[11px] font-mono">{report.episodes.length} recorded events</span>
              </div>

              {report.episodes.length === 0 ? (
                <div className="p-8 text-center rounded-xl bg-stone-950/40 border border-stone-800 text-stone-400 text-xs">
                  No consolidation loss episodes logged yet.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {report.episodes.map((ep) => (
                    <div 
                      key={ep.id}
                      className={`p-4 rounded-xl border transition-all ${
                        ep.isRecurring 
                          ? 'bg-rose-950/25 border-rose-800/60 shadow-[0_0_15px_rgba(244,63,94,0.06)]' 
                          : 'bg-stone-950/60 border-stone-800/80 hover:border-stone-700'
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-stone-800/70">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-bold text-stone-100 text-sm flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-rose-400" />
                            {ep.startTimeUTC} – {ep.endTimeUTC}
                          </span>
                          <span className="text-xs text-stone-400 font-mono">
                            ({ep.dateStr})
                          </span>
                          <span className="text-[11px] text-stone-300 font-sans px-2 py-0.5 rounded bg-stone-800 border border-stone-700">
                            Local: {ep.localTimeRange}
                          </span>
                          {ep.isRecurring && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-rose-500/20 text-rose-300 border border-rose-500/40 flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              Recurring Trap ({ep.recurringFrequency}x)
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold text-rose-400">
                            -${Math.abs(ep.totalLossUSD).toFixed(2)} USD
                          </span>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-stone-800 text-stone-300 font-mono">
                            {ep.lossesCount} stop-out{ep.lossesCount === 1 ? '' : 's'}
                          </span>
                          <span className="text-[10px] text-stone-400">
                            ({ep.durationMinutes}m window)
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2.5 text-xs">
                        <div>
                          <span className="text-stone-400 text-[10px] block uppercase font-semibold">Coins Stopped Out:</span>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            {ep.coinsAffected.map((sym) => (
                              <span key={sym} className="px-1.5 py-0.5 rounded bg-stone-800 text-stone-200 font-mono text-[11px] font-bold border border-stone-700">
                                {sym}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div>
                          <span className="text-stone-400 text-[10px] block uppercase font-semibold">Market Regime:</span>
                          <span className="text-stone-200 text-xs font-medium block mt-1">
                            {ep.marketRegime}
                          </span>
                        </div>

                        <div>
                          <span className="text-stone-400 text-[10px] block uppercase font-semibold">Recommended Action:</span>
                          <span className="text-amber-300 text-[11px] font-medium block mt-1">
                            {ep.recommendedAction}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: 24-Hour Time-of-Day Loss Heatmap */}
          {activeTab === 'heatmap' && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800 text-xs text-stone-300 flex items-start gap-2">
                <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <p>
                  This 24-hour heatmap analyzes all closed trades across every hour of the day (in UTC and local time). Red bars indicate hours where the bot experienced drawdowns during quiet consolidation; green indicates hours with winning breakout momentum.
                </p>
              </div>

              <div className="space-y-1.5">
                {report.hourlyDistribution.map((hourStat) => {
                  const isLossHeavy = hourStat.totalLossUSD > 0.40 || (hourStat.lossCount >= 2 && hourStat.winRatePct <= 40);
                  const isProfitable = hourStat.netPnLUSD > 0;

                  return (
                    <div 
                      key={hourStat.hourUTC}
                      className={`p-2.5 rounded-lg border flex items-center justify-between text-xs transition-colors ${
                        hourStat.isRecurringTrap
                          ? 'bg-rose-950/20 border-rose-800/60'
                          : isLossHeavy
                          ? 'bg-rose-950/10 border-rose-900/40'
                          : isProfitable
                          ? 'bg-emerald-950/10 border-emerald-900/30'
                          : 'bg-stone-950/40 border-stone-800/60'
                      }`}
                    >
                      <div className="flex items-center gap-3 w-48 shrink-0">
                        <span className="font-mono font-bold text-stone-200 text-xs w-28">
                          {String(hourStat.hourUTC).padStart(2, '0')}:00 UTC
                        </span>
                        <span className="text-[10px] text-stone-400 font-mono truncate">
                          {hourStat.hourLabelLocal.split('-')[0].trim()}
                        </span>
                      </div>

                      <div className="flex-1 px-3 hidden md:block">
                        <span className="text-[11px] text-stone-300 truncate block">
                          {hourStat.sessionName}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 text-right">
                        <div className="text-right">
                          <span className="text-[11px] text-stone-400 block font-mono">
                            {hourStat.totalTrades} trade{hourStat.totalTrades === 1 ? '' : 's'} ({hourStat.lossCount} loss)
                          </span>
                        </div>

                        <div className="w-20 text-right">
                          <span className={`font-mono font-bold text-xs ${
                            hourStat.netPnLUSD > 0 
                              ? 'text-emerald-400' 
                              : hourStat.netPnLUSD < 0 
                              ? 'text-rose-400' 
                              : 'text-stone-400'
                          }`}>
                            {hourStat.netPnLUSD > 0 ? '+' : ''}${hourStat.netPnLUSD.toFixed(2)}
                          </span>
                        </div>

                        <div className="w-24 text-right">
                          {hourStat.isRecurringTrap ? (
                            <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 font-bold text-[10px] uppercase border border-rose-500/30">
                              Trap Zone
                            </span>
                          ) : hourStat.totalTrades === 0 ? (
                            <span className="text-stone-400 text-[10px]">No Trades</span>
                          ) : hourStat.winRatePct >= 60 ? (
                            <span className="text-emerald-400 font-mono text-[10px] font-bold">{hourStat.winRatePct}% Win</span>
                          ) : (
                            <span className="text-rose-400 font-mono text-[10px]">{hourStat.lossRatePct}% Loss</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: Recurring Danger Traps */}
          {activeTab === 'recurring' && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-amber-950/20 border border-amber-800/50 text-xs text-amber-200">
                <div className="flex items-center gap-2 font-bold mb-1">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span>Recurring Pattern Defense Rule</span>
                </div>
                <p className="text-stone-300 leading-relaxed text-[11px]">
                  When a specific time window repeatedly triggers consolidation losses across consecutive days, Auto-Pilot can automatically freeze all new trades during that bracket to protect capital.
                </p>
              </div>

              {report.recurringTraps.length === 0 ? (
                <div className="p-8 text-center rounded-xl bg-stone-950/40 border border-stone-800 text-stone-400 text-xs">
                  No recurring multi-day loss traps detected yet. All recorded losses have been isolated events.
                </div>
              ) : (
                <div className="space-y-3">
                  {report.recurringTraps.map((trap, idx) => (
                    <div 
                      key={idx}
                      className="p-4 rounded-xl bg-stone-950/80 border border-rose-800/60 space-y-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-base text-rose-400">
                            {trap.hourBracket}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px] font-black uppercase">
                            Triggered {trap.episodesCount} times
                          </span>
                        </div>
                        <span className="font-mono font-bold text-sm text-rose-400">
                          Total Lost: -${trap.totalLossUSD.toFixed(2)}
                        </span>
                      </div>

                      <p className="text-xs text-stone-300 leading-relaxed">
                        <strong className="text-stone-100">Prescribed Action: </strong>
                        {trap.recommendation}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="p-4 border-t border-stone-800 bg-stone-950/60 flex items-center justify-between text-xs">
          <span className="text-stone-400 text-[11px]">
            Data stored locally in browser storage & synced with closed trades.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 font-bold transition-colors"
          >
            Close Audit
          </button>
        </div>

      </div>
    </div>
  );
};
