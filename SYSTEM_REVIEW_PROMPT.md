# Master Architecture & Quantitative Review Prompt

> **Instructions for the Reviewer / AI Agent:**
> You are acting as a **Principal Quantitative Trading Systems Architect** and **Senior Financial Software Engineer**.
> Your task is to conduct an exhaustive, rigorous, zero-bullshit architectural and mathematical audit of this automated cryptocurrency trading system (**Crypto Trading Assistant / Session Engine**).
> 
> Review every layer of the system: from the pure state engine and real-time feeds to the 1m–15m quant scalp autopilot, anti-fakeout filters, risk management, and React UI.
> 
> Provide brutal, constructive analysis. Identify hidden risks, mathematical flaws, execution race conditions, edge-decay factors, and structural strengths.

---

## 1. System Overview & Context

This repository is a full-stack, automated crypto trading system running on Node.js / TypeScript with a React 19 frontend. It is designed to trade Binance USDT-M perpetual / spot markets across multi-timeframe swing structures and fast-cycle session scalps.

### Repository Map
- **Core Trading Engine (`engine/src/core/engine.ts`)**: Pure, deterministic state machine handling accounts, positions, pending limit orders, time-stops, ladder exits, and halts.
- **Quant Scalp Engine (`engine/src/analysis/scalp.ts`)**: 1m, 5m, and 15m scalp setup detector (EMA20 pullbacks, VWAP bounces, Swing Failure Pattern sweeps, Fair Value Gap fills).
- **Quant Autopilot (`engine/src/main.ts`)**: Automated execution daemon scanning candle batches, filtering traps, and dispatching limit pullback orders.
- **Anti-Fakeout & Filter Suite (`engine/src/filters.ts`, `engine/config/config.yaml`)**: Mathematical breakout validation (`close_beyond_atr`, `min_close_position`, `max_upper_wick_ratio`, `min_rvol`).
- **Trap & Pump Radar (`engine/src/analysis/pumpWatch.ts`)**: Real-time liquidity sweep detector (`failed_high`, `failed_low`, `pump_blowoff`, `sweep_reclaim`, ADR exhaustion).
- **Exit & Trade Management (`engine/src/exits.ts`)**: Dynamic multi-stage exits (3-candle `failed_breakout` emergency bailout, ChOCH breaks, 4h trend change, profit ladder).
- **Market Data Feed & Simulator (`engine/src/feed.ts`, `engine/src/core/sim.ts`)**: Live WebSocket Binance client with fee/slippage simulation.
- **Frontend Dashboard (`src/pages/Scalp.tsx`, `Overview.tsx`, `Trades.tsx`, `Market.tsx`, `Ideas.tsx`)**: High-density trading cockpit.
- **Test Suite (`engine/tests/`)**: 359 Vitest unit tests including strict engine purity verification (`purity.test.ts`).

---

## 2. Review Checklist & Focus Areas

Please analyze and report on each of the following 6 core dimensions:

### Dimension 1: Quant Scalping & Autopilot Mechanics
1. **Setup Integrity (`engine/src/analysis/scalp.ts`)**:
   - How robust are the 4 scalp algorithms (`ema_pullback`, `vwap_bounce`, `sfp_sweep`, `fvg_fill`)?
   - Is the `keyLevel` calculation mathematically sound for limit pullback execution?
   - Does restricting `ema_pullback` away from `1m` effectively eliminate random altcoin noise without sacrificing alpha?
2. **Autopilot Execution Loop (`engine/src/main.ts:runQuantAutopilot`)**:
   - Are the gating rules (5m/15m only, mandatory 1h trend alignment `withTrend === true`, max stop distance $\le 2.2\%$) sufficient to prevent catastrophic drawdowns?
   - How does the system handle limit order lifecycles when price runs away without filling?
   - Are deduplication keys (`autoPlacedScalps`) immune to memory leaks or replay bugs?

### Dimension 2: Anti-Fakeout & False Breakout Protections
1. **Mathematical Filter Geometry (`engine/src/filters.ts:fakeout`)**:
   - Evaluate the 4 core formulas:
     - Penetration: `(sign * (close - level)) / atr >= 0.20`
     - Close quality: `closePos >= 0.70`
     - Rejection wick limit: `upperWick <= 0.40`
     - Volume expansion: `rvol >= 2.0x`
   - Does this filter successfully weed out institutional stop runs, absorption wicks, and low-volume drift?
2. **SFP & Liquidity Sweep Radar (`engine/src/analysis/pumpWatch.ts`)**:
   - Inspect `failedBreaks()` detecting 24-hour high/low sweeps on $\ge 1.5\times$ volume with $\ge 50\%$ wicks.
   - Does the engine properly block opposing trades (`failed_high` blocking longs)?
   - How effective is the `sweep_reclaim` reversal setup?
3. **Emergency Bailout (`engine/src/exits.ts:36-37`)**:
   - Evaluate the 3-candle rule: If price closes back across the broken level within 3 candles, execute immediate `failed_breakout` exit.
   - Is 3 candles optimal, or does it trigger premature shakeouts on healthy retests?

### Dimension 3: Core Engine Architecture & Purity
1. **Functional Purity (`engine/src/core/engine.ts`, `purity.test.ts`)**:
   - Does `engine.ts` maintain 100% side-effect-free purity (zero I/O, deterministic state transitions via `onCandle`, `onTime`, `command`)?
   - Are all mathematical operations safe from `NaN`, `Infinity`, and division-by-zero errors?
2. **Position Sizing & Risk Management**:
   - Inspect portfolio sizing, account risk percentages, margin usage, and max daily drawdown circuit-breakers (`halted`).
   - Can a rapid multi-coin flash crash bypass risk constraints?
3. **Time-Stop Protection (`engine/src/core/engine.ts:onTime`)**:
   - Scalp positions now enforce hard time stops (1m: 45m, 5m: 2h, 15m: 4h).
   - Are there edge cases where open positions linger beyond these thresholds?

### Dimension 4: Market Data Pipeline & Execution Realism
1. **Feed Resilience (`engine/src/feed.ts`)**:
   - How does the feed handle dropped WebSocket packets, out-of-order candles, Binance rate limits, and reconnection gaps?
   - Does the engine prevent duplicate triggers on incomplete/forming candles vs closed candles?
2. **Simulation Fidelity (`engine/src/core/sim.ts`)**:
   - Are trading fees (taker/maker), funding rates, and slippage accurately modeled?
   - Does the backtester/simulator exhibit lookahead bias or unrealistic limit-order fill assumptions?

### Dimension 5: Frontend Interface & Operational UX
1. **Telemetry & Synchronization (`src/pages/Scalp.tsx`, `src/lib/api.ts`)**:
   - How reliably does the React UI reflect engine state, pending limit orders, and active warnings?
   - Is the manual sniper interface ("Take Limit" pre-filling `keyLevel`) safe against accidental double-clicks or stale quotes?

### Dimension 6: Edge Cases, Latency & Live-Trading Readiness
1. **Known Vulnerabilities**:
   - What happens during a BTC flash crash? Does the BTC regime dump filter (`dumping`) react fast enough?
   - What happens when Binance spreads widen during high-volatility news events?
   - Are there any blocking synchronous operations on the Node.js event loop in `engine/src/main.ts`?

---

## 3. Required Output Format

Please structure your review as follows:

```markdown
# Quantitative & Architectural System Audit Report

## 1. Executive Summary & System Scorecard
- Overall Architectural Grade (A-F)
- Statistical Edge Viability (High / Medium / Low / Negative)
- Production Readiness Score (1-10)
- Core Strengths & Critical Red Flags

## 2. In-Depth Technical Audit
### A. Scalp Autopilot & Entry Execution
### B. Anti-Fakeout & Trap Detection Mechanics
### C. Engine Core, Risk Limits & Time-Stops
### D. Market Feed & Simulation Realism
### E. Frontend & Operational Controls

## 3. Vulnerability & Bug Register
| Severity (P0/P1/P2) | File & Line Range | Issue Description | Impact / Failure Mode | Recommended Remedy |
|---|---|---|---|---|

## 4. Quantitative Edge Analysis
- Mathematical expectancy of the setup-filter-exit pipeline.
- Risk-of-Ruin (RoR) and tail-risk assessment.
- Slippage and fee drag sensitivity.

## 5. Strategic Recommendations & Action Plan
- Top 3 critical fixes to implement immediately before increasing live capital.
- Architectural enhancements for low-latency scaling.
```

---

*Load this prompt into your evaluation agent to begin the comprehensive system audit.*

