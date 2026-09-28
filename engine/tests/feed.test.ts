import { describe, expect, it } from 'vitest';
import { openDb } from '../src/storage/db';
import { CandleStore } from '../src/feed/candleStore';
import { replayCandles } from '../src/feed/replayFeed';
import { LiveFeed } from '../src/feed/liveFeed';
import type { BinancePublic } from '../src/feed/binancePublic';
import { loadConfig } from '../src/config';
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../../shared/types';

const T0 = Date.UTC(2026, 8, 28, 0, 0, 0); // a 4h boundary

/** The candle a fake exchange would report; price is a function of time so every source agrees. */
function candle(symbol: string, tf: Timeframe, openTime: number): Candle {
  const p = 100 + (openTime - T0) / 60_000 / 100;
  return { symbol, tf, openTime, closeTime: openTime + TIMEFRAME_MS[tf], open: p, high: p + 1, low: p - 1, close: p + 0.5, volume: 10, quoteVolume: 1000, trades: 5 };
}

/** A fake Binance whose clock the test moves. Like the real one, it also returns the candle still forming. */
function fakeExchange(clock: { now: number }, opts: { failFor?: Set<string> } = {}) {
  const calls: string[] = [];
  const api = {
    serverTime: async () => clock.now,
    klinesRange: async (symbol: string, tf: Timeframe, from: number, to: number) => {
      calls.push(`${symbol} ${tf}`);
      if (opts.failFor?.has(symbol)) throw new Error(`timeout ${symbol}`);
      const tfMs = TIMEFRAME_MS[tf];
      const out: Candle[] = [];
      const lastStarted = Math.floor(clock.now / tfMs) * tfMs;
      for (let t = Math.ceil(from / tfMs) * tfMs; t <= Math.max(to, lastStarted); t += tfMs) {
        if (t <= lastStarted) out.push(candle(symbol, tf, t));
      }
      return out;
    },
  };
  return { api: api as unknown as BinancePublic, calls };
}

function setup(symbols = ['BTCUSDT', 'ETHUSDT'], exchangeOpts = {}) {
  const config = loadConfig('engine/config/config.yaml').feed;
  const clock = { now: T0 + 3_000 };
  const store = new CandleStore(openDb(':memory:'));
  const ex = fakeExchange(clock, exchangeOpts);
  const handed: Candle[][] = [];
  const feed = new LiveFeed({ client: ex.api, store, config, symbols: () => symbols, now: () => clock.now, log: () => {} });
  feed.onCandles((c) => handed.push(c));
  return { clock, store, feed, handed, ex, config };
}

describe('candle store', () => {
  it('saves, replaces and reads candles by time', () => {
    const store = new CandleStore(openDb(':memory:'));
    const cs = [0, 1, 2, 3].map((i) => candle('BTCUSDT', '15m', T0 + i * 900_000));
    store.save(cs);
    store.save([{ ...cs[3], close: 999 }]);
    expect(store.lastOpenTime('BTCUSDT', '15m')).toBe(T0 + 3 * 900_000);
    expect(store.lastOpenTime('BTCUSDT', '1h')).toBeNull();
    expect(store.range('BTCUSDT', '15m', T0 + 900_000, T0 + 2 * 900_000).map((c) => c.openTime)).toEqual([T0 + 900_000, T0 + 1_800_000]);
    const latest = store.latest('BTCUSDT', '15m', 2);
    expect(latest.map((c) => c.close)).toEqual([cs[2].close, 999]);
    // At T0 + 45m only the candles opened at 0, 15m and 30m had closed.
    expect(store.latest('BTCUSDT', '15m', 10, T0 + 2_700_000).map((c) => c.openTime)).toEqual([T0, T0 + 900_000, T0 + 1_800_000]);
  });

  it('prunes by timeframe retention', () => {
    const store = new CandleStore(openDb(':memory:'));
    store.save([candle('BTCUSDT', '1m', T0 - 5 * 86_400_000), candle('BTCUSDT', '1m', T0), candle('BTCUSDT', '4h', T0 - 5 * 86_400_000)]);
    expect(store.prune({ '1m': 3, '15m': 30, '1h': 120, '4h': 400 }, T0)).toBe(1);
    expect(store.lastOpenTime('BTCUSDT', '4h')).toBe(T0 - 5 * 86_400_000);
  });
});

describe('replay feed', () => {
  it('hands out candles by close time, larger timeframe first, across chunks', () => {
    const store = new CandleStore(openDb(':memory:'));
    for (let t = T0; t < T0 + 4 * 3_600_000; t += 60_000) store.save([candle('BTCUSDT', '1m', t), candle('ETHUSDT', '1m', t)]);
    for (let t = T0; t < T0 + 4 * 3_600_000; t += 900_000) store.save([candle('BTCUSDT', '15m', t)]);
    for (let t = T0; t < T0 + 4 * 3_600_000; t += 3_600_000) store.save([candle('BTCUSDT', '1h', t)]);
    store.save([candle('BTCUSDT', '4h', T0)]);

    const batches = [...replayCandles(store, { symbols: ['BTCUSDT', 'ETHUSDT'], timeframes: ['1m', '15m', '1h', '4h'], from: T0, to: T0 + 4 * 3_600_000 + 1, chunkMs: 3_600_000 })];
    const all = batches.flat();
    expect(all).toHaveLength(2 * 240 + 16 + 4 + 1);
    for (let i = 1; i < all.length; i++) expect(all[i].closeTime).toBeGreaterThanOrEqual(all[i - 1].closeTime);
    // At the 4h close everything closes together: 4h, 1h, 15m, then the 1m candles.
    const atEnd = all.filter((c) => c.closeTime === T0 + 4 * 3_600_000).map((c) => `${c.tf} ${c.symbol}`);
    expect(atEnd).toEqual(['4h BTCUSDT', '1h BTCUSDT', '15m BTCUSDT', '1m BTCUSDT', '1m ETHUSDT']);
    // A 15m candle belongs to the chunk it closes in, not the one it opens in.
    const firstChunk = batches[0].filter((c) => c.tf === '15m').map((c) => c.closeTime);
    expect(firstChunk).toEqual([T0 + 900_000, T0 + 1_800_000, T0 + 2_700_000]);
  });
});

describe('live feed', () => {
  it('stores warm-up history and hands it only to history listeners', async () => {
    const { feed, store, handed, config } = setup();
    const history: Candle[] = [];
    feed.onHistory((c) => history.push(...c));
    expect(await feed.poll()).toEqual([]);
    expect(handed).toEqual([]);
    expect(history.filter((c) => c.symbol === 'BTCUSDT' && c.tf === '4h')).toHaveLength(config.history['4h']);
    for (const tf of config.timeframes) {
      const lastClosed = T0 - TIMEFRAME_MS[tf];
      expect(store.lastOpenTime('BTCUSDT', tf)).toBe(lastClosed);
      expect(store.range('BTCUSDT', tf, 0, Infinity)).toHaveLength(config.history[tf]);
    }
    expect(feed.status().state).toBe('live');
  });

  it('never stores or hands on the candle still forming', async () => {
    const { feed, store, clock } = setup(['BTCUSDT']);
    await feed.poll();
    clock.now = T0 + 90_000;                   // 1m candle at T0 closed, the one at T0+60s is forming
    const fresh = await feed.poll();
    expect(fresh.map((c) => `${c.tf} ${c.openTime - T0}`)).toEqual(['1m 0']);
    expect(store.lastOpenTime('BTCUSDT', '1m')).toBe(T0);
  });

  it('hands on each new candle once, in engine order', async () => {
    const { feed, handed, clock } = setup();
    await feed.poll();
    clock.now = T0 + 900_000 + 3_000;          // 15 minutes later
    await feed.poll();
    await feed.poll();                         // nothing new
    expect(handed).toHaveLength(1);
    const batch = handed[0];
    expect(batch.filter((c) => c.tf === '1m')).toHaveLength(2 * 15);
    expect(batch.filter((c) => c.tf === '15m').map((c) => c.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    const at15 = batch.filter((c) => c.closeTime === T0 + 900_000).map((c) => `${c.tf} ${c.symbol}`);
    expect(at15).toEqual(['15m BTCUSDT', '15m ETHUSDT', '1m BTCUSDT', '1m ETHUSDT']);
  });

  it('after downtime, hands on every missed candle so nothing is skipped', async () => {
    const { feed, handed, clock } = setup(['BTCUSDT']);
    await feed.poll();
    clock.now = T0 + 5 * 3_600_000 + 3_000;    // down for 5 hours
    await feed.poll();
    const got = handed.flat();
    expect(got.filter((c) => c.tf === '1m')).toHaveLength(300);
    expect(got.filter((c) => c.tf === '1h')).toHaveLength(5);
    expect(got.filter((c) => c.tf === '4h')).toHaveLength(1);
    const minutes = got.filter((c) => c.tf === '1m').map((c) => c.openTime);
    expect(new Set(minutes).size).toBe(300);
  });

  it('uses Binance time when the local clock is off', async () => {
    const { feed, clock, store } = setup(['BTCUSDT']);
    // Local clock 5 minutes fast: without the offset it would expect candles that do not exist yet.
    const localAhead = 300_000;
    (feed as unknown as { now: () => number }).now = () => clock.now + localAhead;
    await feed.poll();
    expect(feed.status().clockOffsetMs).toBe(localAhead);
    expect(store.lastOpenTime('BTCUSDT', '1m')).toBe(T0 - 60_000);
  });

  it('fetches in parallel, never more than `concurrency` at once', async () => {
    const { feed, config, ex } = setup(['A', 'B', 'C', 'D', 'E', 'F'].map((s) => `${s}USDT`));
    let inFlight = 0;
    let most = 0;
    const real = ex.api.klinesRange.bind(ex.api);
    ex.api.klinesRange = async (...args: Parameters<typeof real>) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return real(...args);
    };
    await feed.poll();
    expect(ex.calls).toHaveLength(6 * config.timeframes.length);
    expect(most).toBe(config.concurrency);
  });

  it('one failing symbol does not stop the others, and is reported', async () => {
    const { feed, store } = setup(['BTCUSDT', 'ETHUSDT'], { failFor: new Set(['ETHUSDT']) });
    await feed.poll();
    expect(store.lastOpenTime('BTCUSDT', '1m')).toBe(T0 - 60_000);
    expect(store.lastOpenTime('ETHUSDT', '1m')).toBeNull();
    expect(feed.status().lastError).toMatch(/ETHUSDT/);
    expect(feed.status().state).toBe('stalled');
  });

  it('reports stalled when 1m candles stop arriving, and live again when they return', async () => {
    const failFor = new Set<string>();
    const { feed, clock } = setup(['BTCUSDT'], { failFor });
    await feed.poll();
    failFor.add('BTCUSDT');
    clock.now = T0 + 5 * 60_000;
    await feed.poll();
    expect(feed.status().state).toBe('stalled');
    failFor.clear();
    await feed.poll();
    expect(feed.status().state).toBe('live');
    expect(feed.status().lastError).toBeNull();
  });
});
