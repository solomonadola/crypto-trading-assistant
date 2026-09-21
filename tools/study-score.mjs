// Does the 100-point conviction score discriminate? If forward return is flat
// across score buckets, the score carries no information and the five pillars
// are decoration. Horizon 50 bars (4.2h) = the one horizon where Study A found
// any signal at all.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const H = 50, DIR = 'data/klines';
const src = readFileSync('src/services/binanceService.ts', 'utf8');
const closes = new Map(), tidx = new Map();
for (const sym of [...src.matchAll(/symbol: '([A-Z0-9]+)'/g)].map(m => m[1])) {
  const dir = `${DIR}/${sym}USDT`; if (!existsSync(dir)) continue;
  const rows = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.csv')).sort())
    for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line) continue; const c = line.split(','); const t = Number(c[0]);
      if (Number.isFinite(t)) rows.push([t > 1e14 ? Math.floor(t/1000) : t, +c[4]]);
    }
  rows.sort((a,b)=>a[0]-b[0]);
  closes.set(sym, Float64Array.from(rows.map(r=>r[1])));
  const m = new Map(); rows.forEach((r,i)=>m.set(r[0],i)); tidx.set(sym,m);
}
const clock = [...tidx.get('BTC').keys()].sort((a,b)=>a-b);
const xs = new Map();
for (const t of clock) { let s=0,n=0;
  for (const sym of closes.keys()) { const i=tidx.get(sym).get(t); if(i===undefined)continue;
    const c=closes.get(sym), p0=c[i], p1=c[i+H]; if(p0>0&&p1>0){s+=(p1-p0)/p0;n++;} }
  xs.set(t, n?s/n:0); }

const { entries } = JSON.parse(readFileSync('data/entries.json','utf8'));
const buckets = new Map();
for (const e of entries) {
  const i = tidx.get(e.symbol)?.get(e.t); if (i===undefined) continue;
  const c = closes.get(e.symbol), p0=c[i], p1=c[i+H]; if(!(p0>0&&p1>0)) continue;
  const sgn = e.dir==='SHORT'?-1:1;
  const b = Math.min(95, Math.floor(e.score/5)*5);
  let a = buckets.get(b); if(!a){a=[0,0,0];buckets.set(b,a);}
  a[0] += sgn*(p1-p0)/p0;
  a[1] += sgn*((p1-p0)/p0 - xs.get(e.t));
  a[2]++;
}
console.log('Forward return at 4.2h by conviction score bucket\n');
console.log('  score    n         raw bps   excess-of-beta bps');
for (const b of [...buckets.keys()].sort((a,b)=>a-b)) {
  const [r,x,n] = buckets.get(b);
  if (n < 500) continue;
  const bar = '#'.repeat(Math.max(0, Math.round((x/n*1e4)*6)));
  console.log(`  ${String(b).padStart(3)}+  ${String(n).padStart(8)}   ${(r/n*1e4).toFixed(2).padStart(8)}   ${(x/n*1e4).toFixed(2).padStart(10)}  ${bar}`);
}
const ks = [...buckets.keys()].filter(k=>buckets.get(k)[2]>=500).sort((a,b)=>a-b);
const lo = buckets.get(ks[0]), hi = buckets.get(ks.at(-1));
console.log(`\n  lowest bucket (${ks[0]}+):  ${(hi?lo[1]/lo[2]*1e4:0).toFixed(2)} bps excess`);
console.log(`  highest bucket (${ks.at(-1)}+): ${(hi[1]/hi[2]*1e4).toFixed(2)} bps excess`);
console.log(`  monotonic improvement with score? ${hi[1]/hi[2] > lo[1]/lo[2] ? 'yes' : 'NO'}`);
