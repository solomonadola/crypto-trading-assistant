// Symbol naming helpers shared by the scanner and the risk rules.

/** The base asset with any 1000/1M multiplier prefix removed: 1000PEPE -> PEPE. */
export function baseName(baseAsset: string): string {
  return baseAsset.replace(/^(1000000|1000|1M)(?=[A-Z])/, '');
}

/** BTCUSDT -> BTC, 1000PEPEUSDT -> PEPE. */
export const coinOf = (symbol: string) => baseName(symbol.replace(/USDT$/, ''));
