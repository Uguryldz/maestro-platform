import { describe, expect, it } from "vitest";
import {
  BusinessCalendar,
  addWorkingMinutes,
  isoWeekday,
  localDate,
  workingMinutesBetween,
} from "../src/calendar.js";

/** Istanbul: UTC+3 all year, Mon–Fri, 09:00–18:00 (9 working hours a day). */
const IST = BusinessCalendar.parse({});
const at = (iso: string): number => Date.parse(iso);

describe("business calendar (M88)", () => {
  it("maps epoch days to ISO weekdays", () => {
    expect(isoWeekday(0)).toBe(4); // 1970-01-01 was a Thursday
    expect(localDate(0)).toBe("1970-01-01");
    expect(isoWeekday(3)).toBe(7); // Sunday
  });

  it("counts only the hours inside the working window", () => {
    // Wed 10:00 -> Wed 17:00 local = 7h.
    expect(workingMinutesBetween(at("2026-08-05T07:00:00Z"), at("2026-08-05T14:00:00Z"), IST)).toBe(420);
  });

  it("ignores evenings: 17:00 Wed -> 10:00 Thu is 2 working hours", () => {
    expect(workingMinutesBetween(at("2026-08-05T14:00:00Z"), at("2026-08-06T07:00:00Z"), IST)).toBe(120);
  });

  it("skips the weekend entirely", () => {
    // Fri 17:00 -> Mon 10:00 local: 1h Friday + 1h Monday.
    expect(workingMinutesBetween(at("2026-08-07T14:00:00Z"), at("2026-08-10T07:00:00Z"), IST)).toBe(120);
  });

  it("skips a configured holiday", () => {
    const cal = BusinessCalendar.parse({ holidays: ["2026-08-06"] });
    expect(workingMinutesBetween(at("2026-08-05T14:00:00Z"), at("2026-08-06T14:00:00Z"), cal)).toBe(60);
  });

  it("addWorkingMinutes is the exact inverse of workingMinutesBetween", () => {
    const from = at("2026-08-07T14:30:00Z"); // Friday 17:30 local
    for (const minutes of [30, 60, 240, 540, 1_000, 5_000]) {
      const to = addWorkingMinutes(from, minutes, IST);
      expect(workingMinutesBetween(from, to, IST)).toBe(minutes);
    }
  });

  it("lands 24 working hours after a Friday evening on Wednesday morning", () => {
    // Fri 17:30 -> 0:30 Fri + 9h Mon + 9h Tue + 5:30 Wed = Wed 14:30 local.
    const due = addWorkingMinutes(at("2026-08-07T14:30:00Z"), 24 * 60, IST);
    expect(new Date(due).toISOString()).toBe("2026-08-12T11:30:00.000Z");
  });

  it("supports a non-default week (Sunday–Thursday, 08:00–16:00)", () => {
    const cal = BusinessCalendar.parse({ workdays: [7, 1, 2, 3, 4], startMinute: 480, endMinute: 960 });
    // Thu 15:00 local -> Sun 09:00 local: 1h Thursday + 1h Sunday.
    expect(workingMinutesBetween(at("2026-08-06T12:00:00Z"), at("2026-08-09T06:00:00Z"), cal)).toBe(120);
  });

  it("refuses a calendar whose working day ends before it starts", () => {
    expect(() => BusinessCalendar.parse({ startMinute: 600, endMinute: 540 })).toThrow();
  });

  it("throws instead of looping forever when a threshold is unreachable", () => {
    const cal = BusinessCalendar.parse({ workdays: [6], startMinute: 540, endMinute: 541 });
    expect(() => addWorkingMinutes(at("2026-08-05T07:00:00Z"), 100_000, cal)).toThrow(/unreachable/);
  });
});
