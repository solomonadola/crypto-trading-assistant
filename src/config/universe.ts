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
  size: 60, // Top 60 institutional volume pairs
  refreshHours: 6, // Refresh every 6h so high-momentum coins entering >$50M volume are promptly caught
  min24hVolumeUSD: 50_000_000, // Capped at $50M minimum 24h volume: eliminates pump-and-dump illiquidity traps
  min24hRangePct: 3.5, // At least 3.5% 24h high-low range for rapid scalping momentum
  maxFundingRatePct: 0.025, // Maximum 0.025% per 8h funding rate (prevents heavy carry fee drag and long squeeze traps)
  preferredMaxFundingRatePct: 0.015, // Optimal low-fee threshold (0.015% or lower per 8h)
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
  // Tokenised shares and ETFs. They trade on Binance as USDT pairs but follow
  // stock-market hours and news, not crypto, and their prices match their
  // underlyings: on 2026-09-23 NVDAB was $229.08, MSTRB $169.64, SOXLB
  // $149.78, SPCXB $154.52, QQQB $748.01, CRCLB $91.67, SNDKB $1,764.50.
  // Going from the top 40 to the top 80 by volume brought a batch of these in
  // at once - NVDAB and SOXLB both passed the level gates on the first scan.
  // Check the "[Universe]" log line for new ones and add them here.
  'CRCLB', 'SNDKB', 'NVDAB', 'MSTRB', 'SOXLB', 'SPCXB', 'QQQB',
]);
