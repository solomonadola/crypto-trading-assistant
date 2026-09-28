import { describe, expect, it } from 'vitest';
import { BinanceError, BinancePublic } from '../src/feed/binancePublic';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

function fakeFetch(replies: Reply[]) {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    const r = replies.shift();
    if (!r) throw new Error('no more replies');
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), { status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, urls };
}

const client = (replies: Reply[]) => {
  const f = fakeFetch(replies);
  const sleeps: number[] = [];
  const c = new BinancePublic({
    restBase: 'https://fapi.test', timeoutMs: 1000, maxRetries: 3,
    fetchFn: f.fn, sleep: async (ms) => { sleeps.push(ms); },
  });
  return { c, urls: f.urls, sleeps };
};

const kline = (openTime: number, close = 100) =>
  [openTime, '99', '101', '98', String(close), '10', openTime + 59_999, '1000', 42, '5', '500', '0'];

describe('BinancePublic', () => {
  it('parses klines, with closeTime = openTime + timeframe', async () => {
    const { c, urls } = client([{ body: [kline(60_000, 100.5)] }]);
    const [k] = await c.klines('BTCUSDT', '1m', { startTime: 60_000, limit: 10 });
    expect(urls[0]).toBe('https://fapi.test/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=10&startTime=60000');
    expect(k).toEqual({
      symbol: 'BTCUSDT', tf: '1m', openTime: 60_000, closeTime: 120_000,
      open: 99, high: 101, low: 98, close: 100.5, volume: 10, quoteVolume: 1000, trades: 42,
    });
  });

  it('pages through ranges longer than one request', async () => {
    const page1 = Array.from({ length: 1500 }, (_, i) => kline(i * 60_000));
    const page2 = [kline(1500 * 60_000), kline(1501 * 60_000)];
    const { c, urls } = client([{ body: page1 }, { body: page2 }]);
    const all = await c.klinesRange('BTCUSDT', '1m', 0, 1501 * 60_000);
    expect(all).toHaveLength(1502);
    expect(urls[1]).toContain(`startTime=${1500 * 60_000}`);
  });

  it('retries network errors and server errors, then succeeds', async () => {
    const { c, sleeps } = client([new Error('ECONNRESET'), { status: 502, body: 'bad gateway' }, { body: { serverTime: 5 } }]);
    expect(await c.serverTime()).toBe(5);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('waits out a 429 for Retry-After seconds', async () => {
    const { c, sleeps } = client([{ status: 429, headers: { 'retry-after': '2' } }, { body: { serverTime: 7 } }]);
    expect(await c.serverTime()).toBe(7);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1500);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
  });

  it('never retries a 418 ban or a bad request', async () => {
    await expect(client([{ status: 418, body: 'banned' }]).c.serverTime()).rejects.toMatchObject({ status: 418 });
    const bad = client([{ status: 400, body: '{"code":-1121,"msg":"Invalid symbol."}' }]);
    await expect(bad.c.klines('NOPEUSDT', '1m', {})).rejects.toBeInstanceOf(BinanceError);
    expect(bad.urls).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const { c, urls } = client([new Error('down'), new Error('down'), new Error('down'), new Error('down'), new Error('down')]);
    await expect(c.serverTime()).rejects.toThrow('down');
    expect(urls).toHaveLength(4);
  });

  it('keeps only trading USDT perpetuals, with their lot rules', async () => {
    const sym = (symbol: string, over: Record<string, unknown> = {}) => ({
      symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '100' },
      ],
      ...over,
    });
    const { c } = client([{ body: { symbols: [sym('BTCUSDT'), sym('ETHUSDT', { contractType: 'CURRENT_QUARTER' }), sym('XUSDT', { status: 'SETTLING' }), sym('BTCUSDC', { quoteAsset: 'USDC' })] } }]);
    expect(await c.perpetualSymbols()).toEqual([
      { symbol: 'BTCUSDT', baseAsset: 'BTC', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 100 },
    ]);
  });
});
