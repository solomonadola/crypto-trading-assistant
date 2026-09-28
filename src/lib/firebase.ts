import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];

export const db = firebaseConfig.firestoreDatabaseId
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

/**
 * Set VITE_FIRESTORE_WRITES=off (e.g. in .env.local) to make this copy of the
 * app read-only against Firestore: it still loads the shared trade history,
 * but everything it does - including auto-pilot deploys - stays in this
 * browser's local storage.
 *
 * Every copy of the app (hosted, local dev, test runs) points at the same
 * production database. On 2026-09-21 test runs of a local dev server opened
 * paper trades in the shared history and the old slot clean-up closed two
 * real positions as a result. Use this for any testing or experimentation.
 */
let envWrites: string | undefined;
try {
  envWrites = import.meta.env.VITE_FIRESTORE_WRITES;
} catch {
  envWrites = typeof process !== 'undefined' ? process.env?.VITE_FIRESTORE_WRITES : undefined;
}

export const FIRESTORE_WRITES_ENABLED = envWrites !== 'off';

if (!FIRESTORE_WRITES_ENABLED) {
  console.info('[Firestore] Read-only mode (VITE_FIRESTORE_WRITES=off): changes stay in this browser.');
}

/**
 * Real health of the Firestore connection.
 *
 * isFirebaseInitialized() only confirmed the SDK objects existed, so the UI
 * reported Firebase as live even when every read and write was being rejected.
 * Writes fail into a catch that warns and falls back to localStorage, so the
 * failure is invisible unless the console is open - and the data then lives on
 * one browser only, with no cross-device consistency.
 */
export type FirestoreHealth = 'unknown' | 'ok' | 'denied' | 'quota' | 'offline';
let firestoreHealth: FirestoreHealth = 'unknown';

export function getFirestoreHealth(): FirestoreHealth {
  return isQuotaBlocked() ? 'quota' : firestoreHealth;
}

/** Called by the data layer after each Firestore operation. */
export function reportFirestoreResult(err?: unknown): void {
  if (!err) { firestoreHealth = 'ok'; return; }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('permission') || msg.includes('insufficient') || msg.includes('unauthenticated')) {
    if (firestoreHealth !== 'denied') {
      console.warn(
        '[Firestore] Permission denied - trades are being kept in this browser only and ' +
        'will not sync to other browsers or devices until Firestore accepts requests again.'
      );
    }
    firestoreHealth = 'denied';
  } else if (msg.includes('resource-exhausted') || msg.includes('quota')) {
    firestoreHealth = 'quota';
  } else {
    firestoreHealth = 'offline';
  }
}

// Operation types for Firestore logging & diagnostic error handling
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  };
}

const QUOTA_STORAGE_KEY = 'firebase_quota_blocked_until';
const QUOTA_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours cooldown when quota is exceeded

export function markQuotaExceeded(): void {
  try {
    const unblockAt = Date.now() + QUOTA_COOLDOWN_MS;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(QUOTA_STORAGE_KEY, String(unblockAt));
    }
  } catch {}
  console.warn('⚠️ [Firebase Quota Guard] Daily quota limit reached. Gracefully operating in offline-resilient local storage mode.');
}

export function resetQuotaState(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(QUOTA_STORAGE_KEY);
    }
  } catch {}
}

export function isQuotaBlocked(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(QUOTA_STORAGE_KEY);
    if (!raw) return false;
    const unblockAt = parseInt(raw, 10);
    if (isNaN(unblockAt)) return false;
    if (Date.now() < unblockAt) {
      return true;
    }
    // Expired, clear
    localStorage.removeItem(QUOTA_STORAGE_KEY);
    return false;
  } catch {
    return false;
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): FirestoreErrorInfo {
  const errMsg = error instanceof Error ? error.message : String(error);
  if (errMsg.toLowerCase().includes('resource-exhausted') || errMsg.toLowerCase().includes('quota')) {
    markQuotaExceeded();
  }
  const errInfo: FirestoreErrorInfo = {
    error: errMsg,
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: true,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

export function isFirebaseInitialized(): boolean {
  // Configured AND actually usable. 'unknown' is treated as configured so the
  // badge is not pessimistic before the first operation completes.
  if (!app || !db || !firebaseConfig.projectId || isQuotaBlocked()) return false;
  const health = getFirestoreHealth();
  return health === 'ok' || health === 'unknown';
}

// Connection test per Firebase integration skill
export async function testFirestoreConnection(): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  // 1. If server /api/status is reachable, use its authoritative Firestore health check (zero direct reads)
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const fsStatus = data?.worker?.sync?.firestore;
      if (fsStatus === 'ok') {
        reportFirestoreResult();
        return { success: true, latencyMs: Math.max(1, Date.now() - start) };
      }
    }
  } catch {}

  // 2. Direct probe fallback only if server status endpoint is unreachable
  try {
    await getDocFromServer(doc(db, 'crypto_automated_trades', '_connection_probe'));
    return { success: true, latencyMs: Date.now() - start };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes('resource-exhausted') || msg.toLowerCase().includes('quota')) {
      markQuotaExceeded();
      return { success: false, latencyMs: Date.now() - start, error: 'Firebase daily quota reached. Local resilience mode active.' };
    }
    if (msg.includes('not-found') || !msg.includes('offline')) {
      return { success: true, latencyMs: Date.now() - start };
    }
    return { success: false, latencyMs: Date.now() - start, error: msg };
  }
}

export default app;
