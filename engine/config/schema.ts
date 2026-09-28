// Validates config.yaml. Objects are strict: a misspelt key is an error, not a
// silently ignored setting.
import { z } from 'zod';

const pct = z.number().min(0).max(100);
const positive = z.number().positive();
const posInt = z.number().int().positive();
const timeframe = z.enum(['1m', '15m', '1h', '4h']);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected "HH:MM"');
const onOff = <T extends z.ZodRawShape>(shape: T) => z.object({ enabled: z.boolean(), ...shape }).strict();

const session = z.object({
  name: z.string().min(1),
  tz: z.string().refine((tz) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }, 'unknown time zone'),
  open: hhmm,
  close: hhmm,
}).strict();

export const configSchema = z.object({
  market: z.literal('futures'),
  leverage: z.number().min(1).max(20),
  starting_balance_usdt: positive,
  quote: z.literal('USDT'),

  feed: z.object({
    rest_base: z.string().url(),
    timeframes: z.array(timeframe).min(1),
    history: z.object({ '1m': posInt, '15m': posInt, '1h': posInt, '4h': posInt }).strict(),
    watch_symbols: z.array(z.string().regex(/^[A-Z0-9]+USDT$/)).min(1),
    poll_delay_ms: z.number().int().min(0).max(30_000),
    concurrency: z.number().int().min(1).max(32),
    stall_after_sec: posInt,
    request_timeout_ms: posInt,
    max_retries: z.number().int().min(0).max(10),
    clock_sync_min: posInt,
  }).strict(),

  storage: z.object({
    path: z.string().min(1),
    candle_retention_days: z.object({ '1m': posInt, '15m': posInt, '1h': posInt, '4h': posInt }).strict(),
  }).strict(),

  backup: z.object({
    target: z.enum(['firestore', 'file']),
    namespace: z.string().regex(/^[a-z0-9_-]+$/),
    events_flush_sec: posInt,
    snapshot_every_min: posInt,
    lock_lease_sec: posInt,
  }).strict(),

  scanner: z.object({
    min_quote_volume_24h: z.number().min(0),
    min_atr_pct_1h: pct,
    max_change_24h_pct: z.number().positive(),
    exclude: z.array(z.string()),
    blacklist: z.array(z.string()),
    rescan_interval_sec: posInt,
    max_symbols: posInt,
  }).strict(),

  sessions: z.object({
    enabled: z.boolean(),
    weekdays_only: z.boolean(),
    list: z.array(session).min(1),
    entry_delay_min: z.number().int().min(0),
    no_entry_before_end_min: z.number().int().min(0),
    exit_at_session_end: z.boolean(),
    skip_minutes_around_funding: z.number().int().min(0),
  }).strict(),

  timeframes: z.object({ bias: timeframe, setup: timeframe, trigger: timeframe, exits: timeframe }).strict(),

  trend: z.object({
    swing_lookback: posInt,
    ema_fast: posInt,
    ema_slow: posInt,
    use_protected_low: z.boolean(),
    allowed_states: z.array(z.enum(['strong', 'pullback'])).min(1),
  }).strict(),

  zones: z.object({
    base_max_candles: posInt,
    base_body_max_atr: positive,
    impulse_body_min_atr: positive,
    impulse_min_rvol: positive,
    max_touches: z.number().int().min(0),
    lookback_candles: posInt,
    max_zone_width_pct: pct,
  }).strict(),

  pullback: z.object({
    ema_levels: z.array(posInt).min(1),
    fib_min: z.number().min(0).max(1),
    fib_max: z.number().min(0).max(1),
    min_confluence: posInt,
    armed_expiry_hours: positive,
    tolerance_atr: positive,
    breakout_levels: posInt,
  }).strict(),

  breakout: onOff({
    lookback_high_candles: posInt,
    min_rvol: positive,
    rsi_min: pct,
    rsi_max: pct,
    min_range_candles_1h: posInt,
  }),

  trigger: z.object({
    confirmations_min: z.number().int().min(0),
    rsi_period: posInt,
    rvol_min: positive,
    rejection_wick_body: positive,
    lookback_candles: posInt,
  }).strict(),

  filters: z.object({
    chop: onOff({ adx_min_1h: z.number().min(0), choppiness_max_1h: pct, ema_cross_max_1h: z.number().int().min(0), ema20_slope_min_atr: z.number().min(0), range_lookback_1h: posInt, range_min_pct: pct }),
    squeeze: onOff({ bb_width_percentile_min: pct }),
    stagnation: onOff({ volume_vs_7d_min: z.number().min(0), atr_vs_avg_min: z.number().min(0) }),
    fakeout: onOff({ close_beyond_atr: z.number().min(0), min_close_position: z.number().min(0).max(1), max_upper_wick_ratio: z.number().min(0).max(1), min_rvol: z.number().min(0), failed_breakout_candles: posInt }),
    extension: onOff({ max_distance_ema20_atr_15m: positive }),
    wicks: onOff({ max_avg_wick_body_ratio_1h: positive }),
    room: onOff({ htf_room_min_pct: pct }),
    funding: onOff({ max_against_pct_8h: z.number().min(0) }),
    btc: onOff({ block_longs_if_btc_1h_below_pct: z.number(), block_shorts_if_btc_1h_above_pct: z.number() }),
  }).strict(),

  scoring: z.object({ min_score: z.number().int().min(0) }).strict(),

  allocation: z.object({
    sizing: z.enum(['flat', 'tiers']),
    flat_capital_pct: pct,
    tiers: z.array(z.object({ min_score: z.number().int().min(0), capital_pct: pct }).strict()).min(1),
    max_open_trades: posInt,
    max_total_exposure_pct: z.number().positive().max(1000),
    max_loss_per_trade_pct: pct,
    max_open_risk_pct: pct,
    max_correlated_trades: posInt,
    correlation_groups: z.record(z.string(), z.array(z.string())),
    max_pct_of_1h_volume: pct,
  }).strict(),

  exits: z.object({
    mode: z.enum(['fixed', 'partial_ladder', 'ladder']),
    fixed_target_pct: positive,
    partial_at_pct: positive,
    partial_close_pct: pct,
    stop_buffer_atr: z.number().min(0),
    max_stop_pct: positive,
    min_rr: z.number().min(0),
    breakeven_fee_buffer_pct: z.number().min(0),
    ladder: z.array(z.object({ trigger_pct: positive, lock_pct: z.number() }).strict()).min(1),
    beyond_last_step: z.object({ lock_fraction_of_peak: z.number().min(0).max(1), or_swing_15m: z.boolean() }).strict(),
    step_on: z.literal('close_15m'),
    min_gap_atr_15m: z.number().min(0),
    time_stop_hours: positive,
    time_stop_min_progress_pct: z.number().min(0),
    early_exit: z.object({
      on_15m_counter_choch: z.enum(['tighten', 'close_half', 'ignore']),
      on_1h_protected_level_break: z.enum(['close', 'ignore']),
      on_4h_state_change: z.enum(['close', 'ignore']),
      on_btc_move_1h_pct: positive,
      on_btc_move_action: z.enum(['tighten', 'close']),
    }).strict(),
  }).strict(),

  risk: z.object({
    max_trades_per_symbol_per_day: posInt,
    daily_loss_limit_pct: pct,
    max_drawdown_kill_pct: pct,
    cooldown_after_loss_min: z.number().int().min(0),
    losing_streak_size_cut: z.object({ after_losses: posInt, size_mult: z.number().gt(0).max(1), reset_after_wins: posInt }).strict(),
  }).strict(),

  sim: z.object({
    taker_fee_pct: z.number().min(0).max(1),
    slippage_pct: z.number().min(0).max(5),
    charge_funding: z.boolean(),
  }).strict(),
}).strict()
  .superRefine((c, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (c.pullback.fib_min >= c.pullback.fib_max) issue(['pullback', 'fib_min'], 'must be below fib_max');
    if (c.breakout.rsi_min >= c.breakout.rsi_max) issue(['breakout', 'rsi_min'], 'must be below rsi_max');
    if (c.trend.ema_fast >= c.trend.ema_slow) issue(['trend', 'ema_fast'], 'must be below ema_slow');
    if (!c.feed.timeframes.includes('1m')) issue(['feed', 'timeframes'], '1m is required: stops and session exits run on it');
    c.exits.ladder.forEach((step, i) => {
      if (step.lock_pct >= step.trigger_pct) issue(['exits', 'ladder', i, 'lock_pct'], 'must be below trigger_pct');
      const prev = c.exits.ladder[i - 1];
      if (prev && (step.trigger_pct <= prev.trigger_pct || step.lock_pct <= prev.lock_pct)) {
        issue(['exits', 'ladder', i], 'steps must rise in both trigger_pct and lock_pct');
      }
    });
    c.allocation.tiers.forEach((tier, i) => {
      const prev = c.allocation.tiers[i - 1];
      if (prev && tier.min_score <= prev.min_score) issue(['allocation', 'tiers', i, 'min_score'], 'tiers must be in rising score order');
    });
    c.sessions.list.forEach((s, i) => {
      if (s.open === s.close) issue(['sessions', 'list', i], 'open and close must differ');
    });
    if (new Set(c.sessions.list.map((s) => s.name)).size !== c.sessions.list.length) issue(['sessions', 'list'], 'session names must be unique');
  });

export type EngineConfig = z.infer<typeof configSchema>;
