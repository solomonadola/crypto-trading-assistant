# Trading Engine Rewrite — Plan (for review)

Status: **draft for review, 2026-09-28.** No code changes until this plan is approved.

This replaces the current scanner, autopilot and worker with a new engine built
around top-down trend analysis, trading sessions and a simulated futures
account. It is based on the "Crypto Momentum Trading Bot — Implementation Plan"
(v2), with the decisions below applied.

> Simulation only. The engine reads public Binance market data and trades a
> virtual balance. It never connects to a Binance account and needs no API keys.

---

## 0. Decisions already made

| Topic | Decision |
|---|---|
| Mode | **Simulation only** (live public prices, simulated fills, virtual balance). No live trading in this rewrite. |
| Market | **Binance USDⓈ-M perpetual futures**, long and short, USDT-margined. |
| Language / stack | TypeScript on Node, React UI, Express, Firebase. One language across the project. |
| Sessions | New trades only inside the **Asian, London and New York** sessions. |
| Session exit | Every trade is **closed at the end of its own session**, even in profit. |
| Backtest | The existing backtest is **removed**. A new one is built later, after the simulator has run for a while. |
| Storage | **SQLite on the server is the working store.** The UI reads only from the server. On AI Studio, Firestore holds a **backup of the event log only** (Section 4A.4). |
| Hosting | **AI Studio (Cloud Run) for now**, possibly a VPS later; local runs also supported. |
| Login | **Firebase Auth** (free, no usage quota). |
| Engine core | Receives time and candles as **inputs**; never reads the clock or the network itself. Same code for simulation, tests and the later backtest. |
| Trade records | **Append-only event log**; positions and balance are derived from it. |
| Build order | **Pullback setup first**, end to end; breakout setup after. |
| Entry | **Always wait for confirmation**, then enter with a **market order**. No limit orders. |
| Account | **$1,000** virtual balance, **3× leverage**. |
| Weekends | Traded, same rules and sessions. |
| Old data | Not needed. Old Firestore data and local state files are deleted, no export. |
| UI | Rebuilt freely; nothing from the old dashboard has to be kept. |
| Git | Handled by the owner before any code change. |

---

## 1. Goals & Non-Goals

**Goals**
- Scan all liquid USDT perpetuals and trade only coins that pass the rules.
- Two setups: **Trend Pullback / Demand Zone** (primary) and **Volume Breakout** (secondary), long and short.
- Explicit filters against chop, stagnation and fakeouts.
- Trade only inside sessions; close every trade when its session ends.
- Strict risk: loss cap per trade, open-risk cap, daily loss limit, kill switch.
- Simulate fills as realistically as possible: fees, slippage, funding, liquidation.
- Record every signal, including rejected ones with the reason, so rules can be judged later.
- Every threshold configurable; no magic numbers in code.

**Non-Goals (this rewrite)**
- Live trading, exchange accounts, API keys.
- A backtester (planned later; see Section 15).
- Machine learning, order-book / HFT scalping, DEX trading.

---

## 2. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (Node 22), strict mode | Shared types between engine, API and UI. |
| Market data | Binance futures **public** REST + WebSocket (`fapi`) | Klines, 24h tickers, mark price, funding rate. No keys. Plain `fetch`/`ws`; `ccxt` only if it saves real work. |
| Indicators | Hand-written TS | EMA, SMA, RSI, ATR, ADX, VWAP, RVOL, Bollinger width, Choppiness, swing pivots. |
| Engine | Long-running Node process | Feed, engine and API run in one process; the engine loop never runs inside request handlers or Cloud Functions. |
| Storage | **SQLite** (`better-sqlite3`, WAL mode) on the server | The only store: event log, signals, zones, equity, config. Candles cached in their own tables or files. |
| UI data | **Express REST + Server-Sent Events** | The UI loads data over REST and receives live updates over one SSE stream. No Firestore. |
| Auth | **Firebase Auth only** | The UI signs in with Firebase Auth; the server verifies ID tokens with `firebase-admin`. Free, no usage quota. |
| API | Express | Serves the UI, the REST API, the SSE stream and the control endpoints. |
| Backup | `backup.target: firestore` on AI Studio, `file` on a VPS or local | Firestore: event log + 5-minute snapshot only (Section 4A.4). File: daily copy of the SQLite file, last 14 kept. |
| Config | `config.yaml` validated with `zod` | Validated on load and on every update. |
| Logging | `pino`, JSON to file + console | |
| Tests | `vitest` | |
| Charts | `lightweight-charts` | Candles, zones, entries, stops, ladder levels, session shading. |
| Hosting | AI Studio (Cloud Run) now; VPS/VM or local later | Cloud Run wipes the disk on restart and may stop an idle instance; the Firestore backup and candle replay cover both (Section 4A.4). On a VPS, `pm2` or Docker with a persistent disk and `backup.target: file`. |

Why Firestore is only a backup: its free tier allows 50,000 reads and 20,000
writes a day, and every live listener update costs a read in every open browser
tab. This repo's history shows repeated quota and sync problems. Here browsers
never read Firestore, and the server writes only trade events and a snapshot
every 5 minutes (a few hundred writes a day) and reads only on startup.

---

## 3. What happens to the current code

**Kept**
- `data/klines*`: historical candles, kept for the future backtest.
- `src/config/universe.ts` exclusion list (stablecoins, wrapped coins, tokenised shares): moved into `config.yaml`.
- Firebase project and **Auth only** (`firebase-applet-config.json` for the client Auth config).
- React + Vite + Tailwind setup, `Header` / `StatusStrip` styling where reusable.
- Study documents (`STUDY_A_RESULTS.md`, `AUDIT.md`) as reference.

**Removed**
- Backtest: `src/backtest/`, `src/types/backtest.ts`, `src/components/BacktestLabView.tsx`, `tools/backtest*.mjs`, `tools/tune-strategy.mjs`, `data/backtests/`.
- Old strategy and engine: `entryScannerService`, `autopilotEngine`, `autopilotSyncService`, `cycleEngineService`, `marketRegimeService`, `marketAnalysisService`, `automatedFeedService`, `orderFlowService`, `catchUpService`, `consolidationLossRecorderService`, `src/strategies/`, `src/config/{autopilot,entry,geometry}.ts`, `src/worker/tradingWorker.ts`.
- Old study/replay tools in `tools/` that depend on the removed code.
- UI views tied to the old engine (AutoPilot HUD, Automated Feed, Order Flow, Lessons, pacing and scorecard cards, old modals).
- Firestore as the app's database: `firebase-blueprint.json`, the Firestore parts of `src/lib/firebase.ts`, `firestoreMeter`, `serverFeed`, `bankrollService`, `tools/fetch-firestore-trades.mjs`, and the old collections themselves (no export). `firestore.rules` is rewritten to deny all client access; only the server (Admin SDK) uses the new backup collections.
- Old local state: `data/worker-state.json`, `data/firestore-*.json`, `data/entries*.json`, `data/tuning/`, `data/studies/`.
- All current UI views: the dashboard is rebuilt from scratch (Section 12).

**Rewritten**
- `src/server.ts` → new Express API.
- `src/App.tsx` and views → new dashboard (Section 12).
- `README.md` → new setup and run instructions.

The exact file list is confirmed in Phase 1 before anything is deleted.

---

## 4. Project Structure

```
repo/
├── engine/
│   ├── config/
│   │   ├── config.yaml
│   │   └── schema.ts            # zod schema
│   ├── src/
│   │   ├── main.ts              # starts the feed, the engine and the API in one process
│   │   ├── core/
│   │   │   ├── engine.ts        # engine core: onCandle(event) → trade events (Section 4A)
│   │   │   └── clock.ts         # time comes from candle events only
│   │   ├── feed/
│   │   │   ├── binancePublic.ts # REST + WebSocket, public endpoints only
│   │   │   ├── liveFeed.ts      # live candles → engine, with catch-up after gaps
│   │   │   ├── replayFeed.ts    # stored candles → engine (tests, restart, later backtest)
│   │   │   └── candleStore.ts   # candle cache, multi-timeframe sync (1m/15m/1h/4h)
│   │   ├── api/
│   │   │   ├── server.ts        # Express: UI, REST, SSE stream, control
│   │   │   └── auth.ts          # Firebase ID token check
│   │   ├── analysis/
│   │   │   ├── indicators.ts
│   │   │   ├── structure.ts     # swings, protected high/low, CHoCH, trend states
│   │   │   └── zones.ts         # supply/demand zones and lifecycle
│   │   ├── sessions.ts          # session calendar, entry window, session-end exits
│   │   ├── scanner.ts           # universe filter
│   │   ├── filters.ts           # chop, squeeze, stagnation, fakeout, BTC, extension
│   │   ├── scoring.ts
│   │   ├── strategy/
│   │   │   ├── pullback.ts
│   │   │   └── breakout.ts
│   │   ├── risk.ts              # sizing, loss caps, daily limit, kill switch
│   │   ├── exits.ts             # stop, profit ladder, time stop, session exit, early exits
│   │   ├── sim/
│   │   │   ├── broker.ts        # simulated order book: fills, fees, slippage, funding
│   │   │   └── account.ts       # virtual balance, margin, liquidation price
│   │   ├── portfolio.ts         # positions and balance, derived from the event log
│   │   └── storage/
│   │       ├── db.ts            # SQLite schema and migrations
│   │       ├── eventLog.ts      # append-only trade events
│   │       ├── backup.ts        # file backup (VPS/local)
│   │       ├── firestoreBackup.ts # event log + snapshot backup and restore (AI Studio)
│   │       └── engineLock.ts    # single-engine lease
│   └── tests/
├── shared/
│   └── types.ts                 # Position, Trade, Signal, Zone, TrendState, Session, Config
└── src/                         # React UI (rebuilt)
```

---

## 4A. Engine Core and Event Log

### 4A.1 Time and prices are inputs

The engine core never calls `Date.now()`, never calls Binance and never sets
timers. It receives events and returns what happened:

```ts
engine.onCandle({ symbol, timeframe, openTime, open, high, low, close, volume, quoteVolume })
engine.onFunding({ symbol, time, rate })
engine.onCommand({ type: 'close' | 'kill' | 'stop' | 'start', ... })
// each returns the trade events it produced (Section 4A.2)
```

The engine's clock is the close time of the latest candle it has seen. Session
starts and ends, the time stop, cooldowns and the daily loss reset are all
measured against that clock.

Feeds supply the events:
- **Live feed**: Binance public WebSocket + REST, emits each candle once it has closed.
- **Replay feed**: stored candles in time order, used for tests, restart recovery and the later backtest.

Consequences:
- Session and daylight-saving behaviour is tested by replaying candles from the DST weekends in March and October and checking exactly when trades close.
- Given the same candles and config, the engine produces the same trades every time.
- The later backtest is the replay feed over history; it cannot drift from the simulation because it runs the same code.

### 4A.2 Append-only event log

Every change to the simulated account is one row in `trade_events`, never
updated or deleted:

`signal_taken`, `order_placed`, `order_filled`, `order_cancelled` (missed fill),
`stop_moved`, `partial_closed`, `funding_charged`, `position_closed` (with exit
reason), `liquidated`, `balance_reset`.

Each row: `id`, `time` (engine clock), `position_id`, `symbol`, `type`,
`payload` (JSON), `engine_version`, `config_hash`.

- Open positions, closed trades, balance and equity are **derived** by replaying the log; a cached snapshot table speeds this up and can always be rebuilt.
- Signals and filter rejections go to their own `signals` table (high volume, pruned after 30 days).
- The log answers "why did this stop move here?" for any trade, and the Stats page is computed from it.

### 4A.3 Restart

On startup: load the latest snapshot, replay events after it, then replay
1m candles from the last processed minute up to now through the engine
before switching to the live feed. Nothing is lost or duplicated.

### 4A.4 Surviving Cloud Run (AI Studio hosting)

Cloud Run wipes the disk on every restart or redeploy and may stop an instance
that gets no traffic. The engine handles both:

- **Backup** (`backup.target: firestore`): every trade event is written to Firestore `engine_events/{id}` in batches every 30 seconds, plus the derived snapshot to `engine_state/snapshot` every 5 minutes. Signals, zones and candles are not backed up; zones and candles are rebuilt from Binance data, and signals are expendable history.
- **Restore**: on a start with an empty disk, read the snapshot and the events after it into SQLite, then continue as in 4A.3. The missed 1m candles are fetched from Binance (it serves them for any past minute), so exits that should have happened while the instance was down happen at the right prices and times, just late on the screen.
- **Single engine lock**: before trading, the engine takes a lease document `engine_state/lock` (holder id, expiry, renewed every 30 s). A copy that cannot get the lease (a second Cloud Run instance, a local dev run) runs **read-only**: it shows data but never writes events or backups. Local runs use their own backup namespace by default (`backup.namespace: local`), so they never touch the hosted engine's data.
- **Keeping it awake**: set the service to one instance (`max-instances=1`) and, if AI Studio allows it, `min-instances=1`. Otherwise a free uptime monitor calling `GET /api/health` every 5 minutes keeps it running; any time it is still stopped is covered by the replay above.
- **Budget**: about 50–300 event writes a day plus 288 snapshot writes; reads only on startup. Far under the free tier.
- **Moving to a VPS**: set `backup.target: file`. No code change.

---

## 5. Sessions (`sessions.ts`)

### 5.1 Session calendar

Sessions are defined in their **local time zones**, so daylight-saving shifts
are handled automatically:

| Session | Local hours | UTC (summer) | UTC (winter) |
|---|---|---|---|
| Asian | 09:00–18:00 Asia/Tokyo | 00:00–09:00 | 00:00–09:00 |
| London | 08:00–17:00 Europe/London | 07:00–16:00 | 08:00–17:00 |
| New York | 08:00–17:00 America/New_York | 12:00–21:00 | 13:00–22:00 |

Outside all three (about 21:00–00:00 UTC in summer, 22:00–00:00 in winter)
no new trades are opened. Crypto trades on weekends; sessions run every day
unless `weekdays_only` is set.

### 5.2 Which session a trade belongs to

A trade belongs to the **most recently opened** session at its entry time.

| Entry time (UTC, summer) | Session | Forced exit |
|---|---|---|
| 02:00 | Asian | 09:00 |
| 08:00 (Asian + London open) | London | 16:00 |
| 13:00 (London + New York open) | New York | 21:00 |
| 22:30 | none | no entry |

### 5.3 Entry window
- New entries are allowed from `session start + entry_delay_min` until `session end − no_entry_before_end_min`.
- Default: entries allowed from session open until **60 minutes before** that session's end.
- Setups armed before a window opens are discarded, not carried in.

### 5.4 Session-end exit
- At the session's end, every trade belonging to it is closed at market (simulated taker fill with slippage), whatever its profit.
- This overrides the profit ladder and replaces the old 48h maximum hold (no trade can live longer than one session, about 9 hours).
- Exit reason recorded as `session_end`.

### 5.5 Config

```yaml
sessions:
  enabled: true
  weekdays_only: false
  list:
    - { name: asian,   tz: Asia/Tokyo,       open: "09:00", close: "18:00" }
    - { name: london,  tz: Europe/London,    open: "08:00", close: "17:00" }
    - { name: newyork, tz: America/New_York, open: "08:00", close: "17:00" }
  entry_delay_min: 0
  no_entry_before_end_min: 60
  exit_at_session_end: true
  skip_minutes_around_funding: 10   # 00:00, 08:00, 16:00 UTC
```

---

## 6. Configuration (`config.yaml`)

The v2 config, with these changes: futures by default, sessions as above, no
`max_hold_hours`, flat position size by default, simulation costs including
funding.

```yaml
market: futures                 # USDT-margined perpetuals
leverage: 3                     # margin only; risk is set by the loss cap
starting_balance_usdt: 1000
quote: USDT

scanner:
  min_quote_volume_24h: 50_000_000
  min_atr_pct_1h: 2.0
  max_change_24h_pct: 30
  exclude: [USDC, FDUSD, TUSD, DAI, USDP, WBTC, WETH, PAXG, XAUT]
  blacklist: []
  rescan_interval_sec: 300
  max_symbols: 30

timeframes: { bias: 4h, setup: 1h, trigger: 15m, exits: 1m }

trend:
  swing_lookback: 3
  ema_fast: 50
  ema_slow: 200
  use_protected_low: true
  allowed_states: [strong, pullback]

zones:
  base_max_candles: 4
  base_body_max_atr: 0.5
  impulse_body_min_atr: 1.5
  impulse_min_rvol: 1.5
  max_touches: 2
  lookback_candles: 200
  max_zone_width_pct: 3.0

pullback: { ema_levels: [20, 50], fib_min: 0.5, fib_max: 0.618, min_confluence: 2, armed_expiry_hours: 6 }

breakout:
  lookback_high_candles: 16
  min_rvol: 3.0
  rsi_min: 55
  rsi_max: 75
  min_range_candles_1h: 8

trigger: { confirmations_min: 1, rsi_period: 14 }   # the 15m CHoCH close is always required (Section 8.4)

filters:                        # every filter can be switched off individually
  chop:       { enabled: true, adx_min_1h: 20, choppiness_max_1h: 61.8, ema_cross_max_1h: 2, ema20_slope_min_atr: 0.1, range_lookback_1h: 12, range_min_pct: 3.0 }
  squeeze:    { enabled: true, bb_width_percentile_min: 20 }
  stagnation: { enabled: true, volume_vs_7d_min: 0.7, atr_vs_avg_min: 0.7 }
  fakeout:    { enabled: true, close_beyond_atr: 0.2, min_close_position: 0.7, max_upper_wick_ratio: 0.4, min_rvol: 2.0, failed_breakout_candles: 3 }
  extension:  { enabled: true, max_distance_ema20_atr_15m: 3.0 }
  wicks:      { enabled: true, max_avg_wick_body_ratio_1h: 2.5 }
  room:       { enabled: true, htf_room_min_pct: 2.5 }
  funding:    { enabled: true, max_against_pct_8h: 0.05 }
  btc:        { enabled: true, block_longs_if_btc_1h_below_pct: -1.5, block_shorts_if_btc_1h_above_pct: 1.5 }

scoring: { min_score: 4 }

allocation:
  sizing: flat                  # flat | tiers (tiers only after data shows score predicts results)
  flat_capital_pct: 10
  tiers:
    - { min_score: 4, capital_pct: 10 }
    - { min_score: 5, capital_pct: 20 }
    - { min_score: 6, capital_pct: 30 }
    - { min_score: 7, capital_pct: 40 }
  max_open_trades: 5
  max_total_exposure_pct: 100
  max_loss_per_trade_pct: 1.0
  max_open_risk_pct: 3.0
  max_correlated_trades: 2
  correlation_groups:
    memes: [DOGE, SHIB, PEPE, WIF, BONK, FLOKI]
  max_pct_of_1h_volume: 1.0

exits:
  mode: partial_ladder          # fixed | partial_ladder | ladder
  fixed_target_pct: 5.0
  partial_at_pct: 5.0
  partial_close_pct: 50
  stop_buffer_atr: 0.3
  max_stop_pct: 2.5
  min_rr: 2.0
  breakeven_fee_buffer_pct: 0.2
  ladder:
    - { trigger_pct: 3,  lock_pct: 0.2 }
    - { trigger_pct: 5,  lock_pct: 2 }
    - { trigger_pct: 7,  lock_pct: 4 }
    - { trigger_pct: 10, lock_pct: 7 }
  beyond_last_step: { lock_fraction_of_peak: 0.7, or_swing_15m: true }
  step_on: close_15m
  min_gap_atr_15m: 1.0
  time_stop_hours: 3
  time_stop_min_progress_pct: 2.0
  early_exit:
    on_15m_counter_choch: tighten
    on_1h_protected_level_break: close
    on_4h_state_change: close
    on_btc_move_1h_pct: 2.0
    on_btc_move_action: tighten

risk:
  max_trades_per_symbol_per_day: 2
  daily_loss_limit_pct: 3.0
  max_drawdown_kill_pct: 15.0
  cooldown_after_loss_min: 30
  losing_streak_size_cut: { after_losses: 3, size_mult: 0.5, reset_after_wins: 2 }

backup:
  target: firestore             # firestore (AI Studio) | file (VPS/local)
  namespace: hosted             # local runs default to "local" so they never touch hosted data
  events_flush_sec: 30
  snapshot_every_min: 5
  lock_lease_sec: 90

sim:                            # simulated execution
  taker_fee_pct: 0.05           # every fill is a market or stop order
  slippage_pct: 0.05            # applied to every fill
  charge_funding: true
```

---

## 7. Scanner (`scanner.ts`)

Every `rescan_interval_sec`:
1. Fetch 24h tickers for all USDT perpetuals.
2. Keep: quote volume ≥ minimum; not excluded, blacklisted or a tokenised stock; `|24h change| ≤ max_change_24h_pct`.
3. Fetch 1h candles; keep if ATR(14)% ≥ `min_atr_pct_1h`.
4. Drop stagnating and wick-heavy coins (filters).
5. Rank by `ATR% × log(volume)`; keep the top `max_symbols`.
6. Store the shortlist with volume, ATR%, trend state.

Open positions keep being priced and managed even if their coin leaves the shortlist.

---

## 8. Analysis

### 8.1 Indicators
All take closed candles only (non-repainting). EMA, SMA, RSI (Wilder), ATR
(Wilder), ADX, Choppiness, Bollinger width, daily VWAP (resets 00:00 UTC), RVOL,
swing pivots (confirmed only after `k` candles close), Fibonacci levels. Each
unit-tested against known values, and tested for no lookahead by truncating data.

### 8.2 Trend state machine (4h, 1h, 15m)
As in v2 Section 7.1: protected low/high, structure break on a candle **close**,
combined states `strong`, `pullback`, `weakening`, `transition`, `reversed`.
Longs need `strong`/`pullback` on the long side and 4h close > EMA50; shorts
mirror everything. States are stored per symbol when they change.

### 8.3 Supply & demand zones (1h)
As in v2 Section 7.2: base + impulse detection, zone bounds, width cap,
touches, fresh/tested/invalid lifecycle.

### 8.4 Pullback confluence (1h) and 15m confirmation
As in v2 Sections 7.3 and 7.4. A trade always passes through these stages, in
order, and never skips one:

| Stage | Meaning | Stored as |
|---|---|---|
| **Selected** | Coin is on the scanner shortlist, trend state allows the direction | scanner row |
| **Armed** | Price is in a pullback area with ≥ `min_confluence` factors (zone, EMA20/50, Fib 0.5–0.618, daily VWAP, old breakout level) | `signals` row, status `armed` |
| **Confirmed** | A 15m candle **closes** beyond the most recent 15m counter-swing (CHoCH), plus ≥ `confirmations_min` of: engulfing/rejection wick, RVOL ≥ 1.5, RSI back through 50 | `signals` row, status `confirmed` |
| **Checked** | Session entry window open, all filters pass, risk limits allow it, stop ≤ `max_stop_pct`, reward-to-risk ≥ `min_rr` | `signals` row, `taken` or `filtered` with the reason |
| **Entered** | Market order at the open of the next 1m candle | `order_filled` event |

- Confirmation is **always required**; there is no setting to turn it off.
- Only closed candles count. A wick through the level without a close is not confirmation.
- Armed setups expire after `armed_expiry_hours`, when price leaves the area, or when the session entry window closes.

### 8.5 Volume breakout
As in v2 Section 8, both directions, with all fakeout rules mandatory.

### 8.6 Filters
As in v2 Section 7.5, except the session filter now lives in `sessions.ts`.
Added: **funding filter**, which skips a trade when the funding rate is
strongly against its direction. Every filter can be switched off on its own,
and every rejection is stored with the filter name and values.

### 8.7 Score
As in v2 Section 7.6. Stored with each factor on every trade. It **does not
change position size** while `allocation.sizing: flat`.

---

## 9. Exits (`exits.ts`)

Checked in this order, on every 1m candle (stops, session end) and every 15m
close (ladder steps, early exits):

1. **Stop-loss**: always present from the moment of entry.
2. **Session end**: close at market when the trade's session ends (Section 5.4).
3. **Profit ladder**: as in v2 Section 9.2; stop only moves in the trade's favour, only on 15m closes, never closer than 1× 15m ATR.
4. **Exit mode**: `fixed`, `partial_ladder` (default) or `ladder`.
5. **Time stop**: if after `time_stop_hours` the peak gain is below `time_stop_min_progress_pct` and the ladder is not active, close.
6. **Early exits**: as in v2 Section 9.5 (counter-CHoCH, protected level break, 4h state change, failed breakout, in-trade stagnation, sharp BTC move).

Removed from v2: `max_hold_hours` (the session exit is shorter).

Note for review: the ladder's first step is +3%, while the session exit closes
trades within about 9 hours and the time stop needs +2% within 3 hours. Many
trades may close before the ladder starts. The simulator reports how often each
exit fires so this can be tuned with evidence.

---

## 10. Risk & Sizing (`risk.ts`)

As in v2 Section 10, with `sizing: flat` (10% of equity per trade) by default:

1. Position size from `flat_capital_pct` (or the score tier when `sizing: tiers`).
2. Shrink so the loss at the stop, including fees and slippage, is ≤ `max_loss_per_trade_pct` of equity.
3. Total exposure ≤ `max_total_exposure_pct`; open risk ≤ `max_open_risk_pct` (trades locked at breakeven or better count as 0).
4. Max open trades, one per symbol, correlation groups, max trades per symbol per day.
5. Size ≤ `max_pct_of_1h_volume` of the coin's 1h quote volume.
6. Losing-streak size cut; never increase size after a loss.
7. Round to the exchange's lot size and minimum notional (from public exchange info).
8. **Liquidation check**: the simulated liquidation price at `leverage` must sit beyond the stop by a margin; otherwise lower the leverage or skip.

Portfolio protection: daily loss limit (block entries until 00:00 UTC), kill
switch at `max_drawdown_kill_pct` (close everything, stop the engine), symbol
cooldown after a loss, and a manual kill switch in the UI.

---

## 11. Simulated Execution (`sim/`)

The simulator stands in for the exchange. It must never be more generous than
a real exchange would be.

- **Prices**: live Binance futures klines (1m, 15m, 1h, 4h) and mark price over WebSocket, with REST catch-up after a disconnect.
- **Entries**: market order after the confirmation candle closes. Filled at the **next 1m candle's open** plus `slippage_pct` against the trade (higher for longs, lower for shorts), taker fee. The fill price is used to recheck the stop distance and loss cap; if the fill moved the trade outside `max_stop_pct` or `min_rr`, it is still entered but sized down to respect the loss cap, and the slippage is recorded.
- **Other market orders** (session exits, early exits, manual close, partial closes): next 1m open with slippage against the trade, taker fee.
- **Stops**: triggered when a 1m candle's low (long) or high (short) reaches the stop. Filled at the stop minus slippage, or at the candle's open if it gapped through. Taker fee.
- **Stop and target in the same 1m candle**: stop first.
- **Funding**: at 00:00, 08:00 and 16:00 UTC, open positions pay or receive the real funding rate on their notional.
- **Liquidation**: computed from leverage and maintenance margin; if the mark price reaches it before the stop, the position is liquidated (should never happen given Section 10.8, and is alerted if it does).
- **Data gaps**: if price data stalls for more than 2 minutes, no new entries until it recovers; on recovery, replay missed 1m candles through the exit logic in order.
- **Restart**: as in Section 4A.3.

---

## 12. UI

### 12.1 Pages
- **Overview**: virtual equity curve, daily PnL, open risk, exposure, limits hit, engine heartbeat, **session clock** (current session, time to its end, next session).
- **Scanner**: shortlist with volume, ATR%, trend state, funding.
- **Positions**: open trades with entry, stop, ladder step, peak gain, unrealised PnL, session and its exit time; manual close.
- **History**: closed trades with full reasoning, exit reason, fees, funding.
- **Signals**: taken, filtered and missed signals with the reason.
- **Chart**: candles with zones, entries, stops, ladder levels and session shading.
- **Settings**: view config; edit safe fields; start / stop / kill.
- **Stats**: results broken down by setup, direction, session, exit reason, score, filter and coin.

### 12.2 Express endpoints (Firebase Auth ID token required)
- `GET /api/status`, `/api/positions`, `/api/trades`, `/api/signals`, `/api/scanner`, `/api/zones/:symbol`, `/api/candles/:symbol`, `/api/stats`, `/api/events`
- `POST /api/control/start`, `/api/control/stop`, `/api/control/kill`, `/api/positions/:id/close`
- `GET /api/config`, `PUT /api/config` (zod-validated; hot-reload safe fields only)
- `POST /api/sim/reset` (reset the virtual balance; blocked while positions are open)

Commands go straight to the engine in the same process, so control always works.

### 12.3 Live updates (Server-Sent Events)
- `GET /api/stream`: one SSE connection per browser tab. Pushes `status`, `position_update`, `trade_closed`, `signal`, `scanner_update`, `zones_update`, `equity_tick` and `alert`.
- The UI loads the current state over REST on page load, then applies stream updates. On reconnect it reloads over REST, so a dropped connection can never leave it out of date.
- `status` is pushed at least every 15 seconds and doubles as the heartbeat.
- Serving extra browsers costs nothing beyond the server's own bandwidth; there is no quota.

### 12.4 Login
- The UI signs in with Firebase Auth (email/password or Google).
- Every API and SSE request carries the ID token; the server verifies it and checks the user's email against an allow-list in `.env`.

---

## 13. Monitoring & Safety

- Heartbeat over the SSE stream; the UI shows the engine offline if it goes stale.
- Backups per Section 4A.4; a full restore from an empty disk is tested in Phase 6.
- Alert when the engine lock is lost or held by another copy.
- Alert (UI event, optional Telegram) on: kill switch, daily limit, data stall, simulated liquidation, any position without a stop.
- Weekly review: results by session, setup, direction and exit reason.
- No API keys exist in this version. When live trading is added later, keys stay in the server `.env`, trading-only, withdrawals disabled, IP-whitelisted, and live mode needs `--confirm-live`.

---

## 14. Build Phases (review after each)

1. **Clean-up and foundation**: remove old code and local state files (the file list is shown before deleting; the Firestore collections are deleted only after a separate confirmation, since that cannot be undone); new `engine/` project, config + zod, SQLite schema with the event log, public Binance client, candle store, live and replay feeds, indicators with tests.
2. **Engine core + sessions**: event-driven core and clock; session calendar, entry windows, session ownership, session-end exits, tested by replaying the DST weekends and the London/New York overlap.
3. **Analysis**: structure, trend states, zones; debug chart page to check them visually.
4. **Pullback setup**: confluence, 15m trigger, filters, scoring, long and short; signals stored with reasons.
5. **Risk, exits and simulator**: sizing and caps, ladder, time stop, early exits, simulated broker with fees, slippage, funding and liquidation; restart recovery.
6. **API + live stream + login + hosting**: REST, SSE, control endpoints, Firebase Auth check, Firestore backup and restore, engine lock, deploy to AI Studio, restore-from-empty-disk test.
7. **UI**: new dashboard pages.
8. **Run the simulation** with the pullback setup for 2–4 weeks; review results by session, direction and exit reason.
9. **Breakout setup**: added once the pullback path is proven end to end, then filters turned on a few at a time.

---

## 15. Later (not in this rewrite)

- **New backtester**: the replay feed (Section 4A.1) run over stored history through the same engine, so backtest and simulation cannot drift apart. Needs historical futures candles and funding rates, and a universe rebuilt per day from historical volume.
- **Live trading** with exchange-side stops, reconciliation and the safety rules above.

---

## 16. Acceptance Criteria

- [ ] Indicators unit-tested; no lookahead anywhere (truncation tests).
- [ ] No trade opens outside a session entry window.
- [ ] Every trade closes by the end of its own session; tested across DST changes and the London/New York overlap.
- [ ] No simulated position ever exists without a stop.
- [ ] The ladder stop only moves in the trade's favour and only on 15m closes.
- [ ] No trade can lose more than `max_loss_per_trade_pct` at its stop, including fees and slippage; exposure and open-risk caps never exceeded.
- [ ] No trade enters without a closed 15m confirmation candle.
- [ ] Simulated fills are never better than the rules in Section 11 (next-candle open plus slippage, taker fee; stops fill with slippage).
- [ ] Funding charged at every funding time on open positions.
- [ ] Engine restarts mid-trade without losing or duplicating positions.
- [ ] Every signal, filtered signal, missed fill and trade stored with its reasoning.
- [ ] The engine core never reads the system clock or the network (enforced by a test/lint rule).
- [ ] Replaying the same candles with the same config produces identical trade events.
- [ ] Positions and balance rebuilt from the event log match the cached snapshot.
- [ ] The UI stays correct after an SSE disconnect and reconnect.
- [ ] Browsers never read or write Firestore; the server writes only the event log, the snapshot and the lock.
- [ ] Starting on an empty disk restores from the Firestore backup and ends with the same positions and balance as before the restart.
- [ ] A second running copy cannot trade or write while the first holds the lock.

---

## 17. Settled in review (2026-09-28)

1. **Leverage**: 3× (margin only; risk per trade is set by the 1% loss cap).
2. **Starting virtual balance**: $1,000.
3. **Sizing**: flat 10% of equity per trade; score tiers stay off until the data shows the score predicts results.
4. **Entry orders**: market order after a closed 15m confirmation candle; no limit orders.
5. **Weekends**: traded, under the same rules and sessions.
6. **Old UI**: rebuilt from scratch; nothing has to be kept.
7. **Old data**: not needed; Firestore collections and local state files are deleted without export (the Firestore deletion is confirmed separately at the time, since it cannot be undone).
8. **Hosting**: AI Studio (Cloud Run) for now, with the Firestore backup, candle replay and engine lock in Section 4A.4; local runs supported; a VPS later needs only `backup.target: file`.
