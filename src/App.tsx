// Engine status page: a stand-in until the dashboard (ENGINE_PLAN.md Phase 7).
// Reads the engine's API every 15 seconds.
import { useEffect, useState } from 'react';
import type { FeedStatus, SignalRecord } from '../shared/types';

interface Session { name: string; openTime: number; closeTime: number }
interface Status {
  engineVersion: string;
  engineClock: number;
  feed: FeedStatus;
  /** Null until the engine's first minute has closed. */
  session: { active: Session[]; owner: Session | null; entryBlock: string | null; next: Session | null } | null;
  openPositions: number;
}
interface ScanRow { symbol: string; quoteVolume: number; changePct: number; atrPct1h: number }
interface Scanner { universe: string[]; lastScan: { time: number; selected: ScanRow[]; dropped: Record<string, number> } | null }
interface Armed { id: string; symbol: string; direction: string; armedAt: number; expiresAt: number; factors: { name: string }[]; areaLow: number; areaHigh: number }

const time = (t: number | undefined) => (t ? new Date(t).toISOString().slice(11, 16) + ' UTC' : '-');
const dateTime = (t: number) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [scanner, setScanner] = useState<Scanner | null>(null);
  const [armed, setArmed] = useState<Armed[]>([]);
  const [signals, setSignals] = useState<SignalRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [st, sc, ar, si] = await Promise.all([
          get<Status>('/api/status'), get<Scanner>('/api/scanner'), get<Armed[]>('/api/armed'), get<SignalRecord[]>('/api/signals?limit=50'),
        ]);
        if (!alive) return;
        setStatus(st); setScanner(sc); setArmed(ar); setSignals(si); setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const feedOk = status?.feed.state === 'live';
  return (
    <div className="min-h-screen bg-stone-950 text-stone-200 font-mono text-sm p-4 space-y-4">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-lg font-semibold text-stone-50">Session Engine</h1>
        <span className="text-stone-400">simulation only · v{status?.engineVersion ?? '…'}</span>
        <span className={feedOk ? 'text-emerald-400' : 'text-amber-400'}>feed {status?.feed.state ?? '…'}</span>
        <span className="text-stone-400">engine clock {time(status?.engineClock)}</span>
        {error && <span className="text-red-400">{error}</span>}
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <Card title="Session">
          {status && !status.session && <p className="text-stone-500">Waiting for the first closed minute…</p>}
          {status?.session && <>
          <p>Now: {status.session.owner ? <b className="text-stone-50">{status.session.owner.name}</b> : 'outside sessions'}
            {status.session.owner && <> · closes {time(status.session.owner.closeTime)}</>}</p>
          <p>New trades: {status.session.entryBlock
            ? <span className="text-amber-400">blocked ({status.session.entryBlock})</span>
            : <span className="text-emerald-400">allowed</span>}</p>
          <p>Next: {status.session.next ? `${status.session.next.name} at ${time(status.session.next.openTime)}` : '-'}</p>
          </>}
          <p>Open positions: {status?.openPositions ?? 0} <span className="text-stone-500">(simulator arrives in Phase 5)</span></p>
        </Card>

        <Card title={`Armed setups (${armed.length})`}>
          {armed.length === 0 && <p className="text-stone-500">None waiting for 15m confirmation.</p>}
          {armed.map((a) => (
            <p key={a.id}>
              <b className="text-stone-50">{a.symbol}</b> {a.direction} · {a.factors.map((f) => f.name).join('+')} · until {time(a.expiresAt)}
            </p>
          ))}
        </Card>

        <Card title={`Scanner (${scanner?.universe.length ?? 0} coins)`}>
          <p className="text-stone-400">last scan {time(scanner?.lastScan?.time)}</p>
          <p className="leading-relaxed">{scanner?.universe.map((s) => s.replace(/USDT$/, '')).join(' ') || '-'}</p>
          {scanner?.lastScan && (
            <p className="text-stone-500">dropped: {Object.entries(scanner.lastScan.dropped).map(([k, v]) => `${k} ${v}`).join(', ')}</p>
          )}
        </Card>
      </section>

      <Card title="Recent signals">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-stone-400">
              <tr><th className="pr-4">time</th><th className="pr-4">coin</th><th className="pr-4">side</th><th className="pr-4">status</th><th>reason</th></tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id} className="border-t border-stone-800">
                  <td className="pr-4 whitespace-nowrap">{dateTime(s.time)}</td>
                  <td className="pr-4">{s.symbol}</td>
                  <td className="pr-4">{s.direction}</td>
                  <td className={`pr-4 ${s.status === 'taken' ? 'text-emerald-400' : s.status === 'filtered' ? 'text-amber-400' : ''}`}>{s.status}</td>
                  <td className="text-stone-400">{s.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {signals.length === 0 && <p className="text-stone-500">No signals yet. They appear at 15-minute closes during sessions.</p>}
        </div>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-stone-800 bg-stone-900 p-3 space-y-1">
      <h2 className="text-stone-400 uppercase tracking-wide text-xs">{title}</h2>
      {children}
    </section>
  );
}
