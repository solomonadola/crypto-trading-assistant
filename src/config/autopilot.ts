/**
 * Auto-Pilot tunables.
 *
 * These were previously magic numbers scattered through App.tsx. Pulling them
 * out makes the behaviour reviewable and lets a single experiment change one
 * variable at a time (see AUDIT.md section 11).
 *
 * Defaults reflect what the replay studies measured - see STUDY_A_RESULTS.md.
 */
export interface AutoPilotConfig {
  /**
   * Short entries. Measured forward returns were negative in both samples:
   * in-sample t = -2.02 at 5m; out-of-sample the short leg collapsed from
   * -38 bps (t = -4.08) to -6.65 bps (t = -1.16). Alt perps also carry
   * negative drift and adverse funding for shorts. Off unless switched on
   * (the switch in the app, or the saved choice); tools/backtest.mjs --shorts
   * measures them on the current rules.
   */
  allowShorts: boolean;

  /**
   * Minimum wall-clock gap between two auto-pilot deployments.
   *
   * Previously the only guard was a 1500ms ref that cleared on its own, while
   * the effect re-fired on a 10s tick AND on every `trades` change - so three
   * or more positions could open from a single 30-second-old snapshot, seconds
   * apart. Because the ranking is a common function of 24h change, those
   * positions were near-maximally correlated: effectively one oversized bet
   * that then resolved as a cluster.
   */
  minMsBetweenDeploys: number;

  /**
   * Only deploy once per distinct market snapshot. Prices refresh every 30s but
   * the deploy effect runs every 10s, so without this the same stale snapshot
   * is acted on repeatedly.
   */
  oneDeployPerSnapshot: boolean;

  /** Minimum conviction score. Note the score proved non-monotonic against
   *  forward returns, so this is a floor, not a ranking signal. Raised to 82
   *  to filter out lower-decile noise and eliminate turnover fee drag. */
  minScore: number;

  /**
   * Max simultaneous positions. Ten names selected by a common 24h-momentum
   * rule are not ten independent bets - realised alt correlation in a
   * directional move runs ~0.85. Lowering this is also the cheapest way to cut
   * turnover, which is the one cost that is certain.
   */
  maxConcurrentTrades: number;

  /**
   * Enforce the market-regime gates (consolidation lock, BTC flash-crash armor,
   * loss-streak circuit breaker) before deploying.
   *
   * These live in marketRegimeService and were never called by anything, so the
   * auto-pilot traded with no regime awareness. Set false only to reproduce the
   * old ungated behaviour for a controlled comparison.
   */
  enforceRegimeGates: boolean;

  /**
   * Enforce liquidity session gating (blocks entries during the 21:00-00:00 UTC
   * dead gap and weekend low-volume chop traps where order books thin out and
   * false wicks cause stop-outs).
   */
  enforceSessionFilter: boolean;
}

const SHORTS_STORAGE_KEY = 'crypto_scalp_autopilot_shorts';

export function getAllowShorts(): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(SHORTS_STORAGE_KEY);
      if (saved === 'false') return false;
      if (saved === 'true') return true;
    }
  } catch {}
  return false; // Off by default: see allowShorts above
}

export function setAllowShorts(allowed: boolean): void {
  AUTOPILOT_CONFIG.allowShorts = allowed;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SHORTS_STORAGE_KEY, String(allowed));
    }
  } catch {}
}

export const AUTOPILOT_CONFIG: AutoPilotConfig = {
  allowShorts: getAllowShorts(),
  minMsBetweenDeploys: 180_000,
  oneDeployPerSnapshot: true,
  minScore: 84,
  maxConcurrentTrades: 5,
  enforceRegimeGates: true,
  enforceSessionFilter: true,
};
