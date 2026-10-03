// "Take position": opens a simulated trade by hand at Binance's mark price,
// sized and limited by the engine's usual risk rules, and tracked like any
// other trade (Overview, Trades, results by model as "Manual").
import { useEffect, useState } from 'react';
import { PlayCircle, X } from 'lucide-react';
import { post, usePrices } from '../lib/api';
import { coin, pct, price as fmtPrice } from '../lib/format';

export interface TakeDefaults { side: 'long' | 'short'; stop: number | null; target: number | null; note: string }

interface Filled { price: number; qty: number; notional: number; stop: number; target: number | null }

/** A price as a short editable string: six significant digits. */
const short = (x: number | null) => (x === null ? '' : String(Number(x.toPrecision(6))));

/** A button that opens the dialog; `defaults` fill it in (from a scalp setup or a trade plan). */
export function TakePosition({ symbol, defaults, label = 'Take position', compact = false }: { symbol: string; defaults: TakeDefaults; label?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={`inline-flex items-center gap-1 rounded-lg bg-good/15 font-semibold text-good ring-1 ring-good/40 hover:bg-good/25 ${compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs'}`}
      >
        <PlayCircle size={compact ? 12 : 13} />{label}
      </button>
      {open && <Dialog symbol={symbol} defaults={defaults} onClose={() => setOpen(false)} />}
    </>
  );
}

function Dialog({ symbol, defaults, onClose }: { symbol: string; defaults: TakeDefaults; onClose: () => void }) {
  const live = usePrices();
  const now = live?.prices[symbol] ?? null;
  const [side, setSide] = useState(defaults.side);
  const [stop, setStop] = useState(short(defaults.stop));
  const [target, setTarget] = useState(short(defaults.target));
  const [note, setNote] = useState(defaults.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filled, setFilled] = useState<Filled | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const s = Number(stop);
  const t = target.trim() ? Number(target) : null;
  const dir = side === 'long' ? 1 : -1;
  const stopOk = now !== null && s > 0 && dir * (now - s) > 0;
  const targetOk = t === null || (now !== null && t > 0 && dir * (t - now) > 0);
  const stopPct = stopOk ? (Math.abs(now! - s) / now!) * 100 : null;
  const rr = stopOk && t !== null && targetOk ? Math.abs(t - now!) / Math.abs(now! - s) : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ fill: Filled & { notional: number } }>('/api/positions/open', { symbol, side, stop: s, target: t, note: note.trim() || undefined });
      setFilled(r.fill);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = 'mt-1 block w-full rounded-lg border border-line bg-card-2 px-2.5 py-1.5 text-sm tabular outline-none focus:border-accent';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center whitespace-normal bg-black/60 px-4 text-left" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div role="dialog" aria-label={`Take a position in ${coin(symbol)}`} className="w-full min-w-0 max-w-md rounded-2xl border border-line bg-card p-5 shadow-2xl shadow-black/60" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Take a position · {coin(symbol)}</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink"><X size={16} /></button>
        </div>

        {filled ? (
          <div className="space-y-3 text-sm">
            <p className="font-semibold text-good">Filled {side} at {fmtPrice(filled.price)}</p>
            <p className="text-ink-2 tabular">Size {filled.qty} {coin(symbol)} (${filled.notional.toFixed(2)}) · stop {fmtPrice(filled.stop)} · target {filled.target === null ? 'none' : fmtPrice(filled.target)}</p>
            <p className="text-xs text-ink-3">It is on the Overview with the other open positions, managed like the engine's trades, and counted as "Manual" on the Trades page and in the results by model.</p>
            <button onClick={onClose} className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110">Done</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex overflow-hidden rounded-lg border border-line">
              {(['long', 'short'] as const).map((x) => (
                <button key={x} onClick={() => setSide(x)}
                  className={`flex-1 py-1.5 text-sm font-semibold ${side === x ? (x === 'long' ? 'bg-good/20 text-good' : 'bg-critical/20 text-critical') : 'bg-card-2 text-ink-2'}`}>{x}</button>
              ))}
            </div>
            <p className="flex justify-between text-sm"><span className="text-ink-3">Price now</span><span className="tabular font-semibold">{fmtPrice(now)}</span></p>
            <label className="block text-xs text-ink-3">Stop (required)
              <input value={stop} onChange={(e) => setStop(e.target.value)} inputMode="decimal" className={`${input} ${stop && !stopOk ? 'border-critical' : ''}`} />
            </label>
            <label className="block text-xs text-ink-3">Target (optional)
              <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" className={`${input} ${target && !targetOk ? 'border-critical' : ''}`} />
            </label>
            <label className="block text-xs text-ink-3">Note
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={input} />
            </label>
            <p className="text-xs text-ink-3 tabular">
              {stopPct !== null ? <>Stop {pct(stopPct, 2)} away{rr !== null ? <> · reward:risk {rr.toFixed(2)}</> : null}. </> : stop ? <span className="text-critical">The stop must be {side === 'long' ? 'below' : 'above'} the price. </span> : null}
              {target && !targetOk && <span className="text-critical">The target must be {side === 'long' ? 'above' : 'below'} the price. </span>}
              Filled at Binance's mark price plus slippage, sized so the stop loses about 1% of the account (0.5% on wild coins), within the engine's risk limits.
            </p>
            {error && <p className="rounded-lg bg-critical/10 px-3 py-2 text-sm text-critical">{error}</p>}
            <button onClick={() => void submit()} disabled={busy || !stopOk || !targetOk}
              className={`w-full rounded-xl px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40 ${side === 'long' ? 'bg-good' : 'bg-critical'}`}>
              {busy ? 'Opening…' : `Open ${side} at market`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
