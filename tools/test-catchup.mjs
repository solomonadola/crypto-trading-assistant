// Tests the while-away catch-up replay (src/services/catchUpService.ts)
// against hand-worked candle paths.
//
//   node tools/test-catchup.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

const out = await esbuild.build({
  stdin: { contents: "export * from './src/services/catchUpService';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  plugins: [{
    name: 'stub-firebase',
    setup(b) {
      b.onResolve({ filter: /automatedFeedService$/ }, () => ({ path: 'feed', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export async function fetchAutomatedTrades(){return []} export async function executeSimulatedTrade(){return {ok:true}}',
        loader: 'ts',
      }));
    },
  }],
});
const { replayBars, chooseInterval } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

const T0 = Date.UTC(2026, 8, 20, 0, 0);
const M = 60_000;
const trade = (dir = 'LONG') => {
  const s = dir === 'SHORT' ? -1 : 1;
  const px = (pct) => +(100 * (1 + s * pct / 100)).toFixed(4);
  return {
    id: 'X', symbol: 'X', coinId: 'X', coinName: 'X', status: 'OPEN', direction: dir,
    entryPrice: 100, currentPrice: 100, positionSizeUSD: 10, totalFeesUSD: 0.015,
    realizedCashBankedUSD: 0, pnlUSD: 0, stopLossPrice: px(-4), stopLossPct: -4,
    sessionHighPrice: 100, sessionLowPrice: 100, openedAtTimestamp: T0,
    // An explicit ATR keeps the trailing stop out of these paths whatever
    // profile is active; otherwise it is inferred from tier 1 and the profile.
    atrValue: 8,
    harvestTiers: {
      tier1: { percent: 33, targetPct: 4, targetPrice: px(4), status: 'PENDING' },
      tier2: { percent: 33, targetPct: 8, targetPrice: px(8), status: 'PENDING' },
      tier3: { percent: 34, targetPct: 14, targetPrice: px(14), status: 'PENDING' },
    },
    ratchet: { isArmed: false, triggerPct: 4, floorPrice: px(0.4), currentProtection: 'INITIAL_DEFENSE', floorBufferPct: 0.4 },
  };
};
const bar = (min, o, h, l, c) => ({ t: T0 + min * M, o, h, l, c });

let fails = 0;
const check = (label, got, want, tol = 0.006) => {
  const ok = got === want || (typeof want === 'number' && typeof got === 'number' && Math.abs(got - want) <= tol);
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(44)} got ${String(got).padStart(10)}   expected ${want}`);
};

console.log('\n1. Stop crossed inside a candle fills AT the stop, not at the low');
{
  const r = replayBars(trade(), [bar(5, 100, 101, 95, 95.5)], M);
  check('status', r.trade.status, 'STOPPED');
  check('exit price', r.trade.exitPrice, 96);
  check('pnlUSD (4% of $10)', r.trade.pnlUSD, -0.40);
  check('closed at candle close', r.trade.closedAtTimestamp, T0 + 6 * M);
}

console.log('\n2. Gap: candle OPENS below the stop -> fills at the open');
{
  const r = replayBars(trade(), [bar(5, 94, 94.5, 93, 94)], M);
  check('exit price', r.trade.exitPrice, 94);
  check('pnlUSD (4% + 2% gap)', r.trade.pnlUSD, -0.60);
}

console.log('\n3. Target hit while away is banked at the target, then breakeven stop exits');
{
  const r = replayBars(trade(), [bar(5, 100, 104.8, 99.5, 104.2), bar(6, 104, 104.1, 100.1, 100.2)], M);
  check('tier 1 harvested', r.trade.harvestTiers.tier1.status, 'HARVESTED');
  check('banked at +4% not +4.8% (0.33*10*0.04)', r.trade.realizedCashBankedUSD, 0.13);
  check('closed at breakeven floor', r.trade.exitPrice, 100.4);
  check('exit reason', r.trade.exitReason, 'RATCHET_BREAKEVEN_HIT');
  check('closed during 2nd candle', r.trade.closedAtTimestamp, T0 + 7 * M);
}

console.log('\n4. Stop is tested before target in the same candle (conservative)');
{
  const r = replayBars(trade(), [bar(5, 100, 105, 95, 102)], M);
  check('stopped, not harvested', r.trade.status, 'STOPPED');
  check('tier 1 still pending', r.trade.harvestTiers.tier1.status, 'PENDING');
}

console.log('\n5. Short mirror: stop above entry');
{
  const r = replayBars(trade('SHORT'), [bar(5, 100, 105, 99, 104)], M);
  check('status', r.trade.status, 'STOPPED');
  check('exit price', r.trade.exitPrice, 104);
}

console.log('\n6. Quiet candles: trade stays open, extremes recorded');
{
  const r = replayBars(trade(), [bar(5, 100, 101.5, 98.7, 100.9), bar(6, 100.9, 102, 100.5, 101.7)], M);
  check('still open', r.trade.status, 'OPEN');
  check('session high', r.trade.sessionHighPrice, 102);
  check('session low', r.trade.sessionLowPrice, 98.7);
  check('current price = last close', r.trade.currentPrice, 101.7);
  check('closed flag', r.closed, false);
}

console.log('\n7. Candles that ended before the trade opened are ignored');
{
  const r = replayBars(trade(), [bar(-3, 100, 100, 90, 90), bar(5, 100, 100.5, 99.8, 100.1)], M);
  check('pre-open crash ignored', r.trade.status, 'OPEN');
}

console.log('\n8. Candle size scales with the gap');
check('10h -> 1m', chooseInterval(10 * 3600e3)[0], '1m');
check('2 days -> 5m', chooseInterval(2 * 86400e3)[0], '5m');
check('8 days -> 15m', chooseInterval(8 * 86400e3)[0], '15m');
check('30 days -> 1h', chooseInterval(30 * 86400e3)[0], '1h');

console.log(`\n${fails === 0 ? 'ALL CATCH-UP CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
