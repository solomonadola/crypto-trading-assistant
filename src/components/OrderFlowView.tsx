import React from 'react';
import { EstimateNotice } from './EstimateNotice';
import { 
  TrendingUp, 
  TrendingDown, 
  Layers, 
  ShieldAlert, 
  Zap, 
  Activity, 
  ArrowUpRight, 
  ArrowDownRight,
  Filter
} from 'lucide-react';
import { CryptoCoin } from '../types';
import { calculateGlobalMarketOrderFlow, calculateCoinOrderFlow, formatCashUSD, formatOrderFlowUSD } from '../services/orderFlowService';

interface OrderFlowViewProps {
  coins: CryptoCoin[];
}

export const OrderFlowView: React.FC<OrderFlowViewProps> = ({ coins }) => {
  const globalFlow = calculateGlobalMarketOrderFlow(coins);

  return (
    <div id="orderflow-view-root" className="space-y-6">
      <EstimateNotice />
      
      {/* Global Order Flow Summary Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-stone-900 via-stone-900 to-stone-950 border border-stone-800 p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-1">
          <span className="flex h-2 w-2 rounded-full bg-amber-400"></span>
          <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
            Estimated Buy/Sell Pressure
          </span>
        </div>
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-100">
          Institutional Order Flow & Whale CVD Terminal
        </h2>
        <p className="text-xs sm:text-sm text-stone-400 mt-1 max-w-2xl">
          Lee-Ready tick-spread price-volume decomposition measuring aggressive taker buying vs. selling, whale block flows (&gt; $100k), and ceiling exhaustion traps.
        </p>

        {/* Global Delta Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-4 border-t border-stone-800/80">
          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800">
            <span className="text-[10px] text-stone-400 uppercase block">24h Market Volume</span>
            <span className="text-lg font-extrabold text-stone-100">
              {formatCashUSD(globalFlow.totalMarketVolumeUSD)}
            </span>
            <span className="text-[10px] text-stone-500 block">Combined Liquid Pairs</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800">
            <span className="text-[10px] text-stone-400 uppercase block">Net CVD Cash Delta</span>
            <span className={`text-lg font-extrabold ${
              globalFlow.globalNetDeltaUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}>
              {formatOrderFlowUSD(globalFlow.globalNetDeltaUSD)}
            </span>
            <span className="text-[10px] text-stone-500 block">Taker Imbalance</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800">
            <span className="text-[10px] text-stone-400 uppercase block">Taker Buy Share</span>
            <span className="text-lg font-extrabold text-amber-400">
              {globalFlow.globalBuyRatioPct}%
            </span>
            <span className="text-[10px] text-stone-500 block">Sell Share: {globalFlow.globalSellRatioPct}%</span>
          </div>

          <div className="p-3 rounded-xl bg-stone-950/60 border border-stone-800">
            <span className="text-[10px] text-stone-400 uppercase block">Dominant Market State</span>
            <span className="text-sm font-bold text-stone-200 truncate block mt-0.5">
              {globalFlow.dominantState.replace('_', ' ')}
            </span>
            <span className="text-[10px] text-stone-500 block">Ratio: {globalFlow.takerBuySellRatio}:1</span>
          </div>
        </div>
      </div>

      {/* Inflow vs Outflow Leaders */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        
        {/* Top Net Inflow */}
        <div className="p-4 rounded-2xl bg-stone-900 border border-stone-800">
          <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-3 flex items-center gap-2">
            <ArrowUpRight className="w-4 h-4" />
            <span>Top Net Inflow Assets (Aggressive Taker Buying)</span>
          </h3>
          <div className="space-y-2">
            {globalFlow.topInflowCoins.map((coin) => (
              <div
                key={coin.coinId}
                className="p-2.5 rounded-xl bg-stone-950/60 border border-stone-800/80 flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-2.5">
                  {coin.image ? (
                    <img src={coin.image} alt={coin.symbol} className="w-7 h-7 rounded-full" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-stone-800 flex items-center justify-center font-bold text-[10px] text-stone-300">
                      {coin.symbol.slice(0, 2)}
                    </div>
                  )}
                  <div>
                    <span className="font-bold text-stone-200">{coin.name} ({coin.symbol})</span>
                    <span className="text-[11px] text-stone-500 block">${coin.price}</span>
                  </div>
                </div>

                <div className="text-right">
                  <span className="font-bold text-emerald-400 block">{formatOrderFlowUSD(coin.netDeltaUSD)}</span>
                  <span className="text-[10px] text-stone-400">{coin.buyRatioPct}% Buy Share</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top Net Outflow */}
        <div className="p-4 rounded-2xl bg-stone-900 border border-stone-800">
          <h3 className="text-xs font-bold uppercase tracking-wider text-rose-400 mb-3 flex items-center gap-2">
            <ArrowDownRight className="w-4 h-4" />
            <span>Top Net Outflow Assets (Aggressive Taker Selling)</span>
          </h3>
          <div className="space-y-2">
            {globalFlow.topOutflowCoins.map((coin) => (
              <div
                key={coin.coinId}
                className="p-2.5 rounded-xl bg-stone-950/60 border border-stone-800/80 flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-2.5">
                  {coin.image ? (
                    <img src={coin.image} alt={coin.symbol} className="w-7 h-7 rounded-full" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-stone-800 flex items-center justify-center font-bold text-[10px] text-stone-300">
                      {coin.symbol.slice(0, 2)}
                    </div>
                  )}
                  <div>
                    <span className="font-bold text-stone-200">{coin.name} ({coin.symbol})</span>
                    <span className="text-[11px] text-stone-500 block">${coin.price}</span>
                  </div>
                </div>

                <div className="text-right">
                  <span className="font-bold text-rose-400 block">{formatOrderFlowUSD(coin.netDeltaUSD)}</span>
                  <span className="text-[10px] text-stone-400">{(100 - coin.buyRatioPct).toFixed(1)}% Sell Share</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Smart Money vs Retail Table */}
      <div className="p-4 rounded-2xl bg-stone-900 border border-stone-800">
        <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400 mb-3 flex items-center gap-2">
          <Activity className="w-4 h-4" />
          <span>Large vs Small Order Split (estimated)</span>
        </h3>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-stone-300">
            <thead className="bg-stone-950/70 text-stone-400 uppercase text-[10px] border-b border-stone-800">
              <tr>
                <th className="py-2.5 px-3">Asset</th>
                <th className="py-2.5 px-3">24h Price</th>
                <th className="py-2.5 px-3">Est. Large-Order Buy %</th>
                <th className="py-2.5 px-3">Est. Small-Order Buy %</th>
                <th className="py-2.5 px-3">Est. Large-Order Delta</th>
                <th className="py-2.5 px-3">Estimated Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-800/60">
              {coins.map((coin) => {
                const of = calculateCoinOrderFlow(coin);
                const sm = of.smartMoneyDivergence;

                return (
                  <tr key={coin.id} className="hover:bg-stone-950/40 transition-colors">
                    <td className="py-2.5 px-3 font-bold text-stone-200">
                      {coin.name} <span className="text-stone-400 font-mono text-[11px]">({coin.symbol.toUpperCase()})</span>
                    </td>
                    <td className="py-2.5 px-3">
                      ${coin.current_price}
                      <span className={`ml-1 text-[10px] ${
                        (coin.price_change_percentage_24h || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}>
                        {(coin.price_change_percentage_24h || 0) >= 0 ? '+' : ''}{(coin.price_change_percentage_24h || 0).toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-semibold text-emerald-400">
                      {of.whale?.whaleBuyRatioPct}%
                    </td>
                    <td className="py-2.5 px-3 font-semibold text-stone-400">
                      {of.retail?.retailBuyRatioPct}%
                    </td>
                    <td className={`py-2.5 px-3 font-bold ${
                      (of.whale?.whaleNetDeltaUSD || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}>
                      {formatOrderFlowUSD(of.whale?.whaleNetDeltaUSD || 0)}
                    </td>
                    <td className="py-2.5 px-3">
                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-stone-950 border border-stone-800 text-amber-300">
                        {sm?.summaryBadge || 'Neutral Flow'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
