import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  attendanceBandFor,
  cadenceFor,
  computeTrackRecord,
  deriveTrackRecordView,
  yearsRunningFor,
} from "../track-record-policy";

const NOW = new Date("2026-09-24T18:00:00.000Z");
const d = (iso: string) => new Date(iso);

describe("computeTrackRecord (FR-009, R4, R5)", () => {
  it("scans 20 / 30 / 0 across three past shows → count 2, total 50, avg 25, band 25_to_100", () => {
    const stats = computeTrackRecord({
      pastEvents: [
        { id: "e1", endsAt: d("2026-09-01T04:00:00Z") },
        { id: "e2", endsAt: d("2026-09-08T04:00:00Z") },
        { id: "e3", endsAt: d("2026-09-15T04:00:00Z") },
      ],
      // e3 has zero scans → ABSENT from the map (the port contract).
      scanCounts: new Map([
        ["e1", 20],
        ["e2", 30],
      ]),
      now: NOW,
    });
    expect(stats).toEqual({
      showsHosted: 3,
      firstShowAt: d("2026-09-01T04:00:00Z"),
      lastShowAt: d("2026-09-15T04:00:00Z"),
      scannedEventCount: 2,
      checkedInTotal: 50,
      checkedInAvg: 25,
    });
    expect(attendanceBandFor(stats.checkedInAvg)).toBe("25_to_100");
  });

  it("a zero-scan show is EXCLUDED from the mean, never counted as 0 — even when the map says 0", () => {
    const stats = computeTrackRecord({
      pastEvents: [
        { id: "e1", endsAt: d("2026-09-01T04:00:00Z") },
        { id: "e2", endsAt: d("2026-09-08T04:00:00Z") },
        { id: "e3", endsAt: d("2026-09-15T04:00:00Z") },
      ],
      scanCounts: new Map([
        ["e1", 20],
        ["e2", 30],
        ["e3", 0],
      ]),
      now: NOW,
    });
    expect(stats.scannedEventCount).toBe(2);
    expect(stats.checkedInAvg).toBe(25);
    // Still a show that happened.
    expect(stats.showsHosted).toBe(3);
  });

  it("zero scans anywhere → scannedEventCount 0, total 0, avg null, band null; shows still count (R5)", () => {
    const stats = computeTrackRecord({
      pastEvents: [
        { id: "rsvp-1", endsAt: d("2026-08-01T04:00:00Z") },
        { id: "rsvp-2", endsAt: d("2026-08-15T04:00:00Z") },
      ],
      scanCounts: new Map(),
      now: NOW,
    });
    expect(stats.showsHosted).toBe(2);
    expect(stats.firstShowAt).toEqual(d("2026-08-01T04:00:00Z"));
    expect(stats.lastShowAt).toEqual(d("2026-08-15T04:00:00Z"));
    expect(stats.scannedEventCount).toBe(0);
    expect(stats.checkedInTotal).toBe(0);
    expect(stats.checkedInAvg).toBeNull();
    expect(attendanceBandFor(stats.checkedInAvg)).toBeNull();
  });

  it("an in-progress show (endsAt > now) is excluded from EVERYTHING — count, last, and scans", () => {
    const stats = computeTrackRecord({
      pastEvents: [
        { id: "done", endsAt: d("2026-09-20T04:00:00Z") },
        // Started, door open, not over — its scans are partial.
        { id: "live", endsAt: d("2026-09-24T23:00:00Z") },
      ],
      scanCounts: new Map([
        ["done", 40],
        ["live", 500],
      ]),
      now: NOW,
    });
    expect(stats).toEqual({
      showsHosted: 1,
      firstShowAt: d("2026-09-20T04:00:00Z"),
      lastShowAt: d("2026-09-20T04:00:00Z"),
      scannedEventCount: 1,
      checkedInTotal: 40,
      checkedInAvg: 40,
    });
  });

  it("a show ending exactly at now has happened", () => {
    const stats = computeTrackRecord({
      pastEvents: [{ id: "edge", endsAt: NOW }],
      scanCounts: new Map([["edge", 3]]),
      now: NOW,
    });
    expect(stats.showsHosted).toBe(1);
    expect(stats.checkedInAvg).toBe(3);
  });

  it("empty input → zeros and nulls", () => {
    expect(
      computeTrackRecord({ pastEvents: [], scanCounts: new Map(), now: NOW }),
    ).toEqual({
      showsHosted: 0,
      firstShowAt: null,
      lastShowAt: null,
      scannedEventCount: 0,
      checkedInTotal: 0,
      checkedInAvg: null,
    });
  });

  it("first/last are read off endsAt regardless of input order, and the mean is rounded", () => {
    const stats = computeTrackRecord({
      pastEvents: [
        { id: "b", endsAt: d("2026-06-02T04:00:00Z") },
        { id: "c", endsAt: d("2026-07-02T04:00:00Z") },
        { id: "a", endsAt: d("2026-05-02T04:00:00Z") },
      ],
      scanCounts: new Map([
        ["a", 10],
        ["b", 11],
        ["c", 12],
      ]),
      now: NOW,
    });
    expect(stats.firstShowAt).toEqual(d("2026-05-02T04:00:00Z"));
    expect(stats.lastShowAt).toEqual(d("2026-07-02T04:00:00Z"));
    expect(stats.checkedInAvg).toBe(11);
    // 10 + 11 + 12 + 14 = 47 / 4 = 11.75 → 12
    expect(
      computeTrackRecord({
        pastEvents: [
          ...["a", "b", "c", "d"].map((id, i) => ({
            id,
            endsAt: d(`2026-0${i + 4}-02T04:00:00Z`),
          })),
        ],
        scanCounts: new Map([
          ["a", 10],
          ["b", 11],
          ["c", 12],
          ["d", 14],
        ]),
        now: NOW,
      }).checkedInAvg,
    ).toBe(12);
  });
});

describe("attendanceBandFor (FR-010) — lower-inclusive boundaries", () => {
  it.each([
    [null, null],
    [0, "under_25"],
    [24, "under_25"],
    [25, "25_to_100"],
    [99, "25_to_100"],
    [100, "100_to_300"],
    [299, "100_to_300"],
    [300, "over_300"],
    [5000, "over_300"],
  ] as const)("%s → %s", (avg, band) => {
    expect(attendanceBandFor(avg)).toBe(band);
  });
});

describe("yearsRunningFor — half-year floor", () => {
  it("2024-03-10 → 2026-09-24 = 2.5", () => {
    expect(yearsRunningFor(d("2024-03-10T04:00:00Z"), NOW)).toBe(2.5);
  });
  it("exactly two years reads 2", () => {
    expect(yearsRunningFor(d("2024-09-24T18:00:00Z"), NOW)).toBe(2);
  });
  it("under half a year → null; null first show → null", () => {
    expect(yearsRunningFor(d("2026-05-01T00:00:00Z"), NOW)).toBeNull();
    expect(yearsRunningFor(null, NOW)).toBeNull();
  });
  it("a first show after now (clock skew) → null, never negative", () => {
    expect(yearsRunningFor(d("2027-01-01T00:00:00Z"), NOW)).toBeNull();
  });
});

describe("cadenceFor (FR-009) — median gap over the trailing 180 days", () => {
  it("09-01/08/15/22 after a sparse spring → weekly, since the first weekly night", () => {
    const ends = [
      d("2026-06-01T04:00:00Z"),
      d("2026-07-15T04:00:00Z"),
      d("2026-09-01T04:00:00Z"),
      d("2026-09-08T04:00:00Z"),
      d("2026-09-15T04:00:00Z"),
      d("2026-09-22T04:00:00Z"),
    ];
    // gaps: 44, 48, 7, 7, 7 → median 7 → weekly; walk back from 09-22 while
    // the gap in stays ≤10d: 09-15, 09-08, 09-01; 07-15 → 09-01 is 48d, stop.
    expect(cadenceFor(ends, NOW)).toEqual({
      cadence: "weekly",
      cadenceSince: d("2026-09-01T04:00:00Z"),
    });
  });

  it("~30-day gaps → monthly, since the earliest show in the run", () => {
    const ends = [
      d("2026-05-05T04:00:00Z"),
      d("2026-06-04T04:00:00Z"),
      d("2026-07-05T04:00:00Z"),
      d("2026-08-04T04:00:00Z"),
      d("2026-09-03T04:00:00Z"),
    ];
    expect(cadenceFor(ends, NOW)).toEqual({
      cadence: "monthly",
      cadenceSince: d("2026-05-05T04:00:00Z"),
    });
  });

  it("~14-day gaps → fortnightly; >45-day gaps → occasional", () => {
    expect(
      cadenceFor(
        [
          d("2026-08-11T04:00:00Z"),
          d("2026-08-25T04:00:00Z"),
          d("2026-09-08T04:00:00Z"),
          d("2026-09-22T04:00:00Z"),
        ],
        NOW,
      ).cadence,
    ).toBe("fortnightly");
    expect(
      cadenceFor(
        [
          d("2026-04-10T04:00:00Z"),
          d("2026-06-10T04:00:00Z"),
          d("2026-08-10T04:00:00Z"),
        ],
        NOW,
      ).cadence,
    ).toBe("occasional");
  });

  it("two shows in the window → null / null", () => {
    expect(
      cadenceFor([d("2026-09-01T04:00:00Z"), d("2026-09-08T04:00:00Z")], NOW),
    ).toEqual({ cadence: null, cadenceSince: null });
  });

  it("shows older than 180 days and shows after now do not count toward the window", () => {
    const ends = [
      // 2026-03-28 is exactly 180d before 09-24 (18:00Z); this is a day earlier.
      d("2026-03-27T04:00:00Z"),
      d("2026-09-01T04:00:00Z"),
      d("2026-09-08T04:00:00Z"),
      // Not yet happened.
      d("2026-10-01T04:00:00Z"),
    ];
    expect(cadenceFor(ends, NOW)).toEqual({
      cadence: null,
      cadenceSince: null,
    });
  });

  it("[traced] a monthly first-Saturday room with an early + late bill each night reads MONTHLY, not fortnightly", () => {
    // Chicago. Early set ends 22:00 local; late set ends 01:36 local the next
    // calendar date (0.15d later). Without collapsing to nights the gaps are
    // [0.15, 28, 0.15, 35, 0.15, 28, 0.15] → median 0.15 → "weekly"; the
    // reviewer's [0.15,0.15,0.15,30,30,30] trace sorted the same way lands
    // on 15.08 → "fortnightly". The room is monthly.
    const zone = "America/Chicago";
    const nights = ["2026-05-02", "2026-05-30", "2026-07-04", "2026-08-01"];
    const ends = nights.flatMap((night) => [
      d(`${night}T22:00:00-05:00`),
      new Date(
        d(`${night}T22:00:00-05:00`).getTime() + 0.15 * 24 * 60 * 60 * 1000,
      ),
    ]);
    // Sanity: the late set really does end on the next LOCAL calendar date
    // (a naive by-date collapse would still see two nights a day apart).
    const localDate = (x: Date) => DateTime.fromJSDate(x, { zone }).toISODate();
    expect(localDate(ends[0]!)).toBe("2026-05-02");
    expect(localDate(ends[1]!)).toBe("2026-05-03");
    const out = cadenceFor(ends, NOW, zone);
    expect(out.cadence).toBe("monthly");
    expect(out.cadenceSince).toEqual(d("2026-05-02T22:00:00-05:00"));
    // The same instants judged in UTC-with-no-rollover would not collapse
    // via deriveTrackRecordView either — it passes the place zone through.
    expect(
      deriveTrackRecordView({
        stats: { firstShowAt: null, checkedInAvg: null },
        pastEventEnds: ends,
        now: NOW,
        timeZone: zone,
      }).cadence,
    ).toBe("monthly");
  });

  it("[traced] a monthly run with ONE double bill keeps cadenceSince at the run start, not the double-bill night", () => {
    const zone = "America/Chicago";
    const ends = [
      d("2026-05-02T22:00:00-05:00"),
      d("2026-06-06T22:00:00-05:00"),
      // Late set on the 06-06 bill, 0.2d after the early one.
      new Date(
        d("2026-06-06T22:00:00-05:00").getTime() + 0.2 * 24 * 60 * 60 * 1000,
      ),
      d("2026-07-04T22:00:00-05:00"),
      d("2026-08-01T22:00:00-05:00"),
      d("2026-09-05T22:00:00-05:00"),
    ];
    // Un-collapsed the walk-back would meet the 0.2d gap ("weekly" ≠
    // "monthly") and stop at 06-06.
    expect(cadenceFor(ends, NOW, zone)).toEqual({
      cadence: "monthly",
      cadenceSince: d("2026-05-02T22:00:00-05:00"),
    });
  });

  it("a weekly residency that skipped ONE week is still weekly since before the skip (one ≤2× skip forgiven)", () => {
    const ends = [
      d("2026-07-07T04:00:00Z"),
      d("2026-07-14T04:00:00Z"),
      d("2026-07-21T04:00:00Z"),
      // 07-28 skipped → 14d gap, bucketed "fortnightly".
      d("2026-08-04T04:00:00Z"),
      d("2026-08-11T04:00:00Z"),
      d("2026-08-18T04:00:00Z"),
      d("2026-08-25T04:00:00Z"),
      d("2026-09-01T04:00:00Z"),
    ];
    expect(cadenceFor(ends, NOW, "UTC")).toEqual({
      cadence: "weekly",
      cadenceSince: d("2026-07-07T04:00:00Z"),
    });
  });

  it("a weekly run with a 30d gap (> 2× median) breaks there", () => {
    const ends = [
      d("2026-06-02T04:00:00Z"),
      d("2026-06-09T04:00:00Z"),
      d("2026-06-16T04:00:00Z"),
      d("2026-06-23T04:00:00Z"),
      d("2026-07-23T04:00:00Z"),
      d("2026-07-30T04:00:00Z"),
      d("2026-08-06T04:00:00Z"),
    ];
    expect(cadenceFor(ends, NOW, "UTC")).toEqual({
      cadence: "weekly",
      cadenceSince: d("2026-07-23T04:00:00Z"),
    });
  });

  it("two CONSECUTIVE out-of-bucket gaps break the run even when each is ≤ 2× median", () => {
    const ends = [
      d("2026-06-02T04:00:00Z"),
      d("2026-06-09T04:00:00Z"),
      d("2026-06-16T04:00:00Z"),
      d("2026-06-28T04:00:00Z"), // 12d
      d("2026-07-11T04:00:00Z"), // 13d
      d("2026-07-18T04:00:00Z"),
      d("2026-07-25T04:00:00Z"),
      d("2026-08-01T04:00:00Z"),
      d("2026-08-08T04:00:00Z"),
    ];
    // gaps 7,7,12,13,7,7,7,7 → median 7 → weekly; walking back: 7,7,7,7 ok;
    // 13 is a skip but the gap before it (12) is out-of-bucket too → break.
    expect(cadenceFor(ends, NOW, "UTC")).toEqual({
      cadence: "weekly",
      cadenceSince: d("2026-07-11T04:00:00Z"),
    });
  });

  it("cadenceSince stops at the first out-of-bucket gap even when the median is weekly", () => {
    // weekly run of 4, then a 30d break, then weekly run of 2 (the latest).
    const ends = [
      d("2026-06-02T04:00:00Z"),
      d("2026-06-09T04:00:00Z"),
      d("2026-06-16T04:00:00Z"),
      d("2026-06-23T04:00:00Z"),
      d("2026-07-23T04:00:00Z"),
      d("2026-07-30T04:00:00Z"),
    ];
    // gaps 7,7,7,30,7 → median 7 → weekly; since = 07-23 (the 30d gap breaks it).
    expect(cadenceFor(ends, NOW)).toEqual({
      cadence: "weekly",
      cadenceSince: d("2026-07-23T04:00:00Z"),
    });
  });
});

describe("deriveTrackRecordView", () => {
  it("showsThisYear honours the PLACE's zone at a year boundary", () => {
    // 23:30 on Dec 31 2025 in Chicago is 05:30Z on Jan 1 2026.
    const newYearsEveChicago = d("2026-01-01T05:30:00.000Z");
    const now = d("2026-03-01T12:00:00.000Z");
    const base = {
      stats: { firstShowAt: null, checkedInAvg: null },
      pastEventEnds: [newYearsEveChicago],
      now,
    };
    expect(
      deriveTrackRecordView({ ...base, timeZone: "America/Chicago" })
        .showsThisYear,
    ).toBe(0);
    expect(
      deriveTrackRecordView({ ...base, timeZone: "UTC" }).showsThisYear,
    ).toBe(1);
    // The mirror: 00:30 local on Jan 1 in Tokyo is still Dec 31 in UTC.
    const newYearTokyo = d("2025-12-31T15:30:00.000Z");
    expect(
      deriveTrackRecordView({
        ...base,
        pastEventEnds: [newYearTokyo],
        timeZone: "Asia/Tokyo",
      }).showsThisYear,
    ).toBe(1);
    expect(
      deriveTrackRecordView({
        ...base,
        pastEventEnds: [newYearTokyo],
        timeZone: "UTC",
      }).showsThisYear,
    ).toBe(0);
  });

  it("a null or unknown zone falls back to UTC rather than counting nothing", () => {
    const base = {
      stats: { firstShowAt: null, checkedInAvg: null },
      pastEventEnds: [d("2026-02-01T04:00:00Z")],
      now: NOW,
    };
    expect(
      deriveTrackRecordView({ ...base, timeZone: null }).showsThisYear,
    ).toBe(1);
    expect(
      deriveTrackRecordView({ ...base, timeZone: "Not/AZone" }).showsThisYear,
    ).toBe(1);
  });

  it("showsThisYear ignores shows that have not ended", () => {
    expect(
      deriveTrackRecordView({
        stats: { firstShowAt: null, checkedInAvg: null },
        pastEventEnds: [d("2026-02-01T04:00:00Z"), d("2026-12-01T04:00:00Z")],
        now: NOW,
        timeZone: "UTC",
      }).showsThisYear,
    ).toBe(1);
  });

  it("assembles all five derivations from stats + ends", () => {
    const view = deriveTrackRecordView({
      stats: { firstShowAt: d("2024-03-10T04:00:00Z"), checkedInAvg: 120 },
      pastEventEnds: [
        d("2026-09-01T04:00:00Z"),
        d("2026-09-08T04:00:00Z"),
        d("2026-09-15T04:00:00Z"),
      ],
      now: NOW,
      timeZone: "America/New_York",
    });
    expect(view).toEqual({
      showsThisYear: 3,
      yearsRunning: 2.5,
      cadence: "weekly",
      cadenceSince: d("2026-09-01T04:00:00Z"),
      attendanceBand: "100_to_300",
    });
  });
});
