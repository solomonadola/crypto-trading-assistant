/**
 * Backtest for Supply & Demand Trend Pullback (src/strategies/trendPullbackDemand.ts).
 *
 * Decisions at every hourly close, from candles that have closed. Exits on
 * the 5-minute candles in between: stop tested before target inside a candle
 * (a gap past either fills at the open), out at market after maxHoldHours.
 * The account is cash plus open positions at market; every fill pays costs,
 * more for meme coins, whose spreads are wider.
 *
 * Pure: the caller loads the candles (tools/backtest.mjs --strategy trend-pullback).
 */
import type { Candle } from '../services/candleService';
import type { BacktestPeriodRow, BacktestPoint, BacktestResult, BacktestTrade } from '../types/backtest';
import { MEME_COINS } from '../types/entryScanner';
import { aggregate, type BarSeries } from './candles';
import {
  TREND_PULLBACK_CONFIG, TrendPullbackConfig, evaluateTrendPullback, btcAllows, isAboveTrendEma, ltfTrailLevel, type TradeSide,
} from '../strategies/trendPullbackDemand';

const M5 = 5 * 60_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const D1 = 24 * H1;
const BARS_24H = 288;

export interface StrategyBacktestOptions {
  from: number;
  to: number;
  startingCapitalUSD: number;
  dataSource: string;
  config?: Partial<TrendPullbackConfig>;
  variant?: string;
  /** Percent of equity lost if a stop is hit. */
  riskPerTradePct?: number;
  maxOpen?: number;
  maxMemeOpen?: number;
  /** A single position may use at most this share of equity (no leverage). */
  maxPositionPct?: number;
  costPerSidePct?: number;
  memeCostPerSidePct?: number;
  /** Also short, with the mirrored rules (needs futures to trade live). */
  allowShorts?: boolean;
  onProgress?: (p: { t: number; fraction: number; trades: number; equityUSD: number }) => void;
}

interface Position {
  symbol: string;
  direction: TradeSide;
  openedAt: number;
  entry: number;
  stop: number;
  target: number;
  units: number;
  sizeUSD: number;
  entryCostUSD: number;
  costRate: number;
  riskUSD: number;
  /** stop at entry, for R and for knowing whether the stop has moved */
  initialStop: number;
}

interface Coin {
  s: BarSeries;
  h1: Candle[];
  h4: Candle[];
  /** zone-timeframe and trigger-timeframe candles (the 4h and 1h in the swing version) */
  zc: Candle[];
  tc: Candle[];
  ptr: number;
  /** rolling 24h quote volume at ptr */
  qv24: number;
  qvFrom: number;
}

/** Candles that closed by `now`: binary search on open time + length. */
function closedBy(c: Candle[], len: number, now: number, count: number): Candle[] {
  let lo = 0;
  let hi = c.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid].t + len <= now) lo = mid + 1; else hi = mid;
  }
  return c.slice(Math.max(0, lo - count), lo);
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const tfName = (m: number) => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);

export function runStrategyBacktest(seriesList: BarSeries[], opts: StrategyBacktestOptions): BacktestResult {
  const startedAt = Date.now();
  const cfg: TrendPullbackConfig = { ...TREND_PULLBACK_CONFIG, ...(opts.config || {}) };
  const riskPct = opts.riskPerTradePct ?? 1;
  const maxOpen = opts.maxOpen ?? 5;
  const maxMeme = opts.maxMemeOpen ?? 2;
  const maxPosPct = opts.maxPositionPct ?? 30;
  const cost = (opts.costPerSidePct ?? 0.15) / 100;
  const memeCost = (opts.memeCostPerSidePct ?? 0.25) / 100;

  const btc = seriesList.find((s) => s.symbol === 'BTC');
  if (!btc) throw new Error('BTC candles are required (market filter and clock).');
  const btcDaily = aggregate(btc, D1);
  const ZTF = cfg.zoneTfMinutes * 60_000;
  const TTF = cfg.triggerTfMinutes * 60_000;
  const coins: Coin[] = seriesList.map((s) => {
    const h1 = aggregate(s, H1);
    const h4 = aggregate(s, H4);
    const pick = (len: number) => (len === H1 ? h1 : len === H4 ? h4 : aggregate(s, len));
    return { s, h1, h4, zc: pick(ZTF), tc: pick(TTF), ptr: 0, qv24: s.qv[0] || 0, qvFrom: 0 };
  });

  const steps: number[] = [];
  for (let i = BARS_24H; i < btc.t.length; i++) if (btc.t[i] >= opts.from && btc.t[i] + M5 <= opts.to) steps.push(i);
  if (!steps.length) throw new Error('No candles in the requested range.');

  let cash = opts.startingCapitalUSD;
  const open = new Map<string, Position>();
  const closed: BacktestTrade[] = [];
  const usedLevels = new Set<string>();
  const lastPrice = new Map<string, number>();
  const equity: BacktestPoint[] = [];
  const skip = new Map<string, number>();
  let peak = cash;
  let pausedUntil = 0;
  let lastProgress = -1;
  const btcStart = btc.c[steps[0]];

  // A long is worth units x price. A short holds its size as collateral and
  // gains what the price fell: units x (2 x entry - price).
  const valueOf = (p: Position, price: number) => (p.direction === 'LONG' ? p.units * price : p.units * (2 * p.entry - price));

  // Which sides the market filter allows now.
  const sides = (closes: number[], price: number): TradeSide[] =>
    (['LONG', 'SHORT'] as TradeSide[]).filter((side) => (side === 'LONG' || opts.allowShorts) && btcAllows(side, closes, price, cfg));

  const equityNow = () => {
    let v = cash;
    for (const p of open.values()) v += valueOf(p, lastPrice.get(p.symbol) ?? p.entry);
    return v;
  };

  const close = (p: Position, price: number, at: number, reason: string) => {
    const value = valueOf(p, price);
    const exitCost = p.units * price * p.costRate;   // the exit trade's notional
    cash += value - exitCost;
    open.delete(p.symbol);
    const gross = value - p.sizeUSD;
    const net = gross - exitCost - p.entryCostUSD;
    closed.push({
      id: `${p.symbol}-${p.openedAt}`,
      symbol: p.symbol,
      direction: p.direction,
      openedAt: p.openedAt,
      closedAt: at,
      entryPrice: p.entry,
      exitPrice: +price.toPrecision(8),
      positionSizeUSD: round2(p.sizeUSD),
      pnlUSD: +gross.toFixed(4),
      feesUSD: +(p.entryCostUSD + exitCost).toFixed(4),
      netUSD: +net.toFixed(4),
      netReturnPct: round2((net / p.sizeUSD) * 100),
      rMultiple: p.riskUSD > 0 ? round2(net / p.riskUSD) : 0,
      exitReason: reason,
      tiersHit: reason === 'TARGET_HIT' || reason === 'TRAILING_STOP_EXIT' ? 1 : 0,
      score: 0,
      holdHours: round2((at - p.openedAt) / H1),
    });
    // Losing streak: that many losses in a row pauses new entries.
    if (cfg.lossStreakLimit > 0) {
      const tail = closed.slice(-cfg.lossStreakLimit);
      if (tail.length === cfg.lossStreakLimit && tail.every((x) => x.netUSD < 0)) pausedUntil = at + cfg.lossStreakPauseHours * H1;
    }
  };

  for (let n = 0; n < steps.length; n++) {
    const t = btc.t[steps[n]];
    const now = t + M5;

    // Advance every coin; keep its rolling 24h quote volume.
    for (const c of coins) {
      const ts = c.s.t;
      while (c.ptr < ts.length - 1 && ts[c.ptr] < t) {
        c.ptr++;
        c.qv24 += c.s.qv[c.ptr];
        while (c.qvFrom < c.ptr && ts[c.ptr] - ts[c.qvFrom] >= D1) { c.qv24 -= c.s.qv[c.qvFrom]; c.qvFrom++; }
      }
      if (ts[c.ptr] === t) lastPrice.set(c.s.symbol, c.s.c[c.ptr]);
    }

    // Exits on this 5-minute candle: stop first, then target, then time.
    for (const p of [...open.values()]) {
      const c = coins.find((x) => x.s.symbol === p.symbol)!;
      if (c.s.t[c.ptr] !== t) continue;
      const i = c.ptr;
      const o = c.s.o[i], h = c.s.h[i], l = c.s.l[i], cl = c.s.c[i];
      const maxHold = (cfg.exitMode === 'ltfTrail' ? Math.max(cfg.maxHoldHours, 240) : cfg.maxHoldHours) * H1;
      const stopReason = p.stop !== p.initialStop ? 'TRAILING_STOP_EXIT' : 'STOP_LOSS_HIT';
      if (p.direction === 'LONG') {
        if (l <= p.stop) close(p, o < p.stop ? o : p.stop, now, stopReason);
        else if (h >= p.target) close(p, o > p.target ? o : p.target, now, 'TARGET_HIT');
        else if (now - p.openedAt >= maxHold) close(p, cl, now, 'TIME_EXIT');
      } else {
        if (h >= p.stop) close(p, o > p.stop ? o : p.stop, now, stopReason);
        else if (l <= p.target) close(p, o < p.target ? o : p.target, now, 'TARGET_HIT');
        else if (now - p.openedAt >= maxHold) close(p, cl, now, 'TIME_EXIT');
      }
    }

    if (now % H1 === 0 && cfg.exitMode === 'ltfTrail') {
      // 1h exit management: at +1R the stop goes to entry, then follows the
      // last 1h swing (never backwards, never through the current price).
      for (const p of open.values()) {
        const c = coins.find((x) => x.s.symbol === p.symbol)!;
        const price = lastPrice.get(p.symbol) ?? p.entry;
        const r = Math.abs(p.entry - p.initialStop);
        const long = p.direction === 'LONG';
        if ((long ? price - p.entry : p.entry - price) < r) continue;
        let next = long ? Math.max(p.stop, p.entry) : Math.min(p.stop, p.entry);
        const swing = ltfTrailLevel(closedBy(c.h1, H1, now, 30), p.direction);
        if (swing !== null && (long ? swing < price && swing > next : swing > price && swing < next)) next = swing;
        p.stop = next;
      }
    }

    if (now % H1 === 0) {
      const eq = equityNow();
      if (eq > peak) peak = eq;
      equity.push({
        t: now, equityUSD: round2(eq), drawdownPct: round2(peak > 0 ? ((eq - peak) / peak) * 100 : 0),
        openPositions: open.size, btcHoldUSD: round2(opts.startingCapitalUSD * (btc.c[steps[n]] / btcStart)),
      });

    }

    if (now % TTF === 0) {
      // Entries at each trigger-timeframe close.
      let reason = '';
      const btcCloses = closedBy(btcDaily, D1, now, cfg.btcSmaDays + cfg.btcSmaRisingDays + 10).map((c) => c.c);
      const btcPrice = btc.c[steps[n]];
      if (open.size >= maxOpen) reason = 'All slots full';
      else if (now < pausedUntil) reason = `Paused after ${cfg.lossStreakLimit} losses in a row`;
      else if (!sides(btcCloses, btcPrice).length) reason = opts.allowShorts ? 'BTC between regimes' : 'BTC below its daily average';
      else {
        const allowedSides = sides(btcCloses, btcPrice);
        // Market-wide inputs: breadth over the liquid coins, and BTC's week.
        const live = coins.filter((c) => c.s.t[c.ptr] === t && c.ptr >= BARS_24H && c.qv24 >= cfg.minQuoteVolume24hUSD);
        const breadthPct = cfg.minBreadthPct > 0 && live.length
          ? (live.filter((c) => isAboveTrendEma(closedBy(c.h4, H4, now, cfg.trendEmaPeriod + 20), c.s.c[c.ptr], cfg)).length / live.length) * 100
          : 100;
        const btcWeekAgo = btcCloses[btcCloses.length - 7];
        const btcReturn7dPct = btcWeekAgo ? ((btcPrice - btcWeekAgo) / btcWeekAgo) * 100 : 0;
        const candidates: Array<{ c: Coin; setup: NonNullable<ReturnType<typeof evaluateTrendPullback>['setup']> }> = [];
        const reasons = new Map<string, number>();
        for (const c of coins) {
          const sym = c.s.symbol;
          if (open.has(sym) || c.s.t[c.ptr] !== t) continue;
          // The last 24h must be 24 hours of candles, not a span across a hole in the data.
          if (c.ptr < BARS_24H || c.s.t[c.ptr] - c.s.t[c.ptr - BARS_24H + 1] !== (BARS_24H - 1) * M5) continue;
          const inputs = {
            price: c.s.c[c.ptr],
            quoteVolume24hUSD: c.qv24,
            // The inducement check walks the whole pullback leg on the 1h.
            h1: closedBy(c.tc, TTF, now, cfg.requireInducementSwept ? Math.ceil((cfg.zoneLookback4h * ZTF) / TTF) + 30 : cfg.touchWindow1h + 8),
            h4: closedBy(c.h4, H4, now, 120),
            zoneCandles: ZTF === H4 ? undefined : closedBy(c.zc, ZTF, now, cfg.zoneLookback4h + 60),
            btcDailyCloses: btcCloses,
            btcPrice,
            breadthPct,
            btcReturn7dPct,
          };
          for (const side of allowedSides) {
            const d = evaluateTrendPullback(inputs, cfg, side);
            if (d.setup && !usedLevels.has(`${sym}:${d.setup.key}`)) { candidates.push({ c, setup: d.setup }); break; }
            if (!d.setup) reasons.set(d.reason, (reasons.get(d.reason) || 0) + 1);
          }
        }
        // Most room to run first.
        candidates.sort((a, b) => b.setup.roomR - a.setup.roomR);
        for (const { c, setup } of candidates) {
          if (open.size >= maxOpen) break;
          const sym = c.s.symbol;
          const isMeme = MEME_COINS.has(sym);
          if (isMeme && [...open.keys()].filter((k) => MEME_COINS.has(k)).length >= maxMeme) continue;
          const eq = equityNow();
          const costRate = isMeme ? memeCost : cost;
          // Size so a stop loses riskPct of equity (costs included), capped
          // per position and by the cash on hand: no leverage.
          const lossPerDollar = setup.stopPct / 100 + 2 * costRate;
          const size = Math.min((eq * riskPct / 100) / lossPerDollar, eq * maxPosPct / 100, cash / (1 + costRate));
          if (size < 1) continue;
          const entryCost = size * costRate;
          cash -= size + entryCost;
          open.set(sym, {
            symbol: sym, direction: setup.direction, openedAt: now, entry: setup.entry, stop: setup.stop, target: setup.target, initialStop: setup.stop,
            units: size / setup.entry, sizeUSD: size, entryCostUSD: entryCost, costRate,
            riskUSD: size * (setup.stopPct / 100),
          });
          usedLevels.add(`${sym}:${setup.key}`);
        }
        reason = candidates.length ? 'Deployed'
          : [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'No coin qualified';
      }
      // Only the decimals vary ("Stop 12.40%", "Only 0.84R"); fixed numbers like 24h stay.
      const key = reason.replace(/-?\d+\.\d+(%|R)?/g, '#').trim();
      skip.set(key, (skip.get(key) || 0) + 1);
    }

    const fraction = n / steps.length;
    if (opts.onProgress && Math.floor(fraction * 100) !== lastProgress) {
      lastProgress = Math.floor(fraction * 100);
      opts.onProgress({ t: now, fraction, trades: closed.length + open.size, equityUSD: equityNow() });
    }
  }

  const end = btc.t[steps[steps.length - 1]] + M5;
  for (const p of [...open.values()]) close(p, lastPrice.get(p.symbol) ?? p.entry, end, 'BACKTEST_END');

  // ---------------------------------------------------------------- report
  const wins = closed.filter((t) => t.netUSD > 0.01).length;
  const losses = closed.filter((t) => t.netUSD < -0.01).length;
  const winSum = closed.filter((t) => t.netUSD > 0).reduce((a, t) => a + t.netUSD, 0);
  const lossSum = closed.filter((t) => t.netUSD < 0).reduce((a, t) => a + t.netUSD, 0);
  const net = closed.reduce((a, t) => a + t.netUSD, 0);
  const fees = closed.reduce((a, t) => a + t.feesUSD, 0);
  let maxDdPct = 0, maxDdUSD = 0, runPeak = opts.startingCapitalUSD;
  for (const p of equity) {
    if (p.equityUSD > runPeak) runPeak = p.equityUSD;
    maxDdPct = Math.min(maxDdPct, p.drawdownPct);
    maxDdUSD = Math.min(maxDdUSD, p.equityUSD - runPeak);
  }
  const first = btc.t[steps[0]];
  const holdReturns: number[] = [];
  for (const c of coins) {
    const ts = c.s.t;
    const a = ts.findIndex((x) => x >= first);
    let b = ts.length - 1;
    while (b > 0 && ts[b] > end) b--;
    if (a >= 0 && b > a && ts[a] - first < 7 * D1) holdReturns.push(c.s.c[b] / c.s.c[a] - 1);
  }
  const months = (end - first) / (30.44 * D1);

  const rows = (keyOf: (t: BacktestTrade) => string) => {
    const m = new Map<string, BacktestPeriodRow>();
    for (const t of closed) {
      const k = keyOf(t);
      const r = m.get(k) || { key: k, trades: 0, wins: 0, netUSD: 0, feesUSD: 0 };
      r.trades++; if (t.netUSD > 0.01) r.wins++; r.netUSD += t.netUSD; r.feesUSD += t.feesUSD;
      m.set(k, r);
    }
    return m;
  };
  const monthly = rows((t) => new Date(t.closedAt).toISOString().slice(0, 7));
  const monthEnd = new Map<string, number>();
  for (const p of equity) monthEnd.set(new Date(p.t - 1).toISOString().slice(0, 7), p.equityUSD);
  let prevEnd = opts.startingCapitalUSD;
  for (const k of [...monthEnd.keys()].sort()) {
    if (!monthly.has(k)) monthly.set(k, { key: k, trades: 0, wins: 0, netUSD: 0, feesUSD: 0 });
    monthly.get(k)!.returnPct = round2(prevEnd > 0 ? ((monthEnd.get(k)! - prevEnd) / prevEnd) * 100 : 0);
    prevEnd = monthEnd.get(k)!;
  }
  const finish = (m: Map<string, BacktestPeriodRow>) => [...m.values()].map((r) => ({ ...r, netUSD: round2(r.netUSD), feesUSD: round2(r.feesUSD) }));

  const gaps: string[] = [];
  for (let k = 1; k < steps.length; k++) {
    const a = btc.t[steps[k - 1]], b = btc.t[steps[k]];
    if (b - a > D1) gaps.push(`${new Date(a + M5).toISOString().slice(0, 10)} to ${new Date(b).toISOString().slice(0, 10)}`);
  }
  const symbols = coins.filter((c) => c.s.t.length && c.s.t[c.s.t.length - 1] >= opts.from && c.s.t[0] < opts.to).map((c) => c.s.symbol);
  const endEq = equityNow();

  return {
    id: '',
    createdAt: startedAt,
    durationMs: Date.now() - startedAt,
    settings: {
      profile: 'TREND_PULLBACK_DEMAND',
      variant: opts.variant,
      rules: [
        `Coins: any of the ${symbols.length} downloaded with at least $${(cfg.minQuoteVolume24hUSD / 1e6).toFixed(0)}M traded in the last 24h at that moment`,
        opts.allowShorts
          ? 'Sides: longs and shorts; shorts use the same rules upside down (BTC below its average, lower highs and lows, supply zone above, red close)'
          : 'Sides: long only',
        cfg.btcSmaDays > 0 ? `Market: BTC above its ${cfg.btcSmaDays}-day average for longs${opts.allowShorts ? ', below it for shorts' : ''}` : 'Market: no BTC filter',
        cfg.requireTrend ? `Trend: 4h higher highs and higher lows, price above the 4h ${cfg.trendEmaPeriod} EMA` : 'Trend: not required',
        cfg.requireZone
          ? `Zone: the base before a ${tfName(cfg.zoneTfMinutes)} move of ${cfg.impulseAtr}+ ATR, fresh (not revisited), within the last ${cfg.zoneLookback4h} ${tfName(cfg.zoneTfMinutes)} candles`
          : 'Level: the 4h 21 EMA (plus or minus 0.25 ATR) instead of a demand zone',
        `Timeframes: 4h trend, ${tfName(cfg.zoneTfMinutes)} zones and key levels, ${tfName(cfg.triggerTfMinutes)} entry`,
        `Entry: dipped into it within ${cfg.touchWindow1h} ${tfName(cfg.triggerTfMinutes)} candles, no close below, then a green ${tfName(cfg.triggerTfMinutes)} close above its midpoint`,
        cfg.exitMode === 'ltfTrail'
          ? `Stop: ${cfg.stopBufferAtr} ATR beyond the zone; needs ${cfg.minRoomR}R of room to the prior swing`
          : `Exit: stop ${cfg.stopBufferAtr} ATR beyond the zone, ${cfg.targetMode === 'R' ? `target ${cfg.targetR}R` : 'target at the key level'}, at market after ${cfg.maxHoldHours}h; needs ${cfg.minRoomR}R of room to the target`,
        ...(cfg.btcSmaRisingDays > 0 ? [`Regime: BTC's ${cfg.btcSmaDays}-day average rising over ${cfg.btcSmaRisingDays} days`] : []),
        ...(cfg.minBreadthPct > 0 ? [`Regime: at least ${cfg.minBreadthPct}% of liquid coins above their 4h ${cfg.trendEmaPeriod} EMA`] : []),
        ...(cfg.requireRelativeStrength ? ['Regime: only coins beating BTC over 7 days'] : []),
        ...(cfg.lossStreakLimit > 0 ? [`Regime: ${cfg.lossStreakLimit} losses in a row pause entries for ${cfg.lossStreakPauseHours}h`] : []),
        ...(cfg.requireBreakOfStructure ? ['Zone quality: the move away broke the prior 20-candle high'] : []),
        ...(cfg.targetMode === 'priorHigh' ? ['Target: the swing the pullback came from (prior high for longs, prior low for shorts), instead of a fixed R'] : []),
        ...(cfg.targetMode === 'keyLevel' ? ['Target: the first key level in the way (the prior swing, or the nearest fresh opposing zone before it); the stop never moves'] : []),
        ...(cfg.requireLtfBreak ? ["Turn verified: the 1h closed beyond the pullback's last swing high (low, for shorts)"] : []),
        ...(cfg.requireInducementSwept ? [`Inducement: the pullback swept an internal 1h swing on its way into the zone, and no unswept 4h swing lies within ${cfg.liquidityBelowAtr} ATR beyond the zone`] : []),
        ...(cfg.exitMode === 'ltfTrail' ? ['Exit on the 1h: no fixed target; at +1R the stop moves to entry, then trails each 1h swing; out after 10 days at most'] : []),
        `Risk: ${riskPct}% of equity per stop, at most ${maxPosPct}% of equity per position, ${maxOpen} open, ${maxMeme} meme coins`,
      ],
      allowShorts: !!opts.allowShorts,
      from: first,
      to: end,
      startingCapitalUSD: opts.startingCapitalUSD,
      symbols,
      entryGates: true,
      minScore: 0,
      maxConcurrentTrades: maxOpen,
      costPerSidePct: +(cost * 100).toFixed(3),
      dataSource: opts.dataSource,
      staleRecycleHours: null,
    },
    summary: {
      trades: closed.length,
      wins, losses, breakeven: closed.length - wins - losses,
      winRatePct: closed.length ? round2((wins / closed.length) * 100) : 0,
      netProfitUSD: round2(net),
      grossProfitUSD: round2(closed.reduce((a, t) => a + t.pnlUSD, 0)),
      feesUSD: round2(fees),
      totalReturnPct: round2(((endEq - opts.startingCapitalUSD) / opts.startingCapitalUSD) * 100),
      profitFactor: lossSum < 0 ? round2(winSum / -lossSum) : null,
      expectancyUSD: closed.length ? +(net / closed.length).toFixed(4) : 0,
      avgR: closed.length ? round2(closed.reduce((a, t) => a + t.rMultiple, 0) / closed.length) : 0,
      avgWinUSD: wins ? +(winSum / wins).toFixed(4) : 0,
      avgLossUSD: losses ? +(lossSum / losses).toFixed(4) : 0,
      maxDrawdownPct: round2(maxDdPct),
      maxDrawdownUSD: round2(maxDdUSD),
      avgHoldHours: closed.length ? round2(closed.reduce((a, t) => a + t.holdHours, 0) / closed.length) : 0,
      tradesPerMonth: months > 0 ? round2(closed.length / months) : 0,
      bestTradeUSD: closed.length ? round2(Math.max(...closed.map((t) => t.netUSD))) : 0,
      worstTradeUSD: closed.length ? round2(Math.min(...closed.map((t) => t.netUSD))) : 0,
      endingEquityUSD: round2(endEq),
      benchmarkReturnPct: round2((holdReturns.length ? holdReturns.reduce((a, b) => a + b, 0) / holdReturns.length : 0) * 100),
      btcReturnPct: round2((btc.c[steps[steps.length - 1]] / btcStart - 1) * 100),
    },
    equity,
    monthly: finish(monthly).sort((a, b) => a.key.localeCompare(b.key)),
    bySymbol: finish(rows((t) => t.symbol)).sort((a, b) => b.netUSD - a.netUSD),
    byExitReason: finish(rows((t) => t.exitReason)).sort((a, b) => b.trades - a.trades),
    byDirection: finish(rows((t) => t.direction)),
    skipReasons: [...skip.entries()].map(([reason, steps]) => ({ reason, steps })).sort((a, b) => b.steps - a.steps).slice(0, 25),
    trades: closed.sort((a, b) => a.openedAt - b.openedAt),
    limitations: [
      ...(gaps.length ? [`No candles for ${gaps.join(', ')}: no entries then; open positions were carried across.`] : []),
      'Coins were chosen from those trading today, so coins delisted since are missing; that flatters any result a little (survivorship).',
      'Within a 5-minute candle that touches both, the stop is assumed to fill first; a gap past a level fills at the open.',
      `Costs: ${(cost * 100).toFixed(2)}% per side, ${(memeCost * 100).toFixed(2)}% for meme coins.`,
      opts.allowShorts
        ? 'Shorts need a futures account to trade live. Priced on spot candles; funding payments (paid or received every 8h on futures) are not charged, and no leverage is used: a short holds its full size as collateral.'
        : 'Long only, spot: no funding or borrowing costs apply.',
      'Decisions once an hour at the 1h close, as the strategy is written; exits checked on every 5-minute candle.',
    ],
  };
}
