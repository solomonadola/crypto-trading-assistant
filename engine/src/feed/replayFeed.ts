// Stored candles, handed out in the same order the live feed uses
// (compareCandles). Used by tests and by restart recovery: the engine cannot
// tell replayed candles from live ones.
import { TIMEFRAME_MS, compareCandles, type Candle, type Timeframe } from '../../../shared/types';
import type { CandleStore } from './candleStore';

export interface ReplayOptions {
  symbols: string[];
  timeframes: Timeframe[];
  /** Candles that close in [from, to). */
  from: number;
  to: number;
  /** Read this much time from the store at once. */
  chunkMs?: number;
}

/** Yields batches: every candle closing in one chunk of time, in engine order. */
export function* replayCandles(store: CandleStore, opts: ReplayOptions): Generator<Candle[]> {
  const chunkMs = opts.chunkMs ?? 86_400_000;
  for (let start = opts.from; start < opts.to; start += chunkMs) {
    const end = Math.min(start + chunkMs, opts.to);
    const batch: Candle[] = [];
    for (const symbol of opts.symbols) {
      for (const tf of opts.timeframes) {
        const tfMs = TIMEFRAME_MS[tf];
        // closeTime in [start, end)  <=>  openTime in [start - tfMs, end - tfMs)
        batch.push(...store.range(symbol, tf, start - tfMs, end - tfMs - 1));
      }
    }
    if (batch.length) yield batch.sort(compareCandles);
  }
}
