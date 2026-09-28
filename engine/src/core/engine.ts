// The engine core (ENGINE_PLAN.md Section 4A). It never reads the system
// clock, the network or timers: time is the close time of the newest candle it
// has been given. Given the same events, candles and commands, it returns the
// same trade events every time, which is what makes replay, restart recovery
// and the later backtest trustworthy.
//
// So far: the clock, sessions, session-end exits and market analysis (trend
// states and zones). Entries and the simulated broker plug in at the marked
// points in later phases.
import type { Candle, TradeEvent, TradeEventType } from '../../../shared/types';
import type { EngineConfig } from '../config';
import { SessionCalendar, type SessionInfo } from '../sessions';
import { Portfolio, type CloseOrder, type CloseReason, type Position } from '../portfolio';
import { MarketBook, type SymbolAnalysis } from '../analysis/market';

export interface EngineDeps {
  config: EngineConfig;
  configHash: string;
  engineVersion: string;
}

export type EngineCommand =
  | { type: 'close'; positionId: string }
  | { type: 'close_all' };

export class CommandError extends Error {}

export class Engine {
  private clock = 0;
  readonly sessions: SessionCalendar;
  private readonly portfolio = new Portfolio();
  private readonly market: MarketBook;

  constructor(private readonly deps: EngineDeps) {
    this.sessions = new SessionCalendar(deps.config.sessions);
    this.market = new MarketBook(deps.config);
  }

  /**
   * Past candles to analyse from, e.g. a symbol's warm-up history. They
   * update the analysis but do not move the clock or trigger any rule.
   */
  seedHistory(candles: Candle[]): void {
    this.market.add(candles);
  }

  analysis(symbol: string): SymbolAnalysis | null {
    return this.market.get(symbol);
  }

  analysedSymbols(): string[] {
    return this.market.symbols();
  }

  /** Rebuilds state from the event log and the clock saved with it. */
  restore(events: TradeEvent[], clock: number): void {
    for (const e of events) this.portfolio.apply(e);
    this.clock = clock;
  }

  /** Engine time: close time of the newest candle processed. 0 before the first. */
  now(): number {
    return this.clock;
  }

  positions(): Position[] {
    return this.portfolio.positions();
  }

  sessionInfo(): SessionInfo {
    return this.sessions.info(this.clock);
  }

  /**
   * Processes closed candles in engine order (compareCandles). Candles closing
   * before the engine clock were already processed and are skipped, so a
   * replay that overlaps what was processed is harmless.
   */
  onCandles(batch: Candle[]): TradeEvent[] {
    const out: TradeEvent[] = [];
    // One close time at a time, so a catch-up over hours sees the market
    // exactly as it was at each close, as if it had been running live.
    let i = 0;
    while (i < batch.length) {
      const t = batch[i].closeTime;
      let j = i;
      while (j < batch.length && batch[j].closeTime === t) j++;
      if (t >= this.clock) out.push(...this.onClose(t, batch.slice(i, j)));
      i = j;
    }
    return out;
  }

  /** Everything that closed at time `t`, larger timeframes first. */
  private onClose(t: number, candles: Candle[]): TradeEvent[] {
    const out: TradeEvent[] = [];
    this.market.add(candles);
    if (t > this.clock) {
      this.clock = t;
      out.push(...this.onTime());
    }
    // Later phases: armed setups confirmed on 15m closes; 1m candles drive
    // stops, the ladder and simulated fills.
    return out;
  }

  /** Commands act at the engine's current time, never the wall clock. */
  onCommand(cmd: EngineCommand): TradeEvent[] {
    switch (cmd.type) {
      case 'close': {
        const pos = this.portfolio.get(cmd.positionId);
        if (!pos) throw new CommandError(`No open position ${cmd.positionId}`);
        if (pos.pendingClose) return [];
        return [this.closeOrder(pos, 'manual')];
      }
      case 'close_all':
        return this.portfolio.positions().filter((p) => !p.pendingClose).map((p) => this.closeOrder(p, 'kill'));
    }
  }

  /** Time-driven rules, run once each time the clock moves forward. */
  private onTime(): TradeEvent[] {
    const out: TradeEvent[] = [];
    if (this.deps.config.sessions.exit_at_session_end) {
      for (const p of this.portfolio.positions()) {
        if (!p.pendingClose && p.session && this.clock >= p.session.closeTime) out.push(this.closeOrder(p, 'session_end'));
      }
    }
    return out;
  }

  private closeOrder(p: Position, reason: CloseReason): TradeEvent {
    const payload: CloseOrder = { action: 'close', orderType: 'market', reason };
    return this.emit('order_placed', p.id, p.symbol, { ...payload, session: p.session?.name ?? null });
  }

  /** Records an event the engine produced and applies it to its own state. */
  private emit(type: TradeEventType, positionId: string | null, symbol: string | null, payload: Record<string, unknown>): TradeEvent {
    const e: TradeEvent = {
      time: this.clock, positionId, symbol, type, payload,
      engineVersion: this.deps.engineVersion, configHash: this.deps.configHash,
    };
    this.portfolio.apply(e);
    return e;
  }
}
