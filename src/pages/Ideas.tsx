import { useState } from 'react';
import { Compass } from 'lucide-react';
import { usePoll } from '../lib/api';
import type { TradeIdea } from '../../shared/types';
import { coin } from '../lib/format';
import { Card, Empty } from '../components/ui';
import { TradePlanCard } from '../components/TradePlan';

const SHOW = [['signals', 'signals'], ['active', 'with a plan'], ['all', 'all coins']] as const;

export function Ideas({ go }: { go: (page: string, symbol?: string) => void }) {
  const { data } = usePoll<TradeIdea[]>('/api/ideas', 30_000);
  const [show, setShow] = useState<(typeof SHOW)[number][0]>('signals');
  const ideas = (data ?? []).filter((i) => show === 'all' || (show === 'signals' ? !!i.plan?.meetsRules : !!i.plan && i.plan.status !== 'no_level'));

  return (
    <div className="space-y-5">
      <Card
        title="Trade ideas"
        icon={<Compass size={16} />}
        right={
          <div className="flex overflow-hidden rounded-lg border border-line">
            {SHOW.map(([id, label]) => (
              <button key={id} onClick={() => setShow(id)} className={`px-2.5 py-1 text-xs ${show === id ? 'bg-accent text-white' : 'bg-card-2 text-ink-2 hover:text-ink'}`}>{label}</button>
            ))}
          </div>
        }
      >
        <p className="max-w-3xl text-sm text-ink-2">
          For every scanned coin: the trend, the key levels, and a plan in the trend's direction with one take-profit. A signal needs the
          take-profit at least 3% away and at least 2R. Signals come first, from the largest profit down. Click a card to see it on the chart.
        </p>
      </Card>
      {!data ? <Empty>Loading…</Empty> : !ideas.length ? <Empty>{show === 'signals' ? 'No coin has a signal right now (3% and 2R minimum). Switch to “with a plan” to see the rest.' : 'No coin has a plan right now. Switch to “all coins” to see their levels.'}</Empty> : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {ideas.map((i) => (
            <button key={i.symbol} onClick={() => go('chart', i.symbol)} className="text-left transition hover:-translate-y-0.5">
              <div className="mb-1 flex items-baseline justify-between px-1">
                <span className="text-lg font-semibold">{coin(i.symbol)}</span>
              </div>
              <TradePlanCard idea={i} compact />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
