// npm run backtest -- [--db data/backtest/futures.db] [--from 2025-09-01] [--split 2026-05-01] [--to 2026-09-01]
//                     [--variants current,stop_setup,fixed_target,ladder_only] [--min-train-trades 40] [--out name]
//
// Stage A: a research replay per exit variant. Stage B: the settings search on
// each. Results go to data/backtest/results/<time>.json, which the dashboard's
// Backtest page reads.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, type EngineConfig } from '../config';
import { runResearch, type ResearchTrade } from './research';
import { search, type SearchResult } from './optimize';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
const DB = arg('db', 'data/backtest/futures.db');
const FROM = day(arg('from', '2025-09-01'));
const SPLIT = day(arg('split', '2026-05-01'));
const TO = day(arg('to', '2026-09-01'));
const MIN_TRAIN = Number(arg('min-train-trades', '40'));

/** Exit variants: each needs its own replay, because exits change every trade's outcome. */
const VARIANTS: Record<string, { label: string; patch: (c: EngineConfig) => void }> = {
  current: { label: 'As configured (stop beyond 15m swing, half at first target, ladder)', patch: () => {} },
  stop_setup: { label: 'Stop beyond the setup (zone / pullback extreme, 1h ATR buffer)', patch: (c) => { c.exits.stop_anchor = 'setup'; } },
  fixed_target: { label: 'All out at the first target', patch: (c) => { c.exits.mode = 'fixed'; } },
  ladder_only: { label: 'No fixed target, profit ladder only', patch: (c) => { c.exits.mode = 'ladder'; } },
};

const wanted = arg('variants', Object.keys(VARIANTS).join(',')).split(',');
const results: { variant: string; label: string; research: { trades: number; confirmed: number; seconds: number; symbols: string[] }; search: SearchResult; trades: ResearchTrade[] }[] = [];
const base = loadConfig();
// 5-minute data (the local spot import): the engine's exits run on 5m candles.
{
  const Database = (await import('better-sqlite3')).default;
  const meta = new Database(DB, { readonly: true });
  const source = (meta.prepare("SELECT value FROM meta WHERE key = 'source'").get() as { value: string } | undefined)?.value ?? '';
  meta.close();
  if (source.includes('5m')) {
    base.timeframes.exits = '5m';
    base.feed.timeframes = ['5m', '15m', '1h', '4h'];
    base.feed.history['5m'] = 300;
    console.log(`Data: ${source}. Exits run on 5m candles.`);
  }
}
for (const v of wanted) {
  const def = VARIANTS[v];
  if (!def) throw new Error(`unknown variant ${v}; known: ${Object.keys(VARIANTS).join(', ')}`);
  const config = structuredClone(base);
  def.patch(config);
  console.log(`\n[${v}] ${def.label}: replaying ${new Date(FROM).toISOString().slice(0, 10)} to ${new Date(TO).toISOString().slice(0, 10)}...`);
  const run = runResearch({
    dbPath: DB, config, label: v, from: FROM, to: TO,
    onProgress: (t, n) => { if (new Date(t).getUTCDate() === 1) console.log(`  ${new Date(t).toISOString().slice(0, 10)}: ${n} research trades`); },
  });
  console.log(`  ${run.trades.length} research trades from ${run.confirmed} confirmed setups in ${run.seconds}s`);
  const s = search(run.trades, config, FROM, SPLIT, TO, MIN_TRAIN);
  const fmt = (m: { trades: number; netUsd: number; profitFactor: number | null; winRate: number; maxDrawdownUsd: number }) =>
    `${String(m.trades).padStart(4)} trades  net ${m.netUsd >= 0 ? '+' : ''}${m.netUsd.toFixed(0).padStart(5)}  PF ${(m.profitFactor ?? Infinity).toFixed(2).padStart(5)}  win ${(m.winRate * 100).toFixed(0).padStart(3)}%  maxDD ${m.maxDrawdownUsd.toFixed(0)}`;
  console.log(`  as configured   tune: ${fmt(s.configured.train)} | test: ${fmt(s.configured.test)}`);
  for (const b of s.best.slice(0, 5)) {
    console.log(`  rr>=${b.settings.minRr} stop<=${b.settings.maxStopPct}% score>=${b.settings.minScore} rvol ${b.settings.fakeoutRvol ?? 'off'} off:[${b.settings.filtersOff.map((f) => f.replace('filter_', '')).join(',')}]`);
    console.log(`                  tune: ${fmt(b.train)} | test: ${fmt(b.test)}`);
  }
  results.push({ variant: v, label: def.label, research: { trades: run.trades.length, confirmed: run.confirmed, seconds: run.seconds, symbols: run.symbols }, search: s, trades: run.trades });
}

const dir = path.join(path.dirname(DB), 'results');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${arg('out', new Date().toISOString().replace(/[:.]/g, '-'))}.json`);
writeFileSync(file, JSON.stringify({ createdAt: Date.now(), db: DB, from: FROM, split: SPLIT, to: TO, minTrainTrades: MIN_TRAIN, results }, null, 1));
console.log(`\nSaved ${file}`);
