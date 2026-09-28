/**
 * Candle helpers shared by the backtests. No app services imported, so a
 * strategy backtest can be bundled without the live engine.
 */
import type { Candle } from '../services/candleService';

/** One coin's 5-minute candles, oldest first. */
export interface BarSeries {
  symbol: string;
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  /** base-asset volume */
  v: Float64Array;
  /** quote (USDT) volume */
  qv: Float64Array;
}

export function aggregate(s: BarSeries, len: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (let i = 0; i < s.t.length; i++) {
    const bucket = Math.floor(s.t[i] / len) * len;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], v: s.v[i] };
    } else {
      if (s.h[i] > cur.h) cur.h = s.h[i];
      if (s.l[i] < cur.l) cur.l = s.l[i];
      cur.c = s.c[i];
      cur.v += s.v[i];
    }
  }
  if (cur) out.push(cur);
  return out;
}
