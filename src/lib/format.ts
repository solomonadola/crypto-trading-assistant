// Number and time formatting for the dashboard. Times are UTC throughout:
// sessions, funding and the engine all run on UTC.

export const usd = (x: number | null | undefined, dp = 2) =>
  x === null || x === undefined || !Number.isFinite(x) ? '–' : `$${x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

/** Signed money: +$1.23 / −$1.23. */
export const signedUsd = (x: number | null | undefined, dp = 2) =>
  x === null || x === undefined || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : '−'}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export const pct = (x: number | null | undefined, dp = 2, signed = false) =>
  x === null || x === undefined || !Number.isFinite(x) ? '–' : `${signed && x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(dp)}%`;

/** Prices keep about 5 significant digits, whatever their size. */
export const price = (x: number | null | undefined) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return '–';
  const abs = Math.abs(x);
  const dp = abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 7;
  return x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

export const compact = (x: number | null | undefined) =>
  x === null || x === undefined ? '–' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x);

export const hhmm = (t: number | null | undefined) => (t ? new Date(t).toISOString().slice(11, 16) : '–');
export const dateTime = (t: number | null | undefined) => (t ? new Date(t).toISOString().slice(5, 16).replace('T', ' ') : '–');

/** 2h 05m / 12m / 45s */
export function duration(ms: number): string {
  if (!(ms > 0)) return '0m';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export const coin = (symbol: string) => symbol.replace(/USDT$/, '');

/** Snake-case reasons to words: filter_chop.adx -> chop adx. */
export const words = (s: string | null | undefined) =>
  (s ?? '').replace(/^filter_/, '').replace(/^risk_/, 'risk: ').replace(/^session_/, 'session: ').replace(/[._]/g, ' ');

export const SESSION_LABEL: Record<string, string> = { asian: 'Asian', london: 'London', newyork: 'New York' };

/** The engine's setups (ENGINE_PLAN.md Section 18). */
export const MODEL_LABEL: Record<string, string> = { zone_sweep: 'Zone sweep (M1)', session_sweep: 'Session sweep (M3)', pullback: 'Pullback (classic)', htf_poi: '4h POI + CHoCH (M4)', manual: 'Manual' };

/** Liquidity levels where stops sit (Section 18.3). */
export const LIQUIDITY_LABEL: Record<string, string> = {
  PDH: 'Previous day high', PDL: 'Previous day low', asian_high: 'Asian high', asian_low: 'Asian low',
  london_high: 'London high', london_low: 'London low', EQH: 'Equal highs', EQL: 'Equal lows',
  '4h_swing_high': '4h swing high', '4h_swing_low': '4h swing low',
};
export const liquidityName = (name: string | null | undefined) => (name ? LIQUIDITY_LABEL[name] ?? words(name) : '');
