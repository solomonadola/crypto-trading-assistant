// Diagnostic & Optimization Study for 1-Year Backtest
// Tests:
// 1. BTC Trend Regime Gate (Only Long when BTC > 20-day MA)
// 2. Realistic ATR-scaled stop loss (1.5x ATR instead of clamped 3.2%)
// 3. Trailing Stop logic (giving runners room instead of 0.3% breakeven choke)
// 4. Bidirectional (Shorts when BTC < 20-day MA)

import { readFileSync, readdirSync, existsSync } from 'node:fs';

const BARS_24H = 24;
const DIR = 'data/klines1h';
const INITIAL_BANKROLL = 1000.0;
const MAX_SLOTS = 10;
const TRANCHE_SIZE = INITIAL_BANKROLL / MAX_SLOTS;
const COST_RATE = 0.0015; // 15 bps per side = 30 bps roundtrip

// Load assets
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

// Compute 20-day (480 hours) MA for BTC
const BTC_MA_PERIOD = 24 * 20; // 480 hours
const btcMa20d = new Array(btcBars.length).fill(0);
let btcSum = 0;
for (let i = 0; i < btcBars.length; i++) {
  btcSum += btcBars[i].c;
  if (i >= BTC_MA_PERIOD) {
    btcSum -= btcBars[i - BTC_MA_PERIOD].c;
    btcMa20d[i] = btcSum / BTC_MA_PERIOD;
  } else {
    btcMa20d[i] = btcSum / (i + 1);
  }
}

/**
 * Runs simulation with parameter variants
 */
function testVariant(name, {
  useBtcRegimeFilter = false,
  atrStopMultiplier = 0.95, // default was ~0.95 capped at 3.2%
  capStopAt32 = true,
  allowShortsInBear = false,
  beBufferPct = 0.003, // 0.3%
  minVolume24h = 10_000_000,
  cooldownHours = 4,
}) {
  let cash = INITIAL_BANKROLL;
  let peakEquity = INITIAL_BANKROLL;
  let maxDrawdownPct = 0;
  const openPositions = new Map();
  const closedTrades = [];
  const cooldownUntil = new Map();

  for (let k = BARS_24H * 10; k < clock.length; k++) {
    const t = clock[k];
    const btcBar = btcBars[k];
    const isBtcBull = btcBar.c >= btcMa20d[k];

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
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
        closedTrades.push({ isWin: netPnLUSD > 0, netPnLUSD });
        openPositions.delete(sym);
        cooldownUntil.set(sym, t + cooldownHours * 3600000);
        continue;
      }

      if (hitT1) {
        pos.t1Hit = true;
        const harvestNotional = pos.initialNotionalUSD * 0.33;
        const pnlPct = (pos.tier1Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = harvestNotional * (1 + pnlPct) * (1 - COST_RATE);
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        pos.remainingSizeUSD -= harvestNotional;
        // Move stop to BE
        pos.currentStopPrice = isShort ? pos.entryPrice * (1 - beBufferPct) : pos.entryPrice * (1 + beBufferPct);
      }

      if (hitT2) {
        pos.t2Hit = true;
        const harvestNotional = pos.initialNotionalUSD * 0.33;
        const pnlPct = (pos.tier2Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = harvestNotional * (1 + pnlPct) * (1 - COST_RATE);
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        pos.remainingSizeUSD -= harvestNotional;
        pos.currentStopPrice = pos.tier1Price;
      }

      if (hitT3) {
        pos.t3Hit = true;
        const pnlPct = (pos.tier3Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = pos.remainingSizeUSD * (1 + pnlPct) * (1 - COST_RATE);
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
        closedTrades.push({ isWin: true, netPnLUSD });
        openPositions.delete(sym);
        cooldownUntil.set(sym, t + cooldownHours * 3600000);
      }
    }

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

    // 2. CHECK ENTRIES
    if (openPositions.size >= MAX_SLOTS) continue;
    if (cash < TRANCHE_SIZE) continue;

    // Date filters: Dead-zone (21-01 UTC or weekend)
    const date = new Date(t);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    if (hour >= 21 || hour < 1 || day === 0 || day === 6) continue;

    // Candidates evaluation
    const candidates = [];
    for (const [sym, s] of series) {
      if (openPositions.has(sym)) continue;
      if (cooldownUntil.has(sym) && t < cooldownUntil.get(sym)) continue;
      const i = idx.get(sym)?.get(t);
      if (i === undefined || i < BARS_24H) continue;
      
      const curPrice = s.bars[i].c;
      const prev24hPrice = s.bars[i - BARS_24H].c;
      const pct24h = ((curPrice - prev24hPrice) / prev24hPrice) * 100;

      // 24h rolling volatility & volume
      let hi = -Infinity, lo = Infinity, qv = 0;
      for (let j = i - BARS_24H + 1; j <= i; j++) {
        const b = s.bars[j];
        if (b.h > hi) hi = b.h;
        if (b.l < lo) lo = b.l;
        qv += b.qv;
      }
      if (qv < minVolume24h) continue;

      const rangePct = ((hi - lo) / curPrice) * 100;
      const atrPct = rangePct * 0.7; // approximate daily ATR

      // Determine trade direction:
      let direction = null;
      if (isBtcBull) {
        // Bullish market: Look for strong Long momentum (+2% to +10%, not overextended)
        if (pct24h >= 2.0 && pct24h <= 12.0) {
          direction = 'LONG';
        }
      } else {
        // Bearish market
        if (useBtcRegimeFilter && !allowShortsInBear) {
          // Gated: do not trade longs in bear regime
          continue;
        }
        if (allowShortsInBear && pct24h <= -2.0 && pct24h >= -12.0) {
          direction = 'SHORT';
        } else if (!useBtcRegimeFilter && pct24h >= 2.0 && pct24h <= 12.0) {
          // Ungated naive long
          direction = 'LONG';
        }
      }

      if (!direction) continue;

      // Determine Stop Loss & Targets
      let stopLossPct = atrPct * atrStopMultiplier;
      if (capStopAt32) {
        stopLossPct = Math.min(3.2, Math.max(1.4, stopLossPct));
      } else {
        // Uncapped ATR stop (clamped between 2.5% and 6.0%)
        stopLossPct = Math.min(6.0, Math.max(2.5, stopLossPct));
      }

      const stopLossPrice = direction === 'LONG'
        ? curPrice * (1 - stopLossPct / 100)
        : curPrice * (1 + stopLossPct / 100);

      // Targets scaled to 1.2R, 2.0R, 3.5R
      const riskDist = Math.abs(curPrice - stopLossPrice);
      const tier1Price = direction === 'LONG' ? curPrice + riskDist * 1.2 : curPrice - riskDist * 1.2;
      const tier2Price = direction === 'LONG' ? curPrice + riskDist * 2.0 : curPrice - riskDist * 2.0;
      const tier3Price = direction === 'LONG' ? curPrice + riskDist * 3.5 : curPrice - riskDist * 3.5;

      candidates.push({
        symbol: sym,
        direction,
        currentPrice: curPrice,
        stopLossPrice,
        tier1Price,
        tier2Price,
        tier3Price,
        score: Math.abs(pct24h) * (qv / 1e7),
      });
    }

    if (!candidates.length) continue;
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];

    const notional = Math.min(TRANCHE_SIZE, cash);
    const entryFeeUSD = notional * COST_RATE;
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

  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter(t => t.isWin);
  const losses = closedTrades.filter(t => !t.isWin);
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
  const grossGains = wins.reduce((sum, t) => sum + t.netPnLUSD, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.netPnLUSD, 0));
  const profitFactor = grossLosses > 0 ? grossGains / grossLosses : grossGains;
  const netPnLUSD = cash - INITIAL_BANKROLL;
  const returnPct = (netPnLUSD / INITIAL_BANKROLL) * 100;

  console.log(`\n--- ${name} ---`);
  console.log(`Net Return:       ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}% ($${cash.toFixed(2)})`);
  console.log(`Trades:           ${totalTrades} (Win Rate: ${winRate.toFixed(1)}%)`);
  console.log(`Profit Factor:    ${profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown:     ${maxDrawdownPct.toFixed(2)}%`);

  return { name, returnPct, winRate, profitFactor, maxDrawdownPct, totalTrades, cash };
}

console.log('Testing Parameter Variants across 1-Year Dataset:');

// Variant 1: Unmodified baseline (Capped 3.2% stop, No Regime Gate, Longs only)
testVariant('1. Baseline (Capped 3.2% Stop, Naive Longs)', {
  useBtcRegimeFilter: false,
  atrStopMultiplier: 0.95,
  capStopAt32: true,
  allowShortsInBear: false,
});

// Variant 2: Uncapped ATR Stop (Give trades room to breathe: 1.5x ATR, no 3.2% cap)
testVariant('2. Uncapped Volatility Stop (1.5x ATR)', {
  useBtcRegimeFilter: false,
  atrStopMultiplier: 1.5,
  capStopAt32: false,
  allowShortsInBear: false,
});

// Variant 3: BTC Macro Regime Gate (Do NOT take longs when BTC < 20-day MA)
testVariant('3. BTC Macro Regime Gate (Longs only when BTC > 20D MA)', {
  useBtcRegimeFilter: true,
  atrStopMultiplier: 1.5,
  capStopAt32: false,
  allowShortsInBear: false,
});

// Variant 4: Full Regime Bidirectional (Longs in Bull, Shorts in Bear, ATR stops)
testVariant('4. Bidirectional (Longs in Bull, Shorts in Bear, ATR stops)', {
  useBtcRegimeFilter: true,
  atrStopMultiplier: 1.5,
  capStopAt32: false,
  allowShortsInBear: true,
  beBufferPct: 0.005,
});

// Variant 5: High Selectivity (Min volume $30M, stronger trend threshold)
testVariant('5. High Selectivity Trend Follower ($30M Vol, 3% momentum threshold)', {
  useBtcRegimeFilter: true,
  atrStopMultiplier: 1.2,
  capStopAt32: false,
  allowShortsInBear: true,
  beBufferPct: 0.003,
  minVolume24h: 30_000_000,
});

// Variant 6: Patient Swing Trend (4% momentum threshold, 48h cooldown post exit, asymmetric R:R)
testVariant('6. Patient Trend Follower (Low Turnover, Higher Quality R:R)', {
  useBtcRegimeFilter: true,
  atrStopMultiplier: 1.5,
  capStopAt32: false,
  allowShortsInBear: true,
  beBufferPct: 0.008,
  minVolume24h: 50_000_000,
});
