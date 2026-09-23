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

# Addendum 2 — profit taking: trailing, locks and caps, measured

**Run date:** 2026-09-23 · `tools/sim-exits.mjs --sample 8000`

Question: should the ladder lock profit earlier (e.g. "up 10%, lock 7%; up 15%,
lock 12.5%; close at 20%"), or trail the peak instead? The entry set is held
fixed; only the exit varies. Expectancy in bp per trade, PF = profit factor.

| Exit rule | In-sample (6mo) | Out-of-sample (24mo) | max win | top 5% of trades |
|---|---|---|---|---|
| OLD (capped 3.2/3.8/7.5/12) | −24.2 · 0.87 | −37.0 · 0.81 | 11% | 26% |
| CURRENT (tiers 1R/2R/3.5R, trail after T3) | **+56.0 · 1.16** | −79.3 · 0.82 | 27% | 26% |
| trail after T1, 1.0–2.0× ATR | +46.7…+59.5 | −84.1…−75.7 | 26–41% | 22–27% |
| trail after T2, 1.5× ATR | +59.0 | −80.8 | 34% | 26% |
| fixed locks 10/7, 15/12.5, cap +20% | +48.3 · 1.14 | **−84.8 · 0.82** | 20% | 25% |
| T1 33% then trail 3.5× ATR | +36.3 | −40.3 · 0.91 | 168% | 43% |
| pure trail 3.5× ATR (no tiers) | +37.7 | −4.2 · 0.99 | 247% | 49% |
| pure trail 5–8× ATR | +42…+44 | +17.6…+21.8 · 1.03 | 385% | 50% |
| initial stop only, hold to 7d | +42.3 | +24.5 · 1.04 | 385% | 50% |
| **no stop at all, hold to 7d** | +28.1 | **+70.8 · 1.11** | 385% | 43% |

## Verdict: the exit is not where the money is

**Locking profit earlier is the worst option.** Every tighter variant loses more
out of sample than the current ladder, and the fixed "lock 7% / 12.5%, cap 20%"
scheme is the worst of all at −84.8 bp. The cap is visible in the tail: max win
20% against 385% for the wide variants, which is the mechanism - it removes
exactly the trades that pay for the rest.

**Wider is better, monotonically, until there is no exit rule left.** 3.5× ATR
beats 2.5×, 5× beats 3.5×, and "initial stop only" beats them all - and *no stop
at all* is the best line in the table. That is the tell. These are not exit
skill; they are market exposure. The entry carries no edge (Study A), so every
stop placed on top of it mostly converts drift into realised losses, and the
2024-25 sample rose.

**"No stop" is not a strategy.** It has unbounded downside per trade and its
result is the sample's beta. It is in the table as the null that the exit rules
have to beat, and none of them do.

**The in-sample advantage of the current ladder does not replicate** (+56.0 →
−79.3), the same non-replication as the geometry study above.

## Consequences

- Keep the current ladder. `trailAfterTier` stays 3. Trailing earlier is inside
  noise (−75.7 to −84.1 against −79.3) and is not worth the change.
- Do not add fixed-percentage locks or a profit cap.
- `trailAfterTier` / `trailAtrMultiple` (config/geometry.ts) remain as knobs so
  this can be re-measured if the entry ever changes.
- Risk-based sizing is back on: it does not add edge, but it keeps dollar risk
  constant across coins, which makes every later comparison readable.

The one real finding for a trade like BCH (+13% then a full retrace keeps only
2.5% on a 5% ATR coin) is that the give-back is real per trade, but fixing it
does not change the aggregate: the trades cut short and the trades saved cancel
out. Any further exit work is re-tuning noise.

# Addendum 3 — entering at real levels, measured

**Run date:** 2026-09-23 · `tools/study-levels.mjs`, `tools/sim-exits.mjs`

The scanner's "levels" were formulas applied to the 24h ticker snapshot, so no
rule about support, resistance or pullbacks could mean what it said (see
Addendum 2's note and services/marketAnalysisService.ts). With real candles in
place, the same historical entry set - the entries the scanner actually took -
was labelled with what the real analysis said at that moment, and bucketed.
Forward return at 4h, net of a 30 bp round trip:

| Bucket | n (OOS) | in-sample 6mo | out-of-sample 24mo | t (OOS) |
|---|---|---|---|---|
| every entry | 12,445 | −25.6 bp | −30.9 bp | −13.0 |
| resistance within 0.25 ATR overhead | 5,119 | −70.9 | **−78.6** | −25.6 |
| 4h structure bearish | 2,326 | −90.6 | **−101.8** | −20.2 |
| price within 0.25 ATR of a real support | 4,989 | +13.3 | **+14.3** | +4.0 |
| headroom > 1 ATR | 205 | +109.0 | +148.7 | +3.1 |
| pullback with a reclaim candle | 1,412 | +12.3 | +8.9 | +1.3 |
| **all three gates (support, headroom, not bearish)** | 2,702 | **+40.5** | **+54.3** | **+9.7** |
| the three gates plus a reclaim candle | 623 | +82.2 | +92.6 | +9.2 |

Both samples agree on sign and magnitude, on thousands of entries, and the two
strongest effects are the negative ones: buying under resistance or into a 4h
downtrend. The gates keep about a fifth of entries.

## Through the bot's own exits (out-of-sample, 24mo)

| Entry set | OLD tight ladder | CURRENT ladder (1R/2R/3.5R) |
|---|---|---|
| every entry | −37.0 bp · PF 0.81 | −79.3 bp · PF 0.82 |
| level-gated | **+37.2 bp · PF 1.24** | −7.5 bp · PF 0.98 |

In-sample the gated set gives +52.7 bp (PF 1.33) on the old ladder and
+143.8 bp (PF 1.48) on the current one.

Two readings worth keeping:

1. **The gates are worth about 70 bp a trade out of sample, whatever the exit.**
2. **On gated entries a stop finally pays.** Addendum 2 found that on ungated
   entries the best exit rule was no stop at all - the "edge" was market
   exposure. On gated entries "initial stop only" (+125.4 bp) and the 5× ATR
   trail (+118.3) beat holding with no stop (+103.7), which is the signature of
   entry selection rather than beta. The tight old ladder is also the only exit
   that is positive in *both* samples (+52.7 / +37.2), consistent with the edge
   being short-horizon: the 1h and 4h forward returns are where it shows.

## Consequence

`config/entry.ts` gates are on: support within 0.25 ATR, resistance no closer
than 0.25 ATR, and no entry while the 4h structure is bearish. The reclaim
requirement is measured and stronger per trade but keeps a quarter as many
entries, so it stays off until live trade counts justify it.

**Not yet measured:** whether a tighter ATR ladder on gated entries beats the
current one in both samples. That is the next exit question, and now it has a
reason to be asked.

---

# Addendum 4 — the exit ladder for gated entries, measured

**Run date:** 2026-09-23 · `tools/sim-exits.mjs --entries data/entries2024-levels.json --dir data/klines2024`

Addendum 3 left one question open: the gates changed the entry, so the exit
built for ungated entries need not still be right. The entry set is held fixed
(16,527 gated LONG entries, 24 months, out of sample; 8,829 in the 6-month
in-sample set) and only the ladder varies. Every variant uses the shipped shape
- 33/33/17 at three tiers, breakeven floor after tier 1, tier-1 floor after
tier 2, trail after tier 3 - so what is compared is where the barriers sit.

## Out of sample, 24 months, 15 bp per side

| ladder | expectancy | PF | avg hold | rot/day | bp/day/slot |
|---|---|---|---|---|---|
| OLD fixed (3.2 / 3.8 / 7.5 / 12%) | +39.8 bp | 1.25 | 23.4h | 1.0 | +40.8 |
| previous: 1.5× ATR, 1R/2R/3.5R | −7.6 | 0.98 | 82.6h | 0.3 | −2.2 |
| 1.5× ATR, 0.5R/1R/2R | +23.9 | 1.09 | 47.3h | 0.5 | +12.2 |
| 1.0× ATR, 1R/2R/3R | +32.3 | 1.12 | 46.9h | 0.5 | +16.5 |
| 1.0× ATR, 0.75R/1.5R/2.5R | +36.3 | 1.17 | 36.6h | 0.7 | +23.8 |
| **0.75× ATR, 1R/2R/3R** | **+37.5** | **1.19** | **30.5h** | **0.8** | **+29.5** |
| 0.5× ATR, 1R/2R/3R | +31.5 | 1.25 | 15.9h | 1.5 | +47.5 |

In sample (6 months) every ladder is positive, so the in-sample ranking is the
wrong thing to read. What it does show is which ladder is fitted to it:

| ladder | in-sample | out-of-sample |
|---|---|---|
| previous: 1.5× ATR, 1R/2R/3.5R | +143.8 bp (PF 1.48) | **−7.6** (0.98) |
| 1.5× ATR, 0.5R/1R/2R | +89.4 (1.43) | +23.9 (1.09) |
| 1.0× ATR, 1R/2R/3R | +90.3 (1.37) | +32.3 (1.12) |
| 0.75× ATR, 1R/2R/3R | +57.8 (1.31) | +37.5 (1.19) |
| 0.5× ATR, 1R/2R/3R | +38.5 (1.31) | +31.5 (1.25) |

The wider the ladder, the larger the gap between the two samples. The shipped
1.5× ATR ladder is the extreme case: best in sample by a distance, negative out
of it.

## Why wider stopped working

Addendum 2 widened the barriers because turnover cost is certain and edge was
not: with no edge at entry, holding longer is strictly cheaper. The gates gave
the entry an edge, and that edge is short-horizon - Addendum 3 measured it at
1h and 4h. A ladder that needs 82 hours to resolve spends most of that time
holding a position whose reason for existing expired on day one. The exit's job
changed from "cost as little as possible" to "collect the edge before it
decays".

## Cost sensitivity

Expectancy per trade out of sample, with the cost per side overridden
(`--cost-bps`). 15 bp is what `src/config/costs.ts` assumes; the others ask what
happens if real slippage is worse.

| ladder | 15 bp | 25 bp | 35 bp |
|---|---|---|---|
| OLD fixed | +39.8 (1.25) | +19.8 (1.12) | −0.2 (1.00) |
| previous: 1.5× ATR | −7.6 (0.98) | −27.6 (0.94) | −47.6 (0.89) |
| 1.0× ATR, 1R/2R/3R | +32.3 (1.12) | +12.3 (1.04) | −7.7 (0.97) |
| 1.0× ATR, 0.75R/1.5R/2.5R | +36.3 (1.17) | +16.3 (1.07) | −3.7 (0.98) |
| **0.75× ATR, 1R/2R/3R** | **+37.5 (1.19)** | **+17.5 (1.09)** | **−2.5 (0.99)** |
| 0.5× ATR, 1R/2R/3R | +31.5 (1.25) | +11.5 (1.09) | −8.5 (0.94) |

Nothing survives 35 bp per side. That is the honest limit of the whole result:
the edge measured here is about 20-40 bp a trade, and a 70 bp round trip eats
it. The ladders that rotate fastest lose it first, which is why 0.5× ATR - the
best earner per unit of time at +47.5 bp/day/slot - is not the one adopted.

## Consequence

`src/config/geometry.ts`: `stopAtrMultiple` 1.5 → **0.75**, `tier3RMultiple`
3.5 → **3.0**. Tiers stay at 1R/2R/3R with 33/33/17, the trail still starts
after tier 3 at 1.5× ATR.

The OLD fixed ladder scores as well or better, and it is not adopted: 3.2% is a
different thing on a 2% ATR coin than on a 10% one, and the gated universe
contains both. At a typical 4-5% ATR, 0.75× ATR is 3.0-3.75% - the same
distance OLD used - so the two agree where most trades live and differ where
OLD is wrong.

Alongside this, `src/config/universe.ts` `size` goes 40 → **80**. The ladder
change roughly doubles the number of trades per day per slot (0.3 → 0.8
rotations); the wider universe keeps the candidate pool ahead of that demand so
the extra rotations are filled by the best available setups rather than by
whatever is left.

## Reproduce

```bash
node tools/sim-exits.mjs --entries data/entries-levels.json     --dir data/klines
node tools/sim-exits.mjs --entries data/entries2024-levels.json --dir data/klines2024
node tools/sim-exits.mjs --entries data/entries2024-levels.json --dir data/klines2024 --cost-bps 25
```

---

# Addendum 5 — how tight is the support gate, and was it even running?

**Run date:** 2026-09-23 · `tools/study-levels.mjs`, plus a live scan of the 80-coin universe

The gate refuses an entry more than 0.25 ATR above support. The obvious
question is whether that is too strict - it turns away a lot of signals. The
bands either side of it, forward return at 4h net of a 30 bp round trip:

| distance to support | n (OOS) | in-sample 6mo | out-of-sample 24mo | t (OOS) |
|---|---|---|---|---|
| at support (≤ 0.25 ATR) | 2,367 | +13.7 bp | **+20.0 bp** | +3.7 |
| near support (0.25–0.5 ATR) | 2,131 | −31.7 | **−43.5** | −8.3 |
| mid (0.5–1.5 ATR) | 1,136 | −80.0 | **−107.1** | −13.1 |
| far (> 1.5 ATR) | 200 | −46.3 | −23.4 | −0.9 |
| no level found | 135 | −14.2 | −39.4 | −1.6 |

It is not too strict; the band immediately outside it is the worst part of the
sample. Loosening to 0.5 ATR would add 2,131 entries worth −43.5 bp each, which
is enough to turn the kept set negative. An entry 1.22 ATR above support - a
typical refusal - sits in a bucket that loses 107 bp a trade on 1,136
observations, t −13.1. Both samples agree.

## The gate was running on a twentieth of the universe

A live scan on 2026-09-23 showed the level gate **measured on 6 of 80 coins**.
The other 74 had no candle analysis, and the scanner treats that as "not
measured" and lets the entry through - so those coins were traded on the old
24h-ticker estimates with no level test at all.

The cause was `analyzeSymbols` mapping over the coin list inside `Promise.all`:
three candle requests per coin, all fired at once, 240 of them for an 80-coin
universe. Measured against Binance with 50 coins (150 requests):

| how the requests are sent | requests answered | coins fully analysed | time |
|---|---|---|---|
| all at once (what it did) | 23 / 150 | 7 / 50 | — |
| 6 at a time | 149 / 150 | 49 / 50 | 34s (cold) |
| **8 at a time** | **150 / 150** | **50 / 50** | **10s** |

`analyzeSymbols` now makes one batched pass per interval through
`fetchCandlesForSymbols`, which honours the limit, and the limit is 8. After
the change the same live scan analysed **80 of 80** coins and **13 passed the
gate** - 16%, in line with the ~19% at-support share of the historical set.

So the trade rate was not being held down by a gate that is too strict. It was
being decided by whichever handful of coins happened to get their candles.

**Also found:** the top 80 by volume contains tokenised equities and ETFs -
NVDAB, MSTRB, SOXLB, SPCXB, QQQB at their underlyings' prices - and NVDAB and
SOXLB passed the gate on that first scan. They follow stock-market hours, not
crypto. Added to `UNIVERSE_EXCLUDED` alongside CRCLB and SNDKB. The
"[Universe]" log line lists the chosen coins each day; new ones need adding.
