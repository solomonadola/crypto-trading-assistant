# Institutional Crypto Trading Engine: Strategy Architecture & Specification

## 1. Executive Summary & Core Philosophy

This application is built on an **Asymmetric High-Reward (1:3 to 1:5 R) Quantitative Framework** designed specifically for crypto altcoin volatility.

### The Problem With Traditional Retail Bots ("Machine Gun Trap"):
* Most retail trading bots take 40–100 trades per week aiming for small +1.0% scalps with wide -3.0% stops (an inverted 1:0.3 R ratio).
* In sideways crypto consolidation, exchange taker fees (30 bps round-trip) and slippage eat **25% to 32% of the total account equity per year**.
* A single flash-crash stops out multiple positions, wiping out 10+ small wins in minutes.

### The Institutional Solution ("Asymmetric Sniper"):
* **Quality Over Quantity:** Executes only **15 to 25 high-conviction trades per month** (~1 trade every 1–2 days across the entire 33-asset watchlist).
* **Positive Mathematical Expectancy:** Every setup risks 1.0R (~2.0% of portfolio equity) to target **+3.0R Core Profit (1:3)** and **+5.0R Parabolic Runner (1:5)**.
* **Capital Preservation:** By trading 70% less frequently, the portfolio saves over **$190+ per year in exchange fees alone**.

---

## 2. The 4 Quantitative Pillars

```
                               ┌──────────────────────────────────────────────┐
                               │         MACRO REGIME GATING (BTC)            │
                               │   BTC > 20D & 50D Daily Moving Averages      │
                               └──────────────────────┬───────────────────────┘
                                                      │
                                                      ▼
                               ┌──────────────────────────────────────────────┐
                               │         MARKET CHOP LOCK (DEFENSE)           │
                               │  Avg 24h Volatility >= 3.2% & >= 4 Pairs Mov  │
                               └──────────────────────┬───────────────────────┘
                                                      │
                                                      ▼
                               ┌──────────────────────────────────────────────┐
                               │         HIGH-CONVICTION SETUP GATING         │
                               │  Volume >= $30M, Score >= 84, TRIGGEREDwick  │
                               └──────────────────────┬───────────────────────┘
                                                      │
                                                      ▼
                               ┌──────────────────────────────────────────────┐
                               │         30 / 40 / 30 ASYMMETRIC LADDER        │
                               │    T1: +1.5R (30%) -> Move Stop to BE +0.5%  │
                               │    T2: +3.0R (40%) -> Core Target Banked     │
                               │    T3: +5.0R (30%) -> Trailing Trend Runner  │
                               └──────────────────────┬───────────────────────┘
                                                      │
                                                      ▼
                               ┌──────────────────────────────────────────────┐
                               │         MONTHLY RISK BUDGET CIRCUIT          │
                               │   Max -6.0% Calendar Month Loss -> Sits Cash  │
                               └──────────────────────────────────────────────┘
```

### Pillar 1: Macro BTC Trend Gating
* **Rule:** Long positions on altcoins are **strictly prohibited** unless Bitcoin is trading above its 20-day and 50-day Daily Moving Averages ($MA_{20}$ and $MA_{50}$).
* **Rationale:** Over 85% of altcoin breakdown losses happen when traders try to buy altcoin dips while Bitcoin is in a macro downtrend. When Bitcoin dumps, altcoins drop 2x–3x harder.

### Pillar 2: Market Chop Lock (Volatility Floor $\ge 3.2\%$)
* **Rule:** If the average 24-hour volatility across Binance assets drops below 3.2%, or fewer than 4 coins are moving $\ge \pm3\%$, the engine locks into **100% Cash Defense**.
* **Rationale:** In compressed sideways markets, breakout follow-through is near 0%. Sidelining the bot during low-volume chop eliminates over $200 in false-breakout whipsaws.

### Pillar 3: The 30 / 40 / 30 Harvest Ladder
* **Tier 1 (+1.5 R — 30% Harvest):**
  * Harvests 30% of the position. Covers all trading costs and slippage.
  * **Crucial Action:** The hard stop-loss immediately ratchets to **Entry $+0.5\%$**. The position is now **100% risk-free**.
* **Tier 2 (+3.0 R — 40% Harvest — Core Target):**
  * Takes off 40% of the initial position at major 4-Hour structural resistance.
  * Secures the core $+6.0\%$ account profit.
  * Stop jumps to Tier 1 price level.
* **Tier 3 (+5.0 R — 30% Harvest — Parabolic Runner):**
  * The final 30% trails behind price at $1.5\times\text{ATR}$.
  * Captures giant multi-day trend expansions (+20% to +40% moves on coins like SOL, NEAR, SUI).

### Pillar 4: The -6.0% Monthly Loss Budget Circuit Breaker
* **Rule:** If total net losses in a single calendar month reach **-6.0% of the account equity**, all new entries are frozen until the 1st day of the next month.
* **Rationale:** Protects capital against abnormal black-swan market conditions. Capital preservation ensures the portfolio is intact when clean trend conditions return.

---

## 3. Mathematical Expectancy

> **Measured, 2026-09-26:** the table below is a hypothesis, not a result. Run through
> `tools/backtest.mjs` on 34 coins from 2024-09 to 2026-08 (January and February 2026
> missing from the data), the live rules lost 29.8% on $100 (1,598 trades, 24% win rate,
> profit factor 0.56, max drawdown -31%), while BTC held returned +33%. 94% of trades were
> closed by the 2.5-hour stale-trade recycle rather than by a target or stop; with it off
> the loss was 13.3% (profit factor 0.86). No tested setting was profitable. Results are
> in `data/backtests/` and the Backtest Lab tab.

Given 20 trades in a typical month at a conservative **45% Win Rate** (9 Wins, 11 Losses):

$$\text{Risk per Trade (1R)} = \$20.00 \quad (2.0\% \text{ on a } \$1,000 \text{ Bankroll})$$

| Category | Trades | Avg Return per Trade | Total PnL |
| :--- | :---: | :---: | :---: |
| **Full Stop Loss** | 11 | -$20.00 (-1.0 R) | **-$220.00** |
| **Tier 1 Scratch / Breakeven** | 3 | +$9.00 (+0.45 R net) | **+$27.00** |
| **Core 1:3 R Hits** | 4 | +$60.00 (+3.0 R) | **+$240.00** |
| **Parabolic 1:5 R Runners** | 2 | +$100.00 (+5.0 R) | **+$200.00** |
| **Gross Monthly Gain** | — | — | **+$247.00** |
| **Exchange Fees (20 trades)** | — | — | **-$28.00** |
| **Net Monthly Return** | — | — | **+$219.00 (+21.9% ROI)** |

---

## 4. Code Architecture & Key Modules

* `src/config/geometry.ts`: Defines `StrategyProfile` presets (`ASYMMETRIC_SNIPER` and `DYNAMIC_SCALP`), ATR multiples, and harvest ratios.
* `src/services/autopilotEngine.ts`: Evaluates candidate setups, enforces cooldowns, checks the monthly risk budget, and manages position sizing.
* `src/services/marketRegimeService.ts`: Computes BTC macro status, 24h volatility radar, and triggers the `isConsolidationLocked` state.
* `tools/build-scanner.mjs`: Compiles the shared mathematical scanner module into `tools/_gen/scanner.mjs` for backtesting parity.
* `src/backtest/runBacktest.ts` + `tools/backtest.mjs`: the backtest. It runs the app's own scanner, entry decision, sizing and exit ladder over the Binance 5-minute candles on disk; results appear in the Backtest Lab tab. See the README.
* `tools/backtest-full-year.mjs`, `tools/backtest-tuned-vs-baseline.mjs`: older scripts with their own copies of the exit rules (and, in the second, its own entries). They read `data/klines1h/`, which is not downloaded, and they do not match the live engine; use `tools/backtest.mjs` instead.
