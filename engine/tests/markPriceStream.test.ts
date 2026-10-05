import { describe, expect, it, vi } from 'vitest';
import { MarkPriceStream } from '../src/feed/markPriceStream';

/** A WebSocket the test drives: it records each connection made. */
function fakeSockets() {
  const made: { url: string; s: { onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null; close: () => void } }[] = [];
  const connect = (url: string) => {
    const s = { onopen: null, onmessage: null, onclose: null, onerror: null, close: () => s.onclose?.({}) } as (typeof made)[number]['s'];
    made.push({ url, s });
    return s;
  };
  return { made, connect };
}

const update = (s: string, p: string, r = '0.0001') => ({ e: 'markPriceUpdate', E: 1, s, p, ap: p, P: p, i: p, r, T: 2 });

describe('mark price stream', () => {
  it('keeps the latest mark price and funding per coin from the update messages', () => {
    const clock = { now: 1_000_000 };
    const { made, connect } = fakeSockets();
    const stream = new MarkPriceStream({ url: 'wss://x/market/ws/!markPrice@arr@1s', connect, now: () => clock.now, log: () => {} });
    stream.start();
    expect(made[0].url).toBe('wss://x/market/ws/!markPrice@arr@1s');
    // Each message holds only the coins that changed.
    made[0].s.onmessage?.({ data: JSON.stringify([update('BTCUSDT', '85512.6'), update('ETHUSDT', '2716.1', '-0.0002')]) });
    made[0].s.onmessage?.({ data: JSON.stringify([update('BTCUSDT', '85520.0')]) });
    expect(stream.prices(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])).toEqual({ BTCUSDT: 85520, ETHUSDT: 2716.1 });
    expect(stream.funding('ETHUSDT')).toBe(-0.0002);
    made[0].s.onmessage?.({ data: 'not json' });   // ignored
    expect(stream.price('BTCUSDT')).toBe(85520);
  });

  it('gives no price once it is 15 seconds old, so callers fall back to REST', () => {
    const clock = { now: 1_000_000 };
    const { made, connect } = fakeSockets();
    const stream = new MarkPriceStream({ url: 'u', connect, now: () => clock.now, log: () => {} });
    stream.start();
    made[0].s.onmessage?.({ data: JSON.stringify([update('BTCUSDT', '100')]) });
    clock.now += 16_000;
    expect(stream.price('BTCUSDT')).toBeNull();
    expect(stream.prices(['BTCUSDT'])).toEqual({});
  });

  it('reconnects after the connection drops, waiting longer each time, and not after stop', () => {
    vi.useFakeTimers();
    try {
      const { made, connect } = fakeSockets();
      const stream = new MarkPriceStream({ url: 'u', connect, log: () => {} });
      stream.start();
      made[0].s.onclose?.({});
      vi.advanceTimersByTime(1000);
      expect(made).toHaveLength(2);
      made[1].s.onclose?.({});
      vi.advanceTimersByTime(1999);
      expect(made).toHaveLength(2);       // the second wait is 2 s
      vi.advanceTimersByTime(1);
      expect(made).toHaveLength(3);
      stream.stop();
      vi.advanceTimersByTime(120_000);
      expect(made).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
