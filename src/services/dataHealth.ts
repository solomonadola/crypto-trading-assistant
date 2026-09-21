import { AutomatedTradeRecord } from '../types/automatedFeed';
import { grossPnlUSD, feesUSD } from './metrics';

/**
 * Finds trade records that cannot be right, or that were not produced by the
 * market, so they can be reviewed and kept out of the statistics.
 *
 * Same rules as tools/diagnose-trades.mjs, which found the two TAO records
 * behind the phantom $23: $11.64 and $11.57 banked on ~$15 positions while the
 * price barely moved, because a hardcoded fallback price of 510 stood in for a
 * real price of ~266.
 */

export type HealthSeverity = 'critical' | 'info';

export interface HealthIssue {
  code:
    | 'IMPOSSIBLE_PNL'
    | 'BANKED_TOO_HIGH'
    | 'PRICE_JUMP'
    | 'FORCED_CLOSE'
    | 'CORRECTED'
    | 'NO_FEES';
  severity: HealthSeverity;
  message: string;
}

export interface TradeHealth {
  trade: AutomatedTradeRecord;
  issues: HealthIssue[];
  worst: HealthSeverity;
}

// Under the current ladder (1R / 2R / 3.5R, R <= 15%) the most a trade can bank
// is ~1.6R ~= 24% of the position, so 30% leaves headroom for legitimate gaps.
const MAX_PLAUSIBLE_BANKED = 0.30;
const MAX_PLAUSIBLE_PNL = 0.50;

export function checkTrade(t: AutomatedTradeRecord): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const pos = Number(t.positionSizeUSD) || 10;
  const pnl = grossPnlUSD(t);
  const banked = Number(t.realizedCashBankedUSD) || 0;
  const entry = Number(t.entryPrice) || 0;
  const last = Number(t.exitPrice ?? t.currentPrice) || 0;
  const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

  if (Math.abs(pnl) > pos * MAX_PLAUSIBLE_PNL) {
    const move = entry > 0 && last > 0 ? ((last - entry) / entry) * 100 : null;
    issues.push({
      code: 'IMPOSSIBLE_PNL',
      severity: 'critical',
      message: `P&L ${usd(pnl)} on a ${usd(pos)} position` +
        (move !== null ? `, while the price moved only ${move >= 0 ? '+' : ''}${move.toFixed(2)}%` : '') +
        '. Likely a bad price reading.',
    });
  }
  if (banked > pos * MAX_PLAUSIBLE_BANKED) {
    issues.push({
      code: 'BANKED_TOO_HIGH',
      severity: 'critical',
      message: `Banked ${usd(banked)} (${((banked / pos) * 100).toFixed(0)}% of the position); the exit ladder cannot bank more than about 24%.`,
    });
  }
  if (entry > 0 && last > 0 && (last / entry > 3 || entry / last > 3)) {
    issues.push({
      code: 'PRICE_JUMP',
      severity: 'critical',
      message: `Price ${entry} -> ${last} is more than a 3x change; probably a price from the wrong market or listing.`,
    });
  }
  if (t.exitReason === 'DUPLICATE_ASSET_CONSOLIDATED' || t.exitReason === 'EXCESS_SLOT_REBALANCED') {
    issues.push({
      code: 'FORCED_CLOSE',
      severity: 'info',
      message: 'Closed by the old slot clean-up, not by the market (recorded at the price of the moment, usually $0 P&L). The clean-up no longer closes positions.',
    });
  }
  if (t.exitReason === 'DATA_CORRECTION_BAD_PRICE') {
    issues.push({
      code: 'CORRECTED',
      severity: 'info',
      message: 'Corrected on 2026-09-21: its profit came from a fake price and was reset to the real price move.',
    });
  }
  if (feesUSD(t) <= 0) {
    issues.push({
      code: 'NO_FEES',
      severity: 'info',
      message: 'No trading costs recorded, so its P&L is before fees.',
    });
  }
  return issues;
}

export interface DataHealthReport {
  flagged: TradeHealth[];
  /** Critical problems on trades that still count toward the statistics. */
  criticalCounted: number;
  excludedCount: number;
  byCode: Record<HealthIssue['code'], number>;
}

export function checkDataHealth(trades: AutomatedTradeRecord[]): DataHealthReport {
  const byCode = { IMPOSSIBLE_PNL: 0, BANKED_TOO_HIGH: 0, PRICE_JUMP: 0, FORCED_CLOSE: 0, CORRECTED: 0, NO_FEES: 0 };
  const flagged: TradeHealth[] = [];
  for (const trade of trades) {
    const issues = checkTrade(trade);
    if (!issues.length) continue;
    issues.forEach((i) => { byCode[i.code]++; });
    flagged.push({ trade, issues, worst: issues.some((i) => i.severity === 'critical') ? 'critical' : 'info' });
  }
  flagged.sort((a, b) =>
    (a.worst === b.worst ? 0 : a.worst === 'critical' ? -1 : 1) ||
    Math.abs(grossPnlUSD(b.trade)) - Math.abs(grossPnlUSD(a.trade)));
  return {
    flagged,
    criticalCounted: flagged.filter((f) => f.worst === 'critical' && !f.trade.excludedFromStats).length,
    excludedCount: trades.filter((t) => t.excludedFromStats).length,
    byCode,
  };
}
