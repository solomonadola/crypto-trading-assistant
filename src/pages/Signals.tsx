import { Fragment, useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Radio, XCircle } from 'lucide-react';
import { usePoll, type SignalRecord } from '../lib/api';
import { coin, dateTime, liquidityName, pct, price, words } from '../lib/format';
import type { TradeIdea } from '../../shared/types';
import { IfBroken } from './ChartPage';
import { Badge, Card, Empty, ModelBadge, SessionBadge, SideBadge, SpeedBadge, Table, td } from '../components/ui';
import { StatusBadge } from './Overview';

const FILTERS = ['all', 'taken', 'filtered', 'armed', 'expired'] as const;

interface Summary { status: string; reason: string | null; count: number }
interface FilterResult { name: string; pass: boolean; detail: Record<string, unknown> }

interface Plan { entry: number; stop: number; target: number; rewardRisk: number; stopDistancePct: number; targetSource: string }

/** One setup from arming to its outcome: the engine records "armed", then "taken", "filtered" or "expired" for it. */
interface Setup {
  key: string; symbol: string; direction: 'long' | 'short';
  records: SignalRecord[];      // oldest first
  last: SignalRecord;           // the latest stage: armed, taken, filtered or expired
  confirmedAt: number | null;
  working: SignalRecord | null; // first moved 1R our way
  outcome: SignalRecord | null; // reached the take-profit, the stop or the session end
  latest: number;               // newest record of any kind
  plan: Plan | null;
  estimate: boolean;            // the plan is the estimate made when it armed
  score: number | null;
  model: string;                // zone_sweep, session_sweep, pullback
  speed: string | null;
}

function toSetups(signals: SignalRecord[]): Setup[] {
  const by = new Map<string, SignalRecord[]>();
  for (const s of signals) {
    const key = String((s.payload as Record<string, unknown>).armedId ?? `id${s.id}`);
    by.set(key, [...(by.get(key) ?? []), s]);
  }
  return [...by.entries()].map(([key, rs]) => {
    const records = [...rs].sort((a, b) => a.time - b.time || (a.id ?? 0) - (b.id ?? 0));
    const stages = records.filter((r) => r.status !== 'working' && r.status !== 'outcome');
    const last = stages[stages.length - 1] ?? records[records.length - 1];
    const confirmed = records.find((r) => r.status === 'taken' || r.status === 'filtered');
    const p = (confirmed?.payload ?? {}) as Record<string, any>;
    const armed = records.find((r) => r.status === 'armed')?.payload as Record<string, any> | undefined;
    const plan = (p.plan ?? armed?.planEstimate ?? null) as Plan | null;
    return {
      key, symbol: last.symbol, direction: last.direction, records, last, plan, estimate: !p.plan && !!plan, score: p.score?.total ?? null,
      confirmedAt: confirmed?.time ?? null,
      working: records.find((r) => r.status === 'working') ?? null,
      outcome: records.find((r) => r.status === 'outcome') ?? null,
      latest: records[records.length - 1].time,
      model: String(p.model ?? last.setup),
      speed: (p.speed ?? null) as string | null,
    };
  }).sort((a, b) => b.latest - a.latest);
}

const STAGE: Record<string, { tone: string; label: string }> = {
  armed: { tone: 'london', label: 'waiting for confirmation' },
  taken: { tone: 'good', label: 'confirmed · taken' },
  filtered: { tone: 'warning', label: 'confirmed · skipped' },
  expired: { tone: 'muted', label: 'expired' },
};

/** Why it is at this stage: the failed rule or expiry reason, else the factors that armed it. */
const SWEEP_WORDS: Record<string, string> = { inducement: 'the inducement', zone_wick: 'a wick through the zone' };

function reasonOf(s: Setup): string {
  if (s.last.reason) return words(s.last.reason);
  // v3 models: what was swept, and where the take-profit is.
  const p = (s.records.find((r) => r.status === 'taken' || r.status === 'filtered')?.payload ?? {}) as Record<string, any>;
  const swept = p.swept?.name ?? p.sweep;
  if (swept) return `swept ${SWEEP_WORDS[swept] ?? liquidityName(swept)}${p.target ? ` · take-profit at the ${liquidityName(p.target.name).toLowerCase()}` : ''}`;
  const armed = s.records.find((r) => r.status === 'armed')?.payload as Record<string, any> | undefined;
  const factors = ((armed?.factors ?? (s.last.payload as Record<string, any>).factors ?? []) as { name: string }[]).map((f) => words(f.name)).join(' + ');
  return s.last.status === 'taken' ? `passed all checks${factors ? ` · ${factors}` : ''}` : factors;
}

function Reason({ s }: { s: Setup }) {
  const tone = s.last.status === 'filtered' ? 'text-warning' : s.last.status === 'taken' ? 'text-good' : 'text-ink-2';
  return <td className={`${td} whitespace-normal text-xs ${tone}`}>{reasonOf(s)}</td>;
}

const OUTCOME: Record<string, { tone: string; label: string }> = {
  target: { tone: 'text-good', label: 'take-profit hit' },
  stop: { tone: 'text-critical', label: 'stopped out' },
  session_end: { tone: 'text-ink-2', label: 'closed at session end' },
  max_hold: { tone: 'text-ink-2', label: 'closed at the max hold' },
};

/** When it confirmed. */
function ConfirmedCell({ s }: { s: Setup }) {
  return (
    <td className={`${td} tabular`}>
      {s.confirmedAt ? dateTime(s.confirmedAt) : <span className="text-xs text-ink-3">not yet</span>}
    </td>
  );
}

/** After confirming: when it started going our way (1R in favour), and how it ended. */
function ProgressCell({ s }: { s: Setup }) {
  if (!s.confirmedAt) return <td className={`${td} text-ink-3`}>–</td>;
  const o = s.outcome?.payload as { outcome: string; r: number } | undefined;
  const oc = o ? OUTCOME[o.outcome] ?? { tone: 'text-ink-2', label: words(o.outcome) } : null;
  return (
    <td className={`${td} whitespace-normal text-xs`}>
      {s.working ? <p className="text-good">going our way since {dateTime(s.working.time)}</p> : !o && <p className="text-ink-3">not 1R in favour yet</p>}
      {o && oc && <p className={oc.tone}>{oc.label} {dateTime(s.outcome!.time)} · <span className="tabular font-semibold">{o.r >= 0 ? '+' : ''}{o.r.toFixed(2)}R</span></p>}
    </td>
  );
}

function Stage({ s }: { s: Setup }) {
  const st = STAGE[s.last.status] ?? { tone: 'muted', label: s.last.status };
  return <Badge tone={st.tone}>{st.label}</Badge>;
}

function PlanCells({ s }: { s: Setup }) {
  const est = s.estimate ? 'italic text-ink-3' : '';
  return (
    <>
      <td className={`${td} tabular`}>{s.score ?? <span className="text-ink-3" title="scored at the confirmation close">–</span>}</td>
      <td className={`${td} tabular ${est}`} title={s.estimate ? 'estimate made when it armed; the real plan is set at confirmation' : undefined}>{s.plan ? price(s.plan.entry) : ''}</td>
      <td className={`${td} tabular text-critical ${s.estimate ? 'italic' : ''}`}>{s.plan ? <>{price(s.plan.stop)} <span className="text-xs text-ink-3">{s.plan.stopDistancePct.toFixed(2)}%</span></> : ''}</td>
      <td className={`${td} tabular text-good ${s.estimate ? 'italic' : ''}`}>{s.plan ? price(s.plan.target) : ''}</td>
      <td className={`${td} tabular font-semibold ${est}`}>{s.plan ? `${s.plan.rewardRisk.toFixed(2)}R` : ''}{s.estimate && <span className="ml-1 text-[10px] font-normal">est.</span>}</td>
    </>
  );
}

export function Signals({ go }: { go: (page: string, symbol?: string) => void }) {
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('all');
  const [open, setOpen] = useState<string | null>(null);
  const { data: signals } = usePoll<SignalRecord[]>('/api/signals?limit=1000', 15_000);
  const { data: summary } = usePoll<Summary[]>('/api/signals/summary?hours=24', 30_000);

  const byStatus = (s: string) => (summary ?? []).filter((x) => x.status === s).reduce((a, b) => a + b.count, 0);
  const reasons = (summary ?? []).filter((x) => x.status === 'filtered' || x.status === 'expired').slice(0, 8);

  // One row per coin: its newest setup, with the rest underneath.
  const setups = toSetups(signals ?? []).filter((s) => status === 'all' || s.last.status === status);
  const coins = new Map<string, Setup[]>();
  for (const s of setups) coins.set(s.symbol, [...(coins.get(s.symbol) ?? []), s]);

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

      <ResultsCard />

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
        title="Signals by coin"
        icon={<Radio size={16} />}
        right={
          <div className="flex overflow-hidden rounded-lg border border-line">
            {FILTERS.map((f) => (
              <button key={f} onClick={() => setStatus(f)} className={`px-2.5 py-1 text-xs ${status === f ? 'bg-accent text-white' : 'bg-card-2 text-ink-2 hover:text-ink'}`}>{f}</button>
            ))}
          </div>
        }
      >
        {!coins.size ? <Empty>No signals{status === 'all' ? '' : ` with status ${status}`} yet.</Empty> : (
          <Table head={['', 'Coin', 'Side', 'Model', 'Stage', 'Reason', 'Confirmed (UTC)', 'Since then', 'Score', 'Entry', 'Stop', 'Target', 'R', '']}>
            {[...coins.entries()].map(([symbol, list]) => {
              const s = list[0];
              const isOpen = open === symbol;
              return (
                <Fragment key={symbol}>
                  <tr className="cursor-pointer hover:bg-card-2/60" onClick={() => setOpen(isOpen ? null : symbol)}>
                    <td className={`${td} text-ink-3`}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td className={td}><button className="font-semibold hover:text-accent" onClick={(e) => { e.stopPropagation(); go('chart', symbol); }}>{coin(symbol)}</button></td>
                    <td className={td}><SideBadge side={s.direction} /></td>
                <td className={td}><span className="flex flex-wrap gap-1"><ModelBadge setup={s.model} /><SpeedBadge speed={s.speed} /></span></td>
                    <td className={td}><span className="flex flex-wrap gap-1"><ModelBadge setup={s.model} /><SpeedBadge speed={s.speed} /></span></td>
                    <td className={td}><Stage s={s} /></td>
                    <Reason s={s} />
                    <ConfirmedCell s={s} />
                    <ProgressCell s={s} />
                    <PlanCells s={s} />
                    <td className={`${td} text-xs text-ink-3`}>{list.length > 1 ? `+${list.length - 1} earlier` : ''}</td>
                  </tr>
                  {isOpen && (
                    <tr><td colSpan={14} className="bg-card-2/40 px-4 py-4"><CoinDetail symbol={symbol} setups={list} /></td></tr>
                  )}
                </Fragment>
              );
            })}
          </Table>
        )}
        <p className="mt-2 text-xs text-ink-3">Grey italic prices are estimates from when the setup armed; the real entry, stop and target are set at the 15m confirmation close, when it is also scored.</p>
      </Card>
    </div>
  );
}

/** A coin's setups, newest first, the latest opened; and where price goes next if it breaks its key levels. */
function CoinDetail({ symbol, setups }: { symbol: string; setups: Setup[] }) {
  const [shown, setShown] = useState(setups[0].key);
  const { data: idea } = usePoll<TradeIdea>(`/api/ideas/${symbol}`, 60_000);
  const current = setups.find((s) => s.key === shown) ?? setups[0];
  const detail = [...current.records].reverse().find((r) => r.status === 'taken' || r.status === 'filtered' || r.status === 'armed') ?? current.last;
  const breaks = (idea?.watch ?? []).filter((w) => w.ifBroken?.length);
  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-2 text-xs">
        {current.records.map((r, i) => (
          <li key={r.id ?? i} className="flex items-center gap-2">
            {i > 0 && <span className="text-ink-3">→</span>}
            <StatusBadge status={r.status} />
            <span className="tabular text-ink-3">{dateTime(r.time)}</span>
            {r.reason && <span className="text-ink-2">{words(r.reason)}</span>}
          </li>
        ))}
      </ol>
      <SignalDetail s={detail} />
      {breaks.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs uppercase tracking-wider text-ink-3">If it breaks: next key levels and targets (now {price(idea!.price)})</h3>
          <ul className="grid gap-2 md:grid-cols-2">
            {breaks.map((w) => (
              <li key={`${w.kind}${w.price}`} className="rounded-lg bg-card px-3 py-2">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-semibold">{w.label}</span>
                  <span className="tabular">{price(w.price)} <span className="text-xs text-ink-3">{pct(w.distancePct, 1, true)}</span></span>
                </div>
                <IfBroken w={w} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {setups.length > 1 && (
        <div>
          <h3 className="mb-1 text-xs uppercase tracking-wider text-ink-3">All setups on {coin(symbol)}</h3>
          <Table head={['Side', 'Model', 'Stage', 'Reason', 'Confirmed (UTC)', 'Since then', 'Score', 'Entry', 'Stop', 'Target', 'R']}>
            {setups.map((s) => (
              <tr key={s.key} onClick={() => setShown(s.key)} className={`cursor-pointer ${s.key === current.key ? 'bg-card-2' : 'hover:bg-card-2/60'}`}>
                <td className={td}><SideBadge side={s.direction} /></td>
                <td className={td}><Stage s={s} /></td>
                <Reason s={s} />
                <ConfirmedCell s={s} />
                    <ProgressCell s={s} />
                <PlanCells s={s} />
              </tr>
            ))}
          </Table>
        </div>
      )}
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
        {!p.plan && p.planEstimate && <p className="tabular text-ink-3">if it confirmed now: entry {price(p.planEstimate.entry)}, stop {price(p.planEstimate.stop)} ({p.planEstimate.stopDistancePct.toFixed(2)}%), target {price(p.planEstimate.target)}, {p.planEstimate.rewardRisk.toFixed(2)}R</p>}
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

interface ResultLine { key: string; trades: number; wins: number; winRate: number; avgR: number; totalR: number }
interface Results { since: number; trades: Summary3; followed: Summary3; skipped: Summary3 }
interface Summary3 { all: ResultLine; byModel: ResultLine[]; bySpeed: ResultLine[] }

function ResultCell({ l }: { l: ResultLine | undefined }) {
  if (!l || !l.trades) return <span className="text-ink-3">–</span>;
  return (
    <span className="tabular">
      <span className="text-ink">{l.trades}</span> <span className="text-ink-3">·</span> {(l.winRate * 100).toFixed(0)}% <span className="text-ink-3">won ·</span>{' '}
      <span className={l.avgR > 0 ? 'text-good' : l.avgR < 0 ? 'text-critical' : 'text-ink-2'}>{l.avgR >= 0 ? '+' : ''}{l.avgR.toFixed(2)}R</span> <span className="text-ink-3">avg ·</span>{' '}
      <span className={l.totalR > 0 ? 'text-good' : l.totalR < 0 ? 'text-critical' : 'text-ink-2'}>{l.totalR >= 0 ? '+' : ''}{l.totalR.toFixed(1)}R</span>
    </span>
  );
}

/** The scorecard (ENGINE_PLAN.md Section 18.7): the engine's closed trades, and every confirmed signal followed to its end. */
function ResultsCard() {
  const [days, setDays] = useState(30);
  const { data } = usePoll<Results>(`/api/results?days=${days}`, 60_000);
  const keys = (pick: (x: Summary3) => ResultLine[]) => data ? [...new Set([...pick(data.trades), ...pick(data.followed)].map((l) => l.key))] : [];
  const row = (label: ReactNode, key: string, pick: (x: Summary3) => ResultLine[]) => (
    <tr key={key} className="hover:bg-card-2/60">
      <td className={td}>{label}</td>
      <td className={td}><ResultCell l={data ? pick(data.trades).find((l) => l.key === key) : undefined} /></td>
      <td className={td}><ResultCell l={data ? pick(data.followed).find((l) => l.key === key) : undefined} /></td>
      <td className={td}><ResultCell l={data ? pick(data.skipped).find((l) => l.key === key) : undefined} /></td>
    </tr>
  );
  return (
    <Card
      title="Results by model and speed"
      right={
        <div className="flex overflow-hidden rounded-lg border border-line">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`px-2.5 py-1 text-xs ${days === d ? 'bg-accent text-white' : 'bg-card-2 text-ink-2 hover:text-ink'}`}>{d} days</button>
          ))}
        </div>
      }
    >
      {!data ? <Empty>Loading…</Empty> : !data.followed.all.trades && !data.trades.all.trades ? (
        <Empty>No results yet. Each confirmed signal is followed to its stop, take-profit or max hold; results appear here as they finish.</Empty>
      ) : (
        <Table head={['', 'Engine trades', 'All confirmed signals, followed', 'Skipped ones, followed']}>
          {row(<b>All</b>, 'all', (x) => [x.all])}
          {keys((x) => x.byModel).map((k) => row(<ModelBadge setup={k} />, k, (x) => x.byModel))}
          {keys((x) => x.bySpeed).map((k) => row(<span className="text-xs text-ink-2">speed: <SpeedBadge speed={k} /></span>, `speed-${k}`, (x) => x.bySpeed.map((l) => ({ ...l, key: `speed-${l.key}` }))))}
        </Table>
      )}
      <p className="mt-2 text-xs text-ink-3">
        Count · win rate · average R · total R. "Engine trades" are the virtual trades it actually took. "Followed" tracks every confirmed
        signal's plan to its stop, take-profit or max hold, including those a rule skipped, so you can see whether the rules help.
        Results need a few weeks before they mean much.
      </p>
    </Card>
  );
}
