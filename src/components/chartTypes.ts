export type { Candle, ClosedTradeView, TradeIdea } from '../../shared/types';
export type { EquityPoint, Zone } from '../lib/api';

export interface PositionViewLike {
  id?: string;
  side: string;
  entryPrice: number;
  stop: number;
  target: number | null;
  /** When it opened: the position box starts there. */
  openedAt?: number;
}
