// Engine entry point: config, database, engine core with the simulated
// account, scanner, live candle feed, the API and the web page.
import dotenv from 'dotenv';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, configHash } from './config';
import { getKv, openDb, setKv } from './storage/db';
import { EventLog } from './storage/eventLog';
import { BinancePublic } from './feed/binancePublic';
import { CandleStore } from './feed/candleStore';
import { LiveFeed } from './feed/liveFeed';
import { replayCandles } from './feed/replayFeed';
import { CommandError, Engine, type EngineCommand } from './core/engine';
import { Results } from './storage/results';
import { SignalLog } from './storage/signals';
import { scan, type ScanResult } from './scanner';
import type { SymbolInfo } from './feed/binancePublic';
import type { Candle, Timeframe } from '../../shared/types';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

export const ENGINE_VERSION = '0.5.0';
const CLOCK_KEY = 'engine_clock';
const UNIVERSE_KEY = 'universe';
const SIGNAL_RETENTION_DAYS = 30;

const config = loadConfig();
const hash = configHash(config);
const dbPath = process.env.ENGINE_DB_PATH || config.storage.path;
const db = openDb(dbPath);
const store = new CandleStore(db);
const events = new EventLog(db);
const signals = new SignalLog(db);
const results = new Results(db);
const client = new BinancePublic({
  restBase: config.feed.rest_base,
  timeoutMs: config.feed.request_timeout_ms,
  maxRetries: config.feed.max_retries,
});
const engine = new Engine({ config, configHash: hash, engineVersion: ENGINE_VERSION });

// The universe: the last scan's shortlist, or the configured watch list until the first scan.
let universe: string[] = JSON.parse(getKv(db, UNIVERSE_KEY) ?? 'null') ?? config.feed.watch_symbols;
engine.setUniverse(universe);
// Fed: BTC (the filters compare every coin with it), the universe, and any coin with a position or pending entry.
const symbols = () => [...new Set(['BTCUSDT', ...universe, ...engine.account().positions.map((p) => p.symbol), ...engine.account().pendingEntries.map((p) => p.symbol)])];

/** Runs candles through the engine; its events, signals, results and clock are saved together or not at all. */
const persist = db.transaction((batch: Candle[]) => {
  const before = engine.now();
  const produced = engine.onCandles(batch);
  const sigs = engine.takeSignals();
  events.append(produced);
  signals.append(sigs);
  results.appendShadows(engine.takeShadowResults());
  setKv(db, CLOCK_KEY, String(engine.now()));
  // The equity curve: a point every 5 minutes of engine time.
  const every = 300_000;
  if (Math.floor(engine.now() / every) > Math.floor(before / every)) {
    const a = engine.account();
    results.recordEquity({ time: Math.floor(engine.now() / every) * every, balance: a.balance, equity: a.equity, openPositions: a.positions.length });
  }
  return { produced, sigs };
});

/** Runs a control command; its events are saved before the answer. */
const command = db.transaction((cmd: EngineCommand) => {
  const produced = engine.onCommand(cmd);
  events.append(produced);
  return produced;
});

const iso = (t: number) => new Date(t).toISOString().slice(0, 16);
function process_(batch: Candle[]): void {
  const { produced, sigs } = persist(batch);
  for (const e of produced) console.log(`[engine] ${iso(e.time)} ${e.type} ${e.symbol ?? ''} ${JSON.stringify(e.payload)}`);
  for (const s of sigs) console.log(`[signal] ${iso(s.time)} ${s.symbol} ${s.direction} ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
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
  const oldSignals = signals.prune(Date.now() - SIGNAL_RETENTION_DAYS * 86_400_000) + results.prune(Date.now() - SIGNAL_RETENTION_DAYS * 86_400_000);
  if (removed || oldSignals) console.log(`[engine] pruned ${removed} old candles, ${oldSignals} old signals`);
}, 3_600_000);

// Scanner and funding rates, every rescan_interval_sec.
let lastScan: ScanResult | null = null;
const symbolsCache: { list: SymbolInfo[]; at: number } = { list: [], at: 0 };
async function rescan(): Promise<void> {
  try {
    lastScan = await scan(client, config.scanner, Date.now(), symbolsCache);
    engine.setSymbolRules(Object.fromEntries(symbolsCache.list.map((s) => [s.symbol, { stepSize: s.stepSize, minQty: s.minQty, minNotional: s.minNotional }])));
    universe = lastScan.selected.map((r) => r.symbol);
    engine.setUniverse(universe);
    signals.append(engine.takeSignals());
    setKv(db, UNIVERSE_KEY, JSON.stringify(universe));
    console.log(`[scanner] ${universe.length} coins: ${universe.join(' ')}`);
  } catch (err) {
    console.log(`[scanner] failed, keeping ${universe.length} coins: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const fed = new Set(symbols());
    for (const p of await client.premiumIndex()) if (fed.has(p.symbol)) engine.onFunding(p.symbol, p.lastFundingRate);
  } catch (err) {
    console.log(`[funding] failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const scanTimer = setInterval(() => void rescan(), config.scanner.rescan_interval_sec * 1000);

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
    // The engine has no time until its first candle closes; 0 would read as 1970.
    session: engine.now() ? engine.sessionInfo() : null,
    openPositions: engine.positions().length,
    halted: engine.account().halted,
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
app.use(express.json());

app.get('/api/account', (_req, res) => {
  res.json(engine.account());
});
app.get('/api/trades', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  res.json(engine.closedTrades().slice(-limit).reverse());
});
app.get('/api/events', (req, res) => {
  const positionId = req.query.position ? String(req.query.position) : null;
  res.json(positionId ? events.forPosition(positionId) : events.after(Math.max(0, events.lastId() - (Number(req.query.limit) || 200))).reverse());
});
app.get('/api/equity', (req, res) => {
  const hours = Number(req.query.hours) || 24 * 7;
  res.json(results.equity(engine.now() - hours * 3_600_000));
});
app.get('/api/shadows', (req, res) => {
  const hours = Number(req.query.hours) || 24 * 7;
  res.json({ stats: results.shadowStats(engine.now() - hours * 3_600_000), recent: results.recentShadows(Number(req.query.limit) || 100) });
});

// Controls. They act at the engine's time and are saved like any other event.
const control = (build: (req: express.Request) => EngineCommand) => (req: express.Request, res: express.Response) => {
  try {
    const produced = command(build(req));
    for (const e of produced) console.log(`[control] ${e.type} ${e.symbol ?? ''} ${JSON.stringify(e.payload)}`);
    res.json({ ok: true, events: produced.length, account: engine.account() });
  } catch (err) {
    res.status(err instanceof CommandError ? 400 : 500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
app.post('/api/positions/:id/close', control((req) => ({ type: 'close', positionId: String(req.params.id) })));
app.post('/api/control/kill', control(() => ({ type: 'kill', reason: 'manual kill' })));
app.post('/api/control/pause', control(() => ({ type: 'pause', reason: 'paused from the dashboard' })));
app.post('/api/control/resume', control(() => ({ type: 'resume' })));
app.post('/api/control/reset', control((req) => ({ type: 'reset_balance', balance: Number(req.body?.balance) || undefined })));

app.get('/api/scanner', (_req, res) => {
  res.json({ universe, lastScan });
});
app.get('/api/armed', (_req, res) => {
  res.json(engine.armedSetups());
});
app.get('/api/signals', (req, res) => {
  const status = req.query.status ? String(req.query.status) as 'armed' | 'expired' | 'taken' | 'filtered' : undefined;
  res.json(signals.recent({ limit: Number(req.query.limit) || 100, symbol: req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined, status }));
});
app.get('/api/signals/summary', (req, res) => {
  const hours = Number(req.query.hours) || 24;
  res.json(signals.summary(engine.now() - hours * 3_600_000));
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

// Any other /api address: a JSON answer, not the web page.
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `No ${req.method} ${req.path}` });
});

// The web page: Vite with live reload in development, the built files in production.
const dist = path.resolve('dist');
if (process.env.NODE_ENV === 'production') {
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    console.log('[engine] no dist/ folder: run `npm run build` to serve the web page');
  }
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[engine] v${ENGINE_VERSION} config ${hash}, database ${dbPath}, open http://localhost:${port}`);
  void rescan().then(() => feed.start());
});

const shutdown = () => {
  console.log('[engine] shutting down');
  feed.stop();
  clearInterval(pruneTimer);
  clearInterval(scanTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
