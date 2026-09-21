import React from 'react';
import { 
  X, 
  ShieldAlert, 
  CheckCircle2, 
  AlertCircle, 
  Zap, 
  TrendingUp, 
  TrendingDown, 
  Lock, 
  Layers, 
  ChevronRight,
  ArrowRight,
  Clock
} from 'lucide-react';
import { EntrySignalResult } from '../types/entryScanner';
import { formatCashUSD, formatOrderFlowUSD } from '../services/orderFlowService';

interface SignalDetailModalProps {
  signal: EntrySignalResult | null;
  onClose: () => void;
  onDeploy: (signal: EntrySignalResult) => void;
  canDeploy: boolean;
  deployBlockReason?: string;
  isAlreadyOpen?: boolean;
  cooldownMinutesRemaining?: number;
  isMajorCapped?: boolean;
  isMemeCapped?: boolean;
}

export const SignalDetailModal: React.FC<SignalDetailModalProps> = ({
  signal,
  onClose,
  onDeploy,
  canDeploy,
  deployBlockReason,
  isAlreadyOpen = false,
  cooldownMinutesRemaining,
  isMajorCapped = false,
  isMemeCapped = false,
}) => {
  if (!signal) return null;

  const plan = signal.tradePlan;
  const isShort = signal.direction === 'SHORT';
  const mtf = signal.timeframeConfluence;

  return (
    <div id="signal-detail-modal-backdrop" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div 
        id="signal-detail-modal-container"
        className="relative w-full max-w-3xl rounded-2xl bg-stone-900 border border-stone-800 shadow-2xl p-6 text-stone-100 my-8 max-h-[90vh] overflow-y-auto"
      >
        {/* Header Bar */}
        <div className="flex items-start justify-between pb-4 border-b border-stone-800">
          <div className="flex items-center gap-3">
            {signal.image ? (
              <img src={signal.image} alt={signal.symbol} className="w-10 h-10 rounded-full" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-stone-800 flex items-center justify-center font-bold text-stone-300">
                {signal.symbol.slice(0, 2)}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-xl font-bold">{signal.coinName} ({signal.symbol})</h3>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                  isShort ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                }`}>
                  {signal.direction}
                </span>
                <span className="px-2 py-0.5 rounded text-xs font-semibold bg-stone-800 text-amber-400 border border-stone-700">
                  {signal.setupQuality} Rating • {signal.score}/100 Score
                </span>
                {cooldownMinutesRemaining !== undefined && cooldownMinutesRemaining > 0 && (
                  <span className="px-2 py-0.5 rounded text-xs font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 flex items-center gap-1">
                    <Clock className="w-3 h-3 animate-pulse" />
                    Cooldown ({cooldownMinutesRemaining}m left)
                  </span>
                )}
                {isMajorCapped && (
                  <span className="px-2 py-0.5 rounded text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40 flex items-center gap-1">
                    <Lock className="w-3 h-3" />
                    Majors Capped (3/3)
                  </span>
                )}
                {isMemeCapped && (
                  <span className="px-2 py-0.5 rounded text-xs font-bold bg-pink-500/20 text-pink-300 border border-pink-500/40 flex items-center gap-1">
                    <Lock className="w-3 h-3" />
                    Memes Capped (2/2)
                  </span>
                )}
              </div>
              <p className="text-xs text-stone-400 mt-0.5">
                {signal.archetypeName} • {signal.timeframe}
              </p>
            </div>
          </div>
          <button 
            id="close-signal-modal-btn"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-stone-800 text-stone-400 hover:text-stone-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* AI Rationale & Execution Decision */}
        <div className="mt-4 p-3.5 rounded-xl bg-stone-950/70 border border-stone-800/80">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 mb-1">
            <Zap className="w-3.5 h-3.5" />
            <span>Quantitative Execution Blueprint</span>
          </div>
          <p className="text-xs sm:text-sm text-stone-300 leading-relaxed">
            {signal.aiRationale}
          </p>
          <div className="mt-2 text-xs text-stone-400 border-t border-stone-800/60 pt-2 flex items-center justify-between">
            <span>Recommended Action:</span>
            <span className="font-semibold text-stone-200">{signal.recommendedAction}</span>
          </div>
        </div>

        {/* Institutional Multi-Timeframe Alignment (4H → 1H → 15M → 5M) */}
        {mtf && (
          <div className="mt-4 p-3.5 rounded-xl bg-stone-950/70 border border-stone-800/80">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-stone-200">
                <Layers className="w-3.5 h-3.5 text-amber-400" />
                <span>Multi-Timeframe Confluence Cascade (4H → 1H → 15M → 5M)</span>
              </div>
              <span className={`px-2 py-0.5 rounded text-xs font-extrabold border ${
                mtf.confluenceRating === 'A+' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                : mtf.confluenceRating === 'A' ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
                : mtf.confluenceRating === 'B' ? 'bg-stone-800 text-stone-300 border-stone-700'
                : 'bg-rose-500/20 text-rose-300 border-rose-500/30'
              }`}>
                Rating: {mtf.confluenceRating} ({mtf.alignedCount ?? 3}/4 Aligned)
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
              <div className={`p-2 rounded-lg border ${mtf.fourHourAligned ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300' : 'bg-stone-900 border-stone-800 text-stone-400'}`}>
                <span className="text-[10px] text-stone-500 uppercase block font-semibold">4H Macro</span>
                <span className="font-bold text-xs">{mtf.dailyTrend || 'NEUTRAL'}</span>
                <span className="text-[10px] block text-stone-400 mt-0.5">{mtf.fourHourStructure}</span>
              </div>

              <div className={`p-2 rounded-lg border ${mtf.oneHourAligned ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300' : 'bg-stone-900 border-stone-800 text-stone-400'}`}>
                <span className="text-[10px] text-stone-500 uppercase block font-semibold">1H Impulse</span>
                <span className="font-bold text-xs">{mtf.oneHourImpulse}</span>
                <span className="text-[10px] block text-stone-400 mt-0.5">Momentum</span>
              </div>

              <div className={`p-2 rounded-lg border ${mtf.fifteenMinAligned ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300' : 'bg-stone-900 border-stone-800 text-stone-400'}`}>
                <span className="text-[10px] text-stone-500 uppercase block font-semibold">15M Squeeze</span>
                <span className="font-bold text-xs">{mtf.fifteenMinSqueeze || 'EXPANDING'}</span>
                <span className="text-[10px] block text-stone-400 mt-0.5">Volatility</span>
              </div>

              <div className={`p-2 rounded-lg border ${mtf.fiveMinAligned ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300' : 'bg-stone-900 border-stone-800 text-stone-400'}`}>
                <span className="text-[10px] text-stone-500 uppercase block font-semibold">5M Flow</span>
                <span className="font-bold text-xs">{mtf.fiveMinFlow || 'NEUTRAL'}</span>
                <span className="text-[10px] block text-stone-400 mt-0.5">Micro Execution</span>
              </div>
            </div>
          </div>
        )}

        {/* 5-Pillar Scoring Breakdown */}
        <div className="mt-5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-400 mb-3">
            Institutional 5-Pillar Checkpoint Audit
          </h4>
          <div className="space-y-2.5">
            {signal.checkpoints.map((cp) => (
              <div 
                key={cp.id}
                className={`p-3 rounded-xl border text-xs ${
                  cp.passed 
                    ? 'bg-stone-950/40 border-emerald-500/25' 
                    : 'bg-stone-950/40 border-stone-800'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {cp.passed ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                    )}
                    <div>
                      <span className="font-semibold text-stone-200">{cp.name}</span>
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-400">
                        {cp.pillarCategory}
                      </span>
                    </div>
                  </div>
                  <span className={`font-bold ${cp.passed ? 'text-emerald-400' : 'text-stone-500'}`}>
                    {cp.earnedScore}/{cp.weight} pts
                  </span>
                </div>
                <div className="mt-1.5 pl-6 text-stone-400 text-[11px] leading-relaxed">
                  <div className="text-stone-300 font-mono text-[10px]">Rule: {cp.requiredRule}</div>
                  <div className="text-stone-400 font-mono text-[10px]">Observed: {cp.currentValue}</div>
                  <p className="mt-1 text-stone-400">{cp.explanation}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Asymmetric Harvest & Ratchet Geometry */}
        <div className="mt-6 p-4 rounded-xl bg-stone-950/80 border border-stone-800">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-400 mb-3 flex items-center gap-2">
            <Lock className="w-3.5 h-3.5" />
            <span>Mathematical Harvest Ladders & Breakeven Ratchet Floor</span>
          </h4>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div className="p-2.5 rounded-lg bg-stone-900 border border-stone-800">
              <span className="text-[10px] text-stone-400 uppercase block">Entry Price</span>
              <span className="text-sm font-bold text-stone-100">${plan.entryPrice}</span>
              <span className="text-[10px] text-stone-500 block">Current Market</span>
            </div>

            <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25">
              <span className="text-[10px] text-rose-300 uppercase block">Stop Loss (Risk)</span>
              <span className="text-sm font-bold text-rose-400">${plan.stopLossPrice}</span>
              <span className="text-[10px] text-rose-400/80 block">-{plan.stopLossPct}% (${plan.riskAmountUSD.toFixed(2)})</span>
            </div>

            <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25">
              <span className="text-[10px] text-emerald-300 uppercase block">Tier 1 Harvest (33%)</span>
              <span className="text-sm font-bold text-emerald-400">${plan.tier1Price}</span>
              <span className="text-[10px] text-emerald-400/80 block">+{plan.tier1Pct}% (Ratchets Breakeven)</span>
            </div>

            <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25">
              <span className="text-[10px] text-emerald-300 uppercase block">Tier 2 Target (33%)</span>
              <span className="text-sm font-bold text-emerald-400">${plan.tier2Price}</span>
              <span className="text-[10px] text-emerald-400/80 block">+{plan.tier2Pct}% (Locks Tier 1)</span>
            </div>
          </div>

          <div className="mt-3 text-xs text-stone-400 flex items-center justify-between border-t border-stone-800/80 pt-2.5">
            <span>Reward-to-Risk Ratio: <strong className="text-emerald-400">{plan.rewardRiskRatio}:1</strong></span>
            <span>Breakeven Ratchet Floor: <strong className="text-amber-400">${plan.breakevenRatchetPrice}</strong></span>
          </div>
        </div>

        {/* Modal Action Buttons */}
        <div className="mt-6 flex items-center justify-end gap-3 pt-4 border-t border-stone-800">
          <button
            id="modal-cancel-btn"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-stone-300 hover:text-stone-100 hover:bg-stone-800 rounded-lg transition-colors"
          >
            Close
          </button>

          {isAlreadyOpen ? (
            <div className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg bg-stone-800 border border-stone-700 text-stone-300">
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              <span>Active in Slot (10-Coin Diversification Enforced)</span>
            </div>
          ) : isMajorCapped ? (
            <div className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg bg-stone-800/80 border border-stone-700/50 text-stone-400">
              <Lock className="w-3.5 h-3.5 text-purple-400" />
              <span>Majors Capped (3/3 Slots Filled)</span>
            </div>
          ) : isMemeCapped ? (
            <div className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg bg-stone-800/80 border border-stone-700/50 text-stone-400">
              <Lock className="w-3.5 h-3.5 text-pink-400" />
              <span>Memes Capped (2/2 Slots Filled)</span>
            </div>
          ) : (
            <button
              id="modal-deploy-tranche-btn"
              onClick={() => onDeploy(signal)}
              disabled={!canDeploy}
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-bold rounded-lg bg-amber-500 hover:bg-amber-400 text-stone-950 disabled:opacity-50 disabled:cursor-not-allowed shadow-md transition-all"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Deploy $10.00 Micro-Tranche</span>
            </button>
          )}
        </div>

        {isAlreadyOpen ? (
          <p className="mt-2 text-right text-[11px] text-amber-400/90 font-medium">
            * An active position for {signal.symbol} is already open. 10 bankroll slots are strictly dedicated to 10 distinct coins for risk diversification.
          </p>
        ) : (!canDeploy && deployBlockReason && (
          <p className="mt-2 text-right text-[11px] text-amber-400/90">
            * {deployBlockReason}
          </p>
        ))}
      </div>
    </div>
  );
};
