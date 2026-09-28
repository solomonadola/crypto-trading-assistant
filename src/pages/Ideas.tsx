import { useState } from 'react';
import { Compass } from 'lucide-react';
import { usePoll } from '../lib/api';
import type { TradeIdea } from '../../shared/types';
import { coin } from '../lib/format';
import { Card, Empty } from '../components/ui';
import { TradePlanCard } from '../components/TradePlan';

const SHOW = [['active', 'with a plan'], ['all', 'all coins']] as const;

export function Ideas({ go }: { go: (page: string, symbol?: string) => void }) {
  const { data } = usePoll<TradeIdea[]>('/api/ideas', 30_000);
  const [show, setShow] = useState<(typeof SHOW)[number][0]>('active');
  const ideas = (data ?? []).filter((i) => show === 'all' || (i.plan && i.plan.status !== 'no_level'));

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
          For every scanned coin: the trend, the key support and resistance levels, and a suggested entry area, stop and targets in the trend's
          direction. Coins the engine has armed and coins whose price is in the entry area come first. Click a card to see it on the chart.
        </p>
      </Card>
      {!data ? <Empty>Loading…</Empty> : !ideas.length ? <Empty>No coin has a plan right now. Switch to “all coins” to see their levels.</Empty> : (
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
