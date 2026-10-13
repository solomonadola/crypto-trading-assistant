import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CandleStore } from '../src/feed/candleStore';
import { runBacktest } from '../tools/backtest/run';
import { generateReport } from '../tools/backtest/report';
import { loadConfig } from '../src/config';
import type { Candle, Timeframe } from '../../shared/types';
import type { SymbolInfo } from '../src/feed/binancePublic';

function createMemoryStore(): { db: any; store: CandleStore } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE candles (
      symbol TEXT NOT NULL,
      tf TEXT NOT NULL,
      open_time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      quote_volume REAL NOT NULL,
      trades INTEGER NOT NULL,
      PRIMARY KEY (symbol, tf, open_time)
    ) WITHOUT ROWID;
  `);
  return { db, store: new CandleStore(db) };
}

function generateSyntheticCandles(symbol: string, startMs: number, countBars: number, tf: Timeframe, basePrice = 100): Candle[] {
  const tfMs = tf === '1m' ? 60_000 : tf === '5m' ? 300_000 : tf === '15m' ? 900_000 : 3600_000;
  const out: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < countBars; i++) {
    const openTime = startMs + i * tfMs;
    const closeTime = openTime + tfMs;
    const open = price;
    price += (i % 3 === 0 ? 0.4 : -0.2);
    const close = price;
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    out.push({
      symbol,
      tf,
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume: 1000,
      quoteVolume: 1000 * close,
      trades: 150,
    });
  }
  return out;
}

describe('Backtest Harness', () => {
  const startMs = 1_700_000_000_000;
  const durationMs = 3 * 86_400_000; // 3 days
  const toMs = startMs + durationMs;

  it('runs deterministically and gives identical results on identical input', async () => {
    const { store } = createMemoryStore();
    const symbol = 'BTCUSDT';

    // Seed 1m, 5m, 15m, 1h candles
    const c1m = generateSyntheticCandles(symbol, startMs - 86_400_000, 4 * 1440, '1m', 50000);
    const c5m = generateSyntheticCandles(symbol, startMs - 86_400_000, 4 * 288, '5m', 50000);
    const c15m = generateSyntheticCandles(symbol, startMs - 86_400_000, 4 * 96, '15m', 50000);
    const c1h = generateSyntheticCandles(symbol, startMs - 86_400_000, 4 * 24, '1h', 50000);

    store.save([...c1m, ...c5m, ...c15m, ...c1h]);

    const rules = new Map<string, SymbolInfo>([
      [symbol, { symbol, baseAsset: 'BTC', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 }],
    ]);

    const cfg1 = loadConfig();
    const cfg2 = loadConfig();

    const res1 = await runBacktest({
      config: cfg1,
      store,
      symbols: [symbol],
      rules,
      fromMs: startMs,
      toMs,
    });

    const res2 = await runBacktest({
      config: cfg2,
      store,
      symbols: [symbol],
      rules,
      fromMs: startMs,
      toMs,
    });

    expect(res1.ordersPlaced.length).toBe(res2.ordersPlaced.length);
    expect(res1.trades.length).toBe(res2.trades.length);
    expect(res1.equityCurve.length).toBe(res2.equityCurve.length);

    const report1 = generateReport(res1, { label: 'test' });
    const report2 = generateReport(res2, { label: 'test' });
    expect(report1.overall.totalPnl).toBe(report2.overall.totalPnl);
    expect(report1.overall.winRatePct).toBe(report2.overall.winRatePct);
  });

  it('generates structured reports with correct metrics', async () => {
    const { store } = createMemoryStore();
    const symbol = 'SOLUSDT';

    const c1m = generateSyntheticCandles(symbol, startMs - 86_400_000, 2 * 1440, '1m', 150);
    const c5m = generateSyntheticCandles(symbol, startMs - 86_400_000, 2 * 288, '5m', 150);
    const c15m = generateSyntheticCandles(symbol, startMs - 86_400_000, 2 * 96, '15m', 150);
    const c1h = generateSyntheticCandles(symbol, startMs - 86_400_000, 2 * 24, '1h', 150);
    const btc1h = generateSyntheticCandles('BTCUSDT', startMs - 86_400_000, 2 * 24, '1h', 60000);

    store.save([...c1m, ...c5m, ...c15m, ...c1h, ...btc1h]);

    const rules = new Map<string, SymbolInfo>([
      [symbol, { symbol, baseAsset: 'SOL', tickSize: 0.01, stepSize: 0.1, minQty: 0.1, minNotional: 5 }],
    ]);

    const res = await runBacktest({
      store,
      symbols: [symbol],
      rules,
      fromMs: startMs,
      toMs: startMs + 86_400_000,
    });

    const report = generateReport(res, {
      label: 'sol_test',
      splitMs: startMs + 43_200_000,
    });

    expect(report.label).toBe('sol_test');
    expect(report.symbols).toContain('SOLUSDT');
    expect(report.inSample).toBeDefined();
    expect(report.outOfSample).toBeDefined();
    expect(Array.isArray(report.monthly)).toBe(true);
  });
});

