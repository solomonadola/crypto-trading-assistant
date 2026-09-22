import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { AutoPilotPacingInfo } from '../services/marketRegimeService';
import { getFirestoreHealth, FirestoreHealth, FIRESTORE_WRITES_ENABLED } from '../lib/firebase';

export interface CatchUpStatus {
  at: number;
  gapMs: number;
  changed: number;
  closed: number;
  failedSymbols: string[];
}

interface StatusStripProps {
  lastPriceUpdateAt: number | null;
  isRefreshing: boolean;
  pacingInfo: AutoPilotPacingInfo;
  lastCatchUp: CatchUpStatus | null;
  /** Impossible-looking records still counted in the statistics. */
  suspectRecords?: number;
  onOpenDataHealth?: () => void;
  serverActive?: boolean;
  lastServerTickAt?: number | null;
  /** No trading server reachable and browser trading off: nothing is traded from this page. */
  displayOnly?: boolean;
  /** Set when the server looks misconfigured (several instances, another build). */
  serverWarning?: string | null;
}

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

// Literal class strings so Tailwind keeps them.
const DOT: Record<Tone, string> = {
  good: 'bg-emerald-400',
  warn: 'bg-amber-400',
  bad: 'bg-rose-500',
  neutral: 'bg-stone-500',
  info: 'bg-sky-400',
};

const PACING_TONE: Record<string, Tone> = {
  emerald: 'good',
  amber: 'warn',
  red: 'bad',
  rose: 'bad',
  blue: 'info',
  stone: 'neutral',
};

const STORAGE: Record<FirestoreHealth, { tone: Tone; label: string; detail: string }> = {
  ok: {
    tone: 'good',
    label: 'Synced to Firebase',
    detail: 'Trades are saved to Firebase and shared by every browser using this app.',
  },
  denied: {
    tone: 'warn',
    label: 'Saved in this browser only',
    detail: 'Firebase is rejecting requests, so trades are kept in this browser. They are not shared with other browsers or devices, and clearing site data deletes them.',
  },
  quota: {
    tone: 'warn',
    label: 'Firebase quota reached - this browser only',
    detail: "Firebase's daily limit was reached. Trades are kept in this browser until it resets.",
  },
  offline: {
    tone: 'warn',
    label: 'Firebase unreachable - this browser only',
    detail: 'Firebase could not be reached. Trades are kept in this browser.',
  },
  unknown: {
    tone: 'neutral',
    label: 'Checking storage...',
    detail: 'Waiting for the first response from Firebase.',
  },
};

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${(m / 60).toFixed(1)} h ago`;
}

function span(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m} min`;
  const h = ms / 3600000;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}

const Item: React.FC<{ tone: Tone; title?: string; className?: string; children: React.ReactNode }> = ({ tone, title, className = 'inline-flex', children }) => (
  <span className={`${className} min-w-0 items-center gap-1.5`} title={title}>
    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden="true" />
    <span className="truncate">{children}</span>
  </span>
);

/**
 * One-line system status, visible on every tab.
 *
 * Answers the questions the rest of the UI left implicit: are these prices
 * current, why is auto-pilot (not) trading, where is my data actually saved,
 * and what happened while the app was closed.
 */
export const StatusStrip: React.FC<StatusStripProps> = ({ lastPriceUpdateAt, isRefreshing, pacingInfo, lastCatchUp, suspectRecords = 0, onOpenDataHealth, serverActive = false, lastServerTickAt = null, displayOnly = false, serverWarning = null }) => {
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  // Prices refresh every 30s while the tab is visible.
  const age = lastPriceUpdateAt ? now - lastPriceUpdateAt : null;
  const priceTone: Tone = age === null ? 'neutral' : age < 60_000 ? 'good' : age < 180_000 ? 'warn' : 'bad';
  const priceLabel = isRefreshing && age === null
    ? 'Loading prices...'
    : age === null
      ? 'No prices yet'
      : `Prices ${ago(age)}`;

  // The Firestore SDK can keep retrying silently rather than failing, which
  // would leave "Checking storage..." on screen indefinitely.
  const health = getFirestoreHealth();
  const storage = !FIRESTORE_WRITES_ENABLED
    ? {
        tone: 'info' as Tone,
        label: 'Firebase read-only - changes stay in this browser',
        detail: 'VITE_FIRESTORE_WRITES=off: this copy reads the shared trade history but never writes to it.',
      }
    : health === 'unknown' && now - mountedAt > 20_000
    ? {
        tone: 'warn' as Tone,
        label: 'Firebase not responding - this browser only',
        detail: 'No response from Firebase after 20 seconds. Trades are being kept in this browser, and are not shared with other browsers or devices.',
      }
    : STORAGE[health];
  const pacingTone = PACING_TONE[pacingInfo.badgeColor] ?? 'neutral';

  let catchUpTone: Tone = 'neutral';
  let catchUpLabel = serverActive
    ? '24/7 background worker active (keeps trading when tab is closed)'
    : 'Checked while open; time away is replayed on return';
  if (lastCatchUp && !serverActive) {
    if (lastCatchUp.failedSymbols.length) {
      catchUpTone = 'warn';
      catchUpLabel = `Catch-up incomplete (${lastCatchUp.failedSymbols.join(', ')}), retrying`;
    } else {
      catchUpTone = lastCatchUp.closed > 0 ? 'info' : 'neutral';
      const what = lastCatchUp.closed > 0
        ? `${lastCatchUp.closed} closed`
        : lastCatchUp.changed > 0 ? `${lastCatchUp.changed} updated` : 'nothing changed';
      catchUpLabel = `Caught up on ${span(lastCatchUp.gapMs)} away: ${what}`;
    }
  }

  return (
    <section
      aria-label="System status"
      className="w-full border-b border-stone-800 bg-stone-900/60 text-[11px] text-stone-400"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2 sm:px-6 lg:px-8">
        <Item tone={priceTone} title="Prices refresh every 30 seconds while this tab is visible.">
          {priceLabel}
        </Item>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="status-strip-autopilot-detail"
          className="inline-flex min-w-0 items-center gap-1.5 rounded text-left text-stone-300 hover:text-stone-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-400"
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[pacingTone]}`} aria-hidden="true" />
          <span className="truncate">
            Auto-pilot: <span className="font-medium">{pacingInfo.headline}</span>
          </span>
          {expanded
            ? <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
            : <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />}
          <span className="sr-only">{expanded ? 'Hide reason' : 'Show reason'}</span>
        </button>

        <Item tone={storage.tone} title={storage.detail}>{storage.label}</Item>

        {serverActive ? (
          <Item
            tone="good"
            title="24/7 background trading worker is active on the server. Trades are evaluated and deployed autonomously even when all browser tabs are closed."
          >
            24/7 Server Active {lastServerTickAt ? `(Tick ${ago(now - lastServerTickAt)})` : ''}
          </Item>
        ) : displayOnly ? (
          <Item
            tone="warn"
            title="The 24/7 trading server is not reachable from this page, so it only shows the trades saved in Firebase and changes nothing. Open the deployed app to trade."
          >
            Display only - no trading server
          </Item>
        ) : (
          <Item
            tone="neutral"
            title="In-browser trading mode (VITE_BROWSER_TRADING=on). Runs while this tab is open in the foreground; time away is replayed on return."
          >
            Browser Mode
          </Item>
        )}

        {serverWarning && (
          <Item tone="bad" title={serverWarning}>{serverWarning}</Item>
        )}

        {suspectRecords > 0 && (
          <button
            type="button"
            onClick={onOpenDataHealth}
            className="inline-flex min-w-0 items-center gap-1.5 rounded text-left text-amber-300 hover:text-amber-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-400"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT.bad}`} aria-hidden="true" />
            <span className="truncate underline decoration-amber-500/40 underline-offset-2">
              {suspectRecords} suspect record{suspectRecords === 1 ? '' : 's'} in your stats
            </span>
          </button>
        )}

        <Item
          tone={serverActive ? 'good' : catchUpTone}
          className={lastCatchUp || serverActive ? 'inline-flex' : 'hidden sm:inline-flex'}
          title={serverActive
            ? "Trading runs 24/7 on the server. When browser tabs close, positions continue to be monitored and auto-pilot continues to deploy."
            : "Stops and targets are checked while this tab is open. When you come back, the price candles you missed are replayed so nothing is skipped."}
        >
          {catchUpLabel}
        </Item>
      </div>

      {expanded && (
        <p
          id="status-strip-autopilot-detail"
          className="mx-auto max-w-7xl px-4 pb-2 text-stone-400 sm:px-6 lg:px-8"
        >
          {pacingInfo.explanation}
        </p>
      )}
    </section>
  );
};
