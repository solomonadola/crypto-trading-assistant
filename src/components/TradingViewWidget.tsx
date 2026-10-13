// TradingView's own chart (their free embeddable widget), for drawing by hand
// with their tools and indicators. It is TradingView's page in a frame: the
// app cannot draw its levels on it, and drawings are not kept unless you are
// signed in to TradingView. The app's own chart is the other tab.
//
// "Our analysis" puts the app's analysis on TradingView itself: two Pine
// scripts to paste into TradingView's Pine editor once (the structure and
// levels indicator, and this coin's plan), then shown or hidden there with the
// indicator's eye icon.
import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardCopy, ExternalLink, Layers } from 'lucide-react';
import structurePine from '../../tradingview/structure.pine?raw';
import { planPine } from '../lib/pine';
import type { TradeIdea } from '../../shared/types';
import type { HtfPoiView } from './charts';

const OURS_KEY = 'tradingview-ours';

/** Copies text, with a fallback for browsers without the clipboard API (or outside a secure page). */
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={() => void copy(text).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); })}
      className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110">
      {done ? <Check size={13} /> : <ClipboardCopy size={13} />}{done ? 'Copied' : label}
    </button>
  );
}

/** The two scripts and how to add them; shown when "Our analysis" is on. */
function OurAnalysis({ symbol, idea, htf }: { symbol: string; idea: TradeIdea | null; htf: { long: HtfPoiView[]; short: HtfPoiView[] } | null }) {
  const plan = idea ? planPine(symbol, idea, htf) : null;
  const step = 'flex gap-2 text-xs text-ink-2';
  const n = 'grid h-5 w-5 shrink-0 place-items-center rounded-full bg-card text-[11px] font-semibold text-ink';
  return (
    <div className="mt-3 grid gap-4 rounded-xl border border-accent/40 bg-accent/5 p-4 lg:grid-cols-2">
      <div className="space-y-2">
        <p className="text-sm font-semibold">1 · Structure & levels indicator <span className="font-normal text-ink-3">(once, works on every coin)</span></p>
        <p className="text-xs text-ink-3">HH/HL/LH/LL, BOS and CHoCH on closes, the protected level, EMA 50/200, previous day and Asian high/low, the open windows and the stretched warning: the dashboard's rules, worked out live by TradingView.</p>
        <CopyButton label="Copy indicator" text={structurePine} />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-semibold">2 · This coin's plan <span className="font-normal text-ink-3">(a snapshot of now)</span></p>
        <p className="text-xs text-ink-3">
          {idea?.plan?.entry != null ? `The ${idea.plan.direction} plan's entry zone, stop loss and take-profit, ` : 'No plan now: the 24h box, '}
          the nearest 4h zones and the liquidity levels. Copy it again when the plan changes.
        </p>
        {plan ? <CopyButton label={`Copy ${symbol.replace(/USDT$/, '')} plan`} text={plan} /> : <p className="text-xs text-ink-3">Loading the plan…</p>}
      </div>
      <ol className="space-y-1.5 lg:col-span-2">
        <li className={step}><span className={n}>1</span>Open the coin on TradingView (signed in, a free account is enough):
          <a href={`https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}.P`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">{symbol}.P on TradingView <ExternalLink size={11} /></a></li>
        <li className={step}><span className={n}>2</span>Open the Pine Editor (bottom of the chart), select everything, paste, then Save and "Add to chart".</li>
        <li className={step}><span className={n}>3</span>Saved scripts stay under Indicators → My scripts. Turn either on or off with the eye icon next to its name on the chart.</li>
      </ol>
      <p className="text-[11px] text-ink-3 lg:col-span-2">
        The chart above is TradingView's free widget: it cannot load your own scripts, so the analysis shows on your TradingView chart, not in this frame.
      </p>
    </div>
  );
}

/** The app's timeframes as TradingView intervals. */
const INTERVAL: Record<string, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240' };

export function TradingViewWidget({ symbol, tf, idea = null, htf = null }: { symbol: string; tf: string; idea?: TradeIdea | null; htf?: { long: HtfPoiView[]; short: HtfPoiView[] } | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [ours, setOurs] = useState<boolean>(() => { try { return localStorage.getItem(OURS_KEY) === 'on'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(OURS_KEY, ours ? 'on' : 'off'); } catch { /* storage unavailable */ } }, [ours]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.type = 'text/javascript';
    // The widget reads its settings from the script's text.
    script.text = JSON.stringify({
      // A fixed height: with autosize the frame collapses to a strip inside this page's layout.
      autosize: false,
      width: '100%',
      height: 640,
      symbol: `BINANCE:${symbol}.P`,   // the USDT perpetual
      interval: INTERVAL[tf] ?? '15',
      timezone: 'Etc/UTC',
      theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      style: '1',
      locale: 'en',
      allow_symbol_change: true,
      hide_side_toolbar: false,       // the drawing tools
      withdateranges: true,
      save_image: true,
      support_host: 'https://www.tradingview.com',
    });
    el.appendChild(script);
    return () => { el.innerHTML = ''; };
  }, [symbol, tf]);
  return (
    <div>
      <label className="mb-2 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-card-2 px-3 py-1.5 text-xs">
        <input type="checkbox" checked={ours} onChange={() => setOurs((o) => !o)} className="accent-[var(--color-accent)]" />
        <Layers size={13} className="text-accent" />Our analysis on TradingView
      </label>
      {ours && <OurAnalysis symbol={symbol} idea={idea} htf={htf} />}
      <div ref={box} className="tradingview-widget-container min-h-[640px] w-full overflow-hidden rounded-lg" />
      <p className="mt-2 text-xs text-ink-3">
        Chart by <a href={`https://www.tradingview.com/symbols/${symbol}.P/?exchange=BINANCE`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">TradingView</a>.
        Their drawing tools are on the left; drawings are kept only when you are signed in to TradingView. The app's levels and plan are on the Engine chart tab, and on your own TradingView chart with "Our analysis".
      </p>
    </div>
  );
}
