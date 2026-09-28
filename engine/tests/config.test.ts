import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ConfigError, configHash, loadConfig, validateConfig } from '../src/config';

const raw = () => parse(readFileSync('engine/config/config.yaml', 'utf8'));

describe('engine config', () => {
  it('the shipped config.yaml is valid and has the decided values', () => {
    const c = loadConfig('engine/config/config.yaml');
    expect(c.market).toBe('futures');
    expect(c.leverage).toBe(3);
    expect(c.starting_balance_usdt).toBe(1000);
    expect(c.scanner.min_quote_volume_24h).toBe(50_000_000);
    expect(c.sessions.list.map((s) => s.name)).toEqual(['asian', 'london', 'newyork']);
    expect(c.allocation.sizing).toBe('flat');
    expect(c.breakout.enabled).toBe(false);
    expect(c.feed.watch_symbols).toContain('BTCUSDT');
  });

  it('rejects a misspelt key instead of ignoring it', () => {
    const r = raw();
    r.risk.daily_loss_limt_pct = 3;
    expect(() => validateConfig(r)).toThrow(/risk/);
  });

  it('rejects values outside their rules, naming each problem', () => {
    const r = raw();
    r.pullback.fib_min = 0.7;                       // above fib_max
    r.exits.ladder[1].lock_pct = 0.1;               // below the previous step's lock
    r.sessions.list[0].tz = 'Mars/Olympus';
    let message = '';
    try { validateConfig(r); } catch (e) { message = (e as Error).message; expect(e).toBeInstanceOf(ConfigError); }
    expect(message).toMatch(/pullback\.fib_min/);
    expect(message).toMatch(/exits\.ladder\.1/);
    expect(message).toMatch(/sessions\.list\.0\.tz/);
  });

  it('requires the 1m timeframe, which stops and session exits run on', () => {
    const r = raw();
    r.feed.timeframes = ['15m', '1h', '4h'];
    expect(() => validateConfig(r)).toThrow(/exits timeframe \(1m\) must be fed/);
  });

  it('hash is stable across key order and changes with any value', () => {
    const a = validateConfig(raw());
    const reordered = validateConfig(Object.fromEntries(Object.entries(raw()).reverse()));
    expect(configHash(reordered)).toBe(configHash(a));
    const changed = raw();
    changed.risk.daily_loss_limit_pct = 2.5;
    expect(configHash(validateConfig(changed))).not.toBe(configHash(a));
  });
});
