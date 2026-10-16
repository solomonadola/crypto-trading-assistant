// Hunter's killzone sweep: a scalp on 5m closes inside the London and New York
// killzones. Price runs the stops beyond an untouched liquidity level (the Asia
// or London high or low, the previous day's high or low, equal highs or lows, a
// 4h swing), closes back inside, and then breaks the swing it left before the
// sweep (a change of character, CHoCH). The entry is a limit at the middle of
// the fair value gap the reversal left (its consequent encroachment), or at the
// broken swing when there is no gap; the stop is beyond the sweep's extreme
// plus an ATR buffer; the target is the next opposite liquidity level when it is
// between exits.min_rr and max_rr away, else a fixed exits.min_rr (shipped: 2R). Longs only in the 4h discount, shorts only in
// the premium. It is a scalp: held at most a couple of hours, and cut early
// when it has not gone our way (the progress check on the order).
//
// Pure: the context, candles and killzone are passed in; nothing here reads the
// clock, the network or the disk. The engine applies the risk rules and costs.
import type { Candle, Direction } from '../../../shared/types';
import type { EngineConfig } from '../config';
import { atr } from '../analysis/indicators';
import { dealingRange, liquidityLevels, LIQUIDITY_NAMES, type DealingRange, type LiquidityLevel } from '../analysis/liquidity';
import { netRewardRisk } from '../speed';
import type { Context } from './context';
import { biasAllows } from './bias';

export type KillzoneSweepConfig = EngineConfig['scalp_autopilot']['killzone_sweep'];

/** What the sweep reads from a coin's context (as of its last 15m close); null without one. */
export interface SweepMarket {
  levels: LiquidityLevel[];
  range: DealingRange | null;
  /** The higher-timeframe trend: whether the engine's bias (1h EMAs, 4h structure not against) allows each side, and the 4h structure. */
  trend: { long: boolean; short: boolean; h4: 'up' | 'down' | 'none' };
}

export function sweepMarket(ctx: Context | null): SweepMarket | null {
  if (!ctx) return null;
  return {
    levels: liquidityLevels(ctx),
    range: dealingRange(ctx),
    trend: { long: biasAllows(ctx, 'long'), short: biasAllows(ctx, 'short'), h4: ctx.analysis.structure['4h']?.trend ?? 'none' },
  };
}

export interface KillzoneSweepInput {
  symbol: string;
  /** The coin's liquidity levels and 4h dealing range (sweepMarket of its context). */
  market: SweepMarket | null;
  /** Closed 5m candles up to and including the one that just closed, oldest first. */
  m5: Candle[];
  /** The killzone the just-closed candle's close falls in, or null. */
  killzone: string | null;
  /** Round-trip costs for a limit entry, percent of price. */
  costPct: number;
  /** Reward:risk the target must reach after costs (config exits.min_rr). */
  minRr: number;
  config: KillzoneSweepConfig;
}

export interface KillzoneSweepOrder {
  symbol: string;
  side: Direction;
  tf: '5m';
  limitPrice: number;
  stop: number;
  target: number;
  /** The level the sweep took and the killzone it happened in, for the note. */
  swept: string;
  killzone: string;
  maxHoldMin: number;
  entryTimeoutMin: number;
  progressCheckMin: number;
  progressMinR: number;
  note: string;
}

export interface KillzoneSweepResult {
  order: KillzoneSweepOrder | null;
  /** Why not. 'no_setup' and 'outside_killzone' are routine: nothing happened worth reporting. */
  skipped?: string;
}

const BAR_MS = 300_000;

/** The order Hunter places for the 5m candle that just closed, or null with the reason. */
export function killzoneSweep(i: KillzoneSweepInput): KillzoneSweepResult {
  if (!i.killzone) return { order: null, skipped: 'outside_killzone' };
  const c = i.config;
  const m = i.m5;
  const n = m.length - 1;
  if (n < c.confirm_bars + c.choch_lookback + 15) return { order: null, skipped: 'not_enough_candles' };
  if (!i.market) return { order: null, skipped: 'no_context' };
  const { levels, range } = i.market;
  const atrNow = atr(m.map((x) => x.high), m.map((x) => x.low), m.map((x) => x.close), 14)[n];
  if (!Number.isFinite(atrNow) || !(atrNow > 0)) return { order: null, skipped: 'not_enough_candles' };

  // At most one side can fire on a candle (it closes beyond a swing high or a swing low, not both).
  let filtered: string | undefined;
  for (const side of ['long', 'short'] as const) {
    const r = oneSide(i, side, levels, range, atrNow);
    if (r.order) return r;
    filtered ??= r.skipped;
  }
  return { order: null, skipped: filtered ?? 'no_setup' };
}

function oneSide(
  i: KillzoneSweepInput, side: Direction, levels: LiquidityLevel[], range: DealingRange | null, atrNow: number,
): KillzoneSweepResult {
  const c = i.config;
  const m = i.m5;
  const n = m.length - 1;
  const long = side === 'long';
  const s = long ? 1 : -1;
  const low = (k: number) => m[k].low;
  const high = (k: number) => m[k].high;
  const close = (k: number) => m[k].close;
  // The extreme on our side (low for a long), and the extreme the CHoCH must close beyond (high for a long).
  const ext = long ? low : high;
  const opp = long ? high : low;

  // 1. The sweep's extreme: the most extreme bar of the confirmation window, before this candle.
  const from = n - c.confirm_bars;
  let e = from;
  for (let k = from; k < n; k++) if (s * (ext(e) - ext(k)) > 0) e = k;
  const sweepTime = m[e].openTime;

  // 2. It took an intact level on that side and price has closed back beyond it.
  const sweptLevels = levels.filter((l) => l.side === (long ? 'sell' : 'buy')
    && l.formedAt <= sweepTime
    && (l.brokenAt === null || l.brokenAt >= sweepTime - c.sweep_bars * BAR_MS)
    && s * (l.price - ext(e)) > 0
    && s * (close(n) - l.price) > 0);
  if (!sweptLevels.length) return { order: null, skipped: 'no_setup' };
  // The one swept the deepest is the one that matters (the furthest level beyond which stops were run).
  const level = sweptLevels.sort((a, b) => s * (a.price - b.price))[0];
  // The sweep is a wick: the extreme bar, or one of the next sweep_bars, closed back beyond the level.
  let reclaimed = false;
  for (let k = e; k <= Math.min(n, e + c.sweep_bars - 1); k++) if (s * (close(k) - level.price) > 0) { reclaimed = true; break; }
  if (!reclaimed) return { order: null, skipped: 'no_setup' };

  // 3. CHoCH: this candle is the first close beyond the swing left in the bars before the sweep.
  if (e - c.choch_lookback < 0) return { order: null, skipped: 'no_setup' };
  let swing = opp(e - c.choch_lookback);
  for (let k = e - c.choch_lookback; k < e; k++) if (s * (opp(k) - swing) > 0) swing = opp(k);
  if (!(s * (close(n) - swing) > 0)) return { order: null, skipped: 'no_setup' };
  for (let k = e + 1; k < n; k++) if (s * (close(k) - swing) > 0) return { order: null, skipped: 'no_setup' };

  // 4. Entry: the middle of the newest fair value gap in the move from the sweep, else the broken swing.
  let limit = swing;
  for (let k = n - 1; k >= e + 1; k--) {
    const gapFar = long ? low(k + 1) : high(k + 1);
    const gapNear = long ? high(k - 1) : low(k - 1);
    if (s * (gapFar - gapNear) > 0) { limit = (gapFar + gapNear) / 2; break; }
  }
  const stop = ext(e) - s * c.stop_buffer_atr * atrNow;
  // The limit must wait below the close (long) and above the stop.
  if (!(s * (close(n) - limit) > 0) || !(s * (limit - stop) > 0)) return { order: null, skipped: 'no_room_for_entry' };

  // 5. Premium / discount: measured at the entry, against the 4h dealing range.
  if (!range) return { order: null, skipped: 'no_dealing_range' };
  const position = (limit - range.low) / (range.high - range.low);
  if (long ? position > 0.48 : position < 0.52) return { order: null, skipped: long ? 'long_not_in_discount' : 'short_not_in_premium' };

  // 5b. Higher-timeframe trend: bias = the 1h trend agrees and the 4h structure is not against us;
  // strict = and the 4h structure is with us.
  const f = c.trend_filter;
  const trend = i.market!.trend;
  if (f !== 'off' && !(long ? trend.long : trend.short)) return { order: null, skipped: 'against_htf_trend' };
  if (f === 'strict' && trend.h4 !== (long ? 'up' : 'down')) return { order: null, skipped: 'h4_structure_not_with_us' };

  // 6. Target: the nearest intact opposite level between min_rr and max_rr after costs, else a fixed min_rr.
  const ahead = levels
    .filter((l) => l.side === (long ? 'buy' : 'sell') && l.brokenAt === null && s * (l.price - limit) > 0)
    .sort((a, b) => s * (a.price - b.price));
  const pick = ahead.find((l) => {
    const rr = netRewardRisk(limit, stop, l.price, i.costPct);
    return rr >= i.minRr && rr <= c.max_rr;
  });
  // A hair beyond min_rr, so rounding cannot leave it at 1.9999999R and have the engine's min_rr check refuse it.
  const fixed = limit + s * ((i.minRr + 0.001) * Math.abs(limit - stop) + (i.costPct / 100) * limit);
  const target = pick ? pick.price : fixed;

  const sweptName = LIQUIDITY_NAMES[level.name];
  return {
    order: {
      symbol: i.symbol, side, tf: '5m', limitPrice: limit, stop, target,
      swept: sweptName, killzone: i.killzone!,
      maxHoldMin: c.max_hold_min, entryTimeoutMin: c.entry_timeout_min,
      progressCheckMin: c.progress_check_min, progressMinR: c.progress_min_r,
      note: `Hunter killzone sweep: ${sweptName} swept in ${i.killzone}, 5m CHoCH${pick ? `; target ${LIQUIDITY_NAMES[pick.name]}` : ''}`,
    },
  };
}
