import { describe, expect, it } from "vitest";

import {
  ANCHORED_CARRIER_START_TIME,
  emptyShiftDraftFields,
  materializeTemplateShift,
  minuteOfDayToTime,
  parseShiftDraftFields,
  resolveTemplateShift,
  shiftDraftDurationMinutes,
  splitMinutesToHoursAndMinutes,
  templateShiftDurationMinutes,
  withShiftDraftDurationMinutes,
  zonedNoonToday,
} from "../template-shift-offset";

/**
 * The runner's own zone, read once.
 *
 * NOTE: this file deliberately does NOT pin the zone from inside the suite.
 * Under Vitest (3.2.4 here) each worker gets a plain copy of `process.env`, so
 * assigning `TZ` there never reaches Node's timezone binding — the assignment
 * sticks in `process.env` while
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` keeps reporting the
 * machine zone. Pinning it for real would mean setting `TZ` in the shared
 * `vitest.config.ts` (before the workers fork), which would re-zone every
 * other suite in this app.
 *
 * The two halves of the suite therefore carry different weight, and it matters
 * which is which:
 *
 * - The **legacy-equivalence matrix** (NFR-001) feeds the runner's own zone in
 *   as the event zone, so it only ever proves equivalence for THAT zone. It is
 *   NOT a universal invariant, and running it in one zone says nothing about
 *   any other: its reference dates have to actually contain a DST transition of
 *   the runner's zone to exercise the interesting branches. The date list below
 *   deliberately covers the US, EU, AU and Lord Howe / NZ transition weekends
 *   for that reason — before they were added, the matrix passed under
 *   TZ=Europe/London and TZ=Australia/Sydney while the resolver got both DST
 *   edges backwards in every positive-offset zone.
 * - The **DST-boundary blocks** pin exact UTC instants for fixed event zones
 *   (Chicago, London, Sydney, Lord Howe). Those are genuinely
 *   runner-independent and are what actually locks the semantics in CI.
 *
 * Run with a shell-level `TZ=` prefix (`TZ=Australia/Sydney pnpm ...`) to
 * re-zone the matrix; an assignment inside the suite will not work.
 */
const RUNNER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe("minuteOfDayToTime", () => {
  it("formats minute-of-day as HH:MM with leading zeros", () => {
    expect(minuteOfDayToTime(0)).toBe("00:00");
    expect(minuteOfDayToTime(60)).toBe("01:00");
    expect(minuteOfDayToTime(9 * 60 + 5)).toBe("09:05");
    expect(minuteOfDayToTime(23 * 60 + 59)).toBe("23:59");
  });

  it("returns empty string for out-of-range values", () => {
    expect(minuteOfDayToTime(-1)).toBe("");
    expect(minuteOfDayToTime(24 * 60)).toBe("");
    expect(minuteOfDayToTime(Number.NaN)).toBe("");
  });
});

describe("parseShiftDraftFields", () => {
  const baseFields = emptyShiftDraftFields();

  it("parses a normal afternoon shift", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Setup",
      startTime: "16:00",
      endTime: "18:30",
      dayOffset: "0",
      capacity: "2",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        label: "Setup",
        startMinuteOfDay: 16 * 60,
        endMinuteOfDay: 18 * 60 + 30,
        startDayOffset: 0,
        endsNextDay: false,
        capacity: 2,
        // Defaults: an untouched row is a wall-clock preset with no offset,
        // which is byte-identical to the pre-anchor behaviour (NFR-001).
        anchor: "WALL_CLOCK",
        offsetMinutes: 0,
      },
    });
  });

  it("flags wrap-past-midnight shifts as endsNextDay", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Cleanup",
      startTime: "23:00",
      endTime: "00:30",
      dayOffset: "0",
      capacity: "",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.endsNextDay).toBe(true);
      expect(result.value.startMinuteOfDay).toBe(23 * 60);
      expect(result.value.endMinuteOfDay).toBe(30);
    }
  });

  it("treats blank capacity as null (unlimited)", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Main",
      startTime: "20:00",
      endTime: "23:00",
      dayOffset: "0",
      capacity: "",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.capacity).toBeNull();
  });

  it("supports negative day offsets (load-in the day before)", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Load-in",
      startTime: "10:00",
      endTime: "12:00",
      dayOffset: "-1",
      capacity: "",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.startDayOffset).toBe(-1);
  });

  it("rejects empty label", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "  ",
      startTime: "09:00",
      endTime: "12:00",
      dayOffset: "0",
      capacity: "",
    });
    expect(result).toEqual({ ok: false, errors: { label: "label_required" } });
  });

  it("rejects identical start and end (0-length shift)", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Empty",
      startTime: "10:00",
      endTime: "10:00",
      dayOffset: "0",
      capacity: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.endTime).toBe("ends_equal_start");
  });

  it("rejects malformed time strings", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Bad",
      startTime: "9am",
      endTime: "10:00",
      dayOffset: "0",
      capacity: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.startTime).toBe("start_invalid");
  });

  it("rejects out-of-bound day offsets", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Far future",
      startTime: "10:00",
      endTime: "12:00",
      dayOffset: "100",
      capacity: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.dayOffset).toBe("day_offset_invalid");
  });

  it("rejects non-positive capacity", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Doors",
      startTime: "18:00",
      endTime: "19:00",
      dayOffset: "0",
      capacity: "0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.capacity).toBe("capacity_invalid");
  });
});

describe("zonedNoonToday", () => {
  // 2026-06-16T01:00Z is still Jun 15 (20:00) in Chicago but already Jun 16
  // (10:00) in Tokyo — the "today" each zone means is a different date.
  const now = new Date("2026-06-16T01:00:00.000Z");

  it("anchors to noon on the event zone's own calendar day", () => {
    expect(zonedNoonToday("America/Chicago", now).toISOString()).toBe(
      "2026-06-15T17:00:00.000Z", // 12:00 CDT, Jun 15
    );
    expect(zonedNoonToday("Asia/Tokyo", now).toISOString()).toBe(
      "2026-06-16T03:00:00.000Z", // 12:00 JST, Jun 16
    );
  });

  it("round-trips through materializeTemplateShift for far-apart zones", () => {
    // The whole point of anchoring in the event zone: a browser-local noon
    // would land on the neighbouring calendar day once the zones are more than
    // 12 hours apart (Tokyo +9 vs Chicago -6 = 15). Whatever "now" is, the
    // materialized day must be the event zone's today.
    for (const timeZone of [
      "America/Chicago",
      "Asia/Tokyo",
      "Pacific/Kiritimati", // +14, the extreme
      "Pacific/Midway", // -11
    ]) {
      const reference = zonedNoonToday(timeZone, now);
      const { startsAt } = materializeTemplateShift(
        reference,
        {
          startMinuteOfDay: 18 * 60,
          endMinuteOfDay: 22 * 60,
          startDayOffset: 0,
          endsNextDay: false,
        },
        timeZone,
      );
      const dayOf = (value: Date) =>
        new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(value);
      expect(dayOf(new Date(startsAt))).toBe(dayOf(now));
    }
  });
});

/**
 * The pre-FR-006 implementation, kept verbatim as the equivalence oracle for
 * NFR-001. Do not "fix" it — its whole job is to reproduce the old behaviour.
 */
function legacyMaterializeTemplateShift(
  reference: Date,
  shift: {
    startMinuteOfDay: number;
    endMinuteOfDay: number;
    startDayOffset: number;
    endsNextDay: boolean;
  },
): { startsAt: string; endsAt: string } {
  const base = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
    0,
    0,
    0,
    0,
  );
  base.setDate(base.getDate() + shift.startDayOffset);

  const start = new Date(base);
  start.setMinutes(shift.startMinuteOfDay);

  const end = new Date(base);
  if (shift.endsNextDay) end.setDate(end.getDate() + 1);
  end.setMinutes(shift.endMinuteOfDay);

  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

describe("materializeTemplateShift", () => {
  const CHICAGO = "America/Chicago";
  // June 15, 2026 13:00 in Chicago (CDT, UTC-5) — safely away from any DST edge.
  const reference = new Date("2026-06-15T18:00:00.000Z");

  it("stamps time-of-day on the event date when dayOffset is 0", () => {
    expect(
      materializeTemplateShift(
        reference,
        {
          startMinuteOfDay: 16 * 60,
          endMinuteOfDay: 18 * 60 + 30,
          startDayOffset: 0,
          endsNextDay: false,
        },
        CHICAGO,
      ),
    ).toEqual({
      // 16:00 and 18:30 CDT on the event's calendar day.
      startsAt: "2026-06-15T21:00:00.000Z",
      endsAt: "2026-06-15T23:30:00.000Z",
    });
  });

  it("rolls the end forward when endsNextDay is true", () => {
    expect(
      materializeTemplateShift(
        reference,
        {
          startMinuteOfDay: 23 * 60,
          endMinuteOfDay: 30,
          startDayOffset: 0,
          endsNextDay: true,
        },
        CHICAGO,
      ),
    ).toEqual({
      startsAt: "2026-06-16T04:00:00.000Z", // 23:00 CDT Jun 15
      endsAt: "2026-06-16T05:30:00.000Z", // 00:30 CDT Jun 16
    });
  });

  it("applies day offset (load-in the day before)", () => {
    expect(
      materializeTemplateShift(
        reference,
        {
          startMinuteOfDay: 10 * 60,
          endMinuteOfDay: 12 * 60,
          startDayOffset: -1,
          endsNextDay: false,
        },
        CHICAGO,
      ),
    ).toEqual({
      startsAt: "2026-06-14T15:00:00.000Z", // 10:00 CDT Jun 14
      endsAt: "2026-06-14T17:00:00.000Z",
    });
  });

  it("resolves the same preset differently for two events in different zones", () => {
    const preset = {
      startMinuteOfDay: 18 * 60,
      endMinuteOfDay: 22 * 60,
      startDayOffset: 0,
      endsNextDay: false,
    };

    const chicago = materializeTemplateShift(reference, preset, CHICAGO);
    const london = materializeTemplateShift(reference, preset, "Europe/London");

    expect(chicago.startsAt).toBe("2026-06-15T23:00:00.000Z"); // 18:00 CDT
    expect(london.startsAt).toBe("2026-06-15T17:00:00.000Z"); // 18:00 BST
    expect(chicago.startsAt).not.toBe(london.startsAt);
  });

  it("reads the reference's calendar day in the event zone, not the browser's", () => {
    // 2026-06-16T01:00Z is still June 15 (20:00) in Chicago but already
    // June 16 (10:00) in Tokyo. The materialized day must follow the event.
    const lateNight = new Date("2026-06-16T01:00:00.000Z");
    const preset = {
      startMinuteOfDay: 9 * 60,
      endMinuteOfDay: 11 * 60,
      startDayOffset: 0,
      endsNextDay: false,
    };

    expect(materializeTemplateShift(lateNight, preset, CHICAGO).startsAt).toBe(
      "2026-06-15T14:00:00.000Z",
    ); // 09:00 CDT on Jun 15
    expect(
      materializeTemplateShift(lateNight, preset, "Asia/Tokyo").startsAt,
    ).toBe("2026-06-16T00:00:00.000Z"); // 09:00 JST on Jun 16
  });

  describe("DST boundaries in America/Chicago", () => {
    // Spring forward: 2026-03-08, 02:00 CST -> 03:00 CDT.
    const springForward = new Date("2026-03-08T18:00:00.000Z"); // 13:00 CDT

    it("keeps the venue wall clock across a spring-forward day", () => {
      expect(
        materializeTemplateShift(
          springForward,
          {
            startMinuteOfDay: 16 * 60,
            endMinuteOfDay: 18 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          CHICAGO,
        ),
      ).toEqual({
        startsAt: "2026-03-08T21:00:00.000Z", // 16:00 CDT (UTC-5)
        endsAt: "2026-03-08T23:00:00.000Z",
      });

      // Same wall clock the day before is still CST (UTC-6) — one hour later
      // in UTC, which is exactly what naive UTC arithmetic gets wrong.
      expect(
        materializeTemplateShift(
          springForward,
          {
            startMinuteOfDay: 16 * 60,
            endMinuteOfDay: 18 * 60,
            startDayOffset: -1,
            endsNextDay: false,
          },
          CHICAGO,
        ),
      ).toEqual({
        startsAt: "2026-03-07T22:00:00.000Z", // 16:00 CST (UTC-6)
        endsAt: "2026-03-08T00:00:00.000Z",
      });
    });

    it("spans the spring-forward transition with endsNextDay", () => {
      // 23:00 CST Mar 7 -> 00:30 CST Mar 8: 1h30 of real time, both sides
      // still on CST because the switch happens at 02:00 local.
      const { startsAt, endsAt } = materializeTemplateShift(
        springForward,
        {
          startMinuteOfDay: 23 * 60,
          endMinuteOfDay: 30,
          startDayOffset: -1,
          endsNextDay: true,
        },
        CHICAGO,
      );
      expect(startsAt).toBe("2026-03-08T05:00:00.000Z");
      expect(endsAt).toBe("2026-03-08T06:30:00.000Z");
      expect(new Date(endsAt).getTime() - new Date(startsAt).getTime()).toBe(
        90 * 60_000,
      );
    });

    it("resolves an early-morning shift on the spring-forward day", () => {
      // 04:00 on 2026-03-08 is already CDT. A single-pass offset lookup
      // (offset at the naive UTC instant) would answer 10:00Z here.
      expect(
        materializeTemplateShift(
          springForward,
          {
            startMinuteOfDay: 4 * 60,
            endMinuteOfDay: 6 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          CHICAGO,
        ),
      ).toEqual({
        startsAt: "2026-03-08T09:00:00.000Z",
        endsAt: "2026-03-08T11:00:00.000Z",
      });
    });

    // Fall back: 2026-11-01, 02:00 CDT -> 01:00 CST.
    const fallBack = new Date("2026-11-01T18:00:00.000Z"); // 12:00 CST

    it("keeps the venue wall clock across a fall-back day", () => {
      expect(
        materializeTemplateShift(
          fallBack,
          {
            startMinuteOfDay: 16 * 60,
            endMinuteOfDay: 18 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          CHICAGO,
        ),
      ).toEqual({
        startsAt: "2026-11-01T22:00:00.000Z", // 16:00 CST (UTC-6)
        endsAt: "2026-11-02T00:00:00.000Z",
      });

      expect(
        materializeTemplateShift(
          fallBack,
          {
            startMinuteOfDay: 16 * 60,
            endMinuteOfDay: 18 * 60,
            startDayOffset: -1,
            endsNextDay: false,
          },
          CHICAGO,
        ),
      ).toEqual({
        startsAt: "2026-10-31T21:00:00.000Z", // 16:00 CDT (UTC-5)
        endsAt: "2026-10-31T23:00:00.000Z",
      });
    });

    it("spans the fall-back transition with endsNextDay", () => {
      // 23:00 CDT Oct 31 -> 01:00 Nov 1, which happens twice; we take the
      // first (CDT) occurrence, so the shift is 2h of real time.
      const { startsAt, endsAt } = materializeTemplateShift(
        fallBack,
        {
          startMinuteOfDay: 23 * 60,
          endMinuteOfDay: 60,
          startDayOffset: -1,
          endsNextDay: true,
        },
        CHICAGO,
      );
      expect(startsAt).toBe("2026-11-01T04:00:00.000Z");
      expect(endsAt).toBe("2026-11-01T06:00:00.000Z");
    });

    it("takes the pre-transition offset inside the spring-forward gap", () => {
      // 02:30 on 2026-03-08 never happens in Chicago (01:59:59 CST jumps to
      // 03:00:00 CDT). ECMAScript resolves a nonexistent local time with the
      // offset in effect BEFORE the transition (CST, UTC-6), landing on
      // 08:30Z — which reads back as 03:30 CDT, an hour later than asked.
      expect(
        materializeTemplateShift(
          springForward,
          {
            startMinuteOfDay: 2 * 60 + 30,
            endMinuteOfDay: 4 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          CHICAGO,
        ).startsAt,
      ).toBe("2026-03-08T08:30:00.000Z");
    });

    it("takes the first occurrence inside the fall-back overlap", () => {
      // 01:30 on 2026-11-01 happens twice: 06:30Z (CDT) and 07:30Z (CST).
      expect(
        materializeTemplateShift(
          fallBack,
          {
            startMinuteOfDay: 60 + 30,
            endMinuteOfDay: 3 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          CHICAGO,
        ).startsAt,
      ).toBe("2026-11-01T06:30:00.000Z");
    });
  });

  /**
   * Runner-independent DST semantics. Everything here pins an explicit event
   * zone and an explicit expected UTC instant, so it asserts the same thing
   * whatever zone CI runs in — unlike the equivalence matrix below, which can
   * only ever speak for the runner's own zone.
   *
   * Positive-offset zones are the point: a fixed-point resolver that probes the
   * zone at the naive UTC reading lands on the far side of the transition here
   * and inverts BOTH branches (gap resolves an hour early, overlap picks the
   * second occurrence).
   */
  describe("DST boundaries outside the US", () => {
    it("resolves the Europe/London gap with the pre-transition offset", () => {
      // 2026-03-29T01:00Z: 00:59 GMT -> 02:00 BST. Local 01:30 never happens;
      // pre-transition offset is GMT (+0), so it resolves to 01:30Z (= 02:30 BST).
      expect(
        materializeTemplateShift(
          new Date("2026-03-29T12:00:00.000Z"), // 13:00 BST, Mar 29 in London
          {
            startMinuteOfDay: 90, // 01:30
            endMinuteOfDay: 180, // 03:00
            startDayOffset: 0,
            endsNextDay: false,
          },
          "Europe/London",
        ),
      ).toEqual({
        startsAt: "2026-03-29T01:30:00.000Z",
        endsAt: "2026-03-29T02:00:00.000Z", // 03:00 BST
      });
    });

    it("resolves the Europe/London overlap to the first occurrence", () => {
      // 2026-10-25T01:00Z: 01:59 BST -> 01:00 GMT. Local 01:30 happens twice
      // (00:30Z as BST, 01:30Z as GMT); we take the earlier, BST one.
      expect(
        materializeTemplateShift(
          new Date("2026-10-25T12:00:00.000Z"), // 12:00 GMT, Oct 25 in London
          {
            startMinuteOfDay: 90, // 01:30
            endMinuteOfDay: 180, // 03:00
            startDayOffset: 0,
            endsNextDay: false,
          },
          "Europe/London",
        ),
      ).toEqual({
        startsAt: "2026-10-25T00:30:00.000Z",
        endsAt: "2026-10-25T03:00:00.000Z", // 03:00 GMT
      });
    });

    it("resolves the Australia/Sydney overlap to the first occurrence", () => {
      // 2026-04-04T16:00Z: 02:59 AEDT -> 02:00 AEST. Local 02:30 happens twice
      // (15:30Z as AEDT, 16:30Z as AEST); we take the earlier, AEDT one.
      expect(
        materializeTemplateShift(
          new Date("2026-04-05T02:00:00.000Z"), // 12:00 AEST, Apr 5 in Sydney
          {
            startMinuteOfDay: 150, // 02:30
            endMinuteOfDay: 300, // 05:00
            startDayOffset: 0,
            endsNextDay: false,
          },
          "Australia/Sydney",
        ),
      ).toEqual({
        startsAt: "2026-04-04T15:30:00.000Z",
        endsAt: "2026-04-04T19:00:00.000Z", // 05:00 AEST
      });
    });

    it("resolves the Australia/Sydney gap with the pre-transition offset", () => {
      // 2026-10-03T16:00Z: 01:59 AEST -> 03:00 AEDT. Local 02:30 never happens;
      // pre-transition offset is AEST (+10), so it resolves to 16:30Z
      // (= 03:30 AEDT).
      expect(
        materializeTemplateShift(
          new Date("2026-10-04T02:00:00.000Z"), // 13:00 AEDT, Oct 4 in Sydney
          {
            startMinuteOfDay: 150, // 02:30
            endMinuteOfDay: 300, // 05:00
            startDayOffset: 0,
            endsNextDay: false,
          },
          "Australia/Sydney",
        ),
      ).toEqual({
        startsAt: "2026-10-03T16:30:00.000Z",
        endsAt: "2026-10-03T18:00:00.000Z", // 05:00 AEDT
      });
    });

    it("handles Australia/Lord_Howe's 30-minute DST shift", () => {
      const LORD_HOWE = "Australia/Lord_Howe";

      // Gap is only 30 minutes wide: 2026-10-03T15:30Z, 01:59 (+10:30) ->
      // 02:30 (+11). Local 02:15 never happens; pre-transition offset is
      // +10:30, so 02:15 resolves to 15:45Z (= 02:45 (+11)).
      expect(
        materializeTemplateShift(
          new Date("2026-10-04T02:00:00.000Z"), // 13:00 (+11), Oct 4 on Lord Howe
          {
            startMinuteOfDay: 135, // 02:15
            endMinuteOfDay: 300, // 05:00
            startDayOffset: 0,
            endsNextDay: false,
          },
          LORD_HOWE,
        ),
      ).toEqual({
        startsAt: "2026-10-03T15:45:00.000Z",
        endsAt: "2026-10-03T18:00:00.000Z",
      });

      // Overlap is also 30 minutes: 2026-04-04T15:00Z, 01:59 (+11) ->
      // 01:30 (+10:30). Local 01:45 happens twice (14:45Z, 15:15Z).
      expect(
        materializeTemplateShift(
          new Date("2026-04-05T02:00:00.000Z"), // 12:30 (+10:30), Apr 5 on Lord Howe
          {
            startMinuteOfDay: 105, // 01:45
            endMinuteOfDay: 300, // 05:00
            startDayOffset: 0,
            endsNextDay: false,
          },
          LORD_HOWE,
        ),
      ).toEqual({
        startsAt: "2026-04-04T14:45:00.000Z",
        endsAt: "2026-04-04T18:30:00.000Z", // 05:00 (+10:30)
      });
    });

    it("resolves fractional-hour zones that never observe DST", () => {
      const reference2 = new Date("2026-06-15T06:00:00.000Z");
      const preset = {
        startMinuteOfDay: 18 * 60,
        endMinuteOfDay: 22 * 60,
        startDayOffset: 0,
        endsNextDay: false,
      };

      // +05:30, no transitions at all — both bracket probes agree.
      expect(
        materializeTemplateShift(reference2, preset, "Asia/Kolkata"),
      ).toEqual({
        startsAt: "2026-06-15T12:30:00.000Z",
        endsAt: "2026-06-15T16:30:00.000Z",
      });

      // +05:45.
      expect(
        materializeTemplateShift(reference2, preset, "Asia/Kathmandu"),
      ).toEqual({
        startsAt: "2026-06-15T12:15:00.000Z",
        endsAt: "2026-06-15T16:15:00.000Z",
      });
    });
  });

  describe("defensive input handling", () => {
    it("falls back to UTC rather than throwing on an unknown zone id", () => {
      // `Intl.DateTimeFormat` throws RangeError on a bad zone. This runs after
      // roles were already created server-side, so throwing would strand the
      // organizer with roles and no drafts.
      expect(
        materializeTemplateShift(
          new Date("2026-06-15T18:00:00.000Z"),
          {
            startMinuteOfDay: 16 * 60,
            endMinuteOfDay: 18 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          "Not/AZone",
        ),
      ).toEqual({
        startsAt: "2026-06-15T16:00:00.000Z",
        endsAt: "2026-06-15T18:00:00.000Z",
      });
    });

    it("throws on a non-finite minute-of-day, like the pre-FR-006 code did", () => {
      const shift = {
        startMinuteOfDay: Number.NaN,
        endMinuteOfDay: 18 * 60,
        startDayOffset: 0,
        endsNextDay: false,
      };
      expect(() => materializeTemplateShift(reference, shift, CHICAGO)).toThrow(
        RangeError,
      );
      // The oracle agrees: `setMinutes(NaN)` makes an invalid Date and
      // `toISOString()` throws. Silently coercing to 00:00 would diverge.
      expect(() => legacyMaterializeTemplateShift(reference, shift)).toThrow(
        RangeError,
      );
    });

    it("carries a minute-of-day past 1439 into the next calendar day", () => {
      // Unreachable from stored presets (schema clamps to 0–1439) but the carry
      // keeps out-of-range input on a real wall clock instead of one Date.UTC
      // normalizes behind the read-back check.
      expect(
        materializeTemplateShift(
          reference,
          {
            startMinuteOfDay: 25 * 60, // 01:00 the following day
            endMinuteOfDay: 26 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          CHICAGO,
        ),
      ).toEqual({
        startsAt: "2026-06-16T06:00:00.000Z", // 01:00 CDT Jun 16
        endsAt: "2026-06-16T07:00:00.000Z",
      });
    });
  });

  /**
   * Zones whose DST transition happens AT midnight (America/Havana springs
   * forward 2026-03-08 00:00 -> 01:00; America/Santiago 2026-09-06 00:00 ->
   * 01:00) break the legacy implementation outright, and we deliberately do
   * NOT reproduce that.
   *
   * Legacy builds `new Date(y, m, d, 0, 0, 0, 0)` and then calls
   * `setMinutes(minuteOfDay)` on it. In those zones that midnight does not
   * exist, so the constructor resolves it to 01:00 local — and `setMinutes`
   * then stamps the time-of-day onto hour 1 instead of hour 0. Every preset on
   * that day comes out an hour late: a 16:00 doors preset materializes as
   * 17:00. That is the same class of defect FR-006 exists to remove, so the
   * new resolver returns the requested wall clock instead and the equivalence
   * matrix below skips these cases explicitly rather than silently.
   */
  describe("midnight-transition zones (deliberate divergence from legacy)", () => {
    it("keeps the requested wall clock in America/Havana on its gap day", () => {
      // Legacy answers 2026-03-08T21:00Z here (17:00 local) because its
      // midnight base was shoved to 01:00. 16:00 CDT is 20:00Z.
      expect(
        materializeTemplateShift(
          new Date("2026-03-08T18:00:00.000Z"), // 14:00 CDT, Mar 8 in Havana
          {
            startMinuteOfDay: 16 * 60,
            endMinuteOfDay: 18 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          "America/Havana",
        ),
      ).toEqual({
        startsAt: "2026-03-08T20:00:00.000Z",
        endsAt: "2026-03-08T22:00:00.000Z",
      });
    });

    it("keeps the requested wall clock in America/Santiago on its gap day", () => {
      // 2026-09-06 00:00 -> 01:00 (-04 -> -03). 16:00 local is 19:00Z.
      expect(
        materializeTemplateShift(
          new Date("2026-09-06T15:00:00.000Z"), // 12:00 -03, Sep 6 in Santiago
          {
            startMinuteOfDay: 16 * 60,
            endMinuteOfDay: 18 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          "America/Santiago",
        ),
      ).toEqual({
        startsAt: "2026-09-06T19:00:00.000Z",
        endsAt: "2026-09-06T21:00:00.000Z",
      });
    });

    it("still resolves a time inside the midnight gap itself", () => {
      // 00:30 on 2026-03-08 never happens in Havana. Pre-transition offset is
      // -05, so it resolves to 05:30Z (= 01:30 CDT) — the ECMAScript rule,
      // consistent with every other gap.
      expect(
        materializeTemplateShift(
          new Date("2026-03-08T18:00:00.000Z"),
          {
            startMinuteOfDay: 30,
            endMinuteOfDay: 2 * 60,
            startDayOffset: 0,
            endsNextDay: false,
          },
          "America/Havana",
        ).startsAt,
      ).toBe("2026-03-08T05:30:00.000Z");
    });
  });

  /**
   * Does the legacy oracle's midnight base land somewhere other than 00:00?
   * True only in a zone whose DST transition is at midnight, on the transition
   * day — the documented divergence above. Reads the runner's zone, which is
   * exactly the zone the matrix compares in.
   */
  function legacyMidnightIsSkipped(
    reference: Date,
    startDayOffset: number,
    endsNextDay: boolean,
  ): boolean {
    const base = new Date(
      reference.getFullYear(),
      reference.getMonth(),
      reference.getDate(),
      0,
      0,
      0,
      0,
    );
    base.setDate(base.getDate() + startDayOffset);
    if (base.getHours() !== 0) return true;
    if (endsNextDay) {
      const end = new Date(base);
      end.setDate(end.getDate() + 1);
      if (end.getHours() !== 0) return true;
    }
    return false;
  }

  // NFR-001: for an event whose zone is the browser's zone, the new
  // timezone-aware resolver must be byte-identical to the old local-time one.
  describe("equivalence with the pre-FR-006 implementation", () => {
    it("matches the legacy output across the preset matrix", () => {
      const references = [
        new Date("2026-06-15T18:00:00.000Z"), // ordinary summer day
        new Date("2026-01-20T18:00:00.000Z"), // ordinary winter day
        new Date("2026-03-08T18:00:00.000Z"), // US spring forward
        new Date("2026-03-07T18:00:00.000Z"), // day before it
        new Date("2026-11-01T18:00:00.000Z"), // US fall back
        new Date("2026-10-31T18:00:00.000Z"), // day before it
        // EU/AU transition weekend: 2026-03-29 is the EU spring-forward and the
        // AU fall-back is 2026-04-05; 2026-10-04 is the AU spring-forward and
        // 2026-10-25 the EU fall-back. Without these the matrix only exercises
        // DST edges when the runner happens to be in a US zone.
        new Date("2026-03-29T12:00:00.000Z"),
        new Date("2026-04-05T12:00:00.000Z"),
        new Date("2026-10-04T12:00:00.000Z"),
        new Date("2026-10-25T12:00:00.000Z"),
        new Date("2026-09-27T12:00:00.000Z"), // Lord Howe / NZ spring forward
        // Midnight-transition zones (Havana 2026-03-08, Santiago 2026-09-06 /
        // 2026-04-05). Mostly skipped by `legacyMidnightIsSkipped`; here so the
        // surrounding days still get compared under those zones.
        new Date("2026-09-06T15:00:00.000Z"),
        new Date("2026-12-31T18:00:00.000Z"), // year boundary
        new Date("2028-02-29T18:00:00.000Z"), // leap day
      ];
      const minutes = [
        0,
        1,
        60, // 01:00 — inside the US fall-back ambiguous band
        90, // 01:30 — ditto, and inside the EU/AU gap on their transition days
        2 * 60 + 30,
        9 * 60,
        12 * 60 + 30,
        16 * 60,
        23 * 60 + 59,
      ];
      const dayOffsets = [-7, -1, 0, 1, 14];

      let compared = 0;
      let skippedMidnightGap = 0;
      for (const reference of references) {
        for (const startMinuteOfDay of minutes) {
          for (const endMinuteOfDay of minutes) {
            for (const startDayOffset of dayOffsets) {
              for (const endsNextDay of [false, true]) {
                if (
                  legacyMidnightIsSkipped(
                    reference,
                    startDayOffset,
                    endsNextDay,
                  )
                ) {
                  // Documented divergence — see the "midnight-transition zones"
                  // block above. The legacy oracle is wrong here, not us.
                  skippedMidnightGap += 1;
                  continue;
                }
                const shift = {
                  startMinuteOfDay,
                  endMinuteOfDay,
                  startDayOffset,
                  endsNextDay,
                };
                const next = materializeTemplateShift(
                  reference,
                  shift,
                  RUNNER_TZ,
                );
                const legacy = legacyMaterializeTemplateShift(reference, shift);
                expect({
                  ...shift,
                  ref: reference.toISOString(),
                  ...next,
                }).toEqual({
                  ...shift,
                  ref: reference.toISOString(),
                  ...legacy,
                });
                compared += 1;
              }
            }
          }
        }
      }
      const total =
        references.length *
        minutes.length *
        minutes.length *
        dayOffsets.length *
        2;
      expect(compared + skippedMidnightGap).toBe(total);
      // Guard against the carve-out quietly widening. Two independent checks:
      //
      //  1. Granularity. The predicate is evaluated per
      //     (reference, dayOffset, endsNextDay) triple, OUTSIDE the two minute
      //     loops, so skips can only ever arrive in whole blocks of
      //     minutes.length ** 2. A predicate that started discriminating on
      //     minute-of-day would break this exactly. This is the check with
      //     real signal — it is structural, not a magnitude guess.
      //  2. Magnitude. Only midnight-transition zones skip at all. MEASURED,
      //     not estimated: America/Havana skips 1053/11340 (9.3%, 13 triples),
      //     America/Santiago and Asia/Beirut less, every other zone zero. 20%
      //     leaves roughly 2x headroom over the worst real zone while still
      //     catching a predicate degenerating toward always-true.
      expect(skippedMidnightGap % (minutes.length * minutes.length)).toBe(0);
      expect(compared).toBeGreaterThan(total * 0.8);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-005 — anchored resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("templateShiftDurationMinutes", () => {
  it("is end minus start for a same-day shift", () => {
    expect(
      templateShiftDurationMinutes({
        startMinuteOfDay: 16 * 60,
        endMinuteOfDay: 18 * 60 + 30,
        endsNextDay: false,
      }),
    ).toBe(150);
  });

  it("adds a day when the shift wraps past midnight", () => {
    expect(
      templateShiftDurationMinutes({
        startMinuteOfDay: 22 * 60,
        endMinuteOfDay: 2 * 60,
        endsNextDay: true,
      }),
    ).toBe(4 * 60);
  });

  it("treats a full loop as 24 hours, not zero", () => {
    expect(
      templateShiftDurationMinutes({
        startMinuteOfDay: 9 * 60,
        endMinuteOfDay: 9 * 60,
        endsNextDay: true,
      }),
    ).toBe(24 * 60);
  });

  it("wraps a malformed row (end < start, flag unset) rather than going backwards", () => {
    // upsertRoleTemplateShifts infers endsNextDay, so this shape shouldn't
    // exist — but if it does, a negative duration would resolve an end BEFORE
    // the start.
    expect(
      templateShiftDurationMinutes({
        startMinuteOfDay: 22 * 60,
        endMinuteOfDay: 2 * 60,
        endsNextDay: false,
      }),
    ).toBe(4 * 60);
  });
});

describe("resolveTemplateShift", () => {
  const CHICAGO = "America/Chicago";
  // 2026-06-15, safely away from any DST edge in Chicago (CDT, UTC-5).
  const eveningShow = {
    timeZone: CHICAGO,
    reference: new Date("2026-06-16T01:00:00.000Z"), // 20:00 CDT on the 15th
    startsAt: new Date("2026-06-16T01:00:00.000Z"), // 20:00 CDT
    endsAt: new Date("2026-06-16T04:00:00.000Z"), // 23:00 CDT
  };
  const matinee = {
    timeZone: CHICAGO,
    reference: new Date("2026-06-15T19:00:00.000Z"), // 14:00 CDT
    startsAt: new Date("2026-06-15T19:00:00.000Z"), // 14:00 CDT
    endsAt: new Date("2026-06-15T22:00:00.000Z"), // 17:00 CDT
  };

  describe("WALL_CLOCK", () => {
    const wallClockPreset = {
      startMinuteOfDay: 16 * 60,
      endMinuteOfDay: 18 * 60 + 30,
      startDayOffset: 0,
      endsNextDay: false,
    };

    it("is byte-identical to materializeTemplateShift when the anchor is absent", () => {
      expect(resolveTemplateShift(wallClockPreset, eveningShow)).toEqual({
        ok: true,
        ...materializeTemplateShift(
          eveningShow.reference,
          wallClockPreset,
          CHICAGO,
        ),
      });
    });

    it("is byte-identical when the anchor is set explicitly", () => {
      expect(
        resolveTemplateShift(
          { ...wallClockPreset, anchor: "WALL_CLOCK" },
          eveningShow,
        ),
      ).toEqual({
        ok: true,
        ...materializeTemplateShift(
          eveningShow.reference,
          wallClockPreset,
          CHICAGO,
        ),
      });
    });

    it("ignores offsetMinutes entirely", () => {
      // The schema refuses a non-zero offset on a WALL_CLOCK preset; if one
      // ever reaches the resolver it must not move the shift.
      expect(
        resolveTemplateShift(
          { ...wallClockPreset, anchor: "WALL_CLOCK", offsetMinutes: -180 },
          eveningShow,
        ),
      ).toEqual({
        ok: true,
        startsAt: "2026-06-15T21:00:00.000Z",
        endsAt: "2026-06-15T23:30:00.000Z",
      });
    });

    it("resolves with no start or end on the target at all", () => {
      // A wall-clock preset never consults the anchors, so a target with
      // nothing but a reference day still resolves.
      expect(
        resolveTemplateShift(wallClockPreset, {
          timeZone: CHICAGO,
          reference: eveningShow.reference,
          startsAt: null,
          endsAt: null,
        }),
      ).toEqual({
        ok: true,
        startsAt: "2026-06-15T21:00:00.000Z",
        endsAt: "2026-06-15T23:30:00.000Z",
      });
    });
  });

  describe("EVENT_START", () => {
    // "Load-in, 3 hours before the show, runs 2.5 hours."
    const loadIn = {
      startMinuteOfDay: 16 * 60,
      endMinuteOfDay: 18 * 60 + 30,
      startDayOffset: 0,
      endsNextDay: false,
      anchor: "EVENT_START" as const,
      offsetMinutes: -180,
    };

    it("resolves to 17:00 for a 20:00 show (acceptance criterion)", () => {
      expect(resolveTemplateShift(loadIn, eveningShow)).toEqual({
        ok: true,
        startsAt: "2026-06-15T22:00:00.000Z", // 17:00 CDT
        endsAt: "2026-06-16T00:30:00.000Z", // 19:30 CDT
      });
    });

    it("resolves the SAME preset to 11:00 for a 14:00 matinee", () => {
      expect(resolveTemplateShift(loadIn, matinee)).toEqual({
        ok: true,
        startsAt: "2026-06-15T16:00:00.000Z", // 11:00 CDT
        endsAt: "2026-06-15T18:30:00.000Z", // 13:30 CDT
      });
    });

    it("resolves in the EVENT's zone, not the runner's", () => {
      // Same instants, a venue in Tokyo. The wall clock the organizer sees is
      // the venue's; the resolved instants are anchor-relative either way, so
      // the check that matters is that the zone id never changes the result
      // for a pure-offset anchor — and that the day offset below does.
      expect(
        resolveTemplateShift(loadIn, {
          ...eveningShow,
          timeZone: "Asia/Tokyo",
        }),
      ).toEqual({
        ok: true,
        startsAt: "2026-06-15T22:00:00.000Z",
        endsAt: "2026-06-16T00:30:00.000Z",
      });
    });

    it("accepts a positive offset (crew arrives after doors)", () => {
      expect(
        resolveTemplateShift({ ...loadIn, offsetMinutes: 30 }, eveningShow),
      ).toEqual({
        ok: true,
        startsAt: "2026-06-16T01:30:00.000Z", // 20:30 CDT
        endsAt: "2026-06-16T04:00:00.000Z", // 23:00 CDT
      });
    });

    it("treats a missing offset as 0 (starts exactly with the show)", () => {
      const { offsetMinutes: _omitted, ...noOffset } = loadIn;
      expect(resolveTemplateShift(noOffset, eveningShow)).toEqual({
        ok: true,
        startsAt: "2026-06-16T01:00:00.000Z",
        endsAt: "2026-06-16T03:30:00.000Z",
      });
    });

    it("reports missing_event_start when the occurrence has no start", () => {
      expect(
        resolveTemplateShift(loadIn, { ...eveningShow, startsAt: null }),
      ).toEqual({ ok: false, reason: "missing_event_start" });
    });

    it("keeps the wrapped duration when endsNextDay is set", () => {
      expect(
        resolveTemplateShift(
          {
            startMinuteOfDay: 22 * 60,
            endMinuteOfDay: 2 * 60,
            startDayOffset: 0,
            endsNextDay: true,
            anchor: "EVENT_START",
            offsetMinutes: 0,
          },
          eveningShow,
        ),
      ).toEqual({
        ok: true,
        startsAt: "2026-06-16T01:00:00.000Z",
        endsAt: "2026-06-16T05:00:00.000Z", // +4h, the stored duration
      });
    });
  });

  describe("EVENT_END", () => {
    // "Cleanup starts when the show ends, runs 90 minutes."
    const cleanup = {
      startMinuteOfDay: 0,
      endMinuteOfDay: 90,
      startDayOffset: 0,
      endsNextDay: false,
      anchor: "EVENT_END" as const,
      offsetMinutes: 0,
    };

    it("resolves against the occurrence's end", () => {
      expect(resolveTemplateShift(cleanup, eveningShow)).toEqual({
        ok: true,
        startsAt: "2026-06-16T04:00:00.000Z", // 23:00 CDT
        endsAt: "2026-06-16T05:30:00.000Z", // 00:30 CDT next day
      });
    });

    it("accepts a negative offset (bar closes before the last song)", () => {
      expect(
        resolveTemplateShift({ ...cleanup, offsetMinutes: -30 }, eveningShow),
      ).toEqual({
        ok: true,
        startsAt: "2026-06-16T03:30:00.000Z",
        endsAt: "2026-06-16T05:00:00.000Z",
      });
    });

    /**
     * The `EventDate.endsAt IS NULL` case. Spec-mandated: represent it, never
     * guess. Falling back to the parent `Event.endsAt` would invent a shift
     * time from a DIFFERENT date's show.
     */
    it("reports missing_event_end for a recurring occurrence with no end time", () => {
      expect(
        resolveTemplateShift(cleanup, {
          timeZone: CHICAGO,
          reference: new Date("2026-06-16T01:00:00.000Z"),
          startsAt: new Date("2026-06-16T01:00:00.000Z"),
          endsAt: null, // EventDate.endsAt is nullable, unlike Event.endsAt
        }),
      ).toEqual({ ok: false, reason: "missing_event_end" });
    });

    it("does not borrow a start time when the end is missing", () => {
      // Guards the specific wrong fix: resolving EVENT_END off `startsAt`.
      const result = resolveTemplateShift(cleanup, {
        timeZone: CHICAGO,
        reference: new Date("2026-06-16T01:00:00.000Z"),
        startsAt: new Date("2026-06-16T01:00:00.000Z"),
        endsAt: null,
      });
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("startsAt");
    });

    it("still resolves an EVENT_START preset on the same end-less occurrence", () => {
      // Only the EVENT_END row is disabled; the rest of the pack still applies.
      expect(
        resolveTemplateShift(
          {
            startMinuteOfDay: 0,
            endMinuteOfDay: 60,
            startDayOffset: 0,
            endsNextDay: false,
            anchor: "EVENT_START",
            offsetMinutes: -60,
          },
          {
            timeZone: CHICAGO,
            reference: new Date("2026-06-16T01:00:00.000Z"),
            startsAt: new Date("2026-06-16T01:00:00.000Z"),
            endsAt: null,
          },
        ),
      ).toEqual({
        ok: true,
        startsAt: "2026-06-16T00:00:00.000Z",
        endsAt: "2026-06-16T01:00:00.000Z",
      });
    });
  });

  describe("startDayOffset composed with an anchor", () => {
    it("moves the resolved instant by whole venue days", () => {
      expect(
        resolveTemplateShift(
          {
            startMinuteOfDay: 0,
            endMinuteOfDay: 120,
            startDayOffset: 1,
            endsNextDay: false,
            anchor: "EVENT_START",
            offsetMinutes: -60,
          },
          eveningShow,
        ),
      ).toEqual({
        ok: true,
        // 19:00 CDT on the 15th, moved to 19:00 CDT on the 16th.
        startsAt: "2026-06-17T00:00:00.000Z",
        endsAt: "2026-06-17T02:00:00.000Z",
      });
    });

    it("accepts a negative day offset (load-in the day before)", () => {
      expect(
        resolveTemplateShift(
          {
            startMinuteOfDay: 0,
            endMinuteOfDay: 180,
            startDayOffset: -1,
            endsNextDay: false,
            anchor: "EVENT_START",
            offsetMinutes: 0,
          },
          eveningShow,
        ),
      ).toEqual({
        ok: true,
        startsAt: "2026-06-15T01:00:00.000Z", // 20:00 CDT on the 14th
        endsAt: "2026-06-15T04:00:00.000Z",
      });
    });

    it("keeps the venue wall clock across a spring-forward day (23-hour day)", () => {
      // 2026-03-07 20:00 CST (-6) + 1 venue day = 2026-03-08 20:00 CDT (-5).
      // A naive +86_400_000ms would land at 21:00 CDT.
      expect(
        resolveTemplateShift(
          {
            startMinuteOfDay: 0,
            endMinuteOfDay: 60,
            startDayOffset: 1,
            endsNextDay: false,
            anchor: "EVENT_START",
            offsetMinutes: 0,
          },
          {
            timeZone: CHICAGO,
            reference: new Date("2026-03-08T02:00:00.000Z"),
            startsAt: new Date("2026-03-08T02:00:00.000Z"), // 20:00 CST on the 7th
            endsAt: new Date("2026-03-08T05:00:00.000Z"),
          },
        ),
      ).toEqual({
        ok: true,
        startsAt: "2026-03-09T01:00:00.000Z", // 20:00 CDT on the 8th
        endsAt: "2026-03-09T02:00:00.000Z",
      });
    });

    it("keeps the venue wall clock across a fall-back day (25-hour day)", () => {
      // 2026-10-31 20:00 CDT (-5) + 1 venue day = 2026-11-01 20:00 CST (-6).
      expect(
        resolveTemplateShift(
          {
            startMinuteOfDay: 0,
            endMinuteOfDay: 60,
            startDayOffset: 1,
            endsNextDay: false,
            anchor: "EVENT_START",
            offsetMinutes: 0,
          },
          {
            timeZone: CHICAGO,
            reference: new Date("2026-11-01T01:00:00.000Z"),
            startsAt: new Date("2026-11-01T01:00:00.000Z"), // 20:00 CDT on Oct 31
            endsAt: new Date("2026-11-01T04:00:00.000Z"),
          },
        ),
      ).toEqual({
        ok: true,
        startsAt: "2026-11-02T02:00:00.000Z", // 20:00 CST on Nov 1
        endsAt: "2026-11-02T03:00:00.000Z",
      });
    });

    it("leaves the instant untouched when the day offset is 0, even inside a fall-back overlap", () => {
      // 2026-11-01 01:30 CDT — the first of the two 01:30s in Chicago.
      // Round-tripping through a wall clock and back would be lossy here; the
      // day-offset-0 short circuit is what keeps this exact.
      const ambiguousStart = new Date("2026-11-01T06:30:00.000Z");
      expect(
        resolveTemplateShift(
          {
            startMinuteOfDay: 0,
            endMinuteOfDay: 60,
            startDayOffset: 0,
            endsNextDay: false,
            anchor: "EVENT_START",
            offsetMinutes: 0,
          },
          {
            timeZone: CHICAGO,
            reference: ambiguousStart,
            startsAt: ambiguousStart,
            endsAt: new Date("2026-11-01T08:00:00.000Z"),
          },
        ),
      ).toEqual({
        ok: true,
        startsAt: "2026-11-01T06:30:00.000Z",
        endsAt: "2026-11-01T07:30:00.000Z",
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anchor editing (FR-017) — the fields behind the "Starts / By / Lasts" control
// ─────────────────────────────────────────────────────────────────────────────

describe("parseShiftDraftFields — anchors", () => {
  const baseFields = emptyShiftDraftFields();

  it("defaults an untouched row to WALL_CLOCK with no offset", () => {
    expect(baseFields.anchor).toBe("WALL_CLOCK");
    expect(baseFields.offsetMinutes).toBe("0");
  });

  it("carries a signed offset on an anchored preset", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Load-in",
      startTime: "16:00",
      endTime: "18:30",
      anchor: "EVENT_START",
      offsetMinutes: "-180",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.anchor).toBe("EVENT_START");
    expect(result.value.offsetMinutes).toBe(-180);
  });

  it("forces the offset to 0 on a WALL_CLOCK preset", () => {
    // The server refuses a non-zero offset there — one representation of
    // "no offset", and a stale value can't come back to life on a switch.
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Doors",
      startTime: "18:00",
      endTime: "19:00",
      anchor: "WALL_CLOCK",
      offsetMinutes: "-180",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.offsetMinutes).toBe(0);
  });

  it("rejects an offset beyond a day", () => {
    const result = parseShiftDraftFields({
      ...baseFields,
      label: "Load-in",
      startTime: "16:00",
      endTime: "18:30",
      anchor: "EVENT_START",
      offsetMinutes: "-18000",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.offsetMinutes).toBe("offset_invalid");
  });
});

describe("shift draft duration helpers", () => {
  const baseFields = emptyShiftDraftFields();

  it("reads the duration off the clock fields", () => {
    expect(
      shiftDraftDurationMinutes({ startTime: "16:00", endTime: "18:30" }),
    ).toBe(150);
  });

  it("wraps past midnight", () => {
    expect(
      shiftDraftDurationMinutes({ startTime: "23:00", endTime: "01:00" }),
    ).toBe(120);
  });

  it("returns null when the fields are incomplete", () => {
    expect(
      shiftDraftDurationMinutes({ startTime: "", endTime: "" }),
    ).toBeNull();
  });

  it("returns null for a zero-length row instead of claiming 24 hours", () => {
    // `parseShiftDraftFields` rejects this row as `ends_equal_start`, so a
    // confident "24 h 0 min" in the anchored editor's "Lasts" field is a lie
    // about a value the organizer cannot see (the clock inputs are hidden) and
    // cannot save.
    expect(
      shiftDraftDurationMinutes({ startTime: "18:00", endTime: "18:00" }),
    ).toBeNull();

    const parsed = parseShiftDraftFields({
      ...emptyShiftDraftFields(),
      label: "Doors",
      startTime: "18:00",
      endTime: "18:00",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.endTime).toBe("ends_equal_start");
  });

  it("sets a duration by moving the end time", () => {
    expect(
      withShiftDraftDurationMinutes(
        { startTime: "16:00", endTime: "17:00" },
        150,
      ),
    ).toEqual({ startTime: "16:00", endTime: "18:30" });
  });

  it("seeds a carrier start when the row has none", () => {
    // An anchored preset hides the clock fields but still needs a stored
    // minute-of-day; noon never wraps a same-day duration past midnight.
    expect(withShiftDraftDurationMinutes({ ...baseFields }, 120)).toEqual({
      startTime: ANCHORED_CARRIER_START_TIME,
      endTime: "14:00",
    });
  });

  it("splits minutes for the two numeric inputs", () => {
    expect(splitMinutesToHoursAndMinutes(-195)).toEqual({
      hours: 3,
      minutes: 15,
    });
  });
});
