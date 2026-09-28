// Firebase Auth sign-in for the dashboard. Only used when the server asks for
// it (ALLOWED_EMAILS set); the server checks every request's ID token.
import { initializeApp } from 'firebase/app';
import { GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export function watchUser(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, cb);
}

export async function signIn(): Promise<void> {
  await signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

/** The current ID token (refreshed by Firebase when near expiry), or null when signed out. */
export async function idToken(): Promise<string | null> {
  return auth.currentUser ? auth.currentUser.getIdToken() : null;
}
