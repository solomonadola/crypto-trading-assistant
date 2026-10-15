// Results per model and per speed group (ENGINE_PLAN.md Section 18.7): from
// closed trades (what the engine actually did) and from followed signals
// (every confirmed signal, taken or skipped, tracked to its stop, take-profit
// or max hold). Pure.

export interface ResultRow {
  setup: string;
  speed: string;
  /** Result in multiples of the risk at entry. */
  r: number;
}

export interface ResultLine {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  avgR: number;
  totalR: number;
}

function line(key: string, rows: ResultRow[]): ResultLine {
  const wins = rows.filter((x) => x.r > 0).length;
  const totalR = rows.reduce((a, x) => a + x.r, 0);
  return { key, trades: rows.length, wins, winRate: rows.length ? wins / rows.length : 0, avgR: rows.length ? totalR / rows.length : 0, totalR };
}

/** All rows, then one line per model and one per speed group, each sorted by key. */
export function summarize(rows: ResultRow[]): { all: ResultLine; byModel: ResultLine[]; bySpeed: ResultLine[] } {
  const by = (pick: (x: ResultRow) => string) =>
    [...new Set(rows.map(pick))].sort().map((k) => line(k, rows.filter((x) => pick(x) === k)));
  return { all: line('all', rows), byModel: by((x) => x.setup), bySpeed: by((x) => x.speed) };
}

export interface ForwardTestBenchmark {
  model: string;
  label: string;
  window: string;
  targetTrades: number;
  winRatePct: number;
  avgR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgHoldMin: number;
  rules: string[];
}

export interface ForwardTestLive {
  tradesCount: number;
  targetTrades: number;
  progressPct: number;
  winsCount: number;
  lossesCount: number;
  winRatePct: number;
  avgR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgHoldMin: number;
  status: 'awaiting_signals' | 'accumulating_sample' | 'edge_confirmed' | 'divergence_warning';
}

export interface ForwardTestReport {
  benchmark: ForwardTestBenchmark;
  live: ForwardTestLive;
}

export const HTF_POI_BENCHMARK: ForwardTestBenchmark = {
  model: 'htf_poi',
  label: 'Institutional 4H POI Long-Only',
  window: '6-Month Out-of-Sample Validated (2026-04-01 to 2026-09-30)',
  targetTrades: 50,
  winRatePct: 53.3,
  avgR: 0.46,
  totalR: 6.9,
  profitFactor: 2.84,
  maxDrawdownPct: 2.74,
  avgHoldMin: 408,
  rules: [
    'Macro Dealing Range: 4H Discount (<= 48%)',
    'Institutional POI: 4H Demand Zone or Bullish FVG',
    'Execution Trigger: 15m CHoCH Confirmation',
    'Session Killzones: London (08:00–10:00) & NY (09:30–11:30)',
    'Opening Protection: 15m Entry Delay',
  ],
};

export function forwardTestStats(
  closedTrades: { setup?: string; pnl: number; riskUsd?: number; openedAt: number; closedAt: number }[],
  currentDrawdownPct = 0,
  targetTrades = 50,
): ForwardTestReport {
  const htfTrades = closedTrades.filter((t) => t.setup === 'htf_poi');
  const wins = htfTrades.filter((t) => t.pnl > 0);
  const losses = htfTrades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalR = htfTrades.reduce((s, t) => s + (t.riskUsd && t.riskUsd > 0 ? t.pnl / t.riskUsd : 0), 0);
  const avgR = htfTrades.length ? totalR / htfTrades.length : 0;
  const avgHoldMs = htfTrades.length ? htfTrades.reduce((s, t) => s + (t.closedAt - t.openedAt), 0) / htfTrades.length : 0;
  const winRatePct = htfTrades.length ? (wins.length / htfTrades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99.9 : 0;

  let status: ForwardTestLive['status'] = 'awaiting_signals';
  if (htfTrades.length > 0) {
    if (htfTrades.length < targetTrades) {
      status = 'accumulating_sample';
    } else {
      status = avgR >= 0.2 ? 'edge_confirmed' : 'divergence_warning';
    }
  }

  return {
    benchmark: HTF_POI_BENCHMARK,
    live: {
      tradesCount: htfTrades.length,
      targetTrades,
      progressPct: Math.min(100, Math.round((htfTrades.length / targetTrades) * 100)),
      winsCount: wins.length,
      lossesCount: losses.length,
      winRatePct: Math.round(winRatePct * 10) / 10,
      avgR: Math.round(avgR * 100) / 100,
      totalR: Math.round(totalR * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      maxDrawdownPct: Math.round(currentDrawdownPct * 100) / 100,
      avgHoldMin: Math.round(avgHoldMs / 60_000),
      status,
    },
  };
}

