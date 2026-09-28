// Live candles from Binance's public REST API. A few seconds after every minute
// closes, asks for each watched symbol's candles newer than the last one
// stored, stores them, and hands the new ones to listeners in engine order
// (compareCandles). Polling rather than a WebSocket: it fills gaps by design,
// and the strategy acts on 15m closes, where seconds do not matter.
//
// A symbol seen for the first time gets `history` candles per timeframe as
// warm-up; those are stored and handed to history listeners (for analysis),
// not to candle listeners (which act on them). Candles missed while the
// process was down or the network failed are handed on, in order, so the
// engine processes the gap exactly as if it had been running.
import { TIMEFRAME_MS, compareCandles, type Candle, type FeedStatus, type Timeframe } from '../../../shared/types';
import type { BinancePublic } from './binancePublic';
import type { CandleStore } from './candleStore';
import type { EngineConfig } from '../config';

type Listener = (candles: Candle[]) => void;

/** How far back a restored engine may catch up. */
const MAX_RESUME_MS = 3 * 86_400_000;

export interface LiveFeedDeps {
  client: BinancePublic;
  store: CandleStore;
  config: EngineConfig['feed'];
  /** Symbols to feed; called on every poll so the scanner can change it. */
  symbols: () => string[];
  /**
   * The engine's clock. A symbol with no stored candles but an engine that has
   * already run (a restored database) gets history back to this time, and the
   * candles after it are handed on to be processed, not treated as warm-up.
   */
  resumeFrom?: () => number;
  /** Wall clock; injected for tests. */
  now?: () => number;
  log?: (msg: string) => void;
}

export class LiveFeed {
  private readonly listeners: Listener[] = [];
  private readonly historyListeners: Listener[] = [];
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private polling = false;
  private clockOffsetMs = 0;
  private lastClockSync = 0;
  private readonly st: FeedStatus;

  constructor(private readonly deps: LiveFeedDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(`[feed] ${m}`));
    this.st = { state: 'stopped', symbols: [], lastCloseTime: {}, lastError: null, clockOffsetMs: 0 };
  }

  onCandles(listener: Listener): void {
    this.listeners.push(listener);
  }

  /** Warm-up history of a symbol seen for the first time: for analysis only, never to act on. */
  onHistory(listener: Listener): void {
    this.historyListeners.push(listener);
  }

  status(): FeedStatus {
    return { ...this.st, symbols: [...this.st.symbols], lastCloseTime: { ...this.st.lastCloseTime } };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.st.state = 'starting';
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.st.state = 'stopped';
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    await this.poll().catch((err) => this.fail(err));
    if (!this.running) return;
    const serverNow = this.now() - this.clockOffsetMs;
    const nextClose = Math.floor(serverNow / 60_000) * 60_000 + 60_000;
    const delay = nextClose - serverNow + this.deps.config.poll_delay_ms;
    this.timer = setTimeout(() => void this.loop(), delay);
  }

  /** One poll: fetch, store and hand on everything that closed since the last one. Returns the candles handed on. */
  async poll(): Promise<Candle[]> {
    if (this.polling) return [];
    this.polling = true;
    try {
      await this.syncClock();
      const now = this.now() - this.clockOffsetMs;
      const symbols = this.deps.symbols();
      this.st.symbols = symbols;
      const fresh: Candle[] = [];
      let errors = 0;
      const jobs = symbols.flatMap((symbol) => this.deps.config.timeframes.map((tf) => ({ symbol, tf })));
      await inParallel(jobs, this.deps.config.concurrency, async ({ symbol, tf }) => {
        try {
          fresh.push(...await this.catchUp(symbol, tf, now));
        } catch (err) {
          errors++;
          this.fail(err, `${symbol} ${tf}`);
        }
      });
      if (!errors) this.st.lastError = null;
      fresh.sort(compareCandles);
      for (const c of fresh) {
        if (c.tf === '1m') this.st.lastCloseTime[c.symbol] = Math.max(this.st.lastCloseTime[c.symbol] ?? 0, c.closeTime);
      }
      this.updateState(symbols, now);
      if (fresh.length) for (const l of this.listeners) l(fresh);
      return fresh;
    } finally {
      this.polling = false;
    }
  }

  private async catchUp(symbol: string, tf: Timeframe, now: number): Promise<Candle[]> {
    const tfMs = TIMEFRAME_MS[tf];
    const lastClosedOpen = Math.floor(now / tfMs) * tfMs - tfMs;
    const stored = this.deps.store.lastOpenTime(symbol, tf);
    if (stored !== null && stored >= lastClosedOpen) return [];

    const warmUp = stored === null;
    if (warmUp) this.st.state = 'backfilling';
    const resume = warmUp ? this.deps.resumeFrom?.() ?? 0 : 0;
    let from = warmUp ? lastClosedOpen - (this.deps.config.history[tf] - 1) * tfMs : stored + tfMs;
    // Back to the engine's clock, at most MAX_RESUME_MS ago.
    if (resume > 0) from = Math.min(from, Math.max(resume - tfMs, now - MAX_RESUME_MS));
    const candles = (await this.deps.client.klinesRange(symbol, tf, from, lastClosedOpen))
      // Never a candle still forming, whatever the server sent.
      .filter((c) => c.closeTime <= now && (stored === null || c.openTime > stored));
    this.deps.store.save(candles);
    if (warmUp) {
      const history = resume > 0 ? candles.filter((c) => c.closeTime <= resume) : candles;
      const missed = resume > 0 ? candles.filter((c) => c.closeTime > resume) : [];
      const lastHist = history[history.length - 1];
      if (tf === '1m' && lastHist) this.st.lastCloseTime[symbol] = lastHist.closeTime;
      this.log(`${symbol} ${tf}: ${history.length} candles of history${missed.length ? `, ${missed.length} missed since the engine last ran` : ''}`);
      if (history.length) for (const l of this.historyListeners) l(history);
      return missed;
    }
    if (candles.length > 1) this.log(`${symbol} ${tf}: caught up ${candles.length} candles`);
    return candles;
  }

  private async syncClock(): Promise<void> {
    const everyMs = this.deps.config.clock_sync_min * 60_000;
    if (this.lastClockSync && this.now() - this.lastClockSync < everyMs) return;
    const before = this.now();
    const server = await this.deps.client.serverTime();
    const after = this.now();
    this.clockOffsetMs = Math.round((before + after) / 2 - server);
    this.st.clockOffsetMs = this.clockOffsetMs;
    this.lastClockSync = after;
    if (Math.abs(this.clockOffsetMs) > 1000) this.log(`local clock is ${this.clockOffsetMs} ms off Binance; using Binance time`);
  }

  private updateState(symbols: string[], now: number): void {
    const staleAfter = this.deps.config.stall_after_sec * 1000;
    // Normally the newest 1m close is under a minute old; older than staleAfter means candles are missing.
    const stalled = symbols.filter((s) => now - (this.st.lastCloseTime[s] ?? 0) > staleAfter);
    const next = stalled.length ? 'stalled' : 'live';
    if (next !== this.st.state) this.log(next === 'stalled' ? `stalled: no new 1m candles for ${stalled.join(', ')}` : 'live');
    this.st.state = next;
  }

  private fail(err: unknown, where = 'poll'): void {
    const msg = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    this.st.lastError = msg;
    this.log(`error ${msg}`);
  }
}

/** Runs `work` over `items` with at most `limit` in flight. */
async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
