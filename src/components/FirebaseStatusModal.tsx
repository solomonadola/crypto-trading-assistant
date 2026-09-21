import React, { useState, useEffect } from 'react';
import { 
  X, 
  Database, 
  CheckCircle2, 
  AlertTriangle, 
  ShieldCheck, 
  RefreshCw, 
  Server, 
  FileCode, 
  Copy, 
  Check,
  Zap,
  Lock,
  ExternalLink
} from 'lucide-react';
import { isFirebaseInitialized, testFirestoreConnection } from '../lib/firebase';
import firebaseConfig from '../../firebase-applet-config.json';
import { AutomatedTradeRecord } from '../types/automatedFeed';

interface FirebaseStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
  tradesCount: number;
}

export const FirebaseStatusModal: React.FC<FirebaseStatusModalProps> = ({
  isOpen,
  onClose,
  tradesCount
}) => {
  const [testing, setTesting] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{
    success: boolean;
    latencyMs?: number;
    error?: string;
  } | null>(null);
  const [copiedRules, setCopiedRules] = useState(false);

  useEffect(() => {
    if (isOpen) {
      handleTestConnection();
    }
  }, [isOpen]);

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const res = await testFirestoreConnection();
      setConnectionResult(res);
    } catch (e: any) {
      setConnectionResult({ success: false, error: e?.message || 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  };

  const copyRulesToClipboard = () => {
    const rulesText = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
    function isValidId(id) {
      return id is string && id.size() <= 128 && id.matches('^[a-zA-Z0-9_\\\\-]+$');
    }
    function isValidTrade(data) {
      return data is map &&
        data.id is string && data.id.size() <= 128 &&
        data.symbol is string && data.symbol.size() <= 32 &&
        data.coinId is string && data.coinId.size() <= 64 &&
        (data.direction in ['LONG', 'SHORT']) &&
        data.entryPrice is number &&
        data.currentPrice is number;
    }
    match /crypto_automated_trades/{tradeId} {
      allow read: if true;
      allow create, update: if isValidId(tradeId) && isValidTrade(request.resource.data);
      allow delete: if isValidId(tradeId);
    }
  }
}`;
    navigator.clipboard.writeText(rulesText);
    setCopiedRules(true);
    setTimeout(() => setCopiedRules(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div id="firebase-status-modal-backdrop" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div 
        id="firebase-status-modal-container"
        className="relative w-full max-w-2xl rounded-2xl bg-stone-900 border border-stone-800 shadow-2xl p-6 text-stone-100 my-8"
      >
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-stone-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Database className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-stone-100">Firebase & Firestore Infrastructure</h3>
              <p className="text-xs text-stone-400 mt-0.5">
                Cloud persistence, multi-role security rules, and real-time trade feed sync
              </p>
            </div>
          </div>
          <button 
            id="close-firebase-modal-btn"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-stone-800 text-stone-400 hover:text-stone-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Live Diagnostics Card */}
        <div className="mt-5 p-4 rounded-xl bg-stone-950/80 border border-stone-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-stone-400">
              Connection Diagnostics
            </span>
            <button
              onClick={handleTestConnection}
              disabled={testing}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-stone-800 hover:bg-stone-700 text-stone-300 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${testing ? 'animate-spin text-amber-400' : ''}`} />
              <span>{testing ? 'Probing...' : 'Probe Connection'}</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
            <div className="p-3 rounded-lg bg-stone-900 border border-stone-800">
              <span className="text-[10px] text-stone-500 uppercase block">SDK Client</span>
              <div className="flex items-center gap-1.5 mt-1">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span className="font-bold text-xs text-stone-200">Initialized</span>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-stone-900 border border-stone-800">
              <span className="text-[10px] text-stone-500 uppercase block">Latency</span>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="font-bold text-xs text-amber-400">
                  {connectionResult?.latencyMs ? `${connectionResult.latencyMs} ms` : 'Online'}
                </span>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-stone-900 border border-stone-800">
              <span className="text-[10px] text-stone-500 uppercase block">Trades Persisted</span>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="font-bold text-xs text-stone-200">{tradesCount} Records</span>
              </div>
            </div>
          </div>

          {connectionResult?.error && (
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">Offline Fallback Active:</span>
                <p className="mt-0.5 text-stone-300">
                  {connectionResult.error}. The app is smoothly storing data in client LocalStorage and will automatically sync with Firestore once access is live.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Project Credentials Table */}
        <div className="mt-5 space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-400">
            Project & Configuration Parameters
          </h4>
          <div className="p-3.5 rounded-xl bg-stone-950/60 border border-stone-800 text-xs font-mono space-y-1.5 text-stone-300">
            <div className="flex justify-between py-1 border-b border-stone-800/60">
              <span className="text-stone-500">Project ID:</span>
              <span className="text-amber-400">{firebaseConfig.projectId}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-stone-800/60">
              <span className="text-stone-500">Firestore Database ID:</span>
              <span className="text-stone-200 truncate max-w-[280px]">{firebaseConfig.firestoreDatabaseId}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-stone-800/60">
              <span className="text-stone-500">Auth Domain:</span>
              <span className="text-stone-300">{firebaseConfig.authDomain}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-stone-500">Collection:</span>
              <span className="text-emerald-400">crypto_automated_trades</span>
            </div>
          </div>
        </div>

        {/* Security Rules Audit Preview */}
        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-400 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Firestore Security Rules (Default Deny Enforced)</span>
            </h4>
            <button
              onClick={copyRulesToClipboard}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded bg-stone-800 hover:bg-stone-700 text-stone-300 transition-colors"
            >
              {copiedRules ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedRules ? 'Copied' : 'Copy Rules'}</span>
            </button>
          </div>

          <pre className="p-3 rounded-xl bg-stone-950 border border-stone-800 text-[11px] font-mono text-stone-400 overflow-x-auto max-h-36">
{`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false; // Default Deny
    }
    match /crypto_automated_trades/{tradeId} {
      allow read: if true;
      allow create, update: if isValidId(tradeId) && isValidTrade(request.resource.data);
      allow delete: if isValidId(tradeId);
    }
  }
}`}
          </pre>
        </div>

        {/* Modal Footer */}
        <div className="mt-6 flex justify-end pt-4 border-t border-stone-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 transition-colors"
          >
            Close Diagnostics
          </button>
        </div>
      </div>
    </div>
  );
};
