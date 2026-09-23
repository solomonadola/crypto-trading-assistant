/**
 * Counts what this copy actually costs Firestore.
 *
 * Reads are billed per document returned, so "what used the 50,000 reads?" has
 * a precise answer - it was just never measured. Every call site reports here,
 * and the totals show up in GET /api/status (server) and the Firebase panel
 * (browser), so the next time a limit is hit the cause is visible rather than
 * inferred.
 */
export type UsageSource =
  | 'startup-full'      // building the trade list at start: one read per trade
  | 'weekly-full'       // the periodic full re-read
  | 'reconcile'         // the server comparing itself with Firestore
  | 'listener'          // documents delivered by the changes-only listener
  | 'count-check'       // "how many trades are there?" (1 read)
  | 'open-check'        // open positions read before a deploy
  | 'history'           // a History refresh or force sync
  | 'other';

interface Counter {
  reads: number;
  writes: number;
  calls: number;
}

const bySource = new Map<UsageSource, Counter>();
let since = Date.now();

function bucket(source: UsageSource): Counter {
  let c = bySource.get(source);
  if (!c) {
    c = { reads: 0, writes: 0, calls: 0 };
    bySource.set(source, c);
  }
  return c;
}

/** `documents` is what Firestore returned: that is what is billed. */
export function countRead(source: UsageSource, documents: number): void {
  const c = bucket(source);
  // An empty result still costs one read.
  c.reads += Math.max(1, documents);
  c.calls += 1;
}

export function countWrite(source: UsageSource, documents = 1): void {
  const c = bucket(source);
  c.writes += documents;
  c.calls += 1;
}

export interface Usage {
  since: number;
  reads: number;
  writes: number;
  bySource: Record<string, Counter>;
}

export function getUsage(): Usage {
  const out: Record<string, Counter> = {};
  let reads = 0;
  let writes = 0;
  for (const [source, c] of bySource) {
    out[source] = { ...c };
    reads += c.reads;
    writes += c.writes;
  }
  return { since, reads, writes, bySource: out };
}

export function resetUsage(): void {
  bySource.clear();
  since = Date.now();
}

/** A one-line summary for logs and the status endpoint. */
export function usageSummary(): string {
  const u = getUsage();
  const hours = Math.max(0.01, (Date.now() - u.since) / 3_600_000);
  const parts = Object.entries(u.bySource)
    .filter(([, c]) => c.reads || c.writes)
    .sort((a, b) => b[1].reads - a[1].reads)
    .map(([s, c]) => `${s} ${c.reads}r/${c.writes}w`);
  return `${u.reads} reads, ${u.writes} writes in ${hours.toFixed(1)}h (${(u.reads / hours).toFixed(0)} reads/h) - ${parts.join(', ') || 'nothing yet'}`;
}
