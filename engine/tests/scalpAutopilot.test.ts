import { describe, expect, it } from 'vitest';
import type { Candle } from '../../shared/types';
import { btcLastHourPct, decideScalp } from '../src/strategy/scalpAutopilot';
import type { EngineConfig } from '../src/config';

function mockConfig(): EngineConfig['scalp_autopilot'] {
  return {
    enabled: true,
    timeframes: ['5m', '15m'],
    kinds: ['sweep_reclaim', 'vwap_bounce', 'ema_pullback', 'orb', 'fvg_retest', 'volume_climax'],
    max_signal_age_sec: 120,
    max_stop_pct: 2.2,
    max_trades_per_day: null,
    max_hold_min: { '1m': 45, '5m': 120, '15m': 240 },
    entry_timeout_min: { '1m': 15, '5m': 35, '15m': 60 },
  };
}

function makeCandles(count: number, basePrice = 100, tfMinutes = 5): Candle[] {
  const tfMs = tfMinutes * 60_000;
  const start = 1_700_000_000_000;
  const out: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const openTime = start + i * tfMs;
    const closeTime = openTime + tfMs;
    // mild upward trend
    const open = price;
    price += (i % 2 === 0 ? 0.2 : -0.1);
    const close = price;
    const high = Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    out.push({
      symbol: 'TESTUSDT',
      tf: `${tfMinutes}m` as '5m' | '15m',
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume: 1000,
      quoteVolume: 1000 * close,
      trades: 100,
    });
  }
  return out;
}

describe('decideScalp', () => {
  it('ignores config.enabled: whether Hunter runs is the caller\'s switch, not the config default', () => {
    const cfg = mockConfig();
    cfg.enabled = false;
    const res = decideScalp({
      symbol: 'TESTUSDT',
      tf: '5m',
      candles: makeCandles(50),
      candles1h: makeCandles(100, 100, 60),
      btc1h: makeCandles(10, 50000, 60),
      sessionOpens: [],
      costPct: 0.2,
      now: 1_700_000_000_000 + 50 * 300_000,
      config: cfg,
    });
    expect(res.skipped).not.toBe('autopilot_disabled');
    expect(res.skipped).toBe('no_fresh_setup');
  });

  it('skips if timeframe is not enabled in config', () => {
    const cfg = mockConfig();
    cfg.timeframes = ['15m'];
    const res = decideScalp({
      symbol: 'TESTUSDT',
      tf: '5m',
      candles: makeCandles(50),
      candles1h: makeCandles(100, 100, 60),
      btc1h: makeCandles(10, 50000, 60),
      sessionOpens: [],
      costPct: 0.2,
      now: 1_700_000_000_000 + 50 * 300_000,
      config: cfg,
    });
    expect(res.order).toBeNull();
    expect(res.skipped).toBe('timeframe_not_enabled');
  });

  it('skips if not enough candles (< 40)', () => {
    const res = decideScalp({
      symbol: 'TESTUSDT',
      tf: '5m',
      candles: makeCandles(30),
      candles1h: makeCandles(100, 100, 60),
      btc1h: makeCandles(10, 50000, 60),
      sessionOpens: [],
      costPct: 0.2,
      now: 1_700_000_000_000 + 30 * 300_000,
      config: mockConfig(),
    });
    expect(res.order).toBeNull();
    expect(res.skipped).toBe('not_enough_candles');
  });

  it('measures BTC over the last closed hour, however long the window passed in', () => {
    const hour = (i: number, close: number): Candle =>
      ({ symbol: 'BTCUSDT', tf: '1h', openTime: i * 3600_000, closeTime: (i + 1) * 3600_000, open: close, high: close, low: close, close, volume: 1, quoteVolume: close, trades: 1 });
    // 50 hours of a slow slide from 64000 to 60000 (-6%), then a flat last hour: not dumping now.
    const window = Array.from({ length: 50 }, (_, i) => hour(i, 64000 - i * (4000 / 49)));
    window.push(hour(50, window[49].close));
    expect(btcLastHourPct(window)).toBeCloseTo(0, 6);
    // The last hour itself falls 1.67%.
    expect(btcLastHourPct([hour(0, 60000), hour(1, 59000)])).toBeCloseTo(-1.667, 2);
    expect(btcLastHourPct([hour(0, 60000)])).toBeNull();
  });
});

