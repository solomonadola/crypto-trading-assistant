import { describe, expect, it } from 'vitest';
import { autopilotCandles, hunterOnAtStart, settledPrices } from '../src/autopilot';
import { loadConfig } from '../src/config';
import type { Candle, Timeframe } from '../../shared/types';

const config = loadConfig('engine/config/config.yaml').scalp_autopilot;
const now = Date.parse('2026-10-13T07:05:04Z');
const candle = (symbol: string, tf: Timeframe, closeTime: number): Candle =>
  ({ symbol, tf, openTime: closeTime - 300_000, closeTime, open: 1, high: 1, low: 1, close: 1, volume: 1, quoteVolume: 1, trades: 1 });

describe('autopilotCandles', () => {
  const close = Date.parse('2026-10-13T07:05Z');
  const pick = (batch: Candle[], held: string[] = []) =>
    autopilotCandles(batch, { config, universe: new Set(['BATUSDT', 'CTUSDT']), held: new Set(held), now }).map((c) => `${c.symbol} ${c.tf}`);

  it('takes a just-closed 5m or 15m candle of a scanner coin', () => {
    expect(pick([candle('BATUSDT', '5m', close), candle('BATUSDT', '15m', close)])).toEqual(['BATUSDT 5m', 'BATUSDT 15m']);
  });

  it('skips other timeframes, coins outside the scanner (watchlist, charts) and coins already held', () => {
    expect(pick([candle('BATUSDT', '1m', close), candle('BATUSDT', '1h', close)])).toEqual([]);
    expect(pick([candle('DODOXUSDT', '5m', close)])).toEqual([]);
    expect(pick([candle('BATUSDT', '5m', close)], ['BATUSDT'])).toEqual([]);
  });

  it('never acts on a candle replayed after a restart or fetched while the feed catches up', () => {
    // CT on 13 October: a 03:15 candle handed on at 07:00 when the engine came back.
    expect(pick([candle('CTUSDT', '15m', Date.parse('2026-10-13T03:15Z'))])).toEqual([]);
    expect(pick([candle('CTUSDT', '5m', now - (config.max_signal_age_sec + 1) * 1000)])).toEqual([]);
  });
});

describe('settledPrices', () => {
  const minute = 60_000;
  const prices = { SAFEUSDT: 0.12718, BATUSDT: 0.18 };

  it('lets no live price act while the engine is behind (restarted, feed still catching up)', () => {
    // SAFE on 13 October: the engine had been down since 19:45; its clock still said so at 07:02.
    const engineClock = Date.parse('2026-10-12T19:45Z');
    expect(settledPrices(prices, { engineClock, lastMinuteClose: () => Date.parse('2026-10-13T07:02Z'), now: Date.parse('2026-10-13T07:02:43Z') })).toEqual({});
  });

  it('once caught up, lets a coin act only when its own 1m candles are processed and recent', () => {
    const engineClock = now - 4_000;
    const lastMinuteClose = (s: string) => (s === 'BATUSDT' ? engineClock : s === 'SAFEUSDT' ? engineClock - 10 * minute : null);
    expect(settledPrices({ ...prices, XUSDT: 1 }, { engineClock, lastMinuteClose, now })).toEqual({ BATUSDT: 0.18 });
  });

  it('waits for a stored candle the engine has not processed yet', () => {
    const engineClock = now - 64_000;
    expect(settledPrices(prices, { engineClock, lastMinuteClose: () => now - 4_000, now })).toEqual({});
  });
});

describe('hunterOnAtStart', () => {
  it('keeps the choice saved from the dashboard across restarts, whatever the config says', () => {
    expect(hunterOnAtStart('true', false)).toBe(true);
    expect(hunterOnAtStart('false', true)).toBe(false);
  });

  it('uses the config only before any choice has been saved', () => {
    expect(hunterOnAtStart(null, false)).toBe(false);
    expect(hunterOnAtStart(null, true)).toBe(true);
  });
});
