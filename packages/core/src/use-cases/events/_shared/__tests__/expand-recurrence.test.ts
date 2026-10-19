import type { EventSeriesSchedule } from "@th/types";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expandRecurrenceDates } from "../expand-recurrence";

/** Render a real instant back into a zone as `"EEE yyyy-MM-dd HH:mm"`. */
function localLabel(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant)
    .setZone(zone)
    .toFormat("EEE yyyy-MM-dd HH:mm");
}

function localParts(
  instant: Date,
  zone: string,
): { weekday: string; hour: number; minute: number } {
  const dt = DateTime.fromJSDate(instant).setZone(zone);
  return { weekday: dt.weekdayLong!, hour: dt.hour, minute: dt.minute };
}

const WINDOW_START = new Date("2026-08-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-09-01T00:00:00.000Z");
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

describe("expandRecurrenceDates", () => {
  it("expands a weekly RRULE within the window, preserving time-of-day + duration", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY",
      // A Tuesday at 20:00 UTC (using UTC so wall-time == the instant).
      dtstart: "2026-08-04T20:00:00",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      max: 60,
      timezone: "UTC",
      durationMs: THREE_HOURS_MS,
    });

    // Tuesdays in August 2026 inside the window: 4, 11, 18, 25 (Sep 1 20:00 is
    // past windowEnd 2026-09-01T00:00Z).
    expect(dates.map((d) => d.startsAt.toISOString())).toEqual([
      "2026-08-04T20:00:00.000Z",
      "2026-08-11T20:00:00.000Z",
      "2026-08-18T20:00:00.000Z",
      "2026-08-25T20:00:00.000Z",
    ]);
    // endsAt = startsAt + duration.
    expect(dates[0]!.endsAt?.toISOString()).toBe("2026-08-04T23:00:00.000Z");
    // Ascending order.
    for (let i = 1; i < dates.length; i += 1) {
      expect(dates[i]!.startsAt.getTime()).toBeGreaterThan(
        dates[i - 1]!.startsAt.getTime(),
      );
    }
  });

  it("caps the expansion at `max`", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY",
      dtstart: "2026-08-04T20:00:00",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      max: 2,
      timezone: "UTC",
    });

    expect(dates).toHaveLength(2);
    expect(dates.map((d) => d.startsAt.toISOString())).toEqual([
      "2026-08-04T20:00:00.000Z",
      "2026-08-11T20:00:00.000Z",
    ]);
    // No duration → null endsAt.
    expect(dates[0]!.endsAt).toBeNull();
  });

  it("maps FIXED_DATES within the window and drops out-of-window dates", () => {
    const schedule: EventSeriesSchedule = {
      kind: "FIXED_DATES",
      dates: [
        "2026-08-10T19:00:00",
        "2026-08-20T19:00:00",
        "2026-10-01T19:00:00", // outside window
      ],
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      max: 60,
      timezone: "UTC",
    });

    expect(dates.map((d) => d.startsAt.toISOString())).toEqual([
      "2026-08-10T19:00:00.000Z",
      "2026-08-20T19:00:00.000Z",
    ]);
  });

  it("converts wall-time to UTC using the given timezone and applies duration", () => {
    const schedule: EventSeriesSchedule = {
      kind: "FIXED_DATES",
      dates: ["2026-08-10T20:00:00"],
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      max: 60,
      timezone: "America/Chicago", // CDT = UTC-5 in August
      durationMs: 2 * 60 * 60 * 1000,
    });

    expect(dates).toHaveLength(1);
    // 20:00 CDT → 01:00Z next day.
    expect(dates[0]!.startsAt.toISOString()).toBe("2026-08-11T01:00:00.000Z");
    expect(dates[0]!.endsAt?.toISOString()).toBe("2026-08-11T03:00:00.000Z");
  });

  it("dedupes identical FIXED_DATES instants", () => {
    const schedule: EventSeriesSchedule = {
      kind: "FIXED_DATES",
      dates: ["2026-08-10T19:00:00", "2026-08-10T19:00:00"],
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      max: 60,
      timezone: "UTC",
    });

    expect(dates).toHaveLength(1);
  });

  it("returns [] for a syntactically malformed rrule (no throw / 500 escapes)", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      // Length-valid but syntactically bad — the rrule package throws on this.
      rrule: "FREQ=NONSENSE",
      dtstart: "2026-08-04T20:00:00",
    };
    const opts = {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      max: 60,
      timezone: "UTC",
    };

    expect(() => expandRecurrenceDates(schedule, opts)).not.toThrow();
    expect(expandRecurrenceDates(schedule, opts)).toEqual([]);
  });

  it("returns [] for an RRULE missing its rrule/dtstart, and for an inverted window", () => {
    expect(
      expandRecurrenceDates(
        { kind: "RRULE", dtstart: "2026-08-04T20:00:00" },
        { windowStart: WINDOW_START, windowEnd: WINDOW_END, max: 60, timezone: "UTC" },
      ),
    ).toEqual([]);

    expect(
      expandRecurrenceDates(
        {
          kind: "RRULE",
          rrule: "FREQ=WEEKLY",
          dtstart: "2026-08-04T20:00:00",
        },
        {
          windowStart: WINDOW_END,
          windowEnd: WINDOW_START, // inverted
          max: 60,
          timezone: "UTC",
        },
      ),
    ).toEqual([]);
  });
});

// ── Timezone regression (RRULE must be evaluated in the EVENT's zone) ─────
//
// The `rrule` package is timezone-blind: it reads/writes a Date's UTC fields
// and treats them as floating wall-clock. Driving it with real UTC instants
// evaluated BYDAY/BYHOUR against the UTC calendar, so in a negative-offset
// zone an evening event (already rolled to the next UTC day) matched the
// WRONG weekday — every occurrence landed one local day early. These pin the
// floating-wall-clock behaviour.
describe("expandRecurrenceDates — RRULE is evaluated in the event's timezone", () => {
  it("FREQ=WEEKLY;BYDAY=MO at 19:00 America/Chicago yields Mondays at 19:00 local", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      // Mon 2026-09-14 19:00 America/Chicago == 2026-09-15T00:00Z (a TUESDAY
      // in UTC). Pre-fix this enumerated UTC-Tuesdays → local Sundays.
      dtstart: "2026-09-14T19:00:00",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: new Date("2026-09-01T00:00:00.000Z"),
      windowEnd: new Date("2026-11-01T00:00:00.000Z"),
      max: 60,
      timezone: "America/Chicago",
    });

    expect(dates.map((d) => localLabel(d.startsAt, "America/Chicago"))).toEqual([
      "Mon 2026-09-14 19:00",
      "Mon 2026-09-21 19:00",
      "Mon 2026-09-28 19:00",
      "Mon 2026-10-05 19:00",
      "Mon 2026-10-12 19:00",
      "Mon 2026-10-19 19:00",
      "Mon 2026-10-26 19:00",
    ]);

    // Every occurrence is a Monday at 19:00 local — weekday AND hour.
    for (const d of dates) {
      const { weekday, hour, minute } = localParts(
        d.startsAt,
        "America/Chicago",
      );
      expect(weekday).toBe("Monday");
      expect(hour).toBe(19);
      expect(minute).toBe(0);
    }

    // And the real instants they map to.
    expect(dates.map((d) => d.startsAt.toISOString())).toEqual([
      "2026-09-15T00:00:00.000Z",
      "2026-09-22T00:00:00.000Z",
      "2026-09-29T00:00:00.000Z",
      "2026-10-06T00:00:00.000Z",
      "2026-10-13T00:00:00.000Z",
      "2026-10-20T00:00:00.000Z",
      "2026-10-27T00:00:00.000Z",
    ]);
  });

  it("holds 19:00 America/New_York across the November fall-back (local hour fixed, UTC hour shifts)", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstart: "2026-10-19T19:00:00",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: new Date("2026-10-01T00:00:00.000Z"),
      windowEnd: new Date("2026-11-30T00:00:00.000Z"),
      max: 60,
      timezone: "America/New_York",
    });

    // US DST ends Sun 2026-11-01: EDT (-4) before, EST (-5) after.
    expect(
      dates.map((d) => localLabel(d.startsAt, "America/New_York")),
    ).toEqual([
      "Mon 2026-10-19 19:00",
      "Mon 2026-10-26 19:00",
      "Mon 2026-11-02 19:00",
      "Mon 2026-11-09 19:00",
      "Mon 2026-11-16 19:00",
      "Mon 2026-11-23 19:00",
    ]);

    // The local hour never drifts...
    for (const d of dates) {
      expect(localParts(d.startsAt, "America/New_York").hour).toBe(19);
    }

    // ...but the UTC instant does, exactly once, at the transition.
    expect(dates.map((d) => d.startsAt.toISOString())).toEqual([
      "2026-10-19T23:00:00.000Z", // EDT
      "2026-10-26T23:00:00.000Z", // EDT
      "2026-11-03T00:00:00.000Z", // EST
      "2026-11-10T00:00:00.000Z",
      "2026-11-17T00:00:00.000Z",
      "2026-11-24T00:00:00.000Z",
    ]);
  });

  it("FREQ=MONTHLY;BYDAY=1FR at 20:00 America/Chicago picks the FIRST Friday of each local month", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=MONTHLY;BYDAY=1FR",
      dtstart: "2026-09-04T20:00:00",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: new Date("2026-09-01T00:00:00.000Z"),
      windowEnd: new Date("2027-01-01T00:00:00.000Z"),
      max: 60,
      timezone: "America/Chicago",
    });

    expect(dates.map((d) => localLabel(d.startsAt, "America/Chicago"))).toEqual([
      "Fri 2026-09-04 20:00",
      "Fri 2026-10-02 20:00",
      "Fri 2026-11-06 20:00",
      "Fri 2026-12-04 20:00",
    ]);

    for (const d of dates) {
      const local = DateTime.fromJSDate(d.startsAt).setZone("America/Chicago");
      expect(local.weekdayLong).toBe("Friday");
      expect(local.hour).toBe(20);
      // "First Friday" ⇒ local day-of-month is 1..7.
      expect(local.day).toBeLessThanOrEqual(7);
    }
  });

  it("works in a POSITIVE-offset zone too (Australia/Sydney, incl. its October DST start)", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      // 09:00 Sydney is the previous UTC day (SUNDAY) — the mirror image of
      // the US-evening bug, so this proves the fix is not an inverted
      // hardcode of a negative offset.
      dtstart: "2026-09-14T09:00:00",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: new Date("2026-09-01T00:00:00.000Z"),
      windowEnd: new Date("2026-10-20T00:00:00.000Z"),
      max: 60,
      timezone: "Australia/Sydney",
    });

    expect(
      dates.map((d) => localLabel(d.startsAt, "Australia/Sydney")),
    ).toEqual([
      "Mon 2026-09-14 09:00",
      "Mon 2026-09-21 09:00",
      "Mon 2026-09-28 09:00",
      "Mon 2026-10-05 09:00",
      "Mon 2026-10-12 09:00",
      "Mon 2026-10-19 09:00",
    ]);

    for (const d of dates) {
      const { weekday, hour } = localParts(d.startsAt, "Australia/Sydney");
      expect(weekday).toBe("Monday");
      expect(hour).toBe(9);
    }

    // Sydney DST starts Sun 2026-10-04 (+10 → +11): the UTC instants step
    // back an hour after it, the local 09:00 does not move.
    expect(dates.map((d) => d.startsAt.toISOString())).toEqual([
      "2026-09-13T23:00:00.000Z",
      "2026-09-20T23:00:00.000Z",
      "2026-09-27T23:00:00.000Z",
      "2026-10-04T22:00:00.000Z",
      "2026-10-11T22:00:00.000Z",
      "2026-10-18T22:00:00.000Z",
    ]);
  });

  it("UTC stays a no-op: a weekly BYDAY=MO rule in UTC is unchanged", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstart: "2026-09-14T19:00:00",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: new Date("2026-09-01T00:00:00.000Z"),
      windowEnd: new Date("2026-10-06T00:00:00.000Z"),
      max: 60,
      timezone: "UTC",
    });

    expect(dates.map((d) => d.startsAt.toISOString())).toEqual([
      "2026-09-14T19:00:00.000Z",
      "2026-09-21T19:00:00.000Z",
      "2026-09-28T19:00:00.000Z",
      "2026-10-05T19:00:00.000Z",
    ]);
  });

  it("honours `until` as wall-time in the zone (not as a UTC instant)", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstart: "2026-09-14T19:00:00",
      until: "2026-09-28T23:59:59",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: new Date("2026-09-01T00:00:00.000Z"),
      windowEnd: new Date("2026-12-01T00:00:00.000Z"),
      max: 60,
      timezone: "America/Chicago",
    });

    expect(dates.map((d) => localLabel(d.startsAt, "America/Chicago"))).toEqual([
      "Mon 2026-09-14 19:00",
      "Mon 2026-09-21 19:00",
      "Mon 2026-09-28 19:00",
    ]);
  });
});

// ── DST edge cases (documented in `rrule-floating-time.ts`) ───────────────
describe("expandRecurrenceDates — DST gap / ambiguity", () => {
  it("shifts a NONEXISTENT spring-forward local time forward instead of emitting an Invalid Date", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=SU",
      // 02:30 on Sun 2027-03-14 does not exist in America/New_York (the clock
      // jumps 02:00 → 03:00).
      dtstart: "2027-03-07T02:30:00",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: new Date("2027-03-01T00:00:00.000Z"),
      windowEnd: new Date("2027-03-25T00:00:00.000Z"),
      max: 10,
      timezone: "America/New_York",
    });

    for (const d of dates) {
      expect(Number.isNaN(d.startsAt.getTime())).toBe(false);
    }
    expect(
      dates.map((d) => localLabel(d.startsAt, "America/New_York")),
    ).toEqual([
      "Sun 2027-03-07 02:30",
      "Sun 2027-03-14 03:30", // gap → shifted FORWARD past the missing hour
      "Sun 2027-03-21 02:30",
    ]);
  });

  it("resolves an AMBIGUOUS fall-back local time to the earlier offset", () => {
    const schedule: EventSeriesSchedule = {
      kind: "RRULE",
      rrule: "FREQ=DAILY",
      // 01:30 on Sun 2026-11-01 happens twice in America/New_York.
      dtstart: "2026-10-31T01:30:00",
    };

    const dates = expandRecurrenceDates(schedule, {
      windowStart: new Date("2026-10-30T00:00:00.000Z"),
      windowEnd: new Date("2026-11-03T00:00:00.000Z"),
      max: 10,
      timezone: "America/New_York",
    });

    expect(dates.map((d) => d.startsAt.toISOString())).toEqual([
      "2026-10-31T05:30:00.000Z", // EDT (-4)
      "2026-11-01T05:30:00.000Z", // EDT (-4) — the FIRST 01:30, not 06:30Z
      "2026-11-02T06:30:00.000Z", // EST (-5)
    ]);
  });
});

// ── Migration end-to-end ─────────────────────────────────────────────────
//
// The admin event builder used to emit a UTC-basis BYDAY token (a Chicago
// Friday-20:00 show was stored as BYDAY=SA) to compensate for the backend
// evaluating in UTC. Now that this file evaluates in the event timezone,
// those stored rules run a day LATE until they are migrated by
// `apps/api/src/scripts/backfill/done/migrate-series-rrule-local-basis.ts`.
//
// These pin BOTH halves of that statement against the real expansion: the
// unmigrated rule is wrong, and the rule the migration produces is right.
// The rewritten strings here are the exact output the script's own suite
// (`apps/api/test/series-rrule-local-basis.test.ts`) asserts.
describe("expandRecurrenceDates — legacy UTC-basis rules and their migration", () => {
  const CHICAGO = "America/Chicago";
  const localDays = (dates: Array<{ startsAt: Date }>) =>
    dates.map((d) =>
      DateTime.fromJSDate(d.startsAt).setZone(CHICAGO).toFormat("EEE HH:mm"),
    );

  it("WEEKLY: the un-migrated BYDAY=SA rule runs a day LATE; BYDAY=FR is correct", () => {
    // Fri 2026-09-04 20:00 Chicago == Sat 2026-09-05 01:00Z.
    const opts = {
      windowStart: new Date("2026-09-01T00:00:00.000Z"),
      windowEnd: new Date("2026-10-05T00:00:00.000Z"),
      max: 4,
      timezone: CHICAGO,
    };
    const dtstart = "2026-09-04T20:00:00";

    const unmigrated = expandRecurrenceDates(
      { kind: "RRULE", rrule: "FREQ=WEEKLY;BYDAY=SA", dtstart },
      opts,
    );
    const migrated = expandRecurrenceDates(
      { kind: "RRULE", rrule: "FREQ=WEEKLY;BYDAY=FR", dtstart },
      opts,
    );

    expect(localDays(unmigrated)).toEqual([
      "Sat 20:00",
      "Sat 20:00",
      "Sat 20:00",
      "Sat 20:00",
    ]);
    expect(localDays(migrated)).toEqual([
      "Fri 20:00",
      "Fri 20:00",
      "Fri 20:00",
      "Fri 20:00",
    ]);
    // Only the migrated rule contains the event's OWN start.
    expect(migrated[0]!.startsAt.toISOString()).toBe(
      "2026-09-05T01:00:00.000Z",
    );
  });

  it("MONTHLY: BYDAY+BYSETPOS must move together across a month boundary", () => {
    // Fri 2026-07-31 20:00 Chicago == Sat 2026-08-01 01:00Z: local LAST
    // Friday of July, UTC FIRST Saturday of August.
    const opts = {
      windowStart: new Date("2026-07-01T00:00:00.000Z"),
      windowEnd: new Date("2026-11-01T00:00:00.000Z"),
      max: 3,
      timezone: CHICAGO,
    };
    const dtstart = "2026-07-31T20:00:00";

    const unmigrated = expandRecurrenceDates(
      { kind: "RRULE", rrule: "FREQ=MONTHLY;BYDAY=SA;BYSETPOS=1", dtstart },
      opts,
    );
    const migrated = expandRecurrenceDates(
      { kind: "RRULE", rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1", dtstart },
      opts,
    );

    // Wrong weekday, and it never lands on the event's own start.
    expect(localDays(unmigrated)).toEqual([
      "Sat 20:00",
      "Sat 20:00",
      "Sat 20:00",
    ]);
    expect(
      unmigrated.map((d) => d.startsAt.toISOString()),
    ).not.toContain("2026-08-01T01:00:00.000Z");

    // Correct last-Fridays, starting with the event's own start.
    expect(localDays(migrated)).toEqual([
      "Fri 20:00",
      "Fri 20:00",
      "Fri 20:00",
    ]);
    expect(
      migrated.map((d) =>
        DateTime.fromJSDate(d.startsAt).setZone(CHICAGO).toISODate(),
      ),
    ).toEqual(["2026-07-31", "2026-08-28", "2026-09-25"]);
  });
});

// ── Ambiguous fall-back hour must NOT depend on when the process runs ─────
//
// `DateTime.fromObject` seeds its offset guess from `Settings.now()`, so an
// ambiguous wall clock used to resolve to whichever repetition matched
// TODAY's offset: 01:30 on 2026-11-01 America/Chicago gave 06:30Z from a
// summer clock and 07:30Z from a winter one. That is data loss here, not a
// curiosity — `reconcileSeriesSchedule` matches stored occurrence instants
// EXACTLY, so a series stored in summer would be orphaned (PLANNED deleted,
// GENERATED/PUBLISHED detached) the first time it was reconciled in winter.
//
// `floatingToInstant` now brackets the transition instead, which is
// clock-independent. These run the SAME assertion under both seasons.
describe("expandRecurrenceDates — the ambiguous hour is clock-independent", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const expandAmbiguous = () =>
    expandRecurrenceDates(
      {
        kind: "RRULE",
        rrule: "FREQ=DAILY",
        // 01:30 on Sun 2026-11-01 America/Chicago happens TWICE.
        dtstart: "2026-10-31T01:30:00",
      },
      {
        windowStart: new Date("2026-10-30T00:00:00.000Z"),
        windowEnd: new Date("2026-11-03T00:00:00.000Z"),
        max: 3,
        timezone: "America/Chicago",
      },
    ).map((d) => d.startsAt.toISOString());

  const EXPECTED = [
    "2026-10-31T06:30:00.000Z", // CDT (-5)
    "2026-11-01T06:30:00.000Z", // the EARLIER of the two 01:30s (still CDT)
    "2026-11-02T07:30:00.000Z", // CST (-6)
  ];

  it("resolves to the earlier offset with a SUMMER process clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    expect(expandAmbiguous()).toEqual(EXPECTED);
  });

  it("resolves IDENTICALLY with a WINTER process clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-15T12:00:00.000Z"));
    expect(expandAmbiguous()).toEqual(EXPECTED);
  });

  it("agrees across both clocks for a southern-hemisphere fall-back too", () => {
    // Sydney's DST ends Sun 2026-04-05: 03:00 AEDT -> 02:00 AEST, so 02:30
    // happens twice. The earlier (AEDT, +11) occurrence must win either way.
    const run = () =>
      expandRecurrenceDates(
        {
          kind: "RRULE",
          rrule: "FREQ=DAILY",
          dtstart: "2026-04-05T02:30:00",
        },
        {
          windowStart: new Date("2026-04-01T00:00:00.000Z"),
          windowEnd: new Date("2026-04-06T00:00:00.000Z"),
          max: 1,
          timezone: "Australia/Sydney",
        },
      ).map((d) => d.startsAt.toISOString());

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z")); // AEDT
    const summerClock = run();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z")); // AEST
    const winterClock = run();

    expect(summerClock).toEqual(winterClock);
    expect(summerClock).toEqual(["2026-04-04T15:30:00.000Z"]); // +11, earlier
  });
});
