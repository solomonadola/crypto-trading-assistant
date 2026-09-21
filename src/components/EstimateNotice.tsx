import React from 'react';
import { Info } from 'lucide-react';

/**
 * States plainly that order-flow figures are estimates.
 *
 * The app receives one 24-hour ticker per coin - no trades, no order book.
 * Every "buy pressure", "large-order" and "flow" figure is calculated from
 * that ticker's price change and range (see services/orderFlowService.ts),
 * with large orders assumed to be a fixed 68% of volume. Nothing here is a
 * measurement of what actual traders did.
 */
export const EstimateNotice: React.FC<{ className?: string }> = ({ className = '' }) => (
  <p
    role="note"
    className={`flex items-start gap-2 rounded-lg border border-stone-700 bg-stone-900/60 px-3 py-2 text-[11px] leading-relaxed text-stone-400 ${className}`}
  >
    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500" aria-hidden="true" />
    <span>
      <strong className="font-semibold text-stone-300">Estimates, not measurements.</strong>{' '}
      Buy/sell pressure and large-order figures are calculated from each coin's
      24-hour price change and range. No individual trades or order-book data
      are available to this app.
    </span>
  </p>
);
