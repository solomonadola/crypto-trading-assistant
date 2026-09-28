import { doc, setDoc } from 'firebase/firestore';
import { db, FIRESTORE_WRITES_ENABLED } from '../lib/firebase';
import { serverApiUrl } from './serverFeed';

const CONFIG_COLLECTION = 'crypto_automated_config';
const AUTOPILOT_DOC_ID = 'autopilot';
const LOCAL_STORAGE_KEY = 'cryptostudy_autopilot';
const BROADCAST_CHANNEL = 'cryptostudy_autopilot_sync';

export interface AutoPilotConfigDoc {
  enabled: boolean;
  updatedAt: number;
  updatedBy?: string;
}

type AutoPilotSubscriber = (enabled: boolean) => void;
const subscribers = new Set<AutoPilotSubscriber>();

let currentAutoPilotState: boolean = (() => {
  try {
    return localStorage.getItem(LOCAL_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
})();

let isInitialized = false;
let broadcastChannel: BroadcastChannel | null = null;

if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  try {
    broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL);
    broadcastChannel.onmessage = (event) => {
      if (typeof event.data?.enabled === 'boolean') {
        applyAutoPilotState(event.data.enabled, false);
      }
    };
  } catch {}
}

function notifySubscribers(enabled: boolean): void {
  subscribers.forEach((cb) => {
    try {
      cb(enabled);
    } catch (err) {
      console.error('[AutoPilotSync] Subscriber error:', err);
    }
  });
}

function applyAutoPilotState(enabled: boolean, broadcast = true): void {
  currentAutoPilotState = enabled;
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, String(enabled));
  } catch {}
  notifySubscribers(enabled);
  if (broadcast && broadcastChannel) {
    try {
      broadcastChannel.postMessage({ enabled });
    } catch {}
  }
}

/**
 * Subscribes to synchronized auto-pilot state changes across all browser tabs,
 * other browsers, and the backend server.
 * Uses BroadcastChannel, localStorage, and /api/status polling from the server
 * with ZERO Firestore reads on the client.
 */
export function subscribeToAutoPilot(callback: AutoPilotSubscriber): () => void {
  subscribers.add(callback);
  // Immediately call with current known state
  callback(currentAutoPilotState);

  return () => {
    subscribers.delete(callback);
  };
}

/**
 * Returns current local cached auto-pilot state.
 */
export function getAutoPilotState(): boolean {
  return currentAutoPilotState;
}

/**
 * Authoritatively toggles auto-pilot state across all connected browsers,
 * tabs, Firestore, and the backend server.
 */
export async function setGlobalAutoPilot(enabled: boolean): Promise<boolean> {
  // 1. Immediately apply locally and broadcast to local tabs
  applyAutoPilotState(enabled, true);

  // 2. Notify the 24/7 server process immediately (the server authoritatively updates memory & Firestore)
  try {
    await fetch(serverApiUrl('/api/autopilot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch((err) => {
      console.warn('[AutoPilotSync] /api/autopilot notification failed:', err);
    });
  } catch {}

  return enabled;
}

/**
 * Synchronizes auto-pilot state from the server status response.
 * Only updates if it differs from current state.
 */
export function syncAutoPilotFromServer(serverEnabled: boolean | undefined): void {
  if (typeof serverEnabled === 'boolean' && serverEnabled !== currentAutoPilotState) {
    applyAutoPilotState(serverEnabled, true);
  }
}
