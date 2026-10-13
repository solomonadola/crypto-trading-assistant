// Volume Surge & Multi-Day Runner Radar: identifies explosive coins expanding
// 3x-10x in volume that initiate multi-day markup phases to double or triple (2x-3x),
// as well as early gradual volume ramps before major price markups.
import type { Candle, RunnerStage, VolumeSurgeRunner } from '../../../shared/types';

export interface VolumeSurgeOptions {
  minRvol?: number;
  min24hChangePct?: number;
  min3dChangePct?: number;
}

/**
 * Analyzes 1h candles (ideally 72 to 168+ candles: 3 to 7 days) to detect
 * early volume ramps, volume surge ignition, and active multi-day runners.
 */
export function analyzeVolumeSurge(
  symbol: string,
  candles1h: Candle[],
  priceNow?: number,
  options: VolumeSurgeOptions = {}
): VolumeSurgeRunner | null {
  const n = candles1h.length;
  if (n < 24) return null;

  const minRvol = options.minRvol ?? 1.8;
  const min24hChange = options.min24hChangePct ?? 8;
  const min3dChange = options.min3dChangePct ?? 20;

  // 1. Calculate 24h Volume and Baseline Daily Volume
  const last24 = candles1h.slice(-24);
  const volume24hUsd = last24.reduce((sum, c) => sum + (c.quoteVolume || c.volume * c.close), 0);

  // Baseline: prior candles (up to 7 days = 168 hours before the last 24)
  const priorCandles = candles1h.slice(0, -24);
  const priorHours = priorCandles.length;
  const baselineDailyUsd = priorHours >= 12
    ? (priorCandles.reduce((sum, c) => sum + (c.quoteVolume || c.volume * c.close), 0) / priorHours) * 24
    : volume24hUsd;

  const rvol = baselineDailyUsd > 0
    ? Number((volume24hUsd / baselineDailyUsd).toFixed(2))
    : 1.0;

  // 2. Calculate Price Trajectory
  const price = priceNow ?? candles1h[n - 1].close;
  const p24 = n >= 25 ? candles1h[n - 25].close : candles1h[0].open;
  const p72 = n >= 73 ? candles1h[n - 73].close : candles1h[0].open;

  const change24hPct = p24 > 0 ? Number((((price - p24) / p24) * 100).toFixed(1)) : 0;
  const change3dPct = p72 > 0 ? Number((((price - p72) / p72) * 100).toFixed(1)) : change24hPct;

  // Count consecutive higher daily closes (grouped into 24h chunks)
  let consecutiveUpDays = 0;
  const dayChunks: number[] = [];
  for (let i = n; i >= 24; i -= 24) {
    dayChunks.unshift(candles1h[i - 1].close);
  }
  for (let i = dayChunks.length - 1; i >= 1; i--) {
    if (dayChunks[i] > dayChunks[i - 1]) {
      consecutiveUpDays++;
    } else {
      break;
    }
  }

  // 3. Early Volume Ramp Analysis (consecutive hourly expansion before large markup)
  const last6Candles = candles1h.slice(-6);
  let consecutiveRampingHours = 0;
  for (let i = last6Candles.length - 1; i >= 1; i--) {
    const curV = last6Candles[i].quoteVolume || (last6Candles[i].volume * last6Candles[i].close);
    const prevV = last6Candles[i - 1].quoteVolume || (last6Candles[i - 1].volume * last6Candles[i - 1].close);
    if (curV >= prevV * 1.05) {
      consecutiveRampingHours++;
    } else {
      break;
    }
  }

  const last4Candles = candles1h.slice(-4);
  const last4hVolume = last4Candles.reduce((s, c) => s + (c.quoteVolume || c.volume * c.close), 0);
  const baselineHourlyUsd = baselineDailyUsd > 0 ? baselineDailyUsd / 24 : 0;
  const recentHourlyRate = baselineHourlyUsd > 0 ? Number(((last4hVolume / 4) / baselineHourlyUsd).toFixed(2)) : 1.0;

  // 4. Filter Qualification: Must exhibit early volume ramp, volume surge OR substantial multi-day runner momentum
  const isEarlyRamp = (consecutiveRampingHours >= 2 && recentHourlyRate >= 1.8 && change24hPct >= 1.0 && change24hPct <= 28)
    || (consecutiveRampingHours >= 3 && rvol >= 1.35 && change24hPct <= 28);
  const isSurging = rvol >= minRvol && (change24hPct >= min24hChange || change3dPct >= min3dChange);
  const isMultiDayRunner = change3dPct >= 30;

  if (!isEarlyRamp && !isSurging && !isMultiDayRunner) {
    return null;
  }

  // 5. Classify Runner Stage
  let stage: RunnerStage;
  let stageLabel: string;
  let stageTone: VolumeSurgeRunner['stageTone'];
  let potentialMultiplier: string;
  let why: string;
  let catalystSummary: string;
  let actionPlan: string;

  if (change3dPct > 150 || (change24hPct >= 60 && rvol >= 5.0)) {
    stage = 'parabolic_blowoff';
    stageLabel = 'CLIMAX / BLOW-OFF';
    stageTone = 'danger';
    potentialMultiplier = 'Late Stage / Climax Risk';
    why = `Extreme parabolic surge (+${change3dPct}% 3-day, ${rvol}x volume expansion). Highly stretched from EMAs.`;
    catalystSummary = 'Vertical retail breakout chase. Heavy distribution risk with sharp -25% to -40% liquidation wicks.';
    actionPlan = 'Tighten stops immediately. Do NOT open new breakout longs. Wait for flush or trail profits.';
  } else if (change3dPct >= 40 && rvol >= 1.8) {
    stage = 'continuation_runner';
    stageLabel = 'MOMENTUM RUNNER';
    stageTone = 'accent';
    potentialMultiplier = 'Active Runner (2x-3x Expansion)';
    why = `Persistent multi-day runner (+${change3dPct}% over 3 days, ${rvol}x sustained volume). Bullish higher-timeframe structure.`;
    catalystSummary = 'Institutional markup continuation absorbing supply pullbacks cleanly.';
    actionPlan = 'Ride momentum with trailing stop below 1h/4h swing lows. Buy shallow pullbacks to 1h EMA20 or demand zones.';
  } else if (isEarlyRamp && change24hPct <= 28 && change3dPct <= 45) {
    stage = 'early_ramp';
    stageLabel = 'EARLY VOLUME RAMP';
    stageTone = 'good';
    potentialMultiplier = 'Pre-Pump Accumulation Candidate';
    why = `Gradual consecutive hourly volume expansion (${consecutiveRampingHours + 1} consecutive hours, ${recentHourlyRate}x recent volume rate) before large price markup (+${change24hPct}% 24h).`;
    catalystSummary = 'Early institutional TWAP accumulation / volume ramping quietly absorbing supply before wide retail breakout.';
    actionPlan = 'Monitor for 15m/1h breakout retest or key demand zone entry. Prime candidate before explosive momentum phase.';
  } else {
    stage = 'ignition';
    stageLabel = 'VOLUME IGNITION';
    stageTone = 'good';
    potentialMultiplier = '2x - 3x Setup Candidate';
    why = `Early explosive volume ignition (${rvol}x volume expansion, +${change24hPct}% 24h). Fresh breakout from accumulation base.`;
    catalystSummary = 'Accumulation breakout driven by heavy buyer volume surge before wide retail awareness.';
    actionPlan = 'Wait for 15m/1h pullback retest into breakout demand zone or key level for asymmetric entry.';
  }

  // 6. Runner Score (0-100)
  const effectiveVolRatio = Math.max(rvol, recentHourlyRate);
  const volPts = Math.min(40, (effectiveVolRatio / 4) * 40);
  const trendPts = Math.min(35, (Math.max(0, change3dPct) / 100) * 35);
  const stagePts = stage === 'early_ramp' ? 30 : stage === 'ignition' ? 25 : stage === 'continuation_runner' ? 20 : 5;
  const score = Math.min(100, Math.max(10, Math.round(volPts + trendPts + stagePts)));

  return {
    symbol,
    price,
    change24hPct,
    change3dPct,
    volume24hUsd,
    baselineVolumeUsd: baselineDailyUsd,
    rvol,
    stage,
    stageLabel,
    stageTone,
    consecutiveUpDays,
    why,
    catalystSummary,
    actionPlan,
    potentialMultiplier,
    score,
  };
}
