// Simulated fills (ENGINE_PLAN.md Section 11). Never more generous than an
// exchange: market, stop and take-profit fills pay the taker fee and slip
// against the trade. A limit entry that rested on the book until price came
// to it fills at its price, without slippage, and pays the maker fee.
import type { Candle } from '../../../shared/types';
import type { Side } from '../portfolio';

export interface SimCosts {
  taker_fee_pct: number;
  /** Paid by a limit order that rested on the book before it filled (Binance USDT-M, regular tier: 0.02%). */
  maker_fee_pct: number;
  slippage_pct: number;
}

/** True when the fill buys: opening a long or closing a short. */
const buys = (side: Side, action: 'open' | 'close') => (side === 'long') === (action === 'open');

/** A market order's price: the reference price moved against the trade by the slippage. */
export function marketFill(side: Side, action: 'open' | 'close', ref: number, costs: SimCosts): number {
  const s = buys(side, action) ? 1 : -1;
  return ref * (1 + (s * costs.slippage_pct) / 100);
}

/**
 * If `c` reaches the stop, the fill price: the stop, or the candle's open when
 * it opened beyond the stop (a gap), then slippage. Null if not reached.
 */
export function stopFill(side: Side, stop: number, c: Candle, costs: SimCosts): number | null {
  if (side === 'long') {
    if (c.low > stop) return null;
    return marketFill(side, 'close', Math.min(stop, c.open), costs);
  }
  if (c.high < stop) return null;
  return marketFill(side, 'close', Math.max(stop, c.open), costs);
}

/** If `c` reaches the target, the fill price (the target, slipped). A candle opening beyond it fills at the target, not better. */
export function targetFill(side: Side, target: number, c: Candle, costs: SimCosts): number | null {
  const reached = side === 'long' ? c.high >= target : c.low <= target;
  return reached ? marketFill(side, 'close', target, costs) : null;
}

/** The fee on a fill: the taker fee, or the maker fee for a limit order that rested on the book. */
/**
 * A take-profit resting on the book as a limit order (Hunter's scalps): filled at the target itself, without
 * slippage, once a candle trades through it. Only touching it is not enough: the order may sit behind others
 * in the queue at that price. Null if not filled.
 */
export function restingTargetFill(side: Side, target: number, c: Candle): number | null {
  return (side === 'long' ? c.high > target : c.low < target) ? target : null;
}

export const fee = (notional: number, costs: SimCosts, maker = false) =>
  Math.abs(notional) * (maker ? costs.maker_fee_pct : costs.taker_fee_pct) / 100;

/** Gross profit of closing `qty` at `exit`. */
export const grossPnl = (side: Side, entry: number, exit: number, qty: number) => (side === 'long' ? exit - entry : entry - exit) * qty;

/** Isolated-margin liquidation price: where the loss equals the margin less the maintenance margin. */
export function liquidationPrice(side: Side, entry: number, leverage: number, maintenancePct: number): number {
  const move = 1 / leverage - maintenancePct / 100;
  return side === 'long' ? entry * (1 - move) : entry * (1 + move);
}

/** Rounds a quantity down to the exchange's step. */
export function roundQty(qty: number, step: number): number {
  if (!(step > 0)) return qty;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.floor(qty / step + 1e-9) * step).toFixed(decimals));
}
