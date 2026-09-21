# Two Claims to Check

**Technical brief · request for review**

A retail crypto trading system, audited before deployment. Two structural results are verifiable from the source in under ten minutes and would decide the project. We would like them checked, and our proposed test design critiqued.

| | |
|---|---|
| **System** | CryptoStudyLab — autonomous scanner + paper execution |
| **Universe** | 36 Binance USDT pairs, cross-sectional |
| **Holding period** | Hours (observed), 1–2d intended |
| **Status** | Simulated positions — deliberate pre-deployment test phase |
| **Backtest** | None exists |
| **Ask** | Verify claims 1–2, critique test design in §5 |

---

## In three lines

- The scanner presents as five scored pillars across five timeframes. It is **rank-one in 24-hour percent change** — the other dimensions are aliases, and several of its thresholds can never fail.
- The tiered exit ladder returns **PF 1.001 / expectancy $0.0003** on a driftless null, as optional stopping requires. It cannot be the source of edge; the entry carries 100% of the burden.
- Break-even win rate after realistic friction is **48.6–54.0%** against a **46.0%** null, so the entry must supply **+3 to +8pp**. We have never measured whether it supplies any.

---

## 1. Claim: the feature set is rank-one

> **Verifiable by substitution — no market data needed.**

The system's only data source is `GET /api/v3/ticker/24hr`, polled at 30s. Every indicator — a 4H EMA, a Daily MA(7), RSI(14), ATR, Bollinger bandwidth, CVD, taker buy/sell ratio, "whale" block flow, 1H candle state, a 15m squeeze, a 5m flow read — is an algebraic transform of five fields from that one response.

The chain degenerates because market cap is synthesised as `total_volume × 15`, making the volume/mcap ratio a global constant of 6.667. Substituting through:

```
// after substituting volToMcap = 6.667 (constant for every symbol, always)

volumeSurgeRatio      = 1.556 + f(Δ24h)        ≥ 1.56 for any coin up on the day
                                               thresholds it is tested against: 1.20 / 1.25 / 1.35
bollingerBandwidthPct = 3.267 + 0.65·|Δ24h|
atrPct                = 3.927 + 0.485·|Δ24h|   floor 3.93% for every altcoin

stopLossPct = max(1.4, min(3.2, atrPct × 0.95))
              0.95 × 3.93 = 3.73 > 3.2  →  the cap always binds

// and the structural rule the entire thesis rests on:
change7d  = change24h × 1.5        // fabricated; 7d data is never fetched
dailyMa7  = price × g(change7d)
   ⇒  (price ≥ dailyMa7) ≡ (change24h > 0)   exactly, across the full range
```

### Trade plan emitted across a ±20% sweep of 24h change

Non-mega-cap. Produced by re-executing the source arithmetic, not estimated.

| Δ24h | atr% | stop% | T1% | T2% | T3% | R:R | volSurge |
|---:|---:|---:|---:|---:|---:|---:|---:|
| −12.0 | 9.50 | 3.2 | 3.8 | 7.5 | 12.0 | 2.34 | 1.74 |
| −5.0 | 6.35 | 3.2 | 3.8 | 7.5 | 12.0 | 2.34 | 1.63 |
| −1.5 | 4.65 | 3.2 | 3.8 | 7.5 | 12.0 | 2.34 | 1.58 |
| +3.0 | 5.38 | 3.2 | 3.8 | 7.5 | 12.0 | 2.34 | 1.65 |
| +8.0 | 7.81 | 3.2 | 3.8 | 7.5 | 12.0 | 2.34 | 1.80 |
| +20.0 | 9.50 | 3.2 | 3.8 | 7.5 | 12.0 | 2.34 | 2.16 |

**Consequences.** Every altcoin receives an identical plan — −3.2 / +3.8 / +7.5 / +12.0 — whether its true ATR is 3% or 9.5%. Effective stop distance is **0.34–0.81× daily ATR**. The volume-surge gate passes unconditionally for anything green on the day. Direction reduces to `sign(Δ24h)`.

> **Restated as a strategy:** long the alts that are up today and not pinned at the top of their 24h range; short the ones that are down. Held for hours. One free parameter, not thirty.

---

## 2. Claim: the exit ladder is EV-neutral

> **Reproducible — 200,000 paths, geometry as implemented.**

The exit is a three-tier scale-out with a breakeven ratchet: bank 33% at +3.8% and move the stop to *entry +0.3%*; bank 33% at +7.5% and move the stop to the T1 price; bank 17% at +12% and trail the remaining 17%. We simulated it exactly as written — including a monotone-tightening bug in the trail — on a zero-drift walk.

$10 notional, geometry −3.2 / +3.8 / +7.5 / +12.0. Tier mix = share of trades reaching tier 0/1/2/3.

| Entry drift | Win rate | Avg win | Avg loss | Payoff | PF | E[P&L] | Tier mix |
|---|---:|---:|---:|---:|---:|---:|---:|
| **None (null)** | 46.0% | $0.401 | $0.340 | 1.18 | **1.001** | **$0.0003** | 54/22/12/11 |
| +0.5 bp/step | 53.6% | $0.458 | $0.340 | 1.35 | 1.552 | $0.0872 | 46/22/14/18 |
| +2.0 bp/step | 73.5% | $0.652 | $0.340 | 1.92 | 5.318 | $0.3892 | 27/16/12/46 |

PF 1.001 is not a simulation artefact — it is optional stopping on a martingale. The ladder buys win rate with smaller wins and creates nothing.

Note also the ratchet's geometry: after a +3.8% gain the stop sits at +0.3%, so a **92% retracement of the move closes the position**, on assets the system itself scores at 4–6% ATR.

> **Our reading:** the exit is a variance-shaping choice, not a P&L source. It is also the wrong shape — a cross-sectional momentum entry paired with a sub-ATR stop and a hair-trigger ratchet. Under the null only 11% of trades reach the runner the design exists to capture.

---

## 3. Cost budget

Given claim 2, the entry must supply the entire edge. Break-even win rate is `(L + c)/(W + L)` using the null's W and L. Live thresholds: 100% taker flow (the system cannot post), 36 symbols including PEPE / WIF / BONK / POPCAT.

Friction quoted on notional, round trip: taker fee + half-spread each side + slippage. Null win rate is 46.0%.

| Friction | Applies to | Break-even WR | Edge required |
|---|---|---:|---:|
| 10 bp | Maker in / maker out, BTC·ETH | 47.3% | +1.3 pp |
| **20 bp** | **Taker perps, liquid L1/L2** | **48.6%** | **+2.7 pp** |
| 30 bp | Taker spot, mid-cap | 50.0% | +4.0 pp |
| **40–60 bp** | **Meme perps at size** | **51.3–54.0%** | **+5.4–8.1 pp** |

Turnover compounds this. Ten concurrent slots on a 3.2% stop, each rotation turning 10% of book: at 20 rotations/day and 20 bp, friction alone is **0.40%/day ≈ −11.3%/month of equity**; at 40 rotations and 40 bp, **−38.4%/month**. This is pure cost, independent of edge.

> **Aggravating factor we think is underweighted:** the scanner preferentially selects assets that are up, near their 24h high, on a volume surge — precisely the state in which perp funding is most positive for longs. Funding is not modelled anywhere. We would value a view on whether this is material at an hours-long holding period.

---

## 4. What we have not measured

| Question | Status |
|---|---|
| Entry information coefficient | never measured |
| Cost as fraction of gross P&L | not instrumented |
| Independent bets across 10 slots | est. ~1 — common selection rule |
| Realised Sharpe / Sortino / max DD | no trade series exists |
| Fill price achievability | no quotes or book ever fetched |
| Intrabar path | 30s polling — invisible |

Paper testing is the intended phase and we are not looking to shorten it — the concern is fidelity, not the decision to simulate. As built, the record is biased optimistic and therefore cannot answer the question the phase exists to answer: favourable price gaps are credited at the gap price while adverse gaps are charged in full, per-trade P&L is gross of fees, outliers are clamped into a window derived from the plan, and the system's own validation gate declares readiness at **n = 20**. We are treating all of it as unmeasured.

---

## 5. Proposed test — please critique

Before changing any strategy logic we intend to isolate the entry. The scanner is a pure function of a snapshot array, so it can be replayed unmodified.

**Design.** Six months of 5-minute klines for all 36 symbols. At each step, reconstruct the rolling 24h fields from a 288-bar lookback — never from a completed daily bar. Feed them to the scanner unchanged, collect every entry it would have made, discard its exits entirely. Measure forward log returns at +1/+3/+5/+10/+20/+50 bars against three controls:

| Control | Isolates |
|---|---|
| Random time, same symbol | Unconditional drift of the asset |
| Random time, same hour-of-day | Session and liquidity effects |
| **Cross-sectional mean of all 36 at that instant** | **Market beta — the control that decides the project** |

**Decision gate:**

- Excess over control 3 positive with t > 2 → the entry has edge the exits are destroying, and the rebuild is worth doing.
- Indistinguishable from zero → it is a beta bot and no exit work will help.
- **Negative → we would take seriously that the signal is correct with the sign inverted**, given that "up today and near the 24h high" is a recognised short-horizon reversal signature.

---

## 6. What we would like from you

In rough order of value to us. We are *not* asking you to review the implementation bugs — those are ours to fix and are already catalogued.

1. **Do claims 1 and 2 survive your reading?** Both are checkable without market data — claim 1 by substitution, claim 2 by re-running the ladder on a driftless walk. If either is wrong, everything downstream changes. *These are the two results the whole assessment rests on.*

2. **Is control 3 specified correctly?** We use a simple cross-sectional demean. Should it be a beta-adjusted residual against BTC instead, and if so estimated over what window? *We suspect naive demeaning under-removes beta on high-beta alts and memes.*

3. **At 1–4h horizons in liquid alts, what is the right prior — momentum or reversal?** Our read of the code says the system is long cross-sectional momentum at a horizon where desk experience may point the other way. *This determines whether the decision gate's third branch is a real possibility or a curiosity.*

4. **Sample size.** We estimate n ≈ 2,200 to resolve a 4pp win-rate effect at conventional power. Is comparing MFE/MAE distributions materially more efficient, and what test would you use — two-sample KS, or something better suited to the joint distribution?

5. **Is 20 bp round-trip realistic** for taker perps on liquid alts at $10 and at $1,000 clip, and what is your number for meme perps? Our cost table is the load-bearing assumption in §3 and we would rather use yours.

6. **Purged / embargoed CV.** With overlapping positions across 10 concurrent slots and hours-long holds, what embargo period would you set?

7. **Is there a version of a breakeven ratchet that is not value-destroying**, or is moving a stop to breakeven always a pure variance trade dressed as risk management? *Genuine question — we would rather understand the principle than tune the parameter.*

---

## 7. Where we think this lands

Our own view, offered so you can disagree with something concrete: the engineering is sound and the scanner's purity makes it cheap to test, but there is currently **no evidence of an edge and no apparatus capable of producing that evidence**. The five-pillar structure has produced five aliases of one variable, which is a subtraction problem, not an addition problem.

We are not asking whether to add indicators. We are asking whether the single hypothesis underneath — short-horizon cross-sectional momentum on liquid alts, held hours, taker-only — is worth testing properly, or whether the cost structure rules it out before we start.

---

*Source: 14,079 LOC TypeScript, full tree audited. Claim 1: source arithmetic re-executed. Claim 2: 200k paths, geometry as implemented. No code modified.*
