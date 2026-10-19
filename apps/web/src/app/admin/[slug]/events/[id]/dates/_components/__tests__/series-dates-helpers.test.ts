import { describe, expect, it } from "vitest";

// Tests import the REAL pure helpers behind the Dates page (extracted to
// series-dates-helpers.ts so this suite stays free of React/Tamagui) — no
// mirrored local copies. Same discipline as RecurrenceBuilder.test.ts.
import {
  deriveManualNote,
  deriveRowKind,
  deriveRowMeta,
  describeSchedule,
  formatRowDate,
  formatRowTime,
  formatThroughDate,
  isPastRow,
  isReadyDraft,
  readyDraftRows,
  summarizeBulkPublish,
  weekdayNameInTimeZone,
  type SeriesDateEventSummary,
  type SeriesDateRow,
} from "../series-dates-helpers";

// ── Fixtures ────────────────────────────────────────────────────────────────

const baseEvent: SeriesDateEventSummary = {
  eventId: "5e29b1a2-0000-4000-8000-000000000001",
  title: "Friday Residency",
  slug: "friday-residency",
  status: "DRAFT",
  ticketTypeCount: 2,
  soldCount: 0,
};

const baseRow: SeriesDateRow = {
  occurrenceId: "5e29b1a2-0000-4000-8000-000000000002",
  // 2026-08-01T01:00:00Z == Fri Jul 31, 8:00 PM in America/Chicago.
  startsAt: new Date("2026-08-01T01:00:00Z"),
  endsAt: null,
  status: "GENERATED",
  manual: false,
  skipNote: null,
  note: null,
  event: baseEvent,
};

const row = (overrides: Partial<SeriesDateRow>): SeriesDateRow => ({
  ...baseRow,
  ...overrides,
});

const TZ = "America/Chicago";
const NOW_2026 = new Date("2026-07-01T12:00:00Z");

// ── deriveRowKind ───────────────────────────────────────────────────────────

describe("deriveRowKind", () => {
  it("PUBLISHED → published", () => {
    expect(
      deriveRowKind(
        row({
          status: "PUBLISHED",
          event: { ...baseEvent, status: "PUBLISHED", soldCount: 43 },
        }),
      ),
    ).toBe("published");
  });

  it("GENERATED with ticket types → draft-ready", () => {
    expect(deriveRowKind(row({}))).toBe("draft-ready");
  });

  it("GENERATED with zero ticket types → draft-unready", () => {
    expect(
      deriveRowKind(row({ event: { ...baseEvent, ticketTypeCount: 0 } })),
    ).toBe("draft-unready");
  });

  it("GENERATED with a missing event row is terminal (detached), NOT planned", () => {
    // generate-events skips occurrences that already link an event id, so a
    // fake "planned" row here would offer a [Create draft] that no-ops.
    expect(deriveRowKind(row({ event: null }))).toBe("detached");
  });

  it("GENERATED whose event already moved past DRAFT reflects the event", () => {
    expect(
      deriveRowKind(row({ event: { ...baseEvent, status: "PUBLISHED" } })),
    ).toBe("published");
    expect(
      deriveRowKind(row({ event: { ...baseEvent, status: "CANCELLED" } })),
    ).toBe("cancelled");
    expect(
      deriveRowKind(row({ event: { ...baseEvent, status: "COMPLETED" } })),
    ).toBe("completed");
    expect(
      deriveRowKind(row({ event: { ...baseEvent, status: "ARCHIVED" } })),
    ).toBe("archived");
  });

  it("PLANNED / SKIPPED / CANCELLED / DETACHED map straight through", () => {
    expect(deriveRowKind(row({ status: "PLANNED", event: null }))).toBe(
      "planned",
    );
    expect(deriveRowKind(row({ status: "SKIPPED", event: null }))).toBe(
      "skipped",
    );
    expect(deriveRowKind(row({ status: "CANCELLED" }))).toBe("cancelled");
    expect(deriveRowKind(row({ status: "DETACHED" }))).toBe("detached");
  });
});

// ── ready filter (bulk publish) ─────────────────────────────────────────────

describe("isReadyDraft / readyDraftRows", () => {
  it("a generated draft with ticket types is ready", () => {
    expect(isReadyDraft(row({}))).toBe(true);
  });

  it("zero ticket types is NOT ready (the 'not set up' state)", () => {
    expect(
      isReadyDraft(row({ event: { ...baseEvent, ticketTypeCount: 0 } })),
    ).toBe(false);
  });

  it("non-draft event status is not ready", () => {
    expect(
      isReadyDraft(row({ event: { ...baseEvent, status: "PUBLISHED" } })),
    ).toBe(false);
  });

  it("planned/skipped rows and missing events are not ready", () => {
    expect(isReadyDraft(row({ status: "PLANNED", event: null }))).toBe(false);
    expect(isReadyDraft(row({ status: "SKIPPED", event: null }))).toBe(false);
    expect(isReadyDraft(row({ event: null }))).toBe(false);
  });

  it("readyDraftRows keeps only ready drafts", () => {
    const rows = [
      row({ occurrenceId: "a".repeat(36) }),
      row({
        occurrenceId: "b".repeat(36),
        event: { ...baseEvent, ticketTypeCount: 0 },
      }),
      row({ occurrenceId: "c".repeat(36), status: "PLANNED", event: null }),
    ];
    expect(readyDraftRows(rows).map((r) => r.occurrenceId)).toEqual([
      "a".repeat(36),
    ]);
  });
});

// ── deriveRowMeta ───────────────────────────────────────────────────────────

describe("deriveRowMeta", () => {
  it("published rows carry the sold count", () => {
    expect(
      deriveRowMeta(
        row({
          status: "PUBLISHED",
          event: { ...baseEvent, status: "PUBLISHED", soldCount: 43 },
        }),
      ),
    ).toEqual({ kind: "sold", count: 43 });
  });

  it("published row with a missing event falls back to zero sold", () => {
    expect(deriveRowMeta(row({ status: "PUBLISHED", event: null }))).toEqual({
      kind: "sold",
      count: 0,
    });
  });

  it("draft readiness maps to ready / notSetUp", () => {
    expect(deriveRowMeta(row({}))).toEqual({ kind: "ready" });
    expect(
      deriveRowMeta(row({ event: { ...baseEvent, ticketTypeCount: 0 } })),
    ).toEqual({ kind: "notSetUp" });
  });

  it("planned rows say no draft yet", () => {
    expect(deriveRowMeta(row({ status: "PLANNED", event: null }))).toEqual({
      kind: "noDraftYet",
    });
  });

  it("skipped rows surface the skip note (or nothing)", () => {
    expect(
      deriveRowMeta(
        row({ status: "SKIPPED", event: null, skipNote: "Venue closed" }),
      ),
    ).toEqual({ kind: "skipNote", note: "Venue closed" });
    expect(
      deriveRowMeta(row({ status: "SKIPPED", event: null, skipNote: null })),
    ).toEqual({ kind: "none" });
  });

  it("cancelled/detached/archived rows have no meta", () => {
    expect(deriveRowMeta(row({ status: "CANCELLED" }))).toEqual({
      kind: "none",
    });
    expect(deriveRowMeta(row({ status: "DETACHED" }))).toEqual({
      kind: "none",
    });
    expect(
      deriveRowMeta(row({ event: { ...baseEvent, status: "ARCHIVED" } })),
    ).toEqual({ kind: "none" });
  });

  it("completed rows keep the sold count (factual)", () => {
    expect(
      deriveRowMeta(
        row({ event: { ...baseEvent, status: "COMPLETED", soldCount: 17 } }),
      ),
    ).toEqual({ kind: "sold", count: 17 });
  });

  it("GENERATED with a missing event explains the missing draft", () => {
    expect(deriveRowMeta(row({ event: null }))).toEqual({
      kind: "draftMissing",
    });
  });
});

// ── isPastRow / deriveManualNote ────────────────────────────────────────────

describe("isPastRow", () => {
  it("compares instants (timezone-independent)", () => {
    expect(isPastRow(baseRow, new Date("2026-08-01T00:59:00Z"))).toBe(false);
    expect(isPastRow(baseRow, new Date("2026-08-01T01:01:00Z"))).toBe(true);
  });
});

describe("deriveManualNote", () => {
  it("returns the note only for manual rows", () => {
    expect(
      deriveManualNote(row({ manual: true, note: "Holiday special" })),
    ).toBe("Holiday special");
    expect(deriveManualNote(row({ manual: true, note: null }))).toBeNull();
    expect(
      deriveManualNote(row({ manual: false, note: "schedule note" })),
    ).toBeNull();
  });
});

// ── Date formatting in the SERIES timezone ──────────────────────────────────

describe("formatRowDate", () => {
  it("formats mono uppercase in the series timezone, not UTC", () => {
    // The UTC date is Aug 1; Chicago wall clock is still Fri Jul 31.
    expect(formatRowDate(baseRow.startsAt, TZ, "en-US", NOW_2026)).toBe(
      "FRI JUL 31",
    );
  });

  it("appends the year only when outside now's year", () => {
    const nextYear = new Date("2027-01-16T02:00:00Z");
    const label = formatRowDate(nextYear, TZ, "en-US", NOW_2026);
    expect(label).toContain("2027");
    expect(formatRowDate(baseRow.startsAt, TZ, "en-US", NOW_2026)).not.toContain(
      "2026",
    );
  });

  it("localizes and uppercases without stray punctuation (es)", () => {
    expect(formatRowDate(baseRow.startsAt, TZ, "es", NOW_2026)).toBe(
      "VIE 31 JUL",
    );
  });
});

describe("formatRowTime", () => {
  it("renders the wall-clock time in the series timezone", () => {
    expect(formatRowTime(baseRow.startsAt, TZ, "en-US")).toBe("8:00 PM");
  });
});

describe("formatThroughDate", () => {
  it("formats the until bound in the series timezone", () => {
    // Midnight UTC on Oct 16 is still Oct 15 in Chicago.
    expect(
      formatThroughDate("2026-10-16T00:00:00Z", TZ, "en-US", NOW_2026),
    ).toBe("OCT 15");
  });

  it("returns null for an unparseable value", () => {
    expect(formatThroughDate("not-a-date", TZ, "en-US", NOW_2026)).toBeNull();
  });
});

describe("weekdayNameInTimeZone", () => {
  it("resolves the weekday of the series wall clock", () => {
    expect(weekdayNameInTimeZone(baseRow.startsAt, TZ, "en-US")).toBe(
      "Friday",
    );
  });
});

// ── describeSchedule ────────────────────────────────────────────────────────

describe("describeSchedule", () => {
  it("weekly single-day rules with interval 1 / 2 / N", () => {
    expect(
      describeSchedule({ kind: "RRULE", rrule: "FREQ=WEEKLY;BYDAY=FR" }),
    ).toEqual({ kind: "weekly", interval: 1 });
    expect(
      describeSchedule({
        kind: "RRULE",
        rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR",
      }),
    ).toEqual({ kind: "weekly", interval: 2 });
    expect(
      describeSchedule({
        kind: "RRULE",
        rrule: "FREQ=WEEKLY;INTERVAL=3;BYDAY=FR",
      }),
    ).toEqual({ kind: "weekly", interval: 3 });
  });

  it("multi-day weekly rules degrade to custom (no honest sentence)", () => {
    expect(
      describeSchedule({ kind: "RRULE", rrule: "FREQ=WEEKLY;BYDAY=FR,SA" }),
    ).toEqual({ kind: "custom" });
  });

  it("daily and monthly", () => {
    expect(describeSchedule({ kind: "RRULE", rrule: "FREQ=DAILY" })).toEqual({
      kind: "daily",
      interval: 1,
    });
    expect(
      describeSchedule({
        kind: "RRULE",
        rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=2",
      }),
    ).toEqual({ kind: "monthly", interval: 1 });
  });

  it("fixed-dates schedules and null rrules → fixed", () => {
    expect(describeSchedule({ kind: "FIXED_DATES", rrule: null })).toEqual({
      kind: "fixed",
    });
    expect(describeSchedule({ kind: "RRULE", rrule: null })).toEqual({
      kind: "fixed",
    });
  });

  it("unparseable rrules → custom", () => {
    expect(
      describeSchedule({ kind: "RRULE", rrule: "FREQ=YEARLY" }),
    ).toEqual({ kind: "custom" });
    expect(
      describeSchedule({ kind: "RRULE", rrule: "garbage" }),
    ).toEqual({ kind: "custom" });
  });
});

// ── summarizeBulkPublish ────────────────────────────────────────────────────

describe("summarizeBulkPublish", () => {
  it("all successes", () => {
    expect(
      summarizeBulkPublish([{ ok: true }, { ok: true }, { ok: true }]),
    ).toEqual({ published: 3, failed: 0, firstFailureReason: null });
  });

  it("mixed results keep the FIRST failure's reason", () => {
    expect(
      summarizeBulkPublish([
        { ok: true },
        { ok: false, reason: "first" },
        { ok: false, reason: "second" },
        { ok: true },
      ]),
    ).toEqual({ published: 2, failed: 2, firstFailureReason: "first" });
  });

  it("empty input", () => {
    expect(summarizeBulkPublish([])).toEqual({
      published: 0,
      failed: 0,
      firstFailureReason: null,
    });
  });
});
