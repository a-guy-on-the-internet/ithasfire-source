import { describe, expect, it } from "vitest";

import {
  analyzeSeriesSchedule,
  nthOfMonth,
} from "../src/scripts/backfill/done/series-rrule-local-basis";

// ── Anchors ──────────────────────────────────────────────────────────────
//
// Fri 2026-09-04 20:00 America/Chicago == 2026-09-05T01:00Z, a SATURDAY in
// UTC. shift = 1. Under the OLD basis the builder stored BYDAY=SA for this
// series; under the new one it stores BYDAY=FR.
const EVENING_DTSTART = "2026-09-05T01:00:00.000Z";
const CHICAGO = "America/Chicago";

// Fri 2026-09-04 09:00 America/Chicago == 2026-09-04T14:00Z — same calendar
// day in both readings. shift = 0.
const DAYTIME_DTSTART = "2026-09-04T14:00:00.000Z";

// Fri 2026-07-31 20:00 America/Chicago == 2026-08-01T01:00Z. The local month
// (July, LAST Friday) and the UTC month (August, FIRST Saturday) differ, so
// the ordinal shifts as well as the day.
const MONTH_BOUNDARY_DTSTART = "2026-08-01T01:00:00.000Z";

// Mon 2026-09-14 09:00 Australia/Sydney == 2026-09-13T23:00Z, a SUNDAY in
// UTC. shift = 6 — the mirror image of the US-evening case.
const SYDNEY_DTSTART = "2026-09-13T23:00:00.000Z";
const SYDNEY = "Australia/Sydney";

function rrule(schedule: {
  rrule?: string | null;
  dtstart?: string | null;
  kind?: string;
}) {
  return {
    kind: "RRULE",
    until: null,
    dates: null,
    windowStart: null,
    windowEnd: null,
    maxOccurrencesPerExpand: 100,
    ...schedule,
  };
}

describe("nthOfMonth", () => {
  it("returns the position among same-weekday days, -1 when final", () => {
    // Fridays of Sep 2026: 4, 11, 18, 25.
    expect(nthOfMonth(2026, 8, 4)).toBe(1);
    expect(nthOfMonth(2026, 8, 11)).toBe(2);
    expect(nthOfMonth(2026, 8, 25)).toBe(-1); // 25 + 7 > 30
    // Fri Jul 31 2026 is the last Friday of a 31-day month.
    expect(nthOfMonth(2026, 6, 31)).toBe(-1);
  });
});

describe("analyzeSeriesSchedule — WEEKLY", () => {
  it("rewrites an old-basis evening rule back to the local day", () => {
    const result = analyzeSeriesSchedule({
      schedule: rrule({
        rrule: "FREQ=WEEKLY;BYDAY=SA;COUNT=12",
        dtstart: EVENING_DTSTART,
      }),
      timezone: CHICAGO,
    });

    expect(result).toEqual({
      kind: "needs-migration",
      from: "FREQ=WEEKLY;BYDAY=SA;COUNT=12",
      to: "FREQ=WEEKLY;BYDAY=FR;COUNT=12",
      shift: 1,
    });
  });

  it("is IDEMPOTENT: the rewritten rule reads as already-local", () => {
    const first = analyzeSeriesSchedule({
      schedule: rrule({
        rrule: "FREQ=WEEKLY;BYDAY=SA;COUNT=12",
        dtstart: EVENING_DTSTART,
      }),
      timezone: CHICAGO,
    });
    expect(first.kind).toBe("needs-migration");
    const migrated = first.kind === "needs-migration" ? first.to : "";

    const second = analyzeSeriesSchedule({
      schedule: rrule({ rrule: migrated, dtstart: EVENING_DTSTART }),
      timezone: CHICAGO,
    });
    expect(second).toEqual({ kind: "already-local" });
  });

  it("leaves a shift-0 (daytime) row untouched, whatever its token says", () => {
    // Both bases name Friday here, so there is nothing to decide and nothing
    // to rewrite — the unambiguous case.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;BYDAY=FR;COUNT=12",
          dtstart: DAYTIME_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toEqual({ kind: "no-shift" });
  });

  it("handles a POSITIVE-offset shift (Sydney morning, shift 6)", () => {
    // Old basis stored the UTC anchor SU for a local Monday.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;BYDAY=SU",
          dtstart: SYDNEY_DTSTART,
        }),
        timezone: SYDNEY,
      }),
    ).toEqual({
      kind: "needs-migration",
      from: "FREQ=WEEKLY;BYDAY=SU",
      to: "FREQ=WEEKLY;BYDAY=MO",
      shift: 6,
    });
  });

  it("shifts EVERY token of a multi-day rule and keeps RRULE weekday order", () => {
    // Old basis SA,TU  ->  local FR,MO, emitted in Monday-first order.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,TU;COUNT=8",
          dtstart: EVENING_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({
      kind: "needs-migration",
      to: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=8",
    });
  });

  it("preserves parts it does not understand, verbatim and in order", () => {
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;WKST=SU;BYDAY=SA;COUNT=3",
          dtstart: EVENING_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ to: "FREQ=WEEKLY;WKST=SU;BYDAY=FR;COUNT=3" });
  });
});

describe("analyzeSeriesSchedule — MONTHLY BYSETPOS", () => {
  it("moves BYDAY and BYSETPOS together across a month boundary", () => {
    // Local: last Friday of July (-1). UTC: first Saturday of August (1).
    // Rewriting BYDAY alone would leave BYSETPOS=1 on FR and build a rule
    // that does not contain the event's own start.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=MONTHLY;BYDAY=SA;BYSETPOS=1;COUNT=6",
          dtstart: MONTH_BOUNDARY_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toEqual({
      kind: "needs-migration",
      from: "FREQ=MONTHLY;BYDAY=SA;BYSETPOS=1;COUNT=6",
      to: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=6",
      shift: 1,
    });
  });

  it("moves BYSETPOS when the ordinal changes but the month does not", () => {
    // Fri Sep 4 (1st local Friday) is Sat Sep 5 in UTC — also the 1st
    // Saturday, so the ordinal happens to match; the DAY still moves.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=MONTHLY;BYDAY=SA;BYSETPOS=1",
          dtstart: EVENING_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ to: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=1" });
  });

  it("is idempotent for MONTHLY too", () => {
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=6",
          dtstart: MONTH_BOUNDARY_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toEqual({ kind: "already-local" });
  });

  it("refuses a half-migrated rule instead of guessing", () => {
    // BYDAY still reads old-basis (SA) but BYSETPOS is already the LOCAL
    // ordinal (-1), not the UTC one (1). Rewriting would be a guess.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=MONTHLY;BYDAY=SA;BYSETPOS=-1",
          dtstart: MONTH_BOUNDARY_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ kind: "ambiguous" });
  });
});

describe("analyzeSeriesSchedule — skips and refusals", () => {
  it("skips FIXED_DATES and rows with no rule", () => {
    expect(
      analyzeSeriesSchedule({
        schedule: { kind: "FIXED_DATES", dates: ["2026-09-04T20:00:00"] },
        timezone: CHICAGO,
      }).kind,
    ).toBe("not-applicable");
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({ rrule: null, dtstart: EVENING_DTSTART }),
        timezone: CHICAGO,
      }).kind,
    ).toBe("not-applicable");
  });

  it("REFUSES a bare wall-clock dtstart instead of reporting it clean", () => {
    // `new Date("2026-09-04T20:00:00")` is valid and resolves in the SCRIPT
    // PROCESS's zone, not the series'. On a UTC host this old-basis row read
    // as Friday in both calendars, came out shift 0, and was bucketed as
    // "no shift — nothing to do" while staying broken. A migration must never
    // declare a broken row safe, so a dtstart with no offset is surfaced.
    const result = analyzeSeriesSchedule({
      schedule: rrule({
        rrule: "FREQ=WEEKLY;BYDAY=SA",
        dtstart: "2026-09-04T20:00:00",
      }),
      timezone: CHICAGO,
    });
    expect(result.kind).toBe("unreadable");
    expect(result.kind === "unreadable" && result.reason).toContain(
      "no UTC offset",
    );
  });

  it("accepts a non-Z offset form", () => {
    // Fri 2026-09-04 20:00 -05:00 is the same instant as EVENING_DTSTART.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;BYDAY=SA",
          dtstart: "2026-09-04T20:00:00-05:00",
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ kind: "needs-migration", to: "FREQ=WEEKLY;BYDAY=FR" });
  });

  it("REFUSES BYSETPOS with a multi-day BYDAY (selection is over the union)", () => {
    // BYSETPOS picks within the month's union of ALL BYDAY matches, so
    // shifting each member and swapping in the anchor's ordinal is not
    // meaning-preserving and can drop the event's own start.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1",
          dtstart: EVENING_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ kind: "ambiguous" });
  });

  it("flags a shift-0 rule that does not contain its own anchor day", () => {
    // Nothing to rewrite, but "clean" would be the wrong report.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
          dtstart: DAYTIME_DTSTART, // a Friday, shift 0
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ kind: "ambiguous" });
  });

  it("a shift-0 bare FREQ=MONTHLY has no drift to report", () => {
    // Same calendar date in both readings ⇒ same day-of-month.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({ rrule: "FREQ=MONTHLY", dtstart: DAYTIME_DTSTART }),
        timezone: CHICAGO,
      }),
    ).toEqual({ kind: "no-shift" });
  });

  it("reports an unreadable dtstart or timezone rather than skipping silently", () => {
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({ rrule: "FREQ=WEEKLY;BYDAY=SA", dtstart: "nope" }),
        timezone: CHICAGO,
      }).kind,
    ).toBe("unreadable");
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;BYDAY=SA",
          dtstart: EVENING_DTSTART,
        }),
        timezone: "Mars/Olympus_Mons",
      }).kind,
    ).toBe("unreadable");
  });

  it("flags a BYDAY carrying BOTH anchors as ambiguous", () => {
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;BYDAY=FR,SA",
          dtstart: EVENING_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ kind: "ambiguous" });
  });

  it("flags a BYDAY carrying NEITHER anchor as ambiguous", () => {
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
          dtstart: EVENING_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ kind: "ambiguous" });
  });

  it("flags an nth-prefixed BYDAY (2SA) as ambiguous rather than rewriting it", () => {
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=MONTHLY;BYDAY=2SA",
          dtstart: EVENING_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ kind: "ambiguous" });
  });

  it("surfaces a bare FREQ=MONTHLY as anchor-only drift (nothing to rewrite)", () => {
    // Repeats on dtstart's day-of-month: local the 31st, UTC the 1st. Real
    // drift, but the rule string carries no token to fix.
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=MONTHLY",
          dtstart: MONTH_BOUNDARY_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toMatchObject({ kind: "anchor-only" });
  });

  it("treats DAILY / bare WEEKLY as unaffected — both bases step from dtstart", () => {
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({ rrule: "FREQ=DAILY", dtstart: EVENING_DTSTART }),
        timezone: CHICAGO,
      }),
    ).toEqual({ kind: "already-local" });
    expect(
      analyzeSeriesSchedule({
        schedule: rrule({
          rrule: "FREQ=WEEKLY;INTERVAL=2",
          dtstart: EVENING_DTSTART,
        }),
        timezone: CHICAGO,
      }),
    ).toEqual({ kind: "already-local" });
  });
});
