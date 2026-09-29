// Stage A of the backtest: replay history through the real engine in research
// mode (every confirmed setup is traded at a fixed size, whatever its checks
// said) and record each trade with everything its signal measured. Stage B
// (optimize.ts) then tests combinations of checks on these trades.
//
// The engine is the live one: same sessions, setups, filters, exits, fees and
// funding. The universe is rebuilt every hour from the history itself with the
// scanner's own rules.
import Database from 'better-sqlite3';
import { CandleStore } from '../feed/candleStore';
import { replayCandles } from '../feed/replayFeed';
import { Engine } from '../core/engine';
import { atr } from '../analysis/indicators';
import { prefilter, rank } from '../scanner';
import type { EngineConfig } from '../config';
import { compareCandles, type Candle, type SignalRecord, type Timeframe } from '../../../shared/types';

export interface ResearchTrade {
  symbol: string;
  side: 'long' | 'short';
  signalTime: number;
  openedAt: number;
  closedAt: number;
  session: string | null;
  reason: string;
  /** Net result in multiples of the money at risk at entry. */
  r: number;
  stopPct: number;
  rewardRisk: number;
  score: number;
  /** Checks that failed, by name (session, filters, stop, reward/risk, score). */
  failures: string[];
  /** Relative volume on the trigger candle and whether the other fakeout conditions passed. */
  fakeoutRvol: number | null;
  fakeoutOtherPass: boolean | null;
}

export interface ResearchRun {
  label: string;
  from: number;
  to: number;
  symbols: string[];
  trades: ResearchTrade[];
  confirmed: number;
  seconds: number;
}

export interface ResearchOptions {
  dbPath: string;
  config: EngineConfig;
  /** The setup to research (default: the pullback), with its parameters. */
  setup?: NonNullable<ConstructorParameters<typeof Engine>[0]['research']>['setup'];
  params?: NonNullable<ConstructorParameters<typeof Engine>[0]['research']>['params'];
  label: string;
  from: number;
  to: number;
  onProgress?: (t: number, trades: number) => void;
  /**
   * 4x slower: each timeframe the engine expects is fed the next one up
   * (15m for 5m, 1h for 15m, 4h for 1h, daily for 4h, built from 4h). Times
   * stay real, so sessions and funding are unchanged.
   */
  slow?: boolean;
}

const SLOW: Partial<Record<Timeframe, Timeframe | '1d'>> = { '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d' };

/** Daily candles from complete UTC days of 4h candles. */
export function daily(h4: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 6 <= h4.length; i++) {
    const g = h4.slice(i, i + 6);
    if (g[0].openTime % DAY !== 0 || g[5].closeTime !== g[0].openTime + DAY) continue;
    out.push({
      ...g[0], closeTime: g[5].closeTime, close: g[5].close, high: Math.max(...g.map((c) => c.high)), low: Math.min(...g.map((c) => c.low)),
      volume: g.reduce((a, c) => a + c.volume, 0), quoteVolume: g.reduce((a, c) => a + c.quoteVolume, 0), trades: g.reduce((a, c) => a + c.trades, 0),
    });
    i += 5;
  }
  return out;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

export function runResearch(o: ResearchOptions): ResearchRun {
  const t0 = Date.now();
  const db = new Database(o.dbPath, { readonly: true });
  const store = new CandleStore(db);
  const meta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const symbols: string[] = JSON.parse((meta.get('symbols') as { value: string }).value);
  const fundingAt = db.prepare('SELECT symbol, rate FROM funding WHERE time = ?');

  const engine = new Engine({ config: o.config, configHash: 'backtest', engineVersion: 'backtest', research: { notional: 1000, setup: o.setup, params: o.params }, analysisExtras: false });
  // Only coins that matter are fed (the universe, BTC, and coins with open positions); a coin gets its
  // recent history when it joins, as the live feed does. Feeding all of them would only slow the replay.
  const fed = new Set<string>();
  // The candles the engine sees as `tf`: the store's own, or in slow mode the next timeframe up, relabelled.
  const load = (s: string, tf: Timeframe, n: number, t: number): Candle[] => {
    if (!o.slow) return store.latest(s, tf, n, t);
    const src = SLOW[tf];
    if (!src) throw new Error(`slow mode has no source for ${tf}`);
    const list = src === '1d' ? daily(store.latest(s, '4h', 6 * n + 6, t)).slice(-n) : store.latest(s, src, n, t);
    return list.map((c) => ({ ...c, tf }));
  };
  const replayed = (symbols: string[], from: number, to: number): Candle[][] => {
    if (!o.slow) return [...replayCandles(store, { symbols, timeframes: o.config.feed.timeframes, from, to, chunkMs: HOUR })];
    const label = new Map(o.config.feed.timeframes.map((tf) => [SLOW[tf], tf]));
    const src = [...label.keys()].filter((tf): tf is Timeframe => tf !== undefined && tf !== '1d');
    const out: Candle[] = [];
    for (const batch of replayCandles(store, { symbols, timeframes: src, from, to, chunkMs: HOUR })) {
      for (const c of batch) {
        out.push({ ...c, tf: label.get(c.tf)! });
        if (c.tf === '4h' && label.has('1d') && c.closeTime % DAY === 0) {
          const d = daily(store.latest(c.symbol, '4h', 6, c.closeTime));
          if (d.length) out.push({ ...d[0], tf: label.get('1d')! });
        }
      }
    }
    return out.length ? [out.sort(compareCandles)] : [];
  };
  const feed = (s: string, t: number) => {
    if (fed.has(s)) return;
    fed.add(s);
    for (const tf of o.config.feed.timeframes) engine.seedHistory(load(s, tf, o.config.feed.history[tf] ?? 500, t));
  };
  feed('BTCUSDT', o.from);

  // The scanner's rules on the history: 24h volume and change from 1h candles, 1h ATR%.
  const universeAt = (t: number): string[] => {
    const tickers = [];
    const atrPct = new Map<string, number>();
    for (const s of symbols) {
      const h = store.latest(s, '1h', 30, t);
      if (h.length < 25) continue;
      const day = h.slice(-24);
      tickers.push({ symbol: s, lastPrice: day[23].close, priceChangePercent: (day[23].close / day[0].open - 1) * 100, quoteVolume: day.reduce((x, c) => x + c.quoteVolume, 0) });
      const a = atr(h.map((c) => c.high), h.map((c) => c.low), h.map((c) => c.close), 14);
      atrPct.set(s, (a[a.length - 1] / h[h.length - 1].close) * 100);
    }
    const info = symbols.map((s) => ({ symbol: s, baseAsset: s.replace(/USDT$/, ''), tickSize: 0, stepSize: 0, minQty: 0, minNotional: 5 }));
    const { candidates, dropped } = prefilter(tickers, info, o.config.scanner);
    return rank(candidates, atrPct, o.config.scanner, dropped).map((r) => r.symbol);
  };

  const confirmed = new Map<string, SignalRecord>();
  for (let hour = Math.floor(o.from / HOUR) * HOUR; hour < o.to; hour += HOUR) {
    const universe = universeAt(hour);
    engine.setUniverse(universe);
    const needed = new Set(['BTCUSDT', ...universe, ...engine.account().positions.map((p) => p.symbol), ...engine.account().pendingEntries.map((p) => p.symbol)]);
    for (const s of needed) feed(s, Math.max(hour, o.from));
    for (const s of fed) if (!needed.has(s)) fed.delete(s);
    // Funding charged at 00/08/16 UTC uses the rate for that time.
    const next = hour + HOUR;
    if (next % (8 * HOUR) === 0) for (const f of fundingAt.all(next) as { symbol: string; rate: number }[]) engine.onFunding(f.symbol, f.rate);
    for (const batch of replayed([...fed], Math.max(hour, o.from) + 1, next + 1)) {
      engine.onCandles(batch as Candle[]);
    }
    for (const s of engine.takeSignals()) if (s.status === 'taken' || s.status === 'filtered') confirmed.set(String(s.payload.armedId), s);
    engine.takeShadowResults();
    if (o.onProgress && hour % DAY === 0) o.onProgress(hour, engine.closedTrades().length);
  }

  const trades: ResearchTrade[] = [];
  for (const t of engine.closedTrades()) {
    const sig = t.signalId ? confirmed.get(t.signalId) : undefined;
    if (!sig || !t.riskUsd) continue;
    const p = sig.payload as Record<string, any>;
    const fake = (p.filters as { name: string; pass: boolean; detail: Record<string, number> }[] | undefined)?.find((f) => f.name === 'fakeout');
    const d = fake?.detail;
    trades.push({
      symbol: t.symbol, side: t.side, signalTime: sig.time, openedAt: t.openedAt, closedAt: t.closedAt, session: t.session, reason: t.reason,
      r: t.pnl / t.riskUsd,
      stopPct: p.plan.stopDistancePct, rewardRisk: p.plan.rewardRisk, score: p.score.total,
      failures: p.failures as string[],
      fakeoutRvol: d ? d.rvol : null,
      fakeoutOtherPass: d ? d.closeBeyondAtr >= d.minBeyond && d.closePosition >= d.minClosePosition && d.oppositeWick <= d.maxWick : null,
    });
  }
  db.close();
  return { label: o.label, from: o.from, to: o.to, symbols, trades, confirmed: confirmed.size, seconds: Math.round((Date.now() - t0) / 1000) };
}
