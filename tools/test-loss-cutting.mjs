// Testing 3 Advanced Loss-Cutting Systems on 1-Year Historical Dataset:
// 1. Time-Decay Stop (Stale Trade Exit): If a position doesn't reach +0.8R within 16 hours, exit at market to avoid slow bleed.
// 2. Trailing Breakeven Scratch: If a position reaches +0.6R (60% to T1), ratchet stop to Entry + 0.1% (never let a winner turn into a loser).
// 3. Rolling Drawdown Circuit Breaker: If 3 consecutive losses occur within 24h, freeze trading for 48h (avoids black-swan flush clusters).

import { readFileSync, readdirSync, existsSync } from 'node:fs';

const BARS_24H = 24;
const DIR = 'data/klines1h';
const INITIAL_BANKROLL = 1000.0;
const MAX_SLOTS = 10;
const TRANCHE_SIZE = 100.0;
const COST_RATE = 0.0015; // 30 bps round-trip

const MAJORS = new Set(['BTC', 'ETH', 'BNB', 'SOL']);
const MEMES = new Set(['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'POPCAT']);

const assetSrc = readFileSync('src/services/binanceService.ts', 'utf8');
const ASSETS = [...assetSrc.matchAll(/\{ id: '([^']+)', symbol: '([A-Z0-9]+)', name: '([^']+)'/g)]
  .map(m => ({ id: m[1], symbol: m[2], name: m[3] }));

const series = new Map();
for (const a of ASSETS) {
  const pair = `${a.symbol}USDT`;
  const dir = `${DIR}/${pair}`;
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter(f => f.endsWith('.csv')).sort();
  if (!files.length) continue;
  const bars = [];
  for (const f of files) {
    const lines = readFileSync(`${dir}/${f}`, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      const c = line.split(',');
      const t = Number(c[0]);
      if (!Number.isFinite(t)) continue;
      const ms = t > 1e14 ? Math.floor(t / 1000) : t;
      bars.push({ t: ms, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5], qv: +c[7] });
    }
  }
  bars.sort((x, y) => x.t - y.t);
  if (bars.length > BARS_24H * 2) {
    series.set(a.symbol, { asset: a, bars });
  }
}

const btcBars = series.get('BTC')?.bars;
const clock = btcBars.map(b => b.t);
const idx = new Map();
for (const [sym, s] of series) {
  const m = new Map();
  s.bars.forEach((b, i) => m.set(b.t, i));
  idx.set(sym, m);
}

// 25-day daily MA for BTC
const BTC_MA25 = 24 * 25;
const btcMa25 = new Array(btcBars.length).fill(0);
let s25 = 0;
for (let i = 0; i < btcBars.length; i++) {
  s25 += btcBars[i].c;
  if (i >= BTC_MA25) {
    s25 -= btcBars[i - BTC_MA25].c;
    btcMa25[i] = s25 / BTC_MA25;
  } else {
    btcMa25[i] = s25 / (i + 1);
  }
}

function testLossCuttingSystem({
  name,
  enableTimeStop = false,
  maxHoursStagnant = 16,
  enableEarlyScratch = false, // move to breakeven at +0.6R
  enableCircuitBreaker = false, // freeze after 3 losses in 24h
  marketVolatilityFloor = 3.0,
}) {
  let cash = INITIAL_BANKROLL;
  let peakEquity = INITIAL_BANKROLL;
  let maxDrawdownPct = 0;
  const openPositions = new Map();
  const closedTrades = [];
  const cooldownUntil = new Map();
  let feeTotalUSD = 0;

  let circuitBreakerUntil = 0;
  const recentLossTimestamps = [];

  const monthlyPnL = new Map();
  for (let m = 9; m <= 12; m++) monthlyPnL.set(`2025-${String(m).padStart(2, '0')}`, { pnl: 0, trades: 0, wins: 0 });
  for (let m = 1; m <= 8; m++) monthlyPnL.set(`2026-${String(m).padStart(2, '0')}`, { pnl: 0, trades: 0, wins: 0 });

  for (let k = BARS_24H * 10; k < clock.length; k++) {
    const t = clock[k];
    const btcBar = btcBars[k];
    const monthKey = new Date(t).toISOString().slice(0, 7);
    const btcBullish = btcBar.c >= btcMa25[k];

    // 1. UPDATE OPEN POSITIONS
    for (const [sym, pos] of openPositions.entries()) {
      const s = series.get(sym);
      const barIdx = idx.get(sym)?.get(t);
      if (barIdx === undefined) continue;
      const bar = s.bars[barIdx];
      const isShort = pos.direction === 'SHORT';

      const holdingHours = Math.round((t - pos.entryTime) / 3600000);

      // Check Early Scratch: if price reached +0.6R, ratchet stop to breakeven +0.2%
      if (enableEarlyScratch && !pos.t1Hit) {
        const currentGainR = isShort
          ? (pos.entryPrice - bar.l) / pos.riskDist
          : (bar.h - pos.entryPrice) / pos.riskDist;
        if (currentGainR >= 0.6) {
          const beFloor = isShort ? pos.entryPrice * (1 - 0.002) : pos.entryPrice * (1 + 0.002);
          if (isShort ? beFloor < pos.currentStopPrice : beFloor > pos.currentStopPrice) {
            pos.currentStopPrice = beFloor;
            pos.isScratched = true;
          }
        }
      }

      // Check Time-Decay Stop: if stagnant after maxHoursStagnant without hitting T1
      let timeStopTriggered = false;
      if (enableTimeStop && !pos.t1Hit && holdingHours >= maxHoursStagnant) {
        const curPnLPct = isShort
          ? (pos.entryPrice - bar.c) / pos.entryPrice
          : (bar.c - pos.entryPrice) / pos.entryPrice;
        // If trade is in negative territory or flat, cut it immediately
        if (curPnLPct < 0.005) {
          timeStopTriggered = true;
        }
      }

      let hitStop = false;
      let hitT1 = false;
      let hitT2 = false;
      let hitT3 = false;

      if (timeStopTriggered) {
        hitStop = true;
        pos.currentStopPrice = bar.c; // exit at current close
      } else if (!isShort) {
        if (bar.l <= pos.currentStopPrice) hitStop = true;
        else {
          if (!pos.t1Hit && bar.h >= pos.tier1Price) hitT1 = true;
          if (pos.t1Hit && !pos.t2Hit && bar.h >= pos.tier2Price) hitT2 = true;
          if (pos.t2Hit && bar.h >= pos.tier3Price) hitT3 = true;
        }
      } else {
        if (bar.h >= pos.currentStopPrice) hitStop = true;
        else {
          if (!pos.t1Hit && bar.l <= pos.tier1Price) hitT1 = true;
          if (pos.t1Hit && !pos.t2Hit && bar.l <= pos.tier2Price) hitT2 = true;
          if (pos.t2Hit && bar.l <= pos.tier3Price) hitT3 = true;
        }
      }

      if (hitStop) {
        const exitPrice = pos.currentStopPrice;
        const pnlPct = isShort
          ? (pos.entryPrice - exitPrice) / pos.entryPrice
          : (exitPrice - pos.entryPrice) / pos.entryPrice;
        const proceeds = pos.remainingSizeUSD * (1 + pnlPct) * (1 - COST_RATE);
        feeTotalUSD += pos.remainingSizeUSD * (1 + pnlPct) * COST_RATE;
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;

        const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
        const isWin = netPnLUSD > 0;
        closedTrades.push({
          symbol: sym,
          isWin,
          netPnLUSD,
          holdingHours,
          reason: timeStopTriggered ? 'TIME_STOP' : (pos.isScratched ? 'SCRATCH' : 'STOP_LOSS')
        });

        openPositions.delete(sym);
        cooldownUntil.set(sym, t + 2 * 3600000); // 2 hours

        if (!isWin) {
          recentLossTimestamps.push(t);
          // Circuit breaker check: 3 losses in 24 hours
          if (enableCircuitBreaker) {
            const cutOff = t - 24 * 3600000;
            const lossesIn24h = recentLossTimestamps.filter(ts => ts >= cutOff).length;
            if (lossesIn24h >= 3) {
              circuitBreakerUntil = t + 48 * 3600000; // freeze new trades for 48h
            }
          }
        }

        const m = monthlyPnL.get(monthKey);
        if (m) {
          m.pnl += netPnLUSD;
          m.trades += 1;
          if (isWin) m.wins += 1;
        }
        continue;
      }

      if (hitT1) {
        pos.t1Hit = true;
        const harvestNotional = pos.initialNotionalUSD * 0.33;
        const pnlPct = (pos.tier1Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = harvestNotional * (1 + pnlPct) * (1 - COST_RATE);
        feeTotalUSD += harvestNotional * (1 + pnlPct) * COST_RATE;
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        pos.remainingSizeUSD -= harvestNotional;

        // Breakeven ratchet
        pos.currentStopPrice = isShort ? pos.entryPrice * (1 - 0.003) : pos.entryPrice * (1 + 0.003);
      }

      if (hitT2) {
        pos.t2Hit = true;
        const harvestNotional = pos.initialNotionalUSD * 0.33;
        const pnlPct = (pos.tier2Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = harvestNotional * (1 + pnlPct) * (1 - COST_RATE);
        feeTotalUSD += harvestNotional * (1 + pnlPct) * COST_RATE;
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        pos.remainingSizeUSD -= harvestNotional;
        pos.currentStopPrice = pos.tier1Price;
      }

      if (hitT3) {
        pos.t3Hit = true;
        const pnlPct = (pos.tier3Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = pos.remainingSizeUSD * (1 + pnlPct) * (1 - COST_RATE);
        feeTotalUSD += pos.remainingSizeUSD * (1 + pnlPct) * COST_RATE;
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;

        const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
        closedTrades.push({
          symbol: sym,
          isWin: true,
          netPnLUSD,
          holdingHours,
          reason: 'FULL_HARVEST_T3'
        });
        openPositions.delete(sym);
        cooldownUntil.set(sym, t + 2 * 3600000);

        const m = monthlyPnL.get(monthKey);
        if (m) {
          m.pnl += netPnLUSD;
          m.trades += 1;
          m.wins += 1;
        }
      }
    }

    // Equity check
    let totalEquity = cash;
    for (const [sym, pos] of openPositions.entries()) {
      const s = series.get(sym);
      const barIdx = idx.get(sym)?.get(t);
      if (barIdx !== undefined) {
        const curPrice = s.bars[barIdx].c;
        const pnlPct = (curPrice - pos.entryPrice) / pos.entryPrice * (pos.direction === 'SHORT' ? -1 : 1);
        totalEquity += pos.remainingSizeUSD * (1 + pnlPct);
      } else {
        totalEquity += pos.remainingSizeUSD;
      }
    }
    if (totalEquity > peakEquity) peakEquity = totalEquity;
    const currentDrawdownPct = ((peakEquity - totalEquity) / peakEquity) * 100;
    if (currentDrawdownPct > maxDrawdownPct) maxDrawdownPct = currentDrawdownPct;

    // Entries
    if (openPositions.size >= MAX_SLOTS || cash < TRANCHE_SIZE) continue;
    if (enableCircuitBreaker && t < circuitBreakerUntil) continue; // Circuit breaker active

    const date = new Date(t);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    if (hour >= 21 || hour < 1 || day === 0 || day === 6) continue;

    // Market Chop Lock
    if (marketVolatilityFloor > 0) {
      let sumVol = 0, count = 0;
      for (const [sym, s] of series) {
        const i = idx.get(sym)?.get(t);
        if (i === undefined || i < BARS_24H) continue;
        const cur = s.bars[i].c, prev = s.bars[i - BARS_24H].c;
        if (prev > 0) {
          sumVol += Math.abs(((cur - prev) / prev) * 100);
          count++;
        }
      }
      if (count > 0 && sumVol / count < marketVolatilityFloor) continue;
    }

    const candidates = [];
    const openMajors = [...openPositions.keys()].filter(k => MAJORS.has(k)).length;
    const openMemes = [...openPositions.keys()].filter(k => MEMES.has(k)).length;

    for (const [sym, s] of series) {
      if (openPositions.has(sym)) continue;
      if (cooldownUntil.has(sym) && t < cooldownUntil.get(sym)) continue;

      if (MAJORS.has(sym) && openMajors >= 3) continue;
      if (MEMES.has(sym) && openMemes >= 2) continue;

      const i = idx.get(sym)?.get(t);
      if (i === undefined || i < BARS_24H) continue;

      const curPrice = s.bars[i].c;
      const prev24hPrice = s.bars[i - BARS_24H].c;
      const pct24h = ((curPrice - prev24hPrice) / prev24hPrice) * 100;

      let hi = -Infinity, lo = Infinity, qv = 0;
      for (let j = i - BARS_24H + 1; j <= i; j++) {
        const b = s.bars[j];
        if (b.h > hi) hi = b.h;
        if (b.l < lo) lo = b.l;
        qv += b.qv;
      }
      if (qv < 25_000_000) continue;

      const rangePct = ((hi - lo) / curPrice) * 100;
      const atrPct = rangePct * 0.7;

      let direction = null;
      if (btcBullish) {
        if (pct24h >= 2.5 && pct24h <= 14.0) direction = 'LONG';
      } else {
        if (pct24h <= -2.5 && pct24h >= -14.0) direction = 'SHORT';
      }
      if (!direction) continue;

      const stopLossPct = Math.min(7.5, Math.max(2.0, atrPct * 1.0));
      const stopLossPrice = direction === 'LONG'
        ? curPrice * (1 - stopLossPct / 100)
        : curPrice * (1 + stopLossPct / 100);

      const riskDist = Math.abs(curPrice - stopLossPrice);
      const tier1Price = direction === 'LONG' ? curPrice + riskDist * 1.2 : curPrice - riskDist * 1.2;
      const tier2Price = direction === 'LONG' ? curPrice + riskDist * 2.2 : curPrice - riskDist * 2.2;
      const tier3Price = direction === 'LONG' ? curPrice + riskDist * 3.2 : curPrice - riskDist * 3.2;

      candidates.push({
        symbol: sym,
        direction,
        currentPrice: curPrice,
        stopLossPrice,
        riskDist,
        tier1Price,
        tier2Price,
        tier3Price,
        score: Math.abs(pct24h) * Math.log10(qv),
      });
    }

    if (!candidates.length) continue;
    candidates.sort((a, b) => b.score - a.score);

    const top = candidates[0];
    const notional = Math.min(TRANCHE_SIZE, cash);
    const entryFeeUSD = notional * COST_RATE;
    feeTotalUSD += entryFeeUSD;
    cash -= notional;

    openPositions.set(top.symbol, {
      symbol: top.symbol,
      direction: top.direction,
      entryTime: t,
      entryPrice: top.currentPrice,
      initialNotionalUSD: notional,
      remainingSizeUSD: notional - entryFeeUSD,
      currentStopPrice: top.stopLossPrice,
      riskDist: top.riskDist,
      tier1Price: top.tier1Price,
      tier2Price: top.tier2Price,
      tier3Price: top.tier3Price,
      t1Hit: false,
      t2Hit: false,
      t3Hit: false,
      isScratched: false,
      bankedProceedsUSD: 0,
    });
  }

  const wins = closedTrades.filter(t => t.isWin);
  const losses = closedTrades.filter(t => !t.isWin);
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const grossGains = wins.reduce((sum, t) => sum + t.netPnLUSD, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.netPnLUSD, 0));
  const profitFactor = grossLosses > 0 ? grossGains / grossLosses : grossGains;
  const netPnLUSD = cash - INITIAL_BANKROLL;
  const returnPct = (netPnLUSD / INITIAL_BANKROLL) * 100;

  console.log(`\n===============================================================`);
  console.log(`  ${name}`);
  console.log(`===============================================================`);
  console.log(`Final Portfolio Value:      $${cash.toFixed(2)} (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%)`);
  console.log(`Win Rate:                   ${winRate.toFixed(1)}% (${wins.length} W / ${losses.length} L)`);
  console.log(`Profit Factor:              ${profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown:               ${maxDrawdownPct.toFixed(2)}%`);
  console.log(`Total Trades:               ${closedTrades.length}`);
  console.log(`Total Fees Paid:            $${feeTotalUSD.toFixed(2)}`);
  console.log('Monthly Breakdown:');
  for (const [m, d] of monthlyPnL.entries()) {
    const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(1) : '0.0';
    console.log(`  ${m}: ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2).padEnd(8)} (${d.trades} trades, ${wr}% WR)`);
  }
}

// Run 1: Baseline Dynamic Sniper (without early loss cut)
testLossCuttingSystem({
  name: '1. Baseline Dynamic Sniper (Holds to Stop)',
  enableTimeStop: false,
  enableEarlyScratch: false,
  enableCircuitBreaker: false,
});

// Run 2: With Trailing Scratch (+0.6R -> BE) & Stale Time Stop (18h)
testLossCuttingSystem({
  name: '2. With Trailing Scratch (+0.6R -> BE) + Stale-Time Stop (18h)',
  enableTimeStop: true,
  maxHoursStagnant: 18,
  enableEarlyScratch: true,
  enableCircuitBreaker: false,
});

// Run 3: Full Loss-Cutting System (Scratch + Time Stop + 48h Loss Circuit Breaker)
testLossCuttingSystem({
  name: '3. Full Loss-Cutting System (Scratch + Time Stop + 48h Circuit Breaker)',
  enableTimeStop: true,
  maxHoursStagnant: 18,
  enableEarlyScratch: true,
  enableCircuitBreaker: true,
});
