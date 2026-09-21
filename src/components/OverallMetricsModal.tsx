import React from 'react';
import { X, BarChart3 } from 'lucide-react';
import { AutomatedTradeRecord, BankrollState } from '../types/automatedFeed';
import { OverallMetricsView } from './OverallMetricsView';

interface OverallMetricsModalProps {
  isOpen: boolean;
  onClose: () => void;
  trades: AutomatedTradeRecord[];
  bankroll: BankrollState;
}

export const OverallMetricsModal: React.FC<OverallMetricsModalProps> = ({
  isOpen,
  onClose,
  trades,
  bankroll,
}) => {
  if (!isOpen) return null;

  return (
    <div 
      id="overall-metrics-modal-overlay" 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm overflow-y-auto"
      onClick={onClose}
    >
      <div 
        id="overall-metrics-modal-container"
        className="relative w-full max-w-5xl my-8 bg-stone-950 border border-amber-500/30 rounded-2xl shadow-2xl p-6 space-y-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with Close button */}
        <div className="flex items-center justify-between pb-4 border-b border-stone-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <BarChart3 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-stone-100">
                Strategy & Profitability Metrics Center
              </h2>
              <p className="text-xs text-stone-400">
                Risk-to-Reward (R:R), Win Rate, Expectancy, and Statistical Confluence Audit
              </p>
            </div>
          </div>

          <button
            id="close-overall-metrics-modal-btn"
            onClick={onClose}
            className="p-2 text-stone-400 hover:text-stone-100 rounded-lg hover:bg-stone-900 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Core Content */}
        <OverallMetricsView trades={trades} bankroll={bankroll} />
      </div>
    </div>
  );
};
