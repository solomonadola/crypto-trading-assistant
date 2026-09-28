import { FlaskConical } from 'lucide-react';
import { usePoll, type ShadowResult, type ShadowStats } from '../lib/api';
import { coin, dateTime, price, words } from '../lib/format';
import { Badge, Card, Empty, SideBadge, Table, td } from '../components/ui';

/**
 * Shadow trades: every confirmed signal followed to its stop, target or
 * session end, grouped by the check that filtered it. Average R per group on
 * a diverging scale around zero (blue above, red below, gray at zero).
 */
export function FilterLab({ go }: { go: (page: string, symbol?: string) => void }) {
  const { data } = usePoll<{ stats: ShadowStats[]; recent: ShadowResult[] }>('/api/shadows?hours=720&limit=200', 60_000);
  const stats = data?.stats ?? [];
  const max = Math.max(0.5, ...stats.map((s) => Math.abs(s.avgR)));

  return (
    <div className="space-y-5">
      <Card title="What each filter saves or costs" icon={<FlaskConical size={16} />} right={<span className="text-xs text-ink-3">last 30 days</span>}>
        <p className="mb-4 max-w-3xl text-sm text-ink-2">
          Every confirmed signal is also followed as if it had been traded exactly as planned, to its stop, first target or the end of its
          session, with fees and slippage. Grouped by the check that stopped it. A filter whose blocked trades average <b className="text-ink">below 0R</b> is
          protecting you; one whose blocked trades average <b className="text-ink">above 0R</b> is blocking winners. Small counts mean little.
        </p>
        {!stats.length ? <Empty>No shadow trades have finished yet. They start after the first confirmed signal.</Empty> : (
          <div className="space-y-2.5">
            {stats.map((s) => (
              <div key={s.group} className="grid grid-cols-[12rem_1fr_11rem] items-center gap-3 text-sm"
                title={`${words(s.group)}: ${s.count} signals, ${(s.winRate * 100).toFixed(0)}% reached a gain, average ${s.avgR.toFixed(2)}R, total ${s.totalR.toFixed(1)}R`}>
                <span className="flex items-center gap-2 truncate">
                  {s.group === 'taken' ? <Badge tone="good">taken</Badge> : <span className="text-ink-2">{words(s.group)}</span>}
                  <span className="text-xs text-ink-3">×{s.count}</span>
                </span>
                <div className="relative h-5 rounded bg-card-2">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-ink-3/60" />
                  <div className="absolute inset-y-1 rounded"
                    style={s.avgR >= 0
                      ? { left: '50%', width: `${(s.avgR / max) * 50}%`, background: 'var(--color-london)' }
                      : { right: '50%', width: `${(-s.avgR / max) * 50}%`, background: 'var(--color-critical)' }} />
                </div>
                <span className="text-right tabular text-ink-2">
                  <b className="text-ink">{s.avgR >= 0 ? '+' : '−'}{Math.abs(s.avgR).toFixed(2)}R</b> avg · {(s.winRate * 100).toFixed(0)}% won
                </span>
              </div>
            ))}
            <div className="grid grid-cols-[12rem_1fr_11rem] text-[11px] text-ink-3"><span /><span className="flex justify-between"><span>−{max.toFixed(1)}R</span><span>0</span><span>+{max.toFixed(1)}R</span></span><span /></div>
          </div>
        )}
      </Card>

      <Card title="Recent shadow trades">
        {!data?.recent.length ? <Empty>None yet.</Empty> : (
          <Table head={['Signal (UTC)', 'Coin', 'Side', 'Stopped by', 'Entry', 'Exit', 'Outcome', 'R']}>
            {data.recent.map((r) => (
              <tr key={r.id} className="hover:bg-card-2/60">
                <td className={`${td} tabular text-ink-2`}>{dateTime(r.signalTime)}</td>
                <td className={td}><button className="font-semibold hover:text-accent" onClick={() => go('chart', r.symbol)}>{coin(r.symbol)}</button></td>
                <td className={td}><SideBadge side={r.direction} /></td>
                <td className={`${td} text-ink-2`}>{r.signalStatus === 'taken' ? <Badge tone="good">taken</Badge> : words(r.signalReason)}</td>
                <td className={`${td} tabular`}>{price(r.entry)}</td>
                <td className={`${td} tabular`}>{price(r.exit)}</td>
                <td className={`${td} text-ink-2`}>{words(r.outcome)}</td>
                <td className={`${td} tabular font-medium ${r.r >= 0 ? 'text-good' : 'text-critical'}`}>{r.r >= 0 ? '+' : '−'}{Math.abs(r.r).toFixed(2)}R</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
