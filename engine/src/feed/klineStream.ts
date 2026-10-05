// Closed candles from Binance's WebSocket, for the live feed. One connection
// carries every symbol x timeframe the feed watches (SUBSCRIBE messages, so the
// list can change without reconnecting). Closed candles are kept in a small
// buffer that the feed reads instead of asking the REST API; whatever the
// stream does not have (history, a gap after a disconnect, a late message) the
// feed still fetches over REST. The stream costs no request weight and keeps
// working while Binance blocks the IP's REST requests.
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../../../shared/types';

interface Socket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface KlineStreamOptions {
  /** A combined-stream endpoint that accepts SUBSCRIBE, e.g. wss://fstream.binance.com/market/stream */
  url: string;
  timeframes: Timeframe[];
  /** Injected for tests; the global WebSocket otherwise. */
  connect?: (url: string) => Socket;
  log?: (msg: string) => void;
}

/** Closed candles kept per symbol and timeframe: enough to cover a few missed polls. */
const KEEP = 30;
/** Binance accepts at most 10 messages a second per connection; params per message kept modest. */
const PARAMS_PER_MESSAGE = 100;
/** Binance's limit per connection. */
const MAX_STREAMS = 1024;

const streamName = (symbol: string, tf: Timeframe) => `${symbol.toLowerCase()}@kline_${tf}`;

export class KlineStream {
  private readonly buffer = new Map<string, Map<number, Candle>>();
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private socket: Socket | null = null;
  private open = false;
  private stopped = true;
  private failures = 0;
  private nextId = 1;
  private readonly log: (msg: string) => void;
  private readonly connectFn: ((url: string) => Socket) | null;
  /** Closed candles received, for the status. */
  received = 0;

  constructor(private readonly opts: KlineStreamOptions) {
    this.log = opts.log ?? ((m) => console.log(`[candles] ${m}`));
    const Ws = (globalThis as { WebSocket?: new (url: string) => Socket }).WebSocket;
    this.connectFn = opts.connect ?? (Ws ? (url) => new Ws(url) : null);
  }

  start(): void {
    if (!this.connectFn) {
      this.log('no WebSocket in this runtime: candles come from REST');
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  connected(): boolean {
    return this.open;
  }

  /** The symbols to receive candles for (all configured timeframes); subscribes and unsubscribes the difference. */
  watch(symbols: string[]): void {
    const next = new Set(symbols.flatMap((s) => this.opts.timeframes.map((tf) => streamName(s, tf))));
    if (next.size > MAX_STREAMS) this.log(`${next.size} streams is over Binance's ${MAX_STREAMS} per connection; the rest come from REST`);
    this.wanted = new Set([...next].slice(0, MAX_STREAMS));
    for (const key of this.buffer.keys()) if (!this.wanted.has(streamName(key.split('|')[0], key.split('|')[1] as Timeframe))) this.buffer.delete(key);
    if (this.open) this.sync();
  }

  /**
   * The closed candles with open times from `from` to `to` (inclusive) if the
   * stream has every one of them, oldest first; null if any is missing (the
   * feed then asks the REST API).
   */
  take(symbol: string, tf: Timeframe, from: number, to: number): Candle[] | null {
    const got = this.buffer.get(`${symbol}|${tf}`);
    if (!got) return null;
    const tfMs = TIMEFRAME_MS[tf];
    const out: Candle[] = [];
    for (let t = from; t <= to; t += tfMs) {
      const c = got.get(t);
      if (!c) return null;
      out.push(c);
    }
    return out;
  }

  private connect(): void {
    if (this.stopped || !this.connectFn) return;
    let socket: Socket;
    try {
      socket = this.connectFn(this.opts.url);
    } catch (err) {
      this.retry(err);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.open = true;
      if (this.failures) this.log('stream connected again');
      this.failures = 0;
      // A new connection has no subscriptions.
      this.subscribed = new Set();
      this.sync();
    };
    socket.onmessage = (ev) => this.onMessage(ev.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.open = false;
      this.retry(null);
    };
  }

  private retry(err: unknown): void {
    if (this.stopped) return;
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6));
    if (this.failures === 0) this.log(`stream closed${err ? ` (${err instanceof Error ? err.message : String(err)})` : ''}; reconnecting (REST covers the gap)`);
    this.failures++;
    setTimeout(() => this.connect(), wait);
  }

  /** Sends SUBSCRIBE / UNSUBSCRIBE for the difference between wanted and subscribed. */
  private sync(): void {
    const socket = this.socket;
    if (!socket) return;
    const add = [...this.wanted].filter((s) => !this.subscribed.has(s));
    const remove = [...this.subscribed].filter((s) => !this.wanted.has(s));
    const send = (method: string, params: string[]) => {
      for (let i = 0; i < params.length; i += PARAMS_PER_MESSAGE) {
        socket.send(JSON.stringify({ method, params: params.slice(i, i + PARAMS_PER_MESSAGE), id: this.nextId++ }));
      }
    };
    send('UNSUBSCRIBE', remove);
    send('SUBSCRIBE', add);
    for (const s of remove) this.subscribed.delete(s);
    for (const s of add) this.subscribed.add(s);
  }

  /** A combined-stream message; only closed candles (k.x) are kept. */
  onMessage(data: unknown): void {
    let msg: { data?: { e?: string; s?: string; k?: Record<string, unknown> } };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const d = msg.data;
    const k = d?.k;
    if (!d || d.e !== 'kline' || !k || k.x !== true) return;
    const tf = k.i as Timeframe;
    const symbol = String(d.s ?? k.s);
    if (!(tf in TIMEFRAME_MS) || !this.opts.timeframes.includes(tf)) return;
    const openTime = Number(k.t);
    const candle: Candle = {
      symbol, tf, openTime, closeTime: openTime + TIMEFRAME_MS[tf],
      open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
      volume: Number(k.v), quoteVolume: Number(k.q), trades: Number(k.n),
    };
    if (![candle.open, candle.high, candle.low, candle.close].every((x) => Number.isFinite(x) && x > 0)) return;
    const key = `${symbol}|${tf}`;
    let got = this.buffer.get(key);
    if (!got) this.buffer.set(key, (got = new Map()));
    got.set(openTime, candle);
    this.received++;
    if (got.size > KEEP) for (const t of [...got.keys()].sort((a, b) => a - b).slice(0, got.size - KEEP)) got.delete(t);
  }
}
