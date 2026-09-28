import { describe, expect, it } from 'vitest';
import { loadConfig, type EngineConfig } from '../src/config';
import { fee, grossPnl, liquidationPrice, marketFill, roundQty, stopFill, targetFill } from '../src/sim/broker';
import { decideEntry, type RiskInput } from '../src/risk';
import { Portfolio, type EntryFill, type OpenOrder } from '../src/portfolio';
import { manage } from '../src/exits';
import { series, type Context } from '../src/strategy/context';
import { Engine } from '../src/core/engine';
import type { Candle, TradeEvent } from '../../shared/types';

const cfg = loadConfig('engine/config/config.yaml');
const costs = cfg.sim;   // taker 0.05%, slippage 0.05%
const u = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z';
const flat = (n: number, v: number) => new Array<number>(n).fill(v);

const bar = (o: number, h: number, l: number, c: number, openTime = 0, symbol = 'SOLUSDT', tf: Candle['tf'] = '1m'): Candle =>
  ({ symbol, tf, openTime, closeTime: openTime + (tf === '1m' ? 60_000 : 900_000), open: o, high: h, low: l, close: c, volume: 100, quoteVolume: 100 * c, trades: 1 });

const ev = (time: number, type: TradeEvent['type'], positionId: string | null, symbol: string | null, payload: Record<string, unknown>): TradeEvent =>
  ({ time, type, positionId, symbol, payload, engineVersion: 't', configHash: 't' });

describe('broker', () => {
  it('market fills slip against the trade', () => {
    expect(marketFill('long', 'open', 100, costs)).toBeCloseTo(100.05, 9);
    expect(marketFill('long', 'close', 100, costs)).toBeCloseTo(99.95, 9);
    expect(marketFill('short', 'open', 100, costs)).toBeCloseTo(99.95, 9);
    expect(marketFill('short', 'close', 100, costs)).toBeCloseTo(100.05, 9);
  });

  it('a stop fills at the stop, or at the open after a gap through it', () => {
    expect(stopFill('long', 98, bar(100, 101, 98.5, 99), costs)).toBeNull();
    expect(stopFill('long', 98, bar(100, 101, 97, 99), costs)).toBeCloseTo(98 * 0.9995, 9);
    expect(stopFill('long', 98, bar(96, 97, 95, 96.5), costs)).toBeCloseTo(96 * 0.9995, 9);
    expect(stopFill('short', 102, bar(103, 104, 102.5, 103), costs)).toBeCloseTo(103 * 1.0005, 9);
  });

  it('a target fills at the target, never better', () => {
    expect(targetFill('long', 105, bar(106, 107, 105.5, 106), costs)).toBeCloseTo(105 * 0.9995, 9);
    expect(targetFill('long', 105, bar(100, 104.9, 99, 104), costs)).toBeNull();
  });

  it('fees, profit, liquidation and lot rounding', () => {
    expect(fee(1000, costs)).toBeCloseTo(0.5, 9);
    expect(grossPnl('short', 100, 90, 2)).toBe(20);
    expect(liquidationPrice('long', 100, 3, 0.5)).toBeCloseTo(100 * (1 - 1 / 3 + 0.005), 9);
    expect(roundQty(1.23456, 0.01)).toBe(1.23);
    expect(roundQty(7.9, 1)).toBe(7);
  });
});

describe('risk', () => {
  const base = (over: Partial<RiskInput> = {}, config: EngineConfig = cfg): RiskInput => ({
    config, t: u('2026-07-15T10:00Z'), symbol: 'SOLUSDT', side: 'long', entry: 100, stop: 98,
    portfolio: new Portfolio(1000), priceOf: () => 100, dayStartEquity: 1000, lastHourVolume: null, rules: null, score: 5, ...over,
  });

  it('flat 10%, shrunk so the loss at the stop with costs is at most 1% of equity', () => {
    // 10% of 1000 = 100 notional; loss at 2% stop + 0.2% costs = 2.2 < 10: no shrink.
    expect(decideEntry(base()).notional).toBeCloseTo(100, 9);
    // With 1% loss cap: a 10% position with a 12% stop would lose 12.2: shrink to 10 / 12.2%.
    const wide = { ...cfg, exits: { ...cfg.exits } };
    const d = decideEntry(base({ stop: 88 }, wide));
    expect(d.notional).toBeCloseTo((10 / 12.2) * 100, 6);
    expect(d.detail.caps).toBe('loss_cap');
  });

  it('caps by 1h volume, and refuses when too small', () => {
    expect(decideEntry(base({ lastHourVolume: 5000 })).notional).toBeCloseTo(50, 9);
    expect(decideEntry(base({ lastHourVolume: 1000 }))).toMatchObject({ ok: false, reason: 'risk_size_too_small' });
  });

  it('one position per symbol, max open trades, cooldown after a loss, daily limit, halted', () => {
    const p = new Portfolio(1000);
    const fill = (id: string, symbol: string, time: number): TradeEvent =>
      ev(time, 'order_filled', id, symbol, { role: 'entry', side: 'long', qty: 1, price: 100, stop: 98, session: null } satisfies EntryFill);
    p.apply(fill('a', 'SOLUSDT', u('2026-07-15T09:00Z')));
    expect(decideEntry(base({ portfolio: p })).reason).toBe('risk_already_in_symbol');

    p.apply(ev(u('2026-07-15T09:50Z'), 'position_closed', 'a', 'SOLUSDT', { qty: 1, price: 97, pnl: -3, fee: 0, reason: 'stop' }));
    expect(decideEntry(base({ portfolio: p })).reason).toBe('risk_cooldown_after_loss');
    expect(decideEntry(base({ portfolio: p, t: u('2026-07-15T10:21Z') })).ok).toBe(true);

    const full = new Portfolio(1000);
    ['A', 'B', 'C', 'D', 'E'].forEach((s, i) => full.apply(fill(s, `${s}USDT`, i)));
    expect(decideEntry(base({ portfolio: full })).reason).toBe('risk_max_open_trades');

    expect(decideEntry(base({ dayStartEquity: 1031 })).reason).toBe('risk_daily_loss_limit');
    const halted = new Portfolio(1000);
    halted.apply(ev(0, 'engine_halted', null, null, { reason: 'test' }));
    expect(decideEntry(base({ portfolio: halted })).reason).toBe('risk_halted');
  });

  it('at most 2 trades in a correlation group (1000PEPE counts as PEPE)', () => {
    const p = new Portfolio(1000);
    ['DOGEUSDT', '1000PEPEUSDT'].forEach((s, i) => p.apply(ev(i, 'order_filled', s, s, { role: 'entry', side: 'long', qty: 0.1, price: 100, stop: 99.9, session: null })));
    expect(decideEntry(base({ portfolio: p, symbol: 'WIFUSDT' })).reason).toBe('risk_correlated');
  });

  it('tiers by score when sizing is tiers', () => {
    const tiers = { ...cfg, allocation: { ...cfg.allocation, sizing: 'tiers' as const } };
    expect(decideEntry(base({ score: 6 }, tiers)).detail.capitalPct).toBe(30);
    expect(decideEntry(base({ score: 3 }, tiers)).reason).toBe('risk_score_below_tiers');
  });
});

describe('account bookkeeping', () => {
  it('fees, partial profit, funding and the final close all reach the balance', () => {
    const p = new Portfolio(1000);
    p.apply(ev(1, 'order_filled', 'x', 'SOLUSDT', { role: 'entry', side: 'long', qty: 2, price: 100, stop: 98, fee: 0.1, session: null }));
    p.apply(ev(2, 'partial_closed', 'x', 'SOLUSDT', { qty: 1, price: 105, pnl: 5, fee: 0.05 }));
    p.apply(ev(3, 'funding_charged', 'x', 'SOLUSDT', { amount: -0.02 }));
    p.apply(ev(4, 'position_closed', 'x', 'SOLUSDT', { qty: 1, price: 103, pnl: 3, fee: 0.05, reason: 'stop' }));
    expect(p.balance).toBeCloseTo(1000 - 0.1 + 5 - 0.05 - 0.02 + 3 - 0.05, 9);
    expect(p.closedTrades()[0]).toMatchObject({ pnl: expect.closeTo(7.78, 9), reason: 'stop', qty: 2 });
    expect(p.positions()).toEqual([]);
  });

  it('three losses in a row cut size until two wins', () => {
    const p = new Portfolio(1000, cfg.risk.losing_streak_size_cut);
    const trade = (id: string, pnl: number) => {
      p.apply(ev(0, 'order_filled', id, 'X', { role: 'entry', side: 'long', qty: 1, price: 100, stop: 90, session: null }));
      p.apply(ev(1, 'position_closed', id, 'X', { qty: 1, price: 100 + pnl, pnl, fee: 0, reason: 'stop' }));
    };
    trade('a', -1); trade('b', -1);
    expect(p.sizeCutActive).toBe(false);
    trade('c', -1);
    expect(p.sizeCutActive).toBe(true);
    trade('d', 2);
    expect(p.sizeCutActive).toBe(true);
    trade('e', 2);
    expect(p.sizeCutActive).toBe(false);
  });
});

describe('trade management', () => {
  const pos = (over = {}) => ({
    id: 'p', symbol: 'SOLUSDT', side: 'long' as const, qty: 1, initialQty: 1, entryPrice: 100, stop: 98, initialStop: 98, target: 105,
    openedAt: u('2026-07-15T10:00Z'), session: null, leverage: 3, liqPrice: 70, chochLevel: null, signalId: null,
    ladderStep: -1, partialDone: false, fees: 0, funding: 0, realized: 0, pendingClose: null, ...over,
  });
  const ctx = (price: number, over: Partial<Context> = {}): Context => ({
    symbol: 'SOLUSDT', t: u('2026-07-15T11:00Z'), config: cfg,
    analysis: { symbol: 'SOLUSDT', asOf: 0, structure: { '4h': null, '1h': null, '15m': null }, ema4h: { fast: 1, slow: 1, close: 1 },
      long: { state: 'strong', emaAligned: true, tradable: true }, short: { state: 'reversed', emaAligned: false, tradable: false }, zones: [], fvgs: [], profiles: [], trendMeter: { '4h': { structure: null, supertrend: null, line: null }, '1h': { structure: null, supertrend: null, line: null }, '15m': { structure: null, supertrend: null, line: null } }, adx1h: null },
    h4: series([]), h1: series([]), m15: series(Array.from({ length: 30 }, (_, i) => bar(price, price + 0.1, price - 0.1, price, i * 900_000, 'SOLUSDT', '15m'))),
    price, atr1h: flat(30, 2), atr15m: flat(30, 0.5), ema1h: {}, ema15m20: flat(30, price), vwap15m: flat(30, price), rsi15m: flat(30, 55),
    rvol15m: flat(30, 1), adx1h: flat(30, 30), chop1h: flat(30, 40), bbw1h: flat(30, 0.02), pivots1h: [], pivots15m: [], pivots4h: [],
    btcChange1hPct: 0, btcAnalysis: null, funding: null, ...over,
  });

  it('ladder: +3% locks breakeven plus fees, +5% locks +2%', () => {
    expect(manage({ ctx: ctx(103), pos: pos(), peakPct: 3.1, candlesSinceEntry: 4 })).toEqual([{ type: 'stop', stop: expect.closeTo(100.2, 9), reason: 'ladder step 1', ladderStep: 0 }]);
    expect(manage({ ctx: ctx(105), pos: pos(), peakPct: 5, candlesSinceEntry: 8 })[0]).toMatchObject({ stop: expect.closeTo(102, 9), ladderStep: 1 });
  });

  it('never closer than 1x 15m ATR to price, and never loosens', () => {
    // Peak was 5% but price is back at 102.3: the +2% lock would sit 0.3 under price; capped to 101.8.
    expect(manage({ ctx: ctx(102.3), pos: pos(), peakPct: 5, candlesSinceEntry: 8 })[0]).toMatchObject({ stop: expect.closeTo(101.8, 9) });
    expect(manage({ ctx: ctx(105), pos: pos({ stop: 102.5, ladderStep: 1 }), peakPct: 5, candlesSinceEntry: 8 })).toEqual([]);
  });

  it('beyond the last step: 70% of the peak', () => {
    expect(manage({ ctx: ctx(115), pos: pos({ stop: 107, ladderStep: 3 }), peakPct: 15, candlesSinceEntry: 20 })[0]).toMatchObject({ stop: expect.closeTo(110.5, 9) });
  });

  it('time stop: 3 hours without +2% and no ladder step', () => {
    expect(manage({ ctx: ctx(100.5, { t: u('2026-07-15T13:00Z') }), pos: pos(), peakPct: 1, candlesSinceEntry: 12 })).toEqual([{ type: 'close', reason: 'time_stop' }]);
    expect(manage({ ctx: ctx(100.5, { t: u('2026-07-15T12:45Z') }), pos: pos(), peakPct: 1, candlesSinceEntry: 11 })).toEqual([]);
  });

  it('early exits: 4h trend lost, 1h weakening, failed breakout, stagnation', () => {
    const c = ctx(100.4);
    c.analysis.long = { state: 'transition', emaAligned: true, tradable: false };
    expect(manage({ ctx: c, pos: pos(), peakPct: 0.4, candlesSinceEntry: 2 })).toEqual([{ type: 'close', reason: 'early_exit_4h' }]);
    const w = ctx(100.4);
    w.analysis.long = { state: 'weakening', emaAligned: true, tradable: false };
    expect(manage({ ctx: w, pos: pos(), peakPct: 0.4, candlesSinceEntry: 2 })).toEqual([{ type: 'close', reason: 'early_exit_1h' }]);
    expect(manage({ ctx: ctx(99.5), pos: pos({ chochLevel: 99.8 }), peakPct: 0.2, candlesSinceEntry: 2 })).toEqual([{ type: 'close', reason: 'failed_breakout' }]);
    expect(manage({ ctx: ctx(100.3, { rvol15m: flat(30, 0.3) }), pos: pos(), peakPct: 0.5, candlesSinceEntry: 6 })).toEqual([{ type: 'close', reason: 'stagnation' }]);
  });
});

describe('simulated trading, end to end', () => {
  const T = u('2026-07-15T10:00Z');
  const minute = (i: number, o: number, h: number, l: number, c: number) => bar(o, h, l, c, T + i * 60_000);

  function engine(over: (c: EngineConfig) => void = () => {}) {
    const config = structuredClone(cfg);
    over(config);
    const e = new Engine({ config, configHash: 't', engineVersion: 't' });
    return e;
  }
  const order = (over: Partial<OpenOrder> = {}): TradeEvent =>
    ev(T, 'order_placed', 'p1', 'SOLUSDT', { action: 'open', orderType: 'market', side: 'long', notional: 100, stop: 98, target: 105, chochLevel: null, signalId: 's1', refPrice: 100, ...over } satisfies OpenOrder);

  it('fills at the next minute\'s open with slippage and fee, then a stop closes it at a loss', () => {
    const e = engine();
    e.restore([order()], T);
    const out = e.onCandles([minute(0, 100, 100.5, 99.5, 100.2), minute(1, 100.2, 100.3, 97.5, 97.8)]);
    const filled = out.find((x) => x.type === 'order_filled')!;
    expect(filled.payload.price).toBeCloseTo(100.05, 9);
    expect(filled.payload.qty).toBeCloseTo(100 / 100.05, 9);
    expect(filled.payload.session).toMatchObject({ name: 'london' });
    expect(iso(filled.time)).toBe('2026-07-15T10:00Z');
    const closed = out.find((x) => x.type === 'position_closed')!;
    expect(closed.payload.reason).toBe('stop');
    expect(closed.payload.price).toBeCloseTo(98 * 0.9995, 9);
    const acct = e.account();
    expect(acct.positions).toEqual([]);
    expect(acct.balance).toBeLessThan(1000 - 2);
    expect(e.closedTrades()[0].pnl).toBeCloseTo(acct.balance - 1000, 9);
  });

  it('the first target takes half and protects the rest at breakeven plus fees', () => {
    const e = engine();
    e.restore([order({ notional: 1000 * 0.1 })], T);
    const out = e.onCandles([minute(0, 100, 100.5, 99.8, 100.2), minute(1, 100.2, 105.5, 100.1, 105)]);
    expect(out.map((x) => x.type)).toEqual(['order_filled', 'partial_closed', 'stop_moved']);
    const p = e.positions()[0];
    expect(p.partialDone).toBe(true);
    expect(p.stop).toBeCloseTo(100.05 * 1.002, 9);
    expect(p.qty).toBeCloseTo(p.initialQty - (out[1].payload.qty as number), 9);
  });

  it('a candle reaching both stop and target counts as the stop', () => {
    const e = engine();
    e.restore([order()], T);
    const out = e.onCandles([minute(0, 100, 100.5, 99.8, 100.2), minute(1, 100.2, 106, 97, 101)]);
    expect(out.filter((x) => x.type !== 'order_filled').map((x) => `${x.type} ${x.payload.reason}`)).toEqual(['position_closed stop']);
  });

  it('an entry with no price to fill at is cancelled', () => {
    const e = engine();
    e.restore([order()], T);
    const out = e.onCandles([bar(1, 1, 1, 1, T + 6 * 60_000, 'BTCUSDT')]);
    expect(out.map((x) => `${x.type} ${x.payload.reason}`)).toEqual(['order_cancelled no_price']);
  });

  it('funding is charged at 08:00 UTC on open positions', () => {
    const t8 = u('2026-07-15T08:00Z');
    const e = engine();
    e.onFunding('SOLUSDT', 0.0001);
    e.restore([ev(t8 - 3_600_000, 'order_filled', 'p1', 'SOLUSDT', { role: 'entry', side: 'long', qty: 2, price: 100, stop: 98, session: null })], t8 - 120_000);
    const out = e.onCandles([bar(100, 100, 100, 100, t8 - 120_000), bar(100, 100, 100, 100, t8 - 60_000)]);
    const f = out.find((x) => x.type === 'funding_charged')!;
    expect(iso(f.time)).toBe('2026-07-15T08:00Z');
    expect(f.payload.amount).toBeCloseTo(-2 * 100 * 0.0001, 12);
  });

  it('a 15% drawdown closes everything and halts new entries', () => {
    const e = engine();
    e.restore([ev(T, 'order_filled', 'p1', 'SOLUSDT', { role: 'entry', side: 'long', qty: 10, price: 100, stop: 50, session: null })], T);
    const out = e.onCandles([minute(0, 100, 100, 84, 84)]);
    expect(out.map((x) => `${x.type} ${x.payload.reason ?? ''}`)).toEqual(['order_placed kill', expect.stringMatching(/^engine_halted drawdown 16/)]);
    expect(e.account().halted).not.toBeNull();
  });

  it('pause, resume and a balance reset', () => {
    const e = engine();
    expect(e.onCommand({ type: 'pause' }).map((x) => x.type)).toEqual(['engine_halted']);
    expect(e.onCommand({ type: 'resume' }).map((x) => x.type)).toEqual(['engine_resumed']);
    expect(e.onCommand({ type: 'reset_balance', balance: 500 })[0].payload).toEqual({ balance: 500 });
    expect(e.account().balance).toBe(500);
  });
});
