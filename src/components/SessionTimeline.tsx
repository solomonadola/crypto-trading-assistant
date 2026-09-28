// Today's trading sessions on a 24-hour UTC strip, with a "now" marker, the
// owning session and how long until it closes.
import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { usePoll, type SessionInfo, type SessionInstance } from '../lib/api';
import { SESSION_LABEL, duration, hhmm, words } from '../lib/format';
import { Badge, Card } from './ui';

const DAY = 86_400_000;
const LANES = ['asian', 'london', 'newyork'];

export function SessionTimeline() {
  const { data } = usePoll<{ dayStart: number; sessions: SessionInstance[]; info: SessionInfo }>('/api/sessions/today', 60_000);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!data) return <Card title="Sessions" icon={<Clock size={16} />}><div className="h-28" /></Card>;

  const { dayStart, sessions } = data;
  const x = (t: number) => `${Math.min(100, Math.max(0, ((t - dayStart) / DAY) * 100))}%`;
  const active = sessions.filter((s) => s.openTime <= now && now < s.closeTime);
  const owner = active.sort((a, b) => b.openTime - a.openTime)[0] ?? null;
  const next = sessions.filter((s) => s.openTime > now).sort((a, b) => a.openTime - b.openTime)[0] ?? data.info.next;
  const block = data.info.entryBlock;

  return (
    <Card
      title="Sessions (UTC)"
      icon={<Clock size={16} />}
      right={block ? <Badge tone="warning">entries paused · {words(block)}</Badge> : <Badge tone="good">entries open</Badge>}
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3">Trades now belong to</p>
          <p className="text-xl font-semibold" style={{ color: owner ? `var(--color-${owner.name})` : undefined }}>
            {owner ? SESSION_LABEL[owner.name] ?? owner.name : 'No session'}
          </p>
        </div>
        <div className="text-right text-sm tabular">
          {owner && <p className="text-ink-2">closes in <span className="font-semibold text-ink">{duration(owner.closeTime - now)}</span> · {hhmm(owner.closeTime)}</p>}
          {next && <p className="text-ink-3">next: {SESSION_LABEL[next.name] ?? next.name} at {hhmm(next.openTime)}{!owner && <> · in {duration(next.openTime - now)}</>}</p>}
        </div>
      </div>

      <div className="relative">
        {LANES.map((lane) => (
          <div key={lane} className="relative mb-1.5 h-6 rounded-md bg-card-2">
            {sessions.filter((s) => s.name === lane).map((s) => (
              <div
                key={s.openTime}
                className="absolute inset-y-0 flex items-center rounded-md px-2 text-[11px] font-semibold text-white/95"
                style={{ left: x(s.openTime), width: `calc(${x(s.closeTime)} - ${x(s.openTime)})`, background: `var(--color-${lane})`, opacity: active.includes(s) ? 1 : 0.55 }}
                title={`${SESSION_LABEL[lane]} ${hhmm(s.openTime)}–${hhmm(s.closeTime)} UTC`}
              >
                <span className="truncate">{SESSION_LABEL[lane]} {hhmm(s.openTime)}–{hhmm(s.closeTime)}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="pointer-events-none absolute -top-1 bottom-0 w-0.5 rounded bg-ink shadow-[0_0_8px_white]" style={{ left: x(now) }} title={`now ${hhmm(now)} UTC`} />
        <div className="mt-1 flex justify-between text-[10px] text-ink-3 tabular">
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => <span key={h}>{String(h).padStart(2, '0')}</span>)}
        </div>
      </div>
    </Card>
  );
}
