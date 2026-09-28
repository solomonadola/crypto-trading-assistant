import { useMemo, useState } from 'react';
import { CandlestickChart, Layers } from 'lucide-react';
import { usePoll, type AccountSummary, type Analysis, type Candle, type ClosedTradeView, type MarketRow } from '../lib/api';
import { coin, price } from '../lib/format';
import { Badge, Card, StateBadge, TrendChip } from '../components/ui';
import { CandleChart, type ChartLayers } from '../components/charts';
import { TradePlanCard } from '../components/TradePlan';
import type { TradeIdea } from '../../shared/types';

const TFS = [['15m', 900_000], ['1h', 3_600_000], ['4h', 14_400_000], ['1m', 60_000]] as const;

function Toggle({ on, onClick, swatch, children }: { on: boolean; onClick: () => void; swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 ring-1 ${on ? 'ring-line text-ink' : 'ring-transparent text-ink-3 line-through'}`} aria-pressed={on}>
      {swatch}{children}
    </button>
  );
}

export function ChartPage({ symbol, setSymbol }: { symbol: string; setSymbol: (s: string) => void }) {
  const [tf, setTf] = useState<(typeof TFS)[number][0]>('15m');
  const { data: market } = usePoll<MarketRow[]>('/api/market', 60_000);
  const { data: candles } = usePoll<Candle[]>(`/api/candles/${symbol}?tf=${tf}&limit=400`, 30_000);
  const { data: analysis } = usePoll<Analysis>(`/api/analysis/${symbol}`, 30_000);
  const { data: trades } = usePoll<ClosedTradeView[]>('/api/trades?limit=2000', 60_000);
  const { data: acct } = usePoll<AccountSummary>('/api/account', 10_000);
  const { data: idea } = usePoll<TradeIdea>(`/api/ideas/${symbol}`, 30_000);
  const [layers, setLayers] = useState<ChartLayers>({ zones: true, fvg: true, profile: '24h', supertrend: true, plan: true });
  const toggle = (k: 'zones' | 'fvg' | 'supertrend' | 'plan') => setLayers((l) => ({ ...l, [k]: !l[k] }));

  const symbols = useMemo(() => [...new Set([symbol, 'BTCUSDT', ...(market ?? []).map((r) => r.symbol)])], [market, symbol]);
  const mine = useMemo(() => (trades ?? []).filter((t) => t.symbol === symbol), [trades, symbol]);
  const open = useMemo(() => (acct?.positions ?? []).filter((p) => p.symbol === symbol), [acct, symbol]);
  const zones = analysis?.zones ?? [];
  const tfMs = TFS.find((x) => x[0] === tf)![1];

  return (
    <div className="space-y-5">
      <Card
        title={<span className="flex items-center gap-2">{coin(symbol)}<span className="text-ink-3">/USDT perpetual</span></span>}
        icon={<CandlestickChart size={16} />}
        right={
          <div className="flex items-center gap-2">
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded-lg border border-line bg-card-2 px-2 py-1 text-xs">
              {symbols.map((s) => <option key={s} value={s}>{coin(s)}</option>)}
            </select>
            <div className="flex overflow-hidden rounded-lg border border-line">
              {TFS.map(([name]) => (
                <button key={name} onClick={() => setTf(name)} className={`px-2.5 py-1 text-xs ${tf === name ? 'bg-accent text-white' : 'bg-card-2 text-ink-2 hover:text-ink'}`}>{name}</button>
              ))}
            </div>
          </div>
        }
      >
        {candles?.length ? (
          <CandleChart
            candles={candles}
            overlays={{ zones: tf === '1m' ? [] : zones, fvgs: analysis?.fvgs ?? [], profiles: analysis?.profiles ?? [] }}
            trades={mine} positions={open} tfMs={tfMs} tf={tf} idea={idea} layers={layers}
          />
        ) : <div className="grid h-[520px] place-items-center text-sm text-ink-3">Loading candles…</div>}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-2">
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-accent" />EMA20</span>
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-warning" />EMA50</span>
          <Toggle on={layers.supertrend} onClick={() => toggle('supertrend')} swatch={<span className="h-0.5 w-4 bg-gradient-to-r from-good to-critical" />}>SuperTrend</Toggle>
          <Toggle on={layers.zones} onClick={() => toggle('zones')} swatch={<span className="h-3 w-4 rounded-sm border border-demand bg-demand/20" />}>supply/demand zones</Toggle>
          <Toggle on={layers.fvg} onClick={() => toggle('fvg')} swatch={<span className="h-3 w-4 rounded-sm border border-dashed border-demand bg-[repeating-linear-gradient(45deg,transparent_0_3px,var(--color-demand)_3px_4px)] opacity-80" />}>FVG · IFVG ({tf === '1m' ? 'not on 1m' : tf})</Toggle>
          <Toggle on={layers.plan} onClick={() => toggle('plan')} swatch={<span className="h-0.5 w-4 bg-accent" />}>plan &amp; key levels</Toggle>
          <label className="flex items-center gap-1.5">
            volume profile
            <select value={layers.profile ?? 'off'} onChange={(e) => setLayers((l) => ({ ...l, profile: e.target.value === 'off' ? null : e.target.value }))} className="rounded border border-line bg-card-2 px-1 py-0.5">
              {(analysis?.profiles ?? []).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              <option value="off">off</option>
            </select>
          </label>
          <span className="text-ink-3">blue = buy side · orange = sell side · solid box = zone · hatched = FVG (dotted edge = IFVG)</span>
        </div>
      </Card>

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
