// Dashboard shell: navigation, live status, controls, and the pages.
import { useEffect, useState } from 'react';
import { CandlestickChart, Crosshair, FlaskConical, History, LayoutDashboard, Pause, Play, Power, Radio, RotateCcw, Zap } from 'lucide-react';
import { post, usePoll, type Status } from './lib/api';
import { hhmm, words } from './lib/format';
import { Badge } from './components/ui';
import { Overview } from './pages/Overview';
import { Market } from './pages/Market';
import { ChartPage } from './pages/ChartPage';
import { Signals } from './pages/Signals';
import { Trades } from './pages/Trades';
import { FilterLab } from './pages/FilterLab';

const PAGES = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'market', label: 'Market', icon: Crosshair },
  { id: 'chart', label: 'Chart', icon: CandlestickChart },
  { id: 'signals', label: 'Signals', icon: Radio },
  { id: 'trades', label: 'Trades', icon: History },
  { id: 'lab', label: 'Filter lab', icon: FlaskConical },
] as const;
type PageId = (typeof PAGES)[number]['id'];

/** #/chart/SOLUSDT -> { page: 'chart', symbol: 'SOLUSDT' } */
function readHash(): { page: PageId; symbol: string } {
  const [, page, symbol] = window.location.hash.split('/');
  return { page: (PAGES.some((p) => p.id === page) ? page : 'overview') as PageId, symbol: symbol || 'BTCUSDT' };
}

export default function App() {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const on = () => setRoute(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (page: string, symbol?: string) => {
    window.location.hash = `/${page}${page === 'chart' ? `/${symbol ?? route.symbol}` : ''}`;
  };

  const { data: status, error, reload } = usePoll<Status>('/api/status', 5_000);
  const live = status?.feed.state === 'live';
  const control = async (path: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    try { await post(`/api/control/${path}`); reload(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-card/60 px-3 py-5 md:flex">
        <div className="mb-8 flex items-center gap-2 px-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-accent via-london to-newyork shadow-lg shadow-accent/30">
            <Zap size={18} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-bold leading-tight">Session Engine</p>
            <p className="text-[11px] text-ink-3">simulation · futures</p>
          </div>
        </div>
        <nav className="space-y-1">
          {PAGES.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => go(id)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${route.page === id ? 'bg-accent/15 font-semibold text-ink ring-1 ring-accent/30' : 'text-ink-2 hover:bg-card-2 hover:text-ink'}`}>
              <Icon size={16} className={route.page === id ? 'text-accent' : ''} />{label}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-1 px-2 text-[11px] text-ink-3">
          <p>v{status?.engineVersion ?? '…'} · config {status?.configHash ?? '…'}</p>
          <p>No exchange account. Public Binance data, simulated fills.</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-page/85 px-4 py-3 backdrop-blur md:px-6">
          <h1 className="text-lg font-semibold">{PAGES.find((p) => p.id === route.page)?.label}</h1>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {error && <Badge tone="critical">engine unreachable</Badge>}
            {status && (
              <Badge tone={live ? 'good' : 'warning'} title={status.feed.lastError ?? undefined}>
                <span className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse bg-good' : 'bg-warning'}`} />
                feed {status.feed.state} · {status.feed.symbols.length} coins
              </Badge>
            )}
            {status?.engineClock ? <Badge tone="muted">engine {hhmm(status.engineClock)} UTC</Badge> : null}
            {status?.halted ? (
              <>
                <Badge tone="critical">stopped: {words(status.halted.reason)}</Badge>
                <button onClick={() => control('resume')} className="inline-flex items-center gap-1 rounded-lg bg-good/20 px-3 py-1.5 text-xs font-semibold text-good ring-1 ring-good/40 hover:bg-good/30"><Play size={12} />Resume</button>
              </>
            ) : (
              <button onClick={() => control('pause')} title="Stop opening new trades; open positions keep being managed"
                className="inline-flex items-center gap-1 rounded-lg bg-card-2 px-3 py-1.5 text-xs text-ink-2 ring-1 ring-line hover:text-ink"><Pause size={12} />Pause entries</button>
            )}
            <button onClick={() => control('kill', 'Close every position at market and stop opening trades?')}
              className="inline-flex items-center gap-1 rounded-lg bg-critical/15 px-3 py-1.5 text-xs font-semibold text-critical ring-1 ring-critical/40 hover:bg-critical/25"><Power size={12} />Kill</button>
            <button onClick={() => control('reset', 'Reset the simulated balance to the starting amount? Trade history stays in the log.')}
              title="Reset the simulated balance (only with no open positions)"
              className="inline-flex items-center gap-1 rounded-lg bg-card-2 px-3 py-1.5 text-xs text-ink-2 ring-1 ring-line hover:text-ink"><RotateCcw size={12} />Reset</button>
          </div>
          <nav className="flex w-full gap-1 overflow-x-auto md:hidden">
            {PAGES.map(({ id, label }) => (
              <button key={id} onClick={() => go(id)} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs ${route.page === id ? 'bg-accent text-white' : 'bg-card-2 text-ink-2'}`}>{label}</button>
            ))}
          </nav>
        </header>

        <main className="flex-1 px-4 py-5 md:px-6">
          {route.page === 'overview' && <Overview go={go} />}
          {route.page === 'market' && <Market go={go} />}
          {route.page === 'chart' && <ChartPage symbol={route.symbol} setSymbol={(s) => go('chart', s)} />}
          {route.page === 'signals' && <Signals go={go} />}
          {route.page === 'trades' && <Trades go={go} />}
          {route.page === 'lab' && <FilterLab go={go} />}
        </main>
      </div>
    </div>
  );
}
