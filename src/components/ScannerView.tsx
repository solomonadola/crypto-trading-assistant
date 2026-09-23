import React, { useState, useMemo } from 'react';
import { resolvePositionSizeUSD } from '../config/geometry';
import { 
  Zap, 
  Activity, 
  TrendingUp, 
  TrendingDown, 
  ShieldCheck, 
  AlertTriangle, 
  Clock, 
  Filter, 
  Layers, 
  Search,
  ExternalLink,
  Info,
  CheckCircle2,
  Lock,
  Compass,
  Bot
} from 'lucide-react';
import { EntrySignalResult, ScannerTradingMode, EntryStrategyArchetype, EntrySignalStatus, MAJOR_COINS, MAX_MAJOR_COIN_SLOTS, MEME_COINS, MAX_MEME_COIN_SLOTS, COIN_REENTRY_COOLDOWN_MS } from '../types/entryScanner';
import { BankrollState, AutomatedTradeRecord } from '../types/automatedFeed';
import { SignalDetailModal } from './SignalDetailModal';
import { AutoPilotMonitorHUD } from './AutoPilotMonitorHUD';
import { 
  BtcMacroRegime, 
  AutoPilotCandidateRank, 
  MarketActivityRadar,
  RecentLossCircuitBreaker,
  AutoPilotPacingInfo
} from '../services/marketRegimeService';
import { formatCashUSD, formatOrderFlowUSD } from '../services/orderFlowService';

interface ScannerViewProps {
  signals: EntrySignalResult[];
  tradingMode: ScannerTradingMode;
  setTradingMode: (mode: ScannerTradingMode) => void;
  bankroll: BankrollState;
  trades?: AutomatedTradeRecord[];
  onDeploySignal: (signal: EntrySignalResult) => void;
  isAutoPilot?: boolean;
  onToggleAutoPilot?: () => void;
  btcRegime?: BtcMacroRegime;
  categoryExposure?: Record<string, number>;
  topCandidates?: AutoPilotCandidateRank[];
  activityRadar?: MarketActivityRadar;
  lossCircuitBreaker?: RecentLossCircuitBreaker;
  pacingInfo?: AutoPilotPacingInfo;
  isLoading?: boolean;
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  signals,
  tradingMode,
  setTradingMode,
  bankroll,
  trades = [],
  onDeploySignal,
  isAutoPilot = false,
  onToggleAutoPilot,
  btcRegime,
  categoryExposure = {},
  topCandidates = [],
  activityRadar,
  lossCircuitBreaker,
  pacingInfo,
  isLoading = false,
}) => {
  const [selectedSignal, setSelectedSignal] = useState<EntrySignalResult | null>(null);
  const [archetypeFilter, setArchetypeFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [directionFilter, setDirectionFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const openTradeSymbols = useMemo(() => {
    return new Set(
      trades
        .filter((t) => t.status === 'OPEN')
        .map((t) => t.symbol.toUpperCase())
    );
  }, [trades]);

  const openMajorCount = useMemo(() => {
    return trades.filter((t) => t.status === 'OPEN' && MAJOR_COINS.has(t.symbol.toUpperCase())).length;
  }, [trades]);

  const openMemeCount = useMemo(() => {
    return trades.filter((t) => t.status === 'OPEN' && MEME_COINS.has(t.symbol.toUpperCase())).length;
  }, [trades]);

  const cooldownMap = useMemo(() => {
    const map = new Map<string, number>();
    const now = Date.now();
    for (const t of trades) {
      if (t.status !== 'OPEN' && t.closedAtTimestamp) {
        const elapsed = now - t.closedAtTimestamp;
        if (elapsed < COIN_REENTRY_COOLDOWN_MS) {
          const minsLeft = Math.ceil((COIN_REENTRY_COOLDOWN_MS - elapsed) / 60000);
          const existing = map.get(t.symbol.toUpperCase()) || 0;
          if (minsLeft > existing) {
            map.set(t.symbol.toUpperCase(), minsLeft);
          }
        }
      }
    }
    return map;
  }, [trades]);

  const macroGate = signals[0]?.directionalConviction;
  const topPick = signals.find(s => s.isTopPick) || signals[0];

  const filteredSignals = signals.filter((sig) => {
    if (directionFilter !== 'ALL' && sig.direction !== directionFilter) return false;
    if (archetypeFilter !== 'ALL' && sig.archetype !== archetypeFilter) return false;
    if (statusFilter !== 'ALL' && sig.status !== statusFilter) return false;
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      return sig.symbol.toLowerCase().includes(q) || sig.coinName.toLowerCase().includes(q);
    }
    return true;
  });

  const candidateList = useMemo(() => {
    if (topCandidates && topCandidates.length > 0) return topCandidates;
    return signals
      .filter((s) => s.score >= 65 && !openTradeSymbols.has(s.symbol.toUpperCase()))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((signal, idx) => ({
        signal,
        rank: idx + 1,
        convictionScore: signal.score,
        rewardRiskRatio: signal.tradePlan?.rewardRiskRatio || 2.5,
        archetype: signal.archetypeName,
        category: MAJOR_COINS.has(signal.symbol.toUpperCase()) ? 'Majors' : MEME_COINS.has(signal.symbol.toUpperCase()) ? 'Memes' : 'Alts',
        isEligibleNow: true,
      }));
  }, [signals, topCandidates, openTradeSymbols]);

  const derivedCategoryExposure = useMemo(() => {
    if (Object.keys(categoryExposure).length > 0) return categoryExposure;
    const exp: Record<string, number> = {};
    for (const t of trades.filter((t) => t.status === 'OPEN')) {
      const cat = MAJOR_COINS.has(t.symbol.toUpperCase()) ? 'Majors' : MEME_COINS.has(t.symbol.toUpperCase()) ? 'Memes' : 'Alts';
      exp[cat] = (exp[cat] || 0) + 1;
    }
    return exp;
  }, [trades, categoryExposure]);

  const triggeredCount = signals.filter(s => s.status === 'TRIGGERED').length;
  const triggeredShortCount = signals.filter(s => s.status === 'TRIGGERED' && s.direction === 'SHORT').length;
  const formingCount = signals.filter(s => s.status === 'FORMING').length;
  const stagingCount = signals.filter(s => s.status === 'STAGING_AT_SUPPORT').length;

  return (
    <div id="scanner-view-root" className="space-y-6">
      
      {/* Top Banner: Mode & Macro Regime Gate */}
      <div className="rounded-2xl bg-gradient-to-r from-stone-900 via-stone-900 to-stone-950 border border-stone-800 p-4 sm:p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="flex h-2 w-2 rounded-full bg-amber-400"></span>
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
                Live Opportunity Scanner
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-100">
              Top Crypto Trade Opportunities
            </h2>
            <p className="text-xs sm:text-sm text-stone-400 mt-1 max-w-2xl">
              Scans Binance coins every 30 seconds using 5 checks (trend, estimated buy pressure, price structure, reward-to-risk). Scores rank signals; they are not guarantees.
            </p>
          </div>

          {/* Mode Switcher & Auto-Pilot Bot */}
          <div className="flex flex-wrap items-center gap-2 shrink-0 self-start md:self-center">
            {onToggleAutoPilot && (
              <button
                id="scanner-autopilot-btn"
                onClick={onToggleAutoPilot}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                  isAutoPilot
                    ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.2)]'
                    : 'bg-stone-950 border-stone-800 text-stone-400 hover:text-stone-200'
                }`}
                title={isAutoPilot ? 'Auto-Pilot is ON: Automatically enters top trades with $10' : 'Click to enable Auto-Pilot (hands-free trading)'}
              >
                <Bot className={`w-3.5 h-3.5 ${isAutoPilot ? 'text-emerald-400 animate-pulse' : 'text-stone-500'}`} />
                <span>Auto-Pilot:</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${
                  isAutoPilot ? 'bg-emerald-500 text-stone-950 font-black' : 'bg-stone-800 text-stone-400'
                }`}>
                  {isAutoPilot ? 'ACTIVE' : 'OFF'}
                </span>
              </button>
            )}

            <div className="flex max-w-full flex-wrap items-center gap-1.5 p-1 rounded-xl bg-stone-950 border border-stone-800">
              <button
                id="mode-futures-btn"
                onClick={() => setTradingMode('FUTURES_1_2D')}
                title="Trade both Long (Up) and Short (Down) on 1-2 day swings"
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  tradingMode === 'FUTURES_1_2D'
                    ? 'bg-amber-500 text-stone-950 shadow'
                    : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                Futures 1-2 Days (Long & Short)
              </button>
              <button
                id="mode-macro-btn"
                onClick={() => setTradingMode('SPOT_1_2W')}
                title="Trade only Long (Up) on safer 1-2 week moves"
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  tradingMode === 'SPOT_1_2W'
                    ? 'bg-amber-500 text-stone-950 shadow'
                    : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                Spot 1-2 Weeks (Long Only)
              </button>
            </div>
          </div>
        </div>

        {/* Stats Strip with Simple Titles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-4 border-t border-stone-800/80">
          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-stone-800">
            <span className="text-[10px] text-stone-400 uppercase block">Ready to Enter</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-bold text-emerald-400">{triggeredCount} Coins</span>
              {triggeredShortCount > 0 && (
                <span className="text-[11px] font-semibold text-rose-400">({triggeredShortCount} Shorts)</span>
              )}
            </div>
            <span className="text-[10px] text-stone-500">Passed all entry checks</span>
          </div>

          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-stone-800">
            <span className="text-[10px] text-stone-400 uppercase block">Almost Ready</span>
            <span className="text-lg font-bold text-amber-400">{stagingCount} Coins</span>
            <span className="text-[10px] text-stone-500">Waiting at bounce level</span>
          </div>

          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-stone-800">
            <span className="text-[10px] text-stone-400 uppercase block">Building Setup</span>
            <span className="text-lg font-bold text-stone-300">{formingCount} Coins</span>
            <span className="text-[10px] text-stone-500">Watching closely</span>
          </div>

          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-stone-800">
            <span className="text-[10px] text-stone-400 uppercase block">Top-Ranked Signal</span>
            <span className="text-lg font-bold text-amber-300">{topPick?.symbol || 'BTC'}</span>
            <span className="text-[10px] text-stone-500">{topPick?.score || 90}/100 score</span>
          </div>
        </div>
      </div>

      {/* Auto-Pilot Command & Control HUD */}
      {btcRegime && (
        <AutoPilotMonitorHUD
          isAutoPilot={isAutoPilot}
          onToggleAutoPilot={onToggleAutoPilot || (() => {})}
          bankroll={bankroll}
          btcRegime={btcRegime}
          categoryExposure={derivedCategoryExposure}
          topCandidates={candidateList}
          onDeployManualCandidate={(cand) => onDeploySignal(cand.signal)}
          activityRadar={activityRadar}
          lossCircuitBreaker={lossCircuitBreaker}
          pacingInfo={pacingInfo}
          trades={trades}
        />
      )}

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-stone-900 border border-stone-800 text-xs">
        
        <div className="flex flex-wrap items-center gap-2">
          {/* Direction Filter */}
          <select
            id="direction-filter-select"
            value={directionFilter}
            onChange={(e) => setDirectionFilter(e.target.value as 'ALL' | 'LONG' | 'SHORT')}
            className="px-3 py-1.5 rounded-lg bg-stone-950 border border-stone-700/80 text-stone-200 text-xs focus:outline-none focus:border-amber-500 font-medium"
          >
            <option value="ALL">All Directions (Long & Short)</option>
            <option value="LONG">Longs (Buy / Rise)</option>
            <option value="SHORT">Shorts (90+ Conviction Gate)</option>
          </select>

          {/* Strategy Type Filter */}
          <select
            id="archetype-filter-select"
            value={archetypeFilter}
            onChange={(e) => setArchetypeFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-stone-950 border border-stone-700/80 text-stone-200 text-xs focus:outline-none focus:border-amber-500"
          >
            <option value="ALL">All Trade Types</option>
            <option value="EMA_PULLBACK_4H">Trend Pullback Buy</option>
            <option value="VOLATILITY_SQUEEZE">Breakout Explosion</option>
            <option value="MEAN_REVERSION_DIP">Oversold Dip Buy</option>
            <option value="BEARISH_RESISTANCE_REJECTION">Ceiling Rejection Short</option>
            <option value="BEARISH_EMA_BREAKDOWN">Support Breakdown Short</option>
          </select>

          {/* Status Filter */}
          <select
            id="status-filter-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-stone-950 border border-stone-700/80 text-stone-200 text-xs focus:outline-none focus:border-amber-500"
          >
            <option value="ALL">All Readiness States</option>
            <option value="TRIGGERED">Ready Now (Triggered)</option>
            <option value="STAGING_AT_SUPPORT">Almost Ready (At Support)</option>
            <option value="FORMING">Building Setup</option>
            <option value="WATCHLIST">Watchlist</option>
            <option value="INHIBITED">Paused by BTC Gate</option>
          </select>
        </div>

        {/* Search Field */}
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-stone-500" />
          <input
            id="scanner-search-input"
            type="text"
            placeholder="Search coin (e.g. BTC, SOL)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-stone-950 border border-stone-700/80 text-stone-200 text-xs placeholder-stone-500 focus:outline-none focus:border-amber-500"
          />
        </div>
      </div>

      {/* Signals Grid */}
      <div id="signals-grid-container" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredSignals.map((sig) => {
          const isShort = sig.direction === 'SHORT';
          const plan = sig.tradePlan;
          const whaleNet = sig.orderFlow?.whale?.whaleNetDeltaUSD || 0;
          const sym = sig.symbol.toUpperCase();
          const isMajor = MAJOR_COINS.has(sym);
          const isMeme = MEME_COINS.has(sym);
          const isHighBetaAlt = !isMajor && !isMeme && Math.abs(sig.priceChange24hPct || 0) >= 3.0;
          const cooldownMins = cooldownMap.get(sym);
          const isMajorCapped = isMajor && openMajorCount >= MAX_MAJOR_COIN_SLOTS;
          const isMemeCapped = isMeme && openMemeCount >= MAX_MEME_COIN_SLOTS;

          const friendlyStatus = 
            sig.status === 'TRIGGERED' ? 'Ready to Enter' :
            sig.status === 'STAGING_AT_SUPPORT' ? 'At Support Level' :
            sig.status === 'FORMING' ? 'Building Setup' :
            sig.status === 'INHIBITED' ? 'Paused (BTC Volatility)' : sig.status;

          return (
            <div
              key={sig.id}
              id={`signal-card-${sig.coinId}`}
              className={`flex flex-col justify-between rounded-xl p-4 border transition-all ${
                sig.status === 'TRIGGERED'
                  ? isShort
                    ? 'bg-stone-900/90 border-rose-500/50 hover:border-rose-500/80 shadow-[0_0_15px_rgba(244,63,94,0.15)]'
                    : 'bg-stone-900/90 border-emerald-500/40 hover:border-emerald-500/70 shadow-lg'
                  : sig.status === 'STAGING_AT_SUPPORT'
                  ? 'bg-stone-900/80 border-amber-500/30 hover:border-amber-500/60'
                  : 'bg-stone-900/50 border-stone-800/80 hover:border-stone-700'
              }`}
            >
              <div>
                {/* Card Top: Coin Info & Status */}
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    {sig.image ? (
                      <img src={sig.image} alt={sig.symbol} className="w-8 h-8 rounded-full" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center font-bold text-xs text-stone-300">
                        {sig.symbol.slice(0, 2)}
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-stone-100">{sig.coinName}</span>
                        <span className="text-xs font-semibold text-stone-400">{sig.symbol}</span>
                      </div>
                      <span className="text-[11px] text-stone-400 block truncate max-w-[170px]" title={sig.archetypeName}>
                        {sig.archetypeName}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col items-end">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {isMajor ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30" title="Major asset (BTC, ETH, BNB, SOL). Capped at max 3 slots to reserve room for dynamic altcoins.">
                          Major (Cap 3)
                        </span>
                      ) : isMeme ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-pink-500/20 text-pink-300 border border-pink-500/30" title="Meme coin (DOGE, PEPE, WIF, BONK, etc.). Capped at max 2 slots to capture explosive upside while preventing sector flush.">
                          Meme (Cap 2)
                        </span>
                      ) : isHighBetaAlt ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30" title="High-Beta Altcoin with dynamic 24h momentum">
                          High-Beta Alt
                        </span>
                      ) : null}

                      {sig.timeframeConfluence && (
                        <span 
                          className={`px-1.5 py-0.5 rounded text-[9px] font-extrabold border ${
                            sig.timeframeConfluence.confluenceRating === 'A+'
                              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-[0_0_8px_rgba(16,185,129,0.2)]'
                              : sig.timeframeConfluence.confluenceRating === 'A'
                              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
                              : sig.timeframeConfluence.confluenceRating === 'B'
                              ? 'bg-stone-800 text-stone-300 border-stone-700'
                              : 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                          }`}
                          title={`Multi-Timeframe Alignment: ${sig.timeframeConfluence.alignedCount ?? 3}/4 Timeframes Aligned (4H, 1H, 15M, 5M)`}
                        >
                          MTF {sig.timeframeConfluence.confluenceRating}
                        </span>
                      )}

                      {cooldownMins !== undefined && cooldownMins > 0 ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 flex items-center gap-0.5" title="Auto-Pilot is cooling down for 20m post-exit to prevent immediate re-entry churn">
                          <Clock className="w-2.5 h-2.5 animate-pulse" />
                          {cooldownMins}m CD
                        </span>
                      ) : null}

                      {isShort ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30" title="Requires 90+ conviction score and confirmed seller volume">
                          90+ Gate
                        </span>
                      ) : (sig.score >= 90 && sig.status === 'TRIGGERED') ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" title="90+ High-Conviction Elite Setup">
                          90+ Conviction
                        </span>
                      ) : null}
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        isShort ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
                      }`} title={isShort ? 'Profits when the price drops' : 'Profits when the price rises'}>
                        {isShort ? 'SHORT (Bet Fall)' : 'BUY (Bet Rise)'}
                      </span>
                    </div>
                    <span className={`text-[10px] font-semibold mt-1 ${
                      sig.status === 'TRIGGERED' 
                        ? (isShort ? 'text-rose-400 font-bold' : 'text-emerald-400')
                        : sig.status === 'STAGING_AT_SUPPORT' ? 'text-amber-400' : 'text-stone-400'
                    }`}>
                      {friendlyStatus}
                    </span>
                  </div>
                </div>

                {/* Price & Score Row */}
                <div className="grid grid-cols-2 gap-2 my-3 p-2.5 rounded-lg bg-stone-950/60 border border-stone-800/80 text-xs">
                  <div>
                    <span className="text-[10px] text-stone-500 block">Price / 24h Change</span>
                    <span className="font-bold text-stone-200">${sig.currentPrice}</span>
                    <span className={`ml-1 text-[11px] font-semibold ${
                      sig.priceChange24hPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}>
                      {sig.priceChange24hPct >= 0 ? '+' : ''}{sig.priceChange24hPct.toFixed(2)}%
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] text-stone-500 block">Signal Score</span>
                    <div className="flex items-center gap-1.5">
                      <span className="font-extrabold text-amber-400 text-sm">{sig.score}/100</span>
                      <span className="text-[10px] text-stone-400">({sig.score >= 85 ? 'High Quality' : 'Moderate'})</span>
                    </div>
                  </div>
                </div>

                {/* Multi-Timeframe Alignment Ribbon */}
                <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-stone-950/80 border border-stone-800/80 text-[10px] mb-3">
                  <span className="text-stone-500 font-medium">MTF Cascade:</span>
                  <div className="flex items-center gap-1.5 font-mono text-[9px]">
                    <span 
                      className={`px-1.5 py-0.5 rounded ${sig.timeframeConfluence?.fourHourAligned ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30' : 'bg-stone-800/60 text-stone-500'}`}
                      title={`4H Trend: ${sig.timeframeConfluence?.dailyTrend || 'NEUTRAL'} (${sig.timeframeConfluence?.fourHourStructure || 'EXPANDING'})`}
                    >
                      4H {sig.timeframeConfluence?.fourHourAligned ? '✓' : '—'}
                    </span>
                    <span 
                      className={`px-1.5 py-0.5 rounded ${sig.timeframeConfluence?.oneHourAligned ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30' : 'bg-stone-800/60 text-stone-500'}`}
                      title={`1H Momentum: ${sig.timeframeConfluence?.oneHourImpulse || 'CHOP'}`}
                    >
                      1H {sig.timeframeConfluence?.oneHourAligned ? '✓' : '—'}
                    </span>
                    <span 
                      className={`px-1.5 py-0.5 rounded ${sig.timeframeConfluence?.fifteenMinAligned ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30' : 'bg-stone-800/60 text-stone-500'}`}
                      title={`15M Squeeze State: ${sig.timeframeConfluence?.fifteenMinSqueeze || 'CHOP'}`}
                    >
                      15M {sig.timeframeConfluence?.fifteenMinAligned ? '✓' : '—'}
                    </span>
                    <span 
                      className={`px-1.5 py-0.5 rounded ${sig.timeframeConfluence?.fiveMinAligned ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30' : 'bg-stone-800/60 text-stone-500'}`}
                      title={`5M Order Flow: ${sig.timeframeConfluence?.fiveMinFlow || 'NEUTRAL'}`}
                    >
                      5M {sig.timeframeConfluence?.fiveMinAligned ? '✓' : '—'}
                    </span>
                  </div>
                </div>

                {/* Plain English Details */}
                <div className="space-y-1.5 text-[11px] text-stone-400 mb-3">
                  <div className="flex items-center justify-between" title="Estimated from the 24h price change and range. No individual trades are observed.">
                    <span>Est. Buy Pressure:</span>
                    <span className={`font-semibold ${whaleNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {whaleNet >= 0 ? '+' : ''}{formatCashUSD(whaleNet)} {whaleNet >= 0 ? '(Buying)' : '(Selling)'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between" title="Distance to the second target compared with distance to the stop">
                    <span>Reward-to-Risk:</span>
                    <span className="font-bold text-stone-200">
                      {plan.rewardRiskRatio}:1 (Stop Loss: -{plan.stopLossPct}%)
                    </span>
                  </div>

                  <div className="flex items-center justify-between" title="First price where 33% profit is locked into cash and risk becomes zero">
                    <span>First Profit Target:</span>
                    <span className="font-semibold text-emerald-400">
                      ${plan.tier1Price} (+{plan.tier1Pct}%)
                    </span>
                  </div>
                </div>
              </div>

              {/* Card Footer Actions */}
              <div className="pt-3 border-t border-stone-800 flex items-center justify-between gap-2">
                <button
                  id={`inspect-signal-${sig.coinId}-btn`}
                  onClick={() => setSelectedSignal(sig)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-300 hover:text-stone-100 hover:bg-stone-800 transition-colors flex items-center gap-1"
                >
                  <Info className="w-3.5 h-3.5" />
                  <span>See Details</span>
                </button>

                {openTradeSymbols.has(sym) ? (
                  <button
                    disabled
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-stone-800 text-stone-400 border border-stone-700/60 cursor-not-allowed"
                    title={`${sig.symbol} is currently active in 1 of your 10 slots. The system enforces 10 distinct coins for risk diversification.`}
                  >
                    <Lock className="w-3 h-3 text-amber-500/70" />
                    <span>Active in Slot</span>
                  </button>
                ) : isMajorCapped ? (
                  <button
                    disabled
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-stone-800/80 text-stone-500 border border-stone-700/50 cursor-not-allowed"
                    title="Major coins (BTC, ETH, BNB, SOL) are capped at 3 simultaneous slots to reserve room for dynamic altcoins."
                  >
                    <Lock className="w-3 h-3 text-purple-400/60" />
                    <span>Majors Capped (3/3)</span>
                  </button>
                ) : isMemeCapped ? (
                  <button
                    disabled
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-stone-800/80 text-stone-500 border border-stone-700/50 cursor-not-allowed"
                    title="Meme coins are capped at 2 simultaneous slots to protect against sector flush."
                  >
                    <Lock className="w-3 h-3 text-pink-400/60" />
                    <span>Memes Capped (2/2)</span>
                  </button>
                ) : cooldownMins !== undefined && cooldownMins > 0 ? (
                  <button
                    id={`deploy-tranche-${sig.coinId}-btn`}
                    onClick={() => onDeploySignal(sig)}
                    disabled={!bankroll.canOpenNewTrade}
                    title={`${sig.symbol} closed recently. Auto-Pilot has a 20-min cooldown, but you can manually deploy an override.`}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold bg-cyan-950/60 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-700/60 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    <Clock className="w-3 h-3 text-cyan-400 animate-pulse" />
                    <span>Deploy ({cooldownMins}m CD)</span>
                  </button>
                ) : (
                  <button
                    id={`deploy-tranche-${sig.coinId}-btn`}
                    onClick={() => onDeploySignal(sig)}
                    disabled={!bankroll.canOpenNewTrade}
                    title={bankroll.canOpenNewTrade ? `Open a $${resolvePositionSizeUSD(bankroll.trancheSizeUSD, bankroll.totalPortfolioValueUSD, plan.stopLossPct).toFixed(2)} position, sized so the stop loses 0.4% of the account` : bankroll.blockReason}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold bg-amber-500 hover:bg-amber-400 text-stone-950 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    <Zap className="w-3 h-3" />
                    <span>Deploy ${resolvePositionSizeUSD(bankroll.trancheSizeUSD, bankroll.totalPortfolioValueUSD, plan.stopLossPct).toFixed(2)}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {filteredSignals.length === 0 && (
        <div className="p-8 text-center rounded-2xl bg-stone-900 border border-stone-800 text-stone-400">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center gap-2">
              <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-medium text-stone-300">Connecting to live Binance exchange feed...</p>
              <p className="text-xs text-stone-500">Discovering active liquid cryptocurrency markets in real-time.</p>
            </div>
          ) : (
            <p className="text-sm">No signals match the selected filters or search query.</p>
          )}
        </div>
      )}

      {/* Signal Detail Modal */}
      <SignalDetailModal
        signal={selectedSignal}
        positionSizeUSD={selectedSignal ? resolvePositionSizeUSD(bankroll.trancheSizeUSD, bankroll.totalPortfolioValueUSD, selectedSignal.tradePlan.stopLossPct) : undefined}
        onClose={() => setSelectedSignal(null)}
        onDeploy={(sig) => {
          onDeploySignal(sig);
          setSelectedSignal(null);
        }}
        canDeploy={
          bankroll.canOpenNewTrade &&
          !(selectedSignal && openTradeSymbols.has(selectedSignal.symbol.toUpperCase())) &&
          !(selectedSignal && MAJOR_COINS.has(selectedSignal.symbol.toUpperCase()) && openMajorCount >= MAX_MAJOR_COIN_SLOTS) &&
          !(selectedSignal && MEME_COINS.has(selectedSignal.symbol.toUpperCase()) && openMemeCount >= MAX_MEME_COIN_SLOTS)
        }
        deployBlockReason={
          selectedSignal && openTradeSymbols.has(selectedSignal.symbol.toUpperCase())
            ? `${selectedSignal.symbol} already occupies an active position. 10 bankroll slots are strictly dedicated to 10 distinct coins.`
            : selectedSignal && MAJOR_COINS.has(selectedSignal.symbol.toUpperCase()) && openMajorCount >= MAX_MAJOR_COIN_SLOTS
            ? `Major coins (BTC, ETH, BNB, SOL) are capped at 3 simultaneous slots to reserve room for dynamic altcoins and memes.`
            : selectedSignal && MEME_COINS.has(selectedSignal.symbol.toUpperCase()) && openMemeCount >= MAX_MEME_COIN_SLOTS
            ? `Meme coins (${Array.from(MEME_COINS).slice(0, 5).join(', ')}...) are capped at ${MAX_MEME_COIN_SLOTS} slots to prevent sector flush while capturing explosive upside.`
            : bankroll.blockReason
        }
        isAlreadyOpen={
          selectedSignal ? openTradeSymbols.has(selectedSignal.symbol.toUpperCase()) : false
        }
        cooldownMinutesRemaining={
          selectedSignal ? cooldownMap.get(selectedSignal.symbol.toUpperCase()) : undefined
        }
        isMajorCapped={
          selectedSignal ? (MAJOR_COINS.has(selectedSignal.symbol.toUpperCase()) && openMajorCount >= MAX_MAJOR_COIN_SLOTS) : false
        }
        isMemeCapped={
          selectedSignal ? (MEME_COINS.has(selectedSignal.symbol.toUpperCase()) && openMemeCount >= MAX_MEME_COIN_SLOTS) : false
        }
      />
    </div>
  );
};
