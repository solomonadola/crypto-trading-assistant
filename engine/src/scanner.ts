// The universe of coins setups may arm on (ENGINE_PLAN.md Section 7): a few
// quality coins to follow the 4h trend on and enter on 15m confirmation. USDT
// perpetuals with enough volume over 24h and right now, not excluded, not
// already moved too far, with sane 1h volatility (enough to reach a target, not
// wild), not in a pump, with a clear 4h trend; ranked by trend quality and only
// the best few kept. Other coins can still be added by hand for analysis.
import type { EngineConfig } from './config';
import type { BinancePublic, SymbolInfo, Ticker24h } from './feed/binancePublic';
import type { Candle, VolumeSurgeRunner } from '../../shared/types';
import { adx, atr, ema } from './analysis/indicators';
import { analyzeStructure } from './analysis/structure';
import { findPump } from './analysis/pumpWatch';
import { readSwingStructure } from './analysis/swingStructure';
import { analyzeVolumeSurge } from './analysis/volumeSurge';
import { baseName } from './symbols';

export { baseName };

export interface ScanRow {
  symbol: string;
  quoteVolume: number;
  changePct: number;
  /** USDT volume of the last `recent_volume_hours` closed hours, scaled to 24h: how much trades now. */
  recentVolume24h: number;
  atrPct1h: number;
  /** Trend quality, 0-100 (see trendQuality); the ranking. */
  rank: number;
  /** The 4h trend's direction: what the engine should look to trade. */
  direction: 'long' | 'short';
  /** Why it scored what it did. */
  why: string;
}

export interface TrendQuality {
  /** The clear 4h trend's direction, or null when there is none (structure and EMAs disagree). */
  direction: 'long' | 'short' | null;
  /** 0-85 from the candles; liquidity adds up to 15 in `rank`. */
  points: number;
  /** In a pump (any stage but given back): left out whatever its trend. */
  pumping: boolean;
  why: string;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** 4h candles the efficiency ratio is measured over (5 days). */
const EFFICIENCY_CANDLES = 30;

/**
 * How clean the 4h trend is, from 4h candles (230 for EMA200) and 1h candles (100).
 * A trend needs the 4h structure (higher highs and lows, or lower) and the EMAs
 * (close beyond EMA200, EMA50 beyond EMA200) to agree. Then:
 * - efficiency (35): net move over the path travelled in the last 30 4h closes;
 *   0.1 or less scores nothing, 0.45 or more full;
 * - strength (20): 4h ADX, 15 nothing to 35 full;
 * - 1h agreeing (15): 1h structure with the trend 15, unclear 7, against 0;
 * - room to enter (15): close within 2 4h ATRs of EMA50 full, 5 or more nothing
 *   (stretched: the pullback to enter on is still to come).
 */
export function trendQuality(h4: Candle[], h1: Candle[]): TrendQuality {
  const none = (why: string, pumping = false): TrendQuality => ({ direction: null, points: 0, pumping, why });
  if (h4.length < 210 || h1.length < 60) return none('not enough history');
  const hi = h4.map((c) => c.high);
  const lo = h4.map((c) => c.low);
  const cl = h4.map((c) => c.close);
  const n = cl.length - 1;
  const pump = findPump(h1, readSwingStructure(h1, '1h'));
  const pumping = !!pump && pump.phase !== 'faded';
  const st4 = analyzeStructure({ high: hi, low: lo, close: cl }, 3).trend;
  const e50 = ema(cl, 50)[n];
  const e200 = ema(cl, 200)[n];
  const up = st4 === 'up' && cl[n] > e200 && e50 > e200;
  const down = st4 === 'down' && cl[n] < e200 && e50 < e200;
  if (!up && !down) return none(`no clear 4h trend (structure ${st4}, EMAs ${e50 > e200 ? 'up' : 'down'})`, pumping);
  const dir = up ? 'long' : 'short';

  let path = 0;
  for (let i = n - EFFICIENCY_CANDLES + 1; i <= n; i++) path += Math.abs(cl[i] - cl[i - 1]);
  const efficiency = path > 0 ? Math.abs(cl[n] - cl[n - EFFICIENCY_CANDLES]) / path : 0;
  const ax = adx(hi, lo, cl, 14).adx[n];
  const a = atr(hi, lo, cl, 14)[n];
  const stretch = a > 0 ? Math.abs(cl[n] - e50) / a : Infinity;
  const st1 = analyzeStructure({ high: h1.map((c) => c.high), low: h1.map((c) => c.low), close: h1.map((c) => c.close) }, 3).trend;
  const agree = st1 === (up ? 'up' : 'down') ? 15 : st1 === 'none' ? 7 : 0;

  const points = 35 * clamp01((efficiency - 0.1) / 0.35) + 20 * clamp01(((Number.isFinite(ax) ? ax : 0) - 15) / 20) + agree + 15 * clamp01((5 - stretch) / 3);
  const why = `4h ${up ? 'up' : 'down'}trend: efficiency ${efficiency.toFixed(2)}, ADX ${Number.isFinite(ax) ? ax.toFixed(0) : '–'}, `
    + `1h ${st1 === 'none' ? 'unclear' : st1 === (up ? 'up' : 'down') ? 'agrees' : 'against'}, ${stretch.toFixed(1)} ATR from EMA50`;
  return { direction: dir, points, pumping, why };
}

export interface ScanResult {
  time: number;
  selected: ScanRow[];
  /** Why the rest were dropped, counted. */
  dropped: Record<string, number>;
}

/** Volume, exclusion and 24h-change filters; returns candidates by volume, largest first. */
export function prefilter(tickers: Ticker24h[], symbols: SymbolInfo[], cfg: EngineConfig['scanner']): { candidates: Ticker24h[]; dropped: Record<string, number> } {
  const info = new Map(symbols.map((s) => [s.symbol, s]));
  const banned = new Set([...cfg.exclude, ...cfg.blacklist].map((x) => x.toUpperCase()));
  const dropped: Record<string, number> = {};
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1; };
  const candidates: Ticker24h[] = [];
  for (const t of tickers) {
    const s = info.get(t.symbol);
    if (!s) continue; // not a trading USDT perpetual
    if (banned.has(baseName(s.baseAsset)) || banned.has(s.baseAsset)) { drop('excluded'); continue; }
    if (t.quoteVolume < cfg.min_quote_volume_24h) { drop('volume'); continue; }
    if (Math.abs(t.priceChangePercent) > cfg.max_change_24h_pct) { drop('change_24h'); continue; }
    candidates.push(t);
  }
  candidates.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return { candidates, dropped };
}

export interface Measured { atrPct: number; recentVolume24h: number; trend: TrendQuality }

/**
 * Current-volume, volatility, pump and trend filters, then ranking by trend quality plus
 * liquidity (up to 15: $50M a day nothing, $2B or more full). Only coins scoring at least
 * `min_quality` count, and of those the best `max_symbols`.
 */
export function rank(candidates: Ticker24h[], measured: Map<string, Measured>, cfg: EngineConfig['scanner'], dropped: Record<string, number>): ScanRow[] {
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1; };
  const rows: ScanRow[] = [];
  for (const t of candidates) {
    const m = measured.get(t.symbol);
    if (!m || !Number.isFinite(m.atrPct)) { drop('no_candles'); continue; }
    if (m.recentVolume24h < cfg.min_recent_quote_volume_24h) { drop('recent_volume'); continue; }
    if (m.atrPct < cfg.min_atr_pct_1h) { drop('atr'); continue; }
    if (m.atrPct > cfg.max_atr_pct_1h) { drop('too_wild'); continue; }
    if (m.trend.pumping) { drop('pumping'); continue; }
    if (!m.trend.direction) { drop('no_4h_trend'); continue; }
    const liquidity = 15 * clamp01((Math.log10(t.quoteVolume) - Math.log10(5e7)) / (Math.log10(2e9) - Math.log10(5e7)));
    const quality = Math.round(m.trend.points + liquidity);
    if (quality < cfg.min_quality) { drop('low_quality'); continue; }
    rows.push({
      symbol: t.symbol, quoteVolume: t.quoteVolume, changePct: t.priceChangePercent, recentVolume24h: m.recentVolume24h, atrPct1h: m.atrPct,
      rank: quality, direction: m.trend.direction, why: m.trend.why,
    });
  }
  rows.sort((a, b) => b.rank - a.rank);
  if (rows.length > cfg.max_symbols) dropped.not_top = (dropped.not_top ?? 0) + rows.length - cfg.max_symbols;
  return rows.slice(0, cfg.max_symbols);
}

/** One full scan against Binance. */
export async function scan(client: BinancePublic, cfg: EngineConfig['scanner'], now: number, symbolsCache: { list: SymbolInfo[]; at: number }): Promise<ScanResult> {
  if (!symbolsCache.list.length || now - symbolsCache.at > 6 * 3_600_000) {
    symbolsCache.list = await client.perpetualSymbols();
    symbolsCache.at = now;
  }
  const { candidates, dropped } = prefilter(await client.tickers24h(), symbolsCache.list, cfg);
  const measured = new Map<string, Measured>();
  for (const t of candidates) {
    try {
      const closed = (await client.klines(t.symbol, '1h', { limit: 100 })).filter((x) => x.closeTime <= now);
      const a = atr(closed.map((x) => x.high), closed.map((x) => x.low), closed.map((x) => x.close), 14);
      const last = closed[closed.length - 1];
      const recent = closed.slice(-cfg.recent_volume_hours);
      const recentVolume24h = recent.length ? (recent.reduce((s, x) => s + x.quoteVolume, 0) * 24) / recent.length : 0;
      if (!last) continue;
      const atrPct = (a[a.length - 1] / last.close) * 100;
      // The 4h candles only for coins that pass the cheap checks.
      const cheapOk = recentVolume24h >= cfg.min_recent_quote_volume_24h && atrPct >= cfg.min_atr_pct_1h && atrPct <= cfg.max_atr_pct_1h;
      const h4 = cheapOk ? (await client.klines(t.symbol, '4h', { limit: 230 })).filter((x) => x.closeTime <= now) : [];
      measured.set(t.symbol, { atrPct, recentVolume24h, trend: cheapOk ? trendQuality(h4, closed) : { direction: null, points: 0, pumping: false, why: '' } });
    } catch {
      // Left out of this scan; counted as no_candles.
    }
  }
  return { time: now, selected: rank(candidates, measured, cfg, dropped), dropped };
}

export interface SurgeScanOptions {
  maxCandidates?: number;
  min24hQuoteVolume?: number;
  exclude?: string[];
}

/**
 * Scans Binance USDT perpetuals for volume surge runners and early volume ramps.
 * Automatically discovers coins before and during their explosive moves.
 */
export async function scanVolumeSurgeRunners(
  client: BinancePublic,
  symbolsCache?: { list: SymbolInfo[]; at?: number },
  opts: SurgeScanOptions = {}
): Promise<VolumeSurgeRunner[]> {
  const tickers = await client.tickers24h();

  let symbolSet: Set<string>;
  if (symbolsCache?.list && symbolsCache.list.length > 0) {
    symbolSet = new Set(symbolsCache.list.map((s) => s.symbol));
  } else {
    try {
      const list = await client.perpetualSymbols();
      if (symbolsCache) {
        symbolsCache.list = list;
        symbolsCache.at = Date.now();
      }
      symbolSet = new Set(list.map((s) => s.symbol));
    } catch {
      symbolSet = new Set(tickers.filter((t) => t.symbol.endsWith('USDT')).map((t) => t.symbol));
    }
  }

  const banned = new Set([
    'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'USDPUSDT', 'AEURUSDT', 'EURUSDT',
    ...(opts.exclude ?? []).map((x) => x.toUpperCase()),
  ]);

  const minVolume = opts.min24hQuoteVolume ?? 10_000_000;
  const isBanned = (sym: string) => banned.has(sym) || banned.has(baseName(sym));
  const validTickers = tickers.filter(
    (t) => symbolSet.has(t.symbol) && !isBanned(t.symbol) && t.quoteVolume >= minVolume
  );

  // Pick top candidates: top gainers and top volume leaders with positive price action
  const candidateSymbols = new Set<string>();
  const byGains = [...validTickers].sort((a, b) => b.priceChangePercent - a.priceChangePercent);
  for (const t of byGains.slice(0, 15)) candidateSymbols.add(t.symbol);

  const byVolume = [...validTickers]
    .filter((t) => t.priceChangePercent >= 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
  for (const t of byVolume.slice(0, 15)) candidateSymbols.add(t.symbol);

  const candidatesArray = Array.from(candidateSymbols).slice(0, opts.maxCandidates ?? 30);
  const runners: VolumeSurgeRunner[] = [];

  // Fetch 1h candles in parallel batches of 5
  const chunkSize = 5;
  for (let i = 0; i < candidatesArray.length; i += chunkSize) {
    const chunk = candidatesArray.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map(async (symbol) => {
        try {
          const klines = await client.klines(symbol, '1h', { limit: 120 });
          if (!klines || klines.length < 24) return null;
          return analyzeVolumeSurge(symbol, klines);
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) runners.push(r);
    }
  }

  runners.sort((a, b) => b.score - a.score);
  return runners;
}
