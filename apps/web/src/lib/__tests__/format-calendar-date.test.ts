import { describe, expect, it } from "vitest";

import { fmtCalendarDateShort } from "../format";

const intlFmt = (locale: string) => ({
  dateTime: (date: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options).format(date),
});

describe("fmtCalendarDateShort", () => {
  it("formats a calendar date as a short date in the viewer's locale", () => {
    expect(fmtCalendarDateShort(intlFmt("en-US"), "2026-10-12")).toBe(
      "Oct 12, 2026",
    );
    expect(fmtCalendarDateShort(intlFmt("es"), "2026-10-12")).toBe(
      "12 oct 2026",
    );
  });

  it("passes UTC noon and timeZone UTC, so no viewer zone moves the day", () => {
    const calls: Array<{ date: Date; options: Intl.DateTimeFormatOptions }> =
      [];
    fmtCalendarDateShort(
      {
        dateTime: (date, options) => {
          calls.push({ date, options });
          return "";
        },
      },
      "2026-10-12",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.date.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    expect(calls[0]!.options.timeZone).toBe("UTC");
    // Why the pin matters: the same instant read in UTC+14 is already the
    // 13th. Unpinned, a viewer there would be told the wrong day.
    expect(
      new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        timeZone: "Pacific/Kiritimati",
      }).format(calls[0]!.date),
    ).toBe("13");
  });

  it("returns null for a malformed or rolled-over date instead of guessing", () => {
    const fmt = intlFmt("en-US");
    expect(fmtCalendarDateShort(fmt, "")).toBeNull();
    expect(fmtCalendarDateShort(fmt, "2026-10-12T00:00:00Z")).toBeNull();
    expect(fmtCalendarDateShort(fmt, "2026-02-31")).toBeNull();
  });
});
