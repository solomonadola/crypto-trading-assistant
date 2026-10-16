// "Take position": opens a simulated trade by hand at Binance's mark price,
// sized and limited by the engine's usual risk rules, with an active pre-flight
// check, Patience Copilot (wait for key level / wait for candle confirmation),
// and pattern memory (estimates per market condition) to flag likely negative-EV setups.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock,
  Hourglass, PauseCircle, PlayCircle, ShieldAlert, ShieldCheck, Sparkles, X, XCircle, Zap
} from 'lucide-react';
import { post, usePoll, usePrices, type CoinWatch, type PatternMatch, type TradeIdea } from '../lib/api';
import { coin, pct, price as fmtPrice } from '../lib/format';
import { chime } from './Notifier';

export interface TakeDefaults {
  side: 'long' | 'short'; stop: number | null; target: number | null; note: string; entry?: number | null;
  /** Scalps: closed at the market after this many minutes, and the limit cancelled if not filled within entryTimeoutMin. */
  maxHoldMin?: number; entryTimeoutMin?: number;
}

interface Filled { price: number; qty: number; notional: number; stop: number; target: number | null }

interface PreflightCheck {
  id: string;
  label: string;
  status: 'good' | 'warning' | 'danger';
  detail: string;
  pts: number;
}

interface PatienceStatus {
  stage: 'wait_level' | 'wait_confirm' | 'confirmed' | 'in_trade' | 'no_level' | 'counter_plan';
  badge: string;
  title: string;
  detail: string;
  tone: 'good' | 'warning' | 'danger' | 'info';
  levelRange?: string;
  distancePct?: number;
}

/** A price as a short editable string: six significant digits. */
const short = (x: number | null) => (x === null ? '' : String(Number(x.toPrecision(6))));
/** Every trade aims for at least this reward:risk after costs (config exits.min_rr): no 1:1 trades. */
const MIN_RR = 2;

/** A button that opens the dialog; `defaults` fill it in (from a scalp setup or a trade plan). */
export function TakePosition({ symbol, defaults, label = 'Take position', compact = false }: { symbol: string; defaults: TakeDefaults; label?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={`inline-flex items-center gap-1 rounded-lg bg-good/15 font-semibold text-good ring-1 ring-good/40 hover:bg-good/25 ${compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs'}`}
      >
        <PlayCircle size={compact ? 12 : 13} />{label}
      </button>
      {open && <Dialog symbol={symbol} defaults={defaults} onClose={() => setOpen(false)} />}
    </>
  );
}

function Dialog({ symbol, defaults, onClose }: { symbol: string; defaults: TakeDefaults; onClose: () => void }) {
  const live = usePrices();
  const now = live?.prices[symbol] ?? null;
  const { data: watch } = usePoll<CoinWatch | null>(`/api/watch/${symbol}`, 60_000);
  const { data: idea } = usePoll<TradeIdea | null>(`/api/ideas/${symbol}`, 15_000);
  const [side, setSide] = useState(defaults.side);
  const { data: pattern } = usePoll<PatternMatch | null>(`/api/pattern-memory/${symbol}?side=${side}`, 15_000);

  const [entry, setEntry] = useState(short(defaults.entry ?? null));
  const [stop, setStop] = useState(short(defaults.stop));
  const [target, setTarget] = useState(short(defaults.target));
  const [note, setNote] = useState(defaults.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filled, setFilled] = useState<Filled | null>(null);
  const [pendingOrder, setPendingOrder] = useState<{ entryPrice: number; stop: number; target: number | null; positionId?: string } | null>(null);

  // Auto-fill planned key level if entry is blank
  useEffect(() => {
    if (!entry && idea?.plan?.entry != null) {
      setEntry(short(idea.plan.entry));
    }
  }, [entry, idea?.plan?.entry]);

  // Pre-flight friction controls
  const [acknowledged, setAcknowledged] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const chimeTriggered = useRef(false);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  // Reset confirmation on direction shift
  useEffect(() => {
    setAcknowledged(false);
    chimeTriggered.current = false;
  }, [side]);

  const customEntryVal = entry.trim() ? Number(entry) : null;
  const effectiveEntry = (customEntryVal !== null && Number.isFinite(customEntryVal) && customEntryVal > 0) ? customEntryVal : now;

  const s = Number(stop);
  const t = target.trim() ? Number(target) : null;
  const dir = side === 'long' ? 1 : -1;
  const stopOk = effectiveEntry !== null && s > 0 && dir * (effectiveEntry - s) > 0;
  const targetSide = t !== null && effectiveEntry !== null && t > 0 && dir * (t - effectiveEntry) > 0;
  const stopPct = stopOk && effectiveEntry !== null ? (Math.abs(effectiveEntry - s) / effectiveEntry) * 100 : null;
  const costFraction = idea?.speed === 'wild' ? 0.004 : 0.002;
  const rr = stopOk && targetSide && effectiveEntry !== null ? (Math.abs(t! - effectiveEntry) - costFraction * effectiveEntry) / Math.abs(effectiveEntry - s) : null;
  const targetOk = rr !== null && rr >= MIN_RR;

  // ---------------- Patience Enforcer (Wait for Level / Wait for Confirmation) ----------------
  const patience = useMemo<PatienceStatus>(() => {
    if (!idea || !idea.plan) {
      return {
        stage: 'no_level',
        badge: 'NO LEVEL',
        title: 'No Clear Key Level',
        detail: idea?.condition ? `Market condition: ${idea.condition.kind} (${idea.condition.reason}). No high-probability POI nearby.` : 'No structural order block or POI within reach.',
        tone: 'warning',
      };
    }

    const plan = idea.plan;
    if (plan.direction !== side) {
      return {
        stage: 'counter_plan',
        badge: 'COUNTER-BIAS',
        title: `Opposing Structural Bias (${plan.direction.toUpperCase()} Plan Active)`,
        detail: `The model's planned setup is for ${plan.direction.toUpperCase()} (${idea.biasReason}). Taking a ${side.toUpperCase()} trades against the structural key levels.`,
        tone: 'danger',
      };
    }

    const entryMid = plan.entry ?? (plan.entryLow !== null && plan.entryHigh !== null ? (plan.entryLow + plan.entryHigh) / 2 : null);
    const distPct = (entryMid !== null && now !== null && now > 0) ? Math.abs(((now - entryMid) / now) * 100) : null;
    const levelRange = (plan.entryLow !== null && plan.entryHigh !== null) ? `${fmtPrice(plan.entryLow)} – ${fmtPrice(plan.entryHigh)}` : null;

    if (plan.status === 'in_trade') {
      return {
        stage: 'in_trade',
        badge: 'IN TRADE',
        title: 'Active Trade Running',
        detail: 'The engine or portfolio already holds an open trade in this direction.',
        tone: 'info',
        levelRange: levelRange ?? undefined,
        distancePct: distPct ?? undefined,
      };
    }

    if (plan.status === 'confirmed') {
      return {
        stage: 'confirmed',
        badge: 'CONFIRMED SETUP',
        title: 'Confirmed Setup (Clear to Enter)',
        detail: 'A 15m candle close confirmed displacement and structure shift at the key level.',
        tone: 'good',
        levelRange: levelRange ?? undefined,
        distancePct: distPct ?? undefined,
      };
    }

    if (plan.status === 'in_zone' || plan.status === 'armed') {
      return {
        stage: 'wait_confirm',
        badge: 'WAIT FOR CONFIRMATION',
        title: 'Wait for 15m Candle Confirmation',
        detail: `Price is inside the ${plan.direction} zone${levelRange ? ` (${levelRange})` : ''}, but the 15m confirmation candle has NOT closed yet. Do not catch a falling knife — wait for a 15m close confirming rejection or CHoCH.`,
        tone: 'warning',
        levelRange: levelRange ?? undefined,
        distancePct: distPct ?? undefined,
      };
    }

    if (plan.status === 'wait') {
      return {
        stage: 'wait_level',
        badge: 'WAIT FOR KEY LEVEL',
        title: 'Wait for Key Level (No-Man\'s Land)',
        detail: `Current price is ${distPct !== null ? distPct.toFixed(1) + '%' : 'far'} away from the planned ${plan.direction} entry zone${levelRange ? ` (${levelRange})` : ''}. Entering at market is front-running in no-man's land with poor R:R.`,
        tone: 'danger',
        levelRange: levelRange ?? undefined,
        distancePct: distPct ?? undefined,
      };
    }

    return {
      stage: 'no_level',
      badge: 'NO LEVEL',
      title: 'No Clear Key Level',
      detail: plan.note || 'No structural order block or POI within reach.',
      tone: 'warning',
    };
  }, [idea, side, now]);

  // Quick action: populate levels from plan
  const applyPlannedLevels = () => {
    if (idea?.plan) {
      const plannedEntry = idea.plan.entry ?? (idea.plan.entryLow !== null && idea.plan.entryHigh !== null ? (idea.plan.entryLow + idea.plan.entryHigh) / 2 : null);
      if (plannedEntry !== null) setEntry(short(plannedEntry));
      if (idea.plan.stop !== null) setStop(short(idea.plan.stop));
      if (idea.plan.targets[0]?.price) setTarget(short(idea.plan.targets[0].price));
      if (idea.plan.direction) setSide(idea.plan.direction);
      setNote(idea.plan.note ? `Chart: ${idea.plan.direction} plan` : note);
    }
  };

  // ---------------- Pre-Flight Health Evaluation ----------------
  const checks: PreflightCheck[] = [];

  // 1. Patience & Key Level Stage
  if (patience.stage === 'confirmed') {
    checks.push({ id: 'patience', label: 'Confirmed Setup (15m Shift)', status: 'good', detail: patience.detail, pts: 25 });
  } else if (patience.stage === 'wait_confirm') {
    checks.push({ id: 'patience', label: 'Unconfirmed (Wait for Candle Close)', status: 'warning', detail: patience.detail, pts: -15 });
  } else if (patience.stage === 'wait_level') {
    checks.push({ id: 'patience', label: 'No-Man\'s Land (Wait for Key Level)', status: 'danger', detail: patience.detail, pts: -25 });
  } else if (patience.stage === 'counter_plan') {
    checks.push({ id: 'patience', label: 'Counter-Plan Direction', status: 'danger', detail: patience.detail, pts: -30 });
  } else if (patience.stage === 'no_level') {
    checks.push({ id: 'patience', label: 'No Nearby Structural Level', status: 'warning', detail: patience.detail, pts: -20 });
  }

  // 2. Dealing Range (Discount vs Premium)
  if (idea?.dealingRange) {
    const pos = idea.dealingRange.position;
    if (side === 'long') {
      if (pos < 0.45) {
        checks.push({ id: 'zone', label: `Discount Zone (${(pos * 100).toFixed(0)}% of 4h range)`, status: 'good', detail: 'Buying cheap in discount provides asymmetric reward-to-risk.', pts: 15 });
      } else if (pos > 0.55) {
        checks.push({ id: 'zone', label: `Premium Zone (${(pos * 100).toFixed(0)}% of 4h range)`, status: 'danger', detail: 'Buying high in premium leaves minimal upside and high drawdown risk.', pts: -25 });
      } else {
        checks.push({ id: 'zone', label: 'Equilibrium (Mid-Range)', status: 'good', detail: 'Price is around 50% fair-value midpoint.', pts: 5 });
      }
    } else {
      if (pos > 0.55) {
        checks.push({ id: 'zone', label: `Premium Zone (${(pos * 100).toFixed(0)}% of 4h range)`, status: 'good', detail: 'Selling high in premium provides asymmetric reward-to-risk.', pts: 15 });
      } else if (pos < 0.45) {
        checks.push({ id: 'zone', label: `Discount Zone (${(pos * 100).toFixed(0)}% of 4h range)`, status: 'danger', detail: 'Shorting low into discount territory risks violent short squeezes.', pts: -25 });
      } else {
        checks.push({ id: 'zone', label: 'Equilibrium (Mid-Range)', status: 'good', detail: 'Price is around 50% fair-value midpoint.', pts: 5 });
      }
    }
  }

  // 3. Pattern memory
  if (pattern) {
    if (pattern.compositeVerdict === 'strong_edge') {
      checks.push({ id: 'pattern', label: `Pattern Edge: ${pattern.winRatePct}% Win Rate (+${pattern.expectancyR}R EV)`, status: 'good', detail: pattern.summary, pts: 20 });
    } else if (pattern.compositeVerdict === 'positive_edge') {
      checks.push({ id: 'pattern', label: `Pattern Edge: ${pattern.winRatePct}% Win Rate (+${pattern.expectancyR}R EV)`, status: 'good', detail: pattern.summary, pts: 10 });
    } else if (pattern.compositeVerdict === 'neutral') {
      checks.push({ id: 'pattern', label: `Neutral Pattern Edge (${pattern.winRatePct}% Win Rate)`, status: 'warning', detail: pattern.summary, pts: 0 });
    } else if (pattern.compositeVerdict === 'negative_edge') {
      checks.push({ id: 'pattern', label: `Negative Pattern EV (${pattern.winRatePct}% Win Rate, ${pattern.expectancyR}R)`, status: 'danger', detail: pattern.summary, pts: -25 });
    } else {
      checks.push({ id: 'pattern', label: `Severe Pattern Hazard (${pattern.winRatePct}% Win Rate, ${pattern.expectancyR}R)`, status: 'danger', detail: pattern.summary, pts: -35 });
    }

    // 3b. Volume Dynamics & Pattern Change Driver
    if (pattern.volumeDiagnosis) {
      const v = pattern.volumeDiagnosis;
      if (v.regime === 'climax') {
        checks.push({ id: 'volume', label: `${v.label} (${v.rvol}x Volume)`, status: 'danger', detail: v.whyItHappened, pts: -25 });
      } else if (v.regime === 'divergence') {
        checks.push({ id: 'volume', label: `${v.label}`, status: 'danger', detail: v.whyItHappened, pts: -25 });
      } else if (v.regime === 'expansion') {
        checks.push({ id: 'volume', label: `${v.label} (${v.rvol}x Volume)`, status: 'good', detail: v.whyItHappened, pts: 15 });
      } else if (v.regime === 'drying') {
        checks.push({ id: 'volume', label: `${v.label} (${v.rvol}x Volume)`, status: 'warning', detail: v.whyItHappened, pts: -10 });
      } else {
        checks.push({ id: 'volume', label: `${v.label} (${v.rvol}x Volume)`, status: 'good', detail: v.whyItHappened, pts: 5 });
      }
    }
  }

  // 4. Structure alignment (4h)
  if (watch?.structure?.h4) {
    const h4 = watch.structure.h4;
    const aligned = (side === 'long' && h4 === 'up') || (side === 'short' && h4 === 'down');
    const opposed = (side === 'long' && h4 === 'down') || (side === 'short' && h4 === 'up');
    if (aligned) {
      checks.push({ id: 'structure', label: `4h ${h4.toUpperCase()} (With Trend)`, status: 'good', detail: 'Aligned with higher timeframe 4h structure.', pts: 20 });
    } else if (opposed) {
      checks.push({ id: 'structure', label: `4h ${h4.toUpperCase()} (Counter-Trend)`, status: 'danger', detail: `Fighting 4h ${h4}trend. Counter-trend setups have a high failure rate.`, pts: -30 });
    } else {
      checks.push({ id: 'structure', label: '4h Structure Unclear', status: 'warning', detail: '4h is consolidating without a clear directional trend.', pts: -5 });
    }
  }

  // 5. BTC Macro Regime
  if (watch?.btc) {
    const ch = watch.btc.change1hPct;
    if (side === 'long') {
      if (watch.btc.isDumping || (ch !== null && ch < -0.8)) {
        checks.push({ id: 'btc', label: `BTC Dumping (${ch !== null ? ch.toFixed(1) + '%' : 'sharp drop'})`, status: 'danger', detail: 'Bitcoin is selling off sharply. Altcoin longs face severe liquidation contagion.', pts: -35 });
      } else if (ch !== null && ch < -0.3) {
        checks.push({ id: 'btc', label: `BTC Headwind (${ch.toFixed(1)}%)`, status: 'warning', detail: 'BTC is sagging over the last hour.', pts: -10 });
      } else {
        checks.push({ id: 'btc', label: `BTC Favorable (${ch !== null ? (ch >= 0 ? '+' : '') + ch.toFixed(1) + '%' : 'neutral'})`, status: 'good', detail: 'No macro Bitcoin selling pressure.', pts: 15 });
      }
    } else {
      if (ch !== null && ch > 1.0) {
        checks.push({ id: 'btc', label: `BTC Surging (+${ch.toFixed(1)}%)`, status: 'danger', detail: 'Bitcoin is expanding upward. Altcoin shorts risk violent squeezes.', pts: -30 });
      } else {
        checks.push({ id: 'btc', label: `BTC Neutral / Weak (${ch !== null ? ch.toFixed(1) + '%' : 'neutral'})`, status: 'good', detail: 'Favorable macro context for shorting.', pts: 15 });
      }
    }
  }

  // 6. Daily Range / Gas Tank (ADR)
  if (watch?.adr) {
    const used = watch.adr.usedPct;
    if (used >= 85) {
      checks.push({ id: 'adr', label: `Daily Range Exhausted (${used.toFixed(0)}%)`, status: 'danger', detail: 'Coin has consumed its typical daily range. Upside/downside is tapped out; high odds of stall or reversal.', pts: -25 });
    } else if (used >= 65) {
      checks.push({ id: 'adr', label: `Late in Daily Move (${used.toFixed(0)}%)`, status: 'warning', detail: 'More than 65% of typical daily expansion is already completed.', pts: -10 });
    } else {
      checks.push({ id: 'adr', label: `Room to Run (ADR ${used.toFixed(0)}% used)`, status: 'good', detail: 'Gas tank full: plenty of typical daily range remaining.', pts: 15 });
    }
  }

  // 7. Stop Geometry (Noise Check)
  if (stopOk && now !== null) {
    const dist = Math.abs(now - s);
    const distPct = (dist / now) * 100;
    const atr15 = watch?.atr15m ?? null;
    const ratio = atr15 && atr15 > 0 ? dist / atr15 : null;
    if (ratio !== null && ratio < 0.5) {
      checks.push({ id: 'stop', label: `Stop Too Tight (${ratio.toFixed(2)}x 15m ATR)`, status: 'danger', detail: `Stop is only ${distPct.toFixed(2)}% away, inside normal 15m candle noise. Guaranteed stop hunt.`, pts: -30 });
    } else if (distPct > 8.0) {
      checks.push({ id: 'stop', label: `Wide Stop (${distPct.toFixed(1)}%)`, status: 'warning', detail: 'Very wide stop requires tiny notional size and distant target.', pts: -10 });
    } else {
      checks.push({ id: 'stop', label: `Healthy Stop Buffer (${ratio !== null ? ratio.toFixed(1) + 'x ATR' : distPct.toFixed(1) + '%'})`, status: 'good', detail: 'Stop placed beyond immediate intra-candle noise.', pts: 15 });
    }
  }

  // 8. Active Danger / Reversal Warnings
  const activeWarnings = (watch?.warnings ?? []).filter((w) => w.side === 'both' || w.side === side);
  for (const w of activeWarnings) {
    if (w.level === 'danger') {
      checks.push({ id: w.code, label: w.title, status: 'danger', detail: w.detail, pts: -30 });
    } else if (w.level === 'caution' && w.code !== 'outside_window') {
      checks.push({ id: w.code, label: w.title, status: 'warning', detail: w.detail, pts: -10 });
    }
  }

  // 9. Reward to Risk
  if (stopOk && targetSide && rr !== null) {
    if (rr >= 2.5) {
      checks.push({ id: 'rr', label: `Reward:Risk ${rr.toFixed(2)}R`, status: 'good', detail: 'Strong mathematical asymmetry after taker fees.', pts: 15 });
    } else if (rr >= MIN_RR) {
      checks.push({ id: 'rr', label: `Reward:Risk ${rr.toFixed(2)}R`, status: 'good', detail: 'Meets minimum 2R threshold after round-trip costs.', pts: 10 });
    } else {
      checks.push({ id: 'rr', label: `Reward:Risk ${rr.toFixed(2)}R (Below 2R)`, status: 'danger', detail: 'Negative mathematical expectancy after fees and slippage.', pts: -25 });
    }
  }

  const hasDanger = checks.some((c) => c.status === 'danger');
  let score = 50 + checks.reduce((sum, c) => sum + c.pts, 0);
  if (hasDanger) score = Math.min(score, 45); // Danger flags cap the score
  score = Math.max(0, Math.min(100, Math.round(score)));

  const isBadTrade = hasDanger || score < 50;

  // Sound audible chime when a bad trade is detected
  useEffect(() => {
    if (isBadTrade && !chimeTriggered.current) {
      chimeTriggered.current = true;
      chime(false);
    }
  }, [isBadTrade]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ fill?: Filled & { notional: number }; pending?: boolean; entryPrice?: number; positionId?: string }>('/api/positions/open', {
        symbol,
        side,
        entry: effectiveEntry !== null ? effectiveEntry : undefined,
        stop: s,
        target: t,
        orderType: 'limit',
        note: note.trim() || undefined,
        maxHoldMin: defaults.maxHoldMin,
        entryTimeoutMin: defaults.entryTimeoutMin,
      });
      if (r.pending) {
        setPendingOrder({ entryPrice: r.entryPrice ?? effectiveEntry!, stop: s, target: t, positionId: r.positionId });
      } else if (r.fill) {
        setFilled(r.fill);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = 'mt-1 block w-full rounded-lg border border-line bg-card-2 px-2.5 py-1.5 text-sm tabular outline-none focus:border-accent';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center whitespace-normal bg-black/60 px-4 text-left" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div role="dialog" aria-label={`Take a position in ${coin(symbol)}`} className="w-full min-w-0 max-w-md max-h-[92vh] overflow-y-auto rounded-2xl border border-line bg-card p-5 shadow-2xl shadow-black/60" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Take a position · {coin(symbol)}</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink"><X size={16} /></button>
        </div>

        {pendingOrder ? (
          <div className="space-y-3 text-sm">
            <div className="rounded-xl border border-accent/40 bg-accent/10 p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-accent font-semibold">
                <Hourglass size={18} className="animate-pulse text-accent" />
                <span>Limit Order Placed at Key Level</span>
              </div>
              <p className="text-xs text-ink-2">
                Resting limit order placed at <b className="text-ink font-mono">{fmtPrice(pendingOrder.entryPrice)}</b>. Patiently waiting for price to pull back to the key level.
              </p>
              <p className="text-xs text-ink-3">
                Stop: <span className="font-mono text-critical/90">{fmtPrice(pendingOrder.stop)}</span> · Target: <span className="font-mono text-good/90">{pendingOrder.target ? fmtPrice(pendingOrder.target) : 'None'}</span>
              </p>
              <div className="rounded-lg bg-black/30 p-2.5 text-[11px] text-ink-3 border border-line/40 leading-relaxed">
                🛡️ <b>Disciplined Pullback Execution:</b> Market price was not chased. If price takes off without pulling back to the key level, the order expires safely without FOMO ("if we miss it that is it").
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110">Done</button>
              {pendingOrder.positionId && (
                <button
                  onClick={async () => {
                    if (!confirm('Cancel this pending limit order?')) return;
                    setBusy(true);
                    try {
                      await post(`/api/positions/${encodeURIComponent(pendingOrder.positionId!)}/cancel`);
                      onClose();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="rounded-xl border border-line px-3 py-2 text-xs text-ink-2 hover:border-critical hover:text-critical"
                >
                  Cancel Order
                </button>
              )}
            </div>
          </div>
        ) : filled ? (
          <div className="space-y-3 text-sm">
            <p className="font-semibold text-good">Filled {side} at {fmtPrice(filled.price)}</p>
            <p className="text-ink-2 tabular">Size {filled.qty} {coin(symbol)} (${filled.notional.toFixed(2)}) · stop {fmtPrice(filled.stop)} · target {filled.target === null ? 'none' : fmtPrice(filled.target)}</p>
            <p className="text-xs text-ink-3">It is on the Overview with the other open positions, managed like the engine's trades, and counted as "Manual" on the Trades page and in the results by model.</p>
            <button onClick={onClose} className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110">Done</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex overflow-hidden rounded-lg border border-line">
              {(['long', 'short'] as const).map((x) => (
                <button key={x} onClick={() => setSide(x)}
                  className={`flex-1 py-1.5 text-sm font-semibold transition ${side === x ? (x === 'long' ? 'bg-good/20 text-good' : 'bg-critical/20 text-critical') : 'bg-card-2 text-ink-2'}`}>{x}</button>
              ))}
            </div>
            <p className="flex justify-between text-sm"><span className="text-ink-3">Price now</span><span className="tabular font-semibold">{fmtPrice(now)}</span></p>

            {/* ---------------- 1. Patience Enforcer Card ---------------- */}
            <div className={`rounded-xl border p-3 transition ${
              patience.tone === 'danger'
                ? 'border-critical/60 bg-critical/10'
                : patience.tone === 'warning'
                ? 'border-amber-500/50 bg-amber-500/10'
                : patience.tone === 'good'
                ? 'border-good/50 bg-good/10'
                : 'border-blue-500/40 bg-blue-500/10'
            }`}>
              <div className="flex items-start gap-2.5">
                {patience.stage === 'wait_level' || patience.stage === 'counter_plan' ? (
                  <PauseCircle className="mt-0.5 shrink-0 text-critical" size={18} />
                ) : patience.stage === 'wait_confirm' ? (
                  <Hourglass className="mt-0.5 shrink-0 text-amber-400 animate-pulse" size={18} />
                ) : patience.stage === 'confirmed' ? (
                  <CheckCircle2 className="mt-0.5 shrink-0 text-good" size={18} />
                ) : (
                  <Clock className="mt-0.5 shrink-0 text-blue-400" size={18} />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${
                      patience.tone === 'danger' ? 'text-critical' : patience.tone === 'warning' ? 'text-amber-400' : patience.tone === 'good' ? 'text-good' : 'text-blue-400'
                    }`}>
                      Patience Copilot · {patience.badge}
                    </span>
                  </div>
                  <p className="text-xs font-bold text-ink leading-snug mt-0.5">{patience.title}</p>
                  <p className="text-[11px] text-ink-2 mt-1 leading-normal">{patience.detail}</p>

                  {idea?.plan && idea.plan.stop !== null && idea.plan.targets[0]?.price && (
                    <button
                      type="button"
                      onClick={applyPlannedLevels}
                      className="mt-2 inline-flex items-center gap-1 rounded-md bg-card/80 px-2 py-1 text-[11px] font-semibold text-accent ring-1 ring-accent/30 hover:bg-card"
                    >
                      <Sparkles size={11} /> Adopt Planned Levels (Stop: {fmtPrice(idea.plan.stop)} · TP: {fmtPrice(idea.plan.targets[0].price)})
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* ---------------- 2. Pattern Memory Card ---------------- */}
            {pattern && (
              <div className="rounded-xl border border-line bg-card-2/60 p-2.5 text-xs">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="text-accent" size={13} />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-3">Pattern Memory</span>
                  </div>
                  <span className={`font-semibold tabular ${
                    pattern.compositeVerdict === 'strong_edge' || pattern.compositeVerdict === 'positive_edge'
                      ? 'text-good'
                      : pattern.compositeVerdict === 'neutral'
                      ? 'text-ink-2'
                      : 'text-critical'
                  }`}>
                    {pattern.winRatePct}% Win Rate · {pattern.expectancyR >= 0 ? '+' : ''}{pattern.expectancyR}R EV
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 text-[10px]">
                  <span className={`rounded px-1.5 py-0.5 font-medium ${pattern.profile.trendAlign === 'with_trend' ? 'bg-good/15 text-good' : pattern.profile.trendAlign === 'counter_trend' ? 'bg-critical/15 text-critical' : 'bg-card text-ink-3'}`}>
                    4H {pattern.profile.trendAlign.replace('_', ' ').toUpperCase()}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 font-medium ${pattern.profile.dealingZone === 'discount' ? 'bg-good/15 text-good' : pattern.profile.dealingZone === 'premium' ? 'bg-critical/15 text-critical' : 'bg-card text-ink-3'}`}>
                    {pattern.profile.dealingZone.toUpperCase()}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 font-medium ${pattern.profile.adrStatus === 'fresh' ? 'bg-good/15 text-good' : pattern.profile.adrStatus === 'exhausted' ? 'bg-critical/15 text-critical' : 'bg-card text-ink-3'}`}>
                    ADR {pattern.profile.adrStatus.toUpperCase()}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 font-medium ${pattern.profile.session === 'killzone' ? 'bg-accent/15 text-accent' : 'bg-card text-ink-3'}`}>
                    {pattern.profile.session === 'killzone' ? 'KILLZONE' : 'OFF-SESSION'}
                  </span>
                  {pattern.volumeDiagnosis && (
                    <span className={`rounded px-1.5 py-0.5 font-medium ${
                      pattern.volumeDiagnosis.regime === 'expansion' ? 'bg-good/15 text-good'
                      : pattern.volumeDiagnosis.regime === 'climax' || pattern.volumeDiagnosis.regime === 'divergence' ? 'bg-critical/15 text-critical'
                      : 'bg-warning/15 text-warning'
                    }`}>
                      {pattern.volumeDiagnosis.label.toUpperCase()} ({pattern.volumeDiagnosis.rvol}x)
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-[11px] text-ink-3 leading-snug">{pattern.summary}</p>
                <p className={`mt-1 text-[10px] ${pattern.assumedPct >= 50 ? 'text-warning' : 'text-ink-3'}`}>
                  {100 - pattern.assumedPct}% from your closed trades · {pattern.assumedPct}% built-in assumptions
                </p>
                {pattern.volumeDiagnosis && (
                  <div className="mt-2 rounded-lg bg-black/30 p-2 text-[11px] text-ink-2 border border-line/40">
                    <span className="font-semibold text-accent flex items-center gap-1 mb-0.5">
                      <Zap size={11} /> Why the pattern is behaving this way:
                    </span>
                    <span>{pattern.volumeDiagnosis.whyItHappened}</span>
                  </div>
                )}
              </div>
            )}

            {/* ---------------- 3. Pre-Flight Safety Banner ---------------- */}
            <div className={`rounded-xl border p-3 transition ${isBadTrade ? 'border-critical/50 bg-critical/10' : score >= 70 ? 'border-good/40 bg-good/10' : 'border-warning/40 bg-warning/10'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isBadTrade ? <ShieldAlert className="text-critical" size={18} /> : score >= 70 ? <ShieldCheck className="text-good" size={18} /> : <AlertTriangle className="text-warning" size={18} />}
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-3">Pre-Flight Safety Check</span>
                    <p className="text-xs font-bold">
                      {isBadTrade ? (
                        <span className="text-critical">⚠️ High Risk / Bad Trade ({score}/100)</span>
                      ) : score >= 70 ? (
                        <span className="text-good">✓ High Probability ({score}/100)</span>
                      ) : (
                        <span className="text-warning">Moderate Setup ({score}/100)</span>
                      )}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowBreakdown(!showBreakdown)}
                  className="inline-flex items-center gap-1 rounded bg-card/60 px-2 py-0.5 text-[11px] font-semibold text-ink-2 hover:text-ink"
                >
                  {showBreakdown ? <>Hide <ChevronUp size={12} /></> : <>Details <ChevronDown size={12} /></>}
                </button>
              </div>

              {/* Expandable Breakdown of Checklist */}
              {showBreakdown && (
                <ul className="mt-2.5 space-y-1.5 border-t border-line/40 pt-2 text-xs">
                  {checks.map((c, idx) => (
                    <li key={c.id + idx} className="flex items-start gap-1.5">
                      {c.status === 'good' ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-good" /> : c.status === 'danger' ? <XCircle size={13} className="mt-0.5 shrink-0 text-critical" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />}
                      <div>
                        <span className={`font-semibold ${c.status === 'good' ? 'text-good' : c.status === 'danger' ? 'text-critical' : 'text-warning'}`}>{c.label}: </span>
                        <span className="text-ink-2">{c.detail}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* Friction: Interceptor Checkbox on Danger / Poor Odds */}
              {isBadTrade && (
                <label className="mt-2.5 flex items-start gap-2 rounded-lg border border-critical/30 bg-black/40 p-2 text-xs text-ink-2 cursor-pointer hover:bg-black/50">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="mt-0.5 rounded border-line text-critical focus:ring-critical"
                  />
                  <span><b>Acknowledge Risks:</b> I understand this setup fights higher-timeframe structure, is in no-man's land without confirmation, or has negative empirical EV, and choose to proceed anyway.</span>
                </label>
              )}
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-ink-3">
                <span className="font-semibold text-ink-2">Key Level Entry (Limit Pullback Only)</span>
                <div className="flex items-center gap-2">
                  {idea?.plan?.entry != null && (
                    <button type="button" onClick={() => setEntry(short(idea.plan!.entry))} className="text-[11px] text-accent hover:underline">
                      Key Level ({short(idea.plan!.entry)})
                    </button>
                  )}
                  {idea?.plan?.entryLow != null && (
                    <button type="button" onClick={() => setEntry(short((idea.plan!.entryLow! + idea.plan!.entryHigh!) / 2))} className="text-[11px] text-accent hover:underline">
                      Zone Mid ({short((idea.plan!.entryLow! + idea.plan!.entryHigh!) / 2)})
                    </button>
                  )}
                  {now != null && (
                    <button type="button" onClick={() => setEntry(short(now))} className="text-[11px] text-ink-3 hover:underline">
                      Mark ({fmtPrice(now)})
                    </button>
                  )}
                </div>
              </div>
              <input value={entry} onChange={(e) => setEntry(e.target.value)} placeholder={`Key level limit price (e.g. ${fmtPrice(idea?.plan?.entry ?? now)})`} inputMode="decimal" className={input} />
              <p className="text-[11px] text-ink-3">
                Always limits entry to the Key Level. Waits for a retest pullback — never chases at market. If price runs away without pulling back, the order expires safely without FOMO.
              </p>
            </div>

            <label className="block text-xs text-ink-3">Stop (required)
              <input value={stop} onChange={(e) => setStop(e.target.value)} inputMode="decimal" className={`${input} ${stop && !stopOk ? 'border-critical' : ''}`} />
            </label>
            <label className="block text-xs text-ink-3">Target (required: at least {MIN_RR}R after costs)
              <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" className={`${input} ${target && !targetOk ? 'border-critical' : ''}`} />
            </label>
            <label className="block text-xs text-ink-3">Note
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={input} />
            </label>
            <p className="text-xs text-ink-3 tabular">
              {stopPct !== null ? <>Stop {pct(stopPct, 2)} away{rr !== null ? <> · reward:risk {rr.toFixed(2)}R</> : null}. </> : stop ? <span className="text-critical">The stop must be {side === 'long' ? 'below' : 'above'} the entry price. </span> : null}
              {target && !targetSide && <span className="text-critical">The target must be {side === 'long' ? 'above' : 'below'} the entry price. </span>}
              {targetSide && rr !== null && rr < MIN_RR && <span className="text-critical">Only {rr.toFixed(2)}R: move the target to at least {MIN_RR}R, or the stop closer. </span>}
              {`Executing as a Key Level limit order at ${fmtPrice(effectiveEntry)}, waiting for pullback, sized so the stop loses about 1% of the account (0.5% on wild coins).`}
            </p>

            {error && <p className="rounded-lg bg-critical/10 px-3 py-2 text-sm text-critical">{error}</p>}

            <button
              onClick={() => void submit()}
              disabled={busy || !stopOk || !targetOk || (isBadTrade && !acknowledged)}
              className={`w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed ${
                isBadTrade
                  ? 'bg-critical'
                  : side === 'long' ? 'bg-good' : 'bg-critical'
              }`}
            >
              {busy ? 'Placing Limit Order…' : isBadTrade && !acknowledged ? `⚠️ Acknowledge Risk Checklist to Place (${score}/100)` : `Place ${side.toUpperCase()} Limit at ${fmtPrice(effectiveEntry)} (Wait for Pullback)`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
