// Closed candles in SQLite, one row per (symbol, timeframe, open time).
import type { DB } from '../storage/db';
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../../../shared/types';

interface Row {
  symbol: string;
  tf: string;
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
  trades: number;
}

const fromRow = (r: Row): Candle => ({
  symbol: r.symbol,
  tf: r.tf as Timeframe,
  openTime: r.open_time,
  closeTime: r.open_time + TIMEFRAME_MS[r.tf as Timeframe],
  open: r.open,
  high: r.high,
  low: r.low,
  close: r.close,
  volume: r.volume,
  quoteVolume: r.quote_volume,
  trades: r.trades,
});

export class CandleStore {
  private readonly upsert;
  private readonly selectLast;
  private readonly selectRange;
  private readonly selectLatest;

  constructor(private readonly db: DB) {
    this.upsert = db.prepare(`INSERT INTO candles (symbol, tf, open_time, open, high, low, close, volume, quote_volume, trades)
      VALUES (@symbol, @tf, @openTime, @open, @high, @low, @close, @volume, @quoteVolume, @trades)
      ON CONFLICT(symbol, tf, open_time) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume, quote_volume = excluded.quote_volume, trades = excluded.trades`);
    this.selectLast = db.prepare('SELECT MAX(open_time) AS t FROM candles WHERE symbol = ? AND tf = ?');
    this.selectRange = db.prepare(
      'SELECT * FROM candles WHERE symbol = ? AND tf = ? AND open_time >= ? AND open_time <= ? ORDER BY open_time');
    this.selectLatest = db.prepare(
      'SELECT * FROM (SELECT * FROM candles WHERE symbol = ? AND tf = ? AND open_time <= ? ORDER BY open_time DESC LIMIT ?) ORDER BY open_time');
  }

  /** Stores candles, replacing any stored with the same symbol, timeframe and open time. */
  save(candles: Candle[]): void {
    this.db.transaction(() => {
      for (const c of candles) {
        this.upsert.run({
          symbol: c.symbol, tf: c.tf, openTime: c.openTime, open: c.open, high: c.high, low: c.low,
          close: c.close, volume: c.volume, quoteVolume: c.quoteVolume, trades: c.trades | 0,
        });
      }
    })();
  }

  /** Open time of the newest stored candle, or null. */
  lastOpenTime(symbol: string, tf: Timeframe): number | null {
    return (this.selectLast.get(symbol, tf) as { t: number | null }).t;
  }

  /** Candles with open time in [from, to], oldest first. */
  range(symbol: string, tf: Timeframe, from: number, to: number): Candle[] {
    return (this.selectRange.all(symbol, tf, from, to) as Row[]).map(fromRow);
  }

  /** The newest `count` candles that had closed by `atTime`, oldest first. */
  latest(symbol: string, tf: Timeframe, count: number, atTime = Number.MAX_SAFE_INTEGER): Candle[] {
    const lastOpen = atTime - TIMEFRAME_MS[tf];
    return (this.selectLatest.all(symbol, tf, lastOpen, count) as Row[]).map(fromRow);
  }

  /** Deletes candles older than the retention for their timeframe. Returns rows removed. */
  prune(retentionDays: Partial<Record<Timeframe, number>>, now: number): number {
    let removed = 0;
    const del = this.db.prepare('DELETE FROM candles WHERE tf = ? AND open_time < ?');
    this.db.transaction(() => {
      for (const [tf, days] of Object.entries(retentionDays)) {
        if (days) removed += del.run(tf, now - days * 86_400_000).changes;
      }
    })();
    return removed;
  }
}

/**
 * The `tf` candle still forming, built from the closed 1m candles since it
 * opened (for charts; the engine acts on closed candles only). Null when no
 * minute of it has closed yet, or `after` (the newest closed candle's open time) already covers it.
 */
export function formingCandle(tf: Timeframe, minutes: Candle[], after: number | null): Candle | null {
  const last = minutes[minutes.length - 1];
  if (!last) return null;
  const tfMs = TIMEFRAME_MS[tf];
  const openTime = Math.floor(last.openTime / tfMs) * tfMs;
  if (after !== null && openTime <= after) return null;
  const parts = minutes.filter((m) => m.openTime >= openTime);
  return {
    symbol: last.symbol,
    tf,
    openTime,
    closeTime: openTime + tfMs - 1,
    open: parts[0].open,
    high: Math.max(...parts.map((m) => m.high)),
    low: Math.min(...parts.map((m) => m.low)),
    close: last.close,
    volume: parts.reduce((s, m) => s + m.volume, 0),
    quoteVolume: parts.reduce((s, m) => s + m.quoteVolume, 0),
    trades: parts.reduce((s, m) => s + m.trades, 0),
  };
}
