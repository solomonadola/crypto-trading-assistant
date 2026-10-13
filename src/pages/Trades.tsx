import { useState, useMemo } from 'react';
import { Brain, History, PieChart, Sparkles } from 'lucide-react';
import { usePoll, type ClosedTradeView, type PatternFeatureStat, type PatternMemoryReport } from '../lib/api';
import { SESSION_LABEL, coin, dateTime, duration, price, signedUsd, words } from '../lib/format';
import { Card, Empty, Kpi, ModelBadge, Pnl, SessionBadge, SideBadge, SpeedBadge, Table, td } from '../components/ui';

interface Group { key: string; count: number; net: number; wins: number }

function groupBy(trades: ClosedTradeView[], key: (t: ClosedTradeView) => string): Group[] {
  const m = new Map<string, Group>();
  for (const t of trades) {
    const k = key(t);
    const g = m.get(k) ?? { key: k, count: 0, net: 0, wins: 0 };
    g.count++; g.net += t.pnl; if (t.pnl > 0) g.wins++;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** Net result per group as bars around zero: gains right in the good color, losses left in the critical color, value always printed. */
function NetBars({ groups, label, color }: { groups: Group[]; label: (k: string) => string; color?: (k: string) => string }) {
  const max = Math.max(1e-9, ...groups.map((g) => Math.abs(g.net)));
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div key={g.key} className="grid grid-cols-[8rem_1fr_6rem] items-center gap-3 text-sm" title={`${label(g.key)}: ${g.count} trades, ${g.wins} won, net ${signedUsd(g.net)}`}>
          <span className="flex items-center gap-2 truncate text-ink-2">
            {color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color(g.key) }} />}
            {label(g.key)} <span className="text-ink-3">×{g.count}</span>
          </span>
          <div className="relative h-4 rounded bg-card-2">
            <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
            <div
              className="absolute inset-y-0.5 rounded"
              style={g.net >= 0
                ? { left: '50%', width: `${(g.net / max) * 50}%`, background: 'var(--color-good)' }
                : { right: '50%', width: `${(-g.net / max) * 50}%`, background: 'var(--color-critical)' }}
            />
          </div>
          <span className={`text-right tabular ${g.net >= 0 ? 'text-good' : 'text-critical'}`}>{signedUsd(g.net)}</span>
        </div>
      ))}
    </div>
  );
}

function PatternBars({ stats }: { stats: PatternFeatureStat[] }) {
  const max = Math.max(0.4, ...stats.map((s) => Math.abs(s.expectancyR)));
  return (
    <div className="space-y-2.5">
      {stats.map((s) => (
        <div key={s.tag} className="grid grid-cols-[13rem_1fr_11rem] items-center gap-3 text-sm" title={s.advice}>
          <span className="flex items-center gap-2 truncate text-ink-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${
              s.verdict === 'strong_edge' || s.verdict === 'positive_edge'
                ? 'bg-good'
                : s.verdict === 'neutral'
                ? 'bg-ink-3'
                : 'bg-critical'
            }`} />
            <span className="truncate font-medium">{s.label}</span>
            <span className="text-xs text-ink-3">×{s.tradesCount}</span>
          </span>
          <div className="relative h-4 rounded bg-card-2">
            <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
            <div
              className="absolute inset-y-0.5 rounded"
              style={s.expectancyR >= 0
                ? { left: '50%', width: `${(s.expectancyR / max) * 50}%`, background: 'var(--color-good)' }
                : { right: '50%', width: `${(-s.expectancyR / max) * 50}%`, background: 'var(--color-critical)' }}
            />
          </div>
          <span className="text-right tabular text-xs text-ink-2">
            <b className={s.expectancyR >= 0 ? 'text-good' : 'text-critical'}>{s.expectancyR >= 0 ? '+' : ''}{s.expectancyR.toFixed(2)}R EV</b> · {s.winRatePct}% win
          </span>
        </div>
      ))}
      <div className="grid grid-cols-[13rem_1fr_11rem] text-[11px] text-ink-3">
        <span />
        <span className="flex justify-between">
          <span>−{max.toFixed(1)}R</span>
          <span>0</span>
          <span>+{max.toFixed(1)}R</span>
        </span>
        <span />
      </div>
    </div>
  );
}

const CATEGORIES = [
  ['all', 'All Features'],
  ['trend', 'Trend Alignment'],
  ['volume', 'Volume Dynamics'],
  ['zone', 'Dealing Range'],
  ['adr', 'ADR Gas Tank'],
  ['session', 'Killzone'],
] as const;

export function Trades({ go }: { go: (page: string, symbol?: string) => void }) {
  const { data: trades } = usePoll<ClosedTradeView[]>('/api/trades?limit=2000', 30_000);
  const { data: memory } = usePoll<PatternMemoryReport>('/api/pattern-memory', 30_000);
  const [cat, setCat] = useState<(typeof CATEGORIES)[number][0]>('all');

  const t = trades ?? [];
  const stats = useMemo(() => {
    const wins = t.filter((x) => x.pnl > 0);
    const losses = t.filter((x) => x.pnl <= 0);
    const gross = wins.reduce((s, x) => s + x.pnl, 0);
    const lost = -losses.reduce((s, x) => s + x.pnl, 0);
    return {
      net: gross - lost, winRate: t.length ? (wins.length / t.length) * 100 : 0,
      avgWin: wins.length ? gross / wins.length : 0, avgLoss: losses.length ? -lost / losses.length : 0,
      pf: lost > 0 ? gross / lost : null,
    };
  }, [t]);

  const patternStats = useMemo(() => {
    const raw = memory?.stats ?? [];
    if (cat === 'all') return raw;
    return raw.filter((s) => s.category === cat);
  }, [memory, cat]);

  if (!t.length) {
    return <Card title="Trade history" icon={<History size={16} />}><Empty>No closed trades yet. They appear here, with their stats, as soon as the simulator closes one.</Empty></Card>;
  }
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Net result" value={signedUsd(stats.net)} tone={stats.net > 0 ? 'good' : stats.net < 0 ? 'critical' : null} accent="var(--color-accent)" sub={`${t.length} trades`} />
        <Kpi label="Win rate" value={`${stats.winRate.toFixed(0)}%`} accent="var(--color-london)" />
        <Kpi label="Average win" value={signedUsd(stats.avgWin)} accent="var(--color-good)" />
        <Kpi label="Average loss" value={signedUsd(stats.avgLoss)} accent="var(--color-critical)" />
        <Kpi label="Profit factor" value={stats.pf === null ? '–' : stats.pf.toFixed(2)} accent="var(--color-newyork)" sub="gross won ÷ gross lost" />
      </div>

      {/* ---------------- Learned Machine Pattern Memory Card ---------------- */}
      <Card
        title="Learned Pattern Memory & Statistical Edge"
        icon={<Brain size={16} />}
        right={
          <div className="flex overflow-hidden rounded-lg border border-line">
            {CATEGORIES.map(([id, label]) => (
              <button
                key={id}
                onClick={() => setCat(id)}
                className={`px-2.5 py-1 text-xs ${cat === id ? 'bg-accent text-white font-semibold' : 'bg-card-2 text-ink-2 hover:text-ink'}`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        <p className="mb-4 max-w-3xl text-sm text-ink-2">
          Empirical Bayesian Matrix: continuously learns from historical trades and market structure characteristics.
          Positive EV patterns (<span className="text-good font-semibold">green</span>) produce long-term mathematical edge;
          negative EV patterns (<span className="text-critical font-semibold">red</span>) represent high-probability failure traps.
        </p>
        {!patternStats.length ? (
          <Empty>Loading pattern memory matrix…</Empty>
        ) : (
          <PatternBars stats={patternStats} />
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="By session" icon={<PieChart size={16} />}>
          <NetBars groups={groupBy(t, (x) => x.session ?? 'none')} label={(k) => SESSION_LABEL[k] ?? k} color={(k) => `var(--color-${k})`} />
        </Card>
        <Card title="By exit reason"><NetBars groups={groupBy(t, (x) => x.reason)} label={words} /></Card>
        <Card title="By side"><NetBars groups={groupBy(t, (x) => x.side)} label={(k) => k} /></Card>
      </div>

      <Card title="Trade history" icon={<History size={16} />}>
        <Table head={['Opened (UTC)', 'Coin', 'Side', 'Model', 'Entry', 'Exit', 'Held', 'Exit reason', 'Session', 'Net P&L']}>
          {t.map((x) => (
            <tr key={x.id} className="hover:bg-card-2/60">
              <td className={`${td} tabular text-ink-2`}>{dateTime(x.openedAt)}</td>
              <td className={td}><button className="font-semibold hover:text-accent" onClick={() => go('chart', x.symbol)}>{coin(x.symbol)}</button></td>
              <td className={td}><SideBadge side={x.side} /></td>
              <td className={td} title={x.note}>
                <span className="flex flex-wrap gap-1"><ModelBadge setup={x.setup} /><SpeedBadge speed={x.speed} /></span>
                {x.note && <span className="block max-w-48 truncate text-xs text-ink-3">{x.note}</span>}
              </td>
              <td className={`${td} tabular`}>{price(x.entryPrice)}</td>
              <td className={`${td} tabular`}>{price(x.exitPrice)}</td>
              <td className={`${td} tabular text-ink-2`}>{duration(x.closedAt - x.openedAt)}</td>
              <td className={`${td} text-ink-2`}>{words(x.reason)}</td>
              <td className={td}><SessionBadge name={x.session} /></td>
              <td className={td}><Pnl value={x.pnl} /></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
