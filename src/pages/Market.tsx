import { useMemo, useState } from 'react';
import { Crosshair, Search, Target } from 'lucide-react';
import { usePoll, type Armed, type MarketRow, type Scanner } from '../lib/api';
import { coin, compact, dateTime, duration, hhmm, pct, price, words } from '../lib/format';
import { Badge, Card, Empty, SideBadge, StateBadge, Table, TrendChip, td } from '../components/ui';

type SortKey = 'rank' | 'change' | 'atr' | 'volume';

export function Market({ go }: { go: (page: string, symbol?: string) => void }) {
  const { data: rows } = usePoll<MarketRow[]>('/api/market', 15_000);
  const { data: scanner } = usePoll<Scanner>('/api/scanner', 60_000);
  const { data: armed } = usePoll<Armed[]>('/api/armed', 15_000);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('rank');

  const shown = useMemo(() => {
    const list = (rows ?? []).filter((r) => r.symbol.includes(q.toUpperCase()));
    const by: Record<SortKey, (r: MarketRow) => number> = {
      rank: () => 0, change: (r) => -(r.changePct ?? 0), atr: (r) => -(r.atrPct1h ?? 0), volume: (r) => -(r.quoteVolume ?? 0),
    };
    return sort === 'rank' ? list : [...list].sort((a, b) => by[sort](a) - by[sort](b));
  }, [rows, q, sort]);

  const now = Date.now();
  return (
    <div className="space-y-5">
      <Card title={`Armed setups (${armed?.length ?? 0})`} icon={<Target size={16} />} right={<span className="text-xs text-ink-3">waiting for a 15m confirmation close</span>}>
        {!armed?.length ? <Empty>No setup is armed. A setup arms when enough factors meet at the price during a pullback.</Empty> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {armed.map((a) => (
              <button key={a.id} onClick={() => go('chart', a.symbol)} className="rounded-xl border border-line bg-card-2 p-3 text-left transition hover:border-accent">
                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold">{coin(a.symbol)}</span>
                  <SideBadge side={a.direction} />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {a.factors.map((f) => <Badge key={f.name} tone="accent" title={f.detail}>{words(f.name)}</Badge>)}
                </div>
                <p className="mt-2 text-xs text-ink-3 tabular">
                  area {price(a.areaLow)} – {price(a.areaHigh)} · armed {hhmm(a.armedAt)} · expires in {duration(a.expiresAt - now)}
                </p>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card
        title={`Scanner · ${rows?.length ?? 0} coins`}
        icon={<Crosshair size={16} />}
        right={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 rounded-lg border border-line bg-card-2 px-2 py-1 text-xs">
              <Search size={12} className="text-ink-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="find coin" className="w-24 bg-transparent outline-none placeholder:text-ink-3" />
            </label>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rounded-lg border border-line bg-card-2 px-2 py-1 text-xs">
              <option value="rank">scanner rank</option><option value="change">24h change</option><option value="atr">volatility</option><option value="volume">volume</option>
            </select>
          </div>
        }
      >
        {!shown.length ? <Empty>The scanner has not picked coins yet.</Empty> : (
          <Table head={['Coin', 'Price', '24h', '1h ATR', 'Volume', 'Trend 4h / 1h / 15m', 'Long', 'Short', 'Zones', '']}>
            {shown.map((r) => (
              <tr key={r.symbol} className="cursor-pointer hover:bg-card-2/60" onClick={() => go('chart', r.symbol)}>
                <td className={`${td} font-semibold`}>{coin(r.symbol)}</td>
                <td className={`${td} tabular`}>{price(r.price)}</td>
                <td className={`${td} tabular ${(r.changePct ?? 0) >= 0 ? 'text-good' : 'text-critical'}`}>{(r.changePct ?? 0) >= 0 ? '▲' : '▼'} {pct(r.changePct, 1, true)}</td>
                <td className={`${td} tabular text-ink-2`}>{pct(r.atrPct1h, 2)}</td>
                <td className={`${td} tabular text-ink-2`}>${compact(r.quoteVolume)}</td>
                <td className={td}><span className="flex gap-1">{(['4h', '1h', '15m'] as const).map((tf) => <TrendChip key={tf} tf={tf} trend={r.trend?.[tf]} />)}</span></td>
                <td className={td}><StateBadge state={r.long?.state} tradable={r.long?.tradable} /></td>
                <td className={td}><StateBadge state={r.short?.state} tradable={r.short?.tradable} /></td>
                <td className={`${td} tabular text-ink-2`}>{r.zones}</td>
                <td className={td}>{r.armed.map((d) => <Badge key={d} tone="london">armed {d}</Badge>)}</td>
              </tr>
            ))}
          </Table>
        )}
        {scanner?.lastScan && (
          <p className="mt-3 text-xs text-ink-3">
            Last scan {dateTime(scanner.lastScan.time)} UTC. Left out: {Object.entries(scanner.lastScan.dropped).map(([k, v]) => `${words(k)} ${v}`).join(' · ')}.
          </p>
        )}
      </Card>
    </div>
  );
}
