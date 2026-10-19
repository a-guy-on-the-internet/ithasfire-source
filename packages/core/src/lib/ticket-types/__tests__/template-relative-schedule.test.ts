import { describe, expect, it } from "vitest";

import {
  MAX_TEMPLATE_OFFSET_MINUTES,
  materializeTemplateEntrySchedule,
  resolveRelativeTemplateInstant,
} from "../template-relative-schedule";

/**
 * FR-011 / FR-015 / FR-016 — the relative `{ anchor, offsetMinutes }` encoding
 * and its materialization against a concrete event.
 */

/** Read an instant as a wall clock in `zone`, e.g. "2026-10-31 21:00". */
function wallClockIn(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const FOURTEEN_DAYS = -20160;
const APPLIED_AT = new Date("2026-08-12T15:00:00.000Z");

describe("resolveRelativeTemplateInstant", () => {
  const target = {
    eventStartsAt: new Date("2026-10-01T20:00:00.000Z"),
    appliedAt: APPLIED_AT,
  };

  it("resolves EVENT_START + 0 to the event's own start", () => {
    expect(
      resolveRelativeTemplateInstant(
        { anchor: "EVENT_START", offsetMinutes: 0 },
        target,
      ),
    ).toEqual(target.eventStartsAt);
  });

  it("resolves a negative EVENT_START offset to before the show (FR-015 -20160)", () => {
    expect(
      resolveRelativeTemplateInstant(
        { anchor: "EVENT_START", offsetMinutes: FOURTEEN_DAYS },
        target,
      ),
    ).toEqual(new Date("2026-09-17T20:00:00.000Z"));
  });

  it("resolves the day-of opener (-1440) to 24h before the show", () => {
    expect(
      resolveRelativeTemplateInstant(
        { anchor: "EVENT_START", offsetMinutes: -1440 },
        target,
      ),
    ).toEqual(new Date("2026-09-30T20:00:00.000Z"));
  });

  it("resolves a positive EVENT_START offset to after the show", () => {
    expect(
      resolveRelativeTemplateInstant(
        { anchor: "EVENT_START", offsetMinutes: 120 },
        target,
      ),
    ).toEqual(new Date("2026-10-01T22:00:00.000Z"));
  });

  it("resolves EVENT_PUBLISH against APPLY TIME, never the event start", () => {
    // FR-016: the publish anchor resolves against apply time. `Event.publishedAt`
    // is deliberately not consulted — a historical publish instant can only
    // produce an already-elapsed bound, which would trip the drop path on every
    // template applied to a live event.
    expect(
      resolveRelativeTemplateInstant(
        { anchor: "EVENT_PUBLISH", offsetMinutes: 0 },
        target,
      ),
    ).toEqual(APPLIED_AT);
    expect(
      resolveRelativeTemplateInstant(
        { anchor: "EVENT_PUBLISH", offsetMinutes: 60 },
        target,
      ),
    ).toEqual(new Date("2026-08-12T16:00:00.000Z"));
  });

  it("caps the offset at a leap year in each direction", () => {
    expect(MAX_TEMPLATE_OFFSET_MINUTES).toBe(366 * 24 * 60);
  });

  // ── Corrupt stored JSON resolves to NULL, never an Invalid Date ──────────
  //
  // The failure this prevents: an Invalid Date passes BOTH drop rules (every
  // comparison against NaN is false), reaches `normalizeSalesWindow`, and
  // THROWS out of a multi-entry apply with earlier entries already committed.

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["a string", "soon"],
    ["null", null],
  ])("returns null for an offset of %s", (_label, offsetMinutes) => {
    expect(
      resolveRelativeTemplateInstant(
        { anchor: "EVENT_START", offsetMinutes } as never,
        target,
      ),
    ).toBeNull();
  });

  it("returns null for an unrecognized anchor rather than defaulting to apply time", () => {
    // The old `anchor === "EVENT_START" ? start : appliedAt` shape silently
    // treated EVERY other string as EVENT_PUBLISH.
    expect(
      resolveRelativeTemplateInstant(
        { anchor: "EVENT_DOORS", offsetMinutes: -60 } as never,
        target,
      ),
    ).toBeNull();
  });

  it("returns null when the ANCHOR instant itself is unreadable", () => {
    expect(
      resolveRelativeTemplateInstant(
        { anchor: "EVENT_START", offsetMinutes: -60 },
        { eventStartsAt: new Date("nonsense"), appliedAt: APPLIED_AT },
      ),
    ).toBeNull();
  });

  // ── DST, both directions ────────────────────────────────────────────────
  //
  // The offset is ELAPSED time, not calendar time (see the module docblock).
  // So an offset spanning a transition moves the resolved WALL CLOCK by the
  // transition step, and that is the documented, deliberate behaviour. These
  // two cases pin it so a future "fix" to calendar arithmetic cannot land
  // silently.

  it("FALL BACK — 14 days before a 20:00 New York show lands at 21:00 local", () => {
    // 2026-11-14 20:00 EST (UTC-5). The 14 days back cross the 2026-11-01
    // fall-back, so they contain 337 hours of wall clock, not 336.
    const eventStartsAt = new Date("2026-11-15T01:00:00.000Z");
    expect(wallClockIn(eventStartsAt, "America/New_York")).toBe(
      "2026-11-14 20:00",
    );

    const close = resolveRelativeTemplateInstant(
      { anchor: "EVENT_START", offsetMinutes: FOURTEEN_DAYS },
      { eventStartsAt, appliedAt: APPLIED_AT },
    );

    expect(close).toEqual(new Date("2026-11-01T01:00:00.000Z"));
    expect(wallClockIn(close, "America/New_York")).toBe("2026-10-31 21:00");
  });

  it("SPRING FORWARD — 14 days before a 20:00 New York show lands at 19:00 local", () => {
    // 2027-03-27 20:00 EDT (UTC-4). The 14 days back cross the 2027-03-14
    // spring-forward, so they contain 335 hours of wall clock.
    const eventStartsAt = new Date("2027-03-28T00:00:00.000Z");
    expect(wallClockIn(eventStartsAt, "America/New_York")).toBe(
      "2027-03-27 20:00",
    );

    const close = resolveRelativeTemplateInstant(
      { anchor: "EVENT_START", offsetMinutes: FOURTEEN_DAYS },
      { eventStartsAt, appliedAt: APPLIED_AT },
    );

    expect(close).toEqual(new Date("2027-03-14T00:00:00.000Z"));
    expect(wallClockIn(close, "America/New_York")).toBe("2027-03-13 19:00");
  });

  it("never lands in a DST gap or on an ambiguous reading — it names an instant directly", () => {
    // A calendar-arithmetic implementation resolving "1440 minutes before a
    // 02:30 spring-forward show" would have to invent a policy for a wall clock
    // that does not exist. Absolute arithmetic simply cannot reach that state:
    // the answer is an instant, and every instant is real.
    const eventStartsAt = new Date("2027-03-14T07:30:00.000Z"); // 03:30 EDT
    const open = resolveRelativeTemplateInstant(
      { anchor: "EVENT_START", offsetMinutes: -1440 },
      { eventStartsAt, appliedAt: APPLIED_AT },
    );
    expect(open).toEqual(new Date("2027-03-13T07:30:00.000Z"));
    expect(wallClockIn(open, "America/New_York")).toBe("2027-03-13 02:30");
  });
});

describe("materializeTemplateEntrySchedule", () => {
  const target = {
    eventStartsAt: new Date("2026-10-01T20:00:00.000Z"),
    appliedAt: APPLIED_AT,
  };

  it("NFR-001 — an entry with no relative fields resolves to all-nulls and no drops", () => {
    expect(materializeTemplateEntrySchedule({}, target)).toEqual({
      salesOpenAt: null,
      salesCloseAt: null,
      scheduledPriceCents: null,
      scheduledPriceAt: null,
      drops: [],
    });
  });

  it("materializes a full early-bird entry", () => {
    const result = materializeTemplateEntrySchedule(
      {
        salesOpen: { anchor: "EVENT_PUBLISH", offsetMinutes: 0 },
        salesClose: { anchor: "EVENT_START", offsetMinutes: FOURTEEN_DAYS },
        scheduledPriceChange: {
          at: { anchor: "EVENT_START", offsetMinutes: -10080 },
          priceCents: 2000,
        },
      },
      target,
    );

    expect(result).toEqual({
      salesOpenAt: APPLIED_AT,
      salesCloseAt: new Date("2026-09-17T20:00:00.000Z"),
      scheduledPriceCents: 2000,
      scheduledPriceAt: new Date("2026-09-24T20:00:00.000Z"),
      drops: [],
    });
  });

  it("drops the WHOLE window when the close has already elapsed", () => {
    const result = materializeTemplateEntrySchedule(
      {
        // Both resolve into the past for an event that already started.
        salesOpen: { anchor: "EVENT_START", offsetMinutes: -2880 },
        salesClose: { anchor: "EVENT_START", offsetMinutes: -1440 },
      },
      {
        eventStartsAt: new Date("2026-08-01T20:00:00.000Z"),
        appliedAt: APPLIED_AT,
      },
    );

    expect(result.salesOpenAt).toBeNull();
    expect(result.salesCloseAt).toBeNull();
    expect(result.drops).toEqual([
      { field: "salesWindow", reason: "already_elapsed" },
    ]);
  });

  it("drops the open bound too, so a closed window never becomes a never-closing one", () => {
    const result = materializeTemplateEntrySchedule(
      {
        // Opens in the future (publish anchor), closes in the past.
        salesOpen: { anchor: "EVENT_PUBLISH", offsetMinutes: 60 },
        salesClose: { anchor: "EVENT_START", offsetMinutes: -1440 },
      },
      {
        eventStartsAt: new Date("2026-08-01T20:00:00.000Z"),
        appliedAt: APPLIED_AT,
      },
    );

    expect(result.salesOpenAt).toBeNull();
    expect(result.salesCloseAt).toBeNull();
    expect(result.drops).toEqual([
      { field: "salesWindow", reason: "already_elapsed" },
    ]);
  });

  it("drops an INVERTED window across mixed anchors", () => {
    // Opens 60 days after apply time; the event is only 50 days out, so the
    // close (event start) lands BEFORE the open. Same-anchor inversion is
    // rejected by the entry schema; this mixed-anchor case can only be caught
    // here.
    const result = materializeTemplateEntrySchedule(
      {
        salesOpen: { anchor: "EVENT_PUBLISH", offsetMinutes: 86400 },
        salesClose: { anchor: "EVENT_START", offsetMinutes: 0 },
      },
      target,
    );

    expect(result.salesOpenAt).toBeNull();
    expect(result.salesCloseAt).toBeNull();
    expect(result.drops).toEqual([{ field: "salesWindow", reason: "inverted" }]);
  });

  it("treats a zero-width window as inverted, matching the write boundary", () => {
    const result = materializeTemplateEntrySchedule(
      {
        salesOpen: { anchor: "EVENT_PUBLISH", offsetMinutes: 60 },
        // Apply time + 60 min, reached from the other anchor.
        salesClose: {
          anchor: "EVENT_START",
          offsetMinutes: -(
            (target.eventStartsAt.getTime() - APPLIED_AT.getTime()) /
              60_000 -
            60
          ),
        },
      },
      target,
    );

    expect(result.drops).toEqual([{ field: "salesWindow", reason: "inverted" }]);
  });

  it("KEEPS a lone already-open bound — 'already open' is what no bound means", () => {
    const result = materializeTemplateEntrySchedule(
      { salesOpen: { anchor: "EVENT_START", offsetMinutes: -1440 } },
      {
        eventStartsAt: new Date("2026-08-01T20:00:00.000Z"),
        appliedAt: APPLIED_AT,
      },
    );

    expect(result.salesOpenAt).toEqual(new Date("2026-07-31T20:00:00.000Z"));
    expect(result.salesCloseAt).toBeNull();
    expect(result.drops).toEqual([]);
  });

  it("drops an already-elapsed price flip and never promotes the post-flip price", () => {
    const result = materializeTemplateEntrySchedule(
      {
        scheduledPriceChange: {
          at: { anchor: "EVENT_START", offsetMinutes: -1440 },
          priceCents: 2500,
        },
      },
      {
        eventStartsAt: new Date("2026-08-01T20:00:00.000Z"),
        appliedAt: APPLIED_AT,
      },
    );

    expect(result.scheduledPriceCents).toBeNull();
    expect(result.scheduledPriceAt).toBeNull();
    expect(result.drops).toEqual([
      { field: "scheduledPrice", reason: "already_elapsed" },
    ]);
  });

  it("drops a flip that resolves to exactly now (the boundary is inclusive)", () => {
    const result = materializeTemplateEntrySchedule(
      {
        scheduledPriceChange: {
          at: { anchor: "EVENT_PUBLISH", offsetMinutes: 0 },
          priceCents: 2500,
        },
      },
      target,
    );

    expect(result.drops).toEqual([
      { field: "scheduledPrice", reason: "already_elapsed" },
    ]);
  });

  it("reports BOTH drops when both halves fail", () => {
    const past = {
      eventStartsAt: new Date("2026-08-01T20:00:00.000Z"),
      appliedAt: APPLIED_AT,
    };
    const result = materializeTemplateEntrySchedule(
      {
        salesClose: { anchor: "EVENT_START", offsetMinutes: -1440 },
        scheduledPriceChange: {
          at: { anchor: "EVENT_START", offsetMinutes: -2880 },
          priceCents: 2500,
        },
      },
      past,
    );

    expect(result.drops).toEqual([
      { field: "salesWindow", reason: "already_elapsed" },
      { field: "scheduledPrice", reason: "already_elapsed" },
    ]);
  });

  it("drops an unreadable bound as `unresolvable` instead of emitting an Invalid Date", () => {
    const result = materializeTemplateEntrySchedule(
      {
        salesOpen: { anchor: "EVENT_PUBLISH", offsetMinutes: 0 },
        salesClose: {
          anchor: "EVENT_START",
          offsetMinutes: "fourteen days" as never,
        },
      },
      target,
    );

    // Both bounds go: half a window is a different product, and the surviving
    // half would be a claim the template never made.
    expect(result.salesOpenAt).toBeNull();
    expect(result.salesCloseAt).toBeNull();
    expect(result.drops).toEqual([
      { field: "salesWindow", reason: "unresolvable" },
    ]);
  });

  it("drops an unreadable flip instant as `unresolvable`", () => {
    const result = materializeTemplateEntrySchedule(
      {
        scheduledPriceChange: {
          at: { anchor: "NOT_AN_ANCHOR", offsetMinutes: -10080 } as never,
          priceCents: 2000,
        },
      },
      target,
    );

    expect(result.scheduledPriceAt).toBeNull();
    expect(result.scheduledPriceCents).toBeNull();
    expect(result.drops).toEqual([
      { field: "scheduledPrice", reason: "unresolvable" },
    ]);
  });

  it("drops a flip whose stored PRICE is not integer cents", () => {
    // `normalizeScheduledPrice` throws on this at the write boundary; a throw
    // mid-apply is the part-committed failure this path exists to avoid.
    for (const priceCents of [-100, 12.5, Number.NaN, "20" as never]) {
      const result = materializeTemplateEntrySchedule(
        {
          scheduledPriceChange: {
            at: { anchor: "EVENT_START", offsetMinutes: -10080 },
            priceCents,
          },
        },
        target,
      );
      expect(result.drops).toEqual([
        { field: "scheduledPrice", reason: "unresolvable" },
      ]);
    }
  });

  it("ACCEPTANCE — the same entry on two different event dates yields different instants", () => {
    const entry = {
      salesClose: {
        anchor: "EVENT_START" as const,
        offsetMinutes: FOURTEEN_DAYS,
      },
      scheduledPriceChange: {
        at: { anchor: "EVENT_START" as const, offsetMinutes: -10080 },
        priceCents: 2000,
      },
    };

    const october = materializeTemplateEntrySchedule(entry, {
      eventStartsAt: new Date("2026-10-01T20:00:00.000Z"),
      appliedAt: APPLIED_AT,
    });
    const december = materializeTemplateEntrySchedule(entry, {
      eventStartsAt: new Date("2026-12-05T02:00:00.000Z"),
      appliedAt: APPLIED_AT,
    });

    expect(october.salesCloseAt).toEqual(new Date("2026-09-17T20:00:00.000Z"));
    expect(december.salesCloseAt).toEqual(new Date("2026-11-21T02:00:00.000Z"));
    expect(october.scheduledPriceAt).toEqual(
      new Date("2026-09-24T20:00:00.000Z"),
    );
    expect(december.scheduledPriceAt).toEqual(
      new Date("2026-11-28T02:00:00.000Z"),
    );
    expect(october.drops).toEqual([]);
    expect(december.drops).toEqual([]);
  });
});
