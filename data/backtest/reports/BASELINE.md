# Baseline Measurement Report: Quant Scalp Autopilot & Engine Models

**Date:** 2026-10-13  
**Period:** 2026-04-01 to 2026-09-30 (6 Months)  
**In-Sample Period:** 2026-04-01 to 2026-08-01 (4 Months)  
**Out-of-Sample Period:** 2026-08-01 to 2026-09-30 (2 Months)  
**Test Universe:** BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT  
**Execution Environment:** Deterministic historical replay, pure engine core, closed candles, honest limit fills, realistic maker/taker fees (5 bps) and slippage (5–15 bps).

---

## 1. Executive Summary

- **Survival Criteria (from ROADMAP.md Step 2):**
  1. $\ge 150$ trades in-sample.
  2. In-sample Avg R > 0 after round-trip costs, with Profit Factor > 1.15.
  3. Out-of-sample Avg R > 0.
  4. No single month > 40% of Total R.
- **SURVIVORS: ZERO (0)**.
- **Finding:**
  1. Under default production configuration (`allocation.max_fee_drag_pct: 15`): **Over 99% of all scalp signals are rejected** as `fees_too_high` (860+ rejections across 5 majors). On `BTCUSDT`, 100% of signals are rejected. The few trades that passed (5 in-sample, 3 out-of-sample) failed out-of-sample validation (-1.3R, Avg R -0.43R).
  2. In an unconstrained simulation (`allocation.max_fee_drag_pct: 100`): Scalp setups traded 70 times, suffered a **30.0% win rate**, net **-24.7R**, **Profit Factor 0.49**, and triggered the **15% account drawdown kill switch** in 45 days.
  3. Core engine models (`zone_sweep`, `session_sweep`, `htf_poi`): Highly selective (+1.1R on 3 trades), but generated only 3 trades across 6 months ($N \ll 150$).
- **Action Required:**
  Per `ROADMAP.md` Step 2 directive (*"If nothing survives, say so plainly and stop the autopilot. Don't keep a losing strategy running"*), **the live Quant Scalp Autopilot must be disabled immediately**.

---

## 2. Quantitative Performance Matrix

### 2.1 Default Production Configuration (`max_fee_drag_pct: 15`)

Tested across `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `XRPUSDT` over April 1 – September 30, 2026.

| Setup / Model | Orders Placed | Trades Filled | Fill % | In-Sample Trades (R) | Out-of-Sample Trades (R) | Total R | Win % | PF | Verdict |
|:---|---:|---:|---:|---:|---:|---:|---:|---:|:---|
| **ema_pullback [15m]** | 6 | 5 | 83.3% | 2 (+1.0R) | 3 (-1.4R) | -0.4R | 40.0% | 0.84 | **FAIL** (N=5, OOS < 0) |
| **sweep_reclaim [5m, 15m]** | 0 | 0 | 0.0% | 0 (0.0R) | 0 (0.0R) | 0.0R | 0.0% | 0.00 | **FAIL** (N=0, 100% fee drag) |
| **vwap_bounce [5m, 15m]** | 0 | 0 | 0.0% | 0 (0.0R) | 0 (0.0R) | 0.0R | 0.0% | 0.00 | **FAIL** (N=0, 100% fee drag) |
| **fvg_retest [5m, 15m]** | 0 | 0 | 0.0% | 0 (0.0R) | 0 (0.0R) | 0.0R | 0.0% | 0.00 | **FAIL** (N=0, 100% fee drag) |
| **volume_climax [5m, 15m]** | 0 | 0 | 0.0% | 0 (0.0R) | 0 (0.0R) | 0.0R | 0.0% | 0.00 | **FAIL** (N=0, 100% fee drag) |
| **orb [5m, 15m]** | 0 | 0 | 0.0% | 0 (0.0R) | 0 (0.0R) | 0.0R | 0.0% | 0.00 | **FAIL** (N=0, 100% fee drag) |
| **htf_poi** (Engine) | 0 | 2 | N/A | 2 (+1.1R) | 0 (0.0R) | +1.1R | 50.0% | 97.1 | **FAIL** (N=2 << 150) |
| **session_sweep** (Engine) | 0 | 1 | N/A | 1 (+0.0R) | 0 (0.0R) | +0.0R | 100.0% | – | **FAIL** (N=1 << 150) |
| **zone_sweep** (Engine) | 0 | 0 | N/A | 0 (0.0R) | 0 (0.0R) | 0.0R | 0.0% | 0.00 | **FAIL** (N=0) |

---

### 2.2 Unconstrained Fee Drag Stress Test (`max_fee_drag_pct: 100`)

To inspect the raw statistical behavior of the scalp setups without the fee drag gatekeeper, we simulated all generated setups across the major universe:

- **Total Trades Taken:** 70
- **Win Rate:** 30.0% (21 wins / 49 losses)
- **Total R:** -24.7R
- **Average Trade:** -0.35R
- **Profit Factor:** 0.49
- **Max Drawdown:** 15.00% (Hit account kill switch in May 2026; halted 476 subsequent trades)

#### Breakdown by Setup (Unconstrained):
| Setup | Trades | Win Rate | Total R | Profit Factor | Avg Hold |
|:---|---:|---:|---:|---:|---:|
| `ema_pullback [15m] long` | 19 | 26.3% | -3.5R | 0.66 | 93m |
| `ema_pullback [15m] short` | 16 | 50.0% | -1.3R | 0.64 | 146m |
| `ema_pullback [5m] long` | 13 | 30.8% | -5.4R | 0.47 | 90m |
| `ema_pullback [5m] short` | 6 | 16.7% | +0.4R | 0.86 | 61m |
| `fvg_retest [15m & 5m]` | 4 | 25.0% | -2.2R | 0.31 | 130m |
| `orb [15m]` | 2 | 0.0% | -2.8R | 0.00 | 4m |
| `sweep_reclaim [15m]` | 1 | 0.0% | -1.4R | 0.00 | 14m |
| `volume_climax [15m]` | 3 | 0.0% | -4.7R | 0.00 | 69m |
| `vwap_bounce [15m & 5m]` | 3 | 0.0% | -3.8R | 0.00 | 75m |

---

## 3. The Core Quantitative Diagnosis

### 3.1 The "Fee Drag" Mathematical Dilemma
1. In perpetual futures, round-trip transaction costs are:
   $$\text{Round-Trip Cost} = 2 \times (\text{Taker Fee } 0.05\% + \text{Slippage } 0.05\%) = 0.20\%$$
2. On 5m and 15m scalp setups, stop loss distances are typically between $0.3\%$ and $1.0\%$.
3. As a percentage of risk, transaction friction is:
   $$\text{Fee Drag} = \frac{0.20\%}{\text{Stop Distance}} \times 100$$
   - A $0.50\%$ stop loss incurs $\frac{0.20\%}{0.50\%} \times 100 = \mathbf{40\% \text{ Fee Drag}}$ (0.40R penalty).
   - Any trade with a stop tighter than $1.33\%$ violates `allocation.max_fee_drag_pct: 15`.
4. Therefore:
   - If `max_fee_drag_pct` is set to 15%, **the bot is mathematically blocked from trading 99.4% of scalp signals**.
   - If `max_fee_drag_pct` is relaxed, **every trade starts at -0.3R to -0.6R in the hole**, resulting in negative expectancy (-0.35R/trade) and rapid capital exhaustion.

### 3.2 Adverse Selection on Limit Pullbacks
The autopilot attempts to enter at `min/max(keyLevel, entry)`.
In volatile trending markets:
- Trades that easily fill at the key level limit often experience continuation against the position (adverse selection), leading to quick stop-outs.
- High-probability moves take off without filling the limit order.

---

## 4. Final Verdict & Actions

1. **Survival Roster:**
   - Surviving Scalp Setups: **NONE**.
   - Surviving Engine Models: **NONE** (insufficient trade count $N < 150$).
2. **Immediate System Action:**
   - Set `scalp_autopilot.enabled: false` in `engine/config/config.yaml`.
   - Update `engine/config/schema.ts` to support `enabled: z.boolean().default(false)`.
   - Set `scalp_autopilot.kinds: []`.
   - Issue `/api/control/quant-scalp-autopilot` with `{ enabled: false }` to ensure the live server immediately halts all automated scalp order submission.
3. **Transition to Step 3:**
   - Any future iteration on scalps must solve the structural friction problem (e.g. maker fee execution with rebate/zero fee, wider stop minimums relative to ATR, higher timeframe filters, session open avoidance).

