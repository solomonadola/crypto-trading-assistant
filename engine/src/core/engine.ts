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
import { btc, exhaustion, funding, runFilters } from '../filters';
import { scoreSignal } from '../scoring';
import { decideEntry, equityOf, riskAtStop, unrealized, type ManualSize, type RiskDecision, type SymbolRules } from '../risk';
import { manage } from '../exits';
import { fee, grossPnl, liquidationPrice, marketFill, restingTargetFill, roundQty, stopFill, targetFill } from '../sim/broker';
import { tradeIdea } from '../analysis/levels';
import { sessionSweep } from '../strategy/sessionSweep';
import { armZoneSweep, confirmZoneSweep, zoneSweepStillValid, type ZoneSweepConfirmation } from '../strategy/zoneSweep';
import { armHtfPoi, chochOn, htfPointsOfInterest, htfPoiStillValid, type HtfPoi } from '../strategy/htfPoi';
import { liquidityPlan } from '../strategy/smc';
import { liquidityLevels, type LiquidityLevel } from '../analysis/liquidity';
import { costsFor, limitRoundTripPct, netRewardRisk, roundTripPct, speedSettings, type SpeedGroup } from '../speed';

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
   * `setup: 'scalp'` is the scalp autopilot's: it must also pass scalpFailures. `maxHoldMin` closes the
   * position at the market after that long; `entryTimeoutMin` cancels a limit not filled by then.
   * `progressCheckMin` / `progressMinR`: closed at the market if, that long after the fill, price has never
   * been `progressMinR` R in the trade's favour (a scalp that is not working is cut, not waited out).
   */
  | {
    type: 'open'; symbol: string; side: Direction; price: number; time: number; stop: number; target: number | null;
    orderType?: 'market' | 'limit'; note?: string; setup?: 'manual' | 'scalp'; maxHoldMin?: number; entryTimeoutMin?: number;
    progressCheckMin?: number; progressMinR?: number;
    /** A size chosen by hand (see ManualSize); absent: sized by the risk rules. */
    size?: ManualSize;
  }
  /**
   * Edit an open position's stop and/or take-profit (null removes the take-profit). `price` is the
   * current price: the stop must stay on the losing side of it and the take-profit on the winning side.
   */
  | { type: 'modify'; positionId: string; stop?: number; target?: number | null; price: number; time?: number }
  /**
   * Live prices between candles (the last trade price per symbol): a position whose stop or
   * take-profit they reach closes at once, the way an exchange's stop order would, instead of
   * waiting for the 1m candle to close.
   */
  | { type: 'live_prices'; prices: Record<string, number>; time: number }
  /** Cancel a pending entry (limit order not yet filled). */
  | { type: 'cancel'; positionId: string }
  /**
   * Edit a pending entry's stop, take-profit, and/or limit price. `price` is the current market
   * price: the stop must be on the losing side and the take-profit on the winning side.
   */
  | { type: 'modify_pending'; positionId: string; stop?: number; target?: number | null; entry?: number; price: number };

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
  /** Entries are limits at the plan's entry: a shadow only counts once the price comes back to it... */
  filled: boolean;
  /** ...by this time (the limit's timeout); otherwise it never happened. */
  fillBy: number;
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
  /** Per symbol, the close time of the newest 1m candle whose fills, stops and targets have been settled. */
  private readonly settledTo = new Map<string, number>();
  private signals: SignalRecord[] = [];
  private shadows: Shadow[] = [];
  private shadowResults: ShadowResult[] = [];
  /** Opening-range breakouts already taken, per coin and session. */
  private peakEquity: number;
  private dayStart = { day: -1, equity: 0 };
  private circuitBreakerUntil = 0;
  private circuitBreakerReason: string | null = null;
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

  speed(symbol: string): SpeedGroup {
    return buildContext(this.market, symbol, this.clock, this.cfg, this.funding.get(symbol) ?? null)?.speed ?? 'normal';
  }

  analysedSymbols(): string[] {
    return this.market.symbols();
  }

  universeSymbols(): string[] {
    return [...this.universe];
  }

  /**
   * A coin's market context as of its last 15m close (liquidity levels, the 4h dealing range and the rest),
   * for strategies that run between 15m closes, such as Hunter's killzone sweep on 5m. Null before there is
   * enough history.
   */
  latestContext(symbol: string): Context | null {
    const last15 = this.market.recent(symbol, this.cfg.timeframes.trigger, 1)[0];
    return last15 ? buildContext(this.market, symbol, last15.closeTime, this.cfg, this.funding.get(symbol) ?? null) : null;
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

  isCircuitBreakerActive(): boolean {
    return this.clock < this.circuitBreakerUntil;
  }

  circuitBreaker(): { active: boolean; until: number; reason: string | null; btcChange5mPct: number | null } {
    const active = this.isCircuitBreakerActive();
    return {
      active,
      until: active ? this.circuitBreakerUntil : 0,
      reason: active ? this.circuitBreakerReason : null,
      btcChange5mPct: this.btcChange5mPct(),
    };
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
      pendingEntries: this.portfolio.pendingEntries().map((e) => ({
        positionId: e.positionId, symbol: e.symbol, side: e.side, notional: e.notional, placedAt: e.placedAt,
        price: e.refPrice, orderType: e.orderType, stop: e.stop, target: e.target,
      })),
      circuitBreaker: this.circuitBreaker(),
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
      else out.push(...this.settleLate(batch.slice(i, j)));
      i = j;
    }
    return out;
  }

  /**
   * 1m candles that arrive after the clock has passed them: a coin whose fetch failed for a few minutes
   * while the others came in, or one fed again after a gap. Too late for the setup rules, but the fills,
   * stops and targets that happened in them are settled at the prices and times they happened, instead
   * of the position carrying on as if its stop had never been touched. Each candle is settled once.
   */
  private settleLate(candles: Candle[]): TradeEvent[] {
    this.market.add(candles);
    const out: TradeEvent[] = [];
    for (const c of candles) {
      if (c.tf === this.cfg.timeframes.exits && c.closeTime > (this.settledTo.get(c.symbol) ?? 0)) out.push(...this.onMinute(c, c.closeTime));
    }
    return out;
  }

  /** Commands act at the engine's current time, never the wall clock. */
  onCommand(cmd: EngineCommand): TradeEvent[] {
    switch (cmd.type) {
      case 'close': {
        const pos = this.portfolio.get(cmd.positionId);
        if (!pos) {
          const pend = this.portfolio.getPending(cmd.positionId);
          if (pend) {
            return [this.emit('order_cancelled', pend.positionId, pend.symbol, {
              reason: 'manual_cancel',
              placedAt: pend.placedAt,
            })];
          }
          throw new CommandError(`No open position ${cmd.positionId}`);
        }
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
        this.peakEquity = Math.max(this.peakEquity, equityOf(this.portfolio, (s) => this.priceOf(s)));
        return [this.emit('engine_resumed', null, null, {})];
      case 'open':
        return this.openManual(cmd);
      case 'modify':
        return this.modify(cmd);
      case 'live_prices':
        return this.liveExits(cmd.prices, cmd.time);
      case 'cancel':
        return this.cancelPending(cmd);
      case 'modify_pending':
        return this.modifyPending(cmd);
      case 'reset_balance': {
        if (this.portfolio.positions().length || this.portfolio.pendingEntries().length) {
          throw new CommandError('Close all positions before resetting the balance');
        }
        if (cmd.balance !== undefined && (!(cmd.balance > 0) || !Number.isFinite(cmd.balance))) {
          throw new CommandError('Balance must be a positive number');
        }
        const balance = cmd.balance ?? this.cfg.starting_balance_usdt;
        this.peakEquity = balance;
        this.dayStart = { day: Math.floor(this.clock / DAY), equity: balance };
        return [this.emit('balance_reset', null, null, { balance })];
      }
    }
  }

  /** A stop and/or take-profit edited by hand, checked against the current price. */
  private modify(cmd: Extract<EngineCommand, { type: 'modify' }>): TradeEvent[] {
    const p = this.portfolio.get(cmd.positionId);
    if (!p) throw new CommandError(`No open position ${cmd.positionId}`);
    if (p.pendingClose) throw new CommandError('This position is already closing');
    const s = sign(p.side);
    const price = cmd.price;
    if (!(price > 0)) throw new CommandError('No current price to check the levels against');
    const stop = cmd.stop ?? p.stop;
    const target = cmd.target === undefined ? p.target : cmd.target;
    if (!(stop > 0) || s * (price - stop) <= 0) {
      throw new CommandError(`The stop must be ${p.side === 'long' ? 'below' : 'above'} the current price ${price}`);
    }
    if (target !== null && (!(target > 0) || s * (target - price) <= 0)) {
      throw new CommandError(`The take-profit must be ${p.side === 'long' ? 'above' : 'below'} the current price ${price}`);
    }
    if (p.liqPrice !== null && s * (stop - p.liqPrice) <= 0) {
      throw new CommandError(`The stop is beyond the liquidation price ${p.liqPrice}`);
    }
    const time = Math.max(cmd.time ?? this.clock, p.openedAt);
    const out: TradeEvent[] = [];
    if (stop !== p.stop) out.push(this.emit('stop_moved', p.id, p.symbol, { stop, reason: 'edited by hand' }, time));
    if (target !== p.target) out.push(this.emit('target_moved', p.id, p.symbol, { target, reason: 'edited by hand' }, time));
    return out;
  }

  /** A pending limit order cancelled by hand. */
  private cancelPending(cmd: Extract<EngineCommand, { type: 'cancel' }>): TradeEvent[] {
    const pend = this.portfolio.getPending(cmd.positionId);
    if (!pend) {
      if (this.portfolio.get(cmd.positionId)) {
        throw new CommandError(`Position ${cmd.positionId} has already filled and is open; close it instead of cancelling`);
      }
      throw new CommandError(`No pending order ${cmd.positionId}`);
    }
    return [this.emit('order_cancelled', pend.positionId, pend.symbol, {
      reason: 'manual_cancel',
      placedAt: pend.placedAt,
    })];
  }

  /** A pending limit order's limit entry price, stop and/or take-profit edited by hand. */
  private modifyPending(cmd: Extract<EngineCommand, { type: 'modify_pending' }>): TradeEvent[] {
    const e = this.portfolio.getPending(cmd.positionId);
    if (!e) throw new CommandError(`No pending order ${cmd.positionId}`);
    const s = sign(e.side);
    const entry = cmd.entry !== undefined && Number.isFinite(cmd.entry) && cmd.entry > 0 ? cmd.entry : e.refPrice;
    const stop = cmd.stop !== undefined && Number.isFinite(cmd.stop) && cmd.stop > 0 ? cmd.stop : e.stop;
    const target = cmd.target === undefined ? e.target : cmd.target === null || cmd.target === 0 ? null : cmd.target;

    if (!(entry > 0) || !Number.isFinite(entry)) throw new CommandError('Limit price must be a positive number');
    if (!(stop > 0) || !Number.isFinite(stop)) throw new CommandError('Stop must be a positive number');
    if (s * (entry - stop) <= 0) {
      throw new CommandError(`The stop must be ${e.side === 'long' ? 'below' : 'above'} the limit entry price (${entry})`);
    }
    if (target !== null) {
      if (!Number.isFinite(target) || target <= 0) throw new CommandError('Target must be a positive number');
      if (s * (target - entry) <= 0) {
        throw new CommandError(`The take-profit must be ${e.side === 'long' ? 'above' : 'below'} the limit entry price (${entry})`);
      }
      const speed = buildContext(this.market, e.symbol, this.clock, this.cfg, this.funding.get(e.symbol) ?? null)?.speed ?? 'normal';
      const rr = netRewardRisk(entry, stop, target, roundTripPct(costsFor(this.cfg, speed)));
      if (rr < this.cfg.exits.min_rr) {
        throw new CommandError(`Reward:risk is ${rr.toFixed(2)}R after costs; at least ${this.cfg.exits.min_rr}R is needed`);
      }
    }
    if (cmd.price > 0 && s * (cmd.price - stop) <= 0) {
      throw new CommandError(`The price ${cmd.price} is already ${e.side === 'long' ? 'below' : 'above'} the stop ${stop}`);
    }

    const out: TradeEvent[] = [];
    if (entry !== e.refPrice) {
      out.push(this.emit('limit_moved', e.positionId, e.symbol, { price: entry, reason: 'edited by hand' }));
    }
    if (stop !== e.stop) {
      out.push(this.emit('stop_moved', e.positionId, e.symbol, { stop, reason: 'edited by hand' }));
    }
    if (target !== e.target) {
      out.push(this.emit('target_moved', e.positionId, e.symbol, { target, reason: 'edited by hand' }));
    }
    return out;
  }

  /**
   * A position with a progress check that, by then, has never been progressMinR in its favour: the best
   * price of the 1m candles after the one it filled in (that one's extreme may have come before the fill),
   * against the risk to its initial stop. Read from the candles,
   * not kept as state, so a restart rebuilding from the trade log decides the same.
   */
  private noProgress(p: Position, t: number): boolean {
    if (!p.progressCheckMin || !p.progressMinR || t - p.openedAt < p.progressCheckMin * 60_000) return false;
    const best = this.bestR(p, t);
    return best !== null && best < p.progressMinR;
  }

  /**
   * How far the trade has been in its favour, in R of its initial risk: the best price of the 1m candles after
   * the one it filled in (that one's extreme may have come before the fill), up to `t`. Null without candles.
   * Read from the candles, not kept as state, so a restart rebuilding from the trade log decides the same.
   */
  private bestR(p: Position, t: number): number | null {
    const risk = Math.abs(p.entryPrice - p.initialStop);
    if (!(risk > 0)) return null;
    const since = this.market.recent(p.symbol, this.cfg.timeframes.exits).filter((c) => c.openTime > p.openedAt && c.closeTime <= t);
    if (!since.length) return null;
    const best = p.side === 'long' ? Math.max(...since.map((c) => c.high)) : Math.min(...since.map((c) => c.low));
    return (sign(p.side) * (best - p.entryPrice)) / risk;
  }

  /**
   * The stop the R ladder (exits.r_ladder) asks for, if it is tighter than the current one; else null. Read
   * from the candles closed before the one at `t`: a stop set at a candle's close applies from the next
   * candle, never to the candle whose high (long) set it, since its low may have come first.
   */
  private ladderStop(p: Position, t: number): { stop: number; reason: string } | null {
    const lad = this.cfg.exits.r_ladder;
    if (!p.setup || !lad.setups.includes(p.setup) || !lad.steps.length) return null;
    const asOf = t - TIMEFRAME_MS[this.cfg.timeframes.exits];
    const best = this.bestR(p, asOf);
    if (best === null) return null;
    const step = [...lad.steps].filter((x) => best >= x.at_r).sort((a, b) => b.at_r - a.at_r)[0];
    if (!step) return null;
    const s = sign(p.side);
    const risk = Math.abs(p.entryPrice - p.initialStop);
    // Beyond the last step, trail: trail_r behind the best price, when that is tighter than the step's lock.
    const last = Math.max(...lad.steps.map((x) => x.at_r));
    const trailing = lad.trail_r !== null && best > last && best - lad.trail_r > step.lock_r;
    const lockR = trailing ? best - lad.trail_r! : step.lock_r;
    const stop = lockR > 0
      ? p.entryPrice + s * lockR * risk
      : p.entryPrice * (1 + (s * this.cfg.exits.breakeven_fee_buffer_pct) / 100);
    if (s * (stop - p.stop) <= 1e-12) return null;       // already there or better
    // A stop must sit on the losing side of the price when it is placed: after a spike that closed back past
    // the level, wait.
    const placedAt = this.market.recent(p.symbol, this.cfg.timeframes.exits).filter((c) => c.closeTime <= asOf).at(-1);
    if (!placedAt || s * (placedAt.close - stop) <= 0) return null;
    const reason = trailing ? `trailing ${lad.trail_r}R behind the best (+${best.toFixed(2)}R): +${lockR.toFixed(2)}R locked`
      : step.lock_r > 0 ? `+${step.at_r}R reached: +${step.lock_r}R locked` : `+${step.at_r}R reached: break-even`;
    return { stop, reason };
  }

  /** Stops and take-profits reached by a live price: closed at once (a stop at that price plus slippage, a take-profit at the target). */
  private liveExits(prices: Record<string, number>, time: number): TradeEvent[] {
    const out: TradeEvent[] = [];
    for (const p of this.portfolio.positions()) {
      const price = prices[p.symbol];
      if (!(price > 0) || p.pendingClose) continue;
      const at = Math.max(time, p.openedAt);
      const costs = costsFor(this.cfg, p.speed);
      const s = sign(p.side);
      if (s * (price - p.stop) <= 0) {
        // A live price can skip past the stop (a gap): the fill is that price, never better than the stop.
        out.push(this.closePosition(p, marketFill(p.side, 'close', s > 0 ? Math.min(price, p.stop) : Math.max(price, p.stop), costs), 'stop', at));
      } else if (p.target !== null && this.cfg.exits.mode === 'fixed' && p.setup === 'scalp' && s * (price - p.target) > 0) {
        // A scalp's take-profit rests on the book: it fills at the target, maker, once price is through it.
        out.push(this.closePosition(p, p.target, 'target', at, true));
      } else if (p.target !== null && this.cfg.exits.mode === 'fixed' && s * (price - p.target) >= 0) {
        out.push(this.closePosition(p, marketFill(p.side, 'close', p.target, costs), 'target', at));
      }
    }
    return out;
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
    // The same reward:risk floor as the engine's own trades, after fees and slippage: no 1:1 trades.
    if (target === null) throw new CommandError(`A take-profit is needed: trades must aim for at least ${this.cfg.exits.min_rr}R`);
    const orderType = cmd.orderType ?? 'market';
    // A limit entry pays the maker fee and does not slip; a market entry pays taker and slips both ways.
    const costs = costsFor(this.cfg, speed);
    const rr = netRewardRisk(price, stop, target, orderType === 'limit' ? limitRoundTripPct(costs) : roundTripPct(costs));
    if (rr < this.cfg.exits.min_rr) throw new CommandError(`Reward:risk is ${rr.toFixed(2)}R after costs; at least ${this.cfg.exits.min_rr}R is needed`);
    const setup = cmd.setup ?? 'manual';
    // A market order fills at `price` (the mark), checked above; a limit fills against the latest price.
    const currentPrice = orderType === 'limit' ? this.priceOf(symbol) : null;
    if (currentPrice !== null && s * (currentPrice - stop) <= 0) {
      throw new CommandError(`The price ${currentPrice} is already ${side === 'long' ? 'below' : 'above'} the stop ${stop}`);
    }
    if (this.isCircuitBreakerActive() && symbol !== 'BTCUSDT' && side === 'long') {
      throw new CommandError(`BTC circuit breaker active: ${this.circuitBreakerReason ?? 'rapid BTC flash drop'}`);
    }
    if (setup === 'scalp') {
      const failures = this.scalpFailures(symbol, side, price, stop, speed);
      if (failures.length) throw new CommandError(`Not taken: ${failures.join(', ')}`);
    }
    const lastHour = this.market.recent(symbol, '1h', 1)[0];
    const risk = decideEntry({
      config: this.cfg, t: cmd.time, symbol, side, entry: price, stop,
      portfolio: this.portfolio, priceOf: (x) => this.priceOf(x), dayStartEquity: this.dayStart.equity || this.portfolio.balance,
      lastHourVolume: lastHour ? lastHour.quoteVolume : null, rules: this.rules.get(symbol) ?? null, score: Number.POSITIVE_INFINITY, speed, setup,
      ...(cmd.size ? { size: cmd.size } : {}),
    });
    if (!risk.ok) throw new CommandError(sizeRefusal(risk) ?? `Not taken: ${risk.reason!.replace(/^risk_/, '').replace(/_/g, ' ')}`);
    const id = `${setup}-${symbol}-${cmd.time}`;
    const order: OpenOrder = {
      action: 'open', orderType, side, notional: risk.notional, stop, target,
      chochLevel: null, signalId: null, refPrice: price, speed, setup, ...(cmd.note ? { note: cmd.note.slice(0, 200) } : {}),
      ...(cmd.maxHoldMin ? { maxHoldMin: cmd.maxHoldMin } : {}), ...(cmd.entryTimeoutMin ? { entryTimeoutMin: cmd.entryTimeoutMin } : {}),
      ...(cmd.progressCheckMin && cmd.progressMinR ? { progressCheckMin: cmd.progressCheckMin, progressMinR: cmd.progressMinR } : {}),
      ...(cmd.size && risk.maxRiskPct !== undefined ? { maxRiskPct: risk.maxRiskPct } : {}),
    };
    const placed = this.emit('order_placed', id, symbol, { ...order }, cmd.time);
    const pending = this.portfolio.pendingEntries().find((e) => e.positionId === id)!;

    // A limit the price has not come back to yet waits for it.
    if (currentPrice !== null && (side === 'long' ? currentPrice > price : currentPrice < price)) return [placed];

    // Filled at once, as a candle opening at that moment: a market order at the asked price, a limit the
    // price is already through at the latest price (the better one, as an exchange would fill it).
    const at = currentPrice ?? price;
    const fill = this.fillEntry(pending, { symbol, tf: '1m', openTime: cmd.time, closeTime: cmd.time, open: at, high: at, low: at, close: at, volume: 0, quoteVolume: 0, trades: 0 });
    return [placed, ...fill];
  }

  /**
   * The scalp autopilot's checks on top of the risk rules: no entries at the weekend or around funding,
   * a stop no wider than scalp_autopilot.max_stop_pct and wide enough for the costs, and the funding,
   * BTC and daily-range filters the engine's own models use (BTC over the hour to now, on 1m).
   */
  private scalpFailures(symbol: string, side: Direction, entry: number, stop: number, speed: SpeedGroup): string[] {
    const cfg = this.cfg;
    const failures: string[] = [];
    if (this.isCircuitBreakerActive() && symbol !== 'BTCUSDT' && side === 'long') failures.push('filter_btc_circuit_breaker');
    const block = this.sessions.entryBlock(this.clock);
    if (block === 'weekend' || block === 'funding_window') failures.push(`session_${block}`);
    const stopPct = (Math.abs(entry - stop) / entry) * 100;
    if (stopPct > cfg.scalp_autopilot.max_stop_pct) failures.push('stop_too_wide');
    // Scalps are entered with resting limit orders: maker fee in, taker with slippage out.
    if ((limitRoundTripPct(costsFor(cfg, speed)) / stopPct) * 100 > cfg.allocation.max_fee_drag_pct) failures.push('fees_too_high');
    const last15 = this.market.recent(symbol, cfg.timeframes.trigger, 1)[0];
    const ctx = last15 ? buildContext(this.market, symbol, last15.closeTime, cfg, this.funding.get(symbol) ?? null) : null;
    if (ctx) {
      const now = { ...ctx, btcChange1hPct: this.btcChange1hPct() };
      if (cfg.filters.funding.enabled && !funding(now, side).pass) failures.push('filter_funding');
      if (cfg.filters.btc.enabled && !btc(now, side).pass) failures.push('filter_btc');
      if (!exhaustion(now, side).pass) failures.push('filter_exhaustion');
    }
    return failures;
  }

  /** BTC's change over the hour to the engine's clock, from 1m closes; null without both candles. */
  private btcChange1hPct(): number | null {
    const tf = this.cfg.timeframes.exits;
    const step = TIMEFRAME_MS[tf];
    const candles = this.market.recent('BTCUSDT', tf, Math.round(3_600_000 / step) + 1);
    const last = candles[candles.length - 1];
    const first = candles[0];
    if (!last || !first || last.closeTime - first.closeTime !== 3_600_000 || !(first.close > 0)) return null;
    return (last.close / first.close - 1) * 100;
  }

  /** BTC's rapid change over the last 5 minutes from 1m closes; null without both candles. */
  private btcChange5mPct(): number | null {
    const tf = this.cfg.timeframes.exits;
    const step = TIMEFRAME_MS[tf];
    const candles = this.market.recent('BTCUSDT', tf, Math.round(300_000 / step) + 1);
    const last = candles[candles.length - 1];
    const first = candles[0];
    if (!last || !first || last.closeTime - first.closeTime !== 300_000 || !(first.close > 0)) return null;
    return (last.close / first.close - 1) * 100;
  }

  /** Everything that closed at time `t`, larger timeframes first. */
  private onClose(t: number, candles: Candle[]): TradeEvent[] {
    const out: TradeEvent[] = [];
    this.market.add(candles);
    if (t > this.clock) {
      this.clock = t;
      out.push(...this.onTime());
    }
    // The exits timeframe (1m) drives fills, stops and targets; each candle once, even when handed on again.
    for (const c of candles) if (c.tf === this.cfg.timeframes.exits && c.closeTime > (this.settledTo.get(c.symbol) ?? 0)) out.push(...this.onMinute(c));
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
    // Positions with their own max hold (scalps) close at the market once held that long.
    for (const p of this.portfolio.positions()) {
      const maxHoldMin = p.maxHoldMin ?? legacyScalp(p.note)?.holdMin;
      if (!p.pendingClose && maxHoldMin && t - p.openedAt >= maxHoldMin * 60_000) out.push(this.closeOrder(p, 'max_hold'));
      else if (!p.pendingClose && this.noProgress(p, t)) out.push(this.closeOrder(p, 'no_progress'));
      else if (!p.pendingClose) {
        const moved = this.ladderStop(p, t);
        if (moved) out.push(this.emit('stop_moved', p.id, p.symbol, moved));
      }
    }

    // Entries with no price to fill at, or limits the price never came back to, are cancelled.
    for (const e of this.portfolio.pendingEntries()) {
      const timeoutMin = e.entryTimeoutMin ?? legacyScalp(e.note)?.timeoutMin
        ?? (e.orderType === 'limit' ? 240 : this.cfg.sim.entry_timeout_min);
      if (t - e.placedAt > timeoutMin * 60_000) {
        out.push(this.emit('order_cancelled', e.positionId, e.symbol, {
          reason: e.orderType === 'limit' ? 'timeout_missed_pullback' : 'no_price',
          placedAt: e.placedAt,
        }));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 1m: fills, stops, targets

  /** Fills, stops and targets in one 1m candle; closes are recorded at `at` (the candle's close when it came late). */
  private onMinute(c: Candle, at = this.clock): TradeEvent[] {
    const out: TradeEvent[] = [];
    this.settledTo.set(c.symbol, Math.max(this.settledTo.get(c.symbol) ?? 0, c.closeTime));
    // Limits filled inside this candle: whether the price reached the target before or after the fill is unknown.
    const limitFills = new Set<string>();
    for (const e of this.portfolio.pendingEntries()) {
      if (e.symbol !== c.symbol || e.placedAt > c.openTime) continue;
      const events = this.fillEntry(e, c, at);
      if (e.orderType === 'limit' && events.some((x) => x.type === 'order_filled')) limitFills.add(e.positionId);
      out.push(...events);
    }
    for (const p of this.portfolio.positions()) {
      if (p.symbol !== c.symbol) continue;
      const costs = costsFor(this.cfg, p.speed);
      if (p.pendingClose && p.pendingClose.placedAt <= c.openTime) {
        out.push(this.closePosition(p, marketFill(p.side, 'close', c.open, costs), p.pendingClose.reason, at));
        continue;
      }
      // Its stop in this candle was settled with the fill; a target is not counted until the next candle.
      if (p.openedAt > c.openTime || limitFills.has(p.id)) continue;
      // Stop first: when a candle reaches both, assume the worse happened first.
      if (p.liqPrice !== null && sign(p.side) * (p.liqPrice - p.stop) >= 0 && (p.side === 'long' ? c.low <= p.liqPrice : c.high >= p.liqPrice)) {
        out.push(this.emit('liquidated', p.id, p.symbol, { price: p.liqPrice, qty: p.qty, pnl: grossPnl(p.side, p.entryPrice, p.liqPrice, p.qty), fee: 0 }));
        continue;
      }
      const stopPrice = stopFill(p.side, p.stop, c, costs);
      if (stopPrice !== null) {
        out.push(this.closePosition(p, stopPrice, 'stop', at));
        continue;
      }
      if (p.target !== null && !(this.cfg.exits.mode === 'partial_ladder' && p.partialDone)) {
        // A scalp's take-profit rests on the book as a limit (maker, no slippage); others fill as a market order.
        const resting = p.setup === 'scalp' && this.cfg.exits.mode === 'fixed';
        const tp = resting ? restingTargetFill(p.side, p.target, c) : targetFill(p.side, p.target, c, costs);
        if (tp !== null) out.push(...this.takeTarget(p, tp, at, resting));
      }
    }
    this.resolveShadows(c);
    return out;
  }

  private fillEntry(e: ReturnType<Portfolio['pendingEntries']>[number], c: Candle, at = this.clock): TradeEvent[] {
    const cfg = this.cfg;
    const costs = costsFor(cfg, e.speed);
    const s = sign(e.side);
    const cancel = (reason: string, extra: Record<string, unknown> = {}) =>
      [this.emit('order_cancelled', e.positionId, e.symbol, { reason, price: e.refPrice, ...extra })];

    if (e.orderType === 'limit') {
      // A candle that runs through the limit and on through the stop filled it on the way (handled below).
      const limitReached = e.side === 'long' ? c.low <= e.refPrice : c.high >= e.refPrice;
      if (!limitReached) {
        const targetReached = e.target !== null && (e.side === 'long' ? c.high >= e.target : c.low <= e.target);
        return targetReached ? cancel('target_reached_before_fill') : [];
      }
    }

    const rawPrice = e.orderType === 'limit'
      ? (e.side === 'long' ? Math.min(e.refPrice, c.open) : Math.max(e.refPrice, c.open))
      : c.open;
    const price = e.orderType === 'limit'
      ? rawPrice
      : marketFill(e.side, 'open', c.open, costs);

    if (s * (price - e.stop) <= 0) return cancel('filled_beyond_stop');
    // A limit rested on the book only if this candle opened on the far side of it and price then came to it;
    // one the candle opened through was marketable at once: a taker fill.
    const maker = e.orderType === 'limit' && s * (c.open - e.refPrice) > 0;

    // Size from the fill: the loss at the stop must still fit the cap.
    const equity = equityOf(this.portfolio, (x) => this.priceOf(x));
    const lossPct = (Math.abs(price - e.stop) / price) * 100 + (maker ? limitRoundTripPct(costs) : roundTripPct(costs));
    // A size chosen by hand carries its own ceiling; otherwise the rules' risk per trade.
    const riskPct = e.maxRiskPct ?? Math.min(cfg.allocation.max_loss_per_trade_pct, speedSettings(cfg, e.speed).risk_pct);
    const maxNotional = ((riskPct / 100) * equity / lossPct) * 100;
    const rules = this.rules.get(e.symbol);
    const qty = roundQty(Math.min(e.notional, maxNotional) / price, rules?.stepSize ?? 0);
    if (qty <= 0 || qty < (rules?.minQty ?? 0) || qty * price < (rules?.minNotional ?? 5)) return cancel('size_too_small', { qty });

    const liqPrice = liquidationPrice(e.side, price, cfg.leverage, cfg.sim.maintenance_margin_pct);
    if (s * (e.stop - liqPrice) <= 0) return cancel('liquidation_before_stop', { liqPrice });

    const fill: EntryFill = {
      role: 'entry', side: e.side, qty, price, stop: e.stop, target: e.target,
      fee: fee(qty * price, cfg.sim, maker), session: this.sessions.ownerAt(e.placedAt),
      leverage: cfg.leverage, liqPrice, chochLevel: e.chochLevel, signalId: e.signalId, speed: e.speed ?? 'normal', setup: e.setup,
      ...(e.note ? { note: e.note } : {}), ...(e.maxHoldMin ? { maxHoldMin: e.maxHoldMin } : {}),
      ...(e.progressCheckMin && e.progressMinR ? { progressCheckMin: e.progressCheckMin, progressMinR: e.progressMinR } : {}),
    };
    // Recorded at the candle's open: the moment the fill happened.
    const filled = this.emit('order_filled', e.positionId, e.symbol, { ...fill, notional: qty * price, margin: (qty * price) / cfg.leverage }, c.openTime);
    if (e.orderType !== 'limit') return [filled];
    // The same candle also reached the stop: filled, then stopped out. Which came first inside the candle is
    // unknown, so the worse is assumed, as everywhere else; a cancelled order would hide a real loss.
    const pos = this.portfolio.get(e.positionId);
    const stopPrice = pos ? stopFill(pos.side, pos.stop, c, costs) : null;
    return pos && stopPrice !== null ? [filled, this.closePosition(pos, stopPrice, 'stop', at)] : [filled];
  }

  private takeTarget(p: Position, price: number, at = this.clock, maker = false): TradeEvent[] {
    const cfg = this.cfg;
    if (cfg.exits.mode === 'fixed') return [this.closePosition(p, price, 'target', at, maker)];
    // partial_ladder: close part at the first objective, protect the rest at breakeven plus fees.
    const rules = this.rules.get(p.symbol);
    const qty = roundQty(p.qty * (cfg.exits.partial_close_pct / 100), rules?.stepSize ?? 0);
    if (qty <= 0 || qty >= p.qty) return [this.closePosition(p, price, 'target', at)];
    const out = [this.emit('partial_closed', p.id, p.symbol, {
      qty, price, pnl: grossPnl(p.side, p.entryPrice, price, qty), fee: fee(qty * price, cfg.sim), reason: 'target',
    })];
    const be = p.entryPrice * (1 + (sign(p.side) * cfg.exits.breakeven_fee_buffer_pct) / 100);
    if (sign(p.side) * (be - p.stop) > 0) out.push(this.emit('stop_moved', p.id, p.symbol, { stop: be, reason: 'breakeven after partial' }));
    return out;
  }

  /** `maker`: filled by a limit order resting on the book (a scalp's take-profit), which pays the maker fee. */
  private closePosition(p: Position, price: number, reason: CloseReason, time = this.clock, maker = false): TradeEvent {
    return this.emit('position_closed', p.id, p.symbol, {
      qty: p.qty, price, pnl: grossPnl(p.side, p.entryPrice, price, p.qty), fee: fee(p.qty * price, this.cfg.sim, maker), reason,
      holdMinutes: Math.round((time - p.openedAt) / 60_000),
    }, time);
  }

  /** Closes at once at `price` (a market order: slippage against the trade), replacing any close still waiting for a candle. */
  private closeNow(p: Position, reason: CloseReason, price: number, time: number): TradeEvent {
    return this.closePosition(p, marketFill(p.side, 'close', price, costsFor(this.cfg, p.speed)), reason, Math.max(time, p.openedAt));
  }

  // ---------------------------------------------------------------- account-wide limits

  /** Daily loss limit bookkeeping, drawdown kill switch, and BTC flash crash circuit breaker. */
  private guardrails(): TradeEvent[] {
    const equity = equityOf(this.portfolio, (s) => this.priceOf(s));
    const today = Math.floor(this.clock / DAY);
    if (this.dayStart.day !== today) this.dayStart = { day: today, equity };
    if (equity > this.peakEquity) this.peakEquity = equity;
    const drawdown = (1 - equity / this.peakEquity) * 100;
    const out: TradeEvent[] = [];
    if (!this.portfolio.halted && drawdown >= this.cfg.risk.max_drawdown_kill_pct) {
      out.push(...this.closeAll('kill'));
      out.push(this.emit('engine_halted', null, null, { reason: `drawdown ${drawdown.toFixed(1)}% from peak`, equity, peakEquity: this.peakEquity }));
      return out;
    }
    const cb = this.cfg.risk.btc_circuit_breaker;
    if (cb && cb.enabled) {
      const btc5m = this.btcChange5mPct();
      if (btc5m !== null && btc5m <= cb.drop_5m_pct) {
        const until = this.clock + cb.cooldown_min * 60_000;
        if (until > this.circuitBreakerUntil) {
          this.circuitBreakerUntil = until;
          this.circuitBreakerReason = `BTC dropped ${btc5m.toFixed(2)}% in 5m (threshold ${cb.drop_5m_pct}%)`;
          if (cb.cancel_pending_limits) {
            for (const e of this.portfolio.pendingEntries()) {
              if (e.symbol !== 'BTCUSDT' && e.side === 'long') {
                out.push(this.emit('order_cancelled', e.positionId, e.symbol, {
                  reason: 'btc_circuit_breaker',
                  placedAt: e.placedAt,
                  btcDropPct: btc5m,
                }));
              }
            }
          }
        }
      }
    }
    return out;
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
      if (this.cfg.htf_poi.directions && !this.cfg.htf_poi.directions.includes(dir)) continue;
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
      if (this.isCircuitBreakerActive() && symbol !== 'BTCUSDT' && dir === 'long') continue;
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
      if (this.cfg.htf_poi.directions && !this.cfg.htf_poi.directions.includes(dir)) continue;
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
    const btcCheck = btc(ctx, a.direction);
    const exhaustCheck = exhaustion(ctx, a.direction);
    const failures = [
      ...(block ? [`session_${block}`] : []),
      ...this.planFailures(ctx, planned.plan),
      ...(fundingCheck.pass ? [] : ['filter_funding']),
      ...(btcCheck.pass ? [] : ['filter_btc']),
      ...(exhaustCheck.pass ? [] : ['filter_exhaustion']),
      ...(this.isCircuitBreakerActive() && ctx.symbol !== 'BTCUSDT' && a.direction === 'long' ? ['filter_btc_circuit_breaker'] : []),
    ];
    return this.submit({
      ctx, id: a.id, direction: a.direction, setup: 'htf_poi', plan: planned.plan, score: a.factors.length, failures, level: chochLevel,
      payload: { ...detail, filters: [fundingCheck, btcCheck, exhaustCheck] },
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
      ...(this.isCircuitBreakerActive() && ctx.symbol !== 'BTCUSDT' && a.direction === 'long' ? ['filter_btc_circuit_breaker'] : []),
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
    const btcCheck = btc(ctx, a.direction);
    const exhaustCheck = exhaustion(ctx, a.direction);
    const failures = [
      ...(block ? [`session_${block}`] : []),
      ...(conf.sweep ? [] : ['no_sweep']),
      ...this.planFailures(ctx, planned.plan),
      ...(fundingCheck.pass ? [] : ['filter_funding']),
      ...(btcCheck.pass ? [] : ['filter_btc']),
      ...(exhaustCheck.pass ? [] : ['filter_exhaustion']),
      ...(this.isCircuitBreakerActive() && ctx.symbol !== 'BTCUSDT' && a.direction === 'long' ? ['filter_btc_circuit_breaker'] : []),
    ];
    return this.submit({
      ctx, id: a.id, direction: a.direction, setup: 'zone_sweep', plan: planned.plan, score: a.factors.length, failures, level: conf.level,
      payload: { ...detail, filters: [fundingCheck, btcCheck, exhaustCheck] },
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
        filled: false, fillBy: ctx.t + cfg.sim.limit_entry_timeout_min * 60_000,
      });
    }
    if (status !== 'taken') return [];

    const target = cfg.exits.mode === 'ladder' ? null : plan.target;
    const order: OpenOrder = {
      action: 'open', orderType: 'limit', side: direction, notional: risk!.notional, stop: plan.stop, target,
      chochLevel: level, signalId: id, refPrice: plan.entry, speed: ctx.speed ?? 'normal', setup,
      entryTimeoutMin: cfg.sim.limit_entry_timeout_min,
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
      const btcCheck = btc(ctx, dir);
      const exhaustCheck = exhaustion(ctx, dir);
      const failures = [
        ...this.planFailures(ctx, sig.plan),
        ...(fundingCheck.pass ? [] : ['filter_funding']),
        ...(btcCheck.pass ? [] : ['filter_btc']),
        ...(exhaustCheck.pass ? [] : ['filter_exhaustion']),
      ];
      out.push(...this.submit({
        ctx, id, direction: dir, setup: 'session_sweep', plan: sig.plan, score: sig.confluence.length, failures, level: sig.swept.price,
        payload: { ...detail, filters: [fundingCheck, btcCheck, exhaustCheck] },
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
      // Like the order it shadows: a limit at the entry, filled when the price comes back to it in time.
      const fillCandle = !sh.filled;
      if (!sh.filled) {
        const targetFirst = sh.direction === 'long' ? c.high >= target : c.low <= target;
        if (!(sh.direction === 'long' ? c.low <= entry : c.high >= entry)) {
          if (!targetFirst && c.closeTime < sh.fillBy) return true;
          this.signal(sh.symbol, sh.direction, 'expired', targetFirst ? 'target_reached_before_fill' : 'not_filled',
            { armedId: sh.armedId, signalStatus: sh.signalStatus, speed: sh.speed }, sh.setup);
          return false;
        }
        sh.filled = true;
      }
      const stopHit = sh.direction === 'long' ? c.low <= stop : c.high >= stop;
      const best = sh.direction === 'long' ? c.high : c.low;
      // Going our way: the first candle that reaches 1R in favour (not one that also hits the stop: order unknown,
      // stop first; not the fill candle: whether the high came before or after the fill is unknown).
      if (!sh.working && !stopHit && !fillCandle && s * (best - entry) >= risk) {
        sh.working = true;
        this.signal(sh.symbol, sh.direction, 'working', null, { armedId: sh.armedId, price: entry + s * risk, r: 1, signalStatus: sh.signalStatus, speed: sh.speed }, sh.setup);
      }
      if (stopHit) { outcome = 'stop'; exit = stop; }
      else if (!fillCandle && (sh.direction === 'long' ? c.high >= target : c.low <= target)) { outcome = 'target'; exit = target; }
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

/**
 * Scalp trades logged before the max hold and entry timeout were fields of the order: read from the
 * note the dashboard and the autopilot wrote then ("Quant Autopilot [5m]: …", "Quant Scalp (5m): …").
 */
/** A readable refusal for a size chosen by hand; null for any other reason. */
function sizeRefusal(r: RiskDecision): string | null {
  const d = r.detail;
  const usd = (x: unknown) => `$${Number(x).toFixed(2)}`;
  switch (r.reason) {
    case 'risk_size_invalid': return 'The size must be a positive number';
    case 'risk_size_over_ceiling':
      return `That size would lose ${Number(d.wantedRiskPct).toFixed(2)}% of the account at the stop (${Number(d.stopPct).toFixed(2)}% away); manual trades may risk at most ${d.ceilingPct}%`;
    case 'risk_size_capped': {
      const why: Record<string, string> = { exposure: 'total exposure (leverage) limit', open_risk: 'open risk limit across your trades', volume: "coin's 1h volume limit" };
      const caps = String(d.caps).split(',').map((x) => why[x] ?? x).join(' and ');
      return `Not placed: ${usd(d.allowedNotional)} is the most the ${caps} allows here; choose that size or less`;
    }
    default: return null;
  }
}

function legacyScalp(note: string | null | undefined): { holdMin: number; timeoutMin: number } | null {
  const tf = /^Quant (?:Autopilot|Scalp) [[(](1m|5m|15m)[\])]/.exec(note ?? '')?.[1];
  if (!tf) return null;
  return tf === '1m' ? { holdMin: 45, timeoutMin: 15 } : tf === '5m' ? { holdMin: 120, timeoutMin: 35 } : { holdMin: 240, timeoutMin: 60 };
}

export { lastOf, TIMEFRAME_MS };
