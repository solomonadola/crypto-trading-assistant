import React, { useState, useMemo } from 'react';
import { 
  TrendingUp, 
  Target, 
  ShieldCheck, 
  BarChart3, 
  Percent, 
  DollarSign, 
  Award, 
  Download, 
  FileSpreadsheet, 
  HelpCircle, 
  ArrowUpRight, 
  ArrowDownRight, 
  RefreshCw, 
  Sliders, 
  Layers, 
  CheckCircle2, 
  AlertTriangle,
  Flame,
  Clock,
  ExternalLink,
  Scale,
  Activity,
  Calendar
} from 'lucide-react';
import { 
  AreaChart, 
  Area, 
  LineChart,
  Line,
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer, 
  ReferenceLine,
  BarChart,
  Bar,
  Cell,
  CartesianGrid
} from 'recharts';
import { AutomatedTradeRecord, BankrollState } from '../types/automatedFeed';
import { 
  calculateStrategyVerification, 
  exportTradesToCSV, 
  exportTradesToJSON 
} from '../services/bankrollService';
import { formatCashUSD } from '../services/orderFlowService';
import { netPnlUSD, outcome, netReturnPct, closeTime, isClosed, formatRatio } from '../services/metrics';
import { 
  analyzeConsolidationLosses, 
  ConsolidationLossAuditReport 
} from '../services/consolidationLossRecorderService';
import { ConsolidationLossAuditModal } from './ConsolidationLossAuditModal';

interface OverallMetricsViewProps {
  trades: AutomatedTradeRecord[];
  bankroll: BankrollState;
  onResetTrades?: () => void;
}

export const OverallMetricsView: React.FC<OverallMetricsViewProps> = ({
  trades,
  bankroll,
  onResetTrades
}) => {
  const verification = useMemo(() => calculateStrategyVerification(trades), [trades]);
  // Charts previously hardcoded 100.0 and ignored the configured budget.
  const baseCapital = bankroll?.initialBudgetUSD || 100;
  const [isConsolidationAuditOpen, setIsConsolidationAuditOpen] = useState(false);
  const [auditRefreshKey, setAuditRefreshKey] = useState(0);

  const consolidationReport = useMemo<ConsolidationLossAuditReport>(() => {
    return analyzeConsolidationLosses(trades);
  }, [trades, auditRefreshKey]);

  // Interactive What-If Simulator State
  const [simWinRate, setSimWinRate] = useState<number>(verification.winRatePct || 60);
  const [simPayoffRR, setSimPayoffRR] = useState<number>(
    Number.isFinite(verification.payoffRatio) && verification.payoffRatio > 0 ? verification.payoffRatio : 2.5
  );
  const [simTradeCount, setSimTradeCount] = useState<number>(50);

  // Filter & breakdown per asset
  const assetBreakdown = useMemo(() => {
    const map = new Map<string, {
      symbol: string;
      coinName: string;
      trades: number;
      wins: number;
      losses: number;
      closed: number;
      pnl: number;
      avgRR: number;
      ratchetHits: number;
    }>();

    trades.forEach((t) => {
      const existing = map.get(t.symbol) || {
        symbol: t.symbol,
        coinName: t.coinName,
        trades: 0,
        wins: 0,
        losses: 0,
        closed: 0,
        pnl: 0,
        avgRR: 0,
        ratchetHits: 0,
      };

      existing.trades += 1;
      if (isClosed(t)) {
        existing.closed += 1;
        existing.pnl += netPnlUSD(t);
        const o = outcome(t);
        if (o === 'WIN') existing.wins += 1;
        else if (o === 'LOSS') existing.losses += 1;
        if (t.ratchet?.isArmed) existing.ratchetHits += 1;
      }
      map.set(t.symbol, existing);
    });

    return Array.from(map.values()).map((item) => {
      // Same definition as the headline win rate: wins / closed trades.
      const winRate = item.closed > 0 ? (item.wins / item.closed) * 100 : 0;
      return {
        ...item,
        winRate: +winRate.toFixed(1),
        pnl: +item.pnl.toFixed(2),
      };
    }).sort((a, b) => b.pnl - a.pnl);
  }, [trades]);

  // Equity Curve Cumulative Timeline
  const equityCurveData = useMemo(() => {
    let runningPnL = 0;
    const closed = trades.filter(isClosed).sort((a, b) => closeTime(a) - closeTime(b));

    const points = [
      {
        name: 'Start',
        equity: baseCapital,
        netPnL: 0,
        trade: 'Initial Treasury',
      }
    ];

    closed.forEach((t, idx) => {
      const net = netPnlUSD(t);
      runningPnL += net;
      points.push({
        name: `T${idx + 1} (${t.symbol})`,
        equity: +(baseCapital + runningPnL).toFixed(2),
        netPnL: +runningPnL.toFixed(2),
        trade: `${t.symbol} ${t.direction || 'LONG'} (${net >= 0 ? '+' : ''}$${net.toFixed(2)})`,
      });
    });

    return points;
  }, [trades, baseCapital]);

  // Active chart view toggle: 'daily' (Daily Performance) | 'equity' (Portfolio Equity Curve) | 'roi' (Cumulative ROI)
  const [activeChartTab, setActiveChartTab] = useState<'daily' | 'equity' | 'roi'>('daily');
  // Sub-toggle for daily performance: 'curve' (Total Portfolio Value Fluctuations) | 'bars' (Daily PnL Breakdown)
  const [dailyChartMode, setDailyChartMode] = useState<'curve' | 'bars'>('curve');

  // Daily Performance timeline calculating portfolio value fluctuations day-by-day based on trade history data
  const dailyPerformanceData = useMemo(() => {
    const startingCapital = baseCapital;
    if (!trades || trades.length === 0) {
      const todayLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return [
        {
          date: 'Baseline',
          isoDate: 'start',
          portfolioValue: startingCapital,
          startValue: startingCapital,
          dailyPnlUSD: 0,
          dailyPnlPct: 0,
          dayHigh: startingCapital,
          dayLow: startingCapital,
          tradesCount: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          symbols: 'Initial Treasury'
        },
        {
          date: todayLabel,
          isoDate: 'today',
          portfolioValue: +(bankroll?.totalPortfolioValueUSD || startingCapital).toFixed(2),
          startValue: startingCapital,
          dailyPnlUSD: 0,
          dailyPnlPct: 0,
          dayHigh: +(bankroll?.totalPortfolioValueUSD || startingCapital).toFixed(2),
          dayLow: startingCapital,
          tradesCount: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          symbols: 'Current State'
        }
      ];
    }

    // Sort trades chronologically
    const sortedTrades = [...trades].sort((a, b) => {
      const tsA = a.closedAtTimestamp || a.openedAtTimestamp || 0;
      const tsB = b.closedAtTimestamp || b.openedAtTimestamp || 0;
      return tsA - tsB;
    });

    interface DayBucket {
      isoDate: string;
      dateLabel: string;
      tradePnls: number[];
      wins: number;
      losses: number;
      tradesCount: number;
      symbols: string[];
    }

    const dayMap = new Map<string, DayBucket>();

    sortedTrades.forEach((t) => {
      // Realized performance only: open trades were bucketed by open date with
      // P&L 0, inflating each day's trade count and diluting its win rate.
      if (!isClosed(t)) return;
      const ts = closeTime(t);
      if (!ts) return;
      const d = new Date(ts);
      const isoDate = d.toISOString().split('T')[0];
      const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      if (!dayMap.has(isoDate)) {
        dayMap.set(isoDate, {
          isoDate,
          dateLabel,
          tradePnls: [],
          wins: 0,
          losses: 0,
          tradesCount: 0,
          symbols: []
        });
      }

      const bucket = dayMap.get(isoDate)!;
      bucket.tradesCount += 1;
      const pnl = netPnlUSD(t);
      bucket.tradePnls.push(pnl);
      const o = outcome(t);
      if (o === 'WIN') bucket.wins += 1;
      else if (o === 'LOSS') bucket.losses += 1;
      if (bucket.symbols.length < 5 && !bucket.symbols.includes(t.symbol)) {
        bucket.symbols.push(t.symbol);
      }
    });

    const sortedDays = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v);

    let runningVal = startingCapital;
    const points: Array<{
      date: string;
      isoDate: string;
      portfolioValue: number;
      startValue: number;
      dailyPnlUSD: number;
      dailyPnlPct: number;
      dayHigh: number;
      dayLow: number;
      tradesCount: number;
      wins: number;
      losses: number;
      winRate: number;
      symbols: string;
    }> = [];

    // Starting baseline point
    const firstDayDate = sortedDays.length > 0 ? sortedDays[0].dateLabel : 'Day 0';
    points.push({
      date: `Start (${firstDayDate})`,
      isoDate: 'start',
      portfolioValue: startingCapital,
      startValue: startingCapital,
      dailyPnlUSD: 0,
      dailyPnlPct: 0,
      dayHigh: startingCapital,
      dayLow: startingCapital,
      tradesCount: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      symbols: `Initial $${startingCapital.toFixed(2)} Treasury`
    });

    sortedDays.forEach((day) => {
      const dayStart = runningVal;
      let dayPeak = dayStart;
      let dayTrough = dayStart;
      let dayTotalPnl = 0;

      day.tradePnls.forEach((p) => {
        runningVal += p;
        dayTotalPnl += p;
        if (runningVal > dayPeak) dayPeak = runningVal;
        if (runningVal < dayTrough) dayTrough = runningVal;
      });

      const dayPct = dayStart > 0 ? +((dayTotalPnl / dayStart) * 100).toFixed(2) : 0;
      const winRate = day.tradesCount > 0 ? +((day.wins / day.tradesCount) * 100).toFixed(1) : 0;

      points.push({
        date: day.dateLabel,
        isoDate: day.isoDate,
        portfolioValue: +runningVal.toFixed(2),
        startValue: +dayStart.toFixed(2),
        dailyPnlUSD: +dayTotalPnl.toFixed(2),
        dailyPnlPct: dayPct,
        dayHigh: +dayPeak.toFixed(2),
        dayLow: +dayTrough.toFixed(2),
        tradesCount: day.tradesCount,
        wins: day.wins,
        losses: day.losses,
        winRate,
        symbols: day.symbols.join(', ')
      });
    });

    return points;
  }, [trades, bankroll?.totalPortfolioValueUSD, baseCapital]);

  // Aggregate daily statistics for quick insights
  const dailyStats = useMemo(() => {
    const activeDays = dailyPerformanceData.filter(d => d.isoDate !== 'start');
    if (activeDays.length === 0) {
      return {
        currentValue: +(bankroll?.totalPortfolioValueUSD || 100).toFixed(2),
        peakValue: +(bankroll?.totalPortfolioValueUSD || 100).toFixed(2),
        troughValue: baseCapital,
        bestDay: { date: 'N/A', pnl: 0, pct: 0 },
        worstDay: { date: 'N/A', pnl: 0, pct: 0 },
        greenDays: 0,
        redDays: 0,
        totalDays: 0,
        avgDailyPnL: 0
      };
    }

    let peak = baseCapital;
    let trough = baseCapital;
    let best = activeDays[0];
    let worst = activeDays[0];
    let totalPnL = 0;
    let green = 0;
    let red = 0;

    activeDays.forEach(d => {
      if (d.dayHigh > peak) peak = d.dayHigh;
      if (d.dayLow < trough) trough = d.dayLow;
      if (d.portfolioValue > peak) peak = d.portfolioValue;
      if (d.portfolioValue < trough) trough = d.portfolioValue;
      if (d.dailyPnlUSD > best.dailyPnlUSD) best = d;
      if (d.dailyPnlUSD < worst.dailyPnlUSD) worst = d;
      if (d.dailyPnlUSD > 0.01) green++;
      else if (d.dailyPnlUSD < -0.01) red++;
      totalPnL += d.dailyPnlUSD;
    });

    const latest = activeDays[activeDays.length - 1];

    return {
      currentValue: latest.portfolioValue,
      peakValue: peak,
      troughValue: trough,
      bestDay: { date: best.date, pnl: best.dailyPnlUSD, pct: best.dailyPnlPct },
      worstDay: { date: worst.date, pnl: worst.dailyPnlUSD, pct: worst.dailyPnlPct },
      greenDays: green,
      redDays: red,
      totalDays: activeDays.length,
      avgDailyPnL: +(totalPnL / activeDays.length).toFixed(2)
    };
  }, [dailyPerformanceData, bankroll?.totalPortfolioValueUSD, baseCapital]);

  // Cumulative ROI Timeline of completed trades over time (derived strictly from real closed trades)
  const cumulativeRoiData = useMemo(() => {
    let runningPnL = 0;
    const closed = trades.filter(isClosed).sort((a, b) => closeTime(a) - closeTime(b));

    const startingCapital = baseCapital;
    const points = [
      {
        name: 'Start',
        date: 'Day 0',
        cumulativeRoiPct: 0.0,
        tradeRoiPct: 0.0,
        netPnL: 0.0,
        trade: `Initial Baseline ($${startingCapital.toFixed(2)})`,
        symbol: 'START',
      }
    ];

    closed.forEach((t, idx) => {
      const pnl = netPnlUSD(t);
      runningPnL += pnl;
      const cumulativeRoiPct = +((runningPnL / startingCapital) * 100).toFixed(2);
      // pnlPercentage is the price move at exit, not the trade's return.
      const tradeRoiPct = +netReturnPct(t).toFixed(2);
      const dateLabel = t.closedAtTimestamp 
        ? new Date(t.closedAtTimestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })
        : `T${idx + 1}`;

      points.push({
        name: `T${idx + 1} (${t.symbol})`,
        date: dateLabel,
        cumulativeRoiPct,
        tradeRoiPct,
        netPnL: +runningPnL.toFixed(2),
        trade: `${t.symbol} (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`,
        symbol: t.symbol,
      });
    });

    return points;
  }, [trades, baseCapital]);

  // Simulated expected value calculation
  const simTrancheSize = 10;
  const simLossRisk = simTrancheSize * 0.025; // 2.5% stop loss = $0.25
  const simAvgWin = simLossRisk * simPayoffRR;
  const simExpectedPerTrade = (simWinRate / 100) * simAvgWin - ((100 - simWinRate) / 100) * simLossRisk - 0.02;
  const simTotalExpectedPnL = simExpectedPerTrade * simTradeCount;

  const handleDownloadCSV = () => {
    const csvStr = exportTradesToCSV(trades);
    const blob = new Blob([csvStr], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cryptostudy-overall-metrics-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJSON = () => {
    const jsonStr = exportTradesToJSON(trades);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cryptostudy-overall-metrics-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div id="overall-metrics-root" className="space-y-6">
      
      {/* Executive Edge Banner */}
      <div className="relative overflow-hidden p-6 rounded-2xl bg-gradient-to-r from-stone-900 via-stone-900 to-stone-950 border border-amber-500/30 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                <ShieldCheck className="w-3.5 h-3.5" />
                Performance Proof & Strategy Health
              </span>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-stone-800 text-stone-300 border border-stone-700">
                Sample: {verification.sampleSize} Completed Trades
              </span>
            </div>
            <h2 className="text-2xl font-black tracking-tight text-stone-100">
              Bot Performance & Strategy Results
            </h2>
            <p className="text-xs sm:text-sm text-stone-400 max-w-2xl leading-relaxed">
              Track how often the bot wins, how big winning trades are compared to losses, and whether the strategy generates steady growth.
            </p>
          </div>

          {/* Quick Action Export Buttons */}
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              id="metrics-export-csv-btn"
              onClick={handleDownloadCSV}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700 transition-colors shadow-sm cursor-pointer"
              title="Download all trade results into an Excel / CSV spreadsheet"
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
              <span>Export CSV</span>
            </button>
            <button
              id="metrics-export-json-btn"
              onClick={handleDownloadJSON}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-stone-950 transition-colors shadow-md font-bold cursor-pointer"
              title="Download raw trade data as JSON"
            >
              <Download className="w-4 h-4" />
              <span>Export JSON</span>
            </button>
          </div>
        </div>
      </div>

      {/* Statistical Sample Size Progress Card */}
      <div id="central-limit-theorem-panel" className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                Statistical Proofing Target
              </span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                verification.readinessStatus === 'VALIDATED_READY'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : verification.readinessStatus === 'SAMPLE_IN_PROGRESS'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
              }`}>
                {verification.readinessStatus === 'VALIDATED_READY' ? 'Ready for Live Funds' : 'Testing in Progress'}
              </span>
            </div>
            <h3 className="text-lg font-bold text-stone-100 mt-0.5">
              Completed Trades: {verification.sampleSize} / {verification.targetSampleSize} Needed
            </h3>
            <p className="text-xs text-stone-400 mt-0.5">
              Reaching 30 completed trades provides enough data to prove whether profits come from genuine mathematical edge rather than pure luck.
            </p>
          </div>

          <div className="text-right">
            <span className="text-[10px] text-stone-500 uppercase font-semibold block">Safety Targets Met</span>
            <span className="text-2xl font-black text-amber-400">{verification.readinessScore}%</span>
            <span className="text-[11px] text-stone-400 block">{Math.round((verification.readinessScore / 100) * 6)} of 6 Targets Passed</span>
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
          <span>{verification.sampleSize} trades completed so far</span>
          <span>Target: 30 completed trades to confirm long-term edge</span>
        </div>
      </div>

      {/* Executive Strategy Summary Cards Strip */}
      <div id="metrics-summary-cards-strip" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Win/Loss Ratio Card */}
        <div id="card-win-loss-ratio" className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-amber-500/40 transition-colors shadow-sm space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-stone-400 uppercase tracking-wider">Win / Loss Ratio</span>
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Scale className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2 pt-1">
            <span className="text-3xl font-black text-amber-400">{verification.winLossRatioFormatted}</span>
          </div>
          <p className="text-xs text-stone-300">
            {verification.winCount} Wins vs {verification.lossCount} Losses
            {verification.breakevenCount > 0 && <span className="text-stone-400"> · {verification.breakevenCount} Breakeven</span>}
          </p>
          <div className="pt-2 border-t border-stone-800/80 text-[11px] text-stone-500">
            Ratio of winning trades to losing trades across completed cycles
          </div>
        </div>

        {/* Win Rate Card */}
        <div id="card-win-rate" className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-emerald-500/40 transition-colors shadow-sm space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-stone-400 uppercase tracking-wider">Win Rate</span>
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Percent className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2 pt-1">
            <span className="text-3xl font-black text-emerald-400">{verification.winRatePct}%</span>
            <span className="text-xs text-stone-400">Target ≥ 55%</span>
          </div>
          <p className="text-xs text-stone-300">
            {verification.winCount} profitable out of {verification.sampleSize} completed
          </p>
          <div className="pt-2 border-t border-stone-800/80 text-[11px] text-stone-500">
            {verification.winRatePassed ? '✓ Meets statistical hurdle' : 'Testing phase in progress'}
          </div>
        </div>

        {/* Cumulative ROI Card */}
        <div id="card-cumulative-roi" className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-cyan-500/40 transition-colors shadow-sm space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-stone-400 uppercase tracking-wider">Cumulative ROI</span>
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2 pt-1">
            <span className={`text-3xl font-black ${verification.netRealizedPnLUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {verification.netRealizedPnLUSD >= 0 ? '+' : ''}{((verification.netRealizedPnLUSD / 100) * 100).toFixed(2)}%
            </span>
            <span className="text-xs text-stone-400">Net Growth</span>
          </div>
          <p className="text-xs text-stone-300">
            {verification.netRealizedPnLUSD >= 0 ? '+' : ''}${verification.netRealizedPnLUSD.toFixed(2)} net realized PnL
          </p>
          <div className="pt-2 border-t border-stone-800/80 text-[11px] text-stone-500">
            Portfolio return calculated from $100 baseline
          </div>
        </div>

        {/* Profit Factor Card */}
        <div id="card-profit-factor" className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-emerald-500/40 transition-colors shadow-sm space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-stone-400 uppercase tracking-wider">Profit Factor</span>
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Flame className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2 pt-1">
            <span className="text-3xl font-black text-emerald-400">{formatRatio(verification.profitFactor)}</span>
            <span className="text-xs text-stone-400">Target ≥ 1.75</span>
          </div>
          <p className="text-xs text-stone-300">
            +${verification.grossProfitUSD.toFixed(2)} Won / -${verification.grossLossUSD.toFixed(2)} Lost
          </p>
          <div className="pt-2 border-t border-stone-800/80 text-[11px] text-stone-500">
            {verification.profitFactorPassed ? '✓ Asymmetric edge confirmed' : 'Evaluating trade cycles'}
          </div>
        </div>
      </div>

      {/* Feature Section: Time-of-Day Consolidation Loss Record Mechanism */}
      <div 
        id="metrics-consolidation-loss-recorder-card" 
        className="p-5 rounded-2xl bg-stone-900 border border-stone-800 space-y-4 shadow-sm"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-stone-800/80">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20">
                <Clock className="w-4 h-4" />
              </span>
              <h3 className="text-base font-bold text-stone-100">
                Consolidation Loss Recorder & Time-of-Day Audit
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30">
                {consolidationReport.totalEpisodesRecorded} Episodes Logged
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-1">
              Tracks exactly from what time to what time consolidation occurred and where trading experienced drawdowns.
            </p>
          </div>

          <button
            onClick={() => setIsConsolidationAuditOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-rose-950/40 hover:bg-rose-900/50 text-rose-200 border border-rose-800/60 transition-colors shadow-sm cursor-pointer self-start sm:self-auto"
          >
            <BarChart3 className="w-4 h-4 text-rose-400" />
            <span>View Full Loss Timeline & 24h Heatmap</span>
            <ExternalLink className="w-3.5 h-3.5 text-rose-400/70" />
          </button>
        </div>

        {/* 3 Metrics Callouts */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-3.5 rounded-xl bg-stone-950/70 border border-stone-800/80 space-y-1">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">
              Peak Drawdown Window (From Time To Time)
            </span>
            <div className="text-sm font-bold text-rose-400 font-mono">
              {consolidationReport.worstWindowUTC}
            </div>
            <span className="text-[11px] text-stone-400 block">
              Local: {consolidationReport.worstWindowLocal}
            </span>
          </div>

          <div className="p-3.5 rounded-xl bg-stone-950/70 border border-stone-800/80 space-y-1">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">
              Worst Window Net Loss
            </span>
            <div className="text-base font-black text-rose-400 font-mono">
              -${consolidationReport.worstWindowTotalLossUSD.toFixed(2)} USD
            </div>
            <span className="text-[11px] text-stone-400 block">
              {consolidationReport.worstWindowLossesCount} stop-outs concentrated here
            </span>
          </div>

          <div className="p-3.5 rounded-xl bg-stone-950/70 border border-stone-800/80 space-y-1">
            <span className="text-[10px] text-stone-400 uppercase font-semibold block">
              Recurring Trap Detection
            </span>
            <div className="flex items-center gap-1.5">
              <span className={`text-base font-black font-mono ${
                consolidationReport.recurringTrapsCount > 0 ? 'text-amber-400' : 'text-emerald-400'
              }`}>
                {consolidationReport.recurringTrapsCount} Detected
              </span>
            </div>
            <span className="text-[11px] text-stone-400 block">
              {consolidationReport.recurringTrapsCount > 0 
                ? 'Flagged for entry freeze recommendation' 
                : 'No recurring trap hours detected yet'}
            </span>
          </div>
        </div>
      </div>

      {/* Consolidation Loss Audit Modal */}
      <ConsolidationLossAuditModal
        isOpen={isConsolidationAuditOpen}
        onClose={() => setIsConsolidationAuditOpen(false)}
        report={consolidationReport}
        trades={trades}
        onRefreshReport={() => setAuditRefreshKey(k => k + 1)}
      />

      {/* The 6 Strategy Verification Benchmarks Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-amber-400" />
          <h3 className="text-lg font-black text-stone-100">
            The 6 Safety & Profitability Checks
          </h3>
        </div>
        <p className="text-xs text-stone-400">
          These are the 6 rules the bot must pass to prove it is safe and reliably profitable:
        </p>
      </div>

      {/* The 6 Verification Benchmark Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        
        {/* Benchmark 1: Win Rate */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-emerald-500/40 transition-colors space-y-3">
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
              <span className="text-3xl font-black text-emerald-400">{verification.winRatePct}%</span>
              <span className="text-xs text-stone-400 font-medium">
                ({verification.winCount}W · {verification.lossCount}L · {verification.breakevenCount}BE)
              </span>
            </div>
            <p className="text-xs font-medium text-stone-300 mt-1">
              The percentage of closed trades that finish in net profit.
            </p>
          </div>

          {/* Win/Loss Mini Proportion Bar */}
          <div className="w-full h-1.5 rounded-full bg-stone-950 flex overflow-hidden border border-stone-800">
            <div 
              className="bg-emerald-500 h-full" 
              style={{ width: `${verification.sampleSize > 0 ? (verification.winCount / verification.sampleSize) * 100 : 0}%` }}
              title={`Wins: ${verification.winCount}`}
            />
            <div 
              className="bg-amber-400 h-full" 
              style={{ width: `${verification.sampleSize > 0 ? (verification.breakevenCount / verification.sampleSize) * 100 : 0}%` }}
              title={`Breakeven: ${verification.breakevenCount}`}
            />
            <div 
              className="bg-rose-500 h-full" 
              style={{ width: `${verification.sampleSize > 0 ? (verification.lossCount / verification.sampleSize) * 100 : 0}%` }}
              title={`Losses: ${verification.lossCount}`}
            />
          </div>

          <div className="pt-2 border-t border-stone-800/80 text-[10px] text-stone-500 leading-tight">
            Formula: <code className="text-stone-400">Wins ÷ Total Closed Trades</code>. 5-pillar confluence entry scoring prevents bad chop entries.
          </div>
        </div>

        {/* Benchmark 2: Win-to-Loss Size Ratio */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-amber-500/40 transition-colors space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Target className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-stone-200">2. Win Size vs Loss Size</span>
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
              <span className="text-3xl font-black text-amber-400">{formatRatio(verification.payoffRatio)}:1</span>
              <span className="text-xs text-stone-400 font-medium">Payoff Ratio (avg win ÷ avg loss)</span>
            </div>
            <p className="text-[11px] text-stone-300 mt-1">
              Average Win: <strong className="text-emerald-400">+${verification.avgWinUSD.toFixed(2)}</strong> vs Average Loss: <strong className="text-rose-400">-${verification.avgLossUSD.toFixed(2)}</strong>
            </p>
          </div>

          <p className="text-xs text-stone-400 leading-relaxed">
            Ensures that winning trades make at least 2x more money than losing trades lose. This means you make money even if you only win half your trades.
          </p>

          <div className="pt-2 border-t border-stone-800/80 text-[10px] text-stone-500 leading-tight">
            Status: {verification.payoffPassed ? 'Passed ✓ Wins are comfortably larger than losses' : 'In Progress - Awaiting runner harvests'}
          </div>
        </div>

        {/* Benchmark 3: Profit Factor */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-emerald-500/40 transition-colors space-y-3">
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
              <span className="text-xs text-stone-400 font-medium">Profit Factor</span>
            </div>
            <p className="text-[11px] text-stone-300 mt-1">
              Total Dollars Won (<strong className="text-emerald-400">+${verification.grossProfitUSD}</strong>) ÷ Total Dollars Lost (<strong className="text-rose-400">-${verification.grossLossUSD}</strong>)
            </p>
          </div>

          <p className="text-xs text-stone-400 leading-relaxed">
            Shows how many dollars the bot makes for every $1 it loses. A score above 1.75 is considered excellent by professional funds.
          </p>

          <div className="pt-2 border-t border-stone-800/80 text-[10px] text-stone-500 leading-tight">
            Status: {verification.profitFactorPassed ? 'Passed ✓ Strong overall profit factor' : 'Evaluating'}
          </div>
        </div>

        {/* Benchmark 4: Maximum Drawdown */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-rose-500/40 transition-colors space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20">
                <ArrowDownRight className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-stone-200">4. Maximum Drawdown (Dip)</span>
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
              <span className="text-xs text-stone-400 font-medium">Largest Portfolio Dip</span>
            </div>
            <p className="text-[11px] text-stone-300 mt-1">
              The biggest dip your balance took from its highest point.
            </p>
          </div>

          <p className="text-xs text-stone-400 leading-relaxed">
            On your <strong className="text-stone-200">$100 starting balance</strong>, this keeps dips strictly below <strong className="text-amber-400">$8.00</strong> so your capital stays protected.
          </p>

          <div className="pt-2 border-t border-stone-800/80 text-[10px] text-stone-500 leading-tight">
            10-slot limit ensures one stopped trade only risks $0.25 (0.25% of your portfolio).
          </div>
        </div>

        {/* Benchmark 5: Fee-Adjusted Mathematical Expectancy */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-amber-500/40 transition-colors space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Award className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-stone-200">5. Average Profit Per Trade</span>
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
                verification.expectancyUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}>
                {verification.expectancyUSD >= 0 ? '+' : ''}${verification.expectancyUSD.toFixed(3)}
              </span>
              <span className="text-xs text-stone-400 font-medium">per $10 trade</span>
            </div>
            <p className="text-[11px] text-stone-300 mt-1">
              Net expected profit after subtracting exchange fees (<strong className="text-rose-400">-${verification.totalFeesUSD.toFixed(2)}</strong>).
            </p>
          </div>

          <p className="text-xs text-stone-400 leading-relaxed">
            Every time the bot opens and closes a $10 trade, you earn this average amount on repeat.
          </p>

          <div className="pt-2 border-t border-stone-800/80 text-[10px] text-stone-500 leading-tight">
            Positive number means repeating this process mathematically grows your balance over time.
          </div>
        </div>

        {/* Benchmark 6: Zero-Risk Ratchet Rate */}
        <div className="p-5 rounded-2xl bg-stone-900 border border-stone-800 hover:border-emerald-500/40 transition-colors space-y-3">
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
              <span className="text-xs text-stone-400 font-medium">Trades with stop at breakeven</span>
            </div>
            <p className="text-[11px] text-stone-300 mt-1">
              Trades reaching Step 1 (+4%): <strong className="text-emerald-400">{verification.zeroRiskRatchetRatePct}%</strong>
            </p>
          </div>

          <p className="text-xs text-stone-400 leading-relaxed">
            The percentage of trades where the bot successfully takes first profit and moves the stop loss up, guaranteeing the trade cannot end in a loss.
          </p>

          <div className="pt-2 border-t border-stone-800/80 text-[10px] text-stone-500 leading-tight">
            Guarantees profits are protected once the price moves in our direction.
          </div>
        </div>
      </div>

      {/* Cumulative Performance & ROI Chart Section */}
      <div id="metrics-cumulative-charts-card" className="p-6 rounded-2xl bg-stone-900 border border-stone-800 space-y-4 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <h3 className="text-base font-bold text-stone-100">
                {activeChartTab === 'daily'
                  ? 'Daily Performance: Total Portfolio Value Fluctuations'
                  : activeChartTab === 'roi'
                  ? 'Cumulative ROI of Completed Trades Over Time'
                  : 'Trade-by-Trade Equity Growth Curve ($100 Starting Treasury)'}
              </h3>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              {activeChartTab === 'daily'
                ? 'Chronological daily portfolio value growth curve with intra-day volatility bounds and daily net PnL'
                : activeChartTab === 'roi'
                ? 'Chronological return on investment curve across every closed trade cycle'
                : 'Sequence of trade realizations showing net growth after 0.10% Binance spot commissions'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* View Selector Toggle Buttons */}
            <div className="flex items-center p-1 rounded-xl bg-stone-950 border border-stone-800 text-xs">
              <button
                id="toggle-chart-daily-performance"
                onClick={() => setActiveChartTab('daily')}
                className={`px-3 py-1.5 rounded-lg font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
                  activeChartTab === 'daily'
                    ? 'bg-emerald-500 text-stone-950 shadow-sm'
                    : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                <Calendar className="w-3.5 h-3.5" />
                <span>Daily Performance ($)</span>
              </button>
              <button
                id="toggle-chart-portfolio-equity"
                onClick={() => setActiveChartTab('equity')}
                className={`px-3 py-1.5 rounded-lg font-bold transition-colors cursor-pointer ${
                  activeChartTab === 'equity'
                    ? 'bg-emerald-500 text-stone-950 shadow-sm'
                    : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                Trade Equity ($)
              </button>
              <button
                id="toggle-chart-cumulative-roi"
                onClick={() => setActiveChartTab('roi')}
                className={`px-3 py-1.5 rounded-lg font-bold transition-colors cursor-pointer ${
                  activeChartTab === 'roi'
                    ? 'bg-emerald-500 text-stone-950 shadow-sm'
                    : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                Cumulative ROI (%)
              </button>
            </div>

            {activeChartTab === 'daily' ? (
              <div className="hidden sm:flex items-center gap-3 text-xs border-l border-stone-800 pl-3">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                  <span className="text-stone-400">Current:</span>
                  <span className={`font-bold ${dailyStats.currentValue >= 100 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    ${dailyStats.currentValue.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                  <span className="text-stone-400">Peak:</span>
                  <span className="font-bold text-stone-100">
                    ${dailyStats.peakValue.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-cyan-400"></span>
                  <span className="text-stone-400">Best Day:</span>
                  <span className="font-bold text-emerald-400">
                    {dailyStats.bestDay.pnl >= 0 ? '+' : ''}${dailyStats.bestDay.pnl.toFixed(2)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="hidden sm:flex items-center gap-3 text-xs border-l border-stone-800 pl-3">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                  <span className="text-stone-400">Total ROI:</span>
                  <span className="font-bold text-emerald-400">
                    {verification.netRealizedPnLUSD >= 0 ? '+' : ''}{((verification.netRealizedPnLUSD / 100) * 100).toFixed(2)}%
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                  <span className="text-stone-400">Net PnL:</span>
                  <span className="font-bold text-stone-100">
                    {verification.netRealizedPnLUSD >= 0 ? '+' : ''}${verification.netRealizedPnLUSD.toFixed(2)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Chart Canvas */}
        <div className="h-72 w-full pt-2">
          <ResponsiveContainer width="100%" height="100%">
            {activeChartTab === 'daily' ? (
              dailyChartMode === 'curve' ? (
                <AreaChart data={dailyPerformanceData} margin={{ top: 12, right: 20, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dailyEquityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#292524" vertical={false} />
                  <XAxis 
                    dataKey="date" 
                    stroke="#78716c" 
                    fontSize={11} 
                    tickLine={false} 
                  />
                  <YAxis 
                    domain={['auto', 'auto']} 
                    stroke="#78716c" 
                    fontSize={11} 
                    tickLine={false} 
                    tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
                  />
                  <Tooltip 
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const data = payload[0].payload;
                      return (
                        <div className="p-3 bg-stone-950 border border-stone-800 rounded-xl shadow-xl text-xs space-y-1.5 min-w-[210px]">
                          <div className="flex items-center justify-between border-b border-stone-800 pb-1.5">
                            <span className="font-bold text-stone-200">{data.date}</span>
                            <span className="text-[10px] text-stone-400 font-mono">{data.isoDate !== 'start' ? data.isoDate : 'Baseline'}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-stone-400">Portfolio Value:</span>
                            <span className="font-black text-stone-100 text-sm">${Number(data.portfolioValue).toFixed(2)}</span>
                          </div>
                          {data.isoDate !== 'start' && (
                            <>
                              <div className="flex items-center justify-between">
                                <span className="text-stone-400">Day Net PnL:</span>
                                <span className={`font-bold ${data.dailyPnlUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                  {data.dailyPnlUSD >= 0 ? '+' : ''}${Number(data.dailyPnlUSD).toFixed(2)} ({data.dailyPnlPct >= 0 ? '+' : ''}{data.dailyPnlPct}%)
                                </span>
                              </div>
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="text-stone-400">Day High / Low:</span>
                                <span className="font-mono text-stone-300">${data.dayHigh} / ${data.dayLow}</span>
                              </div>
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="text-stone-400">Trades Completed:</span>
                                <span className="text-stone-300">{data.tradesCount} ({data.wins}W - {data.losses}L · {data.winRate}%)</span>
                              </div>
                              {data.symbols && (
                                <div className="pt-1 border-t border-stone-800/80 text-[10px] text-stone-400 truncate max-w-[200px]">
                                  Coins: <span className="text-stone-300">{data.symbols}</span>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    }}
                  />
                  <ReferenceLine y={100} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: 'Start $100', fill: '#f59e0b', fontSize: 10 }} />
                  <Area 
                    type="monotone" 
                    dataKey="portfolioValue" 
                    name="Portfolio Value"
                    stroke="#10b981" 
                    strokeWidth={2.5} 
                    fillOpacity={1} 
                    fill="url(#dailyEquityGrad)" 
                    dot={{ r: 4, fill: '#10b981', stroke: '#0c0a09', strokeWidth: 2 }}
                    activeDot={{ r: 6, fill: '#34d399', stroke: '#ffffff', strokeWidth: 2 }}
                  />
                </AreaChart>
              ) : (
                <BarChart data={dailyPerformanceData.filter(d => d.isoDate !== 'start')} margin={{ top: 12, right: 20, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#292524" vertical={false} />
                  <XAxis 
                    dataKey="date" 
                    stroke="#78716c" 
                    fontSize={11} 
                    tickLine={false} 
                  />
                  <YAxis 
                    stroke="#78716c" 
                    fontSize={11} 
                    tickLine={false} 
                    tickFormatter={(v) => `${v > 0 ? '+' : ''}$${Number(v).toFixed(1)}`}
                  />
                  <Tooltip 
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const data = payload[0].payload;
                      return (
                        <div className="p-3 bg-stone-950 border border-stone-800 rounded-xl shadow-xl text-xs space-y-1.5 min-w-[200px]">
                          <div className="flex items-center justify-between border-b border-stone-800 pb-1.5">
                            <span className="font-bold text-stone-200">{data.date}</span>
                            <span className="text-[10px] text-stone-400 font-mono">{data.isoDate}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-stone-400">Day Net PnL:</span>
                            <span className={`font-bold ${data.dailyPnlUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {data.dailyPnlUSD >= 0 ? '+' : ''}${Number(data.dailyPnlUSD).toFixed(2)} ({data.dailyPnlPct >= 0 ? '+' : ''}{data.dailyPnlPct}%)
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-stone-400">End Portfolio:</span>
                            <span className="font-bold text-stone-100">${Number(data.portfolioValue).toFixed(2)}</span>
                          </div>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-stone-400">Trades:</span>
                            <span className="text-stone-300">{data.tradesCount} ({data.wins}W / {data.losses}L · {data.winRate}%)</span>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <ReferenceLine y={0} stroke="#78716c" strokeDasharray="3 3" />
                  <Bar dataKey="dailyPnlUSD" radius={[4, 4, 0, 0]}>
                    {dailyPerformanceData.filter(d => d.isoDate !== 'start').map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={entry.dailyPnlUSD >= 0 ? '#10b981' : '#f43f5e'} 
                      />
                    ))}
                  </Bar>
                </BarChart>
              )
            ) : activeChartTab === 'roi' ? (
              <LineChart data={cumulativeRoiData} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#292524" vertical={false} />
                <XAxis 
                  dataKey="name" 
                  stroke="#78716c" 
                  fontSize={11} 
                  tickLine={false} 
                />
                <YAxis 
                  domain={['auto', 'auto']} 
                  stroke="#78716c" 
                  fontSize={11} 
                  tickLine={false} 
                  tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`}
                />
                <Tooltip 
                  contentStyle={{
                    backgroundColor: '#0c0a09',
                    borderColor: '#292524',
                    borderRadius: '0.75rem',
                    fontSize: '0.75rem',
                    color: '#f5f5f4',
                    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)'
                  }}
                  formatter={(val: any) => [
                    `${Number(val) >= 0 ? '+' : ''}${Number(val).toFixed(2)}%`, 
                    'Cumulative ROI'
                  ]}
                  labelFormatter={(label, payload) => {
                    const item = payload?.[0]?.payload;
                    if (!item) return label;
                    return `${label} (${item.date}) · Realized: ${item.netPnL >= 0 ? '+' : ''}$${item.netPnL.toFixed(2)}`;
                  }}
                />
                <ReferenceLine y={0} stroke="#78716c" strokeDasharray="3 3" label={{ value: '0% Baseline', fill: '#78716c', fontSize: 10 }} />
                <Line 
                  type="monotone" 
                  dataKey="cumulativeRoiPct" 
                  name="Cumulative ROI"
                  stroke="#10b981" 
                  strokeWidth={2.5} 
                  dot={{ r: 4, fill: '#10b981', stroke: '#0c0a09', strokeWidth: 2 }}
                  activeDot={{ r: 6, fill: '#34d399', stroke: '#ffffff', strokeWidth: 2 }}
                />
              </LineChart>
            ) : (
              <AreaChart data={equityCurveData} margin={{ top: 10, right: 15, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <XAxis 
                  dataKey="name" 
                  stroke="#57534e" 
                  fontSize={11} 
                  tickLine={false} 
                />
                <YAxis 
                  domain={['auto', 'auto']} 
                  stroke="#57534e" 
                  fontSize={11} 
                  tickLine={false} 
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip 
                  contentStyle={{
                    backgroundColor: '#0c0a09',
                    borderColor: '#292524',
                    borderRadius: '0.75rem',
                    fontSize: '0.75rem',
                    color: '#f5f5f4'
                  }}
                  formatter={(val: any, name: any) => [
                    `$${Number(val).toFixed(2)}`, 
                    name === 'equity' ? 'Portfolio Value' : 'Net PnL'
                  ]}
                />
                <ReferenceLine y={100} stroke="#78716c" strokeDasharray="3 3" label={{ value: 'Start $100', fill: '#78716c', fontSize: 10 }} />
                <Area 
                  type="monotone" 
                  dataKey="equity" 
                  stroke="#10b981" 
                  strokeWidth={2.5} 
                  fillOpacity={1} 
                  fill="url(#equityGrad)" 
                />
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>

        {/* Daily Performance Breakdown Cards & Sub-mode Switcher */}
        {activeChartTab === 'daily' && (
          <div className="pt-4 border-t border-stone-800 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-xs font-bold text-stone-200">Daily Historical Sessions Ledger</span>
                <span className="text-[11px] text-stone-400">
                  ({dailyStats.greenDays} Green / {dailyStats.redDays} Red · {dailyStats.totalDays} Days)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-stone-500 uppercase font-semibold">Graph Mode:</span>
                <div className="flex items-center p-0.5 rounded-lg bg-stone-950 border border-stone-800 text-[11px]">
                  <button
                    onClick={() => setDailyChartMode('curve')}
                    className={`px-2.5 py-1 rounded-md font-semibold cursor-pointer transition-colors ${
                      dailyChartMode === 'curve' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-stone-400 hover:text-stone-200'
                    }`}
                  >
                    Value Curve ($)
                  </button>
                  <button
                    onClick={() => setDailyChartMode('bars')}
                    className={`px-2.5 py-1 rounded-md font-semibold cursor-pointer transition-colors ${
                      dailyChartMode === 'bars' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-stone-400 hover:text-stone-200'
                    }`}
                  >
                    PnL Bars ($)
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {dailyPerformanceData.filter(d => d.isoDate !== 'start').map((d) => {
                const isGreen = d.dailyPnlUSD >= 0;
                return (
                  <div 
                    key={d.isoDate} 
                    className="p-3.5 rounded-xl bg-stone-950/80 border border-stone-800/90 hover:border-stone-700 transition-colors space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-stone-200 text-xs flex items-center gap-1.5">
                        <Calendar className="w-3 h-3 text-amber-400" />
                        {d.date}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        isGreen ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                      }`}>
                        {isGreen ? '+' : ''}${d.dailyPnlUSD.toFixed(2)} ({isGreen ? '+' : ''}{d.dailyPnlPct}%)
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px] pt-1 border-t border-stone-800/60">
                      <div>
                        <span className="text-stone-500 block text-[10px]">End Portfolio</span>
                        <span className="font-black text-stone-100">${d.portfolioValue.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-stone-500 block text-[10px]">Day Range (L/H)</span>
                        <span className="font-mono text-stone-300 text-[10px]">${d.dayLow} - ${d.dayHigh}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-stone-400 pt-1 border-t border-stone-800/60">
                      <span>{d.tradesCount} Trades ({d.wins}W / {d.losses}L)</span>
                      <span className="font-semibold text-stone-300">{d.winRate}% Win</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Asset-by-Asset Statistical Breakdown Table */}
      <div className="p-6 rounded-2xl bg-stone-900 border border-stone-800 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-stone-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-amber-400" />
              Per-Asset Performance & Win Rate Attribution
            </h3>
            <p className="text-xs text-stone-400">
              Breakdown of trade count, win percentage, realized dollar gain, and dynamic ratchet protections per cryptocurrency
            </p>
          </div>
          <span className="text-xs text-stone-400 font-medium">
            {assetBreakdown.length} unique symbols traded
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-stone-800 text-stone-400 font-semibold uppercase tracking-wider text-[10px]">
                <th className="py-2.5 px-3">Asset</th>
                <th className="py-2.5 px-3 text-center">Tranches</th>
                <th className="py-2.5 px-3 text-center">Win / Loss</th>
                <th className="py-2.5 px-3 text-center">Win Rate %</th>
                <th className="py-2.5 px-3 text-center">Breakeven Stops</th>
                <th className="py-2.5 px-3 text-right">Net Realized PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-800/60 font-medium">
              {assetBreakdown.map((item) => (
                <tr key={item.symbol} className="hover:bg-stone-800/40 transition-colors">
                  <td className="py-3 px-3">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-stone-100">{item.symbol}</span>
                      <span className="text-[11px] text-stone-400">{item.coinName}</span>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-center text-stone-300">
                    {item.trades}
                  </td>
                  <td className="py-3 px-3 text-center text-stone-300">
                    <span className="text-emerald-400">{item.wins}W</span> - <span className="text-rose-400">{item.losses}L</span>
                  </td>
                  <td className="py-3 px-3 text-center">
                    <span className={`px-2 py-0.5 rounded font-bold text-[11px] ${
                      item.winRate >= 60 
                        ? 'bg-emerald-500/20 text-emerald-300' 
                        : item.winRate >= 45 
                        ? 'bg-amber-500/20 text-amber-300' 
                        : 'bg-rose-500/20 text-rose-300'
                    }`}>
                      {item.winRate}%
                    </span>
                  </td>
                  <td className="py-3 px-3 text-center">
                    <span className="inline-flex items-center gap-1 text-amber-300 font-semibold">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      {item.ratchetHits}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-right">
                    <span className={`font-bold ${item.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {item.pnl >= 0 ? '+' : ''}${item.pnl.toFixed(2)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Interactive Quantitative Strategy Simulator ("What-If" Calculator) */}
      <div className="p-6 rounded-2xl bg-stone-900/90 border border-amber-500/30 space-y-5">
        <div className="flex items-center gap-2 pb-2 border-b border-stone-800">
          <Sliders className="w-5 h-5 text-amber-400" />
          <div>
            <h3 className="text-base font-bold text-stone-100">
              Interactive What-If Profitability Simulator
            </h3>
            <p className="text-xs text-stone-400">
              Model how adjustments to your Win Rate and Risk-to-Reward (R:R) impact long-term capital compounding
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Controls */}
          <div className="space-y-4 lg:col-span-2">
            
            {/* Win Rate Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-stone-300">Model Win Rate:</span>
                <span className="font-mono font-bold text-emerald-400 text-sm">{simWinRate}%</span>
              </div>
              <input 
                type="range" 
                min="35" 
                max="85" 
                step="1"
                value={simWinRate}
                onChange={(e) => setSimWinRate(Number(e.target.value))}
                className="w-full accent-emerald-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-stone-500">
                <span>35% (Pessimistic)</span>
                <span>55% (Break-even Target)</span>
                <span>85% (Optimal Confluence)</span>
              </div>
            </div>

            {/* Payoff Ratio Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-stone-300">Model Risk-to-Reward (Payoff R:R):</span>
                <span className="font-mono font-bold text-amber-400 text-sm">{simPayoffRR.toFixed(1)}:1</span>
              </div>
              <input 
                type="range" 
                min="1.0" 
                max="5.0" 
                step="0.1"
                value={simPayoffRR}
                onChange={(e) => setSimPayoffRR(Number(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-stone-500">
                <span>1.0:1 (Flat)</span>
                <span>2.5:1 (Standard Ladder)</span>
                <span>5.0:1 (Extended Runners)</span>
              </div>
            </div>

            {/* Trade Horizon Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-stone-300">Sample Simulation Horizon:</span>
                <span className="font-mono font-bold text-stone-200 text-sm">{simTradeCount} Trades</span>
              </div>
              <input 
                type="range" 
                min="10" 
                max="200" 
                step="10"
                value={simTradeCount}
                onChange={(e) => setSimTradeCount(Number(e.target.value))}
                className="w-full accent-stone-400 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-stone-500">
                <span>10 Trades (Micro)</span>
                <span>50 Trades (Medium)</span>
                <span>200 Trades (Quarterly)</span>
              </div>
            </div>
          </div>

          {/* Outcome Projection Card */}
          <div className="p-5 rounded-xl bg-stone-950 border border-stone-800 flex flex-col justify-between space-y-4">
            <div>
              <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider block mb-1">
                Projected Model Output ($10 Tranches)
              </span>
              <div className="flex items-baseline gap-2">
                <span className={`text-3xl font-black ${simTotalExpectedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {simTotalExpectedPnL >= 0 ? '+' : ''}${simTotalExpectedPnL.toFixed(2)}
                </span>
                <span className="text-xs text-stone-400 font-medium">Net PnL</span>
              </div>
              <p className="text-xs text-stone-400 mt-1">
                Projected Portfolio: <strong className="text-stone-100">${(100 + simTotalExpectedPnL).toFixed(2)}</strong>
              </p>
            </div>

            <div className="space-y-1.5 text-[11px] pt-3 border-t border-stone-800 text-stone-400">
              <div className="flex justify-between">
                <span>Avg Win / Tranche:</span>
                <span className="text-emerald-400 font-semibold">+${simAvgWin.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Avg Stop Loss:</span>
                <span className="text-rose-400 font-semibold">-${simLossRisk.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Net Math Expectancy:</span>
                <span className={`font-bold ${simExpectedPerTrade >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {simExpectedPerTrade >= 0 ? '+' : ''}${simExpectedPerTrade.toFixed(3)} / trade
                </span>
              </div>
            </div>

            <div className="p-2 rounded-lg bg-stone-900 border border-stone-800 text-[10px] text-stone-400 leading-tight">
              Notice: Even with a 45% Win Rate, an R:R above 2.2:1 yields positive compounding!
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
