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
import type { ChecklistItem, Direction, KeyLevel, TradeIdea, TradeIdeaTarget, WatchLevel } from '../../../shared/types';
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

export interface IdeaInputs {
  /** Directions the engine has armed a setup for on this coin. */
  armed: Direction[];
  /** Why new trades may not open now (session rules), or null if they may. */
  entryBlock: string | null;
}

export function tradeIdea(ctx: Context, inputs: IdeaInputs): TradeIdea {
  const idea = planIdea(ctx, inputs.armed);
  return { ...idea, checklist: checklist(ctx, idea, inputs.entryBlock), watch: watchLevels(idea) };
}

type Planned = Omit<TradeIdea, 'checklist' | 'watch'>;

function planIdea(ctx: Context, armedDirections: Direction[]): Planned {
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

  const checklistFor: Direction = bias !== 'none' ? bias : a.structure['4h']?.trend === 'down' ? 'short' : 'long';
  const base: Planned = {
    symbol: ctx.symbol, asOf: ctx.t, price, atr1h: atr, bias, biasReason,
    trend: { '4h': a.structure['4h']?.trend ?? null, '1h': a.structure['1h']?.trend ?? null, '15m': a.structure['15m']?.trend ?? null },
    longState: a.long.state, shortState: a.short.state, checklistFor,
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

/** The engine's conditions for a trade in the checklist's direction, each met, not met, or still pending. */
function checklist(ctx: Context, idea: Planned, entryBlock: string | null): ChecklistItem[] {
  const cfg = ctx.config;
  const dir = idea.checklistFor;
  const want = dir === 'long' ? 'up' : 'down';
  const s = sign(dir);
  const a = ctx.analysis;
  const meter = a.trendMeter;
  const plan = idea.plan && idea.plan.direction === dir && idea.plan.entry !== null ? idea.plan : null;
  const st = (tf: '1h' | '15m') => meter?.[tf]?.supertrend;
  const items: ChecklistItem[] = [
    { label: `4h trend ${want}`, ok: a.structure['4h']?.trend === want, detail: `4h structure: ${a.structure['4h']?.trend ?? 'unknown'}${a.structure['4h']?.broken ? ` (${a.structure['4h']?.broken} trend broken)` : ''}` },
    { label: `1h trend ${want} too`, ok: a.structure['1h']?.trend === want, detail: `1h structure: ${a.structure['1h']?.trend ?? 'unknown'}` },
    { label: 'SuperTrend agrees on 1h and 15m', ok: st('1h') === s && st('15m') === s, detail: `1h ${st('1h') === 1 ? 'up' : st('1h') === -1 ? 'down' : '–'}, 15m ${st('15m') === 1 ? 'up' : st('15m') === -1 ? 'down' : '–'}` },
    { label: `Trend strong enough (1h ADX ≥ ${cfg.filters.chop.adx_min_1h})`, ok: a.adx1h === null ? null : a.adx1h >= cfg.filters.chop.adx_min_1h, detail: a.adx1h === null ? 'not enough data' : `ADX ${a.adx1h.toFixed(1)}` },
    { label: `4h close ${dir === 'long' ? 'above' : 'below'} EMA50`, ok: a[dir].emaAligned, detail: `4h close ${fmt(a.ema4h.close)}, EMA50 ${fmt(a.ema4h.fast)}` },
    { label: 'Entries open now (session)', ok: entryBlock === null, detail: entryBlock === null ? 'inside a session entry window' : entryBlock.replace(/_/g, ' ') },
    { label: 'Price in the entry area', ok: plan ? plan.status === 'in_zone' || plan.status === 'armed' : null, detail: plan ? `area ${fmt(plan.entryLow)} – ${fmt(plan.entryHigh)}, price ${fmt(ctx.price)}` : 'no plan in this direction yet' },
    { label: '15m close back in the trend direction', ok: null, detail: plan?.status === 'armed' ? 'the engine has armed the setup and is waiting for this close' : 'wait for it inside the entry area; the engine checks every 15m close' },
    { label: `Stop within ${cfg.exits.max_stop_pct}%`, ok: plan ? plan.riskPct! <= cfg.exits.max_stop_pct : null, detail: plan ? `stop ${fmt(plan.stop)}, ${plan.riskPct!.toFixed(2)}% away` : '–' },
    { label: `First target at least ${cfg.exits.min_rr}R`, ok: plan ? plan.targets[0].r >= cfg.exits.min_rr : null, detail: plan ? `${plan.targets[0].label} ${fmt(plan.targets[0].price)} = ${plan.targets[0].r.toFixed(2)}R` : '–' },
    {
      label: 'Funding not against the trade',
      ok: ctx.funding === null ? null : s * ctx.funding * 100 <= cfg.filters.funding.max_against_pct_8h,
      detail: ctx.funding === null ? 'funding rate unknown' : `${(ctx.funding * 100).toFixed(4)}% per 8h (${ctx.funding > 0 ? 'longs pay' : ctx.funding < 0 ? 'shorts pay' : 'neutral'})`,
    },
    {
      label: 'BTC not moving against it (1h)',
      ok: ctx.btcChange1hPct === null ? null : dir === 'long' ? ctx.btcChange1hPct >= cfg.filters.btc.block_longs_if_btc_1h_below_pct : ctx.btcChange1hPct <= cfg.filters.btc.block_shorts_if_btc_1h_above_pct,
      detail: ctx.btcChange1hPct === null ? 'BTC change unknown' : `BTC ${ctx.btcChange1hPct >= 0 ? '+' : ''}${ctx.btcChange1hPct.toFixed(2)}% in the last hour`,
    },
  ];
  return items;
}

/** What to wait for: with a plan, its entry, invalidation, targets and the breakout level; without, the range to watch. */
function watchLevels(idea: Planned): WatchLevel[] {
  const pct = (p: number) => ((p - idea.price) / idea.price) * 100;
  const out: WatchLevel[] = [];
  // Range edges and breakout levels are structure, like targets.
  const structural = idea.levels.filter((l) => l.sources.some(isStructural));
  const above = structural.filter((l) => l.price > idea.price).sort((x, y) => x.price - y.price);
  const below = structural.filter((l) => l.price < idea.price).sort((x, y) => y.price - x.price);
  const plan = idea.plan;
  if (plan && plan.entry !== null && plan.entryLow !== null && plan.entryHigh !== null && plan.stop !== null) {
    const long = plan.direction === 'long';
    const edge = long ? plan.entryHigh : plan.entryLow;
    out.push({ kind: 'entry', label: long ? 'Buy area' : 'Sell area', price: edge, distancePct: pct(edge), why: `${fmt(plan.entryLow)} – ${fmt(plan.entryHigh)}: ${plan.status === 'in_zone' || plan.status === 'armed' ? 'price is there now; wait for the 15m confirmation close' : `wait for price to ${long ? 'pull back down' : 'rally up'} into it`}` });
    out.push({ kind: 'invalidation', label: 'Idea is wrong beyond', price: plan.stop, distancePct: pct(plan.stop), why: `a move ${long ? 'below' : 'above'} this breaks the setup; the stop goes here` });
    for (const t of plan.targets) out.push({ kind: 'target', label: `Take profit ${t.label}`, price: t.price, distancePct: pct(t.price), why: `${t.r.toFixed(2)}R · ${t.sources.slice(0, 2).join(', ')}` });
    const breakout = long ? above[0] : below[0];
    if (breakout && !plan.targets.some((t) => Math.abs(t.price - breakout.price) < 1e-12)) {
      out.push({ kind: 'breakout', label: long ? 'Breakout above' : 'Breakdown below', price: breakout.price, distancePct: breakout.distancePct, why: `${breakout.sources.slice(0, 2).join(', ')}: a 15m close ${long ? 'above' : 'below'} it continues the trend without a pullback` });
    }
  } else {
    if (above[0]) out.push({ kind: 'range_top', label: 'Range top', price: above[0].price, distancePct: above[0].distancePct, why: `${above[0].sources.slice(0, 2).join(', ')} (strength ${above[0].strength}): a 15m close above it could start an up move` });
    if (below[0]) out.push({ kind: 'range_bottom', label: 'Range bottom', price: below[0].price, distancePct: below[0].distancePct, why: `${below[0].sources.slice(0, 2).join(', ')} (strength ${below[0].strength}): a 15m close below it could start a down move` });
  }
  return out.sort((x, y) => Math.abs(x.distancePct) - Math.abs(y.distancePct));
}

const fmt = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : Number(x.toPrecision(6)).toString());
