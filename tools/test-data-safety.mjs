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

console.log(`\n${fails === 0 ? 'ALL DATA-SAFETY CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
