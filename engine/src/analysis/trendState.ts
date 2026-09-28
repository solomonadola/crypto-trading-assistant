// Combined trend state from 4h, 1h and 15m structure (ENGINE_PLAN.md
// Section 8.2, v2 table 7.1). Written for longs; shorts mirror it.
import type { TfStructure } from './structure';

export type Direction = 'long' | 'short';

export type TrendState =
  | 'strong'      // 4h, 1h and 15m all in the direction: all setups allowed
  | 'pullback'    // 4h and 1h in the direction, 15m not: arm setups, enter when 15m turns back
  | 'weakening'   // 4h in the direction, 1h broke its protected level: no new entries, close open trades
  | 'transition'  // 4h broke its protected level, opposite structure not confirmed yet: no trades
  | 'reversed'    // 4h confirmed the opposite structure
  | 'none';       // no 4h trend, or 1h has no trend without having broken one

export function combinedState(dir: Direction, s4h: TfStructure, s1h: TfStructure, s15m: TfStructure): TrendState {
  const with_ = dir === 'long' ? 'up' : 'down';
  const against = dir === 'long' ? 'down' : 'up';
  if (s4h.trend === with_) {
    if (s1h.trend === with_) return s15m.trend === with_ ? 'strong' : 'pullback';
    if (s1h.broken === with_) return 'weakening';
    return 'none';
  }
  if (s4h.broken === with_) return 'transition';
  if (s4h.trend === against) return 'reversed';
  return 'none';
}
