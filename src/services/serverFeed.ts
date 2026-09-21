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
  lastTickAt: number | null;
}

export async function fetchServerStatus(): Promise<ServerStatus> {
  const data = await getJson('/api/status', 5000);
  const w = data?.worker;
  if (w?.workerRunning && typeof w.tickAgeMs === 'number' && w.tickAgeMs < 120_000) {
    return { active: true, lastTickAt: Date.now() - w.tickAgeMs };
  }
  return { active: false, lastTickAt: null };
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
