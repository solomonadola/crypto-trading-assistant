// Key levels and a suggested trade plan for one coin: an aid for reading the
// market by hand, separate from the engine's own entry rules. Pure.
//
// Levels come from everything the analysis knows (zones, fair value gaps and
// inverse gaps, volume profile POC/VAH/VAL/HVN, swing points, protected
// levels, the previous day's range, VWAP, EMAs, the 0.5-0.618 retracement,
// old resistance/support). Levels within half a 1h ATR of each
// other are merged into one, so agreement shows up as strength.
//
// The plan follows the models (ENGINE_PLAN.md Section 18): the trend from the
// 1h EMAs and the 4h structure; the entry at the nearest zone or order block
// on the trade's side (Model 1); the stop beyond it; the one take-profit at
// the nearest intact opposite liquidity at 2R. Sweep levels to watch for
// Model 3 are listed with the other levels to wait for.
import { dealingRange, liquidityLevels, zoneAllows, LIQUIDITY_NAMES } from './liquidity';
import { biasAllows } from '../strategy/bias';
import { liquidityPlan, orderBlocks } from '../strategy/smc';
import { pointsOfInterest } from '../strategy/zoneSweep';
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
  /** The engine's recent 15m confirmations on this coin (taken or skipped). */
  confirmed?: { direction: Direction; time: number; taken: boolean; reason: string | null }[];
  /** Directions the engine holds a position (or pending entry) in on this coin. */
  inTrade?: Direction[];
}

export function tradeIdea(ctx: Context, inputs: IdeaInputs): TradeIdea {
  const idea = planIdea(ctx, inputs);
  const list = checklist(ctx, idea, inputs.entryBlock);
  const m = ctx.m15;
  const n = m.close.length - 1;
  const atr15 = lastOf(ctx.atr15m);
  // Each level once (the same price can be, say, the PDL and the Asian low), nearest first.
  const seen = new Set<string>();
  const liquidity = liquidityLevels(ctx)
    .map((l) => ({ name: l.name, side: l.side, price: l.price, distancePct: ((l.price - ctx.price) / ctx.price) * 100, intact: l.brokenAt === null }))
    .filter((l) => { const k = `${l.name}|${l.price}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
  return {
    ...idea, checklist: list, watch: watchLevels(idea, liquidity), quality: quality(idea, list),
    speed: ctx.speed ?? 'normal',
    movingFast: Number.isFinite(atr15) && m.high[n] - m.low[n] >= 3 * atr15,
    dealingRange: dealingRange(ctx),
    liquidity,
    orderBlocks: (['long', 'short'] as const).flatMap((d) => orderBlocks(ctx.h1.candles, ctx.pivots1h, d))
      .map(({ side, low, high, createdAt }) => ({ side, low, high, createdAt })),
  };
}

type Planned = Omit<TradeIdea, 'checklist' | 'watch' | 'quality' | 'speed' | 'movingFast' | 'dealingRange' | 'liquidity' | 'orderBlocks'>;

const STAGE_POINTS: Record<NonNullable<TradeIdea['plan']>['status'], number> = { in_trade: 15, confirmed: 15, armed: 15, in_zone: 12, wait: 5, no_level: 0 };

/** See TradeIdea.quality. Without a trend there is no plan, so only the checklist counts. */
export function quality(idea: Planned, list: ChecklistItem[]): number {
  const decided = list.filter((c) => c.ok !== null);
  const checks = decided.length ? decided.filter((c) => c.ok).length / decided.length : 0;
  const plan = idea.plan;
  const r = plan?.targets[0]?.r ?? 0;
  const stage = plan ? (plan.status === 'confirmed' && plan.confirmation && !plan.confirmation.taken ? 5 : STAGE_POINTS[plan.status]) : 0;
  return Math.round(50 * checks + 25 * Math.min(Math.max(r, 0), 3) / 3 + stage + (plan?.meetsRules ? 10 : 0));
}

function planIdea(ctx: Context, inputs: IdeaInputs): Planned {
  const cfg = ctx.config;
  const price = ctx.price;
  const atr = lastOf(ctx.atr1h);
  const tol = cfg.pullback.tolerance_atr * atr;
  const levels = clusterLevels(rawLevels(ctx), price, tol);
  const st4h = ctx.analysis.structure['4h']?.trend ?? null;

  // The models' trend (Section 18.3): 1h EMA50/200 and the 4h structure.
  const long = biasAllows(ctx, 'long');
  const short = biasAllows(ctx, 'short');
  const bias: TradeIdea['bias'] = long ? 'long' : short ? 'short' : 'none';
  const biasReason = bias === 'none'
    ? 'No trend for the models: the 1h close, EMA50 and EMA200 are not lined up (or the 4h structure is against them)'
    : `1h close ${bias === 'long' ? 'above' : 'below'} EMA200, EMA50 ${bias === 'long' ? 'above it and rising' : 'below it and falling'}; 4h structure ${st4h ?? 'unknown'}`;

  const checklistFor: Direction = bias !== 'none' ? bias : st4h === 'down' ? 'short' : 'long';
  const base: Planned = {
    symbol: ctx.symbol, asOf: ctx.t, price, atr1h: atr, bias, biasReason,
    trend: { '4h': ctx.analysis.structure['4h']?.trend ?? null, '1h': ctx.analysis.structure['1h']?.trend ?? null, '15m': ctx.analysis.structure['15m']?.trend ?? null },
    longState: ctx.analysis.long.state, shortState: ctx.analysis.short.state, checklistFor,
    levels: levels.map(({ band: _band, ...l }) => l).sort((x, y) => y.price - x.price),
    plan: null,
  };
  if (bias === 'none' || !Number.isFinite(atr)) return base;

  // Model 1's entry (Section 18.5): the nearest zone or order block on the trade's side, within reach.
  const s = sign(bias);
  const reach = MAX_ENTRY_ATR * atr;
  const poi = pointsOfInterest(ctx, bias)
    .filter((p) => (bias === 'long' ? p.low <= price + tol && p.high >= price - reach : p.high >= price - tol && p.low <= price + reach))
    .sort((a, b) => s * (b.high - a.high))[0];
  const noPlan = (note: string): Planned => ({
    ...base,
    plan: { direction: bias, status: 'no_level', confirmation: null, targetPct: null, entryLow: null, entryHigh: null, entry: null, stop: null, riskPct: null, targets: [], meetsRules: false, note },
  });
  if (!poi) return noPlan(`No ${bias === 'long' ? 'demand zone or bullish' : 'supply zone or bearish'} order block within ${MAX_ENTRY_ATR} x 1h ATR. Watch the liquidity levels for a session sweep (Model 3).`);

  const entryLow = poi.low;
  const entryHigh = poi.high;
  const entry = bias === 'long' ? Math.min(price, entryHigh) : Math.max(price, entryLow);
  // The stop the engine would use: beyond the zone (it uses the lowest low since arming), plus the speed group's buffer.
  const buffer = cfg.speed.groups[ctx.speed ?? 'normal'].stop_buffer_atr_15m * lastOf(ctx.atr15m);
  const stop = (bias === 'long' ? entryLow : entryHigh) - s * buffer;
  const risk = s * (entry - stop);
  const planned = liquidityPlan(ctx, bias, entry, stop, liquidityLevels(ctx));

  const costPct = 2 * (cfg.sim.taker_fee_pct + speedSlippage(ctx));
  const costR = (costPct / 100) * entry / risk;
  const targets: TradeIdeaTarget[] = planned
    ? [{ label: 'TP', price: planned.plan.target, sources: [LIQUIDITY_NAMES[planned.target.name]], r: planned.plan.rewardRisk - costR }]
    : [];
  const targetPct = planned ? (s * (planned.plan.target - entry) / entry) * 100 : null;
  const riskPct = (risk / entry) * 100;
  const pdOk = zoneAllows(dealingRange(ctx), bias);
  const feeOk = riskPct > 0 && (costPct / riskPct) * 100 <= cfg.allocation.max_fee_drag_pct;

  const inZone = price >= entryLow && price <= entryHigh;
  const conf = (inputs.confirmed ?? []).filter((c) => c.direction === bias).sort((x, y) => y.time - x.time)[0];
  const inTrade = (inputs.inTrade ?? []).includes(bias);
  const confirmation = conf ? { time: conf.time, taken: conf.taken, reason: conf.reason } : null;
  const status: NonNullable<TradeIdea['plan']>['status'] = inTrade ? 'in_trade' : conf ? 'confirmed'
    : inputs.armed.includes(bias) ? 'armed' : inZone ? 'in_zone' : 'wait';
  const r = targets[0]?.r ?? 0;
  const meetsRules = pdOk && feeOk && riskPct <= cfg.exits.max_stop_pct && !!planned && r >= cfg.exits.min_rr && (targetPct ?? 0) >= cfg.exits.min_target_pct;
  const skipped = conf && !conf.taken ? `, but the engine skipped it (${(conf.reason ?? 'rule').replace(/_/g, ' ')})` : '';
  const where = `the ${poi.kind === 'zone' ? (bias === 'long' ? 'demand zone' : 'supply zone') : `${bias === 'long' ? 'bullish' : 'bearish'} order block`}`;
  const noteParts = [
    status === 'in_trade' ? 'Confirmed: the engine is in this trade.'
      : status === 'confirmed' ? `Confirmed: a 15m CHoCH closed on a displacement candle${skipped}.`
      : status === 'armed' ? `Retest in progress: the engine has armed this setup in ${where}; it needs liquidity taken and a 15m CHoCH on a displacement candle in a killzone.`
      : status === 'in_zone' ? `Price is in ${where}: wait for liquidity to be taken and a 15m CHoCH on a displacement candle.`
      : `Waiting for the retest: price has to ${bias === 'long' ? 'pull back down' : 'rally up'} into ${where}.`,
    !pdOk ? `Price is not in ${bias === 'long' ? 'discount' : 'premium'} on the 4h range.` : null,
    !planned ? `No intact liquidity ${bias === 'long' ? 'above' : 'below'} to aim at.` : null,
    riskPct > cfg.exits.max_stop_pct ? `Stop is ${riskPct.toFixed(2)}% away, beyond the ${cfg.exits.max_stop_pct}% limit.` : null,
    !feeOk ? 'The stop is too tight for the fees.' : null,
    planned && r < cfg.exits.min_rr ? `Take-profit is ${r.toFixed(2)}R, under the ${cfg.exits.min_rr}R minimum.` : null,
    targetPct !== null && targetPct < cfg.exits.min_target_pct ? `Take-profit is ${targetPct.toFixed(2)}% away, under the ${cfg.exits.min_target_pct}% minimum.` : null,
    !meetsRules ? 'Not a signal.' : null,
  ].filter(Boolean);
  return {
    ...base,
    plan: { direction: bias, status, confirmation, targetPct, entryLow, entryHigh, entry, stop, riskPct, targets, meetsRules, note: noteParts.join(' ') },
  };
}

const speedSlippage = (ctx: Context) => ctx.config.speed.groups[ctx.speed ?? 'normal'].slippage_pct;

/** The models' conditions for a trade in the checklist's direction, each met, not met, or still pending. */
function checklist(ctx: Context, idea: Planned, entryBlock: string | null): ChecklistItem[] {
  const cfg = ctx.config;
  const dir = idea.checklistFor;
  const long = dir === 'long';
  const s = sign(dir);
  const plan = idea.plan && idea.plan.direction === dir && idea.plan.entry !== null ? idea.plan : null;
  const st4h = ctx.analysis.structure['4h']?.trend ?? null;
  const range = dealingRange(ctx);
  const tp = plan?.targets[0];
  return [
    { label: `1h trend ${long ? 'up' : 'down'}: close ${long ? 'above' : 'below'} EMA200, EMA50 ${long ? 'rising' : 'falling'}`, ok: biasAllows(ctx, dir), detail: idea.biasReason },
    { label: `4h structure not ${long ? 'down' : 'up'}`, ok: st4h === null ? null : st4h !== (long ? 'down' : 'up'), detail: `4h structure: ${st4h ?? 'unknown'}` },
    { label: `In ${long ? 'discount' : 'premium'} (4h range)`, ok: range ? zoneAllows(range, dir) : null, detail: range ? `${Math.round(range.position * 100)}% of ${fmt(range.low)} - ${fmt(range.high)}` : 'no 4h range yet' },
    { label: 'Entries open now (killzone, weekday)', ok: entryBlock === null, detail: entryBlock === null ? 'inside a killzone' : entryBlock.replace(/_/g, ' ') },
    { label: `Retest: price in the ${long ? 'demand zone / order block' : 'supply zone / order block'}`, ok: plan ? plan.status !== 'wait' : null, detail: plan ? `area ${fmt(plan.entryLow)} - ${fmt(plan.entryHigh)}, price ${fmt(ctx.price)}` : 'no zone in reach' },
    {
      label: 'Liquidity taken, then a 15m CHoCH on a displacement candle',
      ok: plan?.confirmation ? true : null,
      detail: plan?.confirmation ? `confirmed at ${new Date(plan.confirmation.time).toISOString().slice(11, 16)} UTC${plan.confirmation.taken ? '' : `, skipped: ${(plan.confirmation.reason ?? 'rule').replace(/_/g, ' ')}`}`
        : 'the inducement, a liquidity level or a wick through the zone, then the CHoCH; the engine checks every 15m close',
    },
    { label: `Take-profit at least ${cfg.exits.min_rr}R`, ok: tp ? tp.r >= cfg.exits.min_rr : null, detail: tp ? `TP ${fmt(tp.price)} (${tp.sources[0]}) = ${tp.r.toFixed(2)}R` : '–' },
    { label: `Take-profit at least ${cfg.exits.min_target_pct}% away`, ok: plan?.targetPct != null ? plan.targetPct >= cfg.exits.min_target_pct : null, detail: plan?.targetPct != null ? `${plan.targetPct.toFixed(2)}% from the entry` : '–' },
    { label: `Stop within ${cfg.exits.max_stop_pct}%`, ok: plan ? plan.riskPct! <= cfg.exits.max_stop_pct : null, detail: plan ? `stop ${fmt(plan.stop)}, ${plan.riskPct!.toFixed(2)}% away` : '–' },
    {
      label: 'Funding not against the trade',
      ok: ctx.funding === null ? null : s * ctx.funding * 100 <= cfg.filters.funding.max_against_pct_8h,
      detail: ctx.funding === null ? 'funding rate unknown' : `${(ctx.funding * 100).toFixed(4)}% per 8h (${ctx.funding > 0 ? 'longs pay' : ctx.funding < 0 ? 'shorts pay' : 'neutral'})`,
    },
  ];
}

/** What to wait for: with a plan, its entry, invalidation, targets and the breakout level; without, the range to watch. */
function watchLevels(idea: Planned, liquidity: TradeIdea['liquidity']): WatchLevel[] {
  const pct = (p: number) => ((p - idea.price) / idea.price) * 100;
  const out: WatchLevel[] = [];
  // Range edges and breakout levels are structure, like targets.
  const structural = idea.levels.filter((l) => l.sources.some(isStructural));
  const above = structural.filter((l) => l.price > idea.price).sort((x, y) => x.price - y.price);
  const below = structural.filter((l) => l.price < idea.price).sort((x, y) => y.price - x.price);
  const plan = idea.plan;
  // The next two structural levels past a price, going up or down.
  const beyond = (p: number, up: boolean) => structural
    .filter((l) => (up ? l.price > p : l.price < p) && Math.abs(l.price - p) > 1e-12)
    .sort((x, y) => (up ? x.price - y.price : y.price - x.price))
    .slice(0, 2)
    .map((l) => ({ price: l.price, distancePct: l.distancePct, sources: l.sources }));
  if (plan && plan.entry !== null && plan.entryLow !== null && plan.entryHigh !== null && plan.stop !== null) {
    const long = plan.direction === 'long';
    const edge = long ? plan.entryHigh : plan.entryLow;
    out.push({ kind: 'entry', label: long ? 'Buy area' : 'Sell area', price: edge, distancePct: pct(edge), why: `${fmt(plan.entryLow)} – ${fmt(plan.entryHigh)}: ${plan.status === 'confirmed' || plan.status === 'in_trade' ? 'confirmed by a 15m close' : plan.status === 'in_zone' || plan.status === 'armed' ? 'price is there now; wait for the 15m confirmation close' : `wait for price to ${long ? 'pull back down' : 'rally up'} into it`}` });
    out.push({ kind: 'invalidation', label: 'Idea is wrong beyond', price: plan.stop, distancePct: pct(plan.stop), why: `a move ${long ? 'below' : 'above'} this breaks the setup; the stop goes here`, ifBroken: beyond(plan.stop, !long) });
    for (const t of plan.targets) out.push({ kind: 'target', label: `Take profit ${t.label}`, price: t.price, distancePct: pct(t.price), why: `${t.r.toFixed(2)}R · ${t.sources.slice(0, 2).join(', ')}`, ifBroken: beyond(t.price, long) });
    const breakout = long ? above[0] : below[0];
    if (breakout && !plan.targets.some((t) => Math.abs(t.price - breakout.price) < 1e-12)) {
      out.push({ kind: 'breakout', label: long ? 'Breakout above' : 'Breakdown below', price: breakout.price, distancePct: breakout.distancePct, why: `${breakout.sources.slice(0, 2).join(', ')}: a 15m close ${long ? 'above' : 'below'} it continues the trend without a pullback`, ifBroken: beyond(breakout.price, long) });
    }
  } else {
    if (above[0]) out.push({ kind: 'range_top', label: 'Range top', price: above[0].price, distancePct: above[0].distancePct, why: `${above[0].sources.slice(0, 2).join(', ')} (strength ${above[0].strength}): a 15m close above it could start an up move`, ifBroken: beyond(above[0].price, true) });
    if (below[0]) out.push({ kind: 'range_bottom', label: 'Range bottom', price: below[0].price, distancePct: below[0].distancePct, why: `${below[0].sources.slice(0, 2).join(', ')} (strength ${below[0].strength}): a 15m close below it could start a down move`, ifBroken: beyond(below[0].price, false) });
  }
  // Model 3: the nearest intact levels on the sweep side (below for a long), where a wick through and a close back is an entry.
  if (idea.bias !== 'none') {
    const long = idea.bias === 'long';
    for (const l of liquidity.filter((x) => x.intact && x.side === (long ? 'sell' : 'buy') && (long ? x.price < idea.price : x.price > idea.price)).slice(0, 2)) {
      out.push({
        kind: 'sweep', label: `Sweep of the ${LIQUIDITY_NAMES[l.name as keyof typeof LIQUIDITY_NAMES] ?? l.name}`, price: l.price, distancePct: l.distancePct,
        why: `a wick ${long ? 'under' : 'over'} it that closes back ${long ? 'above' : 'below'} on a displacement candle, in a killzone, is a session-sweep entry (Model 3)`,
      });
    }
  }
  return out.sort((x, y) => Math.abs(x.distancePct) - Math.abs(y.distancePct));
}

const fmt = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : Number(x.toPrecision(6)).toString());
