// Small building blocks shared by every page.
import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { MODEL_LABEL, SESSION_LABEL, signedUsd, pct } from '../lib/format';

export function Card({ title, icon, right, children, className = '' }: { title?: ReactNode; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-card/90 shadow-lg shadow-black/20 ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {icon && <span className="text-accent">{icon}</span>}
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A headline number with a label and an optional colored accent bar. */
export function Kpi({ label, value, sub, accent = 'var(--color-accent)', tone }: { label: string; value: ReactNode; sub?: ReactNode; accent?: string; tone?: 'good' | 'critical' | null }) {
  const color = tone === 'good' ? 'text-good' : tone === 'critical' ? 'text-critical' : 'text-ink';
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-card p-4">
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: accent }} />
      <p className="text-xs font-medium uppercase tracking-wider text-ink-3">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular ${color}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-2 tabular">{sub}</p>}
    </div>
  );
}

/** Profit or loss: sign, arrow and color together, so it never relies on color alone. */
export function Pnl({ value, percent, className = '' }: { value: number; percent?: number; className?: string }) {
  const up = value > 0.004;
  const down = value < -0.004;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  return (
    <span className={`inline-flex items-center gap-0.5 font-medium tabular ${up ? 'text-good' : down ? 'text-critical' : 'text-ink-2'} ${className}`}>
      <Icon size={14} aria-hidden />
      {signedUsd(value)}
      {percent !== undefined && <span className="ml-1 text-xs opacity-80">({pct(percent, 2, true)})</span>}
    </span>
  );
}

const TONES: Record<string, string> = {
  good: 'bg-good/15 text-good ring-good/30',
  critical: 'bg-critical/15 text-critical ring-critical/30',
  warning: 'bg-warning/15 text-warning ring-warning/30',
  accent: 'bg-accent/15 text-accent ring-accent/30',
  london: 'bg-london/15 text-london ring-london/30',
  asian: 'bg-asian/15 text-asian ring-asian/30',
  newyork: 'bg-newyork/15 text-newyork ring-newyork/30',
  muted: 'bg-ink-3/10 text-ink-2 ring-ink-3/20',
};

export function Badge({ tone = 'muted', children, title }: { tone?: keyof typeof TONES | string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone] ?? TONES.muted}`}>
      {children}
    </span>
  );
}

export function SessionBadge({ name }: { name: string | null | undefined }) {
  if (!name) return <Badge>no session</Badge>;
  return <Badge tone={name}>{SESSION_LABEL[name] ?? name}</Badge>;
}

export function SideBadge({ side }: { side: string }) {
  return side === 'long'
    ? <Badge tone="good"><ArrowUpRight size={12} aria-hidden />Long</Badge>
    : <Badge tone="critical"><ArrowDownRight size={12} aria-hidden />Short</Badge>;
}

/** up/down/none trend on one timeframe. */
export function TrendChip({ tf, trend }: { tf: string; trend: string | null | undefined }) {
  const tone = trend === 'up' ? 'text-good' : trend === 'down' ? 'text-critical' : 'text-ink-3';
  const mark = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '•';
  return (
    <span className={`inline-flex items-center gap-1 rounded-md bg-card-2 px-1.5 py-0.5 text-[11px] tabular ${tone}`} title={`${tf}: ${trend ?? 'no data'}`}>
      <span className="text-ink-3">{tf}</span>{mark}
    </span>
  );
}

const STATE_TONE: Record<string, string> = { strong: 'good', pullback: 'accent', weakening: 'warning', transition: 'warning', reversed: 'critical', none: 'muted' };
export function StateBadge({ state, tradable }: { state: string | null | undefined; tradable?: boolean }) {
  return <Badge tone={STATE_TONE[state ?? 'none'] ?? 'muted'} title={tradable ? 'tradable now' : 'not tradable'}>{state ?? '–'}{tradable ? ' ✓' : ''}</Badge>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-3">{children}</p>;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wider text-ink-3">
            {head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">{children}</tbody>
      </table>
    </div>
  );
}

export const td = 'whitespace-nowrap px-3 py-2.5';

export function ModelBadge({ setup }: { setup: string | null | undefined }) {
  if (!setup) return null;
  return <Badge tone="accent">{MODEL_LABEL[setup] ?? setup}</Badge>;
}

/** The coin's speed group; wild coins stand out (half risk, 24 h max hold). */
export function SpeedBadge({ speed }: { speed: string | null | undefined }) {
  if (!speed) return null;
  return <Badge tone={speed === 'wild' ? 'warning' : 'muted'} title={`speed group: ${speed} (1h ATR as % of price)`}>{speed}</Badge>;
}

/** Where price sits in the 4h dealing range: discount (longs), premium (shorts), or equilibrium (neither). */
export function PdBadge({ position }: { position: number | null | undefined }) {
  if (position === null || position === undefined) return null;
  const pctText = `${Math.round(position * 100)}%`;
  if (position <= 0.48) return <Badge tone="london" title="lower half of the 4h range: longs allowed">discount {pctText}</Badge>;
  if (position >= 0.52) return <Badge tone="asian" title="upper half of the 4h range: shorts allowed">premium {pctText}</Badge>;
  return <Badge title="middle of the 4h range: no trades">equilibrium</Badge>;
}

export function MovingFastBadge({ on }: { on: boolean | undefined }) {
  return on ? <Badge tone="critical" title="last 15m candle at least 3x its usual size: don't chase">moving fast</Badge> : null;
}
