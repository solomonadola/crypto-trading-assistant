# Session Engine

A simulated crypto futures trading engine. It reads Binance USDⓈ-M futures
public market data (no account, no API keys), looks for trend pullback setups
inside the Asian, London and New York sessions, and records every signal with
its reasoning. Simulated trades arrive with the simulator (Phase 5).

The design and the build plan are in [ENGINE_PLAN.md](ENGINE_PLAN.md).

## Run it

```bash
npm install
npm run dev          # engine + web page on http://localhost:3000
```

Startup takes under a minute: the scanner picks the coins, then their history
loads. The terminal prints `[feed] live` when it is running, and `[signal]`
lines at 15-minute closes when setups arm, expire, or are taken or filtered.

Production (what AI Studio runs):

```bash
npm run build        # web page into dist/, engine into server.js
npm start            # NODE_ENV=production node server.ts
```

Other commands: `npm test` (engine tests), `npm run lint` (type check).

## Where things are

| Path | What |
|---|---|
| `engine/config/config.yaml` | Every setting: sessions, scanner, setup, filters, risk, costs. Validated on load; a misspelt key stops the engine. |
| `engine/src/core/engine.ts` | The engine core. Its only clock is the close time of the candles it is given. |
| `engine/src/sessions.ts` | Session calendar, entry window, session-end exits. |
| `engine/src/analysis/` | Indicators, market structure, trend states, supply/demand zones. |
| `engine/src/strategy/pullback.ts` | Pullback setup: arming, 15m confirmation, trade plan. |
| `engine/src/filters.ts`, `scoring.ts` | Filters and score applied to confirmed setups. |
| `engine/src/feed/` | Binance public client, live and replay candle feeds, candle store. |
| `engine/src/storage/` | SQLite: append-only trade log, signals. |
| `src/` | The web page. |
| `data/engine/engine.db` | The engine's database (delete it to start fresh). |

## API

| Address | Shows |
|---|---|
| `/api/status` | Engine clock, feed state, current session and entry window |
| `/api/scanner` | Coins selected, and why the rest were dropped |
| `/api/armed` | Setups waiting for 15m confirmation |
| `/api/signals` | Recent signals with reasoning (`?status=`, `?symbol=`, `?limit=`) |
| `/api/signals/summary` | Counts by status and reason (`?hours=24`) |
| `/api/analysis/:symbol` | Trend per timeframe, trend state, zones |
| `/api/candles/:symbol` | Stored candles (`?tf=15m&limit=300`) |

## Environment

Optional, in `.env.local`: `PORT` (default 3000), `ENGINE_DB_PATH`,
`ENGINE_CONFIG`. See `.env.example`.

## Not built yet

Simulated fills and positions (Phase 5), Firestore backup so AI Studio restarts
keep the data (Phase 6), login and the dashboard (Phases 6-7). Until the
backup exists, a restart on AI Studio starts from an empty database.
