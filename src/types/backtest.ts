/**
 * Result of one backtest run (src/backtest/runBacktest.ts, tools/backtest.mjs).
 * Written as JSON to data/backtests/ and read by the Backtest Lab view.
 */
import type { StrategyProfileId } from '../config/geometry';

export interface BacktestSettings {
  /** A live-engine profile (StrategyProfileId), or a strategy module such as TREND_PULLBACK_DEMAND. */
  profile: StrategyProfileId | 'TREND_PULLBACK_DEMAND';
  /** The strategy's rules in words, shown with the result. */
  rules?: string[];
  /** Named variant, e.g. "no BTC filter", when a rule was switched off. */
  variant?: string;
  allowShorts: boolean;
  /** ms, inclusive */
  from: number;
  /** ms, exclusive */
  to: number;
  startingCapitalUSD: number;
  /** Symbols with data in the range. */
  symbols: string[];
  /** Level gates on (ENTRY_GATES not off). */
  entryGates: boolean;
  minScore: number;
  maxConcurrentTrades: number;
  costPerSidePct: number;
  /** Where the candles came from, e.g. data/klines2024 (5m). */
  dataSource: string;
  /** Hours before a flat trade is recycled, or null when the recycle was off. */
  staleRecycleHours: number | null;
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  positionSizeUSD: number;
  /** Gross, as the engine records it. */
  pnlUSD: number;
  feesUSD: number;
  netUSD: number;
  /** Net P&L as a percent of the position. */
  netReturnPct: number;
  /** Net P&L as a multiple of the dollar risk at entry (1R = stop distance x size). */
  rMultiple: number;
  exitReason: string;
  tiersHit: number;
  score: number;
  holdHours: number;
}

export interface BacktestPoint {
  t: number;
  /** Mark-to-market equity: cash + open positions at the bar close. */
  equityUSD: number;
  /** Percent below the running peak of equityUSD (0 or negative). */
  drawdownPct: number;
  openPositions: number;
  /** The starting capital held in BTC instead, for comparison. */
  btcHoldUSD: number;
}

export interface BacktestPeriodRow {
  key: string;
  trades: number;
  wins: number;
  netUSD: number;
  feesUSD: number;
  /** Month rows: net P&L as a percent of equity at the start of the month. */
  returnPct?: number;
}

export interface BacktestSummary {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number;
  netProfitUSD: number;
  grossProfitUSD: number;
  feesUSD: number;
  totalReturnPct: number;
  /** Infinity is written as null in JSON. */
  profitFactor: number | null;
  expectancyUSD: number;
  avgR: number;
  avgWinUSD: number;
  avgLossUSD: number;
  maxDrawdownPct: number;
  maxDrawdownUSD: number;
  avgHoldHours: number;
  tradesPerMonth: number;
  bestTradeUSD: number;
  worstTradeUSD: number;
  endingEquityUSD: number;
  /** Buy and hold of an equal-weight basket of the backtested coins, for comparison. */
  benchmarkReturnPct: number;
  /** Buy and hold of BTC over the same span. */
  btcReturnPct: number;
}

export interface BacktestResult {
  id: string;
  createdAt: number;
  durationMs: number;
  settings: BacktestSettings;
  summary: BacktestSummary;
  /** Hourly points. */
  equity: BacktestPoint[];
  monthly: BacktestPeriodRow[];
  bySymbol: BacktestPeriodRow[];
  byExitReason: BacktestPeriodRow[];
  byDirection: BacktestPeriodRow[];
  /** Why the auto-pilot did not deploy, counted once per 5-minute step. */
  skipReasons: Array<{ reason: string; steps: number }>;
  trades: BacktestTrade[];
  /** What this run cannot reproduce from history, stated with the result. */
  limitations: string[];
}
