// Stage B of the backtest: test combinations of the entry checks on the
// research trades, apply the portfolio rules and sizing, and score each
// combination separately on a tuning period and an unseen test period. Pure.
//
// A combination is chosen on the tuning period only; its test-period result is
// what says whether it holds up. Only that result is evidence.
import type { EngineConfig } from '../config';
import type { ResearchTrade } from './research';

export interface Settings {
  minRr: number;
  maxStopPct: number;
  minScore: number;
  /** Relative volume the trigger candle needs; null turns the fakeout filter off. */
  fakeoutRvol: number | null;
  /** Filters switched off (by failure name prefix, e.g. 'filter_chop'). */
  filtersOff: string[];
}

export interface Metrics {
  trades: number;
  wins: number;
  winRate: number;
  netUsd: number;
  profitFactor: number | null;
  maxDrawdownUsd: number;
  avgR: number;
  tradesPerWeek: number;
}

export interface Scored {
  settings: Settings;
  train: Metrics;
  test: Metrics;
}

const TOGGLEABLE = ['filter_chop', 'filter_squeeze', 'filter_stagnation', 'filter_room', 'filter_extension', 'filter_wicks'] as const;

/** Whether a trade's signal passes these settings. Session failures always block (the session rule is fixed). */
export function passes(t: ResearchTrade, s: Settings): boolean {
  if (t.rewardRisk < s.minRr || t.stopPct > s.maxStopPct || t.score < s.minScore) return false;
  for (const f of t.failures) {
    if (f === 'stop_too_wide' || f === 'rr_too_low' || f === 'score_too_low') continue;   // re-judged above
    if (f === 'filter_fakeout') continue;                                              // re-judged below
    if (s.filtersOff.some((off) => f.startsWith(off))) continue;
    return false;
  }
  if (s.fakeoutRvol !== null) {
    if (t.fakeoutOtherPass === false) return false;
    if (t.fakeoutRvol !== null && t.fakeoutRvol < s.fakeoutRvol) return false;
  }
  return true;
}

/**
 * The trades these settings would have taken, in time order, under the
 * portfolio rules: max open trades, one position per coin, trades per coin per
 * day, a cooldown after a loss on the coin. P&L uses the engine's sizing: 10%
 * of the starting balance, shrunk so the loss at the stop with costs is at
 * most 1% of it (no compounding, so periods compare fairly).
 */
export function simulate(trades: ResearchTrade[], s: Settings, cfg: EngineConfig, from: number, to: number): Metrics {
  const start = cfg.starting_balance_usdt;
  const costPct = 2 * (cfg.sim.taker_fee_pct + cfg.sim.slippage_pct);
  const open: ResearchTrade[] = [];
  const perDay = new Map<string, number>();
  const lastLoss = new Map<string, number>();
  const taken: { t: ResearchTrade; pnl: number }[] = [];
  for (const t of trades) {
    if (t.openedAt < from || t.openedAt >= to || !passes(t, s)) continue;
    for (let i = open.length - 1; i >= 0; i--) if (open[i].closedAt <= t.openedAt) open.splice(i, 1);
    if (open.length >= cfg.allocation.max_open_trades || open.some((o) => o.symbol === t.symbol)) continue;
    const dayKey = `${t.symbol}|${Math.floor(t.openedAt / 86_400_000)}`;
    if ((perDay.get(dayKey) ?? 0) >= cfg.risk.max_trades_per_symbol_per_day) continue;
    const loss = lastLoss.get(t.symbol);
    if (loss !== undefined && t.openedAt - loss < cfg.risk.cooldown_after_loss_min * 60_000 && loss <= t.openedAt) continue;
    open.push(t);
    perDay.set(dayKey, (perDay.get(dayKey) ?? 0) + 1);
    const notional = Math.min((cfg.allocation.flat_capital_pct / 100) * start, ((cfg.allocation.max_loss_per_trade_pct / 100) * start) / ((t.stopPct + costPct) / 100));
    const pnl = t.r * notional * (t.stopPct / 100);
    taken.push({ t, pnl });
    if (pnl < 0) lastLoss.set(t.symbol, t.closedAt);
  }
  return metrics(taken, from, to);
}

function metrics(taken: { t: ResearchTrade; pnl: number }[], from: number, to: number): Metrics {
  const wins = taken.filter((x) => x.pnl > 0);
  const gross = wins.reduce((a, x) => a + x.pnl, 0);
  const lost = -taken.filter((x) => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
  let peak = 0;
  let equity = 0;
  let dd = 0;
  for (const x of [...taken].sort((a, b) => a.t.closedAt - b.t.closedAt)) {
    equity += x.pnl;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return {
    trades: taken.length,
    wins: wins.length,
    winRate: taken.length ? wins.length / taken.length : 0,
    netUsd: gross - lost,
    profitFactor: lost > 0 ? gross / lost : gross > 0 ? null : 0,
    maxDrawdownUsd: dd,
    avgR: taken.length ? taken.reduce((a, x) => a + x.t.r, 0) / taken.length : 0,
    tradesPerWeek: taken.length / ((to - from) / (7 * 86_400_000)),
  };
}

/** Every combination of the grid. */
export function grid(): Settings[] {
  const out: Settings[] = [];
  const offSets: string[][] = [];
  for (let mask = 0; mask < 1 << TOGGLEABLE.length; mask++) offSets.push(TOGGLEABLE.filter((_, i) => mask & (1 << i)));
  for (const minRr of [0.8, 1, 1.2, 1.5, 2])
    for (const maxStopPct of [2, 2.5, 3.5, 5])
      for (const minScore of [2, 3, 4, 5])
        for (const fakeoutRvol of [null, 1, 1.5, 2])
          for (const filtersOff of offSets) out.push({ minRr, maxStopPct, minScore, fakeoutRvol, filtersOff });
  return out;
}

/** The settings as configured, for comparison. */
export function configured(cfg: EngineConfig): Settings {
  return {
    minRr: cfg.exits.min_rr, maxStopPct: cfg.exits.max_stop_pct, minScore: cfg.scoring.min_score,
    fakeoutRvol: cfg.filters.fakeout.enabled ? cfg.filters.fakeout.min_rvol : null,
    filtersOff: TOGGLEABLE.filter((f) => !(cfg.filters as Record<string, { enabled: boolean }>)[f.replace('filter_', '')]?.enabled),
  };
}

export interface SearchResult {
  combinations: number;
  minTrainTrades: number;
  configured: Scored;
  best: Scored[];
}

/**
 * Scores every combination; the best are chosen by tuning-period profit factor
 * among those with enough tuning trades and a positive tuning result, and then
 * shown with their test-period result.
 */
export function search(trades: ResearchTrade[], cfg: EngineConfig, trainFrom: number, split: number, testTo: number, minTrainTrades = 40, top = 15): SearchResult {
  const sorted = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  const score = (s: Settings): Scored => ({ settings: s, train: simulate(sorted, s, cfg, trainFrom, split), test: simulate(sorted, s, cfg, split, testTo) });
  const all = grid().map(score);
  const eligible = all.filter((x) => x.train.trades >= minTrainTrades && x.train.netUsd > 0);
  eligible.sort((a, b) => (b.train.profitFactor ?? 99) - (a.train.profitFactor ?? 99) || b.train.netUsd - a.train.netUsd);
  return { combinations: all.length, minTrainTrades, configured: score(configured(cfg)), best: eligible.slice(0, top) };
}
