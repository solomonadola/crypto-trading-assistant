// Bundles the REAL scanner into an importable ES module for offline replay.
//
// Only two import lines are rewritten: the ones pulling in Firebase and
// localStorage (used exclusively by deploySignalToAutomatedFeed, which the
// replay never calls). The scoring math, trade-plan math, regime gate and
// status cascade are byte-identical to src/services/entryScannerService.ts.
//
// That fidelity is the whole point: the study must measure the strategy you
// actually run, not a re-implementation that can drift from it.
//
// Re-run after any change to entryScannerService.ts.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

const SRC = 'src/services/entryScannerService.ts';
const TMP = 'src/services/.replay-tmp.ts';
const OUT = 'tools/_gen/scanner.mjs';

const original = readFileSync(SRC, 'utf8');
let src = original;

const rewrites = [
  [/import \{[^}]*\} from '\.\/automatedFeedService';/,
   "import { executeSimulatedTrade, fetchAutomatedTrades } from '../../tools/_gen/stub-feed.ts';"],
  [/import \{[^}]*\} from '\.\/bankrollService';/,
   "import { calculateBankrollState } from '../../tools/_gen/stub-bankroll.ts';"],
];

for (const [pattern, replacement] of rewrites) {
  if (!pattern.test(src)) {
    throw new Error(`Import shape changed - build-scanner.mjs needs updating.\nFailed pattern: ${pattern}`);
  }
  src = src.replace(pattern, replacement);
}

// Guard: only the two import lines may differ. If anything else changed,
// the bundle would no longer be a faithful copy - refuse rather than mislead.
const a = original.split('\n'), b = src.split('\n');
const changed = a.map((l, i) => [i + 1, l !== b[i]]).filter(([, d]) => d).map(([n]) => n);
if (changed.length !== 2) {
  throw new Error(`Expected exactly 2 changed lines, got ${changed.length}: ${changed}. Refusing to generate.`);
}

writeFileSync(TMP, src);
try {
  await esbuild.build({
    entryPoints: [TMP],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: OUT,
    logLevel: 'warning',
  });
} finally {
  unlinkSync(TMP);
}

console.log(`bundled ${OUT}`);
console.log(`rewritten import lines: ${changed.join(', ')} (scanner math untouched)`);
