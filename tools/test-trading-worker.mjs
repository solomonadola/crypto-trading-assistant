// Tests for the 24/7 trading worker (src/worker/tradingWorker.ts) and the
// Firestore -> saved-copy merge. Fully offline: firebase/* is replaced with a
// fake that records writes and lets the test deliver snapshots, and fetch is
// replaced with fake Binance tickers and candles.
//
//   node tools/test-trading-worker.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

const FAKE_FIRESTORE = `
  const log = (c) => (globalThis.__fsCalls = globalThis.__fsCalls || []).push(c);
  const snap = (docs) => ({ empty: docs.length === 0, docs: docs.map((d) => ({ id: d.id, data: () => d })),
    forEach(fn) { this.docs.forEach(fn); } });
  globalThis.__snap = snap;
  export const getFirestore = () => ({});
  export const collection = (_db, name) => ({ name });
  export const doc = (_db, col, id) => ({ col, id });
  const maybeFail = () => { if (globalThis.__fsWriteFail) throw new Error(globalThis.__fsWriteFail); };
  export const setDoc = async (ref, data) => { maybeFail(); log({ op: 'set', id: ref.id, data }); };
  export const updateDoc = async (ref, data) => { maybeFail(); log({ op: 'update', id: ref.id, data }); };
  export const deleteDoc = async (ref) => { log({ op: 'delete', id: ref.id }); };
  export const getDocs = async () => snap(globalThis.__fsDocs || []);
  export const getDocFromServer = async () => ({});
  export const onSnapshot = (_ref, next) => { (globalThis.__listeners = globalThis.__listeners || []).push(next); return () => {}; };
  export const query = (c) => c;
  export const where = () => ({});
  export const getDocsFromServer = async () => snap((globalThis.__fsDocs || []).filter((d) => d.status === 'OPEN'));
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
const reset = () => { globalThis.__fsWriteFail = null; globalThis.__fsCalls = []; globalThis.__listeners = []; globalThis.__fsDocs = []; globalThis.localStorage?.clear(); };
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
  globalThis.__fsDocs = [trade('sol', 'SOL')];     // readable, but no snapshot yet
  const w = await load(false);
  w.startTradingWorker(1e9);
  await settle();
  const r = await w.executeTradingTick();
  check('tick skipped', r.skipped === true && /Firestore/.test(r.reason), r.reason);
  check('no Firestore writes', writes().length === 0, JSON.stringify(writes()));

  console.log('\n3. After the snapshot: a stop at the live price closes the trade');
  deliver([trade('sol', 'SOL'), trade('eth', 'ETH')]);
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
  const unsub = w.subscribeToAutomatedTrades(() => {});
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
  unsub();
}

console.log('\n8. A failed save is queued and retried, not left in one browser');
{
  reset();
  const w = await load(false);
  const unsub = w.subscribeToAutomatedTrades(() => {});
  deliver([]);
  globalThis.__fsWriteFail = 'unavailable';
  const ok = await w.executeSimulatedTrade(trade('q1', 'QQQ', { openedAtTimestamp: NOW - 3600_000 }));
  check('trade opened locally', ok === true);
  check('queued for retry', w.getPendingWriteCount() === 1);
  deliver([]);   // database still without it: kept because it is queued
  await settle();
  check('kept by the merge while queued', w.loadLocalTrades().some((t) => t.id === 'q1'));
  globalThis.__fsWriteFail = null;
  deliver([]);   // next snapshot flushes the queue
  await settle();
  check('written on retry', writes().some((c) => c.op === 'set' && c.id === 'q1'));
  check('queue empty', w.getPendingWriteCount() === 0);

  // With no snapshot arriving, the 30s refresh retries it.
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
  const unsub = w.subscribeToAutomatedTrades(() => {});
  check('not acting on the saved copy before Firestore answers', w.isTradeListAuthoritative() === false);
  (globalThis.__listeners || []).forEach((l) => l({ ...globalThis.__snap([]), metadata: { fromCache: true } }));
  check('an offline cache snapshot does not count as the answer', w.isTradeListAuthoritative() === false);
  check('...and does not wipe the list', w.loadLocalTrades().length === 1);
  deliver([trade('real', 'SOL')]);
  check('acts once Firestore has answered', w.isTradeListAuthoritative() === true);
  const ids = w.loadLocalTrades().map((t) => t.id);
  check('list is now exactly the database', ids.length === 1 && ids[0] === 'real', ids.join(','));
  unsub();
}

console.log(`\n${fails === 0 ? 'ALL WORKER CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
