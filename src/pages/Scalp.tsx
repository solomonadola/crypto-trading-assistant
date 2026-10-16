// Quant Scalp suite (1m, 5m, 15m) across Binance markets: real OHLCV orderflow,
// VWAP bounces, FVG retests, and volume climax reversals with 15m CHoCH confirmation
// and Key Level Limit pullback execution. Includes Master Autopilot and Friction Guard.
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BarChart3, Bot, BotOff, CheckCircle2, Layers, Power,
  ShieldCheck, Timer, Zap
} from 'lucide-react';
import { post, usePoll, usePrices, type ScalpSetup, type ScalpStats } from '../lib/api';
import { SCALP_LABEL, type ScalpKind } from '../../engine/src/analysis/scalp';
import { coin, duration, hhmm, pct, price } from '../lib/format';
import { Badge, Card, Empty, SideBadge, Table, td } from '../components/ui';
import { TakePosition } from '../components/TakePosition';

interface ScalpResponse {
  hours: number;
  costPct: number;
  setups: ScalpSetup[];
  stats: ScalpStats[];
  autopilot?: boolean;
  /** False when config.yaml disables Hunter: the switch cannot turn it on. */
  autopilotAllowed?: boolean;
  /** Per timeframe, minutes: the max hold and the limit-entry timeout a scalp is taken with. */
  maxHoldMin?: Record<string, number>;
  entryTimeoutMin?: Record<string, number>;
}

const STATUS: Record<ScalpSetup['status'], { tone: string; label: string }> = {
  open: { tone: 'accent', label: 'in play' },
  target: { tone: 'good', label: 'hit target' },
  stop: { tone: 'critical', label: 'stopped' },
  expired: { tone: 'muted', label: 'expired' },
};
const KINDS = Object.keys(SCALP_LABEL) as ScalpKind[];
const R = (r: number | null) => (r === null ? '–' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);
const rTone = (r: number | null) => (r === null ? 'text-ink-3' : r > 0 ? 'text-good' : r < 0 ? 'text-critical' : 'text-ink-2');

type TfFilter = 'all' | '1m' | '5m' | '15m';

export function Scalp({ go }: { go: (page: string, symbol?: string, tf?: string) => void }) {
  // Master toggle for quant scalping scanner, persisted in localStorage
  const [active, setActive] = useState<boolean>(() => {
    try {
      return localStorage.getItem('quant_scalp_active') !== 'false';
    } catch {
      return true;
    }
  });

  const toggleActive = () => {
    setActive((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('quant_scalp_active', String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const [tfFilter, setTfFilter] = useState<TfFilter>('all');
  const [kind, setKind] = useState<'all' | ScalpKind>('all');
  const [side, setSide] = useState<'all' | 'long' | 'short'>('all');
  const [trendOnly, setTrendOnly] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);

  // Poll active timeframe; faster 15s poll when active, slower 45s when standby
  const pollUrl = tfFilter === 'all' ? '/api/scalp' : `/api/scalp?tf=${tfFilter}`;
  const { data } = usePoll<ScalpResponse>(pollUrl, active ? 15_000 : 45_000);
  const live = usePrices();

  // Autopilot state synced with backend engine
  // Off until the server says otherwise: the page must not show Hunter engaged before it knows.
  const [autopilot, setAutopilot] = useState<boolean>(false);
  // Switching on is refused while config.yaml disables Hunter; switching off always works.
  const cannotEngage = !autopilot && data?.autopilotAllowed === false;
  const engageTitle = cannotEngage ? 'Disabled in config.yaml (scalp_autopilot.enabled: false)' : undefined;
  const [busyAutopilot, setBusyAutopilot] = useState(false);

  useEffect(() => {
    if (data?.autopilot !== undefined) {
      setAutopilot(data.autopilot);
    }
  }, [data?.autopilot]);

  const toggleAutopilot = async () => {
    setBusyAutopilot(true);
    try {
      const res = await post<{ ok: boolean; enabled: boolean }>('/api/control/quant-scalp-autopilot', {
        enabled: !autopilot,
      });
      setAutopilot(res.enabled);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAutopilot(false);
    }
  };

  const shown = useMemo(() => (data?.setups ?? []).filter((s) =>
    (tfFilter === 'all' || s.tf === tfFilter || (!s.tf && tfFilter === '5m')) &&
    (kind === 'all' || s.kind === kind) &&
    (side === 'all' || s.side === side) &&
    (!trendOnly || s.withTrend) &&
    (!openOnly || s.status === 'open')
  ), [data, tfFilter, kind, side, trendOnly, openOnly]);

  const now = Date.now();
  const select = 'rounded-lg border border-line bg-card-2 px-2 py-1 text-xs';

  return (
    <div className="space-y-5">
      {/* Top Banner / Hunter Control Panel */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-card p-4 shadow-sm md:p-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div className={`grid h-9 w-9 place-items-center rounded-xl transition ${autopilot ? 'bg-sky-500/20 text-sky-400 shadow-md shadow-sky-500/20' : 'bg-card-2 text-ink-3'}`}>
              {autopilot ? <Bot size={20} className="animate-pulse" /> : <BotOff size={20} />}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-ink">Hunter</h2>
                {autopilot ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-400/15 px-2.5 py-0.5 text-[11px] font-bold text-sky-300">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
                    </span>
                    HUNTER ENGAGED
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card-2 px-2.5 py-0.5 text-[11px] font-medium text-ink-3">
                    <span className="h-2 w-2 rounded-full bg-ink-3" />
                    HUNTER OFF (Manual 1-Click)
                  </span>
                )}
                {active ? (
                  <span className="rounded-md border border-good/40 bg-good/15 px-2 py-0.5 text-[10px] font-semibold text-good">
                    Scanner Live
                  </span>
                ) : (
                  <span className="rounded-md border border-warning/40 bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">
                    Scanner Standby
                  </span>
                )}
              </div>
              <p className="text-xs text-ink-3">
                Autonomous 1m Micro, 5m Fast & 15m Macro scalps · 15m CHoCH confirmation · Resting limit order pullback execution
              </p>
            </div>
          </div>
        </div>

        {/* Hunter & Scanner Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={toggleAutopilot}
            disabled={busyAutopilot || cannotEngage}
            title={engageTitle}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold shadow-md transition disabled:cursor-not-allowed disabled:opacity-50 ${
              autopilot
                ? 'border border-sky-500/40 bg-sky-500/20 text-sky-200 hover:bg-sky-500/30'
                : 'border border-sky-500/50 bg-sky-500 text-black hover:brightness-110 shadow-sky-500/20'
            }`}
          >
            {autopilot ? <BotOff size={14} /> : <Bot size={14} />}
            {autopilot ? 'Disengage Hunter' : 'Engage Hunter'}
          </button>

          <button
            onClick={toggleActive}
            className={`inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-medium text-ink-2 hover:bg-card-2 hover:text-ink transition`}
            title="Toggle scanning loop"
          >
            <Power size={13} />
            {active ? 'Scanner ON' : 'Scanner OFF'}
          </button>
        </div>
      </div>

      {/* Hunter Status Notice */}
      {autopilot ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3.5 text-xs text-sky-200">
          <div className="flex items-center gap-2.5">
            <Bot size={18} className="shrink-0 text-sky-400" />
            <div>
              <p className="font-semibold text-ink">Hunter is ACTIVE</p>
              <p className="text-ink-2">
                The engine autonomously monitors every closed 1m, 5m, and 15m candle. When a qualified setup appears,
                it automatically places a resting limit order at the key level pullback, sized to 1% risk with 2R net targets. No manual click required.
              </p>
            </div>
          </div>
          <button
            onClick={toggleAutopilot}
            disabled={busyAutopilot}
            className="rounded-lg border border-sky-500/40 bg-sky-500/20 px-3 py-1 font-semibold text-xs text-sky-300 hover:bg-sky-500/30"
          >
            Disengage
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/10 p-3.5 text-xs text-warning">
          <div className="flex items-center gap-2.5">
            <AlertTriangle size={18} className="shrink-0 text-warning" />
            <div>
              <p className="font-semibold text-ink">Hunter is OFF (Manual 1-Click Mode)</p>
              <p className="text-ink-2">
                The scanner identifies real-time setups, but trades will not be placed automatically. Click "Take Limit" on any setup below to place pullback limit orders.
                {data?.autopilotAllowed === false && ' Hunter is disabled in config.yaml: it lost money in the 6-month baseline backtest.'}
              </p>
            </div>
          </div>
          <button
            onClick={toggleAutopilot}
            disabled={busyAutopilot || cannotEngage}
            title={engageTitle}
            className="rounded-lg border border-warning/40 bg-warning/20 px-3 py-1 font-semibold text-xs text-warning hover:bg-warning/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Engage Hunter
          </button>
        </div>
      )}

      {/* Quant Protections / Friction Budget Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-line bg-card-2/60 p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <ShieldCheck size={13} className="text-good" />
            <span>Execution Model</span>
          </div>
          <p className="mt-1 font-semibold text-xs text-ink">Key Level Limit Pullback</p>
          <p className="text-[10px] text-ink-3">Resting limit · Zero adverse taker slippage</p>
        </div>
        <div className="rounded-xl border border-line bg-card-2/60 p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <CheckCircle2 size={13} className="text-good" />
            <span>Friction Guard</span>
          </div>
          <p className="mt-1 font-semibold text-xs text-ink">≥ 2.0R Net Target</p>
          <p className="text-[10px] text-ink-3">0.20% round-trip costs pre-deducted</p>
        </div>
        <div className="rounded-xl border border-line bg-card-2/60 p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <Layers size={13} className="text-accent" />
            <span>Timeframes</span>
          </div>
          <p className="mt-1 font-semibold text-xs text-ink">1m · 5m · 15m OHLCV</p>
          <p className="text-[10px] text-ink-3">Real Binance candle streams</p>
        </div>
        <div className="rounded-xl border border-line bg-card-2/60 p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <Zap size={13} className="text-london" />
            <span>Risk Sizing</span>
          </div>
          <p className="mt-1 font-semibold text-xs text-ink">Max 1.0% Equity Loss</p>
          <p className="text-[10px] text-ink-3">Skip setups where stop &lt; 3× fees</p>
        </div>
      </div>

      {/* Main Scalp Setups Card */}
      <Card
        title={`Quant setups · ${shown.length}`}
        icon={<Timer size={16} />}
        right={
          <div className="flex flex-wrap items-center gap-2">
            {/* Timeframe Filter Pills */}
            <div className="flex overflow-hidden rounded-lg border border-line">
              {(
                [
                  ['all', 'All (1m–15m)'],
                  ['1m', '1m Micro'],
                  ['5m', '5m Scalp'],
                  ['15m', '15m Macro'],
                ] as const
              ).map(([tf, label]) => (
                <button
                  key={tf}
                  onClick={() => setTfFilter(tf)}
                  className={`px-2.5 py-1 text-xs font-medium transition ${
                    tfFilter === tf ? 'bg-accent text-white' : 'bg-card-2 text-ink-2 hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* In Play vs Last 24h */}
            <div className="flex overflow-hidden rounded-lg border border-line">
              {(
                [
                  [true, 'in play'],
                  [false, `last ${data?.hours ?? 24}h`],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={label}
                  onClick={() => setOpenOnly(v)}
                  className={`px-2.5 py-1 text-xs ${
                    openOnly === v ? 'bg-accent text-white' : 'bg-card-2 text-ink-2 hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              className={select}
              aria-label="Setup"
            >
              <option value="all">all setups</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {SCALP_LABEL[k]}
                </option>
              ))}
            </select>

            <select
              value={side}
              onChange={(e) => setSide(e.target.value as typeof side)}
              className={select}
              aria-label="Side"
            >
              <option value="all">long and short</option>
              <option value="long">long</option>
              <option value="short">short</option>
            </select>

            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={trendOnly}
                onChange={(e) => setTrendOnly(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              with the 1h trend
            </label>
          </div>
        }
      >
        {!data ? (
          <Empty>Loading quant setups…</Empty>
        ) : !shown.length ? (
          <Empty>
            {openOnly
              ? 'No quant scalp setup is in play right now. Switch to the last 24 hours to see completed setups.'
              : 'No quant setup matches these filters.'}
          </Empty>
        ) : (
          <Table head={['Coin', 'TF', 'Setup', 'Side', 'Signal', 'Limit Entry', 'Stop', 'Target', 'Now', 'Status', 'Result', '1h trend', 'Action']}>
            {shown.map((s) => {
              const p = live?.prices[s.symbol] ?? null;
              const limitPrice = (s.keyLevel && Number.isFinite(s.keyLevel))
                ? (s.side === 'long' ? Math.min(s.keyLevel, s.entry) : Math.max(s.keyLevel, s.entry))
                : s.entry;
              const move =
                p === null ? null : ((s.side === 'long' ? p - limitPrice : limitPrice - p) / Math.abs(limitPrice - s.stop));
              const tfMs = s.tf === '1m' ? 60_000 : s.tf === '15m' ? 900_000 : 300_000;
              const candleCloseTime = s.time + tfMs;

              return (
                <tr
                  key={`${s.symbol}${s.kind}${s.side}${s.time}${s.tf ?? '5m'}`}
                  className="cursor-pointer hover:bg-card-2/60"
                  onClick={() => go('chart', s.symbol, s.tf ?? '5m')}
                  title={s.why}
                >
                  <td className={`${td} font-semibold`}>{coin(s.symbol)}</td>
                  <td className={td}>
                    {s.tf === '1m' ? (
                      <span className="rounded border border-purple-500/30 bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-bold text-purple-400">
                        1m
                      </span>
                    ) : s.tf === '15m' ? (
                      <span className="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-400">
                        15m
                      </span>
                    ) : (
                      <span className="rounded border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-bold text-sky-400">
                        5m
                      </span>
                    )}
                  </td>
                  <td className={td}>
                    <span className="block font-medium">{SCALP_LABEL[s.kind]}</span>
                    <span className="block max-w-72 truncate text-xs text-ink-3">{s.why}</span>
                  </td>
                  <td className={td}>
                    <SideBadge side={s.side} />
                  </td>
                  <td className={`${td} tabular text-ink-2`}>
                    {hhmm(candleCloseTime)} UTC
                    <span className="block text-xs text-ink-3">{duration(now - candleCloseTime)} ago</span>
                  </td>
                  <td className={`${td} tabular`}>
                    <span className="font-semibold text-accent">{price(limitPrice)}</span>
                    <span className="block text-[10px] text-ink-3">key level limit</span>
                  </td>
                  <td className={`${td} tabular text-critical`}>{price(s.stop)}</td>
                  <td className={`${td} tabular text-good`}>
                    {price(s.target)}
                    <span className="block text-xs text-ink-3">{pct(s.targetPct, 2, true)}</span>
                  </td>
                  <td className={`${td} tabular`}>
                    {price(p)}
                    {s.status === 'open' && move !== null && (
                      <span className={`block text-xs ${rTone(move)}`}>{R(move)} from limit</span>
                    )}
                  </td>
                  <td className={td}>
                    <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                  </td>
                  <td className={`${td} tabular font-semibold ${rTone(s.resultR)}`}>{R(s.resultR)}</td>
                  <td className={td}>
                    {s.withTrend ? <Badge tone="good">with</Badge> : <span className="text-xs text-ink-3">no</span>}
                  </td>
                  <td className={td}>
                    {s.status === 'open' && (
                      <TakePosition
                        symbol={s.symbol}
                        compact
                        label="Take Limit"
                        defaults={{
                          side: s.side,
                          entry: limitPrice,
                          stop: s.stop,
                          target: s.target,
                          note: `Quant Scalp (${s.tf ?? '5m'}): ${SCALP_LABEL[s.kind]} (${hhmm(candleCloseTime)} UTC)`,
                          maxHoldMin: data.maxHoldMin?.[s.tf ?? '5m'],
                          entryTimeoutMin: data.entryTimeoutMin?.[s.tf ?? '5m'],
                        }}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        <p className="mt-3 max-w-4xl text-xs text-ink-3">
          Found on closed 1m, 5m, and 15m candles across listed coins. When Hunter is engaged, qualified setups
          automatically place resting limit orders at key level pullbacks, sized to 1% risk and 2R net target.
          Stops closer than 3× round-trip friction ({pct(data?.costPct ?? 0.2, 2)}) are discarded to protect against fee drag.
        </p>
      </Card>

      {/* Historical Performance Card */}
      <Card
        title={`How they have played out · last ${data?.hours ?? 24}h`}
        icon={<BarChart3 size={16} />}
        right={
          <span className="text-xs text-ink-3">
            net after fees & slippage · 2R target requirement
          </span>
        }
      >
        {!data ? (
          <Empty>Loading performance…</Empty>
        ) : (
          <Table head={['Setup', 'Setups', 'Closed', 'Won', 'Lost', 'Expired', 'Win rate', 'Average', 'Total']}>
            {data.stats.map((x) => (
              <tr key={x.kind} className={x.kind === 'all' ? 'border-t-2 border-line font-semibold' : ''}>
                <td className={td}>{x.kind === 'all' ? 'All setups' : SCALP_LABEL[x.kind]}</td>
                <td className={`${td} tabular`}>{x.count}</td>
                <td className={`${td} tabular`}>{x.closed}</td>
                <td className={`${td} tabular text-good`}>{x.wins}</td>
                <td className={`${td} tabular text-critical`}>{x.losses}</td>
                <td className={`${td} tabular text-ink-3`}>{x.expired}</td>
                <td className={`${td} tabular`}>{x.winRate === null ? '–' : `${Math.round(x.winRate * 100)}%`}</td>
                <td className={`${td} tabular ${rTone(x.avgR)}`}>{R(x.avgR)}</td>
                <td className={`${td} tabular ${rTone(x.closed ? x.totalR : null)}`}>
                  {x.closed ? R(x.totalR) : '–'}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-ink-3">
          Won and lost reflect whether closed setups ended positive after round-trip costs. With a 2R net target,
          a setup kind needs to win 33% to 40% of the time to break even. Stops are enforced strictly with no chasing.
        </p>
      </Card>
    </div>
  );
}
