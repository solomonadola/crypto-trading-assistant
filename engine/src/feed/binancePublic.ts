// Binance USDⓈ-M futures, public market-data endpoints only. No API keys, no
// account access: this client cannot place orders by construction.
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../../../shared/types';

export interface BinancePublicOptions {
  restBase: string;
  timeoutMs: number;
  maxRetries: number;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class BinanceError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
}

export interface PremiumIndex {
  symbol: string;
  markPrice: number;
  lastFundingRate: number;
  nextFundingTime: number;
}

export interface FundingRate {
  symbol: string;
  fundingTime: number;
  fundingRate: number;
}

const KLINE_LIMIT = 1500;
// Binance allows 2400 request weight per minute per IP; stay well below it.
const WEIGHT_SOFT_LIMIT = 1800;

export class BinancePublic {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Until when requests are paused after a 429 or near the weight limit. */
  private pausedUntil = 0;

  constructor(private readonly opts: BinancePublicOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async get<T>(pathAndQuery: string): Promise<T> {
    const url = `${this.opts.restBase}${pathAndQuery}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      const wait = this.pausedUntil - Date.now();
      if (wait > 0) await this.sleep(wait);
      let res: Response;
      try {
        res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      } catch (err) {
        lastErr = err;
        await this.sleep(backoff(attempt));
        continue;
      }
      const used = Number(res.headers.get('x-mbx-used-weight-1m'));
      if (used > WEIGHT_SOFT_LIMIT) this.pausedUntil = nextMinute();
      if (res.ok) return (await res.json()) as T;

      const body = await res.text().catch(() => '');
      // 418: IP banned for ignoring 429s. Retrying makes it longer.
      if (res.status === 418) throw new BinanceError(`Binance banned this IP (418): ${body}`, 418);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        this.pausedUntil = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 60_000);
        lastErr = new BinanceError(`Rate limited (429) on ${pathAndQuery}`, 429);
        continue;
      }
      if (res.status >= 500) {
        lastErr = new BinanceError(`Binance ${res.status} on ${pathAndQuery}: ${body}`, res.status);
        await this.sleep(backoff(attempt));
        continue;
      }
      // Other 4xx: a bad request; retrying will not help.
      throw new BinanceError(`Binance ${res.status} on ${pathAndQuery}: ${body}`, res.status);
    }
    throw lastErr instanceof Error ? lastErr : new BinanceError(`Request failed: ${pathAndQuery}`, null);
  }

  async serverTime(): Promise<number> {
    return (await this.get<{ serverTime: number }>('/fapi/v1/time')).serverTime;
  }

  /** Candles with open time in [startTime, endTime], oldest first, one request (at most 1500). */
  async klines(symbol: string, tf: Timeframe, opts: { startTime?: number; endTime?: number; limit?: number }): Promise<Candle[]> {
    const q = new URLSearchParams({ symbol, interval: tf, limit: String(Math.min(opts.limit ?? KLINE_LIMIT, KLINE_LIMIT)) });
    if (opts.startTime !== undefined) q.set('startTime', String(opts.startTime));
    if (opts.endTime !== undefined) q.set('endTime', String(opts.endTime));
    const rows = await this.get<unknown[][]>(`/fapi/v1/klines?${q}`);
    return rows.map((k) => parseKline(symbol, tf, k));
  }

  /** All candles with open time in [startTime, endTime], paging past the 1500-per-request limit. */
  async klinesRange(symbol: string, tf: Timeframe, startTime: number, endTime: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let from = startTime;
    while (from <= endTime) {
      const page = await this.klines(symbol, tf, { startTime: from, endTime, limit: KLINE_LIMIT });
      if (!page.length) break;
      out.push(...page);
      const next = page[page.length - 1].openTime + TIMEFRAME_MS[tf];
      if (next <= from) break;
      from = next;
    }
    return out;
  }

  /** USDT-margined perpetuals that are trading, with the lot and price rules a simulated order must respect. */
  async perpetualSymbols(): Promise<SymbolInfo[]> {
    const info = await this.get<{ symbols: RawSymbol[] }>('/fapi/v1/exchangeInfo');
    return info.symbols
      .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
      .map((s) => {
        const f = (type: string) => s.filters.find((x) => x.filterType === type) ?? {};
        return {
          symbol: s.symbol,
          baseAsset: s.baseAsset,
          tickSize: Number(f('PRICE_FILTER').tickSize),
          stepSize: Number(f('MARKET_LOT_SIZE').stepSize ?? f('LOT_SIZE').stepSize),
          minQty: Number(f('MARKET_LOT_SIZE').minQty ?? f('LOT_SIZE').minQty),
          minNotional: Number(f('MIN_NOTIONAL').notional ?? 0),
        };
      });
  }

  async tickers24h(): Promise<Ticker24h[]> {
    const rows = await this.get<Record<string, string>[]>('/fapi/v1/ticker/24hr');
    return rows.map((r) => ({
      symbol: r.symbol,
      lastPrice: Number(r.lastPrice),
      priceChangePercent: Number(r.priceChangePercent),
      quoteVolume: Number(r.quoteVolume),
    }));
  }

  async premiumIndex(): Promise<PremiumIndex[]> {
    const rows = await this.get<Record<string, string | number>[]>('/fapi/v1/premiumIndex');
    return rows.map((r) => ({
      symbol: String(r.symbol),
      markPrice: Number(r.markPrice),
      lastFundingRate: Number(r.lastFundingRate),
      nextFundingTime: Number(r.nextFundingTime),
    }));
  }

  async fundingRates(symbol: string, startTime: number, endTime: number): Promise<FundingRate[]> {
    const q = new URLSearchParams({ symbol, startTime: String(startTime), endTime: String(endTime), limit: '1000' });
    const rows = await this.get<Record<string, string | number>[]>(`/fapi/v1/fundingRate?${q}`);
    return rows.map((r) => ({ symbol: String(r.symbol), fundingTime: Number(r.fundingTime), fundingRate: Number(r.fundingRate) }));
  }
}

interface RawSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  status: string;
  filters: Record<string, string>[];
}

export function parseKline(symbol: string, tf: Timeframe, k: unknown[]): Candle {
  const openTime = Number(k[0]);
  return {
    symbol,
    tf,
    openTime,
    closeTime: openTime + TIMEFRAME_MS[tf],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    quoteVolume: Number(k[7]),
    trades: Number(k[8]),
  };
}

const backoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt);
const nextMinute = () => Math.ceil((Date.now() + 1) / 60_000) * 60_000;
