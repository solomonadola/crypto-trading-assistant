/**
 * Real candles from Binance, cached.
 *
 * Until now every "indicator" in the scanner was a formula applied to the one
 * 24-hour ticker snapshot: the "4H 21 EMA" was `price x (1 - 0.006 - ...)`, so
 * price was always about 0.6% above it, and "1H candle green" was the sign of
 * the 24h change. Nothing was measured from price history, so no rule about
 * levels, structure or pullbacks could mean what it said.
 *
 * This fetches the actual candles. Same venue as the ticker and the catch-up
 * replay (Binance global spot); Binance.US is never used, for the reason in
 * binanceService.ts.
 */

export interface Candle {
  /** open time, ms */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** base-asset volume */
  v: number;
}

export type Interval = '5m' | '15m' | '1h' | '4h' | '1d';

const ENDPOINTS = [
  'https://data-api.binance.vision/api/v3/klines',
  'https://api.binance.com/api/v3/klines',
];

/** How long a fetched series stays usable: about a fifth of its own bar length. */
const TTL_MS: Record<Interval, number> = {
  '5m': 60_000,
  '15m': 180_000,
  '1h': 600_000,
  '4h': 1_800_000,
  '1d': 3_600_000,
};

const REQUEST_TIMEOUT_MS = 8000;
/** Binance rate limits are generous, but a burst of 120 requests is not polite. */
const CONCURRENCY = 6;

interface CacheEntry {
  at: number;
  candles: Candle[];
}
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Candle[]>>();

const key = (symbol: string, interval: Interval) => `${symbol.toUpperCase()}:${interval}`;

/** The last fetched series, however old, or null if this pair was never fetched. */
export function getCachedCandles(symbol: string, interval: Interval): Candle[] | null {
  return cache.get(key(symbol, interval))?.candles ?? null;
}

/** When that series was fetched (0 = never). */
export function getCandlesAge(symbol: string, interval: Interval, now = Date.now()): number {
  const at = cache.get(key(symbol, interval))?.at;
  return at ? now - at : Infinity;
}

async function fetchFromBinance(symbol: string, interval: Interval, limit: number): Promise<Candle[] | null> {
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = `${endpoint}?symbol=${encodeURIComponent(symbol.toUpperCase())}USDT&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) continue;
      const rows = await res.json();   // the timeout covers the body as well
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const candles = rows
        .map((r: any[]) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
        .filter((c: Candle) => Number.isFinite(c.t) && c.h > 0 && c.l > 0 && c.c > 0);
      if (candles.length) return candles;
    } catch {
      // try the next mirror
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Candles for one pair, from cache when fresh. On a failed fetch the last good
 * series is returned rather than nothing: stale candles still describe the
 * structure, and the caller can check getCandlesAge.
 */
export async function fetchCandles(symbol: string, interval: Interval, limit = 200): Promise<Candle[]> {
  const k = key(symbol, interval);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS[interval]) return hit.candles;

  const existing = inFlight.get(k);
  if (existing) return existing;

  const request = (async () => {
    const fetched = await fetchFromBinance(symbol, interval, limit);
    if (fetched) cache.set(k, { at: Date.now(), candles: fetched });
    return fetched ?? hit?.candles ?? [];
  })().finally(() => inFlight.delete(k));

  inFlight.set(k, request);
  return request;
}

/** Candles for many pairs, a few requests at a time. Pairs that fail are left out. */
export async function fetchCandlesForSymbols(
  symbols: string[],
  interval: Interval,
  limit = 200
): Promise<Map<string, Candle[]>> {
  const out = new Map<string, Candle[]>();
  const queue = [...symbols];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const symbol = queue.shift();
      if (!symbol) return;
      const candles = await fetchCandles(symbol, interval, limit);
      if (candles.length) out.set(symbol.toUpperCase(), candles);
    }
  });
  await Promise.all(workers);
  return out;
}

/** For tests and offline replay: use candles the caller already has. */
export function primeCandleCache(symbol: string, interval: Interval, candles: Candle[], at = Date.now()): void {
  cache.set(key(symbol, interval), { at, candles });
}

export function clearCandleCache(): void {
  cache.clear();
  inFlight.clear();
}
