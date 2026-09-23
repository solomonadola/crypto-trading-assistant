// Metric accuracy test. Runs the app's REAL metric code against a fixture
// whose every correct answer was computed by hand, and fails on any mismatch.
//
//   node tools/test-metrics.mjs
//
// Convention under test (see src/services/metrics.ts):
//   pnlUSD         GROSS P&L of the trade (banked harvests + open/closing leg)
//   totalFeesUSD   ALL friction incurred so far (entry + each fill + exit)
//   net            pnlUSD - totalFeesUSD
// Every displayed statistic is computed on net, with one breakeven band.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

// Bundle the real services, stubbing only the Firebase-bound feed module.
const stubPlugin = {
  name: 'stub-firebase',
  setup(b) {
    b.onResolve({ filter: /automatedFeedService$/ }, () => ({ path: 'feed', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export async function fetchAutomatedTrades(){return []} export async function executeSimulatedTrade(){return {ok:true}}',
      loader: 'ts',
    }));
  },
};
const entry = `
  export { calculateBankrollState, calculateStrategyVerification } from './src/services/bankrollService';
  export { evaluateTradeCycle } from './src/services/cycleEngineService';
  export * as metrics from './src/services/metrics';
`;
const out = await esbuild.build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  plugins: [stubPlugin],
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { calculateBankrollState, calculateStrategyVerification, evaluateTradeCycle, metrics } = mod;

// ---------- fixture ----------
const T0 = Date.UTC(2026, 8, 1);
const closed = (id, pnl, fees, hour) => ({
  id, symbol: id, coinId: id, coinName: id, status: 'STOPPED', direction: 'LONG',
  entryPrice: 1, currentPrice: 1, positionSizeUSD: 10,
  pnlUSD: pnl, totalFeesUSD: fees, realizedCashBankedUSD: 0,
  openedAtTimestamp: T0 + hour * 3600e3 - 1800e3, closedAtTimestamp: T0 + hour * 3600e3,
});
const fixture = [
  closed('A', +1.00, 0.03, 1),   // net +0.97  WIN
  closed('B', +0.50, 0.03, 2),   // net +0.47  WIN
  closed('C', -0.40, 0.03, 3),   // net -0.43  LOSS
  closed('D', -0.30, 0.03, 4),   // net -0.33  LOSS
  closed('E', +0.02, 0.04, 5),   // net -0.02  LOSS  (a gross "win" that lost money)
  { id: 'F', symbol: 'F', coinId: 'F', coinName: 'F', status: 'OPEN', direction: 'LONG',
    entryPrice: 1, currentPrice: 1.015, positionSizeUSD: 10,
    pnlUSD: 0.35, realizedCashBankedUSD: 0.20, totalFeesUSD: 0.02,   // net so far +0.33
    openedAtTimestamp: T0 + 6 * 3600e3 },
];

// Hand-computed truth. Derivations in comments.
const expect = {
  winRatePct: 40.0,          // 2 wins / 5 closed
  winCount: 2, lossCount: 3, breakevenCount: 0,
  avgWinUSD: 0.72,           // (0.97 + 0.47) / 2
  avgLossUSD: 0.26,          // (0.43 + 0.33 + 0.02) / 3
  payoffRatio: 2.77,         // 0.72 / 0.26
  profitFactor: 1.85,        // 1.44 / 0.78
  expectancyUSD: 0.13,       // 0.66 / 5
  maxDrawdownPct: 0.8,       // peak +1.44 -> +0.66 = 0.78 on a 101.44 peak = 0.77%, 1dp
  totalFeesPaidUSD: 0.18,    // 4 x 0.03 + 0.04 + 0.02
  realizedProfitUSD: 0.84,   // gross closed 0.82 + banked on open 0.20 - fees 0.18
  unrealizedPnLUSD: 0.15,    // open pnl 0.35 - its banked 0.20
  totalPortfolioValueUSD: 100.99,   // 100 + 0.84 + 0.15  (= 100 + closed net 0.66 + open net 0.33)
};

let failures = 0;
const check = (label, got, want, tol = 0.011) => {
  const ok = got === want || (typeof want === 'number' && Math.abs(got - want) <= tol);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(26)} got ${String(got).padStart(8)}   expected ${want}`);
};

console.log('\n1. Strategy verification (header, scorecard, bankroll, metrics views)');
const v = calculateStrategyVerification(fixture);
for (const k of ['winRatePct', 'winCount', 'lossCount', 'breakevenCount', 'avgWinUSD', 'avgLossUSD',
                 'payoffRatio', 'profitFactor', 'expectancyUSD', 'maxDrawdownPct']) {
  check(k, v[k], expect[k], k === 'maxDrawdownPct' ? 0.051 : 0.011);
}

console.log('\n2. Bankroll state (portfolio value, cash, P&L)');
const b = calculateBankrollState(fixture);
for (const k of ['totalFeesPaidUSD', 'realizedProfitUSD', 'unrealizedPnLUSD', 'totalPortfolioValueUSD']) {
  check(k, b[k], expect[k]);
}

console.log('\n3. Ratios with no losses must not report a dollar amount');
const allWins = [closed('W1', 3.0, 0.03, 1), closed('W2', 1.0, 0.03, 2)];
const vw = calculateStrategyVerification(allWins);
check('profitFactor (no losses)', vw.profitFactor, Infinity, 0);
check('payoffRatio (no losses)', vw.payoffRatio, Infinity, 0);

console.log('\n4. Cycle engine: pnlUSD gross, costs only in totalFeesUSD (no double count)');
const live = {
  id: 'G', symbol: 'G', coinId: 'G', coinName: 'G', status: 'OPEN', direction: 'LONG',
  entryPrice: 100, currentPrice: 100, positionSizeUSD: 10, totalFeesUSD: 0.015,
  realizedCashBankedUSD: 0, pnlUSD: 0, stopLossPrice: 96, stopLossPct: -4,
  sessionHighPrice: 100, sessionLowPrice: 100, openedAtTimestamp: T0,
  harvestTiers: {
    tier1: { percent: 33, targetPct: 4, targetPrice: 104, status: 'PENDING' },
    tier2: { percent: 33, targetPct: 8, targetPrice: 108, status: 'PENDING' },
    tier3: { percent: 34, targetPct: 14, targetPrice: 114, status: 'PENDING' },
  },
  ratchet: { isArmed: false, triggerPct: 4, floorPrice: 100.4, currentProtection: 'INITIAL_DEFENSE', floorBufferPct: 0.4 },
};
const s1 = evaluateTradeCycle(live, 104).trade;          // T1 harvest at exactly +4%
const s2 = evaluateTradeCycle(s1, 100.3).trade;          // falls through 100.4 floor -> ratchet exit
// gross: banked 10*0.33*0.04 = 0.132 ; closing leg 10*0.67*0.003 = 0.0201 ; total 0.152
// fees : entry 0.015 + t1 10*0.33*0.0015 = 0.00495 + exit 10*0.67*0.0015 = 0.01005 ; total 0.030
check('status', s2.status, 'STOPPED');
check('pnlUSD is gross', s2.pnlUSD, 0.15, 0.004);
check('totalFeesUSD', s2.totalFeesUSD, 0.03, 0.002);
check('net = pnl - fees', +(metrics.netPnlUSD(s2)).toFixed(2), 0.12, 0.004);

console.log(`\n${failures === 0 ? 'ALL METRICS CORRECT' : failures + ' METRIC(S) WRONG'}`);
process.exit(failures ? 1 : 0);
