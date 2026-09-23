/**
 * Per-coin analysis computed from real candles: the values the scanner used to
 * approximate from the 24-hour ticker snapshot.
 *
 * analyzeFromCandles is pure, so the offline replay can build the same analysis
 * from historical bars and the live app and the study measure the same thing.
 */
import { Candle, Interval, fetchCandles } from './candleService';
import {
  atr, ema, rsi, levelsFrom, nearestLevel, structureFrom, pullbackState,
  Level, Structure, PullbackState,
} from './indicators';

export interface CoinAnalysis {
  /** When the candles behind this were fetched. */
  at: number;
  /** Daily ATR as a percent of price - what the stop and the ladder are scaled by. */
  atrPct: number;
  atrValue: number;
  ema21_4h: number;
  ema50_4h: number;
  ema200_daily: number;
  ma7_daily: number;
  ma25_daily: number;
  rsi14_1h: number;
  change7dPct: number;
  change30dPct: number;
  micro: {
    currentHourGreen: boolean;
    hourlyChangePct: number;
    consecutiveRedHours: number;
    threeHourChangePct: number;
  };
  /** Nearest real level below and above, from clustered 4h swings. */
  support: Level | null;
  resistance: Level | null;
  /** Distance to those levels in ATR: 0.3 means "a third of a daily range away". */
  distToSupportAtr: number | null;
  distToResistanceAtr: number | null;
  structure: Structure;
  pullback: PullbackState;
}

const sma = (values: number[], period: number): number | null =>
  values.length >= period ? values.slice(-period).reduce((a, b) => a + b, 0) / period : null;

const pctChange = (candles: Candle[], bars: number): number => {
  if (candles.length < 2) return 0;
  const last = candles[candles.length - 1].c;
  const then = candles[Math.max(0, candles.length - 1 - bars)].c;
  return then > 0 ? +(((last - then) / then) * 100).toFixed(2) : 0;
};

/**
 * Builds the analysis from candles already in hand. Returns null when there is
 * too little history to compute the basics; the caller then keeps whatever it
 * used before rather than trading on half-formed numbers.
 */
export function analyzeFromCandles(
  price: number,
  h1: Candle[],
  h4: Candle[],
  d1: Candle[],
  at: number = Date.now()
): CoinAnalysis | null {
  if (!(price > 0) || h1.length < 20 || h4.length < 25 || d1.length < 8) return null;

  const dailyAtr = atr(d1, 14) ?? atr(d1, Math.max(2, d1.length - 1));
  if (!dailyAtr || !(dailyAtr > 0)) return null;
  const atrPct = +((dailyAtr / price) * 100).toFixed(2);

  const closes4h = h4.map((c) => c.c);
  const closes1h = h1.map((c) => c.c);
  const closesD = d1.map((c) => c.c);

  const ema21_4h = ema(closes4h, 21) ?? price;
  const ema50_4h = ema(closes4h, Math.min(50, closes4h.length)) ?? ema21_4h;
  // A 200-day EMA needs 200 days; with less, use what history there is.
  const ema200_daily = ema(closesD, Math.min(200, closesD.length)) ?? price;
  const ma7_daily = sma(closesD, 7) ?? price;
  const ma25_daily = sma(closesD, Math.min(25, closesD.length)) ?? ma7_daily;
  const rsi14_1h = rsi(closes1h, 14) ?? 50;

  const lastHour = h1[h1.length - 1];
  let consecutiveRedHours = 0;
  for (let i = h1.length - 1; i >= 0 && h1[i].c < h1[i].o; i--) consecutiveRedHours++;

  // Levels from 4h swings, clustered within a third of a daily range.
  const levels = levelsFrom(h4, dailyAtr / 3, 2);
  const support = nearestLevel(price, levels, 'SUPPORT', 2);
  const resistance = nearestLevel(price, levels, 'RESISTANCE', 2);

  return {
    at,
    atrPct,
    atrValue: dailyAtr,
    ema21_4h,
    ema50_4h,
    ema200_daily,
    ma7_daily,
    ma25_daily,
    rsi14_1h: +rsi14_1h.toFixed(1),
    change7dPct: pctChange(d1, 7),
    change30dPct: pctChange(d1, 30),
    micro: {
      currentHourGreen: lastHour.c >= lastHour.o,
      hourlyChangePct: lastHour.o > 0 ? +(((lastHour.c - lastHour.o) / lastHour.o) * 100).toFixed(2) : 0,
      consecutiveRedHours,
      threeHourChangePct: pctChange(h1, 3),
    },
    support,
    resistance,
    distToSupportAtr: support ? +((price - support.price) / dailyAtr).toFixed(2) : null,
    distToResistanceAtr: resistance ? +((resistance.price - price) / dailyAtr).toFixed(2) : null,
    structure: structureFrom(h4, 2),
    pullback: pullbackState(h1, 2),
  };
}

/** Candle counts: enough for a 200-day EMA, a 50-period 4h EMA and 1h structure. */
const NEEDED: Array<[Interval, number]> = [['1h', 200], ['4h', 300], ['1d', 220]];

/** Fetches candles for one coin (cached) and builds its analysis. */
export async function analyzeSymbol(symbol: string, price: number): Promise<CoinAnalysis | null> {
  const [h1, h4, d1] = await Promise.all(NEEDED.map(([iv, limit]) => fetchCandles(symbol, iv, limit)));
  return analyzeFromCandles(price, h1, h4, d1);
}

/**
 * Analysis for a list of coins. Coins whose candles cannot be fetched are left
 * out, and the caller falls back to what it had.
 */
export async function analyzeSymbols(coins: Array<{ symbol: string; current_price: number }>): Promise<Map<string, CoinAnalysis>> {
  const out = new Map<string, CoinAnalysis>();
  await Promise.all(coins.map(async (coin) => {
    try {
      const analysis = await analyzeSymbol(coin.symbol, coin.current_price);
      if (analysis) out.set(coin.symbol.toUpperCase(), analysis);
    } catch {
      // leave this coin without analysis
    }
  }));
  return out;
}
