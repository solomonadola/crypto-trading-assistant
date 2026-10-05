// Charts on TradingView's lightweight-charts: the equity curve, and candles
// with EMAs, SuperTrend, zones, fair value gaps, the volume profile, positions,
// trades and the suggested plan. Both have a crosshair with a value readout
// (the hover layer).
//
// Color says which side a level serves: blue buy side (demand, bullish),
// orange sell side (supply, bearish). The kind of level is carried by shape
// and label: zones are solid boxes, FVGs hatched boxes with a dashed edge,
// IFVGs hatched with a dotted edge.
import { useEffect, useRef, useState } from 'react';
import {
  AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, ClosedTradeView, EquityPoint, PositionViewLike, TradeIdea, Zone } from './chartTypes';
import { usePrices, type ChartReading, type Fvg, type ScalpSetup, type SessionInstance, type VolumeProfile } from '../lib/api';
import { SCALP_LABEL } from '../../engine/src/analysis/scalp';
import { bollingerBands, ema, rsi, supertrend, vwapDaily } from '../../engine/src/analysis/indicators';
import { SESSION_LABEL } from '../lib/format';
import { price as fmtPrice, usd, dateTime } from '../lib/format';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

function baseChart(el: HTMLElement): IChartApi {
  return createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--color-ink-3'), fontFamily: 'Inter, system-ui, sans-serif', attributionLogo: false },
    grid: { vertLines: { color: 'rgba(38,45,59,0.45)' }, horzLines: { color: 'rgba(38,45,59,0.45)' } },
    rightPriceScale: { borderColor: css('--color-line') },
    timeScale: { borderColor: css('--color-line'), timeVisible: true, secondsVisible: false },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: css('--color-ink-3'), labelBackgroundColor: css('--color-card-2') }, horzLine: { color: css('--color-ink-3'), labelBackgroundColor: css('--color-card-2') } },
  });
}

/** Equity over time: one series, so no legend box; the card title names it. */
export function EquityChart({ points, startingBalance }: { points: EquityPoint[]; startingBalance: number }) {
  const el = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<'Area'> | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const [hover, setHover] = useState<{ t: number; v: number } | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = baseChart(el.current);
    const accent = css('--color-accent');
    const s = c.addSeries(AreaSeries, {
      lineColor: accent, lineWidth: 2, topColor: 'rgba(144,133,233,0.35)', bottomColor: 'rgba(144,133,233,0.02)',
      priceFormat: { type: 'custom', formatter: (v: number) => usd(v) },
    });
    s.createPriceLine({ price: startingBalance, color: css('--color-ink-3'), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: 'start' });
    c.subscribeCrosshairMove((p) => {
      const d = p.time && p.seriesData.get(s) as { value?: number } | undefined;
      setHover(d && d.value !== undefined ? { t: (p.time as number) * 1000, v: d.value } : null);
    });
    chart.current = c;
    series.current = s;
    return () => { c.remove(); chart.current = null; series.current = null; };
  }, [startingBalance]);

  useEffect(() => {
    series.current?.setData(points.map((p) => ({ time: sec(p.time), value: p.equity })));
    chart.current?.timeScale().fitContent();
  }, [points]);

  const last = points[points.length - 1];
  return (
    <div className="relative">
      <div className="absolute left-2 top-1 z-10 text-xs text-ink-2 tabular">
        {hover ? <>{dateTime(hover.t)} UTC · <span className="font-semibold text-ink">{usd(hover.v)}</span></> : last ? <>now · <span className="font-semibold text-ink">{usd(last.equity)}</span></> : null}
      </div>
      <div ref={el} className="h-64 w-full" />
      {!points.length && <p className="absolute inset-0 grid place-items-center text-sm text-ink-3">The curve starts after the first 5 minutes of running.</p>}
    </div>
  );
}

/** Everything the chart can show; the picker turns each on or off. */
export const INDICATORS = [
  { id: 'htf', group: 'Model 4', label: '4h zones, FVGs & order blocks (where Model 4 trades)' },
  { id: 'ema20', group: 'Lines', label: 'EMA 20' },
  { id: 'ema50', group: 'Lines', label: 'EMA 50' },
  { id: 'ema200', group: 'Lines', label: 'EMA 200' },
  { id: 'supertrend', group: 'Lines', label: 'SuperTrend' },
  { id: 'vwap', group: 'Lines', label: 'VWAP (daily)' },
  { id: 'bb', group: 'Lines', label: 'Bollinger Bands' },
  { id: 'sessions', group: 'Levels', label: 'Session shading' },
  { id: 'zones', group: 'Levels', label: 'Supply / demand zones' },
  { id: 'fvg', group: 'Levels', label: 'FVG / IFVG' },
  { id: 'profile24h', group: 'Levels', label: 'Volume profile 24h' },
  { id: 'profile7d', group: 'Levels', label: 'Volume profile 7d' },
  { id: 'plan', group: 'Levels', label: 'Plan & key levels' },
  { id: 'liquidity', group: 'Smart money', label: 'Liquidity (PDH/PDL, Asian, London, equal highs/lows)' },
  { id: 'orderblocks', group: 'Smart money', label: 'Order blocks (1h)' },
  { id: 'premium', group: 'Smart money', label: 'Premium / discount (4h range)' },
  { id: 'killzones', group: 'Smart money', label: 'Killzones (London, New York)' },
  { id: 'patterns', group: 'Patterns (5m, 15m, 1h)', label: 'Chart patterns (triangles, wedges, channels, double tops)' },
  { id: 'wyckoff', group: 'Patterns (5m, 15m, 1h)', label: 'Wyckoff range & events' },
  { id: 'scalp', group: 'Scalp (5m)', label: 'Scalp setups: entry, stop, target' },
  { id: 'volume', group: 'Panels', label: 'Volume' },
  { id: 'rsi', group: 'Panels', label: 'RSI 14' },
  { id: 'trades', group: 'Marks', label: 'My trades' },
  { id: 'positions', group: 'Marks', label: 'Open positions' },
] as const;
export type IndicatorId = (typeof INDICATORS)[number]['id'];
/** One-click sets of indicators, each for one way of reading the chart. */
export const PRESETS: { id: string; label: string; title: string; ids: IndicatorId[] }[] = [
  { id: 'clean', label: 'Clean', title: 'Candles with your open positions and trades only', ids: ['positions', 'trades'] },
  { id: 'model4', label: 'Model 4', title: '4h zones, FVGs and order blocks, liquidity, the plan, EMA50, volume', ids: ['htf', 'liquidity', 'plan', 'ema50', 'volume', 'trades', 'positions'] },
  { id: 'scalp', label: 'Scalp', title: 'Scalp setups, EMA20, VWAP, volume', ids: ['scalp', 'ema20', 'vwap', 'volume', 'trades', 'positions'] },
  { id: 'patterns', label: 'Patterns', title: 'Chart patterns, Wyckoff, EMA50, volume', ids: ['patterns', 'wyckoff', 'ema50', 'volume', 'positions'] },
  { id: 'all', label: 'Everything', title: 'Every layer at once', ids: INDICATORS.map((i) => i.id).filter((id) => id !== 'profile7d') },
];
/** A clean chart by default: candles, your open positions and your trades; a preset adds the rest. */
export const DEFAULT_INDICATORS: IndicatorId[] = PRESETS[0].ids;

export interface ChartOverlays {
  zones: Zone[];
  fvgs: Fvg[];
  profiles: VolumeProfile[];
  sessions: SessionInstance[];
  killzones: { name: string; openTime: number; closeTime: number }[];
  /** Trend, patterns and Wyckoff read on the timeframe shown; null on timeframes that are not read. */
  reading?: ChartReading | null;
  /** Model 4's 4h points of interest nearest the price, for longs (demand side) and shorts (supply side). */
  htf?: { long: HtfPoiView[]; short: HtfPoiView[] } | null;
  /** Scalp setups of the last 24 hours (5m): open ones drawn bright and labelled, those closed in the last 4 hours faint. */
  scalps?: ScalpSetup[];
}

export interface HtfPoiView { kind: 'zone' | 'fvg' | 'order_block'; id: string; low: number; high: number; from: number }
const HTF_LABEL = {
  long: { zone: '4h demand zone', fvg: '4h bullish FVG', order_block: '4h bullish order block' },
  short: { zone: '4h supply zone', fvg: '4h bearish FVG', order_block: '4h bearish order block' },
} as const;

const BIAS_COLOR = { bullish: 'var(--color-good)', bearish: 'var(--color-critical)', neutral: 'var(--color-warning)' } as const;
/** A dark outline behind drawing labels, so they stay readable over candles and other lines. */
const HALO = { stroke: 'var(--color-page)', strokeWidth: 3, paintOrder: 'stroke' } as const;

interface Props {
  /** The chart is rebuilt (and fitted) only when this changes: symbol and timeframe. */
  viewKey: string;
  candles: Candle[];
  overlays: ChartOverlays;
  trades: ClosedTradeView[];
  positions: PositionViewLike[];
  tfMs: number;
  tf: string;
  idea?: TradeIdea | null;
  show: Set<IndicatorId>;
}

const LINE_COLORS: Partial<Record<IndicatorId, string>> = { ema20: '--color-accent', ema50: '--color-warning', ema200: '--color-ink-2', vwap: '--color-newyork' };

/**
 * Candles with indicators and levels. The chart is created once per symbol
 * and timeframe; new data and indicator changes update it in place, keeping
 * the user's zoom and scroll.
 */
export function CandleChart({ viewKey, candles, overlays, trades, positions, tfMs, tf, idea, show }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const extras = useRef<ISeriesApi<SeriesType>[]>([]);
  const priceLines = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const needsFit = useRef(true);
  const [hover, setHover] = useState<Candle | null>(null);
  const [, setView] = useState(0);
  const byTime = useRef(new Map<number, Candle>());
  /** The newest bar drawn: the last loaded candle, then moved by live prices. */
  const lastBar = useRef<Candle | null>(null);
  const [liveBar, setLiveBar] = useState<Candle | null>(null);
  const live = usePrices();
  const showKey = [...show].sort().join(',');

  // Created once per symbol and timeframe.
  useEffect(() => {
    if (!el.current) return;
    const c = baseChart(el.current);
    const good = css('--color-good');
    const bad = css('--color-critical');
    const s = c.addSeries(CandlestickSeries, {
      upColor: good, downColor: bad, borderUpColor: good, borderDownColor: bad, wickUpColor: good, wickDownColor: bad,
      priceFormat: { type: 'custom', formatter: (v: number) => fmtPrice(v), minMove: 1e-8 },
    });
    markersRef.current = createSeriesMarkers(s, []);
    c.subscribeCrosshairMove((p) => setHover(p.time ? byTime.current.get(p.time as number) ?? null : null));
    const redraw = () => setView((v) => v + 1);
    c.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    const ro = new ResizeObserver(redraw);
    ro.observe(el.current);
    chartRef.current = c;
    candleRef.current = s;
    extras.current = [];
    priceLines.current = [];
    lastBar.current = null;
    needsFit.current = true;
    return () => { ro.disconnect(); c.remove(); chartRef.current = null; candleRef.current = null; markersRef.current = null; };
  }, [viewKey]);

  // Data and indicator lines/panels: replaced in place, the visible range kept.
  useEffect(() => {
    const c = chartRef.current;
    const s = candleRef.current;
    if (!c || !s || !candles.length) return;
    const range = c.timeScale().getVisibleLogicalRange();
    s.setData(candles.map((k) => ({ time: sec(k.openTime), open: k.open, high: k.high, low: k.low, close: k.close })));
    byTime.current = new Map(candles.map((k) => [sec(k.openTime), k]));
    lastBar.current = candles[candles.length - 1];
    setLiveBar(null);

    for (const x of extras.current) c.removeSeries(x);
    extras.current = [];
    const times = candles.map((k) => sec(k.openTime));
    const closes = candles.map((k) => k.close);
    const good = css('--color-good');
    const bad = css('--color-critical');
    const line = (id: string, values: number[], color: string, width: 1 | 2 = 1, pane = 0, extra = {}) => {
      const l = c.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title: id, ...extra }, pane);
      l.setData(values.flatMap((v, i) => (Number.isFinite(v) ? [{ time: times[i], value: v }] : [])));
      extras.current.push(l as ISeriesApi<SeriesType>);
      return l;
    };
    for (const [id, n] of [['ema20', 20], ['ema50', 50], ['ema200', 200]] as const) {
      if (show.has(id)) line(`EMA${n}`, ema(closes, n), css(LINE_COLORS[id]!));
    }
    if (show.has('vwap')) {
      line('VWAP', vwapDaily({ openTime: candles.map((k) => k.openTime), high: candles.map((k) => k.high), low: candles.map((k) => k.low), close: closes, volume: candles.map((k) => k.volume) }), css('--color-newyork'), 2);
    }
    if (show.has('bb')) {
      const bb = bollingerBands(closes, 20, 2);
      const gray = css('--color-ink-3');
      line('BB up', bb.upper, gray, 1, 0, { lineStyle: LineStyle.Dashed });
      line('BB mid', bb.middle, gray, 1, 0, { lastValueVisible: false });
      line('BB low', bb.lower, gray, 1, 0, { lineStyle: LineStyle.Dashed });
    }
    if (show.has('supertrend')) {
      const st = supertrend(candles.map((k) => k.high), candles.map((k) => k.low), closes, 10, 3);
      const l = c.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: 'SuperTrend' });
      l.setData(candles.flatMap((k, i) => {
        if (!Number.isFinite(st.line[i])) return [];
        if (i > 0 && st.dir[i] !== st.dir[i - 1]) return [{ time: times[i] }];
        return [{ time: times[i], value: st.line[i], color: st.dir[i] === 1 ? good : bad }];
      }));
      extras.current.push(l as ISeriesApi<SeriesType>);
    }
    let pane = 1;
    if (show.has('volume')) {
      const v = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, title: 'Volume' }, pane++);
      v.setData(candles.map((k) => ({ time: sec(k.openTime), value: k.volume, color: k.close >= k.open ? 'rgba(34,197,94,0.45)' : 'rgba(239,83,80,0.45)' })));
      extras.current.push(v as ISeriesApi<SeriesType>);
    }
    if (show.has('rsi')) {
      const r = line('RSI 14', rsi(closes, 14), css('--color-accent'), 1, pane++);
      r.createPriceLine({ price: 70, color: css('--color-ink-3'), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      r.createPriceLine({ price: 50, color: css('--color-line'), lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: '' });
      r.createPriceLine({ price: 30, color: css('--color-ink-3'), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
    }
    // Drop panels left empty, and keep the price panel dominant.
    const panes = c.panes();
    for (let i = panes.length - 1; i > 0; i--) if (!panes[i].getSeries().length) c.removePane(i);
    c.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 4 : 1));

    if (needsFit.current) {
      c.timeScale().fitContent();
      needsFit.current = false;
    } else if (range) {
      c.timeScale().setVisibleLogicalRange(range);
    }
    setView((x) => x + 1);
  }, [candles, showKey, viewKey]);

  // Live prices (every few seconds) move the last bar, or open the next one when its time comes.
  // Display only: the loaded candles replace these on the next refetch.
  useEffect(() => {
    const s = candleRef.current;
    const last = lastBar.current;
    const p = last ? live?.prices[last.symbol] : undefined;
    if (!s || !last || !live || p === undefined) return;
    const openTime = Math.floor(live.time / tfMs) * tfMs;
    if (openTime < last.openTime) return;
    const bar: Candle = openTime === last.openTime
      ? { ...last, high: Math.max(last.high, p), low: Math.min(last.low, p), close: p }
      : { ...last, openTime, closeTime: openTime + tfMs - 1, open: last.close, high: Math.max(last.close, p), low: Math.min(last.close, p), close: p, volume: 0, quoteVolume: 0, trades: 0 };
    s.update({ time: sec(bar.openTime), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    byTime.current.set(sec(bar.openTime), bar);
    lastBar.current = bar;
    setLiveBar(bar);
  }, [live, tfMs]);

  // Price lines: open positions, and the plan with the strongest key levels.
  useEffect(() => {
    const s = candleRef.current;
    if (!s) return;
    for (const l of priceLines.current) s.removePriceLine(l);
    priceLines.current = [];
    const add = (o: Parameters<typeof s.createPriceLine>[0]) => priceLines.current.push(s.createPriceLine(o));
    const good = css('--color-good');
    const bad = css('--color-critical');
    if (show.has('positions')) {
      for (const p of positions) {
        // Labels on the price axis only: the position box draws the levels on the chart.
        add({ price: p.entryPrice, color: css('--color-ink-2'), lineWidth: 1, lineVisible: false, title: `entry ${p.side}` });
        add({ price: p.stop, color: bad, lineWidth: 1, lineVisible: false, title: 'stop' });
        if (p.target !== null) add({ price: p.target, color: good, lineWidth: 1, lineVisible: false, title: 'target' });
      }
    }
    if (idea && show.has('plan')) {
      const plan = idea.plan;
      if (plan && plan.entryLow !== null && plan.entryHigh !== null && plan.stop !== null) {
        const accent = css('--color-accent');
        add({ price: plan.entryHigh, color: accent, lineWidth: 2, lineStyle: LineStyle.Solid, title: `plan ${plan.direction} entry` });
        add({ price: plan.entryLow, color: accent, lineWidth: 2, lineStyle: LineStyle.Solid, title: '', axisLabelVisible: false });
        add({ price: plan.stop, color: bad, lineWidth: 2, lineStyle: LineStyle.Dotted, title: 'plan stop' });
        for (const t of plan.targets) add({ price: t.price, color: good, lineWidth: 2, lineStyle: LineStyle.Dotted, title: `${t.label} ${t.r.toFixed(1)}R` });
      }
      const planned = new Set([plan?.entryHigh, plan?.entryLow, plan?.stop, ...(plan?.targets ?? []).map((t) => t.price)]);
      for (const l of idea.levels.filter((x) => Math.abs(x.distancePct) <= 8 && x.strength >= 2 && !planned.has(x.price)).sort((a, b) => b.strength - a.strength).slice(0, 6)) {
        add({ price: l.price, color: l.kind === 'support' ? css('--color-demand') : css('--color-supply'), lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: true, title: `${l.kind} ${l.strength}` });
      }
    }
  }, [idea, positions, showKey, viewKey]);

  // Trade markers.
  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    if (!show.has('trades') || !candles.length) { m.setMarkers([]); return; }
    const first = candles[0].openTime;
    const good = css('--color-good');
    const bad = css('--color-critical');
    m.setMarkers(trades
      .filter((t) => t.openedAt >= first)
      .flatMap((t) => [
        { time: sec(t.openedAt - (t.openedAt % tfMs)), position: t.side === 'long' ? 'belowBar' : 'aboveBar', shape: t.side === 'long' ? 'arrowUp' : 'arrowDown', color: css('--color-accent'), text: `${t.side} in` } as SeriesMarker<Time>,
        { time: sec(t.closedAt - (t.closedAt % tfMs)), position: t.side === 'long' ? 'aboveBar' : 'belowBar', shape: 'circle', color: t.pnl >= 0 ? good : bad, text: `${t.reason} ${t.pnl >= 0 ? '+' : '−'}$${Math.abs(t.pnl).toFixed(2)}` } as SeriesMarker<Time>,
      ])
      .sort((a, b) => (a.time as number) - (b.time as number)));
  }, [trades, candles, tfMs, showKey, viewKey]);

  const k = hover ?? liveBar ?? candles[candles.length - 1];
  return (
    <div className="relative">
      {k && (
        <div className="absolute left-2 top-1 z-10 flex flex-wrap gap-x-3 text-xs text-ink-2 tabular">
          <span>{dateTime(k.openTime)} UTC</span>
          <span>O <b className="text-ink">{fmtPrice(k.open)}</b></span>
          <span>H <b className="text-ink">{fmtPrice(k.high)}</b></span>
          <span>L <b className="text-ink">{fmtPrice(k.low)}</b></span>
          <span>C <b className={k.close >= k.open ? 'text-good' : 'text-critical'}>{fmtPrice(k.close)}</b></span>
        </div>
      )}
      <div ref={el} className="h-[640px] w-full" />
      <Overlay chart={chartRef.current} series={candleRef.current} candles={candles} overlays={overlays} show={show} tf={tf} tfMs={tfMs} idea={idea ?? null}
        positions={positions} priceNow={liveBar?.close ?? candles[candles.length - 1]?.close ?? null} />
    </div>
  );
}

const LIQUIDITY_SHORT: Record<string, string> = {
  PDH: 'PDH', PDL: 'PDL', asian_high: 'Asian high', asian_low: 'Asian low', london_high: 'London high', london_low: 'London low',
  EQH: 'EQH', EQL: 'EQL', '4h_swing_high': '4h high', '4h_swing_low': '4h low',
};

/** Session shading, boxes and the volume profile, drawn in SVG over the price panel at the chart's own coordinates. */
function Overlay({ chart, series, candles, overlays, show, tf, tfMs, idea, positions, priceNow }: {
  chart: IChartApi | null; series: ISeriesApi<'Candlestick'> | null; candles: Candle[]; overlays: ChartOverlays; show: Set<IndicatorId>; tf: string; tfMs: number; idea: TradeIdea | null;
  positions: PositionViewLike[]; priceNow: number | null;
}) {
  if (!chart || !series || !candles.length) return null;
  const width = chart.timeScale().width();
  const height = chart.paneSize(0).height;
  if (!(width > 0 && height > 0)) return null;
  const first = candles[0].openTime;
  const last = candles[candles.length - 1].openTime;
  const ts = chart.timeScale();
  // Any time to an x: snapped to its candle; before the data at the first candle, after it at the right edge.
  const firstX = Math.max(0, ts.timeToCoordinate(sec(first)) ?? 0);
  const x = (ms: number) => {
    const t = Math.floor(ms / tfMs) * tfMs;
    if (t < first) return firstX;
    if (t > last) return width;
    const c = ts.timeToCoordinate(sec(t));
    return c === null ? width : Math.max(0, Math.min(width, c));
  };
  /** A time to an x without clamping, for drawings that should scroll off-screen with their candles; null outside the data. */
  const xFree = (ms: number) => {
    const t = Math.floor(ms / tfMs) * tfMs;
    return t < first || t > last ? null : ts.timeToCoordinate(sec(t));
  };
  const y = (p: number) => series.priceToCoordinate(p);
  const box = (key: string, from: number, top: number, bottom: number, props: Record<string, string | number>, label: string) => {
    const y1 = y(top);
    const y2 = y(bottom);
    if (y1 === null || y2 === null) return null;
    const x1 = x(from);
    if (y2 < 0 || y1 > height || x1 >= width) return null;
    return (
      <g key={key}>
        <rect x={x1} y={y1} width={width - x1} height={Math.max(1, y2 - y1)} {...props} />
        <text x={x1 + 4} y={y1 + 11} fontSize={10} fill="var(--color-ink-2)">{label}</text>
      </g>
    );
  };

  const buy = 'var(--color-demand)';
  const sell = 'var(--color-supply)';
  const profileName = show.has('profile24h') ? '24h' : show.has('profile7d') ? '7d' : null;
  const profile = profileName ? overlays.profiles.find((p) => p.name === profileName) : null;
  const maxVol = profile ? Math.max(...profile.bins.map((b) => b.volume)) : 0;
  const barMax = width * 0.22;

  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-hidden" width={width} height={height} aria-hidden>
      <defs>
        {[['hatch-buy', buy], ['hatch-sell', sell]].map(([id, color]) => (
          <pattern key={id} id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={color} fillOpacity={0.08} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeOpacity={0.45} strokeWidth="1.5" />
          </pattern>
        ))}
      </defs>

      {show.has('sessions') && tfMs < 14_400_000 && overlays.sessions.map((sn) => {
        const x1 = x(sn.openTime);
        const x2 = x(sn.closeTime);
        if (x2 <= 0 || x1 >= width || x2 - x1 < 2) return null;
        const lane = { asian: 0, london: 1, newyork: 2 }[sn.name] ?? 0;
        return (
          <g key={`${sn.name}${sn.openTime}`}>
            <rect x={x1} y={0} width={x2 - x1} height={height} fill={`var(--color-${sn.name})`} fillOpacity={0.05} />
            <rect x={x1} y={height - 4 - lane * 5} width={x2 - x1} height={3} rx={1.5} fill={`var(--color-${sn.name})`} fillOpacity={0.8} />
            {x2 - x1 > 60 && <text x={x1 + 4} y={height - 22 - lane * 11} fontSize={10} fill="var(--color-ink-3)">{SESSION_LABEL[sn.name] ?? sn.name}</text>}
          </g>
        );
      })}

      {show.has('premium') && idea?.dealingRange && (() => {
        // The 4h dealing range: premium (upper half) tinted with the sell colour, discount with the buy colour.
        const r = idea.dealingRange;
        const yh = y(r.high);
        const yl = y(r.low);
        const ye = y((r.high + r.low) / 2);
        if (yh === null || yl === null || ye === null) return null;
        return (
          <g>
            <rect x={0} y={Math.max(0, yh)} width={width} height={Math.max(0, Math.min(height, ye) - Math.max(0, yh))} fill={sell} fillOpacity={0.05} />
            <rect x={0} y={Math.max(0, ye)} width={width} height={Math.max(0, Math.min(height, yl) - Math.max(0, ye))} fill={buy} fillOpacity={0.05} />
            {ye > 0 && ye < height && <line x1={0} x2={width} y1={ye} y2={ye} stroke="var(--color-ink-2)" strokeOpacity={0.6} strokeDasharray="2 4" />}
            {ye > 12 && ye < height && <text x={6} y={ye - 4} fontSize={10} fill="var(--color-ink-2)">equilibrium {fmtPrice((r.high + r.low) / 2)} · premium above, discount below</text>}
          </g>
        );
      })()}

      {show.has('killzones') && tfMs < 14_400_000 && overlays.killzones.map((k) => {
        const x1 = x(k.openTime);
        const x2 = x(k.closeTime);
        if (x2 <= 0 || x1 >= width || x2 - x1 < 2) return null;
        return (
          <g key={`kz${k.name}${k.openTime}`}>
            <rect x={x1} y={0} width={x2 - x1} height={height} fill="var(--color-accent)" fillOpacity={0.07} />
            <rect x={x1} y={0} width={x2 - x1} height={3} fill="var(--color-accent)" fillOpacity={0.8} />
            {x2 - x1 > 40 && <text x={x1 + 4} y={14} fontSize={10} fill="var(--color-accent)">{SESSION_LABEL[k.name] ?? k.name} killzone</text>}
          </g>
        );
      })}

      {show.has('orderblocks') && tf !== '1m' && (idea?.orderBlocks ?? []).map((b) => box(
        `ob${b.side}${b.createdAt}${b.low}`, b.createdAt - 2 * 3_600_000, b.high, b.low,
        { fill: b.side === 'bullish' ? buy : sell, fillOpacity: 0.1, stroke: b.side === 'bullish' ? buy : sell, strokeOpacity: 0.9, strokeWidth: 1, strokeDasharray: '2 2' },
        `${b.side} order block`,
      ))}

      {show.has('liquidity') && (() => {
        // One line per price: levels at the same price (say the PDL and the Asian low) share a label.
        const byPrice = new Map<number, { names: string[]; side: 'buy' | 'sell'; intact: boolean }>();
        for (const l of idea?.liquidity ?? []) {
          const g = byPrice.get(l.price) ?? { names: [], side: l.side, intact: true };
          g.names.push(LIQUIDITY_SHORT[l.name] ?? l.name);
          g.intact = g.intact && l.intact;
          byPrice.set(l.price, g);
        }
        // Top to bottom; a label that would overlap the one above is left out (its line stays, the price axis shows it).
        let lastLabel = -Infinity;
        return [...byPrice]
          .flatMap(([p, g]) => {
            const yy = y(p);
            return yy !== null && yy >= 0 && yy <= height ? [{ p, g, yy: yy as number }] : [];
          })
          .sort((a, b) => a.yy - b.yy)
          .map(({ p, g, yy }) => {
            const color = g.side === 'sell' ? buy : sell;   // lows (sell-side) on the buy colour, highs on the sell colour
            const label = yy - lastLabel >= 12;
            if (label) lastLabel = yy;
            return (
              <g key={`liq${p}`} opacity={g.intact ? 1 : 0.35}>
                <line x1={0} x2={width} y1={yy} y2={yy} stroke={color} strokeWidth={1.25} strokeDasharray="8 4" />
                {label && <text x={6} y={yy - 3} fontSize={10} fill={color} {...HALO}>{g.names.join(' · ')} {fmtPrice(p)}{g.intact ? '' : ' · swept'}</text>}
              </g>
            );
          });
      })()}

      {show.has('htf') && overlays.htf && (['long', 'short'] as const).flatMap((side) => (overlays.htf?.[side] ?? []).map((p) => box(
        `htf${side}${p.id}`, p.from, p.high, p.low,
        { fill: side === 'long' ? buy : sell, fillOpacity: 0.12, stroke: side === 'long' ? buy : sell, strokeOpacity: 0.95, strokeWidth: 1.5 },
        HTF_LABEL[side][p.kind],
      )))}

      {show.has('zones') && overlays.zones.map((z) => box(
        z.id, z.createdAt, z.high, z.low,
        { fill: z.type === 'demand' ? buy : sell, fillOpacity: 0.14, stroke: z.type === 'demand' ? buy : sell, strokeOpacity: 0.7, strokeWidth: 1 },
        `${z.type} zone · ${z.status}`,
      ))}

      {show.has('fvg') && overlays.fvgs.filter((g) => g.tf === tf).map((g) => box(
        g.id, g.createdAt - 2 * tfMs, g.top, g.bottom,
        { fill: `url(#hatch-${g.side === 'bullish' ? 'buy' : 'sell'})`, stroke: g.side === 'bullish' ? buy : sell, strokeOpacity: 0.8, strokeWidth: 1, strokeDasharray: g.inverse ? '1 3' : '5 3' },
        `${g.side} ${g.inverse ? 'IFVG' : 'FVG'}${g.status === 'tested' ? ' · tested' : ''}`,
      ))}

      {show.has('wyckoff') && overlays.reading?.tf === tf && overlays.reading.wyckoff && (() => {
        const w = overlays.reading.wyckoff;
        const yt = y(w.top);
        const yb = y(w.bottom);
        const x1 = xFree(w.from);
        if (yt === null || yb === null || x1 === null || x1 >= width) return null;
        const color = w.kind === 'accumulation' ? 'var(--color-demand)' : 'var(--color-supply)';
        const mid = (w.top + w.bottom) / 2;
        return (
          <g>
            <rect x={x1} y={yt} width={width - x1} height={Math.max(1, yb - yt)} fill={color} fillOpacity={0.06} stroke={color} strokeOpacity={0.6} strokeDasharray="6 3" />
            <text x={Math.max(x1, 0) + 6} y={yb - 6} fontSize={11} fontWeight={600} fill={color} {...HALO}>Wyckoff {w.kind} · phase {w.phase}</text>
            {w.events.map((e) => {
              const ex = xFree(e.time);
              const ey = y(e.price);
              if (ex === null || ey === null) return null;
              const above = e.price >= mid;
              return (
                <g key={`${e.name}${e.time}`}>
                  <circle cx={ex} cy={ey} r={3.5} fill={color} stroke="var(--color-page)" strokeWidth={1} />
                  <text x={ex} y={above ? ey - 8 : ey + 16} fontSize={10} fontWeight={600} textAnchor="middle" fill={color} {...HALO}>{e.name}</text>
                </g>
              );
            })}
          </g>
        );
      })()}

      {show.has('patterns') && overlays.reading?.tf === tf && overlays.reading.patterns.map((p) => {
        const color = BIAS_COLOR[p.bias];
        const ys = [y(p.upper.p1), y(p.upper.p2), y(p.lower.p2), y(p.lower.p1)];
        const xu = xFree(p.upper.t1);
        const xl = xFree(p.lower.t1);
        const xb = xFree(p.upper.t2);
        if (ys.some((v) => v === null) || xu === null || xl === null || xb === null || xb < 0 || Math.min(xu, xl) > width) return null;
        const [u1, u2, l2, l1] = ys as number[];
        const yLabel = u2;
        const yTarget = p.target === null ? null : y(p.target);
        const status = p.status === 'forming' ? 'forming' : p.status === 'broke_up' ? 'broke up' : 'broke down';
        return (
          <g key={`${p.kind}${p.from}`}>
            <polygon points={`${xu},${u1} ${xb},${u2} ${xb},${l2} ${xl},${l1}`} fill={color} fillOpacity={0.08} />
            <line x1={xu} y1={u1} x2={xb} y2={u2} stroke={color} strokeWidth={2.5} />
            <line x1={xl} y1={l1} x2={xb} y2={l2} stroke={color} strokeWidth={2.5} />
            <text x={xb - 4} y={yLabel - 7} fontSize={11} fontWeight={700} textAnchor="end" fill={color} {...HALO}>{p.label} · {status}</text>
            {yTarget !== null && (
              <g>
                <line x1={xb - 80} x2={width} y1={yTarget} y2={yTarget} stroke={color} strokeDasharray="3 3" strokeOpacity={0.8} />
                <text x={xb - 80} y={yTarget - 3} fontSize={10} fill={color} {...HALO}>{p.label.toLowerCase()} target {fmtPrice(p.target!)}</text>
              </g>
            )}
          </g>
        );
      })}

      {show.has('scalp') && tfMs <= 900_000 && (overlays.scalps ?? []).filter((sc) => sc.status === 'open' || last - (sc.closedAt ?? 0) < 4 * 3_600_000).map((sc) => {
        // From the signal candle to where it closed (or the right edge while open).
        const x1 = xFree(sc.time);
        if (x1 === null) return null;
        const x2 = sc.closedAt === null ? width : Math.min(width, x(sc.closedAt));
        if (x2 < 0 || x1 > width) return null;
        const open = sc.status === 'open';
        const lines = [['entry', sc.entry, 'var(--color-ink)'], ['stop', sc.stop, 'var(--color-critical)'], ['target', sc.target, 'var(--color-good)']] as const;
        const ye = y(sc.entry);
        return (
          <g key={`sc${sc.kind}${sc.side}${sc.time}`} opacity={open ? 1 : 0.35}>
            {lines.map(([name, p, color]) => {
              const yy = y(p);
              if (yy === null) return null;
              return <line key={name} x1={x1} x2={x2} y1={yy} y2={yy} stroke={color} strokeWidth={name === 'entry' ? 1.5 : 1.25} strokeDasharray={name === 'entry' ? undefined : '4 3'} />;
            })}
            {open && ye !== null && (
              <text x={Math.max(x1, 0) + 4} y={sc.side === 'long' ? ye + 13 : ye - 5} fontSize={10} fontWeight={600} fill="var(--color-ink)" {...HALO}>
                {SCALP_LABEL[sc.kind]} {sc.side}
              </text>
            )}
          </g>
        );
      })}

      {show.has('positions') && positions.map((p) => {
        // The long/short position box: reward (entry to target) in green, risk (entry to stop) in red, from the entry on.
        const long = p.side === 'long';
        const ye = y(p.entryPrice);
        const ys = y(p.stop);
        const yt = p.target === null ? null : y(p.target);
        if (ye === null || ys === null) return null;
        // From the entry candle to the right edge; at least 300px wide, so a trade opened in the forming candle still shows with its labels.
        const x1 = Math.max(0, Math.min(p.openedAt ? x(p.openedAt) : 0, width - 300));
        const w = width - x1;
        const pct = (to: number) => ((long ? to - p.entryPrice : p.entryPrice - to) / p.entryPrice) * 100;
        const risk = Math.abs(p.entryPrice - p.stop);
        const r = p.target === null ? null : Math.abs(p.target - p.entryPrice) / risk;
        const pnl = priceNow === null ? null : pct(priceNow);
        const good = 'var(--color-good)';
        const bad = 'var(--color-critical)';
        const label = (yy: number, text: string, color: string, below: boolean) => (
          <text x={x1 + 6} y={below ? yy + 13 : yy - 5} fontSize={11} fontWeight={600} fill={color} {...HALO}>{text}</text>
        );
        return (
          <g key={`pos${p.id ?? p.entryPrice}`}>
            {yt !== null && <rect x={x1} y={Math.min(ye, yt)} width={w} height={Math.abs(yt - ye)} fill={good} fillOpacity={0.16} stroke={good} strokeOpacity={0.5} />}
            <rect x={x1} y={Math.min(ye, ys)} width={w} height={Math.abs(ys - ye)} fill={bad} fillOpacity={0.16} stroke={bad} strokeOpacity={0.5} />
            <line x1={x1} x2={width} y1={ye} y2={ye} stroke="var(--color-ink-2)" strokeWidth={1.5} />
            {yt !== null && label(yt, `Target ${fmtPrice(p.target!)} · ${pct(p.target!) >= 0 ? '+' : ''}${pct(p.target!).toFixed(2)}% · ${r!.toFixed(2)}R`, good, !long)}
            {label(ys, `Stop ${fmtPrice(p.stop)} · ${pct(p.stop).toFixed(2)}%`, bad, long)}
            {label(ye, `${long ? 'Long' : 'Short'} ${fmtPrice(p.entryPrice)}${pnl === null ? '' : ` · now ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`}`, pnl === null || pnl >= 0 ? good : bad, false)}
          </g>
        );
      })}

      {profile && (
        <g>
          {profile.bins.map((b, i) => {
            const y1 = y(b.high);
            const y2 = y(b.low);
            if (y1 === null || y2 === null || b.volume <= 0) return null;
            const w = (b.volume / maxVol) * barMax;
            const inValue = b.low >= profile.val - 1e-12 && b.high <= profile.vah + 1e-12;
            return <rect key={i} x={width - w} y={y1 + 1} width={w} height={Math.max(1, y2 - y1 - 2)} rx={1} fill="var(--color-ink-3)" fillOpacity={inValue ? 0.5 : 0.25} />;
          })}
          {([['POC', profile.poc, 'var(--color-ink)', undefined], ['VAH', profile.vah, 'var(--color-ink-2)', '4 3'], ['VAL', profile.val, 'var(--color-ink-2)', '4 3']] as const).map(([name, p, color, dash]) => {
            const yy = y(p);
            if (yy === null || yy < 0 || yy > height) return null;
            return (
              <g key={name}>
                <line x1={0} x2={width} y1={yy} y2={yy} stroke={color} strokeOpacity={0.7} strokeWidth={name === 'POC' ? 1.5 : 1} strokeDasharray={dash} />
                <text x={width - barMax - 4} y={yy - 3} fontSize={10} textAnchor="end" fill="var(--color-ink-2)">{profile.name} {name} {fmtPrice(p)}</text>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}
