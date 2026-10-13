// Timing warnings: whether now is a good moment to enter, for trades taken by
// hand. The engine only enters inside its open windows (the killzones: the
// first hours after the London and New York opens); a person may trade any
// time, so these warn instead of blocking.
//
// - Outside the open windows: the session's main move usually starts in them.
// - Move already done: since the latest window opened, price has run a large
//   share of the coin's usual daily range; entering now chases it.
// - Day's range used: today (UTC) has already moved the coin's usual daily range.
//
// The usual daily range is the average high-low of the last 14 whole UTC days.
// On closed 1h candles. Pure: the time and windows are passed in.
import type { Candle } from '../../../shared/types';
import type { MarketWarning } from './pumpWatch';

export interface OpenWindow { name: string; openTime: number; closeTime: number }

const DAY = 86_400_000;
/** A move since the window opened of this share of the usual day range: done. */
const MOVE_DONE_SHARE = 0.6;
/** Today's range at this share of the usual day range: used up. */
const RANGE_USED_SHARE = 1;

const NAME: Record<string, string> = { london: 'London', newyork: 'New York' };
const fmt = (p: number) => Number(p.toPrecision(5)).toString();
const inHours = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/** Average high-low of the last `days` whole UTC days before `now`'s day, from 1h candles; null with fewer than 5 days. */
export function usualDayRange(c1h: Candle[], now: number, days = 14): number | null {
  const today = Math.floor(now / DAY) * DAY;
  const byDay = new Map<number, { high: number; low: number; n: number }>();
  for (const c of c1h) {
    const d = Math.floor(c.openTime / DAY) * DAY;
    if (d >= today || d < today - days * DAY) continue;
    const g = byDay.get(d) ?? { high: -Infinity, low: Infinity, n: 0 };
    g.high = Math.max(g.high, c.high);
    g.low = Math.min(g.low, c.low);
    g.n++;
    byDay.set(d, g);
  }
  const whole = [...byDay.values()].filter((g) => g.n >= 20);
  if (whole.length < 5) return null;
  return whole.reduce((s, g) => s + g.high - g.low, 0) / whole.length;
}

/**
 * `windows`: the open windows around now (the latest that opened, and the next).
 * Warnings come with the time of the window (or day) they are about, so the same one is not told twice.
 */
export function timingWarnings(c1h: Candle[], now: number, windows: OpenWindow[]): MarketWarning[] {
  const out: MarketWarning[] = [];
  const range = usualDayRange(c1h, now);
  const last = c1h[c1h.length - 1];
  if (!last || range === null || !(range > 0)) return out;
  const price = last.close;

  const inside = windows.find((w) => w.openTime <= now && now < w.closeTime);
  const latest = windows.filter((w) => w.openTime <= now).sort((a, b) => b.openTime - a.openTime)[0];
  const next = windows.filter((w) => w.openTime > now).sort((a, b) => a.openTime - b.openTime)[0];
  if (!inside) {
    out.push({
      code: 'outside_window', level: 'caution', side: 'both', time: latest?.closeTime ?? Math.floor(now / DAY) * DAY,
      title: `Outside the open windows${next ? `: ${NAME[next.name] ?? next.name} opens in ${inHours(next.openTime - now)}` : ''}`,
      detail: 'Most of a session\'s move starts in the first hours after the London and New York opens; entries later in the day often catch the tail of a move or a choppy drift. The engine waits for the windows.',
    });
  }

  // Since the latest window opened (only that window's day: an old one says nothing about now).
  if (latest && now - latest.openTime < 12 * 3_600_000) {
    const since = c1h.filter((c) => c.openTime >= latest.openTime);
    const ref = since[0]?.open;
    if (ref !== undefined) {
      const move = price - ref;
      const share = Math.abs(move) / range;
      if (share >= MOVE_DONE_SHARE) {
        const up = move > 0;
        out.push({
          code: 'move_done', level: 'caution', side: up ? 'long' : 'short', time: latest.openTime,
          title: `Move already done: ${up ? 'up' : 'down'} ${((Math.abs(move) / ref) * 100).toFixed(1)}% since the ${NAME[latest.name] ?? latest.name} open`,
          detail: `That is ${(share * 100).toFixed(0)}% of its usual daily range (${fmt(range)}). ${up ? 'Longs' : 'Shorts'} entered now chase the move: wait for a pullback, or for the next open.`,
        });
      }
    }
  }

  const today = c1h.filter((c) => c.openTime >= Math.floor(now / DAY) * DAY);
  if (today.length) {
    const hi = Math.max(...today.map((c) => c.high));
    const lo = Math.min(...today.map((c) => c.low));
    if (hi - lo >= RANGE_USED_SHARE * range) {
      out.push({
        code: 'range_used', level: 'caution', side: 'both', time: Math.floor(now / DAY) * DAY,
        title: `Today's range is used up: ${fmt(lo)} – ${fmt(hi)}`,
        detail: `${(((hi - lo) / range) * 100).toFixed(0)}% of its usual daily range already. Targets further out than the day's high or low are less likely today.`,
      });
    }
  }
  return out;
}
