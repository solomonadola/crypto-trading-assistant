import { describe, expect, it } from 'vitest';
import { analyzeVolumeSurge } from '../src/analysis/volumeSurge';
import type { Candle } from '../../shared/types';

function makeCandle(i: number, close: number, volume: number): Candle {
  const openTime = i * 3_600_000;
  return {
    symbol: 'TESTUSDT',
    tf: '1h',
    openTime,
    closeTime: openTime + 3_600_000 - 1,
    open: close * 0.99,
    high: close * 1.01,
    low: close * 0.98,
    close,
    volume,
    quoteVolume: volume * close,
    trades: 100,
  };
}

describe('volumeSurge', () => {
  it('detects volume ignition when volume expands 3x-4x with fresh price breakout', () => {
    // 5 days of baseline: 120 candles with 1,000 volume at price 10
    const candles: Candle[] = [];
    for (let i = 0; i < 96; i++) {
      candles.push(makeCandle(i, 10, 1000));
    }
    // Last 24 hours: volume surges to 4,000 per candle and price breaks out to 12 (+20%)
    for (let i = 96; i < 120; i++) {
      candles.push(makeCandle(i, 12, 4000));
    }

    const runner = analyzeVolumeSurge('TESTUSDT', candles);
    expect(runner).not.toBeNull();
    expect(runner!.stage).toBe('ignition');
    expect(runner!.rvol).toBeGreaterThanOrEqual(3.0);
    expect(runner!.change24hPct).toBeCloseTo(20, 0);
    expect(runner!.potentialMultiplier).toBe('2x - 3x Setup Candidate');
  });

  it('detects active multi-day continuation runner when up +60% over 3 days with elevated volume', () => {
    const candles: Candle[] = [];
    // 3 days baseline at price 10, volume 1,000
    for (let i = 0; i < 72; i++) {
      candles.push(makeCandle(i, 10, 1000));
    }
    // 3 days runner: price climbs from 10 to 16 (+60%), volume 2,500
    for (let i = 72; i < 144; i++) {
      const p = 10 + ((i - 72) / 72) * 6;
      candles.push(makeCandle(i, p, 2500));
    }

    const runner = analyzeVolumeSurge('TESTUSDT', candles);
    expect(runner).not.toBeNull();
    expect(runner!.stage).toBe('continuation_runner');
    expect(runner!.change3dPct).toBeGreaterThanOrEqual(50);
  });

  it('flags parabolic blowoff when extended +180% with massive volume spike', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 72; i++) {
      candles.push(makeCandle(i, 10, 1000));
    }
    // Vertical explosion to 28 (+180%)
    for (let i = 72; i < 144; i++) {
      candles.push(makeCandle(i, 28, 6000));
    }

    const runner = analyzeVolumeSurge('TESTUSDT', candles);
    expect(runner).not.toBeNull();
    expect(runner!.stage).toBe('parabolic_blowoff');
    expect(runner!.stageTone).toBe('danger');
  });

  it('detects early volume ramp when volume expands consecutively over recent hours before large pump', () => {
    const candles: Candle[] = [];
    // 3 days baseline (72 candles) with price 10, volume 1,000
    for (let i = 0; i < 72; i++) {
      candles.push(makeCandle(i, 10, 1000));
    }
    // Next 20 candles: still calm around 10, volume ~1,000
    for (let i = 72; i < 92; i++) {
      candles.push(makeCandle(i, 10, 1000));
    }
    // Last 4 hours: consecutive volume ramp: 1,500 -> 2,200 -> 3,200 -> 4,800
    // Price only moves mildly from 10 to 10.6 (+6% 24h)
    const rampVols = [1500, 2200, 3200, 4800];
    const rampPrices = [10.1, 10.25, 10.4, 10.6];
    for (let i = 0; i < 4; i++) {
      candles.push(makeCandle(92 + i, rampPrices[i], rampVols[i]));
    }

    const runner = analyzeVolumeSurge('RAMPUSDT', candles);
    expect(runner).not.toBeNull();
    expect(runner!.stage).toBe('early_ramp');
    expect(runner!.stageLabel).toBe('EARLY VOLUME RAMP');
    expect(runner!.change24hPct).toBeLessThanOrEqual(28);
    expect(runner!.potentialMultiplier).toBe('Pre-Pump Accumulation Candidate');
    expect(runner!.score).toBeGreaterThanOrEqual(50);
  });

  it('scans and automatically discovers surge runners via scanVolumeSurgeRunners', async () => {
    const { scanVolumeSurgeRunners } = await import('../src/scanner');
    const mockClient = {
      tickers24h: async () => [
        { symbol: 'RAMPUSDT', lastPrice: 10.6, priceChangePercent: 6, quoteVolume: 25_000_000 },
        { symbol: 'QUIETUSDT', lastPrice: 5.0, priceChangePercent: 0.5, quoteVolume: 12_000_000 },
      ],
      klines: async (symbol: string) => {
        if (symbol === 'RAMPUSDT') {
          const candles: Candle[] = [];
          for (let i = 0; i < 92; i++) candles.push(makeCandle(i, 10, 1000));
          const rampVols = [1500, 2200, 3200, 4800];
          const rampPrices = [10.1, 10.25, 10.4, 10.6];
          for (let i = 0; i < 4; i++) candles.push(makeCandle(92 + i, rampPrices[i], rampVols[i]));
          return candles;
        }
        const quiet: Candle[] = [];
        for (let i = 0; i < 96; i++) quiet.push(makeCandle(i, 5, 1000));
        return quiet;
      },
    } as any;

    const runners = await scanVolumeSurgeRunners(mockClient);
    expect(runners.length).toBe(1);
    expect(runners[0].symbol).toBe('RAMPUSDT');
    expect(runners[0].stage).toBe('early_ramp');
  });

  it('returns null for quiet coins with normal baseline volume and low price change', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 96; i++) {
      candles.push(makeCandle(i, 10, 1000));
    }
    const runner = analyzeVolumeSurge('TESTUSDT', candles);
    expect(runner).toBeNull();
  });
});

