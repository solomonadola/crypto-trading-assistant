import { LearningLesson } from '../types';

export const LEARNING_LESSONS: LearningLesson[] = [
  {
    id: 'crypto-101-invest-vs-trade',
    category: 'Fundamentals',
    title: 'Investing vs. Trading: Choosing Your Path',
    summary: 'Understand the fundamental difference between long-term thesis investing and short-term technical trading.',
    readTime: '4 min',
    difficulty: 'Beginner',
    content: [
      {
        heading: '1. The Core Philosophy',
        body: 'Investing is about buying value and holding through market cycles (months to years) based on technology adoption, network effects, and utility. Trading is about capitalizing on price volatility and market inefficiencies across shorter timeframes (minutes, hours, or days) using probability, charts, and risk controls.',
        keyTakeaways: [
          'Investors ask: "Will this network be widely used in 5 years?"',
          'Traders ask: "Is the current price structure favorable for a 3:1 risk-to-reward setup today?"',
          'Conflating the two (e.g. trading without a stop-loss and saying "now I am an investor") is the #1 beginner mistake.'
        ],
        investingTakeaway: 'Focus on network growth, active wallets, revenue/fees generated, and token distribution.',
        tradingTakeaway: 'Focus on liquidity, volatility, clear invalidation levels, and disciplined execution.'
      },
      {
        heading: '2. Time Horizons & Mindset',
        body: 'Investors typically practice Dollar-Cost Averaging (DCA), dampening emotional volatility during bear markets. Traders look for clear support/resistance breakouts, liquidity sweeps, or momentum divergences and always define risk before entering.',
        keyTakeaways: [
          'DCA reduces timing risk for long-term investors.',
          'Active traders must manage trade sizes to never risk more than 1-2% of their portfolio on a single idea.'
        ],
        investingTakeaway: 'Set a disciplined automated schedule (e.g. weekly/monthly).',
        tradingTakeaway: 'Never trade without a pre-calculated stop loss.'
      }
    ],
    quiz: {
      question: 'What is the most critical mistake beginners make when combining investing and trading?',
      options: [
        'Holding Bitcoin for more than 2 years',
        'Letting a losing short-term trade drop and turning it into an unplanned "long-term investment" without risk management',
        'Using Dollar Cost Averaging (DCA)',
        'Checking market cap before buying'
      ],
      correctIndex: 1,
      explanation: 'When a trade hits its invalidation point, continuing to hold out of emotion converts an active risk-managed trade into an unplanned holding bag.'
    }
  },
  {
    id: 'crypto-102-marketcap-vs-price',
    category: 'Tokenomics',
    title: 'Market Cap vs. Unit Bias: The $1 Myth',
    summary: 'Why a coin priced at $0.001 is NOT necessarily cheaper than a coin priced at $60,000.',
    readTime: '5 min',
    difficulty: 'Beginner',
    content: [
      {
        heading: '1. The Unit Bias Trap',
        body: 'Beginners frequently believe that buying 1,000,000 tokens of a coin priced at $0.0001 gives them a better chance of getting rich than buying 0.01 Bitcoin. In reality, coin price is meaningless without knowing Circulating Supply. Market Cap = Price * Circulating Supply.',
        keyTakeaways: [
          'Bitcoin has a max supply of 21,000,000 coins.',
          'Some meme coins have 500,000,000,000,000 coins.',
          'If a coin with 100 trillion tokens reached $1, its market cap would exceed the entire global GDP.'
        ],
        investingTakeaway: 'Always evaluate projects by their Market Cap and Fully Diluted Valuation (FDV), never by the raw unit price.',
        tradingTakeaway: 'High-supply low-priced tokens can have high volatility, but look at order book depth and 24h volume.'
      },
      {
        heading: '2. Fully Diluted Valuation (FDV) & Token Unlocks',
        body: 'If only 10% of a token is circulating today and 90% is locked for early venture capitalists and team members, future unlocks will dilute current holders unless demand expands rapidly.',
        keyTakeaways: [
          'High FDV with low circulating supply creates structural sell pressure.',
          'Check the unlock schedule before entering multi-month holdings.'
        ],
        investingTakeaway: 'Favor projects where Circulating Supply is > 60-70% of Total Supply, or where emission schedules are sustainable.',
        tradingTakeaway: 'Trade around major unlock dates as volatility events.'
      }
    ],
    quiz: {
      question: 'If Token A is priced at $0.0001 with 10 trillion circulating supply, what is its Market Cap?',
      options: [
        '$1 Million',
        '$100 Million',
        '$1 Billion',
        '$10 Billion'
      ],
      correctIndex: 2,
      explanation: '0.0001 * 10,000,000,000,000 = $1,000,000,000 ($1 Billion Market Cap).'
    }
  },
  {
    id: 'crypto-103-layers-and-ecosystems',
    category: 'Fundamentals',
    title: 'Layer 1s, Layer 2s & Bridges Explained',
    summary: 'Deconstruct the blockchain stack: Settlement layers, execution rollups, and interoperability.',
    readTime: '6 min',
    difficulty: 'Intermediate',
    content: [
      {
        heading: '1. The Blockchain Trilemma',
        body: 'Blockchains struggle to achieve all three simultaneously: Decentralization, Security, and Scalability. Layer 1s (like Ethereum, Bitcoin, Solana) provide the base settlement and security. Layer 2s (like Arbitrum, Optimism, Base) execute transactions off-chain and post cryptographic proofs back to L1.',
        keyTakeaways: [
          'Bitcoin: Digital gold, monetary store of value, Proof of Work (PoW).',
          'Ethereum: Global decentralized computer & settlement layer, Proof of Stake (PoS).',
          'Solana: High-throughput monolithic chain optimized for speed and sub-second finality.',
          'Layer 2 Rollups: Scale Ethereum by batching thousands of transactions with minimal fees.'
        ],
        investingTakeaway: 'Diversify across different architectural philosophies (monolithic vs modular).',
        tradingTakeaway: 'Watch ecosystem rotation trends (e.g. Solana meme seasons vs L2 DeFi inflows).'
      }
    ],
    quiz: {
      question: 'What is the primary role of a Layer 2 (like Arbitrum or Optimism)?',
      options: [
        'To replace Bitcoin as digital gold',
        'To execute transactions faster and cheaper while inheriting Layer 1 security',
        'To eliminate the need for any validators',
        'To print infinite tokens'
      ],
      correctIndex: 1,
      explanation: 'Layer 2s batch and compute transactions off-chain and finalize proofs on Ethereum (Layer 1) to reduce fees while preserving security.'
    }
  },
  {
    id: 'crypto-104-technical-indicators-101',
    category: 'Trading & TA',
    title: 'Technical Analysis Essentials: RSI, MAs & Support/Resistance',
    summary: 'Learn the primary chart indicators used to evaluate price momentum, trends, and exhaustion.',
    readTime: '5 min',
    difficulty: 'Intermediate',
    content: [
      {
        heading: '1. Support & Resistance & Moving Averages',
        body: 'Support is a price floor where buyers consistently step in. Resistance is a ceiling where sellers take profit. Moving averages (20-day, 50-day, 200-day) smooth price noise to reveal the underlying trend. When price is above the 200-day MA, the broader macro trend is bullish.',
        keyTakeaways: [
          'The 200 EMA/SMA is the most watched macro trend indicator by institutional traders.',
          'Golden Cross: 50 MA crosses above 200 MA (bullish momentum).',
          'Death Cross: 50 MA crosses below 200 MA (bearish momentum).'
        ],
        investingTakeaway: 'Use macro 200-day MA dips as high-conviction DCA accumulation zones.',
        tradingTakeaway: 'Trade pullbacks to dynamic support (20/50 EMA) in established trends.'
      },
      {
        heading: '2. Relative Strength Index (RSI)',
        body: 'RSI measures the speed and change of price movements on a scale from 0 to 100. Traditionally, RSI above 70 indicates an overbought condition, while RSI below 30 signals oversold.',
        keyTakeaways: [
          'In strong bull trends, RSI can stay overbought (>70) for weeks.',
          'Bullish Divergence: Price makes a lower low, but RSI makes a higher low (signals fading selling pressure).'
        ],
        investingTakeaway: 'Weekly RSI < 30 on top blue-chip assets has historically marked cyclical bottoms.',
        tradingTakeaway: 'Look for RSI divergence at key horizontal support or resistance levels.'
      }
    ],
    quiz: {
      question: 'What does a Bullish RSI Divergence indicate?',
      options: [
        'The price is about to crash immediately',
        'Price made a lower low, but RSI momentum made a higher low, hinting sellers are exhausting',
        'The coin has zero circulating supply',
        'Trading volume has tripled'
      ],
      correctIndex: 1,
      explanation: 'When price drops further but RSI indicator shows higher strength, the downward momentum is weakening, signaling a potential reversal.'
    }
  },
  {
    id: 'crypto-105-risk-management',
    category: 'Risk & Security',
    title: 'The Golden Rules of Crypto Risk Management',
    summary: 'How to protect your capital: Position sizing, cold storage, and surviving bear markets.',
    readTime: '4 min',
    difficulty: 'Beginner',
    content: [
      {
        heading: '1. Position Sizing & The 1% Rule',
        body: 'Professional traders never risk more than 1% to 2% of their total account value on a single trade. If you have a $5,000 account, a 1% risk is $50 max loss on that trade. Your position size is adjusted based on your stop-loss distance.',
        keyTakeaways: [
          'Position Size = (Account Risk in $) / (Entry Price - Stop Loss Price).',
          'A 50% portfolio loss requires a 100% gain just to break even.',
          'An 80% portfolio loss requires a 400% gain to break even.'
        ],
        investingTakeaway: 'Never invest money you need for rent, food, or emergency funds in the next 12-24 months.',
        tradingTakeaway: 'Size positions so that no single loss causes emotional distress.'
      }
    ],
    quiz: {
      question: 'If you have a $10,000 account and follow the 1% risk rule, what is the maximum amount you should lose if your stop-loss is hit?',
      options: [
        '$10',
        '$100',
        '$1,000',
        '$5,000'
      ],
      correctIndex: 1,
      explanation: '1% of $10,000 is $100. Your position size and stop-loss should be configured so the total loss does not exceed $100.'
    }
  }
];

export const CRYPTO_GLOSSARY = [
  { term: 'ATH (All-Time High)', def: 'The highest historical price ever recorded for a cryptocurrency.' },
  { term: 'Circulating Supply', def: 'The number of coins currently circulating and publicly tradable in the market.' },
  { term: 'Total Supply vs Max Supply', def: 'Total supply is all coins created minus burned coins. Max supply is the hardcoded lifetime limit (e.g., 21M for Bitcoin).' },
  { term: 'FDV (Fully Diluted Valuation)', def: 'Theoretical market capitalization if all maximum supply tokens were in circulation at the current price.' },
  { term: 'DCA (Dollar Cost Averaging)', def: 'Investing a fixed dollar amount into an asset at regular intervals regardless of the price.' },
  { term: 'RSI (Relative Strength Index)', def: 'A momentum oscillator (0-100) measuring the speed of recent price changes to evaluate overbought or oversold conditions.' },
  { term: 'Proof of Stake (PoS)', def: 'A consensus mechanism where validators lock up cryptocurrency (stake) to validate transactions and secure the network.' },
  { term: 'Proof of Work (PoW)', def: 'A consensus mechanism where miners solve cryptographic puzzles using computational power (e.g. Bitcoin).' },
  { term: 'Smart Contract', def: 'Self-executing code stored on a blockchain that runs automatically when predetermined conditions are met.' },
  { term: 'Gas Fees', def: 'Payments made by users to compensate for the computational energy required to process transactions on a blockchain.' },
  { term: 'Impermanent Loss', def: 'The difference in value between holding tokens versus providing liquidity to an Automated Market Maker (AMM) pool.' },
  { term: 'Order Book', def: 'An electronic list of buy and sell orders for a specific crypto asset organized by price level.' },
  { term: 'Stop Loss', def: 'An automatic exit order set at a specific price to limit potential loss on an open position.' },
  { term: 'Hardware Wallet (Cold Storage)', def: 'A physical device that stores crypto private keys offline, protecting them from online hacks.' }
];

export interface QuantitativeLesson {
  id: string;
  category: string;
  title: string;
  summary: string;
  timeEstimateMinutes: number;
  problemDescription: string;
  solutionMechanics: string;
  mathematicalFormulation: string;
  executionCheckpoints: string[];
  keyTakeaway: string;
}

export const QUANTITATIVE_LESSONS: QuantitativeLesson[] = [
  {
    id: 'asymmetric-harvest-ladders',
    category: 'Harvest Engineering',
    title: 'Asymmetric 1/3rd Harvest Ladders: The Edge of Systematic Scaling',
    summary: 'Why waiting for an all-or-nothing take profit creates drawdowns, and how 3-tier scaling guarantees locked profits.',
    timeEstimateMinutes: 5,
    problemDescription: 'Retail traders frequently experience round-trips: an open trade moves +8% into profit, but because their take-profit target was placed arbitrarily at +20%, price reverses and stops them out for a full loss.',
    solutionMechanics: 'Divide every micro-tranche into 3 asymmetric tiers: Tier 1 (+4%) locks 33% profit into cash and arms a zero-risk ratchet; Tier 2 (+8%) locks another 33%; Tier 3 (+15%+) lets the remaining 34% ride with an ATR trailing floor.',
    mathematicalFormulation: 'Total Realized PnL = (0.33 * P_entry * 0.04) + (0.33 * P_entry * 0.08) + (0.34 * (P_exit - P_entry))',
    executionCheckpoints: [
      'Take 33% off at +4.0% automatically',
      'Move Stop Loss to Entry + 0.3% exchange fee buffer instantly upon Tier 1 fill',
      'Take 33% off at +8.0% to guarantee mathematical net profit',
      'Trail remaining 34% with Peak - 1.8 * ATR'
    ],
    keyTakeaway: 'The goal of systematic trading is not to predict tops, but to extract guaranteed positive mathematical expectancy before the market reverses.'
  },
  {
    id: 'dynamic-zero-risk-ratchets',
    category: 'Risk Mitigation',
    title: 'Breakeven Stops: What They Buy and What They Cost',
    summary: 'Moving the stop to breakeven after the first target: the trade-off between win rate and average win.',
    timeEstimateMinutes: 4,
    problemDescription: 'Holding open risk while sitting on unrealized gains induces anxiety and leads to emotional discretionary intervention.',
    solutionMechanics: 'When Tier 1 (+1R) fills, the stop moves to entry + 0.1R. This does not remove risk: a price that gaps through the stop fills at the gap, and fees are still paid. It also converts many trades that would have run further into small scratches. On a market with no directional edge, no stop rule changes expected profit - it only reshapes it into more, smaller wins.',
    mathematicalFormulation: 'P_stop = P_entry * (1 + 0.1 * R),  R = stop distance as a fraction of entry',
    executionCheckpoints: [
      'Verify exchange maker/taker fee rate (0.10% standard spot)',
      'Arm ratchet only after Tier 1 fill is confirmed',
      'Ensure floor price remains immutable even if price oscillates near breakeven'
    ],
    keyTakeaway: 'A breakeven stop raises win rate and lowers the average win. Judge it by expectancy per trade, not by how often it wins.'
  },
  {
    id: 'orderflow-cvd-decomposition',
    category: 'Microstructure',
    title: 'Lee-Ready CVD & Tick-Spread Decomposition',
    summary: 'Decomposing volume into aggressive taker buyers versus passive limit absorption.',
    timeEstimateMinutes: 6,
    problemDescription: 'Candlestick charts show price changes but conceal whether volume was driven by aggressive market buyers or forced panic liquidation into passive limit orders.',
    solutionMechanics: 'The Lee-Ready algorithm classifies every trade execution as buyer-initiated or seller-initiated based on whether it prints at the ask or bid. Cumulative Volume Delta (CVD) tracks the running balance of aggressive buying versus selling. Note: this app has no trade-level data, so it cannot run Lee-Ready - its order-flow figures are estimates calculated from each coin\'s 24-hour price change and range.',
    mathematicalFormulation: 'Delta = Sum(Volume_taker_buy) - Sum(Volume_taker_sell) ; CVD_t = CVD_{t-1} + Delta_t',
    executionCheckpoints: [
      'Positive CVD with price consolidating at support confirms absorption',
      'Negative CVD with price rising indicates an exhaustion trap / thin book squeeze',
      'Real CVD needs every trade print or at least bid/ask quotes; a 24-hour ticker cannot provide it'
    ],
    keyTakeaway: 'Trade in the direction of taker aggression when supported by passive limit book liquidity.'
  },
  {
    id: 'bankroll-risk-parity',
    category: 'Portfolio Management',
    title: '10-Slot Fixed Parity & Zombie Trade Recycling',
    summary: 'Structuring treasury equity into 10 independent risk units with automatic stagnation recycling.',
    timeEstimateMinutes: 5,
    problemDescription: 'Over-allocating capital to a single coin or leaving funds trapped in flat, non-performing chop destroys opportunity cost.',
    solutionMechanics: 'Divide bankroll into 10 equal $10 micro-tranches ($100 total). If an active position remains flat (< 0.8% movement) for over 24 hours without hitting Tier 1, auto-recycle it to liquid cash.',
    mathematicalFormulation: 'Risk_per_trade = Tranche_USD * StopLoss_pct <= 0.30% of Bankroll_Equity',
    executionCheckpoints: [
      'Cap max active slots at 10 to prevent over-leverage',
      'Enforce $10.00 standard tranche sizing',
      'Recycle positions in Stagnation Decile 10 after 24h to redeploy into fresh momentum'
    ],
    keyTakeaway: 'Capital velocity is as critical as win rate. Do not let dead money idle when liquid opportunities exist.'
  }
];
