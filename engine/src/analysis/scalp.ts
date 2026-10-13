// Scalp setups on 5m candles, for the dashboard's Scalp page: four common
// short-hold setups, each with an entry at the signal candle's close, a stop
// beyond the structure that made it, and a 2R target. Every setup is followed
// forward to its stop, its target or its expiry, so the page can show how
// they have actually played out after fees. Display only: the engine does not
// trade them.
//
//   sweep_reclaim  a wick through an untouched swing high/low that closes back inside
//   vwap_bounce    in a 5m trend, a pullback to the day's VWAP that closes back away from it
//   ema_pullback   with the 1h trend, a 5m pullback to EMA20 that closes back above (below) it
//   orb            the first close out of a session's 15-minute opening range, on volume
import type { Candle } from '../../../shared/types';
import { atr, columns, ema, sma, swingPivots, vwapDaily } from './indicators';

export type ScalpKind = 'sweep_reclaim' | 'vwap_bounce' | 'ema_pullback' | 'orb' | 'fvg_retest' | 'volume_climax';

export const SCALP_LABEL: Record<ScalpKind, string> = {
  sweep_reclaim: 'Sweep & reclaim',
  vwap_bounce: 'VWAP bounce',
  ema_pullback: 'EMA20 pullback',
  fvg_retest: 'FVG imbalance tap',
  volume_climax: 'Volume climax reversal',
  orb: 'Opening range breakout',
};

export interface ScalpSetup {
  symbol: string;
  kind: ScalpKind;
  side: 'long' | 'short';
  tf?: '1m' | '5m' | '15m';
  /** Open time of the signal candle; the entry is at its close. */
  time: number;
  entry: number;
  /** Structural Key Level for limit pullback execution. */
  keyLevel?: number;
  stop: number;
  target: number;
  /** Target distance as a percent of the entry. */
  targetPct: number;
  /** In R after the round-trip costs: what a win and a loss pay. */
  winR: number;
  lossR: number;
  /** In the 1h trend's direction. */
  withTrend: boolean;
  why: string;
  status: 'open' | 'target' | 'stop' | 'expired';
  /** When it reached its target, stop or expiry. */
  closedAt: number | null;
  /** Result in R after costs; null while open. */
  resultR: number | null;
}

export interface ScalpContext {
  symbol: string;
  /** The 1h trend read. */
  bias1h: 'up' | 'down' | 'range';
  /** Session open times (London, New York) for the opening ranges. */
  sessionOpens: number[];
  /** Round-trip costs (fees and slippage, both fills) as a percent of price. */
  costPct: number;
}

const TF = 300_000;
/** Reward:risk to the target after the round-trip costs: never under 2R. */
const TARGET_R = 2;
/** A setup not stopped or at target after this many candles (4 hours) is closed at the market. */
const EXPIRY_BARS = 48;
/** Stops must be at least this many times the round-trip costs away, or fees eat the trade. */
const MIN_RISK_COSTS = 3;
const PIVOT_K = 3;

/** Every setup in the candles given (closed 1m, 5m, or 15m candles, oldest first), followed to its end. */
export function findScalps(c: Candle[], ctx: ScalpContext): ScalpSetup[] {
  const n = c.length;
  if (n < 40) return [];
  const col = columns(c);
  const tfMs = c.length > 1 ? c[1].openTime - c[0].openTime : 300_000;
  const tf: '1m' | '5m' | '15m' = (c[0]?.tf ?? (tfMs <= 60_000 ? '1m' : tfMs <= 300_000 ? '5m' : '15m')) as '1m' | '5m' | '15m';
  const a = atr(col.high, col.low, col.close, 14);
  const e20 = ema(col.close, 20);
  const e50 = ema(col.close, 50);
  const vwap = vwapDaily(col);
  const vAvg = sma(col.volume, 20);
  const pivotLookback = tf === '1m' ? 2 : PIVOT_K;
  const pivots = swingPivots(col.high, col.low, pivotLookback);
  const out: ScalpSetup[] = [];

  const expiryBars = tf === '1m' ? 60 : tf === '15m' ? 32 : EXPIRY_BARS;

  const add = (i: number, kind: ScalpKind, side: 'long' | 'short', stop: number, why: string, keyLevel?: number) => {
    const entry = col.close[i];
    const risk = Math.abs(entry - stop);
    const cost = (entry * ctx.costPct) / 100;
    if (!(risk > 0) || risk < MIN_RISK_COSTS * cost) return;
    if (side === 'long' ? stop >= entry : stop <= entry) return;

    // Strict scalp stop distance cap: discard blown-out high-volatility spikes (e.g. 6% altcoin wicks)
    const stopPct = (risk / entry) * 100;
    const maxStopPct = tf === '1m' ? 2.0 : tf === '5m' ? 2.5 : 3.5;
    if (stopPct > maxStopPct) return;

    // One at a time: not while the same setup on the same side is still running (you would already be in it).
    if (out.some((o) => o.kind === kind && o.side === side && (o.closedAt === null || o.closedAt > col.openTime[i]))) return;
    // Far enough that the win is TARGET_R after costs, not before them.
    const reach = TARGET_R * risk + cost;
    const target = side === 'long' ? entry + reach : entry - reach;
    const setup: ScalpSetup = {
      symbol: ctx.symbol, kind, side, tf, time: col.openTime[i], entry, keyLevel, stop, target,
      targetPct: (Math.abs(target - entry) / entry) * 100,
      winR: (reach - cost) / risk,
      lossR: -(risk + cost) / risk,
      withTrend: ctx.bias1h === (side === 'long' ? 'up' : 'down'),
      why, status: 'open', closedAt: null, resultR: null,
    };
    follow(setup, i, col, cost, tfMs, expiryBars);
    out.push(setup);
  };

  const minWarmup = tf === '1m' ? 30 : 55;
  const swingSearchBars = tf === '1m' ? 30 : tf === '15m' ? 48 : 72;

  for (let i = minWarmup; i < n; i++) {
    const ai = a[i];
    if (!(ai > 0)) continue;
    const candleRange = col.high[i] - col.low[i];
    // Anti-fakeout: confirmation candle must close in its favorable half (no heavy rejection wicks)
    const bull = col.close[i] > col.open[i] && (candleRange === 0 || (col.close[i] - col.low[i]) / candleRange >= 0.50);
    const bear = col.close[i] < col.open[i] && (candleRange === 0 || (col.high[i] - col.close[i]) / candleRange >= 0.50);

    // Sweep & reclaim: untouched swing high/low wicked through and closed back inside
    for (const type of ['high', 'low'] as const) {
      const level = [...pivots].reverse().find((p) => p.type === type && p.confirmedAt < i && p.index >= i - swingSearchBars
        && col.close.slice(p.index + 1, i).every((x) => (type === 'high' ? x <= p.price : x >= p.price)));
      if (!level) continue;
      if (type === 'high' && col.high[i] > level.price + 0.05 * ai && col.close[i] < level.price) {
        add(i, 'sweep_reclaim', 'short', col.high[i] + 0.1 * ai, `wicked above the swing high ${fmt(level.price)} and closed back under it`, level.price);
      }
      if (type === 'low' && col.low[i] < level.price - 0.05 * ai && col.close[i] > level.price) {
        add(i, 'sweep_reclaim', 'long', col.low[i] - 0.1 * ai, `wicked under the swing low ${fmt(level.price)} and closed back over it`, level.price);
      }
    }

    // VWAP bounce: trend on one side of VWAP, a touch of it, and a close back away
    const lookbackVwap = tf === '1m' ? 10 : 6;
    if (i >= lookbackVwap) {
      const above = col.close.slice(i - lookbackVwap, i).every((x, m) => x > vwap[i - lookbackVwap + m]);
      const below = col.close.slice(i - lookbackVwap, i).every((x, m) => x < vwap[i - lookbackVwap + m]);
      if (above && e20[i] > e50[i] && bull && col.low[i] <= vwap[i] + 0.1 * ai && col.close[i] > vwap[i]) {
        add(i, 'vwap_bounce', 'long', Math.min(col.low[i], vwap[i]) - 0.1 * ai, `held above VWAP ${fmt(vwap[i])} on a pullback in an uptrend`, vwap[i]);
      }
      if (below && e20[i] < e50[i] && bear && col.high[i] >= vwap[i] - 0.1 * ai && col.close[i] < vwap[i]) {
        add(i, 'vwap_bounce', 'short', Math.max(col.high[i], vwap[i]) + 0.1 * ai, `rejected VWAP ${fmt(vwap[i])} on a bounce in a downtrend`, vwap[i]);
      }
    }

    // EMA20 pullback with the 1h trend, after a move away from it of at least an ATR (5m and 15m only, not 1m noise)
    if (tf !== '1m') {
      const recentHigh = Math.max(...col.high.slice(Math.max(0, i - 12), i));
      const recentLow = Math.min(...col.low.slice(Math.max(0, i - 12), i));
      if (ctx.bias1h === 'up' && e20[i] > e50[i] && bull && col.low[i] <= e20[i] && col.close[i] > e20[i] && recentHigh >= e20[i] + ai) {
        add(i, 'ema_pullback', 'long', Math.min(...col.low.slice(Math.max(0, i - 5), i + 1)) - 0.1 * ai, 'pulled back to the EMA20 and closed above it, with the 1h uptrend', e20[i]);
      }
      if (ctx.bias1h === 'down' && e20[i] < e50[i] && bear && col.high[i] >= e20[i] && col.close[i] < e20[i] && recentLow <= e20[i] - ai) {
        add(i, 'ema_pullback', 'short', Math.max(...col.high.slice(Math.max(0, i - 5), i + 1)) + 0.1 * ai, 'bounced to the EMA20 and closed below it, with the 1h downtrend', e20[i]);
      }
    }

    // Fair Value Gap (FVG) retest
    if (i >= 4) {
      const isBullFvg = col.low[i - 1] > col.high[i - 3] + 0.05 * ai;
      if (isBullFvg && col.low[i] <= col.low[i - 1] && col.close[i] > col.high[i - 3] && bull && (ctx.bias1h === 'up' || e20[i] > e50[i])) {
        add(i, 'fvg_retest', 'long', col.high[i - 3] - 0.1 * ai, `tapped bullish FVG imbalance (${fmt(col.high[i - 3])} – ${fmt(col.low[i - 1])}) and closed green`, col.low[i - 1]);
      }
      const isBearFvg = col.high[i - 1] < col.low[i - 3] - 0.05 * ai;
      if (isBearFvg && col.high[i] >= col.high[i - 1] && col.close[i] < col.low[i - 3] && bear && (ctx.bias1h === 'down' || e20[i] < e50[i])) {
        add(i, 'fvg_retest', 'short', col.low[i - 3] + 0.1 * ai, `tapped bearish FVG imbalance (${fmt(col.low[i - 3])} – ${fmt(col.high[i - 1])}) and closed red`, col.high[i - 1]);
      }
    }

    // Volume Climax Reversal (Exhaustion wick absorption)
    if (candleRange > 0 && vAvg[i] > 0 && col.volume[i] >= 2.2 * vAvg[i]) {
      const lowerWick = Math.min(col.open[i], col.close[i]) - col.low[i];
      const upperWick = col.high[i] - Math.max(col.open[i], col.close[i]);
      if (bull && lowerWick / candleRange >= 0.40) {
        add(i, 'volume_climax', 'long', col.low[i] - 0.1 * ai, `volume climax (${(col.volume[i] / vAvg[i]).toFixed(1)}x vol) with ${(lowerWick / candleRange * 100).toFixed(0)}% absorption wick`, col.low[i] + 0.5 * lowerWick);
      }
      if (bear && upperWick / candleRange >= 0.40) {
        add(i, 'volume_climax', 'short', col.high[i] + 0.1 * ai, `volume climax (${(col.volume[i] / vAvg[i]).toFixed(1)}x vol) with ${(upperWick / candleRange * 100).toFixed(0)}% rejection wick`, col.high[i] - 0.5 * upperWick);
      }
    }
  }

  // Opening range breakouts (for 5m and 15m)
  if (tf !== '1m') {
    for (const open of ctx.sessionOpens) {
      const first = col.openTime.indexOf(open);
      if (first < 20 || first + 3 >= n) continue;
      const orHigh = Math.max(...col.high.slice(first, first + 3));
      const orLow = Math.min(...col.low.slice(first, first + 3));
      const mid = (orHigh + orLow) / 2;
      for (let i = first + 3; i < Math.min(n, first + 24); i++) {
        const ai = a[i];
        if (!(ai > 0) || !(col.volume[i] > vAvg[i])) continue;
        const rangeText = `the opening range ${fmt(orLow)} – ${fmt(orHigh)}`;
        if (col.close[i] > orHigh + 0.05 * ai) { add(i, 'orb', 'long', mid, `closed above ${rangeText} on above-average volume`, orHigh); break; }
        if (col.close[i] < orLow - 0.05 * ai) { add(i, 'orb', 'short', mid, `closed below ${rangeText} on above-average volume`, orLow); break; }
      }
    }
  }

  return out.sort((x, y) => y.time - x.time);
}

/** Walks the candles after the signal: the stop or target, whichever is touched first (the stop when both are in one candle), or expiry. */
function follow(s: ScalpSetup, i: number, col: ReturnType<typeof columns>, cost: number, barMs: number, expiryBars: number): void {
  const risk = Math.abs(s.entry - s.stop);
  const long = s.side === 'long';
  for (let j = i + 1; j < col.close.length; j++) {
    const hitStop = long ? col.low[j] <= s.stop : col.high[j] >= s.stop;
    const hitTarget = long ? col.high[j] >= s.target : col.low[j] <= s.target;
    if (hitStop || hitTarget) {
      s.status = hitStop ? 'stop' : 'target';
      s.closedAt = col.openTime[j] + barMs;
      s.resultR = hitStop ? s.lossR : s.winR;
      return;
    }
    if (j - i >= expiryBars) {
      s.status = 'expired';
      s.closedAt = col.openTime[j] + barMs;
      s.resultR = ((long ? col.close[j] - s.entry : s.entry - col.close[j]) - cost) / risk;
      return;
    }
  }
}

export interface ScalpStats { kind: ScalpKind | 'all'; count: number; closed: number; wins: number; losses: number; expired: number; winRate: number | null; avgR: number | null; totalR: number }

/** Results of closed setups, per kind and in total. */
export function scalpStats(setups: ScalpSetup[]): ScalpStats[] {
  const one = (kind: ScalpKind | 'all', list: ScalpSetup[]): ScalpStats => {
    const closed = list.filter((s) => s.status !== 'open');
    const wins = closed.filter((s) => (s.resultR ?? 0) > 0).length;
    const totalR = closed.reduce((t, s) => t + (s.resultR ?? 0), 0);
    return {
      kind, count: list.length, closed: closed.length, wins, losses: closed.length - wins,
      expired: closed.filter((s) => s.status === 'expired').length,
      winRate: closed.length ? wins / closed.length : null,
      avgR: closed.length ? totalR / closed.length : null,
      totalR,
    };
  };
  return [...(Object.keys(SCALP_LABEL) as ScalpKind[]).map((k) => one(k, setups.filter((s) => s.kind === k))), one('all', setups)];
}

const fmt = (p: number) => String(Number(p.toPrecision(5)));
