// Engine entry point: config, database, engine core, live candle feed and a
// status API. Strategy, simulator and the full API plug in here in later
// phases (ENGINE_PLAN.md Section 14).
import 'dotenv/config';
import express from 'express';
import { loadConfig, configHash } from './config';
import { getKv, openDb, setKv } from './storage/db';
import { EventLog } from './storage/eventLog';
import { BinancePublic } from './feed/binancePublic';
import { CandleStore } from './feed/candleStore';
import { LiveFeed } from './feed/liveFeed';
import { replayCandles } from './feed/replayFeed';
import { Engine } from './core/engine';
import type { Candle, Timeframe } from '../../shared/types';

export const ENGINE_VERSION = '0.3.0';
const CLOCK_KEY = 'engine_clock';

const config = loadConfig();
const hash = configHash(config);
const dbPath = process.env.ENGINE_DB_PATH || config.storage.path;
const db = openDb(dbPath);
const store = new CandleStore(db);
const events = new EventLog(db);
const client = new BinancePublic({
  restBase: config.feed.rest_base,
  timeoutMs: config.feed.request_timeout_ms,
  maxRetries: config.feed.max_retries,
});
const engine = new Engine({ config, configHash: hash, engineVersion: ENGINE_VERSION });

// BTC is always fed: the filters compare every coin with it.
const symbols = () => [...new Set(['BTCUSDT', ...config.feed.watch_symbols])];

/** Runs candles through the engine; its events and its clock are saved together or not at all. */
const persist = db.transaction((batch: Candle[]) => {
  const produced = engine.onCandles(batch);
  events.append(produced);
  setKv(db, CLOCK_KEY, String(engine.now()));
  return produced;
});

function process_(batch: Candle[]): void {
  const produced = persist(batch);
  for (const e of produced) console.log(`[engine] ${new Date(e.time).toISOString()} ${e.type} ${e.symbol ?? ''} ${JSON.stringify(e.payload)}`);
}

// Restart (ENGINE_PLAN.md Section 4A.3): state from the event log, then any
// stored candles the engine had not processed yet, then the live feed, which
// fetches and hands on whatever closed while the process was down.
const savedClock = Number(getKv(db, CLOCK_KEY) ?? 0);
engine.restore(events.after(0, Number.MAX_SAFE_INTEGER), savedClock);
// Analysis history for every symbol, up to the engine's clock; anything newer is replayed below.
for (const symbol of symbols()) {
  for (const tf of config.feed.timeframes) {
    engine.seedHistory(store.latest(symbol, tf, config.feed.history[tf], savedClock || Date.now()));
  }
}
if (savedClock) {
  let replayed = 0;
  for (const batch of replayCandles(store, { symbols: symbols(), timeframes: config.feed.timeframes, from: savedClock + 1, to: Date.now() + 60_000 })) {
    process_(batch);
    replayed += batch.length;
  }
  console.log(`[engine] restored ${engine.positions().length} open positions; replayed ${replayed} stored candles; clock ${new Date(engine.now()).toISOString()}`);
}

const feed = new LiveFeed({ client, store, config: config.feed, symbols });
feed.onCandles(process_);
feed.onHistory((candles) => engine.seedHistory(candles));

const pruneTimer = setInterval(() => {
  const removed = store.prune(config.storage.candle_retention_days, Date.now());
  if (removed) console.log(`[engine] pruned ${removed} old candles`);
}, 3_600_000);

const app = express();
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', feed: feed.status().state, time: Date.now() });
});
app.get('/api/status', (_req, res) => {
  const status = feed.status();
  res.json({
    engineVersion: ENGINE_VERSION,
    configHash: hash,
    database: dbPath,
    engineClock: engine.now(),
    feed: status,
    session: engine.sessionInfo(),
    openPositions: engine.positions().length,
    lastEventId: events.lastId(),
    latest1m: Object.fromEntries(status.symbols.map((s) => [s, store.latest(s, '1m', 1)[0] ?? null])),
  });
});

app.get('/api/analysis/:symbol', (req, res) => {
  const a = engine.analysis(req.params.symbol.toUpperCase());
  if (!a) {
    res.status(404).json({ error: `No analysis for ${req.params.symbol}; analysed: ${engine.analysedSymbols().join(', ')}` });
    return;
  }
  res.json(a);
});
app.get('/api/candles/:symbol', (req, res) => {
  const tf = String(req.query.tf ?? '15m');
  if (!config.feed.timeframes.includes(tf as Timeframe)) {
    res.status(400).json({ error: `tf must be one of ${config.feed.timeframes.join(', ')}` });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 300, 1500);
  res.json(store.latest(req.params.symbol.toUpperCase(), tf as Timeframe, limit));
});

const port = Number(process.env.ENGINE_PORT || process.env.PORT || 3100);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[engine] v${ENGINE_VERSION} config ${hash}, database ${dbPath}, listening on http://localhost:${port}`);
  feed.start();
});

const shutdown = () => {
  console.log('[engine] shutting down');
  feed.stop();
  clearInterval(pruneTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
