// The level gates decide which entries the bot may take (src/config/entry.ts,
// services/autopilotEngine.ts). They are the one filter measured to create
// edge (+54.3 bp a trade out of sample, STUDY_A_RESULTS.md addendum 3), so
// this pins how they behave - including the case where they cannot be checked.
//
//   node tools/test-entry-gates.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

async function load(gatesOff) {
  const out = await esbuild.build({
    stdin: {
      contents: "export { levelGateBlockReason, selectAutoPilotCandidate, manualDeployBlockReason } from './src/services/autopilotEngine';" +
                "export { LEVEL_GATES_ACTIVE, ENTRY_CONFIG } from './src/config/entry';",
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  });
  // entry.ts reads process.env when the module first runs, so the variable has
  // to be set before the import, not bundled in.
  if (gatesOff) process.env.ENTRY_GATES = 'off'; else delete process.env.ENTRY_GATES;
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64') + '#' + (gatesOff ? 'off' : 'on'));
}

let fails = 0;
const check = (label, ok, detail = '') => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); };

// A signal the rest of the auto-pilot would accept, so only the gate decides.
const signal = (symbol, levelGate) => ({
  symbol, direction: 'LONG', status: 'TRIGGERED', score: 95, levelGate,
  checkpoints: [{ passed: true }, { passed: true }, { passed: true }],
  timeframeConfluence: { confluenceRating: 'A+', alignedCount: 3 },
  priceChange24hPct: 5, microConfirmation: { isGreenReversal: true },
});
const passing = { passed: true, measured: true, distToSupportAtr: 0.1, distToResistanceAtr: 2.0, trend: 'BULLISH' };
const failing = { passed: false, measured: true, reason: '1.22 ATR above support (needs <= 0.25)' };
const unmeasured = { passed: true, measured: false, reason: 'No candle analysis; gates not applied' };

const bankroll = {
  totalSlots: 10, canOpenNewTrade: true, liquidCashUSD: 100, trancheSizeUSD: 10,
  deployedCapitalUSD: 0, totalPortfolioValueUSD: 100, blockReason: undefined,
};
const inputs = (signals) => ({ signals, trades: [], bankroll, pacingInfo: { isDeployingAllowed: true, state: 'ACTIVE', btcRegime: { allowNewLongs: true, allowNewShorts: true } }, now: Date.now(), lastDeployAt: 0 });

console.log('\n1. Gates on: measured and passing is allowed, measured and failing is not');
{
  const m = await load(false);
  check('the gates are in force', m.LEVEL_GATES_ACTIVE === true);
  check('at a level: allowed', m.levelGateBlockReason(signal('AAA', passing)) === null);
  const blocked = m.levelGateBlockReason(signal('BBB', failing));
  check('away from support: refused', /Not at a level/.test(blocked || ''), blocked);
  check('the refusal repeats the measurement', /1\.22 ATR above support/.test(blocked || ''), blocked);
}

console.log('\n2. Gates on: a coin whose levels could not be measured is NOT traded');
{
  // This is the case that used to slip through. The scanner marks the gate
  // "not measured" when the coin's candles did not arrive; reading that as a
  // pass meant trading it on 24h-ticker estimates, which measures about
  // -30 bp a trade.
  const m = await load(false);
  const blocked = m.levelGateBlockReason(signal('CCC', unmeasured));
  check('unmeasured: refused', /could not be measured/.test(blocked || ''), blocked);
  check('a signal with no gate at all: refused', m.levelGateBlockReason(signal('DDD', undefined)) !== null);

  const auto = m.selectAutoPilotCandidate(inputs([signal('CCC', unmeasured)]));
  check('auto-pilot takes nothing', auto.signal === null);
  check('and says why', /no candle data/.test(auto.reason || ''), auto.reason);

  const manual = m.manualDeployBlockReason(signal('CCC', unmeasured), [], bankroll);
  check('a manual deploy is refused too', /could not be measured/.test(manual || ''), manual);

  const mixed = m.selectAutoPilotCandidate(inputs([signal('CCC', unmeasured), signal('AAA', passing)]));
  check('a measurable coin is still taken', mixed.signal?.symbol === 'AAA', mixed.signal?.symbol || mixed.reason);
}

console.log('\n3. ENTRY_GATES=off: the old behaviour, including unmeasured coins');
{
  const m = await load(true);
  check('the gates are not in force', m.LEVEL_GATES_ACTIVE === false);
  check('unmeasured: allowed', m.levelGateBlockReason(signal('CCC', unmeasured)) === null);
  // A gate that was measured and failed is still a refusal: with ENTRY_GATES=off
  // the scanner does not produce one, so this only guards the ordering.
  check('measured failure still refused', m.levelGateBlockReason(signal('BBB', failing)) !== null);
}

console.log(`\n${fails === 0 ? 'ALL ENTRY-GATE CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
