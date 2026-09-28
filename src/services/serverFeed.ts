import { AutomatedTradeRecord } from '../types/automatedFeed';
import { applyServerTrades } from './automatedFeedService';

/**
 * Where the 24/7 trading server is. Empty: the server this page came from
 * (the hosted app). Set VITE_TRADING_SERVER_URL (e.g. in .env.local) to the
 * hosted URL to make any other copy - a local dev server - follow the hosted
 * server instead of trading on its own.
 */
export const TRADING_SERVER_URL = String(import.meta.env.VITE_TRADING_SERVER_URL || '').replace(/\/+$/, '');

export function serverApiUrl(path: string): string {
  return TRADING_SERVER_URL + path;
}

async function getJson(path: string, timeoutMs: number): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(serverApiUrl(path), { cache: 'no-store', signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();   // the timeout covers the body too
  } catch {
    return null;               // no server, or not JSON (a static host answers with the app page)
  } finally {
    clearTimeout(timer);
  }
}

export interface ServerStatus {
  /** A worker that completed a tick in the last two minutes. */
  active: boolean;
  /** Whether the HTTP API server is reachable to accept actions (close, deploy, exclude) */
  serverOnline: boolean;
  lastTickAt: number | null;
  /** Which server process answered (changes on restart). */
  instanceId: string | null;
  /** The build the server belongs to; compare with __BUILD_ID__. */
  buildId: string | null;
  /** Something is off that the user should fix (another build, several servers). */
  warning: string | null;
  /** Background worker Firestore connection state: 'ok', 'offline', etc. */
  firestoreStatus?: string | null;
  /** Background worker auto-pilot enabled state */
  isAutoPilot?: boolean;
  /** Whether the auto-pilot is allowed to deploy short positions */
  allowShorts?: boolean;
  /** The exit profile the server opens trades with */
  strategyProfile?: string;
}

// Instance ids seen recently. Two alternating within minutes means more than
// one server process is answering - each with its own trade list, so an
// action can reach one that does not know the trade, or an old revision
// without the endpoint. That was the "404 once in a while".
const seenInstances: Array<{ id: string; at: number }> = [];
const MULTI_INSTANCE_WINDOW_MS = 10 * 60_000;

function noteInstance(id: string | null | undefined): void {
  if (!id) return;
  const now = Date.now();
  if (seenInstances[seenInstances.length - 1]?.id !== id) seenInstances.push({ id, at: now });
  while (seenInstances.length && now - seenInstances[0].at > MULTI_INSTANCE_WINDOW_MS) seenInstances.shift();
}

function multipleInstances(): boolean {
  // A restart shows up once (old id, then new id for good); several
  // switches inside the window mean they are answering side by side.
  return seenInstances.length >= 3 && new Set(seenInstances.map((x) => x.id)).size >= 2;
}

const PAGE_BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

export async function fetchServerStatus(): Promise<ServerStatus> {
  const data = await getJson('/api/status', 5000);
  const w = data?.worker;
  const instanceId = typeof w?.instanceId === 'string' ? w.instanceId : null;
  const buildId = typeof data?.buildId === 'string' ? data.buildId : null;
  noteInstance(instanceId);
  let warning: string | null = null;
  if (multipleInstances()) {
    warning = 'More than one trading server is answering. Set Cloud Run maximum instances to 1 and send all traffic to the latest revision.';
  } else if (buildId && PAGE_BUILD !== 'dev' && buildId !== 'dev' && buildId !== PAGE_BUILD) {
    warning = `This page (build ${PAGE_BUILD}) and the server (build ${buildId}) are from different deployments. Reload the page; if it persists, an old revision is still taking traffic.`;
  }
  const firestoreStatus = typeof w?.sync?.firestore === 'string' ? w.sync.firestore : null;
  const isAutoPilot = typeof w?.isAutoPilot === 'boolean' ? w.isAutoPilot : undefined;
  const allowShorts = typeof w?.allowShorts === 'boolean' ? w.allowShorts : undefined;
  const strategyProfile = typeof w?.strategyProfile === 'string' ? w.strategyProfile : undefined;
  const serverOnline = Boolean(data?.serverActive);
  const workerActive = Boolean(w?.workerRunning && typeof w.tickAgeMs === 'number' && w.tickAgeMs < 120_000);

  return {
    active: workerActive,
    serverOnline,
    lastTickAt: typeof w?.tickAgeMs === 'number' ? Date.now() - w.tickAgeMs : null,
    instanceId,
    buildId,
    warning,
    firestoreStatus,
    isAutoPilot,
    allowShorts,
    strategyProfile,
  };
}

let cursor = { boot: '', version: 0 };

/** Forget what has been pulled, so the next pull fetches the full list. */
export function resetServerFeed(): void {
  cursor = { boot: '', version: 0 };
}

/**
 * Pulls the trade list from the server - the full list the first time, then
 * only what changed - and applies it. False if the server did not answer.
 */
export async function pullServerTrades(): Promise<boolean> {
  const data = await getJson(`/api/trades?since=${cursor.version}&boot=${encodeURIComponent(cursor.boot)}`, 15_000);
  if (!data || !Array.isArray(data.trades) || typeof data.version !== 'number') return false;
  applyServerTrades(Boolean(data.full), data.trades as AutomatedTradeRecord[], Array.isArray(data.removedIds) ? data.removedIds : []);
  cursor = { boot: String(data.bootId), version: data.version };
  return true;
}

/**
 * Asks the trading server to change a trade (close, exclude, deploy). While
 * the server runs it is the only thing that changes trades; the result shows
 * up in the next pull, which this triggers straight away.
 *
 * Actions are same-origin only. A local dev server following a hosted one
 * must reach it through the dev proxy (BACKEND_URL), not VITE_TRADING_SERVER_URL.
 */
export async function serverAction(path: string, body: unknown): Promise<{ ok: boolean; error?: string; result?: any; unreachable?: boolean }> {
  let outcome = await postOnce(path, body);
  // Retry once, and only when the server certainly did nothing: it had no such
  // endpoint (another revision or an old build answered) or could not be
  // reached before sending anything back. A refusal with a reason (400:
  // "already closed", "10 open") or a server error is never retried - a deploy
  // must not run twice.
  if (!outcome.ok && outcome.retryable) {
    await new Promise((r) => setTimeout(r, 1500));
    await fetchServerStatus();   // note which instance is answering now
    outcome = await postOnce(path, body);
  }
  if (!outcome.ok) {
    const status = await fetchServerStatus();
    // unreachable: the server never answered, so it certainly did nothing. A
    // caller may then act by itself. Anything else (a refusal with a reason, a
    // server error, a timeout that may have gone through) must not be redone.
    return {
      ok: false,
      unreachable: outcome.unreachable,
      error: status.warning ? `${outcome.error} ${status.warning}` : outcome.error,
    };
  }
  await pullServerTrades().catch(() => false);
  return { ok: true, result: outcome.result };
}

async function postOnce(path: string, body: unknown): Promise<{ ok: boolean; retryable?: boolean; unreachable?: boolean; error?: string; result?: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(serverApiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    noteInstance(data?.instanceId);
    if (res.ok && data?.success) return { ok: true, result: data.result };
    if (res.status === 404) {
      return {
        ok: false,
        retryable: true,
        error: data?.error || 'The trading server answered that it has no such action - it is an older version than this page. Nothing was changed.',
      };
    }
    return { ok: false, error: data?.error || `The trading server answered ${res.status}.` };
  } catch {
    // Timed out or could not connect. fetch does not say whether the request
    // reached the server first, so it may have gone through: never retried.
    return {
      ok: false,
      unreachable: true,
      error: TRADING_SERVER_URL
        ? 'Could not reach the trading server. From a local copy, use BACKEND_URL (dev proxy) to send actions.'
        : 'Could not reach the trading server. Check the positions list before trying again - the action may or may not have gone through.',
    };
  } finally {
    clearTimeout(timer);
  }
}
