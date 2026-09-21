// A server that sends headers and then stalls must not hang the price or
// candle fetch (it froze the 30s refresh loop). Uses a local stalling server;
// no real network.
//
//   node tools/test-network.mjs
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('./_gen/vendor/node_modules/esbuild');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write('[{"symbol":"BTCUSDT"');            // ...and never finish the body
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const realFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (url, opts) => { requests++; return realFetch(`http://127.0.0.1:${port}/`, opts); };

const out = await esbuild.build({
  stdin: { contents: "export { fetchBinanceTickers } from './src/services/binanceService'; export { fetchBars } from './src/services/catchUpService';",
           resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  plugins: [{ name: 'stub', setup(b) {
    b.onResolve({ filter: /automatedFeedService$/ }, () => ({ path: 'f', namespace: 's' }));
    b.onLoad({ filter: /.*/, namespace: 's' }, () => ({ contents: 'export const fetchAutomatedTrades=0, executeSimulatedTrade=0;', loader: 'js' }));
  } }],
});
const { fetchBinanceTickers, fetchBars } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

let fails = 0;
const within = async (label, p, maxMs) => {
  const t0 = Date.now();
  const r = await Promise.race([p.then(() => 'returned'), new Promise((res) => setTimeout(() => res('HUNG'), maxMs))]);
  const ok = r === 'returned';
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(40)} ${r} after ${((Date.now() - t0) / 1000).toFixed(1)}s (limit ${maxMs / 1000}s)`);
};

console.log('\nStalled response bodies must time out and fall through:');
requests = 0;
await within('ticker fetch (2 endpoints x 8s)', fetchBinanceTickers(), 25000);
console.log(`        endpoints tried: ${requests}`);
requests = 0;
const now = Date.now();
await within('candle fetch (2 endpoints x 6s)', fetchBars('BTC', now - 3600e3, now), 20000);
console.log(`        endpoints tried: ${requests}`);

server.closeAllConnections?.(); server.close();
console.log(`\n${fails === 0 ? 'ALL NETWORK CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
