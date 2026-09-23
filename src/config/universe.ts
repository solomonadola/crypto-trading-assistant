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
  // Tokenised shares and ETFs. They trade on Binance as USDT pairs but follow
  // stock-market hours and news, not crypto, and their prices match their
  // underlyings: on 2026-09-23 NVDAB was $229.08, MSTRB $169.64, SOXLB
  // $149.78, SPCXB $154.52, QQQB $748.01, CRCLB $91.67, SNDKB $1,764.50.
  // Going from the top 40 to the top 80 by volume brought a batch of these in
  // at once - NVDAB and SOXLB both passed the level gates on the first scan.
  // Check the "[Universe]" log line for new ones and add them here.
  'CRCLB', 'SNDKB', 'NVDAB', 'MSTRB', 'SOXLB', 'SPCXB', 'QQQB',
]);
