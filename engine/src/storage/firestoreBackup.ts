// Firestore as a backup of the trade log (ENGINE_PLAN.md Section 4A.4), for
// hosts whose disk does not survive a restart (AI Studio / Cloud Run).
//
// Written: every trade event (batched), and one state document holding the
// engine clock, the universe and the single-engine lease. Read: only on a
// start with an empty database. Browsers never touch it.
//
//   {prefix}_events/{zero-padded event id}
//   {prefix}_state/engine   { clock, lastEventId, universe, holder, leaseUntil, updatedAt }
import { initializeApp, getApps, applicationDefault, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { TradeEvent } from '../../../shared/types';

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
    const credential = applicationDefault();
    await credential.getAccessToken();
    const app: App = getApps().find((a) => a.name === 'engine-backup')
      ?? initializeApp({ credential, projectId: target.projectId }, 'engine-backup');
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
      tx.set(this.stateDoc, { ...state, holder: this.holder, leaseUntil: now + leaseMs, updatedAt: now });
      return true;
    });
  }

  /** Lets another engine take over at once (on a clean shutdown). */
  async release(state: BackupState, now: number): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(this.stateDoc);
      if ((snap.data() as { holder?: string } | undefined)?.holder === this.holder) {
        tx.set(this.stateDoc, { ...state, holder: null, leaseUntil: 0, updatedAt: now });
      }
    });
  }
}
