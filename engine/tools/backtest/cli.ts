// Command-line entry point for the backtest harness:
// npm run backtest -- [options]
import { loadConfig, validateConfig, type EngineConfig } from '../../src/config';
import { ensureBacktestData, DEFAULT_BACKTEST_SYMBOLS } from './data';
import { runBacktest } from './run';
import { generateReport, formatReportMarkdown, writeReportFiles } from './report';
import type { ScalpKind } from '../../src/analysis/scalp';

function parseArgs(args: string[]) {
  const flags: Record<string, string | string[] | boolean> = {};
  const setOverrides: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'set') {
        const val = args[++i];
        if (val) setOverrides.push(val);
      } else if (key === 'skip-download') {
        flags[key] = true;
      } else {
        const val = args[++i];
        flags[key] = val;
      }
    }
  }

  return { flags, setOverrides };
}

function applySetOverride(cfg: Record<string, any>, keyVal: string) {
  const eqIdx = keyVal.indexOf('=');
  if (eqIdx === -1) return;
  const path = keyVal.slice(0, eqIdx).trim();
  const rawVal = keyVal.slice(eqIdx + 1).trim();

  let val: unknown = rawVal;
  if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
    val = rawVal.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
  } else if (rawVal === 'true') val = true;
  else if (rawVal === 'false') val = false;
  else if (rawVal === 'null') val = null;
  else if (!Number.isNaN(Number(rawVal))) val = Number(rawVal);

  const parts = path.split('.');
  let curr = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!curr[parts[i]] || typeof curr[parts[i]] !== 'object') curr[parts[i]] = {};
    curr = curr[parts[i]];
  }
  curr[parts[parts.length - 1]] = val;
}

export async function main() {
  const { flags, setOverrides } = parseArgs(process.argv.slice(2));

  const fromStr = (flags['from'] as string) ?? '2026-04-01';
  const toStr = (flags['to'] as string) ?? '2026-09-30';
  const splitStr = flags['split'] as string | undefined;
  const label = (flags['label'] as string) ?? 'baseline';

  const fromMs = new Date(`${fromStr}T00:00:00Z`).getTime();
  const toMs = new Date(`${toStr}T23:59:59Z`).getTime();
  const splitMs = splitStr ? new Date(`${splitStr}T00:00:00Z`).getTime() : undefined;

  const symbols = flags['symbols']
    ? (flags['symbols'] as string).split(',').map((s) => s.trim().toUpperCase())
    : DEFAULT_BACKTEST_SYMBOLS;

  const models = flags['models']
    ? ((flags['models'] as string).split(',').map((m) => m.trim()) as Array<'scalp' | 'zone_sweep' | 'session_sweep' | 'htf_poi'>)
    : undefined;

  const kinds = flags['kinds']
    ? ((flags['kinds'] as string).split(',').map((k) => k.trim()) as ScalpKind[])
    : undefined;

  // Load config & apply overrides
  const cfg = loadConfig();
  for (const override of setOverrides) {
    applySetOverride(cfg as unknown as Record<string, any>, override);
  }
  const validatedConfig = validateConfig(cfg);

  console.log(`\n======================================================`);
  console.log(`🚀 STARTING BACKTEST: ${label.toUpperCase()}`);
  console.log(`📅 Period: ${fromStr} to ${toStr} ${splitStr ? `(Split: ${splitStr})` : ''}`);
  console.log(`🪙 Symbols (${symbols.length}): ${symbols.slice(0, 8).join(', ')}...`);
  console.log(`======================================================\n`);

  // Ensure historical candles exist in data/backtest/candles.db
  const dataResult = await ensureBacktestData({
    fromMs,
    toMs,
    symbols,
    onProgress: (msg) => console.log(`[data] ${msg}`),
  });

  // Run simulation
  console.log(`\n🔄 Running deterministic backtest simulation...`);
  const result = await runBacktest({
    config: validatedConfig,
    store: dataResult.store,
    symbols,
    rules: dataResult.rules,
    fromMs,
    toMs,
    models,
    kinds,
    onProgress: ({ day, candlesProcessed, tradesCount, equity }) => {
      process.stdout.write(`\r[sim] ${day} | Candles: ${candlesProcessed} | Trades: ${tradesCount} | Equity: $${equity.toFixed(2)}`);
    },
  });
  console.log(`\n✅ Simulation complete!`);

  // Generate and save reports
  const report = generateReport(result, { label, splitMs });
  const { jsonPath, mdPath } = writeReportFiles(report);

  console.log(`\n📄 Report written to:`);
  console.log(`   - Markdown: ${mdPath}`);
  console.log(`   - JSON:     ${jsonPath}`);
  console.log(`\n${formatReportMarkdown(report)}\n`);
}

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  main().catch((err) => {
    console.error(`\n❌ Backtest failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}

