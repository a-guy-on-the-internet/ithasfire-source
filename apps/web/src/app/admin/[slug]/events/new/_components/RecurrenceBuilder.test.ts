import { describe, expect, it, vi } from "vitest";

// Tests import the REAL pure helpers behind the RecurrenceBuilder (extracted
// to recurrence-helpers.ts so this suite stays free of React/Tamagui) — no
// mirrored local copies.
import {
  WEEKDAYS,
  buildConfigFromState,
  buildRrule,
  classifyRule,
  configsEqual,
  dayOfWeekFromIso,
  defaultBuilderState,
  degradeMonthlySelection,
  deriveStateFromValue,
  enumerateOccurrences,
  isWeekdayPinned,
  lastOccurrence,
  localCalendarWeekday,
  localMonthlyNth,
  monthlyNthForSchedule,
  monthlyPresetLocalOrdinal,
  parseRrule,
  reconcileWindowEndForConfig,
  rruleHasCount,
  startWeekdayForSchedule,
  toggleWeekday,
  untilIsoForLocalDate,
  withCount,
  withStartDayIncluded,
  type BuilderState,
  type DeriveContext,
  type RecurrenceRule,
  type Weekday,
} from "./recurrence-helpers";

// ───────────────────────────────────────────────────────────────────────────
// buildRrule — every emittable shape
// ───────────────────────────────────────────────────────────────────────────

describe("buildRrule", () => {
  it("weekly preset: FREQ=WEEKLY;BYDAY=XX", () => {
    expect(buildRrule({ freq: "WEEKLY", byday: ["FR"] })).toBe(
      "FREQ=WEEKLY;BYDAY=FR",
    );
  });

  it("biweekly preset: FREQ=WEEKLY;INTERVAL=2;BYDAY=XX", () => {
    expect(buildRrule({ freq: "WEEKLY", interval: 2, byday: ["SA"] })).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA",
    );
  });

  it("monthly nth preset: FREQ=MONTHLY;BYDAY=XX;BYSETPOS=n", () => {
    expect(
      buildRrule({ freq: "MONTHLY", byday: ["SA"], bysetpos: 2 }),
    ).toBe("FREQ=MONTHLY;BYDAY=SA;BYSETPOS=2");
  });

  it("monthly last preset: BYSETPOS=-1", () => {
    expect(
      buildRrule({ freq: "MONTHLY", byday: ["FR"], bysetpos: -1 }),
    ).toBe("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1");
  });

  it("custom daily interval: FREQ=DAILY;INTERVAL=N", () => {
    expect(buildRrule({ freq: "DAILY", interval: 3 })).toBe(
      "FREQ=DAILY;INTERVAL=3",
    );
  });

  it("custom plain monthly interval: FREQ=MONTHLY;INTERVAL=N", () => {
    expect(buildRrule({ freq: "MONTHLY", interval: 3 })).toBe(
      "FREQ=MONTHLY;INTERVAL=3",
    );
  });

  it("COUNT rides last: FREQ;INTERVAL;BYDAY;COUNT order", () => {
    expect(
      buildRrule({
        freq: "WEEKLY",
        interval: 5,
        byday: ["TU", "TH"],
        count: 10,
      }),
    ).toBe("FREQ=WEEKLY;INTERVAL=5;BYDAY=TU,TH;COUNT=10");
  });

  it("BYSETPOS with COUNT keeps canonical order", () => {
    expect(
      buildRrule({ freq: "MONTHLY", byday: ["FR"], bysetpos: -1, count: 12 }),
    ).toBe("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=12");
  });

  it("omits INTERVAL when 1 (legacy-compatible strings)", () => {
    expect(buildRrule({ freq: "WEEKLY", interval: 1, byday: ["MO"] })).toBe(
      "FREQ=WEEKLY;BYDAY=MO",
    );
  });

  it("normalizes BYDAY to RRULE weekday order", () => {
    expect(buildRrule({ freq: "WEEKLY", byday: ["FR", "MO", "WE"] })).toBe(
      "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    );
  });

  it("ignores byday for DAILY", () => {
    expect(buildRrule({ freq: "DAILY", byday: ["MO"] })).toBe("FREQ=DAILY");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// parseRrule — round-trips + rejection of the unrepresentable
// ───────────────────────────────────────────────────────────────────────────

describe("parseRrule", () => {
  const roundTrips: Array<[string, RecurrenceRule]> = [
    [
      "FREQ=WEEKLY;BYDAY=FR",
      { freq: "WEEKLY", interval: 1, byday: ["FR"], bysetpos: null, count: null },
    ],
    [
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA",
      { freq: "WEEKLY", interval: 2, byday: ["SA"], bysetpos: null, count: null },
    ],
    [
      "FREQ=WEEKLY;INTERVAL=5;BYDAY=TU,TH;COUNT=10",
      { freq: "WEEKLY", interval: 5, byday: ["TU", "TH"], bysetpos: null, count: 10 },
    ],
    [
      "FREQ=DAILY;INTERVAL=3",
      { freq: "DAILY", interval: 3, byday: [], bysetpos: null, count: null },
    ],
    [
      "FREQ=MONTHLY;BYDAY=SA;BYSETPOS=2",
      { freq: "MONTHLY", interval: 1, byday: ["SA"], bysetpos: 2, count: null },
    ],
    [
      "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=12",
      { freq: "MONTHLY", interval: 1, byday: ["FR"], bysetpos: -1, count: 12 },
    ],
    [
      "FREQ=MONTHLY;INTERVAL=3",
      { freq: "MONTHLY", interval: 3, byday: [], bysetpos: null, count: null },
    ],
    // Legacy builder shapes
    [
      "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      { freq: "WEEKLY", interval: 1, byday: ["MO", "WE", "FR"], bysetpos: null, count: null },
    ],
    [
      "FREQ=DAILY",
      { freq: "DAILY", interval: 1, byday: [], bysetpos: null, count: null },
    ],
    [
      "FREQ=MONTHLY",
      { freq: "MONTHLY", interval: 1, byday: [], bysetpos: null, count: null },
    ],
  ];

  it.each(roundTrips)("parses %s", (rrule, expected) => {
    expect(parseRrule(rrule)).toEqual(expected);
  });

  it.each(roundTrips)("build(parse(%s)) is string-stable", (rrule) => {
    const parsed = parseRrule(rrule)!;
    expect(buildRrule(parsed)).toBe(rrule);
  });

  it.each([
    "FREQ=YEARLY",
    "FREQ=MONTHLY;BYDAY=2SA", // nth-prefixed BYDAY
    "FREQ=WEEKLY;UNTIL=20261231T000000Z", // embedded UNTIL
    "FREQ=MONTHLY;BYMONTHDAY=15",
    "FREQ=WEEKLY;BYSETPOS=2", // BYSETPOS outside MONTHLY
    "FREQ=MONTHLY;BYDAY=FR", // monthly BYDAY without BYSETPOS
    "FREQ=MONTHLY;BYSETPOS=2", // BYSETPOS without BYDAY
    "FREQ=MONTHLY;BYDAY=FR,SA;BYSETPOS=1", // multi-day nth
    "FREQ=WEEKLY;COUNT=abc",
    "FREQ=WEEKLY;INTERVAL=0",
    "FREQ=WEEKLY;FREQ=DAILY", // duplicate key
    "FREQ=WEEKLY;BYSETPOS=7",
    "banana",
    "",
  ])("returns null for unrepresentable rule %s", (rrule) => {
    expect(parseRrule(rrule)).toBeNull();
  });
});

describe("rruleHasCount / withCount", () => {
  it("detects COUNT anywhere in the string", () => {
    expect(rruleHasCount("FREQ=WEEKLY;COUNT=5;BYDAY=FR")).toBe(true);
    expect(rruleHasCount("FREQ=WEEKLY;BYDAY=FR")).toBe(false);
  });

  it("appends COUNT to a rule without one", () => {
    expect(withCount("FREQ=WEEKLY;BYDAY=FR", 8)).toBe(
      "FREQ=WEEKLY;BYDAY=FR;COUNT=8",
    );
  });

  it("replaces a mid-string COUNT (moves it to the tail)", () => {
    expect(withCount("FREQ=WEEKLY;COUNT=5;BYDAY=FR", 8)).toBe(
      "FREQ=WEEKLY;BYDAY=FR;COUNT=8",
    );
  });

  it("removes COUNT when null", () => {
    expect(withCount("FREQ=WEEKLY;BYDAY=FR;COUNT=5", null)).toBe(
      "FREQ=WEEKLY;BYDAY=FR",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// enumerateOccurrences — UTC parity with the backend
// ───────────────────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString();

// These exercise the NO-`eventTimezone` branch, which drives `rrule` on the
// instants as given (the pre-timezone behaviour). They are kept because that
// branch still exists as a defensive fallback for callers with no event
// timezone — NOT because the backend works this way. It does not: it now
// evaluates in the event timezone. The zone-aware behaviour, which is what
// every real caller gets, is pinned in "parity with the server expansion" and
// "the ambiguous fall-back hour" below.
describe("enumerateOccurrences — no-timezone fallback branch", () => {
  it("weekly COUNT=3 enumerates exactly three instants from dtstart", () => {
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;BYDAY=SA;COUNT=3",
      "2026-08-08T01:00:00.000Z",
    );
    expect(out.map(iso)).toEqual([
      "2026-08-08T01:00:00.000Z",
      "2026-08-15T01:00:00.000Z",
      "2026-08-22T01:00:00.000Z",
    ]);
  });

  it("biweekly until-bounded stops at the (inclusive) until instant", () => {
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA",
      "2026-08-08T01:00:00.000Z",
      "2026-09-30T23:59:59.000Z",
    );
    expect(out.map(iso)).toEqual([
      "2026-08-08T01:00:00.000Z",
      "2026-08-22T01:00:00.000Z",
      "2026-09-05T01:00:00.000Z",
      "2026-09-19T01:00:00.000Z",
    ]);
  });

  it("monthly BYSETPOS=-1 tracks the last Friday across 4- and 5-Friday months", () => {
    // Jan 2026 has five Fridays (last: 30th); Feb–Apr have four; May has
    // five again (last: 29th). BYSETPOS=-1 must land on the FINAL Friday of
    // each month regardless of how many there are.
    const out = enumerateOccurrences(
      "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=5",
      "2026-01-30T18:00:00.000Z",
    );
    expect(out.map(iso)).toEqual([
      "2026-01-30T18:00:00.000Z",
      "2026-02-27T18:00:00.000Z",
      "2026-03-27T18:00:00.000Z",
      "2026-04-24T18:00:00.000Z",
      "2026-05-29T18:00:00.000Z",
    ]);
  });

  it("with NO timezone, UTC instants stay fixed across a DST transition", () => {
    // Pins the fallback branch only. Given no zone to evaluate in, the UTC
    // instant is held and the local wall clock drifts an hour across the
    // Nov 1 2026 fall-back (8pm CDT -> 7pm CST).
    //
    // This is NOT what the product does. Pass `eventTimezone` — as every real
    // caller now does — and the LOCAL hour is held instead and the UTC instant
    // moves, matching the server. See the fall-back test in "parity with the
    // server expansion".
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;BYDAY=SA;COUNT=4",
      "2026-10-24T01:00:00.000Z",
    );
    expect(out.map(iso)).toEqual([
      "2026-10-24T01:00:00.000Z",
      "2026-10-31T01:00:00.000Z",
      "2026-11-07T01:00:00.000Z", // = Fri Nov 6, 7:00pm CST (was 8:00pm CDT)
      "2026-11-14T01:00:00.000Z",
    ]);
  });

  it("with NO timezone, a UTC-ordinal monthly rule still contains its own dtstart", () => {
    // Self-consistency of the fallback branch: read purely in UTC, Sat Aug 1
    // 01:00Z is the first Saturday of the UTC August, so BYSETPOS=1 on SA
    // includes it.
    //
    // This shape is the LEGACY one and the builder no longer emits it. That
    // same show is now stored as the local `BYDAY=FR;BYSETPOS=-1` ("last
    // Friday of July"), and rules still carrying the old shape are rewritten
    // by apps/api/src/scripts/backfill/done/migrate-series-rrule-local-basis.ts. Do not read
    // this test as a reason to emit a UTC ordinal.
    const out = enumerateOccurrences(
      "FREQ=MONTHLY;BYDAY=SA;BYSETPOS=1;COUNT=2",
      "2026-08-01T01:00:00.000Z",
    );
    expect(out[0] && iso(out[0])).toBe("2026-08-01T01:00:00.000Z");
  });

  it("caps unbounded rules at the enumeration cap", () => {
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;BYDAY=SA",
      "2026-08-08T01:00:00.000Z",
      undefined,
      7,
    );
    expect(out).toHaveLength(7);
  });

  it("returns [] for invalid rules or dates", () => {
    expect(
      enumerateOccurrences("banana", "2026-08-08T01:00:00.000Z"),
    ).toEqual([]);
    expect(enumerateOccurrences("FREQ=WEEKLY;BYDAY=SA", "not-a-date")).toEqual(
      [],
    );
  });
});

describe("lastOccurrence", () => {
  it("returns the final instant of a COUNT-bounded config", () => {
    expect(
      lastOccurrence({
        rrule: "FREQ=WEEKLY;BYDAY=SA;COUNT=3",
        dtstart: "2026-08-08T01:00:00.000Z",
      }),
    ).toBe("2026-08-22T01:00:00.000Z");
  });

  it("respects an until bound", () => {
    expect(
      lastOccurrence({
        rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA",
        dtstart: "2026-08-08T01:00:00.000Z",
        until: "2026-09-30T23:59:59.000Z",
      }),
    ).toBe("2026-09-19T01:00:00.000Z");
  });

  it("returns null when nothing enumerates", () => {
    expect(
      lastOccurrence({ rrule: "banana", dtstart: "2026-08-08T01:00:00.000Z" }),
    ).toBeNull();
  });
});

describe("reconcileWindowEndForConfig", () => {
  const dtstart = "2026-08-08T01:00:00.000Z";

  it("uses until when present (existing behavior)", () => {
    expect(
      reconcileWindowEndForConfig({
        rrule: "FREQ=WEEKLY;BYDAY=SA",
        dtstart,
        until: "2026-09-30T23:59:59.000Z",
      }),
    ).toBe("2026-09-30T23:59:59.000Z");
  });

  it("uses the final enumerated occurrence for COUNT configs (NOT dtstart)", () => {
    expect(
      reconcileWindowEndForConfig({
        rrule: "FREQ=WEEKLY;BYDAY=SA;COUNT=3",
        dtstart,
      }),
    ).toBe("2026-08-22T01:00:00.000Z");
  });

  it("falls back to dtstart when neither bound exists", () => {
    expect(
      reconcileWindowEndForConfig({ rrule: "FREQ=WEEKLY;BYDAY=SA", dtstart }),
    ).toBe(dtstart);
  });

  it("falls back to dtstart when a COUNT rule cannot be enumerated", () => {
    expect(
      reconcileWindowEndForConfig({ rrule: "banana;COUNT=3", dtstart }),
    ).toBe(dtstart);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Preset derivation — token basis (UTC) vs label basis (local)
// ───────────────────────────────────────────────────────────────────────────

describe("startWeekdayForSchedule", () => {
  // ONE basis: the wall clock in the EVENT timezone decides the calendar
  // day. A browser-local parse would drift for cross-timezone editors.

  it("an evening show keeps its LOCAL day (Nashville Friday 20:00 -> FR)", () => {
    // The regression this suite exists for. Under the old UTC basis this
    // emitted SA, and the fixed backend would then put the series on
    // Saturdays. 2025-01-10 is a Friday.
    expect(startWeekdayForSchedule("2025-01-10T20:00", "America/Chicago")).toBe(
      "FR",
    );
  });

  it("a daytime show is unaffected (Nashville Friday 09:00 -> FR)", () => {
    expect(startWeekdayForSchedule("2025-01-10T09:00", "America/Chicago")).toBe(
      "FR",
    );
  });

  it("a positive-offset morning keeps its local day too (Tokyo Friday 08:00 -> FR)", () => {
    // Under the old basis this was TH (07:00 Thursday UTC).
    expect(startWeekdayForSchedule("2025-01-10T08:00", "Asia/Tokyo")).toBe(
      "FR",
    );
  });

  it("resolves a zone-qualified instant INTO the event timezone", () => {
    // 2026-09-05T01:00Z is Fri Sep 4 20:00 in Chicago — FR, not SA.
    expect(
      startWeekdayForSchedule("2026-09-05T01:00:00.000Z", "America/Chicago"),
    ).toBe("FR");
  });

  it("falls back to UTC fields when no timezone is given", () => {
    expect(startWeekdayForSchedule("2025-01-10T12:00:00.000Z")).toBe("FR");
  });

  it("returns null for an empty start", () => {
    expect(startWeekdayForSchedule("", "America/Chicago")).toBeNull();
  });
});

describe("monthlyNthForSchedule", () => {
  it("computes the ordinal from the LOCAL month", () => {
    // Fri Aug 14 2026, 9:00 Chicago. Fridays of Aug 2026: 7, 14, 21, 28 ->
    // the 14th is the 2nd.
    expect(monthlyNthForSchedule("2026-08-14T09:00", "America/Chicago")).toBe(
      2,
    );
  });

  it("an evening show keeps its LOCAL ordinal", () => {
    // Fri Aug 7 2026, 20:00 Chicago is the FIRST local Friday. The old UTC
    // basis called this 2 (2nd Saturday of August).
    expect(monthlyNthForSchedule("2026-08-07T20:00", "America/Chicago")).toBe(
      1,
    );
  });

  it("returns -1 for the final such weekday (5th-Friday month)", () => {
    expect(monthlyNthForSchedule("2026-05-29T09:00", "America/Chicago")).toBe(
      -1,
    );
  });

  it("returns -1 for a 4th-and-final weekday (per the approved design, last wins)", () => {
    expect(monthlyNthForSchedule("2026-04-24T09:00", "America/Chicago")).toBe(
      -1,
    );
  });

  it("a non-final middle weekday keeps its ordinal", () => {
    expect(monthlyNthForSchedule("2026-05-15T09:00", "America/Chicago")).toBe(
      3,
    );
  });

  it("month-boundary case: local last-Friday-of-July stays -1, NOT the UTC month's 1", () => {
    // Fri Jul 31 2026, 20:00 Chicago is UTC Sat Aug 1. The old basis emitted
    // ordinal 1 (first Saturday of the UTC month); the local basis emits -1
    // (last Friday of July), which is what "Monthly on the last Friday" says
    // and what the fixed backend now expands.
    expect(monthlyNthForSchedule("2026-07-31T20:00", "America/Chicago")).toBe(
      -1,
    );
  });

  it("returns null for an empty or invalid start", () => {
    expect(monthlyNthForSchedule("", "America/Chicago")).toBeNull();
    expect(monthlyNthForSchedule("not-a-date")).toBeNull();
  });
});

describe("localCalendarWeekday / localMonthlyNth agree with the emitted token", () => {
  it("the label day and the emitted token are the SAME day for an evening show", () => {
    // Nashville Friday-8pm show: both FR. These used to disagree (FR vs SA).
    expect(localCalendarWeekday("2026-08-07T20:00")).toBe("FR");
    expect(startWeekdayForSchedule("2026-08-07T20:00", "America/Chicago")).toBe(
      "FR",
    );
  });

  it("the label ordinal and the emitted ordinal match too", () => {
    expect(localMonthlyNth("2026-08-07T20:00")).toBe(1);
    expect(monthlyNthForSchedule("2026-08-07T20:00", "America/Chicago")).toBe(
      1,
    );
  });

  it("the old month-boundary divergence is gone", () => {
    // Local last Friday of July was the UTC first Saturday of August.
    expect(localCalendarWeekday("2026-07-31T20:00")).toBe("FR");
    expect(localMonthlyNth("2026-07-31T20:00")).toBe(-1);
    expect(startWeekdayForSchedule("2026-07-31T20:00", "America/Chicago")).toBe(
      "FR",
    );
    expect(monthlyNthForSchedule("2026-07-31T20:00", "America/Chicago")).toBe(
      -1,
    );
  });

  it("returns null for malformed input", () => {
    expect(localCalendarWeekday("")).toBeNull();
    expect(localCalendarWeekday("garbage")).toBeNull();
    expect(localMonthlyNth("")).toBeNull();
    expect(localMonthlyNth("2026-13")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// classifyRule — select prefill from a stored rule
// ───────────────────────────────────────────────────────────────────────────

describe("classifyRule", () => {
  const rule = (partial: Partial<RecurrenceRule>): RecurrenceRule => ({
    freq: "WEEKLY",
    interval: 1,
    byday: [],
    bysetpos: null,
    count: null,
    ...partial,
  });

  it("weekly-on-start-day → WEEKLY preset", () => {
    expect(classifyRule(rule({ byday: ["SA"] }), "SA", 2)).toBe("WEEKLY");
  });

  it("interval-2 weekly on start day → BIWEEKLY preset", () => {
    expect(classifyRule(rule({ interval: 2, byday: ["SA"] }), "SA", 2)).toBe(
      "BIWEEKLY",
    );
  });

  it("COUNT does not disqualify a preset (Ends chooser is orthogonal)", () => {
    expect(classifyRule(rule({ byday: ["SA"], count: 12 }), "SA", 2)).toBe(
      "WEEKLY",
    );
  });

  it("monthly nth matching the start ordinal → MONTHLY_NTH", () => {
    expect(
      classifyRule(
        rule({ freq: "MONTHLY", byday: ["SA"], bysetpos: 2 }),
        "SA",
        2,
      ),
    ).toBe("MONTHLY_NTH");
  });

  it("monthly nth NOT matching the start ordinal → CUSTOM", () => {
    expect(
      classifyRule(
        rule({ freq: "MONTHLY", byday: ["SA"], bysetpos: 3 }),
        "SA",
        2,
      ),
    ).toBe("CUSTOM");
  });

  it("multi-day weekly → CUSTOM", () => {
    expect(classifyRule(rule({ byday: ["FR", "SA"] }), "SA", 2)).toBe(
      "CUSTOM",
    );
  });

  it("weekly on a different day than start → CUSTOM", () => {
    expect(classifyRule(rule({ byday: ["MO"] }), "SA", 2)).toBe("CUSTOM");
  });

  it("unparseable rule (null) → CUSTOM", () => {
    expect(classifyRule(null, "SA", 2)).toBe("CUSTOM");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Legacy helpers retained by the custom panel
// ───────────────────────────────────────────────────────────────────────────

describe("withStartDayIncluded", () => {
  it("re-inserts the start day in RRULE weekday order when excluded", () => {
    expect(withStartDayIncluded(["MO", "FR"], "WE")).toEqual([
      "MO",
      "WE",
      "FR",
    ]);
  });

  it("returns the set untouched when the start day is already selected", () => {
    expect(withStartDayIncluded(["MO", "WE"], "WE")).toEqual(["MO", "WE"]);
  });

  it("leaves an empty set alone (BYDAY omitted expands on dtstart weekday)", () => {
    expect(withStartDayIncluded([], "WE")).toEqual([]);
  });

  it("is a no-op without a start day", () => {
    expect(withStartDayIncluded(["MO"], null)).toEqual(["MO"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// isWeekdayPinned / toggleWeekday — the "can't deselect Wednesday" contract
// ───────────────────────────────────────────────────────────────────────────

describe("isWeekdayPinned", () => {
  it("pins the start weekday while it is selected", () => {
    expect(isWeekdayPinned("WE", ["MO", "WE"], "WE")).toBe(true);
  });

  it("never pins a non-start weekday", () => {
    expect(isWeekdayPinned("MO", ["MO", "WE"], "WE")).toBe(false);
  });

  it("pins nothing when the set is empty (BYDAY is omitted entirely)", () => {
    expect(isWeekdayPinned("WE", [], "WE")).toBe(false);
  });

  it("pins nothing without a start day", () => {
    expect(isWeekdayPinned("WE", ["WE"], null)).toBe(false);
  });
});

describe("toggleWeekday", () => {
  it("adds a weekday in RRULE order", () => {
    expect(toggleWeekday(["WE"], "MO", "WE")).toEqual(["MO", "WE"]);
    expect(toggleWeekday(["MO", "WE"], "SU", "WE")).toEqual(["MO", "WE", "SU"]);
  });

  it("removes a NON-start weekday", () => {
    expect(toggleWeekday(["MO", "WE", "FR"], "FR", "WE")).toEqual(["MO", "WE"]);
  });

  it("refuses to remove the start weekday, returning the same reference", () => {
    const days: Weekday[] = ["MO", "WE"];
    expect(toggleWeekday(days, "WE", "WE")).toBe(days);
  });

  it("floors at the start weekday when everything else is removed", () => {
    let days: Weekday[] = ["MO", "WE", "FR"];
    for (const day of WEEKDAYS) days = toggleWeekday(days, day, "WE");
    // MO/FR came off, the untouched days went ON, WE never moved — a second
    // sweep drains the newly-added ones and WE is the floor.
    for (const day of WEEKDAYS) {
      if (days.includes(day)) days = toggleWeekday(days, day, "WE");
    }
    expect(days).toEqual(["WE"]);
  });

  it("allows an empty set when there is no start day", () => {
    expect(toggleWeekday(["MO"], "MO", null)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// untilIsoForLocalDate — event-tz end-of-day bound (BLOCKING-1 regression)
// ───────────────────────────────────────────────────────────────────────────

describe("untilIsoForLocalDate", () => {
  it("interprets the picked date's end-of-day in the EVENT timezone", () => {
    // Nov 6 2026 is CST (UTC-6, post fall-back): 23:59 local = 05:59Z next day.
    expect(untilIsoForLocalDate("2026-11-06", "America/Chicago")).toBe(
      "2026-11-07T05:59:00.000Z",
    );
  });

  it("falls back to UTC end-of-day without a timezone", () => {
    expect(untilIsoForLocalDate("2026-11-06")).toBe(
      "2026-11-06T23:59:59.000Z",
    );
  });

  it("evening-show series: picking the last show's LOCAL date includes it", () => {
    // Nashville Fri-8pm weekly series = Sat-01:00Z instants. The Nov-7-01:00Z
    // show happens Fri Nov 6 locally; picking "2026-11-06" as the end must
    // include it.
    const until = untilIsoForLocalDate("2026-11-06", "America/Chicago");
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;BYDAY=SA",
      "2026-10-24T01:00:00.000Z",
      until,
    );
    expect(out.map(iso)).toContain("2026-11-07T01:00:00.000Z");
    expect(out.map(iso)[out.length - 1]).toBe("2026-11-07T01:00:00.000Z");
  });

  it("regression: a UTC end-of-day bound would EXCLUDE that same show", () => {
    // This is the bug the event-tz bound fixes — pinned so nobody "simplifies"
    // it back.
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;BYDAY=SA",
      "2026-10-24T01:00:00.000Z",
      "2026-11-06T23:59:59.000Z",
    );
    expect(out.map(iso)).not.toContain("2026-11-07T01:00:00.000Z");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// monthlyPresetLocalOrdinal — the label must describe what the rule DOES
// ───────────────────────────────────────────────────────────────────────────

describe("monthlyPresetLocalOrdinal", () => {
  it("returns the local ordinal for a daytime show (2nd Friday)", () => {
    expect(
      monthlyPresetLocalOrdinal({
        dtstartIso: "2026-08-14T14:00:00.000Z",
        eventTimezone: "America/Chicago",
      }),
    ).toBe(2);
  });

  it("returns -1 for a local last-Friday show", () => {
    expect(
      monthlyPresetLocalOrdinal({
        dtstartIso: "2026-05-29T14:00:00.000Z",
        eventTimezone: "America/Chicago",
      }),
    ).toBe(-1);
  });

  it("an EVENING show now gets an honest preset instead of being suppressed", () => {
    // 2026-08-01T01:00Z is Fri Jul 31 20:00 Chicago — the local LAST Friday
    // of July. Under the old two-basis rule this returned null (the label
    // would have lied about a UTC-basis rule); with one basis the label and
    // the emitted BYSETPOS are both -1.
    expect(
      monthlyPresetLocalOrdinal({
        dtstartIso: "2026-08-01T01:00:00.000Z",
        eventTimezone: "America/Chicago",
      }),
    ).toBe(-1);
  });

  it("reads the instant in the EVENT timezone, not the browser's", () => {
    // Same instant, two zones: Fri Aug 7 20:00 Chicago (1st Friday) vs
    // Sat Aug 8 in UTC (2nd Saturday).
    expect(
      monthlyPresetLocalOrdinal({
        dtstartIso: "2026-08-08T01:00:00.000Z",
        eventTimezone: "America/Chicago",
      }),
    ).toBe(1);
    expect(
      monthlyPresetLocalOrdinal({
        dtstartIso: "2026-08-08T01:00:00.000Z",
        eventTimezone: "UTC",
      }),
    ).toBe(2);
  });

  it("returns null for an invalid dtstart", () => {
    expect(
      monthlyPresetLocalOrdinal({
        dtstartIso: "not-a-date",
        eventTimezone: "America/Chicago",
      }),
    ).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildConfigFromState / deriveStateFromValue — the emission contract
// ───────────────────────────────────────────────────────────────────────────

// Tue Aug 4 2026, 9:00 Chicago — a daytime start.
const ctxDaytime: DeriveContext = {
  startDay: "TU",
  monthlyNth: 1,
  dtstartIso: "2026-08-04T14:00:00.000Z",
  eventTimezone: "America/Chicago",
  monthlyPresetAvailable: true,
};

// Tue Aug 4 2026, 20:00 Chicago — UTC Wed Aug 5 01:00Z. This is the start
// that USED to shift (token WE, label TU). Under one basis it is a Tuesday
// like any other, which is exactly what these fixtures now pin.
const ctxEvening: DeriveContext = {
  startDay: "TU",
  monthlyNth: 1,
  dtstartIso: "2026-08-05T01:00:00.000Z",
  eventTimezone: "America/Chicago",
  monthlyPresetAvailable: true,
};

// Same start, but with the monthly preset unavailable. Suppression no longer
// comes from a weekday shift (there isn't one) — it now only happens when the
// dtstart instant is unusable, so the flag is set explicitly here.
const ctxNoPreset: DeriveContext = {
  ...ctxEvening,
  monthlyPresetAvailable: false,
};

const makeState = (over: Partial<BuilderState>): BuilderState => ({
  ...defaultBuilderState("TU"),
  ...over,
});

describe("buildConfigFromState", () => {
  it("returns null for 'Doesn't repeat' and for a missing dtstart", () => {
    expect(buildConfigFromState(makeState({}), ctxDaytime)).toBeNull();
    expect(
      buildConfigFromState(makeState({ select: "weekly" }), {
        ...ctxDaytime,
        dtstartIso: null,
      }),
    ).toBeNull();
  });

  it("weekly preset emits the start's LOCAL day, even for an evening start", () => {
    // The headline regression: this used to emit BYDAY=WE for a Tuesday
    // 20:00 Chicago show, which the fixed backend would expand to Wednesdays.
    const config = buildConfigFromState(
      makeState({ select: "weekly" }),
      ctxEvening,
    );
    expect(config?.rrule).toBe("FREQ=WEEKLY;BYDAY=TU;COUNT=12");
    expect(config?.count).toBe(12);
    expect(config?.until).toBeUndefined();
  });

  it("custom weekly chips emit the selected days verbatim", () => {
    const config = buildConfigFromState(
      makeState({ select: "custom", unit: "weeks", byday: ["TU"] }),
      ctxDaytime,
    );
    expect(config?.rrule).toBe("FREQ=WEEKLY;BYDAY=TU;COUNT=12");
  });

  it("the SAME chip selection emits the same days whatever the start time", () => {
    // Identical state (Tuesday selected) under a daytime and an evening
    // start. The start time no longer re-maps the emitted day.
    const day = buildConfigFromState(
      makeState({ select: "custom", unit: "weeks", byday: ["TU"] }),
      ctxDaytime,
    );
    const evening = buildConfigFromState(
      makeState({ select: "custom", unit: "weeks", byday: ["TU"] }),
      ctxEvening,
    );
    expect(evening?.rrule).toBe("FREQ=WEEKLY;BYDAY=TU;COUNT=12");
    expect(evening?.rrule).toBe(day?.rrule);
  });

  it("multi-day selection emits every selected day unshifted", () => {
    const config = buildConfigFromState(
      makeState({ select: "custom", unit: "weeks", byday: ["TU", "FR"] }),
      ctxEvening,
    );
    expect(config?.rrule).toBe("FREQ=WEEKLY;BYDAY=TU,FR;COUNT=12");
  });

  it("count field: raw string is clamped at emit, not per keystroke", () => {
    const at = (count: string) =>
      buildConfigFromState(
        makeState({ select: "weekly", count }),
        ctxDaytime,
      );
    expect(at("10")?.count).toBe(10); // the "typing 10" case — NOT 20
    expect(at("1")?.count).toBe(2); // below COUNT_MIN clamps up
    expect(at("150")?.count).toBe(100); // above COUNT_MAX clamps down
    expect(at("")).toBeNull(); // mid-edit → incomplete, no emission
  });

  it("until mode: user-picked date becomes an event-tz end-of-day instant", () => {
    const config = buildConfigFromState(
      makeState({ select: "weekly", endMode: "until", until: "2026-11-06" }),
      ctxEvening,
    );
    expect(config?.until).toBe("2026-11-07T05:59:00.000Z");
    expect(config?.count).toBeUndefined();
    expect(config?.rrule).toBe("FREQ=WEEKLY;BYDAY=TU");
  });

  it("until mode: a server-loaded full ISO passes through verbatim", () => {
    const config = buildConfigFromState(
      makeState({
        select: "weekly",
        endMode: "until",
        until: "2026-12-31T05:00:00.000Z",
      }),
      ctxEvening,
    );
    expect(config?.until).toBe("2026-12-31T05:00:00.000Z");
  });

  it("until mode without a date is incomplete (null)", () => {
    expect(
      buildConfigFromState(
        makeState({ select: "weekly", endMode: "until", until: "" }),
        ctxDaytime,
      ),
    ).toBeNull();
  });
});

describe("deriveStateFromValue", () => {
  const dtstart = ctxEvening.dtstartIso!;

  it("prefills stored days verbatim — no un-shifting on the way in", () => {
    const state = deriveStateFromValue(
      { rrule: "FREQ=WEEKLY;BYDAY=TU,FR", dtstart },
      ctxEvening,
    );
    expect(state.select).toBe("custom");
    expect(state.byday).toEqual(["TU", "FR"]);
  });

  it("classifies a start-day weekly rule as the weekly preset", () => {
    const state = deriveStateFromValue(
      { rrule: "FREQ=WEEKLY;BYDAY=TU", dtstart },
      ctxEvening,
    );
    expect(state.select).toBe("weekly");
    expect(state.byday).toEqual(["TU"]);
  });

  it("prefers 'until' when the config carries BOTH a COUNT and an until", () => {
    // Dropping the until on passive prefill would silently unbound the series
    // end on the next save.
    const state = deriveStateFromValue(
      {
        rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=5",
        dtstart,
        until: "2026-12-31T05:00:00.000Z",
      },
      ctxEvening,
    );
    expect(state.endMode).toBe("until");
    expect(state.until).toBe("2026-12-31T05:00:00.000Z");
    const rebuilt = buildConfigFromState(state, ctxEvening);
    expect(rebuilt?.until).toBe("2026-12-31T05:00:00.000Z");
    expect(rebuilt?.count).toBeUndefined();
  });

  it("canonical COUNT rules rebuild to the same rrule/dtstart/count", () => {
    const value = { rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=5", dtstart };
    const rebuilt = buildConfigFromState(
      deriveStateFromValue(value, ctxEvening),
      ctxEvening,
    );
    expect(rebuilt?.rrule).toBe(value.rrule);
    expect(rebuilt?.dtstart).toBe(value.dtstart);
    expect(rebuilt?.count).toBe(5);
  });

  it("non-canonical stored rules WOULD rewrite on rebuild — why untouched state never emits", () => {
    // COUNT mid-string is legal RRULE; a rebuild canonicalizes it. The
    // builder therefore suppresses ALL emission until the user interacts, so
    // a passive load+save round-trips the stored rule verbatim.
    const value = { rrule: "FREQ=WEEKLY;COUNT=5;BYDAY=TU", dtstart };
    const rebuilt = buildConfigFromState(
      deriveStateFromValue(value, ctxEvening),
      ctxEvening,
    );
    expect(rebuilt?.rrule).toBe("FREQ=WEEKLY;BYDAY=TU;COUNT=5");
    expect(configsEqual(rebuilt, { ...value })).toBe(false);
  });

  it("monthly-nth rule prefills as the preset when its label is honest", () => {
    const state = deriveStateFromValue(
      { rrule: "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1", dtstart },
      { ...ctxEvening, monthlyPresetAvailable: true },
    );
    expect(state.select).toBe("monthly");
    expect(state.raw).toBeNull();
  });

  it("monthly-nth rule prefills as RAW custom when the preset is suppressed", () => {
    // The structured custom panel can't express BYSETPOS — rebuilding it
    // structurally would silently drop the ordinal, so it must pass through.
    const state = deriveStateFromValue(
      { rrule: "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1;COUNT=12", dtstart },
      ctxNoPreset,
    );
    expect(state.select).toBe("custom");
    expect(state.raw).toBe("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1");
    expect(state.endMode).toBe("count");
    const rebuilt = buildConfigFromState(state, ctxNoPreset);
    expect(rebuilt?.rrule).toBe("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1;COUNT=12");
  });

  it("degradeMonthlySelection: a selected monthly preset losing its label degrades to raw Custom", () => {
    // monthlyPresetAvailable went false while "monthly" was selected: the
    // option would unmount under a dangling native select value. The degrade
    // carries the CURRENT rule as raw so the schedule semantics and the
    // summary survive.
    const selected = makeState({ select: "monthly" });
    const degraded = degradeMonthlySelection(selected, ctxNoPreset);
    expect(degraded.select).toBe("custom");
    expect(degraded.unit).toBe("months");
    expect(degraded.raw).toBe("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1");
    const rebuilt = buildConfigFromState(degraded, ctxNoPreset);
    expect(rebuilt?.rrule).toBe("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1;COUNT=12");
  });

  it("degradeMonthlySelection is a referential no-op when the preset is available or not selected", () => {
    const monthly = makeState({ select: "monthly" });
    expect(degradeMonthlySelection(monthly, ctxDaytime)).toBe(monthly);
    const weekly = makeState({ select: "weekly" });
    expect(degradeMonthlySelection(weekly, ctxNoPreset)).toBe(weekly);
  });

  it("a BOUNDLESS suppressed-preset rule derives into until-mode awaiting an end", () => {
    const state = deriveStateFromValue(
      { rrule: "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1", dtstart },
      ctxNoPreset,
    );
    expect(state.raw).toBe("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1");
    expect(state.endMode).toBe("until");
    // No end chosen yet → incomplete; the untouched-state guard keeps the
    // stored config in the parent meanwhile.
    expect(buildConfigFromState(state, ctxNoPreset)).toBeNull();
  });

  it("unparseable rules pass through raw with COUNT owned by the Ends chooser", () => {
    const state = deriveStateFromValue(
      { rrule: "FREQ=WEEKLY;UNTIL=20261231T000000Z;COUNT=7", dtstart },
      ctxEvening,
    );
    expect(state.select).toBe("custom");
    expect(state.raw).toBe("FREQ=WEEKLY;UNTIL=20261231T000000Z");
    expect(state.endMode).toBe("count");
    expect(state.count).toBe("7");
  });
});

describe("dayOfWeekFromIso", () => {
  it("returns MO for a known Monday", () => {
    // 2025-01-06 is a Monday
    expect(dayOfWeekFromIso("2025-01-06T12:00:00.000Z")).toBe("MO");
  });

  it("returns FR for a known Friday", () => {
    expect(dayOfWeekFromIso("2025-01-10T12:00:00.000Z")).toBe("FR");
  });

  it("returns SU for a known Sunday", () => {
    expect(dayOfWeekFromIso("2025-01-12T12:00:00.000Z")).toBe("SU");
  });

  it("returns SA for a known Saturday", () => {
    expect(dayOfWeekFromIso("2025-01-11T12:00:00.000Z")).toBe("SA");
  });

  it("returns null for invalid date", () => {
    expect(dayOfWeekFromIso("not-a-date")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(dayOfWeekFromIso("")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// One-basis regression + server parity
//
// The builder used to emit a UTC-basis token (a Chicago Friday-20:00 show
// emitted BYDAY=SA) to compensate for a backend that evaluated BYDAY against
// the UTC calendar. The backend now evaluates in the event timezone, so a
// shifted token would land the series a day LATE. These pin the local basis
// end-to-end and pin the preview to the instants the server writes.
// ───────────────────────────────────────────────────────────────────────────

/**
 * PARITY LITERAL — a Chicago 19:00 weekly-Monday series.
 *
 * The same list is asserted in the server's own suite
 * (`packages/core/src/use-cases/events/_shared/__tests__/expand-recurrence.test.ts`
 * and `packages/core/src/use-cases/series/__tests__/expand-series.test.ts`).
 * `apps/web` does not depend on `@th/core`, so parity is enforced by this
 * shared literal rather than a shared import — if either side changes, the
 * other's copy of this list fails.
 */
const CHICAGO_MONDAY_19_DTSTART = "2026-09-15T00:00:00.000Z";
const CHICAGO_MONDAY_19_INSTANTS = [
  "2026-09-15T00:00:00.000Z",
  "2026-09-22T00:00:00.000Z",
  "2026-09-29T00:00:00.000Z",
  "2026-10-06T00:00:00.000Z",
  "2026-10-13T00:00:00.000Z",
  "2026-10-20T00:00:00.000Z",
  "2026-10-27T00:00:00.000Z",
];

describe("the builder emits the event's LOCAL weekday", () => {
  // Fri Sep 4 2026, 20:00 America/Chicago → 2026-09-05T01:00Z (a Saturday in
  // UTC). The old basis emitted SA for this.
  const ctxChicagoFridayEvening: DeriveContext = {
    startDay: startWeekdayForSchedule("2026-09-04T20:00", "America/Chicago"),
    monthlyNth: monthlyNthForSchedule("2026-09-04T20:00", "America/Chicago"),
    dtstartIso: "2026-09-05T01:00:00.000Z",
    eventTimezone: "America/Chicago",
    monthlyPresetAvailable: true,
  };

  it("weekly: a Chicago Friday 20:00 show emits BYDAY=FR, not BYDAY=SA", () => {
    const config = buildConfigFromState(
      { ...defaultBuilderState("FR"), select: "weekly" },
      ctxChicagoFridayEvening,
    );
    expect(config?.rrule).toBe("FREQ=WEEKLY;BYDAY=FR;COUNT=12");
    expect(config?.rrule).not.toContain("SA");
  });

  it("monthly BYSETPOS: first LOCAL Friday emits BYSETPOS=1, not the UTC month's 2", () => {
    // Sep 4 2026 is the first Friday of September locally. In UTC the instant
    // is Sat Sep 5 — the first Saturday — but a UTC-month reading of an
    // evening show is exactly what produced wrong ordinals before.
    const config = buildConfigFromState(
      { ...defaultBuilderState("FR"), select: "monthly" },
      ctxChicagoFridayEvening,
    );
    expect(config?.rrule).toBe("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=1;COUNT=12");
  });

  it("monthly BYSETPOS across a month boundary: local last-Friday-of-July stays -1", () => {
    // Fri Jul 31 2026 20:00 Chicago is 2026-08-01T01:00Z — the local month
    // (July, last Friday) and the UTC month (August, first Saturday) differ.
    // The emitted rule must describe the LOCAL month.
    const ctx: DeriveContext = {
      startDay: startWeekdayForSchedule("2026-07-31T20:00", "America/Chicago"),
      monthlyNth: monthlyNthForSchedule("2026-07-31T20:00", "America/Chicago"),
      dtstartIso: "2026-08-01T01:00:00.000Z",
      eventTimezone: "America/Chicago",
      monthlyPresetAvailable: true,
    };
    expect(ctx.startDay).toBe("FR");
    expect(ctx.monthlyNth).toBe(-1);

    const config = buildConfigFromState(
      { ...defaultBuilderState("FR"), select: "monthly" },
      ctx,
    );
    expect(config?.rrule).toBe("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=12");
  });
});

describe("enumerateOccurrences — parity with the server expansion", () => {
  it("a Chicago 19:00 weekly-Monday rule previews the instants the server writes", () => {
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;BYDAY=MO",
      CHICAGO_MONDAY_19_DTSTART,
      undefined,
      CHICAGO_MONDAY_19_INSTANTS.length,
      "America/Chicago",
    );
    expect(out.map((d) => d.toISOString())).toEqual(CHICAGO_MONDAY_19_INSTANTS);
  });

  it("every previewed occurrence is a Monday at 19:00 local", () => {
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;BYDAY=MO",
      CHICAGO_MONDAY_19_DTSTART,
      undefined,
      7,
      "America/Chicago",
    );
    expect(out).toHaveLength(7);
    for (const d of out) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        weekday: "long",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(d);
      expect(parts).toContain("Monday");
      expect(parts).toContain("19");
    }
  });

  it("holds the local hour across the November fall-back (UTC instant moves)", () => {
    // Weekly Mondays 19:00 America/New_York from Mon 2026-10-19.
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;BYDAY=MO",
      "2026-10-19T23:00:00.000Z", // Mon 2026-10-19 19:00 EDT
      undefined,
      4,
      "America/New_York",
    );
    expect(out.map((d) => d.toISOString())).toEqual([
      "2026-10-19T23:00:00.000Z", // EDT (-4)
      "2026-10-26T23:00:00.000Z", // EDT (-4)
      "2026-11-03T00:00:00.000Z", // EST (-5) — local 19:00 held
      "2026-11-10T00:00:00.000Z",
    ]);
  });

  it("without a timezone it keeps the pre-timezone instant behaviour", () => {
    const out = enumerateOccurrences(
      "FREQ=WEEKLY;BYDAY=WE",
      CHICAGO_MONDAY_19_DTSTART, // 2026-09-15T00:00Z is a Tuesday in UTC
      undefined,
      2,
    );
    // No zone to evaluate in → UTC calendar, exactly as before.
    expect(out.map((d) => d.toISOString())).toEqual([
      "2026-09-16T00:00:00.000Z",
      "2026-09-23T00:00:00.000Z",
    ]);
  });
});

describe("enumerateOccurrences — the ambiguous fall-back hour", () => {
  // 01:30 on Sun 2026-11-01 America/Chicago happens TWICE. The preview must
  // resolve it the same way the server does (earlier offset wins) and must
  // not depend on when the process runs — the server's `floatingToInstant`
  // brackets the transition for exactly this reason, and this side goes
  // through the same bracketing solver (`zonedWallClockToInstant`).
  const run = () =>
    enumerateOccurrences(
      "FREQ=DAILY",
      "2026-10-31T06:30:00.000Z", // Sat 2026-10-31 01:30 CDT
      undefined,
      3,
      "America/Chicago",
    ).map((d) => d.toISOString());

  const EXPECTED = [
    "2026-10-31T06:30:00.000Z", // CDT (-5)
    "2026-11-01T06:30:00.000Z", // the EARLIER of the two 01:30s
    "2026-11-02T07:30:00.000Z", // CST (-6)
  ];

  it("takes the earlier offset, matching the server", () => {
    expect(run()).toEqual(EXPECTED);
  });

  it("gives the same answer whatever the process clock says", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
      const summer = run();
      vi.setSystemTime(new Date("2027-01-15T12:00:00.000Z"));
      const winter = run();
      expect(summer).toEqual(winter);
      expect(summer).toEqual(EXPECTED);
    } finally {
      vi.useRealTimers();
    }
  });
});
