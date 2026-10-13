// Warnings for a coin that "doesn't look right": a pump and where it is in
// its cycle, a move stretched far from its average, a wick through the high
// that closed back below, and structure turning against the move.
//
// A pump runs the same course again and again: a quiet base on thin volume,
// an ignition candle on many times the base volume, a vertical markup, a
// blow-off (long upper wicks on the heaviest volume), then a stall under the
// high and an unwind once the 1h structure breaks down. The read names the
// stage the coin is in and what usually goes wrong for a trade there.
//
// On closed 1h candles; the 1h and 15m structure come from swingStructure.ts.
// Heuristics for the dashboard: the engine's entries do not use them.
import type { Candle } from '../../../shared/types';
import { atr, ema, rsi } from './indicators';
import type { SwingStructure } from './swingStructure';

export type PumpPhase = 'markup' | 'blowoff' | 'distribution' | 'unwind' | 'faded';

export interface PumpRead {
  phase: PumpPhase;
  /** Where the run started: its lowest low, and that candle's open time. */
  baseLow: number;
  baseTime: number;
  /** The first candle of the run with a body of 2 base ATRs on 5x the base volume (the run's start when none). */
  ignitionTime: number;
  peak: number;
  peakTime: number;
  /** Base low to peak, percent. */
  runPct: number;
  /** Candles (hours) from the base low to the peak. */
  hours: number;
  /** The run's average volume over the base's (the 24 hours before it). */
  volumeX: number;
  /** USDT traded per hour in the base: how thin the coin was before it moved. */
  baseVolumePerHour: number;
  /** Below the peak now, percent. */
  fromPeakPct: number;
  /** Share of the run given back, 0 at the peak, 1 back at the base. */
  retrace: number;
  /** Retracements of the run, where pullbacks often pause. */
  levels: { ratio: number; price: number }[];
}

export type WarningCode =
  | 'pump_markup' | 'pump_blowoff' | 'pump_stalling' | 'pump_unwinding' | 'pump_faded' | 'thin_base'
  | 'failed_high' | 'failed_low' | 'stretched_up' | 'stretched_down' | 'dumping'
  | 'ltf_turn' | 'htf_turn'
  | 'outside_window' | 'move_done' | 'range_used'
  | 'sweep_reclaim';

export interface MarketWarning {
  code: WarningCode;
  level: 'caution' | 'danger';
  /** Who should be careful: longs, shorts, or both. */
  side: 'long' | 'short' | 'both';
  title: string;
  detail: string;
  /** The candle (open time) the warning comes from: with the code, says whether it is the same warning as before. */
  time: number;
}

export interface CoinWatch {
  symbol: string;
  /** Open time of the last closed 1h candle read. */
  asOf: number;
  level: 'ok' | 'caution' | 'danger';
  pump: PumpRead | null;
  warnings: MarketWarning[];
  btc?: { change1hPct: number | null; isDumping: boolean } | null;
  adr?: { usualRange: number; todayRange: number; usedPct: number } | null;
  structure?: { h4: 'up' | 'down' | 'none'; h1: 'up' | 'down' | 'none' } | null;
  atr15m?: number | null;
}

/** A pump: at least this much from base to peak... */
const MIN_RUN = 0.2;
/** ...at least this many base ATRs... */
const MIN_RUN_ATR = 6;
/** ...on at least this many times the base's volume... */
const MIN_VOLUME_X = 2.5;
/** ...peaking within this many hours, from a base at most this many hours before the peak. */
const PEAK_WITHIN = 48;
const RUN_WITHIN = 48;
const BASE_HOURS = 24;
/** Base volume under this per hour (USDT): a thin coin, easy to push up and to dump. */
const THIN_BASE_USDT_H = 2_000_000;
/** Close this many ATRs from the 1h EMA50: stretched. */
const STRETCH_ATR = 6;
const RETRACE_RATIOS = [0.382, 0.5, 0.618, 0.786];

const pctStr = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(0)}%`;
const usdM = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${(x / 1e3).toFixed(0)}k`);
const fmt = (p: number) => Number(p.toPrecision(5)).toString();
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

/** The latest pump on 1h candles, or null. */
export function findPump(c: Candle[], s1h: SwingStructure | null = null): PumpRead | null {
  const n = c.length;
  if (n < 60) return null;
  const last = n - 1;
  let peakIdx = last;
  for (let i = last; i >= n - PEAK_WITHIN; i--) if (c[i].high > c[peakIdx].high) peakIdx = i;
  let startIdx = peakIdx;
  for (let i = peakIdx; i >= Math.max(BASE_HOURS, peakIdx - RUN_WITHIN); i--) if (c[i].low < c[startIdx].low) startIdx = i;
  if (startIdx === peakIdx || startIdx < BASE_HOURS) return null;
  const peak = c[peakIdx].high;
  const baseLow = c[startIdx].low;
  const run = peak / baseLow - 1;
  if (run < MIN_RUN) return null;
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14);
  if (!(a[startIdx] > 0) || peak - baseLow < MIN_RUN_ATR * a[startIdx]) return null;
  const baseVol = mean(c.slice(startIdx - BASE_HOURS, startIdx).map((x) => x.quoteVolume));
  const runCandles = c.slice(startIdx, peakIdx + 1);
  const runVol = mean(runCandles.map((x) => x.quoteVolume));
  if (!(baseVol > 0) || runVol < MIN_VOLUME_X * baseVol) return null;
  const ignition = runCandles.find((x) => x.close - x.open >= 2 * a[startIdx] && x.quoteVolume >= 5 * baseVol) ?? c[startIdx];

  const now = c[last].close;
  const retrace = (peak - now) / (peak - baseLow);
  const peakTime = c[peakIdx].openTime;
  const brokeDown = !!s1h?.breaks.some((b) => b.dir === 'down' && b.time > peakTime);
  // The blow-off: the peak candle, in the last three, with a long upper wick on heavy volume.
  const top = c[peakIdx];
  const topRange = top.high - top.low;
  const blowoff = last - peakIdx <= 2 && topRange > 0 && (top.high - Math.max(top.open, top.close)) / topRange >= 0.5 && top.quoteVolume >= runVol;
  const phase: PumpPhase = retrace >= 0.786 ? 'faded'
    : brokeDown || retrace >= 0.382 ? 'unwind'
    : blowoff ? 'blowoff'
    : last - peakIdx <= 2 ? 'markup'
    : 'distribution';
  return {
    phase, baseLow, baseTime: c[startIdx].openTime, ignitionTime: ignition.openTime, peak, peakTime,
    runPct: run * 100, hours: peakIdx - startIdx, volumeX: runVol / baseVol, baseVolumePerHour: baseVol,
    fromPeakPct: (1 - now / peak) * 100, retrace,
    levels: RETRACE_RATIOS.map((ratio) => ({ ratio, price: peak - (peak - baseLow) * ratio })),
  };
}

function pumpWarnings(p: PumpRead, c: Candle[], s1h: SwingStructure | null): MarketWarning[] {
  const run = `${pctStr(p.runPct)} in ${p.hours}h on ${p.volumeX.toFixed(0)}x the volume`;
  const lvl = (r: number) => fmt(p.levels.find((l) => l.ratio === r)!.price);
  const out: MarketWarning[] = [];
  const recentVol = mean(c.slice(-3).map((x) => x.quoteVolume));
  const runVol = p.baseVolumePerHour * p.volumeX;
  switch (p.phase) {
    case 'markup':
      out.push({ code: 'pump_markup', level: 'caution', side: 'long', time: p.peakTime, title: `Pumping ${run}`,
        detail: 'A vertical move: late longs get trapped when it turns, and shorts against it get squeezed. Wait for a pullback that holds a higher low; do not chase green candles.' });
      break;
    case 'blowoff':
      out.push({ code: 'pump_blowoff', level: 'danger', side: 'long', time: p.peakTime, title: `Blow-off at the top of a ${pctStr(p.runPct)} pump`,
        detail: 'Long upper wicks on the heaviest volume of the run: sellers are unloading into the buyers. This is where pumps usually top. No new longs.' });
      break;
    case 'distribution':
      out.push({ code: 'pump_stalling', level: 'caution', side: 'long', time: p.peakTime, title: `Stalling ${p.fromPeakPct.toFixed(0)}% under the pump's high`,
        detail: `After ${run}. Volume is down to ${((recentVol / runVol) * 100).toFixed(0)}% of the run's average. Pumps often roll over from here`
          + (s1h?.breakDown ? `: a 1h close below ${fmt(s1h.breakDown.price)} turns it down.` : '.') });
      break;
    case 'unwind': {
      const brk = s1h?.breaks.find((b) => b.dir === 'down' && b.time > p.peakTime);
      out.push({ code: 'pump_unwinding', level: 'danger', side: 'long', time: p.peakTime, title: `Pump unwinding: ${p.fromPeakPct.toFixed(0)}% off the high`,
        detail: `${brk ? `1h structure broke down (${brk.kind} below ${fmt(brk.level)}); ` : ''}${(p.retrace * 100).toFixed(0)}% of the ${pctStr(p.runPct)} run given back. `
          + `Buying the dip fights the move, and bounces into broken levels often fail. Pullbacks tend to pause at 50% ${lvl(0.5)}, 61.8% ${lvl(0.618)}, base ${fmt(p.baseLow)}.` });
      break;
    }
    case 'faded':
      out.push({ code: 'pump_faded', level: 'caution', side: 'both', time: p.peakTime, title: `Pump given back: ${(p.retrace * 100).toFixed(0)}% of the run retraced`,
        detail: `Back near the base ${fmt(p.baseLow)}. Volume and interest are leaving; moves from here are often choppy either way.` });
      break;
  }
  if (p.baseVolumePerHour < THIN_BASE_USDT_H) {
    out.push({ code: 'thin_base', level: 'caution', side: 'both', time: p.peakTime, title: `Thin coin before the pump (${usdM(p.baseVolumePerHour)}/h)`,
      detail: 'It traded little before it moved: a thin coin is easy to push up and to dump, and its stops slip.' });
  }
  return out;
}

/**
 * A wick through the highest high (lowest low) of the previous 24 candles that
 * closed back inside, on at least 1.5x the average volume, in the last 3 candles.
 */
function failedBreaks(c: Candle[]): MarketWarning[] {
  const n = c.length;
  const out: MarketWarning[] = [];
  for (let j = n - 1; j >= Math.max(24, n - 3); j--) {
    const x = c[j];
    const range = x.high - x.low;
    const prior = c.slice(j - 24, j);
    if (!(range > 0) || x.quoteVolume < 1.5 * mean(prior.map((y) => y.quoteVolume))) continue;
    const hi = Math.max(...prior.map((y) => y.high));
    const lo = Math.min(...prior.map((y) => y.low));
    if (!out.some((w) => w.code === 'failed_high') && x.high > hi && x.close < hi && (x.high - Math.max(x.open, x.close)) / range >= 0.5) {
      out.push({ code: 'failed_high', level: 'caution', side: 'long', time: x.openTime, title: `Wicked above the high ${fmt(hi)} and closed back below`,
        detail: `The breakout failed ${n - 1 - j}h ago: buyers above the high were trapped. Often the move turns down from here.` });
      out.push({ code: 'sweep_reclaim', level: 'caution', side: 'short', time: x.openTime, title: `Bearish Sweep & Reclaim: 24h High ${fmt(hi)} Swept`,
        detail: `Liquidity above ${fmt(hi)} was swept on 1.5x volume and closed back inside. High-probability mean reversion setup for shorts.` });
    }
    if (!out.some((w) => w.code === 'failed_low') && x.low < lo && x.close > lo && (Math.min(x.open, x.close) - x.low) / range >= 0.5) {
      out.push({ code: 'failed_low', level: 'caution', side: 'short', time: x.openTime, title: `Wicked below the low ${fmt(lo)} and closed back above`,
        detail: `The breakdown failed ${n - 1 - j}h ago: sellers below the low were trapped. Often the move turns up from here.` });
      out.push({ code: 'sweep_reclaim', level: 'caution', side: 'long', time: x.openTime, title: `Bullish Sweep & Reclaim: 24h Low ${fmt(lo)} Swept`,
        detail: `Liquidity below ${fmt(lo)} was swept on 1.5x volume and closed back inside. High-probability mean reversion setup for longs.` });
    }
  }
  return out;
}

export function watchCoin(symbol: string, c1h: Candle[], s1h: SwingStructure | null, s15m: SwingStructure | null): CoinWatch {
  const n = c1h.length;
  const asOf = c1h[n - 1]?.openTime ?? 0;
  if (n < 60) return { symbol, asOf, level: 'ok', pump: null, warnings: [] };
  const close = c1h.map((x) => x.close);
  const last = n - 1;
  const a = atr(c1h.map((x) => x.high), c1h.map((x) => x.low), close, 14)[last];
  const e50 = ema(close, 50)[last];
  const r = rsi(close, 14)[last];
  const pump = findPump(c1h, s1h);
  const warnings: MarketWarning[] = pump ? pumpWarnings(pump, c1h, s1h) : [];

  // Stretched from the average: a move this far usually snaps back some way.
  const stretch = a > 0 ? (close[last] - e50) / a : 0;
  if (stretch >= STRETCH_ATR && pump?.phase !== 'blowoff') {
    warnings.push({ code: 'stretched_up', level: 'caution', side: 'long', time: asOf, title: `Stretched ${stretch.toFixed(1)} ATR above the 1h EMA50`,
      detail: `RSI ${Number.isFinite(r) ? r.toFixed(0) : '–'}. Longs from here buy far from value; a snap back toward ${fmt(e50)} is common.` });
  }
  if (stretch <= -STRETCH_ATR) {
    warnings.push({ code: 'stretched_down', level: 'caution', side: 'short', time: asOf, title: `Stretched ${(-stretch).toFixed(1)} ATR below the 1h EMA50`,
      detail: `RSI ${Number.isFinite(r) ? r.toFixed(0) : '–'}. Shorts from here sell far from value; a bounce toward ${fmt(e50)} is common.` });
  }
  // A dump without a pump before it.
  const high24 = Math.max(...c1h.slice(-24).map((x) => x.high));
  const drop = (1 - close[last] / high24) * 100;
  if (!pump && drop >= 20) {
    warnings.push({ code: 'dumping', level: 'danger', side: 'both', time: asOf, title: `Down ${drop.toFixed(0)}% from the 24h high`,
      detail: 'A crash: dip buyers catch a falling knife, and late shorts get caught by violent bounces. Let it settle into a range first.' });
  }
  warnings.push(...failedBreaks(c1h));

  // Structure turning: the 1h trend changed lately, or the 15m turned against the 1h trend.
  const choch1h = s1h?.breaks.filter((b) => b.kind === 'CHoCH').pop();
  if (choch1h && asOf - choch1h.time <= 3 * 3_600_000 && !warnings.some((w) => w.code === 'pump_unwinding')) {
    const down = choch1h.dir === 'down';
    warnings.push({ code: 'htf_turn', level: 'caution', side: down ? 'long' : 'short', time: choch1h.time,
      title: `1h structure turned ${down ? 'down' : 'up'} (CHoCH ${down ? 'below' : 'above'} ${fmt(choch1h.level)})`,
      detail: down ? 'The last higher low broke on a close: the uptrend is in question until a new higher high.' : 'The last lower high broke on a close: the downtrend is in question until a new lower low.' });
  }
  const choch15 = s15m?.breaks.filter((b) => b.kind === 'CHoCH').pop();
  if (choch15 && s1h && s15m && s15m.asOf - choch15.time <= 4 * 900_000 && s1h.trend === (choch15.dir === 'down' ? 'up' : 'down')) {
    const down = choch15.dir === 'down';
    warnings.push({ code: 'ltf_turn', level: 'caution', side: down ? 'long' : 'short', time: choch15.time,
      title: `15m turned ${down ? 'down' : 'up'} inside the 1h ${down ? 'uptrend' : 'downtrend'}`,
      detail: `An early sign: a 15m CHoCH ${down ? 'below' : 'above'} ${fmt(choch15.level)}. Often only a pullback, but ${down ? 'longs' : 'shorts'} added here lean on the 1h holding.` });
  }

  const level = warnings.some((w) => w.level === 'danger') ? 'danger' : warnings.length ? 'caution' : 'ok';
  warnings.sort((x, y) => Number(y.level === 'danger') - Number(x.level === 'danger'));
  return { symbol, asOf, level, pump, warnings };
}
