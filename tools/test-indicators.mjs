// Indicators and price structure from real candles (src/services/indicators.ts),
// checked against hand-worked series, plus the candle cache (candleService).
//
//   node tools/test-indicators.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

const out = await esbuild.build({
  stdin: { contents: "export * from './src/services/indicators'; export * from './src/services/candleService';",
           resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
});
const m = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

let fails = 0;
const check = (label, got, want, tol = 1e-6) => {
  const ok = got === want || (typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) <= tol);
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(52)} got ${String(got).slice(0, 18).padStart(18)}  want ${want}`);
};
const c = (t, o, h, l, cl, v = 1) => ({ t, o, h, l, c: cl, v });

console.log('\n1. EMA');
// period 3 over [1,2,3,4,5]: seed (1+2+3)/3 = 2; k = 0.5; 4 -> 3; 5 -> 4
check('ema([1..5], 3)', m.ema([1, 2, 3, 4, 5], 3), 4);
check('ema of a flat series is that value', m.ema([7, 7, 7, 7, 7], 3), 7);
check('too little history -> null', m.ema([1, 2], 3), null);

console.log('\n2. RSI (Wilder)');
// Every step up: no losses at all -> 100. Every step down -> 0.
check('rising series -> 100', m.rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14), 100);
check('falling series -> 0', m.rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14), 0);
// Alternating +1/-1: equal average gain and loss, so either side of 50 - the
// last move tilts it (Wilder smoothing weights the newest change most).
const zigUp = Array.from({ length: 41 }, (_, i) => 100 + ((i + 1) % 2));    // ends up
const zigDown = Array.from({ length: 41 }, (_, i) => 100 + (i % 2));        // ends down, same length
check('alternating, ending up -> just above 50', m.rsi(zigUp, 14) > 50 && m.rsi(zigUp, 14) < 55, true);
check('alternating, ending down -> mirrored below 50',
  Math.abs((m.rsi(zigUp, 14) - 50) + (m.rsi(zigDown, 14) - 50)) < 0.5, true);
check('too little history -> null', m.rsi([1, 2, 3], 14), null);

console.log('\n3. ATR (Wilder)');
// Every candle has a 2-wide range and closes in the middle: TR = 2 every bar.
const flat = Array.from({ length: 20 }, (_, i) => c(i, 100, 101, 99, 100));
check('constant 2-point ranges -> 2', m.atr(flat, 14), 2);
// A gap up beyond the previous close widens true range beyond high-low.
const gapped = [...flat.slice(0, 19), c(19, 110, 111, 109, 110)];
check('a gap counts in true range (> 2)', m.atr(gapped, 14) > 2, true);
check('too little history -> null', m.atr(flat.slice(0, 5), 14), null);

console.log('\n4. Swing points');
//        i: 0    1    2    3(hi) 4    5    6(lo)  7    8
const zz = [100, 102, 104, 108, 104, 100, 96, 100, 104].map((p, i) => c(i, p, p + 1, p - 1, p));
const pivots = m.swingPivots(zz, 2);
const hi = pivots.filter((p) => p.kind === 'HIGH');
const lo = pivots.filter((p) => p.kind === 'LOW');
check('one swing high, at the peak', hi.length === 1 && hi[0].index === 3, true);
check('one swing low, at the trough', lo.length === 1 && lo[0].index === 6, true);
check('the last candles cannot be swings yet', pivots.every((p) => p.index <= zz.length - 3), true);

console.log('\n5. Levels: repeated swings at the same price');
// Three rejections at ~110 and two bounces at ~90, with price now at 100.
const seq = [];
let t = 0;
const leg = (prices) => prices.forEach((p) => seq.push(c(t++, p, p + 0.4, p - 0.4, p)));
leg([100, 105, 110, 105, 100]);       // rejection at 110
leg([95, 90, 95, 100]);               // bounce at 90
leg([105, 110.2, 105, 100]);          // rejection at 110 again
leg([95, 90.3, 95, 100]);             // bounce at 90 again
leg([105, 109.8, 104, 100]);          // rejection at 110 a third time
const levels = m.levelsFrom(seq, 1.5, 2);
const res = m.nearestLevel(100, levels, 'RESISTANCE', 2);
const sup = m.nearestLevel(100, levels, 'SUPPORT', 2);
check('resistance found near 110', Math.round(res?.price ?? 0), 110);
check('it was touched 3 times', res?.touches, 3);
check('support found near 90', Math.round(sup?.price ?? 0), 90);
check('it was touched 2 times', sup?.touches, 2);
check('a single wick is not a 2-touch level',
  m.nearestLevel(100, m.levelsFrom([...seq, c(t++, 100, 140, 99, 100)], 1.5, 2), 'RESISTANCE', 2)?.price !== 140, true);

console.log('\n6. Trend and pullback');
const upCloses = Array.from({ length: 60 }, (_, i) => 100 + i);
check('rising series is bullish', m.trendFromEmas(upCloses), 'BULLISH');
check('falling series is bearish', m.trendFromEmas(upCloses.slice().reverse()), 'BEARISH');
// Dip to 100 (swing low), rise to 120 (swing high), pull back to 112, then
// close above the previous candle's high.
const pb = [];
let ti = 0;
[104, 102, 100, 102, 106, 110, 114, 118, 120, 118, 115, 112].forEach((p) => pb.push(c(ti++, p, p + 0.5, p - 0.5, p)));
pb.push(c(ti++, 112, 114, 111.5, 113.8));     // reclaim candle
const state = m.pullbackState(pb, 2);
check('recognised as a pullback', state.isPullback, true);
check('retracement measured (~40% of the move)', Math.abs(state.retracement - 0.4) < 0.15, true);
check('reclaim candle detected', state.reclaimed, true);
const deep = [...pb.slice(0, 12), c(ti++, 112, 112, 95, 96)];   // broke the prior swing low
check('a break of the swing low is not a pullback', m.pullbackState(deep, 2).isPullback, false);

console.log('\n7. Candle cache');
m.clearCandleCache();
check('nothing cached to begin with', m.getCachedCandles('BTC', '1h'), null);
m.primeCandleCache('BTC', '1h', flat, Date.now() - 5000);
check('primed series is returned', m.getCachedCandles('BTC', '1h')?.length, 20);
check('its age is reported', m.getCandlesAge('BTC', '1h') >= 5000, true);
globalThis.fetch = async () => ({ ok: true, json: async () => [[1, '1', '2', '0.5', '1.5', '10']] });
const fetched = await m.fetchCandles('ETH', '1h', 10);
check('fetched candle parsed', fetched.length === 1 && fetched[0].h === 2 && fetched[0].c === 1.5, true);
check('served from cache while fresh', (await m.fetchCandles('ETH', '1h', 10))[0].c, 1.5);
globalThis.fetch = async () => { throw new Error('offline'); };
m.primeCandleCache('SOL', '1h', flat, 0);            // stale on purpose
check('a failed fetch returns the last good series', (await m.fetchCandles('SOL', '1h', 10)).length, 20);

console.log(`\n${fails === 0 ? 'ALL INDICATOR CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
