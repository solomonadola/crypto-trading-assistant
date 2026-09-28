// A daily copy of the SQLite database, keeping the last `keepDays`.
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { DB } from './db';

export async function backupToFile(db: DB, dbPath: string, keepDays: number, now: number): Promise<string | null> {
  if (dbPath === ':memory:') return null;
  const dir = path.join(path.dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true });
  const day = new Date(now).toISOString().slice(0, 10);
  const file = path.join(dir, `engine-${day}.db`);
  await db.backup(file);
  const copies = readdirSync(dir).filter((f) => /^engine-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - keepDays))) unlinkSync(path.join(dir, old));
  return file;
}
