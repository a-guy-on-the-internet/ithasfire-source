import { describe, expect, it } from "vitest";

import {
  buildGoogleCalendarUrl,
  buildOutlookCalendarUrl,
  type WebCalendarEvent,
} from "@/lib/calendar/web-calendar";

/** Wed 9 Sep 2026, 8:00–11:00 PM America/Chicago — the seeded open mic. */
const OPEN_MIC: WebCalendarEvent = {
  title: "Grown and Sexy Open Mic",
  startsAt: "2026-09-10T01:00:00.000Z",
  endsAt: "2026-09-10T04:00:00.000Z",
  location: "Carol Ann's, Nashville, TN",
  timezone: "America/Chicago",
};

const WEEKLY = {
  freq: "WEEKLY" as const,
  interval: 1,
  byday: ["WE"],
  until: null,
};

const params = (url: string) => new URL(url).searchParams;

describe("buildGoogleCalendarUrl — the single-event link is unchanged", () => {
  it("matches the pinned URL for a non-recurring event", () => {
    expect(buildGoogleCalendarUrl(OPEN_MIC)).toBe(
      "https://calendar.google.com/calendar/render?action=TEMPLATE" +
        "&text=Grown+and+Sexy+Open+Mic" +
        "&dates=20260910T010000Z%2F20260910T040000Z" +
        "&location=Carol+Ann%27s%2C+Nashville%2C+TN",
    );
  });

  it("adds no recurrence parameters when there is no recurrence", () => {
    for (const recurrence of [undefined, null]) {
      const query = params(buildGoogleCalendarUrl({ ...OPEN_MIC, recurrence }));
      expect(query.get("recur")).toBeNull();
      expect(query.get("ctz")).toBeNull();
    }
  });

  it("keeps the UTC dates when only a timezone is supplied", () => {
    expect(params(buildGoogleCalendarUrl(OPEN_MIC)).get("dates")).toBe(
      "20260910T010000Z/20260910T040000Z",
    );
  });
});

describe("buildGoogleCalendarUrl — the recurring link", () => {
  const recurring = { ...OPEN_MIC, recurrence: WEEKLY };

  it("carries the rule in Google's own `recur` parameter", () => {
    expect(params(buildGoogleCalendarUrl(recurring)).get("recur")).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=WE",
    );
  });

  it("switches `dates` to the wall clock and names the zone in `ctz`", () => {
    // Google expands `recur` against whatever basis `dates` is in. Left in UTC,
    // `BYDAY=WE` would match 01:00Z — a THURSDAY — and generate Tuesday nights.
    const query = params(buildGoogleCalendarUrl(recurring));
    expect(query.get("dates")).toBe("20260909T200000/20260909T230000");
    expect(query.get("ctz")).toBe("America/Chicago");
  });

  it("carries UNTIL when the series is bounded", () => {
    expect(
      params(
        buildGoogleCalendarUrl({
          ...recurring,
          recurrence: { ...WEEKLY, until: "2026-12-31T06:00:00Z" },
        }),
      ).get("recur"),
    ).toBe("RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231T060000Z");
  });

  it("omits UNTIL when the series is unbounded", () => {
    expect(params(buildGoogleCalendarUrl(recurring)).get("recur")).not.toContain(
      "UNTIL",
    );
  });

  it("keeps the other parameters", () => {
    const query = params(
      buildGoogleCalendarUrl({ ...recurring, description: "Sign-up at 7:30" }),
    );
    expect(query.get("text")).toBe("Grown and Sexy Open Mic");
    expect(query.get("location")).toBe("Carol Ann's, Nashville, TN");
    expect(query.get("details")).toBe("Sign-up at 7:30");
  });

  it.each([
    ["no timezone", { timezone: undefined }],
    ["an unresolvable timezone", { timezone: "Mars/Olympus_Mons" }],
    ["an unstatable cadence", { recurrence: { ...WEEKLY, freq: "MONTHLY" as const } }],
  ])("degrades to the UTC single-event link with %s", (_label, over) => {
    const query = params(buildGoogleCalendarUrl({ ...recurring, ...over }));
    expect(query.get("recur")).toBeNull();
    expect(query.get("ctz")).toBeNull();
    expect(query.get("dates")).toBe("20260910T010000Z/20260910T040000Z");
  });
});

describe("buildOutlookCalendarUrl — no recurrence, by design", () => {
  /**
   * Outlook's compose deep link accepts `subject`, `startdt`, `enddt`,
   * `location`, `body`, `allday` and `online`. There is NO recurrence
   * parameter, so a recurring listing opens as a single event on the first date
   * and the user repeats it in Outlook. Faking it — a longer `enddt`, an
   * invented parameter — would either be dropped or describe an appointment the
   * schedule never mentions.
   */
  it("produces the same URL with and without a recurrence", () => {
    expect(buildOutlookCalendarUrl({ ...OPEN_MIC, recurrence: WEEKLY })).toBe(
      buildOutlookCalendarUrl(OPEN_MIC),
    );
  });

  it("matches the pinned URL", () => {
    expect(buildOutlookCalendarUrl(OPEN_MIC)).toBe(
      "https://outlook.live.com/calendar/0/action/compose?rru=addevent" +
        "&subject=Grown+and+Sexy+Open+Mic" +
        "&startdt=2026-09-10T01%3A00%3A00Z" +
        "&enddt=2026-09-10T04%3A00%3A00Z" +
        "&path=%2Fcalendar%2Faction%2Fcompose" +
        "&location=Carol+Ann%27s%2C+Nashville%2C+TN",
    );
  });

  it("does not stretch enddt to cover the series", () => {
    const query = params(
      buildOutlookCalendarUrl({
        ...OPEN_MIC,
        recurrence: { ...WEEKLY, until: "2027-09-01T05:00:00Z" },
      }),
    );
    expect(query.get("enddt")).toBe("2026-09-10T04:00:00Z");
  });
});

describe("an end the server sends can be unreadable or inverted", () => {
  const START = "2026-09-10T01:00:00.000Z";
  const PLUS_2H_GOOGLE = "20260910T010000Z/20260910T030000Z";
  const bad = [
    ["unreadable", "not a date"],
    ["before the start", "2026-09-09T20:00:00.000Z"],
    ["equal to the start", START],
  ] as const;

  for (const [label, endsAt] of bad) {
    it(`Google: an end ${label} becomes start + 2h`, () => {
      const url = buildGoogleCalendarUrl({ title: "T", startsAt: START, endsAt });
      expect(params(url).get("dates")).toBe(PLUS_2H_GOOGLE);
    });

    it(`Outlook: an end ${label} becomes start + 2h`, () => {
      const url = buildOutlookCalendarUrl({ title: "T", startsAt: START, endsAt });
      expect(params(url).get("enddt")).toBe("2026-09-10T03:00:00Z");
    });
  }

  it("a missing end (undefined) becomes start + 2h", () => {
    const event = { title: "T", startsAt: START, endsAt: undefined };
    expect(params(buildGoogleCalendarUrl(event)).get("dates")).toBe(PLUS_2H_GOOGLE);
    expect(params(buildOutlookCalendarUrl(event)).get("enddt")).toBe(
      "2026-09-10T03:00:00Z",
    );
  });

  it("recurring Google link: an inverted end still ends at start + 2h on the wall clock", () => {
    const url = buildGoogleCalendarUrl({
      ...OPEN_MIC,
      endsAt: "2026-09-09T20:00:00.000Z",
      recurrence: WEEKLY,
    });
    expect(params(url).get("dates")).toBe("20260909T200000/20260909T220000");
  });

  it("a valid end is used as sent", () => {
    expect(params(buildGoogleCalendarUrl(OPEN_MIC)).get("dates")).toBe(
      "20260910T010000Z/20260910T040000Z",
    );
    expect(params(buildOutlookCalendarUrl(OPEN_MIC)).get("enddt")).toBe(
      "2026-09-10T04:00:00Z",
    );
  });
});
