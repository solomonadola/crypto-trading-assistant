/**
 * Which coins the scanner looks at.
 *
 * 'volume': the `size` Binance USDT spot pairs with the most 24h trading
 * volume (in USDT), chosen from the same ticker data the price refresh already
 * fetches, and re-chosen every `refreshHours`. Between refreshes the list stays
 * put, so a coin does not drop in and out of the scan from one refresh to the
 * next.
 *
 * 'fixed': the hardcoded list in services/binanceService.ts (TOP_ASSETS) - the
 * one the replay studies in STUDY_A_RESULTS.md were run on.
 *
 * Open positions are priced from every Binance USDT pair either way, so a coin
 * leaving the list does not affect a trade already open in it.
 */
export const UNIVERSE_CONFIG = {
  mode: 'volume' as 'volume' | 'fixed',
  size: 80,
  refreshHours: 24,
};

/**
 * Never traded: stablecoins, wrapped or staked copies of other coins, and
 * tokenised gold. They rank high on volume but do not move like crypto
 * (or move exactly like the coin they wrap). Anything else priced within 2%
 * of $1 with a 24h range under 1% is treated as a stablecoin too.
 */
export const UNIVERSE_EXCLUDED = new Set([
  'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDS', 'USDE', 'USD1', 'PYUSD', 'RLUSD', 'BFUSD', 'XUSD',
  'EUR', 'EURI', 'AEUR',
  'WBTC', 'WBETH', 'WETH', 'BETH', 'STETH', 'WSTETH', 'BNSOL',
  'PAXG', 'XAUT',
  // Apparently tokenised shares: CRCLB and SNDKB (2026-09-22: $91.67 and
  // $1,764.50, stock-like prices matching Circle and SanDisk). Excluded to be
  // safe - they would follow stock-market hours and news, not crypto. Check the
  // "[Universe]" log line for new ones and add them here.
  'CRCLB', 'SNDKB',
]);
