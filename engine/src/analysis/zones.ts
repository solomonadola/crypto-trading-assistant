// Supply and demand zones on 1h (ENGINE_PLAN.md Section 8.3, v2 7.2).
//
// Demand: a base of 1..base_max_candles small-bodied candles, then a bullish
// impulse candle with a large body on high relative volume that closes above
// the base's high. The zone spans from the base's lowest low to its highest
// body top. Supply mirrors it.
//
// A touch is a new visit: price comes back into the zone after having been
// outside it. The zone is invalid once a candle closes beyond its far side,
// or after more than max_touches visits.
import type { Candle, Timeframe } from '../../../shared/types';
import { atr, rvol } from './indicators';
import type { EngineConfig } from '../config';

export type ZoneParams = EngineConfig['zones'];

export interface Zone {
  /** Stable across recomputation: same base, same id. */
  id: string;
  symbol: string;
  tf: Timeframe;
  type: 'demand' | 'supply';
  low: number;
  high: number;
  /** Open time of the first base candle. */
  baseStart: number;
  /** Close time of the impulse candle: the moment the zone became known. */
  createdAt: number;
  /** Impulse body in ATRs. */
  impulseStrength: number;
  touches: number;
  status: 'fresh' | 'tested' | 'invalid';
  invalidatedAt: number | null;
  /** impulseStrength, discounted to 60% once tested. 0 when invalid. */
  score: number;
}

const ATR_PERIOD = 14;
const RVOL_PERIOD = 20;

/** Zones created within the last `lookback_candles`, with their state as of the last candle given. */
export function detectZones(candles: Candle[], p: ZoneParams): Zone[] {
  const n = candles.length;
  if (n < 2) return [];
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const a = atr(high, low, close, ATR_PERIOD);
  const rv = rvol(candles.map((c) => c.volume), RVOL_PERIOD);
  const zones: Zone[] = [];

  for (let j = Math.max(1, n - p.lookback_candles); j < n; j++) {
    const imp = candles[j];
    const ref = a[j - 1];
    if (!Number.isFinite(ref) || !(rv[j] >= p.impulse_min_rvol)) continue;
    const body = Math.abs(imp.close - imp.open);
    if (body <= p.impulse_body_min_atr * ref) continue;

    // The base: the run of small-bodied candles right before the impulse.
    let start = j;
    while (start > 0 && j - start < p.base_max_candles
      && Math.abs(candles[start - 1].close - candles[start - 1].open) < p.base_body_max_atr * ref) start--;
    if (start === j) continue;
    const base = candles.slice(start, j);

    let type: Zone['type'];
    let zLow: number;
    let zHigh: number;
    if (imp.close > imp.open && imp.close > Math.max(...base.map((c) => c.high))) {
      type = 'demand';
      zLow = Math.min(...base.map((c) => c.low));
      zHigh = Math.max(...base.map((c) => Math.max(c.open, c.close)));
    } else if (imp.close < imp.open && imp.close < Math.min(...base.map((c) => c.low))) {
      type = 'supply';
      zHigh = Math.max(...base.map((c) => c.high));
      zLow = Math.min(...base.map((c) => Math.min(c.open, c.close)));
    } else continue;
    if (!(zHigh > zLow) || ((zHigh - zLow) / zLow) * 100 > p.max_zone_width_pct) continue;

    const zone: Zone = {
      id: `${imp.symbol}-${imp.tf}-${type}-${base[0].openTime}`,
      symbol: imp.symbol, tf: imp.tf, type, low: zLow, high: zHigh,
      baseStart: base[0].openTime, createdAt: imp.closeTime,
      impulseStrength: body / ref, touches: 0, status: 'fresh', invalidatedAt: null, score: 0,
    };
    track(zone, candles, j, p.max_touches);
    zone.score = zone.status === 'invalid' ? 0 : zone.impulseStrength * (zone.status === 'fresh' ? 1 : 0.6);
    zones.push(zone);
  }
  return zones;
}

/** Follows a zone from its impulse to the last candle: counts visits, marks it invalid. */
function track(z: Zone, candles: Candle[], impulse: number, maxTouches: number): void {
  const inside = (c: Candle) => (z.type === 'demand' ? c.low <= z.high : c.high >= z.low);
  const through = (c: Candle) => (z.type === 'demand' ? c.close < z.low : c.close > z.high);
  let wasInside = inside(candles[impulse]);
  for (let i = impulse + 1; i < candles.length; i++) {
    const c = candles[i];
    if (through(c)) { invalidate(z, c); return; }
    const isInside = inside(c);
    if (isInside && !wasInside) {
      z.touches++;
      if (z.touches > maxTouches) { invalidate(z, c); return; }
      z.status = 'tested';
    }
    wasInside = isInside;
  }
}

function invalidate(z: Zone, c: Candle): void {
  z.status = 'invalid';
  z.invalidatedAt = c.closeTime;
}

export const activeZones = (zones: Zone[]) => zones.filter((z) => z.status !== 'invalid');
