import { describe, expect, it } from 'vitest';
import { diagnoseVolume } from '../src/analysis/volumeDiagnosis';
import type { Candle } from '../../shared/types';

function makeCandles(specs: { high: number; low: number; open: number; close: number; volume: number }[]): Candle[] {
  const baseT = 1700000000000;
  return specs.map((s, idx) => ({
    symbol: 'BTCUSDT',
    tf: '1h',
    openTime: baseT + idx * 3600000,
    closeTime: baseT + (idx + 1) * 3600000 - 1,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    volume: s.volume,
    quoteVolume: s.volume * s.close,
    trades: 100,
  }));
}

describe('volumeDiagnosis', () => {
  it('detects climax absorption on high volume and long upper rejection wick', () => {
    // 20 normal candles with volume 100
    const candles: Candle[] = Array.from({ length: 22 }, () => ({
      symbol: 'BTCUSDT',
      tf: '1h',
      openTime: 1000,
      closeTime: 2000,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 100,
      quoteVolume: 10000,
      trades: 100,
    }));

    // Add a climax candle with 3.0x volume and long upper wick
    candles.push({
      symbol: 'BTCUSDT',
      tf: '1h',
      openTime: 3000,
      closeTime: 4000,
      open: 101,
      high: 110,
      low: 100,
      close: 102, // upper wick is 110 - 102 = 8, range is 10, wick ratio 80%
      volume: 320, // 3.2x average
      quoteVolume: 32000,
      trades: 500,
    });

    const diag = diagnoseVolume(candles);
    expect(diag.regime).toBe('climax');
    expect(diag.rvol).toBeGreaterThanOrEqual(2.2);
    expect(diag.label).toContain('Absorption');
    expect(diag.whyItHappened).toContain('Institutional sellers aggressively absorbed');
  });

  it('detects institutional volume expansion on directional breakout', () => {
    const candles: Candle[] = Array.from({ length: 22 }, () => ({
      symbol: 'BTCUSDT',
      tf: '1h',
      openTime: 1000,
      closeTime: 2000,
      open: 100,
      high: 101,
      low: 99.5,
      close: 100.5,
      volume: 100,
      quoteVolume: 10000,
      trades: 100,
    }));

    // Add an expansion candle: solid body, 1.8x volume
    candles.push({
      symbol: 'BTCUSDT',
      tf: '1h',
      openTime: 3000,
      closeTime: 4000,
      open: 101,
      high: 105,
      low: 100.8,
      close: 104.8, // wide body closing near high
      volume: 190,
      quoteVolume: 20000,
      trades: 300,
    });

    const diag = diagnoseVolume(candles);
    expect(diag.regime).toBe('expansion');
    expect(diag.rvol).toBeGreaterThanOrEqual(1.4);
    expect(diag.label).toContain('Volume Expansion');
    expect(diag.whyItHappened).toContain('confirms institutional momentum');
  });

  it('detects low/drying volume on thin participation', () => {
    const candles: Candle[] = Array.from({ length: 22 }, () => ({
      symbol: 'BTCUSDT',
      tf: '1h',
      openTime: 1000,
      closeTime: 2000,
      open: 100,
      high: 101,
      low: 99.5,
      close: 100.5,
      volume: 100,
      quoteVolume: 10000,
      trades: 100,
    }));

    // Add drying candle: 0.4x volume
    candles.push({
      symbol: 'BTCUSDT',
      tf: '1h',
      openTime: 3000,
      closeTime: 4000,
      open: 100.5,
      high: 101,
      low: 100.2,
      close: 100.7,
      volume: 40,
      quoteVolume: 4000,
      trades: 30,
    });

    const diag = diagnoseVolume(candles);
    expect(diag.regime).toBe('drying');
    expect(diag.rvol).toBeLessThan(0.65);
    expect(diag.label).toContain('Drying');
  });
});

