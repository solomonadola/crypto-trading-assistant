import { describe, expect, it } from 'vitest';
import { SessionCalendar, localToUtc } from '../src/sessions';
import { loadConfig, type EngineConfig } from '../src/config';

const base = loadConfig('engine/config/config.yaml').sessions;
const cal = (over: Partial<EngineConfig['sessions']> = {}) => new SessionCalendar({ ...base, ...over });
const u = (iso: string) => Date.parse(iso);
const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString().slice(0, 16) + 'Z');

/** "name open-close" in UTC for the owning session at a time. */
function owner(c: SessionCalendar, at: string): string | null {
  const o = c.ownerAt(u(at));
  return o && `${o.name} ${iso(o.openTime)!.slice(11)}-${iso(o.closeTime)!.slice(11)}`;
}

describe('session hours in UTC through the year', () => {
  it('summer: Asian 00-09, London 07-16, New York 12-21', () => {
    const c = cal();
    expect(owner(c, '2026-07-15T02:00Z')).toBe('asian 00:00Z-09:00Z');
    expect(owner(c, '2026-07-15T08:00Z')).toBe('london 07:00Z-16:00Z');
    expect(owner(c, '2026-07-15T13:00Z')).toBe('newyork 12:00Z-21:00Z');
    expect(owner(c, '2026-07-15T22:30Z')).toBeNull();
  });

  it('winter: London 08-17, New York 13-22', () => {
    const c = cal();
    expect(owner(c, '2026-01-15T07:30Z')).toBe('asian 00:00Z-09:00Z');
    expect(owner(c, '2026-01-15T12:30Z')).toBe('london 08:00Z-17:00Z');
    expect(owner(c, '2026-01-15T21:30Z')).toBe('newyork 13:00Z-22:00Z');
    expect(owner(c, '2026-01-15T22:30Z')).toBeNull();
  });

  it('the weeks when only the US has changed clocks: London 08-17, New York 12-21', () => {
    const c = cal();
    for (const day of ['2026-03-16', '2026-10-27']) {
      expect(owner(c, `${day}T10:00Z`)).toBe('london 08:00Z-17:00Z');
      expect(owner(c, `${day}T12:30Z`)).toBe('newyork 12:00Z-21:00Z');
    }
  });

  it('London DST weekends: the same UTC time belongs to a different session', () => {
    const c = cal();
    // Saturday 28 March: London still on GMT, opens 08:00 UTC.
    expect(owner(c, '2026-03-28T07:30Z')).toBe('asian 00:00Z-09:00Z');
    // Sunday 29 March: clocks went forward at 01:00 UTC, London opens 07:00 UTC.
    expect(owner(c, '2026-03-29T07:30Z')).toBe('london 07:00Z-16:00Z');
    // Saturday 24 October: still BST.
    expect(owner(c, '2026-10-24T07:30Z')).toBe('london 07:00Z-16:00Z');
    // Sunday 25 October: back to GMT.
    expect(owner(c, '2026-10-25T07:30Z')).toBe('asian 00:00Z-09:00Z');
  });

  it('converts local times across DST changes', () => {
    expect(iso(localToUtc(2026, 3, 29, 8, 0, 'Europe/London'))).toBe('2026-03-29T07:00Z');
    expect(iso(localToUtc(2026, 3, 8, 8, 0, 'America/New_York'))).toBe('2026-03-08T12:00Z');
    expect(iso(localToUtc(2026, 11, 1, 8, 0, 'America/New_York'))).toBe('2026-11-01T13:00Z');
    expect(iso(localToUtc(2026, 7, 15, 9, 0, 'Asia/Tokyo'))).toBe('2026-07-15T00:00Z');
  });

  it('a trade in the London/New York overlap belongs to New York', () => {
    const c = cal();
    expect(c.activeAt(u('2026-07-15T14:00Z')).map((s) => s.name)).toEqual(['london', 'newyork']);
    expect(c.ownerAt(u('2026-07-15T14:00Z'))!.name).toBe('newyork');
  });

  it('knows the next session outside hours', () => {
    const next = cal().nextAfter(u('2026-07-15T22:30Z'))!;
    expect(next.name).toBe('asian');
    expect(iso(next.openTime)).toBe('2026-07-16T00:00Z');
  });

  it('supports a session that closes after midnight', () => {
    const c = cal({ list: [{ name: 'late', tz: 'UTC', open: '22:00', close: '02:00' }] });
    expect(owner(c, '2026-07-15T01:00Z')).toBe('late 22:00Z-02:00Z');
    expect(c.ownerAt(u('2026-07-15T01:00Z'))!.localDate).toBe('2026-07-14');
    expect(owner(c, '2026-07-15T02:00Z')).toBeNull();
  });

  it('weekends are sessions like any other day by default', () => {
    expect(owner(cal(), '2026-09-26T13:00Z')).toBe('newyork 12:00Z-21:00Z');
  });
});

describe('entry window', () => {
  const block = (at: string, over: Partial<EngineConfig['sessions']> = {}) => cal(over).entryBlock(u(at));

  it('open inside a session away from its end and from funding', () => {
    expect(block('2026-07-15T02:00Z')).toBeNull();
    expect(block('2026-07-15T13:00Z')).toBeNull();
    // Asian's last hour, but London owns this time and closes at 16:00.
    expect(block('2026-07-15T08:30Z')).toBeNull();
  });

  it('closed outside sessions', () => {
    expect(block('2026-07-15T21:30Z')).toBe('outside_sessions');
  });

  it('closed in the last 60 minutes of the owning session', () => {
    expect(block('2026-07-15T19:59Z')).toBeNull();
    expect(block('2026-07-15T20:00Z')).toBe('session_ending');
    expect(block('2026-07-15T20:59Z')).toBe('session_ending');
    expect(block('2026-01-15T21:30Z')).toBe('session_ending');
  });

  it('closed within 10 minutes of a funding time', () => {
    expect(block('2026-07-15T00:05Z')).toBe('funding_window');
    expect(block('2026-07-15T07:55Z')).toBe('funding_window');
    expect(block('2026-07-15T08:09Z')).toBe('funding_window');
    expect(block('2026-07-15T08:10Z')).toBeNull();
    expect(block('2026-07-15T15:51Z')).toBe('funding_window');
  });

  it('entry delay after a session opens, when configured', () => {
    expect(block('2026-07-15T07:10Z', { entry_delay_min: 15 })).toBe('session_opening');
    expect(block('2026-07-15T07:15Z', { entry_delay_min: 15 })).toBeNull();
  });

  it('weekdays only, when configured, uses the session\'s own local day', () => {
    expect(block('2026-09-26T13:00Z', { weekdays_only: true })).toBe('weekend');
    // Monday 00:30 UTC is Monday 09:30 in Tokyo.
    expect(block('2026-09-28T00:30Z', { weekdays_only: true })).toBeNull();
    // Sunday 23:30 UTC: no session open yet.
    expect(block('2026-09-27T23:30Z', { weekdays_only: true })).toBe('outside_sessions');
  });

  it('sessions switched off: always open, no owner', () => {
    const c = cal({ enabled: false });
    expect(c.entryBlock(u('2026-07-15T22:30Z'))).toBeNull();
    expect(c.ownerAt(u('2026-07-15T13:00Z'))).toBeNull();
  });
});

describe('sessions in a period', () => {
  it('lists every session overlapping a UTC day, including one that opened the day before', () => {
    const c = cal({ list: [...base.list, { name: 'late', tz: 'UTC', open: '22:00', close: '02:00' }] });
    const day = c.between(u('2026-07-15T00:00Z'), u('2026-07-16T00:00Z'));
    expect(day.map((s) => `${s.name} ${iso(s.openTime)}`)).toEqual([
      'late 2026-07-14T22:00Z', 'asian 2026-07-15T00:00Z', 'london 2026-07-15T07:00Z', 'newyork 2026-07-15T12:00Z', 'late 2026-07-15T22:00Z',
    ]);
  });
});
