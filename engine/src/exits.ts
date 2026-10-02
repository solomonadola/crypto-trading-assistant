// Trade management at each 15m close (ENGINE_PLAN.md Section 9): the profit
// ladder, the time stop and the early exits. Stops, targets and session ends
// are handled on 1m candles by the engine. The stop only ever moves in the
// trade's favour, and never closer than min_gap_atr_15m x 15m ATR to price.
import type { Position, CloseReason } from './portfolio';
import { lastOf, sign, type Context } from './strategy/context';

export type ManageAction =
  | { type: 'stop'; stop: number; reason: string; ladderStep?: number }
  | { type: 'close'; reason: CloseReason }
  | { type: 'close_half'; reason: string };

export interface ManageInput {
  ctx: Context;
  pos: Position;
  /** Best 15m close gain since entry, including this close, percent. */
  peakPct: number;
  /** 15m candles closed since the entry fill, including this one. */
  candlesSinceEntry: number;
}

/** What to do with an open position at this 15m close. At most one close; stop moves only when they tighten. */
export function manage(i: ManageInput): ManageAction[] {
  const { ctx, pos } = i;
  const cfg = ctx.config.exits;
  const early = cfg.early_exit;
  const s = sign(pos.side);
  const price = ctx.price;
  const atr15 = lastOf(ctx.atr15m);
  const state = ctx.analysis[pos.side].state;
  if (cfg.management === 'v3') return manageV3(i);

  // Closes, most fundamental first.
  if ((state === 'transition' || state === 'reversed' || state === 'none') && early.on_4h_state_change === 'close') return [{ type: 'close', reason: 'early_exit_4h' }];
  if (state === 'weakening' && early.on_1h_protected_level_break === 'close') return [{ type: 'close', reason: 'early_exit_1h' }];
  if (ctx.config.filters.fakeout.enabled && pos.chochLevel !== null && i.candlesSinceEntry <= ctx.config.filters.fakeout.failed_breakout_candles
    && s * (price - pos.chochLevel) < 0) return [{ type: 'close', reason: 'failed_breakout' }];
  const st = early.stagnation;
  if (i.candlesSinceEntry >= st.candles && i.peakPct < st.max_peak_pct
    && ctx.rvol15m.slice(-st.candles).every((r) => r < st.rvol_max)) return [{ type: 'close', reason: 'stagnation' }];
  const btcAgainst = ctx.btcChange1hPct === null ? 0 : -s * ctx.btcChange1hPct;
  if (btcAgainst > early.on_btc_move_1h_pct && early.on_btc_move_action === 'close') return [{ type: 'close', reason: 'btc_move' }];
  if (ctx.t - pos.openedAt >= cfg.time_stop_hours * 3_600_000 && pos.ladderStep < 0 && i.peakPct < cfg.time_stop_min_progress_pct) {
    return [{ type: 'close', reason: 'time_stop' }];
  }

  const actions: ManageAction[] = [];
  // Candidate stops; the most protective that is allowed wins.
  const candidates: { stop: number; reason: string; ladderStep?: number }[] = [];
  const at = (pct: number) => pos.entryPrice * (1 + (s * pct) / 100);

  let step = -1;
  cfg.ladder.forEach((l, k) => { if (i.peakPct >= l.trigger_pct) step = k; });
  if (step >= 0) candidates.push({ stop: at(cfg.ladder[step].lock_pct), reason: `ladder step ${step + 1}`, ladderStep: step });
  const lastTrigger = cfg.ladder[cfg.ladder.length - 1].trigger_pct;
  if (i.peakPct > lastTrigger) {
    let beyond = at(cfg.beyond_last_step.lock_fraction_of_peak * i.peakPct);
    if (cfg.beyond_last_step.or_swing_15m) {
      const swing = [...ctx.pivots15m].reverse().find((p) => p.type === (pos.side === 'long' ? 'low' : 'high') && s * (price - p.price) > 0);
      if (swing && s * (swing.price - beyond) > 0) beyond = swing.price;
    }
    candidates.push({ stop: beyond, reason: 'trailing beyond last step', ladderStep: cfg.ladder.length - 1 });
  }

  if (counterChoch(ctx, pos.side)) {
    if (early.on_15m_counter_choch === 'tighten') candidates.push({ stop: price - s * cfg.min_gap_atr_15m * atr15, reason: '15m counter-CHoCH' });
    else if (early.on_15m_counter_choch === 'close_half' && !pos.partialDone) actions.push({ type: 'close_half', reason: '15m counter-CHoCH' });
  }
  if (btcAgainst > early.on_btc_move_1h_pct && early.on_btc_move_action === 'tighten') {
    candidates.push({ stop: at(cfg.breakeven_fee_buffer_pct), reason: 'BTC moved against the trade' });
  }

  // Never closer than the minimum gap to price; only ever tighter than now.
  const limit = price - s * cfg.min_gap_atr_15m * atr15;
  let best: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    const stop = s * (c.stop - limit) > 0 ? limit : c.stop;
    if (s * (stop - pos.stop) > 1e-12 && (!best || s * (stop - best.stop) > 0)) best = { ...c, stop };
  }
  if (best) actions.push({ type: 'stop', ...best });
  return actions;
}

/**
 * Strategy v3 (Section 18.6): only the max hold and break-even after a new
 * 15m BOS in the trade's direction. The stop and take-profit run on 1m.
 */
function manageV3({ ctx, pos }: ManageInput): ManageAction[] {
  const cfg = ctx.config;
  const s = sign(pos.side);
  const maxHold = cfg.speed.groups[pos.speed ?? 'normal'].max_hold_hours * 3_600_000;
  if (ctx.t - pos.openedAt >= maxHold) return [{ type: 'close', reason: 'max_hold' }];
  // A swing formed after the entry, closed through: structure broke in our favour.
  const m = ctx.m15;
  const n = m.close.length - 1;
  const swing = [...ctx.pivots15m].reverse()
    .find((p) => p.type === (pos.side === 'long' ? 'high' : 'low') && p.index < n && m.candles[p.index].openTime >= pos.openedAt);
  if (!swing || s * (m.close[n] - swing.price) <= 0) return [];
  const breakeven = pos.entryPrice * (1 + (s * cfg.exits.breakeven_fee_buffer_pct) / 100);
  if (s * (breakeven - pos.stop) <= 1e-12) return [];       // already there or better
  return [{ type: 'stop', stop: breakeven, reason: 'break-even after a new 15m BOS' }];
}

/** Against a long: the 15m had made a higher low, and this candle is the first to close below it. Mirrored for a short. */
function counterChoch(ctx: Context, side: Position['side']): boolean {
  const s = sign(side);
  const type = side === 'long' ? 'low' : 'high';
  const swings = ctx.pivots15m.filter((p) => p.type === type);
  if (swings.length < 2) return false;
  const [prev, latest] = swings.slice(-2);
  const n = ctx.m15.close.length - 1;
  return s * (latest.price - prev.price) > 0
    && s * (ctx.m15.close[n] - latest.price) < 0
    && s * (ctx.m15.close[n - 1] - latest.price) >= 0;
}
