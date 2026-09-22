import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Open the app with ?resync=firebase to throw away this browser's saved copy
// of the trades (including changes still waiting to be saved) and load them
// fresh from Firebase. For when this copy has drifted from Firebase; no
// Console needed. The address is cleaned so a later reload does not repeat it.
if (new URLSearchParams(window.location.search).get('resync') === 'firebase') {
  for (const key of [
    'crypto_automated_trades_local_fallback',
    'crypto_automated_trades_pending_writes',
    'crypto_automated_trades_sync_cursor',
    'crypto_automated_trades_full_sync_at',
    'crypto_automated_trades_sync_version',
    'firebase_quota_blocked_until',
  ]) {
    try { localStorage.removeItem(key); } catch {}
  }
  window.history.replaceState(null, '', window.location.pathname);
  console.info('[Sync] Saved trades discarded; loading them from Firebase.');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
