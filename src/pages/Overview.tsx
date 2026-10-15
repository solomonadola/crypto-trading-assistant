import { Activity, Briefcase, Hourglass, LineChart, Radio, ShieldAlert, X } from 'lucide-react';
import { post, usePoll, usePrices, type AccountSummary, type ClosedTradeView, type EquityPoint, type SignalRecord } from '../lib/api';
import { coin, dateTime, duration, hhmm, pct, price, signedUsd, usd, words } from '../lib/format';
import { Badge, Card, Empty, Kpi, ModelBadge, Pnl, SessionBadge, SideBadge, Table, td } from '../components/ui';
import { SessionTimeline } from '../components/SessionTimeline';
import { EditPosition } from '../components/EditPosition';
import { EquityChart } from '../components/charts';
import { DealingRangeRadar } from '../components/DealingRangeRadar';

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'taken' || status === 'working' ? 'good' : status === 'filtered' ? 'warning' : status === 'armed' ? 'london' : 'muted';
  return <Badge tone={tone}>{status}</Badge>;
}

export function Overview({ go }: { go: (page: string, symbol?: string) => void }) {
  const { data: acct, reload } = usePoll<AccountSummary>('/api/account', 5_000);
  const { data: equity } = usePoll<EquityPoint[]>('/api/equity?hours=168', 60_000);
  const { data: trades } = usePoll<ClosedTradeView[]>('/api/trades?limit=500', 30_000);
  const { data: signals } = usePoll<SignalRecord[]>('/api/signals?limit=8', 15_000);

  const wins = trades?.filter((t) => t.pnl > 0).length ?? 0;
  const total = trades?.length ?? 0;
  const net = trades?.reduce((s, t) => s + t.pnl, 0) ?? 0;
  // Open positions at the live price (every few seconds) rather than the last closed minute.
  const live = usePrices();
  const at = (p: AccountSummary['positions'][number]) => live?.positions[p.id] ?? { price: p.price, unrealized: p.unrealized, pnlPct: p.pnlPct };
  const equityNow = acct ? acct.equity + acct.positions.reduce((s, p) => s + at(p).unrealized - p.unrealized, 0) : null;
  const ret = acct && equityNow !== null ? ((equityNow / acct.startingBalance) - 1) * 100 : 0;

  const close = async (id: string) => {
    if (!confirm('Close this position at market?')) return;
    try { await post(`/api/positions/${encodeURIComponent(id)}/close`); reload(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  };

  const cancelOrder = async (id: string) => {
    if (!confirm('Cancel this pending limit order?')) return;
    try { await post(`/api/positions/${encodeURIComponent(id)}/cancel`); reload(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="space-y-5">
      {acct?.circuitBreaker?.active && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3.5 text-sm text-warning">
          <div className="flex items-center gap-2.5">
            <ShieldAlert size={20} className="animate-pulse shrink-0 text-warning" />
            <div>
              <div className="font-semibold text-ink">BTC Flash-Crash Circuit Breaker Active</div>
              <div className="text-xs text-ink-2">
                {acct.circuitBreaker.reason || 'BTC experiencing rapid downward cascade'} · Altcoin long entries halted · Resting limits cancelled
              </div>
            </div>
          </div>
          <Badge tone="warning">Cooling down until {hhmm(acct.circuitBreaker.until)} UTC</Badge>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <div className="col-span-2">
          <Kpi label="Equity" value={usd(equityNow)} sub={acct ? <>{pct(ret, 2, true)} since start · balance {usd(acct.balance)}</> : null}
            accent="linear-gradient(90deg, var(--color-accent), var(--color-london))" tone={ret > 0.005 ? 'good' : ret < -0.005 ? 'critical' : null} />
        </div>
        <Kpi label="Today" value={acct ? signedUsd(acct.dayPnl) : '–'} tone={acct && acct.dayPnl > 0.004 ? 'good' : acct && acct.dayPnl < -0.004 ? 'critical' : null} accent="var(--color-newyork)" sub="realized + open, since 00:00 UTC" />
        <Kpi label="Drawdown" value={pct(acct?.drawdownPct ?? 0, 2)} accent="var(--color-warning)" sub={acct ? `peak ${usd(acct.peakEquity)} · kill at 15%` : null} />
        <Kpi label="Open risk" value={usd(acct?.openRisk)} accent="var(--color-asian)" sub={acct ? `${acct.positions.length} open · exposure ${usd(acct.exposure, 0)}` : null} />
        <Kpi label="Closed trades" value={total} accent="var(--color-london)" sub={total ? <>{((wins / total) * 100).toFixed(0)}% won · net {signedUsd(net)}</> : 'none yet'} />
      </div>

      <div className="grid gap-5 xl:grid-cols-5">
        <div className="xl:col-span-3"><SessionTimeline /></div>
        <Card className="xl:col-span-2" title="Latest signals" icon={<Radio size={16} />} right={<button className="text-xs text-accent hover:underline" onClick={() => go('signals')}>all signals →</button>}>
          {!signals?.length ? <Empty>No signals yet. They appear at 15-minute closes during sessions.</Empty> : (
            <ul className="space-y-2">
              {signals.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-xs text-ink-3 tabular">{hhmm(s.time)}</span>
                    <button className="font-semibold hover:text-accent" onClick={() => go('chart', s.symbol)}>{coin(s.symbol)}</button>
                    <SideBadge side={s.direction} />
                  </span>
                  <span className="flex items-center gap-2 truncate">
                    {s.reason && <span className="truncate text-xs text-ink-3">{words(s.reason)}</span>}
                    <StatusBadge status={s.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <DealingRangeRadar go={go} />

      <Card title="Equity" icon={<LineChart size={16} />} right={<span className="text-xs text-ink-3">last 7 days · 5-minute points</span>}>
        <EquityChart points={equity ?? []} startingBalance={acct?.startingBalance ?? 1000} />
      </Card>

      <Card title="Open positions" icon={<Briefcase size={16} />} right={acct?.pendingEntries.length ? <Badge tone="accent"><Activity size={12} />{acct.pendingEntries.length} limit pullback</Badge> : null}>
        {acct?.pendingEntries && acct.pendingEntries.length > 0 && (
          <div className="mb-4 rounded-xl border border-accent/30 bg-accent/5 p-3">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-accent">
              <span className="flex items-center gap-1.5"><Hourglass size={13} className="animate-pulse" /> Pending Limit Orders (Waiting for Pullback)</span>
              <span className="text-[11px] text-ink-3">Auto-cancels if target is reached first or after 4h timeout</span>
            </div>
            <div className="space-y-1.5">
              {acct.pendingEntries.map((e) => (
                <div key={e.positionId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card-2/80 px-3 py-2 text-xs border border-line">
                  <div className="flex items-center gap-2">
                    <button className="font-semibold hover:text-accent" onClick={() => go('chart', e.symbol)}>{coin(e.symbol)}</button>
                    <SideBadge side={e.side} />
                    <span className="text-ink-2 tabular">Limit: <b className="text-ink">{e.price ? price(e.price) : 'Key Level'}</b></span>
                    {e.stop && <span className="text-critical/90 tabular">Stop: {price(e.stop)}</span>}
                    {e.target && <span className="text-good/90 tabular">TP: {price(e.target)}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-ink-3">
                    <span>${e.notional.toFixed(0)}</span>
                    <span className="tabular">{duration((acct.time || Date.now()) - e.placedAt)} ago</span>
                    <Badge tone="accent">waiting pullback</Badge>
                    <span className="flex gap-1">
                      <EditPosition
                        p={{
                          id: e.positionId,
                          symbol: e.symbol,
                          side: e.side,
                          entryPrice: e.price ?? 0,
                          stop: e.stop ?? 0,
                          target: e.target ?? null,
                          isPending: true,
                        }}
                        onSaved={reload}
                      />
                      <button
                        onClick={() => cancelOrder(e.positionId)}
                        className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:border-critical hover:text-critical"
                      >
                        <X size={12} />Cancel
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!acct?.positions.length ? <Empty>No active open positions. The engine opens one when a limit order fills on pullback.</Empty> : (
          <Table head={['Coin', 'Side', 'Model', 'Entry', 'Price', 'Stop', 'Target', 'P&L', 'Session', 'Open', '']}>
            {acct.positions.map((p) => (
              <tr key={p.id} className="hover:bg-card-2/60">
                <td className={td}><button className="font-semibold hover:text-accent" onClick={() => go('chart', p.symbol)}>{coin(p.symbol)}</button></td>
                <td className={td}><SideBadge side={p.side} /></td>
                <td className={td} title={p.note ?? undefined}>
                  {p.setup ? <ModelBadge setup={p.setup} /> : <span className="text-ink-3">–</span>}
                  {p.note && <span className="block max-w-48 truncate text-xs text-ink-3">{p.note}</span>}
                </td>
                <td className={`${td} tabular`}>{price(p.entryPrice)}</td>
                <td className={`${td} tabular`}>{price(at(p).price)}</td>
                <td className={`${td} tabular text-critical/90`} title={p.ladderStep >= 0 ? `ladder step ${p.ladderStep + 1}` : 'initial stop'}>{price(p.stop)}{p.ladderStep >= 0 && <span className="ml-1 text-[10px] text-accent">L{p.ladderStep + 1}</span>}</td>
                <td className={`${td} tabular text-good/90`}>{p.target !== null && !p.partialDone ? price(p.target) : p.partialDone ? 'half taken' : 'ladder'}</td>
                <td className={td}><Pnl value={at(p).unrealized + p.realized - p.fees + p.funding} percent={at(p).pnlPct} /></td>
                <td className={td}><SessionBadge name={p.sessionName} /> <span className="text-xs text-ink-3">ends {hhmm(p.sessionClose)}</span></td>
                <td className={`${td} text-ink-2 tabular`} title={dateTime(p.openedAt)}>{duration((acct.time || Date.now()) - p.openedAt)}</td>
                <td className={td}>
                  {p.pendingClose ? <Badge tone="warning">closing · {words(p.pendingClose)}</Badge> : (
                    <span className="flex gap-1">
                      <EditPosition p={p} onSaved={reload} />
                      <button onClick={() => close(p.id)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:border-critical hover:text-critical"><X size={12} />Close</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
