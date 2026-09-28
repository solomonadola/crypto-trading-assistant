# Session Engine

A simulated crypto futures trading engine. It reads Binance USDⓈ-M futures
public market data (no account, no API keys), looks for trend pullback setups
inside the Asian, London and New York sessions, and records every signal with
its reasoning. Taken signals become simulated trades with fees, slippage and
funding, managed by stops, a profit ladder, early exits and session ends.

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

Optional, in `.env.local` locally or as environment variables on the host (see `.env.example`):

| Variable | Default | What |
|---|---|---|
| `ALLOWED_EMAILS` | unset (no sign-in) | Google accounts that may sign in. **Set this on AI Studio**, or anyone with the link can use the controls. |
| `BACKUP_TARGET` | `firestore` in production, `file` in development | Where the trade log is backed up. |
| `ENGINE_NAMESPACE` | `hosted` in production, `local` in development | Keeps a local copy's backup apart from the hosted one. |
| `PORT` | 3000 | |
| `ENGINE_DB_PATH` | `data/engine/engine.db` | |
| `ENGINE_CONFIG` | `engine/config/config.yaml` | |

## Running on AI Studio

1. Set `ALLOWED_EMAILS` to your Google account.
2. In the Firebase console of this project: enable **Google** under
   Authentication → Sign-in method, and make sure the app's domain is listed
   under Authorized domains.
3. Deploy. `npm run build` then `npm start` run the engine and the dashboard.
4. Check the dashboard's sidebar: `backup: Firestore (hosted)` means the trade
   log is backed up and survives restarts. `backup off` in the header means
   the server cannot reach Firestore with its credentials; it then keeps only a
   local file, which Cloud Run loses on restart.
5. Deploy `firestore.rules` (browsers get no access; the server's Admin SDK
   is not affected by rules).
6. Keep it awake: one instance, and if possible a minimum of one. Otherwise an
   uptime monitor calling `/api/health` every 5 minutes. Time it was asleep is
   caught up on the next start.

Only one copy trades at a time: the running engine holds a lock in Firestore;
another copy with the same namespace shows data but does not trade
(`standby` in the header).
