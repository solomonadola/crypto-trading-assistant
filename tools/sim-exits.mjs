// Exit-ladder simulator. Holds the ENTRY SET FIXED and varies only the exit
// geometry, so the comparison isolates one variable (AUDIT.md section 11).
//
// Answers the claim made when ATR geometry landed: "wider barriers cut
// turnover". That was asserted from theory (barrier-touch time scales roughly
// with the square of distance). This measures it.
//
//   node tools/sim-exits.mjs [--max-bars 2016] [--sample 20000]
//
// Barrier resolution uses 5m bar high/low. When a bar touches both the stop and
// a profit tier, the stop is assumed to fill first - the conservative
// assumption, and the one that avoids flattering the result.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const MAX_BARS = parseInt(arg('max-bars', '2016'), 10);      // 7 days at 5m
const SAMPLE   = parseInt(arg('sample', '20000'), 10);
const DIR = arg('dir', 'data/klines');

// Costs and the NEW ladder come from the app's own config, so changing
// src/config/costs.ts or src/config/geometry.ts changes what this measures.
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');
const cfgBundle = await esbuild.build({
  stdin: {
    contents: "export { costPerSideRate } from './src/config/costs';" +
              "export { GEOMETRY_CONFIG, resolveGeometry } from './src/config/geometry';",
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
});
const { costPerSideRate, GEOMETRY_CONFIG, resolveGeometry } = await import(
  'data:text/javascript;base64,' + Buffer.from(cfgBundle.outputFiles[0].text).toString('base64'));
const COST_PER_SIDE = costPerSideRate();

// ---------- load bars ----------
const src = readFileSync('src/services/binanceService.ts', 'utf8');
const bars = new Map(), tidx = new Map();
for (const sym of [...src.matchAll(/symbol: '([A-Z0-9]+)'/g)].map(m => m[1])) {
  const dir = `${DIR}/${sym}USDT`; if (!existsSync(dir)) continue;
  const rows = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.csv')).sort())
    for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line) continue; const c = line.split(','); const t = Number(c[0]);
      if (Number.isFinite(t)) rows.push([t > 1e14 ? Math.floor(t / 1000) : t, +c[2], +c[3], +c[4]]);
    }
  rows.sort((a, b) => a[0] - b[0]);
  bars.set(sym, { h: Float64Array.from(rows.map(r => r[1])),
                  l: Float64Array.from(rows.map(r => r[2])),
                  c: Float64Array.from(rows.map(r => r[3])) });
  const m = new Map(); rows.forEach((r, i) => m.set(r[0], i)); tidx.set(sym, m);
}

// ---------- the two ladders ----------
// OLD: what the caps actually produced before the geometry change - identical
// for every altcoin. Deliberately frozen here as the historical baseline.
const oldLadder = () => ({ stop: 3.2, t1: 3.8, t2: 7.5, t3: 12.0, bePct: 0.3 });
// NEW: whatever src/config/geometry.ts currently specifies.
const newLadder = (atrPct) => {
  const g = resolveGeometry(atrPct);
  return { stop: g.stopPct, t1: g.tier1Pct, t2: g.tier2Pct, t3: g.tier3Pct,
           bePct: g.stopPct * GEOMETRY_CONFIG.breakevenFloorRMultiple };
};

/**
 * Walks bars forward applying the harvest ladder, breakeven ratchet and
 * post-T3 trail. Returns net return as a fraction of the position notional,
 * so it is comparable across the two ladders despite different sizing.
 */
function simulate(sym, startIdx, isShort, L) {
  const b = bars.get(sym); if (!b) return null;
  const entry = b.c[startIdx];
  if (!(entry > 0)) return null;

  const up = (pct) => isShort ? entry * (1 - pct / 100) : entry * (1 + pct / 100);
  const dn = (pct) => isShort ? entry * (1 + pct / 100) : entry * (1 - pct / 100);

  let stopPrice = dn(L.stop);
  let active = 1.0, banked = 0, cost = COST_PER_SIDE;   // entry side
  let t1 = false, t2 = false, t3 = false, peak = entry;

  const end = Math.min(startIdx + MAX_BARS, b.c.length - 1);
  for (let i = startIdx + 1; i <= end; i++) {
    const hi = b.h[i], lo = b.l[i];
    if (!(hi > 0) || !(lo > 0)) continue;

    // Stop first when a bar straddles both barriers (conservative).
    const stopHit = isShort ? hi >= stopPrice : lo <= stopPrice;
    if (stopHit) {
      const r = isShort ? (entry - stopPrice) / entry : (stopPrice - entry) / entry;
      cost += COST_PER_SIDE * active;
      return { ret: banked + active * r - cost, bars: i - startIdx,
               reason: t3 ? 'TRAIL' : t1 ? 'RATCHET' : 'STOP' };
    }

    const favourable = isShort ? lo : hi;
    if (isShort ? favourable < peak : favourable > peak) peak = favourable;

    const reached = (pct) => isShort ? lo <= up(pct) : hi >= up(pct);

    if (!t1 && reached(L.t1)) {
      t1 = true; banked += 0.33 * (L.t1 / 100); active -= 0.33;
      cost += COST_PER_SIDE * 0.33;
      stopPrice = up(L.bePct);                       // arm breakeven floor
    }
    if (!t2 && reached(L.t2)) {
      t2 = true; banked += 0.33 * (L.t2 / 100); active -= 0.33;
      cost += COST_PER_SIDE * 0.33;
      stopPrice = up(L.t1);                          // step-lock to tier 1
    }
    if (!t3 && reached(L.t3)) {
      t3 = true; banked += 0.17 * (L.t3 / 100); active -= 0.17;
      cost += COST_PER_SIDE * 0.17;
    }
    if (t3) {                                        // trail the runner
      const trail = isShort ? peak * 1.04 : peak * 0.96;
      if (isShort ? trail < stopPrice : trail > stopPrice) stopPrice = trail;
    }
  }

  // Timed out with the position still open.
  const last = b.c[end];
  const r = isShort ? (entry - last) / entry : (last - entry) / entry;
  cost += COST_PER_SIDE * active;
  return { ret: banked + active * r - cost, bars: end - startIdx, reason: 'TIMEOUT' };
}

// ---------- run both ladders on the same entries ----------
const { entries } = JSON.parse(readFileSync(arg('entries', 'data/entries.json'), 'utf8'));
let pool = entries.filter(e => e.rank === 0 && e.dir === 'LONG' && e.atrPct > 0);
const stride = Math.max(1, Math.floor(pool.length / SAMPLE));
pool = pool.filter((_, i) => i % stride === 0);
console.log(`entry set held fixed: ${pool.length} top-ranked LONG entries (every ${stride}th)\n`);

function run(name, makeLadder) {
  const rets = [], held = [], reasons = {};
  for (const e of pool) {
    const i = tidx.get(e.symbol)?.get(e.t); if (i === undefined) continue;
    const r = simulate(e.symbol, i, false, makeLadder(e.atrPct));
    if (!r) continue;
    rets.push(r.ret); held.push(r.bars); reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
  const wins = rets.filter(x => x > 0);
  const losses = rets.filter(x => x <= 0);
  const avgHoldH = held.reduce((a, b) => a + b, 0) / n * 5 / 60;
  const pf = Math.abs(losses.reduce((a, b) => a + b, 0)) > 0
    ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : Infinity;
  return {
    name, n,
    winPct: wins.length / n * 100,
    avgWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length * 1e4 : 0,
    avgLoss: losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0)) / losses.length * 1e4 : 0,
    expBps: mean * 1e4,
    pf, avgHoldH,
    rotPerDay: 24 / Math.max(avgHoldH, 0.01),
    tStat: mean / (sd / Math.sqrt(n)),
    reasons,
  };
}

const g = GEOMETRY_CONFIG;
const newLabel = `NEW (${g.stopAtrMultiple}x ATR, ${g.tier1RMultiple}R/${g.tier2RMultiple}R/${g.tier3RMultiple}R)`;
console.log(`costs ${(COST_PER_SIDE * 1e4).toFixed(0)}bp/side | ${newLabel} from src/config/geometry.ts\n`);
const results = [run('OLD (capped 3.2/3.8/7.5/12)', oldLadder), run(newLabel, newLadder)];

console.log('ladder                          n     win%   avgWin  avgLoss   expect    PF    avgHold  rot/day');
console.log('-'.repeat(101));
for (const r of results) {
  console.log(
    r.name.padEnd(30),
    String(r.n).padStart(6),
    r.winPct.toFixed(1).padStart(7),
    (r.avgWin.toFixed(0) + 'bp').padStart(8),
    (r.avgLoss.toFixed(0) + 'bp').padStart(9),
    (r.expBps.toFixed(1) + 'bp').padStart(9),
    r.pf.toFixed(2).padStart(6),
    (r.avgHoldH.toFixed(1) + 'h').padStart(9),
    r.rotPerDay.toFixed(1).padStart(8));
}
console.log('\nexit reasons:');
for (const r of results) console.log(`  ${r.name.padEnd(30)} ${JSON.stringify(r.reasons)}`);

const [o, nw] = results;
console.log(`\nturnover:  ${o.rotPerDay.toFixed(1)} -> ${nw.rotPerDay.toFixed(1)} rotations/day  (${((1 - nw.rotPerDay / o.rotPerDay) * 100).toFixed(0)}% reduction)`);
console.log(`hold time: ${o.avgHoldH.toFixed(1)}h -> ${nw.avgHoldH.toFixed(1)}h  (${(nw.avgHoldH / o.avgHoldH).toFixed(1)}x longer)`);
console.log(`expectancy per trade: ${o.expBps.toFixed(1)}bp -> ${nw.expBps.toFixed(1)}bp`);
console.log(`\nCost drag per unit time is what matters, not per trade:`);
for (const r of results) console.log(`  ${r.name.padEnd(30)} ${(r.expBps * r.rotPerDay).toFixed(1)} bp/day per slot`);
