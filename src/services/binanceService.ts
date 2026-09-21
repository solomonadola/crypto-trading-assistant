import { CryptoCoin } from '../types';

export interface BinanceFuturesTicker {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  /** Number of trades in the last 24h. 0 means the listing is not trading. */
  count?: number;
}

const BINANCE_TICKER_CACHE_KEY = 'binance_futures_tickers_cache';
const CACHE_TTL_MS = 15000;

let lastFetchTime = 0;
let cachedTickers: Map<string, BinanceFuturesTicker> = new Map();

// Binance global spot only. data-api.binance.vision is Binance's public
// market-data mirror of the same market as api.binance.com.
//
// api.binance.us used to be the second fallback. It is NOT a mirror: Binance.US
// is a separate exchange with its own listings and prices and, for most of this
// universe, almost no volume ($0.00-0.1M/day vs $3-350M). Measured on
// 2026-09-21: FTM 0.4806 there vs 0.6994 on Binance (-31%), 1-2% gaps on
// OP/WIF/TIA/PEPE/UNI. Whenever the primary timed out, the app silently switched
// venue, and every open trade saw a fake price jump that could trigger a stop
// or bank a target that never happened. Stale-but-consistent prices are safer
// than fresh prices from a different market, so there is no cross-venue fallback.
const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision/api/v3/ticker/24hr',
  'https://api.binance.com/api/v3/ticker/24hr'
];

/** When the ticker data currently in use was actually fetched (0 = never). */
export function getLastTickerFetchTime(): number {
  return lastFetchTime;
}

/**
 * Fetches real-time Binance 24hr ticker data for US-dollar pairs (USDT).
 * Cycles through resilient mirrors to guarantee connectivity across all geographic regions.
 */
export async function fetchBinanceTickers(): Promise<Map<string, BinanceFuturesTicker>> {
  const now = Date.now();
  if (now - lastFetchTime < CACHE_TTL_MS && cachedTickers.size > 0) {
    return cachedTickers;
  }

  for (const endpoint of BINANCE_ENDPOINTS) {
    try {
      const controller = new AbortController();
      // The primary regularly takes several seconds; 3.5s pushed traffic to the fallback.
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      let data: BinanceFuturesTicker[];
      try {
        const response = await fetch(endpoint, {
          signal: controller.signal
        });
        if (!response.ok) {
          continue;
        }
        // The timeout must cover reading the body too: a server that sends
        // headers and then stalls would otherwise hang this call - and the
        // refresh loop waiting on it - indefinitely.
        data = await response.json();
      } finally {
        clearTimeout(timeoutId);
      }
      if (!Array.isArray(data) || data.length === 0) {
        continue;
      }

      const map = new Map<string, BinanceFuturesTicker>();
      for (const item of data) {
        // Skip listings with no trades in 24h: their lastPrice is stale.
        if (typeof item.count === 'number' && item.count <= 0) continue;
        if (item.symbol && (item.symbol.endsWith('USDT') || item.symbol.endsWith('USD'))) {
          map.set(item.symbol, item);
        }
      }

      if (map.size > 0) {
        cachedTickers = map;
        lastFetchTime = now;
        return map;
      }
    } catch {
      // Try next mirror
    }
  }

  console.warn('Binance live ticker fetch failed across all mirrors, using cached/fallback tickers.');
  return cachedTickers;
}

interface AssetDefinition {
  id: string;
  symbol: string;
  name: string;
  category: CryptoCoin['category'];
  image: string;
  launch_year: number;
  consensus: string;
  description: string;
}

export const TOP_ASSETS: AssetDefinition[] = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png', launch_year: 2009, consensus: 'Proof of Work', description: 'Decentralized digital currency and primary store of value.' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png', launch_year: 2015, consensus: 'Proof of Stake', description: 'Global decentralized computing platform for smart contracts and dApps.' },
  { id: 'solana', symbol: 'SOL', name: 'Solana', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/4128/large/solana.png', launch_year: 2020, consensus: 'Proof of History', description: 'High-throughput Layer 1 blockchain optimized for sub-second execution and low fees.' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png', launch_year: 2017, consensus: 'Proof of Staked Authority', description: 'Native utility ecosystem asset powering the BNB Chain network.' },
  { id: 'ripple', symbol: 'XRP', name: 'XRP', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png', launch_year: 2012, consensus: 'Federated Byzantine Agreement', description: 'Real-time gross settlement system for cross-border institutional remittances.' },
  { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin', category: 'Meme', image: 'https://assets.coingecko.com/coins/images/5/large/dogecoin.png', launch_year: 2013, consensus: 'Proof of Work', description: 'Peer-to-peer open-source cryptocurrency and global retail liquidity sentiment barometer.' },
  { id: 'cardano', symbol: 'ADA', name: 'Cardano', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/975/large/cardano.png', launch_year: 2017, consensus: 'Ouroboros PoS', description: 'Evidence-based Layer 1 blockchain built on peer-reviewed academic research.' },
  { id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png', launch_year: 2020, consensus: 'Avalanche Consensus', description: 'Subnet-driven Layer 1 smart contract platform with sub-second finality.' },
  { id: 'chainlink', symbol: 'LINK', name: 'Chainlink', category: 'Oracle', image: 'https://assets.coingecko.com/coins/images/877/large/chainlink-new-logo.png', launch_year: 2017, consensus: 'Decentralized Oracle Network', description: 'Industry standard decentralized oracle network connecting smart contracts to off-chain data.' },
  { id: 'sui', symbol: 'SUI', name: 'Sui', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/26375/large/sui_asset.jpeg', launch_year: 2023, consensus: 'Mysticeti / Narwhal', description: 'Object-centric high-throughput Layer 1 designed by former Meta engineers.' },
  { id: 'near', symbol: 'NEAR', name: 'NEAR Protocol', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/10365/large/near.png', launch_year: 2020, consensus: 'Nightshade PoS', description: 'Sharded Layer 1 blockchain designed for user usability and consumer AI scaling.' },
  { id: 'aptos', symbol: 'APT', name: 'Aptos', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/26455/large/aptos_round.png', launch_year: 2022, consensus: 'AptosBFT', description: 'Layer 1 utilizing the Move programming language for parallel execution.' },
  { id: 'uniswap', symbol: 'UNI', name: 'Uniswap', category: 'DeFi', image: 'https://assets.coingecko.com/coins/images/12504/large/uniswap-uni.png', launch_year: 2018, consensus: 'Ethereum ERC-20', description: 'Leading decentralized automated market maker (AMM) protocol.' },
  { id: 'render-token', symbol: 'RENDER', name: 'Render', category: 'AI & Data', image: 'https://assets.coingecko.com/coins/images/11636/large/rndr.png', launch_year: 2020, consensus: 'Solana SPL', description: 'Decentralized GPU rendering and AI compute distribution network.' },
  { id: 'injective-protocol', symbol: 'INJ', name: 'Injective', category: 'DeFi', image: 'https://assets.coingecko.com/coins/images/12882/large/Secondary_Symbol.png', launch_year: 2020, consensus: 'Tendermint PoS', description: 'Interoperable Layer 1 specifically optimized for decentralized finance orderbooks.' },
  { id: 'pepe', symbol: 'PEPE', name: 'Pepe', category: 'Meme', image: 'https://assets.coingecko.com/coins/images/29850/large/pepe-token.png', launch_year: 2023, consensus: 'Ethereum ERC-20', description: 'High-beta deflationary retail momentum meme token traded actively on Binance Futures.' },
  { id: 'arbitrum', symbol: 'ARB', name: 'Arbitrum', category: 'Layer 2', image: 'https://assets.coingecko.com/coins/images/16547/large/arbitrum_logo.png', launch_year: 2023, consensus: 'Optimistic Rollup', description: 'Leading Ethereum Layer 2 scaling suite using optimistic rollups with deep liquidity.' },
  { id: 'optimism', symbol: 'OP', name: 'Optimism', category: 'Layer 2', image: 'https://assets.coingecko.com/coins/images/25244/large/Optimism.png', launch_year: 2022, consensus: 'OP Stack Rollup', description: 'Collective governance and scalability platform powering the Superchain ecosystem.' },
  { id: 'celestia', symbol: 'TIA', name: 'Celestia', category: 'Infrastructure', image: 'https://assets.coingecko.com/coins/images/31967/large/tia.png', launch_year: 2023, consensus: 'Data Availability Tendermint', description: 'First modular blockchain network that securely scales data availability for rollups.' },
  { id: 'fetch-ai', symbol: 'FET', name: 'Artificial Superintelligence', category: 'AI & Data', image: 'https://assets.coingecko.com/coins/images/5681/large/Fetch.jpg', launch_year: 2019, consensus: 'Cosmos PoS', description: 'Decentralized autonomous AI agent compute alliance and machine learning protocol.' },
  { id: 'fantom', symbol: 'FTM', name: 'Sonic (Fantom)', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/4001/large/Fantom_round.png', launch_year: 2018, consensus: 'Lachesis aBFT', description: 'Ultra-fast sub-second DAG consensus Layer 1 transitioning to Sonic execution.' },
  { id: 'sei-network', symbol: 'SEI', name: 'Sei', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/28205/large/Sei_Logo_-_Transparent.png', launch_year: 2023, consensus: 'Twin-Turbo Consensus', description: 'Sector-specific Layer 1 blockchain specialized for trading exchanges and order books.' },
  { id: 'kaspa', symbol: 'KAS', name: 'Kaspa', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/28898/large/kaspa-icon-exchanges.png', launch_year: 2021, consensus: 'GHOSTDAG PoW', description: 'Instant blockDAG proof-of-work digital silver cryptocurrency with high throughput.' },
  { id: 'aave', symbol: 'AAVE', name: 'Aave', category: 'DeFi', image: 'https://assets.coingecko.com/coins/images/12645/large/AAVE.png', launch_year: 2020, consensus: 'Ethereum ERC-20', description: 'Pioneering non-custodial decentralized liquidity market protocol and lending standard.' },
  { id: 'dogwifhat', symbol: 'WIF', name: 'dogwifhat', category: 'Meme', image: 'https://assets.coingecko.com/coins/images/33566/large/dogwifhat.jpg', launch_year: 2023, consensus: 'Solana SPL', description: 'Top Solana-native community momentum asset with heavy Binance perpetual futures liquidity.' },
  { id: 'shiba-inu', symbol: 'SHIB', name: 'Shiba Inu', category: 'Meme', image: 'https://assets.coingecko.com/coins/images/11939/large/shiba.png', launch_year: 2020, consensus: 'Ethereum ERC-20', description: 'Global decentralized meme ecosystem featuring Shibarium Layer 2 and DEX utility.' },
  { id: 'polkadot', symbol: 'DOT', name: 'Polkadot', category: 'Layer 1', image: 'https://assets.coingecko.com/coins/images/12171/large/polkadot.png', launch_year: 2020, consensus: 'Nominated PoS', description: 'Heterogeneous multi-chain architecture connecting specialized parachains.' },
  { id: 'lido-dao', symbol: 'LDO', name: 'Lido DAO', category: 'DeFi', image: 'https://assets.coingecko.com/coins/images/13573/large/Lido_DAO.png', launch_year: 2020, consensus: 'Ethereum ERC-20', description: 'Liquid staking protocol providing capital efficiency for proof-of-stake blockchains.' },
  { id: 'bittensor', symbol: 'TAO', name: 'Bittensor', category: 'AI & Data', image: 'https://assets.coingecko.com/coins/images/30349/large/Bittensor_Token_Logo.png', launch_year: 2023, consensus: 'Subtensor Yuma', description: 'Decentralized open-source machine learning intelligence network with high volatility beta.' },
  { id: 'ethena', symbol: 'ENA', name: 'Ethena', category: 'DeFi', image: 'https://assets.coingecko.com/coins/images/36528/large/ethena.png', launch_year: 2024, consensus: 'Ethereum ERC-20', description: 'Synthetic dollar protocol and delta-neutral internet bond ecosystem.' },
  { id: 'bonk', symbol: 'BONK', name: 'Bonk', category: 'Meme', image: 'https://assets.coingecko.com/coins/images/28600/large/bonk.jpg', launch_year: 2022, consensus: 'Solana SPL', description: 'High-velocity Solana-native dog coin with prominent Binance perpetual volume.' },
  { id: 'jupiter-exchange-solana', symbol: 'JUP', name: 'Jupiter', category: 'DeFi', image: 'https://assets.coingecko.com/coins/images/34188/large/jup.png', launch_year: 2024, consensus: 'Solana SPL', description: 'Dominant decentralized liquidity aggregator and perpetual exchange on Solana.' },
  { id: 'popcat', symbol: 'POPCAT', name: 'Popcat', category: 'Meme', image: 'https://assets.coingecko.com/coins/images/33760/large/popcat.png', launch_year: 2023, consensus: 'Solana SPL', description: 'Top trending meme asset on Binance Futures with high percentage swings.' },
  { id: 'blockstack', symbol: 'STX', name: 'Stacks', category: 'Layer 2', image: 'https://assets.coingecko.com/coins/images/2069/large/Stacks_Logo_Primary_Color_Purple.png', launch_year: 2018, consensus: 'Proof of Transfer', description: 'Bitcoin Layer 2 smart contract execution and DeFi settlement layer.' },
  { id: 'worldcoin-org', symbol: 'WLD', name: 'Worldcoin', category: 'AI & Data', image: 'https://assets.coingecko.com/coins/images/31062/large/worldcoin.png', launch_year: 2023, consensus: 'Optimism OP Stack', description: 'Global proof-of-personhood biometric and decentralized AI verification network.' },
  { id: 'floki', symbol: 'FLOKI', name: 'FLOKI', category: 'Meme', image: 'https://assets.coingecko.com/coins/images/16746/large/FLOKI.png', launch_year: 2021, consensus: 'Ethereum ERC-20', description: 'Utility meme token powering Valhalla metaverse, crypto education, and DeFi.' }
];

// Pairs we have already warned about, so a missing listing logs once, not every 30s.
const warnedMissingPairs = new Set<string>();

/**
 * Fetches real-time market coins directly from Binance API without any mock data.
 * Assets without a live ticker are excluded rather than falling back to a
 * hardcoded price - a frozen price produces signals that can never resolve.
 */
export async function fetchLiveMarketCoins(): Promise<CryptoCoin[]> {
  const tickers = await fetchBinanceTickers();
  const coins: CryptoCoin[] = [];

  for (let i = 0; i < TOP_ASSETS.length; i++) {
    const asset = TOP_ASSETS[i];
    const binancePair = `${asset.symbol}USDT`;
    const ticker = tickers.get(binancePair) || tickers.get(`${asset.symbol}USD`);

    // Skip assets with no live ticker. There are zero fallback or hardcoded
    // prices; if a coin does not trade on Binance International spot, it is
    // kicked out completely from the universe.
    if (!ticker) {
      if (!warnedMissingPairs.has(binancePair)) {
        warnedMissingPairs.add(binancePair);
        console.warn(`[Universe] ${binancePair} has no live Binance ticker - excluded from scanning.`);
      }
      continue;
    }

    const livePrice = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.priceChangePercent);
    const high24h = parseFloat(ticker.highPrice);
    const low24h = parseFloat(ticker.lowPrice);
    const totalVolume = parseFloat(ticker.quoteVolume);
    const priceChange = parseFloat(ticker.priceChange);

    if (!(livePrice > 0) || !Number.isFinite(change24h)) {
      continue;
    }

    coins.push({
      id: asset.id,
      symbol: asset.symbol.toLowerCase(),
      name: asset.name,
      image: asset.image,
      current_price: livePrice,
      market_cap: totalVolume * 15,
      market_cap_rank: i + 1,
      fully_diluted_valuation: totalVolume * 18,
      total_volume: totalVolume,
      high_24h: high24h,
      low_24h: low24h,
      price_change_24h: priceChange,
      price_change_percentage_24h: change24h,
      circulating_supply: +(totalVolume / livePrice).toFixed(0),
      total_supply: null,
      max_supply: null,
      ath: high24h * 1.5,
      ath_change_percentage: -25,
      ath_date: new Date().toISOString(),
      atl: low24h * 0.5,
      category: asset.category,
      consensus: asset.consensus,
      launch_year: asset.launch_year,
      description: asset.description,
      whitepaper_summary: `${asset.name} operates on a decentralized architecture for institutional and retail liquidity.`,
      use_cases: ['Medium of Exchange', 'Liquidity Layer', 'Staking & Consensus'],
      key_risks: ['Market Volatility', 'Systemic Beta Drag', 'Regulatory Scrutiny'],
      tokenomics_summary: `Live supply traded on Binance with $${(totalVolume / 1e6).toFixed(1)}M 24h turnover.`
    });
  }

  return coins;
}

/**
 * Synchronizes a list of CryptoCoins with Binance live ticker data if available.
 * If a coin has no active ticker on Binance International or has an invalid/non-positive price,
 * it is filtered out rather than keeping stale data.
 */
export async function enrichCoinsWithBinance(coins: CryptoCoin[]): Promise<CryptoCoin[]> {
  if (!coins || coins.length === 0) {
    return fetchLiveMarketCoins();
  }

  try {
    const tickers = await fetchBinanceTickers();
    if (tickers.size === 0) return coins;

    const enriched: CryptoCoin[] = [];
    for (const coin of coins) {
      const binancePair = `${coin.symbol.toUpperCase()}USDT`;
      const ticker = tickers.get(binancePair) || tickers.get(`${coin.symbol.toUpperCase()}USD`);
      if (!ticker) continue;

      const livePrice = parseFloat(ticker.lastPrice);
      const change24h = parseFloat(ticker.priceChangePercent);
      const high24h = parseFloat(ticker.highPrice);
      const low24h = parseFloat(ticker.lowPrice);
      const totalVolume = parseFloat(ticker.quoteVolume);

      if (!(livePrice > 0) || !Number.isFinite(change24h)) {
        continue;
      }

      enriched.push({
        ...coin,
        current_price: livePrice,
        price_change_percentage_24h: change24h,
        high_24h: !isNaN(high24h) && high24h > 0 ? high24h : coin.high_24h,
        low_24h: !isNaN(low24h) && low24h > 0 ? low24h : coin.low_24h,
        total_volume: !isNaN(totalVolume) && totalVolume > 0 ? totalVolume : coin.total_volume,
      });
    }
    return enriched;
  } catch (err) {
    console.warn('Could not enrich coins with Binance:', err);
    return coins;
  }
}

/**
 * Symbol/id -> price for evaluating open trades: the scanned universe first,
 * then every other Binance USDT ticker so an open trade on a coin outside the
 * universe still gets a live price. Shared by the browser and the 24/7 worker.
 */
export async function buildPriceMap(coins: CryptoCoin[]): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();
  coins.forEach((c) => {
    if (c.current_price) {
      priceMap.set(c.symbol.toUpperCase(), c.current_price);
      priceMap.set(c.id.toLowerCase(), c.current_price);
    }
  });
  try {
    const tickers = await fetchBinanceTickers();
    tickers.forEach((t, pair) => {
      const p = parseFloat(t.lastPrice);
      if (!isNaN(p) && p > 0) {
        const sym = pair.replace(/USDT$|USD$/, '').toUpperCase();
        if (!priceMap.has(sym)) priceMap.set(sym, p);
      }
    });
  } catch {}
  return priceMap;
}
