// Adds a coin to the watchlist: the engine fetches its candles and analyses it
// like the scanner's coins, without trading it.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { post } from '../lib/api';

export function AddCoin({ onAdded }: { onAdded?: (symbol: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ symbol: string }>('/api/watchlist', { symbol: text });
      setText('');
      onAdded?.(r.symbol);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-1" title={error ?? 'Add any Binance USDT perpetual, e.g. PEPE or AVAX'}>
      <input value={text} onChange={(e) => { setText(e.target.value); setError(null); }} placeholder="add coin, e.g. AVAX"
        aria-invalid={!!error}
        className={`w-32 rounded-lg border bg-card-2 px-2 py-1 text-xs outline-none placeholder:text-ink-3 ${error ? 'border-critical' : 'border-line focus:border-accent'}`} />
      <button type="submit" disabled={busy || !text.trim()}
        className="inline-flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50">
        <Plus size={12} />{busy ? 'Adding…' : 'Add'}
      </button>
      {error && <span className="max-w-56 truncate text-xs text-critical">{error}</span>}
    </form>
  );
}
