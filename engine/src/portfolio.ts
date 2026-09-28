// Open positions, derived only from the trade event log (ENGINE_PLAN.md
// Section 4A.2). Applying the same events in the same order always gives the
// same positions; nothing here is stored separately.
import type { TradeEvent } from '../../shared/types';
import type { SessionInstance } from './sessions';

export type Side = 'long' | 'short';

/** Payload of an `order_filled` event that opens a position. */
export interface EntryFill {
  role: 'entry';
  side: Side;
  qty: number;
  price: number;
  stop: number;
  /** The session the trade belongs to; it is closed when that session ends. Null with sessions off. */
  session: SessionInstance | null;
}

export type CloseReason = 'session_end' | 'manual' | 'kill' | 'stop' | 'target' | 'time_stop' | 'early_exit';

/** Payload of an `order_placed` event that asks for a position to be closed at market. */
export interface CloseOrder {
  action: 'close';
  orderType: 'market';
  reason: CloseReason;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  stop: number;
  openedAt: number;
  session: SessionInstance | null;
  /** A close order waiting to be filled, if any. */
  pendingClose: { reason: CloseReason; placedAt: number } | null;
}

export class Portfolio {
  private readonly open = new Map<string, Position>();

  apply(e: TradeEvent): void {
    const id = e.positionId;
    switch (e.type) {
      case 'order_filled': {
        const p = e.payload as unknown as EntryFill;
        if (p.role !== 'entry' || !id || !e.symbol) return;
        this.open.set(id, {
          id, symbol: e.symbol, side: p.side, qty: p.qty, entryPrice: p.price, stop: p.stop,
          openedAt: e.time, session: p.session, pendingClose: null,
        });
        return;
      }
      case 'order_placed': {
        const p = e.payload as unknown as CloseOrder;
        const pos = id ? this.open.get(id) : undefined;
        if (pos && p.action === 'close') pos.pendingClose = { reason: p.reason, placedAt: e.time };
        return;
      }
      case 'stop_moved': {
        const pos = id ? this.open.get(id) : undefined;
        if (pos) pos.stop = Number(e.payload.stop);
        return;
      }
      case 'partial_closed': {
        const pos = id ? this.open.get(id) : undefined;
        if (pos) pos.qty -= Number(e.payload.qty);
        return;
      }
      case 'position_closed':
      case 'liquidated':
        if (id) this.open.delete(id);
        return;
      default:
        return;
    }
  }

  /** Copies: changing them does not change the portfolio. */
  positions(): Position[] {
    return [...this.open.values()].map((p) => ({ ...p }));
  }

  get(id: string): Position | undefined {
    const p = this.open.get(id);
    return p && { ...p };
  }
}
