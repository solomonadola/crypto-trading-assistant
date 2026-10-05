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
import { CandleStore, formingCandle } from './feed/candleStore';
import { LiveFeed } from './feed/liveFeed';
import { replayCandles } from './feed/replayFeed';
import { CommandError, Engine, type EngineCommand } from './core/engine';
import { Results } from './storage/results';
import { SignalLog } from './storage/signals';
import { FirestoreBackup, type BackupState } from './storage/firestoreBackup';
import { backupToFile } from './storage/fileBackup';
import { authSettings, requireSignIn } from './api/auth';
import { unrealized } from './risk';
import { summarize } from './stats';
import { noticesFor } from './notices';
import { scan, type ScanResult } from './scanner';
import { resolveSymbol } from './symbols';
import { readChart, type ChartReading } from './analysis/patterns';
import { findScalps, scalpStats, type ScalpSetup } from './analysis/scalp';
import type { SymbolInfo } from './feed/binancePublic';
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../../shared/types';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

// A 24/7 server reports stray background errors instead of stopping on them.
process.on('unhandledRejection', (err) => console.log(`[engine] unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));

export const ENGINE_VERSION = '0.6.0';
const CLOCK_KEY = 'engine_clock';
const UNIVERSE_KEY = 'universe';
const WATCHLIST_KEY = 'watchlist';
const MAX_WATCHLIST = 20;
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
// Coins added from the dashboard: fed and analysed like the universe, but never traded.
let watchlist: string[] = JSON.parse(getKv(db, WATCHLIST_KEY) ?? '[]');

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
    if (state.watchlist) { watchlist = state.watchlist; setKv(db, WATCHLIST_KEY, JSON.stringify(watchlist)); }
  }
  return newer.length;
}

const backupState = (): BackupState => ({ clock: engine.now(), lastEventId: events.lastId(), universe, watchlist });

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
// Coins open on a chart, with when the chart last asked for them: fed while viewed, so the chart stays live.
const viewing = new Map<string, number>();
const VIEW_TTL_MS = 10 * 60_000;
// Fed: BTC (the filters compare every coin with it), the universe, the watchlist, coins on a chart, and any coin with a position or pending entry.
const symbols = () => {
  for (const [s, at] of viewing) if (Date.now() - at > VIEW_TTL_MS) viewing.delete(s);
  return [...new Set(['BTCUSDT', ...universe, ...watchlist, ...viewing.keys(), ...engine.account().positions.map((p) => p.symbol), ...engine.account().pendingEntries.map((p) => p.symbol)])];
};
/** The coins the dashboard lists: the scanner's, then the ones added by hand. */
const listed = () => [...new Set([...universe, ...watchlist])];

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
const commandTx = db.transaction((cmd: EngineCommand) => {
  const produced = engine.onCommand(cmd);
  events.append(produced);
  return produced;
});
function command(cmd: EngineCommand): ReturnType<typeof commandTx> {
  const produced = commandTx(cmd);
  ideaCache.clear();
  broadcast('engine', { clock: engine.now() });
  return produced;
}

function process_(batch: Candle[]): void {
  if (!started || backup.standby) return;
  // A coin fed again after a while brings a gap of candles older than the engine's clock: the engine
  // skips those, so they go to the analysis only.
  const old = batch.filter((c) => c.closeTime < engine.now());
  if (old.length) engine.seedHistory(old);
  const { produced, sigs } = persist(batch);
  for (const e of produced) console.log(`[engine] ${iso(e.time)} ${e.type} ${e.symbol ?? ''} ${JSON.stringify(e.payload)}`);
  for (const s of sigs) console.log(`[signal] ${iso(s.time)} ${s.symbol} ${s.direction} ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
  ideaCache.clear();
  broadcast('engine', { clock: engine.now() });
  // Confirmations for the dashboard's notifications: only fresh ones, not those replayed after a restart.
  for (const n of noticesFor(sigs, Date.now())) broadcast('signal', n);
}

// ---------------------------------------------------------------- live updates
// The dashboard keeps one stream open: "engine" when the engine has processed
// new candles (pages refetch at once), "prices" every few seconds with the
// latest trade prices and open positions' P&L at those prices. Display only:
// the engine still acts on closed candles.

const streams = new Set<express.Response>();
function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(msg);
}

let livePrices: Record<string, number> = {};
function pricesMessage() {
  const positions = Object.fromEntries(engine.positions().map((p) => {
    const price = livePrices[p.symbol] ?? null;
    return [p.id, { price, unrealized: unrealized(p, price), pnlPct: price === null ? 0 : (p.side === 'long' ? 1 : -1) * (price / p.entryPrice - 1) * 100 }];
  }));
  return { time: Date.now(), prices: livePrices, positions };
}
async function pollPrices(): Promise<void> {
  if (streams.size) {
    try {
      const all = await client.tickerPrices();
      livePrices = Object.fromEntries(symbols().filter((s) => all.has(s)).map((s) => [s, all.get(s)!]));
      broadcast('prices', pricesMessage());
    } catch (err) {
      console.log(`[prices] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  setTimeout(() => void pollPrices(), config.feed.price_poll_ms);
}

/** Trade ideas only change when candles close: cached until the engine next processes some. */
const ideaCache = new Map<string, ReturnType<typeof engine.tradeIdea>>();
function ideaFor(symbol: string) {
  if (!ideaCache.has(symbol)) ideaCache.set(symbol, engine.tradeIdea(symbol));
  return ideaCache.get(symbol)!;
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
      engine.seedHistory(store.latest(symbol, tf, config.feed.history[tf] ?? 500, engine.now() || Date.now()));
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
    ideaCache.clear();
    broadcast('engine', { clock: engine.now() });
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

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  streams.add(res);
  res.write(`event: prices\ndata: ${JSON.stringify(pricesMessage())}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => { clearInterval(ping); streams.delete(res); });
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
// A trade taken by hand: filled at once at Binance's mark price (plus slippage), with the engine's usual sizing and risk rules.
app.post('/api/positions/open', async (req, res) => {
  if (backup.standby) {
    res.status(409).json({ ok: false, error: 'Another engine holds the lock; trade there' });
    return;
  }
  const b = req.body ?? {};
  const symbol = String(b.symbol ?? '').toUpperCase();
  const side = b.side === 'short' ? 'short' : b.side === 'long' ? 'long' : null;
  const stop = Number(b.stop);
  const target = b.target === null || b.target === undefined || b.target === '' ? null : Number(b.target);
  if (!symbol || !side) {
    res.status(400).json({ ok: false, error: 'symbol and side (long or short) are required' });
    return;
  }
  let mark: number | undefined;
  try {
    mark = (await client.premiumIndex()).find((x) => x.symbol === symbol)?.markPrice;
  } catch (err) {
    res.status(502).json({ ok: false, error: `Could not get the mark price from Binance: ${message(err)}` });
    return;
  }
  if (!mark) {
    res.status(400).json({ ok: false, error: `${symbol} is not a Binance USDT perpetual` });
    return;
  }
  const wasFed = symbols().includes(symbol);
  try {
    const produced = command({ type: 'open', symbol, side, price: mark, time: Date.now(), stop, target, note: b.note ? String(b.note) : undefined });
    for (const e of produced) console.log(`[manual] ${e.type} ${e.symbol ?? ''} ${JSON.stringify(e.payload)}`);
    void pushToCloud();
    // Its candles are needed from now on for the stop and target.
    if (!wasFed) catchUpNow(symbol);
    const filled = produced.find((e) => e.type === 'order_filled');
    if (!filled) {
      const why = produced.find((e) => e.type === 'order_cancelled')?.payload.reason;
      res.status(400).json({ ok: false, error: `Not filled: ${String(why ?? 'unknown').replace(/_/g, ' ')}`, mark });
      return;
    }
    res.json({ ok: true, mark, fill: filled.payload, positionId: filled.positionId, account: engine.account() });
  } catch (err) {
    res.status(err instanceof CommandError ? 400 : 500).json({ ok: false, error: message(err), mark });
  }
});
/** Binance's mark prices of the open positions' coins; empty when Binance cannot be reached (closes then wait for the next 1m candle). */
async function markPrices(): Promise<Record<string, number>> {
  const held = new Set(engine.positions().map((p) => p.symbol));
  if (!held.size) return {};
  try {
    return Object.fromEntries((await client.premiumIndex()).filter((x) => held.has(x.symbol) && x.markPrice > 0).map((x) => [x.symbol, x.markPrice]));
  } catch (err) {
    console.log(`[control] mark prices unavailable, closing at the next 1m candle instead: ${message(err)}`);
    return {};
  }
}
// Manual closes fill at once at the mark price (they used to wait for the next 1m candle, forever while the feed was down).
app.post('/api/positions/:id/close', async (req, res) => {
  const marks = await markPrices();
  const symbol = engine.positions().find((p) => p.id === String(req.params.id))?.symbol;
  control(() => ({ type: 'close', positionId: String(req.params.id), price: symbol ? marks[symbol] : undefined, time: Date.now() }))(req, res);
});
app.post('/api/control/kill', async (req, res) => {
  const prices = await markPrices();
  control(() => ({ type: 'kill', reason: 'manual kill', prices, time: Date.now() }))(req, res);
});
app.post('/api/control/pause', control(() => ({ type: 'pause', reason: 'paused from the dashboard' })));
app.post('/api/control/resume', control(() => ({ type: 'resume' })));
app.post('/api/control/reset', control((req) => ({ type: 'reset_balance', balance: Number(req.body?.balance) || undefined })));

app.get('/api/sessions', (req, res) => {
  const to = Number(req.query.to) || engine.now() || Date.now();
  const from = Math.max(Number(req.query.from) || to - 86_400_000, to - 60 * 86_400_000);
  res.json(engine.sessions.between(from, to));
});
app.get('/api/killzones', (req, res) => {
  const to = Number(req.query.to) || engine.now() || Date.now();
  const from = Math.max(Number(req.query.from) || to - 86_400_000, to - 60 * 86_400_000);
  res.json(engine.sessions.killzonesBetween(from, to));
});
app.get('/api/sessions/today', (_req, res) => {
  const t = engine.now() || Date.now();
  const dayStart = Math.floor(t / 86_400_000) * 86_400_000;
  res.json({ dayStart, sessions: engine.sessions.between(dayStart, dayStart + 86_400_000), info: engine.sessions.info(t) });
});
// Chart reading (trend, patterns, Wyckoff) per coin and timeframe, worked out again only when a candle closes.
const READ_TFS = (['5m', '15m', '1h'] as const).filter((tf) => config.feed.timeframes.includes(tf));
const readings = new Map<string, ChartReading>();
function chartReading(symbol: string, tf: Timeframe): ChartReading | null {
  const lastOpen = store.lastOpenTime(symbol, tf);
  if (lastOpen === null) return null;
  const key = `${symbol}|${tf}`;
  const cached = readings.get(key);
  if (cached?.asOf === lastOpen) return cached;
  const reading = readChart(store.latest(symbol, tf, config.feed.history[tf] ?? 500), tf);
  readings.set(key, reading);
  return reading;
}
app.get('/api/patterns/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  res.json(READ_TFS.map((tf) => chartReading(symbol, tf)).filter((r): r is ChartReading => r !== null));
});

// Scalp setups on 5m for the listed coins, over the last 24 hours, each followed to its end.
// Worked out again for a coin only when its next 5m candle closes.
const SCALP_HOURS = 24;
/** Round trip: fees and slippage on the entry and the exit. */
const SCALP_COST_PCT = 2 * (config.sim.taker_fee_pct + config.sim.slippage_pct);
const scalpCache = new Map<string, { asOf: number; setups: ScalpSetup[] }>();
function scalpsFor(symbol: string): ScalpSetup[] {
  const lastOpen = store.lastOpenTime(symbol, '5m');
  if (lastOpen === null) return [];
  const cached = scalpCache.get(symbol);
  if (cached?.asOf === lastOpen) return cached.setups;
  // 24 hours, plus warm-up for the ATR, EMAs and swing points.
  const candles = store.latest(symbol, '5m', (SCALP_HOURS * 60) / 5 + 72);
  const from = candles[0]?.openTime ?? lastOpen;
  const sessionOpens = engine.sessions.between(from, lastOpen + 300_000)
    .filter((sn) => sn.name === 'london' || sn.name === 'newyork').map((sn) => sn.openTime);
  const setups = findScalps(candles, {
    symbol,
    bias1h: chartReading(symbol, '1h')?.trend?.direction ?? 'range',
    sessionOpens,
    costPct: SCALP_COST_PCT,
  }).filter((x) => x.time >= lastOpen - SCALP_HOURS * 3_600_000);
  scalpCache.set(symbol, { asOf: lastOpen, setups });
  return setups;
}
app.get('/api/scalp', (_req, res) => {
  const setups = listed().flatMap((sym) => scalpsFor(sym)).sort((a, b) => b.time - a.time);
  res.json({ hours: SCALP_HOURS, costPct: SCALP_COST_PCT, setups, stats: scalpStats(setups) });
});
app.get('/api/scalp/:symbol', (req, res) => {
  res.json(scalpsFor(req.params.symbol.toUpperCase()));
});

app.get('/api/market', (_req, res) => {
  const rows = new Map((lastScan?.selected ?? []).map((r) => [r.symbol, r]));
  res.json(listed().map((symbol) => {
    const a = engine.analysis(symbol);
    const last = store.latest(symbol, '1m', 1)[0];
    return {
      symbol,
      scanned: universe.includes(symbol),
      watched: watchlist.includes(symbol),
      price: last?.close ?? null,
      changePct: rows.get(symbol)?.changePct ?? null,
      quoteVolume: rows.get(symbol)?.quoteVolume ?? null,
      recentVolume24h: rows.get(symbol)?.recentVolume24h ?? null,
      atrPct1h: rows.get(symbol)?.atrPct1h ?? null,
      long: a?.long ?? null,
      short: a?.short ?? null,
      trend: a ? { '4h': a.structure['4h']?.trend ?? null, '1h': a.structure['1h']?.trend ?? null, '15m': a.structure['15m']?.trend ?? null } : null,
      zones: a?.zones.length ?? 0,
      // Per timeframe: the trend, the patterns' names and the Wyckoff phase, for the table.
      reading: Object.fromEntries(READ_TFS.map((tf) => {
        const r = chartReading(symbol, tf);
        return [tf, r && {
          trend: r.trend ? { direction: r.trend.direction, strength: r.trend.strength } : null,
          patterns: r.patterns.map((p) => ({ label: p.label, bias: p.bias, status: p.status })),
          wyckoff: r.wyckoff ? { kind: r.wyckoff.kind, phase: r.wyckoff.phase } : null,
        }];
      })),
      armed: engine.armedSetups().filter((x) => x.symbol === symbol).map((x) => x.direction),
      setup: (() => {
        const idea = ideaFor(symbol);
        if (!idea) return null;
        const decided = idea.checklist.filter((c) => c.ok !== null);
        return {
          bias: idea.bias, stage: idea.plan?.status ?? null, skipped: !!idea.plan?.confirmation && !idea.plan.confirmation.taken,
          rr: idea.plan?.targets[0]?.r ?? null, meetsRules: idea.plan?.meetsRules ?? false, targetPct: idea.plan?.targetPct ?? null,
          checksMet: decided.filter((c) => c.ok).length, checksDecided: decided.length, quality: idea.quality,
          speed: idea.speed, movingFast: idea.movingFast, pdPosition: idea.dealingRange?.position ?? null,
        };
      })(),
    };
  }));
});
// Model 4's 4h points of interest, for the chart: the nearest few on each side of the price.
app.get('/api/htf/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const points = engine.htfPoints(symbol);
  const price = store.latest(symbol, '1m', 1)[0]?.close ?? null;
  if (!points || price === null) {
    res.json({ long: [], short: [] });
    return;
  }
  const near = (list: typeof points.long) => list
    .map((p) => ({ ...p, distance: price > p.high ? price - p.high : price < p.low ? p.low - price : 0 }))
    .sort((a, b) => a.distance - b.distance).slice(0, 3);
  res.json({ long: near(points.long), short: near(points.short) });
});
app.get('/api/ideas/:symbol', (req, res) => {
  const idea = ideaFor(req.params.symbol.toUpperCase());
  if (!idea) {
    res.status(404).json({ error: `Not enough history for ${req.params.symbol} yet` });
    return;
  }
  res.json(idea);
});
app.get('/api/ideas', (_req, res) => {
  const ideas = listed().map((s) => ideaFor(s)).filter((x): x is NonNullable<typeof x> => x !== null);
  // Signals (plans that fit the rules) first, then the rest; each from the largest profit to the take-profit down.
  ideas.sort((a, b) => Number(!!b.plan?.meetsRules) - Number(!!a.plan?.meetsRules) || (b.plan?.targetPct ?? -1) - (a.plan?.targetPct ?? -1));
  res.json(ideas);
});

/** A coin just added to the feed: its stored candles go to the analysis now, and the feed fetches the rest now rather than at the next minute. */
function catchUpNow(symbol: string): void {
  // Candles already stored (a coin the scanner once picked) go to the analysis at once.
  for (const tf of config.feed.timeframes) {
    engine.seedHistory(store.latest(symbol, tf, config.feed.history[tf] ?? 500, engine.now() || Date.now()));
  }
  // Then fetch the rest (once the feed has started), and tell the pages.
  if (feed.status().state !== 'stopped') {
    feed.poll()
      .then(() => { ideaCache.clear(); broadcast('engine', { clock: engine.now() }); })
      .catch((err) => console.log(`[feed] ${message(err)}`));
  }
}

// The watchlist: coins to analyse besides the scanner's. Analysis only; the engine trades the scanner's coins.
function saveWatchlist(next: string[]): void {
  watchlist = next;
  setKv(db, WATCHLIST_KEY, JSON.stringify(watchlist));
  ideaCache.clear();
  broadcast('engine', { clock: engine.now() });
}
app.get('/api/watchlist', (_req, res) => {
  res.json(watchlist);
});
app.post('/api/watchlist', async (req, res) => {
  try {
    if (!symbolsCache.list.length) {
      symbolsCache.list = await client.perpetualSymbols();
      symbolsCache.at = Date.now();
    }
  } catch (err) {
    res.status(502).json({ ok: false, error: `Could not load Binance's coin list: ${message(err)}` });
    return;
  }
  const symbol = resolveSymbol(String(req.body?.symbol ?? ''), symbolsCache.list);
  if (!symbol) {
    res.status(400).json({ ok: false, error: `No USDT perpetual on Binance for "${String(req.body?.symbol ?? '')}"` });
    return;
  }
  if (!watchlist.includes(symbol)) {
    if (watchlist.length >= MAX_WATCHLIST) {
      res.status(400).json({ ok: false, error: `The watchlist holds at most ${MAX_WATCHLIST} coins; remove one first` });
      return;
    }
    const wasFed = symbols().includes(symbol);
    saveWatchlist([...watchlist, symbol]);
    if (!wasFed) catchUpNow(symbol);
    console.log(`[watchlist] added ${symbol}`);
  }
  res.json({ ok: true, symbol, watchlist });
});
app.delete('/api/watchlist/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  saveWatchlist(watchlist.filter((s) => s !== symbol));
  console.log(`[watchlist] removed ${symbol}`);
  res.json({ ok: true, watchlist });
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
// Results per model and speed group: closed trades, and every confirmed signal followed to its end.
app.get('/api/results', (req, res) => {
  const since = engine.now() - (Number(req.query.days) || 30) * 86_400_000;
  const trades = engine.closedTrades().filter((t) => t.closedAt >= since && t.riskUsd)
    .map((t) => ({ setup: t.setup ?? 'pullback', speed: t.speed ?? 'normal', r: t.pnl / t.riskUsd! }));
  const followed = signals.outcomes(since).map((s) => {
    const p = s.payload as { r: number; speed?: string; signalStatus?: string };
    return { setup: s.setup, speed: p.speed ?? 'normal', r: Number(p.r), taken: p.signalStatus === 'taken' };
  });
  res.json({
    since,
    trades: summarize(trades),
    followed: summarize(followed),
    skipped: summarize(followed.filter((x) => !x.taken)),
  });
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
  const symbol = req.params.symbol.toUpperCase();
  // A coin on a chart is fed while the chart keeps asking for it, even when the scanner has dropped it.
  if (viewing.has(symbol)) viewing.set(symbol, Date.now());
  else if (!symbols().includes(symbol) && symbolsCache.list.some((s) => s.symbol === symbol)) {
    viewing.set(symbol, Date.now());
    console.log(`[feed] following ${symbol} while it is on a chart`);
    catchUpNow(symbol);
  }
  const closed = store.latest(symbol, tf as Timeframe, limit);
  // Plus the candle still forming, from the 1m candles closed since it opened, so the chart moves between closes.
  const lastOpen = closed[closed.length - 1]?.openTime ?? null;
  const forming = tf === '1m' || lastOpen === null ? null
    : formingCandle(tf as Timeframe, store.range(symbol, '1m', lastOpen + TIMEFRAME_MS[tf as Timeframe], Date.now()), lastOpen);
  res.json(forming ? [...closed, forming] : closed);
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

const port = Number(process.env.PORT || 3009);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[engine] v${ENGINE_VERSION} config ${hash}, database ${dbPath}, backup ${cloud ? `firestore (${namespace})` : 'file only'}, sign-in ${auth.allowed.length ? 'on' : 'off'}; open http://localhost:${port}`);
  void rescan().then(() => feed.start());
  void pollPrices();
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
