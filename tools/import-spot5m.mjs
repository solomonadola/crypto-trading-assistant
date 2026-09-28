// Builds a backtest database from the 5-minute spot candles already on disk
// (tools/fetch-klines.mjs output in data/klines-wide). No network access.
// 15m, 1h and 4h candles are aggregated from complete groups of 5m candles.
//
//   node tools/import-spot5m.mjs [--dir data/klines-wide] [--db data/backtest/spot5m.db]
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/klines-wide');
const DB = arg('db', 'data/backtest/spot5m.db');
// Stablecoins, wrapped coins and tokenised shares (as in engine/config/config.yaml), plus U (a stablecoin).
const EXCLUDE = new Set(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDS', 'USDE', 'USD1', 'PYUSD', 'RLUSD', 'BFUSD', 'XUSD', 'EUR', 'EURI', 'AEUR',
  'WBTC', 'WBETH', 'WETH', 'BETH', 'STETH', 'WSTETH', 'BNSOL', 'PAXG', 'XAUT', 'CRCLB', 'SNDKB', 'NVDAB', 'MSTRB', 'SOXLB', 'SPCXB', 'QQQB', 'U']);
const AGG = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const FIVE = 300_000;

mkdirSync(path.dirname(DB), { recursive: true });
const db = new Database(DB);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = OFF');
db.exec(`
  CREATE TABLE IF NOT EXISTS candles (symbol TEXT NOT NULL, tf TEXT NOT NULL, open_time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
    low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, quote_volume REAL NOT NULL, trades INTEGER NOT NULL, PRIMARY KEY (symbol, tf, open_time)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS funding (symbol TEXT NOT NULL, time INTEGER NOT NULL, rate REAL NOT NULL, PRIMARY KEY (symbol, time)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const ins = db.prepare('INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

const pairs = readdirSync(DIR).filter((p) => p.endsWith('USDT') && !EXCLUDE.has(p.slice(0, -4)) && /^[A-Z0-9]+USDT$/.test(p)).sort();
const symbols = [];
for (const pair of pairs) {
  const files = readdirSync(path.join(DIR, pair)).filter((f) => f.endsWith('.csv')).sort();
  const rows = new Map();
  for (const f of files) {
    for (const line of readFileSync(path.join(DIR, pair, f), 'utf8').split('\n')) {
      const c = line.trim().split(',');
      if (c.length < 9 || c[0] === '' || !Number.isFinite(Number(c[0]))) continue;
      let t = Number(c[0]);
      if (t > 1e14) t = Math.floor(t / 1000);   // some months are in microseconds
      rows.set(t, [t, +c[1], +c[2], +c[3], +c[4], +c[5], +c[7], Number(c[8]) | 0]);
    }
  }
  if (rows.size < 288 * 30) continue;
  const five = [...rows.values()].sort((a, b) => a[0] - b[0]);
  db.transaction(() => {
    for (const k of five) ins.run(pair, '5m', k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]);
    for (const [tf, ms] of Object.entries(AGG)) {
      const need = ms / FIVE;
      let group = [];
      const flush = () => {
        if (group.length === need) {
          ins.run(pair, tf, Math.floor(group[0][0] / ms) * ms, group[0][1], Math.max(...group.map((g) => g[2])), Math.min(...group.map((g) => g[3])),
            group[group.length - 1][4], group.reduce((a, g) => a + g[5], 0), group.reduce((a, g) => a + g[6], 0), group.reduce((a, g) => a + g[7], 0));
        }
        group = [];
      };
      for (const k of five) {
        if (group.length && Math.floor(k[0] / ms) !== Math.floor(group[0][0] / ms)) flush();
        group.push(k);
      }
      flush();
    }
  })();
  symbols.push(pair);
  console.log(`${pair}: ${five.length.toLocaleString()} 5m candles, ${new Date(five[0][0]).toISOString().slice(0, 7)} -> ${new Date(five[five.length - 1][0]).toISOString().slice(0, 7)}`);
}
db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('symbols', JSON.stringify(symbols.filter((s) => s !== 'BTCUSDT').concat('BTCUSDT')));
db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('selection', `the ${symbols.length} coins in ${DIR} (spot, 5m), chosen by earlier studies from Binance's most traded pairs`);
db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('source', 'spot 5m, local; no funding');
console.log(`done: ${symbols.length} coins ->`, db.prepare('SELECT tf, COUNT(*) AS n FROM candles GROUP BY tf').all().map((r) => `${r.tf} ${r.n.toLocaleString()}`).join(', '));
