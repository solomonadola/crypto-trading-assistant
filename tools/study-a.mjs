// STUDY A - does the entry have edge? (AUDIT.md section 7)
//
// Takes the replay's entry log, discards its exits entirely, and measures
// forward returns against three controls. The one that decides the project is
// control 3: the cross-sectional mean of all symbols at the same instant.
// A momentum scanner on a green day just buys beta; control 3 removes it.
//
// Statistics: entries overlap heavily in time (1.3M obs from 52k steps, and
// horizons overlap each other), so naive t-stats are badly inflated. We
// collapse to one observation per timestamp, then apply Newey-West with lag =
// horizon length. That is the difference between a real result and a mirage.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const BARS = 288, DIR = 'data/klines';
const HORIZONS = [1, 3, 5, 10, 20, 50];        // x5m => 5m 15m 25m 50m 100m 250m
const label = h => h * 5 >= 60 ? `${(h * 5 / 60).toFixed(1)}h` : `${h * 5}m`;

// ---------- load bars ----------
const src = readFileSync('src/services/binanceService.ts', 'utf8');
const SYMS = [...src.matchAll(/symbol: '([A-Z0-9]+)'/g)].map(m => m[1]);
const closes = new Map(), highs = new Map(), lows = new Map(), tidx = new Map();
for (const sym of SYMS) {
  const dir = `${DIR}/${sym}USDT`;
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter(f => f.endsWith('.csv')).sort();
  if (!files.length) continue;
  const rows = [];
  for (const f of files) for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
    if (!line) continue;
    const c = line.split(','); const t = Number(c[0]);
    if (!Number.isFinite(t)) continue;
    rows.push([t > 1e14 ? Math.floor(t / 1000) : t, +c[2], +c[3], +c[4]]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  closes.set(sym, Float64Array.from(rows.map(r => r[3])));
  highs .set(sym, Float64Array.from(rows.map(r => r[1])));
  lows  .set(sym, Float64Array.from(rows.map(r => r[2])));
  const m = new Map(); rows.forEach((r, i) => m.set(r[0], i)); tidx.set(sym, m);
}

// ---------- cross-sectional mean forward return per step (control 3) ----------
const clockArr = [...tidx.get('BTC').keys()].sort((a, b) => a - b);
const xs = new Map();                                  // t -> [ret per horizon]
for (const t of clockArr) {
  const acc = HORIZONS.map(() => [0, 0]);
  for (const sym of closes.keys()) {
    const i = tidx.get(sym).get(t); if (i === undefined) continue;
    const c = closes.get(sym); const p0 = c[i]; if (!(p0 > 0)) continue;
    HORIZONS.forEach((h, k) => { const p1 = c[i + h]; if (p1 > 0) { acc[k][0] += (p1 - p0) / p0; acc[k][1]++; } });
  }
  xs.set(t, acc.map(([s, n]) => n ? s / n : 0));
}

// ---------- Newey-West t-stat on a time series of per-step means ----------
function neweyWest(series, lag) {
  const n = series.length; if (n < 30) return [NaN, NaN];
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const d = series.map(x => x - mean);
  let g0 = d.reduce((a, x) => a + x * x, 0) / n, v = g0;
  for (let L = 1; L <= lag; L++) {
    let g = 0; for (let i = L; i < n; i++) g += d[i] * d[i - L];
    g /= n;
    v += 2 * (1 - L / (lag + 1)) * g;                  // Bartlett kernel
  }
  return [mean, mean / Math.sqrt(Math.max(v, 1e-18) / n)];
}

// ---------- study ----------
const { entries, start, end, steps, scanned } = JSON.parse(readFileSync('data/entries.json', 'utf8'));
console.log(`window ${start} .. ${end} | ${steps} steps | ${entries.length} eligible (${(100*entries.length/scanned).toFixed(1)}% of symbol-steps)\n`);

function run(name, filter) {
  const sel = entries.filter(filter);
  if (!sel.length) return;
  // group per timestamp -> one observation per step (removes cross-sectional overlap)
  const byT = new Map();
  const mfe = [], mae = [];
  for (const e of sel) {
    const i = tidx.get(e.symbol)?.get(e.t); if (i === undefined) continue;
    const c = closes.get(e.symbol), hi = highs.get(e.symbol), lo = lows.get(e.symbol);
    const p0 = c[i]; if (!(p0 > 0)) continue;
    const sgn = e.dir === 'SHORT' ? -1 : 1;
    const x = xs.get(e.t); if (!x) continue;
    let rec = byT.get(e.t); if (!rec) { rec = HORIZONS.map(() => [0, 0, 0]); byT.set(e.t, rec); }
    HORIZONS.forEach((h, k) => {
      const p1 = c[i + h]; if (!(p1 > 0)) return;
      const raw = sgn * (p1 - p0) / p0;
      rec[k][0] += raw; rec[k][1] += raw - sgn * x[k]; rec[k][2]++;   // raw, excess-of-beta, n
    });
    // MFE / MAE over 50 bars
    let best = 0, worst = 0;
    for (let j = i + 1; j <= i + 50 && j < c.length; j++) {
      const up = sgn > 0 ? (hi[j] - p0) / p0 : (p0 - lo[j]) / p0;
      const dn = sgn > 0 ? (lo[j] - p0) / p0 : (p0 - hi[j]) / p0;
      if (up > best) best = up; if (dn < worst) worst = dn;
    }
    mfe.push(best * 100); mae.push(-worst * 100);
  }
  const ts = [...byT.keys()].sort((a, b) => a - b);
  console.log(`--- ${name}  (n=${sel.length} entries, ${ts.length} time clusters) ---`);
  console.log('  horizon    raw bps   excess-of-beta bps    NW t-stat   verdict');
  HORIZONS.forEach((h, k) => {
    const rawS = [], excS = [];
    for (const t of ts) { const r = byT.get(t)[k]; if (r[2]) { rawS.push(r[0] / r[2]); excS.push(r[1] / r[2]); } }
    const [rm] = neweyWest(rawS, h);
    const [em, et] = neweyWest(excS, h);
    const sig = Math.abs(et) > 2 ? (et > 0 ? 'EDGE' : 'INVERTED') : 'noise';
    console.log(`  ${label(h).padStart(6)}  ${(rm*1e4).toFixed(2).padStart(9)}   ${(em*1e4).toFixed(2).padStart(17)}   ${et.toFixed(2).padStart(9)}   ${sig}`);
  });
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log(`  MFE/MAE over 250m:  median MFE ${med(mfe).toFixed(2)}%  |  median MAE ${med(mae).toFixed(2)}%  |  ratio ${(med(mfe)/(med(mae)||1)).toFixed(2)}`);
  console.log();
}

run('ALL ELIGIBLE (the gate)',            e => true);
run('TOP PICK ONLY (what the bot trades)', e => e.rank === 0);
run('TOP PICK - LONG',                     e => e.rank === 0 && e.dir === 'LONG');
run('TOP PICK - SHORT',                    e => e.rank === 0 && e.dir === 'SHORT');
run('SCORE >= 95',                         e => e.score >= 95);
