// Fair value gaps and inverse fair value gaps. Pure and causal: a gap exists
// from the close of its third candle, and its state uses only later candles.
//
// Bullish FVG: candle 3's low is above candle 1's high; the gap between them
// is [candle 1 high, candle 3 low]. Bearish mirrors it.
//
//   open      price has not come back into the gap
//   tested    price came into it but not through it
//   filled    price traded through the whole gap without closing beyond it
//   inverted  a candle closed beyond the far side: the gap now works the
//             other way (a bullish FVG becomes bearish resistance), an IFVG
//
// An IFVG ends when a candle closes back beyond its other side.
import type { Candle, Timeframe } from '../../../shared/types';
import { atr } from './indicators';

export interface FvgParams {
  /** Smallest gap, in ATRs of the candle before it. */
  min_size_atr: number;
  lookback_candles: number;
}

export interface Fvg {
  id: string;
  tf: Timeframe;
  /** Which way it works now: an inverted bullish gap is bearish. */
  side: 'bullish' | 'bearish';
  inverse: boolean;
  top: number;
  bottom: number;
  /** Close of the third candle: when it became known. */
  createdAt: number;
  status: 'open' | 'tested' | 'filled' | 'inverted' | 'ended';
  /** When it became an IFVG, if it did. */
  invertedAt: number | null;
}

export function detectFvgs(candles: Candle[], p: FvgParams): Fvg[] {
  const n = candles.length;
  if (n < 3) return [];
  const a = atr(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14);
  const out: Fvg[] = [];
  for (let j = Math.max(2, n - p.lookback_candles); j < n; j++) {
    const c1 = candles[j - 2];
    const c3 = candles[j];
    const ref = a[j - 1];
    if (!Number.isFinite(ref)) continue;
    let side: Fvg['side'] | null = null;
    let bottom = 0;
    let top = 0;
    if (c3.low > c1.high) { side = 'bullish'; bottom = c1.high; top = c3.low; }
    else if (c3.high < c1.low) { side = 'bearish'; bottom = c3.high; top = c1.low; }
    if (!side || top - bottom < p.min_size_atr * ref) continue;
    const g: Fvg = { id: `${c3.symbol}-${c3.tf}-fvg-${c3.openTime}`, tf: c3.tf, side, inverse: false, top, bottom, createdAt: c3.closeTime, status: 'open', invertedAt: null };
    track(g, candles, j);
    out.push(g);
  }
  return out;
}

function track(g: Fvg, candles: Candle[], from: number): void {
  for (let k = from + 1; k < candles.length; k++) {
    const c = candles[k];
    if (!g.inverse) {
      // The far side: the bottom of a bullish gap, the top of a bearish one.
      const closedThrough = g.side === 'bullish' ? c.close < g.bottom : c.close > g.top;
      if (closedThrough) {
        g.inverse = true;
        g.side = g.side === 'bullish' ? 'bearish' : 'bullish';
        g.status = 'inverted';
        g.invertedAt = c.closeTime;
        continue;
      }
      const through = g.side === 'bullish' ? c.low <= g.bottom : c.high >= g.top;
      if (through) { g.status = 'filled'; return; }
      const into = g.side === 'bullish' ? c.low <= g.top : c.high >= g.bottom;
      if (into) g.status = 'tested';
    } else {
      // An IFVG ends when price closes back beyond its other side.
      const back = g.side === 'bearish' ? c.close > g.top : c.close < g.bottom;
      if (back) { g.status = 'ended'; return; }
    }
  }
}

/** Gaps still working: open or tested FVGs, and live IFVGs. */
export const activeFvgs = (fvgs: Fvg[]) => fvgs.filter((g) => g.status === 'open' || g.status === 'tested' || g.status === 'inverted');
