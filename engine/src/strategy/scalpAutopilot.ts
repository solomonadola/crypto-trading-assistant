// Pure decision logic for the scalp autopilot: given closed candles up to a
// specific close time (including warm-up), decides whether an order should be
// placed, at what limit price, and with what stop and target.
//
// Used both live (by main.ts) and in historical backtests. PURE: wall clock,
// store, network, and process state must never be accessed here.
import type { Candle, Direction } from '../../../shared/types';
import type { EngineConfig } from '../config';
import { findScalps, SCALP_LABEL, type ScalpKind } from '../analysis/scalp';
import { readTrend } from '../analysis/patterns';
import { watchCoin } from '../analysis/pumpWatch';
import { readSwingStructure } from '../analysis/swingStructure';
import { usualDayRange } from '../analysis/timing';

export interface ScalpDecisionInput {
  symbol: string;
  tf: '5m' | '15m';
  /** Closed candles of `tf` up to and including the candle that just closed, oldest first (enough for warm-up). */
  candles: Candle[];
  /** Closed 1h candles up to the same moment (for the 1h trend bias, pump/failed-break warnings, ADR). */
  candles1h: Candle[];
  /** BTC 1h candles up to the same moment (for the "BTC dumping" guard). */
  btc1h: Candle[];
  sessionOpens: number[];            // London/NY open times in range (from SessionCalendar)
  costPct: number;                   // round-trip cost for this coin's speed group
  now: number;                       // the close time of the candle that just closed
  config: EngineConfig['scalp_autopilot'];
}

export interface ScalpOrder {
  symbol: string;
  side: Direction;
  kind: ScalpKind;
  tf: '5m' | '15m';
  limitPrice: number;
  stop: number;
  target: number;
  maxHoldMin: number;
  entryTimeoutMin: number;
  note: string;
}

export interface ScalpDecisionResult {
  order: ScalpOrder | null;
  skipped?: string;
}

/** The order the autopilot would place for the candle that just closed, or null with the reason. */
export function decideScalp(i: ScalpDecisionInput): ScalpDecisionResult {
  if (!i.config.timeframes.includes(i.tf)) return { order: null, skipped: 'timeframe_not_enabled' };

  const lastCandle = i.candles[i.candles.length - 1];
  if (!lastCandle || i.candles.length < 40) return { order: null, skipped: 'not_enough_candles' };

  // Calculate 1h trend bias as of now
  const bias1h = i.candles1h.length >= 60 ? (readTrend(i.candles1h)?.direction ?? 'range') : 'range';

  // Find scalp setups across the candles window
  const setups = findScalps(i.candles, {
    symbol: i.symbol,
    bias1h,
    sessionOpens: i.sessionOpens,
    costPct: i.costPct,
  });

  // An open setup from this exact closed candle, in the 1h trend's direction
  const fresh = setups.find((s) => s.status === 'open' && s.time === lastCandle.openTime && s.withTrend);
  if (!fresh) return { order: null, skipped: 'no_fresh_setup' };

  // Max stop distance guard
  const stopPct = (Math.abs(fresh.entry - fresh.stop) / fresh.entry) * 100;
  if (stopPct > i.config.max_stop_pct) {
    return { order: null, skipped: `stop_too_wide (${stopPct.toFixed(2)}% > ${i.config.max_stop_pct}%)` };
  }

  // BTC dumping guard: BTC dropped > 1.0% in the last 1h candle
  const btcChange1h = i.btc1h.length >= 2 && i.btc1h[0].close > 0
    ? ((i.btc1h[i.btc1h.length - 1].close - i.btc1h[0].close) / i.btc1h[0].close) * 100
    : null;
  const btcDumping = btcChange1h !== null && btcChange1h < -1.0;
  if (btcDumping && i.symbol !== 'BTCUSDT' && fresh.side === 'long') {
    return { order: null, skipped: `btc_dumping (${btcChange1h?.toFixed(1)}% in last hour)` };
  }

  // ADR exhaustion guard: coin has already used >= 85% of its usual daily range
  const adr = usualDayRange(i.candles1h, i.now);
  const todayCandles = i.candles1h.filter((c) => c.openTime >= Math.floor(i.now / 86_400_000) * 86_400_000);
  if (adr && adr > 0 && todayCandles.length) {
    const hi = Math.max(...todayCandles.map((c) => c.high));
    const lo = Math.min(...todayCandles.map((c) => c.low));
    const todayRange = hi - lo;
    const usedPct = (todayRange / adr) * 100;
    if (usedPct >= 85) {
      return { order: null, skipped: `adr_exhausted (${usedPct.toFixed(1)}% >= 85%)` };
    }
  }

  // Watch warnings & traps from 1h and 15m structure
  const s1h = i.candles1h.length >= 60 ? readSwingStructure(i.candles1h, '1h') : null;
  const s15m = i.tf === '15m' && i.candles.length >= 60 ? readSwingStructure(i.candles, '15m') : null;
  const watch = watchCoin(i.symbol, i.candles1h.slice(-200), s1h, s15m);
  const opposingTrap = watch.warnings.find((w) =>
    (w.level === 'danger' && (w.side === fresh.side || w.side === 'both')) ||
    (w.code === 'failed_high' && fresh.side === 'long') ||
    (w.code === 'failed_low' && fresh.side === 'short') ||
    (w.code === 'pump_blowoff' && fresh.side === 'long') ||
    (w.code === 'pump_unwinding' && fresh.side === 'long') ||
    (w.code === 'dumping' && fresh.side === 'long')
  );
  if (opposingTrap) {
    return { order: null, skipped: `warning_${opposingTrap.code} (${opposingTrap.title})` };
  }

  // Limit price: Key Level limit pullback if available, otherwise entry close
  const limitPrice = (fresh.keyLevel && Number.isFinite(fresh.keyLevel))
    ? (fresh.side === 'long' ? Math.min(fresh.keyLevel, fresh.entry) : Math.max(fresh.keyLevel, fresh.entry))
    : fresh.entry;

  const order: ScalpOrder = {
    symbol: fresh.symbol,
    side: fresh.side,
    kind: fresh.kind,
    tf: i.tf,
    limitPrice,
    stop: fresh.stop,
    target: fresh.target,
    maxHoldMin: i.config.max_hold_min[i.tf],
    entryTimeoutMin: i.config.entry_timeout_min[i.tf],
    note: `Quant Autopilot [${fresh.tf ?? i.tf}]: ${SCALP_LABEL[fresh.kind]}`,
  };

  return { order };
}
