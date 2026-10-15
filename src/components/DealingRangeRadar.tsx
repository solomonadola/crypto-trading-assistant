import { useState } from 'react';
import { Compass, ExternalLink, Filter, Layers, Target, Zap } from 'lucide-react';
import { usePoll, usePrices, type MarketRow, type SessionInfo, type SessionInstance } from '../lib/api';
import { SESSION_LABEL, coin, pct, price } from '../lib/format';
import { Badge, Card, Empty, SideBadge, TrendChip } from './ui';

interface DealingRangeRadarProps {
  go: (page: string, symbol?: string) => void;
  maxItems?: number;
}

export function DealingRangeRadar({ go, maxItems = 12 }: DealingRangeRadarProps) {
  const { data: rows } = usePoll<MarketRow[]>('/api/market', 15_000);
  const { data: sessionData } = usePoll<{ dayStart: number; sessions: SessionInstance[]; info: SessionInfo }>('/api/sessions/today', 60_000);
  const live = usePrices();
  const [filter, setFilter] = useState<'all' | 'discount' | 'premium' | 'poi'>('all');

  const currentSession = sessionData?.info.owner ?? null;
  const isOutsideKillzone = sessionData?.info.entryBlock === 'outside_killzone';

  // Filter to coins with scanned status or active setups
  const activeCoins = (rows ?? []).filter((r) => r.scanned || r.setup?.pdPosition != null);

  const discountCount = activeCoins.filter((r) => (r.setup?.pdPosition ?? 0.5) <= 0.48).length;
  const premiumCount = activeCoins.filter((r) => (r.setup?.pdPosition ?? 0.5) >= 0.52).length;
  const eqCount = activeCoins.length - discountCount - premiumCount;
  const inPoiCount = activeCoins.filter((r) => r.htfPoi?.inPoi).length;

  const filtered = activeCoins.filter((r) => {
    const pos = r.setup?.pdPosition ?? 0.5;
    if (filter === 'discount') return pos <= 0.48;
    if (filter === 'premium') return pos >= 0.52;
    if (filter === 'poi') return r.htfPoi?.inPoi;
    return true;
  });

  // Sort by extreme deviation: deepest discount first, then highest premium
  const sorted = [...filtered].sort((a, b) => {
    const posA = a.setup?.pdPosition ?? 0.5;
    const posB = b.setup?.pdPosition ?? 0.5;
    if (filter === 'premium') return posB - posA;
    if (filter === 'poi') return (a.htfPoi?.distPct ?? 99) - (b.htfPoi?.distPct ?? 99);
    return posA - posB;
  }).slice(0, maxItems);

  return (
    <Card
      title="4H Dealing Range & POI Radar"
      icon={<Compass size={16} className="text-accent" />}
      right={
        <div className="flex flex-wrap items-center gap-2">
          {currentSession && !isOutsideKillzone ? (
            <Badge tone="london"><Zap size={11} className="animate-pulse" /> {SESSION_LABEL[currentSession.name] ?? currentSession.name} Killzone Active</Badge>
          ) : (
            <Badge tone="muted">Outside Killzone</Badge>
          )}
          <div className="flex items-center rounded-lg border border-line bg-card-2 p-0.5 text-xs">
            <button
              onClick={() => setFilter('all')}
              className={`rounded px-2 py-0.5 transition ${filter === 'all' ? 'bg-card text-ink font-semibold shadow-sm' : 'text-ink-3 hover:text-ink'}`}
            >
              All ({activeCoins.length})
            </button>
            <button
              onClick={() => setFilter('discount')}
              className={`rounded px-2 py-0.5 transition ${filter === 'discount' ? 'bg-london/20 text-london font-semibold' : 'text-ink-3 hover:text-london'}`}
            >
              Discount ({discountCount})
            </button>
            <button
              onClick={() => setFilter('premium')}
              className={`rounded px-2 py-0.5 transition ${filter === 'premium' ? 'bg-asian/20 text-asian font-semibold' : 'text-ink-3 hover:text-asian'}`}
            >
              Premium ({premiumCount})
            </button>
            <button
              onClick={() => setFilter('poi')}
              className={`rounded px-2 py-0.5 transition ${filter === 'poi' ? 'bg-accent/20 text-accent font-semibold' : 'text-ink-3 hover:text-accent'}`}
            >
              In POI ({inPoiCount})
            </button>
          </div>
        </div>
      }
    >
      {/* Range Distribution Summary Bar */}
      <div className="mb-4 rounded-xl border border-line bg-card-2/50 p-3">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="font-semibold text-ink-2">Market Dealing Range Distribution</span>
          <span className="text-ink-3">
            <span className="text-london font-semibold">{discountCount}</span> Discount · <span className="text-ink-3 font-semibold">{eqCount}</span> Equilibrium · <span className="text-asian font-semibold">{premiumCount}</span> Premium
          </span>
        </div>
        <div className="relative flex h-2 w-full overflow-hidden rounded-full bg-line">
          <div style={{ width: `${(discountCount / Math.max(1, activeCoins.length)) * 100}%` }} className="bg-london/80" title="Discount zone" />
          <div style={{ width: `${(eqCount / Math.max(1, activeCoins.length)) * 100}%` }} className="bg-ink-3/40" title="Equilibrium zone" />
          <div style={{ width: `${(premiumCount / Math.max(1, activeCoins.length)) * 100}%` }} className="bg-asian/80" title="Premium zone" />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-ink-3">
          <span>0% Range Low (Demand Area)</span>
          <span>50% Equilibrium (No-Trade Chop)</span>
          <span>100% Range High (Supply Area)</span>
        </div>
      </div>

      {!sorted.length ? (
        <Empty>No coins matching current radar filter.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sorted.map((r) => {
            const pos = r.setup?.pdPosition ?? 0.5;
            const pctVal = Math.round(pos * 100);
            const isDiscount = pos <= 0.48;
            const isPremium = pos >= 0.52;
            const livePrice = live?.prices[r.symbol] ?? r.price;

            const poi = r.htfPoi;
            const poiLabel = poi
              ? poi.kind === 'zone'
                ? poi.dir === 'long' ? '4H Demand' : '4H Supply'
                : poi.kind === 'fvg'
                ? '4H FVG'
                : '4H Order Block'
              : null;

            return (
              <div
                key={r.symbol}
                onClick={() => go('chart', r.symbol)}
                className="group relative cursor-pointer rounded-xl border border-line bg-card p-3.5 transition hover:border-accent/50 hover:bg-card-2 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-ink group-hover:text-accent transition">{coin(r.symbol)}</span>
                      {r.trend?.['4h'] && <TrendChip tf="4h" trend={r.trend['4h']} />}
                      {r.armed.length > 0 && <Badge tone="good"><Zap size={10} /> armed</Badge>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs tabular text-ink-3">
                      <span>{price(livePrice)}</span>
                      {r.changePct != null && (
                        <span className={r.changePct >= 0 ? 'text-good' : 'text-critical'}>
                          {pct(r.changePct, 1, true)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    {isDiscount ? (
                      <Badge tone="london">Discount {pctVal}%</Badge>
                    ) : isPremium ? (
                      <Badge tone="asian">Premium {pctVal}%</Badge>
                    ) : (
                      <Badge tone="muted">Eq {pctVal}%</Badge>
                    )}
                  </div>
                </div>

                {/* Dealing Range Visual Gauge */}
                <div className="mt-3">
                  <div className="relative h-2 w-full rounded-full bg-card-2 border border-line/60">
                    {/* Equilibrium 50% marker line */}
                    <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-line z-0" />
                    {/* Position Dot */}
                    <div
                      className={`absolute top-1/2 -mt-1.5 h-3 w-3 -translate-x-1/2 rounded-full border border-card shadow-sm z-10 transition-all ${
                        isDiscount ? 'bg-london' : isPremium ? 'bg-asian' : 'bg-ink-3'
                      }`}
                      style={{ left: `${Math.max(4, Math.min(96, pos * 100))}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-ink-3">
                    <span className={isDiscount ? 'text-london font-medium' : ''}>Discount (Longs)</span>
                    <span className={isPremium ? 'text-asian font-medium' : ''}>Premium (Shorts)</span>
                  </div>
                </div>

                {/* HTF POI Proximity */}
                <div className="mt-2.5 flex items-center justify-between border-t border-line/50 pt-2 text-xs">
                  <span className="text-ink-3 flex items-center gap-1">
                    <Target size={12} />
                    <span>POI:</span>
                  </span>
                  {poi ? (
                    poi.inPoi ? (
                      <Badge tone="good">Inside {poiLabel}</Badge>
                    ) : (
                      <span className="tabular text-ink-2">
                        {poiLabel} ({poi.distPct.toFixed(1)}% away)
                      </span>
                    )
                  ) : (
                    <span className="text-ink-3">None near</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
