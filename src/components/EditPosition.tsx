// "Edit": changes an open position's stop and take-profit. Checked against the
// live price here and against Binance's mark price by the engine; the change is
// recorded in the trade log like the engine's own stop moves.
import { useEffect, useState } from 'react';
import { Pencil, X } from 'lucide-react';
import { post, usePrices } from '../lib/api';
import { coin, pct, price as fmtPrice } from '../lib/format';

export interface EditablePosition { id: string; symbol: string; side: string; entryPrice: number; stop: number; target: number | null }

/** A price as a short editable string: six significant digits. */
const short = (x: number | null) => (x === null ? '' : String(Number(x.toPrecision(6))));

export function EditPosition({ p, onSaved }: { p: EditablePosition; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:border-accent hover:text-accent">
        <Pencil size={12} />Edit
      </button>
      {open && <Dialog p={p} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved(); }} />}
    </>
  );
}

function Dialog({ p, onClose, onSaved }: { p: EditablePosition; onClose: () => void; onSaved: () => void }) {
  const live = usePrices();
  const now = live?.prices[p.symbol] ?? null;
  const [stop, setStop] = useState(short(p.stop));
  const [target, setTarget] = useState(short(p.target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const long = p.side === 'long';
  const dir = long ? 1 : -1;
  const s = Number(stop);
  const t = target.trim() ? Number(target) : null;
  const stopOk = now !== null && s > 0 && dir * (now - s) > 0;
  const targetOk = t === null || (now !== null && t > 0 && dir * (t - now) > 0);
  // Loss (or locked-in gain) at the stop, from the entry.
  const atStop = s > 0 ? (dir * (s - p.entryPrice) / p.entryPrice) * 100 : null;
  const rr = t !== null && s > 0 && dir * (p.entryPrice - s) > 0 ? Math.abs(t - p.entryPrice) / Math.abs(p.entryPrice - s) : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/positions/${encodeURIComponent(p.id)}/modify`, { stop: s, target: t });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = 'mt-1 block w-full rounded-lg border border-line bg-card-2 px-2.5 py-1.5 text-sm tabular outline-none focus:border-accent';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center whitespace-normal bg-black/60 px-4 text-left" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div role="dialog" aria-label={`Edit the ${coin(p.symbol)} position`} className="w-full min-w-0 max-w-md rounded-2xl border border-line bg-card p-5 shadow-2xl shadow-black/60" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Edit {coin(p.symbol)} {p.side}</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <p className="flex justify-between text-sm"><span className="text-ink-3">Entry · price now</span><span className="tabular font-semibold">{fmtPrice(p.entryPrice)} · {fmtPrice(now)}</span></p>
          <label className="block text-xs text-ink-3">Stop
            <input value={stop} onChange={(e) => setStop(e.target.value)} inputMode="decimal" className={`${input} ${stop && !stopOk ? 'border-critical' : ''}`} />
          </label>
          <label className="block text-xs text-ink-3">Take-profit (empty for none)
            <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" className={`${input} ${target && !targetOk ? 'border-critical' : ''}`} />
          </label>
          <p className="text-xs text-ink-3 tabular">
            {stopOk && atStop !== null && <>At the stop: {atStop >= 0 ? <span className="text-good">{pct(atStop, 2, true)} locked in</span> : <span className="text-critical">{pct(atStop, 2, true)}</span>} from the entry{rr !== null ? <> · reward:risk {rr.toFixed(2)}</> : null}. </>}
            {stop && !stopOk && <span className="text-critical">The stop must be {long ? 'below' : 'above'} the price now. </span>}
            {target && !targetOk && <span className="text-critical">The take-profit must be {long ? 'above' : 'below'} the price now. </span>}
            Both act on the live price: the position closes as soon as the price reaches either.
          </p>
          {error && <p className="rounded-lg bg-critical/10 px-3 py-2 text-sm text-critical">{error}</p>}
          <button onClick={() => void submit()} disabled={busy || !stopOk || !targetOk}
            className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
