// Scalp setups on 5m across the listed coins: what is in play now, and how
// each kind of setup has done over the last 24 hours after costs.
import { useMemo, useState } from 'react';
import { BarChart3, Timer } from 'lucide-react';
import { usePoll, usePrices, type ScalpSetup, type ScalpStats } from '../lib/api';
import { SCALP_LABEL } from '../../engine/src/analysis/scalp';
import { coin, duration, hhmm, pct, price } from '../lib/format';
import { Badge, Card, Empty, SideBadge, Table, td } from '../components/ui';
import { TakePosition } from '../components/TakePosition';

interface ScalpResponse { hours: number; costPct: number; setups: ScalpSetup[]; stats: ScalpStats[] }

const STATUS: Record<ScalpSetup['status'], { tone: string; label: string }> = {
  open: { tone: 'accent', label: 'in play' },
  target: { tone: 'good', label: 'hit target' },
  stop: { tone: 'critical', label: 'stopped' },
  expired: { tone: 'muted', label: 'expired' },
};
const KINDS = Object.keys(SCALP_LABEL) as ScalpSetup['kind'][];
const R = (r: number | null) => (r === null ? '–' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);
const rTone = (r: number | null) => (r === null ? 'text-ink-3' : r > 0 ? 'text-good' : r < 0 ? 'text-critical' : 'text-ink-2');

export function Scalp({ go }: { go: (page: string, symbol?: string, tf?: string) => void }) {
  const { data } = usePoll<ScalpResponse>('/api/scalp', 30_000);
  const live = usePrices();
  const [kind, setKind] = useState<'all' | ScalpSetup['kind']>('all');
  const [side, setSide] = useState<'all' | 'long' | 'short'>('all');
  const [trendOnly, setTrendOnly] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);

  const shown = useMemo(() => (data?.setups ?? []).filter((s) =>
    (kind === 'all' || s.kind === kind) && (side === 'all' || s.side === side) && (!trendOnly || s.withTrend) && (!openOnly || s.status === 'open')), [data, kind, side, trendOnly, openOnly]);

  const now = Date.now();
  const select = 'rounded-lg border border-line bg-card-2 px-2 py-1 text-xs';
  return (
    <div className="space-y-5">
      <Card
        title={`Scalp setups · ${shown.length}`}
        icon={<Timer size={16} />}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-line">
              {([[true, 'in play'], [false, `last ${data?.hours ?? 24}h`]] as const).map(([v, label]) => (
                <button key={label} onClick={() => setOpenOnly(v)} className={`px-2.5 py-1 text-xs ${openOnly === v ? 'bg-accent text-white' : 'bg-card-2 text-ink-2 hover:text-ink'}`}>{label}</button>
              ))}
            </div>
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={select} aria-label="Setup">
              <option value="all">all setups</option>
              {KINDS.map((k) => <option key={k} value={k}>{SCALP_LABEL[k]}</option>)}
            </select>
            <select value={side} onChange={(e) => setSide(e.target.value as typeof side)} className={select} aria-label="Side">
              <option value="all">long and short</option><option value="long">long</option><option value="short">short</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" checked={trendOnly} onChange={(e) => setTrendOnly(e.target.checked)} className="accent-[var(--color-accent)]" />with the 1h trend
            </label>
          </div>
        }
      >
        {!data ? <Empty>Loading…</Empty> : !shown.length ? (
          <Empty>{openOnly ? 'No scalp setup is in play right now. Switch to the last 24 hours to see the ones that have played out.' : 'No setup matches these filters.'}</Empty>
        ) : (
          <Table head={['Coin', 'Setup', 'Side', 'Signal', 'Entry', 'Stop', 'Target', 'Now', 'Status', 'Result', '1h trend', '']}>
            {shown.map((s) => {
              const p = live?.prices[s.symbol] ?? null;
              const move = p === null ? null : ((s.side === 'long' ? p - s.entry : s.entry - p) / Math.abs(s.entry - s.stop));
              return (
                <tr key={`${s.symbol}${s.kind}${s.side}${s.time}`} className="cursor-pointer hover:bg-card-2/60" onClick={() => go('chart', s.symbol, '5m')} title={s.why}>
                  <td className={`${td} font-semibold`}>{coin(s.symbol)}</td>
                  <td className={td}>
                    <span className="block">{SCALP_LABEL[s.kind]}</span>
                    <span className="block max-w-72 truncate text-xs text-ink-3">{s.why}</span>
                  </td>
                  <td className={td}><SideBadge side={s.side} /></td>
                  <td className={`${td} tabular text-ink-2`}>{hhmm(s.time + 300_000)} UTC<span className="block text-xs text-ink-3">{duration(now - s.time - 300_000)} ago</span></td>
                  <td className={`${td} tabular`}>{price(s.entry)}</td>
                  <td className={`${td} tabular text-critical`}>{price(s.stop)}</td>
                  <td className={`${td} tabular text-good`}>{price(s.target)}<span className="block text-xs text-ink-3">{pct(s.targetPct, 2, true)}</span></td>
                  <td className={`${td} tabular`}>
                    {price(p)}
                    {s.status === 'open' && move !== null && <span className={`block text-xs ${rTone(move)}`}>{R(move)} from entry</span>}
                  </td>
                  <td className={td}><Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge></td>
                  <td className={`${td} tabular font-semibold ${rTone(s.resultR)}`}>{R(s.resultR)}</td>
                  <td className={td}>{s.withTrend ? <Badge tone="good">with</Badge> : <span className="text-xs text-ink-3">no</span>}</td>
                  <td className={td}>
                    {s.status === 'open' && (
                      <TakePosition symbol={s.symbol} compact label="Take"
                        defaults={{ side: s.side, stop: s.stop, target: s.target, note: `Scalp: ${SCALP_LABEL[s.kind]} (${hhmm(s.time + 300_000)} UTC)` }} />
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        <p className="mt-3 max-w-4xl text-xs text-ink-3">
          Found on closed 5m candles of the scanner's coins and your coins. Entry at the signal candle's close, stop beyond the structure that made the setup,
          target at 2R. Costs of {pct(data?.costPct ?? 0.2, 2)} of price for the round trip (fees and slippage, both fills) are taken off every result, and stops closer
          than three times the costs are skipped. A setup closes at its stop or target, whichever price touches first (the stop when both are in one candle),
          or at the market after 4 hours. Click a row to see it on the 5m chart. The engine does not trade these by itself: press Take to open one as a simulated trade at the mark price, tracked as Manual.
        </p>
      </Card>

      <Card title={`How they have played out · last ${data?.hours ?? 24}h`} icon={<BarChart3 size={16} />} right={<span className="text-xs text-ink-3">after costs · a few dozen setups say little: give it days</span>}>
        {!data ? <Empty>Loading…</Empty> : (
          <Table head={['Setup', 'Setups', 'Closed', 'Won', 'Lost', 'Expired', 'Win rate', 'Average', 'Total']}>
            {data.stats.map((x) => (
              <tr key={x.kind} className={x.kind === 'all' ? 'border-t-2 border-line font-semibold' : ''}>
                <td className={td}>{x.kind === 'all' ? 'All setups' : SCALP_LABEL[x.kind]}</td>
                <td className={`${td} tabular`}>{x.count}</td>
                <td className={`${td} tabular`}>{x.closed}</td>
                <td className={`${td} tabular text-good`}>{x.wins}</td>
                <td className={`${td} tabular text-critical`}>{x.losses}</td>
                <td className={`${td} tabular text-ink-3`}>{x.expired}</td>
                <td className={`${td} tabular`}>{x.winRate === null ? '–' : `${Math.round(x.winRate * 100)}%`}</td>
                <td className={`${td} tabular ${rTone(x.avgR)}`}>{R(x.avgR)}</td>
                <td className={`${td} tabular ${rTone(x.closed ? x.totalR : null)}`}>{x.closed ? R(x.totalR) : '–'}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-ink-3">
          Won and lost count closed setups by whether they ended above or below zero after costs (an expired one can be either). With a 2R target, a setup kind
          needs to win 33% to 44% of the time to break even, depending on how big the costs are next to its stop.
        </p>
      </Card>
    </div>
  );
}
