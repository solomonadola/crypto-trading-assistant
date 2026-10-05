import { describe, expect, it, vi } from 'vitest';
import { KlineStream } from '../src/feed/klineStream';
import { LiveFeed } from '../src/feed/liveFeed';
import { CandleStore } from '../src/feed/candleStore';
import { openDb } from '../src/storage/db';
import { loadConfig } from '../src/config';
import type { BinancePublic } from '../src/feed/binancePublic';
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../../shared/types';

type FakeSocket = { onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null; sent: unknown[]; send: (d: string) => void; close: () => void };

function sockets() {
  const made: FakeSocket[] = [];
  const connect = () => {
    const s: FakeSocket = { onopen: null, onmessage: null, onclose: null, onerror: null, sent: [], send: (d) => s.sent.push(JSON.parse(d)), close: () => s.onclose?.({}) };
    made.push(s);
    return s;
  };
  return { made, connect };
}

/** A combined-stream kline message as Binance sends it. */
const kline = (symbol: string, tf: Timeframe, openTime: number, closed: boolean, close = 100) => JSON.stringify({
  stream: `${symbol.toLowerCase()}@kline_${tf}`,
  data: { e: 'kline', E: openTime + TIMEFRAME_MS[tf], s: symbol, k: { t: openTime, T: openTime + TIMEFRAME_MS[tf] - 1, s: symbol, i: tf, o: '99', c: String(close), h: '101', l: '98', v: '10', n: 5, x: closed, q: '1000' } },
});

describe('kline stream', () => {
  it('subscribes to every symbol x timeframe, and to the difference when the list changes', () => {
    const { made, connect } = sockets();
    const s = new KlineStream({ url: 'wss://x/market/stream', timeframes: ['1m', '15m'], connect, log: () => {} });
    s.watch(['BTCUSDT']);
    s.start();
    made[0].onopen?.({});
    expect(made[0].sent).toEqual([{ method: 'SUBSCRIBE', params: ['btcusdt@kline_1m', 'btcusdt@kline_15m'], id: 1 }]);
    s.watch(['ETHUSDT']);
    expect(made[0].sent.slice(1)).toEqual([
      { method: 'UNSUBSCRIBE', params: ['btcusdt@kline_1m', 'btcusdt@kline_15m'], id: 2 },
      { method: 'SUBSCRIBE', params: ['ethusdt@kline_1m', 'ethusdt@kline_15m'], id: 3 },
    ]);
  });

  it('subscribes again after reconnecting', () => {
    vi.useFakeTimers();
    try {
      const { made, connect } = sockets();
      const s = new KlineStream({ url: 'u', timeframes: ['1m'], connect, log: () => {} });
      s.watch(['BTCUSDT']);
      s.start();
      made[0].onopen?.({});
      made[0].onclose?.({});
      vi.advanceTimersByTime(1000);
      made[1].onopen?.({});
      expect(made[1].sent).toEqual([{ method: 'SUBSCRIBE', params: ['btcusdt@kline_1m'], id: 2 }]);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps only closed candles, and hands a range only when it has every one', () => {
    const { made, connect } = sockets();
    const s = new KlineStream({ url: 'u', timeframes: ['1m'], connect, log: () => {} });
    s.watch(['BTCUSDT']);
    s.start();
    made[0].onmessage?.({ data: kline('BTCUSDT', '1m', 0, false) });          // still forming: ignored
    expect(s.take('BTCUSDT', '1m', 0, 0)).toBeNull();
    made[0].onmessage?.({ data: kline('BTCUSDT', '1m', 0, true, 100.5) });
    made[0].onmessage?.({ data: kline('BTCUSDT', '1m', 120_000, true) });
    expect(s.take('BTCUSDT', '1m', 0, 0)).toEqual([{ symbol: 'BTCUSDT', tf: '1m', openTime: 0, closeTime: 60_000, open: 99, high: 101, low: 98, close: 100.5, volume: 10, quoteVolume: 1000, trades: 5 }]);
    expect(s.take('BTCUSDT', '1m', 0, 120_000)).toBeNull();                     // the 60_000 candle is missing
    made[0].onmessage?.({ data: kline('BTCUSDT', '1m', 60_000, true) });
    expect(s.take('BTCUSDT', '1m', 0, 120_000)?.map((c) => c.openTime)).toEqual([0, 60_000, 120_000]);
  });
});

describe('live feed with the stream', () => {
  const T0 = Date.UTC(2026, 8, 28);
  /** A fake REST API counting its candle requests; it can also be "blocked". */
  function setup() {
    const clock = { now: T0 + 3_000 };
    const rest: string[] = [];
    let blockedUntil: number | null = null;
    const api = {
      serverTime: async () => clock.now,
      blockedUntil: () => blockedUntil,
      klinesRange: async (symbol: string, tf: Timeframe, from: number, to: number) => {
        rest.push(`${symbol} ${tf} ${(from - T0) / 60_000}..${(to - T0) / 60_000}`);
        const out: Candle[] = [];
        for (let t = Math.ceil(from / TIMEFRAME_MS[tf]) * TIMEFRAME_MS[tf]; t <= to; t += TIMEFRAME_MS[tf]) {
          out.push({ symbol, tf, openTime: t, closeTime: t + TIMEFRAME_MS[tf], open: 1, high: 1, low: 1, close: 1, volume: 1, quoteVolume: 1, trades: 1 });
        }
        return out;
      },
    };
    const { made, connect } = sockets();
    const stream = new KlineStream({ url: 'u', timeframes: ['1m'], connect, log: () => {} });
    stream.start();
    made[0].onopen?.({});
    const config = { ...loadConfig('engine/config/config.yaml').feed, timeframes: ['1m'] as Timeframe[] };
    const handed: Candle[][] = [];
    const feed = new LiveFeed({ client: api as unknown as BinancePublic, store: new CandleStore(openDb(':memory:')), config, symbols: () => ['BTCUSDT', 'ETHUSDT'], stream, now: () => clock.now, log: () => {} });
    feed.onCandles((c) => handed.push(c));
    const push = (symbol: string, minute: number) => made[0].onmessage?.({ data: kline(symbol, '1m', T0 + minute * 60_000, true) });
    return { clock, rest, feed, handed, push, block: (until: number | null) => { blockedUntil = until; } };
  }

  it('takes new candles from the stream: no REST request after the history', async () => {
    const f = setup();
    await f.feed.poll();                                          // history over REST
    const afterHistory = f.rest.length;
    f.push('BTCUSDT', 0); f.push('ETHUSDT', 0); f.push('BTCUSDT', 1); f.push('ETHUSDT', 1);
    f.clock.now = T0 + 2 * 60_000 + 3_000;
    await f.feed.poll();
    expect(f.rest.length).toBe(afterHistory);
    expect(f.handed.at(-1)!.map((c) => `${c.symbol} ${(c.openTime - T0) / 60_000}`)).toEqual(['BTCUSDT 0', 'ETHUSDT 0', 'BTCUSDT 1', 'ETHUSDT 1']);
    expect(f.feed.status()).toMatchObject({ fromStream: 4 });
  });

  it('asks REST only for what the stream does not have', async () => {
    const f = setup();
    await f.feed.poll();
    const afterHistory = f.rest.length;
    f.push('BTCUSDT', 0);                                         // ETHUSDT's message never came
    f.clock.now = T0 + 60_000 + 3_000;
    await f.feed.poll();
    expect(f.rest.slice(afterHistory)).toEqual(['ETHUSDT 1m 0..0']);
    expect(f.handed.at(-1)!.map((c) => c.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('keeps going on stream candles while Binance blocks REST, and fills the rest after', async () => {
    const f = setup();
    await f.feed.poll();
    const afterHistory = f.rest.length;
    f.block(T0 + 60 * 60_000);
    f.push('BTCUSDT', 0);
    f.clock.now = T0 + 60_000 + 3_000;
    await f.feed.poll();
    expect(f.rest.length).toBe(afterHistory);                    // nothing sent while blocked
    expect(f.handed.at(-1)!.map((c) => c.symbol)).toEqual(['BTCUSDT']);
    expect(f.feed.status().lastError).toMatch(/blocked/);
    f.block(null);
    f.clock.now = T0 + 2 * 60_000 + 3_000;
    f.push('BTCUSDT', 1);
    await f.feed.poll();
    expect(f.rest.slice(afterHistory)).toEqual(['ETHUSDT 1m 0..1']);   // the gap, in one request
  });
});
