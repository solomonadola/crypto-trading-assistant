// The simulated account: open positions, pending orders, balance and the
// statistics the risk rules need, derived only from the trade event log
// (ENGINE_PLAN.md Section 4A.2). Applying the same events in the same order
// always gives the same account.
import type { SpeedGroup } from './speed';
import type { Direction, SignalRecord, TradeEvent } from '../../shared/types';
import type { SessionInstance } from './sessions';

export type Side = Direction;

export type CloseReason =
  | 'session_end' | 'max_hold' | 'manual' | 'kill' | 'stop' | 'target' | 'time_stop'
  | 'early_exit_4h' | 'early_exit_1h' | 'failed_breakout' | 'stagnation' | 'btc_move' | 'liquidation';

/** Payload of the `order_filled` event that opens a position. */
export interface EntryFill {
  role: 'entry';
  side: Side;
  qty: number;
  price: number;
  stop: number;
  /** First objective: where part (or all) of the position is taken. Null in ladder-only mode. */
  target?: number | null;
  fee?: number;
  /** The session the trade belongs to; it is closed when that session ends. Null with sessions off. */
  session: SessionInstance | null;
  leverage?: number;
  liqPrice?: number;
  /** The 15m level the confirmation closed through; a close back beyond it early is a failed breakout. */
  chochLevel?: number | null;
  signalId?: string | null;
  /** The coin's speed group when the trade opened (Section 18.2); `normal` when absent. */
  speed?: SpeedGroup;
  /** The model whose signal opened it. */
  setup?: SignalRecord['setup'];
  /** Manual trades: why it was taken. */
  note?: string;
}


/** Payload of an `order_placed` event asking for a position to be closed at market. */
export interface CloseOrder {
  action: 'close';
  orderType: 'market';
  reason: CloseReason;
}

/** Payload of an `order_placed` event asking for a position to be opened at market. */
export interface OpenOrder {
  action: 'open';
  orderType: 'market';
  side: Side;
  /** Position size in USDT at the reference price; qty is fixed at the fill. */
  notional: number;
  stop: number;
  target: number | null;
  chochLevel: number | null;
  signalId: string | null;
  refPrice: number;
  speed?: SpeedGroup;
  setup?: SignalRecord['setup'];
  note?: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  initialQty: number;
  entryPrice: number;
  stop: number;
  initialStop: number;
  target: number | null;
  openedAt: number;
  session: SessionInstance | null;
  leverage: number;
  liqPrice: number | null;
  chochLevel: number | null;
  signalId: string | null;
  speed: SpeedGroup;
  setup: SignalRecord['setup'] | null;
  /** Manual trades: why it was taken. */
  note?: string | null;
  /** Index of the highest ladder step reached; -1 before the first. */
  ladderStep: number;
  partialDone: boolean;
  fees: number;
  funding: number;
  /** Gross profit on the part already closed. */
  realized: number;
  pendingClose: { reason: CloseReason; placedAt: number } | null;
}

export interface PendingEntry extends OpenOrder {
  positionId: string;
  symbol: string;
  placedAt: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: Side;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  /** Net: gross profit minus all fees plus funding. */
  pnl: number;
  reason: CloseReason;
  session: string | null;
  signalId: string | null;
  /** Money at risk at entry: distance to the initial stop x quantity (before costs). */
  riskUsd: number;
  setup?: SignalRecord['setup'];
  speed: SpeedGroup;
  note?: string;
}

const day = (t: number) => Math.floor(t / 86_400_000);

export class Portfolio {
  private readonly open = new Map<string, Position>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly closed: ClosedTrade[] = [];
  balance: number;
  halted: { reason: string; at: number } | null = null;
  /** Net result of trades closed per UTC day. */
  private readonly dayPnl = new Map<number, number>();
  private readonly entriesPerSymbolDay = new Map<string, number>();
  private readonly lastLossAt = new Map<string, number>();
  /** Consecutive losing trades, and wins since the size cut began. */
  lossStreak = 0;
  winsSinceCut = 0;
  sizeCutActive = false;

  constructor(startingBalance: number, private readonly streakCfg = { after_losses: 3, reset_after_wins: 2 }) {
    this.balance = startingBalance;
  }

  apply(e: TradeEvent): void {
    const id = e.positionId;
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'order_placed': {
        if (p.action === 'open' && id && e.symbol) {
          this.pending.set(id, { ...(p as unknown as OpenOrder), positionId: id, symbol: e.symbol, placedAt: e.time });
        } else if (p.action === 'close') {
          const pos = id ? this.open.get(id) : undefined;
          if (pos) pos.pendingClose = { reason: p.reason as CloseReason, placedAt: e.time };
        }
        return;
      }
      case 'order_cancelled':
        if (id) this.pending.delete(id);
        return;
      case 'order_filled': {
        const f = p as unknown as EntryFill;
        if (f.role !== 'entry' || !id || !e.symbol) return;
        this.pending.delete(id);
        const fee = f.fee ?? 0;
        this.balance -= fee;
        this.open.set(id, {
          id, symbol: e.symbol, side: f.side, qty: f.qty, initialQty: f.qty, entryPrice: f.price,
          stop: f.stop, initialStop: f.stop, target: f.target ?? null, openedAt: e.time, session: f.session,
          leverage: f.leverage ?? 1, liqPrice: f.liqPrice ?? null, chochLevel: f.chochLevel ?? null, signalId: f.signalId ?? null, speed: f.speed ?? 'normal', setup: f.setup ?? null, note: f.note ?? null,
          ladderStep: -1, partialDone: false, fees: fee, funding: 0, realized: 0, pendingClose: null,
        });
        const key = `${e.symbol}|${day(e.time)}`;
        this.entriesPerSymbolDay.set(key, (this.entriesPerSymbolDay.get(key) ?? 0) + 1);
        return;
      }
      case 'stop_moved': {
        const pos = id ? this.open.get(id) : undefined;
        if (!pos) return;
        pos.stop = Number(p.stop);
        if (typeof p.ladderStep === 'number') pos.ladderStep = p.ladderStep;
        return;
      }
      case 'partial_closed': {
        const pos = id ? this.open.get(id) : undefined;
        if (!pos) return;
        const qty = Number(p.qty);
        const gross = Number(p.pnl);
        const fee = Number(p.fee ?? 0);
        pos.qty -= qty;
        pos.realized += gross;
        pos.fees += fee;
        pos.partialDone = true;
        this.balance += gross - fee;
        return;
      }
      case 'funding_charged': {
        const pos = id ? this.open.get(id) : undefined;
        const amount = Number(p.amount);
        if (pos) pos.funding += amount;
        this.balance += amount;
        return;
      }
      case 'position_closed':
      case 'liquidated': {
        const pos = id ? this.open.get(id) : undefined;
        if (!pos) return;
        const gross = Number(p.pnl);
        const fee = Number(p.fee ?? 0);
        this.balance += gross - fee;
        const net = pos.realized + gross - pos.fees - fee + pos.funding;
        this.open.delete(pos.id);
        this.closed.push({
          id: pos.id, symbol: pos.symbol, side: pos.side, openedAt: pos.openedAt, closedAt: e.time,
          entryPrice: pos.entryPrice, exitPrice: Number(p.price), qty: pos.initialQty, pnl: net,
          reason: (e.type === 'liquidated' ? 'liquidation' : p.reason) as CloseReason,
          session: pos.session?.name ?? null,
          signalId: pos.signalId,
          riskUsd: Math.abs(pos.entryPrice - pos.initialStop) * pos.initialQty,
          setup: pos.setup ?? undefined, speed: pos.speed, ...(pos.note ? { note: pos.note } : {}),
        });
        this.dayPnl.set(day(e.time), (this.dayPnl.get(day(e.time)) ?? 0) + net);
        if (net < 0) {
          this.lastLossAt.set(pos.symbol, e.time);
          this.lossStreak++;
          this.winsSinceCut = 0;
          if (this.lossStreak >= this.streakCfg.after_losses) this.sizeCutActive = true;
        } else {
          this.lossStreak = 0;
          if (this.sizeCutActive && ++this.winsSinceCut >= this.streakCfg.reset_after_wins) {
            this.sizeCutActive = false;
            this.winsSinceCut = 0;
          }
        }
        return;
      }
      case 'balance_reset':
        this.balance = Number(p.balance);
        this.closed.length = 0;
        this.dayPnl.clear();
        this.lossStreak = 0;
        this.winsSinceCut = 0;
        this.sizeCutActive = false;
        return;
      case 'engine_halted':
        this.halted = { reason: String(p.reason), at: e.time };
        return;
      case 'engine_resumed':
        this.halted = null;
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

  pendingEntries(): PendingEntry[] {
    return [...this.pending.values()].map((p) => ({ ...p }));
  }

  closedTrades(): ClosedTrade[] {
    return [...this.closed];
  }

  realizedOnDay(t: number): number {
    return this.dayPnl.get(day(t)) ?? 0;
  }

  entriesToday(symbol: string, t: number): number {
    return this.entriesPerSymbolDay.get(`${symbol}|${day(t)}`) ?? 0;
  }

  lastLoss(symbol: string): number | null {
    return this.lastLossAt.get(symbol) ?? null;
  }
}
