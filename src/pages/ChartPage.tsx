import { useMemo, useState } from 'react';
import { CandlestickChart, Layers } from 'lucide-react';
import { usePoll, type AccountSummary, type Analysis, type Candle, type ClosedTradeView, type MarketRow } from '../lib/api';
import { coin, price } from '../lib/format';
import { Badge, Card, StateBadge, TrendChip } from '../components/ui';
import { CandleChart } from '../components/charts';

const TFS = [['15m', 900_000], ['1h', 3_600_000], ['4h', 14_400_000], ['1m', 60_000]] as const;

export function ChartPage({ symbol, setSymbol }: { symbol: string; setSymbol: (s: string) => void }) {
  const [tf, setTf] = useState<(typeof TFS)[number][0]>('15m');
  const { data: market } = usePoll<MarketRow[]>('/api/market', 60_000);
  const { data: candles } = usePoll<Candle[]>(`/api/candles/${symbol}?tf=${tf}&limit=400`, 30_000);
  const { data: analysis } = usePoll<Analysis>(`/api/analysis/${symbol}`, 30_000);
  const { data: trades } = usePoll<ClosedTradeView[]>('/api/trades?limit=2000', 60_000);
  const { data: acct } = usePoll<AccountSummary>('/api/account', 10_000);

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
          <CandleChart candles={candles} zones={tf === '1m' ? [] : zones} trades={mine} positions={open} tfMs={tfMs} />
        ) : <div className="grid h-[520px] place-items-center text-sm text-ink-3">Loading candles…</div>}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-3">
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-accent" />EMA20</span>
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-warning" />EMA50</span>
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-demand" />demand zone</span>
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-supply" />supply zone</span>
          <span>solid = fresh, dashed = tested</span>
        </div>
      </Card>

      {analysis && (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card title="Trend" icon={<Layers size={16} />}>
            <div className="flex gap-2">{(['4h', '1h', '15m'] as const).map((t) => <TrendChip key={t} tf={t} trend={analysis.structure[t]?.trend} />)}</div>
            <div className="mt-3 space-y-2 text-sm">
              <p className="flex items-center justify-between">Long <StateBadge state={analysis.long.state} tradable={analysis.long.tradable} /></p>
              <p className="flex items-center justify-between">Short <StateBadge state={analysis.short.state} tradable={analysis.short.tradable} /></p>
              <p className="text-xs text-ink-3 tabular">4h close {price(analysis.ema4h.close)} · EMA50 {price(analysis.ema4h.fast)} · EMA200 {price(analysis.ema4h.slow)}</p>
            </div>
          </Card>
          <Card title="Protected levels">
            <div className="space-y-1 text-sm tabular">
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
          </Card>
          <Card title={`1h zones (${zones.length})`}>
            {!zones.length ? <p className="text-sm text-ink-3">No active supply or demand zone.</p> : (
              <ul className="space-y-1 text-sm tabular">
                {zones.map((z) => (
                  <li key={z.id} className="flex justify-between">
                    <Badge tone={z.type === 'demand' ? 'london' : 'asian'}>{z.type}</Badge>
                    <span>{price(z.low)} – {price(z.high)}</span>
                    <span className="text-ink-3">{z.status}{z.touches ? ` · ${z.touches}×` : ''}</span>
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
