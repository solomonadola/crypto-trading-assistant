// Testing High-Conviction + Chop-Lock Strategy on 1-Year Dataset
// Problem: Fees (916 trades = $275 fee drag) and chop-whipsaws in Oct, Dec, March, April.
// Solution:
// 1. Minimum 24h Volatility / Trend Strength Filter (ADX / Momentum threshold): only trade when market is actually moving (> 3.5% move).
// 2. Trailing Stop Profit Locking (let winners run to 3.5R, don't chop out).
// 3. Higher Minimum Conviction Score (Quality > Quantity).
// 4. Maximum 1 trade per day per slot to slash fee churn.

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

function runExperiment(name, {
  minVolume = 30_000_000,
  minMomentumPct = 3.5,
  maxMomentumPct = 14.0,
  stopAtrMultiple = 1.0,
  rewardR = 2.5,
  cooldownHours = 6,
  requireBtcTrend = true,
  allowShorts = true,
  marketVolatilityFloor = 2.5, // skip chop days
}) {
  let cash = INITIAL_BANKROLL;
  let peakEquity = INITIAL_BANKROLL;
  let maxDrawdownPct = 0;
  const openPositions = new Map();
  const closedTrades = [];
  const cooldownUntil = new Map();

  const monthlyPnL = new Map();
  for (let m = 9; m <= 12; m++) monthlyPnL.set(`2025-${String(m).padStart(2, '0')}`, { pnl: 0, trades: 0, wins: 0 });
  for (let m = 1; m <= 8; m++) monthlyPnL.set(`2026-${String(m).padStart(2, '0')}`, { pnl: 0, trades: 0, wins: 0 });

  let feeTotalUSD = 0;

  for (let k = BARS_24H * 10; k < clock.length; k++) {
    const t = clock[k];
    const btcBar = btcBars[k];
    const monthKey = new Date(t).toISOString().slice(0, 7);

    const btcBullish = btcBar.c >= btcMa25[k];

    // Update positions
    for (const [sym, pos] of openPositions.entries()) {
      const s = series.get(sym);
      const barIdx = idx.get(sym)?.get(t);
      if (barIdx === undefined) continue;
      const bar = s.bars[barIdx];
      const isShort = pos.direction === 'SHORT';

      let hitStop = false;
      let hitT1 = false;
      let hitT2 = false;

      if (!isShort) {
        if (bar.l <= pos.stopPrice) hitStop = true;
        else {
          if (!pos.t1 && bar.h >= pos.t1Price) hitT1 = true;
          if (pos.t1 && bar.h >= pos.t2Price) hitT2 = true;
        }
      } else {
        if (bar.h >= pos.stopPrice) hitStop = true;
        else {
          if (!pos.t1 && bar.l <= pos.t1Price) hitT1 = true;
          if (pos.t1 && bar.l <= pos.t2Price) hitT2 = true;
        }
      }

      if (hitStop) {
        const exitPrice = pos.stopPrice;
        const pnlPct = isShort
          ? (pos.entryPrice - exitPrice) / pos.entryPrice
          : (exitPrice - pos.entryPrice) / pos.entryPrice;
        const proceeds = pos.remSize * (1 + pnlPct) * (1 - COST_RATE);
        feeTotalUSD += pos.remSize * (1 + pnlPct) * COST_RATE;
        pos.banked += proceeds;
        cash += proceeds;

        const netPnLUSD = pos.banked - pos.initSize;
        closedTrades.push({ isWin: netPnLUSD > 0, netPnLUSD });
        openPositions.delete(sym);
        cooldownUntil.set(sym, t + cooldownHours * 3600000);

        const m = monthlyPnL.get(monthKey);
        if (m) {
          m.pnl += netPnLUSD;
          m.trades += 1;
          if (netPnLUSD > 0) m.wins += 1;
        }
        continue;
      }

      if (hitT1) {
        pos.t1 = true;
        const harvestNotional = pos.initSize * 0.50; // Bank 50% at T1
        const pnlPct = (pos.t1Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = harvestNotional * (1 + pnlPct) * (1 - COST_RATE);
        feeTotalUSD += harvestNotional * (1 + pnlPct) * COST_RATE;
        pos.banked += proceeds;
        cash += proceeds;
        pos.remSize -= harvestNotional;

        // Move stop to entry + 0.5% profit lock
        pos.stopPrice = isShort ? pos.entryPrice * (1 - 0.005) : pos.entryPrice * (1 + 0.005);
      }

      if (hitT2) {
        pos.t2 = true;
        const pnlPct = (pos.t2Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = pos.remSize * (1 + pnlPct) * (1 - COST_RATE);
        feeTotalUSD += pos.remSize * (1 + pnlPct) * COST_RATE;
        pos.banked += proceeds;
        cash += proceeds;

        const netPnLUSD = pos.banked - pos.initSize;
        closedTrades.push({ isWin: true, netPnLUSD });
        openPositions.delete(sym);
        cooldownUntil.set(sym, t + cooldownHours * 3600000);

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
        totalEquity += pos.remSize * (1 + pnlPct);
      } else {
        totalEquity += pos.remSize;
      }
    }
    if (totalEquity > peakEquity) peakEquity = totalEquity;
    const currentDrawdownPct = ((peakEquity - totalEquity) / peakEquity) * 100;
    if (currentDrawdownPct > maxDrawdownPct) maxDrawdownPct = currentDrawdownPct;

    if (openPositions.size >= MAX_SLOTS || cash < TRANCHE_SIZE) continue;

    // Session filter: skip 21-01 UTC and weekends
    const date = new Date(t);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    if (hour >= 21 || hour < 1 || day === 0 || day === 6) continue;

    // Candidate scan
    const candidates = [];
    let marketVolSum = 0;
    let validCoins = 0;

    for (const [sym, s] of series) {
      const i = idx.get(sym)?.get(t);
      if (i === undefined || i < BARS_24H) continue;
      const curPrice = s.bars[i].c;
      const prevPrice = s.bars[i - BARS_24H].c;
      const pct24h = ((curPrice - prevPrice) / prevPrice) * 100;
      marketVolSum += Math.abs(pct24h);
      validCoins++;
    }

    // Market Chop Lock: If average altcoin volatility is low, market is in dead chop - SIT IN CASH
    const avgMarketVol = validCoins > 0 ? marketVolSum / validCoins : 0;
    if (avgMarketVol < marketVolatilityFloor) continue;

    for (const [sym, s] of series) {
      if (openPositions.has(sym)) continue;
      if (cooldownUntil.has(sym) && t < cooldownUntil.get(sym)) continue;

      const i = idx.get(sym)?.get(t);
      if (i === undefined || i < BARS_24H) continue;

      const curPrice = s.bars[i].c;
      const prevPrice = s.bars[i - BARS_24H].c;
      const pct24h = ((curPrice - prevPrice) / prevPrice) * 100;

      let hi = -Infinity, lo = Infinity, qv = 0;
      for (let j = i - BARS_24H + 1; j <= i; j++) {
        const b = s.bars[j];
        if (b.h > hi) hi = b.h;
        if (b.l < lo) lo = b.l;
        qv += b.qv;
      }
      if (qv < minVolume) continue;

      const rangePct = ((hi - lo) / curPrice) * 100;
      const atrPct = rangePct * 0.7;

      let direction = null;
      if (btcBullish) {
        if (pct24h >= minMomentumPct && pct24h <= maxMomentumPct) {
          direction = 'LONG';
        }
      } else {
        if (requireBtcTrend && !allowShorts) continue;
        if (allowShorts && pct24h <= -minMomentumPct && pct24h >= -maxMomentumPct) {
          direction = 'SHORT';
        }
      }

      if (!direction) continue;

      const stopLossPct = Math.min(5.5, Math.max(2.2, atrPct * stopAtrMultiple));
      const stopPrice = direction === 'LONG'
        ? curPrice * (1 - stopLossPct / 100)
        : curPrice * (1 + stopLossPct / 100);

      const riskDist = Math.abs(curPrice - stopPrice);
      const t1Price = direction === 'LONG' ? curPrice + riskDist * 1.5 : curPrice - riskDist * 1.5;
      const t2Price = direction === 'LONG' ? curPrice + riskDist * rewardR : curPrice - riskDist * rewardR;

      candidates.push({
        sym,
        direction,
        curPrice,
        stopPrice,
        t1Price,
        t2Price,
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

    openPositions.set(top.sym, {
      direction: top.direction,
      entryPrice: top.curPrice,
      initSize: notional,
      remSize: notional - entryFeeUSD,
      stopPrice: top.stopPrice,
      t1Price: top.t1Price,
      t2Price: top.t2Price,
      t1: false,
      t2: false,
      banked: 0,
    });
  }

  const wins = closedTrades.filter(t => t.isWin);
  const losses = closedTrades.filter(t => !t.isWin);
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const grossWins = wins.reduce((s, t) => s + t.netPnLUSD, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnLUSD, 0));
  const pf = grossLoss > 0 ? grossWins / grossLoss : grossWins;
  const ret = ((cash - INITIAL_BANKROLL) / INITIAL_BANKROLL) * 100;

  console.log(`\n--- ${name} ---`);
  console.log(`Final Equity:     $${cash.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%)`);
  console.log(`Trades:           ${closedTrades.length} (Wins: ${wins.length}, Losses: ${losses.length})`);
  console.log(`Win Rate:         ${winRate.toFixed(1)}%`);
  console.log(`Profit Factor:    ${pf.toFixed(2)}`);
  console.log(`Max Drawdown:     ${maxDrawdownPct.toFixed(2)}%`);
  console.log(`Total Fees Paid:  $${feeTotalUSD.toFixed(2)}`);

  console.log('Monthly Breakdown:');
  for (const [mKey, d] of monthlyPnL.entries()) {
    const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(1) : '0.0';
    console.log(`  ${mKey}: ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2).padEnd(8)} (${d.trades} trades, ${wr}% WR)`);
  }
}

// 1. Scalp High Turnover (the previous run)
runExperiment('1. High Turnover Scalp (No Chop Lock)', {
  minVolume: 15_000_000,
  minMomentumPct: 2.0,
  maxMomentumPct: 12.0,
  stopAtrMultiple: 0.85,
  rewardR: 2.0,
  cooldownHours: 2,
  marketVolatilityFloor: 0.0,
});

// 2. High Conviction + Chop Filter (Quality over Quantity)
runExperiment('2. High Selectivity + Market Chop Lock (Floor = 3.0%)', {
  minVolume: 25_000_000,
  minMomentumPct: 3.0,
  maxMomentumPct: 14.0,
  stopAtrMultiple: 1.0,
  rewardR: 2.5,
  cooldownHours: 6,
  marketVolatilityFloor: 3.0,
});

// 3. Sniper Trend Mode (Floor = 3.8%, Higher R:R)
runExperiment('3. Sniper Trend Mode (Floor = 3.8%, 1.5R/3.0R)', {
  minVolume: 35_000_000,
  minMomentumPct: 3.5,
  maxMomentumPct: 15.0,
  stopAtrMultiple: 1.1,
  rewardR: 3.0,
  cooldownHours: 12,
  marketVolatilityFloor: 3.8,
});
