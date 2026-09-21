# Study A — Does the entry have edge?

**Run date:** 2026-09-21 · **Window:** 2026-03-02 → 2026-08-31 (6 months)
**Method:** the real `scanLiveMarketEntries()` replayed over reconstructed rolling-24h snapshots. No re-implementation — `tools/build-scanner.mjs` bundles `entryScannerService.ts` with only its two Firebase/localStorage imports stubbed; all scoring and trade-plan math is byte-identical to `src/`.

| | |
|---|---|
| Decision steps | 52,704 (5-minute) |
| Symbols | 33 of 36 (FTM, KAS, POPCAT unavailable on Binance spot) |
| Signals evaluated | 1,730,304 |
| Auto-pilot eligible | 1,329,147 |
| Top-ranked picks (what the bot deploys) | 52,695 |

---

## Verdict: it lands on the "beta bot" branch of the decision gate

Raw forward returns are ~0 to negative at every horizon. The only statistically
detectable excess-of-beta appears at a single horizon, does not survive
multiple-comparison correction, and is a fraction of transaction costs.

**Net expectancy per trade at the 4.2h horizon: +2.94 bps gross, −17 bps after a 20 bps round trip.**

---

## 1. The gate is not a filter

**76.8%** of all symbol-steps pass auto-pilot eligibility (score ≥ 75, MTF grade
not C/DISQUALIFIED, ≥2 timeframes aligned). A filter that admits three out of
every four asset-moments is not selecting anything.

Further, **54%** of eligible entries score ≥ 95. The 0–100 conviction scale is
compressed into its top decile in practice.

## 2. The conviction score does not discriminate

Forward return at 4.2h by score bucket:

| Score | n | Raw bps | Excess-of-beta bps |
|---:|---:|---:|---:|
| 75+ | 23,782 | +29.58 | **+12.48** |
| 80+ | 121,852 | −6.58 | +2.09 |
| 85+ | 110,816 | +2.26 | −0.27 |
| 90+ | 348,201 | +0.22 | +2.73 |
| 95+ | 723,580 | −3.19 | **+1.54** |

**Non-monotonic, and inverted at the ends** — the *lowest* score bucket has the
highest excess return, the highest bucket nearly the lowest. A higher conviction
score does not predict a better outcome. The five pillars carry no ordering
information, which is the empirical confirmation of the rank-one degeneracy in
`AUDIT.md` §2.

## 3. Forward returns — top pick only (what the bot actually trades)

n = 52,695. One observation per timestamp; Newey-West with lag = horizon.

| Horizon | Raw bps | Excess-of-beta bps | NW t-stat | Verdict |
|---|---:|---:|---:|---|
| 5m | −0.13 | −0.05 | −0.51 | noise |
| 15m | −0.20 | +0.03 | 0.14 | noise |
| 25m | −0.34 | +0.11 | 0.34 | noise |
| 50m | −0.32 | +0.51 | 0.87 | noise |
| 1.7h | −0.82 | +0.85 | 0.81 | noise |
| **4.2h** | **+2.94** | **+6.80** | **2.78** | significant, but see below |

Three reasons the 4.2h result should not be traded on:

1. **Multiple comparisons.** 30 tests were run (5 subgroups × 6 horizons). The
   Bonferroni threshold at 5% is t ≈ 3.2. t = 2.78 does not clear it.
2. **Shape.** A real signal builds monotonically across horizons. This one is
   flat-to-negative for four hours and then jumps — the signature of a
   single-horizon artifact, not a drift.
3. **It is not tradeable anyway.** +6.80 bps is *excess of beta*. The system is
   unhedged and taker-only, so what it actually earns is the raw +2.94 bps,
   against ~20 bps of round-trip friction.

## 4. MFE/MAE — the most robust result

| Cut | Median MFE | Median MAE | Ratio |
|---|---:|---:|---:|
| All eligible | 0.80% | 0.83% | **0.97** |
| Top pick | 1.06% | 1.09% | **0.97** |
| Top pick, LONG | 1.15% | 1.17% | **0.98** |
| Top pick, SHORT | 0.89% | 0.92% | **0.97** |
| Score ≥ 95 | 0.81% | 0.84% | **0.96** |

Excursion is **symmetric to within 3%** in every cut, across samples of 37k–1.3M.
The entry produces as much adverse movement as favourable. There is no asymmetry
to harvest, which is what an entry with edge would supply.

Applying the `AUDIT.md` §7 decision rule: median MFE (1.15%) is nowhere near
2× median MAE (1.17%), so **the entry is the problem, not the exits.**

Note also: median MFE over 4.2 hours is **1.15%** against a T1 target of
**+3.8%**. The median trade never comes close to the first harvest tier — which
is precisely the mechanism behind the fast-exit complaint.

## 5. The short side is worse than useless

| Horizon | Raw bps | Excess bps | NW t |
|---|---:|---:|---:|
| 5m | −0.46 | −0.26 | **−2.02** |
| 25m | −1.02 | −0.02 | −0.05 |
| 4.2h | −5.88 | +2.73 | 1.15 |

Negative raw return at every horizon and significantly negative at 5m. This
confirms the `AUDIT.md` §5 prediction: because direction reduces to
`sign(Δ24h)`, shorts are the same momentum rule with the sign flipped, against
a positive drift and negative carry. **Recommend disabling the short side.**

---

## Limitations

- **One regime.** Six months (2026-03 → 2026-08). A different volatility or
  trend regime could produce different numbers.
- **Spot data as a perp proxy.** The app labels itself futures but reads spot
  tickers; this study uses spot klines to match. Funding is not in these
  forward returns — including it would make the long side worse.
- **5m granularity.** The rolling 24h window is 288 bars rather than 1,440
  minutes. A minor approximation to the exchange's own rolling statistic.
- **No execution modelling.** These are mid-to-mid closes. Real fills are worse.

None of these limitations point toward a hidden edge; the first and third are
neutral, the second and fourth both make the real result worse than shown.

---

## Reproduce

```bash
node tools/build-scanner.mjs        # bundle the real scanner (re-run after src changes)
node tools/fetch-klines.mjs --months 6
node tools/replay.mjs               # -> data/entries.json
node tools/study-a.mjs              # forward returns vs 3 controls
node tools/study-score.mjs          # score discrimination
```

---

# Addendum — exit geometry, measured

**Run date:** 2026-09-21 · `tools/sim-exits.mjs`

When ATR-scaled geometry landed, the commit message claimed it "cuts turnover"
on theoretical grounds (barrier-touch time scales roughly with the square of
distance). This measures that claim instead of asserting it.

Method: entry set held fixed, only the exit ladder varies — one variable, per
`AUDIT.md` §11. Barriers resolved on 5m bar high/low; when a bar touches both
the stop and a tier, the stop is assumed to fill first.

| Metric | In-sample (6mo, 2026) | Out-of-sample (24mo, 2024–25) |
|---|---|---|
| OLD expectancy / trade | −24.5 bp | −40.9 bp |
| NEW expectancy / trade | **+54.4 bp** | **−82.5 bp** |
| OLD profit factor | 0.87 | 0.79 |
| NEW profit factor | 1.16 | 0.82 |
| OLD hold / turnover | 29.6h · 0.8 rot/day | 20.5h · 1.2 rot/day |
| NEW hold / turnover | 105.7h · 0.2 rot/day | 77.2h · 0.3 rot/day |
| **Turnover reduction** | **72%** | **73%** |
| **Hold lengthening** | **3.6×** | **3.8×** |
| OLD bleed rate | −19.9 bp/day/slot | −47.9 bp/day/slot |
| NEW bleed rate | +12.3 bp/day/slot | −25.6 bp/day/slot |

## Verdict: mechanical claim confirmed, profit claim refuted

**Turnover and hold time replicate almost exactly** across both samples. That
part is geometry, not market behaviour, so it holds in any regime.

**The in-sample profitability did not replicate.** +54.4 bp/trade became
−82.5 bp/trade. Two tells were visible in-sample and should have been weighted
more heavily at the time: 35.5% of NEW trades hit the 7-day TIMEOUT still open
(so a third of the result was the mark-to-market, not the ladder), and a
105-hour average hold is mostly four days of market exposure in a window
already known to be momentum-friendly.

**In book terms**, at 10 slots:

- Old geometry: −0.48%/day ≈ **−13.5%/month**
- New geometry: −0.26%/day ≈ **−7.4%/month**

The change nearly halves the bleed rate and is worth keeping. It does not make
the system profitable, and no exit rule can — the harvest ladder returns profit
factor 1.001 on a zero-drift null, so all edge must come from the entry, and
Study A showed the entry has none.

Note that per-trade expectancy got *worse* (−40.9 → −82.5 bp) because each
trade is now larger. What improved is the rate at which the loss is paid.

## Caveat on a number in this output

The OOS run prints "eligible 209,749 (3.1% of all symbol-steps)". That is an
artifact of the `--top-only` flag capping storage at one entry per step, **not**
a regime difference from the 76.8% gate-admission rate measured in Study A.

## Reproduce

```bash
node tools/replay.mjs --dir data/klines2024 --out data/entries2024.json --top-only
node tools/sim-exits.mjs --dir data/klines2024 --entries data/entries2024.json
```
