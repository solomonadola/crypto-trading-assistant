// Beta-neutral residual momentum (AUDIT.md Tier 4, item 14).
//
// Study A showed the scanner's raw ranking earns ~0 excess of the
// cross-sectional mean - i.e. it buys beta. This tests whether ranking on the
// part of the move that ISN'T beta carries anything.
//
// Three signals, ranked cross-sectionally at every 5m step:
//   RAW    r_i                      (what the scanner effectively does)
//   DEMEAN r_i - mean(r)            (beta-neutral if all betas ~ 1)
//   RESID  r_i - beta_i * r_btc     (proper beta removal, rolling estimate)
//
// For each we take the top-3 and bottom-3 names and measure forward returns
// in excess of the cross-sectional mean, with Newey-West t-stats on one
// observation per timestamp.
//
//   node tools/study-residual.mjs [--dir data/klines] [--lookback 288]
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/klines');
const LOOKBACK = parseInt(arg('lookback', '288'), 10);   // 24h momentum window
const BETA_WIN = 288 * 30;                               // 30d of 5m bars for beta
const BETA_EVERY = 288;                                  // re-estimate daily
const TOP_N = 3;
const HORIZONS = (arg('horizons', '1,3,5,10,20,50')).split(',').map(Number);
const label = h => { const m = h * 5;
  return m >= 1440 ? `${(m/1440).toFixed(1)}d` : m >= 60 ? `${(m/60).toFixed(1)}h` : `${m}m`; };

const src = readFileSync('src/services/binanceService.ts', 'utf8');
const SYMS = [...src.matchAll(/symbol: '([A-Z0-9]+)'/g)].map(m => m[1]);

// ---------- load aligned closes on the BTC clock ----------
const raw = new Map();
for (const sym of SYMS) {
  const dir = `${DIR}/${sym}USDT`; if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter(f => f.endsWith('.csv')).sort();
  if (!files.length) continue;
  const rows = [];
  for (const f of files) for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
    if (!line) continue; const c = line.split(','); const t = Number(c[0]);
    if (Number.isFinite(t)) rows.push([t > 1e14 ? Math.floor(t / 1000) : t, +c[4]]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  raw.set(sym, rows);
}
if (!raw.has('BTC')) throw new Error(`no BTC data in ${DIR}`);

const clock = raw.get('BTC').map(r => r[0]);
const T = clock.length;
const pos = new Map(clock.map((t, i) => [t, i]));
const px = new Map();                                  // sym -> Float64Array aligned to clock
for (const [sym, rows] of raw) {
  const a = new Float64Array(T);
  for (const [t, c] of rows) { const i = pos.get(t); if (i !== undefined) a[i] = c; }
  px.set(sym, a);
}
const symbols = [...px.keys()];
console.log(`${DIR}: ${symbols.length} symbols | ${T} bars | ${new Date(clock[0]).toISOString().slice(0, 10)} .. ${new Date(clock.at(-1)).toISOString().slice(0, 10)}`);

// ---------- rolling beta vs BTC, re-estimated daily ----------
const btc = px.get('BTC');
const beta = new Map(symbols.map(s => [s, new Float64Array(T).fill(1)]));
for (let k = BETA_WIN; k < T; k += BETA_EVERY) {
  const bR = [];
  for (let i = k - BETA_WIN + 1; i <= k; i++) bR.push(btc[i] > 0 && btc[i - 1] > 0 ? (btc[i] - btc[i - 1]) / btc[i - 1] : 0);
  const bMean = bR.reduce((a, b) => a + b, 0) / bR.length;
  let bVar = 0; for (const x of bR) bVar += (x - bMean) ** 2;
  for (const sym of symbols) {
    const p = px.get(sym); const sR = [];
    for (let i = k - BETA_WIN + 1; i <= k; i++) sR.push(p[i] > 0 && p[i - 1] > 0 ? (p[i] - p[i - 1]) / p[i - 1] : 0);
    const sMean = sR.reduce((a, b) => a + b, 0) / sR.length;
    let cov = 0; for (let j = 0; j < bR.length; j++) cov += (bR[j] - bMean) * (sR[j] - sMean);
    const b = bVar > 0 ? cov / bVar : 1;
    const arr = beta.get(sym);
    for (let i = k; i < Math.min(T, k + BETA_EVERY); i++) arr[i] = Math.max(0.1, Math.min(3, b));
  }
}

function neweyWest(s, lag) {
  const n = s.length; if (n < 30) return [NaN, NaN];
  const m = s.reduce((a, b) => a + b, 0) / n, d = s.map(x => x - m);
  let v = d.reduce((a, x) => a + x * x, 0) / n;
  for (let L = 1; L <= lag; L++) {
    let g = 0; for (let i = L; i < n; i++) g += d[i] * d[i - L];
    v += 2 * (1 - L / (lag + 1)) * (g / n);
  }
  return [m, m / Math.sqrt(Math.max(v, 1e-18) / n)];
}

// ---------- walk the clock ----------
const acc = {};
const keys = ['RAW.top', 'RAW.bot', 'DEMEAN.top', 'DEMEAN.bot', 'RESID.top', 'RESID.bot'];
for (const k of keys) acc[k] = HORIZONS.map(() => []);

const startK = Math.max(BETA_WIN + BETA_EVERY, LOOKBACK + 1);
for (let k = startK; k < T - Math.max(...HORIZONS); k++) {
  const rows = [];
  for (const sym of symbols) {
    const p = px.get(sym);
    const p0 = p[k], pPrev = p[k - LOOKBACK];
    if (!(p0 > 0) || !(pPrev > 0)) continue;
    rows.push({ sym, r: (p0 - pPrev) / pPrev, b: beta.get(sym)[k] });
  }
  if (rows.length < 15) continue;

  const rBtc = rows.find(x => x.sym === 'BTC')?.r ?? 0;
  const mean = rows.reduce((a, x) => a + x.r, 0) / rows.length;
  for (const x of rows) { x.demean = x.r - mean; x.resid = x.r - x.b * rBtc; }

  // forward cross-sectional mean at each horizon (the benchmark)
  const xsFwd = HORIZONS.map(h => {
    let s = 0, n = 0;
    for (const x of rows) { const p = px.get(x.sym); if (p[k] > 0 && p[k + h] > 0) { s += (p[k + h] - p[k]) / p[k]; n++; } }
    return n ? s / n : 0;
  });

  const fwd = (sym, h) => { const p = px.get(sym); return p[k] > 0 && p[k + h] > 0 ? (p[k + h] - p[k]) / p[k] : null; };

  for (const [name, field] of [['RAW', 'r'], ['DEMEAN', 'demean'], ['RESID', 'resid']]) {
    const sorted = [...rows].sort((a, b) => b[field] - a[field]);
    for (const [side, picks] of [['top', sorted.slice(0, TOP_N)], ['bot', sorted.slice(-TOP_N)]]) {
      HORIZONS.forEach((h, hi) => {
        let s = 0, n = 0;
        for (const x of picks) { const f = fwd(x.sym, h); if (f !== null) { s += f - xsFwd[hi]; n++; } }
        if (n) acc[`${name}.${side}`][hi].push(s / n);
      });
    }
  }
}

console.log(`\nTop/bottom ${TOP_N} by signal | excess of cross-sectional mean | Newey-West t (lag = horizon)\n`);
for (const name of ['RAW', 'DEMEAN', 'RESID']) {
  console.log(`--- ${name} ---`);
  console.log('  horizon      LONG top-3 bps    t        SHORT bot-3 bps    t     (bot negative = reversal)');
  HORIZONS.forEach((h, hi) => {
    const lag = Math.min(h, 2000);
    const [tm, tt] = neweyWest(acc[`${name}.top`][hi], lag);
    const [bm, bt] = neweyWest(acc[`${name}.bot`][hi], lag);
    console.log(`  ${label(h).padStart(6)}  ${(tm * 1e4).toFixed(2).padStart(14)}  ${tt.toFixed(2).padStart(6)}  ${(bm * 1e4).toFixed(2).padStart(17)}  ${bt.toFixed(2).padStart(6)}`);
  });
  console.log();
}
console.log(`steps used: ${acc['RAW.top'][0].length}`);
console.log('Reference: round-trip friction is ~20 bps. An edge must clear that, not just t=2.');
