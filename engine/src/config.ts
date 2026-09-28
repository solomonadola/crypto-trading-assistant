import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse } from 'yaml';
import { configSchema, type EngineConfig } from '../config/schema';

export type { EngineConfig };

export const DEFAULT_CONFIG_PATH = path.join('engine', 'config', 'config.yaml');

export class ConfigError extends Error {}

/** Validates a parsed config object; throws ConfigError listing every problem. */
export function validateConfig(raw: unknown): EngineConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid engine config:\n${lines.join('\n')}`);
  }
  return result.data;
}

export function loadConfig(file = process.env.ENGINE_CONFIG || DEFAULT_CONFIG_PATH): EngineConfig {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read engine config ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateConfig(raw);
}

/** Short fingerprint of a config, stored with every trade event so results can be tied to the settings that made them. */
export function configHash(config: EngineConfig): string {
  const canonical = JSON.stringify(config, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
      : value);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
