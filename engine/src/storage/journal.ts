// Trade journal storage for post-trade reviews, discipline tags, and ATA Level 5 exercises.
import type { DB } from './db';
import type { JournalEntry } from '../../../shared/types';

interface JournalRow {
  trade_id: string;
  rating: number;
  tags: string;
  notes: string;
  ata_checklist: string;
  updated_at: number;
}

const fromRow = (r: JournalRow): JournalEntry => ({
  tradeId: r.trade_id,
  rating: r.rating,
  tags: r.tags ? JSON.parse(r.tags) : [],
  notes: r.notes || '',
  ata: r.ata_checklist ? JSON.parse(r.ata_checklist) : undefined,
  updatedAt: r.updated_at,
});

export class TradeJournalStore {
  constructor(private readonly db: DB) {}

  getAll(): JournalEntry[] {
    const rows = this.db.prepare('SELECT * FROM trade_journal ORDER BY updated_at DESC').all() as JournalRow[];
    return rows.map(fromRow);
  }

  get(tradeId: string): JournalEntry | null {
    const row = this.db.prepare('SELECT * FROM trade_journal WHERE trade_id = ?').get(tradeId) as JournalRow | undefined;
    return row ? fromRow(row) : null;
  }

  save(entry: JournalEntry): void {
    this.db.prepare(`
      INSERT INTO trade_journal (trade_id, rating, tags, notes, ata_checklist, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(trade_id) DO UPDATE SET
        rating = excluded.rating,
        tags = excluded.tags,
        notes = excluded.notes,
        ata_checklist = excluded.ata_checklist,
        updated_at = excluded.updated_at
    `).run(
      entry.tradeId,
      entry.rating,
      JSON.stringify(entry.tags ?? []),
      entry.notes ?? '',
      JSON.stringify(entry.ata ?? {}),
      entry.updatedAt,
    );
  }
}
