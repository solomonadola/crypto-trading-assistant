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
// ENTRY_GATES=off turns the level gates off for a run (a test, or a session
// where you want the old behaviour back) without editing this file. Browser
// builds have no process, hence the guard.
const env = (typeof process !== 'undefined' && process.env ? process.env : {}) as Record<string, string | undefined>;
const GATES_ON = env.ENTRY_GATES !== 'off';

export const ENTRY_CONFIG = {
  useRealCandles: true,

  /**
   * Level gates, measured in tools/study-levels.mjs on the same entry set the
   * scanner actually took, labelled with what the real analysis said at that
   * moment. Forward return at 4h, net of a 30 bp round trip:
   *
   *                                    in-sample (6mo)   out-of-sample (24mo)
   *   every entry                          -25.6 bp            -30.9 bp
   *   resistance within 0.25 ATR           -70.9 bp            -78.6 bp   (t -25.6)
   *   4h trend bearish                     -90.6 bp           -101.8 bp   (t -20.2)
   *   price within 0.25 ATR of support     +13.3 bp            +14.3 bp   (t  +4.0)
   *   all three gates together             +40.5 bp            +54.3 bp   (t  +9.7)
   *
   * Both samples agree on sign and size, on thousands of entries. Through the
   * bot's own exit ladder out of sample the same filter takes the result from
   * -79.3 bp a trade (PF 0.82) to -7.5 bp (PF 0.98), and with the older tighter
   * ladder to +37.2 bp (PF 1.24).
   */
  requireSupportProximity: GATES_ON,
  maxDistanceToSupportAtr: 0.25,

  /** Reject when the nearest real resistance is closer than this many ATR. */
  minHeadroomToResistanceAtr: GATES_ON ? 0.25 : 0,

  /** Reject when the 4h structure is in a downtrend. */
  rejectBearishTrend: GATES_ON,

  /** How many separate swings a price must have held to count as a level. */
  minLevelTouches: 2,

  /**
   * Also require the lower timeframe to have closed back up (the reclaim
   * candle). Stronger per trade (+92.6 bp out of sample against +54.3) but it
   * keeps only a quarter as many entries, so it is off until the live results
   * say the trade count can afford it.
   */
  requireReclaim: false,
};

/**
 * Whether the level gates are in force at all.
 *
 * It matters because a coin whose candles could not be fetched has nothing to
 * measure, and an unmeasured gate must not be read as a pass: that is how the
 * filter quietly stopped applying to 74 of 80 coins (STUDY_A_RESULTS.md
 * addendum 5). With the gates on, "could not measure" means "do not trade".
 * With them off - ENTRY_GATES=off, or useRealCandles off, where nothing can
 * ever be measured - entries go through as they did before.
 */
export const LEVEL_GATES_ACTIVE = GATES_ON && ENTRY_CONFIG.useRealCandles;
