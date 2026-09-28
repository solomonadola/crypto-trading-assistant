// Shadow trade results and the equity curve.
import type { DB } from './db';
import type { ShadowResult } from '../../../shared/types';

export interface EquityPoint {
  time: number;
  balance: number;
  equity: number;
  openPositions: number;
}

export interface ShadowStats {
  group: string;
  count: number;
  winRate: number;
  avgR: number;
  totalR: number;
}

export class Results {
  private readonly insertShadow;
  private readonly insertEquity;

  constructor(private readonly db: DB) {
    this.insertShadow = db.prepare(`INSERT INTO shadow_results
      (time, signal_time, symbol, direction, signal_status, signal_reason, entry, stop, target, exit, outcome, r)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertEquity = db.prepare('INSERT OR REPLACE INTO equity (time, balance, equity, open_positions) VALUES (?, ?, ?, ?)');
  }

  appendShadows(rows: ShadowResult[]): void {
    for (const r of rows) {
      this.insertShadow.run(r.time, r.signalTime, r.symbol, r.direction, r.signalStatus, r.signalReason, r.entry, r.stop, r.target, r.exit, r.outcome, r.r);
    }
  }

  recordEquity(p: EquityPoint): void {
    this.insertEquity.run(p.time, p.balance, p.equity, p.openPositions);
  }

  equity(since: number): EquityPoint[] {
    return this.db.prepare('SELECT time, balance, equity, open_positions AS openPositions FROM equity WHERE time >= ? ORDER BY time').all(since) as EquityPoint[];
  }

  recentShadows(limit = 100): ShadowResult[] {
    return (this.db.prepare(`SELECT id, time, signal_time AS signalTime, symbol, direction, signal_status AS signalStatus,
      signal_reason AS signalReason, entry, stop, target, exit, outcome, r FROM shadow_results ORDER BY id DESC LIMIT ?`).all(limit)) as ShadowResult[];
  }

  /**
   * How signals would have done, grouped by why they were filtered ("taken"
   * for those that passed). A filter whose group has a positive average R is
   * blocking winners.
   */
  shadowStats(since: number): ShadowStats[] {
    return this.db.prepare(`SELECT COALESCE(signal_reason, 'taken') AS "group", COUNT(*) AS count,
        AVG(CASE WHEN r > 0 THEN 1.0 ELSE 0.0 END) AS winRate, AVG(r) AS avgR, SUM(r) AS totalR
      FROM shadow_results WHERE time >= ? GROUP BY "group" ORDER BY count DESC`).all(since) as ShadowStats[];
  }

  prune(before: number): number {
    return this.db.prepare('DELETE FROM shadow_results WHERE time < ?').run(before).changes;
  }
}
