// Invariants of the backtest (src/backtest/runBacktest.ts via tools/backtest.mjs),
// checked on a short real run: the books balance, the position limits hold,
// nothing is dated before it could have happened, and every trade pays costs.
//
//   node tools/test-backtest.mjs [--from 2025-03-01 --to 2025-03-15]
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const out = join(mkdtempSync(join(tmpdir(), 'cs-bt-')), 'run.json');
const run = spawnSync(process.execPath, ['tools/backtest.mjs', '--from', arg('from', '2025-03-01'), '--to', arg('to', '2025-03-15'), '--out', out],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) {
  console.log((run.stderr || run.stdout).replace(/data:text\/javascript;base64,[\w+/=]+/g, '<bundle>').slice(-2000));
  console.log('BACKTEST DID NOT RUN');
  process.exit(1);
}
const r = JSON.parse(readFileSync(out, 'utf8'));

let fails = 0;
const check = (label, ok, detail = '') => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); };
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
const s = r.summary;
const trades = r.trades;

console.log(`\n${trades.length} trades, ${r.settings.symbols.length} coins, ${new Date(r.settings.from).toISOString().slice(0, 10)} .. ${new Date(r.settings.to).toISOString().slice(0, 10)}`);
check('it traded at all', trades.length > 0);

console.log('\n1. The books balance');
const net = trades.reduce((a, t) => a + t.netUSD, 0);
check('net profit = sum of trade nets', near(s.netProfitUSD, net), `${s.netProfitUSD} vs ${net.toFixed(2)}`);
check('ending equity = capital + net profit', near(s.endingEquityUSD, r.settings.startingCapitalUSD + s.netProfitUSD), `${s.endingEquityUSD}`);
check('trade net = gross - fees', trades.every((t) => near(t.netUSD, t.pnlUSD - t.feesUSD, 0.011)));
check('wins + losses + breakeven = trades', s.wins + s.losses + s.breakeven === s.trades);

console.log('\n2. The limits hold at every moment');
const events = trades.flatMap((t) => [[t.openedAt, 1, t], [t.closedAt, -1, t]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
let open = 0, maxOpen = 0, coinTwice = false;
const held = new Set();
for (const [, d, t] of events) {
  if (d === 1) { if (held.has(t.symbol)) coinTwice = true; held.add(t.symbol); open++; maxOpen = Math.max(maxOpen, open); }
  else { held.delete(t.symbol); open--; }
}
check(`never more than ${r.settings.maxConcurrentTrades} open`, maxOpen <= r.settings.maxConcurrentTrades, `max ${maxOpen}`);
check('never two positions in one coin', !coinTwice);
check('equity points agree on open count', r.equity.every((p) => p.openPositions <= r.settings.maxConcurrentTrades));
const opens = trades.map((t) => t.openedAt).sort((a, b) => a - b);
const minGap = Math.min(...opens.slice(1).map((t, i) => t - opens[i]));
check('deploys at least minMsBetweenDeploys apart', trades.length < 2 || minGap >= 180_000, `${minGap / 60000} min`);
check('longs only unless asked', r.settings.allowShorts || trades.every((t) => t.direction === 'LONG'));

console.log('\n3. Time runs forward');
check('every trade opens inside the range', trades.every((t) => t.openedAt >= r.settings.from && t.openedAt <= r.settings.to));
check('every trade closes after it opens', trades.every((t) => t.closedAt >= t.openedAt));
check('decisions on 5-minute closes', trades.every((t) => t.openedAt % 300_000 === 0));
check('equity points hourly and in order', r.equity.every((p, i) => p.t % 3_600_000 === 0 && (i === 0 || p.t > r.equity[i - 1].t)));

console.log('\n4. Costs are paid');
const side = r.settings.costPerSidePct / 100;
check('every trade pays at least a round trip', trades.every((t) => t.feesUSD >= t.positionSizeUSD * side * 2 - 0.0002),
  trades.filter((t) => t.feesUSD < t.positionSizeUSD * side * 2 - 0.0002).map((t) => `${t.symbol} ${t.feesUSD}`).slice(0, 3).join(', '));
check('fees in summary = sum of trade fees', near(s.feesUSD, trades.reduce((a, t) => a + t.feesUSD, 0)));

console.log(`\n${fails === 0 ? 'ALL BACKTEST CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
