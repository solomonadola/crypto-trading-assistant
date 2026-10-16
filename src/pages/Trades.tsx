import { useState, useMemo } from 'react';
import { BookOpen, Brain, History, PieChart, Scale, Sparkles } from 'lucide-react';
import { usePoll, type ClosedTradeView, type ForwardTestReport, type JournalEntry, type PatternFeatureStat, type PatternMemoryReport } from '../lib/api';
import { MODEL_LABEL, SESSION_LABEL, coin, dateTime, duration, price, signedUsd, words } from '../lib/format';
import { Badge, Card, Empty, Kpi, ModelBadge, Pnl, SessionBadge, SideBadge, SpeedBadge, Table, td } from '../components/ui';
import { TradeJournalModal } from '../components/TradeJournalModal';

const STRATEGY_FILTERS = [
  { id: 'all', label: 'All Strategies' },
  { id: 'htf_poi', label: 'Institutional (4H POI)' },
  { id: 'scalp', label: 'Hunter' },
  { id: 'manual', label: 'Manual Trades' },
] as const;
type StrategyFilterId = (typeof STRATEGY_FILTERS)[number]['id'];

function ForwardTestPanel({ data }: { data: ForwardTestReport | null }) {
  if (!data) return null;
  const { benchmark, live } = data;
  const isAwaiting = live.status === 'awaiting_signals';
  const progressText = `${live.tradesCount} / ${benchmark.targetTrades} trades (${live.progressPct}%)`;

  return (
    <Card
      title="Forward-Test Monitor: Backtest Benchmark vs Live Paper (Step 4)"
      icon={<Scale size={16} />}
      right={
        <div className="flex items-center gap-2">
          <ModelBadge setup="htf_poi" />
          <Badge
            tone={
              live.status === 'edge_confirmed'
                ? 'good'
                : live.status === 'divergence_warning'
                ? 'critical'
                : live.status === 'accumulating_sample'
                ? 'london'
                : 'muted'
            }
          >
            {live.status === 'edge_confirmed'
              ? 'Edge Validated'
              : live.status === 'divergence_warning'
              ? 'Divergence Warning'
              : live.status === 'accumulating_sample'
              ? 'Accumulating Sample'
              : 'Awaiting Signals'}
          </Badge>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Progress bar towards 50-trade statistical checkpoint */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-semibold text-ink">
              Forward-Test Progress towards Statistical Significance (50 Trades)
            </span>
            <span className="tabular text-ink-2 font-medium">{progressText}</span>
          </div>
          <div className="relative h-2.5 w-full rounded-full bg-card-2 overflow-hidden border border-line">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.max(2, live.progressPct)}%`,
                background:
                  live.status === 'divergence_warning'
                    ? 'var(--color-critical)'
                    : 'linear-gradient(90deg, var(--color-london), var(--color-good))',
              }}
            />
          </div>
          <p className="mt-1 text-[11px] text-ink-3">
            Per ROADMAP Step 4: live expectancy is benchmarked over ~50 closed trades across London & NY sessions before real capital deployment.
          </p>
        </div>

        {/* Side-by-side comparison table */}
        <div className="overflow-x-auto rounded-xl border border-line bg-card-2/40">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line bg-card-2/80 text-ink-3 font-medium">
                <th className="px-3.5 py-2.5">Key Metric</th>
                <th className="px-3.5 py-2.5">6-Month Backtest Target (OOS)</th>
                <th className="px-3.5 py-2.5">Live Forward-Test (Paper)</th>
                <th className="px-3.5 py-2.5">Evaluation Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              <tr>
                <td className="px-3.5 py-2 font-medium text-ink">Win Rate</td>
                <td className="px-3.5 py-2 tabular text-ink-2">
                  <b className="text-ink">{benchmark.winRatePct}%</b> (53.3% blended / 62.5% OOS)
                </td>
                <td className="px-3.5 py-2 tabular">
                  {isAwaiting ? <span className="text-ink-3">Calibrating…</span> : <b className={live.winRatePct >= 50 ? 'text-good' : 'text-critical'}>{live.winRatePct}%</b>}
                </td>
                <td className="px-3.5 py-2">
                  {isAwaiting ? (
                    <Badge tone="muted">Sampling</Badge>
                  ) : live.winRatePct >= 45 ? (
                    <Badge tone="good">On Track</Badge>
                  ) : (
                    <Badge tone="warning">Below Target</Badge>
                  )}
                </td>
              </tr>
              <tr>
                <td className="px-3.5 py-2 font-medium text-ink">Expectancy (Average R)</td>
                <td className="px-3.5 py-2 tabular text-ink-2">
                  <b className="text-good">+{benchmark.avgR}R</b> (+0.62R in OOS)
                </td>
                <td className="px-3.5 py-2 tabular">
                  {isAwaiting ? <span className="text-ink-3">Calibrating…</span> : <b className={live.avgR >= 0 ? 'text-good' : 'text-critical'}>{live.avgR >= 0 ? '+' : ''}{live.avgR}R</b>}
                </td>
                <td className="px-3.5 py-2">
                  {isAwaiting ? (
                    <Badge tone="muted">Sampling</Badge>
                  ) : live.avgR >= 0.2 ? (
                    <Badge tone="good">Positive Edge</Badge>
                  ) : (
                    <Badge tone="critical">Negative Drift</Badge>
                  )}
                </td>
              </tr>
              <tr>
                <td className="px-3.5 py-2 font-medium text-ink">Profit Factor</td>
                <td className="px-3.5 py-2 tabular text-ink-2">
                  <b className="text-ink">{benchmark.profitFactor}</b> (Gross Win / Gross Loss)
                </td>
                <td className="px-3.5 py-2 tabular">
                  {isAwaiting ? <span className="text-ink-3">Calibrating…</span> : <b className={live.profitFactor >= 1.5 ? 'text-good' : 'text-critical'}>{live.profitFactor.toFixed(2)}</b>}
                </td>
                <td className="px-3.5 py-2">
                  {isAwaiting ? (
                    <Badge tone="muted">Sampling</Badge>
                  ) : live.profitFactor >= 1.5 ? (
                    <Badge tone="good">Healthy</Badge>
                  ) : (
                    <Badge tone="warning">Sub-optimal</Badge>
                  )}
                </td>
              </tr>
              <tr>
                <td className="px-3.5 py-2 font-medium text-ink">Max Drawdown</td>
                <td className="px-3.5 py-2 tabular text-ink-2">
                  <b className="text-ink">&le; {benchmark.maxDrawdownPct}%</b> (Kill Switch @ 15.0%)
                </td>
                <td className="px-3.5 py-2 tabular">
                  <b className={live.maxDrawdownPct < 5 ? 'text-good' : 'text-critical'}>{live.maxDrawdownPct}%</b>
                </td>
                <td className="px-3.5 py-2">
                  {live.maxDrawdownPct < 5 ? <Badge tone="good">Safe (&lt; 5%)</Badge> : <Badge tone="critical">Elevated</Badge>}
                </td>
              </tr>
              <tr>
                <td className="px-3.5 py-2 font-medium text-ink">Average Hold Duration</td>
                <td className="px-3.5 py-2 tabular text-ink-2">
                  ~6.8 hours (408m)
                </td>
                <td className="px-3.5 py-2 tabular">
                  {isAwaiting ? <span className="text-ink-3">Calibrating…</span> : duration(live.avgHoldMin * 60_000)}
                </td>
                <td className="px-3.5 py-2">
                  <Badge tone="muted">Day / Swing</Badge>
                </td>
              </tr>
              <tr>
                <td className="px-3.5 py-2 font-medium text-ink">Trading Windows</td>
                <td className="px-3.5 py-2 text-ink-2">
                  London (08:00–10:00) & NY (09:30–11:30)
                </td>
                <td className="px-3.5 py-2">
                  Enforced (15m opening delay)
                </td>
                <td className="px-3.5 py-2">
                  <Badge tone="london">Killzones Only</Badge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Institutional Rules & Quotation */}
        <div className="grid gap-3 pt-1 md:grid-cols-2">
          <div className="rounded-xl border border-line bg-card-2/60 p-3 text-xs">
            <p className="font-semibold text-accent mb-1.5 flex items-center gap-1.5">
              Institutional Framework (SMC / Dealing Range)
            </p>
            <ul className="space-y-1 text-ink-2">
              {benchmark.rules.map((rule, idx) => (
                <li key={idx} className="flex items-start gap-1.5">
                  <span className="text-good font-bold">✓</span>
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-line bg-card-2/60 p-3 text-xs flex flex-col justify-center">
            <p className="italic text-ink-2">
              "Discipline is doing nothing when nothing is there. The hardest skill in trading is not execution — it’s restraint. No setup means no trade."
            </p>
            <p className="mt-2 text-right text-[11px] font-medium text-ink-3">
              — Ace Trades Academy (ATA) · Level 5 HTF Dealing Range Rule
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

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
            <span className="text-xs text-ink-3" title={`${s.tradesCount} of your trades; ${s.assumedPct}% of this estimate is the built-in starting assumption`}>×{s.tradesCount}</span>
            {s.assumedPct >= 50 && <span className="text-[10px] uppercase text-warning" title="Few real trades yet: this is mostly the built-in starting assumption">assumed</span>}
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
  const { data: journalEntries, reload: reloadJournal } = usePoll<JournalEntry[]>('/api/journal', 30_000);
  const { data: memory } = usePoll<PatternMemoryReport>('/api/pattern-memory', 30_000);
  const { data: forwardTest } = usePoll<ForwardTestReport>('/api/forward-test', 15_000);
  const [cat, setCat] = useState<(typeof CATEGORIES)[number][0]>('all');
  const [strategyFilter, setStrategyFilter] = useState<StrategyFilterId>('all');
  const [selectedTrade, setSelectedTrade] = useState<ClosedTradeView | null>(null);

  const journalMap = useMemo(() => new Map((journalEntries ?? []).map((j) => [j.tradeId, j])), [journalEntries]);

  const t = trades ?? [];
  const activeTrades = useMemo(() => {
    if (strategyFilter === 'all') return t;
    return t.filter((x) => (x.setup ?? 'manual') === strategyFilter);
  }, [t, strategyFilter]);

  const stats = useMemo(() => {
    const wins = activeTrades.filter((x) => x.pnl > 0);
    const losses = activeTrades.filter((x) => x.pnl <= 0);
    const gross = wins.reduce((s, x) => s + x.pnl, 0);
    const lost = -losses.reduce((s, x) => s + x.pnl, 0);
    return {
      net: gross - lost, winRate: activeTrades.length ? (wins.length / activeTrades.length) * 100 : 0,
      avgWin: wins.length ? gross / wins.length : 0, avgLoss: losses.length ? -lost / losses.length : 0,
      pf: lost > 0 ? gross / lost : null,
      total: activeTrades.length,
    };
  }, [activeTrades]);

  const patternStats = useMemo(() => {
    const raw = memory?.stats ?? [];
    if (cat === 'all') return raw;
    return raw.filter((s) => s.category === cat);
  }, [memory, cat]);

  if (!t.length) {
    return (
      <div className="space-y-5">
        <ForwardTestPanel data={forwardTest} />
        <Card title="Trade history" icon={<History size={16} />}>
          <Empty>No closed trades yet in current history. The engine is armed for institutional 4H POI Longs confirmed on 15m CHoCH during London & NY Killzones.</Empty>
        </Card>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <ForwardTestPanel data={forwardTest} />

      {/* Strategy Selector Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider mr-1">Filter Strategy:</span>
          {STRATEGY_FILTERS.map((f) => {
            const count = f.id === 'all' ? t.length : t.filter((x) => (x.setup ?? 'manual') === f.id).length;
            return (
              <button
                key={f.id}
                onClick={() => setStrategyFilter(f.id)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  strategyFilter === f.id
                    ? 'bg-accent text-white shadow-sm'
                    : 'bg-card-2 text-ink-2 hover:text-ink hover:bg-card-2/80'
                }`}
              >
                <span>{f.label}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${strategyFilter === f.id ? 'bg-white/20 text-white' : 'bg-card text-ink-3'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        {strategyFilter !== 'all' && (
          <span className="text-xs text-ink-3">
            Showing KPI & History for: <b className="text-accent">{STRATEGY_FILTERS.find((f) => f.id === strategyFilter)?.label}</b>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Net result" value={signedUsd(stats.net)} tone={stats.net > 0 ? 'good' : stats.net < 0 ? 'critical' : null} accent="var(--color-accent)" sub={`${stats.total} trades`} />
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
          Each condition starts from a built-in assumption about how it trades and moves toward your own results as
          closed trades come in. Rows marked <span className="font-semibold text-warning">assumed</span> are still mostly that
          starting assumption, not evidence. Positive EV (<span className="text-good font-semibold">green</span>) or
          negative EV (<span className="text-critical font-semibold">red</span>) only becomes meaningful with dozens of trades per row.
        </p>
        {!patternStats.length ? (
          <Empty>Loading pattern memory matrix…</Empty>
        ) : (
          <PatternBars stats={patternStats} />
        )}
      </Card>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="By strategy" icon={<PieChart size={16} />}>
          <NetBars
            groups={groupBy(t, (x) => x.setup ?? 'manual')}
            label={(k) => MODEL_LABEL[k] ?? words(k)}
            color={(k) => (k === 'htf_poi' ? 'var(--color-london)' : k === 'scalp' ? 'var(--color-accent)' : 'var(--color-good)')}
          />
        </Card>
        <Card title="By session" icon={<PieChart size={16} />}>
          <NetBars groups={groupBy(t, (x) => x.session ?? 'none')} label={(k) => SESSION_LABEL[k] ?? k} color={(k) => `var(--color-${k})`} />
        </Card>
        <Card title="By exit reason"><NetBars groups={groupBy(t, (x) => x.reason)} label={words} /></Card>
        <Card title="By side"><NetBars groups={groupBy(t, (x) => x.side)} label={(k) => k} /></Card>
      </div>

      <Card title={`Trade history (${activeTrades.length} ${strategyFilter === 'all' ? 'trades' : STRATEGY_FILTERS.find((f) => f.id === strategyFilter)?.label})`} icon={<History size={16} />}>
        {!activeTrades.length ? (
          <Empty>No closed trades found matching "{STRATEGY_FILTERS.find((f) => f.id === strategyFilter)?.label}".</Empty>
        ) : (
          <Table head={['Opened (UTC)', 'Coin', 'Side', 'Model', 'Entry', 'Exit', 'Held', 'Exit reason', 'Session', 'Net P&L', 'Journal']}>
            {activeTrades.map((x) => {
              const j = journalMap.get(x.id);
              return (
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
                  <td className={td}>
                    <button
                      onClick={() => setSelectedTrade(x)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition ${
                        j
                          ? 'border-accent/40 bg-accent/10 text-accent font-semibold hover:bg-accent/20'
                          : 'border-line text-ink-3 hover:border-ink-3 hover:text-ink'
                      }`}
                      title={j ? `Journaled · Rating: ${j.rating}★` : 'Click to journal and record ATA reflection'}
                    >
                      <BookOpen size={12} />
                      {j ? (
                        <span className="flex items-center gap-1">
                          <span>Review</span>
                          {j.rating > 0 && <span className="text-warning font-bold">★{j.rating}</span>}
                        </span>
                      ) : (
                        <span>Journal</span>
                      )}
                    </button>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      {selectedTrade && (
        <TradeJournalModal
          trade={selectedTrade}
          initialEntry={journalMap.get(selectedTrade.id)}
          onClose={() => setSelectedTrade(null)}
          onSaved={() => reloadJournal()}
        />
      )}
    </div>
  );
}
