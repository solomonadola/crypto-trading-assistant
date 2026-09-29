// npm run backtest:merge -- --out name file1.json file2.json ...
//
// Joins result files from separate runs (run in parallel, one variant each)
// into one, in the order given. Files saved before the every-signal baseline
// existed get it computed from their stored trades. All files must cover the
// same periods.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config';
import { everySignal } from './optimize';
import type { ResearchTrade } from './research';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx > -1 ? args.splice(outIdx, 2)[1] : null;
if (!out || !args.length) throw new Error('usage: merge --out name file1.json file2.json ...');
const cfg = loadConfig();
const files = args.map((f) => ({ f, d: JSON.parse(readFileSync(f, 'utf8')) }));
const first = files[0].d;
for (const { f, d } of files) {
  if (d.from !== first.from || d.split !== first.split || d.to !== first.to) throw new Error(`${f} covers different periods`);
}
const results = files.flatMap(({ d }) => d.results.map((r: { trades: ResearchTrade[]; everySignal?: unknown; setup?: string }) => ({
  ...r, setup: r.setup ?? 'pullback', everySignal: r.everySignal ?? everySignal(r.trades, cfg, d.from, d.split, d.to),
})));
const file = path.join(path.dirname(args[0]), `${out}.json`);
writeFileSync(file, JSON.stringify({ ...first, createdAt: Date.now(), results }, null, 1));
console.log(`Saved ${file}: ${results.map((r: { variant: string }) => r.variant).join(', ')}`);
