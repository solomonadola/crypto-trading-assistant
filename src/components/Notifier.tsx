// Notifications when the engine confirms an entry, and (separately) when a
// coin gets a pump or danger warning: a message box in the app, a browser
// notification (seen even when the tab is in the background), and a short
// sound. Off by default; the bell in the header turns them on and picks what
// to hear about. The choice is remembered in this browser only.
import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, BellRing, X } from 'lucide-react';
import { useStream } from '../lib/api';
import { coin, MODEL_LABEL, price, words } from '../lib/format';
import type { ConfirmationNotice, WarningNotice } from '../../shared/types';


type Mode = 'off' | 'entries' | 'all';
const MODE_KEY = 'notify-mode';
const WARN_KEY = 'notify-warnings';
const TOAST_MS = 20_000;

function readMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'entries' || m === 'all' ? m : 'off';
  } catch { return 'off'; }
}

/** Pump warnings, sweeps, pattern radar, key levels reached, volume surge ignition & ramps, and anything rated danger. */
const worthTelling = (w: WarningNotice) =>
  w.level === 'danger' ||
  w.code.startsWith('pump_') ||
  w.code === 'sweep_reclaim' ||
  w.code.startsWith('pattern_') ||
  w.code === 'key_level_reached' ||
  w.code === 'volume_surge_ignition' ||
  w.code === 'volume_ramp_detected';

function readWarn(): boolean {
  try { return localStorage.getItem(WARN_KEY) === 'on'; } catch { return false; }
}

type Toast = { id: number; kind: 'signal'; n: ConfirmationNotice } | { id: number; kind: 'warning'; w: WarningNotice };

const title = (n: ConfirmationNotice) =>
  `${n.status === 'taken' ? 'Entry' : 'Confirmed, skipped'}: ${coin(n.symbol)} ${n.direction}`;

const body = (n: ConfirmationNotice) => [
  MODEL_LABEL[n.setup] ?? n.setup,
  n.entry !== null && n.stop !== null && n.target !== null ? `entry ${price(n.entry)} · stop ${price(n.stop)} · TP ${price(n.target)}` : null,
  n.rewardRisk !== null ? `${n.rewardRisk.toFixed(2)}R` : null,
  n.status === 'filtered' && n.reason ? `skipped: ${words(n.reason)}` : null,
].filter(Boolean).join(' · ');

/** A short two-tone chime, made in the browser (no sound file). Silently does nothing where audio is blocked. */
export function chime(entry: boolean): void {
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
  const [warn, setWarn] = useState<boolean>(readWarn);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage unavailable */ } }, [mode]);
  useEffect(() => { try { localStorage.setItem(WARN_KEY, warn ? 'on' : 'off'); } catch { /* storage unavailable */ } }, [warn]);

  const choose = async (m: Mode) => {
    setMode(m);
    setOpen(false);
    if (m !== 'off' && typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
  };

  const toggleWarn = async () => {
    setWarn((w) => !w);
    if (!warn && typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
  };

  const notify = (toast: Toast, heading: string, text: string, symbol: string, tag: string, high: boolean) => {
    setToasts((t) => [toast, ...t].slice(0, 4));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), TOAST_MS);
    chime(high);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const note = new Notification(heading, { body: text, tag });
        note.onclick = () => { window.focus(); go('chart', symbol); note.close(); };
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
  };
  const show = (n: ConfirmationNotice) => notify({ id: nextId.current++, kind: 'signal', n }, title(n), body(n), n.symbol, `${n.symbol}-${n.time}`, n.status === 'taken');
  const showWarning = (w: WarningNotice) =>
    notify({ id: nextId.current++, kind: 'warning', w }, `${coin(w.symbol)}: ${w.title}`, w.detail, w.symbol, `${w.symbol}-${w.code}-${w.time}`, false);

  useStream('signal', (data) => {
    const n = data as ConfirmationNotice;
    if (mode === 'off' || (mode === 'entries' && n.status !== 'taken')) return;
    show(n);
  });
  useStream('warning', (data) => {
    const w = data as WarningNotice;
    if (warn && worthTelling(w)) showWarning(w);
  });

  const quiet = mode === 'off' && !warn;
  const Icon = quiet ? BellOff : mode === 'all' ? BellRing : Bell;
  const label = (mode === 'off' ? (warn ? 'Warnings' : 'Alerts off') : mode === 'all' ? 'All confirmations' : 'Entries') + (mode !== 'off' && warn ? ' + warnings' : '');
  return (
    <>
      <div className="relative">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Notifications when the engine confirms an entry"
          className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs ring-1 ${quiet ? 'bg-card-2 text-ink-2 ring-line hover:text-ink' : 'bg-accent/15 font-semibold text-accent ring-accent/40'}`}>
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
            <label className="mt-2 flex cursor-pointer items-start gap-2 border-t border-line px-2 pt-2 text-ink-2 hover:text-ink">
              <input type="checkbox" checked={warn} onChange={() => void toggleWarn()} className="mt-1 accent-[var(--color-accent)]" />
              <span>Key levels, runners & alerts<span className="block text-xs text-ink-3">coins reaching key zones/levels, volume ignition & early ramps (2x-3x runners), sweeps</span></span>
            </label>
            {permission === 'denied' && <p className="mt-2 text-xs text-warning">Browser notifications are blocked for this site; you will still get the message box and the sound here. Allow them in the browser's site settings.</p>}
            {permission === 'unsupported' && <p className="mt-2 text-xs text-ink-3">This browser has no notifications; you will get the message box and the sound.</p>}
            <p className="mt-2 text-[11px] text-ink-3">Works while this dashboard is open (any tab).</p>
            <button
              onClick={() => { setOpen(false); if (warn) showWarning({ symbol: 'METUSDT', code: 'pump_unwinding', level: 'danger', side: 'long', time: Date.now(), phase: 'unwind', title: 'Pump unwinding: 19% off the high', detail: '1h structure broke down (CHoCH). Buying the dip fights the move.' }); show({ time: Date.now(), symbol: 'BTCUSDT', direction: 'long', setup: 'session_sweep', status: 'taken', reason: null, entry: 100, stop: 97, target: 107, rewardRisk: 2.33, speed: 'normal', swept: 'asian_low' }); }}
              className="mt-2 text-xs text-accent hover:underline">Send a test notification</button>
          </div>
        )}
      </div>

      <div className="pointer-events-none fixed right-4 top-16 z-40 flex w-80 flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => {
          const symbol = t.kind === 'signal' ? t.n.symbol : t.w.symbol;
          const [border, tone, heading, text] = t.kind === 'signal'
            ? [t.n.status === 'taken' ? 'border-good/50' : 'border-warning/50', t.n.status === 'taken' ? 'text-good' : 'text-warning', title(t.n), body(t.n)]
            : [t.w.level === 'danger' ? 'border-critical/60' : 'border-warning/50', t.w.level === 'danger' ? 'text-critical' : 'text-warning', `${coin(t.w.symbol)}: ${t.w.title}`, t.w.detail];
          return (
            <div key={t.id} className={`pointer-events-auto rounded-xl border bg-card p-3 shadow-xl ${border}`}>
              <div className="flex items-start gap-2">
                <button onClick={() => go('chart', symbol)} className="min-w-0 flex-1 text-left">
                  <p className={`text-sm font-semibold ${tone}`}>{heading}</p>
                  <p className="mt-0.5 text-xs text-ink-2">{text}</p>
                  <p className="mt-1 text-[11px] text-accent">open the chart</p>
                </button>
                <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss" className="text-ink-3 hover:text-ink"><X size={14} /></button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
