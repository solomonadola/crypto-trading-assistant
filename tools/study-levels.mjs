// Does entering at a real level do better than entering anywhere?
//
//   node tools/study-levels.mjs [--dir data/klines] [--entries data/entries.json] [--sample 6000]
//
// The entry set is held fixed - the same entries the scanner actually took -
// and each one is labelled with what the REAL analysis said at that moment,
// using the production code (services/indicators.ts and marketAnalysisService.ts)
// on candles aggregated from the 5m history. Entries are then bucketed and the
// forward return of each bucket is measured, net of costs.
//
// A filter is only worth switching on if its bucket beats the whole set out of
// sample by more than a round trip in costs.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/klines');
const ENTRIES = arg('entries', 'data/entries.json');
const SAMPLE = parseInt(arg('sample', '6000'), 10);
// --out writes the entries that pass the level gates, in the same shape as
// data/entries.json, so tools/sim-exits.mjs can run the real ladder on them.
const OUT = arg('out', '');
const OUT_RULE = arg('out-rule', 'support-room-trend');

const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');
const built = await esbuild.build({
  stdin: { contents: "export { analyzeFromCandles } from './src/services/marketAnalysisService';" +
                     "export { costPerSideRate } from './src/config/costs';",
           resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
});
const { analyzeFromCandles, costPerSideRate } = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const COST_ROUND_TRIP = costPerSideRate() * 2;

// ---------- load 5m bars ----------
const src = readFileSync('src/services/binanceService.ts', 'utf8');
const bars = new Map();
for (const sym of [...src.matchAll(/symbol: '([A-Z0-9]+)'/g)].map((m) => m[1])) {
  const dir = `${DIR}/${sym}USDT`;
  if (!existsSync(dir)) continue;
  const rows = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.csv')).sort())
    for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line) continue;
      const c = line.split(',');
      const t = Number(c[0]);
      if (!Number.isFinite(t)) continue;
      rows.push({ t: t > 1e14 ? Math.floor(t / 1000) : t, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] });
    }
  rows.sort((a, b) => a.t - b.t);
  if (rows.length) bars.set(sym, rows);
}
console.log(`loaded ${bars.size} symbols of 5m bars from ${DIR}`);

/** 5m bars aggregated into whole candles of `minutes` length. */
function aggregate(rows, minutes) {
  const ms = minutes * 60_000;
  const out = [];
  let cur = null;
  for (const r of rows) {
    const bucket = Math.floor(r.t / ms) * ms;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
    } else {
      cur.h = Math.max(cur.h, r.h);
      cur.l = Math.min(cur.l, r.l);
      cur.c = r.c;
      cur.v += r.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const tf = new Map();   // symbol -> { h1, h4, d1, idx5 }
for (const [sym, rows] of bars) {
  tf.set(sym, {
    h1: aggregate(rows, 60),
    h4: aggregate(rows, 240),
    d1: aggregate(rows, 1440),
    idx5: new Map(rows.map((r, i) => [r.t, i])),
  });
}

/** Candles strictly before `time` (no peeking at the candle being formed). */
const upTo = (candles, time, count) => {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < time) lo = mid + 1; else hi = mid;
  }
  return candles.slice(Math.max(0, lo - count), lo);
};

// ---------- entries ----------
const { entries } = JSON.parse(readFileSync(ENTRIES, 'utf8'));
let pool = entries.filter((e) => e.rank === 0 && e.dir === 'LONG' && e.atrPct > 0 && bars.has(e.symbol));
const stride = Math.max(1, Math.floor(pool.length / SAMPLE));
pool = pool.filter((_, i) => i % stride === 0);
console.log(`entry set: ${pool.length} top-ranked LONG entries (every ${stride}th)\n`);

/** Forward return from the entry close, `bars5` 5-minute bars later, net of a round trip. */
function forwardReturn(sym, startIdx, bars5) {
  const rows = bars.get(sym);
  const end = Math.min(startIdx + bars5, rows.length - 1);
  if (end <= startIdx) return null;
  return (rows[end].c - rows[startIdx].c) / rows[startIdx].c - COST_ROUND_TRIP;
}

const HORIZONS = [[12, '1h'], [48, '4h'], [288, '24h']];
const buckets = new Map();
const add = (name, key, values) => {
  if (!buckets.has(name)) buckets.set(name, new Map());
  const b = buckets.get(name);
  if (!b.has(key)) b.set(key, { n: 0, sums: HORIZONS.map(() => 0), sqs: HORIZONS.map(() => 0), wins: HORIZONS.map(() => 0) });
  const rec = b.get(key);
  rec.n++;
  values.forEach((v, i) => {
    if (v === null) return;
    rec.sums[i] += v;
    rec.sqs[i] += v * v;
    if (v > 0) rec.wins[i]++;
  });
};

const passing = [];
let analysed = 0;
let skipped = 0;
for (const e of pool) {
  const t = tf.get(e.symbol);
  const idx = t?.idx5.get(e.t);
  if (idx === undefined) { skipped++; continue; }
  const price = bars.get(e.symbol)[idx].c;
  const a = analyzeFromCandles(price, upTo(t.h1, e.t, 200), upTo(t.h4, e.t, 300), upTo(t.d1, e.t, 220), e.t);
  if (!a) { skipped++; continue; }
  analysed++;

  const values = HORIZONS.map(([b]) => forwardReturn(e.symbol, idx, b));
  add('all entries', 'all', values);

  // 1. distance to the nearest real support, in ATR
  const ds = a.distToSupportAtr;
  add('distance to support', ds === null ? 'no level' : ds <= 0.25 ? 'at support (<=0.25 ATR)'
    : ds <= 0.5 ? 'near support (<=0.5 ATR)' : ds <= 1.5 ? 'mid (0.5-1.5 ATR)' : 'far (>1.5 ATR)', values);

  // 2. headroom to the nearest real resistance
  const dr = a.distToResistanceAtr;
  add('headroom to resistance', dr === null ? 'clear above' : dr <= 0.25 ? 'blocked (<=0.25 ATR)'
    : dr <= 1 ? 'tight (<=1 ATR)' : 'roomy (>1 ATR)', values);

  // 3. pullback and reclaim on the 1h
  add('pullback state', !a.pullback.isPullback ? 'not in a pullback'
    : a.pullback.reclaimed ? 'pullback + reclaim candle' : 'pullback, no reclaim', values);

  // 4. 4h structure
  add('4h trend', a.structure.trend, values);

  // 5. composites: what is left after dropping the clearly bad buckets
  const blocked = dr !== null && dr <= 0.25;
  const bearish = a.structure.trend === 'BEARISH';
  const atSupport = ds !== null && ds <= 0.25;
  add('drop blocked resistance + bearish 4h', blocked || bearish ? 'rejected' : 'kept', values);
  add('...and require price at support', (blocked || bearish || !atSupport) ? 'rejected' : 'kept', values);
  add('...and require a reclaim candle',
    (blocked || bearish || !atSupport || !a.pullback.reclaimed) ? 'rejected' : 'kept', values);

  if (OUT) {
    const keep = OUT_RULE === 'support-room-trend-reclaim'
      ? (!blocked && !bearish && atSupport && a.pullback.reclaimed)
      : (!blocked && !bearish && atSupport);
    if (keep) passing.push(e);
  }

  // 6. the original strict rule
  const wanted = ds !== null && ds <= 0.5 && (dr === null || dr >= 1) && a.pullback.reclaimed;
  add('level rule (support + room + reclaim)', wanted ? 'passes' : 'rejected', values);
}
console.log(`analysed ${analysed} entries (${skipped} skipped for missing history)\n`);

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ rule: OUT_RULE, from: ENTRIES, entries: passing }));
  console.log(`wrote ${passing.length} entries passing "${OUT_RULE}" to ${OUT}\n`);
}

const bp = (x) => (x * 1e4).toFixed(1).padStart(8) + 'bp';
for (const [name, b] of buckets) {
  console.log(`${name}`);
  console.log(`  ${'bucket'.padEnd(34)}${'n'.padStart(7)}   ${HORIZONS.map(([, l]) => (l + ' net').padStart(11)).join('')}     ${HORIZONS.map(([, l]) => ('win% ' + l).padStart(10)).join('')}`);
  for (const [key, rec] of [...b.entries()].sort((x, y) => y[1].n - x[1].n)) {
    const means = rec.sums.map((s) => s / rec.n);
    const wins = rec.wins.map((w) => (w / rec.n * 100).toFixed(1).padStart(10));
    // t-stat on the 4h horizon, the middle one
    const sd = Math.sqrt(Math.max(0, rec.sqs[1] / rec.n - means[1] ** 2));
    const tstat = sd > 0 ? (means[1] / (sd / Math.sqrt(rec.n))).toFixed(1) : '-';
    console.log(`  ${key.padEnd(34)}${String(rec.n).padStart(7)}   ${means.map(bp).map((s) => s.padStart(11)).join('')}     ${wins.join('')}    t(4h) ${tstat}`);
  }
  console.log('');
}
