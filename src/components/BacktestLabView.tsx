import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { FlaskConical, Play, Square, AlertTriangle, Table2, BarChart3 } from 'lucide-react';
import type { BacktestResult, BacktestSettings, BacktestSummary, BacktestTrade } from '../types/backtest';

/**
 * Backtest Lab: runs tools/backtest.mjs on the server (the app's own scanner
 * and exit ladder over the Binance candles on disk) and shows the saved runs.
 */

interface RunListItem { id: string; createdAt: number; settings: BacktestSettings; summary: BacktestSummary }
interface Job {
  id: string; status: 'running' | 'done' | 'failed'; startedAt: number; fraction: number;
  t: number | null; trades: number; equityUSD: number | null; log: string[]; resultId: string | null; error: string | null;
}
interface ListResponse {
  runs: RunListItem[]; canRun: boolean; dataDirs: string[];
  profiles: Array<{ id: string; name: string }>; job: Job | null;
}

// Validated (dataviz validator, dark mode, on stone-900): categorical 1-3 for
// the equity lines; the blue/red diverging poles for gains and losses.
const C = {
  strategy: '#3987e5',
  btc: '#d95926',
  compare: '#199e70',
  gain: '#3987e5',
  loss: '#e66767',
  grid: '#292524',
  axis: '#a8a29e',
};

/** Extra filters for Supply & Demand Trend Pullback (tools/backtest.mjs flags). */
const STRATEGY_RULES = [
  { id: 'btc-rising', label: 'BTC average rising', help: "BTC's 50-day average must be higher than 10 days ago" },
  { id: 'breadth', label: 'Market breadth 50%+', help: 'At least half the liquid coins above their 4h 50 EMA' },
  { id: 'rel-strength', label: 'Only coins beating BTC', help: 'Coin up more than BTC over the last 7 days' },
  { id: 'loss-pause', label: 'Pause after 3 losses', help: '3 losses in a row stop new entries for 24 hours' },
  { id: 'bos', label: 'Break-of-structure zones', help: "Only zones whose move away broke the prior 20-candle high" },
  { id: 'key-level', label: 'Exit at the key level', help: 'Take profit at the first key level in the way: the prior swing, or the nearest fresh opposing zone before it. No fixed R; the stop never moves. Needs 1.5R of room to be taken.' },
  { id: 'target-prior-high', label: 'Exit at the prior swing (high for longs, low for shorts)', help: 'Take profit at the swing the pullback came from, the prior high for a long and the prior low for a short, instead of a fixed 2R' },
  { id: 'inducement', label: 'Inducement check', help: 'Skip zones reached without sweeping an internal 1h swing on the way (the zone may be the inducement), and zones with an unswept 4h swing just beyond them' },
  { id: 'ltf-trail', label: 'Exit on the 1h (trail)', help: 'No fixed target: at +1R the stop moves to entry, then trails each 1h swing until the 1h structure breaks' },
  { id: 'ltf-break', label: 'Verify the turn on 1h', help: "Enter only after the 1h closes beyond the pullback's last swing high (low, for shorts), not just on a green (red) candle" },
];

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const usd = (x: number, digits = 2) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(digits)}`;
const pct = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(2)}%`;
const DATA_START = '2024-09-01';
const DATA_END = '2026-09-01';

function shiftMonths(date: string, months: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** At most `max` points: the last equity of each bucket, and its deepest drawdown. */
function downsample(points: BacktestResult['equity'], max = 800) {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / max);
  const out: BacktestResult['equity'] = [];
  for (let i = 0; i < points.length; i += size) {
    const bucket = points.slice(i, i + size);
    const last = bucket[bucket.length - 1];
    out.push({ ...last, drawdownPct: Math.min(...bucket.map((p) => p.drawdownPct)) });
  }
  return out;
}

/** A direct label at the last point of a line: its name and value, in text ink. */
const endLabel = (count: number, name: string) => (props: any) => {
  const { index, x, y, value } = props;
  if (index !== count - 1 || value === undefined || value === null) return null;
  return (
    <text x={x + 8} y={y} dy={4} fontSize={11} fill="#d6d3d1">
      {name} {usd(Number(value), 0)}
    </text>
  );
};

const tooltipStyle = {
  contentStyle: { background: '#0c0a09', border: '1px solid #44403c', borderRadius: 8, fontSize: 12, color: '#e7e5e4' },
  labelStyle: { color: '#a8a29e' },
  itemStyle: { color: '#e7e5e4' },
};

const Card: React.FC<{ title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, subtitle, right, children }) => (
  <section className="rounded-2xl bg-stone-900 border border-stone-800 p-4 space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-stone-100">{title}</h3>
        {subtitle && <p className="text-xs text-stone-400 mt-0.5">{subtitle}</p>}
      </div>
      {right}
    </div>
    {children}
  </section>
);

const Stat: React.FC<{ label: string; value: string; note?: string; tone?: 'up' | 'down' }> = ({ label, value, note, tone }) => (
  <div className="rounded-xl bg-stone-900 border border-stone-800 px-3 py-2.5">
    <div className="text-[11px] uppercase tracking-wide text-stone-400">{label}</div>
    <div className="text-lg font-semibold text-stone-100 tabular-nums mt-0.5">
      {tone && <span className={tone === 'up' ? 'text-sky-400' : 'text-rose-400'} aria-hidden>{tone === 'up' ? '▲ ' : '▼ '}</span>}
      {value}
    </div>
    {note && <div className="text-[11px] text-stone-500 mt-0.5">{note}</div>}
  </div>
);

export const BacktestLabView: React.FC = () => {
  const [list, setList] = useState<ListResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [compareId, setCompareId] = useState<string>('');
  const [results, setResults] = useState<Record<string, BacktestResult>>({});
  const [job, setJob] = useState<Job | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [profile, setProfile] = useState('TREND_PULLBACK_DEMAND');
  const [from, setFrom] = useState(shiftMonths(DATA_END, -12));
  const [to, setTo] = useState(DATA_END);
  const [capital, setCapital] = useState(100);
  const [shorts, setShorts] = useState(false);
  const [rules, setRules] = useState<string[]>([]);
  const [minVolumeM, setMinVolumeM] = useState(50);
  const [timeframes, setTimeframes] = useState<'swing' | 'intraday' | 'scalp'>('swing');
  const [costPct, setCostPct] = useState(0.15);

  const [monthView, setMonthView] = useState<'chart' | 'table'>('chart');
  const [tradeSort, setTradeSort] = useState<'time' | 'net'>('time');
  const [tradePage, setTradePage] = useState(0);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/backtests');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not list backtests');
      setList(data);
      setListError(null);
      if (data.job) setJob(data.job);
      setSelectedId((cur) => cur || data.runs[0]?.id || '');
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const loadResult = useCallback(async (id: string) => {
    if (!id || results[id]) return;
    try {
      const res = await fetch(`/api/backtests/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (data.success) setResults((r) => ({ ...r, [id]: data.result }));
    } catch {}
  }, [results]);

  useEffect(() => { loadResult(selectedId); }, [selectedId, loadResult]);
  useEffect(() => { loadResult(compareId); }, [compareId, loadResult]);

  // Follow a running job until it finishes, then show its result.
  useEffect(() => {
    if (job?.status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const data = await (await fetch('/api/backtests/job')).json();
        if (!data.job) return;
        setJob(data.job);
        if (data.job.status === 'done') {
          await loadList();
          if (data.job.resultId) setSelectedId(data.job.resultId);
        }
      } catch {}
    }, 1000);
    return () => clearInterval(timer);
  }, [job?.status, loadList]);

  const startRun = async () => {
    setRunError(null);
    try {
      const res = await fetch('/api/backtests/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, from, to, shorts, capital, rules, minVolumeM, timeframes, costPct }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setJob(data.job);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelRun = async () => {
    try { setJob((await (await fetch('/api/backtests/cancel', { method: 'POST' })).json()).job); } catch {}
  };

  const result = results[selectedId];
  const compare = compareId && compareId !== selectedId ? results[compareId] : undefined;

  const equitySeries = useMemo(() => {
    if (!result) return [];
    const base = downsample(result.equity);
    if (!compare) return base.map((p) => ({ t: p.t, strategy: p.equityUSD, btc: p.btcHoldUSD, dd: p.drawdownPct }));
    // The comparison run is matched by time; runs over other ranges only overlap where they share dates.
    const other = new Map(compare.equity.map((p) => [p.t, p.equityUSD]));
    return base.map((p) => ({ t: p.t, strategy: p.equityUSD, btc: p.btcHoldUSD, compare: other.get(p.t), dd: p.drawdownPct }));
  }, [result, compare]);

  const sortedTrades = useMemo(() => {
    if (!result) return [] as BacktestTrade[];
    const t = [...result.trades];
    return tradeSort === 'net' ? t.sort((a, b) => a.netUSD - b.netUSD) : t.sort((a, b) => b.openedAt - a.openedAt);
  }, [result, tradeSort]);

  const recycleLabel = (st: BacktestSettings) =>
    st.staleRecycleHours === undefined ? '' : st.staleRecycleHours === null ? 'stale recycle off' : `stale recycle ${st.staleRecycleHours}h`;
  const runLabel = (r: RunListItem) =>
    [`${day(r.settings.from)} → ${day(r.settings.to)}`,
     r.settings.profile === 'TREND_PULLBACK_DEMAND'
       ? `S&D Pullback${r.settings.variant ? ` (${r.settings.variant})` : ''}`
       : `${r.settings.profile === 'DYNAMIC_SCALP' ? 'Scalp' : 'Sniper'}${r.settings.allowShorts ? ' L/S' : ''}`,
     recycleLabel(r.settings), pct(r.summary.totalReturnPct)].filter(Boolean).join(' · ');

  const s = result?.summary;
  const PAGE = 50;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <FlaskConical className="w-6 h-6 text-amber-400 mt-0.5" />
        <div>
          <h2 className="text-lg font-semibold text-stone-100">Backtest Lab</h2>
          <p className="text-sm text-stone-400 max-w-3xl">
            Replays the auto-pilot over Binance 5-minute candles with the app's own scanner, entry rules, sizing and exit ladder,
            every fill charged 15 bps. It measures the rules as they are in this build.
          </p>
        </div>
      </div>

      {/* Run controls: one row, above everything they affect. */}
      <Card title="New run" subtitle={list?.canRun ? `Candles: ${list.dataDirs.join(', ')}. Runs start ${DATA_START} or later so the daily analysis has its 220 days; any month missing from the history is named in the result.` : undefined}>
        {list && !list.canRun ? (
          <p className="text-sm text-amber-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> This server has no candle history. Run <code className="text-stone-200">node tools/fetch-klines.mjs</code> where the app runs to enable new runs.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-stone-400 space-y-1">
              <span className="block">Profile</span>
              <select value={profile} onChange={(e) => setProfile(e.target.value)} className="bg-stone-950 border border-stone-700 rounded-lg px-2 py-1.5 text-sm text-stone-100">
                {(list?.profiles || [{ id: 'TREND_PULLBACK_DEMAND', name: 'Supply & Demand Trend Pullback' }]).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-stone-400 space-y-1">
              <span className="block">From</span>
              <input type="date" value={from} min={DATA_START} max={to} onChange={(e) => setFrom(e.target.value)} className="bg-stone-950 border border-stone-700 rounded-lg px-2 py-1.5 text-sm text-stone-100" />
            </label>
            <label className="text-xs text-stone-400 space-y-1">
              <span className="block">To</span>
              <input type="date" value={to} min={from} max={DATA_END} onChange={(e) => setTo(e.target.value)} className="bg-stone-950 border border-stone-700 rounded-lg px-2 py-1.5 text-sm text-stone-100" />
            </label>
            <div className="flex gap-1 pb-0.5">
              {[['3M', -3], ['6M', -6], ['12M', -12], ['All', 0]].map(([label, m]) => (
                <button key={label} onClick={() => { setTo(DATA_END); setFrom(m ? shiftMonths(DATA_END, m as number) : DATA_START); }}
                  className="px-2 py-1 text-xs rounded-md border border-stone-700 text-stone-300 hover:bg-stone-800">{label}</button>
              ))}
            </div>
            <label className="text-xs text-stone-400 space-y-1">
              <span className="block">Capital ($)</span>
              <input type="number" min={10} value={capital} onChange={(e) => setCapital(Number(e.target.value))} className="w-24 bg-stone-950 border border-stone-700 rounded-lg px-2 py-1.5 text-sm text-stone-100" />
            </label>
            <label className="flex items-center gap-2 text-sm text-stone-300 pb-1.5"
              title={profile === 'TREND_PULLBACK_DEMAND' ? 'Also short with the mirrored rules: BTC below its average, 4h lower highs and lower lows, a fresh supply zone, a red 1h close. Needs futures to trade live.' : undefined}>
              <input type="checkbox" checked={shorts} onChange={(e) => setShorts(e.target.checked)} /> Allow shorts
            </label>
            {job?.status === 'running' ? (
              <button onClick={cancelRun} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-800 text-stone-200 text-sm border border-stone-700">
                <Square className="w-4 h-4" /> Cancel
              </button>
            ) : (
              <button onClick={startRun} disabled={!list?.canRun} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 text-sm border border-amber-500/40 hover:bg-amber-500/30 disabled:opacity-40">
                <Play className="w-4 h-4" /> Run backtest
              </button>
            )}
          </div>
        )}
        {list?.canRun && profile === 'TREND_PULLBACK_DEMAND' && (
          <div className="space-y-2 border-t border-stone-800 pt-3">
            <p className="text-xs text-stone-400">
              The 4h sets the direction and zones, the 1h times the entry. Base rules always apply: BTC above its 50-day average, 4h uptrend (higher highs and lows), fresh demand zone, green 1h close, stop under the zone, 2R target.
              With Allow shorts, the same rules upside down for shorts (supply zones in downtrends). Tick extra filters to test when the bot should stay out:
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {STRATEGY_RULES.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm text-stone-300" title={r.help}>
                  <input type="checkbox" checked={rules.includes(r.id)}
                    onChange={(e) => setRules((cur) => e.target.checked ? [...cur, r.id] : cur.filter((x) => x !== r.id))} />
                  {r.label}
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm text-stone-300">
                Timeframes
                <select value={timeframes} onChange={(e) => setTimeframes(e.target.value as typeof timeframes)}
                  className="bg-stone-950 border border-stone-700 rounded-md px-1.5 py-0.5 text-sm text-stone-100">
                  <option value="swing">Swing: 4h zones, 1h entry (hold up to 3 days)</option>
                  <option value="intraday">Intraday: 1h zones, 15m entry (up to 18h)</option>
                  <option value="scalp">Scalp: 15m zones, 5m entry (up to 6h)</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-300" title="Fees + spread + slippage per side. 0.15% = Binance spot market orders; about 0.07% = Binance futures with limit entries. Meme coins pay 0.05% more.">
                Cost per side
                <select value={costPct} onChange={(e) => setCostPct(Number(e.target.value))}
                  className="bg-stone-950 border border-stone-700 rounded-md px-1.5 py-0.5 text-sm text-stone-100">
                  <option value={0.15}>0.15% (spot, market orders)</option>
                  <option value={0.1}>0.10% (spot with BNB discount)</option>
                  <option value={0.07}>0.07% (futures, limit entries)</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-300">
                Min 24h volume $
                <input type="number" min={1} value={minVolumeM} onChange={(e) => setMinVolumeM(Number(e.target.value))}
                  className="w-16 bg-stone-950 border border-stone-700 rounded-md px-1.5 py-0.5 text-sm text-stone-100" />M
              </label>
            </div>
            <div className="flex gap-2 text-xs">
              <button onClick={() => setRules(['breadth', 'rel-strength', 'loss-pause'])} className="px-2 py-1 rounded-md border border-stone-700 text-stone-300 hover:bg-stone-800">
                Best on train year (breadth + beats BTC + 3-loss pause)
              </button>
              <button onClick={() => setRules([])} className="px-2 py-1 rounded-md border border-stone-700 text-stone-300 hover:bg-stone-800">Clear</button>
            </div>
          </div>
        )}
        {job?.status === 'running' && (
          <div className="space-y-1">
            <div className="h-2 rounded-full bg-stone-800 overflow-hidden" role="progressbar" aria-valuenow={Math.round(job.fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-amber-400 transition-all" style={{ width: `${Math.round(job.fraction * 100)}%` }} />
            </div>
            <p className="text-xs text-stone-400 tabular-nums">
              {Math.round(job.fraction * 100)}% · {job.t ? `simulating ${day(job.t)}` : job.log[job.log.length - 1] || 'loading candles'} · {job.trades} trades
              {job.equityUSD !== null ? ` · equity ${usd(job.equityUSD)}` : ''} · about 20 seconds per simulated month
            </p>
          </div>
        )}
        {job?.status === 'failed' && <p className="text-xs text-rose-300">Run failed: {job.error}</p>}
        {runError && <p className="text-xs text-rose-300">{runError}</p>}
      </Card>

      {listError && <p className="text-sm text-rose-300">Could not reach the backtest API: {listError}</p>}

      {list && list.runs.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-stone-400 space-y-1">
            <span className="block">Showing</span>
            <select value={selectedId} onChange={(e) => { setSelectedId(e.target.value); setTradePage(0); }} className="bg-stone-900 border border-stone-700 rounded-lg px-2 py-1.5 text-sm text-stone-100 max-w-[34rem]">
              {list.runs.map((r) => <option key={r.id} value={r.id}>{runLabel(r)}</option>)}
            </select>
          </label>
          <label className="text-xs text-stone-400 space-y-1">
            <span className="block">Compare with</span>
            <select value={compareId} onChange={(e) => setCompareId(e.target.value)} className="bg-stone-900 border border-stone-700 rounded-lg px-2 py-1.5 text-sm text-stone-100 max-w-[34rem]">
              <option value="">Nothing</option>
              {list.runs.filter((r) => r.id !== selectedId).map((r) => <option key={r.id} value={r.id}>{runLabel(r)}</option>)}
            </select>
          </label>
        </div>
      )}

      {list && list.runs.length === 0 && !job && (
        <p className="text-sm text-stone-400">No saved runs yet. Start one above, or from a terminal: <code className="text-stone-200">node tools/backtest.mjs</code></p>
      )}

      {result && s && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Net return" value={pct(s.totalReturnPct)} tone={s.totalReturnPct >= 0 ? 'up' : 'down'} note={`${usd(s.netProfitUSD)} on ${usd(result.settings.startingCapitalUSD, 0)} · BTC held ${pct(s.btcReturnPct)}`} />
            <Stat label="Max drawdown" value={`${s.maxDrawdownPct.toFixed(2)}%`} note={`${usd(s.maxDrawdownUSD)} from peak, marked to market`} />
            <Stat label="Profit factor" value={s.profitFactor === null ? '∞' : s.profitFactor.toFixed(2)} note={`avg ${s.avgR.toFixed(2)}R · ${usd(s.expectancyUSD, 3)} a trade`} />
            <Stat label="Win rate" value={`${s.winRatePct.toFixed(1)}%`} note={`${s.wins} W / ${s.losses} L / ${s.breakeven} BE`} />
            <Stat label="Trades" value={String(s.trades)} note={`${s.tradesPerMonth.toFixed(1)} a month · avg hold ${s.avgHoldHours.toFixed(1)}h`} />
            <Stat label="Fees paid" value={usd(s.feesUSD)} note={`${result.settings.costPerSidePct}% a side · gross ${usd(s.grossProfitUSD)}`} />
            <Stat label="Avg win / loss" value={`${usd(s.avgWinUSD, 3)} / ${usd(s.avgLossUSD, 3)}`} note={`best ${usd(s.bestTradeUSD)} · worst ${usd(s.worstTradeUSD)}`} />
            <Stat label="Coin basket held" value={pct(s.benchmarkReturnPct)} note={`equal weight, ${result.settings.symbols.length} coins, no trading`} />
          </div>

          {result.settings.rules && (
            <Card title={`Rules: Supply & Demand Trend Pullback${result.settings.variant ? ` (${result.settings.variant})` : ''}`}>
              <ul className="list-disc pl-5 space-y-1 text-xs text-stone-300">
                {result.settings.rules.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </Card>
          )}

          <Card title="Equity" subtitle={`Marked to market hourly · ${day(result.settings.from)} to ${day(result.settings.to)} · ${result.settings.symbols.length} coins ${result.settings.minScore ? ` · min score ${result.settings.minScore}` : ''} · up to ${result.settings.maxConcurrentTrades} open${recycleLabel(result.settings) ? ` · ${recycleLabel(result.settings)}` : ''}`}>
            <div className="h-72" role="img" aria-label="Equity curve of the backtest compared with holding BTC">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={equitySeries} margin={{ top: 8, right: 132, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={(t) => day(t).slice(0, 7)} stroke={C.axis} fontSize={11} tickLine={false} />
                  <YAxis stroke={C.axis} fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${Math.round(v)}`} width={52} domain={['auto', 'auto']} />
                  <Tooltip {...tooltipStyle} labelFormatter={(t) => day(Number(t))} formatter={(v: any, name: any) => [usd(Number(v)), name]} />
                  <Legend wrapperStyle={{ fontSize: 12, color: '#d6d3d1' }} />
                  <ReferenceLine y={result.settings.startingCapitalUSD} stroke="#57534e" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="strategy" name="This run" label={endLabel(equitySeries.length, "This run")} stroke={C.strategy} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                  {compare && <Line type="monotone" dataKey="compare" name="Compared run" label={endLabel(equitySeries.length, "Compared")} stroke={C.compare} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />}
                  <Line type="monotone" dataKey="btc" name="BTC held" label={endLabel(equitySeries.length, "BTC held")} stroke={C.btc} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="Drawdown" subtitle="How far equity sat below its previous peak">
            <div className="h-40" role="img" aria-label="Drawdown from peak over time">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equitySeries} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={(t) => day(t).slice(0, 7)} stroke={C.axis} fontSize={11} tickLine={false} />
                  <YAxis stroke={C.axis} fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={52} />
                  <Tooltip {...tooltipStyle} labelFormatter={(t) => day(Number(t))} formatter={(v: any) => [`${Number(v).toFixed(2)}%`, 'Below peak']} />
                  <Area type="monotone" dataKey="dd" stroke={C.loss} strokeWidth={2} fill={C.loss} fillOpacity={0.2} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="By month" subtitle="Return on equity at the start of each month"
            right={
              <button onClick={() => setMonthView(monthView === 'chart' ? 'table' : 'chart')} className="inline-flex items-center gap-1 text-xs text-stone-300 border border-stone-700 rounded-md px-2 py-1 hover:bg-stone-800">
                {monthView === 'chart' ? <><Table2 className="w-3.5 h-3.5" /> Table</> : <><BarChart3 className="w-3.5 h-3.5" /> Chart</>}
              </button>
            }>
            {monthView === 'chart' ? (
              <div className="h-56" role="img" aria-label="Monthly return bars">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={result.monthly} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="key" stroke={C.axis} fontSize={11} tickLine={false} />
                    <YAxis stroke={C.axis} fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={52} />
                    <ReferenceLine y={0} stroke="#57534e" />
                    <Tooltip {...tooltipStyle} cursor={{ fill: '#292524' }}
                      formatter={(v: any, _n: any, item: any) => [`${pct(Number(v))} · ${item.payload.trades} trades · ${usd(item.payload.netUSD)}`, 'Month']} />
                    <Bar dataKey="returnPct" radius={[4, 4, 4, 4]} isAnimationActive={false}>
                      {result.monthly.map((m) => <Cell key={m.key} fill={(m.returnPct ?? 0) >= 0 ? C.gain : C.loss} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <table className="w-full text-sm tabular-nums">
                <thead className="text-xs text-stone-400"><tr><th className="text-left py-1">Month</th><th className="text-right">Trades</th><th className="text-right">Wins</th><th className="text-right">Net</th><th className="text-right">Fees</th><th className="text-right">Return</th></tr></thead>
                <tbody className="text-stone-200">
                  {result.monthly.map((m) => (
                    <tr key={m.key} className="border-t border-stone-800">
                      <td className="py-1">{m.key}</td><td className="text-right">{m.trades}</td><td className="text-right">{m.wins}</td>
                      <td className="text-right">{usd(m.netUSD)}</td><td className="text-right">{usd(m.feesUSD)}</td><td className="text-right">{m.returnPct !== undefined ? pct(m.returnPct) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <div className="grid md:grid-cols-2 gap-4">
            <Card title="How trades ended">
              <Breakdown rows={result.byExitReason} />
            </Card>
            <Card title="Why the auto-pilot did not deploy" subtitle="Counted once per 5-minute step">
              <ul className="space-y-1 text-sm">
                {result.skipReasons.slice(0, 10).map((r) => {
                  const total = result.skipReasons.reduce((a, x) => a + x.steps, 0);
                  return (
                    <li key={r.reason} className="flex items-center gap-2">
                      <span className="w-14 text-right tabular-nums text-stone-400 text-xs">{((r.steps / total) * 100).toFixed(1)}%</span>
                      <span className="text-stone-200 truncate" title={r.reason}>{r.reason.replace(/\s*\([^)]*#[^)]*\)/g, '') || '(no reason)'}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
            <Card title="By coin" subtitle="Best and worst by net P&L">
              <Breakdown rows={[...result.bySymbol.slice(0, 6), ...result.bySymbol.slice(-6).filter((r) => !result.bySymbol.slice(0, 6).includes(r))]} />
            </Card>
            <Card title="By direction">
              <Breakdown rows={result.byDirection} />
            </Card>
          </div>

          <Card title={`Trades (${result.trades.length})`}
            right={
              <div className="flex gap-1 text-xs">
                {(['time', 'net'] as const).map((k) => (
                  <button key={k} onClick={() => { setTradeSort(k); setTradePage(0); }} className={`px-2 py-1 rounded-md border ${tradeSort === k ? 'border-amber-500/40 text-amber-300' : 'border-stone-700 text-stone-300'}`}>
                    {k === 'time' ? 'Newest' : 'Worst first'}
                  </button>
                ))}
              </div>
            }>
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums whitespace-nowrap">
                <thead className="text-stone-400">
                  <tr><th className="text-left py-1">Opened</th><th className="text-left">Coin</th><th className="text-left">Side</th><th className="text-right">Entry</th><th className="text-right">Exit</th><th className="text-right">Size</th><th className="text-right">Net</th><th className="text-right">R</th><th className="text-right">Tiers</th><th className="text-right">Hold</th><th className="text-left pl-3">Exit reason</th></tr>
                </thead>
                <tbody className="text-stone-200">
                  {sortedTrades.slice(tradePage * PAGE, (tradePage + 1) * PAGE).map((t) => (
                    <tr key={t.id} className="border-t border-stone-800">
                      <td className="py-1">{new Date(t.openedAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
                      <td>{t.symbol}</td><td>{t.direction}</td>
                      <td className="text-right">{t.entryPrice}</td><td className="text-right">{t.exitPrice}</td>
                      <td className="text-right">{usd(t.positionSizeUSD)}</td>
                      <td className={`text-right ${t.netUSD >= 0 ? 'text-sky-300' : 'text-rose-300'}`}>{usd(t.netUSD, 3)}</td>
                      <td className="text-right">{t.rMultiple.toFixed(2)}</td><td className="text-right">{t.tiersHit}</td>
                      <td className="text-right">{t.holdHours.toFixed(1)}h</td><td className="pl-3 text-stone-400">{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sortedTrades.length > PAGE && (
              <div className="flex items-center gap-2 text-xs text-stone-400">
                <button disabled={tradePage === 0} onClick={() => setTradePage(tradePage - 1)} className="px-2 py-1 border border-stone-700 rounded-md disabled:opacity-40">Previous</button>
                <span>Page {tradePage + 1} of {Math.ceil(sortedTrades.length / PAGE)}</span>
                <button disabled={(tradePage + 1) * PAGE >= sortedTrades.length} onClick={() => setTradePage(tradePage + 1)} className="px-2 py-1 border border-stone-700 rounded-md disabled:opacity-40">Next</button>
              </div>
            )}
          </Card>

          <Card title="What this backtest cannot reproduce">
            <ul className="list-disc pl-5 space-y-1 text-xs text-stone-400">
              {result.limitations.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
};

const Breakdown: React.FC<{ rows: BacktestResult['byExitReason'] }> = ({ rows }) => (
  <table className="w-full text-sm tabular-nums">
    <thead className="text-xs text-stone-400"><tr><th className="text-left py-1"></th><th className="text-right">Trades</th><th className="text-right">Win %</th><th className="text-right">Net</th></tr></thead>
    <tbody className="text-stone-200">
      {rows.map((r) => (
        <tr key={r.key} className="border-t border-stone-800">
          <td className="py-1">{r.key}</td>
          <td className="text-right">{r.trades}</td>
          <td className="text-right">{r.trades ? ((r.wins / r.trades) * 100).toFixed(0) : 0}%</td>
          <td className={`text-right ${r.netUSD >= 0 ? 'text-sky-300' : 'text-rose-300'}`}>{usd(r.netUSD)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);
