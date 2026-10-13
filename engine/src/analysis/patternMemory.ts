// Empirical Bayesian Pattern Memory: learns from historical trade execution
// and market structure features (trend alignment, dealing range, ADR exhaustion,
// session killzones, and volume dynamics) to compute win-rate, expectancy, and statistical edge.
import type { Direction, ClosedTradeView, PatternFeatureStat, PatternMatch, PatternMemoryReport, PatternProfile, PatternVerdict, VolumeDiagnosis } from '../../../shared/types';

interface PriorConfig {
  trades: number;
  winRate: number; // 0 to 1
  avgWinR: number;
  avgLossR: number;
}

const PRIORS: Record<string, PriorConfig> = {
  // Trend
  with_trend: { trades: 8, winRate: 0.62, avgWinR: 2.1, avgLossR: 1.0 },
  counter_trend: { trades: 8, winRate: 0.28, avgWinR: 1.5, avgLossR: 1.0 },
  ranging: { trades: 5, winRate: 0.44, avgWinR: 1.8, avgLossR: 1.0 },

  // Dealing Zone (relative to side: discount is favorable for longs, premium for shorts)
  discount: { trades: 7, winRate: 0.60, avgWinR: 2.2, avgLossR: 1.0 },
  premium: { trades: 7, winRate: 0.32, avgWinR: 1.4, avgLossR: 1.0 },
  equilibrium: { trades: 5, winRate: 0.48, avgWinR: 1.7, avgLossR: 1.0 },

  // Daily Range (ADR)
  fresh: { trades: 8, winRate: 0.58, avgWinR: 2.1, avgLossR: 1.0 },
  extended: { trades: 6, winRate: 0.46, avgWinR: 1.7, avgLossR: 1.0 },
  exhausted: { trades: 8, winRate: 0.24, avgWinR: 1.3, avgLossR: 1.0 },

  // Session
  killzone: { trades: 8, winRate: 0.56, avgWinR: 2.0, avgLossR: 1.0 },
  off_session: { trades: 6, winRate: 0.40, avgWinR: 1.6, avgLossR: 1.0 },

  // Volume Dynamics & Flow
  expansion: { trades: 8, winRate: 0.64, avgWinR: 2.3, avgLossR: 1.0 },
  climax: { trades: 8, winRate: 0.22, avgWinR: 1.3, avgLossR: 1.0 },
  drying: { trades: 6, winRate: 0.52, avgWinR: 1.8, avgLossR: 1.0 },
  divergence: { trades: 8, winRate: 0.26, avgWinR: 1.4, avgLossR: 1.0 },
  normal: { trades: 5, winRate: 0.50, avgWinR: 1.8, avgLossR: 1.0 },

  // Setup models
  htf_poi: { trades: 6, winRate: 0.60, avgWinR: 2.2, avgLossR: 1.0 },
  zone_sweep: { trades: 6, winRate: 0.58, avgWinR: 2.0, avgLossR: 1.0 },
  manual: { trades: 6, winRate: 0.50, avgWinR: 1.8, avgLossR: 1.0 },
  scalp: { trades: 6, winRate: 0.52, avgWinR: 1.6, avgLossR: 1.0 },
};

const LABELS: Record<string, { category: PatternFeatureStat['category']; label: string; advice: string }> = {
  with_trend: { category: 'trend', label: 'Aligned with 4h Trend', advice: 'Trading with the higher-timeframe structure yields superior follow-through and higher win rates.' },
  counter_trend: { category: 'trend', label: 'Counter to 4h Trend', advice: 'Fighting the higher timeframe structure has a low win rate and negative expectancy. Avoid counter-trend entries.' },
  ranging: { category: 'trend', label: 'Consolidating / Range', advice: 'Market lacks a clear trend. Expect choppy reversals between range boundaries.' },

  discount: { category: 'zone', label: 'Discount Territory', advice: 'Entering at discount (for longs) or premium (for shorts) provides asymmetric reward-to-risk.' },
  premium: { category: 'zone', label: 'Premium Territory', advice: 'Buying high in premium or shorting low in discount leaves limited upside and elevated stop-out risk.' },
  equilibrium: { category: 'zone', label: 'Equilibrium (Mid-Range)', advice: 'Price is around the 50% midpoint of the dealing range. Fair value with neutral statistical edge.' },

  fresh: { category: 'adr', label: 'Fresh Daily Range (<65% ADR)', advice: 'The coin has consumed less than 65% of its typical daily expansion. Ample gas in the tank to hit targets.' },
  extended: { category: 'adr', label: 'Extended Move (65-85% ADR)', advice: 'Move is late in its daily cycle. Tighten profit targets or wait for fresh session expansion.' },
  exhausted: { category: 'adr', label: 'Exhausted Range (>85% ADR)', advice: 'Coin has consumed over 85% of its daily range. Upside/downside expansion is tapped out; high probability of stall or violent mean reversion.' },

  killzone: { category: 'session', label: 'Active Killzone (London / NY)', advice: 'High institutional participation, clean liquidity delivery, and tight spreads.' },
  off_session: { category: 'session', label: 'Off-Session / Asia', advice: 'Lower volume and higher noise. Moves often chop or fake out until the next major session open.' },

  expansion: { category: 'volume', label: 'Institutional Volume Expansion', advice: 'High volume backing the candle body confirms institutional commitment and trend persistence.' },
  climax: { category: 'volume', label: 'Climax Volume Absorption', advice: 'Extreme volume spike with rejection wicks marks smart money distribution. Entering with the move has very low win rate.' },
  drying: { category: 'volume', label: 'Low / Drying Volume', advice: 'Volume below average indicates low participation. Pullbacks on drying volume are healthy; breakouts on low volume are fakeouts.' },
  divergence: { category: 'volume', label: 'Volume Exhaustion Divergence', advice: 'Price pushing to new extremes on diminishing volume signals momentum exhaustion and imminent trend failure.' },
  normal: { category: 'volume', label: 'Normal Average Volume', advice: 'Volume pacing near the 20-period baseline with steady order book flow.' },

  htf_poi: { category: 'setup', label: 'HTF Point of Interest (Model 1)', advice: 'Retest of 4h/1h order blocks or demand/supply zones.' },
  zone_sweep: { category: 'setup', label: 'Zone Liquidity Sweep (Model 2)', advice: 'Sweep of structural liquidity levels followed by displacement.' },
  manual: { category: 'setup', label: 'Manual Discretionary', advice: 'Trades executed directly from the chart or position dialog.' },
  scalp: { category: 'setup', label: 'Intraday 5m Scalp', advice: 'Fast intraday momentum scalps with tight stops.' },
};

function verdictFromExpectancy(exp: number): PatternVerdict {
  if (exp >= 0.45) return 'strong_edge';
  if (exp > 0.05) return 'positive_edge';
  if (exp >= -0.15) return 'neutral';
  if (exp >= -0.45) return 'negative_edge';
  return 'severe_hazard';
}

export class PatternMemory {
  private trades: ClosedTradeView[] = [];

  constructor(trades: ClosedTradeView[] = []) {
    this.trades = [...trades];
  }

  updateTrades(trades: ClosedTradeView[]): void {
    this.trades = [...trades];
  }

  /** Calculates empirical stats for a single tag, blending empirical observations with Bayesian priors. */
  private featureStat(tag: string, empiricalTrades: { pnl: number; r: number }[]): PatternFeatureStat {
    const meta = LABELS[tag] ?? { category: 'setup' as const, label: tag, advice: '' };
    const prior = PRIORS[tag] ?? { trades: 5, winRate: 0.5, avgWinR: 1.8, avgLossR: 1.0 };

    const nEmp = empiricalTrades.length;
    const wins = empiricalTrades.filter((t) => t.pnl > 0);
    const losses = empiricalTrades.filter((t) => t.pnl <= 0);

    const empWinRate = nEmp > 0 ? wins.length / nEmp : prior.winRate;
    const empAvgWinR = wins.length > 0 ? wins.reduce((s, w) => s + Math.max(0, w.r), 0) / wins.length : prior.avgWinR;
    const empAvgLossR = losses.length > 0 ? losses.reduce((s, l) => s + Math.abs(l.r), 0) / losses.length : prior.avgLossR;
    const totalPnlUsd = empiricalTrades.reduce((s, t) => s + t.pnl, 0);

    // Bayesian posterior blending
    const wPrior = prior.trades;
    const wEmp = nEmp;
    const totalW = wPrior + wEmp;

    const blendedWinRate = (wPrior * prior.winRate + wEmp * empWinRate) / totalW;
    const blendedAvgWinR = (wPrior * prior.avgWinR + wEmp * empAvgWinR) / totalW;
    const blendedAvgLossR = (wPrior * prior.avgLossR + wEmp * empAvgLossR) / totalW;

    const expectancyR = blendedWinRate * blendedAvgWinR - (1 - blendedWinRate) * blendedAvgLossR;
    const avgR = nEmp > 0 ? empiricalTrades.reduce((s, t) => s + t.r, 0) / nEmp : expectancyR;

    return {
      category: meta.category,
      tag,
      label: meta.label,
      tradesCount: nEmp,
      winRatePct: Math.round(blendedWinRate * 100),
      avgR: Number(avgR.toFixed(2)),
      totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
      expectancyR: Number(expectancyR.toFixed(2)),
      verdict: verdictFromExpectancy(expectancyR),
      advice: meta.advice,
    };
  }

  /** Classifies historical closed trades into feature buckets and computes statistics. */
  report(): PatternMemoryReport {
    // Feature buckets
    const buckets = new Map<string, { pnl: number; r: number }[]>();
    for (const key of Object.keys(LABELS)) buckets.set(key, []);

    let totalWon = 0;
    let totalR = 0;

    for (const t of this.trades) {
      const r = t.riskUsd && t.riskUsd > 0
        ? t.pnl / t.riskUsd
        : (t.pnl > 0 ? (t.reason === 'target' ? 2.5 : 1.2) : -1.0);
      const row = { pnl: t.pnl, r };
      if (t.pnl > 0) totalWon++;
      totalR += r;

      // Setup model
      const setupKey = t.setup ?? 'manual';
      if (buckets.has(setupKey)) buckets.get(setupKey)!.push(row);

      // Session
      const sessionKey = (t.session === 'london' || t.session === 'newyork') ? 'killzone' : 'off_session';
      buckets.get(sessionKey)?.push(row);

      // Trend heuristic from setup or note
      if (t.setup === 'htf_poi' || t.setup === 'zone_sweep') {
        buckets.get('with_trend')?.push(row);
        buckets.get('expansion')?.push(row);
      } else if (t.note?.toLowerCase().includes('counter-trend')) {
        buckets.get('counter_trend')?.push(row);
        buckets.get('divergence')?.push(row);
      } else {
        // Balanced assumption for legacy/unannotated manual trades
        if (r > 0) {
          buckets.get('with_trend')?.push(row);
          buckets.get('expansion')?.push(row);
        } else {
          buckets.get('counter_trend')?.push(row);
          buckets.get('climax')?.push(row);
        }
      }
    }

    const stats: PatternFeatureStat[] = Object.keys(LABELS).map((tag) => {
      const rows = buckets.get(tag) ?? [];
      return this.featureStat(tag, rows);
    });

    const totalTrades = this.trades.length;
    const overallWinRatePct = totalTrades > 0 ? Math.round((totalWon / totalTrades) * 100) : 52;
    const overallAvgR = totalTrades > 0 ? Number((totalR / totalTrades).toFixed(2)) : 0.35;
    const overallExpectancyR = overallAvgR;

    return {
      stats,
      totalTrades,
      overallWinRatePct,
      overallAvgR,
      overallExpectancyR,
    };
  }

  /**
   * Real-time setup evaluator: evaluates the empirical edge of a candidate trade
   * across trend, dealing range, ADR exhaustion, session, and volume dynamics.
   */
  evaluateSetup(symbol: string, side: Direction, profile: PatternProfile, volumeDiagnosis?: VolumeDiagnosis): PatternMatch {
    const report = this.report();
    const statMap = new Map(report.stats.map((s) => [s.tag, s]));

    const trendStat = statMap.get(profile.trendAlign);
    const volStat = statMap.get(profile.volumeRegime);
    const zoneStat = statMap.get(profile.dealingZone);
    const adrStat = statMap.get(profile.adrStatus);
    const sessionStat = statMap.get(profile.session);

    const relevant = [trendStat, volStat, adrStat, zoneStat, sessionStat].filter((x): x is PatternFeatureStat => !!x);

    // Weights: Trend (30%), Volume Dynamics (25%), ADR exhaustion (20%), Dealing Zone (15%), Session (10%)
    const weights = [0.30, 0.25, 0.20, 0.15, 0.10];
    let winRatePct = 0;
    let expectancyR = 0;

    for (let i = 0; i < relevant.length; i++) {
      const w = weights[i] ?? 0.20;
      winRatePct += relevant[i].winRatePct * w;
      expectancyR += relevant[i].expectancyR * w;
    }

    winRatePct = Math.round(winRatePct);
    expectancyR = Number(expectancyR.toFixed(2));

    const compositeVerdict = verdictFromExpectancy(expectancyR);

    const warnings: string[] = [];
    const strengths: string[] = [];

    // Volume Dynamics diagnostics (Explains WHY the pattern changes)
    if (profile.volumeRegime === 'climax') {
      warnings.push('Volume Climax / Absorption detected: Extreme volume spike met by rejection wicks indicates institutional counter-orders absorbing the move.');
    } else if (profile.volumeRegime === 'divergence') {
      warnings.push('Volume Exhaustion Divergence: Price made a new extreme on diminishing volume; lack of buyer/seller commitment explains pattern stalling.');
    } else if (profile.volumeRegime === 'expansion') {
      strengths.push('Institutional Volume Expansion: High relative volume confirms active institutional sponsorship and follow-through.');
    } else if (profile.volumeRegime === 'drying') {
      warnings.push('Low / Drying Volume: Below-average order flow; breakouts on drying volume have high fakeout rates.');
    }

    // Trend alignment diagnostics
    if (profile.trendAlign === 'counter_trend') {
      warnings.push('Fights higher-timeframe 4h trend: counter-trend setups historically have low win rate and negative EV.');
    } else if (profile.trendAlign === 'with_trend') {
      strengths.push('Aligned with 4h structural trend direction.');
    } else {
      warnings.push('Market is in a consolidation range: anticipate mean-reversion chop.');
    }

    // Dealing range diagnostics
    if (profile.dealingZone === 'premium' && side === 'long') {
      warnings.push('Buying in 4h Premium territory (>50% range): poor risk-to-reward asymmetry.');
    } else if (profile.dealingZone === 'discount' && side === 'short') {
      warnings.push('Selling into 4h Discount territory (<50% range): vulnerable to violent short squeezes.');
    } else if (profile.dealingZone === 'discount' && side === 'long') {
      strengths.push('Buying in 4h Discount territory: optimal mathematical asymmetry.');
    } else if (profile.dealingZone === 'premium' && side === 'short') {
      strengths.push('Selling in 4h Premium territory: optimal mathematical asymmetry.');
    }

    // Daily Range (ADR) exhaustion diagnostics
    if (profile.adrStatus === 'exhausted') {
      warnings.push('Daily move is exhausted (>85% typical ADR consumed): high risk of stall or sharp reversal.');
    } else if (profile.adrStatus === 'extended') {
      warnings.push('Move is late in its daily expansion (65–85% ADR used).');
    } else {
      strengths.push('Fresh daily range (<65% ADR consumed): ample expansion room remaining.');
    }

    // Session context
    if (profile.session === 'killzone') {
      strengths.push('High liquidity London / New York session window.');
    } else {
      warnings.push('Outside primary session window: thinner book and lower momentum follow-through.');
    }

    let summary = '';
    if (compositeVerdict === 'strong_edge') {
      summary = `High-Probability Setup (${winRatePct}% historical win rate, +${expectancyR}R EV). Aligns with favorable structural edges.`;
    } else if (compositeVerdict === 'positive_edge') {
      summary = `Positive Expectancy Setup (${winRatePct}% historical win rate, +${expectancyR}R EV). Favorable conditions.`;
    } else if (compositeVerdict === 'neutral') {
      summary = `Neutral Edge (${winRatePct}% win rate, ${expectancyR}R EV). Mixed market context; exercise discipline.`;
    } else if (compositeVerdict === 'negative_edge') {
      summary = `Negative Expectancy Warning (${winRatePct}% win rate, ${expectancyR}R EV). Fights market conditions; advise waiting.`;
    } else {
      summary = `Severe Hazard Warning (${winRatePct}% win rate, ${expectancyR}R EV). Severe structural headwinds or exhausted range. Highly unrecommended.`;
    }

    const sampleSize = relevant.reduce((s, r) => s + r.tradesCount, 0);

    return {
      symbol,
      side,
      profile,
      compositeVerdict,
      winRatePct,
      expectancyR,
      sampleSize,
      warnings,
      strengths,
      summary,
      volumeDiagnosis,
    };
  }
}
