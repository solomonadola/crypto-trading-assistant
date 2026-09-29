// The engine core (ENGINE_PLAN.md Section 4A). It never reads the system
// clock, the network or timers: time is the close time of the newest candle it
// has been given. Given the same events, candles and commands, it returns the
// same trade events every time, which is what makes replay, restart recovery
// and the later backtest trustworthy.
//
// At each close time, in this order: market analysis; time rules (session
// ends, funding, stale entries); 1m candles (fills, stops, targets); the
// daily loss limit and kill switch; then 15m rules (trade management, then the
// pullback setup). The 1m candle that ends at a 15m close happened before
// that close, so it is settled first.
import type {
  AccountSummary, Candle, ClosedTradeView, Direction, ShadowResult, SignalRecord, TradeEvent, TradeEventType, TradeIdea,
} from '../../../shared/types';
import { TIMEFRAME_MS } from '../../../shared/types';
import type { EngineConfig } from '../config';
import { SessionCalendar, type SessionInfo } from '../sessions';
import { Portfolio, type CloseOrder, type CloseReason, type EntryFill, type OpenOrder, type Position, type SetupName } from '../portfolio';
import { MarketBook, type SymbolAnalysis } from '../analysis/market';
import { buildContext, lastOf, sign, type Context } from '../strategy/context';
import { armedStillValid, planTrade, tryArm, tryConfirm, type Armed, type Confirmation, type TradePlan } from '../strategy/pullback';
import { runFilters } from '../filters';
import { scoreSignal } from '../scoring';
import { decideEntry, equityOf, riskAtStop, unrealized, type SymbolRules } from '../risk';
import { manage } from '../exits';
import { fee, grossPnl, liquidationPrice, marketFill, roundQty, stopFill, targetFill } from '../sim/broker';
import { tradeIdea } from '../analysis/levels';
import { meanReversion, momentumContinuation, openingRangeBreakout, type AltSignal, type MeanRevParams, type MomentumParams, type OrbParams } from '../strategy/alternatives';

const DIRECTIONS: Direction[] = ['long', 'short'];
/** Entry-window blocks that end an armed setup; a funding pause only delays it. */
const WINDOW_CLOSED = new Set(['outside_sessions', 'session_ending', 'weekend']);
const FUNDING_EVERY = 8 * 3_600_000;
const DAY = 86_400_000;
/** How long a confirmation shows on the trade idea after it happened (longer while in the trade). */
const CONFIRMED_SHOWN_MS = 3_600_000;

export interface EngineDeps {
  config: EngineConfig;
  configHash: string;
  engineVersion: string;
  /**
   * Backtest research: every confirmed setup becomes a trade of this fixed
   * size, whatever its checks said and with no risk limits, so each setup's
   * outcome can be measured and any combination of checks tested afterwards.
   */
  research?: {
    notional: number;
    /** Which setup to research; the default is the pullback. The others are experiments (strategy/alternatives.ts). */
    setup?: SetupName;
    params?: OrbParams | MomentumParams | MeanRevParams;
  };
  /** Compute the chart-reading analysis (default true). */
  analysisExtras?: boolean;
}

export type EngineCommand =
  | { type: 'close'; positionId: string }
  | { type: 'close_all' }
  /** Close everything and stop opening trades until resumed. */
  | { type: 'kill'; reason?: string }
  /** Stop opening trades; open positions keep being managed. */
  | { type: 'pause'; reason?: string }
  | { type: 'resume' }
  | { type: 'reset_balance'; balance?: number };

export class CommandError extends Error {}

interface Shadow {
  signalTime: number;
  symbol: string;
  direction: Direction;
  signalStatus: 'taken' | 'filtered';
  signalReason: string | null;
  plan: TradePlan;
  sessionClose: number;
}

export class Engine {
  private clock = 0;
  readonly sessions: SessionCalendar;
  private readonly portfolio: Portfolio;
  private readonly market: MarketBook;
  private readonly armed = new Map<string, Armed>();
  /** The latest confirmation per symbol|direction, for the trade ideas' stage. */
  private readonly confirmed = new Map<string, { direction: Direction; time: number; taken: boolean; reason: string | null }>();
  private universe = new Set<string>();
  private readonly funding = new Map<string, number>();
  private readonly rules = new Map<string, SymbolRules>();
  private signals: SignalRecord[] = [];
  private shadows: Shadow[] = [];
  private shadowResults: ShadowResult[] = [];
  /** Opening-range breakouts already taken, per coin and session. */
  private readonly orbTaken = new Set<string>();
  private peakEquity: number;
  private dayStart = { day: -1, equity: 0 };
  private readonly cfg: EngineConfig;

  constructor(private readonly deps: EngineDeps) {
    this.cfg = deps.config;
    this.sessions = new SessionCalendar(deps.config.sessions);
    this.market = new MarketBook(deps.config, deps.analysisExtras ?? true);
    this.portfolio = new Portfolio(deps.config.starting_balance_usdt, deps.config.risk.losing_streak_size_cut);
    this.peakEquity = deps.config.starting_balance_usdt;
  }

  // ---------------------------------------------------------------- inputs

  /** Past candles to analyse from, e.g. warm-up history. They update the analysis but do not move the clock or trigger any rule. */
  seedHistory(candles: Candle[]): void {
    this.market.add(candles);
  }

  /** Rebuilds state from the event log and the clock saved with it. */
  restore(events: TradeEvent[], clock: number): void {
    for (const e of events) this.portfolio.apply(e);
    this.clock = clock;
    this.peakEquity = Math.max(this.peakEquity, this.portfolio.balance);
  }

  /** Coins setups may arm on (the scanner's shortlist). Armed setups on coins that leave it expire. */
  setUniverse(symbols: string[]): void {
    this.universe = new Set(symbols);
    for (const [key, a] of this.armed) {
      if (!this.universe.has(a.symbol)) {
        this.armed.delete(key);
        this.signal(a.symbol, a.direction, 'expired', 'left_universe', { armedId: a.id });
      }
    }
  }

  /** Latest funding rate for a symbol, as a fraction per 8h. */
  onFunding(symbol: string, rate: number): void {
    this.funding.set(symbol, rate);
  }

  /** Lot size and minimum order value per symbol, from the exchange. */
  setSymbolRules(rules: Record<string, SymbolRules>): void {
    for (const [s, r] of Object.entries(rules)) this.rules.set(s, r);
  }

  // ---------------------------------------------------------------- outputs

  now(): number {
    return this.clock;
  }

  positions(): Position[] {
    return this.portfolio.positions();
  }

  analysis(symbol: string): SymbolAnalysis | null {
    return this.market.get(symbol);
  }

  analysedSymbols(): string[] {
    return this.market.symbols();
  }

  universeSymbols(): string[] {
    return [...this.universe];
  }

  armedSetups(): Armed[] {
    return [...this.armed.values()];
  }

  /** Key levels and a suggested plan for a coin, as of its last 15m close. Null without enough history. */
  tradeIdea(symbol: string): TradeIdea | null {
    const last15 = this.market.recent(symbol, this.cfg.timeframes.trigger, 1)[0];
    if (!last15) return null;
    const at15 = buildContext(this.market, symbol, last15.closeTime, this.cfg, this.funding.get(symbol) ?? null);
    if (!at15) return null;
    // Analysis as of the last 15m close; distances and "in the entry area" from the latest minute's price.
    const live = this.market.recent(symbol, this.cfg.timeframes.exits, 1)[0];
    const ctx = live && live.closeTime > at15.t ? { ...at15, price: live.close } : at15;
    const open = [...this.portfolio.positions(), ...this.portfolio.pendingEntries()].filter((p) => p.symbol === symbol).map((p) => p.side);
    const recent = DIRECTIONS.map((d) => this.confirmed.get(`${symbol}|${d}`))
      .filter((c): c is NonNullable<typeof c> => !!c && (this.clock - c.time <= CONFIRMED_SHOWN_MS || open.includes(c.direction)));
    return tradeIdea(ctx, {
      armed: this.armedSetups().filter((a) => a.symbol === symbol).map((a) => a.direction),
      confirmed: recent,
      inTrade: open,
      entryBlock: this.sessions.entryBlock(this.clock || last15.closeTime),
    });
  }

  sessionInfo(): SessionInfo {
    return this.sessions.info(this.clock);
  }

  /** Signals recorded since the last call, oldest first. */
  takeSignals(): SignalRecord[] {
    const out = this.signals;
    this.signals = [];
    return out;
  }

  /** Shadow trades resolved since the last call. */
  takeShadowResults(): ShadowResult[] {
    const out = this.shadowResults;
    this.shadowResults = [];
    return out;
  }

  closedTrades(): ClosedTradeView[] {
    return this.portfolio.closedTrades();
  }

  account(): AccountSummary {
    const priceOf = (s: string) => this.priceOf(s);
    const positions = this.portfolio.positions();
    const equity = equityOf(this.portfolio, priceOf);
    return {
      time: this.clock,
      startingBalance: this.cfg.starting_balance_usdt,
      balance: this.portfolio.balance,
      equity,
      unrealized: equity - this.portfolio.balance,
      exposure: positions.reduce((s, p) => s + p.qty * (priceOf(p.symbol) ?? p.entryPrice), 0),
      openRisk: positions.reduce((s, p) => s + riskAtStop(p), 0),
      dayPnl: this.dayStart.day === Math.floor(this.clock / DAY) ? equity - this.dayStart.equity : 0,
      peakEquity: Math.max(this.peakEquity, equity),
      drawdownPct: this.peakEquity > 0 ? Math.max(0, (1 - equity / this.peakEquity) * 100) : 0,
      halted: this.portfolio.halted,
      positions: positions.map((p) => {
        const price = priceOf(p.symbol);
        const u = unrealized(p, price);
        return {
          id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, entryPrice: p.entryPrice, stop: p.stop, target: p.target,
          price, unrealized: u, pnlPct: price === null ? 0 : sign(p.side) * (price / p.entryPrice - 1) * 100,
          openedAt: p.openedAt, sessionName: p.session?.name ?? null, sessionClose: p.session?.closeTime ?? null,
          ladderStep: p.ladderStep, partialDone: p.partialDone, pendingClose: p.pendingClose?.reason ?? null,
          fees: p.fees, funding: p.funding, realized: p.realized,
        };
      }),
      pendingEntries: this.portfolio.pendingEntries().map((e) => ({ positionId: e.positionId, symbol: e.symbol, side: e.side, notional: e.notional, placedAt: e.placedAt })),
    };
  }

  // ---------------------------------------------------------------- processing

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
        return this.closeAll('kill');
      case 'kill': {
        const out = this.closeAll('kill');
        if (!this.portfolio.halted) out.push(this.emit('engine_halted', null, null, { reason: cmd.reason ?? 'manual kill' }));
        return out;
      }
      case 'pause':
        return this.portfolio.halted ? [] : [this.emit('engine_halted', null, null, { reason: cmd.reason ?? 'paused' })];
      case 'resume':
        if (!this.portfolio.halted) return [];
        this.peakEquity = equityOf(this.portfolio, (s) => this.priceOf(s));
        return [this.emit('engine_resumed', null, null, {})];
      case 'reset_balance': {
        if (this.portfolio.positions().length || this.portfolio.pendingEntries().length) {
          throw new CommandError('Close all positions before resetting the balance');
        }
        const balance = cmd.balance ?? this.cfg.starting_balance_usdt;
        this.peakEquity = balance;
        this.dayStart = { day: Math.floor(this.clock / DAY), equity: balance };
        return [this.emit('balance_reset', null, null, { balance })];
      }
    }
  }

  /** Everything that closed at time `t`, larger timeframes first. */
  private onClose(t: number, candles: Candle[]): TradeEvent[] {
    const out: TradeEvent[] = [];
    this.market.add(candles);
    if (t > this.clock) {
      this.clock = t;
      out.push(...this.onTime());
    }
    // The exits timeframe (1m live; 5m in a backtest on 5m data) drives fills, stops and targets.
    for (const c of candles) if (c.tf === this.cfg.timeframes.exits) out.push(...this.onMinute(c));
    out.push(...this.guardrails());
    for (const c of candles) {
      if (c.tf !== this.cfg.timeframes.trigger) continue;
      const managed = this.portfolio.positions().filter((p) => p.symbol === c.symbol);
      const inUniverse = this.universe.has(c.symbol);
      if (!managed.length && !inUniverse) continue;
      const ctx = buildContext(this.market, c.symbol, t, this.cfg, this.funding.get(c.symbol) ?? null);
      if (!ctx) continue;
      for (const p of managed) out.push(...this.managePosition(ctx, p));
      const setup = this.deps.research?.setup ?? 'pullback';
      if (inUniverse) out.push(...(setup === 'pullback' ? this.evaluate(ctx) : this.evaluateAlternative(ctx, setup)));
    }
    return out;
  }

  /** Time-driven rules, run once each time the clock moves forward. */
  private onTime(): TradeEvent[] {
    const out: TradeEvent[] = [];
    const t = this.clock;
    if (this.cfg.sessions.exit_at_session_end) {
      for (const p of this.portfolio.positions()) {
        if (!p.pendingClose && p.session && t >= p.session.closeTime) out.push(this.closeOrder(p, 'session_end'));
      }
    }
    // Funding at 00:00, 08:00 and 16:00 UTC, on positions open at that moment.
    if (this.cfg.sim.charge_funding && t % FUNDING_EVERY === 0) {
      for (const p of this.portfolio.positions()) {
        const rate = this.funding.get(p.symbol);
        const price = this.priceOf(p.symbol);
        if (rate === undefined || price === null) continue;
        const notional = p.qty * price;
        out.push(this.emit('funding_charged', p.id, p.symbol, { rate, notional, amount: -sign(p.side) * notional * rate }));
      }
    }
    // Entries with no price to fill at are cancelled.
    for (const e of this.portfolio.pendingEntries()) {
      if (t - e.placedAt > this.cfg.sim.entry_timeout_min * 60_000) {
        out.push(this.emit('order_cancelled', e.positionId, e.symbol, { reason: 'no_price', placedAt: e.placedAt }));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 1m: fills, stops, targets

  private onMinute(c: Candle): TradeEvent[] {
    const out: TradeEvent[] = [];
    const costs = this.cfg.sim;
    for (const e of this.portfolio.pendingEntries()) {
      if (e.symbol === c.symbol && e.placedAt <= c.openTime) out.push(...this.fillEntry(e, c));
    }
    for (const p of this.portfolio.positions()) {
      if (p.symbol !== c.symbol) continue;
      if (p.pendingClose && p.pendingClose.placedAt <= c.openTime) {
        out.push(this.closePosition(p, marketFill(p.side, 'close', c.open, costs), p.pendingClose.reason));
        continue;
      }
      if (p.openedAt > c.openTime) continue;
      // Stop first: when a candle reaches both, assume the worse happened first.
      if (p.liqPrice !== null && sign(p.side) * (p.liqPrice - p.stop) >= 0 && (p.side === 'long' ? c.low <= p.liqPrice : c.high >= p.liqPrice)) {
        out.push(this.emit('liquidated', p.id, p.symbol, { price: p.liqPrice, qty: p.qty, pnl: grossPnl(p.side, p.entryPrice, p.liqPrice, p.qty), fee: 0 }));
        continue;
      }
      const stopPrice = stopFill(p.side, p.stop, c, costs);
      if (stopPrice !== null) {
        out.push(this.closePosition(p, stopPrice, 'stop'));
        continue;
      }
      if (p.target !== null && !(this.cfg.exits.mode === 'partial_ladder' && p.partialDone)) {
        const tp = targetFill(p.side, p.target, c, costs);
        if (tp !== null) out.push(...this.takeTarget(p, tp));
      }
    }
    this.resolveShadows(c);
    return out;
  }

  private fillEntry(e: ReturnType<Portfolio['pendingEntries']>[number], c: Candle): TradeEvent[] {
    const cfg = this.cfg;
    const price = marketFill(e.side, 'open', c.open, cfg.sim);
    const s = sign(e.side);
    const cancel = (reason: string, extra: Record<string, unknown> = {}) =>
      [this.emit('order_cancelled', e.positionId, e.symbol, { reason, price, ...extra })];
    if (s * (price - e.stop) <= 0) return cancel('filled_beyond_stop');

    // Size from the fill: the loss at the stop must still fit the cap.
    const equity = equityOf(this.portfolio, (x) => this.priceOf(x));
    const lossPct = (Math.abs(price - e.stop) / price) * 100 + 2 * (cfg.sim.taker_fee_pct + cfg.sim.slippage_pct);
    const maxNotional = ((cfg.allocation.max_loss_per_trade_pct / 100) * equity / lossPct) * 100;
    const rules = this.rules.get(e.symbol);
    const qty = roundQty((this.deps.research ? e.notional : Math.min(e.notional, maxNotional)) / price, rules?.stepSize ?? 0);
    if (qty <= 0 || qty < (rules?.minQty ?? 0) || qty * price < (rules?.minNotional ?? 5)) return cancel('size_too_small', { qty });

    const liqPrice = liquidationPrice(e.side, price, cfg.leverage, cfg.sim.maintenance_margin_pct);
    if (s * (e.stop - liqPrice) <= 0) return cancel('liquidation_before_stop', { liqPrice });

    const fill: EntryFill = {
      role: 'entry', side: e.side, qty, price, stop: e.stop, target: e.target,
      fee: fee(qty * price, cfg.sim), session: this.sessions.ownerAt(e.placedAt),
      leverage: cfg.leverage, liqPrice, chochLevel: e.chochLevel, signalId: e.signalId, setup: e.setup ?? 'pullback',
    };
    // Recorded at the candle's open: the moment the fill happened.
    return [this.emit('order_filled', e.positionId, e.symbol, { ...fill, notional: qty * price, margin: (qty * price) / cfg.leverage }, c.openTime)];
  }

  private takeTarget(p: Position, price: number): TradeEvent[] {
    const cfg = this.cfg;
    if (cfg.exits.mode === 'fixed') return [this.closePosition(p, price, 'target')];
    // partial_ladder: close part at the first objective, protect the rest at breakeven plus fees.
    const rules = this.rules.get(p.symbol);
    const qty = roundQty(p.qty * (cfg.exits.partial_close_pct / 100), rules?.stepSize ?? 0);
    if (qty <= 0 || qty >= p.qty) return [this.closePosition(p, price, 'target')];
    const out = [this.emit('partial_closed', p.id, p.symbol, {
      qty, price, pnl: grossPnl(p.side, p.entryPrice, price, qty), fee: fee(qty * price, cfg.sim), reason: 'target',
    })];
    const be = p.entryPrice * (1 + (sign(p.side) * cfg.exits.breakeven_fee_buffer_pct) / 100);
    if (sign(p.side) * (be - p.stop) > 0) out.push(this.emit('stop_moved', p.id, p.symbol, { stop: be, reason: 'breakeven after partial' }));
    return out;
  }

  private closePosition(p: Position, price: number, reason: CloseReason): TradeEvent {
    return this.emit('position_closed', p.id, p.symbol, {
      qty: p.qty, price, pnl: grossPnl(p.side, p.entryPrice, price, p.qty), fee: fee(p.qty * price, this.cfg.sim), reason,
      holdMinutes: Math.round((this.clock - p.openedAt) / 60_000),
    });
  }

  // ---------------------------------------------------------------- account-wide limits

  /** Daily loss limit bookkeeping and the drawdown kill switch. */
  private guardrails(): TradeEvent[] {
    if (this.deps.research) return [];
    const equity = equityOf(this.portfolio, (s) => this.priceOf(s));
    const today = Math.floor(this.clock / DAY);
    if (this.dayStart.day !== today) this.dayStart = { day: today, equity };
    if (equity > this.peakEquity) this.peakEquity = equity;
    const drawdown = (1 - equity / this.peakEquity) * 100;
    if (!this.portfolio.halted && drawdown >= this.cfg.risk.max_drawdown_kill_pct) {
      const out = this.closeAll('kill');
      out.push(this.emit('engine_halted', null, null, { reason: `drawdown ${drawdown.toFixed(1)}% from peak`, equity, peakEquity: this.peakEquity }));
      return out;
    }
    return [];
  }

  private closeAll(reason: CloseReason): TradeEvent[] {
    const out = this.portfolio.positions().filter((p) => !p.pendingClose).map((p) => this.closeOrder(p, reason));
    for (const e of this.portfolio.pendingEntries()) out.push(this.emit('order_cancelled', e.positionId, e.symbol, { reason }));
    return out;
  }

  // ---------------------------------------------------------------- 15m: management and setups

  private managePosition(ctx: Context, p: Position): TradeEvent[] {
    if (p.pendingClose || p.openedAt > ctx.t) return [];
    const since = ctx.m15.candles.filter((c) => c.openTime >= p.openedAt);
    const peakPct = Math.max(0, ...since.map((c) => sign(p.side) * (c.close / p.entryPrice - 1) * 100));
    const out: TradeEvent[] = [];
    for (const a of manage({ ctx, pos: p, peakPct, candlesSinceEntry: since.length })) {
      if (a.type === 'close') out.push(this.closeOrder(p, a.reason));
      else if (a.type === 'stop') out.push(this.emit('stop_moved', p.id, p.symbol, { stop: a.stop, reason: a.reason, ...(a.ladderStep !== undefined ? { ladderStep: a.ladderStep } : {}) }));
      else if (a.type === 'close_half') {
        const qty = roundQty(p.qty / 2, this.rules.get(p.symbol)?.stepSize ?? 0);
        const price = marketFill(p.side, 'close', ctx.price, this.cfg.sim);
        if (qty > 0) out.push(this.emit('partial_closed', p.id, p.symbol, { qty, price, pnl: grossPnl(p.side, p.entryPrice, price, qty), fee: fee(qty * price, this.cfg.sim), reason: a.reason }));
      }
    }
    return out;
  }

  /** The pullback setup for one symbol at a 15m close: expire, confirm, or arm. */
  private evaluate(ctx: Context): TradeEvent[] {
    const out: TradeEvent[] = [];
    const { symbol, t } = ctx;
    const block = this.sessions.entryBlock(t);
    const windowClosed = block !== null && WINDOW_CLOSED.has(block);
    const busy = !this.deps.research && (this.portfolio.positions().some((p) => p.symbol === symbol) || this.portfolio.pendingEntries().some((e) => e.symbol === symbol));
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
            out.push(...this.check(ctx, armed, conf, block));
          }
          continue;
        }
      }
      if (windowClosed || busy) continue;
      const fresh = tryArm(ctx, dir);
      if (fresh) {
        this.armed.set(key, fresh);
        this.confirmed.delete(key);
        this.signal(symbol, dir, 'armed', null, {
          armedId: fresh.id, price: fresh.price, factors: fresh.factors, zone: fresh.zone && { id: fresh.zone.id, low: fresh.zone.low, high: fresh.zone.high, status: fresh.zone.status },
          areaLow: fresh.areaLow, areaHigh: fresh.areaHigh, expiresAt: fresh.expiresAt, trendState: ctx.analysis[dir].state,
          // Entry, stop and target if it confirmed now; the real plan is made at the confirmation close.
          planEstimate: planTrade(ctx, fresh),
        });
      }
    }
    return out;
  }

  /** Research only: an alternative setup, under the session rule, recorded like a taken pullback signal. */
  private evaluateAlternative(ctx: Context, setup: Exclude<SetupName, 'pullback'>): TradeEvent[] {
    const research = this.deps.research!;
    if (this.sessions.entryBlock(ctx.t)) return [];
    const owner = this.sessions.ownerAt(ctx.t);
    const orbKey = owner ? `${ctx.symbol}|${owner.name}|${owner.openTime}` : '';
    let sig: AltSignal | null = null;
    if (setup === 'orb') sig = openingRangeBreakout(ctx, owner, research.params as OrbParams, this.orbTaken.has(orbKey));
    else if (setup === 'momentum') sig = momentumContinuation(ctx, research.params as MomentumParams);
    else sig = meanReversion(ctx, research.params as MeanRevParams);
    if (!sig) return [];
    if (setup === 'orb') this.orbTaken.add(orbKey);
    const id = `${ctx.symbol}-${setup}-${ctx.t}`;
    const risk = Math.abs(ctx.price - sig.stop);
    const plan = {
      entry: ctx.price, stop: sig.stop, target: sig.target, targetSource: setup,
      stopDistancePct: (risk / ctx.price) * 100, rewardRisk: Math.abs(sig.target - ctx.price) / risk,
    };
    this.signals.push({
      time: this.clock, symbol: ctx.symbol, setup: 'pullback', direction: sig.direction, status: 'taken', reason: null,
      payload: { armedId: id, setup, plan, score: { total: 0, points: {} }, failures: [], filters: [], detail: sig.detail, session: owner?.name ?? null },
    });
    const order: OpenOrder = {
      action: 'open', orderType: 'market', side: sig.direction, notional: research.notional, stop: sig.stop, target: sig.target,
      chochLevel: sig.level, signalId: id, refPrice: ctx.price, setup,
    };
    return [this.emit('order_placed', `${id}-pos`, ctx.symbol, { ...order, plan })];
  }

  /** A confirmed setup: session, filters, stop, reward/risk, score, then risk. The first failure is the reason. */
  private check(ctx: Context, a: Armed, conf: Confirmation, block: string | null): TradeEvent[] {
    const cfg = this.cfg;
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
    const lastHour = this.market.recent(a.symbol, '1h', 1)[0];
    const risk = failures.length || this.deps.research ? null : decideEntry({
      config: cfg, t: ctx.t, symbol: a.symbol, side: a.direction, entry: plan.entry, stop: plan.stop,
      portfolio: this.portfolio, priceOf: (s) => this.priceOf(s), dayStartEquity: this.dayStart.equity || this.portfolio.balance,
      lastHourVolume: lastHour ? lastHour.quoteVolume : null, rules: this.rules.get(a.symbol) ?? null, score: score.total,
    });
    if (risk && !risk.ok) failures.push(risk.reason!);
    const status = failures.length ? 'filtered' : 'taken';
    this.confirmed.set(`${a.symbol}|${a.direction}`, { direction: a.direction, time: ctx.t, taken: status === 'taken', reason: failures[0] ?? null });
    this.signal(a.symbol, a.direction, status, failures[0] ?? null, {
      armedId: a.id, armedAt: a.armedAt, factors: a.factors, trendState: ctx.analysis[a.direction].state,
      session: this.sessions.ownerAt(ctx.t)?.name ?? null, confirmation: conf, plan, score, filters, failures, risk,
    });

    // Every confirmed signal with a sane plan is followed as a shadow trade.
    const owner = this.sessions.ownerAt(ctx.t);
    if (plan.stopDistancePct > 0) {
      this.shadows.push({
        signalTime: ctx.t, symbol: a.symbol, direction: a.direction, signalStatus: status, signalReason: failures[0] ?? null, plan,
        sessionClose: owner?.closeTime ?? ctx.t + DAY,
      });
    }
    if (this.deps.research) {
      if (!(plan.stopDistancePct > 0) || block) return [];
      const order: OpenOrder = {
        action: 'open', orderType: 'market', side: a.direction, notional: this.deps.research.notional, stop: plan.stop,
        target: cfg.exits.mode === 'ladder' ? null : plan.target, chochLevel: conf.level, signalId: a.id, refPrice: plan.entry,
      };
      return [this.emit('order_placed', `${a.id}-pos`, a.symbol, { ...order, plan, score: score.total })];
    }
    if (status !== 'taken') return [];

    const target = cfg.exits.mode === 'ladder' ? null : plan.target;
    const order: OpenOrder = {
      action: 'open', orderType: 'market', side: a.direction, notional: risk!.notional, stop: plan.stop, target,
      chochLevel: conf.level, signalId: a.id, refPrice: plan.entry,
    };
    return [this.emit('order_placed', `${a.id}-pos`, a.symbol, { ...order, plan, score: score.total })];
  }

  // ---------------------------------------------------------------- shadow trades

  private resolveShadows(c: Candle): void {
    const costs = this.cfg.sim;
    const costPct = 2 * (costs.taker_fee_pct + costs.slippage_pct);
    this.shadows = this.shadows.filter((sh) => {
      if (sh.symbol !== c.symbol || c.openTime < sh.signalTime) return true;
      const { entry, stop, target } = sh.plan;
      const s = sign(sh.direction);
      const risk = Math.abs(entry - stop);
      let outcome: ShadowResult['outcome'] | null = null;
      let exit = 0;
      if (sh.direction === 'long' ? c.low <= stop : c.high >= stop) { outcome = 'stop'; exit = stop; }
      else if (sh.direction === 'long' ? c.high >= target : c.low <= target) { outcome = 'target'; exit = target; }
      else if (c.closeTime >= sh.sessionClose) { outcome = 'session_end'; exit = c.close; }
      if (!outcome) return true;
      this.shadowResults.push({
        time: c.closeTime, signalTime: sh.signalTime, symbol: sh.symbol, direction: sh.direction,
        signalStatus: sh.signalStatus, signalReason: sh.signalReason, entry, stop, target, exit, outcome,
        r: (s * (exit - entry) - (costPct / 100) * entry) / risk,
      });
      return false;
    });
  }

  // ---------------------------------------------------------------- helpers

  /** Latest known price: the newest 1m close. */
  private priceOf(symbol: string): number | null {
    const c = this.market.recent(symbol, this.cfg.timeframes.exits, 1)[0];
    return c ? c.close : null;
  }

  private closeOrder(p: Position, reason: CloseReason): TradeEvent {
    const payload: CloseOrder = { action: 'close', orderType: 'market', reason };
    return this.emit('order_placed', p.id, p.symbol, { ...payload, session: p.session?.name ?? null });
  }

  private signal(symbol: string, direction: Direction, status: SignalRecord['status'], reason: string | null, payload: Record<string, unknown>): void {
    this.signals.push({ time: this.clock, symbol, setup: 'pullback', direction, status, reason, payload });
  }

  /** Records an event the engine produced and applies it to its own state. */
  private emit(type: TradeEventType, positionId: string | null, symbol: string | null, payload: Record<string, unknown>, time = this.clock): TradeEvent {
    const e: TradeEvent = {
      time, positionId, symbol, type, payload,
      engineVersion: this.deps.engineVersion, configHash: this.deps.configHash,
    };
    this.portfolio.apply(e);
    return e;
  }
}

export { lastOf, TIMEFRAME_MS };
