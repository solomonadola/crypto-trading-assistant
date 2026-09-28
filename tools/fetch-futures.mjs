// Downloads Binance USDⓈ-M futures history for the backtest from
// data.binance.vision (monthly archives, no rate limits) into a SQLite
// database the backtest reads: 1m candles for the tested months, 15m/1h/4h
// from the warm-up month on, and funding rates.
//
//   node tools/fetch-futures.mjs --from 2025-09 --to 2026-08 [--warmup-from 2025-06] [--top 30]
//                                [--symbols BTCUSDT,ETHUSDT] [--db data/backtest/futures.db]
//
// --top N picks the N most traded USDT perpetuals today that were already
// listed at --warmup-from (picking by today's volume favours coins that did
// well; the backtest reports this). Resumable: months already stored are skipped.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const FROM = arg('from', '2025-09');
const TO = arg('to', '2026-08');
const WARMUP = arg('warmup-from', '2025-06');
const TOP = Number(arg('top', '30'));
const DB = arg('db', 'data/backtest/futures.db');
const EXCLUDE = new Set(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDS', 'USDE', 'USD1', 'PYUSD', 'RLUSD', 'BFUSD', 'XUSD', 'EUR', 'EURI', 'AEUR',
  'WBTC', 'WBETH', 'WETH', 'BETH', 'STETH', 'WSTETH', 'BNSOL', 'PAXG', 'XAUT', 'CRCLB', 'SNDKB', 'NVDAB', 'MSTRB', 'SOXLB', 'SPCXB', 'QQQB']);
const TF_MS = { '1m': 60_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };

function months(from, to) {
  const out = [];
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) out.push(`${y}-${String(m).padStart(2, '0')}`);
  return out;
}

async function pickSymbols() {
  if (arg('symbols', null)) return arg('symbols').split(',');
  const info = await (await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo')).json();
  const since = Date.parse(`${WARMUP}-01T00:00:00Z`);
  const listed = new Map(info.symbols
    .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.onboardDate <= since)
    .map((s) => [s.symbol, s.baseAsset.replace(/^(1000000|1000|1M)(?=[A-Z])/, '')]));
  const tickers = await (await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr')).json();
  return tickers
    .filter((t) => listed.has(t.symbol) && !EXCLUDE.has(listed.get(t.symbol)))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, TOP)
    .map((t) => t.symbol);
}

mkdirSync(path.dirname(DB), { recursive: true });
const db = new Database(DB);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS candles (symbol TEXT NOT NULL, tf TEXT NOT NULL, open_time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
    low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, quote_volume REAL NOT NULL, trades INTEGER NOT NULL, PRIMARY KEY (symbol, tf, open_time)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS funding (symbol TEXT NOT NULL, time INTEGER NOT NULL, rate REAL NOT NULL, PRIMARY KEY (symbol, time)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS fetched (key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const insCandle = db.prepare('INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const insFunding = db.prepare('INSERT OR REPLACE INTO funding VALUES (?, ?, ?)');
const done = db.prepare('SELECT 1 FROM fetched WHERE key = ?');
const mark = db.prepare('INSERT OR REPLACE INTO fetched VALUES (?)');
const tmp = path.join(path.dirname(DB), 'tmp');
mkdirSync(tmp, { recursive: true });

async function csvFromZip(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const file = path.join(tmp, `${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  try {
    return execFileSync('unzip', ['-p', file], { maxBuffer: 512 * 1024 * 1024 }).toString();
  } finally {
    rmSync(file, { force: true });
  }
}

async function job({ symbol, kind, month }) {
  const key = `${symbol}|${kind}|${month}`;
  if (done.get(key)) return 'skip';
  const base = 'https://data.binance.vision/data/futures/um/monthly';
  if (kind === 'funding') {
    const csv = await csvFromZip(`${base}/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`);
    if (csv !== null) {
      db.transaction(() => {
        for (const line of csv.split('\n')) {
          const c = line.trim().split(',');
          if (c.length < 3 || c[0] === '' || !Number.isFinite(Number(c[0]))) continue;
          insFunding.run(symbol, Math.round(Number(c[0]) / 1000) * 1000, Number(c[2]));
        }
      })();
    }
  } else {
    const csv = await csvFromZip(`${base}/klines/${symbol}/${kind}/${symbol}-${kind}-${month}.zip`);
    if (csv !== null) {
      db.transaction(() => {
        for (const line of csv.split('\n')) {
          const c = line.trim().split(',');
          // Header, blank lines (Number('') is 0) and short lines are skipped.
          if (c.length < 9 || c[0] === '' || !Number.isFinite(Number(c[0]))) continue;
          const t = Number(c[0]);
          insCandle.run(symbol, kind, t, +c[1], +c[2], +c[3], +c[4], +c[5], +c[7], Number(c[8]) | 0);
        }
      })();
    }
  }
  mark.run(key);
  return 'ok';
}

const symbols = await pickSymbols();
db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('symbols', JSON.stringify(symbols));
db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('selection', `top ${symbols.length} USDT perpetuals by 24h volume on ${new Date().toISOString().slice(0, 10)}, listed by ${WARMUP}`);
console.log(`${symbols.length} coins: ${symbols.join(' ')}`);
const jobs = [];
for (const symbol of new Set(['BTCUSDT', ...symbols])) {
  for (const month of months(FROM, TO)) { jobs.push({ symbol, kind: '1m', month }); jobs.push({ symbol, kind: 'funding', month }); }
  for (const month of months(WARMUP, TO)) for (const kind of ['15m', '1h', '4h']) jobs.push({ symbol, kind, month });
}
let next = 0;
let finished = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++];
    for (let attempt = 0; ; attempt++) {
      try { await job(j); break; } catch (e) {
        if (attempt >= 3) { console.log(`failed ${j.symbol} ${j.kind} ${j.month}: ${e.message}`); break; }
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (++finished % 50 === 0) console.log(`${finished}/${jobs.length} files, ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}));
rmSync(tmp, { recursive: true, force: true });
const counts = db.prepare('SELECT tf, COUNT(*) AS n FROM candles GROUP BY tf').all();
console.log('done:', counts.map((c) => `${c.tf} ${c.n.toLocaleString()}`).join(', '), '| funding', db.prepare('SELECT COUNT(*) AS n FROM funding').get().n);
