# Trading Companion — Project Brief

A brief for designing a **new, standalone app**: a trading companion that helps one
discretionary crypto trader execute their own setups with discipline. The trader
brings the judgment; the companion brings the rules, the sizing, the limits and the
record. It is not an auto-trading bot.

This brief carries forward what was learned (and measured) in an earlier project,
CryptoStudyLab, so the new design starts from evidence rather than assumptions.

---

## 1. The problem

The trader's setups work for them when they follow them. What goes wrong is
execution under emotion:

- entering trades that are not their setup (FOMO, boredom)
- oversizing when confident, undersizing after a loss
- moving stops further away, or closing winners early out of fear
- revenge trading after a loss; overtrading after a win
- no reliable record of what was traded, why, and in what state of mind

The companion exists to remove those failure points without removing the trader's
judgment.

## 2. Goals and non-goals

**Goals**
1. Every trade is checked against the trader's own rules before entry.
2. Every trade is sized for a fixed risk, calculated, never guessed.
3. Limits (trades per day, daily loss, loss streaks) are enforced, not suggested.
4. Every trade is journaled with its reason and the trader's emotional state.
5. The trader can see, over weeks, which setups and which emotional states make or
   lose money.
6. Optional later: the companion places orders on the trader's click.

**Non-goals**
- No fully automatic trading in version 1.
- No promised returns or return targets. (See section 9.)
- No high-frequency or scalping strategies. (Measured: they lose. See section 8.)
- No leverage by default.

## 3. Principles

1. **The trader decides; the companion checks.** It can block a trade that breaks a
   hard rule, and it must say why in one plain sentence.
2. **Rules are data, not code.** The trader tunes limits and checklist items in the
   app, without a developer.
3. **Nothing touches money in phase 1.** The trader places orders on the exchange;
   the companion plans, checks, sizes and records.
4. **Every number shown is computed from real data.** No placeholder statistics, no
   invented results, no "expected" returns presented as measured ones.
5. **Calm by design.** Short messages, no hype, no flashing gains. The interface
   should lower arousal, not raise it.

## 4. Users and context

- One trader (single user), trading crypto on Binance.
- Timeframes: the 4h chart sets direction and zones; the 1h times entries.
- Universe: coins with at least **$50M traded in the last 24h** — majors, alts and
  meme coins.
- Account size: small to start (the backtests used $100).

## 5. Features (version 1)

### 5.1 Pre-trade checklist
The trader picks a coin and a direction. The companion shows each rule as pass or
fail:

| Check | Automatic? | Hard rule (blocks) or soft (warns) |
|---|---|---|
| 24h volume at least $50M | automatic | hard |
| BTC regime allows the direction (BTC above its 50-day average for longs, below for shorts) | automatic | hard |
| 4h trend matches (higher highs and higher lows, price above 4h 50 EMA; mirrored for shorts) | automatic | hard |
| A fresh 4h demand zone (supply for shorts) is being tested | automatic | soft |
| Inducement swept on the way into the zone (see 7.3) | automatic | soft |
| At least 1.5R of room to the next key level | automatic | hard |
| Trades today under the daily cap | automatic | hard |
| No cooldown active (loss streak, daily loss, post-loss wait) | automatic | hard |
| Trader's own items (e.g. "chart is clean", "no major news") | trader ticks | configurable |

A failed hard rule disables the "plan trade" action and states the reason, e.g.
"No 4h uptrend: this is not your setup."

### 5.2 Position sizing
The trader enters entry and stop (or accepts the suggested stop just beyond the
zone). The companion computes:
- position size so that hitting the stop loses exactly the chosen risk (default 1%
  of equity), fees included
- the target at the next key level (see 7.4), and the R multiple it represents
- a warning if the stop is under 0.5% or over 10% of price

### 5.3 Guardrails (the emotional part)
All configurable; defaults below.

| Guardrail | Default |
|---|---|
| Risk per trade | 1% of equity |
| Maximum trades per day | 5 |
| Daily loss limit | −3% of equity, then locked until the next UTC day |
| Loss streak | 3 losses in a row, then a 24h cooldown |
| Wait after any loss | 30 minutes |
| Open positions at once | 5, at most 2 meme coins |
| Stop moved further from entry | warning, logged as a rule break |
| Adding to a losing position | blocked |

Locks cannot be dismissed from inside the app; they expire on schedule. Changing a
limit takes effect the next day, so a limit cannot be loosened in the heat of the
moment.

### 5.4 During a trade
- Alerts when price nears the key level or the stop.
- A single reminder line of the plan ("Plan: hold to $X. Stop at $Y.").
- Closing early is allowed but asks for a one-word reason, which is journaled.

### 5.5 Journal and review
Per trade: coin, side, setup, entry, stop, target, size, result in $ and R, exit
reason, and the trader's emotion before entry and after exit (calm / confident /
FOMO / fearful / revenge / bored), plus an optional note.

Review screens:
- results by setup, by coin, by weekday and hour, and **by emotion**
- rule adherence: share of trades that passed every hard and soft check
- equity curve and drawdown from the journal

### 5.6 Setup alerts (optional in v1)
A scanner runs the strategy rules in section 7 across the universe and notifies the
trader of candidates. It only suggests; the trader decides.

## 6. Phases

1. **Paper practice.** Everything in section 5, with trades recorded against live
   prices but no real orders. Suggested: two weeks.
2. **Real trades, placed by the trader.** The trader places orders on Binance
   themselves and records them in the companion (manually, or read back from the
   exchange with a read-only API key).
3. **Click-to-execute (optional).** The companion places the planned order on the
   trader's confirmation, using an API key with trading enabled and withdrawals
   disabled. Only after phase 2 has been used for some weeks.

## 7. The strategy the checklist is built around

"**Supply & Demand Trend Pullback**": trade with the 4h trend, enter when price
pulls back into a fresh zone and shows it held. Long side below; the short side is
the same rules mirrored.

### 7.1 Direction (4h)
- BTC above its 50-day simple moving average (below, for shorts).
- The coin's 4h chart: the last two swing highs rising and the last two swing lows
  rising (swings found with a 2-candle lookback), and price above the 4h 50 EMA.

### 7.2 Demand zone (4h)
- A quiet base: one or two 4h candles whose range is at most 1× the 4h ATR(14).
- Followed by a strong move away: the highest close within the next three candles
  is at least 2× ATR above the base's close.
- Zone = from the base's low to the top of its candle bodies.
- **Fresh**: no close below the zone since the move, and not revisited before the
  current pullback. Looked for within the last 90 4h candles (15 days).

### 7.3 Inducement check (the one filter that clearly helped)
Skip the zone if either is true:
1. The pullback reached the zone **without sweeping an internal 1h swing low**
   formed above the zone on the way down. A zone reached directly is likely the
   inducement itself.
2. An **unswept 4h swing low lies within 1 ATR below the zone**. Price tends to run
   that liquidity, and the stop with it.

### 7.4 Entry, stop, exit
- Entry (1h): price dipped into the zone within the last 12 hours, never closed
  below it, and the last 1h candle closed green above the zone's midpoint. Do not
  chase: skip if price is already more than 0.5 ATR above the zone.
- Stop: 0.1 ATR below the zone. The stop never moves.
- Exit: at the **key level**, the high the pullback came from, or the bottom of the
  nearest fresh supply zone above if that comes first. Skip the trade if the key
  level is less than 1.5R away. Close at market after 72h if neither is hit.

### 7.5 Measured results (backtest)
100 Binance coins, 5-minute candles, Sep 2024 to Aug 2026, $100 start, 1% risk per
trade, longs only, costs charged on every fill.

| Version | Trades | Win rate | Net | Profit factor | Max drawdown |
|---|---|---|---|---|---|
| Base rules, 2R target | 112 | 33.9% | −12.8% | 0.77 | −23.7% |
| + inducement check, 2R target | 42 | 40.5% | +1.9% | 1.10 | −7.1% |
| + inducement check, exit at key level (spot fees 0.15%/side) | 42 | 33.3% | **+8.1%** | **1.40** | −7.9% |
| same, futures fees with limit entries (0.07%/side) | 42 | 35.7% | **+10.5%** | **1.54** | −7.6% |

Winners averaged +3.25R and losers −1.19R. Both years were positive (+$5.25 in the
first, +$2.89 in the second on 11 trades).

**Caveats**: 42 trades is a small sample. The coin list was taken from coins
trading today (delisted coins are missing). It has not yet been tested on
2022–2023 data. Treat it as promising, not proven.

## 8. What was tested and did NOT work (do not rebuild these)

| Idea | Result |
|---|---|
| Shorting with the mirrored rules | Shorts won 27–29%; they lost even with the inducement check. Keep shorts off until tested differently. |
| Stacking every filter for "perfect" setups (BTC rising, breadth, relative strength, BOS zones) | Half the trades, lower win rate (27%), −2.9%. Perfect setups cluster in time and act as one bet. |
| Confirming the turn with a 1h swing-high break | ~1 trade a month, 22% win rate; entries came too late. |
| 1h trailing exit instead of a key-level target | Worse than a fixed key-level exit. |
| Intraday (1h zones, 15m entry) | 214 trades, −23%. Lost before costs. |
| Scalping (15m zones, 5m entry, quick exits) | 457 trades in a year, −33.6% even at futures fees. Fast-chart zones are noise; costs eat small targets. |
| Frequent quick targets (e.g. +2% five times a day) | Without a measured edge, the chance of +2% before the stop roughly offsets the loss size; fees make it negative. |
| Lower volume floor ($20M instead of $50M) | Worse (−34%). |
| The earlier bot's own entries | 24% win rate, −30% over two years. |

## 9. Honesty standards (required)

The earlier project was misled by documents that presented invented numbers as
backtest results (claimed +38% and +131% annual returns, with statistics that did
not agree with each other and code files that did not exist). The new project must:

1. Show only numbers computed from real data, with the file or run they came from.
2. Include costs (fees, spread, slippage) in every performance figure.
3. Judge any strategy on data it was not designed on.
4. Require roughly 100+ trades before calling a result reliable.
5. Never present a return target as a forecast. Realistic good outcomes for a
   systematic crypto strategy are tens of percent per year, not per week; 30–50% a
   week compounds to hundreds of thousands of times the account per year and is not
   achievable without ruinous risk.

## 10. Technical notes (suggestions, not requirements)

- **Market data**: Binance public REST (`/api/v3/ticker/24hr`, `/api/v3/klines`)
  for live prices and candles; `data.binance.vision` monthly 5-minute kline archives
  for history. Futures equivalents exist if futures are chosen.
- **Strategy logic as pure functions** (candles in, decision out), shared by the
  live checklist, the setup scanner and any backtest, so they cannot disagree.
- **Storage**: a local database (e.g. SQLite) for the journal and settings, with
  export to CSV/JSON. The journal is the most valuable asset; back it up.
- **Exchange keys** (phase 2–3): never store in the browser; server-side only,
  withdrawals disabled, IP-restricted where possible.
- **Time**: all rules in UTC; the daily limits reset at 00:00 UTC.
- **Testing**: the guardrails (caps, cooldowns, locks) need automated tests; they
  are the product.
- The earlier project's backtest engine and strategy code
  (`src/strategies/trendPullbackDemand.ts`, `src/backtest/`) can be reused or
  ported as the reference implementation of section 7.

## 11. Decisions still open

1. **Paper first, or real trades from day one?** Suggested: two weeks of paper.
2. **Limits**: are the defaults in 5.3 right for this trader?
3. **Spot or futures?** Suggested: futures without leverage — lower fees
   (0.02% maker / 0.05% taker vs about 0.10% spot) and shorts possible later.
4. **Platform**: web app, desktop app, or mobile? Where will alerts arrive
   (browser, phone, Telegram)?
5. **Which of the trader's own checklist items** should be added beyond section 7?
6. **Setup alerts in v1, or later?**

## 12. What a good design document should produce

- Screens and flows: checklist → plan → (place order) → monitor → close → journal →
  review.
- Exact behavior of every guardrail, including edge cases (a trade open across
  midnight, a limit changed mid-day, partial closes).
- Data model: trade, plan, checklist result, journal entry, settings, lock.
- The strategy rules from section 7 written as testable specifications.
- A test plan for guardrails and sizing.
- A phase-by-phase delivery plan with what "done" means for each phase.
