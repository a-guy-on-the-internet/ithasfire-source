import { describe, expect, it } from "vitest";

import {
  planAvailabilityBackfill,
  type ExistingAvailabilityRow,
  type LegacyAvailabilityRow,
} from "../src/scripts/plan-availability-backfill";

/**
 * The `PlaceAvailability → CalendarAvailability` backfill's decision logic.
 *
 * What this is really protecting: the public booking date picker moved off the
 * legacy table. A venue whose hours never made the trip does not throw — it
 * reports NO rules, and the picker renders every one of the next 62 days as
 * closed and disabled. There is no error anywhere for an operator to notice.
 * So the interesting cases here are the ones where a row would be MISSED, and
 * the ones where re-running would duplicate.
 */

const PLACE_A = "00000000-0000-4000-8000-0000000000a1";
const PLACE_B = "00000000-0000-4000-8000-0000000000b2";
const CALENDAR_ID = "ca1e0da1-1111-4111-8111-111111111111";

const legacyWindow = (
  overrides: Partial<LegacyAvailabilityRow> = {},
): LegacyAvailabilityRow => ({
  placeId: PLACE_A,
  dayOfWeek: 5,
  date: null,
  startTime: "18:00",
  endTime: "23:00",
  isOpen: true,
  note: null,
  ...overrides,
});

const existingFrom = (
  row: LegacyAvailabilityRow,
  overrides: Partial<ExistingAvailabilityRow> = {},
): ExistingAvailabilityRow => ({
  placeId: row.placeId,
  calendarId: null,
  dayOfWeek: row.dayOfWeek,
  date: row.date,
  startTime: row.startTime,
  endTime: row.endTime,
  isOpen: row.isOpen,
  ...overrides,
});

describe("planAvailabilityBackfill", () => {
  it("copies a weekly window as a PLACE-WIDE row", async () => {
    // `calendarId: null` is the whole point: the legacy row was scoped to the
    // place, and a null-calendar row applies to every calendar (FR-007). Any
    // other choice would either strand the hours on one stream or need a
    // decision the old data cannot support.
    const planned = planAvailabilityBackfill([legacyWindow()], []);

    expect(planned).toEqual([
      {
        placeId: PLACE_A,
        calendarId: null,
        dayOfWeek: 5,
        date: null,
        startTime: "18:00",
        endTime: "23:00",
        isOpen: true,
        note: null,
      },
    ]);
  });

  it("carries a dated blackout across, note and all", async () => {
    const date = new Date("2026-09-01T05:00:00.000Z");
    const planned = planAvailabilityBackfill(
      [
        legacyWindow({
          dayOfWeek: null,
          date,
          startTime: null,
          endTime: null,
          isOpen: false,
          note: "floor refinishing",
        }),
      ],
      [],
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      calendarId: null,
      dayOfWeek: null,
      date,
      isOpen: false,
      note: "floor refinishing",
    });
  });

  it("is IDEMPOTENT — a second run plans nothing", async () => {
    const rows = [
      legacyWindow(),
      legacyWindow({ dayOfWeek: 6 }),
      legacyWindow({ placeId: PLACE_B, dayOfWeek: 2 }),
    ];

    const firstRun = planAvailabilityBackfill(rows, []);
    expect(firstRun).toHaveLength(3);

    // Feed the first run's output back as what now exists.
    const secondRun = planAvailabilityBackfill(
      rows,
      firstRun.map((r) => existingFrom(r as LegacyAvailabilityRow)),
    );
    expect(secondRun).toEqual([]);
  });

  it("does not fan out a DUPLICATED legacy row", async () => {
    const planned = planAvailabilityBackfill(
      [legacyWindow(), legacyWindow()],
      [],
    );
    expect(planned).toHaveLength(1);
  });

  it("ignores the private note when deciding what is already migrated", async () => {
    // An owner editing the note on the migrated copy must not resurrect the
    // source row — `note` says nothing about WHEN the venue is open.
    const legacy = legacyWindow({ note: "old reason" });
    const planned = planAvailabilityBackfill(
      [legacy],
      [existingFrom(legacy)], // same rule, note not part of the shape
    );
    expect(planned).toEqual([]);
  });

  it("COLLAPSES two legacy rows that differ ONLY by note", async () => {
    // The converse of the case above, and the reason both are pinned: `note`
    // is excluded from the identity key, so these two rows are ONE rule with
    // two annotations — same day, same hours, same open/closed — and must
    // produce one row, not two.
    //
    // This is the guard against a plausible-looking "fix": someone seeing a
    // collapse here and adding `note` back into the key would make the two
    // rows distinct, which reads like it solves a duplicate problem. It would
    // instead break IDEMPOTENCE — an edited note on a migrated row would stop
    // matching its source and the backfill would copy it again on every run.
    const planned = planAvailabilityBackfill(
      [legacyWindow({ note: "a" }), legacyWindow({ note: "b" })],
      [],
    );

    expect(planned).toHaveLength(1);
    // First writer wins; either annotation is a defensible carry-over.
    expect(planned[0]!.note).toBe("a");
  });

  it("does NOT treat a CALENDAR-SCOPED row as already migrated", async () => {
    // The load-bearing negative. A row on one calendar is a different rule
    // from a place-wide one; counting it as a match would silently drop those
    // hours from every OTHER calendar of the venue.
    const legacy = legacyWindow();
    const planned = planAvailabilityBackfill(
      [legacy],
      [existingFrom(legacy, { calendarId: CALENDAR_ID })],
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]!.calendarId).toBeNull();
  });

  it("keeps rules that differ only in isOpen, time, or place", async () => {
    // Each field is part of the rule's identity. A near-match must not
    // swallow a real, distinct rule — that is how a blackout goes missing.
    const open = legacyWindow();
    const planned = planAvailabilityBackfill(
      [
        open,
        legacyWindow({ isOpen: false }),
        legacyWindow({ endTime: "02:00" }),
        legacyWindow({ placeId: PLACE_B }),
      ],
      [existingFrom(open)],
    );

    expect(planned).toHaveLength(3);
    expect(planned.every((p) => p.calendarId === null)).toBe(true);
  });

  it("plans nothing when there is nothing legacy to move", async () => {
    expect(planAvailabilityBackfill([], [])).toEqual([]);
  });
});
