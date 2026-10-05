// Risk and sizing (ENGINE_PLAN.md Section 10). Decides whether a taken
// signal may become an entry and how large it is. The loss at the stop,
// including fees and slippage, never exceeds max_loss_per_trade_pct of equity.
import type { EngineConfig } from './config';
import type { Position, PendingEntry, Portfolio, Side } from './portfolio';
import { coinOf } from './symbols';
import { costsFor, roundTripPct, speedSettings, type SpeedGroup } from './speed';

export interface SymbolRules {
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface RiskInput {
  config: EngineConfig;
  t: number;
  symbol: string;
  side: Side;
  entry: number;
  stop: number;
  portfolio: Portfolio;
  /** Latest price per symbol, for open positions' value. */
  priceOf: (symbol: string) => number | null;
  /** Equity at the start of the UTC day (for the daily loss limit). */
  dayStartEquity: number;
  /** The coin's last 1h USDT volume, or null if unknown. */
  lastHourVolume: number | null;
  rules: SymbolRules | null;
  /** The signal's score: picks the capital tier when allocation.sizing is `tiers`. */
  score: number;
  /** The coin's speed group: its risk, slippage and open-trade limit (Section 18.2). */
  speed?: SpeedGroup;
}

export interface RiskDecision {
  ok: boolean;
  reason: string | null;
  notional: number;
  detail: Record<string, number | string | boolean | null>;
}


export function unrealized(p: Position, price: number | null): number {
  if (price === null) return 0;
  return (p.side === 'long' ? price - p.entryPrice : p.entryPrice - price) * p.qty;
}

/** Money lost if the position's stop is hit now; 0 once the stop locks in breakeven or better. */
export function riskAtStop(p: Position): number {
  const loss = (p.side === 'long' ? p.entryPrice - p.stop : p.stop - p.entryPrice) * p.qty;
  return Math.max(0, loss);
}

export function equityOf(portfolio: Portfolio, priceOf: (s: string) => number | null): number {
  return portfolio.balance + portfolio.positions().reduce((sum, p) => sum + unrealized(p, priceOf(p.symbol)), 0);
}

export function decideEntry(i: RiskInput): RiskDecision {
  const c = i.config;
  const a = c.allocation;
  const pf = i.portfolio;
  const positions = pf.positions();
  const pending = pf.pendingEntries();
  const equity = equityOf(pf, i.priceOf);
  const no = (reason: string, detail: RiskDecision['detail'] = {}) => ({ ok: false, reason, notional: 0, detail: { equity: round(equity), ...detail } });

  if (pf.halted) return no('risk_halted', { haltReason: pf.halted.reason });

  const dayLoss = i.dayStartEquity - equity;
  if (dayLoss >= (c.risk.daily_loss_limit_pct / 100) * i.dayStartEquity) {
    return no('risk_daily_loss_limit', { dayLoss: round(dayLoss), limitPct: c.risk.daily_loss_limit_pct });
  }
  if (c.risk.max_trades_per_day !== null && pf.entriesOnDay(i.t) >= c.risk.max_trades_per_day) return no('risk_max_trades_per_day', { max: c.risk.max_trades_per_day });
  const held = (x: { symbol: string }) => x.symbol === i.symbol;
  if (positions.some(held) || pending.some(held)) return no('risk_already_in_symbol');
  if (a.max_open_trades !== null && positions.length + pending.length >= a.max_open_trades) return no('risk_max_open_trades', { open: positions.length + pending.length, max: a.max_open_trades });
  if (pf.entriesToday(i.symbol, i.t) >= c.risk.max_trades_per_symbol_per_day) return no('risk_max_trades_today', { max: c.risk.max_trades_per_symbol_per_day });
  const lastLoss = pf.lastLoss(i.symbol);
  if (lastLoss !== null && i.t - lastLoss < c.risk.cooldown_after_loss_min * 60_000) {
    return no('risk_cooldown_after_loss', { minutesSinceLoss: Math.round((i.t - lastLoss) / 60_000), cooldown: c.risk.cooldown_after_loss_min });
  }
  const speed = speedSettings(c, i.speed);
  if (speed.max_open !== undefined) {
    const same = [...positions, ...pending].filter((x) => (x.speed ?? 'normal') === (i.speed ?? 'normal')).length;
    if (same >= speed.max_open) return no('risk_max_speed_group', { group: i.speed ?? 'normal', open: same, max: speed.max_open });
  }
  const group = Object.entries(a.correlation_groups).find(([, members]) => members.includes(coinOf(i.symbol)));
  if (group) {
    const inGroup = [...positions, ...pending].filter((x) => group[1].includes(coinOf(x.symbol))).length;
    if (inGroup >= a.max_correlated_trades) return no('risk_correlated', { group: group[0], open: inGroup, max: a.max_correlated_trades });
  }

  // Size: by risk (the loss at the stop is the group's risk), flat, or the score's tier; then every cap in order.
  const stopPct = (Math.abs(i.entry - i.stop) / i.entry) * 100;
  const lossPct = stopPct + roundTripPct(costsFor(c, i.speed));
  const riskPct = Math.min(a.max_loss_per_trade_pct, speed.risk_pct);
  let capitalPct = a.sizing === 'risk' ? (riskPct / lossPct) * 100 : a.flat_capital_pct;
  if (a.sizing === 'tiers') {
    const tier = [...a.tiers].reverse().find((x) => i.score >= x.min_score);
    if (!tier) return no('risk_score_below_tiers', { score: i.score });
    capitalPct = tier.capital_pct;
  }
  let notional = (capitalPct / 100) * equity;
  const caps: string[] = [];
  if (pf.sizeCutActive) { notional *= c.risk.losing_streak_size_cut.size_mult; caps.push('losing_streak'); }

  const maxLoss = (riskPct / 100) * equity;
  if ((notional * lossPct) / 100 > maxLoss) { notional = (maxLoss / lossPct) * 100; caps.push('loss_cap'); }

  const exposure = positions.reduce((s, p) => s + p.qty * (i.priceOf(p.symbol) ?? p.entryPrice), 0) + pending.reduce((s, p) => s + p.notional, 0);
  const room = (a.max_total_exposure_pct / 100) * equity - exposure;
  if (notional > room) { notional = Math.max(0, room); caps.push('exposure'); }

  const openRisk = positions.reduce((s, p) => s + riskAtStop(p), 0) + pending.reduce((s, p) => s + p.notional * (Math.abs(p.refPrice - p.stop) / p.refPrice), 0);
  const riskRoom = a.max_open_risk_pct === null ? Infinity : (a.max_open_risk_pct / 100) * equity - openRisk;
  if ((notional * lossPct) / 100 > riskRoom) { notional = Math.max(0, (riskRoom / lossPct) * 100); caps.push('open_risk'); }

  if (i.lastHourVolume !== null) {
    const volCap = (a.max_pct_of_1h_volume / 100) * i.lastHourVolume;
    if (notional > volCap) { notional = volCap; caps.push('volume'); }
  }

  const minNotional = Math.max(i.rules?.minNotional ?? 5, 0.05 * equity);
  const detail = { equity: round(equity), stopPct: round(stopPct), capitalPct, notional: round(notional), caps: caps.join(',') || null, lossAtStop: round((notional * lossPct) / 100) };
  if (notional < minNotional) return { ok: false, reason: 'risk_size_too_small', notional: 0, detail: { ...detail, minNotional: round(minNotional) } };
  return { ok: true, reason: null, notional, detail };
}

const round = (x: number) => Math.round(x * 100) / 100;
