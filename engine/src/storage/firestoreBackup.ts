// Firestore as a backup of the trade log (ENGINE_PLAN.md Section 4A.4), for
// hosts whose disk does not survive a restart (AI Studio / Cloud Run).
//
// Written: every trade event (batched), the history tables (signal records,
// shadow results, the equity curve) and one state document holding the
// engine clock, the universe, the watchlist and the single-engine lease.
// Read: on a start with an empty database, and when taking over from another
// engine. Browsers never touch it.
//
//   {prefix}_events/{zero-padded event id}
//   {prefix}_signals|_shadow_results|_equity/{zero-padded id or time}
//   {prefix}_state/engine   { clock, lastEventId, universe, watchlist, holder, leaseUntil, updatedAt }
import { initializeApp, getApps, applicationDefault, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { TradeEvent } from '../../../shared/types';
import { mergeState, type HistoryRow, type HistoryTable } from './history';

export interface BackupState {
  clock: number;
  lastEventId: number;
  universe: string[];
  /** Coins added by hand for analysis only. */
  watchlist?: string[];
}

export interface FirebaseTarget {
  projectId: string;
  databaseId?: string;
}

const pad = (id: number) => String(id).padStart(12, '0');

export class FirestoreBackup {
  private readonly db: Firestore;
  private readonly prefix: string;
  private pushedUpTo = 0;
  /** Per history table, the newest key known to be in Firestore. */
  private readonly historyPushed = new Map<string, number>();

  private constructor(db: Firestore, namespace: string, readonly holder: string) {
    this.db = db;
    this.prefix = `engine_${namespace}`;
  }

  /**
   * Connects with the host's credentials (Cloud Run's service account, or
   * GOOGLE_APPLICATION_CREDENTIALS). Throws if there are none or Firestore
   * cannot be read. Credentials are checked before the Firestore client is
   * created: its connection is made in the background and fails there.
   */
  static async connect(target: FirebaseTarget, namespace: string, holder: string): Promise<FirestoreBackup> {
    // The Firestore emulator (tests) needs no credentials.
    const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
    const credential = emulator ? undefined : applicationDefault();
    if (credential) await credential.getAccessToken();
    const app: App = getApps().find((a) => a.name === 'engine-backup')
      ?? initializeApp({ ...(credential ? { credential } : {}), projectId: target.projectId }, 'engine-backup');
    const backup = new FirestoreBackup(target.databaseId ? getFirestore(app, target.databaseId) : getFirestore(app), namespace, holder);
    await backup.stateDoc.get();
    return backup;
  }

  private get stateDoc() {
    return this.db.collection(`${this.prefix}_state`).doc('engine');
  }

  /** The saved state and every event after `afterId`, oldest first; null state if nothing was ever saved. */
  async restore(afterId = 0): Promise<{ state: BackupState | null; events: TradeEvent[] }> {
    const snap = await this.stateDoc.get();
    const state = snap.exists ? (snap.data() as BackupState) : null;
    const events: TradeEvent[] = [];
    let cursor = pad(afterId);
    for (;;) {
      const page = await this.db.collection(`${this.prefix}_events`).orderBy('__name__').startAfter(cursor).limit(500).get();
      if (page.empty) break;
      for (const d of page.docs) events.push(d.data() as TradeEvent);
      cursor = page.docs[page.docs.length - 1].id;
    }
    // Everything up to the newest event known to be in Firestore needs no writing again.
    this.pushedUpTo = Math.max(this.pushedUpTo, state?.lastEventId ?? 0, events.length ? Number(events[events.length - 1].id) : 0);
    return { state, events };
  }

  /** Writes events not pushed yet, in batches. Returns how many were written. */
  async pushEvents(events: TradeEvent[]): Promise<number> {
    const fresh = events.filter((e) => (e.id ?? 0) > this.pushedUpTo);
    for (let i = 0; i < fresh.length; i += 400) {
      const batch = this.db.batch();
      // Through JSON: Firestore refuses fields whose value is undefined.
      for (const e of fresh.slice(i, i + 400)) batch.set(this.db.collection(`${this.prefix}_events`).doc(pad(e.id!)), JSON.parse(JSON.stringify(e)));
      await batch.commit();
      this.pushedUpTo = fresh[Math.min(i + 400, fresh.length) - 1].id!;
    }
    return fresh.length;
  }

  private history(t: HistoryTable) {
    return this.db.collection(`${this.prefix}_${t.name}`);
  }

  /** History rows whose `field` is above `after`, oldest first. */
  async readHistory(t: HistoryTable, field: string, after: number): Promise<HistoryRow[]> {
    const rows: HistoryRow[] = [];
    let q = this.history(t).where(field, '>', after).orderBy(field).limit(500);
    for (;;) {
      const page = await q.get();
      if (page.empty) break;
      for (const d of page.docs) rows.push(d.data() as HistoryRow);
      q = this.history(t).where(field, '>', after).orderBy(field).startAfter(page.docs[page.docs.length - 1]).limit(500);
    }
    return rows;
  }

  /** The newest key of a history table in Firestore, 0 when empty; what is at or under it is not written again. */
  async historyLastKey(t: HistoryTable): Promise<number> {
    const page = await this.history(t).orderBy(t.key, 'desc').limit(1).get();
    const k = page.empty ? 0 : Number(page.docs[0].get(t.key));
    this.historyPushed.set(t.name, Math.max(this.historyPushed.get(t.name) ?? 0, k));
    return k;
  }

  /** Writes history rows not pushed yet (rows must come oldest first). Returns how many were written. */
  async pushHistory(t: HistoryTable, rows: HistoryRow[]): Promise<number> {
    const fresh = rows.filter((r) => Number(r[t.key]) > (this.historyPushed.get(t.name) ?? 0));
    for (let i = 0; i < fresh.length; i += 400) {
      const batch = this.db.batch();
      const part = fresh.slice(i, i + 400);
      for (const r of part) batch.set(this.history(t).doc(pad(Number(r[t.key]))), r);
      await batch.commit();
      this.historyPushed.set(t.name, Number(part[part.length - 1][t.key]));
    }
    return fresh.length;
  }

  historyPushedUpTo(t: HistoryTable): number {
    return this.historyPushed.get(t.name) ?? 0;
  }

  lastPushed(): number {
    return this.pushedUpTo;
  }

  /** Marks events up to `id` as already in Firestore (from the saved state), so they are not written again. */
  assumePushed(id: number): void {
    this.pushedUpTo = Math.max(this.pushedUpTo, id);
  }

  /**
   * Takes or renews the single-engine lease and saves the state in the same
   * write. False if another holder's lease has not expired.
   */
  async lease(state: BackupState, leaseMs: number, now: number): Promise<boolean> {
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(this.stateDoc);
      const cur = snap.data() as { holder?: string; leaseUntil?: number } | undefined;
      if (cur?.holder && cur.holder !== this.holder && (cur.leaseUntil ?? 0) > now) return false;
      // Never older than what is saved: an engine that has not restored yet must not blank the clock, coins or watchlist.
      tx.set(this.stateDoc, { ...mergeState(snap.data() as Partial<BackupState> | undefined, state), holder: this.holder, leaseUntil: now + leaseMs, updatedAt: now });
      return true;
    });
  }

  /** Lets another engine take over at once (on a clean shutdown). */
  async release(state: BackupState, now: number): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(this.stateDoc);
      if ((snap.data() as { holder?: string } | undefined)?.holder === this.holder) {
        tx.set(this.stateDoc, { ...mergeState(snap.data() as Partial<BackupState>, state), holder: null, leaseUntil: 0, updatedAt: now });
      }
    });
  }
}
