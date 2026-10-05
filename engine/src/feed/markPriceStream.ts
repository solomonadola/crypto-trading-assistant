// Binance's mark price and funding rate for every perpetual, pushed once a
// second over one WebSocket. It costs no REST request weight, so the live
// prices on the dashboard and the prices manual trades fill at no longer
// count towards the per-IP limit that got the server banned. Reconnects on
// its own; callers fall back to REST while it has nothing fresh.

/** What the stream needs from a WebSocket: the standard browser/Node API. */
interface Socket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface MarkPriceStreamOptions {
  url: string;
  /** Injected for tests; the global WebSocket otherwise. */
  connect?: (url: string) => Socket;
  now?: () => number;
  log?: (msg: string) => void;
}

interface Mark { price: number; funding: number | null; time: number }

/** A price older than this is not used: the stream is down or the coin stopped updating. */
const FRESH_MS = 15_000;

export class MarkPriceStream {
  private readonly marks = new Map<string, Mark>();
  private socket: Socket | null = null;
  private stopped = false;
  private failures = 0;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly connectFn: ((url: string) => Socket) | null;

  constructor(private readonly opts: MarkPriceStreamOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[prices] ${m}`));
    const Ws = (globalThis as { WebSocket?: new (url: string) => Socket }).WebSocket;
    this.connectFn = opts.connect ?? (Ws ? (url) => new Ws(url) : null);
  }

  start(): void {
    if (!this.connectFn) {
      this.log('no WebSocket in this runtime: live prices come from REST');
      return;
    }
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  private open(): void {
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
      if (this.failures) this.log('stream connected again');
      this.failures = 0;
    };
    socket.onmessage = (ev) => this.onMessage(ev.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.retry(null);
    };
  }

  private retry(err: unknown): void {
    if (this.stopped) return;
    // 1 s, 2 s, 4 s ... at most a minute between tries.
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6));
    if (this.failures === 0) this.log(`stream closed${err ? ` (${err instanceof Error ? err.message : String(err)})` : ''}; reconnecting`);
    this.failures++;
    setTimeout(() => this.open(), wait);
  }

  /** One message: an array of updates for the coins that changed. */
  onMessage(data: unknown): void {
    let rows: unknown;
    try {
      rows = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    const at = this.now();
    for (const r of rows as { s?: string; p?: string; r?: string }[]) {
      const price = Number(r.p);
      if (!r.s || !(price > 0)) continue;
      const funding = r.r === undefined || r.r === '' ? null : Number(r.r);
      this.marks.set(r.s, { price, funding: Number.isFinite(funding) ? funding : null, time: at });
    }
  }

  /** The latest mark price, or null when there is none from the last 15 seconds. */
  price(symbol: string): number | null {
    const m = this.marks.get(symbol);
    return m && this.now() - m.time <= FRESH_MS ? m.price : null;
  }

  /** Fresh mark prices of these coins; the ones without one are left out. */
  prices(symbols: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of symbols) {
      const p = this.price(s);
      if (p !== null) out[s] = p;
    }
    return out;
  }

  /** The latest funding rate (fraction per 8 h), when fresh. */
  funding(symbol: string): number | null {
    const m = this.marks.get(symbol);
    return m && this.now() - m.time <= FRESH_MS ? m.funding : null;
  }
}
