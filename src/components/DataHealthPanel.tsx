import React, { useState } from 'react';
import { ShieldAlert, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import { AutomatedTradeRecord } from '../types/automatedFeed';
import { DataHealthReport, TradeHealth } from '../services/dataHealth';
import { netPnlUSD } from '../services/metrics';
import { FIRESTORE_WRITES_ENABLED } from '../lib/firebase';

interface DataHealthPanelProps {
  report: DataHealthReport;
  onSetExcluded: (trade: AutomatedTradeRecord, excluded: boolean) => Promise<void>;
}

const usd = (n: number) => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;
const when = (t: AutomatedTradeRecord) => {
  const ms = t.closedAtTimestamp || t.openedAtTimestamp;
  return ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
};

const Row: React.FC<{
  item: TradeHealth;
  busy: boolean;
  onToggle: (t: AutomatedTradeRecord, excluded: boolean) => void;
}> = ({ item, busy, onToggle }) => {
  const t = item.trade;
  const excluded = !!t.excludedFromStats;
  const canExclude = t.status !== 'OPEN';
  return (
    <li className={`flex flex-col gap-2 border-t border-stone-800 py-3 sm:flex-row sm:items-start sm:justify-between ${excluded ? 'opacity-60' : ''}`}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span className="font-semibold text-stone-100">{t.symbol}</span>
          <span className="text-stone-400">{t.status === 'OPEN' ? 'open' : 'closed'} {when(t)}</span>
          <span className={`font-mono ${netPnlUSD(t) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{usd(netPnlUSD(t))}</span>
          {excluded && <span className="rounded bg-stone-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-stone-300">Excluded</span>}
        </div>
        <ul className="space-y-0.5 text-xs text-stone-400">
          {item.issues.map((i) => (
            <li key={i.code} className={i.severity === 'critical' ? 'text-amber-300' : ''}>{i.message}</li>
          ))}
        </ul>
        <div className="font-mono text-[10px] text-stone-600 break-all">{t.id}</div>
      </div>
      {canExclude && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle(t, !excluded)}
          className="shrink-0 self-start rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-xs font-medium text-stone-200 hover:bg-stone-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-400 disabled:opacity-40"
        >
          {busy ? 'Saving...' : excluded ? 'Count again' : 'Exclude from stats'}
        </button>
      )}
    </li>
  );
};

/**
 * Lists trade records that cannot be right, or were not produced by the
 * market, and lets them be left out of the statistics without deleting them.
 */
export const DataHealthPanel: React.FC<DataHealthPanelProps> = ({ report, onSetExcluded }) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  const critical = report.flagged.filter((f) => f.worst === 'critical');
  const info = report.flagged.filter((f) => f.worst === 'info');

  const toggle = async (t: AutomatedTradeRecord, excluded: boolean) => {
    setBusyId(t.id);
    try { await onSetExcluded(t, excluded); } finally { setBusyId(null); }
  };

  return (
    <section aria-labelledby="data-health-title" className="mx-auto my-8 max-w-3xl rounded-2xl border border-stone-800 bg-stone-900 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        {report.criticalCounted > 0
          ? <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
          : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />}
        <div className="space-y-1">
          <h3 id="data-health-title" className="text-lg font-bold text-stone-100">Data Health</h3>
          <p className="text-sm text-stone-400">
            {report.criticalCounted > 0
              ? `${report.criticalCounted} record${report.criticalCounted === 1 ? '' : 's'} look${report.criticalCounted === 1 ? 's' : ''} impossible and ${report.criticalCounted === 1 ? 'is' : 'are'} still counted in your statistics.`
              : 'No impossible records are counted in your statistics.'}
            {report.excludedCount > 0 && ` ${report.excludedCount} excluded.`}
          </p>
          <p className="text-xs text-stone-500">
            Excluding keeps the record in your history but leaves it out of P&amp;L, win rate and every other figure.
            {!FIRESTORE_WRITES_ENABLED && ' Read-only mode: exclusions are saved in this browser only.'}
          </p>
          {report.criticalCounted > 0 && (
            <div className="pt-2">
              <button
                type="button"
                disabled={busyId !== null}
                onClick={async () => {
                  for (const item of critical) {
                    if (!item.trade.excludedFromStats) {
                      await toggle(item.trade, true);
                    }
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
              >
                Exclude All {report.criticalCounted} Impossible Records
              </button>
            </div>
          )}
        </div>
      </div>

      {critical.length > 0 && (
        <ul className="mt-4" aria-label="Records that need review">
          {critical.map((item) => (
            <Row key={item.trade.id} item={item} busy={busyId === item.trade.id} onToggle={toggle} />
          ))}
        </ul>
      )}

      {info.length > 0 && (
        <div className="mt-4 border-t border-stone-800 pt-3">
          <button
            type="button"
            onClick={() => setShowInfo((v) => !v)}
            aria-expanded={showInfo}
            className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-stone-300 hover:text-stone-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-400"
          >
            {showInfo ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
            {info.length} more record{info.length === 1 ? '' : 's'} worth knowing about
            <span className="text-stone-500">
              ({[
                report.byCode.FORCED_CLOSE && `${report.byCode.FORCED_CLOSE} closed by the old clean-up`,
                report.byCode.CORRECTED && `${report.byCode.CORRECTED} corrected`,
                report.byCode.NO_FEES && `${report.byCode.NO_FEES} without recorded fees`,
              ].filter(Boolean).join(', ')})
            </span>
          </button>
          {showInfo && (
            <ul className="mt-2">
              {info.map((item) => (
                <Row key={item.trade.id} item={item} busy={busyId === item.trade.id} onToggle={toggle} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};
