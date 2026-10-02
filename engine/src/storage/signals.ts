// Signals at every stage (armed, expired, taken, filtered), with their full
// reasoning. High volume and expendable, so kept apart from the trade log and
// pruned after `retentionDays`.
import type { DB } from './db';
import type { SignalRecord } from '../../../shared/types';

interface Row {
  id: number;
  time: number;
  symbol: string;
  setup: string;
  direction: string;
  status: string;
  reason: string | null;
  payload: string;
}

const fromRow = (r: Row): SignalRecord => ({
  id: r.id,
  time: r.time,
  symbol: r.symbol,
  setup: r.setup as SignalRecord['setup'],
  direction: r.direction as SignalRecord['direction'],
  status: r.status as SignalRecord['status'],
  reason: r.reason,
  payload: JSON.parse(r.payload),
});

export class SignalLog {
  private readonly insert;

  constructor(private readonly db: DB) {
    this.insert = db.prepare('INSERT INTO signals (time, symbol, setup, direction, status, reason, payload) VALUES (?, ?, ?, ?, ?, ?, ?)');
  }

  append(signals: SignalRecord[]): void {
    this.db.transaction(() => {
      for (const s of signals) this.insert.run(s.time, s.symbol, s.setup, s.direction, s.status, s.reason, JSON.stringify(s.payload));
    })();
  }

  /** Newest first. */
  recent(opts: { limit?: number; symbol?: string; status?: SignalRecord['status'] } = {}): SignalRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.symbol) { where.push('symbol = ?'); args.push(opts.symbol); }
    if (opts.status) { where.push('status = ?'); args.push(opts.status); }
    const sql = `SELECT * FROM signals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, Math.min(opts.limit ?? 100, 1000)) as Row[]).map(fromRow);
  }

  /** Followed signals' outcomes (status `outcome`) since `since`, oldest first. */
  outcomes(since: number): SignalRecord[] {
    return (this.db.prepare("SELECT * FROM signals WHERE status = 'outcome' AND time >= ? ORDER BY id").all(since) as Row[]).map(fromRow);
  }

  /** Counts by status and reason since `since`. */
  summary(since: number): { status: string; reason: string | null; count: number }[] {
    return this.db.prepare('SELECT status, reason, COUNT(*) AS count FROM signals WHERE time >= ? GROUP BY status, reason ORDER BY count DESC')
      .all(since) as { status: string; reason: string | null; count: number }[];
  }

  prune(before: number): number {
    return this.db.prepare('DELETE FROM signals WHERE time < ?').run(before).changes;
  }
}
