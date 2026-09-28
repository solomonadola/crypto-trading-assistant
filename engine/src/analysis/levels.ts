// Key levels and a suggested trade plan for one coin: an aid for reading the
// market by hand, separate from the engine's own entry rules. Pure.
//
// Levels come from everything the analysis knows (zones, fair value gaps and
// inverse gaps, volume profile POC/VAH/VAL/HVN, swing points, protected
// levels, the previous day's range, VWAP, EMAs, the 0.5-0.618 retracement,
// old resistance/support). Levels within half a 1h ATR of each
// other are merged into one, so agreement shows up as strength.
//
// The plan follows the trend state: long when the long side is strong or in a
// pullback, short likewise, otherwise no plan. Entry is the strongest support
// cluster (long) within reach below the price, the stop beyond it, and the
// targets the next resistance clusters above.
import type { Direction, KeyLevel, TradeIdea, TradeIdeaTarget } from '../../../shared/types';
import { fibLevel } from './indicators';
import { impulseLeg, flippedLevels } from '../strategy/pullback';
import { lastOf, sign, type Context } from '../strategy/context';

interface RawLevel {
  price: number;
  source: string;
  /** How much the source counts: zones and 4h levels weigh more. */
  weight: number;
  /** The price band a zone covers. */
  band?: [number, number];
}

/**
 * Sources that are fixed structure. A target needs at least one: a Fibonacci
 * retracement of the leg being pulled back from, an EMA or the VWAP says where
 * a pullback may stop, not where a move will.
 */
const isStructural = (source: string) => !/^fib |EMA|VWAP/.test(source);

/** How far below (long) the price an entry area may be, in 1h ATRs. */
const MAX_ENTRY_ATR = 3;
const STRONG_STATES = new Set(['strong', 'pullback']);

function rawLevels(ctx: Context): RawLevel[] {
  const out: RawLevel[] = [];
  const add = (price: number, source: string, weight = 1, band?: [number, number]) => {
    if (Number.isFinite(price) && price > 0) out.push({ price, source, weight, band });
  };
  for (const z of ctx.analysis.zones) {
    add(z.type === 'demand' ? z.high : z.low, `${z.status} ${z.type} zone`, z.status === 'fresh' ? 3 : 2, [z.low, z.high]);
  }
  for (const g of ctx.analysis.fvgs ?? []) {
    const name = `${g.tf} ${g.side} ${g.inverse ? 'IFVG' : 'FVG'}`;
    add((g.top + g.bottom) / 2, name, g.tf === '15m' ? 1 : 2, [g.bottom, g.top]);
  }
  for (const p of ctx.analysis.profiles ?? []) {
    add(p.poc, `${p.name} POC`, 2);
    add(p.vah, `${p.name} VAH`);
    add(p.val, `${p.name} VAL`);
    for (const h of p.hvn.slice(0, 2)) add(h, `${p.name} HVN`);
  }
  for (const [tf, pivots, n, weight] of [['1h', ctx.pivots1h, 4, 1], ['4h', ctx.pivots4h, 3, 2]] as const) {
    for (const p of pivots.filter((x) => x.type === 'high').slice(-n)) add(p.price, `${tf} swing high`, weight);
    for (const p of pivots.filter((x) => x.type === 'low').slice(-n)) add(p.price, `${tf} swing low`, weight);
  }
  for (const tf of ['4h', '1h'] as const) {
    const st = ctx.analysis.structure[tf];
    if (st?.protectedLow) add(st.protectedLow, `${tf} protected low`, 2);
    if (st?.protectedHigh) add(st.protectedHigh, `${tf} protected high`, 2);
  }
  const dayStart = Math.floor(ctx.t / 86_400_000) * 86_400_000;
  const yesterday = ctx.h1.candles.filter((c) => c.openTime >= dayStart - 86_400_000 && c.openTime < dayStart);
  if (yesterday.length) {
    add(Math.max(...yesterday.map((c) => c.high)), 'previous day high', 2);
    add(Math.min(...yesterday.map((c) => c.low)), 'previous day low', 2);
  }
  add(lastOf(ctx.vwap15m), 'daily VWAP');
  for (const n of [20, 50]) add(lastOf(ctx.ema1h[n] ?? []), `1h EMA${n}`);
  for (const dir of ['long', 'short'] as Direction[]) {
    const leg = impulseLeg(ctx.pivots1h, dir);
    if (leg) {
      add(fibLevel(leg.from.price, leg.to.price, 0.5), `fib 0.5 of 1h ${dir === 'long' ? 'up' : 'down'} leg`);
      add(fibLevel(leg.from.price, leg.to.price, 0.618), `fib 0.618 of 1h ${dir === 'long' ? 'up' : 'down'} leg`);
    }
    for (const p of flippedLevels(ctx, dir)) add(p, dir === 'long' ? 'old resistance' : 'old support');
  }
  return out;
}

/**
 * Merges levels into clusters no wider than `tol`: a level joins a cluster
 * only if it is within `tol` of the cluster's first level. (Comparing with
 * the last level instead lets a dense run of levels chain into one cluster
 * spanning the whole chart.)
 */
export function clusterLevels(raw: RawLevel[], price: number, tol: number): (KeyLevel & { band: [number, number] })[] {
  const sorted = [...raw].sort((a, b) => a.price - b.price);
  const groups: RawLevel[][] = [];
  for (const r of sorted) {
    const g = groups[groups.length - 1];
    if (g && r.price - g[0].price <= tol) g.push(r); else groups.push([r]);
  }
  return groups.map((g) => {
    const w = g.reduce((s, r) => s + r.weight, 0);
    const p = g.reduce((s, r) => s + r.price * r.weight, 0) / w;
    const lows = g.map((r) => r.band?.[0] ?? r.price);
    const highs = g.map((r) => r.band?.[1] ?? r.price);
    return {
      price: p,
      kind: p <= price ? 'support' : 'resistance',
      sources: [...new Set(g.map((r) => r.source))],
      strength: w,
      distancePct: ((p - price) / price) * 100,
      band: [Math.min(...lows), Math.max(...highs)] as [number, number],
    };
  });
}

export function tradeIdea(ctx: Context, armedDirections: Direction[]): TradeIdea {
  const cfg = ctx.config;
  const price = ctx.price;
  const atr = lastOf(ctx.atr1h);
  const tol = cfg.pullback.tolerance_atr * atr;
  const levels = clusterLevels(rawLevels(ctx), price, tol);
  const a = ctx.analysis;

  const long = STRONG_STATES.has(a.long.state);
  const short = STRONG_STATES.has(a.short.state);
  const bias: TradeIdea['bias'] = long && !short ? 'long' : short && !long ? 'short' : 'none';
  const biasReason = bias === 'none'
    ? `No clear trend: long side ${a.long.state}, short side ${a.short.state}`
    : `${bias === 'long' ? 'Long' : 'Short'} side is ${a[bias].state}${a[bias].emaAligned ? ', 4h close on the right side of EMA50' : ', but the 4h close is on the wrong side of EMA50'}`;

  const base: TradeIdea = {
    symbol: ctx.symbol, asOf: ctx.t, price, atr1h: atr, bias, biasReason,
    trend: { '4h': a.structure['4h']?.trend ?? null, '1h': a.structure['1h']?.trend ?? null, '15m': a.structure['15m']?.trend ?? null },
    longState: a.long.state, shortState: a.short.state,
    levels: levels.map(({ band: _band, ...l }) => l).sort((x, y) => y.price - x.price),
    plan: null,
  };
  if (bias === 'none' || !Number.isFinite(atr)) return base;

  const s = sign(bias);
  // Entry: the strongest cluster on the near side of the price, within reach (the one containing the price counts).
  const reach = MAX_ENTRY_ATR * atr;
  // Never enter a long from a supply zone or a bearish gap (or a short from their mirrors): that level is the other side's.
  const otherSide = bias === 'long' ? /supply zone$|bearish I?FVG$/ : /demand zone$|bullish I?FVG$/;
  const candidates = levels.filter((l) => !l.sources.some((src) => otherSide.test(src)) && (bias === 'long'
    ? l.price <= price + tol && l.band[1] >= price - reach
    : l.price >= price - tol && l.band[0] <= price + reach));
  const entryLevel = candidates.sort((x, y) => y.strength - x.strength || Math.abs(x.distancePct) - Math.abs(y.distancePct))[0];
  if (!entryLevel) {
    return { ...base, plan: { direction: bias, status: 'no_level', entryLow: null, entryHigh: null, entry: null, stop: null, riskPct: null, targets: [], meetsRules: false, note: `No support${bias === 'short' ? '/resistance' : ''} cluster within ${MAX_ENTRY_ATR} × 1h ATR to enter from; wait for structure to form.` } };
  }
  const entryLow = Math.min(entryLevel.band[0], entryLevel.price) - tol / 2;
  const entryHigh = Math.max(entryLevel.band[1], entryLevel.price) + tol / 2;
  const entry = bias === 'long' ? Math.min(price, (entryLow + entryHigh) / 2) : Math.max(price, (entryLow + entryHigh) / 2);

  // Stop beyond the entry area, or beyond a swing point just past it, plus the configured buffer.
  const far = bias === 'long' ? entryLow : entryHigh;
  const swingType = bias === 'long' ? 'low' : 'high';
  const nearSwing = [...ctx.pivots1h, ...ctx.pivots15m]
    .filter((p) => p.type === swingType && s * (far - p.price) >= 0 && Math.abs(far - p.price) <= atr)
    .map((p) => p.price);
  const anchor = bias === 'long' ? Math.min(far, ...nearSwing) : Math.max(far, ...nearSwing);
  const stop = anchor - s * cfg.exits.stop_buffer_atr * atr;
  const risk = s * (entry - stop);

  const costR = (2 * (cfg.sim.taker_fee_pct + cfg.sim.slippage_pct) / 100) * entry / risk;
  const targets: TradeIdeaTarget[] = levels
    .filter((l) => s * (l.price - entry) > 0.5 * risk && l !== entryLevel && l.sources.some(isStructural))
    .sort((x, y) => s * (x.price - y.price))
    .slice(0, 3)
    .map((l, i) => ({ label: `TP${i + 1}`, price: l.price, sources: l.sources, r: (s * (l.price - entry)) / risk - costR }));
  if (!targets.length) targets.push({ label: 'TP1', price: entry + s * 2 * risk, sources: ['2R (no level ahead)'], r: 2 - costR });

  const inZone = price >= entryLow && price <= entryHigh;
  const riskPct = (risk / entry) * 100;
  const status: NonNullable<TradeIdea['plan']>['status'] = armedDirections.includes(bias) ? 'armed' : inZone ? 'in_zone' : 'wait';
  const meetsRules = riskPct <= cfg.exits.max_stop_pct && targets[0].r >= cfg.exits.min_rr;
  const noteParts = [
    status === 'armed' ? 'The engine has armed this setup and waits for a 15m confirmation close.'
      : status === 'in_zone' ? 'Price is in the entry area now; wait for a 15m close back in the trend direction before entering.'
      : `Wait for price to ${bias === 'long' ? 'pull back down' : 'rally up'} into the entry area.`,
    riskPct > cfg.exits.max_stop_pct ? `Stop is ${riskPct.toFixed(2)}% away, beyond the ${cfg.exits.max_stop_pct}% limit.` : null,
    targets[0].r < cfg.exits.min_rr ? `First target is ${targets[0].r.toFixed(2)}R, under the ${cfg.exits.min_rr}R minimum.` : null,
  ].filter(Boolean);
  return {
    ...base,
    plan: { direction: bias, status, entryLow, entryHigh, entry, stop, riskPct, targets, meetsRules, note: noteParts.join(' ') },
  };
}
