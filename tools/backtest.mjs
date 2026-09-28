// Backtests the auto-pilot on the Binance 5-minute candles already on disk,
// using the app's own scanner, entry decision, sizing and exit ladder
// (src/backtest/runBacktest.ts). Results go to data/backtests/, where the
// Backtest Lab tab reads them.
//
//   node tools/backtest.mjs [--from 2024-09-01] [--to 2026-09-01]
//                           [--profile ASYMMETRIC_SNIPER|DYNAMIC_SCALP]
//                           [--shorts] [--capital 100] [--dir data/klines2024,data/klines]
//                           [--symbols BTC,ETH,SOL] [--gates off] [--out file.json]
//                           [--no-stale | --stale-hours 6]   (what-if on the stale-trade recycle)
//
//   node tools/backtest.mjs --strategy trend-pullback [--from ..] [--to ..] [--capital 100]
//                           [--risk 1] [--no-btc] [--no-trend] [--no-zone] [--min-volume 50] [--dir data/klines-wide]
//                           [--btc-rising] [--breadth] [--rel-strength] [--loss-pause] [--bos] [--target-prior-high]
//                           [--ltf-break] [--shorts] [--inducement] [--ltf-trail] [--key-level]
//                           [--zone-tf 60 --trigger-tf 15 --max-hold 18]   (timeframes in minutes; 4h is always the trend)
//                           [--cost 0.07 --meme-cost 0.12]   (percent per side; default 0.15 / 0.25, Binance spot taker)
//       (1h turn confirmation; mirrored short side; inducement check; 1h trailing exit)
//       Supply & Demand Trend Pullback (src/strategies/trendPullbackDemand.ts). The --no-* flags
//       switch one rule off, to measure what it adds.
//                           [--progress-json]
//
// Default range starts 2024-09-01 so every coin has the 220 daily candles the
// live analysis asks for (the history starts 2024-01).
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadCandles } from './lib/load-candles.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);

const DIRS = arg('dir', existsSync('data/klines-wide') ? 'data/klines-wide' : 'data/klines2024,data/klines').split(',').map((d) => d.trim()).filter((d) => existsSync(d));
const DIR = DIRS.join(', ');
const FROM = Date.parse(arg('from', '2024-09-01') + 'T00:00:00Z');
const TO = Date.parse(arg('to', '2026-09-01') + 'T00:00:00Z');
const PROFILE = arg('profile', 'ASYMMETRIC_SNIPER');
const SHORTS = flag('shorts');
const CAPITAL = Number(arg('capital', '100'));
const ONLY = arg('symbols', '') ? new Set(arg('symbols').split(',').map((s) => s.trim().toUpperCase())) : null;
const PROGRESS_JSON = flag('progress-json');
const STRATEGY = arg('strategy', 'live');
if (!['live', 'trend-pullback'].includes(STRATEGY)) { console.error('--strategy must be live or trend-pullback'); process.exit(2); }
const TP_CONFIG = {
  ...(flag('no-btc') ? { btcSmaDays: 0 } : {}),
  ...(flag('no-trend') ? { requireTrend: false } : {}),
  ...(flag('no-zone') ? { requireZone: false } : {}),
  ...(arg('min-volume', '') ? { minQuoteVolume24hUSD: Number(arg('min-volume')) * 1e6 } : {}),
  ...(flag('btc-rising') ? { btcSmaRisingDays: 10 } : {}),
  ...(flag('breadth') ? { minBreadthPct: 50 } : {}),
  ...(flag('rel-strength') ? { requireRelativeStrength: true } : {}),
  ...(flag('loss-pause') ? { lossStreakLimit: 3 } : {}),
  ...(flag('bos') ? { requireBreakOfStructure: true } : {}),
  ...(flag('target-prior-high') ? { targetMode: 'priorHigh' } : {}),
  ...(flag('key-level') ? { targetMode: 'keyLevel' } : {}),
  ...(flag('ltf-break') ? { requireLtfBreak: true } : {}),
  ...(flag('inducement') ? { requireInducementSwept: true } : {}),
  ...(flag('ltf-trail') ? { exitMode: 'ltfTrail' } : {}),
  ...(arg('zone-tf', '') ? { zoneTfMinutes: Number(arg('zone-tf')) } : {}),
  ...(arg('trigger-tf', '') ? { triggerTfMinutes: Number(arg('trigger-tf')) } : {}),
  ...(arg('max-hold', '') ? { maxHoldHours: Number(arg('max-hold')) } : {}),
};
for (const [k, v] of [['zone-tf', TP_CONFIG.zoneTfMinutes], ['trigger-tf', TP_CONFIG.triggerTfMinutes]]) {
  if (v !== undefined && ![5, 15, 60, 240].includes(v)) { console.error(`--${k} must be 5, 15, 60 or 240 (minutes)`); process.exit(2); }
}
const TP_VARIANT = [flag('no-btc') && 'no BTC filter', flag('no-trend') && 'no trend filter', flag('no-zone') && 'EMA pullback, no zone', arg('min-volume', '') && `$${arg('min-volume')}M volume floor`,
  flag('btc-rising') && 'BTC average rising', flag('breadth') && 'breadth 50%+', flag('rel-strength') && 'beats BTC',
  flag('loss-pause') && '3-loss pause', flag('bos') && 'BOS zones', flag('target-prior-high') && 'exit at prior swing', flag('key-level') && 'exit at key level', flag('ltf-break') && '1h turn verified', flag('inducement') && 'inducement check', flag('ltf-trail') && '1h trailing exit', arg('zone-tf', '') && `${arg('zone-tf')}m zones / ${arg('trigger-tf', '60')}m entry`, arg('cost', '') && `${arg('cost')}% cost per side`, SHORTS && 'longs + shorts'].filter(Boolean).join(', ') || undefined;
const RISK = Number(arg('risk', '1'));
const STALE = flag('no-stale') ? false : arg('stale-hours', '') ? { hours: Number(arg('stale-hours')) } : undefined;
if (arg('gates', '') === 'off') process.env.ENTRY_GATES = 'off';
if (!(FROM < TO)) { console.error('--from must be before --to'); process.exit(2); }
if (!(CAPITAL > 0)) { console.error('--capital must be positive'); process.exit(2); }

const log = (msg) => { if (PROGRESS_JSON) process.stdout.write(JSON.stringify({ type: 'log', message: msg }) + '\n'); else console.log(msg); };

// ---------------------------------------------------------------- environment
// The simulated clock. The regime gates, loss-streak breaker, monthly cap and
// stale-trade rule all read Date.now() / new Date(); they must read the bar's
// time, not today's.
const RealDate = Date;
let simNow = RealDate.now();
class SimDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(simNow); else super(...a); }
  static now() { return simNow; }
}
const wallClock = () => RealDate.now();

// Settings the app keeps in localStorage, kept in memory for the run.
const store = new Map([['crypto_scalp_strategy_profile', PROFILE], ['crypto_scalp_autopilot_shorts', String(SHORTS)]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
// Nothing in a backtest may reach the network.
globalThis.fetch = async () => { throw new Error('network disabled in backtest'); };

// ---------------------------------------------------------------- bundle
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');
// Every name the app imports from firebase/firestore, as a no-op. Read from the
// sources so a new import cannot break the backtest.
const firestoreNames = new Set();
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) {
      for (const m of readFileSync(p, 'utf8').matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'firebase\/firestore'/g)) {
        for (const n of m[1].split(',')) { const name = n.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''); if (name) firestoreNames.add(name); }
      }
    }
  }
};
walk('src');
const FIRESTORE_STUB = `
  const stub = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : stub), apply: () => stub, construct: () => stub });
  ${[...firestoreNames].map((n) => `export const ${n} = stub;`).join('\n  ')}
`;
const built = await esbuild.build({
  stdin: {
    contents: "export { runBacktest } from './src/backtest/runBacktest'; export { runStrategyBacktest } from './src/backtest/runStrategyBacktest'; export { STRATEGY_PROFILES } from './src/config/geometry';",
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  define: { 'import.meta.env.VITE_FIRESTORE_WRITES': '"off"' },
  plugins: [{
    name: 'no-firebase',
    setup(b) {
      b.onResolve({ filter: /^firebase\/(app|firestore)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
        contents: a.path === 'firebase/app'
          ? 'export const initializeApp = () => ({}); export const getApps = () => [];'
          : FIRESTORE_STUB,
        loader: 'js',
      }));
    },
  }],
});
globalThis.Date = SimDate;
const { runBacktest, runStrategyBacktest, STRATEGY_PROFILES } = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
if (!(PROFILE in STRATEGY_PROFILES)) {
  console.error(`--profile must be one of ${Object.keys(STRATEGY_PROFILES).join(', ')}`);
  process.exit(2);
}

// ---------------------------------------------------------------- candles
// 230 days before --from, for the daily analysis; nothing after --to is read.

if (!DIRS.length) {
  console.error(`No candles in ${arg('dir', 'data/klines2024,data/klines')}. Download them with: node tools/fetch-klines.mjs`);
  process.exit(2);
}
const loadStarted = wallClock();
const series = loadCandles({ dirs: DIRS, from: FROM, to: TO, only: ONLY });
log(`Loaded ${series.length} coins of 5m candles from ${DIR} in ${((wallClock() - loadStarted) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- run
const profileName = STRATEGY === 'trend-pullback'
  ? `Supply & Demand Trend Pullback${TP_VARIANT ? ` (${TP_VARIANT})` : ''}`
  : STRATEGY_PROFILES[PROFILE].name;
log(`Backtesting ${profileName}, ${SHORTS ? 'longs and shorts' : 'longs only'}, $${CAPITAL} from ${arg('from', '2024-09-01')} to ${arg('to', '2026-09-01')}`);
const onProgress = ({ t, fraction, trades, equityUSD }) => {
  if (PROGRESS_JSON) {
    process.stdout.write(JSON.stringify({ type: 'progress', fraction, t, trades, equityUSD }) + '\n');
  } else {
    process.stdout.write(`  ${new RealDate(t).toISOString().slice(0, 10)}  ${(fraction * 100).toFixed(0).padStart(3)}%  trades ${String(trades).padStart(4)}  equity $${equityUSD.toFixed(2)}   \r`);
  }
};
const result = STRATEGY === 'trend-pullback' ? runStrategyBacktest(series, {
  from: FROM, to: TO, startingCapitalUSD: CAPITAL, dataSource: `${DIR} (5m)`,
  config: TP_CONFIG, variant: TP_VARIANT, riskPerTradePct: RISK, allowShorts: SHORTS, onProgress,
  ...(arg('cost', '') ? { costPerSidePct: Number(arg('cost')), memeCostPerSidePct: Number(arg('meme-cost', String(Number(arg('cost')) + 0.05))) } : {}),
}) : runBacktest(series, {
  from: FROM, to: TO, profile: PROFILE, allowShorts: SHORTS, startingCapitalUSD: CAPITAL,
  dataSource: `${DIR} (5m)`,
  staleRecycle: STALE,
  setClock: (ms) => { simNow = ms; },
  onProgress,
});
result.createdAt = wallClock();
result.durationMs = wallClock() - loadStarted;
result.id = STRATEGY === 'trend-pullback'
  ? `trend_pullback${flag('no-btc') ? '-nobtc' : ''}${flag('no-trend') ? '-notrend' : ''}${flag('no-zone') ? '-nozone' : ''}${arg('min-volume', '') ? `-vol${arg('min-volume')}m` : ''}${['btc-rising', 'breadth', 'rel-strength', 'loss-pause', 'bos', 'target-prior-high', 'key-level', 'ltf-break', 'inducement', 'ltf-trail', 'shorts'].filter(flag).map((f) => `-${f}`).join('')}${arg('zone-tf', '') ? `-z${arg('zone-tf')}t${arg('trigger-tf', '60')}` : ''}${arg('cost', '') ? `-cost${arg('cost')}` : ''}${RISK !== 1 ? `-risk${RISK}` : ''}-${arg('from', '2024-09-01')}-${arg('to', '2026-09-01')}-${new RealDate(result.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '')}`
  : `${PROFILE.toLowerCase()}-${SHORTS ? 'ls' : 'long'}${STALE === false ? '-nostale' : STALE ? `-stale${STALE.hours}h` : ''}-${arg('from', '2024-09-01')}-${arg('to', '2026-09-01')}-${new RealDate(result.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '')}`;

mkdirSync('data/backtests', { recursive: true });
const OUT = arg('out', `data/backtests/${result.id}.json`);
writeFileSync(OUT, JSON.stringify(result));

const s = result.summary;
if (PROGRESS_JSON) {
  process.stdout.write(JSON.stringify({ type: 'done', id: result.id, file: OUT, summary: s }) + '\n');
} else {
  const pct = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  console.log('\n');
  console.log(`${profileName}  |  ${result.settings.symbols.length} coins  |  ${new RealDate(result.settings.from).toISOString().slice(0, 10)} .. ${new RealDate(result.settings.to).toISOString().slice(0, 10)}`);
  console.log(`  trades            ${s.trades}  (${s.tradesPerMonth}/month, avg hold ${s.avgHoldHours}h)`);
  console.log(`  win rate          ${s.winRatePct}%   (${s.wins} W / ${s.losses} L / ${s.breakeven} BE)`);
  console.log(`  net profit        $${s.netProfitUSD}  (${pct(s.totalReturnPct)} on $${CAPITAL}), fees $${s.feesUSD}`);
  console.log(`  profit factor     ${s.profitFactor ?? 'inf'}    expectancy $${s.expectancyUSD}/trade   avg ${s.avgR}R`);
  console.log(`  max drawdown      ${s.maxDrawdownPct}%  ($${s.maxDrawdownUSD})`);
  console.log(`  buy & hold        basket ${pct(s.benchmarkReturnPct)}, BTC ${pct(s.btcReturnPct)}`);
  console.log('\n  by month:');
  for (const m of result.monthly) console.log(`    ${m.key}  ${String(m.trades).padStart(4)} trades  net $${m.netUSD.toFixed(2).padStart(8)}  ${m.returnPct !== undefined ? pct(m.returnPct) : ''}`);
  console.log('\n  exits:');
  for (const r of result.byExitReason) console.log(`    ${r.key.padEnd(24)} ${String(r.trades).padStart(4)}  net $${r.netUSD.toFixed(2)}`);
  console.log('\n  why no deploy (5m steps):');
  for (const r of result.skipReasons.slice(0, 8)) console.log(`    ${String(r.steps).padStart(7)}  ${r.reason.slice(0, 110)}`);
  console.log(`\nwrote ${OUT}  (${(result.durationMs / 1000).toFixed(0)}s)`);
}
