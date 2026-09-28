// Loads Binance 5-minute kline CSVs (tools/fetch-klines.mjs) into typed arrays,
// one series per coin, merged across folders by open time. Only the months that
// overlap [from - warmupDays, to) are read, and nothing at or after `to`.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

export function loadCandles({ dirs, from, to, warmupDays = 230, only = null }) {
  const loadFrom = from - warmupDays * 86_400_000;
  const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
  const firstMonth = monthOf(loadFrom);
  const lastMonth = monthOf(to - 1);
  const pairs = new Set(dirs.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((p) => p.endsWith('USDT')) : [])));
  const series = [];
  for (const pair of [...pairs].sort()) {
    const symbol = pair.slice(0, -4);
    if (only && !only.has(symbol) && symbol !== 'BTC') continue;
    const byTime = new Map();
    for (const dir of dirs) {
      if (!existsSync(`${dir}/${pair}`)) continue;
      const files = readdirSync(`${dir}/${pair}`)
        .filter((f) => f.endsWith('.csv'))
        .filter((f) => { const m = f.match(/(\d{4}-\d{2})\.csv$/); return !m || (m[1] >= firstMonth && m[1] <= lastMonth); });
      for (const f of files) {
        for (const line of readFileSync(`${dir}/${pair}/${f}`, 'utf8').split('\n')) {
          if (!line) continue;
          const c = line.split(',');
          let t = Number(c[0]);
          if (!Number.isFinite(t)) continue;               // header rows
          if (t > 1e14) t = Math.floor(t / 1000);          // some dumps are in microseconds
          if (t < loadFrom || t >= to) continue;
          byTime.set(t, [t, +c[1], +c[2], +c[3], +c[4], +c[5], +c[7]]);
        }
      }
    }
    if (byTime.size < 288 * 2) continue;
    const rows = [...byTime.values()].sort((a, b) => a[0] - b[0]);
    const n = rows.length;
    const s = { symbol, t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n),
                c: new Float64Array(n), v: new Float64Array(n), qv: new Float64Array(n) };
    rows.forEach((r, i) => { s.t[i] = r[0]; s.o[i] = r[1]; s.h[i] = r[2]; s.l[i] = r[3]; s.c[i] = r[4]; s.v[i] = r[5]; s.qv[i] = r[6]; });
    series.push(s);
  }
  return series;
}
