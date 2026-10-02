// Notifications when the engine confirms an entry: a message box in the app,
// a browser notification (seen even when the tab is in the background), and a
// short sound. Off by default; the bell in the header turns them on and picks
// what to hear about. The choice is remembered in this browser only.
import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, BellRing, X } from 'lucide-react';
import { useStream } from '../lib/api';
import { coin, MODEL_LABEL, price, words } from '../lib/format';
import type { ConfirmationNotice } from '../../shared/types';


type Mode = 'off' | 'entries' | 'all';
const MODE_KEY = 'notify-mode';
const TOAST_MS = 20_000;

function readMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'entries' || m === 'all' ? m : 'off';
  } catch { return 'off'; }
}

const title = (n: ConfirmationNotice) =>
  `${n.status === 'taken' ? 'Entry' : 'Confirmed, skipped'}: ${coin(n.symbol)} ${n.direction}`;

const body = (n: ConfirmationNotice) => [
  MODEL_LABEL[n.setup] ?? n.setup,
  n.entry !== null && n.stop !== null && n.target !== null ? `entry ${price(n.entry)} · stop ${price(n.stop)} · TP ${price(n.target)}` : null,
  n.rewardRisk !== null ? `${n.rewardRisk.toFixed(2)}R` : null,
  n.status === 'filtered' && n.reason ? `skipped: ${words(n.reason)}` : null,
].filter(Boolean).join(' · ');

/** A short two-tone chime, made in the browser (no sound file). Silently does nothing where audio is blocked. */
function chime(entry: boolean): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = entry ? [660, 880] : [520];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.connect(g);
      g.connect(ctx.destination);
      const at = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
      o.start(at);
      o.stop(at + 0.3);
    });
    setTimeout(() => void ctx.close(), 1_000);
  } catch { /* audio unavailable */ }
}

/** The bell in the header and the message boxes; `go` opens a coin's chart. */
export function Notifier({ go }: { go: (page: string, symbol?: string) => void }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<(ConfirmationNotice & { id: number })[]>([]);
  const nextId = useRef(0);
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage unavailable */ } }, [mode]);

  const choose = async (m: Mode) => {
    setMode(m);
    setOpen(false);
    if (m !== 'off' && typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
  };

  const show = (n: ConfirmationNotice) => {
    const id = nextId.current++;
    setToasts((t) => [{ ...n, id }, ...t].slice(0, 4));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
    chime(n.status === 'taken');
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const note = new Notification(title(n), { body: body(n), tag: `${n.symbol}-${n.time}` });
        note.onclick = () => { window.focus(); go('chart', n.symbol); note.close(); };
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
  };

  useStream('signal', (data) => {
    const n = data as ConfirmationNotice;
    if (mode === 'off' || (mode === 'entries' && n.status !== 'taken')) return;
    show(n);
  });

  const Icon = mode === 'off' ? BellOff : mode === 'all' ? BellRing : Bell;
  const label = mode === 'off' ? 'Alerts off' : mode === 'all' ? 'All confirmations' : 'Entries';
  return (
    <>
      <div className="relative">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Notifications when the engine confirms an entry"
          className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs ring-1 ${mode === 'off' ? 'bg-card-2 text-ink-2 ring-line hover:text-ink' : 'bg-accent/15 font-semibold text-accent ring-accent/40'}`}>
          <Icon size={12} />{label}
        </button>
        {open && (
          <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-line bg-card p-3 text-sm shadow-xl">
            <p className="mb-2 text-xs text-ink-3">Notify me when the engine confirms a setup:</p>
            {([['entries', 'Entries only', 'when it opens a trade'], ['all', 'All confirmations', 'also the ones a rule skipped'], ['off', 'Off', '']] as const).map(([m, name, hint]) => (
              <button key={m} onClick={() => void choose(m)} className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-card-2 ${mode === m ? 'text-ink' : 'text-ink-2'}`}>
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${mode === m ? 'bg-accent' : 'bg-line'}`} />
                <span>{name}{hint && <span className="block text-xs text-ink-3">{hint}</span>}</span>
              </button>
            ))}
            {permission === 'denied' && <p className="mt-2 text-xs text-warning">Browser notifications are blocked for this site; you will still get the message box and the sound here. Allow them in the browser's site settings.</p>}
            {permission === 'unsupported' && <p className="mt-2 text-xs text-ink-3">This browser has no notifications; you will get the message box and the sound.</p>}
            <p className="mt-2 text-[11px] text-ink-3">Works while this dashboard is open (any tab).</p>
            <button
              onClick={() => { setOpen(false); show({ time: Date.now(), symbol: 'BTCUSDT', direction: 'long', setup: 'session_sweep', status: 'taken', reason: null, entry: 100, stop: 97, target: 107, rewardRisk: 2.33, speed: 'normal', swept: 'asian_low' }); }}
              className="mt-2 text-xs text-accent hover:underline">Send a test notification</button>
          </div>
        )}
      </div>

      <div className="pointer-events-none fixed right-4 top-16 z-40 flex w-80 flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((n) => (
          <div key={n.id} className={`pointer-events-auto rounded-xl border bg-card p-3 shadow-xl ${n.status === 'taken' ? 'border-good/50' : 'border-warning/50'}`}>
            <div className="flex items-start gap-2">
              <button onClick={() => go('chart', n.symbol)} className="min-w-0 flex-1 text-left">
                <p className={`text-sm font-semibold ${n.status === 'taken' ? 'text-good' : 'text-warning'}`}>{title(n)}</p>
                <p className="mt-0.5 text-xs text-ink-2">{body(n)}</p>
                <p className="mt-1 text-[11px] text-accent">open the chart</p>
              </button>
              <button onClick={() => setToasts((t) => t.filter((x) => x.id !== n.id))} aria-label="Dismiss" className="text-ink-3 hover:text-ink"><X size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
