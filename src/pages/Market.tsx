import { useMemo, useState } from 'react';
import { Crosshair, Eye, Search, Target, X } from 'lucide-react';
import { post, usePoll, usePrices, type Armed, type MarketRow, type Scanner } from '../lib/api';
import { coin, compact, dateTime, duration, hhmm, pct, price, words } from '../lib/format';
import { AddCoin } from '../components/AddCoin';
import { Badge, Card, Empty, MovingFastBadge, PdBadge, SideBadge, SpeedBadge, StateBadge, Table, TrendChip, td } from '../components/ui';

type SortKey = 'profit' | 'quality' | 'rr' | 'checks' | 'rank' | 'change' | 'atr' | 'volume';

const STAGE: Record<string, { tone: string; label: string }> = {
  in_trade: { tone: 'good', label: 'in trade' },
  confirmed: { tone: 'good', label: 'confirmed' },
  armed: { tone: 'london', label: 'armed' },
  in_zone: { tone: 'newyork', label: 'retest' },
  wait: { tone: 'muted', label: 'wait retest' },
  no_level: { tone: 'warning', label: 'no level' },
};

function Quality({ q }: { q: number }) {
  const color = q >= 70 ? 'var(--color-good)' : q >= 50 ? 'var(--color-warning)' : 'var(--color-ink-3)';
  return (
    <span className="flex items-center gap-2" title={`setup quality ${q}/100`}>
      <span className="h-2 w-16 rounded bg-card-2"><span className="block h-2 rounded" style={{ width: `${q}%`, background: color }} /></span>
      <span className="w-6 text-right tabular font-semibold">{q}</span>
    </span>
  );
}

export function Market({ go }: { go: (page: string, symbol?: string) => void }) {
  const { data: rows } = usePoll<MarketRow[]>('/api/market', 15_000);
  const { data: scanner } = usePoll<Scanner>('/api/scanner', 60_000);
  const { data: armed } = usePoll<Armed[]>('/api/armed', 15_000);
  const { data: watchlist, reload: reloadWatchlist } = usePoll<string[]>('/api/watchlist', 60_000);
  const remove = async (symbol: string) => {
    try { await post(`/api/watchlist/${symbol}`, undefined, 'DELETE'); reloadWatchlist(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  };
  const live = usePrices();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('profit');

  const shown = useMemo(() => {
    const list = (rows ?? []).filter((r) => r.symbol.includes(q.toUpperCase()));
    const by: Record<SortKey, (r: MarketRow) => number> = {
      rank: () => 0,
      // Signals first, then the rest; each from the largest profit to the take-profit down.
      profit: (r) => (r.setup?.meetsRules ? -1000 : 0) - (r.setup?.targetPct ?? -1),
      quality: (r) => -(r.setup?.quality ?? -1),
      rr: (r) => -(r.setup?.rr ?? -99),
      checks: (r) => -(r.setup && r.setup.checksDecided ? r.setup.checksMet / r.setup.checksDecided : -1),
      change: (r) => -(r.changePct ?? 0), atr: (r) => -(r.atrPct1h ?? 0), volume: (r) => -(r.quoteVolume ?? 0),
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
        title={`Your coins (${watchlist?.length ?? 0})`}
        icon={<Eye size={16} />}
        right={<AddCoin onAdded={(s) => { reloadWatchlist(); go('chart', s); }} />}
      >
        {!watchlist?.length ? (
          <Empty>Add any Binance USDT perpetual to get its analysis, levels and indicators, even if the scanner did not pick it.</Empty>
        ) : (
          <div className="flex flex-wrap gap-2">
            {watchlist.map((s) => (
              <span key={s} className="inline-flex items-center rounded-lg border border-line bg-card-2 text-sm">
                <button onClick={() => go('chart', s)} className="px-2.5 py-1 font-semibold hover:text-accent">{coin(s)}</button>
                <button onClick={() => void remove(s)} title={`Remove ${coin(s)}`} aria-label={`Remove ${coin(s)}`} className="border-l border-line px-1.5 py-1 text-ink-3 hover:text-critical"><X size={13} /></button>
              </span>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3">Analysis only: the engine trades a coin only when the scanner picks it. Added coins also appear in the table below, on the chart and in trade ideas.</p>
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
              <option value="profit">signals, highest profit</option><option value="quality">setup quality</option><option value="rr">reward:risk</option><option value="checks">checks met</option><option value="rank">scanner rank</option><option value="change">24h change</option><option value="atr">volatility</option><option value="volume">volume</option>
            </select>
          </div>
        }
      >
        {!shown.length ? <Empty>The scanner has not picked coins yet.</Empty> : (
          <Table head={['Coin', 'Profit to TP', 'R:R', 'Setup', 'Quality', 'Checks', 'Price', '24h', '1h ATR', 'Volume', 'Trend 4h / 1h / 15m', 'Long', 'Short', 'Zones']}>
            {shown.map((r) => (
              <tr key={r.symbol} className="cursor-pointer hover:bg-card-2/60" onClick={() => go('chart', r.symbol)}>
                <td className={td}>
                  <span className="flex items-center gap-1.5">
                    <span className="font-semibold">{coin(r.symbol)}</span>
                    <SpeedBadge speed={r.setup?.speed} />
                    <MovingFastBadge on={r.setup?.movingFast} />
                    {r.watched && !r.scanned && <Badge tone="muted" title="Added by you: analysed, not traded">yours</Badge>}
                  </span>
                </td>
                <td className={`${td} tabular font-semibold ${r.setup?.meetsRules ? 'text-good' : 'text-ink-3'}`}>
                  {r.setup?.targetPct != null ? `+${r.setup.targetPct.toFixed(2)}%` : '–'}
                  {r.setup?.meetsRules && <Badge tone="good">signal</Badge>}
                </td>
                <td className={`${td} tabular font-semibold ${r.setup?.rr == null ? 'text-ink-3' : r.setup.rr >= 2 ? 'text-good' : r.setup.rr >= 1 ? 'text-ink' : 'text-warning'}`}>
                  {r.setup?.rr != null ? `${r.setup.rr.toFixed(2)}R` : '–'}
                </td>
                <td className={td}>
                  {r.setup && r.setup.bias !== 'none' ? (
                    <span className="flex items-center gap-1">
                      <SideBadge side={r.setup.bias} />
                      <PdBadge position={r.setup.pdPosition} />
                      {r.setup.stage && (r.setup.skipped ? <Badge tone="warning">skipped</Badge> : <Badge tone={STAGE[r.setup.stage]?.tone ?? 'muted'}>{STAGE[r.setup.stage]?.label ?? r.setup.stage}</Badge>)}
                    </span>
                  ) : <span className="text-xs text-ink-3">no trend</span>}
                </td>
                <td className={td}>{r.setup ? <Quality q={r.setup.quality} /> : <span className="text-ink-3">–</span>}</td>
                <td className={`${td} tabular text-ink-2`}>{r.setup ? `${r.setup.checksMet}/${r.setup.checksDecided}` : '–'}</td>
                <td className={`${td} tabular`}>{price(live?.prices[r.symbol] ?? r.price)}</td>
                <td className={`${td} tabular ${r.changePct == null ? 'text-ink-3' : r.changePct >= 0 ? 'text-good' : 'text-critical'}`}>{r.changePct == null ? '–' : `${r.changePct >= 0 ? '▲' : '▼'} ${pct(r.changePct, 1, true)}`}</td>
                <td className={`${td} tabular text-ink-2`}>{pct(r.atrPct1h, 2)}</td>
                <td className={`${td} tabular text-ink-2`}>${compact(r.quoteVolume)}</td>
                <td className={td}><span className="flex gap-1">{(['4h', '1h', '15m'] as const).map((tf) => <TrendChip key={tf} tf={tf} trend={r.trend?.[tf]} />)}</span></td>
                <td className={td}><StateBadge state={r.long?.state} tradable={r.long?.tradable} /></td>
                <td className={td}><StateBadge state={r.short?.state} tradable={r.short?.tradable} /></td>
                <td className={`${td} tabular text-ink-2`}>{r.zones}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-ink-3">
          A signal needs its one take-profit at least 3% from the entry and at least 2R. Signals come first, from the largest profit down.
          Quality (0–100) ranks how close a coin is to a clean setup: share of the checklist met, reward:risk to the first target, how far the setup has got, and whether it fits the stop and R rules.
          It is not a win probability.
        </p>
        {scanner?.lastScan && (
          <p className="mt-3 text-xs text-ink-3">
            Last scan {dateTime(scanner.lastScan.time)} UTC. Left out: {Object.entries(scanner.lastScan.dropped).map(([k, v]) => `${words(k)} ${v}`).join(' · ')}.
          </p>
        )}
      </Card>
    </div>
  );
}
