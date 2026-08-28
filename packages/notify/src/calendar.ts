import { z } from "zod";
import { NotifyConfigError } from "./errors.js";

/**
 * Working-time calendar for the escalation ladder (M88). Every field is a
 * Studio parameter; nothing about the bank's week is compiled in.
 *
 * The offset is a FIXED number of minutes rather than an IANA zone name on
 * purpose: Türkiye has been permanently UTC+3 since 2016, and a fixed offset
 * keeps the maths exact, dependency-free and reproducible on any host,
 * whatever `TZ` the container happens to have.
 */
export const BusinessCalendar = z
  .object({
    utcOffsetMinutes: z.number().int().min(-840).max(840).default(180),
    /** ISO weekday numbers that count as working days: 1 = Monday … 7 = Sunday. */
    workdays: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
    /** Minutes after local midnight. */
    startMinute: z.number().int().min(0).max(1_440).default(9 * 60),
    endMinute: z.number().int().min(0).max(1_440).default(18 * 60),
    /** Local YYYY-MM-DD dates that never count, whatever the weekday. */
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  })
  .refine((cal) => cal.endMinute > cal.startMinute, {
    message: "endMinute must be after startMinute",
  });
export type BusinessCalendar = z.infer<typeof BusinessCalendar>;

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1_440;
/** ~10 years of days; a threshold that cannot be reached is a config error. */
const MAX_DAYS = 3_660;

interface LocalPoint {
  /** Days since the epoch in LOCAL time. */
  day: number;
  /** Minutes after local midnight. */
  minute: number;
}

function toLocal(instantMs: number, cal: BusinessCalendar): LocalPoint {
  const localMinutes = Math.floor(instantMs / MINUTE_MS) + cal.utcOffsetMinutes;
  const day = Math.floor(localMinutes / DAY_MINUTES);
  return { day, minute: localMinutes - day * DAY_MINUTES };
}

function toInstant(point: LocalPoint, cal: BusinessCalendar): number {
  return (point.day * DAY_MINUTES + point.minute - cal.utcOffsetMinutes) * MINUTE_MS;
}

/** 1970-01-01 was a Thursday (ISO weekday 4). */
export function isoWeekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

export function localDate(day: number): string {
  return new Date(day * DAY_MINUTES * MINUTE_MS).toISOString().slice(0, 10);
}

function isWorkingDay(day: number, cal: BusinessCalendar): boolean {
  return cal.workdays.includes(isoWeekday(day)) && !cal.holidays.includes(localDate(day));
}

/**
 * Working minutes between two instants. Time outside the working window — and
 * whole weekends and holidays — simply does not count, which is what "24
 * business hours" has to mean for a gate opened at 17:55 on a Friday.
 */
export function workingMinutesBetween(fromMs: number, toMs: number, cal: BusinessCalendar): number {
  if (toMs <= fromMs) return 0;
  const from = toLocal(fromMs, cal);
  const to = toLocal(toMs, cal);
  if (to.day - from.day > MAX_DAYS) {
    throw new NotifyConfigError(`escalation window spans more than ${MAX_DAYS} days — check openedAt/now`);
  }
  let total = 0;
  for (let day = from.day; day <= to.day; day += 1) {
    if (!isWorkingDay(day, cal)) continue;
    const windowStart = Math.max(cal.startMinute, day === from.day ? from.minute : 0);
    const windowEnd = Math.min(cal.endMinute, day === to.day ? to.minute : DAY_MINUTES);
    if (windowEnd > windowStart) total += windowEnd - windowStart;
  }
  return total;
}

/**
 * The inverse: the instant at which `minutes` of working time have elapsed.
 * Used to tell a Temporal timer exactly when the next ladder step is due.
 */
export function addWorkingMinutes(fromMs: number, minutes: number, cal: BusinessCalendar): number {
  if (minutes <= 0) return fromMs;
  const from = toLocal(fromMs, cal);
  let remaining = minutes;

  for (let offset = 0; offset <= MAX_DAYS; offset += 1) {
    const day = from.day + offset;
    if (!isWorkingDay(day, cal)) continue;
    const windowStart = Math.max(cal.startMinute, offset === 0 ? from.minute : 0);
    const available = cal.endMinute - windowStart;
    if (available <= 0) continue;
    if (remaining <= available) return toInstant({ day, minute: windowStart + remaining }, cal);
    remaining -= available;
  }

  throw new NotifyConfigError(
    `escalation threshold of ${minutes} working minute(s) is unreachable within ${MAX_DAYS} days — check the calendar`,
  );
}
