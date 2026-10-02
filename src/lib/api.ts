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
    rr: number | null; meetsRules: boolean; targetPct: number | null; checksMet: number; checksDecided: number; quality: number;
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

// ---------------------------------------------------------------- live stream
// One connection to /api/stream for the whole page: "engine" when the engine
// has processed new candles, "prices" every few seconds. Reconnects on its own.

export interface LivePrices {
  time: number;
  prices: Record<string, number>;
  positions: Record<string, { price: number | null; unrealized: number; pnlPct: number }>;
}
type StreamListener = (data: unknown) => void;
const listeners = new Map<string, Set<StreamListener>>();
let lastPrices: LivePrices | null = null;
let connected = false;
let everOpened = false;

function emit(event: string, data: unknown): void {
  if (event === 'prices') lastPrices = data as LivePrices;
  for (const l of listeners.get(event) ?? []) l(data);
}

async function connect(): Promise<void> {
  if (connected) return;
  connected = true;
  for (;;) {
    try {
      const res = await fetch('/api/stream', { headers: await authHeaders() });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      if (everOpened) emit('open', null);   // a reconnect: pages catch up on anything missed
      everOpened = true;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let end: number;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) emit(event, JSON.parse(data));
        }
      }
    } catch {
      // dropped or refused: try again shortly
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Calls `cb` on every stream event of this type (and opens the stream if needed). */
export function useStream(event: string, cb: StreamListener): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    void connect();
    const l: StreamListener = (d) => ref.current(d);
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(l);
    return () => { listeners.get(event)!.delete(l); };
  }, [event]);
}

/** Live trade prices and open positions' P&L, updated every few seconds. */
export function usePrices(): LivePrices | null {
  const [p, setP] = useState<LivePrices | null>(lastPrices);
  useStream('prices', (d) => setP(d as LivePrices));
  return p;
}

/**
 * Fetches `url` now, again as soon as the engine processes new candles (pushed
 * over the stream), and every `ms` as a fallback. `reload` refetches at once.
 * Keeps the last good value on errors.
 */
export function usePoll<T>(url: string | null, ms: number): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (!url || busy.current) return;
    busy.current = true;
    try {
      const d = await get<T>(url);
      if (alive.current) { setData(d); setError(null); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, [url]);
  useEffect(() => {
    alive.current = true;
    setData(null);
    void load();
    const timer = setInterval(load, ms);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load, ms]);
  useStream('engine', () => void load());
  useStream('open', () => void load());
  return { data, error, reload: load };
}
