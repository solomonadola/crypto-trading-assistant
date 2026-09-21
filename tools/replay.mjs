// Replays the REAL scanner over historical 5m bars and logs every entry the
// auto-pilot would have taken. Exits are NOT simulated - this measures the
// entry in isolation (Study A). See AUDIT.md section 7.
//
//   node tools/replay.mjs [--out data/entries.json]
//
// Snapshot reconstruction is the part that must be exactly right: at each
// decision step we rebuild the 24h ROLLING fields the app reads from
// /ticker/24hr, using only bars at or before that step. Using a completed
// daily bar's high/low here would be look-ahead bias and would manufacture
// an edge that does not exist.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { scanLiveMarketEntries } from './_gen/scanner.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const OUT = arg('out', 'data/entries.json');
const BARS_24H = 288;            // 288 x 5m = 24h rolling window
const DIR = 'data/klines';

// --- asset metadata straight from the app, so ids/names/symbols match ---
const assetSrc = readFileSync('src/services/binanceService.ts', 'utf8');
const ASSETS = [...assetSrc.matchAll(/\{ id: '([^']+)', symbol: '([A-Z0-9]+)', name: '([^']+)'/g)]
  .map(m => ({ id: m[1], symbol: m[2], name: m[3] }));

// --- load bars ---
const series = new Map();
for (const a of ASSETS) {
  const pair = `${a.symbol}USDT`, dir = `${DIR}/${pair}`;
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter(f => f.endsWith('.csv')).sort();
  if (!files.length) continue;
  const bars = [];
  for (const f of files) {
    for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line) continue;
      const c = line.split(',');
      const t = Number(c[0]);
      if (!Number.isFinite(t)) continue;                       // skip header rows
      bars.push({ t: t > 1e14 ? Math.floor(t / 1000) : t,      // some dumps are microseconds
                  h: +c[2], l: +c[3], c: +c[4], qv: +c[7] });
    }
  }
  bars.sort((x, y) => x.t - y.t);
  if (bars.length > BARS_24H * 2) series.set(a.symbol, { asset: a, bars });
}

console.log(`loaded ${series.size} symbols`);

// --- common timeline: every 5m step present in BTC (the market clock) ---
const clock = series.get('BTC').bars.map(b => b.t);
const idx = new Map();
for (const [sym, s] of series) {
  const m = new Map();
  s.bars.forEach((b, i) => m.set(b.t, i));
  idx.set(sym, m);
}

const start = new Date(clock[BARS_24H]).toISOString().slice(0, 10);
const end = new Date(clock.at(-1)).toISOString().slice(0, 10);
console.log(`timeline ${start} .. ${end} | ${clock.length - BARS_24H} decision steps`);

// --- App.tsx auto-pilot eligibility (App.tsx:309-327), replicated ---
function autoPilotWouldFire(s) {
  const conf = s.timeframeConfluence?.confluenceRating;
  const aligned = s.timeframeConfluence?.alignedCount ?? 3;
  if (conf === 'DISQUALIFIED' || conf === 'C' || aligned < 2) return false;
  if (s.status === 'TRIGGERED' && s.score >= 75) return true;
  if (s.status === 'FORMING' && s.score >= 75 && !s.disqualificationReason)
    return s.checkpoints.filter(c => c.passed).length >= 3;
  if (s.status === 'STAGING_AT_SUPPORT' && s.score >= 75 && s.microConfirmation?.isGreenReversal) return true;
  return false;
}

// App.tsx:329-356 candidate ordering, replicated. The bot deploys ONLY
// eligibleCandidates[0], so the top pick is what actually gets traded.
const MAJORS = new Set(['BTC','ETH','BNB','SOL']);
function appSort(a, b) {
  const cr = s => s.timeframeConfluence?.confluenceRating === 'A+' ? 2
               : s.timeframeConfluence?.confluenceRating === 'A'  ? 1 : 0;
  if (cr(b) !== cr(a)) return cr(b) - cr(a);
  const stalling = s => MAJORS.has(s.symbol.toUpperCase()) && Math.abs(s.priceChange24hPct || 0) < 2.5;
  if (!stalling(a) && stalling(b)) return -1;
  if (stalling(a) && !stalling(b)) return 1;
  if (a.status === 'TRIGGERED' && b.status !== 'TRIGGERED') return -1;
  if (b.status === 'TRIGGERED' && a.status !== 'TRIGGERED') return 1;
  return b.score - a.score;
}

const entries = [];
let steps = 0, scanned = 0;

for (let k = BARS_24H; k < clock.length; k++) {
  const t = clock[k];
  const coins = [];

  for (const [sym, s] of series) {
    const i = idx.get(sym).get(t);
    if (i === undefined || i < BARS_24H) continue;
    const w = s.bars.slice(i - BARS_24H + 1, i + 1);       // rolling 24h, no future data
    let hi = -Infinity, lo = Infinity, qv = 0;
    for (const b of w) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; qv += b.qv; }
    const price = s.bars[i].c;
    const prev = s.bars[i - BARS_24H].c;
    if (!(price > 0) || !(prev > 0) || !(qv > 0)) continue;

    coins.push({
      id: s.asset.id, symbol: s.asset.symbol.toLowerCase(), name: s.asset.name,
      current_price: price,
      price_change_percentage_24h: ((price - prev) / prev) * 100,
      high_24h: hi, low_24h: lo,
      total_volume: qv,
      market_cap: qv * 15,        // the app synthesises this (binanceService.ts:153).
                                  // Replicated exactly - it drives the degeneracy in AUDIT.md section 2.
    });
  }
  if (coins.length < 10) continue;

  const all = scanLiveMarketEntries(coins, 'FUTURES_1_2D');
  scanned += all.length;
  const eligible = all.filter(autoPilotWouldFire).sort(appSort);
  for (let r = 0; r < eligible.length; r++) {
    const sig = eligible[r];
    entries.push({
      rank: r,                       // 0 = the one the bot actually deploys
      t, symbol: sig.symbol, dir: sig.direction, score: sig.score,
      status: sig.status, archetype: sig.archetype,
      conf: sig.timeframeConfluence?.confluenceRating,
      price: sig.currentPrice,
      stopPct: sig.tradePlan.stopLossPct, t1Pct: sig.tradePlan.tier1Pct,
      t2Pct: sig.tradePlan.tier2Pct, rr: sig.tradePlan.rewardRiskRatio,
      chg24h: +sig.priceChange24hPct.toFixed(2),
    });
  }
  if (++steps % 2000 === 0) {
    process.stdout.write(`  ${new Date(t).toISOString().slice(0,10)}  steps ${steps}  entries ${entries.length}\r`);
  }
}

writeFileSync(OUT, JSON.stringify({ start, end, steps, scanned, entries }));
const tops = entries.filter(e => e.rank === 0).length;
console.log(`\n\nsteps ${steps} | signals evaluated ${scanned} | eligible ${entries.length} (${(100*entries.length/scanned).toFixed(1)}% of all symbol-steps)`);
console.log(`top-ranked picks (what the bot deploys): ${tops}`);
console.log(`wrote ${OUT}`);
