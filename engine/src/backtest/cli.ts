// npm run backtest -- [--db data/backtest/futures.db] [--from 2025-09-01] [--split 2026-05-01] [--to 2026-09-01]
//                     [--variants current,stop_setup,fixed_target,ladder_only | orb_30_opposite,momentum_rv2,meanrev_bb2,...] [--min-train-trades 40] [--out name]
//
// Stage A: a research replay per exit variant. Stage B: the settings search on
// each. Results go to data/backtest/results/<time>.json, which the dashboard's
// Backtest page reads.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, type EngineConfig } from '../config';
import { runResearch, type ResearchTrade } from './research';
import { everySignal, search, type EverySignal, type SearchResult } from './optimize';
import type { SetupName } from '../portfolio';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
const DB = arg('db', 'data/backtest/futures.db');
const FROM = day(arg('from', '2025-09-01'));
const SPLIT = day(arg('split', '2026-05-01'));
const TO = day(arg('to', '2026-09-01'));
const MIN_TRAIN = Number(arg('min-train-trades', '40'));

/** Exit variants: each needs its own replay, because exits change every trade's outcome. */
/** All out at the target, and only the stop, the target or the session end close the trade. */
const holdOn = (c: EngineConfig) => {
  c.exits.mode = 'fixed';
  c.filters.fakeout.enabled = false;
  c.exits.time_stop_hours = 1_000;
  c.exits.early_exit.stagnation.candles = 1_000;
};
/**
 * Slow mode: the same rules on candles 4x longer (1h trigger, 4h zones, daily
 * bias, 15m management). Times written in hours scale with it; the session
 * rules do not (they are clock times).
 */
const slower = (c: EngineConfig) => {
  c.pullback.armed_expiry_hours *= 4;
  c.exits.time_stop_hours *= 4;
  c.risk.cooldown_after_loss_min *= 4;
  c.sim.entry_timeout_min = 20;                  // the next 15m candle fills the entry
  c.sessions.no_entry_before_end_min = 120;      // an hour-candle entry needs time before the session closes
};
type Variant = { label: string; patch: (c: EngineConfig) => void; slow?: boolean; setup?: SetupName; params?: Parameters<typeof runResearch>[0]['params'] };
const VARIANTS: Record<string, Variant> = {
  current: { label: 'As configured (stop beyond 15m swing, half at first target, ladder)', patch: () => {} },
  stop_setup: { label: 'Stop beyond the setup (zone / pullback extreme, 1h ATR buffer)', patch: (c) => { c.exits.stop_anchor = 'setup'; } },
  fixed_target: { label: 'All out at the first target', patch: (c) => { c.exits.mode = 'fixed'; } },
  ladder_only: { label: 'No fixed target, profit ladder only', patch: (c) => { c.exits.mode = 'ladder'; } },
  // Alternative entry ideas: all out at a fixed target, with the same stops-first fills, session ends and costs.
  orb_30_opposite: { label: 'Opening-range breakout: 30 min range, stop at the far side, 2R', setup: 'orb', params: { rangeMinutes: 30, stopAt: 'opposite', targetR: 2 }, patch: (c) => { c.exits.mode = 'fixed'; } },
  orb_60_opposite: { label: 'Opening-range breakout: 60 min range, stop at the far side, 2R', setup: 'orb', params: { rangeMinutes: 60, stopAt: 'opposite', targetR: 2 }, patch: (c) => { c.exits.mode = 'fixed'; } },
  orb_30_mid: { label: 'Opening-range breakout: 30 min range, stop at the middle, 2R', setup: 'orb', params: { rangeMinutes: 30, stopAt: 'mid', targetR: 2 }, patch: (c) => { c.exits.mode = 'fixed'; } },
  momentum_rv2: { label: 'Momentum: strong trend, 4h high broken on 2x volume, 2R', setup: 'momentum', params: { lookback: 16, minRvol: 2, targetR: 2 }, patch: (c) => { c.exits.mode = 'fixed'; } },
  momentum_rv15: { label: 'Momentum: strong trend, 4h high broken on 1.5x volume, 2R', setup: 'momentum', params: { lookback: 16, minRvol: 1.5, targetR: 2 }, patch: (c) => { c.exits.mode = 'fixed'; } },
  orb_30_hold: { label: 'Opening-range breakout: 30 min range, far-side stop, 2R, no early exits', setup: 'orb', params: { rangeMinutes: 30, stopAt: 'opposite', targetR: 2 }, patch: holdOn },
  momentum_rv15_hold: { label: 'Momentum: 1.5x volume, 2R, no early exits', setup: 'momentum', params: { lookback: 16, minRvol: 1.5, targetR: 2 }, patch: holdOn },
  slow_pullback: { label: 'Slow: pullback on 1h trigger, 4h zones, daily bias', slow: true, patch: slower },
  slow_pullback_fixed: { label: 'Slow: pullback, all out at the first target', slow: true, patch: (c) => { slower(c); c.exits.mode = 'fixed'; } },
  slow_pullback_hold: { label: 'Slow: pullback, held past the session close (breaks the session rule)', slow: true, patch: (c) => { slower(c); c.sessions.exit_at_session_end = false; } },
  slow_momentum: { label: 'Slow: momentum on 1h, 16h high broken on 1.5x volume, 2R', slow: true, setup: 'momentum', params: { lookback: 16, minRvol: 1.5, targetR: 2 }, patch: (c) => { slower(c); c.exits.mode = 'fixed'; } },
  slow_meanrev: { label: 'Slow: mean reversion on 1h, 2.0 band', slow: true, setup: 'meanrev', params: { bbPeriod: 20, bbStd: 2, maxAdx: 20, minR: 0.8 }, patch: (c) => { slower(c); c.exits.mode = 'fixed'; } },
  meanrev_bb2: { label: 'Mean reversion: wick outside the 2.0 band, back to the middle', setup: 'meanrev', params: { bbPeriod: 20, bbStd: 2, maxAdx: 20, minR: 0.8 }, patch: (c) => { c.exits.mode = 'fixed'; } },
  meanrev_bb25: { label: 'Mean reversion: wick outside the 2.5 band, back to the middle', setup: 'meanrev', params: { bbPeriod: 20, bbStd: 2.5, maxAdx: 20, minR: 0.8 }, patch: (c) => { c.exits.mode = 'fixed'; } },
};
const PULLBACK = ['current', 'stop_setup', 'fixed_target', 'ladder_only'];

const wanted = arg('variants', PULLBACK.join(',')).split(',');
const results: { variant: string; label: string; research: { trades: number; confirmed: number; seconds: number; symbols: string[] }; setup: SetupName; search: SearchResult | null; everySignal: EverySignal; trades: ResearchTrade[] }[] = [];
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
    dbPath: DB, config, label: v, from: FROM, to: TO, setup: def.setup, params: def.params, slow: def.slow,
    onProgress: (t, n) => { if (new Date(t).getUTCDate() === 1) console.log(`  ${new Date(t).toISOString().slice(0, 10)}: ${n} research trades`); },
  });
  console.log(`  ${run.trades.length} research trades from ${run.confirmed} confirmed setups in ${run.seconds}s`);
  const fmt = (m: { trades: number; netUsd: number; profitFactor: number | null; winRate: number; maxDrawdownUsd: number }) =>
    `${String(m.trades).padStart(4)} trades  net ${m.netUsd >= 0 ? '+' : ''}${m.netUsd.toFixed(0).padStart(5)}  PF ${(m.profitFactor ?? Infinity).toFixed(2).padStart(5)}  win ${(m.winRate * 100).toFixed(0).padStart(3)}%  maxDD ${m.maxDrawdownUsd.toFixed(0)}`;
  const every = everySignal(run.trades, config, FROM, SPLIT, TO);
  console.log(`  every signal    tune: ${fmt(every.all.train)} | test: ${fmt(every.all.test)}`);
  for (const [k, m] of [...Object.entries(every.bySession), ...Object.entries(every.bySide)]) console.log(`    ${k.padEnd(12)}  tune: ${fmt(m.train)} | test: ${fmt(m.test)}`);
  // The filter search only means something for the pullback, whose signals carry filter results and a score.
  const s = def.setup ? null : search(run.trades, config, FROM, SPLIT, TO, MIN_TRAIN);
  if (s) {
    console.log(`  as configured   tune: ${fmt(s.configured.train)} | test: ${fmt(s.configured.test)}`);
    for (const b of s.best.slice(0, 5)) {
      console.log(`  rr>=${b.settings.minRr} stop<=${b.settings.maxStopPct}% score>=${b.settings.minScore} rvol ${b.settings.fakeoutRvol ?? 'off'} off:[${b.settings.filtersOff.map((f) => f.replace('filter_', '')).join(',')}]`);
      console.log(`                  tune: ${fmt(b.train)} | test: ${fmt(b.test)}`);
    }
  }
  results.push({ variant: v, label: def.label, setup: def.setup ?? 'pullback', everySignal: every, research: { trades: run.trades.length, confirmed: run.confirmed, seconds: run.seconds, symbols: run.symbols }, search: s, trades: run.trades });
}

const dir = path.join(path.dirname(DB), 'results');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${arg('out', new Date().toISOString().replace(/[:.]/g, '-'))}.json`);
writeFileSync(file, JSON.stringify({ createdAt: Date.now(), db: DB, from: FROM, split: SPLIT, to: TO, minTrainTrades: MIN_TRAIN, results }, null, 1));
console.log(`\nSaved ${file}`);
