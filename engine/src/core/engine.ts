// The engine core (ENGINE_PLAN.md Section 4A). It never reads the system
// clock, the network or timers: time is the close time of the newest candle it
// has been given. Given the same events, candles and commands, it returns the
// same trade events every time, which is what makes replay, restart recovery
// and the later backtest trustworthy.
//
// So far: the clock, sessions, session-end exits, market analysis (trend
// states and zones) and the pullback setup up to a taken or filtered signal.
// Entries and the simulated broker plug in at the marked points in Phase 5.
import type { Candle, Direction, SignalRecord, TradeEvent, TradeEventType } from '../../../shared/types';
import type { EngineConfig } from '../config';
import { SessionCalendar, type SessionInfo } from '../sessions';
import { Portfolio, type CloseOrder, type CloseReason, type Position } from '../portfolio';
import { MarketBook, type SymbolAnalysis } from '../analysis/market';
import { buildContext, type Context } from '../strategy/context';
import { armedStillValid, planTrade, tryArm, tryConfirm, type Armed, type Confirmation } from '../strategy/pullback';
import { runFilters } from '../filters';
import { scoreSignal } from '../scoring';

const DIRECTIONS: Direction[] = ['long', 'short'];
/** Entry-window blocks that end an armed setup; a funding pause only delays it. */
const WINDOW_CLOSED = new Set(['outside_sessions', 'session_ending', 'weekend']);

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
  private readonly armed = new Map<string, Armed>();
  private universe = new Set<string>();
  private readonly funding = new Map<string, number>();
  private signals: SignalRecord[] = [];

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

  /** Coins setups may arm on (the scanner's shortlist). Armed setups on coins that leave it expire at their next evaluation. */
  setUniverse(symbols: string[]): void {
    this.universe = new Set(symbols);
    for (const [key, a] of this.armed) {
      if (!this.universe.has(a.symbol)) {
        this.armed.delete(key);
        this.signal(a.symbol, a.direction, 'expired', 'left_universe', { armedId: a.id });
      }
    }
  }

  universeSymbols(): string[] {
    return [...this.universe];
  }

  /** Latest funding rate for a symbol, as a fraction per 8h. */
  onFunding(symbol: string, rate: number): void {
    this.funding.set(symbol, rate);
  }

  armedSetups(): Armed[] {
    return [...this.armed.values()];
  }

  /** Signals recorded since the last call, oldest first. */
  takeSignals(): SignalRecord[] {
    const out = this.signals;
    this.signals = [];
    return out;
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
    for (const c of candles) {
      if (c.tf === this.deps.config.timeframes.trigger && this.universe.has(c.symbol)) this.evaluate(c.symbol, t);
    }
    // Phase 5: 1m candles drive stops, the ladder and simulated fills.
    return out;
  }

  /** The pullback setup for one symbol at a 15m close: expire, confirm, or arm. */
  private evaluate(symbol: string, t: number): void {
    const ctx = buildContext(this.market, symbol, t, this.deps.config, this.funding.get(symbol) ?? null);
    if (!ctx) return;
    const block = this.sessions.entryBlock(t);
    const windowClosed = block !== null && WINDOW_CLOSED.has(block);
    const inPosition = this.portfolio.positions().some((p) => p.symbol === symbol);
    for (const dir of DIRECTIONS) {
      const key = `${symbol}|${dir}`;
      const armed = this.armed.get(key);
      if (armed) {
        const why = armedStillValid(ctx, armed, windowClosed);
        if (why) {
          this.armed.delete(key);
          this.signal(symbol, dir, 'expired', why, { armedId: armed.id, price: ctx.price });
        } else {
          const conf = tryConfirm(ctx, armed);
          if (conf) {
            this.armed.delete(key);
            this.check(ctx, armed, conf, block);
          }
          continue;
        }
      }
      if (windowClosed || inPosition) continue;
      const fresh = tryArm(ctx, dir);
      if (fresh) {
        this.armed.set(key, fresh);
        this.signal(symbol, dir, 'armed', null, {
          armedId: fresh.id, price: fresh.price, factors: fresh.factors, zone: fresh.zone && { id: fresh.zone.id, low: fresh.zone.low, high: fresh.zone.high, status: fresh.zone.status },
          areaLow: fresh.areaLow, areaHigh: fresh.areaHigh, expiresAt: fresh.expiresAt, trendState: ctx.analysis[dir].state,
        });
      }
    }
  }

  /** A confirmed setup: session, filters, stop, reward/risk and score, in that order. The first failure is the reason. */
  private check(ctx: Context, a: Armed, conf: Confirmation, block: string | null): void {
    const cfg = this.deps.config;
    const filters = runFilters(ctx, a, conf);
    const plan = planTrade(ctx, a);
    const score = scoreSignal(ctx, a, conf, plan);
    const failures = [
      ...(block ? [`session_${block}`] : []),
      ...filters.filter((f) => !f.pass).map((f) => `filter_${f.name}`),
      ...(plan.stopDistancePct > 0 && plan.stopDistancePct <= cfg.exits.max_stop_pct ? [] : ['stop_too_wide']),
      ...(plan.rewardRisk >= cfg.exits.min_rr ? [] : ['rr_too_low']),
      ...(score.total >= cfg.scoring.min_score ? [] : ['score_too_low']),
    ];
    this.signal(a.symbol, a.direction, failures.length ? 'filtered' : 'taken', failures[0] ?? null, {
      armedId: a.id, armedAt: a.armedAt, factors: a.factors, trendState: ctx.analysis[a.direction].state,
      session: this.sessions.ownerAt(ctx.t)?.name ?? null, confirmation: conf, plan, score, filters, failures,
    });
    // Phase 5: a taken signal goes to risk sizing and becomes an entry order.
  }

  private signal(symbol: string, direction: Direction, status: SignalRecord['status'], reason: string | null, payload: Record<string, unknown>): void {
    this.signals.push({ time: this.clock, symbol, setup: 'pullback', direction, status, reason, payload });
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
