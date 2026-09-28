// Everything the pullback setup, the filters and the score read for one
// symbol at one 15m close, computed once from the market book. Pure.
import { TIMEFRAME_MS, type Candle, type Direction } from '../../../shared/types';
import type { EngineConfig } from '../config';
import type { MarketBook, SymbolAnalysis } from '../analysis/market';
import { adx, atr, bollingerWidth, choppiness, ema, rsi, rvol, swingPivots, vwapDaily, type Pivot } from '../analysis/indicators';

export interface Series {
  candles: Candle[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  quoteVolume: number[];
}

export function series(candles: Candle[]): Series {
  return {
    candles,
    open: candles.map((c) => c.open),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    volume: candles.map((c) => c.volume),
    quoteVolume: candles.map((c) => c.quoteVolume),
  };
}

export interface Context {
  symbol: string;
  /** Engine clock: close time of the 15m candle being evaluated. */
  t: number;
  config: EngineConfig;
  analysis: SymbolAnalysis;
  h4: Series;
  h1: Series;
  m15: Series;
  /** Latest 15m close: the price everything is measured against. */
  price: number;
  atr1h: number[];
  atr15m: number[];
  ema1h: Record<number, number[]>;
  ema15m20: number[];
  vwap15m: number[];
  rsi15m: number[];
  rvol15m: number[];
  adx1h: number[];
  chop1h: number[];
  bbw1h: number[];
  pivots1h: Pivot[];
  pivots15m: Pivot[];
  pivots4h: Pivot[];
  /** BTC's change over the last 60 minutes, percent; null if unknown. */
  btcChange1hPct: number | null;
  btcAnalysis: SymbolAnalysis | null;
  /** Latest funding rate as a fraction per 8h (0.0001 = 0.01%); null if unknown. */
  funding: number | null;
}

const last = (s: number[]) => s[s.length - 1];

/** Null when there is not enough history yet, or the symbol's last 15m candle did not close at `t`. */
export function buildContext(book: MarketBook, symbol: string, t: number, config: EngineConfig, funding: number | null): Context | null {
  const analysis = book.get(symbol);
  if (!analysis) return null;
  const m15 = series(book.recent(symbol, '15m'));
  const h1 = series(book.recent(symbol, '1h'));
  const h4 = series(book.recent(symbol, '4h'));
  if (m15.candles.length < 60 || h1.candles.length < 60 || h4.candles.length < 10) return null;
  if (m15.candles[m15.candles.length - 1].closeTime !== t) return null;

  const k = config.trend.swing_lookback;
  const emaLevels = [...new Set([20, 50, ...config.pullback.ema_levels])];
  // BTC over the hour to `t` on the exits timeframe: the candle closing at t and the one closing an hour earlier
  // (newer candles may already be stored when this is evaluated between 15m closes).
  const exitTf = config.timeframes.exits;
  const perHour = 3_600_000 / TIMEFRAME_MS[exitTf];
  const btc = book.recent('BTCUSDT', exitTf);
  let atT = -1;
  for (let i = btc.length - 1; i >= 0; i--) if (btc[i].closeTime === t) { atT = i; break; }
  const btcChange1hPct = atT >= perHour && btc[atT - perHour].closeTime === t - 3_600_000
    ? (btc[atT].close / btc[atT - perHour].close - 1) * 100
    : null;

  return {
    symbol, t, config, analysis, h4, h1, m15,
    price: last(m15.close),
    atr1h: atr(h1.high, h1.low, h1.close, 14),
    atr15m: atr(m15.high, m15.low, m15.close, 14),
    ema1h: Object.fromEntries(emaLevels.map((n) => [n, ema(h1.close, n)])),
    ema15m20: ema(m15.close, 20),
    vwap15m: vwapDaily({ openTime: m15.candles.map((c) => c.openTime), high: m15.high, low: m15.low, close: m15.close, volume: m15.volume }),
    rsi15m: rsi(m15.close, config.trigger.rsi_period),
    rvol15m: rvol(m15.volume, 20),
    adx1h: adx(h1.high, h1.low, h1.close, 14).adx,
    chop1h: choppiness(h1.high, h1.low, h1.close, 14),
    bbw1h: bollingerWidth(h1.close, 20, 2),
    pivots1h: swingPivots(h1.high, h1.low, k),
    pivots15m: swingPivots(m15.high, m15.low, k),
    pivots4h: swingPivots(h4.high, h4.low, k),
    btcChange1hPct,
    btcAnalysis: book.get('BTCUSDT'),
    funding,
  };
}

/** +1 for long, -1 for short: multiply a price move by it to get "in the trade's favour". */
export const sign = (d: Direction) => (d === 'long' ? 1 : -1);
export const lastOf = last;
