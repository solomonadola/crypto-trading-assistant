// Types shared by the engine, the API and the UI.

export type Timeframe = '1m' | '15m' | '1h' | '4h';

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
};

/**
 * When several candles close at the same moment (a 4h close is also a 1h, 15m
 * and 1m close), the larger timeframe is handed to the engine first, so the
 * analysis it feeds is current before the smaller timeframes act on it.
 */
export const TIMEFRAME_ORDER: Timeframe[] = ['4h', '1h', '15m', '1m'];

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
  | 'balance_reset';

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
