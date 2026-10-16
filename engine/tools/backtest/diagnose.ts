// Trade-level diagnostic for Hunter: runs the scalp backtest and breaks the trades down by exit, side and
// month, with each trade's excursion and what simpler versions of it would have made after fees.
//
//   npx tsx engine/tools/backtest/diagnose.ts <label> [config.path=value ...]
//
// Values may be JSON (arrays, objects). Environment: FROM, TO, SPLIT (YYYY-MM-DD; default 2026-04-01,
// 2026-09-30, 2026-08-01) and SYMBOLS (comma-separated; default 19 liquid coins).
//
// The "versions" table holds each filled entry to a plain -1R stop / +2R target for up to 4 hours (Hunter's
// stop/target only), and the two ways of taking the other side. Costs are a share of each trade's own risk:
// 0.12% of price for a resting limit in and a taker out, 0.20% for a stop-market in and taker out.
import { loadConfig, validateConfig } from '../../src/config';
import { ensureBacktestData } from './data';
import { runBacktest } from './run';
import type { ClosedTradeView } from '../../../shared/types';

const [label = 'run', ...sets] = process.argv.slice(2);
const SYMBOLS = (process.env.SYMBOLS
  ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,SUIUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,INJUSDT,TIAUSDT,SEIUSDT,WIFUSDT,LTCUSDT')
  .split(',').map((s) => s.trim()).filter(Boolean);
const fromMs = Date.parse(`${process.env.FROM ?? '2026-04-01'}T00:00:00Z`);
const toMs = Date.parse(`${process.env.TO ?? '2026-09-30'}T23:59:59Z`);
const split = Date.parse(`${process.env.SPLIT ?? '2026-08-01'}T00:00:00Z`);

const cfg = loadConfig() as unknown as Record<string, any>;
for (const s of sets) {
  const i = s.indexOf('=');
  const keys = s.slice(0, i).split('.');
  const v = s.slice(i + 1);
  let o = cfg;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = v.startsWith('[') || v.startsWith('{') ? JSON.parse(v)
    : v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v);
}
const config = validateConfig(cfg);
const data = await ensureBacktestData({ fromMs, toMs, symbols: SYMBOLS, onProgress: (m) => { if (/error/i.test(m)) console.error(m); } });
const res = await runBacktest({ config, store: data.store, symbols: SYMBOLS, rules: data.rules, fromMs, toMs, models: ['scalp'] });

const trades = res.trades.filter((t) => t.riskUsd);
const R = (t: ClosedTradeView) => t.pnl / t.riskUsd!;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
const pf = (ts: ClosedTradeView[]) => {
  const won = sum(ts.filter((t) => t.pnl > 0).map((t) => t.pnl));
  const lost = -sum(ts.filter((t) => t.pnl <= 0).map((t) => t.pnl));
  return lost ? won / lost : Infinity;
};
const out: string[] = [];
const line = (s = '') => out.push(s);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

line(`# ${label}  ${day(fromMs)}..${day(toMs)} split ${day(split)}  ${SYMBOLS.length} coins  ${sets.join(' ')}`);
const days = (toMs - fromMs) / 86_400_000;
line(`per day: ${(res.ordersPlaced.length / days).toFixed(2)} orders placed, ${(trades.length / days).toFixed(2)} trades filled`);
const ins = trades.filter((t) => t.openedAt < split);
const oos = trades.filter((t) => t.openedAt >= split);
line(`trades ${trades.length} | total ${fmt(sum(trades.map(R)))}R | avg ${fmt(sum(trades.map(R)) / (trades.length || 1))}R | PF ${pf(trades).toFixed(2)} | win ${(100 * trades.filter((t) => t.pnl > 0).length / (trades.length || 1)).toFixed(0)}%`);
line(`before split ${ins.length} trades ${fmt(sum(ins.map(R)))}R | after split ${oos.length} trades ${fmt(sum(oos.map(R)))}R`);
line(`orders placed ${res.ordersPlaced.length}, filled ${trades.length} (${(100 * trades.length / (res.ordersPlaced.length || 1)).toFixed(0)}%)`);

const groupBy = (title: string, key: (t: ClosedTradeView) => string) => {
  line(`\n## By ${title}`);
  for (const k of [...new Set(trades.map(key))].sort()) {
    const ts = trades.filter((t) => key(t) === k);
    line(`${k.padEnd(12)} ${String(ts.length).padStart(4)} trades  ${fmt(sum(ts.map(R))).padStart(7)}R  avg ${fmt(sum(ts.map(R)) / ts.length)}R`);
  }
};
groupBy('exit', (t) => t.reason);
groupBy('side', (t) => t.side);
groupBy('month', (t) => new Date(t.openedAt).toISOString().slice(0, 7));

// Versions of each filled entry, after fees.
const v = { actual: [0, 0], bracket: [0, 0], flip1: [0, 0], flip2: [0, 0] };
const counts = { bracketWin: 0, bracketLoss: 0 };
let costSum = 0;
const rows: string[] = [];
for (const t of trades) {
  const risk = t.riskUsd! / t.qty;
  const riskPct = (risk / t.entryPrice) * 100;
  const limitCost = 0.12 / riskPct;
  const takerCost = 0.20 / riskPct;
  costSum += limitCost;
  const s = t.side === 'long' ? 1 : -1;
  const cs = data.store.range(t.symbol, '1m', t.openedAt + 60_000, t.openedAt + 4 * 3_600_000);
  const fav = (c: { high: number; low: number }) => (s > 0 ? c.high - t.entryPrice : t.entryPrice - c.low) / risk;
  const adv = (c: { high: number; low: number }) => (s > 0 ? t.entryPrice - c.low : c.high - t.entryPrice) / risk;
  /** The first of +up / -down reached along the trade's direction (the worse first within one candle), or null. */
  const firstHit = (up: number, down: number): number | null => {
    for (const c of cs) {
      if (adv(c) >= down) return -down;
      if (fav(c) >= up) return up;
    }
    return null;
  };
  const lastR = cs.length ? (s * (cs[cs.length - 1].close - t.entryPrice)) / risk : 0;
  const mfe = Math.max(0, ...cs.map(fav));
  const mae = Math.max(0, ...cs.map(adv));
  const b = firstHit(2, 1);
  if (b === 2) counts.bracketWin++; else if (b === -1) counts.bracketLoss++;
  const versions = {
    actual: R(t),
    bracket: (b ?? lastR) - limitCost,
    flip1: (b === -1 ? 1 : b === 2 ? -2 : -lastR) - takerCost,
    flip2: ((h) => (h === -2 ? 2 : h === 1 ? -1 : -lastR))(firstHit(1, 2)) - takerCost,
  };
  for (const [k, x] of Object.entries(versions)) v[k as keyof typeof v][t.openedAt < split ? 0 : 1] += x;
  rows.push(`${new Date(t.openedAt).toISOString().slice(0, 16)} ${t.symbol.padEnd(12)} ${t.side.padEnd(5)} stop ${riskPct.toFixed(2)}% fees ${limitCost.toFixed(2)}R | exit ${t.reason.padEnd(11)} ${fmt(R(t)).padStart(6)}R | MFE ${mfe.toFixed(2)}R MAE ${mae.toFixed(2)}R`);
}
const n = trades.length || 1;
line('\n## Versions, after fees');
line(`average fees per trade: ${(costSum / n).toFixed(2)}R for a limit entry, ${((costSum / n) * 0.20 / 0.12).toFixed(2)}R for a stop-market entry`);
line(`version                       all    before split   after split   per trade`);
const vline = (name: string, k: keyof typeof v) => {
  const all = v[k][0] + v[k][1];
  line(`${name.padEnd(26)} ${fmt(all).padStart(7)}R ${fmt(v[k][0]).padStart(11)}R ${fmt(v[k][1]).padStart(11)}R   ${fmt(all / n)}R`);
};
vline('Hunter as is', 'actual');
vline('Hunter, stop/target only', 'bracket');
vline('Flip 1 (+1R / -2R)', 'flip1');
vline('Flip 2 (+2R / -1R)', 'flip2');
line(`stop/target only: ${counts.bracketWin} reached +2R first, ${counts.bracketLoss} hit -1R first`);
const mfeAtLeast = (x: number) => rows.filter((r) => Number(r.match(/MFE ([\d.]+)R/)![1]) >= x).length;
line(`went at least +0.5R our way: ${mfeAtLeast(0.5)}/${trades.length}, +1R: ${mfeAtLeast(1)}/${trades.length}, +2R: ${mfeAtLeast(2)}/${trades.length}`);

line('\n## Rejections');
for (const [k, c] of [...res.rejections.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) line(`${String(c).padStart(5)}  ${k}`);
line('\n## Trades');
out.push(...rows);
console.log(out.join('\n'));
