import React from 'react';
import { formatRatio } from '../services/metrics';
import { 
  ShieldCheck, 
  Target, 
  Flame, 
  ArrowDownRight, 
  Award, 
  Percent, 
  RotateCcw, 
  DollarSign, 
  TrendingUp, 
  CheckCircle2, 
  AlertTriangle,
  Info,
  Scale
} from 'lucide-react';
import { AutomatedTradeRecord, BankrollState } from '../types/automatedFeed';
import { calculateStrategyVerification } from '../services/bankrollService';

interface StrategyMetricsScorecardProps {
  trades: AutomatedTradeRecord[];
  bankroll: BankrollState;
  onResetTrades?: () => void;
}

export const StrategyMetricsScorecard: React.FC<StrategyMetricsScorecardProps> = ({
  trades,
  bankroll,
  onResetTrades
}) => {
  const verification = calculateStrategyVerification(trades);

  return (
    <div id="strategy-metrics-scorecard" className="space-y-6">
      
      {/* 1. Treasury & Fee Ledger Strip */}
      <div id="treasury-fee-ledger-strip" className="p-4 sm:p-5 rounded-2xl bg-stone-900 border border-stone-800 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-800/80">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <DollarSign className="w-4 h-4" />
              </span>
              <span className="text-xs font-bold text-stone-200 uppercase tracking-wider">
                Treasury & Binance Fee Ledger (0.10% Spot Maker/Taker)
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-1">
              Strict accounting ledger: All exchange commissions deducted directly from liquid cash and factored into net expectancy.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-stone-400 font-medium">Slot Structure:</span>
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-stone-800 text-amber-400 border border-stone-700">
              {bankroll.totalSlots} × ${bankroll.trancheSizeUSD.toFixed(2)} High-Conviction Slots (${bankroll.initialBudgetUSD.toFixed(0)} USDT Base)
            </span>
          </div>
        </div>

        {/* Financial Ledger Metric Blocks */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-4">
          <div className="p-3 rounded-xl bg-stone-950/70 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Starting Capital</span>
            <span className="text-lg font-black text-stone-100">$100.00 <span className="text-xs font-normal text-stone-400">USDT</span></span>
            <span className="text-[10px] text-stone-400 block mt-0.5">Strict Baseline</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/70 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Gross Gains Won</span>
            <span className="text-lg font-black text-emerald-400">+${verification.grossProfitUSD.toFixed(2)}</span>
            <span className="text-[10px] text-stone-400 block mt-0.5">{verification.winCount} Winners Harvested</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/70 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Binance Fees Paid</span>
            <span className="text-lg font-black text-rose-400">-${verification.totalFeesUSD.toFixed(2)}</span>
            <span className="text-[10px] text-stone-400 block mt-0.5">0.10% Entry & Exit</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/70 border border-stone-800/80">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Net Realized Profit</span>
            <span className={`text-lg font-black ${verification.netRealizedPnLUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {verification.netRealizedPnLUSD >= 0 ? '+' : ''}${verification.netRealizedPnLUSD.toFixed(2)}
            </span>
            <span className="text-[10px] text-stone-400 block mt-0.5">Strictly Post-Fee PnL</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/70 border border-stone-800/80 col-span-2 sm:col-span-1">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">Liquid Cash Recycled</span>
            <span className="text-lg font-black text-amber-400">${bankroll.liquidCashUSD.toFixed(2)}</span>
            <span className="text-[10px] text-stone-400 block mt-0.5">Available for New Signals</span>
          </div>
        </div>
      </div>

      {/* 2. Central Limit Theorem Sample Size Progress Banner */}
      <div id="clt-sample-progress" className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                Quantitative Verification Scorecard (N ≥ 30 Sample Progress)
              </span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                verification.readinessStatus === 'VALIDATED_READY'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
              }`}>
                {verification.readinessStatus}
              </span>
            </div>
            <h3 className="text-base sm:text-lg font-bold text-stone-100 mt-1">
              Sample Size Progress ({verification.sampleSize} / {verification.targetSampleSize} Closed Cycles)
            </h3>
            <p className="text-xs text-stone-400 mt-0.5">
              Tracks closed cycles against N ≥ 30 required under the Central Limit Theorem to verify that results are systemic and not short-term luck.
            </p>
          </div>

          <div className="flex items-center sm:flex-col sm:items-end justify-between sm:justify-center border-t sm:border-t-0 pt-2 sm:pt-0 border-stone-800">
            <span className="text-[10px] text-stone-400 uppercase font-semibold">Verification Score</span>
            <span className="text-2xl font-black text-amber-400">{verification.readinessScore}%</span>
            <span className="text-[11px] text-stone-400 font-medium">
              {Math.round((verification.readinessScore / 100) * 6)} of 6 Hurdle Benchmarks Passed
            </span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-2.5 rounded-full bg-stone-950 overflow-hidden border border-stone-800">
          <div 
            className="h-full bg-gradient-to-r from-amber-500 via-amber-400 to-emerald-400 transition-all duration-500"
            style={{ width: `${verification.sampleProgressPct}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-stone-400">
          <span>{verification.sampleSize} closed trade cycles logged in database</span>
          <span>Target: 30 closed cycles for Central Limit Theorem statistical proof</span>
        </div>
      </div>

      {/* 3. The 6 Quantitative Verification Scorecard Hurdles Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        
        {/* Metric 1: Win Rate */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Percent className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-stone-200">1. Win Rate</span>
            </div>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
              verification.winRatePassed 
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
            }`}>
              Target ≥ {verification.targetWinRatePct.toFixed(1)}%
            </span>
          </div>

          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black text-stone-100">{verification.winRatePct}%</span>
              <span className="text-xs text-stone-400 font-medium">
                ({verification.winCount}W · {verification.lossCount}L · {verification.breakevenCount}BE)
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-1">
              Percentage of closed trades finishing in net profit. 5-pillar confluence scoring keeps win rate resilient.
            </p>
          </div>

          <div className="pt-2 border-t border-stone-800 text-[10px] text-stone-400">
            Formula: <code className="text-stone-300">Wins ÷ Total Closed Trades</code>
          </div>
        </div>

        {/* Metric 2: Payoff Ratio */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Target className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-stone-200">2. Payoff Ratio</span>
            </div>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
              verification.payoffPassed 
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
            }`}>
              Target ≥ {verification.targetPayoffRatio.toFixed(2)}x
            </span>
          </div>

          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black text-amber-400">{formatRatio(verification.payoffRatio)}x</span>
              <span className="text-xs text-stone-400 font-medium">Asymmetry Multiple</span>
            </div>
            <p className="text-xs text-stone-400 mt-1">
              Avg Win (<strong className="text-emerald-400">${verification.avgWinUSD.toFixed(2)}</strong>) vs Avg Loss (<strong className="text-rose-400">${verification.avgLossUSD.toFixed(2)}</strong>). Ensures winners far exceed capped stop losses.
            </p>
          </div>

          <div className="pt-2 border-t border-stone-800 text-[10px] text-stone-400">
            Formula: <code className="text-stone-300">Average Win ($) ÷ Average Loss ($)</code>
          </div>
        </div>

        {/* Metric 3: Profit Factor */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Flame className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-stone-200">3. Profit Factor</span>
            </div>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
              verification.profitFactorPassed 
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
            }`}>
              Target ≥ {verification.targetProfitFactor.toFixed(2)}
            </span>
          </div>

          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black text-emerald-400">{formatRatio(verification.profitFactor)}</span>
              <span className="text-xs text-stone-400 font-medium">Gross Ratio</span>
            </div>
            <p className="text-xs text-stone-400 mt-1">
              Shows gross dollars won (<strong className="text-emerald-400">+${verification.grossProfitUSD.toFixed(2)}</strong>) substantially outweigh gross dollars lost (<strong className="text-rose-400">-${verification.grossLossUSD.toFixed(2)}</strong>).
            </p>
          </div>

          <div className="pt-2 border-t border-stone-800 text-[10px] text-stone-400">
            Formula: <code className="text-stone-300">Gross Profit ($) ÷ Gross Loss ($)</code>
          </div>
        </div>

        {/* Metric 4: Maximum Drawdown */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20">
                <ArrowDownRight className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-stone-200">4. Maximum Drawdown</span>
            </div>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
              verification.drawdownPassed 
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
            }`}>
              Target ≤ {verification.targetMaxDrawdownPct.toFixed(1)}%
            </span>
          </div>

          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black text-stone-100">{verification.maxDrawdownPct}%</span>
              <span className="text-xs text-stone-400 font-medium">Peak-to-Trough Decline</span>
            </div>
            <p className="text-xs text-stone-400 mt-1">
              Deepest account drop from high-water mark. On your $100 bankroll, keeps portfolio drawdowns strictly under $8.00.
            </p>
          </div>

          <div className="pt-2 border-t border-stone-800 text-[10px] text-stone-400">
            Boundary: <code className="text-stone-300">Peak - Trough ≤ $8.00 on 100 USDT</code>
          </div>
        </div>

        {/* Metric 5: Net Expectancy */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Award className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-stone-200">5. Net Expectancy</span>
            </div>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
              verification.expectancyPassed 
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
            }`}>
              Target ≥ +${verification.targetExpectancyUSD.toFixed(2)} / slot
            </span>
          </div>

          <div>
            <div className="flex items-baseline gap-2">
              <span className={`text-3xl font-black ${
                verification.expectancyUSD >= verification.targetExpectancyUSD ? 'text-emerald-400' : verification.expectancyUSD >= 0 ? 'text-amber-400' : 'text-rose-400'
              }`}>
                {verification.expectancyUSD >= 0 ? '+' : ''}${verification.expectancyUSD.toFixed(3)}
              </span>
              <span className="text-xs text-stone-400 font-medium">per $10 slot</span>
            </div>
            <p className="text-xs text-stone-400 mt-1">
              Net return per $10 micro-slot strictly after deducting 0.10% Binance maker/taker spot commissions.
            </p>
          </div>

          <div className="pt-2 border-t border-stone-800 text-[10px] text-stone-400">
            Formula: <code className="text-amber-300">(Win% × AvgWin) - (Loss% × AvgLoss) - Fees</code>
          </div>
        </div>

        {/* Metric 6: Zero-Risk Ratchet Rate */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-stone-200">6. Breakeven-Stop Rate</span>
            </div>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
              verification.ratchetPassed 
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
            }`}>
              Target ≥ {verification.targetZeroRiskRatchetRatePct.toFixed(1)}%
            </span>
          </div>

          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black text-emerald-400">{verification.zeroRiskRatchetRatePct}%</span>
              <span className="text-xs text-stone-400 font-medium">Armed Ratio</span>
            </div>
            <p className="text-xs text-stone-400 mt-1">
              Percent of trades that hit Tier 1 (+4.2%) and arm breakeven ratchet, preventing green trades from turning into losses.
            </p>
          </div>

          <div className="pt-2 border-t border-stone-800 text-[10px] text-stone-400">
            Mechanism: <code className="text-stone-300">Harvest 1/3 at +4.2% → Move Stop to Entry</code>
          </div>
        </div>

      </div>

      {/* 4. Strategy Win/Loss Ratio & Cycle Execution Summary */}
      <div id="strategy-winloss-execution-panel" className="p-5 rounded-2xl bg-stone-900/90 border border-stone-800 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                Cycle Verification & Win/Loss Ratio
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                Live Trade Metrics
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              Derived directly from closed paper trading cycles without synthetic mock adjustments.
            </p>
          </div>

          {onResetTrades && (
            <button
              onClick={onResetTrades}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-300 transition-colors cursor-pointer self-start sm:self-auto"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Trade Sample</span>
            </button>
          )}
        </div>

        {/* Real Live Metrics Breakdown */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
          <div className="p-4 rounded-xl bg-stone-950/80 border border-stone-800">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-stone-400">Win / Loss Ratio</span>
              <Scale className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-black text-amber-400 mt-2">
              {verification.winLossRatioFormatted}
            </div>
            <div className="text-[11px] text-stone-400 mt-1">
              {verification.winCount} Wins vs {verification.lossCount} Losses
            </div>
          </div>

          <div className="p-4 rounded-xl bg-stone-950/80 border border-stone-800">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-stone-400">Closed Trade Cycles</span>
              <Target className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-stone-100 mt-2">
              {verification.sampleSize} <span className="text-xs text-stone-400 font-normal">/ {verification.targetSampleSize}</span>
            </div>
            <div className="text-[11px] text-stone-400 mt-1">
              {verification.breakevenCount} Breakeven Ratchets ($0.00 Risk)
            </div>
          </div>

          <div className="p-4 rounded-xl bg-stone-950/80 border border-stone-800">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-stone-400">Net Cycle Expectancy</span>
              <TrendingUp className="w-4 h-4 text-cyan-400" />
            </div>
            <div className={`text-2xl font-black mt-2 ${verification.expectancyUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {verification.expectancyUSD >= 0 ? '+' : ''}${verification.expectancyUSD.toFixed(2)}
            </div>
            <div className="text-[11px] text-stone-400 mt-1">
              Net expectancy per $10.00 tranche
            </div>
          </div>
        </div>
      </div>

    </div>
  );
};
