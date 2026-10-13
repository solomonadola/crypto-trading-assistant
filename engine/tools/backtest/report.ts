// Formats and saves backtest reports in JSON and Markdown.
// Computes metrics per setup × timeframe × side, in-sample vs out-of-sample, and per-month Total R.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BacktestResult, PlacedOrderRecord } from './run';
import type { ClosedTradeView } from '../../../shared/types';

export interface GroupStats {
  group: string;
  ordersPlaced: number;
  ordersFilled: number;
  fillRatePct: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnl: number;
  totalR: number;
  avgR: number;
  profitFactor: number;
  avgHoldMin: number;
  exitReasons: Record<string, number>;
}

export interface MonthlyStats {
  month: string;
  trades: number;
  winRatePct: number;
  totalR: number;
  totalPnl: number;
  profitFactor: number;
}

export interface BacktestReportData {
  timestamp: string;
  label: string;
  from: string;
  to: string;
  split?: string;
  symbols: string[];
  maxDrawdownPct: number;
  overall: GroupStats;
  byGroup: GroupStats[];
  inSample?: { overall: GroupStats; byGroup: GroupStats[] };
  outOfSample?: { overall: GroupStats; byGroup: GroupStats[] };
  monthly: MonthlyStats[];
  rejections: Record<string, number>;
}

function calculateGroupStats(
  groupName: string,
  trades: ClosedTradeView[],
  orders: PlacedOrderRecord[],
): GroupStats {
  const ordersPlaced = orders.length;
  const ordersFilled = trades.length;
  const fillRatePct = ordersPlaced > 0 ? (ordersFilled / ordersPlaced) * 100 : 0;

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl <= 0).length;
  const winRatePct = trades.length > 0 ? (wins / trades.length) * 100 : 0;

  let grossWins = 0;
  let grossLosses = 0;
  let totalPnl = 0;
  let totalR = 0;
  let totalHoldMs = 0;
  const exitReasons: Record<string, number> = {};

  for (const t of trades) {
    totalPnl += t.pnl;
    if (t.pnl > 0) grossWins += t.pnl;
    else grossLosses += Math.abs(t.pnl);

    const risk = t.riskUsd && t.riskUsd > 0 ? t.riskUsd : 100;
    totalR += t.pnl / risk;
    totalHoldMs += Math.max(0, t.closedAt - t.openedAt);

    exitReasons[t.reason] = (exitReasons[t.reason] ?? 0) + 1;
  }

  const avgR = trades.length > 0 ? totalR / trades.length : 0;
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;
  const avgHoldMin = trades.length > 0 ? totalHoldMs / trades.length / 60_000 : 0;

  return {
    group: groupName,
    ordersPlaced,
    ordersFilled,
    fillRatePct,
    trades: trades.length,
    wins,
    losses,
    winRatePct,
    totalPnl,
    totalR,
    avgR,
    profitFactor,
    avgHoldMin,
    exitReasons,
  };
}

function computeMaxDrawdown(curve: Array<{ time: number; equity: number }>): number {
  if (curve.length < 2) return 0;
  let peak = curve[0].equity;
  let maxDd = 0;
  for (const pt of curve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak > 0 ? ((peak - pt.equity) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

export function generateReport(
  res: BacktestResult,
  opts: { label?: string; splitMs?: number } = {},
): BacktestReportData {
  const label = opts.label ?? 'baseline';
  const maxDrawdownPct = computeMaxDrawdown(res.equityCurve);

  // Helper to categorize trade
  const tradeKey = (t: ClosedTradeView) => {
    const meta = res.positionMeta.get(t.id);
    if (meta) return `${meta.kind} [${meta.tf}] ${t.side}`;
    if (t.setup) return `${t.setup} ${t.side}`;
    return `unknown ${t.side}`;
  };

  const orderKey = (o: PlacedOrderRecord) => `${o.kind} [${o.tf}] ${o.side}`;

  // Unique groups
  const groupSet = new Set<string>();
  for (const t of res.trades) groupSet.add(tradeKey(t));
  for (const o of res.ordersPlaced) groupSet.add(orderKey(o));
  const groups = [...groupSet].sort();

  const byGroup: GroupStats[] = groups.map((g) => {
    const subTrades = res.trades.filter((t) => tradeKey(t) === g);
    const subOrders = res.ordersPlaced.filter((o) => orderKey(o) === g);
    return calculateGroupStats(g, subTrades, subOrders);
  });

  const overall = calculateGroupStats('ALL TRADES', res.trades, res.ordersPlaced);

  // In-sample vs Out-of-sample
  let inSample: { overall: GroupStats; byGroup: GroupStats[] } | undefined;
  let outOfSample: { overall: GroupStats; byGroup: GroupStats[] } | undefined;

  if (opts.splitMs) {
    const isTrades = res.trades.filter((t) => t.openedAt < opts.splitMs!);
    const isOrders = res.ordersPlaced.filter((o) => o.time < opts.splitMs!);
    const oosTrades = res.trades.filter((t) => t.openedAt >= opts.splitMs!);
    const oosOrders = res.ordersPlaced.filter((o) => o.time >= opts.splitMs!);

    inSample = {
      overall: calculateGroupStats('IN-SAMPLE (ALL)', isTrades, isOrders),
      byGroup: groups.map((g) =>
        calculateGroupStats(g, isTrades.filter((t) => tradeKey(t) === g), isOrders.filter((o) => orderKey(o) === g))
      ),
    };
    outOfSample = {
      overall: calculateGroupStats('OUT-OF-SAMPLE (ALL)', oosTrades, oosOrders),
      byGroup: groups.map((g) =>
        calculateGroupStats(g, oosTrades.filter((t) => tradeKey(t) === g), oosOrders.filter((o) => orderKey(o) === g))
      ),
    };
  }

  // Monthly stats
  const monthMap = new Map<string, ClosedTradeView[]>();
  for (const t of res.trades) {
    const m = new Date(t.openedAt).toISOString().slice(0, 7);
    const arr = monthMap.get(m) ?? [];
    arr.push(t);
    monthMap.set(m, arr);
  }
  const monthly: MonthlyStats[] = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, list]) => {
    const st = calculateGroupStats(month, list, []);
    return {
      month,
      trades: st.trades,
      winRatePct: st.winRatePct,
      totalR: st.totalR,
      totalPnl: st.totalPnl,
      profitFactor: st.profitFactor,
    };
  });

  const rejectionsRecord: Record<string, number> = {};
  for (const [r, cnt] of res.rejections) rejectionsRecord[r] = cnt;

  return {
    timestamp: new Date().toISOString(),
    label,
    from: new Date(res.fromMs).toISOString().slice(0, 10),
    to: new Date(res.toMs).toISOString().slice(0, 10),
    split: opts.splitMs ? new Date(opts.splitMs).toISOString().slice(0, 10) : undefined,
    symbols: res.symbols,
    maxDrawdownPct,
    overall,
    byGroup,
    inSample,
    outOfSample,
    monthly,
    rejections: rejectionsRecord,
  };
}

export function formatReportMarkdown(r: BacktestReportData): string {
  const fNum = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '–');
  const fmtRow = (s: GroupStats) =>
    `| ${s.group.padEnd(28)} | ${String(s.ordersPlaced).padStart(6)} | ${String(s.trades).padStart(6)} | ${fNum(s.fillRatePct, 1).padStart(5)}% | ${fNum(s.winRatePct, 1).padStart(5)}% | ${fNum(s.avgR, 2).padStart(6)}R | ${fNum(s.totalR, 1).padStart(7)}R | ${fNum(s.profitFactor, 2).padStart(6)} | ${fNum(s.avgHoldMin, 0).padStart(5)}m |`;

  const header = `| Setup / Model               | Orders | Trades | Fill % |  Win % |  Avg R  | Total R |   PF   | AvgHold |
|:----------------------------|-------:|-------:|-------:|-------:|--------:|--------:|-------:|--------:|`;

  let md = `# Backtest Report: ${r.label.toUpperCase()}

- **Range:** ${r.from} to ${r.to} ${r.split ? `(Split: ${r.split})` : ''}
- **Symbols (${r.symbols.length}):** ${r.symbols.slice(0, 10).join(', ')}${r.symbols.length > 10 ? '...' : ''}
- **Max Drawdown:** ${r.maxDrawdownPct.toFixed(2)}%
- **Total Trades:** ${r.overall.trades} (Win Rate: ${r.overall.winRatePct.toFixed(1)}%, Total R: ${r.overall.totalR.toFixed(1)}R, PF: ${fNum(r.overall.profitFactor)})

---

## 1. Overall Performance by Setup & Timeframe

${header}
${fmtRow(r.overall)}
| --------------------------- | ------ | ------ | ------ | ------ | ------- | ------- | ------ | ------- |
${r.byGroup.map(fmtRow).join('\n')}

---
`;

  if (r.inSample && r.outOfSample) {
    md += `## 2. In-Sample vs Out-of-Sample Validation

### In-Sample (${r.from} to ${r.split})
${header}
${fmtRow(r.inSample.overall)}
${r.inSample.byGroup.filter((g) => g.trades > 0).map(fmtRow).join('\n')}

### Out-of-Sample (${r.split} to ${r.to})
${header}
${fmtRow(r.outOfSample.overall)}
${r.outOfSample.byGroup.filter((g) => g.trades > 0).map(fmtRow).join('\n')}

---
`;
  }

  md += `## 3. Monthly Breakdown

| Month   | Trades | Win %  | Total R  | Profit Factor | Net P&L (USDT) |
|:--------|-------:|-------:|---------:|--------------:|---------------:|
${r.monthly.map((m) => `| ${m.month} | ${String(m.trades).padStart(6)} | ${fNum(m.winRatePct, 1).padStart(5)}% | ${fNum(m.totalR, 1).padStart(7)}R | ${fNum(m.profitFactor, 2).padStart(12)} | $${fNum(m.totalPnl, 2).padStart(13)} |`).join('\n')}

---

## 4. Rejection Summary (Order Gate Filters)

| Reason | Count |
|:-------|------:|
${Object.entries(r.rejections).map(([reason, count]) => `| ${reason.padEnd(30)} | ${String(count).padStart(5)} |`).join('\n')}
`;

  return md;
}

export function writeReportFiles(report: BacktestReportData, outDir = 'data/backtest/reports'): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true });
  const ts = report.timestamp.replace(/[:.]/g, '-');
  const baseName = `${ts}-${report.label}`;
  const jsonPath = path.join(outDir, `${baseName}.json`);
  const mdPath = path.join(outDir, `${baseName}.md`);

  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, formatReportMarkdown(report), 'utf8');

  return { jsonPath, mdPath };
}

