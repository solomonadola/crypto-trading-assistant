// Study B: do any scalping entries have edge at 15 minutes to 3 hours?
//
// Measures entries only, no exits: for each signal, what price did 15m, 30m,
// 1h, 2h and 3h later, and how far it went for and against the trade on the
// way (MFE/MAE). An exit ladder cannot create edge the entry does not have, so
// this is the gate before any exit design (STUDY_A_RESULTS.md, AUDIT.md §7).
//
// Every coin in the folder is scanned; the only coin rule is 24h USDT volume,
// reported by tier so the data shows where the floor belongs.
//
//   node tools/study-scalp-entries.mjs [--dir data/klines-wide] [--from 2024-03-01] [--to 2026-09-01]
//                                      [--min-vol 5000000] [--cooldown 24]
//
// Signals (all long, entry at the next bar's open, one per coin per cooldown):
//   breakout   close above the highest high of the last 4h, on a bar with 3x the
//              coin's average 5m volume of the last 24h, BTC not down >0.5% in 1h
//   pullback   coin up >3% over 4h with EMA20 > EMA60 (5m), a bar dipped to EMA20
//              in the last 3 bars, and this bar closes back above it, green
//   relstrength coin beats BTC by >3% over 2h (first bar it crosses), BTC 2h >= 0
//   random     every coin-bar that passes the volume floor, sampled 1 in 50;
//              the baseline any signal has to beat
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/klines-wide');
const FROM = Date.parse(arg('from', '2024-03-01') + 'T00:00:00Z');
const TO = Date.parse(arg('to', '2026-09-01') + 'T00:00:00Z');
const MIN_VOL = Number(arg('min-vol', '5000000'));
const COOLDOWN = Number(arg('cooldown', '24'));

const HORIZONS = [[3, '15m'], [6, '30m'], [12, '1h'], [24, '2h'], [36, '3h']];
const MAXH = 36;
const VOL_TIERS = [[5e6, '$5-20M'], [20e6, '$20-50M'], [50e6, '$50-200M'], [200e6, '$200M+']];
// Round-trip costs in bps. Spread is not in 5m klines, so these are fees plus
// an assumed slippage; thin coins will do worse than shown.
const COSTS = { taker: 20, maker: 8 };
// Tokenised shares and stablecoins: not crypto, never traded (src/config/universe.ts).
const EXCLUDED = new Set(['MSTRB', 'SNDKB', 'SPCXB', 'NVDAB', 'SOXLB', 'QQQB', 'CRCLB', 'U', 'USDC', 'FDUSD']);

function loadPair(pair) {
  const rows = new Map();
  for (const f of readdirSync(`${DIR}/${pair}`).filter((f) => f.endsWith('.csv'))) {
    for (const line of readFileSync(`${DIR}/${pair}/${f}`, 'utf8').split('\n')) {
      if (!line) continue;
      const c = line.split(',');
      let t = Number(c[0]);
      if (!Number.isFinite(t)) continue;
      if (t > 1e14) t = Math.floor(t / 1000);
      rows.set(t, [t, +c[1], +c[2], +c[3], +c[4], +c[7]]);
    }
  }
  const r = [...rows.values()].sort((a, b) => a[0] - b[0]);
  const n = r.length;
  const s = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), qv: new Float64Array(n) };
  r.forEach((x, i) => { s.t[i] = x[0]; s.o[i] = x[1]; s.h[i] = x[2]; s.l[i] = x[3]; s.c[i] = x[4]; s.qv[i] = x[5]; });
  return s;
}

function ema(arr, len) {
  const out = new Float64Array(arr.length);
  const k = 2 / (len + 1);
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}

const btc = loadPair('BTCUSDT');
const btcIdx = new Map();
btc.t.forEach((t, i) => btcIdx.set(t, i));
const btcRet = (t, bars) => {
  const i = btcIdx.get(t);
  if (i === undefined || i < bars) return NaN;
  return btc.c[i] / btc.c[i - bars] - 1;
};

// obs[signal] = array of { day, year, tier, fwd: [bps...], btcFwd: [bps...], mfe, mae }
const obs = { breakout: [], pullback: [], relstrength: [], random: [] };
let rng = 12345;
const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const pairs = readdirSync(DIR).filter((p) => p.endsWith('USDT') && !EXCLUDED.has(p.slice(0, -4)));
let scanned = 0;
for (const pair of pairs) {
  const sym = pair.slice(0, -4);
  const s = pair === 'BTCUSDT' ? btc : loadPair(pair);
  const n = s.t.length;
  if (n < 288 * 3) continue;
  scanned++;
  const e20 = ema(s.c, 20), e60 = ema(s.c, 60);
  const cumQv = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cumQv[i + 1] = cumQv[i] + s.qv[i];
  const last = { breakout: -1e9, pullback: -1e9, relstrength: -1e9 };
  let prevRel = 0;

  for (let i = 288; i < n - MAXH - 1; i++) {
    const t = s.t[i];
    // Gaps in the data would make "N bars later" mean something else: skip them.
    if (s.t[i - 288] !== t - 288 * 300_000 || s.t[i + MAXH + 1] !== t + (MAXH + 1) * 300_000) continue;
    const vol24 = cumQv[i + 1] - cumQv[i - 287];
    const rel = sym === 'BTC' ? 0 : (s.c[i] / s.c[i - 24] - 1) - btcRet(t, 24);
    const relCross = rel > 0.03 && prevRel <= 0.03;
    prevRel = rel;
    if (t < FROM || t >= TO || vol24 < MIN_VOL) continue;

    const fired = [];
    if (rand() < 0.02) fired.push('random');

    let hi48 = 0;
    for (let k = i - 48; k < i; k++) if (s.h[k] > hi48) hi48 = s.h[k];
    const avgQv = vol24 / 288;
    const b1 = btcRet(t, 12);
    if (s.c[i] > hi48 && s.qv[i] >= 3 * avgQv && !(b1 < -0.005) && i - last.breakout >= COOLDOWN) fired.push('breakout');

    const up4h = s.c[i] / s.c[i - 48] - 1;
    const dipped = s.l[i] <= e20[i] || s.l[i - 1] <= e20[i - 1] || s.l[i - 2] <= e20[i - 2];
    if (up4h > 0.03 && e20[i] > e60[i] && dipped && s.c[i] > e20[i] && s.c[i] > s.o[i] && i - last.pullback >= COOLDOWN) fired.push('pullback');

    if (sym !== 'BTC' && relCross && btcRet(t, 24) >= 0 && i - last.relstrength >= COOLDOWN) fired.push('relstrength');

    if (!fired.length) continue;
    const entry = s.o[i + 1];
    const bi = btcIdx.get(s.t[i + 1]);
    const fwd = [], btcFwd = [];
    for (const [h] of HORIZONS) {
      fwd.push((s.c[i + h] / entry - 1) * 1e4);
      btcFwd.push(bi !== undefined && btcIdx.get(s.t[i + h]) !== undefined ? (btc.c[btcIdx.get(s.t[i + h])] / btc.o[bi] - 1) * 1e4 : NaN);
    }
    let mfe = 0, mae = 0;
    for (let k = i + 1; k <= i + MAXH; k++) {
      mfe = Math.max(mfe, s.h[k] / entry - 1);
      mae = Math.max(mae, 1 - s.l[k] / entry);
    }
    let tier = VOL_TIERS[0][1];
    for (const [floor, name] of VOL_TIERS) if (vol24 >= floor) tier = name;
    const d = new Date(t);
    const rec = { day: Math.floor(t / 86_400_000), year: d.getUTCFullYear(), tier, fwd, btcFwd, mfe: mfe * 1e4, mae: mae * 1e4 };
    for (const f of fired) { obs[f].push(rec); if (f !== 'random') last[f] = i; }
  }
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
// t-stat over daily means: signals on the same day move together, so each day counts once.
function dayT(recs, get) {
  const byDay = new Map();
  for (const r of recs) { const v = get(r); if (!Number.isFinite(v)) continue; (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)).push(v); }
  const dm = [...byDay.values()].map(mean);
  if (dm.length < 10) return { t: NaN, m: NaN, days: dm.length, upDays: NaN };
  const m = mean(dm);
  const sd = Math.sqrt(dm.reduce((x, y) => x + (y - m) ** 2, 0) / (dm.length - 1));
  return { t: m / (sd / Math.sqrt(dm.length)), m, days: dm.length, upDays: 100 * dm.filter((x) => x > 0).length / dm.length };
}

function summarize(recs) {
  const out = { n: recs.length, horizons: {} };
  if (!recs.length) return out;
  HORIZONS.forEach(([, name], h) => {
    const v = recs.map((r) => r.fwd[h]);
    const ex = recs.map((r) => r.fwd[h] - r.btcFwd[h]).filter(Number.isFinite);
    out.horizons[name] = {
      meanBps: +mean(v).toFixed(1), medianBps: +median(v).toFixed(1), winPct: +(100 * v.filter((x) => x > 0).length / v.length).toFixed(1),
      excessBps: +mean(ex).toFixed(1), ...(() => { const d = dayT(recs, (r) => r.fwd[h]); return { dayMeanBps: +d.m.toFixed(1), tDaily: +d.t.toFixed(2), upDaysPct: +d.upDays.toFixed(1) }; })(),
      netTakerBps: +(mean(v) - COSTS.taker).toFixed(1), netMakerBps: +(mean(v) - COSTS.maker).toFixed(1),
    };
  });
  out.mfeMedBps = +median(recs.map((r) => r.mfe)).toFixed(0);
  out.maeMedBps = +median(recs.map((r) => r.mae)).toFixed(0);
  out.mfeMae = +(out.mfeMedBps / out.maeMedBps).toFixed(2);
  return out;
}

const result = { run: new Date().toISOString(), dir: DIR, from: arg('from', '2024-03-01'), to: arg('to', '2026-09-01'), coins: scanned, minVol: MIN_VOL, costs: COSTS, signals: {} };
const pad = (x, w) => String(x).padStart(w);
for (const [sig, recs] of Object.entries(obs)) {
  const all = summarize(recs);
  const byYear = {}, byTier = {};
  for (const y of [...new Set(recs.map((r) => r.year))].sort()) byYear[y] = summarize(recs.filter((r) => r.year === y));
  for (const [, tn] of VOL_TIERS) byTier[tn] = summarize(recs.filter((r) => r.tier === tn));
  result.signals[sig] = { all, byYear, byTier };

  console.log(`\n=== ${sig}  n=${all.n}  MFE/MAE (3h) ${all.mfeMedBps}/${all.maeMedBps} = ${all.mfeMae}`);
  console.log('  horizon   mean  median   win%  excessBTC  dayMean  t(daily)  upDays%  net@taker  net@maker');
  for (const [name, h] of Object.entries(all.horizons ?? {})) {
    console.log(`  ${name.padEnd(6)} ${pad(h.meanBps, 7)} ${pad(h.medianBps, 7)} ${pad(h.winPct, 6)} ${pad(h.excessBps, 10)} ${pad(h.dayMeanBps, 8)} ${pad(h.tDaily, 9)} ${pad(h.upDaysPct, 8)} ${pad(h.netTakerBps, 10)} ${pad(h.netMakerBps, 10)}`);
  }
  const line = (label, x) => x.n ? console.log(`  ${label.padEnd(10)} n=${pad(x.n, 6)}  1h ${pad(x.horizons['1h'].meanBps, 6)}  2h ${pad(x.horizons['2h'].meanBps, 6)}  3h ${pad(x.horizons['3h'].meanBps, 6)} bps  MFE/MAE ${x.mfeMae}`) : null;
  for (const [y, x] of Object.entries(byYear)) line(y, x);
  for (const [tn, x] of Object.entries(byTier)) line(tn, x);
}

mkdirSync('data/studies', { recursive: true });
const out = `data/studies/scalp-entries-${Date.now()}.json`;
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(`\n${scanned} coins scanned. Written ${out}`);
