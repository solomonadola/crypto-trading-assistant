// SQLite: the engine's only working store. Schema changes are numbered
// migrations, applied in order and recorded in PRAGMA user_version.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // 1: candles, the append-only trade log, signals, snapshots, engine metadata
  `
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

  CREATE TABLE trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    position_id TEXT,
    symbol TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    config_hash TEXT NOT NULL
  );
  CREATE INDEX trade_events_position ON trade_events (position_id);
  CREATE INDEX trade_events_time ON trade_events (time);

  -- The trade log is never edited: corrections are new events.
  CREATE TRIGGER trade_events_no_update BEFORE UPDATE ON trade_events
    BEGIN SELECT RAISE(ABORT, 'trade_events is append-only'); END;
  CREATE TRIGGER trade_events_no_delete BEFORE DELETE ON trade_events
    BEGIN SELECT RAISE(ABORT, 'trade_events is append-only'); END;

  CREATE TABLE signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    setup TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX signals_time ON signals (time);

  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    last_event_id INTEGER NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this engine (${MIGRATIONS.length}). Update the engine.`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function getKv(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setKv(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
