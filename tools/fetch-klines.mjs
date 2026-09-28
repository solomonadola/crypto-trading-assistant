// Downloads Binance monthly 5m kline dumps (spot) for a list of coins.
//
// Uses data.binance.vision monthly ZIPs (no rate limits, ~1MB/symbol/month)
// rather than the REST API. Resumable: existing CSVs are skipped, so an
// interrupted run costs nothing.
//
//   node tools/fetch-klines.mjs --symbols BTC,ETH [--months 6]
//   node tools/fetch-klines.mjs --from 2024-01 --to 2025-12 --out data/klines2024 --symbols BTC,ETH,SOL
//   node tools/fetch-klines.mjs --from 2024-01 --to 2026-08 --out data/klines-wide --symbols-file coins.txt
//
// CSV columns (Binance kline format):
//   0 openTime  1 open  2 high  3 low  4 close  5 volume
//   6 closeTime 7 quoteVolume 8 trades 9 takerBuyBase 10 takerBuyQuote 11 ignore
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const MONTHS   = parseInt(arg('months', '6'), 10);
const INTERVAL = arg('interval', '5m');
const FROM     = arg('from', null);      // 'YYYY-MM' inclusive
const TO       = arg('to', null);        // 'YYYY-MM' inclusive
const OUT      = arg('out', 'data/klines');
const CONCURRENCY = parseInt(arg('concurrency', '8'), 10);

// --symbols BTC,ETH,... or --symbols-file list.txt (one per line) picks the coins.
const SYMBOLS = arg('symbols-file', null)
  ? readFileSync(arg('symbols-file'), 'utf8').split(/\s+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
  : arg('symbols', null)
  ? arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  : null;
if (!SYMBOLS) {
  console.error('Name the coins: --symbols BTC,ETH,... or --symbols-file list.txt');
  process.exit(1);
}

// Explicit --from/--to range, else the last N complete months.
const months = [];
if (FROM && TO) {
  const [fy, fm] = FROM.split('-').map(Number), [ty, tm] = TO.split('-').map(Number);
  for (let d = new Date(Date.UTC(fy, fm - 1, 1)); d <= new Date(Date.UTC(ty, tm - 1, 1));
       d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
} else {
  const now = new Date();
  for (let i = 1; i <= MONTHS; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
}

console.log(`universe: ${SYMBOLS.length} symbols | ${INTERVAL} | ${months.at(-1)} .. ${months[0]} | -> ${OUT}`);

const missing = new Map();
let got = 0, skipped = 0, failed = 0, done = 0;

async function fetchSymbol(sym) {
  const pair = `${sym}USDT`;
  const dir = `${OUT}/${pair}`;
  mkdirSync(dir, { recursive: true });
  for (const ym of months) {
    const csv = `${dir}/${pair}-${INTERVAL}-${ym}.csv`;
    if (existsSync(csv)) { skipped++; continue; }
    const url = `https://data.binance.vision/data/spot/monthly/klines/${pair}/${INTERVAL}/${pair}-${INTERVAL}-${ym}.zip`;
    const zip = `${dir}/.tmp-${ym}.zip`;
    try {
      const res = await fetch(url);
      if (!res.ok) { missing.set(pair, (missing.get(pair) || 0) + 1); failed++; continue; }
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
      unlinkSync(zip);
      got++;
    } catch {
      missing.set(pair, (missing.get(pair) || 0) + 1); failed++;
      try { unlinkSync(zip); } catch {}
    }
  }
  const n = readdirSync(dir).filter(f => f.endsWith('.csv')).length;
  process.stdout.write(`  [${String(++done).padStart(2)}/${SYMBOLS.length}] ${pair.padEnd(12)} ${n}/${months.length} months\n`);
}

// Bounded worker pool - N symbols in flight instead of one at a time.
const queue = [...SYMBOLS];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) await fetchSymbol(queue.shift());
}));

console.log(`\ndownloaded ${got} | cached ${skipped} | unavailable ${failed}`);
if (missing.size) {
  console.log('\nsymbols with missing months (delisted / renamed / never listed on spot):');
  for (const [p, n] of missing) console.log(`  ${p}: ${n}/${months.length} unavailable`);
}
