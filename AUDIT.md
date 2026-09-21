# Ladder Without an Edge

**A quantitative audit of the CryptoStudyLab autonomous engine**

The bot enters and exits quickly because its exit ladder is mathematically EV-neutral, its stop sits at roughly half the volatility it claims to adapt to, and its 100-point, five-pillar, multi-timeframe scanner reduces algebraically to a single number: the 24-hour percent change.

| | |
|---|---|
| **Scope** | 14,079 LOC · TypeScript / React 19 · 16 services, 19 components |
| **Reviewed** | 2026-09-21 |
| **Status of system** | Simulated positions — deliberate pre-deployment test phase |
| **Missing** | No backtest, no tests, no exchange execution |
| **Code modified** | None |

---

## Contents

1. [Bottom line](#bottom-line)
2. [What the system actually is](#1-what-the-system-actually-is)
3. [The scanner collapses to one variable](#2-the-scanner-collapses-to-one-variable)
4. [Why it enters and exits quickly](#3-why-it-enters-and-exits-quickly)
5. [The ladder is EV-neutral](#4-the-ladder-is-ev-neutral-so-the-entry-carries-all-the-weight)
6. [What kind of strategy this is](#5-what-kind-of-strategy-this-is)
7. [Microstructure and the cost budget](#6-microstructure-and-the-cost-budget)
8. [Diagnose before optimising](#7-diagnose-before-optimising-separate-the-entry-from-the-exit)
9. [Backtest framework](#8-backtest-framework)
10. [Risk model](#9-risk-model)
11. [Changes, in dependency order](#10-changes-in-dependency-order)
12. [Experiment framework](#11-experiment-framework)
13. [What would change my assessment](#12-what-would-change-my-assessment)

---

## Bottom line

### There is no evidence of an edge — and the system as built cannot produce that evidence.

That is a statement about measurement, not about the idea. Nothing here has ever been tested: there is no backtester, no historical data, and no test suite in the repository.

The live paper record that *is* accumulating is not usable as evidence either. Paper testing is the correct phase and this is not an argument to shorten it — the concern is **fidelity**. As built, the record is biased optimistic and therefore cannot answer the question the phase exists to answer, because:

- favourable price gaps are credited in full while adverse gaps are charged in full;
- per-trade P&L is gross of fees;
- outlier P&L is silently clamped into a pre-set window;
- stop/target evaluation is blind to everything between 30-second polls — including whole minutes where the browser tab was backgrounded.

Underneath that, two structural results decide the outcome before any signal-quality question is reached. They are in §2 and §4, and both are verifiable from the source without any market data.

| Metric | Value | Meaning |
|---|---:|---|
| Null profit factor | **1.001** | Ladder on a zero-drift asset, 200k paths |
| Null expectancy | **$0.0003** | Per $10 tranche, before costs |
| Distinct trade plans | **1** | Every alt gets −3.2 / +3.8 / +7.5 / +12 |
| Safety gates enforced | **0 of 4** | All four are display-only |

---

## 1. What the system actually is

It is a browser-based paper-trading simulator. There is no exchange authentication, no order placement, no order types and no fill model. "Entering a trade" writes a record to `localStorage` and Firestore; "exiting" flips a status field.

The most consequential fact in the codebase is the data layer. `binanceService.ts` makes exactly one kind of request — `GET /api/v3/ticker/24hr` — cached for 15 seconds. There are **no klines, no order-book depth, no aggregate trades, no websocket**. Every indicator is therefore a deterministic algebraic transform of five numbers per symbol: `lastPrice`, `priceChangePercent`, `highPrice`, `lowPrice`, `quoteVolume`.

### Inventory as implemented

Where the README and the code disagree, the code is shown.

| Dimension | As implemented | Evidence |
|---|---|---|
| Market | 36 hard-coded Binance USDT **spot** pairs. Spot ticker data describes a product labelled "Binance Futures". | `binanceService.ts:89-126` |
| Data feed | 24-hour rolling ticker REST, 3 mirrors, 15s cache, 30s poll. | `binanceService.ts:14-75`, `App.tsx:156-164` |
| **Timeframes** | Nominally five (1D/4H/1H/15m/5m). **Actually one**: the 24h snapshot. All others are synthesised from it. | `entryScannerService.ts:185-232, 395-419` |
| **Intrabar vs close** | Neither. Decisions fire on a 10s wall-clock timer against a 30s-old snapshot. There is no bar concept anywhere. | `App.tsx:166-175` |
| Entry rule | Five pillars × 20 pts, then a gate cascade → TRIGGERED / FORMING / STAGING / WATCHLIST / INHIBITED / REJECTED. | `entryScannerService.ts:1022-1157` |
| **Live entry threshold** | **Score ≥ 75.** README says 80; the scanner's own TRIGGERED gate says 85; auto-pilot accepts FORMING and STAGING at 75. | `App.tsx:309-327` |
| Exit — stop | **Flat −3.2%** for every non-mega-cap (see §2). 1.7–3.0% for BTC/ETH. | `entryScannerService.ts:424-433` |
| Exit — targets | T1 +3.8% (bank 33%), T2 +7.5% (33%), T3 +12.0% (17%), 17% runner. README states +4/+8/+15 with −3.5 to −5.0 stop; those appear nowhere in the live path. | `entryScannerService.ts:435-458` |
| Ratchet | T1 hit → stop jumps to `entry × 1.003`. T2 → stop to T1 price. T3 → `max(T2 price, peak × (1−buffer))`. | `cycleEngineService.ts:137-228` |
| Trailing | Only after T3. Buffer 4% / 2.5% / 1.8% keyed on *current* return, and can only ever tighten. | `cycleEngineService.ts:199, 217-227` |
| **Position sizing** | Notional-constant, not risk-constant: `units = tranche / price`, tranche = equity/10 (floor $5). | `entryScannerService.ts:1611`, `bankrollService.ts:231` |
| Leverage | **Cosmetic.** `suggestedLeverage: '3x - 5x'` is a display string; no P&L path multiplies by it. | `entryScannerService.ts:1192` |
| Risk per trade | 3.2% of tranche = 0.32% of equity. 10 concurrent = 3.2% equity at full risk — but see §9 on correlation. | — |
| Concurrency | Max 10 open, 1 per symbol, max 3 majors, max 2 memes. | `bankrollService.ts:155`, `App.tsx:196-217` |
| Cooldown | 20 min per symbol after close — **auto-pilot only**. Manual deploy prints a notice and proceeds anyway. | `App.tsx:279-284, 234-247` |
| Order types | None. Instantaneous, complete fill at the polled `lastPrice`. | — |
| **Fees** | 10 bps charged once at entry. Per-trade P&L is gross; fees netted only at portfolio level, using a *different* constant (20 bps). | `entryScannerService.ts:1640`, `bankrollService.ts:203` |
| Spread / funding / latency / partial fills | Not modelled. | — |
| Slippage | Modelled on adverse stop gaps only. Favourable gaps credited at the better price. | `cycleEngineService.ts:140, 251-266` |
| Tick / step size | Magnitude buckets in `roundPrice()`, not exchange `exchangeInfo` filters. | `entryScannerService.ts:129-143` |

---

## 2. The scanner collapses to one variable

This is the finding that reframes the rest. The five pillars are not five independent tests — they are five monotone functions of the same input, and several of their thresholds can never fail.

The chain starts with a synthetic market cap. `binanceService.ts:153` sets `market_cap = total_volume * 15`. So the volume-to-market-cap ratio the scanner leans on is the constant **6.667** for every coin, forever. Everything downstream inherits that.

```
// Substituting the constant through entryScannerService.ts:182-240

volumeSurgeRatio      = 1.556 + f(Δ24h)        ≥ 1.56 whenever Δ24h > 0
                                               thresholds tested against it: 1.20, 1.25, 1.35
bollingerBandwidthPct = 3.267 + 0.65·|Δ24h|
atrPct                = 3.927 + 0.485·|Δ24h|    floor 3.93% for every alt

stopLossPct = max(1.4, min(3.2, atrPct × 0.95))
              0.95 × 3.93 = 3.73 > 3.2  →  the cap always binds

// And the structural rule the README builds its whole thesis on:
change7d = change24h × 1.5        // fabricated; 7d data is never fetched (scanner:157)
dailyMa7 = price × g(change7d)
   ⇒  (price ≥ dailyMa7)  ≡  (change24h > 0)   exactly, across the full range
```

### Trade plan across a ±20% sweep of 24h change

Non-mega-cap, live `FUTURES_1_2D` path. Computed by re-executing the source arithmetic, not estimated.

| Δ24h | volSurge | bbWidth | atr% | stop% | T1% | T2% | T3% | R:R | MA7 slope | price ≥ MA7 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| −12.0 | 1.74 | 11.07 | 9.50 | **3.2** | **3.8** | **7.5** | **12.0** | **2.34** | FALLING | false |
| −5.0 | 1.63 | 6.52 | 6.35 | **3.2** | **3.8** | **7.5** | **12.0** | **2.34** | FALLING | false |
| −1.5 | 1.58 | 4.24 | 4.65 | **3.2** | **3.8** | **7.5** | **12.0** | **2.34** | FALLING | false |
| −0.5 | 1.56 | 3.59 | 4.17 | **3.2** | **3.8** | **7.5** | 11.7 | **2.34** | FLAT | false |
| +0.5 | 1.57 | 3.59 | 4.17 | **3.2** | **3.8** | **7.5** | 11.7 | **2.34** | FLAT | true |
| +3.0 | 1.65 | 5.22 | 5.38 | **3.2** | **3.8** | **7.5** | **12.0** | **2.34** | RISING | true |
| +8.0 | 1.80 | 8.47 | 7.81 | **3.2** | **3.8** | **7.5** | **12.0** | **2.34** | RISING | true |
| +20.0 | 2.16 | 14.50 | 9.50 | **3.2** | **3.8** | **7.5** | **12.0** | **2.34** | RISING | true |

Read the four middle columns. **Every alt receives an identical trade plan** — −3.2% / +3.8% / +7.5% / +12.0%, R:R 2.34 — whether it is a 3% ATR Layer-1 or a 9.5% ATR meme. The ATR multipliers, the archetype branching, the four-way volatility classification and the "volatility-adaptive" language in the README all describe machinery that the `min()` caps delete before it reaches a single order.

Meanwhile `volumeSurgeRatio` never drops below 1.56 for any coin that is up on the day, so the "Volume Surge ≥ 1.20×" and "≥ 1.35×" tests always pass and Pillar 3 hands out its 20 points for free. `distToEma21Pct` is a straight line in Δ24h, so the "4H EMA retest" and "mean-reversion discount" pillars read the same number as the structure pillar.

> **What the strategy actually says:** buy the alts that are up on the day and not pinned at the very top of their 24-hour range; short the ones that are down. That is a legitimate, well-studied hypothesis — short-horizon cross-sectional momentum. It is not what the README describes, and it has **one** free parameter, not thirty. Testing *that one hypothesis honestly* is worth more than any further pillar.

---

## 3. Why it enters and exits quickly

Ranked by how much each moves the outcome. The first four answer the question; the rest matter because they corrupt the record you would use to check any fix.

### 1. The breakeven ratchet is a 92% give-back trigger · PRIMARY CAUSE

- **Problem** — Hitting T1 moves the stop from −3.2% to *+0.3%* in one step, with no confirmation and no volatility scaling.
- **Evidence** — `cycleEngineService.ts:146-149`: `updated.stopLossPrice = updated.ratchet.floorPrice`, where `floorPrice = entry × 1.003` (set at `:124`).
- **Expected** — Protect a winner from turning into a loser.
- **Actual** — After a +3.8% gain, price must retrace only 3.5 points — **92% of the move** — to close the whole position. On an asset the scanner itself scores at 4–6% ATR, a 3.5% pullback is the noise floor, not a reversal. This is the single mechanism that turns the modal winner into a +$0.145 scratch minutes after entry.
- **Fix** — Express the armed floor in R, not basis points off entry: leave the stop alone until +1.0R, then move to entry and trail at 2.5× ATR from peak. Smallest safe version: make `floorBufferPct` configurable and derive the armed floor from `stopLossPct` rather than the literal `1.003`.

### 2. The stop sits at roughly half the volatility it claims to adapt to · PRIMARY CAUSE

- **Problem** — `stopLossPct = max(1.4, min(3.2, atrPct * 0.95))`. Since `atrPct ≥ 3.93` for every alt, the product always exceeds 3.2 and the cap always wins.
- **Evidence** — `entryScannerService.ts:424-433`, confirmed across the full Δ24h range in §2.
- **Expected** — A stop outside the asset's normal range of movement, scaled per asset.
- **Actual** — A flat 3.2% stop on assets with 3.9–9.5% daily ATR — **0.34× to 0.81× ATR**. Conventional placement is 1.5–3×. A stop this far inside the noise band is hit by ordinary intraday movement regardless of whether the entry thesis is correct.
- **Fix** — Delete the `min(3.2, …)` and `min(3.8, …)` caps; express targets in ATR units. Two-line change, highest-value single edit in the codebase — but do it **after** finding 8, or you cannot measure whether it helped.

### 3. Every safety gate is display-only · PRIMARY CAUSE

- **Problem** — The consolidation lock, loss-streak circuit breaker, BTC flash-crash armor and pacing state machine are all implemented, all correct in spirit, and all wired to nothing.
- **Evidence** — `marketRegimeService.ts` is imported only by `ScannerView`, `AutomatedFeedView`, `TradePacingDiagnosticsCard` and `AutoPilotMonitorHUD` — all render-only. The deployment effect at `App.tsx:264-384` references none of them.
- **Expected** — "Consolidation Lock active — Auto-Pilot locked 100% in cash" means the bot is in cash.
- **Actual** — The HUD prints that banner while the same render cycle opens a position. A 3.2% stop in a sub-2% daily-volatility tape is a coin flip on noise, and `evaluateMarketActivityRadar` already detects that state — it is never consulted. Same for `evaluateRecentLossCircuitBreaker`, which would have paused trading after two stop-outs in two hours.
- **Fix** — One early return in the deploy effect: `if (!getAutoPilotPacingInfo(...).isDeployingAllowed) return;`. Highest leverage-to-risk ratio in this document — the logic already exists.

### 4. Entry bursts: a stale snapshot re-fired every 10s with no throttle · PRIMARY CAUSE

- **Problem** — `signals` is a `useMemo` on `coins`, which refreshes every 30s. The deploy effect fires on a 10s tick *and* on every change to `trades`. The only guard, `isDeployingRef`, clears after 1500ms.
- **Evidence** — `App.tsx:93-95`, `:166-175`, `:264`, `:378-382`. Each successful deploy calls `setTrades`, which is in the dependency array, which re-runs the effect immediately.
- **Expected** — One considered entry per fresh look at the market.
- **Actual** — Three or more positions opened from a *single* 30-second-old snapshot, seconds apart. Because the ranking is a common function of Δ24h (§2), those positions are near-maximally correlated — effectively one oversized bet. They then resolve together: the "cluster of entries followed by a cluster of exits" you are seeing.
- **Fix** — Gate deployment on the snapshot, not the clock: track the `coins` array timestamp, allow one deploy per snapshot, add a configurable `minMsBetweenDeploys` (start at 120s). Remove `trades` from the effect dependencies.

### 5. Post-T3 trailing tightens on a spike and can never loosen · PREMATURE EXIT

- **Problem** — The trail buffer is selected from `currentReturnPct`, then only accepted if *more* protective.
- **Evidence** — `cycleEngineService.ts:217` picks 1.8% / 2.5% / 4.0% by current return; `:222-227` applies `isStopMoreProtective` monotonically.
- **Expected** — Tighten as a windfall matures; relax back to a normal trail if it doesn't.
- **Actual** — A trade touching +36% for one poll permanently locks a 1.8% trail from the session high — and keeps it after falling back to +15%, where the intended buffer is 4%. On a 5% ATR asset a 1.8% trail is a same-hour exit. The runner meant to capture the fat tail is cut by its own protection.
- **Fix** — Key the buffer on *peak* return (`mfePct`, already tracked at `:66`), and recompute the floor each tick rather than ratcheting it.

### 6. Two strategies vote on the same number · DESIGN

- **Problem** — Direction is assigned by a momentum rule, then overridden by a mean-reversion rule — both reading Δ24h.
- **Evidence** — `entryScannerService.ts:318-330` sets direction from `price < dailyMa7` (≡ `Δ24h < 0`, per §2). `:332-337` then flips to LONG when `pseudoRsi < 36`, and `pseudoRsi = 50 + 2.2·Δ24h + 0.6·Δ7d` — the same variable.
- **Expected** — A regime test choosing which of two strategies applies.
- **Actual** — A discontinuity in one variable. Around the flip point, small changes in the 24h number reverse trade direction entirely — the classic signature of conflicting logic producing whipsaw.
- **Fix** — Pick one. Run them as two separately-measured strategies with their own books if you want both; do not let them arbitrate inside one score.

### 7. Signals repaint by construction · SIGNAL QUALITY

- **Problem** — Every input is a 24-hour *rolling* statistic. `high_24h`, `low_24h` and `priceChangePercent` step discontinuously as old data ages out of the window.
- **Evidence** — Inherent to `/ticker/24hr`; consumed at `entryScannerService.ts:166-172` and propagated into `rangeLocationPct`, `lowerWickAbsorptionPct`, `pseudoRsi`, `atrPct` and the score.
- **Expected** — A signal persists while the condition that created it persists.
- **Actual** — A setup scoring 85 can score 40 minutes later with **zero price movement**, purely because yesterday's high rolled out of the window. The `signalPersistenceMap` "anti-jitter" layer (`:28-127`) measures the clock, not the market. This does not directly close trades — the exit path never re-checks the signal — but it invalidates any claim the setup was still valid at exit.
- **Fix** — Compute features from klines over a fixed, explicitly-aligned window.

### 8. The recorded P&L is asymmetric, gross, and clamped · BLOCKS MEASUREMENT

- **Problem** — Three independent biases, all pointing the same direction.
- **Evidence** —
  - (a) `Math.max(targetPct, currentReturnPct)` at `cycleEngineService.ts:140, 165, 189` harvests favourable gaps at the full gap price, while `:251-266` charges adverse gaps in full.
  - (b) Per-trade `pnlUSD` is gross of fees; two different fee constants exist (`0.0010` at `entryScannerService.ts:1640` vs `0.0020` at `bankrollService.ts:203`).
  - (c) `sanitizedClosedPnL` at `bankrollService.ts:186-193` silently clamps every closed P&L into a window derived from the plan.
- **Expected** — The trade log measures the strategy.
- **Actual** — It measures the strategy plus an upward bias of unknown size, with the tails — the only part distinguishing a trend strategy from a scalper — clipped off. Every metric the app reports inherits this.
- **Fix** — One fee constant in config; subtract per fill inside `evaluateTradeCycle`; handle gaps symmetrically; delete the clamps and fix whatever real bug motivated them.

### 9. The record depends on whether the browser tab was focused · BLOCKS MEASUREMENT

- **Problem** — Stops and targets are evaluated only against the 30s-polled price, and both loops return early when the tab is hidden.
- **Evidence** — `App.tsx:158` and `:171`: `if (document.hidden) return;`. Browsers additionally throttle background timers to ~one tick per minute.
- **Expected** — Two identical market days produce two identical trade logs.
- **Actual** — They do not. The entire intrabar path is invisible: stops touched and recovered never register, T1 touches that reversed never register, and a backgrounded tab collapses hours of path into one price. The bias understates loss frequency. This makes an iterative experiment framework impossible until fixed.
- **Fix** — For open positions, poll 1m klines and evaluate barriers against bar high/low with a conservative same-bar rule (stop first). Remove the `document.hidden` early returns from the trade-evaluation loop; keep them for UI refresh only.

### 10. `coin.micro` is never populated · DEAD LOGIC

- **Problem** — `micro` is optional on `CryptoCoin` (`types.ts:37`) and no code path anywhere assigns it.
- **Evidence** — Grep for `micro:` across `src/` returns only the type declaration. The fallback at `entryScannerService.ts:175-180` therefore always runs: `hourlyChangePct = change24h / 24`, `consecutiveRedHours = f(sign(change24h))`.
- **Expected** — "Micro 1H Reversal & Wick Defense" (20 pts) confirms an hourly candle actually turned.
- **Actual** — It confirms the sign of the 24-hour change. The "bleeding knife" gate and the BTC lead-bleed regime branch at `:1497` (`btc?.micro && …`) are both dead — the latter can never evaluate true.
- **Fix** — Populate `micro` from real 1h klines, or delete the pillar. Do not leave a scored gate reading a fabricated value.

### 11. `sanitizeActiveTrades` can close live positions as a side effect of a read · STATE BUG

- **Problem** — It force-closes any open trade beyond the caps to COMPLETED at `currentPrice` and writes to Firestore — on every fetch and every subscriber notification.
- **Evidence** — `automatedFeedService.ts:35-88`, called from `:91`, `:182`, `:213`, `:241`, `:320`, `:519`.
- **Expected** — A de-duplication safety net.
- **Actual** — Combined with the optimistic `setTrades` in App.tsx and a concurrent Firestore snapshot, a transient over-count silently closes a real position with reason `EXCESS_SLOT_REBALANCED` or `DUPLICATE_ASSET_CONSOLIDATED`. **Grep your trade history for those two strings** — if they appear, some fast exits are this, not the market.
- **Fix** — Make sanitisation a pure read-side filter that reports conflicts; close positions only from an explicit, logged path.

### 12. Documented behaviour that does not exist · HYGIENE

- (a) The adaptive 6-hour futures stagnation exit at `bankrollService.ts:76-78` — `customConfig?.maxStaleHours` is always 24 and truthy, so the `isFutures ? 6 : …` branch never runs.
- (b) The README's +4/+8/+15 ladder and −3.5 to −5.0 stop — the cycle-engine defaults at `cycleEngineService.ts:92-94` that would produce them are unreachable because `deploySignalToAutomatedFeed` always supplies `harvestTiers`.
- (c) Leverage — displayed as "3x–5x", applied nowhere.
- **Fix** — Reconcile the README to the code before the next change. On leverage: if this is ever wired to a real venue at 5×, every figure in the app is wrong by 5× and the 3.2% stop becomes a 16% equity move.

---

## 4. The ladder is EV-neutral, so the entry carries all the weight

Before asking whether the exits are tuned correctly, establish what they do when the entry has no edge. The ladder was simulated exactly as written — all three tiers, the breakeven ratchet, the monotone trailing bug — on a driftless random walk, 200,000 paths.

| Entry drift | Win rate | Avg win | Avg loss | Payoff | Profit factor | Expectancy | Tier mix (0/1/2/3) |
|---|---:|---:|---:|---:|---:|---:|---:|
| **None (null)** | **46.0%** | $0.401 | $0.340 | 1.18 | **1.001** | **$0.0003** | 54 / 22 / 12 / 11 |
| Weak (+0.5 bp/step) | 53.6% | $0.458 | $0.340 | 1.35 | 1.552 | $0.0872 | 46 / 22 / 14 / 18 |
| Strong (+2 bp/step) | 73.5% | $0.652 | $0.340 | 1.92 | 5.318 | $0.3892 | 27 / 16 / 12 / 46 |

Profit factor **1.001**, expectancy **$0.0003**. Not a coincidence or a simulation artefact — it is optional stopping on a martingale. **No exit rule, however clever, creates edge on a driftless asset.** The ladder only reshapes the distribution: it buys a higher win rate with smaller wins.

Which means the honest framing of the whole project is: *the ratchet is not the source of profit and never can be; it is a variance-shaping choice. All of the edge, if any exists, must come from the entry.* And the entry is a function of Δ24h computed from a public 24-hour ticker.

### Break-even win rate after costs

`(L + c) / (W + L)`, holding avg win and avg loss at their null values. The null delivers 46.0%.

| Round-trip friction | Realistic for | Cost / $10 trade | Break-even win rate | Entry edge required |
|---|---|---:|---:|---:|
| 0 bp | Frictionless (the current simulator) | $0.000 | 45.9% | — |
| 10 bp | Maker-in / maker-out, BTC or ETH | $0.010 | 47.3% | +1.3 pp |
| **20 bp** | **Taker futures, liquid L1/L2** | $0.020 | **48.6%** | **+2.7 pp** |
| 30 bp | Taker spot, mid-cap | $0.030 | 50.0% | +4.0 pp |
| **40–60 bp** | **Memes at size (PEPE, WIF, BONK, POPCAT)** | $0.040–0.060 | **51.3–54.0%** | **+5.4 to +8.1 pp** |

The entry must be right **3 to 8 percentage points more often than the null** before the system earns a dollar — and the meme names, which auto-pilot explicitly prioritises during major-coin stalls (`App.tsx:338-348`), sit at the expensive end.

### Friction drag vs turnover

$100 book, 10 slots, each rotation turning 10% of equity. Pure cost — applies whether or not the strategy has edge.

| Rotations / day | @20bp per day | @20bp per month | @40bp per day | @40bp per month |
|---:|---:|---:|---:|---:|
| 5 | 0.10% | −3.0% | 0.20% | −5.8% |
| 10 | 0.20% | −5.8% | 0.40% | −11.3% |
| **20** | **0.40%** | **−11.3%** | **0.80%** | **−21.4%** |
| **40** | **0.80%** | **−21.4%** | **1.60%** | **−38.4%** |
| 60 | 1.20% | −30.4% | 2.40% | −51.8% |

> **Measure your actual rotation rate first.** Count closed trades per day in your history and read off the row. Above 20 rotations/day — which the 10-second deploy tick and the 3.2% stop make very likely — friction alone costs 11–38% of equity per month.

### On the metrics the app reports

**Sharpe, Sortino and max drawdown cannot be computed** from what exists. There is no historical trade series and no backtester. The app renders a scorecard via `calculateStrategyVerification`, but it runs on the clamped, gross-of-fee, path-blind P&L from finding 8, so it is not a measurement.

It also declares `VALIDATED_READY` at **n = 20** (`bankrollService.ts:450`). The standard error on a win-rate estimate at n = 20 is about 11 percentage points; you are hunting a 3–8 point effect. Detecting a 4-point edge at conventional power needs roughly **n ≈ 2,200 trades**. Raise that threshold, or replace it with an MFE/MAE study, which is far more sample-efficient.

---

## 5. What kind of strategy this is

The README describes institutional swing trading on 1–2 week cycles, capturing parabolic fat tails with an uncapped runner. The code does something else.

**The entry is short-horizon cross-sectional momentum.** Thirty-six assets are ranked at each tick by a composite that reduces to 24-hour return plus position within the 24-hour range, and capital goes to the top of the ranking.

**The exit is scalping.** A 0.34–0.81× ATR stop, a first target at 1.0× ATR, and a breakeven ratchet that fires after a 92% give-back.

These are opposite strategies. Momentum entries need wide stops and open-ended exits, because the whole thesis is that a minority of trades run a long way; the payoff lives entirely in the right tail. This system pairs that entry with the tightest, most tail-hostile exit structure available. Under the null only 11% of trades reach the runner at all, and finding 5 then cuts those.

> **That mismatch is the structural answer to the fast-exit question.** The bot enters and exits quickly because a momentum entry has been bolted to a scalping exit. The README's own fat-tail rationale is defeated by the ratchet the README also advocates — the two halves of the stated philosophy contradict each other.

**Secondary note on the short side:** because direction is `sign(Δ24h)`, shorts are not a separate strategy. They are the same momentum rule with the sign flipped, which in crypto is materially worse — alt perps have a positive drift and a negative carry for shorts. Measure separately; likely switch off.

---

## 6. Microstructure and the cost budget

The system never sees a quote. `lastPrice` from the 24-hour ticker is the last *trade* price; bid, ask and depth are not fetched. Every fill in the simulator happens at a price no participant could have transacted at.

| Cost | Magnitude here | Why it matters for this strategy |
|---|---|---|
| Taker fee | 5 bp/side futures, 10 bp/side spot | Nothing in the system can place a maker order, so 100% of flow is taker. |
| Spread | 1–2 bp majors, 5–20 bp memes | Not modelled at all. Auto-pilot *preferentially* routes to high-beta alts and memes when majors are quiet (`App.tsx:338-348`) — it systematically selects the widest spreads. |
| **Funding** | ±1 bp/8h typical, 5–30 bp/8h in momentum | **The scanner selects for the worst funding conditions for longs.** An asset up on the day with a volume surge near its 24h high is precisely when perp funding is most positive. Not modelled. |
| Market impact | Negligible at $10; material at $1,000 | The README's scaling plan takes tranches from $10 to $1,000 while keeping the coin list fixed — 100× the impact against a paper record where impact was zero. |

On session and regime: `evaluateLiquiditySession` correctly identifies the 21:00–00:00 UTC dead gap and weekend thinning, and `evaluateMarketActivityRadar` correctly identifies sub-2% consolidation as a regime where a 3.2% stop is a coin flip. Both are good instincts, correctly implemented, and connected to nothing (finding 3). **You have already written the regime filter this strategy needs — you just have not plugged it in.**

---

## 7. Diagnose before optimising: separate the entry from the exit

Do this before changing a single strategy parameter. It requires no modification to the bot — only its entry log.

### Study A — Does the entry have edge?

*Inputs: entry timestamp + symbol + direction only. Exits discarded entirely.*

1. **Compute forward log returns** at +1, +3, +5, +10, +20, +50 bars on 5-minute data (reaching ~4 hours, matching the observed holding period). Report mean, t-statistic, and hit rate at each horizon. A flat term structure means no drift to capture.

2. **Benchmark against three controls:**
   - random time on the same symbol — isolates unconditional drift;
   - random time *at the same hour of day* on the same symbol — isolates session effects;
   - **the cross-sectional mean of all 36 symbols at that same instant** — isolates market beta.

   The third control is the one that matters. A momentum scanner on a green day just buys beta. If excess return over control 3 is zero, you have a beta bot, not an alpha bot — and given §2, that is the prior.

3. **Plot the joint MFE/MAE distribution**, not just the means. Decision rule: if median MFE at 4h is under 0.8% while median MAE exceeds 1.5%, the entry is late and no exit tuning will rescue it. If median MFE exceeds 2× median |MAE|, the entry is sound and the exits are the whole problem.

### Study B — Which exit family fits?

*Same entry set, held fixed. Compare on expectancy per hour of exposure, never on total profit.*

1. **Fixed horizon, no stop** — 30m, 1h, 2h, 4h, 12h, 24h. The pure test of whether the entry has drift. If the best horizon beats every stop-based variant, the stops are the problem.
2. **ATR stop only** — 1.0, 1.5, 2.0, 3.0 × ATR(1h), exit at the best horizon from step 1.
3. **Chandelier trail** — 2.5 and 3.5 × ATR from peak, no breakeven move.
4. **The current ladder**, as the baseline to beat. Expect it to place last on expectancy and first on win rate. That contrast is the clearest demonstration of why win rate is the wrong objective.

---

## 8. Backtest framework

One constraint dominates. The current features are built from point-in-time rolling statistics that the exchange computes for you. **You cannot replay them from daily bars** — you must reconstruct a rolling 1,440-minute window as of each decision timestamp, from 1-minute klines. Using a completed daily bar's high/low is look-ahead bias, and it will manufacture an edge that does not exist.

| Component | Specification |
|---|---|
| Data | Binance 1m klines for all 36 symbols, 2+ years, plus historical funding rates. Use the monthly ZIP dumps at `data.binance.vision` — same host already in use, no rate limits. 1m is the minimum granularity that resolves a 3.2% stop against a 3.8% target; `aggTrades` gives the true path for top candidates. |
| Same-bar ambiguity | When a 1m bar touches both barriers, assume the stop filled first. Report what fraction of trades hit this case — above ~5%, the barriers are too close to backtest on 1m and you need tick data. |
| Architecture | Event-driven, single clock. Decision at *t*, fill at *t* + latency (150–400 ms) against the opposite side of the book plus half-spread. |
| Fees | Your actual VIP tier, applied per fill on the fraction filled. One constant, in config, shared with the live path. |
| Funding | Real historical rates, accrued at 00:00 / 08:00 / 16:00 UTC against open notional. |
| Slippage | Square-root impact calibrated from `bookTicker` depth, or a flat per-symbol-tier estimate to start. **Do not use zero.** |
| Constraints | `minNotional`, `tickSize`, `stepSize` from `exchangeInfo`. Fill cap at 1% of bar volume to approximate partial fills at size. |
| **Leakage assertion** | Assert in code that no feature at decision time *t* reads any bar with `closeTime > t`. Make it a test, not a convention — this is the bug class that produces beautiful equity curves and no money. |
| Splits | 2023 train → 2024 validation → 2025 out-of-sample, plus walk-forward (6mo train / 1mo test, rolled). Positions overlap in time, so use purged and embargoed splits rather than naive date cuts. |
| **Parameter budget** | Currently ~30 hand-set thresholds across five pillars and eight gates. With 30 free parameters and n ≈ 1,000 you will fit noise perfectly. **Rule: no parameter gets tuned until Study A says the entry has edge unconditionally.** |

---

## 9. Risk model

Per-trade risk is genuinely conservative at 0.32% of equity. The problem is everything around it.

**Position count is not diversification when the selection rule is common.** Ten alt longs chosen by the same Δ24h ranking on the same tick are not ten independent bets — crypto alt correlation in a directional move runs around 0.85, so effective exposure is closer to a single 2.7% bet than to ten 0.32% ones. The sector caps (3 majors, 2 memes) address labels, not the actual common factor, which is BTC beta.

There is also no daily loss limit, no consecutive-loss brake and no drawdown-scaled sizing in the execution path. The circuit breaker exists but is display-only (finding 3).

One thing is already right: tranche = equity/10 scales size down after losses and up after gains — a sound fractional-Kelly-shaped rule. Keep it.

| Control | Setting | Rationale |
|---|---|---|
| **Risk-based sizing** | `units = (equity × riskFrac) / (entry − stop)` | Replaces notional-constant sizing. Makes every trade risk the same dollars — a prerequisite for the ATR stop below, without which risk per trade would vary by 3×. |
| **Concurrency cap** | 4, not 10, until Study A shows decorrelated selection | Directly addresses the common-factor problem. Also cuts rotation count, the dominant cost term. |
| Portfolio heat | Sum of open risk ≤ 2% of equity | Hard ceiling independent of position count. |
| Daily loss limit | −2% equity → flat, no new entries until next UTC day | Bounds the worst single day. Currently unbounded. |
| Consecutive-loss brake | 3 stops in a rolling 4h → 4h pause | Wire the existing `evaluateRecentLossCircuitBreaker`, tightened from 2-in-2h / 60-min. |
| Drawdown throttle | `size ×= (1 − DD / 0.15)`; halt at 15% | De-risks into a losing regime instead of compounding into it. |
| Regime filter | No entries when consolidation-locked or in the dead-zone window | Already written in `marketRegimeService`. Just connect it. |
| Leverage | **Stay at 1×** | The binding constraint is the friction budget, not return. Leverage multiplies cost drag alongside P&L and does nothing for the underlying edge question. |

---

## 10. Changes, in dependency order

Tier 1 comes first not because those bugs cost the most money, but because until they are fixed you cannot tell whether anything else helped.

### Tier 1 — Correctness
*Blocks measurement. Do these before touching strategy logic.*

1. **Connect the safety gates.** One early return in the deploy effect using the existing `getAutoPilotPacingInfo(...).isDeployingAllowed`.
   *Hypothesis:* most losses cluster in consolidation and post-loss chop, which the existing detectors already flag. *Success metric:* loss rate during flagged windows drops toward the unflagged rate. *Risk:* fewer trades, longer time to significance — accept it.
2. **One deploy per snapshot + `minMsBetweenDeploys`.** Remove `trades` from the effect dependencies.
   *Success metric:* max positions opened in any 60s window falls to 1. Watch that total trade count drops without expectancy per trade degrading.
3. **Fix the P&L accounting.** Single fee constant; per-fill net P&L inside `evaluateTradeCycle`; symmetric gap handling; delete the clamps.
   *Success metric:* reported expectancy moves — the size of the move is the size of the bias you were carrying.
4. **Make evaluation path-aware.** 1m klines for open positions; drop the `document.hidden` guard on the trade loop.
   *Success metric:* two runs over the same period produce identical logs. Expect win rate to fall; that is bias being removed, not a regression.
5. **Key the post-T3 trail on peak return; populate or delete `coin.micro`; make `sanitizeActiveTrades` read-only.**

### Tier 2 — Execution
*Makes simulated fills resemble achievable ones.*

6. **Model spread and fee per fill; accrue funding.**
   *Success metric:* cost as a fraction of gross profit reported on every run. Above 30%, the strategy is a cost-delivery mechanism regardless of gross numbers.
7. **Risk-based position sizing.** `units = (equity × riskFrac) / (entry − stop)`. Four lines.
8. **Real `tickSize` / `stepSize` / `minNotional`** from `exchangeInfo`, replacing the magnitude buckets in `roundPrice`.

### Tier 3 — Strategy
*Only after Study A says the entry has edge. Each is one experiment.*

9. **Remove the stop and target caps; express geometry in ATR.** Stop 2.0× ATR(1h), T1 1.5× ATR.
   *Hypothesis:* the stop is inside the noise band, so a large share of losses are noise, not thesis failures. *Expected:* win rate falls, average win rises, expectancy rises. *Risk:* larger per-trade loss — contain with item 7, which is why that lands first.
10. **Replace the breakeven ratchet.** No stop movement until +1.0R, then trail at 2.5× ATR from peak; never tighten below that.
    *Hypothesis:* the +0.3% floor converts winners into scratches. *Expected:* win rate falls sharply, payoff rises, tier-3 reach rate roughly doubles. *Success metric:* expectancy per hour of exposure. Watch max drawdown stays in budget.
11. **Add the max-hold exit** found in Study B.
12. **Cap concurrency at 4** and re-measure both expectancy and realised portfolio volatility.
13. **Resolve the momentum/mean-reversion conflict.** Pick one; run the other as a separate book if wanted.

### Tier 4 — Hypotheses worth testing
*Speculative. Each needs its own out-of-sample confirmation.*

14. **Beta-neutral ranking.** Rank on residual momentum after regressing out BTC beta, rather than raw Δ24h.
    *The direct test of whether any alpha survives beta removal. If Study A's control 3 comes back flat, this is the most promising single idea in this document.*
15. **Funding-rate filter.** Skip longs when 8-hour funding exceeds 0.03%. Targets the adverse selection in §6.
16. **Session filter** from the hourly distribution already collected in `consolidationLossRecorderService`.
    *Beware: 24 hourly buckets on a small sample will always show a "worst" hour. Require it to hold out-of-sample.*
17. **Maker entries** with a limit at bid and a queue timeout.
    *Halves the fee — worth 1–1.5pp of break-even win rate. Introduces adverse selection, so test with fill-probability modelling, not assumption.*

---

## 11. Experiment framework

One major variable per experiment. Re-run the frozen baseline every time, because code drifts underneath you.

```yaml
# experiments/EXP-0007.yaml
id:            EXP-0007
hypothesis:    "Stop at 2.0x ATR(1h) instead of flat 3.2% raises expectancy by
                reducing noise stop-outs, at the cost of win rate."
baseline:      EXP-0000 (frozen @ commit a3f91c2)
change:        stopLossPct: flat 3.2  ->  2.0 * atr1h      # exactly one variable
dataset:       binance-1m, 36 symbols, 2023-01-01 .. 2025-12-31
split:         train 2023 | val 2024 | oos 2025 | walk-forward 6m/1m
market:        USDT perps      timeframe: 5m decision, 1m evaluation

# results (report OOS first; train/val are diagnostic only)
  n_trades          1,847         win_rate        38.2%
  avg_win           $0.71         avg_loss        $0.42
  expectancy        +$0.011 ± 0.009   # 95% CI - overlaps zero, NOT a result
  profit_factor     1.07          max_drawdown    9.4%
  sharpe            0.61          sortino         0.88
  avg_hold          3.1h          exposure_hours  5,725
  cost_fraction     0.34          # fees+spread+funding / gross profit
  turnover_daily    12.3 rotations/day
  n_configs_tried   7             deflated_sharpe  0.21

verdict:       INCONCLUSIVE - CI spans zero, cost_fraction above 0.30 gate.
               Do not promote. Re-run after Tier-2 item 7.
seed: 8831     data_hash: sha256:9c1e...    code: a3f91c2
```

Four rules that matter more than the schema:

- **Report the confidence interval, never the point estimate.** `expectancy ± 1.96σ/√n`. If it spans zero, you learned nothing regardless of how good the headline looks.
- **Success is out-of-sample expectancy per hour of exposure** — with a secondary gate on max drawdown and a hard gate on `cost_fraction < 0.30`. Not total profit. Not win rate. Given §4, a change that raises win rate while lowering expectancy is the single most likely failure mode here, and total-profit reporting will hide it.
- **Log `n_configs_tried` and deflate.** After twenty attempts, a Sharpe of 2.0 is what noise produces. Tracking the count is the cheapest defence against fooling yourself.
- **Minimum sample: 300 trades for a directional read, ~2,200 for a 4-point win-rate claim.** Below that, prefer MFE/MAE distribution comparisons, which extract far more information per trade than a binary win/loss.

---

## 12. What would change my assessment

The claim that there is no evidence of an edge is falsifiable, and Study A falsifies it cheaply — it needs the existing entry log and a few days of 5-minute klines, and it touches no strategy code.

**If** entries show positive mean forward return at 1–4 hours *in excess of the cross-sectional mean*, with a t-statistic above 2 on a few hundred observations, then there is something real and the whole Tier 3 list becomes worth doing — the entry would be carrying edge that the exits are currently destroying, which is a good problem.

**If** that excess is indistinguishable from zero, then no amount of exit tuning, indicator addition or pillar weighting will produce a profitable system, because §4 shows the exits cannot manufacture what the entry does not supply. The honest response is to change the entry hypothesis — most promisingly toward beta-neutral residual momentum (Tier 4, item 14), which is at least a claim about something other than "this coin went up today."

**A third outcome is live:** a *negative* excess would mean the system is systematically buying short-term tops. "Up today and near the 24h high" is a recognised short-horizon reversal signature. That result would be valuable — it would mean the signal is correct with the sign inverted.

One closing note on direction of effort. The instinct this codebase reflects — more pillars, more confluence, more timeframes — has produced five scoring dimensions that all read the same number. The fastest way to make this system better is **subtraction**: one hypothesis, one timeframe, one parameter, measured honestly. Everything in Tier 1 is subtraction or connection, and none of it requires a new idea.

---

*Audit scope: full `src/` tree, 36 files. Null model: 200,000 paths, geometry as implemented. Degeneracy table: source arithmetic re-executed, not estimated. No code was modified.*
