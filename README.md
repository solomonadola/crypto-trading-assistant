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
bun run dev          # http://localhost:3000 - the app only; trades while the tab is open
bun run build        # builds the app (dist/) and the server (server.js)
bun run start        # http://localhost:3000 - app + 24/7 trading worker
bun run lint         # type check (tsc --noEmit)
```

### 24/7 trading — `server.ts`, `src/worker/tradingWorker.ts`

A web page cannot run while every browser is closed, so trading around the
clock needs a server. `bun run start` serves the app and runs a worker that
does, every 30 seconds, what an open tab does: fetch prices, replay any time
it missed, check stops and targets, and run the auto-pilot with the same
decision code as the browser (`src/services/autopilotEngine.ts`).

- **Browsers step aside and follow the server.** A browser that finds a
  worker that has completed a tick in the last two minutes only displays: it
  does not evaluate trades or open new ones, so there is one trader. It shows
  the server's own list, pulled every 30 seconds from `GET /api/trades`
  (only the trades changed since its last pull, gzipped), and makes no
  Firestore reads — so every copy shows the same data even while the
  Firestore quota is spent. If the worker stops ticking, browsers switch back
  to Firestore and trade themselves within about 20 seconds.
- **Which server:** the one the page came from, or the URL in
  `VITE_TRADING_SERVER_URL` (e.g. a local dev server following the hosted
  app; see `.env.example`). The status strip shows "24/7 Server Active".
  Manual deploys and exclusions from a browser still go to Firestore, so the
  server only sees them once Firestore can be read.
- **Restarts lose nothing.** Every open trade carries `lastEvaluatedAt`, saved
  with it to Firestore at each exit-ladder event and every 10 minutes. After a
  restart or a sleep, the worker replays each trade's candles from exactly
  there.
- **It keeps a JSON copy on disk** (`data/worker-state.json`, or
  `WORKER_STATE_FILE`; `off` to disable): the trade list, sync position and
  queued writes, saved within 2 seconds of any change. A restart resumes from
  it with a changes-only sync instead of re-reading the whole history.
- **It keeps trading when Firebase cannot be read** (daily quota spent,
  outage), from a list Firebase has confirmed before — this run or the saved
  file — since it is the only writer while it runs. Stops and targets are
  still enforced; writes are queued and sent when Firebase is back.
- **It never trades blind.** With no confirmed list (a first start while
  Firebase is down) it waits; it also skips ticks when prices are more than
  two minutes old.
- **Settings:** `TRADING_WORKER=off` serves the app without the worker;
  `WORKER_AUTOPILOT=off` manages open trades but opens no new ones. A
  read-only copy (`VITE_FIRESTORE_WRITES=off`, also read from `.env.local`)
  never starts it.
- **Endpoints:** `GET /api/status` (worker state and recent log),
  `GET /api/trades?since=&boot=` (the trade list, or changes since a pull),
  `GET /api/tick` (run a tick now), `POST /api/autopilot` `{"enabled": bool}`.
  `/api/autopilot` is unauthenticated and its setting resets on restart.

**Hosting.** The worker needs a process that stays running:

- *VPS / any always-on machine:* `bun run build && bun run start` (e.g. under
  systemd or pm2). `PORT` sets the port. The JSON file survives restarts.
- *Cloud Run (how AI Studio deploys):* by default an instance only gets CPU
  while it is answering a request and is shut down when idle, so the 30s loop
  stalls, and its disk is temporary, so the JSON file lasts only until the
  instance restarts. Either set **minimum instances = 1** with **CPU always allocated**,
  or have a free uptime pinger (UptimeRobot, Cloud Scheduler) request
  `/api/tick` every minute. Set **maximum instances = 1** either way: two
  instances would be two workers trading the same account. After deploying,
  open `/api/status` on the hosted URL — `workerRunning: true` and a
  `tickAgeMs` under 60000 mean it is trading.
- *Static hosting only* (no Node server): there is no worker; the app trades
  while a tab is open, as before.

Only one worker should run against the database. `bun run dev` never starts
one; do not leave `bun run start` running locally while a hosted worker is
live unless `.env.local` has `VITE_FIRESTORE_WRITES=off`.

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
running the app (local and hosted) shares one trade history. **Firestore is the
record; the browser's saved copy is only a working cache of it:**

- Nothing is evaluated or opened until Firestore has delivered the list
  (or is known to be failing, or has not answered in 20 seconds).
- Each update from Firestore replaces the saved copy, keeping only a close not
  yet written and fresher prices on open trades. A correction made anywhere
  reaches every browser; a trade that never reached Firestore disappears.
- A save that fails is queued and retried on the next update or refresh,
  rather than living in one browser.
- Before opening a trade, the open positions are read from Firestore itself,
  so the 10-position, one-per-coin and 3-major limits hold across every
  browser and the worker. (Two copies opening in the same second can still
  both pass; the worker plus stand-down browsers keeps that to one writer.) Reads can be slow
to start; the status strip shows whether Firestore has actually answered.

### Firebase free tier

The free tier allows 50,000 reads, 20,000 writes and 1 GiB of storage a day,
for **one database per project** (the first one created). Every document a
query returns counts as a read, so the app reads the history as little as
possible:

- **One listener per copy**, shared by every view, asking only for trades
  changed since the last sync (each write stamps `updatedAt` with the
  server's clock).
- **The whole history is read** only by a copy with nothing saved (a new
  browser, a server start) and once a week (to catch deletions). A reload or
  reopening reads nothing up front.
- Anything that edits trades outside the app must set `updatedAt`, or copies
  only see the change at their weekly full read.

Expected use at about 70 trades a day with the worker running:

| | per day | free limit |
|---|---|---|
| Writes: opens, exit-ladder events, 10-minute checkpoints of ~10 open trades | ~1,700 | 20,000 |
| Reads: worker listener + open-slot check before each deploy | ~2,400 | |
| Reads: each browser tab left open all day | ~1,700 | |
| Reads: each full history read (server start, new browser, weekly) | 1 per trade stored (341 now, ~2,000 more a month) | |
| **Typical total** (worker + two open tabs, no restarts) | **~6,000** | 50,000 |

Storage is about 3 KB per trade, around 6 MB a month. Usage is shown in the
Firebase console under Firestore > Usage. If the quota is reached, browsers
keep working from their saved list and the 24/7 worker from its JSON file;
both queue their writes and send them once Firebase is readable again (the
quota resets at midnight Pacific). Browsers cannot see the worker's changes
until then.

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

**Without the server, nothing runs while the app is closed.** Served by
`bun run start` on an always-on host, the worker trades 24/7 (see above).
Served any other way, prices, stops and targets are checked only while a tab
is open; on return, the candles missed are replayed.

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
node tools/test-trading-worker.mjs           # 24/7 worker: no blind trading, restart replay, Firestore merge
node tools/diagnose-trades.mjs trades.json   # find corrupt records in an exported feed
```

To export your trade history for `diagnose-trades`, run this in the app's
browser console and paste the result into a file:

```js
copy(localStorage.getItem('crypto_automated_trades_local_fallback'))
```
