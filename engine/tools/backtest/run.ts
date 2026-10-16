// Backtest runner: feeds historical candles through Engine and decideScalp.
// Pure simulation: zero lookahead, honest limit fills, realistic costs and stops.
import { Engine } from '../../src/core/engine';
import { loadConfig, configHash, type EngineConfig } from '../../src/config';
import type { CandleStore } from '../../src/feed/candleStore';
import { decideScalp } from '../../src/strategy/scalpAutopilot';
import { killzoneSweep, sweepMarket } from '../../src/strategy/killzoneSweep';
import { windowAt } from '../../src/sessions';
import { limitRoundTripPct, costsFor } from '../../src/speed';
import { compareCandles, type Candle, type ClosedTradeView, type Direction, type Timeframe } from '../../../shared/types';
import type { ScalpKind } from '../../src/analysis/scalp';
import type { SymbolInfo } from '../../src/feed/binancePublic';
import type { SymbolRules } from '../../src/risk';

export interface BacktestRunOptions {
  config?: EngineConfig;
  configOverrides?: Record<string, unknown>;
  store: CandleStore;
  symbols: string[];
  rules: Map<string, SymbolInfo>;
  fromMs: number;
  toMs: number;
  models?: Array<'scalp' | 'zone_sweep' | 'session_sweep' | 'htf_poi'>;
  kinds?: ScalpKind[];
  onProgress?: (progress: { day: string; candlesProcessed: number; tradesCount: number; equity: number }) => void;
}

export interface PlacedOrderRecord {
  symbol: string;
  side: Direction;
  /** A classic scalp kind, or 'killzone_sweep'. */
  kind: string;
  tf: string;
  time: number;
  limitPrice: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  balance: number;
}

export interface BacktestResult {
  config: EngineConfig;
  fromMs: number;
  toMs: number;
  symbols: string[];
  trades: ClosedTradeView[];
  positionMeta: Map<string, { kind: string; tf: string; side: Direction }>;
  ordersPlaced: PlacedOrderRecord[];
  rejections: Map<string, number>;
  equityCurve: EquityPoint[];
}

export async function runBacktest(opts: BacktestRunOptions): Promise<BacktestResult> {
  const cfg = opts.config ?? loadConfig();

  const runScalp = opts.models ? opts.models.includes('scalp') : true;

  // Apply model selections
  if (opts.models) {
    cfg.models.zone_sweep = opts.models.includes('zone_sweep');
    cfg.models.session_sweep = opts.models.includes('session_sweep');
    cfg.models.htf_poi = opts.models.includes('htf_poi');
  }

  const engine = new Engine({
    config: cfg,
    configHash: configHash(cfg),
    engineVersion: 'backtest',
  });

  engine.setUniverse(opts.symbols);
  const rulesRecord: Record<string, SymbolRules> = {};
  for (const [s, r] of opts.rules) rulesRecord[s] = r;
  engine.setSymbolRules(rulesRecord);

  const tfs: Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];
  const warmupDays = 30;
  const warmupFrom = Math.max(0, opts.fromMs - warmupDays * 86_400_000);

  // In-memory rolling windows per symbol and timeframe
  const windows = new Map<string, Candle[]>();
  const getWindow = (sym: string, tf: string): Candle[] => {
    const key = `${sym}:${tf}`;
    let w = windows.get(key);
    if (!w) {
      w = [];
      windows.set(key, w);
    }
    return w;
  };

  const pushToWindow = (c: Candle, maxKeep: number) => {
    const w = getWindow(c.symbol, c.tf);
    w.push(c);
    if (w.length > maxKeep) w.splice(0, w.length - maxKeep);
  };

  // Seed warm-up history
  const warmupBatch: Candle[] = [];
  for (const sym of opts.symbols) {
    for (const tf of tfs) {
      const candles = opts.store.range(sym, tf, warmupFrom, opts.fromMs - 1);
      for (const c of candles) {
        warmupBatch.push(c);
        const maxKeep = tf === '1m' ? 360 : tf === '5m' ? 360 : tf === '15m' ? 240 : 200;
        pushToWindow(c, maxKeep);
      }
    }
  }
  // Also seed BTCUSDT 1h for dumping check if not already in symbols
  if (!opts.symbols.includes('BTCUSDT')) {
    const btc1h = opts.store.range('BTCUSDT', '1h', warmupFrom, opts.fromMs - 1);
    for (const c of btc1h) pushToWindow(c, 50);
  }

  warmupBatch.sort(compareCandles);
  engine.seedHistory(warmupBatch);

  const positionMeta = new Map<string, { kind: string; tf: string; side: Direction }>();
  const ordersPlaced: PlacedOrderRecord[] = [];
  const rejections = new Map<string, number>();
  const equityCurve: EquityPoint[] = [];

  let candlesProcessed = 0;
  const dayMs = 86_400_000;

  for (let dayStart = opts.fromMs; dayStart < opts.toMs; dayStart += dayMs) {
    const dayEnd = Math.min(dayStart + dayMs - 1, opts.toMs);
    const dayCandles: Candle[] = [];

    for (const sym of opts.symbols) {
      for (const tf of tfs) {
        const cs = opts.store.range(sym, tf, dayStart, dayEnd);
        dayCandles.push(...cs);
      }
    }
    if (!opts.symbols.includes('BTCUSDT')) {
      const btc = opts.store.range('BTCUSDT', '1h', dayStart, dayEnd);
      dayCandles.push(...btc);
    }

    if (!dayCandles.length) continue;
    dayCandles.sort(compareCandles);

    // Group by closeTime
    let i = 0;
    while (i < dayCandles.length) {
      const closeTime = dayCandles[i].closeTime;
      const group: Candle[] = [];
      while (i < dayCandles.length && dayCandles[i].closeTime === closeTime) {
        group.push(dayCandles[i]);
        i++;
      }

      // Update engine
      engine.onCandles(group);
      candlesProcessed += group.length;

      // Update rolling windows
      for (const c of group) {
        const maxKeep = c.tf === '1m' ? 360 : c.tf === '5m' ? 360 : c.tf === '15m' ? 240 : 200;
        pushToWindow(c, maxKeep);
      }

      // Run scalp decision logic on 5m and 15m closed candles
      if (runScalp) {
        const scalpCandidates = group.filter((c) => (c.tf === '5m' || c.tf === '15m') && opts.symbols.includes(c.symbol));
        for (const c of scalpCandidates) {
          const tf = c.tf as '5m' | '15m';
          const held = engine.positions().some((p) => p.symbol === c.symbol) ||
                       engine.account().pendingEntries.some((p) => p.symbol === c.symbol);
          if (held) continue;

          // Hunter enters with resting limit orders: maker fee in, taker with slippage out.
          const costPct = limitRoundTripPct(costsFor(cfg, engine.speed(c.symbol)));
          const place = (o: {
            symbol: string; side: Direction; kind: string; tf: '5m' | '15m'; limitPrice: number; stop: number; target: number;
            note: string; maxHoldMin: number; entryTimeoutMin: number; progressCheckMin?: number; progressMinR?: number;
          }) => {
            try {
              const produced = engine.onCommand({
                type: 'open', symbol: o.symbol, side: o.side, price: o.limitPrice, time: c.closeTime,
                stop: o.stop, target: o.target, orderType: 'limit', setup: 'scalp', note: o.note,
                maxHoldMin: o.maxHoldMin, entryTimeoutMin: o.entryTimeoutMin,
                progressCheckMin: o.progressCheckMin, progressMinR: o.progressMinR,
              });
              const placed = produced.find((x) => x.type === 'order_placed');
              if (placed?.positionId) positionMeta.set(placed.positionId, { kind: o.kind, tf: o.tf, side: o.side });
              ordersPlaced.push({ symbol: o.symbol, side: o.side, kind: o.kind, tf: o.tf, time: c.closeTime, limitPrice: o.limitPrice });
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
            }
          };

          // Hunter's main strategy: the killzone sweep, on 5m closes (same code as live).
          if (cfg.scalp_autopilot.killzone_sweep.enabled && tf === '5m' && !opts.kinds) {
            const kz = killzoneSweep({
              symbol: c.symbol,
              market: sweepMarket(engine.latestContext(c.symbol)),
              m5: getWindow(c.symbol, '5m').slice(-120),
              killzone: windowAt(c.closeTime, cfg.scalp_autopilot.killzone_sweep.windows),
              costPct,
              minRr: cfg.exits.min_rr,
              config: cfg.scalp_autopilot.killzone_sweep,
            });
            if (kz.order) {
              place({ ...kz.order, kind: 'killzone_sweep' });
              continue;
            }
          }

          // The classic scalp setups: those in scalp_autopilot.kinds, or the --kinds given.
          const kinds = opts.kinds ?? cfg.scalp_autopilot.kinds;
          if (!kinds.length) continue;
          const candlesTf = getWindow(c.symbol, tf);
          const candles1h = getWindow(c.symbol, '1h');
          const btc1h = getWindow('BTCUSDT', '1h');
          const fromTime = candlesTf[0]?.openTime ?? c.openTime;
          const sessionOpens = engine.sessions.between(fromTime, c.openTime + 300_000)
            .filter((sn) => sn.name === 'london' || sn.name === 'newyork').map((sn) => sn.openTime);
          const decision = decideScalp({
            symbol: c.symbol,
            tf,
            candles: candlesTf,
            candles1h,
            btc1h,
            sessionOpens,
            costPct,
            now: c.closeTime,
            config: { ...cfg.scalp_autopilot, kinds },
          });
          if (decision.order) place(decision.order);
        }
      }

      // Periodically record equity
      if (closeTime % 300_000 === 0) {
        const acc = engine.account();
        equityCurve.push({ time: closeTime, equity: acc.equity, balance: acc.balance });
      }
    }

    if (opts.onProgress) {
      const acc = engine.account();
      opts.onProgress({
        day: new Date(dayStart).toISOString().slice(0, 10),
        candlesProcessed,
        tradesCount: engine.closedTrades().length,
        equity: acc.equity,
      });
    }
  }

  return {
    config: cfg,
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    symbols: opts.symbols,
    trades: engine.closedTrades(),
    positionMeta,
    ordersPlaced,
    rejections,
    equityCurve,
  };
}
