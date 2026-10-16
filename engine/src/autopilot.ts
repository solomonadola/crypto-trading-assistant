// What the server lets act between and on candle closes, kept out of main.ts so it can be tested:
// which closed candles the scalp autopilot may look for a setup on, and which live prices may close
// positions. Pure: the wall clock is passed in.
import type { Candle } from '../../shared/types';
import type { EngineConfig } from './config';

/**
 * Candles the scalp autopilot may take a fresh setup from: its timeframes, the scanner's coins only (not
 * the watchlist or a coin open on a chart), not a coin already held or waiting for a fill, and closed just
 * now. A candle replayed after a restart or fetched while the feed catches up is history: acting on it
 * would place an order at a price the market has long left.
 */
export function autopilotCandles(
  batch: Candle[],
  o: { config: EngineConfig['scalp_autopilot']; universe: ReadonlySet<string>; held: ReadonlySet<string>; now: number },
): Candle[] {
  const tfs: readonly string[] = o.config.timeframes;
  return batch.filter((c) => tfs.includes(c.tf) && o.universe.has(c.symbol) && !o.held.has(c.symbol)
    && o.now - c.closeTime <= o.config.max_signal_age_sec * 1000);
}

/** How far behind the wall clock the engine and a coin's 1m candles may be for its live price to act. */
export const LIVE_PRICE_MAX_LAG_MS = 150_000;

/**
 * The live prices that may close positions: none while the engine itself is behind (after a restart,
 * before the feed has caught up), and only for coins whose 1m candles the engine has processed up to the
 * last minute or so. Otherwise a stop hit while the engine was down would close at today's price instead
 * of at the stop, which the missed candles settle first.
 */
export function settledPrices(
  prices: Record<string, number>,
  o: { engineClock: number; lastMinuteClose: (symbol: string) => number | null; now: number },
): Record<string, number> {
  if (o.now - o.engineClock > LIVE_PRICE_MAX_LAG_MS) return {};
  return Object.fromEntries(Object.entries(prices).filter(([symbol]) => {
    const t = o.lastMinuteClose(symbol);
    return t !== null && t <= o.engineClock && o.now - t <= LIVE_PRICE_MAX_LAG_MS;
  }));
}

/**
 * Why Hunter (the scalp autopilot) may not be switched as asked from the dashboard, or null when it may.
 * With `scalp_autopilot.enabled: false` in the config it stays off: the switch used to turn it on anyway
 * until the next restart. Switching it off is always allowed. A standby copy changes nothing: the copy
 * holding the lock is the one that trades.
 */
export function hunterSwitchRefusal(o: { configEnabled: boolean; standby: boolean; enable: boolean }): string | null {
  if (o.standby) return 'This copy is on standby; switch Hunter on the copy that holds the lock';
  if (o.enable && !o.configEnabled) return 'Hunter is disabled in config.yaml (scalp_autopilot.enabled: false); enable it there and restart to switch it on';
  return null;
}
