// The trend bias for strategy v3 (ENGINE_PLAN.md Section 18.3). Long when the
// 1h close is above EMA200, EMA50 is above EMA200 and rising (above its value
// 5 candles ago), and the 4h structure is not down. Short mirrored. Pure.
import type { Direction } from '../../../shared/types';
import { ema } from '../analysis/indicators';
import type { Context } from './context';

const SLOPE_CANDLES = 5;

export function biasAllows(ctx: Context, dir: Direction): boolean {
  const close = ctx.h1.close;
  const n = close.length - 1;
  if (n < 200 + SLOPE_CANDLES) return false;
  const e50 = ema(close, 50);
  const e200 = ema(close, 200);
  if (![e50[n], e200[n], e50[n - SLOPE_CANDLES]].every(Number.isFinite)) return false;
  const h4 = ctx.analysis.structure['4h']?.trend ?? 'none';
  return dir === 'long'
    ? close[n] > e200[n] && e50[n] > e200[n] && e50[n] > e50[n - SLOPE_CANDLES] && h4 !== 'down'
    : close[n] < e200[n] && e50[n] < e200[n] && e50[n] < e50[n - SLOPE_CANDLES] && h4 !== 'up';
}
