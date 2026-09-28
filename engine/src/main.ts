// Engine entry point. Phase 1: config, database, live candle feed and a
// status API. The engine core, sessions and simulator plug in here in later
// phases (ENGINE_PLAN.md Section 14).
import 'dotenv/config';
import express from 'express';
import { loadConfig, configHash } from './config';
import { openDb } from './storage/db';
import { EventLog } from './storage/eventLog';
import { BinancePublic } from './feed/binancePublic';
import { CandleStore } from './feed/candleStore';
import { LiveFeed } from './feed/liveFeed';

export const ENGINE_VERSION = '0.1.0';

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

// BTC is always fed: the filters compare every coin with it.
const symbols = () => [...new Set(['BTCUSDT', ...config.feed.watch_symbols])];
const feed = new LiveFeed({ client, store, config: config.feed, symbols });

let candlesHanded = 0;
feed.onCandles((batch) => {
  candlesHanded += batch.length;
  const newest = batch[batch.length - 1];
  console.log(`[engine] ${batch.length} new candles, newest ${newest.symbol} ${newest.tf} closed ${new Date(newest.closeTime).toISOString()}`);
});

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
    feed: status,
    candlesHanded,
    lastEventId: events.lastId(),
    latest1m: Object.fromEntries(status.symbols.map((s) => [s, store.latest(s, '1m', 1)[0] ?? null])),
  });
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
