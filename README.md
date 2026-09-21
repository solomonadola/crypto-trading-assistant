# CryptoStudyLab

A browser-based **paper-trading lab** for crypto. It scans a fixed list of
Binance USDT pairs, opens simulated positions when its scanner fires, manages
them with a tiered exit ladder, and reports performance. No real orders are
ever placed.

Its purpose is to test whether a trading idea makes money **after costs**, not
to trade. See [Status](#status) before drawing conclusions from its numbers.

---

## Running it

```bash
bun install          # or npm install
bun run dev          # http://localhost:3000
bun run lint         # type check (tsc --noEmit)
```

No environment variables are required. `.env.example` lists `GEMINI_API_KEY`
and `APP_URL` from the AI Studio template; nothing in `src/` reads them.

---

## How it trades

All tunables live in `src/config/`. The values below are the current defaults.

### Market data

- **Universe:** 36 hardcoded USDT pairs in `src/services/binanceService.ts`.
  Pairs with no live Binance spot ticker (currently FTM, KAS and POPCAT) are
  skipped rather than scanned at a stale price.
- **Feed:** Binance `/api/v3/ticker/24hr` (global spot, via
  `data-api.binance.vision` or `api.binance.com`), refreshed every 30 seconds.
  Binance.US is deliberately *not* used as a fallback: it is a different
  exchange with different prices. Candles are fetched only to replay time the
  app was closed.
- **Indicators:** every indicator the scanner shows (EMAs, MA7, RSI, ATR,
  Bollinger, order-flow, 1H/15m/5m reads) is derived from that one 24-hour
  snapshot. They are approximations, not values computed from real candles.
  `AUDIT.md` section 2 shows they reduce almost entirely to the 24-hour
  percent change.

### Entries — `src/config/autopilot.ts`

Auto-pilot checks for entries every 10 seconds and deploys when all of these hold:

- Scanner score **≥ 75** with status TRIGGERED, FORMING or STAGING
- Multi-timeframe grade not C or DISQUALIFIED, at least 2 of 4 timeframes aligned
- **Long only** — shorts are disabled (`allowShorts: false`); they lost money in
  both test samples
- **Market-regime gates pass** (`enforceRegimeGates: true`):
  - *Consolidation lock* — no entries when average 24h movement across the
    universe is under 2%, or 2 or fewer coins are moving 3%+
  - *BTC armor* — no entries when BTC is down more than 6.5% in 24 hours.
    Separately, the scanner downgrades altcoin longs whenever BTC is down
    more than 1.5% or looks weak, requiring a 90+ score to trigger
  - *Loss-streak breaker* — 2 losing trades within 2 hours pauses entries for
    60 minutes
- **At most one deploy per fresh price snapshot, and one every 2 minutes**

Position limits: 10 open positions, one per coin, at most 3 majors
(BTC/ETH/BNB/SOL) and 2 memes. A coin closed within the last 20 minutes is
skipped by auto-pilot (manual deploys ignore this).

### Exits — `src/config/geometry.ts`

Everything is expressed in **R**, where 1R is the stop distance.

| Stage | Trigger | Action |
|---|---|---|
| Entry | — | Stop at **1.5 × ATR** below entry (bounded 1.5%–15%) |
| Tier 1 | **+1R** | Bank 33%. Stop moves to entry **+0.1R** |
| Tier 2 | **+2R** | Bank 33%. Stop moves to the Tier 1 price |
| Tier 3 | **+3.5R** | Bank 17%. Remaining 17% trails 4% below the session high (2.5% once the trade is up 20%, 1.8% once up 35%), never below the Tier 2 price |

Because the stop scales with each coin's volatility, a quiet coin gets a tight
stop and a volatile one a wide stop. If a price gaps past a tier it is banked
at the better price, capped at 3× the tier target so a bad price tick cannot
bank an absurd gain.

A position flat to within ±0.8% after 24 hours without reaching Tier 1 is
closed to free the slot.

### Sizing

- **Risk-based:** each trade is sized so that hitting its stop loses **0.4% of
  equity**, whatever the stop distance.
- **Capped** at the slot size (equity ÷ 10, minimum $5), so a tight stop never
  takes an oversized position.
- Equity compounds: slot size tracks the current portfolio value.

### Costs — `src/config/costs.ts`

Every fill pays **15 bps per side** (10 fee + 2 half-spread + 3 slippage),
charged on the fraction actually traded. A full round trip is 30 bps. Costs
accumulate in each trade's `totalFeesUSD`.

---

## How performance is measured

All statistics use the definitions in `src/services/metrics.ts`:

- `pnlUSD` on a trade is **gross**. `totalFeesUSD` holds **all** its costs.
- Every figure shown is on **net = pnlUSD − totalFeesUSD**.
- A trade is a **win** if net > $0.01, a **loss** if net < −$0.01, otherwise a
  **scratch**. Win rate = wins ÷ closed trades.
- Profit factor and payoff ratio show **∞** when there are no losing trades.
- Max drawdown is measured on realized net equity from its running peak.
- Portfolio value, cash and profit are **calculated from the trade list**, not
  stored — so they cannot drift out of sync with the trades.

`node tools/test-metrics.mjs` checks all of this against trades with
hand-computed answers.

---

## Data health

The **Cloud Database** tab checks every trade record and lists any that cannot be
right (profit far larger than the price move allows, more banked than the exit
ladder can bank, a more-than-3x price jump) or that were not produced by the
market. A record can be **excluded from statistics**: it stays in the history
but no longer counts toward P&L, win rate or any other figure. If any such
record is still counted, the status strip links to it.

## Storage

Trades and settings are saved in the browser's **localStorage**. They survive
closing the tab or browser, but exist only in that browser, and clearing site
data deletes them.

Trades are also written to and read from **Firestore**, so every browser
running the app (local and hosted) shares one trade history. Reads can be slow
to start; the status strip shows whether Firestore has actually answered.

> **Every copy of the app shares the production database**, including a local
> dev server. For development or testing, put `VITE_FIRESTORE_WRITES=off` in
> `.env.local`: the app still loads the shared history, but everything it does
> stays in that browser. The status strip shows "Firebase read-only" when it
> is set.

Positions are never closed automatically for exceeding the slot limits. If two
browsers open trades at the same moment and push the count over 10 (or open
the same coin twice), the conflict is logged and new entries are blocked until
positions close on their own stops and targets. (The old behaviour closed the
older position at the current price with $0 P&L; it had done so 18 times.)

> `firestore.rules` in this repo is **more permissive** than the rules actually
> deployed. Do not run `firebase deploy --only firestore:rules` without
> reviewing it first — it would replace the stricter live rules.

---

## Status

**Nothing runs while the app is closed.** Prices, stops and targets are only
checked while the tab is open and in the foreground. On reopening, each open
position is evaluated once at the current price; whatever happened in between
is missed. Paper results therefore depend on when the app was open.

**The strategy has not shown an edge.** Replaying the real scanner over
6 months (and checking against 24 more) found that its entries do not beat the
market by more than trading costs. Wider, volatility-scaled exits roughly halve
the rate of loss but do not make it profitable. Details:

| Document | Contents |
|---|---|
| `AUDIT.md` | Full review of the original system and why it exited so quickly |
| `STUDY_A_RESULTS.md` | Replay results: entry edge, score, exit geometry, out-of-sample checks |
| `QUANT_BRIEF.md` | Short summary for review by a quant or trading engineer |

---

## Research tools — `tools/`

These run the app's real scanner and exit logic offline against historical
Binance data. Market data (~1.5 GB) is downloaded on demand and gitignored.

```bash
node tools/build-scanner.mjs                 # bundle the real scanner (re-run after changing it)
node tools/fetch-klines.mjs --months 6       # download 5m candles
node tools/replay.mjs                        # every entry auto-pilot would have taken
node tools/study-a.mjs                       # do entries beat the market?
node tools/study-score.mjs                   # does a higher score mean better trades?
node tools/study-residual.mjs                # beta-neutral / longer-horizon variants
node tools/sim-exits.mjs                     # old vs current exit geometry
node tools/test-metrics.mjs                  # metric accuracy check
node tools/test-catchup.mjs                  # replay of time spent away
node tools/test-data-safety.mjs              # no forced closes; read-only switch; data health rules
node tools/test-network.mjs                  # a stalled Binance response cannot hang the refresh
node tools/diagnose-trades.mjs trades.json   # find corrupt records in an exported feed
```

To export your trade history for `diagnose-trades`, run this in the app's
browser console and paste the result into a file:

```js
copy(localStorage.getItem('crypto_automated_trades_local_fallback'))
```
