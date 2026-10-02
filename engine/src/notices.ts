// Which signals the dashboard is notified about: confirmations (taken or
// skipped by a rule) that just happened, not those replayed after a restart.
// Pure: the current time is passed in.
import type { ConfirmationNotice, SignalRecord } from '../../shared/types';

/** Older confirmations are being replayed (a restart catching up), not happening now. */
export const NOTIFY_MAX_AGE_MS = 10 * 60_000;


export function noticesFor(signals: SignalRecord[], now: number): ConfirmationNotice[] {
  return signals
    .filter((s) => (s.status === 'taken' || s.status === 'filtered') && now - s.time <= NOTIFY_MAX_AGE_MS)
    .map((s) => {
      const p = s.payload as { plan?: { entry: number; stop: number; target: number; rewardRisk: number }; speed?: string; swept?: { name: string }; sweep?: string | null };
      return {
        time: s.time, symbol: s.symbol, direction: s.direction, setup: s.setup, status: s.status as 'taken' | 'filtered', reason: s.reason,
        entry: p.plan?.entry ?? null, stop: p.plan?.stop ?? null, target: p.plan?.target ?? null, rewardRisk: p.plan?.rewardRisk ?? null,
        speed: p.speed ?? null, swept: p.swept?.name ?? p.sweep ?? null,
      };
    });
}
