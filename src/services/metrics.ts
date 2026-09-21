import { AutomatedTradeRecord } from '../types/automatedFeed';

/**
 * Single source of truth for per-trade performance.
 *
 * Before this module, "win" was defined seven different ways across the app
 * (> 0, > 0.005, > 0.01, < -0.05, excluding or including breakevens in the
 * denominator), so the same trade could be a win in one view and breakeven in
 * another, and the win rate on the History tab disagreed with the Scorecard.
 * Some views subtracted fees, most did not, and one labelled a gross figure
 * "Net P&L".
 *
 * Convention for stored fields:
 *   pnlUSD        GROSS P&L - banked harvests plus the open or closing leg
 *   totalFeesUSD  ALL friction incurred so far - entry, each fill, and exit
 * Every figure shown to the user is computed on net = pnlUSD - totalFeesUSD.
 *
 * Keeping pnlUSD gross (rather than netting costs into it) matters because
 * legacy records were written gross; netting in some places and not others
 * caused fees to be subtracted twice.
 */

/** |net| at or below this is a scratch, neither a win nor a loss. */
export const BREAKEVEN_BAND_USD = 0.01;

export type TradeOutcome = 'WIN' | 'LOSS' | 'BREAKEVEN';

export function feesUSD(t: AutomatedTradeRecord): number {
  const f = Number(t.totalFeesUSD);
  return Number.isFinite(f) && f > 0 ? f : 0;
}

export function grossPnlUSD(t: AutomatedTradeRecord): number {
  const p = Number(t.pnlUSD);
  return Number.isFinite(p) ? p : 0;
}

export function netPnlUSD(t: AutomatedTradeRecord): number {
  return grossPnlUSD(t) - feesUSD(t);
}

export function outcome(t: AutomatedTradeRecord): TradeOutcome {
  const n = netPnlUSD(t);
  return n > BREAKEVEN_BAND_USD ? 'WIN' : n < -BREAKEVEN_BAND_USD ? 'LOSS' : 'BREAKEVEN';
}

/**
 * Net return on the capital the trade actually used.
 *
 * Replaces t.pnlPercentage for reporting: that field holds the PRICE move at
 * the moment of exit, not the trade's return. A position that banked a third
 * at +3.8% and ratcheted out at +0.3% stores pnlPercentage = 0.3, though the
 * trade returned roughly +1.4%.
 */
export function netReturnPct(t: AutomatedTradeRecord): number {
  const pos = Number(t.positionSizeUSD) || 10;
  return (netPnlUSD(t) / pos) * 100;
}

export function isClosed(t: AutomatedTradeRecord): boolean {
  return t.status !== 'OPEN';
}

export function closeTime(t: AutomatedTradeRecord): number {
  return t.closedAtTimestamp || t.openedAtTimestamp || 0;
}

/** Ratio that is honest about an empty denominator: Infinity, never a dollar amount. */
export function safeRatio(numerator: number, denominator: number): number {
  if (denominator > 0) return numerator / denominator;
  return numerator > 0 ? Infinity : 0;
}

/** Display form for a ratio that may be Infinity. */
export function formatRatio(r: number, digits = 2): string {
  if (!Number.isFinite(r)) return r > 0 ? '∞' : '—';
  return r.toFixed(digits);
}
