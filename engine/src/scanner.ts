// The universe of coins setups may arm on (ENGINE_PLAN.md Section 7): USDT
// perpetuals with enough volume, not excluded, not already pumped too far,
// with enough 1h volatility, ranked by ATR% x log(volume).
import type { EngineConfig } from './config';
import type { BinancePublic, SymbolInfo, Ticker24h } from './feed/binancePublic';
import { atr } from './analysis/indicators';
import { baseName } from './symbols';

export { baseName };

export interface ScanRow {
  symbol: string;
  quoteVolume: number;
  changePct: number;
  atrPct1h: number;
  rank: number;
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

/** ATR% filter and ranking. `atrPct` holds each candidate's 1h ATR(14) as a percent of price. */
export function rank(candidates: Ticker24h[], atrPct: Map<string, number>, cfg: EngineConfig['scanner'], dropped: Record<string, number>): ScanRow[] {
  const rows: ScanRow[] = [];
  for (const t of candidates) {
    const a = atrPct.get(t.symbol);
    if (a === undefined || !Number.isFinite(a)) { dropped.no_candles = (dropped.no_candles ?? 0) + 1; continue; }
    if (a < cfg.min_atr_pct_1h) { dropped.atr = (dropped.atr ?? 0) + 1; continue; }
    rows.push({ symbol: t.symbol, quoteVolume: t.quoteVolume, changePct: t.priceChangePercent, atrPct1h: a, rank: a * Math.log10(t.quoteVolume) });
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
  const atrPct = new Map<string, number>();
  for (const t of candidates) {
    try {
      const c = await client.klines(t.symbol, '1h', { limit: 30 });
      const closed = c.filter((x) => x.closeTime <= now);
      const a = atr(closed.map((x) => x.high), closed.map((x) => x.low), closed.map((x) => x.close), 14);
      const last = closed[closed.length - 1];
      if (last) atrPct.set(t.symbol, (a[a.length - 1] / last.close) * 100);
    } catch {
      // Left out of this scan; counted as no_candles.
    }
  }
  return { time: now, selected: rank(candidates, atrPct, cfg, dropped), dropped };
}
