// Tunes Supply & Demand Trend Pullback without fooling itself.
//
// Every combination of the regime and setup-quality rules is run on the TRAIN
// period only. The best few (by profit factor, with enough trades to mean
// anything) are then run once on the TEST period, which played no part in
// choosing them. Only a result that holds on TEST is worth trading.
//
//   node tools/tune-strategy.mjs [--train 2024-09-01:2025-09-01] [--test 2025-09-01:2026-09-01]
//                                [--min-trades 30] [--top 5] [--dir data/klines-wide]
//
// The chosen configurations are written as ordinary backtest results over the
// whole span (data/backtests/), so the Backtest Lab shows them.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadCandles } from './lib/load-candles.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const span = (s) => s.split(':').map((d) => Date.parse(d + 'T00:00:00Z'));
const [trainFrom, trainTo] = span(arg('train', '2024-09-01:2025-09-01'));
const [testFrom, testTo] = span(arg('test', '2025-09-01:2026-09-01'));
const MIN_TRADES = Number(arg('min-trades', '30'));
const TOP = Number(arg('top', '5'));
const DIRS = arg('dir', existsSync('data/klines-wide') ? 'data/klines-wide' : 'data/klines2024,data/klines').split(',');

const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');
const built = await esbuild.build({
  stdin: { contents: "export { runStrategyBacktest } from './src/backtest/runStrategyBacktest';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
});
const { runStrategyBacktest } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const t0 = Date.now();
const series = loadCandles({ dirs: DIRS, from: Math.min(trainFrom, testFrom), to: Math.max(trainTo, testTo) });
console.log(`Loaded ${series.length} coins in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// The rules being tuned: each on or off.
const KNOBS = [
  ['btcRising', { btcSmaRisingDays: 10 }, 'BTC average rising'],
  ['breadth', { minBreadthPct: 50 }, 'breadth 50%+'],
  ['relStrength', { requireRelativeStrength: true }, 'beats BTC'],
  ['streak', { lossStreakLimit: 3 }, '3-loss pause'],
  ['bos', { requireBreakOfStructure: true }, 'BOS zones'],
  ['priorHigh', { targetMode: 'priorHigh' }, 'target prior high'],
];
const combos = [];
for (let mask = 0; mask < 1 << KNOBS.length; mask++) {
  const on = KNOBS.filter((_, i) => mask & (1 << i));
  combos.push({ name: on.map((k) => k[2]).join(' + ') || 'baseline', config: Object.assign({}, ...on.map((k) => k[1])) });
}

const run = (config, from, to, variant) => runStrategyBacktest(series, { from, to, startingCapitalUSD: 100, dataSource: `${DIRS.join(', ')} (5m)`, config, variant });
const row = (r) => ({ trades: r.summary.trades, win: r.summary.winRatePct, ret: r.summary.totalReturnPct, pf: r.summary.profitFactor ?? 99, dd: r.summary.maxDrawdownPct });
const fmt = (x) => `${String(x.trades).padStart(4)} tr  ${x.win.toFixed(1).padStart(5)}% win  ${(x.ret >= 0 ? '+' : '') + x.ret.toFixed(1)}%`.padEnd(34) + `PF ${x.pf.toFixed(2).padStart(5)}  DD ${x.dd.toFixed(1)}%`;

console.log(`\nTRAIN ${new Date(trainFrom).toISOString().slice(0, 10)} .. ${new Date(trainTo).toISOString().slice(0, 10)}: ${combos.length} combinations`);
const results = combos.map((c, i) => {
  const r = row(run(c.config, trainFrom, trainTo));
  process.stdout.write(`  ${String(i + 1).padStart(2)}/${combos.length}  ${fmt(r)}  ${c.name}\n`);
  return { ...c, train: r };
});

const eligible = results.filter((r) => r.train.trades >= MIN_TRADES).sort((a, b) => b.train.pf - a.train.pf);
const picked = eligible.slice(0, TOP);
const baseline = results.find((r) => r.name === 'baseline');
if (!picked.includes(baseline)) picked.push(baseline);

console.log(`\nTEST ${new Date(testFrom).toISOString().slice(0, 10)} .. ${new Date(testTo).toISOString().slice(0, 10)}: the top ${TOP} on TRAIN (${MIN_TRADES}+ trades), and the baseline`);
for (const p of picked) {
  p.test = row(run(p.config, testFrom, testTo));
  console.log(`  ${p.name}\n     train ${fmt(p.train)}\n     test  ${fmt(p.test)}`);
}

// Full-span results for the Backtest Lab; the whole table goes to data/tuning/.
mkdirSync('data/backtests', { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
for (const p of picked) {
  const r = run(p.config, trainFrom, testTo, `tuned: ${p.name}`);
  r.createdAt = Date.now();
  r.id = `trend_pullback-tuned-${p.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}-${stamp}`;
  r.limitations.unshift(`Tuned: chosen on ${new Date(trainFrom).toISOString().slice(0, 10)} to ${new Date(trainTo).toISOString().slice(0, 10)}; only the part after that is out of sample.`);
  writeFileSync(`data/backtests/${r.id}.json`, JSON.stringify(r));
}
mkdirSync('data/tuning', { recursive: true });
writeFileSync(`data/tuning/tuning-${stamp}.json`, JSON.stringify({ trainFrom, trainTo, testFrom, testTo, results, picked }, null, 1));
console.log(`\nwrote ${picked.length} runs to data/backtests/ and the full table to data/tuning/tuning-${stamp}.json  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
