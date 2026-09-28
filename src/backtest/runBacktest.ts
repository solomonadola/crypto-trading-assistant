/**
 * Replays the auto-pilot over historical 5-minute candles, using the app's own
 * code at every step: the coin built from a 24h ticker (binanceService), the
 * candle analysis (marketAnalysisService), the scanner (entryScannerService),
 * the entry decision and regime gates (autopilotEngine, marketRegimeService),
 * sizing and the trade record (entryScannerService), the exit ladder
 * (cycleEngineService), the candle path within a bar (catchUpService) and the
 * stale-trade recycle (bankrollService). Nothing here decides anything the
 * live app decides; it only rebuilds what the app would have seen, bar by bar.
 *
 * Pure: the caller loads the candles and supplies the clock (tools/backtest.mjs
 * installs a simulated Date, because the regime gates, the loss-streak breaker,
 * the monthly cap and the stale-trade rule all read the current time).
 *
 * What the app sees live and history cannot give back is listed in
 * `limitations` on every result.
 */
import { AutomatedTradeRecord, BankrollConfig } from '../types/automatedFeed';
import type { CryptoCoin } from '../types';
import type {
  BacktestPeriodRow,
  BacktestPoint,
  BacktestResult,
  BacktestSummary,
  BacktestTrade,
} from '../types/backtest';
import type { Candle } from '../services/candleService';
import { aggregate, type BarSeries } from './candles';

export { aggregate, type BarSeries };
import { assetFor, coinFromTicker } from '../services/binanceService';
import { analyzeFromCandles, type CoinAnalysis } from '../services/marketAnalysisService';
import { scanLiveMarketEntries, buildTradeRecord, resolveDeployTrancheUSD } from '../services/entryScannerService';
import { computePacing, selectAutoPilotCandidate } from '../services/autopilotEngine';
import { calculateBankrollState, isTradeZombieStale, DEFAULT_BANKROLL_CONFIG } from '../services/bankrollService';
import { evaluateTradeCycle, recycleStaleTrade, closeTradeAt } from '../services/cycleEngineService';
import { pricePathForBar } from '../services/catchUpService';
import { netPnlUSD, feesUSD, outcome } from '../services/metrics';
import { AUTOPILOT_CONFIG } from '../config/autopilot';
import { LEVEL_GATES_ACTIVE } from '../config/entry';
import { StrategyProfileId, setActiveStrategyProfile } from '../config/geometry';
import { UNIVERSE_CONFIG } from '../config/universe';
import { costPerSideRate } from '../config/costs';

const M5 = 5 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * H1;
const D1 = 24 * H1;
const BARS_24H = 288;
/** Live candle counts (marketAnalysisService NEEDED), the forming candle included. */
const NEED_1H = 200;
const NEED_4H = 300;
const NEED_1D = 220;
/** Live keeps a 1h series for about 10 minutes (candleService TTL). */
const ANALYSIS_REFRESH_MS = 10 * 60_000;


export interface BacktestOptions {
  from: number;
  to: number;
  profile: StrategyProfileId;
  allowShorts: boolean;
  startingCapitalUSD: number;
  dataSource: string;
  /**
   * What-if on the stale-trade recycle (bankrollService): false turns it off,
   * a number replaces its hours. Omitted, the app's own setting applies.
   */
  staleRecycle?: false | { hours: number };
  /** Moves the simulated clock that Date.now() and new Date() read. */
  setClock: (ms: number) => void;
  onProgress?: (p: { t: number; fraction: number; trades: number; equityUSD: number }) => void;
}

interface Prepared {
  s: BarSeries;
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
  /** index of the current bar, advanced with the clock */
  ptr: number;
  analysis: CoinAnalysis | null;
  analysisAt: number;
}


/**
 * The candles live would have fetched at `now` (the close of bar `i`): the
 * last `need - 1` completed candles and the one still forming, built only
 * from bars that have closed. No later bar is ever read.
 */
function candlesAt(p: Prepared, agg: Candle[], len: number, i: number, now: number, need: number): Candle[] {
  let lo = 0;
  let hi = agg.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (agg[mid].t + len <= now) lo = mid + 1; else hi = mid;
  }
  const completed = lo;
  const out = agg.slice(Math.max(0, completed - (need - 1)), completed);
  const bucket = Math.floor((now - 1) / len) * len;
  if (bucket + len > now) {
    const s = p.s;
    let j = i;
    while (j > 0 && s.t[j - 1] >= bucket) j--;
    if (s.t[j] >= bucket && j <= i) {
      const forming: Candle = { t: bucket, o: s.o[j], h: s.h[j], l: s.l[j], c: s.c[j], v: 0 };
      for (let k = j; k <= i; k++) {
        if (s.h[k] > forming.h) forming.h = s.h[k];
        if (s.l[k] < forming.l) forming.l = s.l[k];
        forming.c = s.c[k];
        forming.v += s.v[k];
      }
      out.push(forming);
    }
  }
  return out;
}

/** The /ticker/24hr fields at the close of bar `i`: a rolling 24h window, as Binance computes it. */
export function tickerAt(s: BarSeries, i: number) {
  let hi = -Infinity;
  let lo = Infinity;
  let qv = 0;
  for (let j = i - BARS_24H + 1; j <= i; j++) {
    if (s.h[j] > hi) hi = s.h[j];
    if (s.l[j] < lo) lo = s.l[j];
    qv += s.qv[j];
  }
  const price = s.c[i];
  const open = s.o[i - BARS_24H + 1];
  return {
    lastPrice: String(price),
    priceChange: String(price - open),
    priceChangePercent: String(((price - open) / open) * 100),
    highPrice: String(hi),
    lowPrice: String(lo),
    quoteVolume: String(qv),
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function tally(rows: Map<string, BacktestPeriodRow>, key: string, t: BacktestTrade) {
  let r = rows.get(key);
  if (!r) { r = { key, trades: 0, wins: 0, netUSD: 0, feesUSD: 0 }; rows.set(key, r); }
  r.trades++;
  if (t.netUSD > 0.01) r.wins++;
  r.netUSD += t.netUSD;
  r.feesUSD += t.feesUSD;
}

const finishRows = (rows: Map<string, BacktestPeriodRow>) =>
  [...rows.values()].map((r) => ({ ...r, netUSD: round2(r.netUSD), feesUSD: round2(r.feesUSD) }));

export function runBacktest(seriesList: BarSeries[], opts: BacktestOptions): BacktestResult {
  const startedAt = Date.now();
  const profile = setActiveStrategyProfile(opts.profile);
  AUTOPILOT_CONFIG.allowShorts = opts.allowShorts;

  const zombieDefaults = DEFAULT_BANKROLL_CONFIG.zombieTradeRecycle!;
  const bankrollConfig: BankrollConfig = {
    ...DEFAULT_BANKROLL_CONFIG,
    zombieTradeRecycle: opts.staleRecycle === false
      ? { ...zombieDefaults, enabled: false }
      : opts.staleRecycle
      ? { ...zombieDefaults, maxStaleHours: opts.staleRecycle.hours }
      : zombieDefaults,
    totalBudgetUSD: opts.startingCapitalUSD,
    trancheSizeUSD: +(opts.startingCapitalUSD / (DEFAULT_BANKROLL_CONFIG.maxSlots || 5)).toFixed(2),
  };

  const btc = seriesList.find((s) => s.symbol === 'BTC');
  if (!btc) throw new Error('BTC candles are required: BTC is the market clock and the macro regime.');

  const prepared: Prepared[] = seriesList.map((s) => ({
    s, h1: aggregate(s, H1), h4: aggregate(s, H4), d1: aggregate(s, D1), ptr: 0, analysis: null, analysisAt: -Infinity,
  }));
  const bySymbol = new Map(prepared.map((p) => [p.s.symbol, p]));

  // The clock: every BTC bar in range with a full day of history behind it.
  const steps: number[] = [];
  for (let i = BARS_24H; i < btc.t.length; i++) {
    if (btc.t[i] >= opts.from && btc.t[i] + M5 <= opts.to) steps.push(i);
  }
  if (!steps.length) throw new Error('No candles in the requested range.');

  let trades: AutomatedTradeRecord[] = [];
  const entryInfo = new Map<string, { stopPct: number; score: number }>();
  const equity: BacktestPoint[] = [];
  const skip = new Map<string, number>();
  let lastDeployAt = 0;
  let peak = opts.startingCapitalUSD;
  let lastProgress = -1;
  const lastPrice = new Map<string, number>();

  for (let n = 0; n < steps.length; n++) {
    const t = btc.t[steps[n]];
    const now = t + M5;                 // decisions are made at the bar close
    opts.setClock(now);

    // Advance every coin to this bar. A coin with no bar at t (a gap, or not
    // listed yet) is simply not seen this step.
    const present: Array<{ p: Prepared; i: number }> = [];
    for (const p of prepared) {
      const ts = p.s.t;
      while (p.ptr < ts.length - 1 && ts[p.ptr] < t) p.ptr++;
      if (ts[p.ptr] === t) {
        present.push({ p, i: p.ptr });
        lastPrice.set(p.s.symbol, p.s.c[p.ptr]);
      }
    }
    const barOf = (sym: string) => {
      const p = bySymbol.get(sym.toUpperCase());
      if (!p || p.s.t[p.ptr] !== t) return null;
      const i = p.ptr;
      return { t, o: p.s.o[i], h: p.s.h[i], l: p.s.l[i], c: p.s.c[i] };
    };

    // 1. Exits: each open trade through this bar's path, then the stale rule.
    trades = trades.map((trade) => {
      if (trade.status !== 'OPEN') return trade;
      const bar = barOf(trade.symbol);
      if (!bar) return trade;
      let cur = trade;
      for (const price of pricePathForBar(cur, bar)) {
        cur = evaluateTradeCycle(cur, price).trade;
        if (cur.status !== 'OPEN') return { ...cur, closedAtTimestamp: now, exitPrice: price };
      }
      const zombie = bankrollConfig.zombieTradeRecycle;
      if (zombie?.enabled && zombie.autoRecycleToCash) {
        const stale = isTradeZombieStale(cur, zombie, bar.c);
        if (stale.isStale) return recycleStaleTrade(cur, bar.c, stale.reason, now);
      }
      return cur;
    });

    let bankroll = calculateBankrollState(trades, bankrollConfig);

    if (now % H1 === 0) {
      const eq = bankroll.totalPortfolioValueUSD;
      if (eq > peak) peak = eq;
      equity.push({
        t: now,
        equityUSD: round2(eq),
        drawdownPct: round2(peak > 0 ? ((eq - peak) / peak) * 100 : 0),
        openPositions: bankroll.activeTradesCount,
        btcHoldUSD: round2(opts.startingCapitalUSD * (btc.c[steps[n]] / btc.c[steps[0]])),
      });
    }

    // 2. Entry. The checks that need no market data go first, so the scan
    //    (the expensive part) only runs when a deploy is actually possible.
    const cheap = selectAutoPilotCandidate({
      signals: [], trades, bankroll,
      pacingInfo: { isDeployingAllowed: true } as ReturnType<typeof computePacing>,
      now, lastDeployAt,
    });
    let reason = cheap.reason || '';
    if (reason === 'No qualifying signal') {
      if (present.length < 10) {
        reason = 'Too few coins with data';
      } else {
        const coins: CryptoCoin[] = [];
        for (const { p, i } of present) {
          // A 24h window must be 24 hours of candles: across a hole in the
          // history it would span days and describe a market that never was.
          if (i < BARS_24H || p.s.t[i] - p.s.t[i - BARS_24H + 1] !== (BARS_24H - 1) * M5) continue;
          const coin = coinFromTicker(assetFor(p.s.symbol), tickerAt(p.s, i), 0.01, 0);
          if (!coin) continue;
          if (now - p.analysisAt >= ANALYSIS_REFRESH_MS) {
            p.analysis = analyzeFromCandles(
              p.s.c[i],
              candlesAt(p, p.h1, H1, i, now, NEED_1H),
              candlesAt(p, p.h4, H4, i, now, NEED_4H),
              candlesAt(p, p.d1, D1, i, now, NEED_1D),
              now
            );
            p.analysisAt = now;
          }
          if (p.analysis) coin.analysis = p.analysis;
          coins.push(coin);
        }
        coins.sort((a, b) => b.total_volume - a.total_volume).forEach((c, k) => { c.market_cap_rank = k + 1; });

        const pacingInfo = computePacing(coins, trades, true, bankroll.totalSlots, bankroll.totalPortfolioValueUSD);
        const decision = selectAutoPilotCandidate({
          signals: pacingInfo.isDeployingAllowed || !AUTOPILOT_CONFIG.enforceRegimeGates
            ? scanLiveMarketEntries(coins, 'FUTURES_1_2D')
            : [],
          trades, bankroll, pacingInfo, now, lastDeployAt,
        });
        reason = decision.reason || '';
        if (decision.signal) {
          try {
            const tranche = resolveDeployTrancheUSD(decision.signal, bankroll);
            const record = buildTradeRecord(decision.signal, tranche, now);
            trades = [...trades, record];
            entryInfo.set(record.id, { stopPct: Math.abs(record.stopLossPct || 0), score: decision.signal.score });
            lastDeployAt = now;
            reason = 'Deployed';
          } catch (err) {
            reason = err instanceof Error ? err.message : String(err);
          }
        }
      }
    }
    // Numbers in reasons ("$4.12", "12m left") would split one reason into many:
    // parentheticals holding them go, and any number left becomes #.
    const key = reason.replace(/\s*\([^)]*\d[^)]*\)/g, '').replace(/\$?-?\d+(\.\d+)?%?/g, '#').trim();
    skip.set(key, (skip.get(key) || 0) + 1);

    const fraction = n / steps.length;
    if (opts.onProgress && Math.floor(fraction * 100) !== lastProgress) {
      lastProgress = Math.floor(fraction * 100);
      bankroll = calculateBankrollState(trades, bankrollConfig);
      opts.onProgress({ t: now, fraction, trades: trades.length, equityUSD: bankroll.totalPortfolioValueUSD });
    }
  }

  // Whatever is still open is closed at the last price, with the exit cost.
  const end = btc.t[steps[steps.length - 1]] + M5;
  opts.setClock(end);
  trades = trades.map((t) => t.status === 'OPEN'
    ? { ...closeTradeAt(t, lastPrice.get(t.symbol.toUpperCase()) || t.currentPrice, 'BACKTEST_END', end), exitPrice: lastPrice.get(t.symbol.toUpperCase()) || t.currentPrice }
    : t);
  const finalBankroll = calculateBankrollState(trades, bankrollConfig);

  // ---------------------------------------------------------------- report
  const closed: BacktestTrade[] = trades.map((t) => {
    const info = entryInfo.get(t.id);
    const net = netPnlUSD(t);
    const riskUSD = (t.positionSizeUSD || 0) * ((info?.stopPct || 0) / 100);
    const tiers = t.harvestTiers
      ? [t.harvestTiers.tier1, t.harvestTiers.tier2, t.harvestTiers.tier3].filter((x) => x.status === 'HARVESTED').length
      : 0;
    return {
      id: t.id,
      symbol: t.symbol.toUpperCase(),
      direction: (t.direction || 'LONG') as 'LONG' | 'SHORT',
      openedAt: t.openedAtTimestamp || 0,
      closedAt: t.closedAtTimestamp || end,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice ?? t.currentPrice,
      positionSizeUSD: round2(t.positionSizeUSD || 0),
      pnlUSD: round2(t.pnlUSD),
      feesUSD: +feesUSD(t).toFixed(4),
      netUSD: +net.toFixed(4),
      netReturnPct: round2(t.positionSizeUSD ? (net / t.positionSizeUSD) * 100 : 0),
      rMultiple: riskUSD > 0 ? round2(net / riskUSD) : 0,
      exitReason: t.exitReason || t.status,
      tiersHit: tiers,
      score: info?.score ?? 0,
      holdHours: round2(((t.closedAtTimestamp || end) - (t.openedAtTimestamp || end)) / H1),
    };
  });

  const outcomes = trades.map(outcome);
  const wins = outcomes.filter((o) => o === 'WIN').length;
  const losses = outcomes.filter((o) => o === 'LOSS').length;
  const winSum = closed.filter((t) => t.netUSD > 0).reduce((a, t) => a + t.netUSD, 0);
  const lossSum = closed.filter((t) => t.netUSD < 0).reduce((a, t) => a + t.netUSD, 0);
  const netProfit = closed.reduce((a, t) => a + t.netUSD, 0);
  const fees = closed.reduce((a, t) => a + t.feesUSD, 0);

  let maxDdPct = 0;
  let maxDdUSD = 0;
  let runPeak = opts.startingCapitalUSD;
  for (const p of equity) {
    if (p.equityUSD > runPeak) runPeak = p.equityUSD;
    maxDdPct = Math.min(maxDdPct, p.drawdownPct);
    maxDdUSD = Math.min(maxDdUSD, p.equityUSD - runPeak);
  }

  // Buy and hold, for scale: what the same coins did with no trading at all.
  const firstIdx = steps[0];
  const lastIdx = steps[steps.length - 1];
  const holdReturns: number[] = [];
  for (const p of prepared) {
    const ts = p.s.t;
    const a = ts.findIndex((x) => x >= btc.t[firstIdx]);
    let b = ts.length - 1;
    while (b > 0 && ts[b] > btc.t[lastIdx]) b--;
    if (a >= 0 && b > a && ts[a] - btc.t[firstIdx] < 7 * D1) holdReturns.push(p.s.c[b] / p.s.c[a] - 1);
  }
  const benchmark = holdReturns.length ? holdReturns.reduce((x, y) => x + y, 0) / holdReturns.length : 0;

  const spanMonths = (end - btc.t[firstIdx]) / (30.44 * D1);
  const summary: BacktestSummary = {
    trades: closed.length,
    wins,
    losses,
    breakeven: closed.length - wins - losses,
    winRatePct: closed.length ? round2((wins / closed.length) * 100) : 0,
    netProfitUSD: round2(netProfit),
    grossProfitUSD: round2(closed.reduce((a, t) => a + t.pnlUSD, 0)),
    feesUSD: round2(fees),
    totalReturnPct: round2((netProfit / opts.startingCapitalUSD) * 100),
    profitFactor: lossSum < 0 ? round2(winSum / -lossSum) : null,
    expectancyUSD: closed.length ? +(netProfit / closed.length).toFixed(4) : 0,
    avgR: closed.length ? round2(closed.reduce((a, t) => a + t.rMultiple, 0) / closed.length) : 0,
    avgWinUSD: wins ? +(winSum / wins).toFixed(4) : 0,
    avgLossUSD: losses ? +(lossSum / losses).toFixed(4) : 0,
    maxDrawdownPct: round2(maxDdPct),
    maxDrawdownUSD: round2(maxDdUSD),
    avgHoldHours: closed.length ? round2(closed.reduce((a, t) => a + t.holdHours, 0) / closed.length) : 0,
    tradesPerMonth: spanMonths > 0 ? round2(closed.length / spanMonths) : 0,
    bestTradeUSD: closed.length ? round2(Math.max(...closed.map((t) => t.netUSD))) : 0,
    worstTradeUSD: closed.length ? round2(Math.min(...closed.map((t) => t.netUSD))) : 0,
    endingEquityUSD: round2(finalBankroll.totalPortfolioValueUSD),
    benchmarkReturnPct: round2(benchmark * 100),
    btcReturnPct: round2((btc.c[lastIdx] / btc.c[firstIdx] - 1) * 100),
  };

  const monthly = new Map<string, BacktestPeriodRow>();
  const sym = new Map<string, BacktestPeriodRow>();
  const exits = new Map<string, BacktestPeriodRow>();
  const dirs = new Map<string, BacktestPeriodRow>();
  for (const t of closed) {
    tally(monthly, new Date(t.closedAt).toISOString().slice(0, 7), t);
    tally(sym, t.symbol, t);
    tally(exits, t.exitReason, t);
    tally(dirs, t.direction, t);
  }
  // Month return on mark-to-market equity, so a month is judged on what the
  // account was worth, not only on what closed in it.
  const monthStart = new Map<string, number>();
  const monthEnd = new Map<string, number>();
  for (const p of equity) {
    const k = new Date(p.t - 1).toISOString().slice(0, 7);
    if (!monthStart.has(k)) monthStart.set(k, p.equityUSD);
    monthEnd.set(k, p.equityUSD);
  }
  let prevEnd = opts.startingCapitalUSD;
  for (const k of [...monthEnd.keys()].sort()) {
    if (!monthly.has(k)) monthly.set(k, { key: k, trades: 0, wins: 0, netUSD: 0, feesUSD: 0 });
    const endEq = monthEnd.get(k)!;
    monthly.get(k)!.returnPct = round2(prevEnd > 0 ? ((endEq - prevEnd) / prevEnd) * 100 : 0);
    prevEnd = endEq;
  }

  // Holes in the BTC history inside the range, so a result never hides them.
  const gaps: string[] = [];
  for (let k = 1; k < steps.length; k++) {
    const a = btc.t[steps[k - 1]];
    const b = btc.t[steps[k]];
    if (b - a > D1) gaps.push(`${new Date(a + M5).toISOString().slice(0, 10)} to ${new Date(b).toISOString().slice(0, 10)}`);
  }

  const symbols = prepared
    .filter((p) => p.s.t.length && p.s.t[p.s.t.length - 1] >= opts.from && p.s.t[0] < opts.to)
    .map((p) => p.s.symbol);

  return {
    id: '',
    createdAt: startedAt,
    durationMs: Date.now() - startedAt,
    settings: {
      profile: profile.id,
      allowShorts: opts.allowShorts,
      from: btc.t[firstIdx],
      to: end,
      startingCapitalUSD: opts.startingCapitalUSD,
      symbols,
      entryGates: LEVEL_GATES_ACTIVE,
      minScore: AUTOPILOT_CONFIG.minScore,
      maxConcurrentTrades: Math.min(AUTOPILOT_CONFIG.maxConcurrentTrades, bankrollConfig.maxSlots || 5),
      costPerSidePct: +(costPerSideRate() * 100).toFixed(3),
      dataSource: opts.dataSource,
      staleRecycleHours: bankrollConfig.zombieTradeRecycle?.enabled
        ? isTradeZombieStale({ status: 'OPEN' } as AutomatedTradeRecord, bankrollConfig.zombieTradeRecycle).thresholdHours
        : null,
    },
    summary,
    equity,
    monthly: finishRows(monthly).sort((a, b) => a.key.localeCompare(b.key)),
    bySymbol: finishRows(sym).sort((a, b) => b.netUSD - a.netUSD),
    byExitReason: finishRows(exits).sort((a, b) => b.trades - a.trades),
    byDirection: finishRows(dirs),
    skipReasons: [...skip.entries()].map(([reason, n]) => ({ reason, steps: n })).sort((a, b) => b.steps - a.steps).slice(0, 25),
    trades: closed.sort((a, b) => a.openedAt - b.openedAt),
    limitations: [
      ...(gaps.length ? [`No candles for ${gaps.join(', ')}: nothing was traded then, open positions were carried across at their last price, and the first day after each hole scans no coin until it has 24 hours of candles again.`] : []),
      `Coins: the ${symbols.length} with downloaded candles, not the live volume-ranked list of ${UNIVERSE_CONFIG.size}. A coin enters when its data starts.`,
      'Funding rates are not in the candle history: every coin reads the app default of 0.01%, so the funding filters never refuse an entry.',
      'Prices are 5-minute candles walked open, adverse extreme, targets, favourable extreme, close (the catch-up order): a stop is always assumed to fill before a target inside the same candle, and at its level unless the candle opened past it.',
      'Decisions are made once per 5-minute close; live checks every 10-30 seconds, so some entries and stale-trade exits land a few minutes differently.',
      'Order flow is derived from the 24h ticker, as it is live, so it is reproduced exactly; there is no order-book history.',
      'Costs: 15 bps per side on every fill (config/costs.ts). Funding payments on held positions are not charged.',
    ],
  };
}
