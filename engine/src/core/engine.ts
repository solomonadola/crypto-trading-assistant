// The engine core (ENGINE_PLAN.md Section 4A). It never reads the system
// clock, the network or timers: time is the close time of the newest candle it
// has been given. Given the same events, candles and commands, it returns the
// same trade events every time, which is what makes replay and restart
// recovery trustworthy.
//
// At each close time, in this order: market analysis; time rules (session
// ends, funding, stale entries); 1m candles (fills, stops, targets); the
// daily loss limit and kill switch; then 15m rules (trade management, then the
// pullback setup). The 1m candle that ends at a 15m close happened before
// that close, so it is settled first.
import type {
  AccountSummary, Candle, ClosedTradeView, Direction, ShadowResult, SignalRecord, Timeframe, TradeEvent, TradeEventType, TradeIdea,
} from '../../../shared/types';
import { TIMEFRAME_MS } from '../../../shared/types';
import type { EngineConfig } from '../config';
import { SessionCalendar, type SessionInfo } from '../sessions';
import { Portfolio, type CloseOrder, type CloseReason, type EntryFill, type OpenOrder, type Position } from '../portfolio';
import { MarketBook, type SymbolAnalysis } from '../analysis/market';
import { buildContext, lastOf, sign, type Context } from '../strategy/context';
import { armedStillValid, planTrade, tryArm, tryConfirm, type Armed, type Confirmation, type TradePlan } from '../strategy/pullback';
import { funding, runFilters } from '../filters';
import { scoreSignal } from '../scoring';
import { decideEntry, equityOf, riskAtStop, unrealized, type SymbolRules } from '../risk';
import { manage } from '../exits';
import { fee, grossPnl, liquidationPrice, marketFill, roundQty, stopFill, targetFill } from '../sim/broker';
import { tradeIdea } from '../analysis/levels';
import { sessionSweep } from '../strategy/sessionSweep';
import { armZoneSweep, confirmZoneSweep, zoneSweepStillValid, type ZoneSweepConfirmation } from '../strategy/zoneSweep';
import { armHtfPoi, chochOn, htfPointsOfInterest, htfPoiStillValid, type HtfPoi } from '../strategy/htfPoi';
import { liquidityPlan } from '../strategy/smc';
import { liquidityLevels, type LiquidityLevel } from '../analysis/liquidity';
import { costsFor, netRewardRisk, roundTripPct, speedSettings, type SpeedGroup } from '../speed';

const DIRECTIONS: Direction[] = ['long', 'short'];
/** Entry-window blocks that end an armed setup; a funding pause only delays it. */
const WINDOW_CLOSED = new Set(['outside_sessions', 'session_ending', 'weekend']);
const FUNDING_EVERY = 8 * 3_600_000;
const DAY = 86_400_000;

/** A confirmed signal of any model, checked, waiting for risk and the order. */
interface Candidate {
  ctx: Context;
  /** The setup's id: the armed setup's for a pullback; joins its signal records. */
  id: string;
  direction: Direction;
  setup: SignalRecord['setup'];
  plan: TradePlan;
  /** Ranks clean signals after reward:risk: the pullback's score, the sweep's confluence count. */
  score: number;
  failures: string[];
  /** The level the confirmation closed through (classic management's failed-breakout exit). */
  level: number | null;
  /** Model-specific detail for the signal record. */
  payload: Record<string, unknown>;
}
/** How long a confirmation shows on the trade idea after it happened (longer while in the trade). */
const CONFIRMED_SHOWN_MS = 3_600_000;

export interface EngineDeps {
  config: EngineConfig;
  configHash: string;
  engineVersion: string;
}

export type EngineCommand =
  /**
   * With `price` (the mark price when asked) the position closes at once at that price plus slippage, at
   * `time`; without it, at the next 1m candle's open, which never comes while the feed is down.
   */
  | { type: 'close'; positionId: string; price?: number; time?: number }
  | { type: 'close_all' }
  /** Close everything and stop opening trades until resumed; at once at `prices` where given. */
  | { type: 'kill'; reason?: string; prices?: Record<string, number>; time?: number }
  /** Stop opening trades; open positions keep being managed. */
  | { type: 'pause'; reason?: string }
  | { type: 'resume' }
  | { type: 'reset_balance'; balance?: number }
  /**
   * A trade taken by hand: filled at once at `price` (the mark price when asked, plus slippage) and at
   * `time` (the wall clock), sized and limited by the same risk rules as the engine's own trades.
   */
  | { type: 'open'; symbol: string; side: Direction; price: number; time: number; stop: number; target: number | null; note?: string };

export class CommandError extends Error {}

interface Shadow {
  armedId: string;
  /** Price has moved 1R in the trade's favour (recorded once). */
  working: boolean;
  signalTime: number;
  symbol: string;
  direction: Direction;
  signalStatus: 'taken' | 'filtered';
  signalReason: string | null;
  plan: TradePlan;
  /** Followed until this time: the session's end, or the speed group's max hold (Section 18.6). */
  sessionClose: number;
  speed: SpeedGroup;
  setup: SignalRecord['setup'];
}

export class Engine {
  private clock = 0;
  readonly sessions: SessionCalendar;
  private readonly portfolio: Portfolio;
  private readonly market: MarketBook;
  private readonly armed = new Map<string, Armed>();
  /** Model 4's armed setups, by symbol|direction: they confirm on 5m or 15m closes. */
  private readonly htfArmed = new Map<string, Armed>();
  /** Signals that passed every check at this 15m close, waiting to be ranked. */
  private clean: Candidate[] = [];
  /** Liquidity levels a sweep signal came from, with when: one signal per level and direction. */
  private readonly sweepsUsed = new Map<string, number>();
  /** The latest confirmation per symbol|direction, for the trade ideas' stage. */
  private readonly confirmed = new Map<string, { direction: Direction; time: number; taken: boolean; reason: string | null }>();
  private universe = new Set<string>();
  private readonly funding = new Map<string, number>();
  private readonly rules = new Map<string, SymbolRules>();
  private signals: SignalRecord[] = [];
  private shadows: Shadow[] = [];
  private shadowResults: ShadowResult[] = [];
  /** Opening-range breakouts already taken, per coin and session. */
  private peakEquity: number;
  private dayStart = { day: -1, equity: 0 };
  private readonly cfg: EngineConfig;

  constructor(private readonly deps: EngineDeps) {
    this.cfg = deps.config;
    this.sessions = new SessionCalendar(deps.config.sessions);
    this.market = new MarketBook(deps.config, true);
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
    for (const [map, setup] of [[this.armed, this.cfg.models.zone_sweep ? 'zone_sweep' : 'pullback'], [this.htfArmed, 'htf_poi']] as const) {
      for (const [key, a] of map) {
        if (!this.universe.has(a.symbol)) {
          map.delete(key);
          this.signal(a.symbol, a.direction, 'expired', 'left_universe', { armedId: a.id }, setup);
        }
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

  /** Model 4's 4h points of interest for a coin, as of its last 15m close: where it would arm, both ways. */
  htfPoints(symbol: string): { long: HtfPoi[]; short: HtfPoi[] } | null {
    const last15 = this.market.recent(symbol, this.cfg.timeframes.trigger, 1)[0];
    const ctx = last15 ? buildContext(this.market, symbol, last15.closeTime, this.cfg, this.funding.get(symbol) ?? null) : null;
    return ctx ? { long: htfPointsOfInterest(ctx, 'long'), short: htfPointsOfInterest(ctx, 'short') } : null;
  }

  armedSetups(): Armed[] {
    return [...this.armed.values(), ...this.htfArmed.values()];
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
          fees: p.fees, funding: p.funding, realized: p.realized, setup: p.setup, note: p.note ?? null,
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
        if (cmd.price !== undefined && cmd.price > 0) return [this.closeNow(pos, 'manual', cmd.price, cmd.time ?? this.clock)];
        if (pos.pendingClose) return [];
        return [this.closeOrder(pos, 'manual')];
      }
      case 'close_all':
        return this.closeAll('kill');
      case 'kill': {
        const out = this.closeAll('kill', cmd.prices, cmd.time);
        if (!this.portfolio.halted) out.push(this.emit('engine_halted', null, null, { reason: cmd.reason ?? 'manual kill' }));
        return out;
      }
      case 'pause':
        return this.portfolio.halted ? [] : [this.emit('engine_halted', null, null, { reason: cmd.reason ?? 'paused' })];
      case 'resume':
        if (!this.portfolio.halted) return [];
        this.peakEquity = equityOf(this.portfolio, (s) => this.priceOf(s));
        return [this.emit('engine_resumed', null, null, {})];
      case 'open':
        return this.openManual(cmd);
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

  /** A manual trade: the risk rules, then an order and its fill at the given price. */
  private openManual(cmd: Extract<EngineCommand, { type: 'open' }>): TradeEvent[] {
    const { symbol, side, price, stop, target } = cmd;
    if (!this.clock) throw new CommandError('The engine has not started yet');
    if (![price, stop].every((x) => Number.isFinite(x) && x > 0)) throw new CommandError('Price and stop must be positive numbers');
    const s = sign(side);
    if (s * (price - stop) <= 0) throw new CommandError(`The stop must be ${side === 'long' ? 'below' : 'above'} the price (${price})`);
    if (target !== null && (!Number.isFinite(target) || s * (target - price) <= 0)) throw new CommandError(`The target must be ${side === 'long' ? 'above' : 'below'} the price (${price})`);
    const speed = buildContext(this.market, symbol, this.clock, this.cfg, this.funding.get(symbol) ?? null)?.speed ?? 'normal';
    const lastHour = this.market.recent(symbol, '1h', 1)[0];
    const risk = decideEntry({
      config: this.cfg, t: cmd.time, symbol, side, entry: price, stop,
      portfolio: this.portfolio, priceOf: (x) => this.priceOf(x), dayStartEquity: this.dayStart.equity || this.portfolio.balance,
      lastHourVolume: lastHour ? lastHour.quoteVolume : null, rules: this.rules.get(symbol) ?? null, score: Number.POSITIVE_INFINITY, speed,
    });
    if (!risk.ok) throw new CommandError(`Not taken: ${risk.reason!.replace(/^risk_/, '').replace(/_/g, ' ')}`);
    const id = `manual-${symbol}-${cmd.time}`;
    const order: OpenOrder = {
      action: 'open', orderType: 'market', side, notional: risk.notional, stop, target,
      chochLevel: null, signalId: null, refPrice: price, speed, setup: 'manual', ...(cmd.note ? { note: cmd.note.slice(0, 200) } : {}),
    };
    const placed = this.emit('order_placed', id, symbol, { ...order }, cmd.time);
    const pending = this.portfolio.pendingEntries().find((e) => e.positionId === id)!;
    // Filled at once, as a candle opening at the asked price at that moment.
    const fill = this.fillEntry(pending, { symbol, tf: '1m', openTime: cmd.time, closeTime: cmd.time, open: price, high: price, low: price, close: price, volume: 0, quoteVolume: 0, trades: 0 });
    return [placed, ...fill];
  }

  /** Everything that closed at time `t`, larger timeframes first. */
  private onClose(t: number, candles: Candle[]): TradeEvent[] {
    const out: TradeEvent[] = [];
    this.market.add(candles);
    if (t > this.clock) {
      this.clock = t;
      out.push(...this.onTime());
    }
    // The exits timeframe (1m) drives fills, stops and targets.
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
      if (inUniverse) {
        if (this.cfg.models.pullback || this.cfg.models.zone_sweep) out.push(...this.evaluate(ctx));
        out.push(...this.evaluateSweep(ctx));
        if (this.cfg.models.htf_poi) this.armHtf(ctx);
      }
    }
    // Model 4 confirms on the first 5m or 15m CHoCH (larger timeframes come first in a batch).
    if (this.cfg.models.htf_poi && this.htfArmed.size) {
      const done = new Set<string>();
      for (const c of candles) {
        if (this.universe.has(c.symbol) && (this.cfg.htf_poi.confirm_timeframes as Timeframe[]).includes(c.tf)) out.push(...this.confirmHtf(c, done));
      }
    }
    // Clean signals from this close, best first: highest reward:risk, then score (Section 18.1).
    const clean = this.clean.sort((x, y) => y.plan.rewardRisk - x.plan.rewardRisk || y.score - x.score);
    this.clean = [];
    for (const c of clean) out.push(...this.finish(c));
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
    for (const e of this.portfolio.pendingEntries()) {
      if (e.symbol === c.symbol && e.placedAt <= c.openTime) out.push(...this.fillEntry(e, c));
    }
    for (const p of this.portfolio.positions()) {
      if (p.symbol !== c.symbol) continue;
      const costs = costsFor(this.cfg, p.speed);
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
    const costs = costsFor(cfg, e.speed);
    const price = marketFill(e.side, 'open', c.open, costs);
    const s = sign(e.side);
    const cancel = (reason: string, extra: Record<string, unknown> = {}) =>
      [this.emit('order_cancelled', e.positionId, e.symbol, { reason, price, ...extra })];
    if (s * (price - e.stop) <= 0) return cancel('filled_beyond_stop');

    // Size from the fill: the loss at the stop must still fit the cap.
    const equity = equityOf(this.portfolio, (x) => this.priceOf(x));
    const lossPct = (Math.abs(price - e.stop) / price) * 100 + roundTripPct(costs);
    const riskPct = Math.min(cfg.allocation.max_loss_per_trade_pct, speedSettings(cfg, e.speed).risk_pct);
    const maxNotional = ((riskPct / 100) * equity / lossPct) * 100;
    const rules = this.rules.get(e.symbol);
    const qty = roundQty(Math.min(e.notional, maxNotional) / price, rules?.stepSize ?? 0);
    if (qty <= 0 || qty < (rules?.minQty ?? 0) || qty * price < (rules?.minNotional ?? 5)) return cancel('size_too_small', { qty });

    const liqPrice = liquidationPrice(e.side, price, cfg.leverage, cfg.sim.maintenance_margin_pct);
    if (s * (e.stop - liqPrice) <= 0) return cancel('liquidation_before_stop', { liqPrice });

    const fill: EntryFill = {
      role: 'entry', side: e.side, qty, price, stop: e.stop, target: e.target,
      fee: fee(qty * price, cfg.sim), session: this.sessions.ownerAt(e.placedAt),
      leverage: cfg.leverage, liqPrice, chochLevel: e.chochLevel, signalId: e.signalId, speed: e.speed ?? 'normal', setup: e.setup,
      ...(e.note ? { note: e.note } : {}),
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

  private closePosition(p: Position, price: number, reason: CloseReason, time = this.clock): TradeEvent {
    return this.emit('position_closed', p.id, p.symbol, {
      qty: p.qty, price, pnl: grossPnl(p.side, p.entryPrice, price, p.qty), fee: fee(p.qty * price, this.cfg.sim), reason,
      holdMinutes: Math.round((time - p.openedAt) / 60_000),
    }, time);
  }

  /** Closes at once at `price` (a market order: slippage against the trade), replacing any close still waiting for a candle. */
  private closeNow(p: Position, reason: CloseReason, price: number, time: number): TradeEvent {
    return this.closePosition(p, marketFill(p.side, 'close', price, costsFor(this.cfg, p.speed)), reason, Math.max(time, p.openedAt));
  }

  // ---------------------------------------------------------------- account-wide limits

  /** Daily loss limit bookkeeping and the drawdown kill switch. */
  private guardrails(): TradeEvent[] {
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

  private closeAll(reason: CloseReason, prices: Record<string, number> = {}, time = this.clock): TradeEvent[] {
    const out = this.portfolio.positions().flatMap((p) => {
      const price = prices[p.symbol];
      if (price > 0) return [this.closeNow(p, reason, price, time)];
      return p.pendingClose ? [] : [this.closeOrder(p, reason)];
    });
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
        const price = marketFill(p.side, 'close', ctx.price, costsFor(this.cfg, p.speed));
        if (qty > 0) out.push(this.emit('partial_closed', p.id, p.symbol, { qty, price, pnl: grossPnl(p.side, p.entryPrice, price, qty), fee: fee(qty * price, this.cfg.sim), reason: a.reason }));
      }
    }
    return out;
  }

  /**
   * The zone setup for one symbol at a 15m close: expire, confirm, or arm. With
   * models.zone_sweep, Model 1's rules (Section 18.5); with models.pullback,
   * the classic pullback (Section 8.4).
   */
  private evaluate(ctx: Context): TradeEvent[] {
    const out: TradeEvent[] = [];
    const { symbol, t } = ctx;
    const m1 = this.cfg.models.zone_sweep;
    const setup = m1 ? 'zone_sweep' : 'pullback';
    const block = this.sessions.entryBlock(t);
    const windowClosed = block !== null && WINDOW_CLOSED.has(block);
    // New listings: too little history to read structure (Section 18.1).
    const newListing = ctx.h1.candles.length < this.cfg.speed.min_history_days * 24;
    const busy = (this.portfolio.positions().some((p) => p.symbol === symbol) || this.portfolio.pendingEntries().some((e) => e.symbol === symbol));
    for (const dir of DIRECTIONS) {
      const key = `${symbol}|${dir}`;
      const armed = this.armed.get(key);
      if (armed) {
        const why = m1 ? zoneSweepStillValid(ctx, armed, windowClosed) : armedStillValid(ctx, armed, windowClosed);
        if (why) {
          this.armed.delete(key);
          this.signal(symbol, dir, 'expired', why, { armedId: armed.id, price: ctx.price }, setup);
        } else if (m1) {
          const levels = liquidityLevels(ctx);
          const conf = confirmZoneSweep(ctx, armed, levels);
          if (conf) {
            this.armed.delete(key);
            out.push(...this.checkZoneSweep(ctx, armed, conf, block, levels));
          }
          continue;
        } else {
          const conf = tryConfirm(ctx, armed);
          if (conf) {
            this.armed.delete(key);
            out.push(...this.check(ctx, armed, conf, block));
          }
          continue;
        }
      }
      if (windowClosed || busy || newListing) continue;
      const fresh = m1 ? armZoneSweep(ctx, dir) : tryArm(ctx, dir);
      if (fresh) {
        this.armed.set(key, fresh);
        this.confirmed.delete(key);
        this.signal(symbol, dir, 'armed', null, {
          armedId: fresh.id, price: fresh.price, factors: fresh.factors, zone: fresh.zone && { id: fresh.zone.id, low: fresh.zone.low, high: fresh.zone.high, status: fresh.zone.status },
          areaLow: fresh.areaLow, areaHigh: fresh.areaHigh, expiresAt: fresh.expiresAt, trendState: ctx.analysis[dir].state,
          // Entry, stop and target if it confirmed now; the real plan is made at the confirmation close.
          planEstimate: m1 ? this.zonePlan(ctx, fresh, dir === 'long' ? fresh.areaLow : fresh.areaHigh, liquidityLevels(ctx))?.plan ?? null : planTrade(ctx, fresh),
        }, setup);
      }
    }
    return out;
  }

  /** Model 4's entry window: the session rules, without the killzones unless htf_poi.killzones_only. */
  private htfBlock(t: number): string | null {
    const block = this.sessions.entryBlock(t);
    return block === 'outside_killzone' && !this.cfg.htf_poi.killzones_only ? null : block;
  }

  /** Model 4 at a 15m close: expire armed setups that no longer stand, arm new ones at 4h points of interest. */
  private armHtf(ctx: Context): void {
    const { symbol, t } = ctx;
    const block = this.htfBlock(t);
    const windowClosed = block !== null && WINDOW_CLOSED.has(block);
    const newListing = ctx.h1.candles.length < this.cfg.speed.min_history_days * 24;
    const busy = this.portfolio.positions().some((p) => p.symbol === symbol) || this.portfolio.pendingEntries().some((e) => e.symbol === symbol);
    for (const dir of DIRECTIONS) {
      const key = `${symbol}|${dir}`;
      const armed = this.htfArmed.get(key);
      if (armed) {
        const why = htfPoiStillValid(ctx, armed, ctx.price, windowClosed);
        if (why) {
          this.htfArmed.delete(key);
          this.signal(symbol, dir, 'expired', why, { armedId: armed.id, price: ctx.price }, 'htf_poi');
        }
        continue;
      }
      if (windowClosed || busy || newListing) continue;
      const fresh = armHtfPoi(ctx, dir);
      if (!fresh) continue;
      this.htfArmed.set(key, fresh);
      this.signal(symbol, dir, 'armed', null, {
        armedId: fresh.id, model: 'htf_poi', price: fresh.price, factors: fresh.factors,
        areaLow: fresh.areaLow, areaHigh: fresh.areaHigh, expiresAt: fresh.expiresAt, trendState: ctx.analysis[dir].state,
      }, 'htf_poi');
    }
  }

  /** Model 4 at a 5m or 15m close: a CHoCH on that timeframe confirms an armed setup (once per symbol and close). */
  private confirmHtf(c: Candle, done: Set<string>): TradeEvent[] {
    const out: TradeEvent[] = [];
    for (const dir of DIRECTIONS) {
      const key = `${c.symbol}|${dir}`;
      const a = this.htfArmed.get(key);
      if (!a || done.has(key) || c.closeTime <= a.armedAt) continue;
      const candles = this.market.recent(c.symbol, c.tf);
      if (candles[candles.length - 1]?.openTime !== c.openTime) continue;
      const swing = chochOn(candles, this.cfg.trend.swing_lookback, dir);
      if (!swing) continue;
      // The analysis as of the last 15m close, priced and timed at this close.
      const last15 = this.market.recent(c.symbol, this.cfg.timeframes.trigger, 1)[0];
      const base = last15 ? buildContext(this.market, c.symbol, last15.closeTime, this.cfg, this.funding.get(c.symbol) ?? null) : null;
      if (!base) continue;
      done.add(key);
      this.htfArmed.delete(key);
      out.push(...this.checkHtf({ ...base, t: c.closeTime, price: c.close }, a, swing.price, c.tf));
    }
    return out;
  }

  /** A confirmed Model 4 setup: stop beyond the extreme since arming, take-profit at opposite liquidity, then the shared rules. */
  private checkHtf(ctx: Context, a: Armed, chochLevel: number, chochTf: Timeframe): TradeEvent[] {
    const long = a.direction === 'long';
    // The finest confirmation timeframe, from the arming candle's open on.
    const fine = (this.cfg.htf_poi.confirm_timeframes as Timeframe[]).includes('5m') ? '5m' : this.cfg.timeframes.trigger;
    const armingOpen = a.armedAt - TIMEFRAME_MS[this.cfg.timeframes.trigger];
    const since = this.market.recent(ctx.symbol, fine).filter((x) => x.openTime >= armingOpen && x.closeTime <= ctx.t);
    if (!since.length) return [];
    const extreme = long ? Math.min(...since.map((x) => x.low)) : Math.max(...since.map((x) => x.high));
    const levels = liquidityLevels(ctx);
    const planned = this.zonePlan(ctx, a, extreme, levels);
    const detail = {
      armedAt: a.armedAt, factors: a.factors, poi: { low: a.areaLow, high: a.areaHigh }, chochLevel, chochTf, extreme,
      target: planned && { name: planned.target.name, price: planned.target.price },
    };
    if (!planned) {
      this.signals.push({ time: this.clock, symbol: ctx.symbol, setup: 'htf_poi', direction: a.direction, status: 'filtered', reason: 'no_target', payload: { armedId: a.id, model: 'htf_poi', ...detail, failures: ['no_target'], speed: ctx.speed ?? 'normal' } });
      return [];
    }
    const block = this.htfBlock(ctx.t);
    const fundingCheck = funding(ctx, a.direction);
    const failures = [
      ...(block ? [`session_${block}`] : []),
      ...this.planFailures(ctx, planned.plan),
      ...(fundingCheck.pass ? [] : ['filter_funding']),
    ];
    return this.submit({
      ctx, id: a.id, direction: a.direction, setup: 'htf_poi', plan: planned.plan, score: a.factors.length, failures, level: chochLevel,
      payload: { ...detail, filters: [fundingCheck] },
    });
  }

  /** A confirmed pullback: session, filters, stop, reward/risk, score, then risk. The first failure is the reason. */
  private check(ctx: Context, a: Armed, conf: Confirmation, block: string | null): TradeEvent[] {
    const cfg = this.cfg;
    const filters = runFilters(ctx, a, conf);
    const plan = planTrade(ctx, a);
    const score = scoreSignal(ctx, a, conf, plan);
    const failures = [
      ...(block ? [`session_${block}`] : []),
      // The fakeout check can be recorded without blocking (its failed-breakout exit stays on).
      ...filters.filter((f) => !f.pass && !(f.name === 'fakeout' && !cfg.filters.fakeout.block_entry)).map((f) => `filter_${f.name}`),
      ...this.planFailures(ctx, plan),
      ...(score.total >= cfg.scoring.min_score ? [] : ['score_too_low']),
    ];
    return this.submit({
      ctx, id: a.id, direction: a.direction, setup: 'pullback', plan, score: score.total, failures, level: conf.level,
      payload: { armedAt: a.armedAt, factors: a.factors, trendState: ctx.analysis[a.direction].state, confirmation: conf, score, filters },
    });
  }

  /** Model 1's plan: stop beyond `extreme` plus the speed group's buffer, take-profit at opposite liquidity. */
  private zonePlan(ctx: Context, a: Armed, extreme: number, levels: LiquidityLevel[]) {
    const s = sign(a.direction);
    const buffer = speedSettings(this.cfg, ctx.speed).stop_buffer_atr_15m * lastOf(ctx.atr15m);
    return liquidityPlan(ctx, a.direction, ctx.price, extreme - s * buffer, levels);
  }

  /** A confirmed Model 1 setup: the sweep is required; then the shared plan rules, funding and risk. */
  private checkZoneSweep(ctx: Context, a: Armed, conf: ZoneSweepConfirmation, block: string | null, levels: LiquidityLevel[]): TradeEvent[] {
    const planned = this.zonePlan(ctx, a, conf.extreme, levels);
    const detail = {
      armedAt: a.armedAt, factors: a.factors, poi: { low: a.areaLow, high: a.areaHigh }, chochLevel: conf.level, sweep: conf.sweep, extreme: conf.extreme,
      target: planned && { name: planned.target.name, price: planned.target.price },
    };
    if (!planned) {
      this.signals.push({ time: this.clock, symbol: ctx.symbol, setup: 'zone_sweep', direction: a.direction, status: 'filtered', reason: 'no_target', payload: { armedId: a.id, model: 'zone_sweep', ...detail, failures: ['no_target'], speed: ctx.speed ?? 'normal' } });
      return [];
    }
    const fundingCheck = funding(ctx, a.direction);
    const failures = [
      ...(block ? [`session_${block}`] : []),
      ...(conf.sweep ? [] : ['no_sweep']),
      ...this.planFailures(ctx, planned.plan),
      ...(fundingCheck.pass ? [] : ['filter_funding']),
    ];
    return this.submit({
      ctx, id: a.id, direction: a.direction, setup: 'zone_sweep', plan: planned.plan, score: a.factors.length, failures, level: conf.level,
      payload: { ...detail, filters: [fundingCheck] },
    });
  }

  /** The plan rules every model shares: stop distance, reward:risk, minimum profit, and costs against the risk. */
  private planFailures(ctx: Context, plan: TradePlan): string[] {
    const cfg = this.cfg;
    return [
      ...(plan.stopDistancePct > 0 && plan.stopDistancePct <= cfg.exits.max_stop_pct ? [] : ['stop_too_wide']),
      // At least min_rr after the round-trip costs, not before them.
      ...(netRewardRisk(plan.entry, plan.stop, plan.target, roundTripPct(costsFor(cfg, ctx.speed))) >= cfg.exits.min_rr ? [] : ['rr_too_low']),
      ...(Math.abs(plan.target - plan.entry) / plan.entry * 100 >= cfg.exits.min_target_pct ? [] : ['profit_too_small']),
      // Fees and slippage would eat too much of the money at risk: the stop is too tight for the costs.
      ...(plan.stopDistancePct > 0 && (roundTripPct(costsFor(cfg, ctx.speed)) / plan.stopDistancePct) * 100 > cfg.allocation.max_fee_drag_pct ? ['fees_too_high'] : []),
    ];
  }

  /** A clean signal waits for the other coins closing now: the best are sized first when slots are short. */
  private submit(c: Candidate): TradeEvent[] {
    if (!c.failures.length) {
      this.clean.push(c);
      return [];
    }
    return this.finish(c);
  }

  /** Risk, the signal record, the shadow trade and the order for one checked signal of any model. */
  private finish({ ctx, id, direction, setup, plan, score, failures, level, payload }: Candidate): TradeEvent[] {
    const cfg = this.cfg;
    const symbol = ctx.symbol;
    const lastHour = this.market.recent(symbol, '1h', 1)[0];
    const risk = failures.length ? null : decideEntry({
      config: cfg, t: ctx.t, symbol, side: direction, entry: plan.entry, stop: plan.stop,
      portfolio: this.portfolio, priceOf: (s) => this.priceOf(s), dayStartEquity: this.dayStart.equity || this.portfolio.balance,
      lastHourVolume: lastHour ? lastHour.quoteVolume : null, rules: this.rules.get(symbol) ?? null, score, speed: ctx.speed,
    });
    if (risk && !risk.ok) failures.push(risk.reason!);
    const status = failures.length ? 'filtered' : 'taken';
    this.confirmed.set(`${symbol}|${direction}`, { direction, time: ctx.t, taken: status === 'taken', reason: failures[0] ?? null });
    this.signals.push({
      time: this.clock, symbol, setup, direction, status, reason: failures[0] ?? null,
      payload: { armedId: id, model: setup, ...payload, session: this.sessions.ownerAt(ctx.t)?.name ?? null, plan, failures, risk, speed: ctx.speed ?? 'normal' },
    });

    // Every confirmed signal with a sane plan is followed as a shadow trade.
    const owner = this.sessions.ownerAt(ctx.t);
    if (plan.stopDistancePct > 0) {
      this.shadows.push({
        armedId: id, working: false,
        signalTime: ctx.t, symbol, direction, signalStatus: status, signalReason: failures[0] ?? null, plan,
        sessionClose: cfg.sessions.exit_at_session_end ? owner?.closeTime ?? ctx.t + DAY
          : ctx.t + Math.min(speedSettings(cfg, ctx.speed).max_hold_hours, setup === 'htf_poi' ? cfg.htf_poi.max_hold_hours : Infinity) * 3_600_000,
        speed: ctx.speed ?? 'normal', setup,
      });
    }
    if (status !== 'taken') return [];

    const target = cfg.exits.mode === 'ladder' ? null : plan.target;
    const order: OpenOrder = {
      action: 'open', orderType: 'market', side: direction, notional: risk!.notional, stop: plan.stop, target,
      chochLevel: level, signalId: id, refPrice: plan.entry, speed: ctx.speed ?? 'normal', setup,
    };
    return [this.emit('order_placed', `${id}-pos`, symbol, { ...order, plan, score })];
  }

  /**
   * Model 3, the session sweep (Section 18.4), for one coin at a 15m close.
   * Only inside an entry window (killzone, weekday); each swept level gives
   * at most one signal per direction.
   */
  private evaluateSweep(ctx: Context): TradeEvent[] {
    const cfg = this.cfg;
    if (!cfg.models.session_sweep || this.sessions.entryBlock(ctx.t)) return [];
    const { symbol, t } = ctx;
    if (ctx.h1.candles.length < cfg.speed.min_history_days * 24) return [];
    if (this.portfolio.positions().some((p) => p.symbol === symbol) || this.portfolio.pendingEntries().some((e) => e.symbol === symbol)) return [];
    const out: TradeEvent[] = [];
    for (const dir of DIRECTIONS) {
      const sig = sessionSweep(ctx, dir);
      if (!sig) continue;
      const key = `${symbol}|${dir}|${sig.swept.name}|${sig.swept.formedAt}`;
      if (this.sweepsUsed.has(key)) continue;
      this.sweepsUsed.set(key, t);
      const id = `${symbol}-sweep-${dir}-${t}`;
      const detail = {
        swept: { name: sig.swept.name, price: sig.swept.price }, sweptAll: sig.sweptAll.map((l) => l.name), extreme: sig.extreme,
        target: sig.targetLevel && { name: sig.targetLevel.name, price: sig.targetLevel.price }, confluence: sig.confluence,
      };
      if (!sig.plan) {
        // No opposite level ahead: nothing to aim at. Recorded so the Signals page shows why.
        this.signals.push({ time: this.clock, symbol, setup: 'session_sweep', direction: dir, status: 'filtered', reason: 'no_target', payload: { armedId: id, model: 'session_sweep', ...detail, failures: ['no_target'], speed: ctx.speed ?? 'normal' } });
        continue;
      }
      const fundingCheck = funding(ctx, dir);
      const failures = [...this.planFailures(ctx, sig.plan), ...(fundingCheck.pass ? [] : ['filter_funding'])];
      out.push(...this.submit({
        ctx, id, direction: dir, setup: 'session_sweep', plan: sig.plan, score: sig.confluence.length, failures, level: sig.swept.price,
        payload: { ...detail, filters: [fundingCheck] },
      }));
    }
    // Forget levels from more than two days ago.
    for (const [k, at] of this.sweepsUsed) if (t - at > 2 * DAY) this.sweepsUsed.delete(k);
    return out;
  }

  // ---------------------------------------------------------------- shadow trades

  private resolveShadows(c: Candle): void {
    this.shadows = this.shadows.filter((sh) => {
      if (sh.symbol !== c.symbol || c.openTime < sh.signalTime) return true;
      const costPct = roundTripPct(costsFor(this.cfg, sh.speed));
      const { entry, stop, target } = sh.plan;
      const s = sign(sh.direction);
      const risk = Math.abs(entry - stop);
      let outcome: ShadowResult['outcome'] | null = null;
      let exit = 0;
      const stopHit = sh.direction === 'long' ? c.low <= stop : c.high >= stop;
      const best = sh.direction === 'long' ? c.high : c.low;
      // Going our way: the first candle that reaches 1R in favour (not one that also hits the stop: order unknown, stop first).
      if (!sh.working && !stopHit && s * (best - entry) >= risk) {
        sh.working = true;
        this.signal(sh.symbol, sh.direction, 'working', null, { armedId: sh.armedId, price: entry + s * risk, r: 1, signalStatus: sh.signalStatus, speed: sh.speed }, sh.setup);
      }
      if (stopHit) { outcome = 'stop'; exit = stop; }
      else if (sh.direction === 'long' ? c.high >= target : c.low <= target) { outcome = 'target'; exit = target; }
      else if (c.closeTime >= sh.sessionClose) { outcome = this.cfg.sessions.exit_at_session_end ? 'session_end' : 'max_hold'; exit = c.close; }
      if (!outcome) return true;
      const r = (s * (exit - entry) - (costPct / 100) * entry) / risk;
      this.signal(sh.symbol, sh.direction, 'outcome', outcome, { armedId: sh.armedId, outcome, exit, r, signalStatus: sh.signalStatus, speed: sh.speed }, sh.setup);
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

  private signal(symbol: string, direction: Direction, status: SignalRecord['status'], reason: string | null, payload: Record<string, unknown>, setup: SignalRecord['setup'] = 'pullback'): void {
    this.signals.push({ time: this.clock, symbol, setup, direction, status, reason, payload });
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
