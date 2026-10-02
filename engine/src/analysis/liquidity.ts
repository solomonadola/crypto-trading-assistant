// Liquidity levels and premium / discount (ENGINE_PLAN.md Section 18.3).
//
// Levels where stops sit: the previous UTC day's high and low, today's Asian
// range (00:00-08:00 UTC) and London range (07:00-11:00 London time), equal
// highs and lows on 1h, and the last confirmed 4h swings. Each level records
// when it formed and when a 15m candle first traded through it (a sweep or a
// break); a setup needs it intact until the sweep. Pure: everything comes
// from the context's candles.
import type { Candle } from '../../../shared/types';
import { localDateOf, localToUtc } from '../sessions';
import type { Context } from '../strategy/context';

export type LiquidityName = 'PDH' | 'PDL' | 'asian_high' | 'asian_low' | 'london_high' | 'london_low' | 'EQH' | 'EQL' | '4h_swing_high' | '4h_swing_low';

export const LIQUIDITY_NAMES: Record<LiquidityName, string> = {
  PDH: 'previous day high', PDL: 'previous day low', asian_high: 'Asian high', asian_low: 'Asian low',
  london_high: 'London high', london_low: 'London low', EQH: 'equal highs', EQL: 'equal lows',
  '4h_swing_high': '4h swing high', '4h_swing_low': '4h swing low',
};

export interface LiquidityLevel {
  name: LiquidityName;
  /** buy: above the price, where shorts' stops and breakout buys sit (a long's target). sell: below. */
  side: 'buy' | 'sell';
  price: number;
  /** When the level became known. */
  formedAt: number;
  /** Close time of the first 15m candle after formedAt that traded through it, or null while intact. */
  brokenAt: number | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Equal highs / lows: swings within this many 1h ATRs of each other. */
const EQUAL_ATR = 0.1;
const EQUAL_LOOKBACK = 48 * HOUR;

function range(candles: Candle[], from: number, to: number): { high: number; low: number } | null {
  const inside = candles.filter((c) => c.openTime >= from && c.closeTime <= to);
  if (!inside.length) return null;
  return { high: Math.max(...inside.map((c) => c.high)), low: Math.min(...inside.map((c) => c.low)) };
}

function brokenAt(m15: Candle[], side: 'buy' | 'sell', price: number, formedAt: number, t: number): number | null {
  for (const c of m15) {
    if (c.openTime < formedAt || c.closeTime > t) continue;
    if (side === 'buy' ? c.high > price : c.low < price) return c.closeTime;
  }
  return null;
}

/** Every liquidity level known at the context's time. */
export function liquidityLevels(ctx: Context): LiquidityLevel[] {
  const { t } = ctx;
  const m15 = ctx.m15.candles;
  const day = Math.floor(t / DAY) * DAY;
  const raw: Omit<LiquidityLevel, 'brokenAt'>[] = [];
  const pair = (hi: LiquidityName, lo: LiquidityName, r: { high: number; low: number } | null, formedAt: number) => {
    if (!r) return;
    raw.push({ name: hi, side: 'buy', price: r.high, formedAt }, { name: lo, side: 'sell', price: r.low, formedAt });
  };

  pair('PDH', 'PDL', range(m15, day - DAY, day), day);
  if (t >= day + 8 * HOUR) pair('asian_high', 'asian_low', range(m15, day, day + 8 * HOUR), day + 8 * HOUR);
  const ld = localDateOf(t, 'Europe/London');
  const londonFrom = localToUtc(ld.y, ld.m, ld.d, 7, 0, 'Europe/London');
  const londonTo = localToUtc(ld.y, ld.m, ld.d, 11, 0, 'Europe/London');
  if (t >= londonTo) pair('london_high', 'london_low', range(m15, londonFrom, londonTo), londonTo);

  // Equal highs / lows: confirmed 1h swings of the last 48 h within 0.1 x ATR(1h) of each other.
  const h1 = ctx.h1.candles;
  const atr = ctx.atr1h[ctx.atr1h.length - 1];
  if (Number.isFinite(atr)) {
    for (const type of ['high', 'low'] as const) {
      const swings = ctx.pivots1h
        .filter((p) => p.type === type && h1[p.confirmedAt] && h1[p.confirmedAt].closeTime <= t && h1[p.index].openTime >= t - EQUAL_LOOKBACK)
        .sort((a, b) => a.index - b.index);
      for (let i = 1; i < swings.length; i++) {
        const prev = swings.slice(0, i).filter((p) => Math.abs(p.price - swings[i].price) <= EQUAL_ATR * atr);
        if (!prev.length) continue;
        const prices = [...prev, swings[i]].map((p) => p.price);
        raw.push({
          name: type === 'high' ? 'EQH' : 'EQL', side: type === 'high' ? 'buy' : 'sell',
          price: type === 'high' ? Math.max(...prices) : Math.min(...prices), formedAt: h1[swings[i].confirmedAt].closeTime,
        });
      }
    }
  }

  // The last confirmed 4h swings.
  const h4 = ctx.h4.candles;
  for (const type of ['high', 'low'] as const) {
    const last = [...ctx.pivots4h].reverse().find((p) => p.type === type && h4[p.confirmedAt] && h4[p.confirmedAt].closeTime <= t);
    if (last) raw.push({ name: type === 'high' ? '4h_swing_high' : '4h_swing_low', side: type === 'high' ? 'buy' : 'sell', price: last.price, formedAt: h4[last.confirmedAt].closeTime });
  }

  return raw.map((l) => ({ ...l, brokenAt: brokenAt(m15, l.side, l.price, l.formedAt, t) }));
}

export interface DealingRange {
  high: number;
  low: number;
  /** (price - low) / (high - low): under 0.5 is discount, over 0.5 premium; beyond the range, below 0 or above 1. */
  position: number;
}

/** The 4h dealing range: the latest confirmed 4h swing high and swing low. Null until both exist. */
export function dealingRange(ctx: Context): DealingRange | null {
  const h4 = ctx.h4.candles;
  const known = ctx.pivots4h.filter((p) => h4[p.confirmedAt] && h4[p.confirmedAt].closeTime <= ctx.t);
  const high = [...known].reverse().find((p) => p.type === 'high');
  const low = [...known].reverse().find((p) => p.type === 'low');
  if (!high || !low || !(high.price > low.price)) return null;
  return { high: high.price, low: low.price, position: (ctx.price - low.price) / (high.price - low.price) };
}

/** Whether premium / discount allows a trade (Section 18.3): longs at or under 0.48, shorts at or over 0.52. */
export function zoneAllows(range: DealingRange | null, side: 'long' | 'short'): boolean {
  if (!range) return false;
  return side === 'long' ? range.position <= 0.48 : range.position >= 0.52;
}
