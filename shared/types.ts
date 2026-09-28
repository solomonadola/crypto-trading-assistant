// Types shared by the engine, the API and the UI.

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h';

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
};

/**
 * When several candles close at the same moment (a 4h close is also a 1h, 15m
 * and 1m close), the larger timeframe is handed to the engine first, so the
 * analysis it feeds is current before the smaller timeframes act on it.
 */
export const TIMEFRAME_ORDER: Timeframe[] = ['4h', '1h', '15m', '5m', '1m'];

/** A closed candle. `closeTime` is the moment it completed: openTime + the timeframe's length. */
export interface Candle {
  symbol: string;
  tf: Timeframe;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Base-asset volume. */
  volume: number;
  /** USDT volume. */
  quoteVolume: number;
  trades: number;
}

/** Orders candles the way the engine must see them: by close time, then larger timeframe first, then symbol. */
export function compareCandles(a: Candle, b: Candle): number {
  return a.closeTime - b.closeTime
    || TIMEFRAME_ORDER.indexOf(a.tf) - TIMEFRAME_ORDER.indexOf(b.tf)
    || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
}

export type TradeEventType =
  | 'signal_taken'
  | 'order_placed'
  | 'order_filled'
  | 'order_cancelled'
  | 'stop_moved'
  | 'partial_closed'
  | 'funding_charged'
  | 'position_closed'
  | 'liquidated'
  | 'balance_reset'
  | 'engine_halted'
  | 'engine_resumed';

/** One row of the append-only trade log. Positions and balance are derived from these. */
export interface TradeEvent {
  id?: number;
  /** Engine clock (ms), not wall-clock time. */
  time: number;
  positionId: string | null;
  symbol: string | null;
  type: TradeEventType;
  payload: Record<string, unknown>;
  engineVersion: string;
  configHash: string;
}

export type Direction = 'long' | 'short';

/**
 * Stages a setup is recorded at (ENGINE_PLAN.md Section 8.4): armed at a
 * confluence area; expired without confirmation; or confirmed and then
 * taken (every check passed) or filtered (the first failing check is the reason).
 */
export type SignalStatus = 'armed' | 'expired' | 'taken' | 'filtered';

export interface SignalRecord {
  id?: number;
  /** Engine clock. */
  time: number;
  symbol: string;
  setup: 'pullback' | 'breakout';
  direction: Direction;
  status: SignalStatus;
  reason: string | null;
  payload: Record<string, unknown>;
}

/**
 * What a confirmed signal would have done if traded exactly as planned:
 * followed on 1m candles to its stop, first target or session end, with fees
 * and slippage, without touching the balance. Recorded for filtered signals
 * (and taken ones, for comparison), so the data shows what each filter saves
 * or costs.
 */
export interface ShadowResult {
  id?: number;
  /** When it resolved (engine clock). */
  time: number;
  signalTime: number;
  symbol: string;
  direction: Direction;
  signalStatus: 'taken' | 'filtered';
  signalReason: string | null;
  entry: number;
  stop: number;
  target: number;
  exit: number;
  outcome: 'stop' | 'target' | 'session_end';
  /** Result in multiples of the planned risk, after costs. */
  r: number;
}

export interface PositionView {
  id: string;
  symbol: string;
  side: Direction;
  qty: number;
  entryPrice: number;
  stop: number;
  target: number | null;
  price: number | null;
  unrealized: number;
  pnlPct: number;
  openedAt: number;
  sessionName: string | null;
  sessionClose: number | null;
  ladderStep: number;
  partialDone: boolean;
  pendingClose: string | null;
  fees: number;
  funding: number;
  realized: number;
}

export interface AccountSummary {
  time: number;
  startingBalance: number;
  balance: number;
  equity: number;
  unrealized: number;
  exposure: number;
  openRisk: number;
  dayPnl: number;
  peakEquity: number;
  drawdownPct: number;
  halted: { reason: string; at: number } | null;
  positions: PositionView[];
  pendingEntries: { positionId: string; symbol: string; side: Direction; notional: number; placedAt: number }[];
}

export interface ClosedTradeView {
  id: string;
  symbol: string;
  side: Direction;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  reason: string;
  session: string | null;
  signalId?: string | null;
  riskUsd?: number;
}

/** A price level where several sources agree. */
export interface KeyLevel {
  price: number;
  kind: 'support' | 'resistance';
  /** What the level is made of: zones, swing points, VWAP, EMAs, fib, ... */
  sources: string[];
  /** Sum of source weights: zones and 4h levels count more. */
  strength: number;
  /** Distance from the current price, percent (negative below). */
  distancePct: number;
}

export interface TradeIdeaTarget {
  label: string;
  price: number;
  sources: string[];
  /** Reward in multiples of the risk, after fees and slippage. */
  r: number;
}

export interface ChecklistItem {
  label: string;
  /** true met, false not met, null not decidable yet (e.g. waiting for a candle). */
  ok: boolean | null;
  detail: string;
}

export interface WatchLevel {
  kind: 'entry' | 'invalidation' | 'target' | 'breakout' | 'range_top' | 'range_bottom';
  label: string;
  price: number;
  /** From the current price, percent. */
  distancePct: number;
  why: string;
}

/** Advisory: key levels and a suggested plan for one coin. Separate from the engine's own entries. */
export interface TradeIdea {
  symbol: string;
  asOf: number;
  price: number;
  atr1h: number;
  bias: Direction | 'none';
  biasReason: string;
  trend: Record<'4h' | '1h' | '15m', string | null>;
  longState: string;
  shortState: string;
  levels: KeyLevel[];
  /** The direction the checklist is for: the bias, or the 4h lean when there is none. */
  checklistFor: Direction;
  checklist: ChecklistItem[];
  /** The prices to wait for, nearest first. */
  watch: WatchLevel[];
  plan: null | {
    direction: Direction;
    /** armed: the engine waits for confirmation; in_zone: price is in the entry area; wait: not there yet; no_level: nothing to enter from. */
    status: 'armed' | 'in_zone' | 'wait' | 'no_level';
    entryLow: number | null;
    entryHigh: number | null;
    entry: number | null;
    stop: number | null;
    riskPct: number | null;
    targets: TradeIdeaTarget[];
    /** Whether the plan fits the engine's stop and reward/risk limits. */
    meetsRules: boolean;
    note: string;
  };
}

export type FeedState = 'starting' | 'backfilling' | 'live' | 'stalled' | 'stopped';

export interface FeedStatus {
  state: FeedState;
  symbols: string[];
  /** Close time of the newest 1m candle received, per symbol. */
  lastCloseTime: Record<string, number>;
  lastError: string | null;
  /** Local clock minus Binance server time, ms. */
  clockOffsetMs: number;
}
