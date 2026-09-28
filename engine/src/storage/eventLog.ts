// The append-only trade log (ENGINE_PLAN.md Section 4A.2). Rows are only ever
// added; the database refuses updates and deletes.
import type { DB } from './db';
import type { TradeEvent, TradeEventType } from '../../../shared/types';

interface Row {
  id: number;
  time: number;
  position_id: string | null;
  symbol: string | null;
  type: string;
  payload: string;
  engine_version: string;
  config_hash: string;
}

const fromRow = (r: Row): TradeEvent => ({
  id: r.id,
  time: r.time,
  positionId: r.position_id,
  symbol: r.symbol,
  type: r.type as TradeEventType,
  payload: JSON.parse(r.payload),
  engineVersion: r.engine_version,
  configHash: r.config_hash,
});

export class EventLog {
  private readonly insert;
  private readonly selectAfter;
  private readonly selectPosition;
  private readonly selectLast;

  constructor(private readonly db: DB) {
    this.insert = db.prepare(
      'INSERT INTO trade_events (time, position_id, symbol, type, payload, engine_version, config_hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.selectAfter = db.prepare('SELECT * FROM trade_events WHERE id > ? ORDER BY id LIMIT ?');
    this.selectPosition = db.prepare('SELECT * FROM trade_events WHERE position_id = ? ORDER BY id');
    this.selectLast = db.prepare('SELECT MAX(id) AS id FROM trade_events');
  }

  /** Appends events in one transaction and returns them with their ids. */
  append(events: TradeEvent[]): TradeEvent[] {
    return this.db.transaction(() => events.map((e) => {
      const { lastInsertRowid } = this.insert.run(
        e.time, e.positionId, e.symbol, e.type, JSON.stringify(e.payload), e.engineVersion, e.configHash);
      return { ...e, id: Number(lastInsertRowid) };
    }))();
  }

  /** Events with id greater than `afterId`, oldest first. */
  after(afterId = 0, limit = 10_000): TradeEvent[] {
    return (this.selectAfter.all(afterId, limit) as Row[]).map(fromRow);
  }

  forPosition(positionId: string): TradeEvent[] {
    return (this.selectPosition.all(positionId) as Row[]).map(fromRow);
  }

  lastId(): number {
    return (this.selectLast.get() as { id: number | null }).id ?? 0;
  }
}
