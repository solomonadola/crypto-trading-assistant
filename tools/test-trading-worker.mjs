// Tests for the 24/7 trading worker (src/worker/tradingWorker.ts) and the
// Firestore -> saved-copy merge. Fully offline: firebase/* is replaced with a
// fake that records writes and lets the test deliver snapshots, and fetch is
// replaced with fake Binance tickers and candles.
//
//   node tools/test-trading-worker.mjs
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const CHILD = process.argv[2];   // set when this file re-runs itself for the restart tests
// Never write a state file into the project.
if (!process.env.WORKER_STATE_FILE) process.env.WORKER_STATE_FILE = join(mkdtempSync(join(tmpdir(), 'cs-worker-')), 'state.json');
const esbuild = require('./_gen/vendor/node_modules/esbuild');

const FAKE_FIRESTORE = `
  const log = (c) => (globalThis.__fsCalls = globalThis.__fsCalls || []).push(c);
  const snap = (docs) => ({ empty: docs.length === 0, docs: docs.map((d) => ({ id: d.id, data: () => d })),
    forEach(fn) { this.docs.forEach(fn); },
    docChanges() { return this.docs.map((doc) => ({ type: 'added', doc })); } });
  const count = (n) => { globalThis.__reads = (globalThis.__reads || 0) + Math.max(1, n); };
  globalThis.__snap = snap;
  export const getFirestore = () => ({});
  export const collection = (_db, name) => ({ name });
  export const doc = (_db, col, id) => ({ col, id });
  const maybeFail = () => { if (globalThis.__fsWriteFail) throw new Error(globalThis.__fsWriteFail); };
  export const setDoc = async (ref, data) => { maybeFail(); log({ op: 'set', id: ref.id, data }); };
  export const updateDoc = async (ref, data) => { maybeFail(); log({ op: 'update', id: ref.id, data }); };
  export const deleteDoc = async (ref) => { log({ op: 'delete', id: ref.id }); };
  export const getDocs = async () => { const d = globalThis.__fsDocs || []; count(d.length); return snap(d); };
  export const getDocFromServer = async () => ({});
  export const onSnapshot = (_ref, next) => { (globalThis.__listeners = globalThis.__listeners || []).push(next); return () => {}; };
  export const where = (field, op, value) => ({ field, op, value });
  export const query = (c, ...filters) => ({ ...c, filters });
  export const serverTimestamp = () => ({ serverTs: true });
  export const Timestamp = { fromMillis: (ms) => ({ ms }) };
  export const getDocsFromServer = async (q) => {
    if (globalThis.__fsQuotaSpent) throw new Error('resource-exhausted: Quota exceeded');
    if (globalThis.__fsHold) await globalThis.__fsHold;
    const status = (q.filters || []).find((f) => f.field === 'status');
    const d = (globalThis.__fsDocs || []).filter((x) => !status || x.status === status.value);
    count(d.length);
    return snap(d);
  };
`;

let build = 0;
async function load(writesOff) {
  const out = await esbuild.build({
    stdin: {
      contents: "export * from './src/worker/tradingWorker'; export { mergeRemoteTrades, loadLocalTrades, executeSimulatedTrade, updateAutomatedTrade, subscribeToAutomatedTrades, isTradeListAuthoritative, getPendingWriteCount, syncOpenTradesWithLivePrices } from './src/services/automatedFeedService';",
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
    define: { 'import.meta.env.VITE_FIRESTORE_WRITES': writesOff ? '"off"' : 'undefined' },
    plugins: [{
      name: 'fake-firebase',
      setup(b) {
        b.onResolve({ filter: /^firebase\/(app|firestore)$/ }, (a) => ({ path: a.path, namespace: 'fake' }));
        b.onLoad({ filter: /.*/, namespace: 'fake' }, (a) => ({
          contents: a.path === 'firebase/app'
            ? 'export const initializeApp = () => ({}); export const getApps = () => [];'
            : FAKE_FIRESTORE,
          loader: 'js',
        }));
      },
    }],
  });
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64') + '#' + build++);
}

// ---------------------------------------------------------------- fakes
const NOW = Date.now();
const M = 60_000;
let prices = {};          // SYMBOL -> last price
let candles = {};         // SYMBOL -> [[t,o,h,l,c], ...]
let binanceDown = false;
globalThis.fetch = async (url) => {
  url = String(url);
  if (binanceDown) throw new Error('offline');
  if (url.includes('/ticker/24hr')) {
    const rows = Object.entries(prices).map(([s, p]) => ({
      symbol: `${s}USDT`, lastPrice: String(p), priceChangePercent: '0.3', priceChange: '0',
      highPrice: String(p * 1.01), lowPrice: String(p * 0.99), quoteVolume: '100000000', count: 1000,
    }));
    return { ok: true, json: async () => rows };
  }
  if (url.includes('/klines')) {
    const sym = new URL(url).searchParams.get('symbol').replace(/USDT$/, '');
    return { ok: true, json: async () => candles[sym] || [] };
  }
  return { ok: false, json: async () => null };
};
const deliver = (docs) => { globalThis.__fsDocs = docs; (globalThis.__listeners || []).forEach((l) => l(globalThis.__snap(docs))); };
const reset = () => { globalThis.__fsHold = null; globalThis.__reads = 0; globalThis.__fsWriteFail = null; globalThis.__fsCalls = []; globalThis.__listeners = []; globalThis.__fsDocs = []; globalThis.localStorage?.clear(); };
const settle = () => new Promise((r) => setTimeout(r, 30));
const writes = () => globalThis.__fsCalls || [];

const trade = (id, sym, extra = {}) => ({
  id, symbol: sym, coinId: sym.toLowerCase(), coinName: sym, status: 'OPEN', direction: 'LONG',
  entryPrice: 100, currentPrice: 100, positionSizeUSD: 10, totalFeesUSD: 0.015,
  realizedCashBankedUSD: 0, pnlUSD: 0, stopLossPrice: 96, stopLossPct: -4,
  sessionHighPrice: 100, sessionLowPrice: 100, openedAtTimestamp: NOW - 2 * 3600_000,
  harvestTiers: {
    tier1: { percent: 33, targetPct: 4, targetPrice: 104, status: 'PENDING' },
    tier2: { percent: 33, targetPct: 8, targetPrice: 108, status: 'PENDING' },
    tier3: { percent: 34, targetPct: 14, targetPrice: 114, status: 'PENDING' },
  },
  ratchet: { isArmed: false, triggerPct: 4, floorPrice: 100.4, currentProtection: 'INITIAL_DEFENSE', floorBufferPct: 0.4 },
  ...extra,
});

let fails = 0;
const check = (label, ok, detail = '') => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); };

// Restart scenarios run in a fresh process, because the state file is read
// once, when the storage module first loads.
if (CHILD) {
  globalThis.__fsQuotaSpent = true;      // reads fail all day
  prices = { SOL: 95, ETH: 101 };
  const w = await load(false);
  w.startTradingWorker(1e9);
  await settle();
  const r = await w.executeTradingTick();
  const sol = w.loadLocalTrades().find((t) => t.id === 'sol');
  const pending = w.getPendingWriteCount();
  w.stopTradingWorker();                 // saves the state file
  console.log(JSON.stringify({ r, solStatus: sol?.status ?? null, pending }));
  process.exit(0);
}

function runChild(state) {
  const file = join(mkdtempSync(join(tmpdir(), 'cs-worker-')), 'state.json');
  if (state) writeFileSync(file, JSON.stringify(state));
  const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child'], {
    env: { ...process.env, WORKER_STATE_FILE: file }, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,   // stack traces include the whole bundle
  });
  const line = out.stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
  return { result: line ? JSON.parse(line) : null, file, stderr: out.stderr };
}

// ---------------------------------------------------------------- tests
console.log('\n1. A read-only copy never starts the worker');
{
  reset();
  const w = await load(true);
  w.startTradingWorker(1e9);
  await settle();
  const s = w.getWorkerStatus();
  check('not running', s.workerRunning === false);
  check('says why', /read-only/i.test(s.disabledReason || ''), s.disabledReason);
  check('no Firestore writes', writes().length === 0);
  w.stopTradingWorker();
}

console.log('\n2. No trading before Firestore has delivered the trades');
{
  reset();
  prices = { SOL: 95, ETH: 101 };
  let release;
  globalThis.__fsHold = new Promise((r) => { release = r; });   // database slow to answer
  const w = await load(false);
  w.startTradingWorker(1e9);
  await settle();
  const r = await w.executeTradingTick();
  check('tick skipped', r.skipped === true && /Firestore/.test(r.reason), r.reason);
  check('no Firestore writes', writes().length === 0, JSON.stringify(writes()));

  console.log('\n3. After the database answers: a stop at the live price closes the trade');
  globalThis.__fsDocs = [trade('sol', 'SOL'), trade('eth', 'ETH')];
  release();
  await settle();
  const r2 = await w.executeTradingTick();
  check('tick ran', r2.success === true, r2.reason || r2.error || '');
  const closed = writes().find((c) => c.id === 'sol' && c.data?.status === 'STOPPED');
  check('SOL stop written to Firestore', !!closed);
  check('SOL filled at the live price', closed?.data?.exitPrice === 95 || closed?.data?.currentPrice === 95, String(closed?.data?.currentPrice));
  const eth = w.loadLocalTrades().find((t) => t.id === 'eth');
  check('ETH still open', eth?.status === 'OPEN');
  check('ETH stamped with lastEvaluatedAt', eth?.lastEvaluatedAt >= NOW, String(eth?.lastEvaluatedAt));
  check('ETH checkpointed to Firestore', writes().some((c) => c.id === 'eth' && c.data?.lastEvaluatedAt >= NOW));
  check('status reports a fresh tick', w.getWorkerStatus().tickAgeMs < 5000);
  w.stopTradingWorker();
}

console.log('\n4. No fresh prices: the tick is skipped and nothing is evaluated');
{
  reset();
  binanceDown = true;
  const w = await load(false);
  w.startTradingWorker(1e9);
  await settle();
  deliver([trade('sol', 'SOL')]);
  const r = await w.executeTradingTick();
  check('tick skipped', r.skipped === true && /prices/.test(r.reason), r.reason);
  check('no Firestore writes', writes().length === 0, JSON.stringify(writes()));
  binanceDown = false;
  w.stopTradingWorker();
}

console.log('\n5. After a restart, candles missed while asleep are replayed from each trade\'s stamp');
{
  reset();
  prices = { SOL: 99, ETH: 99 };
  const bars = [
    [NOW - 50 * M, 100, 100.5, 99.5, 100],
    [NOW - 30 * M, 99, 99, 90, 91],          // dips through the 96 stop
    [NOW - 2 * M, 99, 99, 98.5, 99],
  ];
  candles = { SOL: bars, ETH: bars };
  const w = await load(false);
  w.startTradingWorker(1e9);
  await settle();
  deliver([
    trade('sol', 'SOL', { lastEvaluatedAt: NOW - 55 * M }),   // stamped: replayed
    trade('eth', 'ETH'),                                      // never stamped: not replayed
  ]);
  const r = await w.executeTradingTick();
  check('tick ran', r.success === true, r.reason || r.error || '');
  const sol = w.loadLocalTrades().find((t) => t.id === 'sol');
  check('SOL closed during the gap', sol?.status === 'STOPPED', sol?.status);
  check('SOL filled at its stop, not the low', sol?.exitPrice === 96, String(sol?.exitPrice));
  const eth = w.loadLocalTrades().find((t) => t.id === 'eth');
  check('unstamped ETH not replayed from its open', eth?.status === 'OPEN', eth?.status);
  w.stopTradingWorker();
}

console.log('\n6. Merging a Firestore snapshot into the saved copy');
{
  reset();
  const w = await load(false);
  const m = w.mergeRemoteTrades;
  const closedLocal = trade('tao', 'TAO', { status: 'STOPPED', pnlUSD: 11.57, openedAtTimestamp: NOW - 86400_000 });
  const corrected = { ...closedLocal, pnlUSD: 0.02, correctionNote: 'corrected' };
  check('a Firestore correction replaces the saved copy', m([corrected], [closedLocal], NOW)[0].pnlUSD === 0.02);

  const fresh = trade('a', 'AAA', { sessionHighPrice: 103, currentPrice: 102 });
  const stale = trade('a', 'AAA', { sessionHighPrice: 100, currentPrice: 100 });
  check('open in both, same stage: our fresher prices kept', m([stale], [fresh], NOW)[0].sessionHighPrice === 103);

  const tiered = trade('a', 'AAA');
  tiered.harvestTiers = { ...tiered.harvestTiers, tier1: { ...tiered.harvestTiers.tier1, status: 'HARVESTED' } };
  check('a tier filled elsewhere wins', m([tiered], [fresh], NOW)[0].harvestTiers.tier1.status === 'HARVESTED');

  const closedHere = trade('a', 'AAA', { status: 'STOPPED' });
  check('our close is kept until its write lands', m([stale], [closedHere], NOW)[0].status === 'STOPPED');

  const orphanOld = trade('old', 'OLD', { openedAtTimestamp: NOW - 3600_000 });
  const orphanNew = trade('new', 'NEW', { openedAtTimestamp: NOW - 60_000 });
  const ids = m([], [orphanOld, orphanNew], NOW).map((t) => t.id);
  check('trade missing from Firestore for an hour is dropped', !ids.includes('old'));
  check('trade opened a minute ago is kept (write in flight)', ids.includes('new'));
}

console.log('\n7. Never more than 10 open: the database is checked, not just this copy');
{
  reset();
  const w = await load(false);
  // The database has 10 open; this copy has only seen 2 of them.
  const ten = ['A','B','C','D','E','F','G','H','I','J'].map((x) => trade(x, x + 'X'));
  globalThis.__fsDocs = ten;
  localStorage.setItem('crypto_automated_trades_local_fallback', JSON.stringify(ten.slice(0, 2)));
  const ok = await w.executeSimulatedTrade(trade('new', 'NEWX', { openedAtTimestamp: NOW }));
  check('11th position refused', ok === false);
  check('nothing written', !writes().some((c) => c.id === 'new'));
  globalThis.__fsDocs = ten.slice(0, 3);
  const dup = await w.executeSimulatedTrade(trade('dup', 'CX', { openedAtTimestamp: NOW }));
  check('coin already open in the database refused', dup === false);
}

console.log('\n8. A failed save is queued and retried, not left in one browser');
{
  reset();
  const w = await load(false);
  const unsub = w.subscribeToAutomatedTrades(() => {});
  await settle();
  globalThis.__fsWriteFail = 'unavailable';
  const ok = await w.executeSimulatedTrade(trade('q1', 'QQQ', { openedAtTimestamp: NOW - 3600_000 }));
  check('trade opened locally', ok === true);
  check('queued for retry', w.getPendingWriteCount() === 1);
  deliver([]);   // database still without it: kept because it is queued
  await settle();
  check('kept by the merge while queued', w.loadLocalTrades().some((t) => t.id === 'q1'));
  globalThis.__fsWriteFail = null;
  await w.syncOpenTradesWithLivePrices(new Map(), w.loadLocalTrades());   // the 30s refresh
  check('written on retry', writes().some((c) => c.op === 'set' && c.id === 'q1'));
  check('queue empty', w.getPendingWriteCount() === 0);

  // A failed close is retried the same way.
  globalThis.__fsWriteFail = 'unavailable';
  await w.updateAutomatedTrade({ ...w.loadLocalTrades()[0], status: 'STOPPED' }, true);
  check('failed close queued', w.getPendingWriteCount() === 1);
  globalThis.__fsWriteFail = null;
  await w.syncOpenTradesWithLivePrices(new Map(), w.loadLocalTrades());
  check('refresh retried it', w.getPendingWriteCount() === 0 && writes().some((c) => c.op === 'update' && c.id === 'q1' && c.data.status === 'STOPPED'));
  unsub();
}

console.log('\n9. Database first at startup');
{
  reset();
  const w = await load(false);
  localStorage.setItem('crypto_automated_trades_local_fallback', JSON.stringify([trade('stale', 'OLD', { status: 'COMPLETED' })]));
  let release;
  globalThis.__fsHold = new Promise((r) => { release = r; });
  const unsub = w.subscribeToAutomatedTrades(() => {});
  await settle();
  check('not acting on the saved copy before Firestore answers', w.isTradeListAuthoritative() === false);
  (globalThis.__listeners || []).forEach((l) => l({ ...globalThis.__snap([]), metadata: { fromCache: true } }));
  check('an offline cache snapshot does not count as the answer', w.isTradeListAuthoritative() === false);
  check('...and does not wipe the list', w.loadLocalTrades().length === 1);
  globalThis.__fsDocs = [trade('real', 'SOL')];
  release();
  await settle();
  check('acts once Firestore has answered', w.isTradeListAuthoritative() === true);
  const ids = w.loadLocalTrades().map((t) => t.id);
  check('list is now exactly the database', ids.length === 1 && ids[0] === 'real', ids.join(','));
  unsub();
}

console.log('\n10. Free-tier reads: the history is not re-read on every load');
{
  reset();
  const w = await load(false);
  globalThis.__fsDocs = Array.from({ length: 300 }, (_, i) => trade('h' + i, 'H' + i, { status: 'COMPLETED' }));
  const a = w.subscribeToAutomatedTrades(() => {});
  const b = w.subscribeToAutomatedTrades(() => {});   // e.g. the History tab
  await settle();
  check('two views, one full read (300 reads, not 600)', globalThis.__reads === 300, String(globalThis.__reads));
  check('listener asks only for changes', (globalThis.__listeners || []).length === 1);
  a(); b();
  globalThis.__reads = 0;
  const c = w.subscribeToAutomatedTrades(() => {});  // reopening with a saved copy
  await settle();
  check('reopening reads nothing up front', globalThis.__reads === 0, String(globalThis.__reads));
  const changed = trade('h5', 'H5', { status: 'COMPLETED', pnlUSD: 1.23 });
  deliver([changed]);
  check('a change arrives through the listener', w.loadLocalTrades().find((t) => t.id === 'h5')?.pnlUSD === 1.23);
  check('history intact', w.loadLocalTrades().length === 300);
  c();
}

console.log('\n11. Firebase quota spent: the server trades on from its saved file');
{
  const saved = {
    crypto_automated_trades_local_fallback: JSON.stringify([trade('sol', 'SOL'), trade('eth', 'ETH')]),
    crypto_automated_trades_full_sync_at: String(NOW - 3600_000),
    crypto_automated_trades_sync_cursor: String(NOW - 3600_000),
    firebase_quota_blocked_until: String(NOW + 2 * 3600_000),
  };
  const { result, file, stderr } = runChild(saved);
  check('tick ran on the saved list', result?.r?.success === true, result ? (result.r.reason || result.r.error || '') : stderr.slice(-300));
  check('stop still enforced (SOL closed at 95)', result?.solStatus === 'STOPPED', result?.solStatus);
  check('the close is queued for Firebase', result?.pending >= 1, String(result?.pending));
  const after = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const savedSol = JSON.parse(after.crypto_automated_trades_local_fallback || '[]').find((t) => t.id === 'sol');
  check('state file holds the close', savedSol?.status === 'STOPPED');
  check('state file holds the queue', Object.keys(JSON.parse(after.crypto_automated_trades_pending_writes || '{}')).includes('sol'));

  const fresh = runChild(null);
  check('with no saved list it waits instead of trading blind', fresh.result?.r?.skipped === true && /Waiting/.test(fresh.result?.r?.reason || ''), fresh.result?.r?.reason);
}

console.log(`\n${fails === 0 ? 'ALL WORKER CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
