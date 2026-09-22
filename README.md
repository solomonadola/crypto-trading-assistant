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

- **The server is the source of truth.** Its trade list (in memory, mirrored
  to `data/worker-state.json`) is what every copy of the app shows, and every
  change goes through it: its own checks and the actions browsers send.
  - Browsers pull the list every 5 seconds from `GET /api/trades` (only the
    trades changed since their last pull, gzipped; paused while the tab is
    hidden), so every open page shows the same within seconds. They make no
    Firestore reads or writes while the server runs.
  - Manual deploy, close, recycle and exclude are sent to the server
    (`POST /api/deploy`, `/api/trades/:id/close`, `/api/trades/:id/exclude`),
    which applies them one at a time with its own checks, so an action can
    never be overwritten by a check running at the same moment.
- **Firestore is the server's backup, kept in step both ways.** Every trade
  carries a revision (`rev`): 1 when opened, +1 with every change that is
  saved (targets, stop moves, close, exclusion; price-only updates leave it).
  Every minute (`WORKER_FLUSH_MINUTES`) the server writes its queued changes
  (one write per changed trade), then asks Firestore for trades changed since
  the last check and compares revisions:
  - Firestore higher: the server is behind — it takes Firestore's version
  - server higher: the server is ahead — it writes its version
  - only in Firestore: taken; only on the server: written (full check only)
  Every trade is compared at startup from a saved state file and once a day.
  Open positions' prices are saved hourly; everything queued is written on
  shutdown. `POST /api/flush` runs a round now; `POST /api/resync` rebuilds
  the list from Firestore. A crash (not a normal shutdown) on a host whose
  disk is wiped loses at most the last minute of changes; the candle replay
  re-applies any stop or target crossed meanwhile.
  - To empty Firestore for a fresh start, do it with the server stopped:
    a running server would write back the trades it holds.
- **If the server is not reachable**, a browser shows the trades saved in
  Firebase and changes nothing ("Display only - no trading server" in the
  status strip); its buttons say so. Browsers trading on their own - a second
  trader beside the server - is what produced duplicate positions and more
  than 10 open. `VITE_BROWSER_TRADING=on` lets a browser trade without a
  server, for running with no server at all.
- **Misconfiguration is reported.** Every answer carries the server's
  instance id and build id. If two instances answer (Cloud Run maximum
  instances above 1, or an old revision still taking traffic) or the page and
  server come from different builds, the status strip says so. Unknown `/api`
  addresses answer with a JSON explanation rather than a bare 404, and an
  action refused that way is retried once (nothing was changed).
- **Following the hosted server from a local copy:** put
  `BACKEND_URL=https://your-app.run.app` in `.env.local` and restart
  `bun run dev`; the dev server forwards `/api` there, so the local copy
  shows the hosted list and its buttons act on it.
- **Restarts lose nothing** on hosts with a lasting disk: the state file
  holds the list, the queued changes and each open trade's `lastEvaluatedAt`,
  and missed candles are replayed from there.
- **It enforces the limits on what is already open.** On every check, a
  second position in the same coin, or anything over 10 open, is closed:
  the newest go (the oldest were opened legitimately), at their live price
  with the exit cost, marked `DUPLICATE_COIN_CLOSED` or `SLOT_LIMIT_CLOSED`.
  Browsers without the server only report such conflicts, as before; a
  browser acting on its own possibly stale list is what once closed real
  positions at $0.
- **It never trades blind.** Without a list (a first start while Firestore
  is unavailable) it waits; it also skips checks when prices are more than
  two minutes old.
- **Settings:** `TRADING_WORKER=off` serves the app without the worker;
  `WORKER_AUTOPILOT=off` makes auto-pilot start off (the switch in the app
  changes it, and the choice survives restarts); `WORKER_FLUSH_MINUTES`;
  `WORKER_STATE_FILE` (`off` to keep no file). A read-only copy
  (`VITE_FIRESTORE_WRITES=off`, also read from `.env.local`) never starts it.
- **Endpoints:** `GET /api/status` (worker state, `sync` section with queued
  changes and the last Firestore save, recent log), `GET /api/trades`,
  `GET /api/tick`, `POST /api/autopilot`, `/api/deploy`, `/api/trades/:id/close`,
  `/api/trades/:id/exclude`, `/api/flush` (save to Firestore now),
  `/api/resync`. The POST endpoints are same-origin only and unauthenticated.

**Hosting.** The worker needs a process that stays running:

- *VPS / any always-on machine:* `bun run build && bun run start` (e.g. under
  systemd or pm2). `PORT` sets the port. The JSON file survives restarts.
- *Cloud Run (how AI Studio deploys):* by default an instance only gets CPU
  while it is answering a request and is shut down when idle, so the 30s loop
  stalls, and its disk is temporary, so the JSON file lasts only until the
  instance restarts. Either set **minimum instances = 1** with **CPU always allocated**,
  or have an uptime pinger request `/api/tick` regularly (see the note on
  pinger intervals below). Set **maximum instances = 1** either way: two
  instances would be two workers trading the same account. After deploying,
  open `/api/status` on the hosted URL — `workerRunning: true` and a
  `tickAgeMs` under 60000 mean it is trading.
- *Static hosting only* (no Node server): there is no worker; the app trades
  while a tab is open, as before.

Only one worker should run against the database. `bun run dev` never starts
one; do not leave `bun run start` running locally while a hosted worker is
live unless `.env.local` has `VITE_FIRESTORE_WRITES=off`.

Pinger intervals: browsers treat the server as in charge only if it checked
in the last 2 minutes. With a pinger slower than that, browsers will take
over trading between pings - use minimum instances = 1 instead, or a pinger
every minute.

No environment variables are required. `.env.example` lists `GEMINI_API_KEY`
and `APP_URL` from the AI Studio template; nothing in `src/` reads them.

---

## How it trades

All tunables live in `src/config/`. The values below are the current defaults.

### Market data

- **Universe** — `src/config/universe.ts`: the **40 Binance USDT pairs with
  the most 24-hour trading volume**, taken from the same ticker data as the
  prices (no extra requests) and re-chosen once a day; the list is saved so a
  reload or restart keeps it. Stablecoins, wrapped coins, tokenised gold and
  apparent stock tokens are left out (`UNIVERSE_EXCLUDED`). Coins without
  known details get a plain name and lettered logo. `mode: 'fixed'` switches
  back to the old hardcoded 36 (`TOP_ASSETS` in `binanceService.ts`).
  - Meme coins share the 2-position cap only if they are in `MEME_COINS`
    (`src/types/entryScanner.ts`); new memes that reach the list must be
    added there.
  - The replay studies (`STUDY_A_RESULTS.md`, `tools/`) were run on the fixed
    36. Their findings do not carry over automatically to a volume-ranked list,
    which takes in newer, more volatile listings.
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
  browser, a server start) and every 6 hours (to catch deletions, and
  changes saved by copies still on older code, which do not stamp
  `updatedAt`). A reload within those 6 hours reads nothing up front.
- Anything that edits trades outside the app must set `updatedAt`, or copies
  only see the change at their next full read.
- **Once a minute each page counts the trades in Firestore** (1 read per
  1,000 trades) and re-reads everything if the count differs from what it
  holds. The changes-only listener cannot see deletions; this catches them,
  and anything else missed, within a minute.

Expected use at about 70 trades a day, with the 24/7 server running (browsers
then use no Firestore at all; the server is the only reader and writer):

| | per day | free limit |
|---|---|---|
| Writes: one per changed trade, saved every minute (opens, exit-ladder events, closes, exclusions) | ~250 | 20,000 |
| Writes: hourly save of open trades' prices (~10 open) | ~240 | |
| Reads: the minute-by-minute check (the server's own writes read back, plus any made elsewhere) | ~500 | 50,000 |
| Reads: daily full comparison, and a start from the state file | 1 per trade stored, each time | |
| Reads: start without the state file, or `/api/resync` | 1 per trade stored | |

Without the server (browsers trading themselves) each browser tab uses about
1,700 reads a day, as described above.

Storage is about 3 KB per trade, around 6 MB a month. Usage is shown in the
Firebase console under Firestore > Usage. If the read quota is spent, the
server carries on from its own list, and its writes (a separate allowance)
still go out; browsers without a server keep working from their saved list
and queue their writes until the quota resets (midnight Pacific).

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
node tools/test-universe.mjs                 # volume-ranked coin list
npm run build && node tools/test-server-e2e.mjs  # the real server over HTTP: open/close from the web, saves, restart
node tools/diagnose-trades.mjs trades.json   # find corrupt records in an exported feed
```

To export your trade history for `diagnose-trades`, run this in the app's
browser console and paste the result into a file:

```js
copy(localStorage.getItem('crypto_automated_trades_local_fallback'))
```
