import { describe, expect, it } from "vitest";

import { formatAskWindow } from "../ask-window-label";

// What `useFormatters().dateTime` is: Intl with no default zone.
const dateTime = (
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
) => new Intl.DateTimeFormat("en-US", options).format(new Date(value));
const fmt = { locale: "en-US", dateTime };
// ICU spaces AM/PM with U+202F and the range dash with U+2009; folded to plain
// spaces so the expectations stay readable.
const plain = (label: string | null) =>
  label?.replace(/[\u202f\u2009]/g, " ") ?? null;
const t = (key: string, values?: Record<string, string>) =>
  `${key}:${values?.date ?? ""}`;

describe("formatAskWindow", () => {
  it("prints a same-day zoned window's date and zone once", () => {
    const label = formatAskWindow(fmt, t, {
      startsAt: "2026-10-24T22:00:00.000Z",
      endsAt: "2026-10-25T02:00:00.000Z",
      timezone: "America/New_York",
    });
    expect(plain(label)).toBe("Oct 24, 2026, 6:00 – 10:00 PM EDT");
  });

  it("prints both dates when the window crosses days, in the ask's zone", () => {
    // 22:00Z → 04:30 next day in Kolkata (UTC+5:30): the half-hour offset
    // shows the zone, not the host's, did the formatting.
    const label = formatAskWindow(fmt, t, {
      startsAt: "2026-10-24T12:30:00.000Z",
      endsAt: "2026-10-24T23:00:00.000Z",
      timezone: "Asia/Kolkata",
    });
    expect(plain(label)).toBe(
      "Oct 24, 2026, 6:00 PM GMT+5:30 – Oct 25, 2026, 4:30 AM GMT+5:30",
    );
  });

  it("names the zone on a start-only window", () => {
    const label = formatAskWindow(fmt, t, {
      startsAt: "2026-10-24T23:00:00.000Z",
      endsAt: null,
      timezone: "America/Chicago",
    });
    expect(plain(label)).toBe(
      "volunteering.askWindowFrom:Oct 24, 2026, 6:00 PM CDT",
    );
  });

  it("names the zone on an end-only window", () => {
    const label = formatAskWindow(fmt, t, {
      startsAt: null,
      endsAt: "2026-10-24T23:00:00.000Z",
      timezone: "America/Chicago",
    });
    expect(plain(label)).toBe(
      "volunteering.askWindowUntil:Oct 24, 2026, 6:00 PM CDT",
    );
  });

  it("keeps the date-only rendering for an ask with no zone", () => {
    const starts = new Date("2026-10-24T22:00:00.000Z");
    const ends = new Date("2026-10-25T02:00:00.000Z");
    const label = formatAskWindow(fmt, t, {
      startsAt: starts,
      endsAt: ends,
      timezone: null,
    });
    expect(label).toBe(`${dateTime(starts)} → ${dateTime(ends)}`);
  });

  it("falls back to the date-only rendering when the zone is unreadable", () => {
    const starts = new Date("2026-10-24T22:00:00.000Z");
    expect(
      formatAskWindow(fmt, t, {
        startsAt: starts,
        endsAt: null,
        timezone: "Not/AZone",
      }),
    ).toBe(`volunteering.askWindowFrom:${dateTime(starts)}`);
  });

  it("is null with no window, and ignores an unparseable date", () => {
    expect(
      formatAskWindow(fmt, t, {
        startsAt: null,
        endsAt: null,
        timezone: "America/Chicago",
      }),
    ).toBeNull();
    expect(
      formatAskWindow(fmt, t, {
        startsAt: "not a date",
        endsAt: null,
        timezone: null,
      }),
    ).toBeNull();
  });
});
