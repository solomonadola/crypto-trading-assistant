// Tests for the volume-ranked coin list (src/services/binanceService.ts,
// src/config/universe.ts). Offline: fake tickers.
//
//   node tools/test-universe.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

const out = await esbuild.build({
  stdin: { contents: "export { selectUniverse, currentUniverse, fetchLiveMarketCoins } from './src/services/binanceService';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
});
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const m = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

let fails = 0;
const check = (label, ok, detail = '') => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); };
const tk = (symbol, price, volM, extra = {}) => [symbol, {
  symbol, lastPrice: String(price), quoteVolume: String(volM * 1e6), priceChangePercent: '2', priceChange: '0',
  highPrice: String(price * 1.05), lowPrice: String(price * 0.95), volume: '0', count: 1000, ...extra,
}];

const rows = [
  tk('BTCUSDT', 100000, 3000), tk('ETHUSDT', 4000, 2000), tk('USDCUSDT', 1.0001, 5000, { highPrice: '1.0003', lowPrice: '0.9999' }),
  tk('FDUSDUSDT', 1, 4000), tk('NEWUSDT', 0.5, 900), tk('WBTCUSDT', 100000, 800), tk('CRCLBUSDT', 91, 700),
  tk('ODDSTABLEUSDT', 0.999, 600, { highPrice: '1.001', lowPrice: '0.998' }), tk('DEADUSDT', 2, 500, { count: 0 }),
  tk('SOLUSDT', 200, 400), tk('SOLBTC', 0.002, 9999), tk('TINYUSDT', 1.5, 1),
];
const tickers = new Map(rows);

console.log('\n1. Picking the most traded USDT pairs');
const u = m.selectUniverse(tickers, 4);
check('highest volume first', u.join(',') === 'BTC,ETH,NEW,SOL', u.join(','));
check('stablecoins left out (listed or behaving like $1)', !u.includes('USDC') && !u.includes('FDUSD') && !u.includes('ODDSTABLE'));
check('wrapped coins and apparent stock tokens left out', !u.includes('WBTC') && !u.includes('CRCLB'));
check('pairs with no trades left out', !u.includes('DEAD'));
check('only USDT pairs', !u.some((s) => s.endsWith('BTC') && s !== 'BTC'));

console.log('\n2. The list is kept for a day, then re-chosen');
const t0 = Date.UTC(2026, 8, 22, 8);
const first = m.currentUniverse(tickers, t0);
check('chosen on first use', first.length > 0 && first[0] === 'BTC');
const changed = new Map(rows);
changed.set('TINYUSDT', tk('TINYUSDT', 1.5, 99999)[1]);    // suddenly the most traded
check('an hour later: unchanged', m.currentUniverse(changed, t0 + 3600_000).join() === first.join());
check('a day later: re-chosen', m.currentUniverse(changed, t0 + 25 * 3600_000)[0] === 'TINY');

console.log('\n3. Coins without known details still get prices and a name');
globalThis.fetch = async () => ({ ok: true, json: async () => rows.map(([, t]) => t) });
const coins = await m.fetchLiveMarketCoins();
const tiny = coins.find((c) => c.symbol === 'tiny');
check('new coin scanned', !!tiny && tiny.current_price === 1.5);
check('generic name and badge logo', tiny?.name === 'TINY' && String(tiny?.image).startsWith('data:image/svg+xml'));
const btc = coins.find((c) => c.symbol === 'btc');
check('known coin keeps its details', btc?.id === 'bitcoin' && btc?.name === 'Bitcoin');

console.log(`\n${fails === 0 ? 'ALL UNIVERSE CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
