// Comprehensive 1-Year Historical Backtest & Simulation Engine
// Simulates the full auto-pilot portfolio engine over 1 year of real Binance hourly klines (2025-09-01 to 2026-08-31).
// Evaluates every hour with strictly rolling 24h windows (zero look-ahead bias).

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { scanLiveMarketEntries, analyzeFromCandles } from './_gen/scanner.mjs';

const BARS_24H = 24; // 24 x 1h bars = 24h rolling window
const DIR = 'data/klines1h';
const INITIAL_BANKROLL = 1000.0; // $1,000 baseline
const MAX_SLOTS = 10;
const TRANCHE_SIZE = INITIAL_BANKROLL / MAX_SLOTS; // $100 per tranche
const COST_RATE = 0.0015; // 15 bps per side (0.10% taker + 0.02% half-spread + 0.03% slippage) = 30 bps round-trip

const MAJORS = new Set(['BTC', 'ETH', 'BNB', 'SOL']);
const MEMES = new Set(['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'POPCAT']);

// Load Asset metadata
const assetSrc = readFileSync('src/services/binanceService.ts', 'utf8');
const ASSETS = [...assetSrc.matchAll(/\{ id: '([^']+)', symbol: '([A-Z0-9]+)', name: '([^']+)'/g)]
  .map(m => ({ id: m[1], symbol: m[2], name: m[3] }));

console.log(`\n===============================================================`);
console.log(`  BINANCE 1-YEAR BACKTEST SIMULATION (2025-09-01 -> 2026-08-31)`);
console.log(`===============================================================\n`);
console.log(`Loading 1-hour klines from ${DIR}...`);

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
      // Convert microseconds to milliseconds if needed
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
    // Precompute 4h bars
    const bars4h = [];
    for (let j = 0; j < bars.length; j += 4) {
      const chunk = bars.slice(j, j + 4);
      if (!chunk.length) continue;
      bars4h.push({
        t: chunk[0].t,
        o: chunk[0].o,
        h: Math.max(...chunk.map(c => c.h)),
        l: Math.min(...chunk.map(c => c.l)),
        c: chunk[chunk.length - 1].c,
        v: chunk.reduce((sum, c) => sum + (c.v || 0), 0),
      });
    }

    // Precompute 1d bars (24 x 1h)
    const bars1d = [];
    for (let j = 0; j < bars.length; j += 24) {
      const chunk = bars.slice(j, j + 24);
      if (!chunk.length) continue;
      bars1d.push({
        t: chunk[0].t,
        o: chunk[0].o,
        h: Math.max(...chunk.map(c => c.h)),
        l: Math.min(...chunk.map(c => c.l)),
        c: chunk[chunk.length - 1].c,
        v: chunk.reduce((sum, c) => sum + (c.v || 0), 0),
      });
    }

    series.set(a.symbol, { asset: a, bars, bars4h, bars1d });
  }
}

console.log(`Loaded ${series.size} asset pairs with full history.`);

// Master timeline using BTC as reference
const btcSeries = series.get('BTC');
if (!btcSeries) {
  console.error('BTC series not found! Cannot establish master timeline.');
  process.exit(1);
}
const clock = btcSeries.bars.map(b => b.t);
const idx = new Map();
for (const [sym, s] of series) {
  const m = new Map();
  s.bars.forEach((b, i) => m.set(b.t, i));
  idx.set(sym, m);
}

const startDateStr = new Date(clock[BARS_24H]).toISOString().slice(0, 10);
const endDateStr = new Date(clock.at(-1)).toISOString().slice(0, 10);
console.log(`Timeline: ${startDateStr} to ${endDateStr} (${clock.length - BARS_24H} hourly steps)\n`);

/**
 * Runs the portfolio simulation over the historical timeline.
 * @param {Object} options Configuration flags
 */
function runSimulation({ enableInducementGate = true, enableDeadZoneFilter = true }) {
  let cash = INITIAL_BANKROLL;
  let peakEquity = INITIAL_BANKROLL;
  let maxDrawdownPct = 0;
  
  // Active positions: Map of symbol -> Position
  const openPositions = new Map();
  const closedTrades = [];
  const monthlyPnL = new Map(); // 'YYYY-MM' -> { pnl: 0, trades: 0, wins: 0 }
  
  // Cooldown tracker: symbol -> timestamp until which no new trade allowed
  const cooldownUntil = new Map();
  // 2-hour loss dampener
  const recentLosses = [];

  let skippedByInducementTrap = 0;
  let skippedByDeadZone = 0;
  let skippedByConsolidation = 0;

  for (let k = BARS_24H; k < clock.length; k++) {
    const t = clock[k];
    const date = new Date(t);
    const monthKey = date.toISOString().slice(0, 7);
    if (!monthlyPnL.has(monthKey)) {
      monthlyPnL.set(monthKey, { pnl: 0, trades: 0, wins: 0 });
    }

    const hourUTC = date.getUTCHours();
    const dayUTC = date.getUTCDay(); // 0 is Sunday, 6 is Saturday

    // 1. UPDATE & RESOLVE OPEN POSITIONS
    for (const [sym, pos] of openPositions.entries()) {
      const s = series.get(sym);
      const barIdx = idx.get(sym)?.get(t);
      if (barIdx === undefined) continue;
      const bar = s.bars[barIdx];

      // Conservative barrier resolution:
      // If low hits stop, stop fills first.
      const isShort = pos.direction === 'SHORT';
      let hitStop = false;
      let hitT1 = false;
      let hitT2 = false;
      let hitT3 = false;

      if (!isShort) {
        // LONG
        if (bar.l <= pos.currentStopPrice) {
          hitStop = true;
        } else {
          if (!pos.t1Hit && bar.h >= pos.tier1Price) hitT1 = true;
          if (pos.t1Hit && !pos.t2Hit && bar.h >= pos.tier2Price) hitT2 = true;
          if (pos.t2Hit && bar.h >= pos.tier3Price) hitT3 = true;
        }
      } else {
        // SHORT
        if (bar.h >= pos.currentStopPrice) {
          hitStop = true;
        } else {
          if (!pos.t1Hit && bar.l <= pos.tier1Price) hitT1 = true;
          if (pos.t1Hit && !pos.t2Hit && bar.l <= pos.tier2Price) hitT2 = true;
          if (pos.t2Hit && bar.l <= pos.tier3Price) hitT3 = true;
        }
      }

      if (hitStop) {
        // Exit remainder at currentStopPrice
        const exitPrice = pos.currentStopPrice;
        const pricePctChange = isShort
          ? ((pos.entryPrice - exitPrice) / pos.entryPrice)
          : ((exitPrice - pos.entryPrice) / pos.entryPrice);
        
        // Fee for exit side
        const grossReturnUSD = pos.remainingSizeUSD * (1 + pricePctChange);
        const exitCostUSD = grossReturnUSD * COST_RATE;
        const netProceedsUSD = grossReturnUSD - exitCostUSD;
        
        pos.bankedProceedsUSD += netProceedsUSD;
        const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
        const netPnLPct = (netPnLUSD / pos.initialNotionalUSD) * 100;

        cash += netProceedsUSD;
        const tradeRecord = {
          symbol: sym,
          direction: pos.direction,
          entryTime: pos.entryTime,
          exitTime: t,
          entryPrice: pos.entryPrice,
          exitPrice,
          initialNotionalUSD: pos.initialNotionalUSD,
          netPnLUSD,
          netPnLPct,
          isWin: netPnLUSD > 0,
          exitReason: pos.t1Hit ? 'STOP_AT_BREAKEVEN' : 'INITIAL_STOP_LOSS',
          holdingHours: Math.round((t - pos.entryTime) / 3600000),
          archetype: pos.archetype,
        };
        closedTrades.push(tradeRecord);
        openPositions.delete(sym);

        // Update monthly stats
        const m = monthlyPnL.get(monthKey);
        m.pnl += netPnLUSD;
        m.trades += 1;
        if (tradeRecord.isWin) m.wins += 1;

        // Register cooldown
        cooldownUntil.set(sym, t + 3600000); // 1 hour cooldown post-exit
        if (!tradeRecord.isWin) {
          recentLosses.push(t);
        }
        continue;
      }

      if (hitT1) {
        pos.t1Hit = true;
        // Bank 33% harvest
        const harvestNotional = pos.initialNotionalUSD * 0.33;
        const pnlPct = (pos.tier1Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = harvestNotional * (1 + pnlPct) * (1 - COST_RATE);
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        pos.remainingSizeUSD -= harvestNotional;

        // Ratchet stop to Breakeven (+0.3% floor)
        const beFloor = isShort
          ? pos.entryPrice * (1 - 0.003)
          : pos.entryPrice * (1 + 0.003);
        pos.currentStopPrice = beFloor;
      }

      if (hitT2) {
        pos.t2Hit = true;
        // Bank 33% harvest
        const harvestNotional = pos.initialNotionalUSD * 0.33;
        const pnlPct = (pos.tier2Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = harvestNotional * (1 + pnlPct) * (1 - COST_RATE);
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;
        pos.remainingSizeUSD -= harvestNotional;

        // Ratchet stop to lock in Tier 1 profit floor
        pos.currentStopPrice = pos.tier1Price;
      }

      if (hitT3) {
        pos.t3Hit = true;
        // Bank remaining ~34% at Tier 3
        const pnlPct = (pos.tier3Price - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
        const proceeds = pos.remainingSizeUSD * (1 + pnlPct) * (1 - COST_RATE);
        pos.bankedProceedsUSD += proceeds;
        cash += proceeds;

        const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
        const netPnLPct = (netPnLUSD / pos.initialNotionalUSD) * 100;

        const tradeRecord = {
          symbol: sym,
          direction: pos.direction,
          entryTime: pos.entryTime,
          exitTime: t,
          entryPrice: pos.entryPrice,
          exitPrice: pos.tier3Price,
          initialNotionalUSD: pos.initialNotionalUSD,
          netPnLUSD,
          netPnLPct,
          isWin: true,
          exitReason: 'FULL_HARVEST_T3',
          holdingHours: Math.round((t - pos.entryTime) / 3600000),
          archetype: pos.archetype,
        };
        closedTrades.push(tradeRecord);
        openPositions.delete(sym);

        const m = monthlyPnL.get(monthKey);
        m.pnl += netPnLUSD;
        m.trades += 1;
        m.wins += 1;
        cooldownUntil.set(sym, t + 3600000);
      }
    }

    // Measure total portfolio equity (cash + open positions mark-to-market)
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

    // 2. CHECK IF NEW ENTRY IS ALLOWED
    if (openPositions.size >= MAX_SLOTS) continue;
    if (cash < TRANCHE_SIZE) continue;

    // Check 2-hour loss dampener
    const recent2hLosses = recentLosses.filter(lt => (t - lt) <= 7200000);
    if (recent2hLosses.length >= 2) continue; // Cool down

    // Check Dead-Zone Pause
    if (enableDeadZoneFilter) {
      // 21:00-01:00 UTC rollover
      if (hourUTC >= 21 || hourUTC < 1) {
        skippedByDeadZone++;
        continue;
      }
      // Weekend lull
      if (dayUTC === 0 || dayUTC === 6) {
        skippedByDeadZone++;
        continue;
      }
    }

    // 3. RECONSTRUCT 24H ROLLING SNAPSHOT FOR SCANNER
    const coins = [];
    let sumAbsVol = 0;
    for (const [sym, s] of series) {
      const i = idx.get(sym)?.get(t);
      if (i === undefined || i < BARS_24H) continue;
      let hi = -Infinity, lo = Infinity, qv = 0;
      for (let j = i - BARS_24H + 1; j <= i; j++) {
        const b = s.bars[j];
        if (b.h > hi) hi = b.h;
        if (b.l < lo) lo = b.l;
        qv += b.qv;
      }
      const price = s.bars[i].c;
      const prev = s.bars[i - BARS_24H].c;
      if (!(price > 0) || !(prev > 0) || !(qv > 0)) continue;
      const pct24h = ((price - prev) / prev) * 100;
      sumAbsVol += Math.abs(pct24h);

      const h1Slice = s.bars.slice(Math.max(0, i - 100), i + 1);
      const cur4hIdx = Math.floor(i / 4);
      const h4Slice = s.bars4h ? s.bars4h.slice(Math.max(0, cur4hIdx - 50), cur4hIdx + 1) : [];
      const cur1dIdx = Math.floor(i / 24);
      const d1Slice = s.bars1d ? s.bars1d.slice(Math.max(0, cur1dIdx - 30), cur1dIdx + 1) : [];

      const analysis = analyzeFromCandles(price, h1Slice, h4Slice, d1Slice, t);

      coins.push({
        id: s.asset.id,
        symbol: s.asset.symbol.toLowerCase(),
        name: s.asset.name,
        current_price: price,
        price_change_percentage_24h: pct24h,
        high_24h: hi,
        low_24h: lo,
        total_volume: qv,
        market_cap: qv * 15,
        analysis,
      });
    }

    if (coins.length < 10) continue;

    // Check Market Consolidation (<2.0% avg 24h volatility)
    const avgMarketVol = sumAbsVol / coins.length;
    if (avgMarketVol < 2.0) {
      skippedByConsolidation++;
      continue;
    }

    // 4. RUN LIVE SCANNER
    const signals = scanLiveMarketEntries(coins, 'FUTURES_1_2D');

    // Filter eligible candidates
    const eligible = signals.filter(sig => {
      if (openPositions.has(sig.symbol)) return false;
      if (cooldownUntil.has(sig.symbol) && t < cooldownUntil.get(sig.symbol)) return false;
      if (sig.direction !== 'LONG') return false; // Focus on primary long momentum
      if (sig.score < 80) return false;
      if (sig.status !== 'TRIGGERED') return false;

      // Sector limits
      const sym = sig.symbol.toUpperCase();
      const currentMajors = [...openPositions.keys()].filter(k => MAJORS.has(k)).length;
      if (MAJORS.has(sym) && currentMajors >= 3) return false;
      const currentMemes = [...openPositions.keys()].filter(k => MEMES.has(k)).length;
      if (MEMES.has(sym) && currentMemes >= 2) return false;

      // In SMC-enabled run: status must be TRIGGERED, levelGate passed, and inducement safe
      if (enableInducementGate) {
        if (sig.status !== 'TRIGGERED') return false;
        if (sig.inducement && !sig.inducement.isSafeToEnter) {
          skippedByInducementTrap++;
          return false;
        }
        if (sig.levelGate && sig.levelGate.measured && !sig.levelGate.passed) {
          return false;
        }
      } else {
        // Baseline (Pre-SMC): would enter even if an inducement trap was pending
        const isBlockedOnlyByInducement = sig.levelGate?.reason?.toLowerCase().includes('inducement') ?? false;
        if (sig.status !== 'TRIGGERED' && !isBlockedOnlyByInducement) return false;
      }

      return true;
    });

    if (eligible.length === 0) continue;

    // Sort by trade quality score
    eligible.sort((a, b) => (b.tradeQualityScore || b.score) - (a.tradeQualityScore || a.score));

    // Deploy top candidate
    const top = eligible[0];
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
      currentStopPrice: top.tradePlan.stopLossPrice,
      tier1Price: top.tradePlan.tier1Price,
      tier2Price: top.tradePlan.tier2Price,
      tier3Price: top.tradePlan.tier3TargetPrice,
      t1Hit: false,
      t2Hit: false,
      t3Hit: false,
      bankedProceedsUSD: 0,
      archetype: top.archetypeName || top.archetype,
    });
  }

  // Close remaining positions at last available bar
  for (const [sym, pos] of openPositions.entries()) {
    const s = series.get(sym);
    const bar = s.bars[s.bars.length - 1];
    const isShort = pos.direction === 'SHORT';
    const pnlPct = (bar.c - pos.entryPrice) / pos.entryPrice * (isShort ? -1 : 1);
    const proceeds = pos.remainingSizeUSD * (1 + pnlPct) * (1 - COST_RATE);
    pos.bankedProceedsUSD += proceeds;
    cash += proceeds;
    const netPnLUSD = pos.bankedProceedsUSD - pos.initialNotionalUSD;
    const netPnLPct = (netPnLUSD / pos.initialNotionalUSD) * 100;
    closedTrades.push({
      symbol: sym,
      direction: pos.direction,
      entryTime: pos.entryTime,
      exitTime: clock[clock.length - 1],
      entryPrice: pos.entryPrice,
      exitPrice: bar.c,
      initialNotionalUSD: pos.initialNotionalUSD,
      netPnLUSD,
      netPnLPct,
      isWin: netPnLUSD > 0,
      exitReason: 'END_OF_SIMULATION',
      holdingHours: Math.round((clock[clock.length - 1] - pos.entryTime) / 3600000),
      archetype: pos.archetype,
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
  const totalReturnPct = (netPnLUSD / INITIAL_BANKROLL) * 100;
  const avgHoldHours = totalTrades > 0
    ? (closedTrades.reduce((sum, t) => sum + t.holdingHours, 0) / totalTrades).toFixed(1)
    : 0;

  return {
    initialBankroll: INITIAL_BANKROLL,
    finalBankroll: +cash.toFixed(2),
    netPnLUSD: +netPnLUSD.toFixed(2),
    totalReturnPct: +totalReturnPct.toFixed(2),
    totalTrades,
    winsCount: wins.length,
    lossesCount: losses.length,
    winRate: +winRate.toFixed(2),
    profitFactor: +profitFactor.toFixed(2),
    maxDrawdownPct: +maxDrawdownPct.toFixed(2),
    avgHoldingHours: avgHoldHours,
    skippedByInducementTrap,
    skippedByDeadZone,
    skippedByConsolidation,
    monthlyPnL: Object.fromEntries(monthlyPnL),
    tradesSample: closedTrades.slice(0, 10),
  };
}

// 1. RUN SIMULATION WITH ALL SAFEGUARDS & SMC INDUCEMENT ENGINE
console.log(`Running 1-Year Backtest with SMC Inducement & Liquidity Sweep Engine...`);
const fullRun = runSimulation({ enableInducementGate: true, enableDeadZoneFilter: true });

// 2. RUN ABLATION (WITHOUT SMC INDUCEMENT ENGINE) TO MEASURE VALUE-ADD
console.log(`Running 1-Year Ablation Test (Without SMC Inducement Engine)...`);
const baselineRun = runSimulation({ enableInducementGate: false, enableDeadZoneFilter: true });

console.log(`\n===============================================================`);
console.log(`                 1-YEAR PERFORMANCE RESULTS                   `);
console.log(`===============================================================\n`);

console.log(`Metric                        WITH SMC Gating     WITHOUT SMC (Baseline)`);
console.log(`---------------------------------------------------------------------`);
console.log(`Initial Capital:              $${fullRun.initialBankroll.toFixed(2)}             $${baselineRun.initialBankroll.toFixed(2)}`);
console.log(`Final Portfolio Value:        $${fullRun.finalBankroll.toFixed(2)}             $${baselineRun.finalBankroll.toFixed(2)}`);
console.log(`Net Profit ($):               $${fullRun.netPnLUSD.toFixed(2)}             $${baselineRun.netPnLUSD.toFixed(2)}`);
console.log(`Total Return (%):             +${fullRun.totalReturnPct}%              +${baselineRun.totalReturnPct}%`);
console.log(`Win Rate (%):                 ${fullRun.winRate}%                 ${baselineRun.winRate}%`);
console.log(`Profit Factor:                ${fullRun.profitFactor}                 ${baselineRun.profitFactor}`);
console.log(`Max Drawdown (%):             ${fullRun.maxDrawdownPct}%                 ${baselineRun.maxDrawdownPct}%`);
console.log(`Total Trades Taken:           ${fullRun.totalTrades}                  ${baselineRun.totalTrades}`);
console.log(`Trades Won / Lost:            ${fullRun.winsCount} / ${fullRun.lossesCount}             ${baselineRun.winsCount} / ${baselineRun.lossesCount}`);
console.log(`Avg Holding Time:             ${fullRun.avgHoldingHours} hrs              ${baselineRun.avgHoldingHours} hrs`);
console.log(`Inducement Traps Avoided:     ${fullRun.skippedByInducementTrap} traps avoided`);
console.log(`Dead-Zone Periods Skipped:    ${fullRun.skippedByDeadZone} hours`);
console.log(`Consolidation Hours Skipped:  ${fullRun.skippedByConsolidation} hours`);
console.log(`---------------------------------------------------------------------\n`);

console.log(`\nMONTHLY BREAKDOWN (With SMC Engine):`);
console.log(`Month        Net PnL ($)    Trades    Win Rate`);
console.log(`-----------------------------------------------`);
for (const [month, data] of Object.entries(fullRun.monthlyPnL)) {
  const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(1) : '0.0';
  const pnlSign = data.pnl >= 0 ? '+' : '';
  console.log(`${month}      ${pnlSign}$${data.pnl.toFixed(2).padEnd(10)} ${String(data.trades).padEnd(8)} ${wr}%`);
}

// Save detailed report to data/backtest-results-1yr.json
writeFileSync('data/backtest-results-1yr.json', JSON.stringify({ fullRun, baselineRun }, null, 2));
console.log(`\nFull report saved to data/backtest-results-1yr.json`);
