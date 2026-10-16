// Trade journal storage for post-trade reviews, discipline tags, and ATA Level 5 exercises.
import type { DB } from './db';
import type { AtaReflection, JournalEntry } from '../../../shared/types';

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

const MAX_NOTES = 10_000;
const MAX_TAGS = 20;
const MAX_TAG = 40;
const MAX_ATA_TEXT = 2_000;

const oneOf = <T extends string>(x: unknown, allowed: readonly T[]): T | undefined =>
  allowed.includes(x as T) ? (x as T) : undefined;
const flag = (x: unknown): boolean | undefined => (typeof x === 'boolean' ? x : undefined);
const text = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.slice(0, MAX_ATA_TEXT) : undefined);

/** Only the reflection's known fields, each of its own type; anything else sent is dropped. */
function ataFrom(x: unknown): AtaReflection | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined;
  const a = x as Record<string, unknown>;
  const ata: AtaReflection = {
    pdAlignment: oneOf(a.pdAlignment, ['discount', 'premium', 'equilibrium', 'na'] as const),
    majorLiquidityTaken: flag(a.majorLiquidityTaken),
    hrlrOrLrlr: oneOf(a.hrlrOrLrlr, ['lrlr', 'hrlr', 'unknown'] as const),
    htfTrendAligned: flag(a.htfTrendAligned),
    keyPoi: oneOf(a.keyPoi, ['ob', 'fvg', 'breaker', 'none'] as const),
    shiftReason: text(a.shiftReason),
    invalidation: text(a.invalidation),
  };
  const kept = Object.fromEntries(Object.entries(ata).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length ? (kept as AtaReflection) : undefined;
}

/**
 * A journal entry from what the dashboard sent, or why it cannot be saved. The rating is 0 (unrated) to
 * 5 stars; tags are short strings, without repeats; unknown reflection fields are dropped.
 */
export function journalEntryFrom(tradeId: string, body: unknown, now: number): JournalEntry | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const rating = b.rating === undefined ? 0 : Number(b.rating);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) return 'Rating must be a whole number from 0 to 5';
  if (b.tags !== undefined && !Array.isArray(b.tags)) return 'Tags must be a list';
  const tags = [...new Set(((b.tags as unknown[] | undefined) ?? [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().slice(0, MAX_TAG))
    .filter(Boolean))];
  if (tags.length > MAX_TAGS) return `At most ${MAX_TAGS} tags`;
  if (b.notes !== undefined && typeof b.notes !== 'string') return 'Notes must be text';
  const notes = (b.notes as string | undefined) ?? '';
  if (notes.length > MAX_NOTES) return `Notes are limited to ${MAX_NOTES} characters`;
  return { tradeId, rating, tags, notes, ata: ataFrom(b.ata), updatedAt: now };
}

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
