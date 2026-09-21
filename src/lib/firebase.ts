import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];

export const db = firebaseConfig.firestoreDatabaseId
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

// Anonymous auth.
//
// The firestore.rules FILE in this repo allowed unauthenticated read/write/
// delete, with `allow delete: if isValidId(tradeId)` amounting to
// `allow delete: if true`. The DEPLOYED rules are stricter - a REST read with
// only the projectId and public apiKey returns PERMISSION_DENIED - so the repo
// file was out of sync with what is actually running rather than describing a
// live hole. The file has been corrected to match intent either way.
//
// Signing in anonymously gives those rules a request.auth to check against.
// NOTE: this currently fails with ADMIN_ONLY_OPERATION because Anonymous
// sign-in is disabled for this project. Until it is enabled in
// Firebase console > Authentication > Sign-in method, every Firestore
// operation is rejected and the app runs on localStorage alone - which means
// no cross-device sync. getFirestoreHealth() reports this honestly.
const auth = getAuth(app);

export const authReady: Promise<string | null> = new Promise((resolve) => {
  let settled = false;
  const finish = (uid: string | null) => { if (!settled) { settled = true; resolve(uid); } };

  onAuthStateChanged(auth, (user) => { if (user) finish(user.uid); });

  signInAnonymously(auth).catch((err) => {
    console.warn(
      '[Auth] Anonymous sign-in failed - Firestore writes will be rejected by security rules. ' +
      'Enable Anonymous sign-in in Firebase console > Authentication > Sign-in method.',
      err
    );
    finish(null);
  });

  // Never block the UI indefinitely on auth; localStorage remains the fallback.
  setTimeout(() => finish(null), 8000);
});

export function getCurrentUid(): string | null {
  return auth.currentUser?.uid ?? null;
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
        '[Firestore] Permission denied - trades are being kept in localStorage only. ' +
        'They will NOT sync across browsers or devices. Enable Anonymous sign-in ' +
        '(Firebase console > Authentication > Sign-in method) and deploy firestore.rules.'
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
    localStorage.setItem(QUOTA_STORAGE_KEY, String(unblockAt));
  } catch {}
  console.warn('⚠️ [Firebase Quota Guard] Daily quota limit reached. Gracefully operating in offline-resilient local storage mode.');
}

export function resetQuotaState(): void {
  try {
    localStorage.removeItem(QUOTA_STORAGE_KEY);
  } catch {}
}

export function isQuotaBlocked(): boolean {
  try {
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
