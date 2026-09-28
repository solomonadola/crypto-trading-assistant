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
  AreaSeries, CandlestickSeries, ColorType, CrosshairMode, LineSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, ClosedTradeView, EquityPoint, PositionViewLike, TradeIdea, Zone } from './chartTypes';
import type { Fvg, VolumeProfile } from '../lib/api';
import { ema, supertrend } from '../../engine/src/analysis/indicators';
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

export interface ChartLayers {
  zones: boolean;
  fvg: boolean;
  /** Name of the volume profile window to draw, or null. */
  profile: string | null;
  supertrend: boolean;
  plan: boolean;
}

export interface ChartOverlays {
  zones: Zone[];
  fvgs: Fvg[];
  profiles: VolumeProfile[];
}

interface Props {
  candles: Candle[];
  overlays: ChartOverlays;
  trades: ClosedTradeView[];
  positions: PositionViewLike[];
  tfMs: number;
  tf: string;
  idea?: TradeIdea | null;
  layers: ChartLayers;
}

export function CandleChart({ candles, overlays, trades, positions, tfMs, tf, idea, layers }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [hover, setHover] = useState<Candle | null>(null);
  // Bumped whenever the view moves, so the overlay redraws at the new coordinates.
  const [, setView] = useState(0);
  const byTime = useRef(new Map<number, Candle>());

  useEffect(() => {
    if (!el.current) return;
    const c = baseChart(el.current);
    const good = css('--color-good');
    const bad = css('--color-critical');
    const s = c.addSeries(CandlestickSeries, {
      upColor: good, downColor: bad, borderUpColor: good, borderDownColor: bad, wickUpColor: good, wickDownColor: bad,
      priceFormat: { type: 'custom', formatter: (v: number) => fmtPrice(v), minMove: 1e-8 },
    });
    s.setData(candles.map((k) => ({ time: sec(k.openTime), open: k.open, high: k.high, low: k.low, close: k.close })));
    byTime.current = new Map(candles.map((k) => [sec(k.openTime), k]));

    const closes = candles.map((k) => k.close);
    for (const [n, color] of [[20, css('--color-accent')], [50, css('--color-warning')]] as const) {
      const line = c.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: `EMA${n}` });
      line.setData(ema(closes, n).flatMap((v, i) => (Number.isFinite(v) ? [{ time: sec(candles[i].openTime), value: v }] : [])));
    }

    // SuperTrend: the line below price in an uptrend, above in a downtrend; a gap where it flips.
    if (layers.supertrend) {
      const st = supertrend(candles.map((k) => k.high), candles.map((k) => k.low), closes, 10, 3);
      const line = c.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: 'SuperTrend' });
      line.setData(candles.flatMap((k, i) => {
        if (!Number.isFinite(st.line[i])) return [];
        if (i > 0 && st.dir[i] !== st.dir[i - 1]) return [{ time: sec(k.openTime) }];
        return [{ time: sec(k.openTime), value: st.line[i], color: st.dir[i] === 1 ? good : bad }];
      }));
    }

    // Open positions: entry, stop and target.
    for (const p of positions) {
      s.createPriceLine({ price: p.entryPrice, color: css('--color-ink-2'), lineWidth: 1, lineStyle: LineStyle.Solid, title: `entry ${p.side}` });
      s.createPriceLine({ price: p.stop, color: bad, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'stop' });
      if (p.target !== null) s.createPriceLine({ price: p.target, color: good, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'target' });
    }
    // Suggested plan and the strongest key levels near the price.
    if (idea && layers.plan) {
      const plan = idea.plan;
      if (plan && plan.entryLow !== null && plan.entryHigh !== null && plan.stop !== null) {
        const accent = css('--color-accent');
        s.createPriceLine({ price: plan.entryHigh, color: accent, lineWidth: 2, lineStyle: LineStyle.Solid, title: `plan ${plan.direction} entry` });
        s.createPriceLine({ price: plan.entryLow, color: accent, lineWidth: 2, lineStyle: LineStyle.Solid, title: '', axisLabelVisible: false });
        s.createPriceLine({ price: plan.stop, color: bad, lineWidth: 2, lineStyle: LineStyle.Dotted, title: 'plan stop' });
        for (const t of plan.targets) s.createPriceLine({ price: t.price, color: good, lineWidth: 2, lineStyle: LineStyle.Dotted, title: `${t.label} ${t.r.toFixed(1)}R` });
      }
      const planned = new Set([plan?.entryHigh, plan?.entryLow, plan?.stop, ...(plan?.targets ?? []).map((t) => t.price)]);
      const near = idea.levels
        .filter((l) => Math.abs(l.distancePct) <= 8 && l.strength >= 2 && !planned.has(l.price))
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 6);
      for (const l of near) {
        s.createPriceLine({
          price: l.price, color: l.kind === 'support' ? css('--color-demand') : css('--color-supply'), lineWidth: 1, lineStyle: LineStyle.SparseDotted,
          axisLabelVisible: true, title: `${l.kind} ${l.strength}`,
        });
      }
    }

    // Trades: arrows at entry and exit.
    const first = candles[0]?.openTime ?? 0;
    const markers: SeriesMarker<Time>[] = trades
      .filter((t) => t.openedAt >= first)
      .flatMap((t) => [
        { time: sec(t.openedAt - (t.openedAt % tfMs)), position: t.side === 'long' ? 'belowBar' : 'aboveBar', shape: t.side === 'long' ? 'arrowUp' : 'arrowDown', color: css('--color-accent'), text: `${t.side} in` } as SeriesMarker<Time>,
        { time: sec(t.closedAt - (t.closedAt % tfMs)), position: t.side === 'long' ? 'aboveBar' : 'belowBar', shape: 'circle', color: t.pnl >= 0 ? good : bad, text: `${t.reason} ${t.pnl >= 0 ? '+' : '−'}$${Math.abs(t.pnl).toFixed(2)}` } as SeriesMarker<Time>,
      ])
      .sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(s, markers);

    c.subscribeCrosshairMove((p) => setHover(p.time ? byTime.current.get(p.time as number) ?? null : null));
    const redraw = () => setView((v) => v + 1);
    c.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    const ro = new ResizeObserver(redraw);
    ro.observe(el.current);
    c.timeScale().fitContent();
    chartRef.current = c;
    seriesRef.current = s;
    redraw();
    return () => { ro.disconnect(); c.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [candles, trades, positions, tfMs, idea, layers.plan, layers.supertrend]);

  const k = hover ?? candles[candles.length - 1];
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
      <div ref={el} className="h-[560px] w-full" />
      <Overlay chart={chartRef.current} series={seriesRef.current} candles={candles} overlays={overlays} layers={layers} tf={tf} tfMs={tfMs} />
    </div>
  );
}

/** Boxes and the volume profile, drawn in SVG over the chart at the chart's own coordinates. */
function Overlay({ chart, series, candles, overlays, layers, tf, tfMs }: {
  chart: IChartApi | null; series: ISeriesApi<'Candlestick'> | null; candles: Candle[]; overlays: ChartOverlays; layers: ChartLayers; tf: string; tfMs: number;
}) {
  if (!chart || !series || !candles.length) return null;
  const width = chart.timeScale().width();
  const height = chart.paneSize().height;
  if (!(width > 0 && height > 0)) return null;
  const first = candles[0].openTime;
  const ts = chart.timeScale();
  const x = (ms: number) => {
    const t = Math.floor(ms / tfMs) * tfMs;
    if (t < first) return 0;
    const c = ts.timeToCoordinate(sec(t));
    return c === null ? width : Math.max(0, Math.min(width, c));
  };
  const y = (p: number) => series.priceToCoordinate(p);
  const box = (key: string, from: number, top: number, bottom: number, props: Record<string, string | number>, label: string) => {
    const y1 = y(top);
    const y2 = y(bottom);
    if (y1 === null || y2 === null) return null;
    const x1 = x(from);
    const h = Math.max(1, y2 - y1);
    if (y2 < 0 || y1 > height || x1 >= width) return null;
    return (
      <g key={key}>
        <rect x={x1} y={y1} width={width - x1} height={h} {...props} />
        <text x={x1 + 4} y={y1 + 11} fontSize={10} fill="var(--color-ink-2)">{label}</text>
      </g>
    );
  };

  const buy = 'var(--color-demand)';
  const sell = 'var(--color-supply)';
  const profile = layers.profile ? overlays.profiles.find((p) => p.name === layers.profile) : null;
  const maxVol = profile ? Math.max(...profile.bins.map((b) => b.volume)) : 0;
  const barMax = width * 0.22;

  return (
    <svg className="pointer-events-none absolute left-0 top-0" width={width} height={height} aria-hidden>
      <defs>
        {[['hatch-buy', buy], ['hatch-sell', sell]].map(([id, color]) => (
          <pattern key={id} id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={color} fillOpacity={0.08} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeOpacity={0.45} strokeWidth="1.5" />
          </pattern>
        ))}
      </defs>

      {layers.zones && overlays.zones.map((z) => box(
        z.id, z.createdAt, z.high, z.low,
        { fill: z.type === 'demand' ? buy : sell, fillOpacity: 0.14, stroke: z.type === 'demand' ? buy : sell, strokeOpacity: 0.7, strokeWidth: 1 },
        `${z.type} zone · ${z.status}`,
      ))}

      {layers.fvg && overlays.fvgs.filter((g) => g.tf === tf).map((g) => box(
        g.id, g.createdAt - 2 * tfMs, g.top, g.bottom,
        { fill: `url(#hatch-${g.side === 'bullish' ? 'buy' : 'sell'})`, stroke: g.side === 'bullish' ? buy : sell, strokeOpacity: 0.8, strokeWidth: 1, strokeDasharray: g.inverse ? '1 3' : '5 3' },
        `${g.side} ${g.inverse ? 'IFVG' : 'FVG'}${g.status === 'tested' ? ' · tested' : ''}`,
      ))}

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
