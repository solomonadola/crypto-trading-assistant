// The suggested plan and key levels for one coin. Advisory: it is not what the
// engine trades on (that needs the full pullback setup, filters and risk rules).
import { AlertTriangle, CheckCircle2, Compass } from 'lucide-react';
import type { TradeIdea } from '../../shared/types';
import { price as fmt, pct } from '../lib/format';
import { Badge, Card, SideBadge, TrendChip } from './ui';

const STATUS: Record<string, { tone: string; label: string }> = {
  in_trade: { tone: 'good', label: 'confirmed · in trade' },
  confirmed: { tone: 'good', label: 'confirmed' },
  armed: { tone: 'london', label: 'armed · waiting for confirmation' },
  in_zone: { tone: 'newyork', label: 'retest · waiting for confirmation' },
  wait: { tone: 'muted', label: 'waiting for retest' },
  no_level: { tone: 'warning', label: 'no entry level' },
};

export function PlanStatus({ idea }: { idea: TradeIdea }) {
  if (!idea.plan) return <Badge>no trend · wait</Badge>;
  const c = idea.plan.confirmation;
  if (idea.plan.status === 'confirmed' && c && !c.taken) return <Badge tone="warning" title={c.reason ?? undefined}>confirmed · skipped</Badge>;
  const s = STATUS[idea.plan.status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Retest → confirmation → confirmed, with the current step highlighted. */
export function StageTracker({ plan }: { plan: NonNullable<TradeIdea['plan']> }) {
  if (plan.status === 'no_level') return null;
  const step = plan.status === 'wait' ? 0 : plan.status === 'in_zone' || plan.status === 'armed' ? 1 : 2;
  const skipped = plan.confirmation && !plan.confirmation.taken;
  const steps = [
    { label: step === 0 ? 'Waiting for retest' : 'Retest', hint: 'price back in the entry area' },
    { label: step === 1 ? 'Waiting for confirmation' : 'Confirmation', hint: plan.status === 'armed' ? 'armed: next 15m close decides' : '15m close back in the trend' },
    { label: plan.status === 'in_trade' ? 'Confirmed · in trade' : skipped ? 'Confirmed · skipped' : 'Confirmed', hint: skipped ? (plan.confirmation!.reason ?? '').replace(/_/g, ' ') : plan.confirmation ? `at ${new Date(plan.confirmation.time).toISOString().slice(11, 16)} UTC` : 'entry at market' },
  ];
  return (
    <ol className="grid grid-cols-3 gap-1" aria-label="setup stage">
      {steps.map((st, i) => {
        const done = i < step || (i === 2 && step === 2);
        const current = i === step;
        const tone = i === 2 && done ? (skipped ? 'border-warning text-warning' : 'border-good text-good')
          : current ? 'border-accent text-accent' : done ? 'border-good/60 text-good' : 'border-line text-ink-3';
        return (
          <li key={i} className={`rounded-lg border-2 px-2 py-1.5 ${tone} ${current ? 'bg-card-2' : ''}`} aria-current={current ? 'step' : undefined}>
            <p className="flex items-center gap-1 text-xs font-semibold">
              {done ? <CheckCircle2 size={12} aria-hidden /> : <span className={`h-2 w-2 rounded-full ${current ? 'animate-pulse bg-accent' : 'bg-line'}`} aria-hidden />}
              {st.label}
            </p>
            <p className="truncate text-[11px] text-ink-3">{st.hint}</p>
          </li>
        );
      })}
    </ol>
  );
}

export function TradePlanCard({ idea, compact = false }: { idea: TradeIdea; compact?: boolean }) {
  const plan = idea.plan;
  return (
    <Card
      title={compact ? undefined : 'Trade plan'}
      icon={compact ? undefined : <Compass size={16} />}
      right={compact ? undefined : <PlanStatus idea={idea} />}
      className="h-full"
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {idea.bias === 'none' ? <Badge>no bias</Badge> : <SideBadge side={idea.bias} />}
          {(['4h', '1h', '15m'] as const).map((tf) => <TrendChip key={tf} tf={tf} trend={idea.trend[tf]} />)}
          {compact && <PlanStatus idea={idea} />}
          {compact && idea.checklist && (() => {
            const met = idea.checklist.filter((c) => c.ok === true).length;
            const decided = idea.checklist.filter((c) => c.ok !== null).length;
            return <Badge tone={met === decided ? 'good' : met >= decided - 2 ? 'warning' : 'muted'} title={`checklist for a ${idea.checklistFor}`}>{met}/{decided} checks</Badge>;
          })()}
        </div>
        <p className="text-ink-2">{idea.biasReason}.</p>
        {plan && <StageTracker plan={plan} />}

        {plan && plan.entry !== null && plan.stop !== null && plan.entryLow !== null && plan.entryHigh !== null ? (
          <>
            <div className="grid grid-cols-3 gap-2 tabular">
              <Level label="Entry area" value={`${fmt(plan.entryLow)} – ${fmt(plan.entryHigh)}`} sub={`mid ${fmt(plan.entry)}`} tone="accent" />
              <Level label="Stop" value={fmt(plan.stop)} sub={`${pct(plan.riskPct, 2)} risk`} tone="critical" />
              <Level label="Now" value={fmt(idea.price)} sub={`1h ATR ${fmt(idea.atr1h)}`} />
            </div>
            <div className="space-y-1">
              {plan.targets.map((t) => (
                <div key={t.label} className="flex items-center justify-between gap-2 rounded-lg bg-card-2 px-3 py-1.5" title={t.sources.join(', ')}>
                  <span className="font-semibold text-good">{t.label}</span>
                  <span className="tabular">{fmt(t.price)} {plan.targetPct !== null && <span className={`text-xs ${plan.targetPct >= 3 ? 'text-good' : 'text-warning'}`}>+{plan.targetPct.toFixed(2)}%</span>}</span>
                  <span className="truncate text-xs text-ink-3">{t.sources.slice(0, 2).join(' · ')}</span>
                  <span className={`tabular font-semibold ${t.r >= 2 ? 'text-good' : t.r >= 1 ? 'text-ink' : 'text-warning'}`}>{t.r.toFixed(2)}R</span>
                </div>
              ))}
            </div>
            <p className={`flex items-start gap-1.5 text-xs ${plan.meetsRules ? 'text-ink-2' : 'text-warning'}`}>
              {plan.meetsRules ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-good" aria-label="fits the rules" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-label="breaks a rule" />}
              {plan.note}
            </p>
          </>
        ) : plan ? (
          <p className="text-xs text-warning">{plan.note}</p>
        ) : (
          <p className="text-xs text-ink-3">No plan while neither side has a trend. Key levels below still show where price may react.</p>
        )}

        {!compact && (
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wider text-ink-3">Key levels: 5 nearest above and below</h3>
            <ul className="space-y-1">
              {[
                ...idea.levels.filter((l) => l.kind === 'resistance').sort((x, y) => x.price - y.price).slice(0, 5).reverse(),
                ...idea.levels.filter((l) => l.kind === 'support').sort((x, y) => y.price - x.price).slice(0, 5),
              ].map((l) => (
                <li key={l.price} className="flex items-center gap-2 text-xs" title={l.sources.join(', ')}>
                  <span className={`w-16 font-medium ${l.kind === 'support' ? 'text-demand' : 'text-supply'}`}>{l.kind}</span>
                  <span className="w-24 tabular">{fmt(l.price)}</span>
                  <span className="w-14 tabular text-ink-3">{pct(l.distancePct, 1, true)}</span>
                  <span className="flex gap-0.5" aria-label={`strength ${l.strength}`}>
                    {Array.from({ length: Math.min(6, l.strength) }, (_, i) => <span key={i} className={`h-2 w-1.5 rounded-sm ${l.kind === 'support' ? 'bg-demand' : 'bg-supply'}`} />)}
                  </span>
                  <span className="truncate text-ink-3">{l.sources.join(' · ')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[11px] text-ink-3">Suggested from the analysis, for reading the chart. Not financial advice; the engine only trades setups that pass all its rules.</p>
      </div>
    </Card>
  );
}

function Level({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'accent' | 'critical' }) {
  const color = tone === 'accent' ? 'text-accent' : tone === 'critical' ? 'text-critical' : 'text-ink';
  return (
    <div className="rounded-lg bg-card-2 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wider text-ink-3">{label}</p>
      <p className={`font-semibold ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-ink-3">{sub}</p>}
    </div>
  );
}
