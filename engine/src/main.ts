// Engine entry point: config, database, backup and single-engine lock,
// engine core with the simulated account, scanner, live candle feed, the API
// (behind sign-in when ALLOWED_EMAILS is set) and the web page.
import dotenv from 'dotenv';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
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
import { FirestoreBackup, type BackupState } from './storage/firestoreBackup';
import { backupToFile } from './storage/fileBackup';
import { authSettings, requireSignIn } from './api/auth';
import { scan, type ScanResult } from './scanner';
import type { SymbolInfo } from './feed/binancePublic';
import type { Candle, Timeframe } from '../../shared/types';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

// A 24/7 server reports stray background errors instead of stopping on them.
process.on('unhandledRejection', (err) => console.log(`[engine] unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));

export const ENGINE_VERSION = '0.6.0';
const CLOCK_KEY = 'engine_clock';
const UNIVERSE_KEY = 'universe';
const SIGNAL_RETENTION_DAYS = 30;
const isProduction = process.env.NODE_ENV === 'production';

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
const firebase = JSON.parse(readFileSync('firebase-applet-config.json', 'utf8')) as { projectId: string; firestoreDatabaseId?: string };
const auth = authSettings(firebase.projectId);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------- backup and lock

const namespace = process.env.ENGINE_NAMESPACE || (isProduction ? config.backup.namespace : 'local');
const backup = {
  // Development keeps a file backup unless told otherwise: there are no cloud credentials to look for.
  target: (process.env.BACKUP_TARGET || (isProduction ? config.backup.target : 'file')) as 'firestore' | 'file',
  namespace,
  ok: false,
  error: null as string | null,
  holder: `${hostname()}-${randomUUID().slice(0, 8)}`,
  /** True while another engine holds the lock: this one shows data but does not trade. */
  standby: false,
  lastPush: 0,
  lastFileBackup: null as string | null,
};
let cloud: FirestoreBackup | null = null;
if (backup.target === 'firestore') {
  try {
    cloud = await FirestoreBackup.connect({ projectId: firebase.projectId, databaseId: firebase.firestoreDatabaseId }, namespace, backup.holder);
    backup.ok = true;
  } catch (err) {
    cloud = null;
    backup.error = `Firestore unreachable (${message(err)}); only a local file backup is kept, so a restart on a wiped disk starts fresh`;
    console.log(`[backup] ${backup.error}`);
  }
}

// The universe: the last scan's shortlist, or the configured watch list until the first scan.
let universe: string[] = JSON.parse(getKv(db, UNIVERSE_KEY) ?? 'null') ?? config.feed.watch_symbols;

/** Events in Firestore newer than the local log are added to it (a restore onto an empty disk, or another engine's work). */
async function pullFromCloud(): Promise<number> {
  if (!cloud) return 0;
  const { state, events: newer } = await cloud.restore(events.lastId());
  if (newer.length) {
    const added = events.append(newer.map((e) => ({ ...e, id: undefined })));
    if (added[0].id !== newer[0].id) console.log(`[backup] event ids moved on restore (${newer[0].id} -> ${added[0].id})`);
  }
  if (state && state.clock > Number(getKv(db, CLOCK_KEY) ?? 0)) {
    setKv(db, CLOCK_KEY, String(state.clock));
    if (state.universe?.length) { universe = state.universe; setKv(db, UNIVERSE_KEY, JSON.stringify(universe)); }
  }
  return newer.length;
}

const backupState = (): BackupState => ({ clock: engine.now(), lastEventId: events.lastId(), universe });

async function pushToCloud(): Promise<void> {
  if (!cloud || backup.standby) return;
  try {
    const n = await cloud.pushEvents(events.after(cloud.lastPushed(), 5000));
    if (n) backup.lastPush = Date.now();
    backup.ok = true;
  } catch (err) {
    backup.ok = false;
    backup.error = `backup write failed: ${message(err)}`;
    console.log(`[backup] ${backup.error}`);
  }
}

// ---------------------------------------------------------------- engine

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

function process_(batch: Candle[]): void {
  if (!started || backup.standby) return;
  const { produced, sigs } = persist(batch);
  for (const e of produced) console.log(`[engine] ${iso(e.time)} ${e.type} ${e.symbol ?? ''} ${JSON.stringify(e.payload)}`);
  for (const s of sigs) console.log(`[signal] ${iso(s.time)} ${s.symbol} ${s.direction} ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
}

// Restart (ENGINE_PLAN.md Section 4A.3): state from the event log, then any
// stored candles the engine had not processed yet, then the live feed, which
// fetches and hands on whatever closed while the process was down.
let started = false;
let appliedEventId = 0;
function startEngine(): void {
  const savedClock = Number(getKv(db, CLOCK_KEY) ?? 0);
  const fresh = events.after(appliedEventId, Number.MAX_SAFE_INTEGER);
  engine.restore(fresh, Math.max(engine.now(), savedClock));
  appliedEventId = events.lastId();
  engine.setUniverse(universe);
  // Analysis history for every symbol, up to the engine's clock; anything newer is replayed below.
  for (const symbol of symbols()) {
    for (const tf of config.feed.timeframes) {
      engine.seedHistory(store.latest(symbol, tf, config.feed.history[tf], engine.now() || Date.now()));
    }
  }
  started = true;
  let replayed = 0;
  if (engine.now()) {
    for (const batch of replayCandles(store, { symbols: symbols(), timeframes: config.feed.timeframes, from: engine.now() + 1, to: Date.now() + 60_000 })) {
      process_(batch);
      replayed += batch.length;
    }
  }
  appliedEventId = events.lastId();
  console.log(`[engine] ${fresh.length} events applied, ${engine.positions().length} open positions, ${replayed} stored candles replayed; clock ${engine.now() ? iso(engine.now()) : 'not started'}`);
}

/** Takes or renews the lock; starts the engine on gaining it, stops trading on losing it. */
async function holdLock(): Promise<void> {
  if (!cloud) {
    if (!started) startEngine();
    return;
  }
  try {
    const mine = await cloud.lease(backupState(), config.backup.lock_lease_sec * 1000, Date.now());
    if (mine && (backup.standby || !started)) {
      const pulled = await pullFromCloud();
      backup.standby = false;
      if (pulled && started) console.log(`[backup] ${pulled} events from the previous lock holder`);
      startEngine();
    } else if (!mine && !backup.standby) {
      backup.standby = true;
      console.log('[backup] another engine holds the lock: this one shows data and does not trade');
    }
  } catch (err) {
    backup.error = `lock renewal failed: ${message(err)}`;
    console.log(`[backup] ${backup.error}`);
    if (!started) startEngine();
  }
}

await holdLock();

const feed = new LiveFeed({ client, store, config: config.feed, symbols, resumeFrom: () => engine.now() });
feed.onCandles(process_);
feed.onHistory((candles) => engine.seedHistory(candles));

const timers = [
  setInterval(() => {
    const removed = store.prune(config.storage.candle_retention_days, Date.now());
    const oldSignals = signals.prune(Date.now() - SIGNAL_RETENTION_DAYS * 86_400_000) + results.prune(Date.now() - SIGNAL_RETENTION_DAYS * 86_400_000);
    if (removed || oldSignals) console.log(`[engine] pruned ${removed} old candles, ${oldSignals} old signals`);
    const today = new Date().toISOString().slice(0, 10);
    if (!backup.lastFileBackup?.includes(today)) {
      backupToFile(db, dbPath, config.backup.file_keep_days, Date.now())
        .then((f) => { backup.lastFileBackup = f; })
        .catch((err) => console.log(`[backup] file backup failed: ${message(err)}`));
    }
  }, 3_600_000),
  setInterval(() => void pushToCloud(), config.backup.events_flush_sec * 1000),
  setInterval(() => void holdLock(), (config.backup.lock_lease_sec * 1000) / 2),
];

// ---------------------------------------------------------------- scanner

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
    console.log(`[scanner] failed, keeping ${universe.length} coins: ${message(err)}`);
  }
  try {
    const fed = new Set(symbols());
    for (const p of await client.premiumIndex()) if (fed.has(p.symbol)) engine.onFunding(p.symbol, p.lastFundingRate);
  } catch (err) {
    console.log(`[funding] failed: ${message(err)}`);
  }
}
timers.push(setInterval(() => void rescan(), config.scanner.rescan_interval_sec * 1000));

// ---------------------------------------------------------------- API

const app = express();
app.use(express.json());
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', feed: feed.status().state, standby: backup.standby, time: Date.now() });
});
app.get('/api/auth/config', (_req, res) => {
  res.json({ required: auth.allowed.length > 0 });
});
app.use('/api', requireSignIn(auth));

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
    backup: { ...backup, pushedUpTo: cloud?.lastPushed() ?? null },
    signInRequired: auth.allowed.length > 0,
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
  if (backup.standby) {
    res.status(409).json({ ok: false, error: 'Another engine holds the lock; control it there' });
    return;
  }
  try {
    const produced = command(build(req));
    for (const e of produced) console.log(`[control] ${e.type} ${e.symbol ?? ''} ${JSON.stringify(e.payload)}`);
    void pushToCloud();
    res.json({ ok: true, events: produced.length, account: engine.account() });
  } catch (err) {
    res.status(err instanceof CommandError ? 400 : 500).json({ ok: false, error: message(err) });
  }
};
app.post('/api/positions/:id/close', control((req) => ({ type: 'close', positionId: String(req.params.id) })));
app.post('/api/control/kill', control(() => ({ type: 'kill', reason: 'manual kill' })));
app.post('/api/control/pause', control(() => ({ type: 'pause', reason: 'paused from the dashboard' })));
app.post('/api/control/resume', control(() => ({ type: 'resume' })));
app.post('/api/control/reset', control((req) => ({ type: 'reset_balance', balance: Number(req.body?.balance) || undefined })));

app.get('/api/sessions/today', (_req, res) => {
  const t = engine.now() || Date.now();
  const dayStart = Math.floor(t / 86_400_000) * 86_400_000;
  res.json({ dayStart, sessions: engine.sessions.between(dayStart, dayStart + 86_400_000), info: engine.sessions.info(t) });
});
app.get('/api/market', (_req, res) => {
  const rows = new Map((lastScan?.selected ?? []).map((r) => [r.symbol, r]));
  res.json(universe.map((symbol) => {
    const a = engine.analysis(symbol);
    const last = store.latest(symbol, '1m', 1)[0];
    return {
      symbol,
      price: last?.close ?? null,
      changePct: rows.get(symbol)?.changePct ?? null,
      quoteVolume: rows.get(symbol)?.quoteVolume ?? null,
      atrPct1h: rows.get(symbol)?.atrPct1h ?? null,
      long: a?.long ?? null,
      short: a?.short ?? null,
      trend: a ? { '4h': a.structure['4h']?.trend ?? null, '1h': a.structure['1h']?.trend ?? null, '15m': a.structure['15m']?.trend ?? null } : null,
      zones: a?.zones.length ?? 0,
      armed: engine.armedSetups().filter((x) => x.symbol === symbol).map((x) => x.direction),
    };
  }));
});
app.get('/api/ideas/:symbol', (req, res) => {
  const idea = engine.tradeIdea(req.params.symbol.toUpperCase());
  if (!idea) {
    res.status(404).json({ error: `Not enough history for ${req.params.symbol} yet` });
    return;
  }
  res.json(idea);
});
app.get('/api/ideas', (_req, res) => {
  const ideas = universe.map((s) => engine.tradeIdea(s)).filter((x): x is NonNullable<typeof x> => x !== null);
  const rank = { armed: 0, in_zone: 1, wait: 2, no_level: 3 } as const;
  ideas.sort((a, b) => (a.plan ? rank[a.plan.status] : 4) - (b.plan ? rank[b.plan.status] : 4));
  res.json(ideas);
});
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
if (isProduction) {
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
  console.log(`[engine] v${ENGINE_VERSION} config ${hash}, database ${dbPath}, backup ${cloud ? `firestore (${namespace})` : 'file only'}, sign-in ${auth.allowed.length ? 'on' : 'off'}; open http://localhost:${port}`);
  void rescan().then(() => feed.start());
});

// Cloud Run allows 10 seconds after SIGTERM: save to Firestore and free the lock first.
const shutdown = async () => {
  console.log('[engine] shutting down');
  feed.stop();
  for (const t of timers) clearInterval(t);
  try {
    await pushToCloud();
    if (cloud && !backup.standby) await cloud.release(backupState(), Date.now());
  } catch (err) {
    console.log(`[backup] on shutdown: ${message(err)}`);
  }
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
