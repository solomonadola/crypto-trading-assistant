// Per-symbol candle windows and the analysis built on them. Recomputed when a
// 4h, 1h or 15m candle closes; 1m candles are only kept (they drive exits).
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../../../shared/types';
import type { EngineConfig } from '../config';
import { adx, ema, supertrend } from './indicators';
import { activeFvgs, detectFvgs, type Fvg } from './fvg';
import { volumeProfile, type VolumeProfile } from './volumeProfile';
import { analyzeStructure, type TfStructure } from './structure';
import { combinedState, type Direction, type TrendState } from './trendState';
import { activeZones, detectZones, type Zone } from './zones';

export interface DirectionView {
  state: TrendState;
  /** Longs need the 4h close above 4h EMA(ema_fast); shorts below. */
  emaAligned: boolean;
  /** State is in trend.allowed_states and the EMA agrees. */
  tradable: boolean;
}

export interface SymbolAnalysis {
  symbol: string;
  /** Close time of the newest candle the analysis used. */
  asOf: number;
  structure: Record<'4h' | '1h' | '15m', TfStructure | null>;
  ema4h: { fast: number | null; slow: number | null; close: number | null };
  long: DirectionView;
  short: DirectionView;
  /** Zones on the setup timeframe that are not invalid. */
  zones: Zone[];
  /** Working fair value gaps and inverse gaps on each configured timeframe. */
  fvgs: Fvg[];
  profiles: VolumeProfile[];
  /** Per timeframe: structure trend, SuperTrend direction and line. */
  trendMeter: Record<'4h' | '1h' | '15m', { structure: string | null; supertrend: 1 | -1 | null; line: number | null }>;
  /** 1h ADX: trend strength (above ~20-25 trending). */
  adx1h: number | null;
}

const ANALYSED: Timeframe[] = ['4h', '1h', '15m'];

export class MarketBook {
  private readonly candles = new Map<string, Map<Timeframe, Candle[]>>();
  private readonly analysis = new Map<string, SymbolAnalysis>();

  /** `extras`: the chart-reading analysis (FVGs, volume profiles, trend meter). Trading does not use it. */
  constructor(private readonly config: EngineConfig, private readonly extras = true) {}

  /** Adds candles; returns the symbols whose analysis changed. Older or duplicate candles are ignored or replaced. */
  add(batch: Candle[]): string[] {
    const touched = new Set<string>();
    for (const c of batch) {
      this.append(c);
      if (ANALYSED.includes(c.tf)) touched.add(c.symbol);
    }
    for (const s of touched) this.analysis.set(s, this.analyse(s));
    return [...touched];
  }

  get(symbol: string): SymbolAnalysis | null {
    return this.analysis.get(symbol) ?? null;
  }

  symbols(): string[] {
    return [...this.candles.keys()];
  }

  /** The newest `count` stored candles, oldest first. */
  recent(symbol: string, tf: Timeframe, count = Infinity): Candle[] {
    const list = this.candles.get(symbol)?.get(tf) ?? [];
    return count >= list.length ? [...list] : list.slice(-count);
  }

  private append(c: Candle): void {
    let bySymbol = this.candles.get(c.symbol);
    if (!bySymbol) this.candles.set(c.symbol, (bySymbol = new Map()));
    let list = bySymbol.get(c.tf);
    if (!list) bySymbol.set(c.tf, (list = []));
    const last = list[list.length - 1];
    if (last && c.openTime < last.openTime) {
      // Older than the newest: only fill it in if missing.
      const i = list.findIndex((x) => x.openTime >= c.openTime);
      if (list[i].openTime === c.openTime) list[i] = c; else list.splice(i, 0, c);
    } else if (last && c.openTime === last.openTime) {
      list[list.length - 1] = c;
    } else {
      list.push(c);
    }
    const cap = this.config.feed.history[c.tf] ?? 500;
    if (list.length > cap) list.splice(0, list.length - cap);
  }

  private analyse(symbol: string): SymbolAnalysis {
    const k = this.config.trend.swing_lookback;
    const structureOf = (tf: Timeframe) => {
      const list = this.recent(symbol, tf);
      if (list.length < 2 * k + 1) return null;
      return analyzeStructure({ high: list.map((c) => c.high), low: list.map((c) => c.low), close: list.map((c) => c.close) }, k);
    };
    const structure = { '4h': structureOf('4h'), '1h': structureOf('1h'), '15m': structureOf('15m') };

    const h4 = this.recent(symbol, '4h');
    const closes = h4.map((c) => c.close);
    const lastOf = (s: number[]) => (s.length && Number.isFinite(s[s.length - 1]) ? s[s.length - 1] : null);
    const fast = lastOf(ema(closes, this.config.trend.ema_fast));
    const slow = lastOf(ema(closes, this.config.trend.ema_slow));
    const close = closes.length ? closes[closes.length - 1] : null;

    const view = (dir: Direction): DirectionView => {
      const state = structure['4h'] && structure['1h'] && structure['15m']
        ? combinedState(dir, structure['4h'], structure['1h'], structure['15m'])
        : 'none';
      const emaAligned = fast !== null && close !== null && (dir === 'long' ? close > fast : close < fast);
      const tradable = (this.config.trend.allowed_states as TrendState[]).includes(state) && emaAligned;
      return { state, emaAligned, tradable };
    };

    const setupTf = this.config.timeframes.setup;
    const zones = activeZones(detectZones(this.recent(symbol, setupTf), this.config.zones));

    const asOf = Math.max(0, ...ANALYSED.map((tf) => {
      const list = this.recent(symbol, tf, 1);
      return list.length ? list[0].openTime + TIMEFRAME_MS[tf] : 0;
    }));
    // Working gaps nearest the price, at most max_per_tf per timeframe: old gaps far away are noise.
    const px = lastOf(this.recent(symbol, this.config.timeframes.exits, 1).map((c) => c.close)) ?? close ?? 0;
    const dist = (g: Fvg) => (px > g.top ? px - g.top : px < g.bottom ? g.bottom - px : 0);
    if (!this.extras) {
      const none = { structure: null, supertrend: null, line: null };
      return { symbol, asOf, structure, ema4h: { fast, slow, close }, long: view('long'), short: view('short'), zones, fvgs: [], profiles: [], trendMeter: { '4h': none, '1h': none, '15m': none }, adx1h: null };
    }
    const fvgs = this.config.fvg.timeframes.flatMap((tf) => activeFvgs(detectFvgs(this.recent(symbol, tf), this.config.fvg))
      .sort((a, b) => dist(a) - dist(b))
      .slice(0, this.config.fvg.max_per_tf));
    const profiles = this.config.volume_profile.windows
      .map((w) => volumeProfile(w.name, this.recent(symbol, w.tf, w.candles), this.config.volume_profile.bins, this.config.volume_profile.value_area_pct))
      .filter((p): p is VolumeProfile => p !== null);
    const st = this.config.supertrend;
    const meter = (tf: '4h' | '1h' | '15m') => {
      const list = this.recent(symbol, tf);
      const s = supertrend(list.map((c) => c.high), list.map((c) => c.low), list.map((c) => c.close), st.atr_period, st.multiplier);
      const d = lastOf(s.dir);
      return { structure: structure[tf]?.trend ?? null, supertrend: d === 1 || d === -1 ? d : null, line: lastOf(s.line) } as const;
    };
    const h1 = this.recent(symbol, '1h');
    const adx1h = lastOf(adx(h1.map((c) => c.high), h1.map((c) => c.low), h1.map((c) => c.close), 14).adx);
    return {
      symbol, asOf, structure, ema4h: { fast, slow, close }, long: view('long'), short: view('short'), zones,
      fvgs, profiles, trendMeter: { '4h': meter('4h'), '1h': meter('1h'), '15m': meter('15m') }, adx1h,
    };
  }
}
