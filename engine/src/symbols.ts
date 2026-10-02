// Symbol naming helpers shared by the scanner and the risk rules.

/** The base asset with any 1000/1M multiplier prefix removed: 1000PEPE -> PEPE. */
export function baseName(baseAsset: string): string {
  return baseAsset.replace(/^(1000000|1000|1M)(?=[A-Z])/, '');
}

/** BTCUSDT -> BTC, 1000PEPEUSDT -> PEPE. */
export const coinOf = (symbol: string) => baseName(symbol.replace(/USDT$/, ''));

/**
 * What someone typed ("pepe", "PEPE/USDT", "1000pepeusdt") -> the USDT perpetual
 * it names, or null when there is none. `symbols` is the exchange's list.
 */
export function resolveSymbol(input: string, symbols: { symbol: string; baseAsset: string }[]): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  const exact = symbols.find((x) => x.symbol === s || x.symbol === `${s}USDT`);
  if (exact) return exact.symbol;
  const base = baseName(s.replace(/USDT$/, ''));
  return symbols.find((x) => baseName(x.baseAsset) === base)?.symbol ?? null;
}
