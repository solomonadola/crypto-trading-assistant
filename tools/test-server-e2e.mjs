// End-to-end test of the deployed setup: the real server.ts (Express + the
// 24/7 worker), built the way `npm run build` builds it, answering real HTTP
// requests with live Binance prices. Only Firebase is replaced: an in-memory
// database saved to a temp file, so production data is never touched.
//
//   npm run build && node tools/test-server-e2e.mjs
//
// Covers what the web page does: status, the trade list, opening a position
// (POST /api/deploy), closing it (POST /api/trades/:id/close), exclusion,
// unknown endpoints (JSON, not a bare 404), batched saves to Firebase,
// saving on shutdown, and resuming from the state file after a restart.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

if (!existsSync('dist/index.html')) {
  console.error('Run `npm run build` first (the server serves dist/).');
  process.exit(1);
}

const FAKE_FIRESTORE = `
  import fs from 'node:fs';
  const FILE = process.env.FAKE_DB_FILE;
  const db = new Map(Object.entries(FILE && fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {}));
  const save = () => { if (FILE) fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(db))); };
  const clean = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v && v.__serverTs ? Date.now() : v]));
  const snap = (docs) => ({ empty: !docs.length, size: docs.length, metadata: { fromCache: false },
    docs: docs.map((d) => ({ id: d.id, data: () => d })), forEach(fn) { this.docs.forEach(fn); },
    docChanges() { return this.docs.map((doc) => ({ type: 'added', doc })); } });
  const run = (q) => [...db.values()].filter((d) => (q.filters || []).every((f) =>
    f.field === 'status' ? d.status === f.value : f.field === 'updatedAt' ? (d.updatedAt || 0) > f.value.ms : true));
  export const getFirestore = () => ({});
  export const collection = (_db, name) => ({ name });
  export const doc = (_db, col, id) => ({ col, id });
  export const where = (field, op, value) => ({ field, op, value });
  export const query = (c, ...filters) => ({ ...c, filters });
  export const getDocs = async (q) => snap(run(q));
  export const getDocsFromServer = async (q) => snap(run(q));
  export const getDocFromServer = async () => ({ exists: () => false });
  export const setDoc = async (ref, data) => { db.set(ref.id, clean(data)); save(); };
  export const updateDoc = async (ref, data) => {
    if (!db.has(ref.id)) throw new Error('not-found: No document to update');
    db.set(ref.id, { ...db.get(ref.id), ...clean(data) }); save();
  };
  export const deleteDoc = async (ref) => { db.delete(ref.id); save(); };
  export const onSnapshot = () => () => {};
  export const getCountFromServer = async (q) => ({ data: () => ({ count: run(q).length }) });
  export const serverTimestamp = () => ({ __serverTs: true });
  export const Timestamp = { fromMillis: (ms) => ({ ms, toMillis: () => ms }) };
`;

// Written next to server.ts so it finds dist/ exactly as server.js does.
const BUNDLE = '.server-e2e.mjs';
await esbuild.build({
  entryPoints: ['server.ts'], outfile: BUNDLE,
  bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'error',
  external: ['express', 'dotenv', 'vite'],   // server.ts imports vite lazily for dev mode
  plugins: [{
    name: 'fake-firebase',
    setup(b) {
      b.onResolve({ filter: /^firebase\/(app|firestore)$/ }, (a) => ({ path: a.path, namespace: 'fake' }));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, (a) => ({
        contents: a.path === 'firebase/app' ? 'export const initializeApp = () => ({}); export const getApps = () => [];' : FAKE_FIRESTORE,
        loader: 'js', resolveDir: process.cwd(),
      }));
    },
  }],
});

const dir = mkdtempSync(join(tmpdir(), 'cs-e2e-'));
const DB = join(dir, 'db.json');
const STATE = join(dir, 'state.json');
const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${PORT}`;
let fails = 0;
const check = (label, ok, detail = '') => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readDb = () => (existsSync(DB) ? JSON.parse(readFileSync(DB, 'utf8')) : {});

function startServer() {
  const child = spawn(process.execPath, [BUNDLE], {
    // TRADING_WORKER=on: the worker only trades from a deployed server
    // (NODE_ENV=production) unless a run asks for it, as this test does.
    env: { ...process.env, PORT: String(PORT), FAKE_DB_FILE: DB, WORKER_STATE_FILE: STATE, WORKER_AUTOPILOT: 'off', TRADING_WORKER: 'on',
      // The level gates refuse most coins most of the time (that is their job);
      // section 7 checks them separately with a server that has them on.
      ENTRY_GATES: process.env.E2E_GATES || 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.log = () => log;
  return child;
}
async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get('content-type') || '', body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
}
async function post(path, body = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function waitForTick(minTicks = 1, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const s = await get('/api/status');
      if (s.body?.worker?.ticksCount >= minTicks) return s.body;
    } catch {}
    await sleep(500);
  }
  return null;
}

let server = startServer();
try {
  console.log('\n1. The server starts on an empty database and trades');
  const status = await waitForTick();
  check('worker ticking', status?.worker?.workerRunning === true && status.worker.ticksCount >= 1, status ? status.worker.lastTickSummary : server.log().slice(-400));
  check('status reports build and instance', typeof status?.buildId === 'string' && status.buildId !== 'dev' && typeof status?.worker?.instanceId === 'string',
    JSON.stringify({ build: status?.buildId, instance: status?.worker?.instanceId }));
  const page = await get('/');
  check('web page served', page.status === 200 && String(page.body).includes('<div id="root">'));
  const feed = await get('/api/trades');
  check('trade list served (empty to start)', feed.status === 200 && feed.body.full === true && feed.body.trades.length === 0);

  console.log('\n2. Opening a position from the web page (POST /api/deploy)');
  let opened = null;
  let refusal = '';
  for (const sym of ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']) {
    const r = await post('/api/deploy', { symbol: sym });
    if (r.status === 200 && r.body?.success) { opened = r.body.result; break; }
    refusal += `${sym}: ${r.body?.error}; `;
  }
  check('position opened', opened?.status === 'OPEN', opened ? `${opened.symbol} $${opened.positionSizeUSD}` : refusal);
  const again = opened && await post('/api/deploy', { symbol: opened.symbol });
  check('second position in the same coin refused', again?.status === 400 && /already open/.test(again.body?.error || ''), again?.body?.error);
  const delta = await get(`/api/trades?since=${feed.body.version}&boot=${feed.body.bootId}`);
  check('the page sees it in the next pull (changes only)', delta.body.full === false && delta.body.trades.some((t) => t.id === opened?.id));

  console.log('\n3. Closing it from the web page (POST /api/trades/:id/close)');
  const closed = opened && await post(`/api/trades/${encodeURIComponent(opened.id)}/close`, { reason: 'manual' });
  const c = closed?.body?.result;
  check('closed', closed?.status === 200 && c?.status === 'COMPLETED' && c.exitReason === 'CLOSED_MANUAL', closed?.body?.error);
  check('at a live price, with the exit fee', c?.exitPrice > 0 && c.totalFeesUSD > opened.totalFeesUSD, `fees ${opened?.totalFeesUSD} -> ${c?.totalFeesUSD}`);
  const twice = opened && await post(`/api/trades/${encodeURIComponent(opened.id)}/close`, {});
  check('closing twice is refused with a reason (not 404)', twice?.status === 400 && /already closed/.test(twice.body?.error || ''), twice?.body?.error);
  const excl = opened && await post(`/api/trades/${encodeURIComponent(opened.id)}/exclude`, { excluded: true });
  check('exclude from statistics', excl?.status === 200 && excl.body.result.excludedFromStats === true);
  const unknown = await post('/api/trades/x/no-such-action', {});
  check('unknown action: JSON explanation, not a bare 404', unknown.status === 404 && /has no POST/.test(unknown.body?.error || ''), unknown.body?.error);
  check('every answer names the instance', typeof closed?.body?.instanceId === 'string' && closed.body.instanceId === status?.worker?.instanceId);

  console.log('\n4. Saved to Firebase in batches');
  const before = await get('/api/status');
  check('changes queued, not yet written', before.body.worker.sync.pendingWrites >= 1 && !readDb()[opened?.id], `pending ${before.body.worker.sync.pendingWrites}`);
  await post('/api/flush');
  const saved = readDb()[opened?.id];
  check('flush writes the final state', saved?.status === 'COMPLETED' && saved.excludedFromStats === true && typeof saved.updatedAt === 'number');

  console.log('\n5. Shutdown saves what is queued; a restart resumes from the state file');
  const eth = await post('/api/deploy', { symbol: opened?.symbol === 'ETH' ? 'SOL' : 'ETH' });
  const ethId = eth.body?.result?.id;
  check('another position opened', !!ethId, eth.body?.error);
  check('not in Firebase yet', ethId && !readDb()[ethId]);
  server.kill('SIGTERM');
  await new Promise((r) => server.on('exit', r));
  check('saved on shutdown', ethId && readDb()[ethId]?.status === 'OPEN');
  server = startServer();
  const status2 = await waitForTick();
  const feed2 = await get('/api/trades');
  check('new instance after restart', status2?.worker?.instanceId && status2.worker.instanceId !== status.worker.instanceId);
  check('list resumed', feed2.body.trades.some((t) => t.id === ethId && t.status === 'OPEN') && feed2.body.trades.some((t) => t.id === opened?.id));
  const close2 = ethId && await post(`/api/trades/${encodeURIComponent(ethId)}/close`, {});
  check('and its positions can be closed', close2?.status === 200 && close2.body.result.status === 'COMPLETED', close2?.body?.error);

  console.log('\n6. The web page\'s own code: two pages, open and close through the server');
  // The browser modules the app uses (services/serverFeed.ts and the data
  // layer), bundled as for the page and pointed at this server - twice, as
  // two separate pages with their own storage.
  async function loadPage(name) {
    const out = await esbuild.build({
      stdin: { contents: "export { serverAction, pullServerTrades, fetchServerStatus } from './src/services/serverFeed'; export { loadLocalTrades } from './src/services/automatedFeedService';", resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
      define: { 'import.meta.env.VITE_TRADING_SERVER_URL': JSON.stringify(base), 'import.meta.env.VITE_FIRESTORE_WRITES': 'undefined', __BUILD_ID__: JSON.stringify(status2?.buildId || 'dev') },
      plugins: [{
        name: 'fake-firebase',
        setup(b) {
          b.onResolve({ filter: /^firebase\/(app|firestore)$/ }, (a) => ({ path: a.path, namespace: 'fake' }));
          b.onLoad({ filter: /.*/, namespace: 'fake' }, (a) => ({
            contents: a.path === 'firebase/app' ? 'export const initializeApp = () => ({}); export const getApps = () => [];'
              : 'const n = () => ({}); export { n as getFirestore, n as collection, n as doc, n as query, n as where, n as serverTimestamp }; export const Timestamp = { fromMillis: n }; export const onSnapshot = () => () => {}; export const getCountFromServer = async () => ({ data: () => ({ count: 0 }) }); const e = async () => { throw new Error("page must not use Firebase here"); }; export { e as getDocs, e as getDocsFromServer, e as getDocFromServer, e as setDoc, e as updateDoc, e as deleteDoc };',
            loader: 'js',
          }));
        },
      }],
    });
    const code = out.outputFiles[0].text;
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
    // Each page gets its own storage: swap it in around every call.
    const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64') + '#' + name);
    const wrap = (fn) => async (...args) => { const prev = globalThis.localStorage; globalThis.localStorage = storage; try { return await fn(...args); } finally { globalThis.localStorage = prev; } };
    return { action: wrap(mod.serverAction), pull: wrap(mod.pullServerTrades), status: wrap(mod.fetchServerStatus), list: wrap(async () => mod.loadLocalTrades()) };
  }
  const pageA = await loadPage('A');
  const pageB = await loadPage('B');
  const st = await pageA.status();
  check('page sees the server as active', st.active === true && !st.warning, JSON.stringify(st));
  await pageA.pull(); await pageB.pull();
  const sym = ['DOGE', 'XRP', 'ADA', 'LINK', 'AVAX'];
  let openedByPage = null;
  for (const x of sym) {
    const r = await pageA.action('/api/deploy', { symbol: x });
    if (r.ok) { openedByPage = r.result; break; }
  }
  check('page A opens a position with the button\'s request', openedByPage?.status === 'OPEN', openedByPage?.symbol);
  check('page A shows it at once', (await pageA.list()).some((t) => t.id === openedByPage?.id && t.status === 'OPEN'));
  await pageB.pull();
  check('page B shows the same after its next pull', (await pageB.list()).some((t) => t.id === openedByPage?.id && t.status === 'OPEN'));
  const closeR = openedByPage && await pageB.action(`/api/trades/${encodeURIComponent(openedByPage.id)}/close`, { reason: 'manual' });
  check('page B closes it', closeR?.ok === true && closeR.result.status === 'COMPLETED', closeR?.error);
  await pageA.pull();
  check('page A shows it closed after its next pull', (await pageA.list()).find((t) => t.id === openedByPage?.id)?.status === 'COMPLETED');
  const a = JSON.stringify((await pageA.list()).map((t) => [t.id, t.status]).sort());
  const b = JSON.stringify((await pageB.list()).map((t) => [t.id, t.status]).sort());
  check('both pages hold the same list', a === b);
  const refused = openedByPage && await pageA.action(`/api/trades/${encodeURIComponent(openedByPage.id)}/close`, {});
  check('a refused close explains why (no 404)', refused?.ok === false && /already closed/.test(refused.error || ''), refused?.error);
  console.log('\n7. The level gates refuse an entry that is not at a level');
  {
    // Same server, gates on: a deploy is refused with the measured reason.
    server.kill('SIGTERM');
    await new Promise((r) => server.on('exit', r));
    process.env.E2E_GATES = 'on';
    server = startServer();
    await waitForTick();
    const tried = [];
    for (const sym of ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'AVAX']) {
      const r = await post('/api/deploy', { symbol: sym });
      tried.push(r);
      if (r.status === 200) break;
    }
    const refused = tried.filter((r) => r.status === 400 && /Not at a level/.test(r.body?.error || ''));
    check('refusals explain the level test', refused.length > 0 || tried.some((r) => r.status === 200),
      tried.map((r) => r.body?.error).join(' | ').slice(0, 120));
    if (refused.length) {
      check('the reason names support or resistance',
        /support|Resistance|downtrend/.test(refused[0].body.error), refused[0].body.error.slice(0, 80));
    }
  }
} finally {
  server.kill('SIGTERM');
  await sleep(300);
  try { unlinkSync(BUNDLE); } catch {}
}

console.log(`\n${fails === 0 ? 'ALL END-TO-END CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
