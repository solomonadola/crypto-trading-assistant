import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { configured, passes, search, simulate, type Settings } from '../src/backtest/optimize';
import type { ResearchTrade } from '../src/backtest/research';

const cfg = loadConfig('engine/config/config.yaml');
const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);
const trade = (over: Partial<ResearchTrade> = {}): ResearchTrade => ({
  symbol: 'SOLUSDT', side: 'long', signalTime: T0, openedAt: T0, closedAt: T0 + H, session: 'london', reason: 'target',
  r: 1, stopPct: 1, rewardRisk: 2, score: 5, failures: [], fakeoutRvol: 2.5, fakeoutOtherPass: true, ...over,
});
const loose: Settings = { minRr: 1, maxStopPct: 5, minScore: 2, fakeoutRvol: null, filtersOff: ['filter_chop'] };

describe('which trades a setting allows', () => {
  it('thresholds are re-judged from the stored values, not the stored failures', () => {
    const t = trade({ rewardRisk: 1.2, failures: ['rr_too_low'] });
    expect(passes(t, loose)).toBe(true);
    expect(passes(t, { ...loose, minRr: 1.5 })).toBe(false);
    expect(passes(trade({ stopPct: 3 }), { ...loose, maxStopPct: 2.5 })).toBe(false);
    expect(passes(trade({ score: 3 }), { ...loose, minScore: 4 })).toBe(false);
  });

  it('a filter blocks unless switched off; session failures always block', () => {
    expect(passes(trade({ failures: ['filter_chop.adx'] }), loose)).toBe(true);
    expect(passes(trade({ failures: ['filter_squeeze'] }), loose)).toBe(false);
    expect(passes(trade({ failures: ['session_funding_window'] }), { ...loose, filtersOff: ['filter_chop', 'filter_squeeze'] })).toBe(false);
  });

  it('the fakeout filter is re-judged at the chosen volume, and can be switched off', () => {
    const t = trade({ fakeoutRvol: 1.6, failures: ['filter_fakeout'] });
    expect(passes(t, { ...loose, fakeoutRvol: 1.5 })).toBe(true);
    expect(passes(t, { ...loose, fakeoutRvol: 2 })).toBe(false);
    expect(passes(trade({ fakeoutOtherPass: false, failures: ['filter_fakeout'] }), { ...loose, fakeoutRvol: 1 })).toBe(false);
    expect(passes(trade({ fakeoutOtherPass: false, failures: ['filter_fakeout'] }), { ...loose, fakeoutRvol: null })).toBe(true);
  });

  it('the configured settings match config.yaml', () => {
    expect(configured(cfg)).toEqual({ minRr: cfg.exits.min_rr, maxStopPct: cfg.exits.max_stop_pct, minScore: cfg.scoring.min_score, fakeoutRvol: cfg.filters.fakeout.min_rvol, filtersOff: [] });
  });
});

describe('portfolio rules and sizing', () => {
  it('one position per coin, max open trades, and a cooldown after a loss', () => {
    const trades = [
      trade({ symbol: 'A', openedAt: T0, closedAt: T0 + 3 * H }),
      trade({ symbol: 'A', openedAt: T0 + H, closedAt: T0 + 2 * H }),          // A already open: skipped
      ...['B', 'C', 'D', 'E'].map((s) => trade({ symbol: s, openedAt: T0 + H, closedAt: T0 + 5 * H })),
      trade({ symbol: 'F', openedAt: T0 + 2 * H, closedAt: T0 + 3 * H }),      // 5 open: skipped
      trade({ symbol: 'G', openedAt: T0 + 6 * H, closedAt: T0 + 7 * H, r: -1 }),
      trade({ symbol: 'G', openedAt: T0 + 7 * H + 10 * 60_000, closedAt: T0 + 8 * H }),   // 10 min after a loss: skipped
      trade({ symbol: 'G', openedAt: T0 + 8 * H, closedAt: T0 + 9 * H }),      // after the cooldown: taken
    ];
    expect(simulate(trades, loose, cfg, T0, T0 + 24 * H).trades).toBe(7);
  });

  it('sizes like the engine: 10% of the balance, shrunk only if the loss at the stop with costs would pass 1%', () => {
    // Stop 1%: a $100 position; a 1R win is $100 x 1% = $1.
    expect(simulate([trade({ stopPct: 1, r: 1 })], loose, cfg, T0, T0 + H).netUsd).toBeCloseTo(1, 9);
    // Stop 4%: $100 loses $4.2 with costs, under the $10 cap, so still $100; a 1R win is $4.
    expect(simulate([trade({ stopPct: 4, r: 1 })], loose, cfg, T0, T0 + H).netUsd).toBeCloseTo(4, 9);
    // Only a stop wider than 10% minus costs would shrink it: stop 12% -> $10 / 12.2% = $82.
    expect(simulate([trade({ stopPct: 12, r: 1 })], { ...loose, maxStopPct: 20 }, cfg, T0, T0 + H).netUsd).toBeCloseTo((10 / 0.122) * 0.12, 6);
  });

  it('tuning and test periods never mix, and the search reports both', () => {
    const tune = Array.from({ length: 80 }, (_, i) => trade({ symbol: `S${i}`, openedAt: T0 + i * H, closedAt: T0 + i * H + 1, r: i % 3 ? 1.5 : -1 }));
    const test = Array.from({ length: 20 }, (_, i) => trade({ symbol: `S${i}`, openedAt: T0 + 200 * H + i * H, closedAt: T0 + 200 * H + i * H + 1, r: -1 }));
    const r = search([...tune, ...test], cfg, T0, T0 + 150 * H, T0 + 300 * H, 40, 3);
    expect(r.best.length).toBe(3);
    for (const b of r.best) {
      expect(b.train.trades).toBe(80);
      expect(b.train.netUsd).toBeGreaterThan(0);
      expect(b.test.trades).toBe(20);
      expect(b.test.netUsd).toBeLessThan(0);
    }
  });
});
