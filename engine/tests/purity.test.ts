// The engine core must take time and prices only from its inputs
// (ENGINE_PLAN.md Section 4A.1). This fails the build if core code reads the
// system clock, sets timers, uses randomness or reaches the network or disk.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CORE = ['engine/src/core', 'engine/src/analysis', 'engine/src/sessions.ts', 'engine/src/portfolio.ts'];

const FORBIDDEN: [RegExp, string][] = [
  [/Date\.now\s*\(/, 'Date.now()'],
  [/new Date\(\s*\)/, 'new Date() without a time'],
  [/performance\.now/, 'performance.now()'],
  [/\bset(Timeout|Interval|Immediate)\s*\(/, 'timers'],
  [/Math\.random/, 'Math.random'],
  [/\bfetch\s*\(/, 'fetch'],
  [/from\s+['"](node:)?(fs|net|http|https|child_process)['"]/, 'disk or network modules'],
  [/from\s+['"][^'"]*\/(feed|storage)\//, 'the feed or storage layers'],
  [/process\.env/, 'environment variables'],
];

function files(p: string): string[] {
  if (p.endsWith('.ts')) return [p];
  return readdirSync(p, { withFileTypes: true }).flatMap((d) => files(path.join(p, d.name)));
}

describe('engine core purity', () => {
  const all = CORE.flatMap(files);

  it('covers the core files', () => {
    expect(all).toContain('engine/src/core/engine.ts');
    expect(all).toContain('engine/src/sessions.ts');
  });

  it.each(all)('%s uses only its inputs', (file) => {
    // Comments may mention these words.
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const [pattern, what] of FORBIDDEN) expect(code, `${file} uses ${what}`).not.toMatch(pattern);
  });
});
