// Data-safety tests. Never contacts Firebase: firebase/app and
// firebase/firestore are replaced with a recorder that counts every write.
//
//   node tools/test-data-safety.mjs
//
// Covers:
//  - sanitizeActiveTrades no longer closes positions (it closed 18 real ones)
//  - VITE_FIRESTORE_WRITES=off blocks every Firestore write, keeps local storage
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

const FAKE_FIRESTORE = `
  // Always record into the CURRENT log: a cached module must not keep an old array.
  const calls = { push: (c) => (globalThis.__fsCalls = globalThis.__fsCalls || []).push(c) };
  export const getFirestore = () => ({});
  export const collection = (_db, name) => ({ name });
  export const doc = (_db, col, id) => ({ col, id });
  export const setDoc = async (ref) => { calls.push('setDoc:' + ref.id); };
  export const updateDoc = async (ref) => { calls.push('updateDoc:' + ref.id); };
  export const deleteDoc = async (ref) => { calls.push('deleteDoc:' + ref.id); };
  export const getDocs = async () => ({ empty: true, docs: [], forEach() {} });
  export const getDocFromServer = async () => ({});
  export const onSnapshot = () => () => {};
  export const query = (c) => c;
  export const where = () => ({});
  export const getDocsFromServer = async () => ({ empty: true, docs: [], forEach() {} });
`;

async function load(writesOff) {
  const out = await esbuild.build({
    stdin: { contents: "export * from './src/services/automatedFeedService';", resolveDir: process.cwd(), loader: 'ts' },
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
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64') + '#' + writesOff);
}

// Minimal browser globals the data layer touches.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { addEventListener() {}, removeEventListener() {} };

let fails = 0;
const check = (label, ok, detail = '') => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); };
const trade = (id, sym, openedMin) => ({
  id, symbol: sym, coinId: sym.toLowerCase(), coinName: sym, status: 'OPEN', direction: 'LONG',
  entryPrice: 1, currentPrice: 1, positionSizeUSD: 5, totalFeesUSD: 0.0075, pnlUSD: 0,
  openedAtTimestamp: Date.UTC(2026, 8, 21, 6, openedMin),
});

console.log('\n1. Slot clean-up reports conflicts but never closes positions');
{
  globalThis.__fsCalls = [];
  const m = await load(false);
  const open = ['AAA','BBB','CCC','DDD','EEE','FFF','GGG','HHH','III','JJJ','KKK'].map((s, i) => trade(`t${i}`, s, i));
  open.push(trade('dup', 'AAA', 30));                        // duplicate coin, newest
  const out = m.sanitizeActiveTrades(open);
  check('every position still OPEN', out.every((t) => t.status === 'OPEN'), `${out.filter(t => t.status === 'OPEN').length}/${open.length}`);
  check('no Firestore writes', globalThis.__fsCalls.length === 0, JSON.stringify(globalThis.__fsCalls));
  const c = m.findSlotConflicts(open);
  check('duplicate reported', c.duplicateIds.length === 1 && c.duplicateIds[0] === 't0', JSON.stringify(c.duplicateIds));
  check('over-limit reported', c.overLimit && c.openCount === 12);
}

console.log('\n2. Writes enabled (default): a deploy is written to Firestore');
{
  globalThis.__fsCalls = []; store.clear();
  const m = await load(false);
  const ok = await m.executeSimulatedTrade(trade('w1', 'SOL', 1));
  check('deploy accepted', ok === true);
  check('setDoc called once', globalThis.__fsCalls.filter((c) => c.startsWith('setDoc')).length === 1, JSON.stringify(globalThis.__fsCalls));
  await m.updateAutomatedTrade({ ...trade('w1', 'SOL', 1), status: 'STOPPED' }, true);
  check('close written with updateDoc', globalThis.__fsCalls.some((c) => c === 'updateDoc:w1'));
}

console.log('\n3. VITE_FIRESTORE_WRITES=off: nothing is written, local storage still works');
{
  globalThis.__fsCalls = []; store.clear();
  const m = await load(true);
  const ok = await m.executeSimulatedTrade(trade('r1', 'ETH', 2));
  await m.updateAutomatedTrade({ ...trade('r1', 'ETH', 2), status: 'STOPPED' }, true);
  await m.resetAutomatedTrades();
  check('deploy still works locally', ok === true);
  check('zero Firestore writes (deploy, close, reset)', globalThis.__fsCalls.length === 0, JSON.stringify(globalThis.__fsCalls));
}
{
  globalThis.__fsCalls = []; store.clear();
  const m = await load(true);
  await m.executeSimulatedTrade(trade('r2', 'BNB', 3));
  const local = JSON.parse(store.get('crypto_automated_trades_local_fallback') || '[]');
  check('trade kept in local storage', local.some((t) => t.id === 'r2'));
}

console.log('\n4. Data health check flags impossible records, and only those');
{
  const out = await esbuild.build({
    stdin: { contents: "export * from './src/services/dataHealth';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  });
  const { checkTrade, checkDataHealth } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
  const base = { status: 'STOPPED', direction: 'LONG', totalFeesUSD: 0.03, realizedCashBankedUSD: 0 };
  // The real TAO record before correction.
  const tao = { ...base, id: 'tao', symbol: 'TAO', entryPrice: 266.4, currentPrice: 266.6, positionSizeUSD: 15.34,
                pnlUSD: 11.64, realizedCashBankedUSD: 11.64, totalFeesUSD: 0.0153 };
  const codes = (t) => checkTrade(t).map((i) => i.code).sort().join(',');
  check('TAO phantom profit -> critical', codes(tao) === 'BANKED_TOO_HIGH,IMPOSSIBLE_PNL', codes(tao));
  // A legitimate full ladder on a 15% stop: 0.33*15 + 0.33*30 + 0.17*52.5 = 23.8% banked.
  const bigWin = { ...base, id: 'big', symbol: 'BONK', entryPrice: 1, currentPrice: 1.45, positionSizeUSD: 3,
                   pnlUSD: 0.95, realizedCashBankedUSD: 0.71 };
  check('legitimate 1.6R ladder win -> not flagged', codes(bigWin) === '', codes(bigWin));
  const forced = { ...base, id: 'f', symbol: 'LDO', entryPrice: 1, currentPrice: 1, positionSizeUSD: 10, pnlUSD: 0,
                   exitReason: 'EXCESS_SLOT_REBALANCED' };
  check('old clean-up close -> info', codes(forced) === 'FORCED_CLOSE');
  const wrongVenue = { ...base, id: 'w', symbol: 'FTM', entryPrice: 0.7, exitPrice: 0.1, positionSizeUSD: 10, pnlUSD: -0.4 };
  check('7x price change -> critical', codes(wrongVenue) === 'PRICE_JUMP', codes(wrongVenue));
  const normal = { ...base, id: 'n', symbol: 'SOL', entryPrice: 100, currentPrice: 103, positionSizeUSD: 10, pnlUSD: 0.3 };
  check('normal trade -> clean', codes(normal) === '');
  const r = checkDataHealth([tao, { ...tao, id: 'tao2', excludedFromStats: true }, forced, normal]);
  check('excluded records not counted as outstanding', r.criticalCounted === 1 && r.excludedCount === 1,
        `critical counted ${r.criticalCounted}, excluded ${r.excludedCount}`);
}

console.log(`\n${fails === 0 ? 'ALL DATA-SAFETY CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
