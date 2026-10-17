import { describe, expect, it } from 'vitest';
import { openDb } from '../src/storage/db';
import { IdeaLog, ideaOutcome, ideaQualityStats, type IdeaLogRow } from '../src/storage/ideaLog';
import type { Candle } from '../../shared/types';

const T = Date.parse('2026-10-16T08:00Z');
const M15 = 900_000;
const bar = (i: number, high: number, low: number, close = (high + low) / 2): Candle =>
  ({ symbol: 'PYTHUSDT', tf: '15m', openTime: T + i * M15, closeTime: T + (i + 1) * M15 - 1, open: close, high, low, close, volume: 1, quoteVolume: 1, trades: 1 });
const idea = (over: Partial<IdeaLogRow> = {}): IdeaLogRow =>
  ({ symbol: 'PYTHUSDT', time: T, direction: 'long', quality: 100, confirmed: false, price: 0.0885, stop: 0.0860, target: 0.0960, ...over });

describe('ideaOutcome', () => {
  it('the stop first: the PYTH long that kept falling', () => {
    expect(ideaOutcome(idea(), [bar(0, 0.0890, 0.0875), bar(1, 0.0880, 0.0855)])).toEqual({ outcome: 'stop', r: -1 });
  });

  it('the target first, in R of the risk from the idea price', () => {
    const r = ideaOutcome(idea(), [bar(0, 0.0900, 0.0870), bar(1, 0.0965, 0.0890)]);
    expect(r?.outcome).toBe('target');
    expect(r?.r).toBeCloseTo((0.0960 - 0.0885) / (0.0885 - 0.0860), 9);
  });

  it('a candle reaching both counts as the stop; neither: open, at the last close', () => {
    expect(ideaOutcome(idea(), [bar(0, 0.0970, 0.0850)])?.outcome).toBe('stop');
    const open = ideaOutcome(idea(), [bar(0, 0.0900, 0.0870, 0.0895)]);
    expect(open?.outcome).toBe('open');
    expect(open?.r).toBeCloseTo((0.0895 - 0.0885) / 0.0025, 9);
  });

  it('shorts mirrored; nothing to measure when the price is already past the stop', () => {
    const short = idea({ direction: 'short', price: 0.09, stop: 0.092, target: 0.085 });
    expect(ideaOutcome(short, [bar(0, 0.0905, 0.0845)])?.outcome).toBe('target');
    expect(ideaOutcome(idea({ price: 0.0855 }), [bar(0, 0.09, 0.085)])).toBeNull();
  });
});

describe('ideaQualityStats', () => {
  it('counts each idea once, by quality band and confirmation', () => {
    const rows = [
      idea(),                                       // 100, unconfirmed, stopped
      idea({ time: T + M15 }),                      // the same idea a candle later: not counted again
      idea({ symbol: 'ARBUSDT', quality: 90, confirmed: true }),   // won
      idea({ symbol: 'OPUSDT', quality: 60 }),      // open
    ];
    const candles: Record<string, Candle[]> = {
      PYTHUSDT: [bar(0, 0.0880, 0.0850)],
      ARBUSDT: [bar(0, 0.0970, 0.0880)],
      OPUSDT: [bar(0, 0.0890, 0.0880)],
    };
    const bands = ideaQualityStats(rows, (r) => candles[r.symbol]);
    const find = (band: string, confirmed: boolean) => bands.find((b) => b.band === band && b.confirmed === confirmed)!;
    expect(find('85-100', false)).toMatchObject({ ideas: 1, target: 0, stop: 1, hitRatePct: 0 });
    expect(find('85-100', true)).toMatchObject({ ideas: 1, target: 1, stop: 0, hitRatePct: 100 });
    expect(find('50-69', false)).toMatchObject({ ideas: 1, open: 1, hitRatePct: null });
    expect(find('0-49', true)).toMatchObject({ ideas: 0, avgR: null });
  });
});

describe('IdeaLog storage', () => {
  it('keeps one row per coin and 15m close', () => {
    const log = new IdeaLog(openDb(':memory:'));
    log.record(idea());
    log.record(idea({ quality: 50 }));             // same coin and moment: ignored
    log.record(idea({ time: T + M15, confirmed: true }));
    const rows = log.since(T);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ quality: 100, confirmed: false });
    expect(rows[1].confirmed).toBe(true);
  });
});
