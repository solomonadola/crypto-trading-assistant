# Quantitative & Architectural System Audit Report

**System:** Crypto Trading Assistant / Session Engine v0.6.0 (working tree incl. uncommitted changes, 2026-10-13)
**Scope:** `engine/src/**`, `engine/config/config.yaml`, `src/pages/Scalp.tsx`, `src/components/TakePosition.tsx`, `src/lib/api.ts`
**Verification run:** `vitest run` → 26 files, **359/359 passing**; `tsc --noEmit` → clean.
**Code modified:** none.

> **First, five places where the review brief doesn't match the code.** Several questions in `SYSTEM_REVIEW_PROMPT.md` assume behaviour the code doesn't have. Answering them as written would hide the real risks.
>
> | The brief says | The code does |
> |---|---|
> | 4 scalp algorithms: `ema_pullback`, `vwap_bounce`, `sfp_sweep`, `fvg_fill` | **6**: `sweep_reclaim`, `vwap_bounce`, `ema_pullback`, `fvg_retest`, `volume_climax`, `orb` (`scalp.ts:15`) |
> | The fakeout filter (`filters.ts:fakeout`) guards entries | It runs only inside `check()` for the **classic pullback model, which is disabled** (`models.pullback: false`). Zone-sweep, session-sweep, HTF-POI and the **Quant Autopilot never run it**. |
> | 3-candle `failed_breakout` bailout (`exits.ts:36-37`) | It lives in the classic manager. `exits.management: v3` returns at `exits.ts:31` before reaching it. **It never fires.** |
> | Live WebSocket feed (`feed.ts`) | A **REST poller**, 3 s after each minute (`feed/liveFeed.ts`), plus a 2 s REST ticker poll for live stops |
> | Simulator `core/sim.ts`, "backtester" | `sim/broker.ts` is a fill model only. There is **no backtester**: `replayFeed.ts` only re-runs stored candles after a restart. |
>
> In short, the anti-fakeout layer the brief asks me to evaluate isn't protecting any trade the system takes today.

---

## 1. Executive Summary & System Scorecard

| Metric | Rating |
|---|---|
| **Overall Architectural Grade** | **B−** for the core engine (pure, event-sourced, well tested). **D** for the Quant Autopilot layer bolted on in `main.ts`. Blended: **C+** |
| **Statistical Edge Viability** | **Low, and unmeasured.** No setup has an out-of-sample test. The only performance figure is the Scalp page's 24 h follow-forward, which measures a different trade from the one the autopilot places (§4). Under a driftless null, every scalp loses 0.09–0.33 R per trade to costs. |
| **Production Readiness (live capital)** | **2 / 10.** There is no exchange execution layer at all: no API keys, no order endpoints, no exchange-side stops. As a paper-trading research platform it's about **6 / 10**. |

### Core strengths
1. **A genuinely pure engine core.** `core/engine.ts` takes time only from candle close times. State is rebuilt from an append-only event log (`portfolio.apply`), and a static purity test enforces this (`purity.test.ts`). Restart recovery and audit trails are first-rate for a project of this size.
2. **Conservative candle conventions in most places.** Stop-before-target on ambiguous candles (`engine.ts:547`, `scalp.ts:219`). Gap-aware stop fills (`broker.ts:155`). Reward:risk is measured *after* round-trip costs (`speed.ts:216`). Positions are re-sized at fill time against the live equity (`engine.ts:603-608`).
3. **Layered risk caps that compose correctly** (`risk.ts:59-128`): per-trade loss cap → exposure cap → open-risk cap → 1 h-volume cap → exchange minimums. Also a losing-streak size cut, a per-symbol cooldown, a daily loss gate and a drawdown kill switch.
4. **Feed hygiene.** Forming candles are never handed on (`liveFeed.ts:153`). Clock sync to Binance server time works. 429 and 418 handling respects `Retry-After` (`binancePublic.ts:83-93`). Single-writer lease via Firestore.
5. **Double-submit safety.** A second manual or autopilot order on a symbol already held or pending is refused by `risk_already_in_symbol` (`risk.ts:76`). Because Node is single-threaded and commands run in a sync transaction, double-clicks can't create two orders.

### Critical red flags
1. **The Quant Autopilot sits outside every engine safeguard.** It enters through the *manual* `open` command (`main.ts:884`). That skips killzones and weekends, the funding, BTC and exhaustion filters, `max_stop_pct`, `fees_too_high`, `min_target_pct` and score ranking. The trades are also labelled `setup: 'manual'`.
2. **The autopilot trades any coin that is fed**, including watchlist coins (documented as "never traded", `main.ts:107`) and *any coin someone opens on a chart* (`main.ts:1209`, `symbols()` at `main.ts:163`).
3. **Fill modelling is biased in your favour when a limit order fills on the same candle as its stop or target.** If the candle hits limit and stop, the order is cancelled and the loss vanishes. If it hits limit and target, the win is booked (`engine.ts:574-591`, `557-560`). Tight-stop scalps are where this happens most.
4. **A restart or feed catch-up re-runs the autopilot on old candles** (`main.ts:291` → `process_` → `runQuantAutopilot`). A manual limit can also fill when the current price is already beyond its stop (`engine.ts:431-441`).
5. **The BTC "dumping" guard is up to about 60 minutes late.** It compares the last two *closed 1 h* candles (`main.ts:659-663`), and the result is cached per 15 m candle.
6. **Time stops depend on text in the free-form `note` field** (`engine.ts:503-528`). If someone edits the note, the position loses its 45 m / 2 h / 4 h stop.
7. **An uncommitted change switches the engine's own models from market to limit entries with a 4 h timeout** (`engine.ts:955`, `521`). This removes slippage and picks up the fills that move against you; the trades that run away in your favour never fill.

---

## 2. In-Depth Technical Audit

### A. Scalp Autopilot & Entry Execution

#### A.1 Setup detectors (`engine/src/analysis/scalp.ts`)

| Kind | Trigger | Stop | `keyLevel` (limit) | Assessment |
|---|---|---|---|---|
| `sweep_reclaim` | Wick > swing pivot + 0.05 ATR, close back inside. Pivot untouched by closes since it formed. | Candle extreme ± 0.1 ATR | The swept pivot | Best-specified of the six. Pivots use `confirmedAt < i`, so there's **no lookahead**. 0.05 ATR of penetration is shallow: on 1m/5m alts it counts ordinary noise as a "sweep". |
| `vwap_bounce` | 6 (10 on 1m) closes on one side of VWAP, EMA20>EMA50, touch within 0.1 ATR, close back | Beyond min(low, VWAP) − 0.1 ATR | VWAP | Sound. The daily VWAP resets at 00:00 UTC, so the first 1–2 h of each UTC day are unreliable. |
| `ema_pullback` | 1 h bias, EMA20>EMA50, low ≤ EMA20 < close, prior 12-bar excursion ≥ 1 ATR. Disabled on 1m. | Lowest low of 6 bars − 0.1 ATR | EMA20 | Reasonable trend-continuation logic. |
| `fvg_retest` | 3-bar gap > 0.05 ATR, candle taps into it, closes beyond the far side | Far side of gap − 0.1 ATR | Near side of gap | The gap must exist on bars i-3…i-1 and be tapped on bar i. That's an **immediate** retest, a weak form of FVG logic. Often the close is already below the key level, so the limit collapses to the close. |
| `volume_climax` | Volume ≥ 2.2× SMA20, ≥ 40 % absorption wick, close in favourable half | Extreme ± 0.1 ATR | Wick midpoint | A reversal setup. The autopilot's `withTrend` gate means it's only taken as a dip-buy in an uptrend, which works against what it's designed to catch. |
| `orb` | First close beyond the London/NY 3-bar opening range, volume > SMA20 | OR midpoint | OR edge | A conventional setup. With a midpoint stop, R is usually large, so many are dropped by the 2.5–3.5 % cap. |

**Is `keyLevel` sound for limit execution?** In the geometry sense, yes. I checked each detector: the key level always sits strictly between the stop and the close, so the limit can never land on the wrong side of the stop. In the statistical sense, no, for two reasons:
- **The win/loss stats are computed for a fill at the signal close**, which `follow()` assumes (`scalp.ts:215`). The autopilot instead rests a limit at the key level. Those are different trades: the limit only fills when price retraces deep into the structure that triggered the signal. That's adverse selection. You systematically miss the setups that work at once, and you fill the ones that are failing.
- **A deeper limit means a smaller R, so costs eat a larger share of it.** Example: close 100.0, swept level 99.7, stop 99.4. At the close, R = 0.6 % and costs/R = 0.2/0.6 = 33 %. At the key level, R = 0.3 % and costs/R = 67 %. The engine rejects anything above 15 % fee drag for its own models (`max_fee_drag_pct`), but `openManual` never applies that check. The trade passes because the reward:risk check *improves* with a lower entry: the target was computed from the close (`engine.ts:412`).

**Does removing `ema_pullback` from 1m remove noise without losing alpha?** The question doesn't apply to the autopilot, because it ignores 1m entirely (`main.ts:830`). For manual 1m use, the other five 1m detectors are noisier than `ema_pullback` was. `sweep_reclaim` at a 2-bar pivot with 0.05 ATR penetration fires on almost every micro-swing. There's no data to show alpha either way.

**Other detector issues:**
- `withTrend` uses the *current* 1 h trend and stamps it onto every setup in the 24 h window (`main.ts:818`, `scalp.ts:112`). So the historical stats on the Scalp page carry lookahead bias whenever the 1 h trend has changed.
- `scalpStats` pools 1m, 5m and 15m setups and both trend states into one table (`main.ts:935-936`). The sample is about 24 h. These numbers can't support a decision.
- `SCALP_COST_PCT` = 0.20 % is fixed (`main.ts:799`). For the "wild" speed group the engine charges 0.40 % (`speed.ts:208`). So the Scalp page overstates the R of wild coins, and `openManual` then rejects some of those trades as `rr < 2`.

#### A.2 Autopilot loop (`main.ts:827-916`)

**Do the gates (5m/15m only, `withTrend`, stop ≤ 2.2 %) prevent catastrophic drawdowns?** No. They limit how big each trade is, not how much the account loses overall. Gates that are missing:

| Missing gate | Engine models have it | Autopilot |
|---|---|---|
| Killzone / weekday / funding-window block | ✅ `sessions.entryBlock` | ❌ trades 24/7, weekends included |
| Funding / BTC 1 h (rolling 1m) / ADR filters | ✅ `engine.ts:883-893` | Partial. ADR yes, BTC only via the stale 1 h check, funding no |
| `max_stop_pct`, `min_target_pct`, `fees_too_high` | ✅ `planFailures` | ❌ only a hard-coded `2.2` and the RR check |
| Universe restriction (scanner quality) | ✅ `universe.has()` | ❌ any fed symbol, including chart-viewed coins |
| Minimum stop distance vs ATR or noise | — | ❌ only "≥ 3× costs" (`scalp.ts:94`) |

What actually caps the downside are the account-level limits in `decideEntry`: 1 % per trade, 3 % open risk, 4 open trades/pending, 6 entries a day, a 3 % daily-loss gate, the 30-minute cooldown, and the 15 % drawdown kill. Those are sound, and they mean the worst *expected* day costs about 3–4 % of equity. The tail scenarios are covered in §4.

**What happens when price runs away without filling?** It's handled correctly in the core. The order is cancelled with `timeout_missed_pullback` after 35 min (5m) or 60 min (15m) (`engine.ts:521`), or with `target_reached_before_fill` if the target prints first (`engine.ts:583`), or with `cancelled_invalidation_hit` if the stop prints first. Three weaknesses:
- The order is placed at `c.closeTime + 1` (`main.ts:889`). Candles use `closeTime = openTime + tf` (`candleStore.ts:22`), so `placedAt <= c.openTime` fails for the first following 1m candle (`engine.ts:537`). **The first minute after the signal can never fill.**
- A pending limit is checked only on closed 1m candles. The 2 s live-price path (`engine.ts:383`) handles stops and targets of *open positions* only.
- Timeouts are keyed off regexes on the note, not config, so `configHash` doesn't capture them.

**Are the `autoPlacedScalps` dedupe keys safe from leaks and replays?**
- **Memory leaks: yes, safe.** The set is FIFO-capped at 500 (`main.ts:896`).
- **Replays: no.** The set lives in memory only. After a restart, `startEngine()` replays stored candles through `process_()`, which calls `runQuantAutopilot` on each historical batch (`main.ts:215`, `291`). `scalpsFor` always reads the *latest* candles (`store.latest`), not candles as of the replayed time. Any setup still `open` gets matched again and an order is placed with a *past* `time`. The same happens on any feed catch-up after an outage. `runQuantAutopilot` should skip batches whose close time is older than about one bar.

### B. Anti-Fakeout & Trap Detection Mechanics

#### B.1 Fakeout filter (`filters.ts:89-105`): **inactive under the current config**

I evaluate it on its merits anyway, for when the pullback model is switched back on:

| Formula | Comment |
|---|---|
| `s·(close − level)/ATR15 ≥ 0.20` | Reasonable. The break must clear noise. `NaN` ATR fails closed (good). |
| `closePos ≥ 0.70` | Requires the close in the top 30 % of the range. This works against absorption wicks. |
| `oppWick ≤ 0.40` | Correctly measures the *opposite* wick for each direction. The config name `max_upper_wick_ratio` is misleading for shorts. |
| `rvol15m ≥ 2.0` | Combined with the three conditions above, this is very restrictive. Expect very few signals to pass. |

**Does it catch stop runs?** Only partly. A stop run looks the same as a real breakout *on the trigger candle*: big volume, a close near the extreme. What tells them apart is the next 1–3 candles. That's why the `failed_breakout` exit was paired with this filter, and that exit is now dead code too (see B.3). The filter does catch low-volume drift (the rvol condition) and obvious rejection wicks.

#### B.2 Trap & pump radar (`pumpWatch.ts`)

- **`failedBreaks()`** looks at the last 3 closed 1 h candles. It flags a wick beyond the prior 24 × 1 h high or low on ≥ 1.5× average volume, with ≥ 50 % of the range as wick and a close back inside. The logic is correct.
- **Does it block opposing trades?** Yes, for the autopilot. `failed_high` blocks longs and `failed_low` blocks shorts (`main.ts:858-859`), for 3 hours after the candle. The engine's own models ignore pumpWatch entirely, as the file says ("the engine's entries do not use them").
- **`sweep_reclaim` (radar version)** is only a dashboard caution. Nothing trades it. Calling it a "high-probability mean reversion setup" in user-facing text (`pumpWatch.ts:196`, `202`) is an untested claim and should be softened.
- **Pump-phase logic** (`findPump`) is a sensible heuristic. One flaw: `blowoff` needs the peak within the last 2 h, while `unwind` triggers at a 38.2 % retrace. A coin that tops and drops 30 % in 3 h reads as `distribution` (caution), and caution doesn't block longs.
- **The whole radar runs on closed 1 h candles and is cached per 15 m candle** (`main.ts:641-646`). It's slow by design. It's suited to swing context, not 5m scalps.

#### B.3 3-candle emergency bailout: **inactive under the current config**

When it was live: 3 × 15 m = 45 min, triggered by any 15 m close back across the CHoCH level (`exits.ts:36`). That's too sensitive. A healthy retest that closes 1 tick through the broken level is common, and especially so now that entries are limits *at* the close. Suggested fix: require the close back across by ≥ 0.25 × ATR15, or two consecutive closes. Ideally, measure both variants with shadow trades before turning either back on.

### C. Engine Core, Risk Limits & Time-Stops

#### C.1 Purity
- **Static purity holds.** There's no clock, I/O, timers or randomness in the core (enforced by the test).
- **Semantic determinism has weakened.** `live_prices`, `open` and `close` commands carry wall-clock times and mark prices from outside (`main.ts:256`, `529`, `565`). The event log stays authoritative, so restarts are fine. But **re-running the same candles no longer reproduces live results**: a live-price stop fill differs from a candle stop fill. The autopilot's decision logic (`main.ts`) uses `Date.now()` and latest-store data, so it **can't be replayed or backtested at all**.
- **Event times are no longer monotonic.** Live exits and manual fills are stamped `Date.now()`, which is ahead of the engine clock. The portfolio doesn't care, but analytics that assume a sorted log will misbehave.

#### C.2 NaN / Infinity / division safety
Mostly good. Most divisions are guarded (`risk > 0`, `ai > 0`, `range > 0`), and the filters fail closed on `NaN`. Gaps I found:
- `reset_balance` accepts negative balances: `Number(req.body.balance) || undefined` only screens out 0 (`main.ts:583`). After that, `drawdown = 1 − eq/peak` behaves oddly.
- `guardrails()` would produce `NaN` drawdown if `peakEquity` were ever 0 (`engine.ts:659`). That can't happen today, but nothing guards it.
- `chop()` divides by `atr` without a guard (`filters.ts:49`). The result is a `NaN` slope that fails the check, which is acceptable.

#### C.3 Sizing and the circuit breakers
- **Sizing** is `notional = risk% / (stop% + round-trip%)`, re-checked at fill. That's correct.
- **The daily loss limit is only an entry gate.** It doesn't flatten open positions, which is acceptable. It is measured against equity at the first close of the UTC day.
- **The drawdown kill** is checked only at candle closes (`engine.ts:454`), not after live-price exits. A `resume` command resets `peakEquity` to current equity (`engine.ts:336`), so repeated pause/resume cycles can keep re-arming the 15 % allowance with no lifetime cap.
- **Correlation control is close to useless.** The only correlation group is `memes`. In a BTC-led crash, four alt longs behave like one position at about 4× size.
- **Can a multi-coin flash crash get past the risk limits?** By design the limits bound *planned* loss at about 3 % (open-risk cap). What they don't bound is **slippage past the stop**, which scales with notional. With tight scalp stops, notional is large: a 0.4 % stop at 1 % risk means 167 % of equity per position, up to the 300 % exposure cap. Each 1 % of stop slippage across the book costs about 3 % of equity. The simulator charges a fixed 0.05–0.15 % (`broker.ts:155-162`), so this tail never shows up in paper results.

#### C.4 Time stops (`engine.ts:503-514`)
Positions *can* outlive their thresholds:
1. **The note gets edited** (TakePosition lets you edit the default `Quant Scalp (5m): …`). No "Scalp" in the note means no scalp time stop, and the position falls back to the 48 h speed-group hold.
2. **The note has no `[1m]`/`(1m)`/`[5m]`/`(5m)` tag.** It defaults to 4 h. Any note that merely contains the word "scalp" also gets a 4 h stop.
3. **The close fills only at the next 1m candle open for that symbol** (`closeOrder` → `engine.ts:542`). If the feed is stalled, the position stays open indefinitely. The manual close path uses the mark price; the time stop doesn't.
4. **`onTime` runs only when the clock moves forward**, and the clock is driven entirely by candles.

Fix: store `maxHoldMs` and `entryTimeoutMs` as typed fields on the order (`OpenOrder`) and drive them from config. Never parse them out of the note.

### D. Market Feed & Simulation Realism

#### D.1 Feed (`feed/liveFeed.ts`, `binancePublic.ts`)
- **Dropped packets / out-of-order candles:** these don't really apply to REST polling. Gaps are refilled from the last stored open time, and the batch is sorted by `compareCandles`. Good.
- **Rate limits:** about 150 kline calls a minute (≈30 symbols × 5 timeframes) plus a ticker call every 2 s. That's well under 2400 weight. 429 and 418 are handled properly.
- **A symbol that falls behind loses stop checks.** `Engine.onCandles` drops any candle whose close time is earlier than the *global* engine clock (`engine.ts:309`). `process_` only sends those to analysis (`main.ts:205`). If one symbol's requests fail for two or more polls while others succeed, its missed 1m candles **never run through `onMinute`**. Stops, targets and limit fills that happened in those candles are skipped silently. The 2 s live-price check partly covers this, but it polls the same REST host.
- **Forming vs closed candles:** handled correctly. Forming candles are filtered out (`liveFeed.ts:153`) and only built for chart display (`formingCandle`).
- **Latency:** an entry decision lands about 3–8 s after the close (3 s poll delay plus about 150 requests at concurrency 8). That's fine for 15 m and marginal for 5m scalps.

#### D.2 Simulation fidelity (`sim/broker.ts`, `engine.ts:fillEntry`)
| Item | Status |
|---|---|
| Taker fee | 0.05 % on every fill, limit fills included. Conservative (the maker fee is 0.02 %). |
| Slippage | Fixed 0.05 % (wild: 0.15 %) on market and stop fills. **None on limit fills.** No volatility or size dependence. Optimistic for stops during fast markets. |
| Funding | Charged at 00/08/16 UTC using the *last settled* rate, refreshed every 5 min. Acceptable. |
| Liquidation | Isolated-margin formula, but `fee: 0` on liquidation. Minor, since stops always sit inside the liquidation price. |
| **Limit-fill bias** | Fills **on touch** with no queue position (optimistic). **Same-candle limit+stop is cancelled; same-candle limit+target is booked as a win** (`engine.ts:577-591`, `557`). The ambiguity is always resolved in the trade's favour. That's the opposite of the stop-first rule used everywhere else. |
| Lookahead | None found in the engine. The scalp *stats* have the `withTrend` lookahead (A.1). |
| Shadow trades | Assume a fill at `plan.entry` (`engine.ts:1010`), but entries are now limit orders that may never fill. So "followed" results include trades that never happened. |

### E. Frontend & Operational Controls

- **Telemetry.** SSE `engine` events trigger refetches, and `prices` arrive every 2 s. That's adequate. Pending limits show in the account summary with price, stop and target.
- **Double-clicks are safe on the server** (see Strength 5). The UI `busy` flag is a nice-to-have on top.
- **Stale quotes.** If the entry box is blank, the UI fills in its own last price `now` and sends `orderType: 'limit'` every time (`TakePosition.tsx:99`, `382`). The server's "already reached?" check uses the **last 1m close**, not the mark (`engine.ts:429`). A marketable limit fills at the *limit* price. The sim is pessimistic here, but a real exchange would fill at the touch. **There's no check that the current price is still on the right side of the stop** before an immediate fill.
- **Cost mismatch.** The UI uses a hard-coded 0.2 % cost (`TakePosition.tsx:104`). The server uses speed-group costs, up to 0.4 %. For wild coins the UI says the RR is fine and the server rejects the order.
- **The autopilot toggle isn't in the event log or the backup.** It's only a KV flag (`main.ts:926`), so there's no audit trail of when it was switched on or off.

---

## 3. Vulnerability & Bug Register

| Severity | File & Line Range | Issue Description | Impact / Failure Mode | Recommended Remedy |
|---|---|---|---|---|
| **P0** | `engine/src/main.ts:884-894`, `core/engine.ts:402-442` | The autopilot enters through the manual `open` command | Skips sessions/weekends, funding/BTC/exhaustion filters, `max_stop_pct`, `fees_too_high`, `min_target_pct`. Trades are logged as `setup:'manual'`, so results can't be attributed. | Add a dedicated `scalp` command or model inside the engine core. Run it through `planFailures` and the shared filters, give it its own setup label, and drive its limits from config. |
| **P0** | `engine/src/main.ts:830-839`, `163-166`, `1207-1213` | The autopilot considers every fed symbol | Coins on the watchlist (documented "never traded") or opened on a chart (illiquid, unscreened) can be auto-traded | `if (!universe.includes(c.symbol)) continue;` |
| **P0** | `engine/src/main.ts:215`, `291-294` | Autopilot runs on replayed or caught-up batches | After a restart or outage, orders are placed on stale setups with past timestamps, and can duplicate earlier orders | Skip when `Date.now() - c.closeTime > TIMEFRAME_MS[c.tf]`, or pass a `live` flag to `process_`. Persist the dedupe keys. |
| **P1** | `core/engine.ts:573-591`, `557-560` | Same-candle ambiguity in limit fills is resolved in the trade's favour | Fill+stop within 1 min is cancelled (loss hidden). Fill+target is a win. Win rate is inflated for tight-stop scalps. | If `limitReached && stopHit`, fill then stop at `stopFill`. If limit and target are both hit on the fill candle, don't book the target until the next candle. |
| **P1** | `core/engine.ts:431-441` | An immediate limit fill doesn't check the current price against the stop | A long limit above the market but with the market already below the stop fills, then stops out with a gap at more than 1 R | Cancel with `filled_beyond_stop` when `s*(currentPrice - stop) <= 0` |
| **P1** | `core/engine.ts:503-528` | Time stops and entry timeouts are parsed from the free-text `note` | An edited note removes the time stop. Unrelated notes that say "scalp" get one. Changing them doesn't change `configHash`. | Typed `maxHoldMs` / `entryTimeoutMs` fields on `OpenOrder`, values from config |
| **P1** | `engine/src/main.ts:659-663`, `641-646` | The BTC dump guard uses closed 1 h candles and is cached per 15 m | It reacts 0–60 min late. Intrahour crashes that recover partway never trigger it. | Use the rolling 60 × 1m change (already computed in `context.ts:79-90`), recalculated every batch without the cache. Also add a 5–15 min velocity trigger. |
| **P1** | `core/engine.ts:309`, `main.ts:205-206` | Candles older than the global clock skip `onMinute` | When one symbol's poll lags two or more minutes, its stops, targets and limit fills are silently skipped | Track a clock per symbol for 1m settlement, or settle late 1m candles against open positions before dropping them |
| **P1** | `core/engine.ts:955`, `521` (uncommitted) | Engine models changed from market to limit at the 15 m close with a 4 h timeout | No slippage, adverse selection, setups go stale. Shadows still assume a fill. | Either go back to market orders, or shorten the timeout to 1–2 bars and record the fill rate. Make shadows honour fills. |
| **P1** | `engine/src/scanner.ts:209-217`, `main.ts:388-397` | Surge runners are added to the engine's tradable `universe`. The `exclude` list compares coin names with full symbols, so it never matches. | Top-15 gainers at ≥ $10 M volume skip `max_change_24h_pct`, the ATR caps and `min_quality`. Tokenised gold and stocks can get through. | Match on `coinOf(symbol)`. Keep surge runners in a display-only list, or run them through the same scanner gates. |
| **P2** | `engine/src/main.ts:889`, `core/engine.ts:537` | `placedAt = closeTime + 1` misses the first 1m candle | Fills arrive a minute late, which distorts the scalp-entry statistics | Use `time: c.closeTime` |
| **P2** | `core/engine.ts:336` | `resume` resets `peakEquity` | Repeated resumes re-arm the 15 % kill switch with no lifetime cap | Keep a lifetime peak as well. Require an explicit acknowledgement to resume after a drawdown halt. |
| **P2** | `engine/src/main.ts:583` | `reset_balance` accepts negative values | Strange equity and drawdown figures | Validate `balance > 0` |
| **P2** | `engine/src/main.ts:799`, `scalp.ts:93` | Scalp cost is fixed at 0.20 % regardless of speed group | Wild-coin R is overstated, and the server rejects trades the page shows as valid | Pass `roundTripPct(costsFor(cfg, speed))` for each symbol |
| **P2** | `engine/src/main.ts:818`, `scalp.ts:112` | `withTrend` uses the current 1 h bias for historical setups | Lookahead in the Scalp page stats | Compute the 1 h bias as of each setup's time |
| **P2** | `engine/src/main.ts:723-793`, `210` | Every 1m batch runs a synchronous `announceWarnings` over all listed coins, and `ideaCache` is cleared every batch | Synchronous work on the event loop grows with the coin count, about 0.2–1 s per minute at 40 coins. `/api/market` recomputes on every request. | Throttle to 15 m closes, invalidate caches per symbol, and consider moving analysis to a `worker_thread` |
| **P2** | `exits.ts:31-37`, `config.yaml:170` | Fakeout filter and `failed_breakout` exit can never run in this config | A false sense of protection, and the docs disagree with the code | Remove them, or wire them into the active models and the autopilot |
| **P2** | `src/components/TakePosition.tsx:104` | Hard-coded 0.2 % cost in the UI RR check | UI and server disagree | Expose the cost per speed group through the API |

---

## 4. Quantitative Edge Analysis

### 4.1 Expectancy of the setup → filter → exit pipeline

**The baseline with no edge.** A scalp has stop distance *r* and target distance 2*r* + *c*, where *c* is the round-trip cost (`scalp.ts:105`). For a driftless price the probability of reaching the target first is *r* / (3*r* + *c*), so gross EV is exactly zero. Net expectancy is then

> **E₀ = −c / r per trade, in R.**

| Stop distance (r) | c = 0.20 % (calm/normal) | c = 0.40 % (wild) |
|---|---|---|
| 0.6 % (minimum, 3× costs) | **−0.33 R** | −0.67 R (blocked by RR) |
| 1.0 % | −0.20 R | −0.40 R |
| 2.2 % (autopilot cap) | −0.09 R | −0.18 R |

Time stops and expiry don't change this. Truncating a martingale leaves its EV at 0. **Any setup has to beat this cost in skill before it breaks even.** Breakeven win rates against a 2 R winner: **35 %** at r = 2.2 %, **40 %** at r = 0.6 %.

**The key-level limit makes this worse:** *r* is smaller at the limit, so *c / r* is larger (see the A.1 example, where it doubles). Meanwhile the same-candle fill bias (P1) makes the *simulated* win rate look better. The two effects point in opposite directions and their sizes are unknown. **Paper P&L from the autopilot can't be read as evidence of an edge until the P1 fill bias is fixed.**

**Existing evidence.** `STUDY_A_RESULTS.md` (an earlier version of the system, 6 months, 33 symbols) found **+2.9 bps gross and −17 bps net** per trade. Nothing in the current setups has been tested out of sample. The Scalp page's 24 h stats are in-sample, pool all timeframes, carry lookahead in `withTrend`, and price a different entry from the one traded.

### 4.2 Risk-of-ruin and tail risk
- **Drift to the kill switch.** Say expectancy is −0.15 R per trade, 1 R = 1 % of equity, and there are at most 6 entries a day. The expected drift is about −0.9 % a day, which reaches the **15 % kill switch in roughly 3 weeks**. Variance gets there sooner: σ per trade is about 1.5 R, so after 60 trades σ ≈ 12 %.
- **Losing streaks.** At a 38 % win rate, P(≥ 8 losses in a row somewhere in 200 trades) is about 80 %, and P(≥ 10) is about 45 %. The streak size cut (×0.5 after 3 losses) softens this but doesn't stop it.
- **Correlated crash (the real tail).** Four alt longs, total notional up to 300 % of equity, BTC −5 % in 10 min. The planned loss is about 3 %. On top of that comes slippage past the stops: on alts it's typically 0.5–2 %. **Realised loss is 4.5–9 % of equity in one event**, against roughly 3.3 % in the sim. With no exchange-side stops (paper only), a Binance REST outage during the crash also stops both the candle and the live-price stop paths.
- **Liquidation** at 3× isolated is about 32.8 % away. It's never reached before a stop. Fine.

### 4.3 Slippage and fee sensitivity
For a 1 % stop scalp, each extra 0.05 % of one-way slippage costs about 0.10 R per trade (two fills). Moving from the modelled 0.05 % to a realistic 0.10–0.15 % on 5m alt entries and stops takes **0.10–0.20 R per trade**, which is probably more than any edge these setups have. Charging the maker fee (0.02 %) on limit entries and keeping market stops would win back about 0.03 R per trade at a 1 % stop, or about 0.06 R if take-profits are resting limits too. That's the cheapest improvement available.

---

## 5. Strategic Recommendations & Action Plan

### Top 3 fixes before any increase in capital (paper or live)
1. **Move the autopilot into the engine core as a proper model.** Run it through `planFailures`, the session/weekday rules, the funding/BTC/exhaustion filters and universe-only selection. Give it typed time-stop and timeout fields and its own `setup: 'scalp'` label. In the same change, gate it to live (non-replayed) batches. This fixes three P0s and one P1, and makes autopilot results attributable and replayable.
2. **Make the fill model honest.** Resolve same-candle limit+stop as fill-then-stop and limit+target as no win on that bar. Validate current price against the stop on immediate fills. Settle late 1m candles. Add size- and volatility-dependent stop slippage, e.g. `max(cfg.slippage, k · range1m / price)`. Until this is done, treat paper P&L as an upper bound.
3. **Build a real backtest harness and measure edge before tuning anything.** The core is already pure and candle-driven, so feeding `Engine.onCandles` from months of stored or downloaded 1m–4h klines is a small step. Record per setup type, timeframe and trend state: fill rate, win rate, average R net of realistic costs, and MAE/MFE. Freeze parameters, test out of sample, and adjust for multiple comparisons (6 kinds × 3 timeframes × 2 sides is already 36 hypotheses).

### Architectural improvements for low-latency scaling
- **WebSocket kline and mark-price streams** (`<symbol>@kline_1m`, `!markPrice@arr@1s`), keeping REST as gap-fill. That cuts decision latency from about 5 s to under 1 s and removes the 150-requests-a-minute fan-out.
- **A clock per symbol** for 1m settlement, keeping the global clock for cross-sectional 15 m logic.
- **Analysis off the event loop.** Run the scanner, watch, pattern and idea computation in a `worker_thread`, triggered by closes, with caches invalidated per symbol rather than globally.
- **An execution adapter interface** (`SimBroker` | `BinanceFuturesBroker`) behind the same `order_placed/order_filled` events, with **exchange-side STOP_MARKET/TAKE_PROFIT_MARKET** orders attached on fill and reconciliation against exchange positions on restart. That's the minimum before real capital.
- **Correlation-aware risk.** Cap total *beta-to-BTC-weighted* exposure rather than counting meme-group membership. Add a portfolio "flash" breaker on the live-price path: flatten or halt when BTC moves more than X % in 5 minutes.
- **Every control change in the event log.** Autopilot on/off and config hash changes become auditable and survive restores.
