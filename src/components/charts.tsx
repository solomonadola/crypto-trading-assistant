// Charts on TradingView's lightweight-charts: the equity curve and candles
// with zones, EMAs, positions and trades. Both have a crosshair with a value
// readout (the hover layer).
import { useEffect, useRef, useState } from 'react';
import {
  AreaSeries, CandlestickSeries, ColorType, CrosshairMode, LineSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, ClosedTradeView, EquityPoint, PositionViewLike, TradeIdea, Zone } from './chartTypes';
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

/** EMA for the chart overlay. */
function ema(values: number[], n: number): (number | null)[] {
  const k = 2 / (n + 1);
  let prev: number | null = null;
  return values.map((v, i) => {
    if (i < n - 1) return null;
    prev = prev === null ? values.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n : v * k + prev * (1 - k);
    return prev;
  });
}

export function CandleChart({ candles, zones, trades, positions, tfMs, idea }: { candles: Candle[]; zones: Zone[]; trades: ClosedTradeView[]; positions: PositionViewLike[]; tfMs: number; idea?: TradeIdea | null }) {
  const el = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Candle | null>(null);
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
      line.setData(ema(closes, n).flatMap((v, i) => (v === null ? [] : [{ time: sec(candles[i].openTime), value: v }])));
    }

    // Zones: a labelled line at each edge, in the zone's own color.
    for (const z of zones) {
      const color = z.type === 'demand' ? css('--color-demand') : css('--color-supply');
      const style = z.status === 'fresh' ? LineStyle.Solid : LineStyle.Dashed;
      s.createPriceLine({ price: z.high, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: `${z.type} ${z.status}` });
      s.createPriceLine({ price: z.low, color, lineWidth: 1, lineStyle: style, axisLabelVisible: false, title: '' });
    }
    // Open positions: entry, stop and target.
    for (const p of positions) {
      s.createPriceLine({ price: p.entryPrice, color: css('--color-ink-2'), lineWidth: 1, lineStyle: LineStyle.Solid, title: `entry ${p.side}` });
      s.createPriceLine({ price: p.stop, color: bad, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'stop' });
      if (p.target !== null) s.createPriceLine({ price: p.target, color: good, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'target' });
    }
    // Suggested plan and the strongest key levels near the price.
    if (idea) {
      const plan = idea.plan;
      if (plan && plan.entryLow !== null && plan.entryHigh !== null && plan.stop !== null) {
        const accent = css('--color-accent');
        s.createPriceLine({ price: plan.entryHigh, color: accent, lineWidth: 2, lineStyle: LineStyle.Solid, title: `plan ${plan.direction} entry` });
        s.createPriceLine({ price: plan.entryLow, color: accent, lineWidth: 2, lineStyle: LineStyle.Solid, title: '' , axisLabelVisible: false });
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
    c.timeScale().fitContent();
    return () => c.remove();
  }, [candles, zones, trades, positions, tfMs, idea]);

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
      <div ref={el} className="h-[520px] w-full" />
    </div>
  );
}
