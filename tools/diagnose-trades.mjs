// Finds corrupted trade records in an exported feed.
//
// Removing the P&L clamp in bankrollService made pre-existing bad values
// visible in the totals. The clamp was hiding them, not preventing them. This
// locates which records are wrong and what they contribute.
//
//   node tools/diagnose-trades.mjs <trades.json>
//
// To export from the browser, open the app and run in the console:
//   copy(localStorage.getItem('crypto_automated_trades_local_fallback'))
// then paste into a file.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/diagnose-trades.mjs <trades.json>');
  process.exit(1);
}

let trades = JSON.parse(readFileSync(file, 'utf8'));
if (typeof trades === 'string') trades = JSON.parse(trades);   // double-encoded localStorage dump
if (!Array.isArray(trades)) { console.error('expected an array of trades'); process.exit(1); }

const usd = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2);
const open = trades.filter(t => t.status === 'OPEN');
const closed = trades.filter(t => t.status !== 'OPEN');

console.log(`${trades.length} trades  (${open.length} open, ${closed.length} closed)\n`);

// ---------- 1. records whose P&L is impossible for their position size ----------
const suspect = [];
for (const t of trades) {
  const pos = Number(t.positionSizeUSD) || 10;
  const pnl = Number(t.pnlUSD) || 0;
  const banked = Number(t.realizedCashBankedUSD) || 0;
  const entry = Number(t.entryPrice) || 0;
  const cur = Number(t.currentPrice) || 0;
  const movePct = entry > 0 ? ((cur - entry) / entry) * 100 : 0;

  const flags = [];
  if (Math.abs(pnl) > pos * 0.5) flags.push(`pnl ${usd(pnl)} vs ${usd(pos)} position`);
  if (banked > pos * 0.25) flags.push(`banked ${usd(banked)} > 25% of position`);
  if (Math.abs(movePct) > 100) flags.push(`price moved ${movePct.toFixed(0)}% since entry`);
  if (entry > 0 && cur > 0 && (cur / entry > 5 || entry / cur > 5)) {
    flags.push(`entry ${entry} vs current ${cur} differ >5x - likely a wrong-symbol price`);
  }
  if (flags.length) suspect.push({ t, pnl, banked, pos, movePct, flags });
}

if (suspect.length) {
  console.log(`--- ${suspect.length} suspect record(s) ---\n`);
  suspect.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  for (const s of suspect) {
    const when = s.t.closedAtTimestamp || s.t.openedAtTimestamp;
    console.log(`  ${s.t.symbol}  ${s.t.status}  ${when ? new Date(when).toISOString().slice(0, 16).replace('T', ' ') : '?'}`);
    console.log(`    entry ${s.t.entryPrice}   current ${s.t.currentPrice}   exit ${s.t.exitPrice ?? '-'}`);
    console.log(`    pnlUSD ${usd(s.pnl)}   banked ${usd(s.banked)}   position ${usd(s.pos)}   exitReason ${s.t.exitReason || '-'}`);
    const tiers = s.t.harvestTiers;
    if (tiers) {
      console.log(`    tiers  T1 ${tiers.tier1?.status}@${tiers.tier1?.targetPct}%  T2 ${tiers.tier2?.status}@${tiers.tier2?.targetPct}%  T3 ${tiers.tier3?.status}@${tiers.tier3?.targetPct}%`);
    }
    for (const f of s.flags) console.log(`    !! ${f}`);
    console.log(`    id ${s.t.id}`);
    console.log();
  }
} else {
  console.log('No individually impossible records found.\n');
}

// ---------- 2. what the totals look like with and without the suspects ----------
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const suspectIds = new Set(suspect.map(s => s.t.id));

const closedPnL = sum(closed, t => t.pnlUSD);
const openPnL = sum(open, t => t.pnlUSD);
const cleanClosed = sum(closed.filter(t => !suspectIds.has(t.id)), t => t.pnlUSD);
const cleanOpen = sum(open.filter(t => !suspectIds.has(t.id)), t => t.pnlUSD);

console.log('--- contribution to reported profit ---\n');
console.log(`  closed P&L        ${usd(closedPnL).padStart(10)}`);
console.log(`  open P&L          ${usd(openPnL).padStart(10)}`);
console.log(`  TOTAL             ${usd(closedPnL + openPnL).padStart(10)}`);
console.log();
console.log(`  excluding suspects:`);
console.log(`  closed P&L        ${usd(cleanClosed).padStart(10)}`);
console.log(`  open P&L          ${usd(cleanOpen).padStart(10)}`);
console.log(`  TOTAL             ${usd(cleanClosed + cleanOpen).padStart(10)}`);
console.log();
console.log(`  >> suspect records account for ${usd((closedPnL + openPnL) - (cleanClosed + cleanOpen))} of reported profit`);

// ---------- 3. duplicate-symbol and slot-cap forced closes ----------
const forced = trades.filter(t => t.exitReason === 'EXCESS_SLOT_REBALANCED' || t.exitReason === 'DUPLICATE_ASSET_CONSOLIDATED');
if (forced.length) {
  console.log(`\n--- ${forced.length} position(s) closed by sanitizeActiveTrades, not by the market ---`);
  for (const t of forced) console.log(`  ${t.symbol}  ${t.exitReason}  pnl ${usd(Number(t.pnlUSD) || 0)}`);
}

// ---------- 4. fee coverage ----------
const noFee = trades.filter(t => !(Number(t.totalFeesUSD) > 0));
if (noFee.length) {
  console.log(`\n--- ${noFee.length} trade(s) carry no recorded fee ---`);
  console.log('  These predate config/costs.ts. Their P&L is gross, so reported');
  console.log('  profit is overstated by roughly 30bps of notional per trade.');
}
