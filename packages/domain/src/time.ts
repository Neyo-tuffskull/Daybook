/**
 * Time and calendar-day helpers.
 *
 * Rule for the whole codebase: the user's IANA timezone from their profile is
 * the only timezone that exists. The browser's zone is never consulted, because
 * a planner that silently reinterprets your history when you travel is worse
 * than useless. Every "which day is this" question goes through dayKey.
 */

/** A calendar date with no time and no zone, as YYYY-MM-DD. */
export type DayKey = string;

export interface DayKeyOptions {
  /**
   * The hour a logical day begins, as HH:MM. An activity at 01:00 belongs to
   * the previous day for someone whose day starts at 04:00. Stored per user in
   * user_preferences.analytics_start_of_day.
   */
  startOfDay?: string;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsCache.get(timeZone);
  if (!formatter) {
    // Constructing a DateTimeFormat is expensive relative to using one, and the
    // materialiser builds tens of thousands of occurrences in a single job.
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    partsCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws on an unknown zone rather than silently falling back to UTC. */
export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
  } catch {
    throw new RangeError(`Unknown IANA timezone: ${timeZone}`);
  }
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`Missing ${type} while formatting for ${timeZone}`);
    return Number(found.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

function parseHhMm(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Expected HH:MM, received: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new RangeError(`Not a valid time: ${value}`);
  return hours * 60 + minutes;
}

function toIsoDate(year: number, month: number, day: number): DayKey {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * The logical day an instant belongs to, for a given user.
 *
 * Uses UTC arithmetic on the already-localised calendar date, so the
 * "previous day" shift cannot be knocked off by a daylight-saving transition.
 */
export function dayKey(instant: Date, timeZone: string, options: DayKeyOptions = {}): DayKey {
  const { year, month, day, hour, minute } = localParts(instant, timeZone);
  const cutoff = parseHhMm(options.startOfDay ?? '00:00');

  if (hour * 60 + minute >= cutoff) {
    return toIsoDate(year, month, day);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return toIsoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Whole minutes from a to b, negative when b precedes a. */
export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

/** Inclusive list of calendar days, used for streaks and analytics ranges. */
export function eachDay(from: DayKey, to: DayKey): DayKey[] {
  const days: DayKey[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    throw new RangeError(`Expected YYYY-MM-DD bounds, received ${from} and ${to}`);
  }
  while (cursor <= end) {
    days.push(toIsoDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
