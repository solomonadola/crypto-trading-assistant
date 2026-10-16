// Pine Script (TradingView) for one coin's current plan: the entry zone, stop
// loss and take-profit, the nearest 4h zones and the liquidity levels, drawn on
// a TradingView chart. A snapshot: paste a new one when the plan changes.
// The structure indicator (tradingview/structure.pine) works out the rest live.
import type { TradeIdea } from '../../shared/types';
import type { HtfPoiView } from '../components/charts';
import { LIQUIDITY_NAMES } from '../../engine/src/analysis/liquidity';

const num = (x: number) => {
  const s = Number(x.toPrecision(8)).toString();
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};
const str = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

type Draw = { kind: 'level'; price: number; text: string; color: string; style: 'solid' | 'dashed' | 'dotted'; width: number }
  | { kind: 'zone'; from: number; top: number; bottom: number; text: string; color: string };

export function planPine(symbol: string, idea: TradeIdea, htf: { long: HtfPoiView[]; short: HtfPoiView[] } | null): string {
  const base = symbol.replace(/USDT$/, '');
  const asOf = new Date(idea.asOf).toISOString().slice(0, 16).replace('T', ' ');
  const draws: Draw[] = [];
  const plan = idea.plan;
  const GREEN = '#26a69a';
  const RED = '#ef5350';
  const BLUE = '#2962ff';
  const ORANGE = '#ff9800';
  let note: string;

  if (plan && plan.entryLow !== null && plan.entryHigh !== null && plan.stop !== null) {
    const long = plan.direction === 'long';
    const [near, far] = long ? [plan.entryHigh, plan.entryLow] : [plan.entryLow, plan.entryHigh];
    draws.push({ kind: 'level', price: near, text: `Entry ${plan.direction} ${num(near)}`, color: GREEN, style: 'solid', width: 2 });
    if (Math.abs(far - near) > 1e-12) draws.push({ kind: 'level', price: far, text: `Entry zone ${num(far)}`, color: GREEN, style: 'dashed', width: 1 });
    draws.push({ kind: 'level', price: plan.stop, text: `Stop Loss ${num(plan.stop)}`, color: RED, style: 'solid', width: 2 });
    plan.targets.forEach((t, i) => draws.push({ kind: 'level', price: t.price, text: `Take Profit${plan.targets.length > 1 ? ` ${i + 1}` : ''} ${num(t.price)} (${t.r.toFixed(1)}R)`, color: GREEN, style: 'dotted', width: 2 }));
    note = `${plan.direction.toUpperCase()} plan · ${plan.status.replace(/_/g, ' ')}${plan.meetsRules ? '' : ' · not a signal (breaks a rule)'}`;
  } else {
    const c = idea.condition;
    if (c.rangeHigh !== null && c.rangeLow !== null) {
      draws.push({ kind: 'level', price: c.rangeHigh, text: `24h box high ${num(c.rangeHigh)}`, color: ORANGE, style: 'dashed', width: 1 });
      draws.push({ kind: 'level', price: c.rangeLow, text: `24h box low ${num(c.rangeLow)}`, color: BLUE, style: 'dashed', width: 1 });
    }
    note = idea.bias === 'none' ? `No trade: ${c.kind === 'choppy' ? 'choppy' : 'consolidating'}, no clear direction` : 'No entry level within reach';
  }
  for (const side of ['long', 'short'] as const) {
    for (const p of htf?.[side] ?? []) {
      const what = p.kind === 'zone' ? (side === 'long' ? 'demand zone' : 'supply zone') : p.kind === 'fvg' ? `${side === 'long' ? 'bullish' : 'bearish'} FVG` : `${side === 'long' ? 'bullish' : 'bearish'} order block`;
      draws.push({ kind: 'zone', from: p.from, top: p.high, bottom: p.low, text: `4h ${what}`, color: side === 'long' ? BLUE : ORANGE });
    }
  }
  const seen = new Set<number>();
  for (const l of idea.liquidity.filter((x) => x.intact).slice(0, 4)) {
    if (seen.has(l.price)) continue;
    seen.add(l.price);
    const name = LIQUIDITY_NAMES[l.name as keyof typeof LIQUIDITY_NAMES] ?? l.name;
    draws.push({ kind: 'level', price: l.price, text: `${name} ${num(l.price)}`, color: l.side === 'sell' ? BLUE : ORANGE, style: 'dotted', width: 1 });
  }

  const body = draws.map((d, i) => d.kind === 'level'
    ? `    [l${i}, t${i}] = level(${num(d.price)}, ${str(d.text)}, color.new(${d.color}, 0), line.style_${d.style}, ${d.width})
    array.push(lines, l${i})
    array.push(labels, t${i})`
    : `    array.push(boxes, box.new(${Math.floor(d.from)}, ${num(d.top)}, time, ${num(d.bottom)}, xloc = xloc.bar_time, extend = extend.right, border_color = color.new(${d.color}, 30), bgcolor = color.new(${d.color}, 88), text = ${str(d.text)}, text_color = color.new(${d.color}, 0), text_size = size.small, text_halign = text.align_left, text_valign = text.align_top))`).join('\n');

  return `//@version=6
// Killzone plan for ${symbol}, as of ${asOf} UTC (a snapshot: paste a new one when the plan changes).
// ${idea.biasReason.replace(/\n/g, ' ')}
indicator(${str(`KZ plan ${base} ${asOf}`)}, shorttitle = ${str(`KZ plan ${base}`)}, overlay = true, max_lines_count = 100, max_labels_count = 100, max_boxes_count = 50)

if syminfo.ticker != ${str(`${symbol}.P`)} and syminfo.ticker != ${str(symbol)}
    runtime.error(${str(`This plan is for ${symbol}; open a ${base} chart`)})

level(float p, string txt, color c, string st, int w) =>
    l = line.new(bar_index - 150, p, bar_index, p, extend = extend.right, color = c, style = st, width = w)
    t = label.new(bar_index + 3, p, txt, style = label.style_label_left, color = color.new(c, 15), textcolor = color.white, size = size.small)
    [l, t]

var lines  = array.new<line>()
var labels = array.new<label>()
var boxes  = array.new<box>()
var label head = na

if barstate.islast
    for x in lines
        line.delete(x)
    for x in labels
        label.delete(x)
    for x in boxes
        box.delete(x)
    array.clear(lines)
    array.clear(labels)
    array.clear(boxes)
    label.delete(head)
    head := label.new(bar_index, high, ${str(note)}, yloc = yloc.abovebar, style = label.style_label_down, color = color.new(#434651, 0), textcolor = color.white, size = size.normal)
${body}
`;
}
