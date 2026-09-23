/**
 * Entry settings: what the scanner measures from, and what it requires.
 *
 * `useRealCandles` fetches 1h/4h/1d candles and computes EMAs, RSI, ATR, swing
 * levels, structure and pullbacks from them (marketAnalysisService). With it
 * off, the scanner falls back to the old estimates derived from the 24-hour
 * ticker snapshot - where the "4H 21 EMA" was price x 0.994 on every coin.
 *
 * The level requirements below are off until measured: they are the rules a
 * level-aware entry needs ("wait for the level, then confirm"), and they are
 * only worth switching on if the replay shows they beat the current entries
 * out of sample.
 */
export const ENTRY_CONFIG = {
  useRealCandles: true,

  /** Only enter when price is within this many ATR of a real support level. */
  requireSupportProximity: false,
  maxDistanceToSupportAtr: 0.5,

  /** How many separate swings a price must have held to count as a level. */
  minLevelTouches: 2,

  /** Only enter when the lower timeframe has closed back up (the reclaim candle). */
  requireReclaim: false,

  /** Reject when the nearest real resistance is closer than this many ATR. */
  minHeadroomToResistanceAtr: 0,
};
