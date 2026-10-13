// Causal Volume Dynamics & Pattern Diagnostics: explains WHY patterns change,
// stall, or reverse based on volume expansion, climax absorption, volume divergence,
// and liquidity drying. Pure and causal.
import type { Candle, VolumeDiagnosis } from '../../../shared/types';
import { rvol } from './indicators';

export function diagnoseVolume(candles: Candle[], side?: 'long' | 'short'): VolumeDiagnosis {
  const n = candles.length;
  if (n < 20) {
    return {
      regime: 'normal',
      rvol: 1.0,
      label: 'Normal Volume',
      whyItHappened: 'Insufficient candle history for relative volume profiling.',
    };
  }

  const vol = candles.map((c) => c.volume);
  const rv = rvol(vol, 20);
  const last = n - 1;
  const lastRvol = Number.isFinite(rv[last]) ? Number(rv[last].toFixed(2)) : 1.0;

  // 1. Check for Volume Climax / Absorption in the most recent 3 candles
  for (let i = last; i >= Math.max(0, last - 2); i--) {
    const c = candles[i];
    const r = Number.isFinite(rv[i]) ? rv[i] : 1.0;
    const range = c.high - c.low;
    if (range > 0 && r >= 2.2) {
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;

      if (upperWick / range >= 0.4) {
        return {
          regime: 'climax',
          rvol: Number(r.toFixed(2)),
          label: 'Climax Buying Absorption',
          whyItHappened: `Massive volume spike (${r.toFixed(1)}x average) met a heavy upper rejection wick. Institutional sellers aggressively absorbed retail breakout buyers, explaining why the bullish push failed and reversed.`,
        };
      }

      if (lowerWick / range >= 0.4) {
        return {
          regime: 'climax',
          rvol: Number(r.toFixed(2)),
          label: 'Climax Panic Absorption',
          whyItHappened: `Massive volume spike (${r.toFixed(1)}x average) met a heavy lower rejection wick. Institutional buyers absorbed panic sellers, explaining why the dump stalled and reversed upward.`,
        };
      }
    }
  }

  // 2. Check for Volume Divergence over the last 24 candles
  // (Price making higher high or lower low, but on significantly lower volume)
  if (n >= 24) {
    const window = candles.slice(-24);
    let peak1Idx = -1;
    let peak2Idx = -1;
    let trough1Idx = -1;
    let trough2Idx = -1;

    for (let i = 2; i < window.length - 2; i++) {
      const curr = window[i];
      // Swing high
      if (curr.high > window[i - 1].high && curr.high > window[i - 2].high &&
          curr.high >= window[i + 1].high && curr.high >= window[i + 2].high) {
        if (peak1Idx === -1) peak1Idx = i;
        else if (peak2Idx === -1) peak2Idx = i;
      }
      // Swing low
      if (curr.low < window[i - 1].low && curr.low < window[i - 2].low &&
          curr.low <= window[i + 1].low && curr.low <= window[i + 2].low) {
        if (trough1Idx === -1) trough1Idx = i;
        else if (trough2Idx === -1) trough2Idx = i;
      }
    }

    if (peak1Idx !== -1 && peak2Idx !== -1) {
      const p1 = window[peak1Idx];
      const p2 = window[peak2Idx];
      if (p2.high > p1.high && p2.volume < 0.65 * p1.volume) {
        const dropPct = Math.round((1 - p2.volume / p1.volume) * 100);
        return {
          regime: 'divergence',
          rvol: lastRvol,
          label: 'Bearish Volume Divergence',
          whyItHappened: `Price reached a higher high (${p2.high.toFixed(4)}) on ${dropPct}% lower volume than the previous swing. Buyer exhaustion explains why the uptrend is stalling and vulnerable to a sharp reversal.`,
        };
      }
    }

    if (trough1Idx !== -1 && trough2Idx !== -1) {
      const t1 = window[trough1Idx];
      const t2 = window[trough2Idx];
      if (t2.low < t1.low && t2.volume < 0.65 * t1.volume) {
        const dropPct = Math.round((1 - t2.volume / t1.volume) * 100);
        return {
          regime: 'divergence',
          rvol: lastRvol,
          label: 'Bullish Volume Divergence',
          whyItHappened: `Price pushed to a lower low (${t2.low.toFixed(4)}) on ${dropPct}% lower volume than the prior breakdown. Seller exhaustion explains why selling pressure dried up and a reversal is brewing.`,
        };
      }
    }
  }

  // 3. Institutional Volume Expansion
  const lastC = candles[last];
  const lastRange = lastC.high - lastC.low;
  const lastBody = Math.abs(lastC.close - lastC.open);
  if (lastRvol >= 1.4 && lastRange > 0 && lastBody / lastRange >= 0.5) {
    const isBull = lastC.close >= lastC.open;
    return {
      regime: 'expansion',
      rvol: lastRvol,
      label: isBull ? 'Bullish Volume Expansion' : 'Bearish Volume Expansion',
      whyItHappened: `High relative volume (${lastRvol.toFixed(1)}x average) backed by a solid ${isBull ? 'green' : 'red'} candle body confirms institutional momentum. Validates continuation in the move's direction.`,
    };
  }

  // 4. Drying / Low Volume
  if (lastRvol < 0.65) {
    return {
      regime: 'drying',
      rvol: lastRvol,
      label: 'Low / Drying Volume',
      whyItHappened: `Volume is 35%+ below average (${lastRvol.toFixed(1)}x). Indicates low institutional participation; breakouts on this volume have a high failure/fakeout rate, while pullbacks indicate low opposing pressure.`,
    };
  }

  return {
    regime: 'normal',
    rvol: lastRvol,
    label: 'Normal Volume',
    whyItHappened: `Volume is pacing normally around its 20-period moving average (${lastRvol.toFixed(1)}x) with balanced participation.`,
  };
}

