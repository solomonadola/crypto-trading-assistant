// Volume profile over a window of candles. Pure. Each candle's volume is
// spread evenly across the price bins its range covers.
//
//   POC  point of control: the price bin with the most volume
//   VAH/VAL  the value area: the bins around the POC holding value_area_pct of
//            the volume, grown one step at a time toward the heavier side
//   HVN/LVN  high and low volume nodes: local peaks and troughs of the profile
import type { Candle } from '../../../shared/types';

export interface ProfileBin {
  low: number;
  high: number;
  volume: number;
}

export interface VolumeProfile {
  name: string;
  from: number;
  to: number;
  bins: ProfileBin[];
  poc: number;
  vah: number;
  val: number;
  /** Price of each node's bin centre, strongest first. */
  hvn: number[];
  lvn: number[];
}

export function volumeProfile(name: string, candles: Candle[], binCount: number, valueAreaPct: number): VolumeProfile | null {
  if (candles.length < 2) return null;
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  if (!(hi > lo)) return null;
  const size = (hi - lo) / binCount;
  const bins: ProfileBin[] = Array.from({ length: binCount }, (_, i) => ({ low: lo + i * size, high: lo + (i + 1) * size, volume: 0 }));
  const index = (price: number) => Math.min(binCount - 1, Math.max(0, Math.floor((price - lo) / size)));
  for (const c of candles) {
    const first = index(c.low);
    const last = index(c.high);
    const share = c.volume / (last - first + 1);
    for (let i = first; i <= last; i++) bins[i].volume += share;
  }

  const total = bins.reduce((s, b) => s + b.volume, 0);
  let poc = 0;
  bins.forEach((b, i) => { if (b.volume > bins[poc].volume) poc = i; });
  let down = poc;
  let up = poc;
  let inside = bins[poc].volume;
  while (inside < (valueAreaPct / 100) * total && (down > 0 || up < binCount - 1)) {
    const below = down > 0 ? bins[down - 1].volume : -1;
    const above = up < binCount - 1 ? bins[up + 1].volume : -1;
    if (above >= below) inside += bins[++up].volume; else inside += bins[--down].volume;
  }

  const mid = (i: number) => (bins[i].low + bins[i].high) / 2;
  const peaks: number[] = [];
  const troughs: number[] = [];
  for (let i = 1; i < binCount - 1; i++) {
    const v = bins[i].volume;
    if (v > bins[i - 1].volume && v >= bins[i + 1].volume && i !== poc) peaks.push(i);
    if (v < bins[i - 1].volume && v <= bins[i + 1].volume && i > down && i < up) troughs.push(i);
  }
  peaks.sort((x, y) => bins[y].volume - bins[x].volume);
  troughs.sort((x, y) => bins[x].volume - bins[y].volume);
  return {
    name,
    from: candles[0].openTime,
    to: candles[candles.length - 1].closeTime,
    bins,
    poc: mid(poc),
    vah: bins[up].high,
    val: bins[down].low,
    hvn: peaks.slice(0, 3).map(mid),
    lvn: troughs.slice(0, 3).map(mid),
  };
}
