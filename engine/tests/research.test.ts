import { describe, expect, it } from 'vitest';
import { daily } from '../src/backtest/research';
import type { Candle } from '../../shared/types';

const D = Date.UTC(2025, 0, 2);
const h4 = (openTime: number, i: number): Candle => ({
  symbol: 'SOLUSDT', tf: '4h', openTime, closeTime: openTime + 14_400_000, open: 100 + i, high: 110 + i, low: 90 - i, close: 101 + i, volume: 1, quoteVolume: 10, trades: 2,
});

describe('daily candles for the slow backtest', () => {
  it('only complete UTC days of six 4h candles', () => {
    // Two 4h candles of the day before, then one full day, then three of the next.
    const list = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8].map((k, i) => h4(D + k * 14_400_000, i));
    const d = daily(list);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ openTime: D, closeTime: D + 86_400_000, open: 102, close: 108, high: 117, low: 83, volume: 6, quoteVolume: 60, trades: 12 });
  });
});
