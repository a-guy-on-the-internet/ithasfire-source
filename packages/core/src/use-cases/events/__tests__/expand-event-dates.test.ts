import { describe, expect, it } from "vitest";

import {
  calendarOccurrenceSchema,
  expandEventDates,
  type ExpandableEventDate,
} from "../expand-event-dates";

// ─────────────────────────────────────────────────────────────────────────────
// The ONE EventDate projector every calendar read shares (FR-003). Pinned:
// one occurrence per SCHEDULED row, index/total over the event's scheduled
// rows, null occurrence for events without rows (single-date AND series —
// a series is already one Event per date), CANCELLED rows skipped, window
// trimming by overlap, and the two ordering modes.
// ─────────────────────────────────────────────────────────────────────────────

const LISTING = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SINGLE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SERIES_OCC = "cccccccc-3333-4333-8333-cccccccccccc";
const D1 = "dddddddd-0001-4001-8001-dddddddddddd";
const D2 = "dddddddd-0002-4002-8002-dddddddddddd";
const D3 = "dddddddd-0003-4003-8003-dddddddddddd";
const D_CANCELLED = "dddddddd-0009-4009-8009-dddddddddddd";

const at = (iso: string) => new Date(iso);

function date(
  id: string,
  eventId: string,
  startsAt: string,
  status: "SCHEDULED" | "CANCELLED" = "SCHEDULED",
  endsAt: string | null = null,
): ExpandableEventDate {
  return {
    id,
    eventId,
    startsAt: at(startsAt),
    endsAt: endsAt ? at(endsAt) : null,
    status,
  };
}

const listing = {
  id: LISTING,
  title: "Tuesday Residency",
  // Pinned mirror of the FIRST upcoming row — must not be emitted again.
  startsAt: at("2026-06-02T20:00:00Z"),
  endsAt: at("2026-06-02T23:00:00Z"),
  timezone: "America/Chicago",
};
const single = {
  id: SINGLE,
  title: "One Night Only",
  startsAt: at("2026-06-05T20:00:00Z"),
  endsAt: null,
  timezone: "America/New_York",
};
const seriesOccurrence = {
  id: SERIES_OCC,
  title: "Friday Jazz",
  startsAt: at("2026-06-03T20:00:00Z"),
  endsAt: at("2026-06-03T22:00:00Z"),
  timezone: "America/Chicago",
  seriesId: "eeeeeeee-4444-4444-8444-eeeeeeeeeeee",
};

const listingDates = [
  // Deliberately out of startsAt order to prove index follows time, not input.
  date(D3, LISTING, "2026-06-16T20:00:00Z", "SCHEDULED", "2026-06-16T23:00:00Z"),
  date(D1, LISTING, "2026-06-02T20:00:00Z", "SCHEDULED", "2026-06-02T23:00:00Z"),
  date(D_CANCELLED, LISTING, "2026-06-09T20:00:00Z", "CANCELLED"),
  date(D2, LISTING, "2026-06-23T20:00:00Z"),
];

describe("expandEventDates", () => {
  it("yields one occurrence per SCHEDULED row with 1-based index over the event's scheduled rows, carrying the parent fields", () => {
    const out = expandEventDates([listing], listingDates);

    expect(out).toHaveLength(3);
    expect(out.map((o) => o.occurrence)).toEqual([
      { index: 1, total: 3, eventDateId: D1 },
      { index: 2, total: 3, eventDateId: D3 },
      { index: 3, total: 3, eventDateId: D2 },
    ]);
    // Row instants replace the pinned parent instant; parent fields ride along.
    expect(out[1]).toMatchObject({
      id: LISTING,
      title: "Tuesday Residency",
      timezone: "America/Chicago",
      startsAt: at("2026-06-16T20:00:00Z"),
      endsAt: at("2026-06-16T23:00:00Z"),
    });
    // A row with no endsAt yields a null endsAt — never the parent's.
    expect(out[2]!.endsAt).toBeNull();
    // Every occurrence passes the wire schema fragment.
    for (const o of out) expect(calendarOccurrenceSchema.parse(o.occurrence)).toEqual(o.occurrence);
  });

  it("skips CANCELLED rows entirely — they are neither chips nor counted in `total`", () => {
    const out = expandEventDates([listing], listingDates);
    expect(out.some((o) => o.occurrence?.eventDateId === D_CANCELLED)).toBe(false);
    expect(out.every((o) => o.occurrence?.total === 3)).toBe(true);
  });

  it("does NOT re-emit the pinned parent instant when rows exist (no double-painted night)", () => {
    const out = expandEventDates([listing], listingDates);
    const firstNight = out.filter(
      (o) => o.startsAt.getTime() === listing.startsAt.getTime(),
    );
    expect(firstNight).toHaveLength(1);
    expect(firstNight[0]!.occurrence).toEqual({ index: 1, total: 3, eventDateId: D1 });
  });

  it("passes single-date events through unchanged with occurrence: null", () => {
    const out = expandEventDates([single], listingDates);
    expect(out).toEqual([{ ...single, occurrence: null }]);
  });

  it("leaves series occurrences alone — one Event per date already, so no rows and occurrence: null", () => {
    const out = expandEventDates([seriesOccurrence], listingDates);
    expect(out).toEqual([{ ...seriesOccurrence, occurrence: null }]);
  });

  it("an event whose rows are ALL cancelled falls back to its pinned instant (occurrence: null)", () => {
    const out = expandEventDates(
      [listing],
      [date(D_CANCELLED, LISTING, "2026-06-09T20:00:00Z", "CANCELLED")],
    );
    expect(out).toEqual([{ ...listing, occurrence: null }]);
  });

  it("ignores rows for events not in the input", () => {
    const out = expandEventDates([single], listingDates);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(SINGLE);
  });

  describe("window", () => {
    it("keeps only EXPANDED occurrences overlapping [from, to] — the repo admitted the EVENT, the projector trims its nights", () => {
      const out = expandEventDates([listing, single], listingDates, {
        window: { from: at("2026-06-10T00:00:00Z"), to: at("2026-06-20T00:00:00Z") },
      });
      expect(out.map((o) => [o.id, o.occurrence?.eventDateId ?? null])).toEqual([
        [LISTING, D3],
        // A row-less event is the repo's window to enforce, not the projector's.
        [SINGLE, null],
      ]);
      // index/total are still over ALL scheduled rows, not the in-window subset.
      expect(out[0]!.occurrence).toEqual({ index: 2, total: 3, eventDateId: D3 });
    });

    it("an event pinned OUTSIDE the window still surfaces the night it has INSIDE it", () => {
      // Pinned 2026-06-02; the window is a month later where D2 lives.
      const out = expandEventDates([listing], listingDates, {
        window: { from: at("2026-06-20T00:00:00Z"), to: at("2026-06-30T00:00:00Z") },
      });
      expect(out.map((o) => o.occurrence?.eventDateId)).toEqual([D2]);
    });

    it("overlap, not containment: an occurrence that starts before `from` but ends after it is kept", () => {
      const out = expandEventDates([listing], listingDates, {
        window: { from: at("2026-06-02T22:00:00Z"), to: at("2026-06-03T00:00:00Z") },
      });
      expect(out.map((o) => o.occurrence?.eventDateId)).toEqual([D1]);
    });

    it("rows exist, none in window → the event emits NOTHING (no parent fallback; a cancelled night is not a show)", () => {
      // The listing is pinned at D1's instant (2026-06-02). The repo admitted
      // it through the parent-overlap arm for a window covering that night,
      // but D1 has since been CANCELLED and the surviving rows sit outside
      // the window. Emitting the parent would paint the called-off night.
      const out = expandEventDates(
        [listing],
        [
          date(D1, LISTING, "2026-06-02T20:00:00Z", "CANCELLED"),
          date(D3, LISTING, "2026-06-16T20:00:00Z"),
          date(D2, LISTING, "2026-06-23T20:00:00Z"),
        ],
        { window: { from: at("2026-06-01T00:00:00Z"), to: at("2026-06-05T00:00:00Z") } },
      );
      expect(out).toEqual([]);
    });

    it("never trims a parent fallback — the repo bounded row-less events on Event.startsAt already", () => {
      const out = expandEventDates(
        [listing],
        [date(D_CANCELLED, LISTING, "2026-06-09T20:00:00Z", "CANCELLED")],
        { window: { from: at("2026-06-08T00:00:00Z"), to: at("2026-06-10T00:00:00Z") } },
      );
      expect(out).toEqual([{ ...listing, occurrence: null }]);
    });

    it("half-open windows work (from only / to only)", () => {
      expect(
        expandEventDates([listing], listingDates, { window: { from: at("2026-06-10T00:00:00Z") } }).map(
          (o) => o.occurrence?.eventDateId,
        ),
      ).toEqual([D3, D2]);
      expect(
        expandEventDates([listing], listingDates, { window: { to: at("2026-06-10T00:00:00Z") } }).map(
          (o) => o.occurrence?.eventDateId,
        ),
      ).toEqual([D1]);
    });

    it("an event with a null startsAt and no rows is kept (pass-through) under a window", () => {
      const undated = { id: SINGLE, startsAt: null, endsAt: null };
      const out = expandEventDates([undated], [], {
        window: { from: at("2026-06-10T00:00:00Z"), to: at("2026-06-20T00:00:00Z") },
      });
      expect(out).toEqual([{ ...undated, occurrence: null }]);
    });
  });

  describe("ordering", () => {
    it("default: input order, occurrences contiguous per event (a paginated listing keeps its page order)", () => {
      const out = expandEventDates([single, listing, seriesOccurrence], listingDates);
      expect(out.map((o) => o.id)).toEqual([SINGLE, LISTING, LISTING, LISTING, SERIES_OCC]);
    });

    it("sort: 'startsAt' interleaves chronologically, stable on ties", () => {
      const sameInstant = { ...single, id: SERIES_OCC, startsAt: listing.startsAt, endsAt: null };
      const out = expandEventDates([single, listing, sameInstant], listingDates, {
        sort: "startsAt",
      });
      expect(out.map((o) => [o.id, o.startsAt?.toISOString()])).toEqual([
        [LISTING, "2026-06-02T20:00:00.000Z"],
        [SERIES_OCC, "2026-06-02T20:00:00.000Z"],
        [SINGLE, "2026-06-05T20:00:00.000Z"],
        [LISTING, "2026-06-16T20:00:00.000Z"],
        [LISTING, "2026-06-23T20:00:00.000Z"],
      ]);
    });
  });
});
