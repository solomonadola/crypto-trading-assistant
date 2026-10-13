import { useState, useEffect } from 'react';
import { BookOpen, Check, Star, Tag, X, AlertCircle } from 'lucide-react';
import { post, type ClosedTradeView, type JournalEntry, type AtaReflection } from '../lib/api';
import { coin, dateTime, pct, price, signedUsd } from '../lib/format';
import { Badge, ModelBadge, Pnl, SessionBadge, SideBadge } from './ui';

const PRESET_TAGS = [
  'Followed Rules',
  'Patient Entry',
  'Wait for Confirmation',
  'Clean Execution',
  'Chased / FOMO',
  'Early Exit',
  'Moved Stop Loss',
  'Revenge Trade',
  'Overleveraged',
  'No Clear POI',
];

interface TradeJournalModalProps {
  trade: ClosedTradeView | null;
  initialEntry?: JournalEntry | null;
  onClose: () => void;
  onSaved: (entry: JournalEntry) => void;
}

export function TradeJournalModal({ trade, initialEntry, onClose, onSaved }: TradeJournalModalProps) {
  if (!trade) return null;

  const [rating, setRating] = useState<number>(initialEntry?.rating ?? 0);
  const [notes, setNotes] = useState<string>(initialEntry?.notes ?? '');
  const [tags, setTags] = useState<string[]>(initialEntry?.tags ?? []);
  const [ata, setAta] = useState<AtaReflection>(initialEntry?.ata ?? {
    pdAlignment: 'na',
    majorLiquidityTaken: false,
    hrlrOrLrlr: 'unknown',
    htfTrendAligned: false,
    keyPoi: 'none',
    shiftReason: '',
    invalidation: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialEntry) {
      setRating(initialEntry.rating);
      setNotes(initialEntry.notes);
      setTags(initialEntry.tags);
      if (initialEntry.ata) setAta(initialEntry.ata);
    }
  }, [initialEntry]);

  const toggleTag = (tag: string) => {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        rating,
        tags,
        notes,
        ata,
      };
      const res = await post<{ ok: boolean; entry: JournalEntry }>(`/api/journal/${encodeURIComponent(trade.id)}`, payload);
      if (res.entry) {
        onSaved(res.entry);
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const pnlPct = trade.entryPrice ? ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100 * (trade.side === 'long' ? 1 : -1) : 0;
  const rMultiple = trade.riskUsd && trade.riskUsd > 0 ? (trade.pnl / trade.riskUsd).toFixed(2) + 'R' : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-line p-5">
          <div>
            <div className="flex items-center gap-2">
              <BookOpen size={18} className="text-accent" />
              <h2 className="text-lg font-bold text-ink">Trade Post-Mortem & Journal</h2>
              <span className="font-semibold text-accent">{coin(trade.symbol)}</span>
              <SideBadge side={trade.side} />
              {trade.setup && <ModelBadge setup={trade.setup} />}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-3">
              <span>{dateTime(trade.closedAt)}</span>
              {trade.session && <SessionBadge name={trade.session} />}
              <span className="tabular">Entry: {price(trade.entryPrice)}</span>
              <span className="tabular">Exit: {price(trade.exitPrice)}</span>
              <Pnl value={trade.pnl} percent={pnlPct} />
              {rMultiple && <span className="font-bold tabular text-ink">{rMultiple}</span>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-ink-3 hover:bg-card-2 hover:text-ink transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-critical/40 bg-critical/10 p-3 text-xs text-critical">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}

          {/* Execution Rating */}
          <div className="flex items-center justify-between rounded-xl border border-line bg-card-2/50 p-3.5">
            <div>
              <div className="text-sm font-semibold text-ink">Execution Quality</div>
              <div className="text-xs text-ink-3">Rate your rule discipline, not just the financial outcome</div>
            </div>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRating(star)}
                  className="p-1 transition hover:scale-110"
                >
                  <Star
                    size={20}
                    className={star <= rating ? 'fill-warning text-warning' : 'text-ink-3/40 hover:text-warning'}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* ATA Level 5 Checklist */}
          <div className="rounded-xl border border-line bg-card-2/30 p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-accent">
                Ace Trades Academy (ATA) Level 5 Reflection
              </span>
              <span className="text-[11px] text-ink-3">Price Understanding Over Prediction</span>
            </div>

            {/* Dealing Range */}
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1.5">1. Dealing Range Position</label>
              <div className="grid grid-cols-4 gap-2 text-xs">
                {(['discount', 'premium', 'equilibrium', 'na'] as const).map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => setAta({ ...ata, pdAlignment: pos })}
                    className={`rounded-lg border px-2.5 py-1.5 text-center capitalize transition ${
                      ata.pdAlignment === pos
                        ? pos === 'discount'
                          ? 'border-london bg-london/20 text-london font-semibold'
                          : pos === 'premium'
                          ? 'border-asian bg-asian/20 text-asian font-semibold'
                          : 'border-accent bg-accent/20 text-accent font-semibold'
                        : 'border-line bg-card text-ink-3 hover:text-ink'
                    }`}
                  >
                    {pos === 'na' ? 'N/A' : pos}
                  </button>
                ))}
              </div>
            </div>

            {/* Structure Type & Major Liquidity */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1.5">2. Liquidity Profile</label>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {(['lrlr', 'hrlr'] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setAta({ ...ata, hrlrOrLrlr: kind })}
                      className={`rounded-lg border px-2 py-1.5 text-center uppercase transition ${
                        ata.hrlrOrLrlr === kind
                          ? 'border-accent bg-accent/20 text-accent font-semibold'
                          : 'border-line bg-card text-ink-3 hover:text-ink'
                      }`}
                    >
                      {kind}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1.5">3. Key POI Tapped</label>
                <select
                  value={ata.keyPoi ?? 'none'}
                  onChange={(e) => setAta({ ...ata, keyPoi: e.target.value as any })}
                  className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-ink"
                >
                  <option value="none">None / Market Churn</option>
                  <option value="ob">Order Block (OB)</option>
                  <option value="fvg">Fair Value Gap (FVG)</option>
                  <option value="breaker">Breaker Block</option>
                </select>
              </div>
            </div>

            {/* Toggles */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={!!ata.majorLiquidityTaken}
                  onChange={(e) => setAta({ ...ata, majorLiquidityTaken: e.target.checked })}
                  className="rounded border-line bg-card text-accent focus:ring-accent"
                />
                <span>Major Liquidity Taken Before Entry</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={!!ata.htfTrendAligned}
                  onChange={(e) => setAta({ ...ata, htfTrendAligned: e.target.checked })}
                  className="rounded border-line bg-card text-accent focus:ring-accent"
                />
                <span>LTF Idea Aligned with HTF Trend</span>
              </label>
            </div>

            {/* Why price shifted / continued */}
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">
                4. Why did price shift or continue?
              </label>
              <input
                type="text"
                placeholder="e.g., Asian low swept + liquidity taken into 4H demand zone"
                value={ata.shiftReason ?? ''}
                onChange={(e) => setAta({ ...ata, shiftReason: e.target.value })}
                className="w-full rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-ink placeholder:text-ink-3/50"
              />
            </div>

            {/* Invalidation */}
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">
                5. What was the invalidation level / logic?
              </label>
              <input
                type="text"
                placeholder="e.g., Close below recent 15m swing low at 64,800"
                value={ata.invalidation ?? ''}
                onChange={(e) => setAta({ ...ata, invalidation: e.target.value })}
                className="w-full rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-ink placeholder:text-ink-3/50"
              />
            </div>
          </div>

          {/* Discipline / Emotion Tags */}
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1.5">
              Emotional & Discipline Tags
            </label>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_TAGS.map((tag) => {
                const active = tags.includes(tag);
                const isBad = tag.includes('FOMO') || tag.includes('Early') || tag.includes('Revenge') || tag.includes('Moved') || tag.includes('Overleveraged') || tag.includes('No Clear');
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={`rounded-lg border px-2.5 py-1 text-xs transition flex items-center gap-1 ${
                      active
                        ? isBad
                          ? 'border-critical bg-critical/20 text-critical font-medium'
                          : 'border-good bg-good/20 text-good font-medium'
                        : 'border-line bg-card-2 text-ink-3 hover:text-ink'
                    }`}
                  >
                    {active && <Check size={11} />}
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Free-form Notes */}
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">
              Journal Notes & Lessons Learned
            </label>
            <textarea
              rows={3}
              placeholder="What did you learn? Did you stick to the plan? What will you do better next time?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-xl border border-line bg-card p-3 text-xs text-ink placeholder:text-ink-3/50 focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line p-4">
          <div className="text-[11px] text-ink-3">
            “Breaking your own rules creates false confidence.”
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-line px-4 py-2 text-xs font-semibold text-ink-2 hover:bg-card-2 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-bold text-accent-ink hover:opacity-90 transition disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Journal Entry'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
