// Market-condition filters (ENGINE_PLAN.md Section 8.6, v2 7.5). A confirmed
// signal must pass every enabled filter. Each result carries the values it
// measured, so a filtered signal can always be explained.
import type { Direction } from '../../shared/types';
import { ema, sma } from './analysis/indicators';
import { lastOf, sign, type Context } from './strategy/context';
import { opposingLevels, type Armed, type Confirmation } from './strategy/pullback';

export interface FilterResult {
  name: string;
  pass: boolean;
  detail: Record<string, number | string | null>;
}

const r = (x: number, dp = 4) => (Number.isFinite(x) ? Number(x.toFixed(dp)) : null);

export function runFilters(ctx: Context, a: Armed, conf: Confirmation): FilterResult[] {
  const f = ctx.config.filters;
  const out: FilterResult[] = [];
  if (f.chop.enabled) out.push(...chop(ctx));
  if (f.squeeze.enabled) out.push(squeeze(ctx));
  if (f.stagnation.enabled) out.push(...stagnation(ctx));
  if (f.fakeout.enabled) out.push(fakeout(ctx, a.direction, conf));
  if (f.extension.enabled) out.push(extension(ctx, a.direction));
  if (f.wicks.enabled) out.push(wicks(ctx));
  if (f.room.enabled) out.push(room(ctx, a.direction));
  if (f.funding.enabled) out.push(funding(ctx, a.direction));
  if (f.btc.enabled) out.push(btc(ctx, a.direction));
  return out;
}

function chop(ctx: Context): FilterResult[] {
  const c = ctx.config.filters.chop;
  const h1 = ctx.h1;
  const n = h1.close.length - 1;
  const atr = lastOf(ctx.atr1h);
  const adx = lastOf(ctx.adx1h);
  const ch = lastOf(ctx.chop1h);
  const e20 = ema(h1.close, 20);
  const e50 = ema(h1.close, 50);
  let crosses = 0;
  for (let i = Math.max(1, n - 19); i <= n; i++) {
    const a = e20[i - 1] - e50[i - 1];
    const b = e20[i] - e50[i];
    if (Number.isFinite(a) && Number.isFinite(b) && Math.sign(a) !== Math.sign(b)) crosses++;
  }
  const slope = Math.abs(e20[n] - e20[n - 5]) / atr;
  const win = h1.candles.slice(-c.range_lookback_1h);
  const lo = Math.min(...win.map((x) => x.low));
  const range = ((Math.max(...win.map((x) => x.high)) - lo) / lo) * 100;
  return [
    { name: 'chop.adx', pass: adx >= c.adx_min_1h, detail: { adx: r(adx, 2), min: c.adx_min_1h } },
    { name: 'chop.choppiness', pass: ch <= c.choppiness_max_1h, detail: { choppiness: r(ch, 2), max: c.choppiness_max_1h } },
    { name: 'chop.ema_crosses', pass: crosses <= c.ema_cross_max_1h, detail: { crosses, max: c.ema_cross_max_1h } },
    { name: 'chop.ema20_slope', pass: slope >= c.ema20_slope_min_atr, detail: { slopeAtr: r(slope), min: c.ema20_slope_min_atr } },
    { name: 'chop.range', pass: range >= c.range_min_pct, detail: { rangePct: r(range, 2), min: c.range_min_pct } },
  ];
}

/** Current 1h Bollinger width's percentile rank among the last 100. */
function squeeze(ctx: Context): FilterResult {
  const min = ctx.config.filters.squeeze.bb_width_percentile_min;
  const w = ctx.bbw1h.slice(-100).filter(Number.isFinite);
  const now = lastOf(ctx.bbw1h);
  const pct = w.length ? (w.filter((x) => x < now).length / w.length) * 100 : NaN;
  return { name: 'squeeze', pass: !(pct < min), detail: { widthPercentile: r(pct, 1), min } };
}

function stagnation(ctx: Context): FilterResult[] {
  const c = ctx.config.filters.stagnation;
  const qv = ctx.h1.quoteVolume;
  const out: FilterResult[] = [];
  if (qv.length >= 168) {
    const day = qv.slice(-24).reduce((a, b) => a + b, 0);
    const week = qv.slice(-168).reduce((a, b) => a + b, 0) / 7;
    const ratio = day / week;
    out.push({ name: 'stagnation.volume', pass: ratio >= c.volume_vs_7d_min, detail: { volume24hVs7d: r(ratio, 3), min: c.volume_vs_7d_min } });
  } else {
    out.push({ name: 'stagnation.volume', pass: true, detail: { note: 'under 7 days of 1h data' } });
  }
  const atrRatio = lastOf(ctx.atr1h) / lastOf(sma(ctx.atr1h, 20));
  out.push({ name: 'stagnation.atr', pass: !(atrRatio < c.atr_vs_avg_min), detail: { atrVsAvg: r(atrRatio, 3), min: c.atr_vs_avg_min } });
  return out;
}

/** The trigger candle must close decisively through the CHoCH level, near its extreme, on volume. */
function fakeout(ctx: Context, dir: Direction, conf: Confirmation): FilterResult {
  const c = ctx.config.filters.fakeout;
  const m = ctx.m15;
  const n = m.close.length - 1;
  const s = sign(dir);
  const atr = lastOf(ctx.atr15m);
  const beyond = (s * (m.close[n] - conf.level)) / atr;
  const range = m.high[n] - m.low[n];
  const closePos = range > 0 ? (dir === 'long' ? m.close[n] - m.low[n] : m.high[n] - m.close[n]) / range : 1;
  const oppWick = range > 0 ? (dir === 'long' ? m.high[n] - Math.max(m.open[n], m.close[n]) : Math.min(m.open[n], m.close[n]) - m.low[n]) / range : 0;
  const rv = ctx.rvol15m[n];
  const pass = beyond >= c.close_beyond_atr && closePos >= c.min_close_position && oppWick <= c.max_upper_wick_ratio && rv >= c.min_rvol;
  return {
    name: 'fakeout', pass,
    detail: { closeBeyondAtr: r(beyond, 3), minBeyond: c.close_beyond_atr, closePosition: r(closePos, 3), minClosePosition: c.min_close_position, oppositeWick: r(oppWick, 3), maxWick: c.max_upper_wick_ratio, rvol: r(rv, 2), minRvol: c.min_rvol },
  };
}

function extension(ctx: Context, dir: Direction): FilterResult {
  const max = ctx.config.filters.extension.max_distance_ema20_atr_15m;
  const dist = (sign(dir) * (ctx.price - lastOf(ctx.ema15m20))) / lastOf(ctx.atr15m);
  return { name: 'extension', pass: dist <= max, detail: { distanceAtr: r(dist, 3), max } };
}

/** Sum of wicks over sum of bodies across the last 50 1h candles. */
function wicks(ctx: Context): FilterResult {
  const max = ctx.config.filters.wicks.max_avg_wick_body_ratio_1h;
  let wick = 0;
  let body = 0;
  for (const c of ctx.h1.candles.slice(-50)) {
    body += Math.abs(c.close - c.open);
    wick += c.high - Math.max(c.open, c.close) + Math.min(c.open, c.close) - c.low;
  }
  const ratio = body > 0 ? wick / body : Infinity;
  return { name: 'wicks', pass: ratio <= max, detail: { wickBodyRatio: r(ratio, 3), max } };
}

function room(ctx: Context, dir: Direction): FilterResult {
  const min = ctx.config.filters.room.htf_room_min_pct;
  const s = sign(dir);
  const ahead = opposingLevels(ctx, dir)
    .map((l) => ({ ...l, pct: ((s * (l.price - ctx.price)) / ctx.price) * 100 }))
    .filter((l) => l.pct > 0)
    .sort((a, b) => a.pct - b.pct)[0];
  return {
    name: 'room', pass: !ahead || ahead.pct >= min,
    detail: { nearest: ahead?.name ?? null, nearestPrice: ahead?.price ?? null, roomPct: ahead ? r(ahead.pct, 3) : null, min },
  };
}

/** Longs pay positive funding, shorts negative. */
export function funding(ctx: Context, dir: Direction): FilterResult {
  const max = ctx.config.filters.funding.max_against_pct_8h;
  if (ctx.funding === null) return { name: 'funding', pass: true, detail: { note: 'funding rate unknown' } };
  const against = sign(dir) * ctx.funding * 100;
  return { name: 'funding', pass: against <= max, detail: { fundingPct: r(ctx.funding * 100, 4), againstPct: r(against, 4), max } };
}

function btc(ctx: Context, dir: Direction): FilterResult {
  const c = ctx.config.filters.btc;
  const ch = ctx.btcChange1hPct;
  if (ch === null) return { name: 'btc', pass: true, detail: { note: 'BTC 1h change unknown' } };
  const pass = dir === 'long' ? ch >= c.block_longs_if_btc_1h_below_pct : ch <= c.block_shorts_if_btc_1h_above_pct;
  return { name: 'btc', pass, detail: { btcChange1hPct: r(ch, 3), limit: dir === 'long' ? c.block_longs_if_btc_1h_below_pct : c.block_shorts_if_btc_1h_above_pct } };
}
