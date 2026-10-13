import { describe, expect, it } from 'vitest';
import { timingWarnings, usualDayRange } from '../src/analysis/timing';
import type { Candle } from '../../shared/types';

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 6, 1);

/** 1h candles from T0: each day ranges 98-102 (a usual day range of 4), then `today` closes after them. */
function candles(days: number, today: number[] = []): Candle[] {
  const out: Candle[] = [];
  const add = (t: number, open: number, close: number, high = Math.max(open, close), low = Math.min(open, close)) =>
    out.push({ symbol: 'X', tf: '1h', openTime: t, closeTime: t + H, open, high, low, close, volume: 1, quoteVolume: 1, trades: 1 });
  for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) add(T0 + d * DAY + h * H, 100, 100, h === 12 ? 102 : 100, h === 6 ? 98 : 100);
  today.forEach((close, h) => add(T0 + days * DAY + h * H, h ? today[h - 1] : 100, close));
  return out;
}

const london = (day: number) => ({ name: 'london', openTime: T0 + day * DAY + 7 * H, closeTime: T0 + day * DAY + 9 * H });
const newyork = (day: number) => ({ name: 'newyork', openTime: T0 + day * DAY + 13.5 * H, closeTime: T0 + day * DAY + 15.5 * H });

describe('timing warnings', () => {
  it('measures the usual day range over whole past days', () => {
    expect(usualDayRange(candles(14), T0 + 14 * DAY)).toBe(4);
    expect(usualDayRange(candles(3), T0 + 3 * DAY)).toBeNull();
  });

  it('says nothing inside a window before the move', () => {
    const c = candles(14, [100, 100, 100, 100, 100, 100, 100, 100.5]);
    expect(timingWarnings(c, T0 + 14 * DAY + 8 * H, [london(14), newyork(14)])).toEqual([]);
  });

  it('warns outside the windows, naming the next one', () => {
    const c = candles(14, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const w = timingWarnings(c, T0 + 14 * DAY + 11 * H, [london(14), newyork(14)]);
    expect(w.map((x) => x.code)).toEqual(['outside_window']);
    expect(w[0].title).toBe('Outside the open windows: New York opens in 2h 30m');
  });

  it('warns that the move is done when price has run most of a usual day since the open, for that side', () => {
    // Up 3 (75% of a 4 range) since London opened at 07:00.
    const c = candles(14, [100, 100, 100, 100, 100, 100, 100, 101, 102, 103]);
    const w = timingWarnings(c, T0 + 14 * DAY + 10 * H, [london(14), newyork(14)]);
    const done = w.find((x) => x.code === 'move_done')!;
    expect(done).toMatchObject({ side: 'long', level: 'caution' });
    expect(done.title).toBe('Move already done: up 3.0% since the London open');
  });

  it('warns when today has already moved its usual range', () => {
    const c = candles(14, [100, 98, 97, 99, 101.5]);
    const w = timingWarnings(c, T0 + 14 * DAY + 5 * H, [london(14), newyork(14)]);
    expect(w.map((x) => x.code)).toContain('range_used');
  });
});
