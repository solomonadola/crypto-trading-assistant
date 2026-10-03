import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickChart, CheckCircle2, CircleDashed, Crosshair, Layers, Shapes, SlidersHorizontal, XCircle } from 'lucide-react';
import { usePoll, usePrices, type AccountSummary, type Analysis, type Candle, type ChartReading, type ClosedTradeView, type MarketRow, type SessionInstance } from '../lib/api';
import { coin, pct, price } from '../lib/format';
import { Badge, Card, StateBadge, TrendChip } from '../components/ui';
import { CandleChart, DEFAULT_INDICATORS, INDICATORS, type ChartOverlays, type IndicatorId } from '../components/charts';
import { TradePlanCard } from '../components/TradePlan';
import { AddCoin } from '../components/AddCoin';
import type { TradeIdea, WatchLevel } from '../../shared/types';

const TFS = [['15m', 900_000], ['1h', 3_600_000], ['4h', 14_400_000], ['5m', 300_000], ['1m', 60_000]] as const;
const STORE_KEY = 'chart-indicators';
/** Set once the smart-money indicators have been switched on for a saved choice. */
const SMART_KEY = 'chart-indicators-smart';
/** Set once the pattern and Wyckoff drawings have been switched on for a saved choice. */
const PATTERNS_KEY = 'chart-indicators-patterns';

/** The viewer's indicator choice, remembered in this browser (a convenience: defaults when storage is unavailable). */
function useIndicators(): [Set<IndicatorId>, (id: IndicatorId) => void, () => void] {
  const [ids, setIds] = useState<IndicatorId[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
      if (Array.isArray(saved)) {
        const kept = saved.filter((x): x is IndicatorId => INDICATORS.some((i) => i.id === x));
        // Saved before the smart-money or pattern items existed: switch those on, once.
        const added: IndicatorId[] = [];
        if (!localStorage.getItem(SMART_KEY)) added.push('liquidity', 'orderblocks', 'premium', 'killzones');
        if (!localStorage.getItem(PATTERNS_KEY)) added.push('patterns', 'wyckoff');
        localStorage.setItem(SMART_KEY, '1');
        localStorage.setItem(PATTERNS_KEY, '1');
        return [...new Set<IndicatorId>([...kept, ...added])];
      }
      localStorage.setItem(SMART_KEY, '1');   // the defaults already include them
      localStorage.setItem(PATTERNS_KEY, '1');
    } catch { /* storage unavailable */ }
    return DEFAULT_INDICATORS;
  });
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(ids)); } catch { /* storage unavailable */ } }, [ids]);
  const toggle = (id: IndicatorId) => setIds((cur) => {
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    // One volume profile at a time.
    if (id === 'profile24h' && next.includes(id)) return next.filter((x) => x !== 'profile7d');
    if (id === 'profile7d' && next.includes(id)) return next.filter((x) => x !== 'profile24h');
    return next;
  });
  return [useMemo(() => new Set(ids), [ids]), toggle, () => setIds(DEFAULT_INDICATORS)];
}

function IndicatorPicker({ show, toggle, reset }: { show: Set<IndicatorId>; toggle: (id: IndicatorId) => void; reset: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const groups = [...new Set(INDICATORS.map((i) => i.group))];
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-line bg-card-2 px-2.5 py-1 text-xs text-ink hover:border-accent">
        <SlidersHorizontal size={13} />Indicators <span className="rounded bg-accent/20 px-1 text-accent">{show.size}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-line bg-card p-3 shadow-2xl shadow-black/50">
          {groups.map((g) => (
            <div key={g} className="mb-2">
              <p className="mb-1 text-[11px] uppercase tracking-wider text-ink-3">{g}</p>
              <div className="grid grid-cols-2 gap-1">
                {INDICATORS.filter((i) => i.group === g).map((i) => (
                  <label key={i.id} className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs ${show.has(i.id) ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-card-2'}`}>
                    <input type="checkbox" checked={show.has(i.id)} onChange={() => toggle(i.id)} className="accent-[var(--color-accent)]" />
                    {i.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <button onClick={reset} className="mt-1 text-xs text-accent hover:underline">Back to defaults</button>
        </div>
      )}
    </div>
  );
}

const WATCH_TONE: Record<WatchLevel['kind'], string> = {
  entry: 'text-accent', invalidation: 'text-critical', target: 'text-good', breakout: 'text-ink', range_top: 'text-supply', range_bottom: 'text-demand', sweep: 'text-warning',
};

/** Where price may run next if it closes through a level. */
export function IfBroken({ w }: { w: TradeIdea['watch'][number] }) {
  if (!w.ifBroken?.length) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-3">
      <span>if broken, next:</span>
      {w.ifBroken.map((n, i) => (
        <span key={n.price} className="rounded bg-card px-1.5 py-0.5 tabular text-ink-2" title={n.sources.join(', ')}>
          {i === 0 ? '→ ' : ''}{price(n.price)} <span className="text-ink-3">{pct(n.distancePct, 1, true)} · {n.sources[0]}</span>
        </span>
      ))}
    </p>
  );
}

function LivePrice({ symbol, fallback }: { symbol: string; fallback: number }) {
  const live = usePrices();
  return <span className="text-xs text-ink-3 tabular">now {price(live?.prices[symbol] ?? fallback)}</span>;
}

function WatchCard({ idea }: { idea: TradeIdea }) {
  return (
    <Card title="Levels to wait for" icon={<Crosshair size={16} />} right={<LivePrice symbol={idea.symbol} fallback={idea.price} />} className="h-full">
      {!idea.watch.length ? <p className="text-sm text-ink-3">No level within reach yet.</p> : (
        <ul className="space-y-2">
          {idea.watch.map((w) => (
            <li key={`${w.kind}${w.price}`} className="rounded-lg bg-card-2 px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className={`text-sm font-semibold ${WATCH_TONE[w.kind]}`}>{w.label}</span>
                <span className="tabular text-sm">{price(w.price)} <span className="text-xs text-ink-3">{pct(w.distancePct, 1, true)}</span></span>
              </div>
              <p className="mt-0.5 text-xs text-ink-2">{w.why}</p>
              <IfBroken w={w} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ChecklistCard({ idea }: { idea: TradeIdea }) {
  const met = idea.checklist.filter((i) => i.ok === true).length;
  const decided = idea.checklist.filter((i) => i.ok !== null).length;
  return (
    <Card
      title={`Checklist for a ${idea.checklistFor}`}
      icon={<CheckCircle2 size={16} />}
      right={<Badge tone={met === decided ? 'good' : met >= decided - 2 ? 'warning' : 'muted'}>{met}/{decided} met</Badge>}
      className="h-full"
    >
      {idea.bias === 'none' && <p className="mb-2 text-xs text-ink-3">No trend yet: checked for a {idea.checklistFor}, the way the 4h leans.</p>}
      <ul className="space-y-1.5">
        {idea.checklist.map((c) => (
          <li key={c.label} className="flex items-start gap-2 text-sm" title={c.detail}>
            {c.ok === true ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-good" aria-label="met" />
              : c.ok === false ? <XCircle size={15} className="mt-0.5 shrink-0 text-critical" aria-label="not met" />
              : <CircleDashed size={15} className="mt-0.5 shrink-0 text-warning" aria-label="waiting" />}
            <span className="min-w-0">
              <span className={c.ok === false ? 'text-ink-2' : 'text-ink'}>{c.label}</span>
              <span className="block truncate text-xs text-ink-3">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const TREND_TONE = { up: 'good', down: 'critical', range: 'muted' } as const;
const BIAS_TONE = { bullish: 'good', bearish: 'critical', neutral: 'warning' } as const;
const STATUS_TEXT = { forming: 'forming', broke_up: 'broke up', broke_down: 'broke down' } as const;

/** Trend, chart patterns and Wyckoff per timeframe; clicking a timeframe shows its drawings on the chart. */
function ReadingsCard({ readings, tf, setTf }: { readings: ChartReading[]; tf: string; setTf: (tf: string) => void }) {
  return (
    <Card title="Trend, patterns & Wyckoff" icon={<Shapes size={16} />} right={<span className="text-xs text-ink-3">read on closed candles · drawn on the chart for its timeframe</span>}>
      {!readings.length ? <p className="text-sm text-ink-3">No candles yet for 5m, 15m or 1h.</p> : (
        <div className="grid gap-4 lg:grid-cols-3">
          {readings.map((r) => (
            <div key={r.tf} className={`rounded-xl border p-3 ${r.tf === tf ? 'border-accent bg-accent/5' : 'border-line bg-card-2'}`}>
              <div className="flex items-center justify-between gap-2">
                <button onClick={() => setTf(r.tf)} className="text-sm font-semibold hover:text-accent" title="Show this timeframe on the chart">{r.tf}</button>
                {r.trend
                  ? <Badge tone={TREND_TONE[r.trend.direction]}>{r.trend.direction === 'range' ? 'ranging' : `${r.trend.strength} ${r.trend.direction}trend`}</Badge>
                  : <Badge tone="muted">not enough candles</Badge>}
              </div>
              {r.trend && <p className="mt-1 text-xs text-ink-3">{r.trend.detail}</p>}

              <p className="mt-3 text-[11px] uppercase tracking-wider text-ink-3">Patterns</p>
              {!r.patterns.length ? <p className="text-xs text-ink-3">None clear right now.</p> : (
                <ul className="mt-1 space-y-1.5">
                  {r.patterns.map((p) => (
                    <li key={`${p.kind}${p.from}`} className="text-sm">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold">{p.label}</span>
                        <Badge tone={BIAS_TONE[p.bias]}>{p.bias}</Badge>
                        <Badge tone={p.status === 'forming' ? 'muted' : 'accent'}>{STATUS_TEXT[p.status]}</Badge>
                      </span>
                      <span className="block text-xs text-ink-3">{p.detail}{p.target !== null ? ` · target ${price(p.target)}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-3 text-[11px] uppercase tracking-wider text-ink-3">Wyckoff</p>
              {!r.wyckoff ? <p className="text-xs text-ink-3">No accumulation or distribution range found.</p> : (
                <div className="mt-1 text-sm">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={r.wyckoff.kind === 'accumulation' ? 'good' : 'critical'}>{r.wyckoff.kind}</Badge>
                    <Badge tone="accent">phase {r.wyckoff.phase}</Badge>
                    <span className="text-xs text-ink-3 tabular">{price(r.wyckoff.bottom)} – {price(r.wyckoff.top)}</span>
                  </span>
                  <span className="block text-xs text-ink-3">{r.wyckoff.detail}</span>
                  <ul className="mt-1 space-y-0.5">
                    {r.wyckoff.events.map((e) => (
                      <li key={`${e.name}${e.time}`} className="text-xs" title={e.why}>
                        <b className="text-ink">{e.name}</b> <span className="tabular text-ink-2">{price(e.price)}</span> <span className="text-ink-3">· {e.why}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-3">
        Rule-based reads of the chart to help you look, not signals: the engine's entries do not use them. Trend: up or down when at least two of
        swing structure, the EMA20/EMA50 stack and the EMA20 slope agree. Wyckoff names: SC/BC selling/buying climax, AR automatic reaction,
        ST secondary test, Spring/UTAD the shakeout, SOS/SOW sign of strength/weakness, LPS/LPSY last point of support/supply.
      </p>
    </Card>
  );
}

export function ChartPage({ symbol, setSymbol }: { symbol: string; setSymbol: (s: string) => void }) {
  const [tf, setTf] = useState<(typeof TFS)[number][0]>('15m');
  const [show, toggle, reset] = useIndicators();
  const { data: market } = usePoll<MarketRow[]>('/api/market', 60_000);
  const { data: candles } = usePoll<Candle[]>(`/api/candles/${symbol}?tf=${tf}&limit=500`, 30_000);
  const { data: analysis } = usePoll<Analysis>(`/api/analysis/${symbol}`, 30_000);
  const { data: trades } = usePoll<ClosedTradeView[]>('/api/trades?limit=2000', 60_000);
  const { data: acct } = usePoll<AccountSummary>('/api/account', 10_000);
  const { data: idea } = usePoll<TradeIdea>(`/api/ideas/${symbol}`, 30_000);
  const { data: readings } = usePoll<ChartReading[]>(`/api/patterns/${symbol}`, 60_000);
  // A stable address (from the loaded candles, rounded to the day): a changing one would refetch on every redraw.
  const day = 86_400_000;
  const from = candles?.length ? Math.floor(candles[0].openTime / day) * day : null;
  const to = candles?.length ? Math.floor(candles[candles.length - 1].openTime / day) * day + 2 * day : null;
  const { data: sessions } = usePoll<SessionInstance[]>(from && to ? `/api/sessions?from=${from}&to=${to}` : null, 300_000);
  const { data: killzones } = usePoll<ChartOverlays['killzones']>(from && to ? `/api/killzones?from=${from}&to=${to}` : null, 300_000);

  const symbols = useMemo(() => [...new Set([symbol, 'BTCUSDT', ...(market ?? []).map((r) => r.symbol)])], [market, symbol]);
  const mine = useMemo(() => (trades ?? []).filter((t) => t.symbol === symbol), [trades, symbol]);
  const open = useMemo(() => (acct?.positions ?? []).filter((p) => p.symbol === symbol), [acct, symbol]);
  const zones = analysis?.zones ?? [];
  const tfMs = TFS.find((x) => x[0] === tf)![1];
  const lines = INDICATORS.filter((i) => show.has(i.id) && i.group === 'Lines');

  return (
    <div className="space-y-5">
      <Card
        title={<span className="flex items-center gap-2">{coin(symbol)}<span className="text-ink-3">/USDT perpetual</span></span>}
        icon={<CandlestickChart size={16} />}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <AddCoin onAdded={setSymbol} />
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded-lg border border-line bg-card-2 px-2 py-1 text-xs">
              {symbols.map((s) => <option key={s} value={s}>{coin(s)}</option>)}
            </select>
            <div className="flex overflow-hidden rounded-lg border border-line">
              {TFS.map(([name]) => (
                <button key={name} onClick={() => setTf(name)} className={`px-2.5 py-1 text-xs ${tf === name ? 'bg-accent text-white' : 'bg-card-2 text-ink-2 hover:text-ink'}`}>{name}</button>
              ))}
            </div>
            <IndicatorPicker show={show} toggle={toggle} reset={reset} />
          </div>
        }
      >
        {candles?.length ? (
          <CandleChart
            viewKey={`${symbol}|${tf}`}
            candles={candles}
            overlays={{ zones: tf === '1m' ? [] : zones, fvgs: analysis?.fvgs ?? [], profiles: analysis?.profiles ?? [], sessions: sessions ?? [], killzones: killzones ?? [], reading: readings?.find((r) => r.tf === tf) ?? null }}
            trades={mine} positions={open} tfMs={tfMs} tf={tf} idea={idea} show={show}
          />
        ) : <div className="grid h-[640px] place-items-center text-sm text-ink-3">Loading candles… (a newly added coin takes a few seconds to fetch its history)</div>}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-2">
          {lines.map((l) => <span key={l.id}>{l.label}</span>)}
          {show.has('sessions') && <span className="flex items-center gap-1"><span className="h-1 w-3 rounded bg-asian" />Asian<span className="ml-1 h-1 w-3 rounded bg-london" />London<span className="ml-1 h-1 w-3 rounded bg-newyork" />New York</span>}
          {(show.has('zones') || show.has('fvg')) && <span className="text-ink-3">blue = buy side · orange = sell side · solid box = zone · hatched = FVG (dotted edge = IFVG){tf === '1m' ? ' · none on 1m' : ''}</span>}
          <span className="text-ink-3">drag to scroll, wheel to zoom; the view stays where you leave it</span>
        </div>
      </Card>

      {readings && <ReadingsCard readings={readings} tf={tf} setTf={(t) => setTf(t as typeof tf)} />}

      {idea && (
        <div className="grid gap-5 lg:grid-cols-2">
          <WatchCard idea={idea} />
          <ChecklistCard idea={idea} />
        </div>
      )}

      {idea && <TradePlanCard idea={idea} />}

      {analysis && (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card title="Trend meter" icon={<Layers size={16} />}>
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-ink-3"><th className="text-left font-medium">tf</th><th className="text-left font-medium">structure</th><th className="text-left font-medium">SuperTrend</th><th className="text-right font-medium">agree</th></tr></thead>
              <tbody>
                {(['4h', '1h', '15m'] as const).map((t) => {
                  const m = analysis.trendMeter[t];
                  const st = m.supertrend === 1 ? 'up' : m.supertrend === -1 ? 'down' : null;
                  const agree = st && m.structure === st;
                  return (
                    <tr key={t} className="border-t border-line/60">
                      <td className="py-1.5 text-ink-3">{t}</td>
                      <td><TrendChip tf="" trend={m.structure} /> <span className="text-xs text-ink-2">{m.structure ?? '–'}</span></td>
                      <td><TrendChip tf="" trend={st} /> <span className="text-xs text-ink-2 tabular">{st ?? '–'} {m.line ? `· ${price(m.line)}` : ''}</span></td>
                      <td className="text-right text-xs">{agree ? <span className="text-good">✓ agree</span> : <span className="text-ink-3">mixed</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-3">
              <div className="flex justify-between text-xs"><span className="text-ink-3">1h ADX (trend strength)</span><span className="tabular">{analysis.adx1h?.toFixed(1) ?? '–'} · {analysis.adx1h === null ? '' : analysis.adx1h >= 25 ? 'trending' : analysis.adx1h >= 20 ? 'building' : 'ranging'}</span></div>
              <div className="mt-1 h-2 rounded bg-card-2"><div className="h-2 rounded bg-accent" style={{ width: `${Math.min(100, (analysis.adx1h ?? 0) * 2)}%` }} /></div>
            </div>
            <div className="mt-3 space-y-1.5 text-sm">
              <p className="flex items-center justify-between">Long <StateBadge state={analysis.long.state} tradable={analysis.long.tradable} /></p>
              <p className="flex items-center justify-between">Short <StateBadge state={analysis.short.state} tradable={analysis.short.tradable} /></p>
              <p className="text-xs text-ink-3 tabular">4h close {price(analysis.ema4h.close)} · EMA50 {price(analysis.ema4h.fast)} · EMA200 {price(analysis.ema4h.slow)}</p>
            </div>
          </Card>
          <Card title="Volume profile & protected levels">
            <div className="space-y-3 text-sm tabular">
              {analysis.profiles.map((p) => (
                <div key={p.name}>
                  <p className="mb-1 text-xs uppercase tracking-wider text-ink-3">{p.name}</p>
                  <p className="flex justify-between"><span className="text-ink-2">POC</span><b>{price(p.poc)}</b></p>
                  <p className="flex justify-between"><span className="text-ink-2">Value area</span><span>{price(p.val)} – {price(p.vah)}</span></p>
                  <p className="flex justify-between"><span className="text-ink-2">High-volume nodes</span><span>{p.hvn.map(price).join(' · ') || '–'}</span></p>
                </div>
              ))}
              <div>
                <p className="mb-1 text-xs uppercase tracking-wider text-ink-3">Protected levels</p>
                {(['4h', '1h', '15m'] as const).map((t) => {
                  const st = analysis.structure[t];
                  return (
                    <p key={t} className="flex justify-between">
                      <span className="text-ink-3">{t}</span>
                      <span>{st?.protectedLow ? <>low {price(st.protectedLow)}</> : st?.protectedHigh ? <>high {price(st.protectedHigh)}</> : st?.broken ? <Badge tone="warning">{st.broken} trend broken</Badge> : '–'}</span>
                    </p>
                  );
                })}
              </div>
            </div>
          </Card>
          <Card title={`Zones & gaps (${zones.length + analysis.fvgs.length})`}>
            {!zones.length && !analysis.fvgs.length ? <p className="text-sm text-ink-3">No active zone or fair value gap.</p> : (
              <ul className="space-y-1 text-sm tabular">
                {zones.map((z) => (
                  <li key={z.id} className="flex items-center justify-between gap-2">
                    <Badge tone={z.type === 'demand' ? 'london' : 'asian'}>1h {z.type}</Badge>
                    <span>{price(z.low)} – {price(z.high)}</span>
                    <span className="text-xs text-ink-3">{z.status}{z.touches ? ` · ${z.touches}×` : ''}</span>
                  </li>
                ))}
                {analysis.fvgs.slice().sort((a, b) => b.top - a.top).map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2">
                    <Badge tone={g.side === 'bullish' ? 'london' : 'asian'}>{g.tf} {g.side} {g.inverse ? 'IFVG' : 'FVG'}</Badge>
                    <span>{price(g.bottom)} – {price(g.top)}</span>
                    <span className="text-xs text-ink-3">{g.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
