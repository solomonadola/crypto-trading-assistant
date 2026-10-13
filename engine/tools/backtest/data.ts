// Downloads and caches Binance perpetual klines in SQLite for backtesting.
// Never touches data/engine/engine.db: keeps all backtest candles in data/backtest/candles.db.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDb } from '../../src/storage/db';
import { CandleStore } from '../../src/feed/candleStore';
import { BinancePublic, type SymbolInfo } from '../../src/feed/binancePublic';
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../../../shared/types';

export const DEFAULT_BACKTEST_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT',
  'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'INJUSDT',
  'TIAUSDT', 'SEIUSDT', 'WIFUSDT', 'PEPEUSDT', 'LTCUSDT',
  'DOTUSDT', 'ATOMUSDT', 'FILUSDT', 'RENDERUSDT', 'ENAUSDT',
];

export const BACKTEST_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];

export interface BacktestDataOptions {
  dbPath?: string;
  symbols?: string[];
  timeframes?: Timeframe[];
  fromMs: number;
  toMs: number;
  warmupDays?: number;
  onProgress?: (msg: string) => void;
}

export interface BacktestDataResult {
  store: CandleStore;
  dbPath: string;
  symbols: string[];
  rules: Map<string, SymbolInfo>;
}

export async function ensureBacktestData(opts: BacktestDataOptions): Promise<BacktestDataResult> {
  const dbPath = opts.dbPath ?? path.resolve('data/backtest/candles.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = openDb(dbPath);
  const store = new CandleStore(db);
  const binance = new BinancePublic({
    restBase: 'https://fapi.binance.com',
    timeoutMs: 30_000,
    maxRetries: 5,
  });
  const log = opts.onProgress ?? ((m: string) => console.log(`[backtest-data] ${m}`));

  const symbols = opts.symbols ?? DEFAULT_BACKTEST_SYMBOLS;
  const tfs = opts.timeframes ?? BACKTEST_TIMEFRAMES;
  const warmupMs = (opts.warmupDays ?? 30) * 86_400_000;
  const fetchFrom = Math.max(0, opts.fromMs - warmupMs);
  const fetchTo = opts.toMs;

  log(`Fetching perpetual symbol rules from Binance...`);
  let symbolInfos: SymbolInfo[] = [];
  try {
    symbolInfos = await binance.perpetualSymbols();
  } catch (err) {
    log(`Warning: could not fetch exchangeInfo: ${String(err)}. Proceeding with defaults.`);
  }
  const rules = new Map<string, SymbolInfo>(symbolInfos.map((s) => [s.symbol, s]));

  for (const symbol of symbols) {
    for (const tf of tfs) {
      const tfMs = TIMEFRAME_MS[tf];
      const { min, max } = store.bounds(symbol, tf);
      const rangesToFetch: Array<{ from: number; to: number }> = [];

      if (min === null || max === null) {
        rangesToFetch.push({ from: fetchFrom, to: fetchTo });
      } else {
        if (min > fetchFrom + tfMs) {
          rangesToFetch.push({ from: fetchFrom, to: min - 1 });
        }
        if (max < fetchTo - tfMs) {
          rangesToFetch.push({ from: max + tfMs, to: fetchTo });
        }
      }

      if (rangesToFetch.length === 0) continue;

      const chunkDays = tf === '1m' ? 7 : 30;
      const chunkMs = chunkDays * 86_400_000;

      for (const range of rangesToFetch) {
        log(`Downloading ${symbol} [${tf}] from ${new Date(range.from).toISOString().slice(0, 10)} to ${new Date(range.to).toISOString().slice(0, 10)}...`);
        let curr = range.from;
        while (curr <= range.to) {
          const chunkEnd = Math.min(curr + chunkMs - 1, range.to);
          try {
            const candles = await binance.klinesRange(symbol, tf, curr, chunkEnd);
            if (candles.length > 0) {
              store.save(candles);
              log(`Saved ${candles.length} candles for ${symbol} [${tf}] (${new Date(curr).toISOString().slice(0, 10)} to ${new Date(chunkEnd).toISOString().slice(0, 10)}).`);
            }
          } catch (err) {
            log(`Error fetching ${symbol} [${tf}] chunk: ${String(err)}`);
          }
          curr = chunkEnd + tfMs;
        }
      }
    }
  }

  return { store, dbPath, symbols, rules };
}
