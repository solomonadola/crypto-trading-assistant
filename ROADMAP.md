# Roadmap: from "trades a lot" to "trades with a measured edge"

**Audience:** an AI coding agent (or developer) picking this up cold. Read all of it before you change anything.
**Written:** 2026-10-13, after a full system audit (`SYSTEM_AUDIT_REPORT.md`) and two rounds of bug fixes.
**Goal:** find out which setups actually make money after costs, keep only those, and only then think about real capital.

---

## 0. Background you need

### What this system is
- Node/TypeScript engine (`engine/src/`) with a React 19 dashboard (`src/`). It **paper-trades** Binance USDT-M perpetuals. There is **no real order execution**.
- **The engine core is pure** (`engine/src/core/engine.ts` plus `analysis/`, `strategy/`, `filters.ts`, `risk.ts`, `exits.ts`, `sim/`, `portfolio.ts`, `sessions.ts`, `speed.ts`, `symbols.ts`). It takes time only from candle close times and never reads the clock, network or disk. `engine/tests/purity.test.ts` enforces this. **This is what makes a backtest possible: feed the engine historical candles and it behaves as if it were live.**
- State is event-sourced. `Portfolio.apply(event)` rebuilds the account from the trade-event log.
- Trading models:
  - Engine models, at 15m closes: `zone_sweep`, `session_sweep` and `htf_poi`. They place limit orders at the signal close, cancelled after `sim.limit_entry_timeout_min` (30).
  - The **Quant Scalp Autopilot** in `engine/src/main.ts` (`runQuantAutopilot`). It uses scalp setups from `engine/src/analysis/scalp.ts` (`sweep_reclaim`, `vwap_bounce`, `ema_pullback`, `fvg_retest`, `volume_climax`, `orb`) on 5m and 15m, and places limit orders at each setup's `keyLevel` through the engine's `open` command with `setup: 'scalp'`.

### What has already been fixed (don't redo this)
- The autopilot acts only on just-closed candles of scanner coins, never on replays or feed catch-up (`engine/src/autopilot.ts: autopilotCandles`).
- Live-price stops wait until the engine has caught up after a restart (`settledPrices`).
- Scalp orders go through `scalpFailures` in `engine.ts`: no weekend entries, no entries around funding, max stop width, fee drag, and the funding, BTC (rolling 1h on 1m) and daily-range filters.
- Max hold and entry timeout are typed fields on orders (`maxHoldMin`, `entryTimeoutMin`), not parsed from the note.
- Fill model:
  - A limit that fills and hits its stop in the same candle is fill-then-stop.
  - A target is not counted on a limit's fill candle.
  - A limit that price has already passed in your favour fills at the current price.
  - A limit is refused if price is already past its stop.
- Late 1m candles are settled (`settleLate`), and each 1m candle is settled once (`settledTo`).
- Shadow trades count only after price reaches the entry within the limit timeout.
- Daily trade caps are off (`risk.max_trades_per_day: null`, `scalp_autopilot.max_trades_per_day: null`). Still on: 2 trades per coin per day, 4 open trades, 3% open risk, 3% daily loss limit, 15% drawdown kill.
- Baseline: **383 tests passing, `tsc --noEmit` clean.**

### Rules for working in this repo
1. **Run `npx vitest run` and `npx tsc --noEmit` after every task.** Both must stay green. Add tests for new behaviour.
2. **Keep the core pure.** No `Date.now()`, timers, randomness, network, `fs` or `process.env` in the core folders listed above. New strategy logic goes in `engine/src/strategy/` and must take `now` as a parameter.
3. **Match the existing style.** Plain-English comments explaining *why*, no emoji in code, small functions, config-driven numbers. New numbers go in `engine/config/config.yaml` **and** `engine/config/schema.ts`, which is strict: unknown keys are errors.
4. **Never touch `data/engine/engine.db`.** That's the live paper account. Backtest data goes under `data/backtest/`.
5. **Don't change live trading behaviour** unless a task says so. Refactors must keep behaviour identical and prove it with a test.
6. Work on a branch. Make small commits with clear messages.

---

## Step 0: Lock in the current fixes (about 10 min)

1. `git checkout -b fix/audit-autopilot-and-fills`
2. Run tests and typecheck. Expect 383 passing.
3. Commit everything except scratch files. Suggested message: `Fix autopilot replay/restart bugs, honest limit fills, late-candle settling; scalp setup type; daily caps off`.
4. Tell the user to **restart the engine server**. The running process predates these fixes.
5. Recommend running the engine somewhere that doesn't sleep, such as a small VPS. While the engine is off, open positions have no stop protection.

**Done when:** the branch is committed, tests are green, and the user has been told to restart.

---

## Step 1: Build the backtest harness (about 1 day)

### 1.1 What it is
A command-line tool, `npm run backtest -- [options]`, that:
1. Downloads historical klines from Binance and caches them in its own SQLite file.
2. Replays them through **the same `Engine` class and the same autopilot decision code** the live server uses.
3. Records every order, fill and exit.
4. Writes a report per setup × timeframe × side.

It's a new tool. The live server keeps working as it does today.

### 1.2 The prerequisite: make the autopilot decision reusable and time-correct
Today the autopilot's decision logic lives in `engine/src/main.ts` and mixes in live-only things:
- `scalpsFor()` reads `store.latest(...)`, which is "the newest candles", not "candles as of time T".
- `watchFor()` uses `Date.now()` and a 15m cache.
- `chartReading(symbol,'1h')` supplies `bias1h`.
- `universe`, `livePrices` and `broadcast` are server globals.

A backtest calling this code would see the future. So:

**Create `engine/src/strategy/scalpAutopilot.ts`** (pure, inside the purity-tested folders) exporting something like:

```ts
export interface ScalpDecisionInput {
  symbol: string;
  tf: '5m' | '15m';
  /** Closed candles of `tf` up to and including the candle that just closed, oldest first (enough for warm-up). */
  candles: Candle[];
  /** Closed 1h candles up to the same moment (for the 1h trend bias, pump/failed-break warnings, ADR). */
  candles1h: Candle[];
  /** BTC 1h candles up to the same moment (for the "BTC dumping" guard). */
  btc1h: Candle[];
  sessionOpens: number[];            // London/NY open times in range (from SessionCalendar)
  costPct: number;                   // round-trip cost for this coin's speed group
  now: number;                       // the close time of the candle that just closed
  config: EngineConfig['scalp_autopilot'];
}
export interface ScalpOrder {
  symbol: string; side: Direction; kind: ScalpKind; tf: '5m' | '15m';
  limitPrice: number; stop: number; target: number;
  maxHoldMin: number; entryTimeoutMin: number; note: string;
}
/** The order the autopilot would place for the candle that just closed, or null with the reason. */
export function decideScalp(i: ScalpDecisionInput): { order: ScalpOrder | null; skipped?: string };
```

Move into it, unchanged in meaning: the setup search (`findScalps` filtered to `status==='open' && time===lastCandle.openTime && withTrend`), the trap and warning checks (`watchCoin` plus the BTC-dumping and ADR checks from `watchFor`), and the limit-price rule (`min/max(keyLevel, entry)`). It must take `now` instead of `Date.now()`. `timingWarnings` and the session windows also need `now` passed in.

Then **make `main.ts: runQuantAutopilot` a thin wrapper**: build the input from the store, call `decideScalp`, and send the `open` command. Keep the live-only guards in `main.ts` (`autopilotCandles`, `currentHeld`, `broadcast`).

**Acceptance:**
- A test feeding a fixed candle fixture through `decideScalp` gives the same order the old `main.ts` path gave for the same data.
- `main.ts` no longer contains the decision logic.
- The purity test covers the new file.

> ⚠️ **Watch for `withTrend` lookahead.** `bias1h` must come from 1h candles **closed at or before `now`**, never the latest stored ones. The same goes for every 1h-derived warning.

### 1.3 Historical data (`engine/tools/backtest/data.ts`)
- Reuse `BinancePublic.klinesRange(symbol, tf, from, to)` (`engine/src/feed/binancePublic.ts`). It already handles 429 and 418 and backoff.
- Store candles with `CandleStore` (`engine/src/feed/candleStore.ts`) in **`data/backtest/candles.db`**, never `engine.db`. Download only what's missing, so later runs are instant.
- Timeframes: 1m, 5m, 15m, 1h, 4h. Also download about 30 days **before** `--from` as warm-up (EMA200 on 4h needs it, and so do the 500-candle analysis windows in `config.feed.history`).
- Expect about 6.5M 1m rows for 25 coins over 6 months. That's fine for SQLite.
- Symbol rules (step size, minimum notional): take the current values from `perpetualSymbols()`. That's acceptable for a backtest.
- Funding: optionally fetch `/fapi/v1/fundingRate` history and call `engine.onFunding(symbol, rate)` at each funding time. If you skip it, say so in the report.

### 1.4 The runner (`engine/tools/backtest/run.ts`)
For each run:
1. `loadConfig()`, then apply `--set key=value` overrides (see 1.6). Construct `new Engine({ config, configHash, engineVersion: 'backtest' })`.
2. Seed warm-up history with `engine.seedHistory(candles before --from)`.
3. `engine.setUniverse(symbols)` and `engine.setSymbolRules(...)`.
4. Stream candles from `--from` to `--to` **in engine order** (`compareCandles` from `shared/types.ts`), grouped by close time, with `engine.onCandles(group)` per close time. Process in memory: never load all 1m candles at once; stream per day.
5. After each group, for each 5m or 15m candle in it that belongs to a backtest symbol, call `decideScalp(...)` with candles **as of that close**. Keep rolling windows per symbol and timeframe; don't re-query SQLite for every candle. If it returns an order and the symbol has no open position or pending order, send `engine.onCommand({ type:'open', ..., orderType:'limit', setup:'scalp', time: candle.closeTime, ... })`. Catch `CommandError` and count rejections by reason.
6. Record which `positionId` came from which `kind` and `tf`. Position ids are `scalp-${symbol}-${time}`, so keep a map from the order you placed. `ClosedTradeView` has `setup` but not the scalp kind.
7. At the end, collect `engine.closedTrades()`, the signals (`engine.takeSignals()`, cleared regularly) and the shadow results.

**Performance note:** `findScalps` recomputes indicators over the whole window on every call. A naive run (about 52k 5m closes × 25 coins) may be slow. Acceptable fixes:
- (a) Pass only the last N≈360 candles, as live does.
- (b) Precompute setups once per symbol over the full history (detection at candle *i* uses only data ≤ *i*: pivots need `confirmedAt < i`, and the EMA, ATR and daily VWAP are causal), **with the 1h bias computed as of each candle**. Then look them up by time.

If you choose (b), **add a test proving the precomputed setups equal the per-candle results** on a sample.

> Backtest fills happen only on 1m candles. The live path also uses 2-second live prices, so live stop fills can be slightly better or worse. That's expected; mention it in the report.

### 1.5 The report (`engine/tools/backtest/report.ts`)
Write `data/backtest/reports/<timestamp>-<label>.json` and `.md`. Columns per **setup × tf × side**, plus each engine model, plus a total:

| Metric | Definition |
|---|---|
| Orders placed / filled / fill rate | Limit orders sent vs filled. A low fill rate with a high win rate is a warning sign. |
| Trades | Closed positions |
| Win % | pnl > 0 |
| Avg R, Total R | R = `pnl / riskUsd` (net of fees and funding; `riskUsd` is on each closed trade) |
| Profit factor | Gross wins / gross losses |
| Max drawdown % | On the equity curve (`engine.account().equity` sampled every 5 min) |
| Avg hold | Minutes |
| Exit reasons | Counts: stop / target / max_hold / … |
| Rejections | Counts by `CommandError` reason (`stop_too_wide`, `fees_too_high`, `filter_btc`, …) |

Also print an **in-sample vs out-of-sample** split (see Step 2) and a per-month Total R, so a single lucky month stands out.

### 1.6 CLI
Add to `package.json`: `"backtest": "tsx engine/tools/backtest/cli.ts"`. Options:

```
--from 2026-04-01 --to 2026-09-30
--symbols BTCUSDT,ETHUSDT,...        (default: a fixed list of ~25 liquid perps, see below)
--split 2026-08-01                   (trades before = in-sample, after = out-of-sample)
--models scalp,zone_sweep,session_sweep,htf_poi   (switch models on/off for the run)
--kinds sweep_reclaim,vwap_bounce,...             (scalp kinds to allow)
--set scalp_autopilot.max_stop_pct=1.5            (repeatable; any config key, validated by the schema)
--label baseline
```

**Coin list:** the live scanner picks coins from live 24h tickers, and a backtest can't reproduce that historically. Use a **fixed list of liquid perps** that existed for the whole window, such as BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, SUI, NEAR, APT, ARB, OP, INJ, TIA, SEI, WIF, PEPE, LTC, DOT, ATOM, FIL, RENDER and ENA. State in the report that this introduces **survivorship bias** (coins that died aren't in the list).

### 1.7 Tests for the harness
- The runner on a tiny synthetic dataset (a few hours, 1–2 symbols) gives a known trade with the right entry, exit and R.
- Same input twice gives the same report (determinism).
- No lookahead: corrupting candles **after** a signal's time must not change whether that signal was taken.

**Step 1 is done when:** `npm run backtest -- --from <6 months ago> --to <yesterday> --label baseline` finishes in a reasonable time (aim for under 15 minutes after the first download) and writes the report. All tests are green.

---

## Step 2: Measure the baseline (an afternoon)

1. Run the baseline over about 6 months with `--split` at roughly the two-thirds mark (for example, April–July in-sample and August–September out-of-sample).
2. Run each scalp kind on its own (`--kinds X`) and each engine model on its own.
3. Write `data/backtest/reports/BASELINE.md` summarising the result.

**Keep a setup only if:**
- It has **at least ~150 trades** in-sample (fewer is noise).
- Its **in-sample Avg R is above 0 after costs**, with profit factor above about 1.15.
- Its **out-of-sample Avg R is also above 0**. Don't adjust anything to make out-of-sample pass. If it fails there, it fails.
- No single month provides more than about 40% of its Total R.

Expect most of the 6 kinds × 2 timeframes × 2 sides (24 combinations) to fail. That's normal. **Testing 24 combinations means about 1 will look good by luck**, so require out-of-sample confirmation.

4. Set `scalp_autopilot` config so **only the surviving kinds and timeframes trade live**. This needs a new config key, for example `scalp_autopilot.kinds: [...]`, read by `decideScalp`. Add it to the schema and test it.

**Done when:** BASELINE.md exists, the survivors are listed, and live config allows only them. If nothing survives, say so plainly and stop the autopilot (`/api/control/quant-scalp-autopilot` with `enabled:false`). Don't keep a losing strategy running.

---

## Step 3: Improve the survivors, one change at a time (a few days)

**Tune on the in-sample period only.** Check out-of-sample **once**, at the end, for the final combination.

Make each idea configurable (new `scalp_autopilot.*` keys with defaults equal to today's behaviour, so live doesn't change until chosen). Run it with `--set`, and record the result in `data/backtest/reports/EXPERIMENTS.md` as a table: idea, setting, trades, Avg R, profit factor, max drawdown, keep or drop.

| # | Idea | Config sketch | Why |
|---|---|---|---|
| 1 | Skip the first N min after the London and NY opens | `skip_after_open_min: 0 \| 15 \| 30` | Live losses on 13 Oct all died in the 07:34–07:36 London-open whipsaw |
| 2 | Minimum stop relative to volatility | `min_stop_atr: 0 \| 0.5 \| 1.0` (on the setup's tf) | Very tight stops get swept by noise; fee drag also rises as stops shrink |
| 3 | Entry style | `entry: key_level \| close \| market` | The key-level limit may suffer adverse selection (only failing setups pull back that far). Measure it. |
| 4 | Trend filter strength | `trend: 1h \| 1h+4h` | Fewer trades, possibly better ones |
| 5 | Liquidity floor | `min_quote_volume_24h` per coin | Thin coins (DODOX, SAFE live) gap and slip |
| 6 | Target | `target_r: 1.5 \| 2 \| 3`, or partial at 1R plus a trail | The exit can matter as much as the entry |
| 7 | Max stop | `max_stop_pct: 1.2 \| 1.6 \| 2.2` | Stop width against noise |
| 8 | Time of day | Allowed UTC hours | Some setups only work in active sessions |

**Rules:**
- **One variable per run.** Combine winners only after each has proven itself alone.
- **Prefer simpler.** If two settings are within noise, keep the simpler one or today's.
- **Never re-tune after looking at out-of-sample.**

**Done when:** a final settings set is chosen, its out-of-sample result is recorded once, and the chosen values are written into `config.yaml` (with tests updated, such as `engine/tests/config.test.ts`, which pins key config values).

---

## Step 4: Forward-test on paper (2–4 weeks, mostly waiting)

1. Deploy the final config to the always-on paper engine.
2. Weekly, compare live paper results for each surviving setup with the backtest's expectations: win rate, Avg R, fill rate, and average slippage (actual stop exit vs stop level).
3. **Pass:** live Avg R is within roughly the backtest's range after 50 or more trades. **Fail:** much worse. Then find the gap (fills, slippage, data, latency) before going further.
4. Optional, but useful: add a "Backtest vs live" panel to the Results page.

---

## Step 5: Real capital, only after Step 4 passes

Out of scope until Step 4 passes. When the time comes:
- Add an execution adapter (`SimBroker` | `BinanceFuturesBroker`) behind the same `order_placed`/`order_filled` events.
- Place **exchange-side STOP_MARKET and TAKE_PROFIT_MARKET orders** on every fill, so a server crash can't leave a position unprotected.
- Reconcile engine state with exchange positions on startup.
- Start with a small amount, scale up only as live results keep matching, and keep the kill switch and daily loss limit.

---

## Backlog: known smaller issues (from `SYSTEM_AUDIT_REPORT.md`, not yet fixed)

Pick these up when convenient. None block Steps 1–3.

| Severity | Where | Issue |
|---|---|---|
| P2 | `engine.ts` `resume` | It resets `peakEquity`, so repeated pause/resume re-arms the 15% kill switch. Keep a lifetime peak too. |
| P2 | `main.ts` `reset_balance` | It accepts negative balances. Validate `balance > 0`. |
| P2 | `main.ts` `SCALP_COST_PCT` | A fixed 0.20%. Use `roundTripPct(costsFor(cfg, speed))` per coin; wild coins cost 0.40%. |
| P2 | `main.ts` `scalpsFor` / Scalp page stats | `withTrend` uses the *current* 1h bias for past setups (lookahead in the page's stats). Fixed for free if the page uses `decideScalp`-style as-of bias. |
| P2 | `main.ts` `announceWarnings` | Heavy synchronous work every 1m batch, and `ideaCache` is cleared globally. Throttle, cache per symbol, maybe move to a worker. |
| P2 | `filters.ts` fakeout / `exits.ts` `failed_breakout` | Never runs with the current config (pullback model off, `management: v3`). Wire it into active models or remove it. |
| P2 | `scanner.ts` `scanVolumeSurgeRunners` | `exclude` compares coin names with full symbols, so it never matches. Use `coinOf(symbol)`. Surge runners also skip the scanner's quality gates but enter the tradable universe. |
| P2 | `TakePosition.tsx` | Hard-coded 0.2% cost in the RR check; the server uses speed-group costs. |
| Arch | Feed | Switch to Binance WebSocket kline and mark-price streams, keeping REST for gap-fill. Lower latency, fewer requests. |
| Arch | Risk | Correlation control is only a "memes" group. In a BTC-led crash, all alt longs act as one position. Consider a cap on BTC-beta-weighted exposure, plus a "BTC moved X% in 5 min" halt on the live-price path. |

---

## Things not to do

- Don't judge a setup from fewer than about 150 trades, or from the dashboard's 24h Scalp stats. They're in-sample, mix timeframes and carry the `withTrend` lookahead.
- Don't tune parameters until the backtest looks great and then trust it. That's fitting the past. Out-of-sample decides.
- Don't loosen risk limits to "get more trades". More trades with no edge just loses faster.
- Don't write to `data/engine/engine.db` from the backtest.
- Don't break engine purity to make the backtest easier. The purity is what makes the backtest trustworthy.
