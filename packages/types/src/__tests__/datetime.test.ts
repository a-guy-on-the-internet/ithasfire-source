import { describe, expect, it } from "vitest";

import {
  formatDateTime,
  formatDateTimeAs,
  parseDateTime,
  toVenueLocalDate,
} from "../datetime";

const CHICAGO = "America/Chicago";
const LISBON = "Europe/Lisbon";

describe("parseDateTime", () => {
  it("keeps a date-only string on its own day", () => {
    // The bug this exists to stop: `new Date("2026-08-19")` is UTC midnight per
    // spec, which is Aug 18 in every timezone west of Greenwich — i.e. every
    // user this product currently has.
    //
    // Asserted through an explicit zone rather than getFullYear/getMonth/
    // getDate, which read the HOST's clock: those passed in Chicago and failed
    // on a UTC runner, which is the whole class of bug this function exists to
    // remove. A date-only value must land on its own day no matter where the
    // process happens to be running.
    const parsed = parseDateTime("2026-08-19");
    for (const timeZone of [
      "America/Chicago",
      "UTC",
      "Europe/London",
      "Asia/Tokyo",
    ]) {
      expect(
        new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(parsed),
      ).toBe("2026-08-19");
    }
  });

  it("passes a full timestamp through as the instant it is", () => {
    const iso = "2026-08-19T20:00:00.000Z";
    expect(parseDateTime(iso).toISOString()).toBe(iso);
  });

  it("accepts Date and epoch-millis unchanged", () => {
    const date = new Date("2026-08-19T20:00:00Z");
    expect(parseDateTime(date)).toBe(date);
    expect(parseDateTime(date.getTime()).toISOString()).toBe(
      date.toISOString(),
    );
  });
});

describe("formatDateTimeAs", () => {
  // 8pm Central on Aug 19 2026 (CDT, UTC-5).
  const showtime = "2026-08-20T01:00:00.000Z";

  it("renders the venue's wall-clock time, not the reader's", () => {
    // The same instant, formatted for the same venue, must produce the same
    // string regardless of where the code runs. This is the whole rule.
    expect(formatDateTimeAs(showtime, "time", { timeZone: CHICAGO })).toBe(
      "8:00 PM",
    );
    // And a different venue zone gives that venue's clock — not the viewer's.
    expect(formatDateTimeAs(showtime, "time", { timeZone: LISBON })).toBe(
      "2:00 AM",
    );
  });

  it("does not roll the date backwards for a late show", () => {
    // 8pm Central is already tomorrow in UTC. Formatting the date in the venue
    // zone has to give Aug 19, not Aug 20.
    expect(formatDateTimeAs(showtime, "date", { timeZone: CHICAGO })).toBe(
      "Aug 19, 2026",
    );
  });

  it("zero-pads the numeric and day formats", () => {
    expect(
      formatDateTimeAs("2026-08-05", "dateNumeric", { timeZone: CHICAGO }),
    ).toBe("08/05/2026");
    expect(formatDateTimeAs("2026-08-05", "day", { timeZone: CHICAGO })).toBe(
      "05",
    );
  });

  it("joins the meta idiom with a middot", () => {
    expect(formatDateTimeAs(showtime, "meta", { timeZone: CHICAGO })).toBe(
      "Wed, Aug 19 · 8:00 PM",
    );
  });

  it("appends the zone abbreviation only where a clock time exists", () => {
    expect(
      formatDateTimeAs(showtime, "time", {
        timeZone: CHICAGO,
        showTimeZone: true,
      }),
    ).toContain("CDT");
    // A bare date has no time to qualify, so the flag must not smuggle a zone in.
    expect(
      formatDateTimeAs(showtime, "date", {
        timeZone: CHICAGO,
        showTimeZone: true,
      }),
    ).not.toMatch(/CDT|CST/);
  });

  it("returns an empty string rather than 'Invalid Date'", () => {
    // "Invalid Date" printed on a ticket looks like a system broken in a much
    // more alarming way than one blank field.
    expect(formatDateTimeAs("not a date", "date", { timeZone: CHICAGO })).toBe(
      "",
    );
  });

  it("formatDateTime is the datetime shorthand", () => {
    expect(formatDateTime(showtime, { timeZone: CHICAGO })).toBe(
      formatDateTimeAs(showtime, "datetime", { timeZone: CHICAGO }),
    );
  });
});

describe("toVenueLocalDate", () => {
  it("answers 'which day is this event on' in the venue's zone", () => {
    // 8pm Central = 01:00 UTC the next day. Slicing the ISO string would say
    // the 20th; the venue says the 19th, and the venue is right.
    expect(toVenueLocalDate("2026-08-20T01:00:00.000Z", CHICAGO)).toBe(
      "2026-08-19",
    );
    expect("2026-08-20T01:00:00.000Z".slice(0, 10)).toBe("2026-08-20");
  });

  it("is stable for a date-only input", () => {
    expect(toVenueLocalDate("2026-08-19", CHICAGO)).toBe("2026-08-19");
  });

  it("returns an empty string for an unparseable value", () => {
    expect(toVenueLocalDate("nope", CHICAGO)).toBe("");
  });
});
