// Sign-in for the dashboard (ENGINE_PLAN.md Section 12.4). The page signs in
// with Firebase Auth (Google); every API request carries the ID token; the
// server checks it and the email against ALLOWED_EMAILS. Checking a token
// needs only the project id, no secret key.
//
// With ALLOWED_EMAILS unset (local development), sign-in is off.
import type { NextFunction, Request, Response } from 'express';
import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface AuthSettings {
  projectId: string;
  allowed: string[];
}

export function authSettings(projectId: string): AuthSettings {
  const allowed = (process.env.ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return { projectId, allowed };
}

/** Paths that answer without sign-in: the uptime check and what the page needs to know how to sign in. */
const OPEN = new Set(['/health', '/auth/config']);

export function requireSignIn(settings: AuthSettings) {
  if (!settings.allowed.length) return (_req: Request, _res: Response, next: NextFunction) => next();
  const app: App = getApps().find((a) => a.name === 'engine-auth') ?? initializeApp({ projectId: settings.projectId }, 'engine-auth');
  const auth = getAuth(app);
  return async (req: Request, res: Response, next: NextFunction) => {
    if (OPEN.has(req.path)) return next();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sign in required' });
    try {
      const user = await auth.verifyIdToken(token);
      const email = (user.email ?? '').toLowerCase();
      if (!user.email_verified || !settings.allowed.includes(email)) return res.status(403).json({ error: `${email || 'This account'} is not allowed` });
      next();
    } catch {
      res.status(401).json({ error: 'Sign-in expired; sign in again' });
    }
  };
}
