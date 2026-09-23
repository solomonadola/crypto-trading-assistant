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
// --cost-bps overrides the configured cost, to see which exit still works if
// real slippage is worse than assumed. Turnover-heavy ladders fail first.
const COST_OVERRIDE = arg('cost-bps', '');
const COST_PER_SIDE = COST_OVERRIDE ? Number(COST_OVERRIDE) / 1e4 : costPerSideRate();

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

// ---------- exit variants ----------
//
// Every variant is a spec applied to the SAME entries:
//   stop, t1..t3          barrier distances in % from entry
//   fracs                 fraction of the position sold at each tier
//   bePct                 where the stop goes after tier 1 (breakeven floor)
//   trailAfterTier        start following the peak after N tiers (99 = never)
//   trailPctOfEntry       trailing distance, in % of entry (ATR-scaled by caller)
//   climaxTighten         after tier 3, also tighten to 4/2.5/1.8% of the peak
//   locks                 [{ atPct, lockPct }] fixed "up X, lock Y" rules
//   capPct                close the whole position at +X%
const oldLadder = () => ({ stop: 3.2, t1: 3.8, t2: 7.5, t3: 12.0, bePct: 0.3,
  fracs: [0.33, 0.33, 0.17], trailAfterTier: 3, trailPctOfEntry: null, climaxTighten: true });

const currentLadder = (atrPct) => ladderOf(
  GEOMETRY_CONFIG.stopAtrMultiple, GEOMETRY_CONFIG.tier1RMultiple,
  GEOMETRY_CONFIG.tier2RMultiple, GEOMETRY_CONFIG.tier3RMultiple)(atrPct);

/**
 * The shipped ladder shape with different multiples: stop `stopAtr` x ATR,
 * tiers at R multiples. Everything else - the breakeven floor, the tier
 * fractions, when trailing starts and how far behind the peak it follows, the
 * parabolic-climax tightening - comes from src/config/geometry.ts, so what is
 * measured here is what cycleEngineService actually does.
 */
const ladderOf = (stopAtr, t1R, t2R, t3R) => (atrPct) => {
  const cfg = { ...GEOMETRY_CONFIG, stopAtrMultiple: stopAtr, tier1RMultiple: t1R, tier2RMultiple: t2R, tier3RMultiple: t3R };
  const g = resolveGeometry(atrPct, cfg);
  return { stop: g.stopPct, t1: g.tier1Pct, t2: g.tier2Pct, t3: g.tier3Pct,
           bePct: g.stopPct * cfg.breakevenFloorRMultiple,
           fracs: [0.33, 0.33, 0.17],
           trailAfterTier: cfg.trailAfterTier, trailPctOfEntry: cfg.trailAtrMultiple * atrPct,
           climaxTighten: true };
};

/** The current ladder, but trailing starts after tier `after`, k x ATR behind the peak. */
const trailLadder = (after, k) => (atrPct) => ({ ...currentLadder(atrPct),
  trailAfterTier: after, trailPctOfEntry: k * atrPct, climaxTighten: false });

/** No tiers at all: the whole position rides a k x ATR trailing stop. */
const pureTrail = (k) => (atrPct) => {
  const g = resolveGeometry(atrPct);
  return { stop: g.stopPct, t1: Infinity, t2: Infinity, t3: Infinity, bePct: 0,
           fracs: [0, 0, 0], trailAfterTier: 0, trailPctOfEntry: k * atrPct, climaxTighten: false };
};

/** Sell `frac` at tier 1 to take risk off, then trail the rest k x ATR behind the peak. */
const oneTierThenTrail = (frac, k) => (atrPct) => {
  const g = resolveGeometry(atrPct);
  return { stop: g.stopPct, t1: g.tier1Pct, t2: Infinity, t3: Infinity,
           bePct: g.stopPct * GEOMETRY_CONFIG.breakevenFloorRMultiple,
           fracs: [frac, 0, 0], trailAfterTier: 1, trailPctOfEntry: k * atrPct, climaxTighten: false };
};

/** Fixed "up 10 lock 7, up 15 lock 12.5, out at 20" - no tiers, no volatility scaling. */
const fixedLocks = (atrPct) => {
  const g = resolveGeometry(atrPct);
  return { stop: g.stopPct, t1: Infinity, t2: Infinity, t3: Infinity, bePct: 0,
           fracs: [0, 0, 0], trailAfterTier: 99, trailPctOfEntry: null, climaxTighten: false,
           locks: [{ atPct: 10, lockPct: 7 }, { atPct: 15, lockPct: 12.5 }], capPct: 20 };
};

/**
 * Walks bars forward applying the spec. Returns net return as a fraction of the
 * position notional, so variants are comparable despite different sizing.
 */
function simulate(sym, startIdx, isShort, L) {
  const b = bars.get(sym); if (!b) return null;
  const entry = b.c[startIdx];
  if (!(entry > 0)) return null;

  const up = (pct) => isShort ? entry * (1 - pct / 100) : entry * (1 + pct / 100);
  const dn = (pct) => isShort ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
  const moreProtective = (a, b2) => isShort ? Math.min(a, b2) : Math.max(a, b2);

  let stopPrice = dn(L.stop);
  let active = 1.0, banked = 0, cost = COST_PER_SIDE;   // entry side
  let taken = 0, peak = entry;
  const fracs = L.fracs || [0.33, 0.33, 0.17];
  const tiers = [L.t1, L.t2, L.t3];

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
               reason: taken >= 3 ? 'TRAIL' : taken >= 1 ? 'RATCHET' : 'STOP' };
    }

    const favourable = isShort ? lo : hi;
    if (isShort ? favourable < peak : favourable > peak) peak = favourable;
    const peakPct = isShort ? (entry - peak) / entry * 100 : (peak - entry) / entry * 100;

    // Close the lot at a fixed cap (+X%).
    if (L.capPct != null && (isShort ? lo <= up(L.capPct) : hi >= up(L.capPct))) {
      cost += COST_PER_SIDE * active;
      return { ret: banked + active * (L.capPct / 100) - cost, bars: i - startIdx, reason: 'CAP' };
    }

    const reached = (pct) => Number.isFinite(pct) && (isShort ? lo <= up(pct) : hi >= up(pct));
    for (let k = 0; k < 3; k++) {
      if (taken === k && reached(tiers[k])) {
        taken = k + 1;
        banked += fracs[k] * (tiers[k] / 100);
        active -= fracs[k];
        cost += COST_PER_SIDE * fracs[k];
        if (k === 0) stopPrice = moreProtective(stopPrice, up(L.bePct));
        if (k === 1) stopPrice = moreProtective(stopPrice, up(L.t1));
      }
    }

    // Fixed "up X, lock Y" rules.
    for (const rule of L.locks || []) {
      if (peakPct >= rule.atPct) stopPrice = moreProtective(stopPrice, up(rule.lockPct));
    }

    // Trailing stop, k x ATR behind the peak, once enough tiers are taken.
    if (L.trailPctOfEntry != null && taken >= L.trailAfterTier) {
      const trail = isShort ? peak * (1 + L.trailPctOfEntry / 100) : peak * (1 - L.trailPctOfEntry / 100);
      stopPrice = moreProtective(stopPrice, trail);
    }
    if (L.climaxTighten && taken >= 3) {
      const rp = isShort ? (entry - (isShort ? lo : hi)) / entry * 100 : peakPct;
      const buf = rp >= 35 ? 0.018 : rp >= 20 ? 0.025 : 0.04;
      stopPrice = moreProtective(stopPrice, isShort ? peak * (1 + buf) : peak * (1 - buf));
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
  const sorted = [...rets].sort((a, b) => b - a);
  const top5 = sorted.slice(0, Math.max(1, Math.round(n * 0.05)));
  const grossWin = wins.reduce((a, b) => a + b, 0);
  return {
    name, n,
    maxWin: sorted[0] * 100,
    top5Share: grossWin > 0 ? top5.reduce((a, b) => a + b, 0) / grossWin * 100 : 0,
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
const newLabel = `(${g.stopAtrMultiple}x ATR, ${g.tier1RMultiple}R/${g.tier2RMultiple}R/${g.tier3RMultiple}R)`;
console.log(`costs ${(COST_PER_SIDE * 1e4).toFixed(0)}bp/side | ${newLabel} from src/config/geometry.ts\n`);
const results = [
  run('OLD (capped 3.2/3.8/7.5/12)', oldLadder),
  run(`CURRENT ${newLabel}`, currentLadder),
  run('previous (1.5x ATR, 1R/2R/3.5R)', ladderOf(1.5, 1, 2, 3.5)),
  run('tight: 1.0x ATR, 1R/2R/3R', ladderOf(1.0, 1, 2, 3)),
  run('tight: 0.75x ATR, 1R/2R/3R', ladderOf(0.75, 1, 2, 3)),
  run('tight: 1.0x ATR, 0.75R/1.5R/2.5R', ladderOf(1.0, 0.75, 1.5, 2.5)),
  run('tight: 0.5x ATR, 1R/2R/3R', ladderOf(0.5, 1, 2, 3)),
  run('tight: 1.5x ATR, 0.5R/1R/2R', ladderOf(1.5, 0.5, 1, 2)),
  run('trail after T1, 1.0x ATR', trailLadder(1, 1.0)),
  run('trail after T1, 1.5x ATR', trailLadder(1, 1.5)),
  run('trail after T1, 2.0x ATR', trailLadder(1, 2.0)),
  run('trail after T2, 1.5x ATR', trailLadder(2, 1.5)),
  run('pure trail, 2.5x ATR (no tiers)', pureTrail(2.5)),
  run('fixed locks 10/7, 15/12.5, cap 20', fixedLocks),
  run('pure trail, 3.5x ATR (no tiers)', pureTrail(3.5)),
  run('T1 33% then trail 2.5x ATR', oneTierThenTrail(0.33, 2.5)),
  run('T1 33% then trail 3.5x ATR', oneTierThenTrail(0.33, 3.5)),
  run('pure trail, 5.0x ATR (no tiers)', pureTrail(5.0)),
  run('pure trail, 8.0x ATR (no tiers)', pureTrail(8.0)),
  // Sanity checks: no exit logic at all, and no stop at all. If the wide
  // trails only match these, the "improvement" is market exposure, not exits.
  run('initial stop only, hold to 7d', (atrPct) => ({ ...pureTrail(2.5)(atrPct), trailPctOfEntry: null })),
  run('no stop at all, hold to 7d', () => ({ stop: 99, t1: Infinity, t2: Infinity, t3: Infinity,
      bePct: 0, fracs: [0, 0, 0], trailAfterTier: 99, trailPctOfEntry: null, climaxTighten: false })),
];

console.log('exit rule                          n    win%   avgWin  avgLoss   expect    PF   avgHold rot/day  maxWin  top5%');
console.log('-'.repeat(118));
for (const r of results) {
  console.log(
    r.name.padEnd(33),
    String(r.n).padStart(6),
    r.winPct.toFixed(1).padStart(7),
    (r.avgWin.toFixed(0) + 'bp').padStart(8),
    (r.avgLoss.toFixed(0) + 'bp').padStart(9),
    (r.expBps.toFixed(1) + 'bp').padStart(9),
    r.pf.toFixed(2).padStart(6),
    (r.avgHoldH.toFixed(1) + 'h').padStart(8),
    r.rotPerDay.toFixed(1).padStart(7),
    (r.maxWin.toFixed(0) + '%').padStart(8),
    (r.top5Share.toFixed(0) + '%').padStart(6));
}
console.log('\nexit reasons:');
for (const r of results) console.log(`  ${r.name.padEnd(30)} ${JSON.stringify(r.reasons)}`);

const [o, nw] = results;
console.log(`\nturnover:  ${o.rotPerDay.toFixed(1)} -> ${nw.rotPerDay.toFixed(1)} rotations/day  (${((1 - nw.rotPerDay / o.rotPerDay) * 100).toFixed(0)}% reduction)`);
console.log(`hold time: ${o.avgHoldH.toFixed(1)}h -> ${nw.avgHoldH.toFixed(1)}h  (${(nw.avgHoldH / o.avgHoldH).toFixed(1)}x longer)`);
console.log(`expectancy per trade: ${o.expBps.toFixed(1)}bp -> ${nw.expBps.toFixed(1)}bp`);
console.log(`\nCost drag per unit time is what matters, not per trade:`);
for (const r of results) console.log(`  ${r.name.padEnd(30)} ${(r.expBps * r.rotPerDay).toFixed(1)} bp/day per slot`);
