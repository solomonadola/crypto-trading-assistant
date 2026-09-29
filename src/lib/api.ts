// Talking to the engine: typed GETs, control POSTs, and a polling hook.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSummary, Candle, ClosedTradeView, FeedStatus, ShadowResult, SignalRecord } from '../../shared/types';
import { idToken } from './auth';

export type { AccountSummary, Candle, ClosedTradeView, ShadowResult, SignalRecord };

export interface SessionInstance { name: string; openTime: number; closeTime: number; localDate: string }
export interface SessionInfo {
  time: number;
  active: SessionInstance[];
  owner: SessionInstance | null;
  entryBlock: string | null;
  next: SessionInstance | null;
}

export interface Status {
  engineVersion: string;
  configHash: string;
  engineClock: number;
  feed: FeedStatus;
  session: SessionInfo | null;
  openPositions: number;
  halted: { reason: string; at: number } | null;
  backup: { target: string; namespace: string; ok: boolean; error: string | null; standby: boolean; lastPush: number };
  signInRequired: boolean;
}

export interface Direction { state: string; emaAligned: boolean; tradable: boolean }
export interface MarketRow {
  symbol: string;
  price: number | null;
  changePct: number | null;
  quoteVolume: number | null;
  atrPct1h: number | null;
  long: Direction | null;
  short: Direction | null;
  trend: Record<'4h' | '1h' | '15m', string | null> | null;
  zones: number;
  armed: string[];
  setup: null | {
    bias: 'long' | 'short' | 'none'; stage: string | null; skipped: boolean;
    rr: number | null; meetsRules: boolean; checksMet: number; checksDecided: number; quality: number;
  };
}

export interface Zone { id: string; type: 'demand' | 'supply'; low: number; high: number; status: string; touches: number; createdAt: number }
export interface Fvg { id: string; tf: string; side: 'bullish' | 'bearish'; inverse: boolean; top: number; bottom: number; createdAt: number; status: string; invertedAt: number | null }
export interface VolumeProfile { name: string; from: number; to: number; bins: { low: number; high: number; volume: number }[]; poc: number; vah: number; val: number; hvn: number[]; lvn: number[] }
export interface TrendMeterRow { structure: string | null; supertrend: 1 | -1 | null; line: number | null }

export interface Analysis {
  symbol: string;
  asOf: number;
  structure: Record<'4h' | '1h' | '15m', { trend: string; broken: string | null; protectedLow: number | null; protectedHigh: number | null } | null>;
  ema4h: { fast: number | null; slow: number | null; close: number | null };
  long: Direction;
  short: Direction;
  zones: Zone[];
  fvgs: Fvg[];
  profiles: VolumeProfile[];
  trendMeter: Record<'4h' | '1h' | '15m', TrendMeterRow>;
  adx1h: number | null;
}

export interface Armed {
  id: string; symbol: string; direction: 'long' | 'short'; armedAt: number; expiresAt: number; price: number;
  factors: { name: string; level: number; detail: string }[]; areaLow: number; areaHigh: number;
}

export interface Scanner {
  universe: string[];
  lastScan: { time: number; selected: { symbol: string; quoteVolume: number; changePct: number; atrPct1h: number }[]; dropped: Record<string, number> } | null;
}

export interface EquityPoint { time: number; balance: number; equity: number; openPositions: number }
export interface ShadowStats { group: string; count: number; winRate: number; avgR: number; totalR: number }

/** Sign-in header when signed in; the server ignores it when sign-in is off. */
async function authHeaders(): Promise<Record<string, string>> {
  const token = await idToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new HttpError(data.error ?? `${url}: ${res.status}`, res.status);
  }
  return res.json();
}

export async function post<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${url}: ${res.status}`);
  return data;
}

/** Fetches `url` now and every `ms`; `reload` refetches immediately. Keeps the last good value on errors. */
export function usePoll<T>(url: string | null, ms: number): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!url) return;
    try {
      const d = await get<T>(url);
      if (alive.current) { setData(d); setError(null); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [url]);
  useEffect(() => {
    alive.current = true;
    setData(null);
    void load();
    const timer = setInterval(load, ms);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load, ms]);
  return { data, error, reload: load };
}
