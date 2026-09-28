import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FlaskRound } from 'lucide-react';
import { usePoll } from '../lib/api';
import { Badge, Card, Empty, Table, td } from '../components/ui';
import { signedUsd } from '../lib/format';

interface Metrics { trades: number; wins: number; winRate: number; netUsd: number; profitFactor: number | null; maxDrawdownUsd: number; avgR: number; tradesPerWeek: number }
interface Settings { minRr: number; maxStopPct: number; minScore: number; fakeoutRvol: number | null; filtersOff: string[] }
interface Scored { settings: Settings; train: Metrics; test: Metrics }
interface Result {
  createdAt: number; from: number; split: number; to: number; minTrainTrades: number;
  results: { variant: string; label: string; research: { trades: number; confirmed: number; seconds: number; symbols: string[] }; search: { combinations: number; configured: Scored; best: Scored[] } }[];
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const pf = (m: Metrics) => (m.profitFactor === null ? '∞' : m.profitFactor.toFixed(2));
const holds = (s: Scored) => s.test.trades >= 10 && s.test.netUsd > 0 && (s.test.profitFactor ?? 99) > 1;

function describe(s: Settings): string {
  return [
    `reward/risk ≥ ${s.minRr}`,
    `stop ≤ ${s.maxStopPct}%`,
    `score ≥ ${s.minScore}`,
    s.fakeoutRvol === null ? 'fakeout filter off' : `trigger volume ≥ ${s.fakeoutRvol}×`,
    s.filtersOff.length ? `off: ${s.filtersOff.map((f) => f.replace('filter_', '')).join(', ')}` : 'all other filters on',
  ].join(' · ');
}

function Cell({ m }: { m: Metrics }) {
  return (
    <span className="tabular">
      <span className="text-ink">{m.trades}</span> <span className="text-ink-3">trades</span>{' '}
      <span className={m.netUsd > 0 ? 'text-good' : m.netUsd < 0 ? 'text-critical' : 'text-ink-2'}>{signedUsd(m.netUsd, 0)}</span>{' '}
      <span className="text-ink-3">PF</span> {pf(m)} <span className="text-ink-3">win</span> {(m.winRate * 100).toFixed(0)}%{' '}
      <span className="text-ink-3">DD</span> ${m.maxDrawdownUsd.toFixed(0)}
    </span>
  );
}

export function Backtest() {
  const { data: files } = usePoll<string[]>('/api/backtests', 60_000);
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => { if (!file && files?.length) setFile(files[0]); }, [files, file]);
  const { data } = usePoll<Result>(file ? `/api/backtests/${encodeURIComponent(file)}` : null, 3_600_000);

  if (!files) return <Empty>Loading…</Empty>;
  if (!files.length) {
    return (
      <Card title="Backtest" icon={<FlaskRound size={16} />}>
        <p className="text-sm text-ink-2">No backtest has been run yet. Run <code className="rounded bg-card-2 px-1">npm run backtest -- --db data/backtest/spot5m.db</code> in the project folder; results appear here.</p>
      </Card>
    );
  }
  return (
    <div className="space-y-5">
      <Card title="Backtest" icon={<FlaskRound size={16} />}
        right={<select value={file ?? ''} onChange={(e) => setFile(e.target.value)} className="rounded-lg border border-line bg-card-2 px-2 py-1 text-xs">{files.map((f) => <option key={f} value={f}>{f.replace('.json', '')}</option>)}</select>}>
        {data && (
          <div className="space-y-2 text-sm text-ink-2">
            <p>
              Tuned on <b className="text-ink">{day(data.from)} → {day(data.split)}</b>, then tested once on <b className="text-ink">{day(data.split)} → {day(data.to)}</b>, which played no part in choosing.
              Only the <b className="text-ink">test</b> column is evidence: the best of thousands of combinations always looks good on the months it was picked on.
            </p>
            <p className="text-xs text-ink-3">P&L at the engine's sizing on a $1,000 balance (10% positions, at most 1% lost at the stop), no compounding, fees and slippage included; portfolio rules applied (5 open, one per coin, 2 a day per coin, 30 min cooldown after a loss).</p>
          </div>
        )}
      </Card>
      {data?.results.map((r) => (
        <Card key={r.variant} title={r.label} right={<span className="text-xs text-ink-3">{r.research.confirmed} confirmed setups · {r.research.trades} traded in research · {r.search.combinations.toLocaleString()} combinations</span>}>
          <Table head={['Settings', 'Tuning period', 'Unseen test period', '']}>
            <tr className="bg-card-2/40">
              <td className={`${td} whitespace-normal`}><Badge tone="accent">your current settings</Badge><p className="mt-1 text-xs text-ink-3">{describe(r.search.configured.settings)}</p></td>
              <td className={td}><Cell m={r.search.configured.train} /></td>
              <td className={td}><Cell m={r.search.configured.test} /></td>
              <td className={td}>{holds(r.search.configured) ? <CheckCircle2 size={16} className="text-good" aria-label="holds on test" /> : null}</td>
            </tr>
            {r.search.best.map((b, i) => (
              <tr key={i} className="hover:bg-card-2/60">
                <td className={`${td} whitespace-normal text-xs text-ink-2`}>{describe(b.settings)}</td>
                <td className={td}><Cell m={b.train} /></td>
                <td className={td}><Cell m={b.test} /></td>
                <td className={td}>{holds(b)
                  ? <span className="flex items-center gap-1 text-xs text-good"><CheckCircle2 size={14} aria-label="holds" />holds</span>
                  : <span className="flex items-center gap-1 text-xs text-warning"><AlertTriangle size={14} aria-label="does not hold" />not on test</span>}</td>
              </tr>
            ))}
          </Table>
          {!r.search.best.length && <p className="mt-2 text-sm text-warning">No combination made money on the tuning period with at least {data.minTrainTrades} trades.</p>}
        </Card>
      ))}
    </div>
  );
}
