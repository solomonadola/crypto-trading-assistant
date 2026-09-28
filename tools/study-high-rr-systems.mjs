// Empirical Study: High R:R Asymmetric Strategies (1:3, 1:5, and Compounding)
// Testing on full 1-year Binance historical klines (2025-09 to 2026-08) across 33 assets.
// Goal: Analyze what system achieves ~8-12% monthly ROI while controlling drawdown.

import { readFileSync, readdirSync, existsSync } from 'node:fs';

const BARS_24H = 24;
const DIR = 'data/klines1h';
const INITIAL_BANKROLL = 1000.0;
const COST_RATE = 0.0015; // 30 bps round-trip

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

// 20D and 50D Daily Moving Averages for BTC
const btcMa20 = new Array(btcBars.length).fill(0);
const btcMa50 = new Array(btcBars.length).fill(0);
let s20 = 0, s50 = 0;
for (let i = 0; i < btcBars.length; i++) {
  s20 += btcBars[i].c;
  s50 += btcBars[i].c;
  if (i >= 480) { s20 -= btcBars[i - 480].c; btcMa20[i] = s20 / 480; } else { btcMa20[i] = s20 / (i + 1); }
  if (i >= 1200) { s50 -= btcBars[i - 1200].c; btcMa50[i] = s50 / 1200; } else { btcMa50[i] = s50 / (i + 1); }
}

function simulateStrategy({
  name,
  targetR1 = 1.5,
  targetR2 = 3.0,
  targetR3 = 5.0,
  stopAtrMultiple = 1.0,
  leverage = 1.0,
  riskPctPerTrade = 2.5, // 2.5% account equity risk per trade
  maxSlots = 5,
  useTrailingRunner = true,
  marketVolatilityFloor = 3.2,
}) {
  let cash = INITIAL_BANKROLL;
  let peakEquity = INITIAL_BANKROLL;
  let maxDrawdownPct = 0;
  const openPositions = new Map();
  const closedTrades = [];
  const cooldownUntil = new Map();
  let feeTotalUSD = 0;

  const monthlyPnL = new Map();
  for (let m = 9; m <= 12; m++) monthlyPnL.set(`2025-${String(m).padStart(2, '0')}`, { pnl: 0, trades: 0, wins: 0 });
  for (let m = 1; m <= 8; m++) monthlyPnL.set(`2026-${String(m).padStart(2, '0')}`, { pnl: 0, trades: 0, wins: 0 });

  for (let k = BARS_24H * 10; k < clock.length; k++) {
    const t = clock[k];
    const btcBar = btcBars[k];
    const monthKey = new Date(t).toISOString().slice(0, 7);

    // Bullish: BTC > MA20 and MA50
    const btcBullish = btcBar.c >= btcMa20[k] && btcBar.c >= btcMa50[k];

    // 1. UPDATE OPEN POSITIONS
    for (const [sym, pos] of openPositions.entries()) {
      const s = series.get(sym);
      const barIdx = idx.get(sym)?.get(t);
      if (barIdx === undefined) continue;
      const bar = s.bars[barIdx];
      const isShort = pos.direction === 'SHORT';

      let hitStop = false, hitT1 = false, hitT2 = false, hitT3 = false;

      // Trailing runner stop logic after T2
      if (useTrailingRunner && pos.t2Hit) {
        const trailDist = pos.riskDist * 1.5;
        if (!isShort) {
          const newTrail = bar.h - trailDist;
          if (newTrail > pos.currentStopPrice) pos.currentStopPrice = newTrail;
        } else {
          const newTrail = bar.l + trailDist;
          if (newTrail < pos.currentStopPrice) pos.currentStopPrice = newTrail;
        }
      }

      if (!isShort) {
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
        const proceeds = pos.remainingSizeUSD * (1 + pnlPct * leverage) * (1 - COST_RATE * leverage);
        feeTotalUSD += pos.remainingSizeUSD * COST_RATE * leverage;
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;

        const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
        closedTrades.push({ isWin: netPnLUSD > 0, netPnLUSD, symbol: sym });
        openPositions.delete(sym);
        cooldownUntil.set(sym, t + 4 * 3600000);

        const m = monthlyPnL.get(monthKey);
        if (m) {
          m.pnl += netPnLUSD;
          m.trades += 1;
          if (netPnLUSD > 0) m.wins += 1;
        }
        continue;
      }

      if (hitT1) {
        pos.t1Hit = true;
        // Harvest 30% at T1 (Derisk)
        const harvestNotional = pos.initialNotionalUSD * 0.30;
        const pnlPct = (pos.tier1Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = harvestNotional * (1 + pnlPct * leverage) * (1 - COST_RATE * leverage);
        feeTotalUSD += harvestNotional * COST_RATE * leverage;
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        pos.remainingSizeUSD -= harvestNotional;

        // Breakeven +0.5% ratchet
        pos.currentStopPrice = isShort ? pos.entryPrice * (1 - 0.005) : pos.entryPrice * (1 + 0.005);
      }

      if (hitT2) {
        pos.t2Hit = true;
        // Harvest 40% at T2
        const harvestNotional = pos.initialNotionalUSD * 0.40;
        const pnlPct = (pos.tier2Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = harvestNotional * (1 + pnlPct * leverage) * (1 - COST_RATE * leverage);
        feeTotalUSD += harvestNotional * COST_RATE * leverage;
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        pos.remainingSizeUSD -= harvestNotional;

        // Stop locked in at Tier 1 profit floor
        pos.currentStopPrice = pos.tier1Price;
      }

      if (hitT3) {
        pos.t3Hit = true;
        // Harvest remaining 30% at T3 (Huge R)
        const pnlPct = (pos.tier3Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = pos.remainingSizeUSD * (1 + pnlPct * leverage) * (1 - COST_RATE * leverage);
        feeTotalUSD += pos.remainingSizeUSD * COST_RATE * leverage;
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;

        const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
        closedTrades.push({ isWin: true, netPnLUSD, symbol: sym });
        openPositions.delete(sym);
        cooldownUntil.set(sym, t + 4 * 3600000);

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
        totalEquity += pos.remainingSizeUSD * (1 + pnlPct * leverage);
      } else {
        totalEquity += pos.remainingSizeUSD;
      }
    }
    if (totalEquity > peakEquity) peakEquity = totalEquity;
    const currentDrawdownPct = ((peakEquity - totalEquity) / peakEquity) * 100;
    if (currentDrawdownPct > maxDrawdownPct) maxDrawdownPct = currentDrawdownPct;

    if (openPositions.size >= maxSlots || cash < 20) continue;

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
    for (const [sym, s] of series) {
      if (openPositions.has(sym)) continue;
      if (cooldownUntil.has(sym) && t < cooldownUntil.get(sym)) continue;

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
      if (qv < 30_000_000) continue;

      const rangePct = ((hi - lo) / curPrice) * 100;
      const atrPct = rangePct * 0.7;

      let direction = null;
      if (btcBullish) {
        if (pct24h >= 3.0 && pct24h <= 14.0) direction = 'LONG';
      } else {
        if (pct24h <= -3.0 && pct24h >= -14.0) direction = 'SHORT';
      }
      if (!direction) continue;

      const stopLossPct = Math.min(6.5, Math.max(2.2, atrPct * stopAtrMultiple));
      const stopLossPrice = direction === 'LONG'
        ? curPrice * (1 - stopLossPct / 100)
        : curPrice * (1 + stopLossPct / 100);

      const riskDist = Math.abs(curPrice - stopLossPrice);
      const tier1Price = direction === 'LONG' ? curPrice + riskDist * targetR1 : curPrice - riskDist * targetR1;
      const tier2Price = direction === 'LONG' ? curPrice + riskDist * targetR2 : curPrice - riskDist * targetR2;
      const tier3Price = direction === 'LONG' ? curPrice + riskDist * targetR3 : curPrice - riskDist * targetR3;

      candidates.push({
        symbol: sym,
        direction,
        currentPrice: curPrice,
        stopLossPrice,
        riskDist,
        tier1Price,
        tier2Price,
        tier3Price,
        stopLossPct,
        score: Math.abs(pct24h) * Math.log10(qv),
      });
    }

    if (!candidates.length) continue;
    candidates.sort((a, b) => b.score - a.score);

    const top = candidates[0];
    // Dynamic position sizing based on risk percentage:
    // Risk = notional * (stopLossPct / 100) * leverage => notional = (equity * riskPct) / (stopLossPct * leverage)
    const dollarRisk = totalEquity * (riskPctPerTrade / 100);
    let calculatedNotional = dollarRisk / ((top.stopLossPct / 100) * leverage);
    // Cap at max slot size (20% of equity)
    const maxSlotUSD = totalEquity / maxSlots;
    const notional = Math.min(calculatedNotional, maxSlotUSD, cash);
    if (notional < 10) continue;

    const entryFeeUSD = notional * COST_RATE * leverage;
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
  let positiveMonths = 0;
  for (const [m, d] of monthlyPnL.entries()) {
    const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(1) : '0.0';
    if (d.pnl > 0) positiveMonths++;
    console.log(`  ${m}: ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2).padEnd(8)} (${d.trades} trades, ${wr}% WR)`);
  }
  console.log(`Profitable Months:          ${positiveMonths} / 12`);
}

// 1. Unleveraged 1:3 R Asymmetric System (1.5R / 3.0R / 5.0R)
simulateStrategy({
  name: '1. Spot Unleveraged 1:3 R Asymmetric System',
  targetR1: 1.5,
  targetR2: 3.0,
  targetR3: 5.0,
  leverage: 1.0,
  riskPctPerTrade: 2.0,
});

// 2. Moderate 2x Leverage 1:3.5 R Compounding System
simulateStrategy({
  name: '2. Moderate 2x Leverage 1:3.5 R Asymmetric System',
  targetR1: 1.5,
  targetR2: 3.5,
  targetR3: 5.5,
  leverage: 2.0,
  riskPctPerTrade: 2.5,
});

// 3. High-Asymmetry 1:5 R Runner System (2x Leverage, 1.8R / 3.5R / 6.0R)
simulateStrategy({
  name: '3. High-Asymmetry 1:5 R Runner System (2x Leverage)',
  targetR1: 1.8,
  targetR2: 3.5,
  targetR3: 6.0,
  leverage: 2.0,
  riskPctPerTrade: 2.5,
});
