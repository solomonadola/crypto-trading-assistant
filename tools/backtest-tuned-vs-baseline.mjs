// Comprehensive 1-Year Backtest: Baseline vs. Tuned Multi-Coin Auto-Pilot
// Evaluates every 1-hour bar from 2025-09-02 to 2026-08-31 across 33 Binance assets.
// Features exact portfolio execution, realistic 30 bps round-trip costs, and sector caps.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';

const BARS_24H = 24;
const DIR = 'data/klines1h';
const INITIAL_BANKROLL = 1000.0;
const MAX_SLOTS = 10;
const TRANCHE_SIZE = INITIAL_BANKROLL / MAX_SLOTS; // $100
const COST_RATE = 0.0015; // 15 bps per side = 30 bps round-trip

const MAJORS = new Set(['BTC', 'ETH', 'BNB', 'SOL']);
const MEMES = new Set(['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'POPCAT']);

// Load asset metadata
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
      bars.push({
        t: ms,
        o: +c[1],
        h: +c[2],
        l: +c[3],
        c: +c[4],
        v: +c[5],
        qv: +c[7]
      });
    }
  }
  bars.sort((x, y) => x.t - y.t);
  if (bars.length > BARS_24H * 2) {
    series.set(a.symbol, { asset: a, bars });
  }
}

const btcBars = series.get('BTC')?.bars;
if (!btcBars) process.exit(1);

const clock = btcBars.map(b => b.t);
const idx = new Map();
for (const [sym, s] of series) {
  const m = new Map();
  s.bars.forEach((b, i) => m.set(b.t, i));
  idx.set(sym, m);
}

// Compute 25-day daily MA (600 hours) and 7-day MA (168 hours) for BTC macro trend
const BTC_MA25_PERIOD = 24 * 25;
const BTC_MA7_PERIOD = 24 * 7;
const btcMa25 = new Array(btcBars.length).fill(0);
const btcMa7 = new Array(btcBars.length).fill(0);

let sum25 = 0;
let sum7 = 0;
for (let i = 0; i < btcBars.length; i++) {
  sum25 += btcBars[i].c;
  sum7 += btcBars[i].c;
  if (i >= BTC_MA25_PERIOD) {
    sum25 -= btcBars[i - BTC_MA25_PERIOD].c;
    btcMa25[i] = sum25 / BTC_MA25_PERIOD;
  } else {
    btcMa25[i] = sum25 / (i + 1);
  }
  if (i >= BTC_MA7_PERIOD) {
    sum7 -= btcBars[i - BTC_MA7_PERIOD].c;
    btcMa7[i] = sum7 / BTC_MA7_PERIOD;
  } else {
    btcMa7[i] = sum7 / (i + 1);
  }
}

/**
 * Runs a 1-year backtest simulation
 */
function runSimulation({
  name,
  isTuned = false,
  cooldownMs = 20 * 60 * 1000,
  allowShorts = false,
  enforceBtcMacro = false,
  capStopAt32 = true,
  stopAtrMultiple = 0.95,
  tier1Multiple = 1.2,
  tier2Multiple = 2.0,
  tier3Multiple = 3.5,
  minVolume = 15_000_000,
  marketVolatilityFloor = 0.0,
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

    const btcIsBullish = btcBar.c >= btcMa25[k] || (btcBar.c >= btcMa7[k] && btcBar.c > btcBars[k - BARS_24H].c);

    // 1. UPDATE OPEN POSITIONS
    for (const [sym, pos] of openPositions.entries()) {
      const s = series.get(sym);
      const barIdx = idx.get(sym)?.get(t);
      if (barIdx === undefined) continue;
      const bar = s.bars[barIdx];

      const isShort = pos.direction === 'SHORT';
      let hitStop = false;
      let hitT1 = false;
      let hitT2 = false;
      let hitT3 = false;

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
        const proceeds = pos.remainingSizeUSD * (1 + pnlPct) * (1 - COST_RATE);
        feeTotalUSD += pos.remainingSizeUSD * (1 + pnlPct) * COST_RATE;
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;

        const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
        const tradeRecord = {
          symbol: sym,
          direction: pos.direction,
          entryTime: pos.entryTime,
          exitTime: t,
          netPnLUSD,
          isWin: netPnLUSD > 0,
          holdingHours: Math.round((t - pos.entryTime) / 3600000),
        };
        closedTrades.push(tradeRecord);
        openPositions.delete(sym);
        cooldownUntil.set(sym, t + cooldownMs);

        const m = monthlyPnL.get(monthKey);
        if (m) {
          m.pnl += netPnLUSD;
          m.trades += 1;
          if (tradeRecord.isWin) m.wins += 1;
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
        const buffer = isTuned ? 0.005 : 0.003;
        pos.currentStopPrice = isShort ? pos.entryPrice * (1 - buffer) : pos.entryPrice * (1 + buffer);
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
        const tradeRecord = {
          symbol: sym,
          direction: pos.direction,
          entryTime: pos.entryTime,
          exitTime: t,
          netPnLUSD,
          isWin: true,
          holdingHours: Math.round((t - pos.entryTime) / 3600000),
        };
        closedTrades.push(tradeRecord);
        openPositions.delete(sym);
        cooldownUntil.set(sym, t + cooldownMs);

        const m = monthlyPnL.get(monthKey);
        if (m) {
          m.pnl += netPnLUSD;
          m.trades += 1;
          m.wins += 1;
        }
      }
    }

    // Equity & Drawdown tracking
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

    // 2. CHECK CANDIDATE ENTRIES
    if (openPositions.size >= MAX_SLOTS) continue;
    if (cash < TRANCHE_SIZE) continue;

    // Avoid low-liquidity weekend and midnight gap
    const date = new Date(t);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    if (hour >= 21 || hour < 1 || day === 0 || day === 6) continue;

    // Market Chop Lock check (volatility floor)
    if (marketVolatilityFloor > 0) {
      let sumVol = 0;
      let count = 0;
      for (const [sym, s] of series) {
        const i = idx.get(sym)?.get(t);
        if (i === undefined || i < BARS_24H) continue;
        const cur = s.bars[i].c;
        const prev = s.bars[i - BARS_24H].c;
        if (prev > 0) {
          sumVol += Math.abs(((cur - prev) / prev) * 100);
          count++;
        }
      }
      const avgVol = count > 0 ? sumVol / count : 0;
      if (avgVol < marketVolatilityFloor) {
        continue; // Market is in sideways chop lock: 100% Cash Defense
      }
    }

    // Scan multi-coin candidate signals
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
      if (qv < minVolume) continue;

      const rangePct = ((hi - lo) / curPrice) * 100;
      const atrPct = rangePct * 0.7; // ~daily ATR

      let direction = null;
      if (btcIsBullish) {
        if (pct24h >= 2.5 && pct24h <= 14.0) {
          direction = 'LONG';
        }
      } else {
        // Bearish Macro
        if (enforceBtcMacro && !allowShorts) {
          // Macro gate: do not long in bear trend
          continue;
        }
        if (allowShorts && pct24h <= -2.5 && pct24h >= -14.0) {
          direction = 'SHORT';
        } else if (!enforceBtcMacro && pct24h >= 2.5 && pct24h <= 14.0) {
          direction = 'LONG';
        }
      }

      if (!direction) continue;

      let stopLossPct = atrPct * stopAtrMultiple;
      if (capStopAt32) {
        stopLossPct = Math.min(3.2, Math.max(1.4, stopLossPct));
      } else {
        stopLossPct = Math.min(7.5, Math.max(2.0, stopLossPct));
      }

      const stopLossPrice = direction === 'LONG'
        ? curPrice * (1 - stopLossPct / 100)
        : curPrice * (1 + stopLossPct / 100);

      const riskDist = Math.abs(curPrice - stopLossPrice);
      const tier1Price = direction === 'LONG' ? curPrice + riskDist * tier1Multiple : curPrice - riskDist * tier1Multiple;
      const tier2Price = direction === 'LONG' ? curPrice + riskDist * tier2Multiple : curPrice - riskDist * tier2Multiple;
      const tier3Price = direction === 'LONG' ? curPrice + riskDist * tier3Multiple : curPrice - riskDist * tier3Multiple;

      candidates.push({
        symbol: sym,
        direction,
        currentPrice: curPrice,
        stopLossPrice,
        tier1Price,
        tier2Price,
        tier3Price,
        score: Math.abs(pct24h) * Math.log10(qv),
      });
    }

    if (!candidates.length) continue;
    candidates.sort((a, b) => b.score - a.score);

    // Pick top candidates up to available slots
    const availableSlots = Math.min(MAX_SLOTS - openPositions.size, 1);
    for (let cIdx = 0; cIdx < availableSlots; cIdx++) {
      if (cash < TRANCHE_SIZE) break;
      const top = candidates[cIdx];
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
        tier1Price: top.tier1Price,
        tier2Price: top.tier2Price,
        tier3Price: top.tier3Price,
        t1Hit: false,
        t2Hit: false,
        t3Hit: false,
        bankedProceedsUSD: 0,
      });
    }
  }

  // Final settlement
  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter(t => t.isWin);
  const losses = closedTrades.filter(t => !t.isWin);
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
  const grossGains = wins.reduce((sum, t) => sum + t.netPnLUSD, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.netPnLUSD, 0));
  const profitFactor = grossLosses > 0 ? grossGains / grossLosses : grossGains;
  const netPnLUSD = cash - INITIAL_BANKROLL;
  const returnPct = (netPnLUSD / INITIAL_BANKROLL) * 100;
  const avgHoldingHours = totalTrades > 0
    ? (closedTrades.reduce((sum, t) => sum + t.holdingHours, 0) / totalTrades).toFixed(1)
    : '0';

  return {
    name,
    initialBankroll: INITIAL_BANKROLL,
    finalBankroll: +cash.toFixed(2),
    netPnLUSD: +netPnLUSD.toFixed(2),
    totalReturnPct: +returnPct.toFixed(2),
    winRate: +winRate.toFixed(2),
    profitFactor: +profitFactor.toFixed(2),
    maxDrawdownPct: +maxDrawdownPct.toFixed(2),
    totalTrades,
    winsCount: wins.length,
    lossesCount: losses.length,
    avgHoldingHours,
    feeTotalUSD: +feeTotalUSD.toFixed(2),
    monthlyPnL: Object.fromEntries(monthlyPnL),
  };
}

console.log('Executing 1-Year Multi-Coin Backtest (2025-09-01 to 2026-08-31)...');

// 1. Baseline
const baseline = runSimulation({
  name: 'Baseline (Pre-Tuning)',
  isTuned: false,
  cooldownMs: 20 * 60 * 1000, // 20m
  allowShorts: false,          // Longs only
  enforceBtcMacro: false,      // Naive entries during bear market
  capStopAt32: true,           // Clamped at 3.2%
  stopAtrMultiple: 0.95,
});

// 2. Tuned Engine (Swing 1.5x ATR)
const tuned = runSimulation({
  name: 'Tuned Auto-Pilot (Swing)',
  isTuned: true,
  cooldownMs: 120 * 60 * 1000, // 2-hour cooldown
  allowShorts: true,            // Bidirectional: Shorts in bear, Longs in bull
  enforceBtcMacro: true,        // Gated: No long traps when BTC < 25D MA
  capStopAt32: false,           // Dynamic 1.5x ATR stops
  stopAtrMultiple: 1.5,
});

// 3. Tuned Scalp Engine (0.85x ATR Stop, Fast 1.0R/2.0R Take Profits)
const tunedScalp = runSimulation({
  name: 'Tuned Scalp Engine',
  isTuned: true,
  cooldownMs: 120 * 60 * 1000,
  allowShorts: true,
  enforceBtcMacro: true,
  capStopAt32: false,
  stopAtrMultiple: 0.85,
});

// 4. Dynamic Sniper Engine (Chop Lock Floor = 3.0%, 1.0x ATR, 1.2R/2.2R/3.2R)
const tunedDynamic = runSimulation({
  name: 'Dynamic Sniper (Chop Lock)',
  isTuned: true,
  cooldownMs: 120 * 60 * 1000,
  allowShorts: true,
  enforceBtcMacro: true,
  capStopAt32: false,
  stopAtrMultiple: 1.0,
  tier1Multiple: 1.2,
  tier2Multiple: 2.2,
  tier3Multiple: 3.2,
  minVolume: 25_000_000,
  marketVolatilityFloor: 3.0,
});

console.log('\n==================================================================================================');
console.log('                               1-YEAR PERFORMANCE COMPARISON                                      ');
console.log('==================================================================================================');
console.log(`Metric                      BASELINE               TUNED SWING            TUNED SCALP            DYNAMIC SNIPER`);
console.log('--------------------------------------------------------------------------------------------------');
console.log(`Initial Capital:            $${baseline.initialBankroll.toFixed(2)}               $${tuned.initialBankroll.toFixed(2)}               $${tunedScalp.initialBankroll.toFixed(2)}               $${tunedDynamic.initialBankroll.toFixed(2)}`);
console.log(`Final Portfolio Value:      $${baseline.finalBankroll.toFixed(2)}                $${tuned.finalBankroll.toFixed(2)}                $${tunedScalp.finalBankroll.toFixed(2)}                $${tunedDynamic.finalBankroll.toFixed(2)}`);
console.log(`Net Return (%):             ${baseline.totalReturnPct >= 0 ? '+' : ''}${baseline.totalReturnPct.toFixed(2)}%               ${tuned.totalReturnPct >= 0 ? '+' : ''}${tuned.totalReturnPct.toFixed(2)}%               ${tunedScalp.totalReturnPct >= 0 ? '+' : ''}${tunedScalp.totalReturnPct.toFixed(2)}%               ${tunedDynamic.totalReturnPct >= 0 ? '+' : ''}${tunedDynamic.totalReturnPct.toFixed(2)}%`);
console.log(`Win Rate (%):               ${baseline.winRate.toFixed(1)}%                  ${tuned.winRate.toFixed(1)}%                  ${tunedScalp.winRate.toFixed(1)}%                  ${tunedDynamic.winRate.toFixed(1)}%`);
console.log(`Profit Factor:              ${baseline.profitFactor.toFixed(2)}                   ${tuned.profitFactor.toFixed(2)}                   ${tunedScalp.profitFactor.toFixed(2)}                   ${tunedDynamic.profitFactor.toFixed(2)}`);
console.log(`Max Drawdown (%):           ${baseline.maxDrawdownPct.toFixed(2)}%                 ${tuned.maxDrawdownPct.toFixed(2)}%                 ${tunedScalp.maxDrawdownPct.toFixed(2)}%                 ${tunedDynamic.maxDrawdownPct.toFixed(2)}%`);
console.log(`Total Trades Taken:         ${baseline.totalTrades}                    ${tuned.totalTrades}                    ${tunedScalp.totalTrades}                    ${tunedDynamic.totalTrades}`);
console.log(`Trades Won / Lost:          ${baseline.winsCount} / ${baseline.lossesCount}             ${tuned.winsCount} / ${tuned.lossesCount}             ${tunedScalp.winsCount} / ${tunedScalp.lossesCount}             ${tunedDynamic.winsCount} / ${tunedDynamic.lossesCount}`);
console.log(`Total Fees Paid ($):        $${baseline.feeTotalUSD.toFixed(2)}                $${tuned.feeTotalUSD.toFixed(2)}                $${tunedScalp.feeTotalUSD.toFixed(2)}                $${tunedDynamic.feeTotalUSD.toFixed(2)}`);
console.log(`Avg Holding Time:           ${baseline.avgHoldingHours} hrs               ${tuned.avgHoldingHours} hrs                ${tunedScalp.avgHoldingHours} hrs                 ${tunedDynamic.avgHoldingHours} hrs`);

console.log('\n---------------------------------------------------------------');
console.log('MONTHLY BREAKDOWN: DYNAMIC SNIPER (Chop Lock + Adaptive)');
console.log('Month        Net PnL ($)    Trades    Win Rate');
console.log('-----------------------------------------------');
for (const [month, data] of Object.entries(tunedDynamic.monthlyPnL)) {
  const winRate = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(1) : '0.0';
  const sign = data.pnl >= 0 ? '+' : '';
  console.log(`${month}      ${sign}$${data.pnl.toFixed(2).padEnd(10)}  ${String(data.trades).padEnd(8)}  ${winRate}%`);
}

// Write to JSON file for audit
writeFileSync('data/backtest-comparison-1yr.json', JSON.stringify({ baseline, tuned, tunedScalp, tunedDynamic }, null, 2));
console.log('\nComparison report saved to data/backtest-comparison-1yr.json\n');
