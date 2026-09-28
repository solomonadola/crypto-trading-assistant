import { Fragment, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Radio, XCircle } from 'lucide-react';
import { usePoll, type SignalRecord } from '../lib/api';
import { coin, dateTime, price, words } from '../lib/format';
import { Badge, Card, Empty, SessionBadge, SideBadge, Table, td } from '../components/ui';
import { StatusBadge } from './Overview';

const FILTERS = ['all', 'taken', 'filtered', 'armed', 'expired'] as const;

interface Summary { status: string; reason: string | null; count: number }
interface FilterResult { name: string; pass: boolean; detail: Record<string, unknown> }

export function Signals({ go }: { go: (page: string, symbol?: string) => void }) {
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('all');
  const [open, setOpen] = useState<number | null>(null);
  const { data: signals } = usePoll<SignalRecord[]>(`/api/signals?limit=300${status === 'all' ? '' : `&status=${status}`}`, 15_000);
  const { data: summary } = usePoll<Summary[]>('/api/signals/summary?hours=24', 30_000);

  const byStatus = (s: string) => (summary ?? []).filter((x) => x.status === s).reduce((a, b) => a + b.count, 0);
  const reasons = (summary ?? []).filter((x) => x.status === 'filtered' || x.status === 'expired').slice(0, 8);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-4">
        {(['armed', 'expired', 'taken', 'filtered'] as const).map((s) => (
          <button key={s} onClick={() => setStatus(s)} className="rounded-2xl border border-line bg-card p-4 text-left transition hover:border-accent">
            <p className="text-xs uppercase tracking-wider text-ink-3">{s} · last 24h</p>
            <p className="mt-1 text-2xl font-semibold tabular">{byStatus(s)}</p>
          </button>
        ))}
      </div>

      {reasons.length > 0 && (
        <Card title="Why setups did not become trades (24h)">
          <div className="space-y-2">
            {reasons.map((r) => {
              const max = Math.max(...reasons.map((x) => x.count));
              return (
                <div key={`${r.status}${r.reason}`} className="flex items-center gap-3 text-sm" title={`${r.count} ${r.status}: ${words(r.reason)}`}>
                  <span className="w-48 truncate text-ink-2">{words(r.reason)}</span>
                  <div className="h-3 flex-1 rounded bg-card-2">
                    <div className="h-3 rounded" style={{ width: `${(r.count / max) * 100}%`, background: r.status === 'filtered' ? 'var(--color-warning)' : 'var(--color-ink-3)' }} />
                  </div>
                  <span className="w-10 text-right tabular text-ink-2">{r.count}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-ink-3"><span className="text-warning">■</span> filtered after confirming · <span className="text-ink-3">■</span> expired before confirming</p>
        </Card>
      )}

      <Card
        title="Signals"
        icon={<Radio size={16} />}
        right={
          <div className="flex overflow-hidden rounded-lg border border-line">
            {FILTERS.map((f) => (
              <button key={f} onClick={() => setStatus(f)} className={`px-2.5 py-1 text-xs ${status === f ? 'bg-accent text-white' : 'bg-card-2 text-ink-2 hover:text-ink'}`}>{f}</button>
            ))}
          </div>
        }
      >
        {!signals?.length ? <Empty>No signals{status === 'all' ? '' : ` with status ${status}`} yet.</Empty> : (
          <Table head={['', 'Time (UTC)', 'Coin', 'Side', 'Status', 'Reason', 'Score', 'Entry / stop / target', 'R']}>
            {signals.map((s) => {
              const p = s.payload as Record<string, any>;
              const plan = p.plan as { entry: number; stop: number; target: number; rewardRisk: number; stopDistancePct: number; targetSource: string } | undefined;
              const isOpen = open === s.id;
              return (
                <Fragment key={s.id}>
                  <tr className="cursor-pointer hover:bg-card-2/60" onClick={() => setOpen(isOpen ? null : s.id!)}>
                    <td className={`${td} text-ink-3`}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td className={`${td} tabular text-ink-2`}>{dateTime(s.time)}</td>
                    <td className={td}><button className="font-semibold hover:text-accent" onClick={(e) => { e.stopPropagation(); go('chart', s.symbol); }}>{coin(s.symbol)}</button></td>
                    <td className={td}><SideBadge side={s.direction} /></td>
                    <td className={td}><StatusBadge status={s.status} /></td>
                    <td className={`${td} text-ink-2`}>{words(s.reason) || (s.status === 'armed' ? (p.factors ?? []).map((f: { name: string }) => words(f.name)).join(' + ') : '')}</td>
                    <td className={`${td} tabular`}>{p.score?.total ?? ''}</td>
                    <td className={`${td} tabular text-ink-2`}>{plan ? `${price(plan.entry)} / ${price(plan.stop)} / ${price(plan.target)}` : ''}</td>
                    <td className={`${td} tabular`}>{plan ? plan.rewardRisk.toFixed(2) : ''}</td>
                  </tr>
                  {isOpen && (
                    <tr><td colSpan={9} className="bg-card-2/40 px-4 py-4"><SignalDetail s={s} /></td></tr>
                  )}
                </Fragment>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}

function SignalDetail({ s }: { s: SignalRecord }) {
  const p = s.payload as Record<string, any>;
  const filters = (p.filters ?? []) as FilterResult[];
  return (
    <div className="grid gap-4 text-sm lg:grid-cols-3">
      <div className="space-y-2">
        <h3 className="text-xs uppercase tracking-wider text-ink-3">Setup</h3>
        <p className="flex flex-wrap gap-1">{(p.factors ?? []).map((f: { name: string; detail: string }) => <Badge key={f.name} tone="accent" title={f.detail}>{words(f.name)}</Badge>)}</p>
        {p.trendState && <p>trend state <b>{p.trendState}</b></p>}
        {p.session !== undefined && <p>session <SessionBadge name={p.session} /></p>}
        {p.confirmation && <p>confirmed through {price(p.confirmation.level)} with {(p.confirmation.confirmations ?? []).map(words).join(', ') || 'no extra confirmation'}{p.confirmation.liquiditySweep ? ', after a liquidity sweep' : ''}</p>}
        {p.plan && <p className="tabular">stop {p.plan.stopDistancePct.toFixed(2)}% away · target from {p.plan.targetSource} · reward/risk {p.plan.rewardRisk.toFixed(2)}</p>}
        {p.risk && <p className="tabular">size {p.risk.ok ? `$${p.risk.notional.toFixed(2)}` : 'refused'}{p.risk.detail?.caps ? ` (capped by ${p.risk.detail.caps})` : ''}</p>}
      </div>
      <div className="space-y-2">
        <h3 className="text-xs uppercase tracking-wider text-ink-3">Score {p.score ? `${p.score.total}` : ''}</h3>
        {p.score ? (
          <ul className="space-y-1">{Object.entries(p.score.points as Record<string, number>).map(([k, v]) => <li key={k} className="flex justify-between"><span className="text-ink-2">{words(k)}</span><span className="tabular">+{v}</span></li>)}</ul>
        ) : <p className="text-ink-3">Scored once confirmed.</p>}
        {(p.failures ?? []).length > 0 && (
          <p className="text-warning">Failed: {(p.failures as string[]).map(words).join(', ')}</p>
        )}
      </div>
      <div className="space-y-1">
        <h3 className="text-xs uppercase tracking-wider text-ink-3">Filters</h3>
        {!filters.length ? <p className="text-ink-3">Checked once confirmed.</p> : filters.map((f) => (
          <p key={f.name} className="flex items-start gap-2" title={JSON.stringify(f.detail)}>
            {f.pass ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-good" aria-label="passed" /> : <XCircle size={14} className="mt-0.5 shrink-0 text-critical" aria-label="failed" />}
            <span className={f.pass ? 'text-ink-2' : 'text-ink'}>{words(f.name)}</span>
            <span className="ml-auto truncate text-xs text-ink-3 tabular">{Object.entries(f.detail).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
