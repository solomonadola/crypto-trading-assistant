# PerpPilot

A simulated crypto futures trading engine with three strategy modes:

| Mode | How it works | Config |
|---|---|---|
| **Institutional (HTF pullback)** | Engine scans coins, arms setups on the 1H chart, waits for a 15M CHoCH confirmation, then opens a simulated trade with a stop, target, and profit ladder. Fully automatic. | `pullback`, `exits`, `allocation` in `config.yaml` |
| **Hunter (scalp autopilot)** | Places limit orders at key levels on 5M/15M scalp setups. Automatic while switched on from the Hunter page. | `scalp_autopilot` in `config.yaml` |
| **Manual trades** | You open and manage trades from the dashboard or via API. Same risk rules apply. | `POST /api/positions/open` |

It reads **Binance USDⓈ-M public market data** — no account, no API keys needed.
All trades are simulated with fees, slippage, and funding.

The full design is in [ENGINE_PLAN.md](ENGINE_PLAN.md).

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Running Tests](#running-tests)
- [Testing with Sample Data](#testing-with-sample-data)
- [Backtest CLI](#backtest-cli)
- [Dashboard Pages](#dashboard-pages)
- [API Reference](#api-reference)
- [Trade Journal (ATA Post-Mortem)](#trade-journal-ata-post-mortem)
- [BTC Circuit Breaker](#btc-circuit-breaker)
- [4H Dealing Range Radar](#4h-dealing-range-radar)
- [n8n Integration](#n8n-integration)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Production / AI Studio](#production--ai-studio)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js** ≥ 22 (tested on v24)
- **npm** ≥ 10
- **Internet** for live market data (Binance public endpoints)
- **Docker** (optional, only for n8n)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start in dev mode (engine + dashboard)
npm run dev
```

Open **http://localhost:3009** in your browser.

The terminal prints `[feed] live` once the engine is running and receiving
candles. `[signal]` lines appear at 15-minute closes when setups arm, confirm,
or get filtered.

> **First start** takes under a minute: the scanner picks coins, then their
> candle history loads from Binance.

---

## Project Structure

| Path | What |
|---|---|
| `engine/config/config.yaml` | Every setting: sessions, scanner, setup, filters, risk, costs. Validated on load; a misspelled key stops the engine. |
| `engine/src/core/engine.ts` | The engine core. Its only clock is the close time of the candles it is given. |
| `engine/src/main.ts` | Express server: all API routes, Hunter (the scalp autopilot), live feed wiring. |
| `engine/src/sessions.ts` | Session calendar (Asia, London, New York), entry windows, session-end exits. |
| `engine/src/analysis/` | Indicators, market structure, trend states, supply/demand zones, FVGs, volume profile. |
| `engine/src/strategy/pullback.ts` | Pullback setup: arming on 1H, 15M confirmation, trade plan. |
| `engine/src/filters.ts`, `scoring.ts` | Filters (chop, fakeout, stagnation, etc.) and confluence scoring. |
| `engine/src/feed/` | Binance public client, live and replay candle feeds, candle store. |
| `engine/src/storage/` | SQLite: append-only trade log, signals, trade journal. |
| `engine/tests/` | 30 test files, 408 tests. |
| `src/` | React dashboard (Vite + Tailwind). |
| `src/pages/` | Dashboard pages: Overview, Market, Trades, Signals, Scalp, Ideas, Chart, FilterLab. |
| `data/engine/engine.db` | SQLite database (delete it to start fresh). |

---

## Running Tests

```bash
# Run all 408 tests (engine logic, storage, indicators, backtest, etc.)
npm test

# Type check (no emit)
npm run lint

# Both (recommended before committing)
npm test && npm run lint
```

### Key test files

| Test file | What it covers |
|---|---|
| `engine/tests/engine.test.ts` | Core engine: manual trades, limits, scalps, BTC circuit breaker, exits, editing |
| `engine/tests/storage.test.ts` | SQLite storage including trade journal CRUD |
| `engine/tests/purity.test.ts` | Engine core must stay free of side-effects (no I/O, no Date.now) |
| `engine/tests/backtest.test.ts` | Backtest harness determinism and report generation |
| `engine/tests/autopilot.test.ts` | Scalp autopilot candle filtering, settled prices |
| `engine/tests/analysis.test.ts` | Market structure, trend detection |
| `engine/tests/htfPoi.test.ts` | 4H dealing range POI calculations |

---

## Testing with Sample Data

### 1. Start the engine and let it collect data

```bash
npm run dev
```

Wait ~1 minute until you see `[feed] live`. The engine will:
- Scan the top Binance futures coins by volume
- Download 14+ days of candle history for each
- Start watching 15-minute closes for setups

### 2. See what it's doing

Open these in your browser (or `curl`):

```bash
# Engine status (clock, session, feed state)
curl http://localhost:3009/api/status | jq

# Which coins are selected and why others were dropped
curl http://localhost:3009/api/scanner | jq

# Currently armed setups (waiting for 15M confirmation)
curl http://localhost:3009/api/armed | jq

# Market overview with HTF POI data (Dealing Range Radar)
curl http://localhost:3009/api/market | jq

# Account balance and equity
curl http://localhost:3009/api/account | jq
```

### 3. Open a manual trade (test the manual trading flow)

```bash
# Open a long on BTCUSDT with stop and target
curl -X POST http://localhost:3009/api/positions/open \
  -H 'Content-Type: application/json' \
  -d '{
    "symbol": "BTCUSDT",
    "side": "long",
    "stop": 60000,
    "target": 75000,
    "note": "Testing manual trade entry"
  }'
```

The engine will:
- Size the position so the loss at the stop = 1% of equity
- Apply slippage and taker fees
- Start managing it: stop-loss, take-profit, break-even after BOS, max hold

```bash
# See open trades
curl http://localhost:3009/api/trades | jq

# Modify stop/target on a trade (or limit price/stop/target on a pending order)
curl -X POST http://localhost:3009/api/positions/<trade-id>/modify \
  -H 'Content-Type: application/json' \
  -d '{ "stop": 61000, "target": 74000 }'

# Cancel a pending limit order
curl -X POST http://localhost:3009/api/positions/<order-id>/cancel

# Close an open trade at market
curl -X POST http://localhost:3009/api/positions/<trade-id>/close \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### 4. Test the Trade Journal

After closing a trade, journal it:

```bash
# List all journal entries
curl http://localhost:3009/api/journal | jq

# Get a specific trade's journal
curl http://localhost:3009/api/journal/<trade-id> | jq

# Save a journal entry (ATA Level 5 reflection)
curl -X POST http://localhost:3009/api/journal/<trade-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "reflection": {
      "setup_followed": true,
      "entry_quality": 4,
      "exit_quality": 3,
      "emotion": "calm",
      "lesson": "Waited for confirmation before entering",
      "htf_aligned": true,
      "premium_discount": "discount",
      "liquidity_taken": true,
      "bias_correct": true,
      "invalidation_clear": true
    }
  }'
```

Or use the dashboard: go to **Trades** → click "Journal" on any closed trade.

### 5. Test the BTC Circuit Breaker

The circuit breaker activates when BTC drops ≥ 1.5% in 5 minutes:

```bash
# Check if circuit breaker is active
curl http://localhost:3009/api/account | jq '.circuitBreaker'
```

In the unit tests, you can see exactly how it works:

```bash
npm test -- engine/tests/engine.test.ts -t "circuit breaker"
```

When active, the dashboard shows an animated red warning banner on the Overview page.

### 6. View the 4H Dealing Range Radar

Open the dashboard → **Overview** page. Each coin card shows:
- Current dealing range (high/low)
- Premium / Discount zone
- Key POIs: Order Blocks, FVGs, Breaker Blocks
- Where price is relative to the range

Or via API:

```bash
# All coins with HTF POI data
curl http://localhost:3009/api/market | jq '.[0].htfPoi'

# Detailed HTF analysis for a specific coin
curl http://localhost:3009/api/htf/BTCUSDT | jq
```

### 7. Test Hunter (the scalp autopilot)

Turn Hunter on or off with **Engage Hunter** on the Hunter page. Your choice is
saved and survives restarts; `scalp_autopilot.enabled` in `config.yaml` is only
the default before you first use the switch. `scalp_autopilot.kinds` lists the
setups it may take (an empty list means it never places an order).

The **Hunter activity** card on that page lists what it did: orders placed, and
setups it passed on or the engine refused, with the reason. Most scalps are
refused as `fees too high` while `allocation.max_fee_drag_pct` is 15: tight 5m
stops leave little room after costs.

To test its logic:

```bash
# Check Hunter's status
curl http://localhost:3009/api/quant-scalp/autopilot | jq

# View current scalp setups
curl http://localhost:3009/api/scalp | jq

# Run the scalp-specific tests
npm test -- engine/tests/scalpAutopilot.test.ts
npm test -- engine/tests/scalp.test.ts
```

---

## Backtest CLI

Run historical simulations:

```bash
# Default backtest (downloads data if needed)
npm run backtest

# Specific symbols and date range
npm run backtest -- --symbols BTCUSDT,ETHUSDT --from 2025-01-01 --to 2025-06-30

# Skip downloading (use cached data)
npm run backtest -- --skip-download

# Override config values for the run
npm run backtest -- --set "exits.min_rr=3.0" --set "scoring.min_score=5"
```

Reports are written to `data/backtest/` with metrics: win rate, profit factor, max drawdown, Sharpe ratio, and per-trade breakdowns.

---

## Dashboard Pages

| Page | What you see |
|---|---|
| **Overview** | Account equity, open trades, armed setups, BTC circuit breaker banner, dealing range radar cards |
| **Market** | All scanned coins with trend, volume, key levels, HTF POI data |
| **Trades** | Trade history table with P&L, setup type (pullback/scalp/manual), **Journal** button for each closed trade |
| **Signals** | Every signal the engine generated with reasoning, filtering, and scoring |
| **Hunter** | Scalp setups across timeframes, and the switch for Hunter (the scalp autopilot) |
| **Ideas** | Trade ideas and analysis per coin |
| **Chart** | Interactive chart with zones, FVGs, structure |
| **FilterLab** | Experiment with filter settings |

---

## API Reference

### Status & Health

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Health check (returns `{ ok: true }`) |
| GET | `/api/status` | Engine clock, feed state, current session, entry window |
| GET | `/api/auth/config` | Firebase auth config for the dashboard |
| GET | `/api/stream` | SSE stream of real-time events |

### Market Data

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/scanner` | Coins selected by the scanner, and why others were dropped |
| GET | `/api/market` | All coins with price, trend, volume, HTF POI data |
| GET | `/api/candles/:symbol` | Stored candles (`?tf=15m&limit=300`) |
| GET | `/api/analysis/:symbol` | Trend per timeframe, trend state, zones |
| GET | `/api/structure/:symbol` | Market structure (swing highs/lows, BOS, CHoCH) |
| GET | `/api/patterns/:symbol` | Chart patterns detected |
| GET | `/api/htf/:symbol` | Detailed 4H dealing range analysis |
| GET | `/api/volume-surge` | Coins with unusual volume |
| GET | `/api/watch/:symbol` | Full watchlist analysis for a symbol |
| GET | `/api/killzones` | Current session killzones |
| GET | `/api/sessions` | Session calendar (`?date=2025-01-15`) |
| GET | `/api/sessions/today` | Today's sessions with times |
| GET | `/api/pattern-memory` | Pattern memory stats across all coins |
| GET | `/api/pattern-memory/:symbol` | Pattern memory for a specific coin |

### Trading

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/account` | Account summary: equity, margin, open risk, circuit breaker state |
| GET | `/api/trades` | Trade history (`?status=open&symbol=BTCUSDT&limit=50`) |
| GET | `/api/events` | Raw trade events (`?symbol=&limit=`) |
| GET | `/api/equity` | Equity curve data (`?from=&to=`) |
| GET | `/api/shadows` | Shadow trades (setups taken in simulation only) |
| GET | `/api/results` | Trade results and statistics (`?from=&to=`) |
| GET | `/api/forward-test` | Forward test results |
| POST | `/api/positions/open` | Open a manual trade (body: `{ symbol, side, stop, target, note? }`) |
| POST | `/api/positions/:id/close` | Close an open position (`{ price? }` for market close) or cancel a pending order |
| POST | `/api/positions/:id/cancel` | Cancel a pending limit order |
| POST | `/api/positions/:id/modify` | Edit stop/target on an open position or limit entry price/stop/target on a pending order (`{ entry?, stop?, target? }`) |

### Setups & Signals

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/armed` | Setups waiting for 15M confirmation |
| GET | `/api/signals` | Signals with reasoning (`?status=&symbol=&limit=`) |
| GET | `/api/signals/summary` | Signal counts by status and reason (`?hours=24`) |
| GET | `/api/scalp` | Scalp setups across all coins (`?tf=15m`) |
| GET | `/api/scalp/:symbol` | Scalp setups for a specific coin |
| GET | `/api/ideas` | Trade ideas across all coins |
| GET | `/api/ideas/:symbol` | Trade ideas for a specific coin |
| GET | `/api/quant-scalp/autopilot` | Hunter (scalp autopilot) status |

### Trade Journal

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/journal` | All journal entries |
| GET | `/api/journal/:id` | Journal entry for a specific trade |
| POST | `/api/journal/:id` | Save/update a journal entry (body: `{ reflection }`) |

### Watchlist

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/watchlist` | Current watchlist |
| POST | `/api/watchlist` | Add to watchlist (`{ symbol, note? }`) |
| DELETE | `/api/watchlist/:symbol` | Remove from watchlist |

### Controls

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/control/kill` | Emergency: close all positions |
| POST | `/api/control/pause` | Pause the engine (no new trades) |
| POST | `/api/control/resume` | Resume after a pause, kill or drawdown stop |
| POST | `/api/control/reset` | Reset the simulated balance (`{ balance? }`; only with no open positions) |
| POST | `/api/control/quant-scalp-autopilot` | Turn Hunter on or off (`{ enabled }`) |

---

## Trade Journal (ATA Post-Mortem)

Every closed trade can be journaled with an **ATA Level 5 reflection**:

- ✅ Did you follow your setup rules?
- 📊 Entry quality (1–5)
- 📊 Exit quality (1–5)
- 🧠 Emotion during the trade
- 📝 Lesson learned
- 📈 Was HTF bias aligned?
- 💰 Premium or Discount entry?
- 💧 Was liquidity taken first?
- ✅ Was your bias correct?
- ⚠️ Was invalidation clear?

**On the dashboard:** Trades page → click "Journal" on any closed trade → fill the modal.

**Via API:** `POST /api/journal/<trade-id>` (see example above).

Journal data is stored in SQLite (`trade_journal` table, schema version 3).

---

## BTC Circuit Breaker

Protects your positions when BTC flash-crashes:

| Setting | Default | What |
|---|---|---|
| `enabled` | `true` | Master switch |
| `drop_5m_pct` | `-1.5` | BTC drop threshold in 5 minutes |
| `cooldown_min` | `30` | Stay halted for 30 minutes after the shock |
| `cancel_pending_limits` | `true` | Cancel limit orders waiting to catch falling knives |

When active:
- ❌ No new alt long trades (institutional, scalp, or manual)
- ❌ Pending long limit orders are cancelled
- 🔴 Red animated banner on the Overview page
- ✅ Existing positions are NOT touched (stops handle those)

Config path: `risk.btc_circuit_breaker` in `config.yaml`.

---

## 4H Dealing Range Radar

Shows you the big picture for each coin on the Overview page:

- **Current dealing range** (4H high/low)
- **Premium / Discount zone** — are you buying cheap or expensive?
- **Key POIs**: Order Blocks, Fair Value Gaps, Breaker Blocks
- **Reward:Risk** to the next POI level, after costs

This maps to the ATA Level 5 exercises:
1. Mark out the current range ✅
2. Identify LRLR or HRLR ✅
3. See where liquidity sits ✅
4. Confirm HTF bias alignment before trading ✅

---

## n8n Integration

n8n is a workflow automation tool. You can connect it to the engine's API to build automations like:
- Send Telegram/Discord alerts when a trade opens or closes
- Log every trade to Google Sheets
- Get a daily P&L summary email
- Alert when the circuit breaker activates

### Setup n8n locally with Docker

```bash
# Start n8n (runs on http://localhost:5678)
docker run -d \
  --name n8n \
  -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  --add-host=host.docker.internal:host-gateway \
  n8nio/n8n
```

Open **http://localhost:5678** and create an account.

> **Sign-in:** with `ALLOWED_EMAILS` set, every API call except `/api/health`
> needs a sign-in. Set `ENGINE_API_KEY` on the engine and add a header
> `X-API-Key: <that key>` to each HTTP Request node. n8n's SSE Trigger node
> cannot send headers, so Workflow 2 needs sign-in off (a local copy).

### Workflow 1: Trade Alert (opened / closed → Telegram)

Polls the trade log and sends only what is new since the last run.

1. **Create a new workflow** in n8n
2. Add a **Schedule Trigger** node → every 30 seconds
3. Add an **HTTP Request** node:
   - Method: `GET`
   - URL: `http://host.docker.internal:3009/api/events?limit=50`
   - Returns the latest trade events, newest first: `{ id, time, type, symbol, positionId, payload }`
4. Add a **Code** node that keeps the events it has not seen yet:
   ```javascript
   const seen = $getWorkflowStaticData('global');
   const events = $input.all().map((i) => i.json);
   const lastId = seen.lastId ?? Math.max(0, ...events.map((e) => e.id));
   const fresh = events.filter((e) => e.id > lastId && ['order_filled', 'position_closed', 'liquidated'].includes(e.type));
   seen.lastId = Math.max(lastId, ...events.map((e) => e.id));
   return fresh.reverse().map((e) => ({ json: { text: e.type === 'order_filled'
     ? `OPENED ${e.payload.side} ${e.symbol} @ ${e.payload.price} (stop ${e.payload.stop})`
     : `CLOSED ${e.symbol} @ ${e.payload.price} (${e.payload.reason}), gross P&L ${Number(e.payload.pnl).toFixed(2)} USDT` } }));
   ```
   The first run only records where the log is, so you are not sent the whole history.
5. Add a **Telegram** node (or Discord, Slack, Email) → send `{{ $json.text }}`
6. **Activate** the workflow

For the open positions right now, use `GET /api/account` → `positions[]`
(`symbol`, `side`, `entryPrice`, `stop`, `target`, `unrealized`, `pnlPct`).

### Workflow 2: SSE Event Stream (real-time alerts)

`GET /api/stream` is a server-sent event stream. Use n8n's **SSE Trigger** node
(an HTTP Request node waits for the response to end, and this one never does):

- URL: `http://host.docker.internal:3009/api/stream`
- Events it sends:
  - `signal`: the engine confirmed an entry (the dashboard's notifications)
  - `warning`: a coin got a pump or danger warning
  - `engine`: the engine's clock moved (every candle close; no detail)
  - `prices`: live prices
- Trades opening and closing are **not** on the stream; poll `/api/events` for those (Workflow 1).

### Workflow 3: Daily P&L Report

1. **Schedule Trigger** → every day at 8:00 AM
2. **HTTP Request** → `GET http://host.docker.internal:3009/api/equity?hours=24` (equity points over the last 24 hours)
3. **HTTP Request** → `GET http://host.docker.internal:3009/api/trades?limit=200` (closed trades, newest first; keep those with `closedAt` in the last 24 hours)
4. **Code** → Format a summary with:
   - Starting vs ending equity
   - Number of trades taken
   - Win/loss breakdown
   - Best and worst trade
5. **Email/Telegram/Slack** → Send the summary

### Workflow 4: Circuit Breaker Alert

1. **Schedule Trigger** → every 1 minute
2. **HTTP Request** → `GET http://host.docker.internal:3009/api/account`
3. **IF** node → check `{{ $json.circuitBreaker.active === true }}`
4. **Telegram** → "🚨 BTC Circuit Breaker ACTIVE — new altcoin longs blocked for 30 min"

### Testing n8n workflows

1. Start the engine: `npm run dev`
2. Start n8n: `docker start n8n` (or the `docker run` command above)
3. In n8n, open a workflow and click **"Test workflow"**
4. Check that n8n can reach the engine:
   ```
   # From inside n8n, test the connection:
   URL: http://host.docker.internal:3009/api/health
   Expected: { "status": "ok", "feed": "live", ... }
   ```
5. If `host.docker.internal` doesn't work on your system, use your machine's local IP instead

> **Note:** On Linux, `host.docker.internal` may need the `--add-host` flag
> shown in the Docker command above. Alternatively, use `172.17.0.1` (the
> default Docker bridge gateway).

---

## Configuration

All settings live in [`engine/config/config.yaml`](engine/config/config.yaml).
The config is validated against a schema on startup — a misspelled key stops the engine.

Key sections:

| Section | What |
|---|---|
| `speed` | Coin grouping by ATR (calm/normal/wild), risk per group |
| `timeframes` | Which timeframes for bias (4H), setup (1H), trigger (15M), exits (1M) |
| `trend` | Swing lookback, EMAs, allowed trend states |
| `zones` | Supply/demand zone detection parameters |
| `fvg` | Fair Value Gap detection |
| `pullback` | Pullback setup: EMA levels, Fibonacci, confluence, arming |
| `trigger` | 15M confirmation: RSI, relative volume, rejection wick |
| `filters` | Individual filters: chop, squeeze, fakeout, extension, room, BTC, etc. |
| `scoring` | Minimum confluence score to take a trade |
| `allocation` | Position sizing, max open trades, max exposure, correlation groups |
| `exits` | Stop placement, take-profit, profit ladder, early exits, break-even |
| `scalp_autopilot` | Quant scalp: timeframes, kinds, max stop, hold time, entry timeout |
| `risk` | Daily loss limit, max drawdown kill switch, cooldown, BTC circuit breaker |
| `sim` | Simulated execution: fees, slippage, funding, entry timeout |

---

## Environment Variables

Set in `.env.local` (git-ignored) or as environment variables:

| Variable | Default | What |
|---|---|---|
| `PORT` | `3009` | Port for the server |
| `ENGINE_DB_PATH` | `data/engine/engine.db` | SQLite database path |
| `ENGINE_CONFIG` | `engine/config/config.yaml` | Config file path |
| `ALLOWED_EMAILS` | unset (no sign-in) | Comma-separated Google accounts for auth. **Set this on hosted copies.** |
| `ENGINE_API_KEY` | unset | Key automations send in an `X-API-Key` header to call the API while sign-in is on. Keep it secret. |
| `BACKUP_TARGET` | `firestore` (prod) / `file` (dev) | Where the trade log is backed up |
| `ENGINE_NAMESPACE` | `hosted` (prod) / `local` (dev) | Keeps backups separate between copies |

See [`.env.example`](.env.example) for documentation.

---

## Production / AI Studio

```bash
npm run build    # Vite frontend → dist/, engine → server.js
npm start        # NODE_ENV=production node server.ts
```

### Deploying to AI Studio / Cloud Run

1. Set `ALLOWED_EMAILS` to your Google account
2. In Firebase console: enable **Google** under Authentication → Sign-in method
3. Add your app's domain to Firebase Authorized domains
4. Deploy — `npm run build` then `npm start`
5. Check the dashboard sidebar: `backup: Firestore (hosted)` means the trade log survives restarts
6. Deploy `firestore.rules` (browsers get no access; the Admin SDK bypasses rules)
7. Keep it awake: set minimum instances to 1, or use an uptime monitor hitting `/api/health` every 5 minutes

> Only one copy trades at a time: the running engine holds a Firestore lock.
> Another copy with the same namespace shows data but does not trade (`standby` in the header).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `[feed] error` on startup | Check your internet connection. The engine reads Binance public endpoints. |
| `Config validation failed` | You misspelled a key in `config.yaml`. The error message shows which key. |
| No trades appearing | Check `npm run dev` terminal for `[signal]` lines. Trades only open during session entry windows (Asia, London, NY). Run `curl localhost:3009/api/status` to see the current session. |
| Database corrupt | Delete `data/engine/engine.db` and restart. The engine rebuilds from scratch. |
| Tests failing | Run `npm test` to see which. Run `npm run lint` to check for type errors. |
| n8n can't reach the engine | Make sure the engine is running. Try `curl http://localhost:3009/api/health` from your machine first. In Docker, use `host.docker.internal` or `172.17.0.1`. |
| Circuit breaker won't clear | It auto-clears after `cooldown_min` (default 30 min). Check with `curl localhost:3009/api/account \| jq '.circuitBreaker'`. |
| Port already in use | Set `PORT=3010` in `.env.local` or `PORT=3010 npm run dev`. |
| `npm run build` fails | Run `npm run lint` first to catch type errors. |

---

## Commands Cheat Sheet

```bash
npm install              # Install dependencies
npm run dev              # Dev server (engine + dashboard)
npm test                 # Run all 408 tests
npm run lint             # Type check
npm run build            # Production build
npm start                # Start production server
npm run backtest         # Run historical backtest
npm run clean            # Remove build artifacts
```
