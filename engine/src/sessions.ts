// Trading sessions (ENGINE_PLAN.md Section 5). Sessions are defined in local
// time in their own time zone, so daylight-saving changes move them in UTC
// automatically. Pure: every answer is for a time passed in, never "now".
import type { EngineConfig } from './config';

export interface SessionDef {
  name: string;
  tz: string;
  open: string;   // "HH:MM" local
  close: string;  // "HH:MM" local; at or before `open` means it closes the next day
}

/** One occurrence of a session, in UTC milliseconds. Open at openTime, closed from closeTime. */
export interface SessionInstance {
  name: string;
  openTime: number;
  closeTime: number;
  /** Local date the session opened on, YYYY-MM-DD in its own time zone. */
  localDate: string;
}

export type EntryBlock =
  | 'outside_sessions'   // no session open
  | 'session_opening'    // inside entry_delay_min after the owning session opened
  | 'session_ending'     // inside no_entry_before_end_min before the owning session closes
  | 'funding_window'     // within skip_minutes_around_funding of 00:00, 08:00 or 16:00 UTC
  | 'weekend';           // weekdays_only and the owning session's local day is Saturday or Sunday

export interface SessionInfo {
  time: number;
  /** Sessions open at `time`, oldest first. */
  active: SessionInstance[];
  /** The most recently opened active session: the one a trade entered now belongs to. */
  owner: SessionInstance | null;
  /** Why a new trade may not open now, or null if it may. */
  entryBlock: EntryBlock | null;
  /** The next session to open after `time`. */
  next: SessionInstance | null;
}

const FUNDING_EVERY = 8 * 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Local calendar fields of instant `t` in `tz`. */
function localParts(t: number, tz: string) {
  const p: Record<string, number> = {};
  for (const x of formatter(tz).formatToParts(t)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute, ss: p.second };
}

/** Offset of `tz` from UTC at instant `t`, ms (London in summer: +3 600 000). */
function offsetAt(t: number, tz: string): number {
  const p = localParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(t / 1000) * 1000;
}

/** UTC instant of a local wall-clock time in `tz`. */
export function localToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  const first = asUtc - offsetAt(asUtc, tz);
  // Re-read the offset at the answer: correct when a DST change falls between the guess and the answer.
  return asUtc - offsetAt(first, tz);
}

const hhmm = (s: string) => s.split(':').map(Number) as [number, number];
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export class SessionCalendar {
  private readonly defs: SessionDef[];

  constructor(private readonly cfg: EngineConfig['sessions']) {
    this.defs = cfg.list;
  }

  /** The instance of `def` that opens on the local date `dayShift` days from the local date of `t`. */
  private instance(def: SessionDef, t: number, dayShift: number): SessionInstance {
    const base = localParts(t, def.tz);
    const day = new Date(Date.UTC(base.y, base.m - 1, base.d + dayShift));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const [oh, om] = hhmm(def.open);
    const [ch, cm] = hhmm(def.close);
    const openTime = localToUtc(y, m, d, oh, om, def.tz);
    const closesNextDay = ch * 60 + cm <= oh * 60 + om;
    const closeDay = new Date(Date.UTC(y, m - 1, d + (closesNextDay ? 1 : 0)));
    const closeTime = localToUtc(closeDay.getUTCFullYear(), closeDay.getUTCMonth() + 1, closeDay.getUTCDate(), ch, cm, def.tz);
    return { name: def.name, openTime, closeTime, localDate: ymd(y, m, d) };
  }

  private candidates(t: number, shifts: number[]): SessionInstance[] {
    return this.defs.flatMap((def) => shifts.map((s) => this.instance(def, t, s)));
  }

  /** Every session instance that overlaps [from, to), by open time. */
  between(from: number, to: number): SessionInstance[] {
    const days = Math.ceil((to - from) / 86_400_000) + 1;
    const shifts = Array.from({ length: days + 2 }, (_, i) => i - 1);
    const seen = new Set<string>();
    return this.candidates(from, shifts)
      .filter((s) => s.openTime < to && s.closeTime > from)
      .filter((s) => { const k = `${s.name}|${s.openTime}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.openTime - b.openTime);
  }

  /** Sessions open at `t` (openTime <= t < closeTime), oldest first. */
  activeAt(t: number): SessionInstance[] {
    return this.candidates(t, [-1, 0])
      .filter((s) => s.openTime <= t && t < s.closeTime)
      .sort((a, b) => a.openTime - b.openTime);
  }

  /** The session a trade entered at `t` belongs to: the most recently opened one. Null outside sessions or with sessions off. */
  ownerAt(t: number): SessionInstance | null {
    if (!this.cfg.enabled) return null;
    const active = this.activeAt(t);
    return active.length ? active[active.length - 1] : null;
  }

  nextAfter(t: number): SessionInstance | null {
    const upcoming = this.candidates(t, [0, 1, 2]).filter((s) => s.openTime > t).sort((a, b) => a.openTime - b.openTime);
    return upcoming[0] ?? null;
  }

  /** Why a new trade may not open at `t`, or null if it may. */
  entryBlock(t: number): EntryBlock | null {
    if (!this.cfg.enabled) return null;
    const owner = this.ownerAt(t);
    if (!owner) return 'outside_sessions';
    if (this.cfg.weekdays_only) {
      const [y, m, d] = owner.localDate.split('-').map(Number);
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      if (weekday === 0 || weekday === 6) return 'weekend';
    }
    if (t < owner.openTime + this.cfg.entry_delay_min * 60_000) return 'session_opening';
    if (t >= owner.closeTime - this.cfg.no_entry_before_end_min * 60_000) return 'session_ending';
    const sinceFunding = ((t % FUNDING_EVERY) + FUNDING_EVERY) % FUNDING_EVERY;
    const toFunding = Math.min(sinceFunding, FUNDING_EVERY - sinceFunding);
    if (toFunding < this.cfg.skip_minutes_around_funding * 60_000) return 'funding_window';
    return null;
  }

  info(t: number): SessionInfo {
    return {
      time: t,
      active: this.activeAt(t),
      owner: this.ownerAt(t),
      entryBlock: this.entryBlock(t),
      next: this.nextAfter(t),
    };
  }
}
