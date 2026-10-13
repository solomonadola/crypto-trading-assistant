import { describe, expect, it } from 'vitest';
import { PatternMemory } from '../src/analysis/patternMemory';
import type { ClosedTradeView } from '../../shared/types';

describe('PatternMemory', () => {
  it('generates statistically sound priors without historical trades', () => {
    const memory = new PatternMemory([]);
    const report = memory.report();
    expect(report.totalTrades).toBe(0);
    expect(report.stats.length).toBeGreaterThan(0);

    const withTrend = report.stats.find((s) => s.tag === 'with_trend')!;
    const counterTrend = report.stats.find((s) => s.tag === 'counter_trend')!;

    expect(withTrend.winRatePct).toBeGreaterThan(counterTrend.winRatePct);
    expect(withTrend.expectancyR).toBeGreaterThan(0);
    expect(counterTrend.expectancyR).toBeLessThan(0);
    expect(withTrend.verdict).toBe('strong_edge');
    expect(counterTrend.verdict).toMatch(/negative_edge|severe_hazard/);
  });

  it('updates posterior distributions with closed trades', () => {
    const mockTrades: ClosedTradeView[] = [
      {
        id: 'trade-1',
        symbol: 'BTCUSDT',
        side: 'long',
        openedAt: 1000,
        closedAt: 2000,
        entryPrice: 100,
        exitPrice: 105,
        qty: 1,
        pnl: 50,
        reason: 'target',
        session: 'london',
        riskUsd: 20,
        setup: 'htf_poi',
      },
      {
        id: 'trade-2',
        symbol: 'ETHUSDT',
        side: 'long',
        openedAt: 3000,
        closedAt: 4000,
        entryPrice: 200,
        exitPrice: 210,
        qty: 1,
        pnl: 60,
        reason: 'target',
        session: 'newyork',
        riskUsd: 20,
        setup: 'htf_poi',
      },
    ];

    const memory = new PatternMemory(mockTrades);
    const report = memory.report();
    expect(report.totalTrades).toBe(2);

    const poiStat = report.stats.find((s) => s.tag === 'htf_poi')!;
    expect(poiStat.tradesCount).toBe(2);
    expect(poiStat.totalPnlUsd).toBe(110);
    expect(poiStat.winRatePct).toBeGreaterThan(60);

    const expansionStat = report.stats.find((s) => s.tag === 'expansion')!;
    expect(expansionStat.category).toBe('volume');
    expect(expansionStat.winRatePct).toBeGreaterThan(60);
  });

  it('evaluates setups and flags high risk on counter-trend + exhausted moves', () => {
    const memory = new PatternMemory([]);
    const badSetup = memory.evaluateSetup('SOLUSDT', 'long', {
      trendAlign: 'counter_trend',
      dealingZone: 'premium',
      adrStatus: 'exhausted',
      session: 'off_session',
      volumeRegime: 'climax',
    });

    expect(badSetup.compositeVerdict).toMatch(/negative_edge|severe_hazard/);
    expect(badSetup.expectancyR).toBeLessThan(0);
    expect(badSetup.winRatePct).toBeLessThan(40);
    expect(badSetup.warnings.length).toBeGreaterThanOrEqual(3);
    expect(badSetup.summary).toContain('Warning');

    const goodSetup = memory.evaluateSetup('SOLUSDT', 'long', {
      trendAlign: 'with_trend',
      dealingZone: 'discount',
      adrStatus: 'fresh',
      session: 'killzone',
      volumeRegime: 'expansion',
    });

    expect(goodSetup.compositeVerdict).toMatch(/strong_edge|positive_edge/);
    expect(goodSetup.expectancyR).toBeGreaterThan(0.4);
    expect(goodSetup.winRatePct).toBeGreaterThan(55);
    expect(goodSetup.strengths.length).toBeGreaterThanOrEqual(3);
    expect(goodSetup.summary).toContain('High-Probability');
  });
});

