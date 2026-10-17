// The trade ideas the dashboard showed, logged at each 15m close, and how each played out: whether price
// reached the idea's take-profit or its stop first. It measures whether "setup quality" predicts anything,
// rather than trusting the score.
import type { Candle, Direction, IdeaQualityBand } from '../../../shared/types';
import type { DB } from './db';

export interface IdeaLogRow {
  symbol: string;
  /** The 15m close the idea was read at. */
  time: number;
  direction: Direction;
  quality: number;
  /** Whether the 15m CHoCH had confirmed it. */
  confirmed: boolean;
  price: number;
  stop: number;
  target: number;
}

interface Row { symbol: string; time: number; direction: string; quality: number; confirmed: number; price: number; stop: number; target: number }

export class IdeaLog {
  constructor(private readonly db: DB) {}

  /** Logs an idea once per coin and 15m close; a second write for the same moment is ignored. */
  record(r: IdeaLogRow): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO idea_log (symbol, time, direction, quality, confirmed, price, stop, target)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(r.symbol, r.time, r.direction, Math.round(r.quality), r.confirmed ? 1 : 0, r.price, r.stop, r.target);
  }

  since(t: number): IdeaLogRow[] {
    return (this.db.prepare('SELECT * FROM idea_log WHERE time >= ? ORDER BY time').all(t) as Row[])
      .map((r) => ({ ...r, direction: r.direction as Direction, confirmed: r.confirmed === 1 }));
  }
}

/** How long an idea is followed for. */
export const IDEA_HORIZON_MS = 48 * 3_600_000;

export interface IdeaOutcome {
  outcome: 'target' | 'stop' | 'open';
  /** In R of the risk from the idea's price to its stop: the target's R, -1, or where price is at the end. */
  r: number;
}

/**
 * Which of the idea's take-profit and stop price reached first, from its price, in the candles after it
 * (oldest first, up to IDEA_HORIZON_MS). A candle reaching both counts as the stop: the worse is assumed.
 * Null for an idea whose price was already past its stop or target (nothing to measure).
 */
export function ideaOutcome(row: IdeaLogRow, candles: Candle[]): IdeaOutcome | null {
  const s = row.direction === 'long' ? 1 : -1;
  const risk = s * (row.price - row.stop);
  const reward = s * (row.target - row.price);
  if (!(risk > 0) || !(reward > 0)) return null;
  const after = candles.filter((c) => c.openTime >= row.time && c.openTime < row.time + IDEA_HORIZON_MS);
  for (const c of after) {
    if (s > 0 ? c.low <= row.stop : c.high >= row.stop) return { outcome: 'stop', r: -1 };
    if (s > 0 ? c.high >= row.target : c.low <= row.target) return { outcome: 'target', r: reward / risk };
  }
  const last = after[after.length - 1];
  return { outcome: 'open', r: last ? (s * (last.close - row.price)) / risk : 0 };
}

const BANDS: [string, number, number][] = [['0-49', 0, 49], ['50-69', 50, 69], ['70-84', 70, 84], ['85-100', 85, 100]];

/**
 * Hit rates per quality band, confirmed and not. The same idea is logged at every 15m close while it stands,
 * so each one (coin, direction, stop and target) counts once, from the first time it was shown.
 */
export function ideaQualityStats(rows: IdeaLogRow[], candlesFor: (row: IdeaLogRow) => Candle[]): IdeaQualityBand[] {
  const seen = new Set<string>();
  const firsts = rows.filter((r) => {
    const key = `${r.symbol}|${r.direction}|${r.stop}|${r.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const out: IdeaQualityBand[] = [];
  for (const confirmed of [true, false]) {
    for (const [band, lo, hi] of BANDS) {
      const results = firsts
        .filter((r) => r.confirmed === confirmed && r.quality >= lo && r.quality <= hi)
        .map((r) => ideaOutcome(r, candlesFor(r)))
        .filter((x): x is IdeaOutcome => x !== null);
      const target = results.filter((x) => x.outcome === 'target').length;
      const stop = results.filter((x) => x.outcome === 'stop').length;
      const decided = target + stop;
      out.push({
        band, confirmed, ideas: results.length, target, stop, open: results.length - decided,
        hitRatePct: decided ? (100 * target) / decided : null,
        avgR: results.length ? results.reduce((a, x) => a + x.r, 0) / results.length : null,
      });
    }
  }
  return out;
}
