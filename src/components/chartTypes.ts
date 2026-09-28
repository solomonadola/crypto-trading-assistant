export type { Candle, ClosedTradeView } from '../../shared/types';
export type { EquityPoint, Zone } from '../lib/api';

export interface PositionViewLike {
  side: string;
  entryPrice: number;
  stop: number;
  target: number | null;
}
