import { AutomatedTradeRecord } from '../types/automatedFeed';
import { evaluateTradeCycle } from './cycleEngineService';

/**
 * Catch-up evaluation for the time the app was closed or in the background.
 *
 * Stops and targets are otherwise only checked against the price at each
 * 30-second refresh while the tab is visible. Anything that happened while the
 * app was closed was invisible: a stop crossed at 3am filled at the morning
 * price, and a target touched and reversed was never banked. Paper results
 * then depended on when the tab happened to be open.
 *
 * On return, this fetches the candles covering the gap and replays each open
 * trade through them in time order, using the same cycle engine as live.
 *
 * Within one candle the true path is unknown, so the order is conservative:
 *   open -> adverse extreme -> each pending target -> favourable extreme -> close
 * i.e. the stop is tested before any target (the same rule tools/sim-exits.mjs
 * uses). A stop or target crossed during the candle fills AT its level; only a
 * candle that OPENS beyond a level fills at the open, which is a genuine gap.
 */

export interface Bar {
  /** open time, ms */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface ReplayResult {
  trade: AutomatedTradeRecord;
  events: string[];
  closed: boolean;
}

/** Prices to feed the engine for one candle, in conservative order. */
export function pricePathForBar(trade: AutomatedTradeRecord, bar: Bar): number[] {
  const isShort = trade.direction === 'SHORT';
  const stop = trade.stopLossPrice;
  const path: number[] = [bar.o];

  // Adverse leg. If the stop sits between the open and the extreme, the stop
  // order fills at the stop - not at the extreme.
  const adverse = isShort ? bar.h : bar.l;
  const crossesStop = isShort ? adverse >= stop : adverse <= stop;
  const openedBeyondStop = isShort ? bar.o >= stop : bar.o <= stop;
  path.push(crossesStop && !openedBeyondStop ? stop : adverse);

  // Favourable leg: each pending target reached inside the candle fills at its
  // own price, nearest first, so a gap harvest is only credited for a real gap.
  const favourable = isShort ? bar.l : bar.h;
  const tiers = trade.harvestTiers;
  if (tiers) {
    const targets = [tiers.tier1, tiers.tier2, tiers.tier3]
      .filter((tier) => tier && tier.status === 'PENDING')
      .map((tier) => tier.targetPrice)
      .filter((p) => (isShort ? p >= favourable && p < bar.o : p <= favourable && p > bar.o))
      .sort((a, b) => (isShort ? b - a : a - b));
    path.push(...targets);
  }
  path.push(favourable, bar.c);
  return path.filter((p) => Number.isFinite(p) && p > 0);
}

/**
 * Replays one trade through candles. Pure: no I/O, so it can be tested offline
 * (tools/test-catchup.mjs).
 *
 * @param intervalMs candle length, used to timestamp an exit at candle close
 */
export function replayBars(
  trade: AutomatedTradeRecord,
  bars: Bar[],
  intervalMs: number
): ReplayResult {
  let current = trade;
  const events: string[] = [];
  const since = trade.openedAtTimestamp || 0;

  for (const bar of bars) {
    if (current.status !== 'OPEN') break;
    if (bar.t + intervalMs <= since) continue;          // candle ended before the trade opened

    for (const price of pricePathForBar(current, bar)) {
      const result = evaluateTradeCycle(current, price);
      current = result.trade;
      if (result.message) {
        const when = new Date(bar.t).toISOString().slice(0, 16).replace('T', ' ');
        events.push(`[${when} UTC, while away] ${result.message}`);
      }
      if (current.status !== 'OPEN') {
        // The engine stamps Date.now(); the exit happened during this candle.
        current = {
          ...current,
          closedAtTimestamp: Math.min(bar.t + intervalMs, Date.now()),
          exitPrice: price,
        };
        break;
      }
    }
  }

  return { trade: current, events, closed: trade.status === 'OPEN' && current.status !== 'OPEN' };
}

// ---------------------------------------------------------------- network

// Same venue as the live ticker (see binanceService). Binance.US is a different
// exchange with different prices, so it must never supply candles here.
const KLINE_ENDPOINTS = [
  'https://data-api.binance.vision/api/v3/klines',
  'https://api.binance.com/api/v3/klines',
];

const INTERVALS: Array<[string, number]> = [
  ['1m', 60_000],
  ['5m', 300_000],
  ['15m', 900_000],
  ['1h', 3_600_000],
  ['4h', 14_400_000],
];

/**
 * Finest candle size that covers the gap in a single 1,000-candle request:
 * 1m up to ~16h, 5m up to ~3.5 days, then 15m, 1h, 4h. Longer gaps use coarser
 * candles, which the conservative within-candle order compensates for.
 */
export function chooseInterval(gapMs: number): [string, number] {
  for (const iv of INTERVALS) if (gapMs <= iv[1] * 1000) return iv;
  return INTERVALS[INTERVALS.length - 1];
}

export async function fetchBars(symbol: string, fromMs: number, toMs: number): Promise<{ bars: Bar[]; intervalMs: number } | null> {
  const [interval, intervalMs] = chooseInterval(toMs - fromMs);
  // Start on the candle that contains fromMs.
  const start = Math.floor(fromMs / intervalMs) * intervalMs;
  for (const endpoint of KLINE_ENDPOINTS) {
    try {
      const url = `${endpoint}?symbol=${encodeURIComponent(symbol.toUpperCase())}USDT&interval=${interval}&startTime=${start}&endTime=${toMs}&limit=1000`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      let rows: unknown;
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) continue;
        rows = await res.json();   // timeout covers the body as well as the headers
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(rows)) continue;
      const bars = rows
        .map((r: any[]) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4] }))
        .filter((b) => b.t >= start && b.h > 0 && b.l > 0);
      return { bars, intervalMs };
    } catch {
      // try the next mirror
    }
  }
  return null;
}

export interface CatchUpSummary {
  /** The full trade list with caught-up trades replaced. */
  trades: AutomatedTradeRecord[];
  /** Trades whose state changed during the replay. */
  changed: AutomatedTradeRecord[];
  events: string[];
  closedCount: number;
  /** Symbols whose candles could not be fetched; those trades were left as they were. */
  failedSymbols: string[];
}

/**
 * Replays every open trade through the candles between `sinceMs` and `nowMs`.
 * A trade already evaluated after `sinceMs` (its `lastEvaluatedAt`, set by
 * whichever copy last checked it) starts from there instead, so no candle is
 * applied twice.
 *
 * With `requireCheckpoint`, trades that have never been stamped are skipped
 * rather than replayed from their open: their saved stop and tiers may already
 * reflect later prices, and replaying old candles against a stop that has
 * since been raised would close them on a price that came before the raise.
 */
export async function catchUpOpenTrades(
  trades: AutomatedTradeRecord[],
  sinceMs: number,
  nowMs: number,
  options: { requireCheckpoint?: boolean } = {}
): Promise<CatchUpSummary> {
  const out = [...trades];
  const changed: AutomatedTradeRecord[] = [];
  const events: string[] = [];
  const failedSymbols: string[] = [];
  let closedCount = 0;

  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (t.status !== 'OPEN') continue;
    if (options.requireCheckpoint && !t.lastEvaluatedAt) continue;
    const from = Math.max(sinceMs, t.lastEvaluatedAt || 0, t.openedAtTimestamp || 0);
    if (nowMs - from < 60_000) continue;

    const fetched = await fetchBars(t.symbol, from, nowMs);
    if (!fetched) { failedSymbols.push(t.symbol); continue; }

    const result = replayBars(t, fetched.bars, fetched.intervalMs);
    if (result.trade !== t) {
      const replayed = { ...result.trade, lastEvaluatedAt: nowMs };
      out[i] = replayed;
      changed.push(replayed);
      events.push(...result.events);
      if (result.closed) closedCount++;
    }
  }
  return { trades: out, changed, events, closedCount, failedSymbols };
}
