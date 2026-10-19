import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";
import type {
  BulkUpsertEventSeriesOccurrenceRow,
  EventSeriesOccurrenceRecord,
  EventSeriesRecord,
} from "@th/types";

import { expandSeries } from "../expand-series";
import type { ExpandSeriesDeps } from "../expand-series";

// ── Fixtures ─────────────────────────────────────────────────────────────
//
// Focus of this suite: RRULE shape handling emitted by the event-builder
// recurrence UI — COUNT=N, INTERVAL>2, and BYSETPOS (monthly nth/last
// weekday) — including the interaction between COUNT and the
// maxOccurrencesPerExpand cap. Enumeration itself is delegated to the
// `rrule` package; these tests pin the use case's windowing/cap/dedup
// wiring around it.

const SERIES_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-04-01T12:00:00.000Z");

/** Mondays: Apr 6 is the dtstart anchor for the weekly rules below. */
const DTSTART = "2026-04-06T18:00:00.000Z";

function makeSeriesRecord(
  overrides?: Partial<EventSeriesRecord>,
): EventSeriesRecord {
  return {
    id: SERIES_ID,
    ownerScope: "HUMAN",
    ownerId: ACTOR_ID,
    name: "Weekly Jam",
    description: null,
    active: true,
    timezone: "UTC",
    schedule: {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstart: DTSTART,
      until: null,
      dates: null,
      windowStart: null,
      windowEnd: null,
      maxOccurrencesPerExpand: 100,
    },
    templateId: null,
    defaults: null,
    createdByHumanId: ACTOR_ID,
    updatedByHumanId: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function makeClock(): ClockPort {
  return { now: () => NOW };
}

function makeIdempotency(): IdempotencyPort {
  return {
    get: vi.fn(async () => null),
    begin: vi.fn(async () => true),
    commit: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  } as unknown as IdempotencyPort;
}

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

/**
 * In-memory occurrence store backing listBySeries / uniqueCheck / bulkUpsert
 * so expandSeries can read back what it just wrote (fetchCreatedOccurrences).
 */
function makeOccurrenceStore(seed: EventSeriesOccurrenceRecord[] = []) {
  const records: EventSeriesOccurrenceRecord[] = [...seed];

  const listBySeries = vi.fn(
    async (input: {
      seriesId: string;
      limit: number;
      cursor?: string;
      range?: { start: Date; end: Date };
    }) => {
      const items = records
        .filter((rec) =>
          input.range
            ? rec.startsAt.getTime() >= input.range.start.getTime() &&
              rec.startsAt.getTime() <= input.range.end.getTime()
            : true,
        )
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      return { items, nextCursor: null };
    },
  );

  const uniqueCheck = vi.fn(
    async (input: { seriesId: string; ordinal: number; startsAt: Date }) =>
      !records.some(
        (rec) =>
          rec.ordinal === input.ordinal ||
          rec.startsAt.getTime() === input.startsAt.getTime(),
      ),
  );

  const bulkUpsert = vi.fn(
    async (input: { occurrences: BulkUpsertEventSeriesOccurrenceRow[] }) => {
      for (const row of input.occurrences) {
        records.push({
          id: nextUuid(),
          seriesId: row.seriesId,
          ordinal: row.ordinal,
          startsAt: row.startsAt,
          endsAt: row.endsAt ?? null,
          status: row.status,
          eventId: null,
          overrides: null,
          createdAt: NOW,
          updatedAt: NOW,
        } as EventSeriesOccurrenceRecord);
      }
      return { count: input.occurrences.length };
    },
  );

  return { records, listBySeries, uniqueCheck, bulkUpsert };
}

function makeSeedOccurrence(
  overrides: Partial<EventSeriesOccurrenceRecord> & {
    startsAt: Date;
    ordinal: number;
  },
): EventSeriesOccurrenceRecord {
  return {
    id: nextUuid(),
    seriesId: SERIES_ID,
    endsAt: null,
    status: "PLANNED",
    eventId: null,
    overrides: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  } as EventSeriesOccurrenceRecord;
}

function makeDeps(options?: {
  series?: EventSeriesRecord;
  seedOccurrences?: EventSeriesOccurrenceRecord[];
}): { deps: ExpandSeriesDeps; store: ReturnType<typeof makeOccurrenceStore> } {
  const store = makeOccurrenceStore(options?.seedOccurrences ?? []);
  const tx = {
    series: {
      getById: vi.fn(async () => options?.series ?? makeSeriesRecord()),
    },
    seriesOccurrences: {
      listBySeries: store.listBySeries,
      uniqueCheck: store.uniqueCheck,
      bulkUpsert: store.bulkUpsert,
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    audit: { log: vi.fn(async () => undefined) },
  };
  const repos = {
    tx: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as Repos;

  return {
    deps: { repos, idempotency: makeIdempotency(), clock: makeClock() },
    store,
  };
}

function baseInput(overrides?: Record<string, unknown>) {
  return {
    actorHumanId: ACTOR_ID,
    seriesId: SERIES_ID,
    windowStart: "2026-04-01T00:00:00.000Z",
    windowEnd: "2026-12-31T00:00:00.000Z",
    clientKey: "expand-test-key",
    ...overrides,
  };
}

function createdIsoStarts(result: {
  occurrences: Array<{ startsAt: Date }>;
}): string[] {
  return result.occurrences.map((occ) => occ.startsAt.toISOString());
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("expandSeries — RRULE shapes (COUNT / INTERVAL / BYSETPOS)", () => {
  // COUNT stops enumeration even when the window extends far beyond, and
  // dtstart's own occurrence is #1 of the COUNT.
  it("COUNT=3: creates exactly 3 occurrences (dtstart included) despite a far windowEnd", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        schedule: {
          kind: "RRULE",
          rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
          dtstart: DTSTART,
          until: null,
          dates: null,
          windowStart: null,
          windowEnd: null,
          maxOccurrencesPerExpand: 100,
        },
      }),
    });

    const result = await expandSeries(deps, baseInput());

    expect(result.occurrencesCreated).toBe(3);
    expect(createdIsoStarts(result)).toEqual([
      "2026-04-06T18:00:00.000Z",
      "2026-04-13T18:00:00.000Z",
      "2026-04-20T18:00:00.000Z",
    ]);
  });

  // COUNT counts from dtstart — an occurrence already materialized at #1
  // (e.g. the converted source event) consumes one of the COUNT slots.
  it("COUNT=3: an existing occurrence at dtstart leaves only 2 to create", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        schedule: {
          kind: "RRULE",
          rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
          dtstart: DTSTART,
          until: null,
          dates: null,
          windowStart: null,
          windowEnd: null,
          maxOccurrencesPerExpand: 100,
        },
      }),
      seedOccurrences: [
        makeSeedOccurrence({
          startsAt: new Date(DTSTART),
          ordinal: 1,
          status: "PUBLISHED",
        }),
      ],
    });

    const result = await expandSeries(
      deps,
      baseInput({ clientKey: "expand-count-existing" }),
    );

    expect(result.occurrencesCreated).toBe(2);
    expect(createdIsoStarts(result)).toEqual([
      "2026-04-13T18:00:00.000Z",
      "2026-04-20T18:00:00.000Z",
    ]);
    // Ordinal 1 is taken by the converted occurrence.
    expect(result.occurrences.map((occ) => occ.ordinal)).toEqual([2, 3]);
  });

  // COUNT vs maxOccurrencesPerExpand: the smaller of the two wins.
  it("COUNT=5 with maxOccurrencesPerExpand=2: cap wins", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        schedule: {
          kind: "RRULE",
          rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=5",
          dtstart: DTSTART,
          until: null,
          dates: null,
          windowStart: null,
          windowEnd: null,
          maxOccurrencesPerExpand: 2,
        },
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({ clientKey: "expand-cap-wins" }),
    );

    expect(result.occurrencesCreated).toBe(2);
    expect(createdIsoStarts(result)).toEqual([
      "2026-04-06T18:00:00.000Z",
      "2026-04-13T18:00:00.000Z",
    ]);
  });

  it("COUNT=2 with default cap: COUNT wins", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        schedule: {
          kind: "RRULE",
          rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=2",
          dtstart: DTSTART,
          until: null,
          dates: null,
          windowStart: null,
          windowEnd: null,
          maxOccurrencesPerExpand: 100,
        },
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({ clientKey: "expand-count-wins" }),
    );

    expect(result.occurrencesCreated).toBe(2);
    expect(createdIsoStarts(result)).toEqual([
      "2026-04-06T18:00:00.000Z",
      "2026-04-13T18:00:00.000Z",
    ]);
  });

  // INTERVAL=3 weekly: dates land every third Monday, anchored at dtstart.
  it("INTERVAL=3 weekly: enumerates every third Monday only", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        schedule: {
          kind: "RRULE",
          rrule: "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO",
          dtstart: DTSTART,
          until: null,
          dates: null,
          windowStart: null,
          windowEnd: null,
          maxOccurrencesPerExpand: 100,
        },
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({
        windowEnd: "2026-06-30T00:00:00.000Z",
        clientKey: "expand-interval-3",
      }),
    );

    expect(createdIsoStarts(result)).toEqual([
      "2026-04-06T18:00:00.000Z",
      "2026-04-27T18:00:00.000Z",
      "2026-05-18T18:00:00.000Z",
      "2026-06-08T18:00:00.000Z",
      "2026-06-29T18:00:00.000Z",
    ]);
  });

  // BYSETPOS monthly "last Friday" across a 4-Friday month (Apr 2026) and a
  // 5-Friday month (May 2026: 1, 8, 15, 22, 29).
  it("BYSETPOS=-1 monthly: hits the last Friday in 4- and 5-Friday months", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        schedule: {
          kind: "RRULE",
          rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
          dtstart: "2026-04-24T18:00:00.000Z", // last Friday of April
          until: null,
          dates: null,
          windowStart: null,
          windowEnd: null,
          maxOccurrencesPerExpand: 100,
        },
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({
        windowEnd: "2026-06-30T00:00:00.000Z",
        clientKey: "expand-bysetpos",
      }),
    );

    const starts = createdIsoStarts(result);
    expect(starts).toEqual([
      "2026-04-24T18:00:00.000Z", // last Friday of April (4 Fridays)
      "2026-05-29T18:00:00.000Z", // last Friday of May (5 Fridays)
      "2026-06-26T18:00:00.000Z", // last Friday of June
    ]);
    // The 4th Friday of May (May 22) must NOT be selected in a 5-Friday month.
    expect(starts).not.toContain("2026-05-22T18:00:00.000Z");
  });

  // COUNT + BYSETPOS combined: monthly last-Friday, ends after 2 occurrences.
  it("COUNT=2 with BYSETPOS: stops after the second last-Friday", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        schedule: {
          kind: "RRULE",
          rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=2",
          dtstart: "2026-04-24T18:00:00.000Z",
          until: null,
          dates: null,
          windowStart: null,
          windowEnd: null,
          maxOccurrencesPerExpand: 100,
        },
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({
        windowEnd: "2027-12-31T00:00:00.000Z",
        clientKey: "expand-count-bysetpos",
      }),
    );

    expect(createdIsoStarts(result)).toEqual([
      "2026-04-24T18:00:00.000Z",
      "2026-05-29T18:00:00.000Z",
    ]);
  });
});

// ── Timezone regression ──────────────────────────────────────────────────
//
// `rrule` is timezone-blind: it reads/writes a Date's UTC fields and treats
// them as floating wall-clock. Driving it with real UTC instants evaluated
// BYDAY/BYHOUR against the UTC calendar, so a 19:00-local weekly series in a
// negative-offset zone (already the next UTC day) matched the WRONG weekday
// and every persisted occurrence landed one local day early. The cases in the
// suite above all use `timezone: "UTC"`, where the bug is invisible.

/** Render a persisted occurrence instant back into the series' zone. */
function localLabel(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant)
    .setZone(zone)
    .toFormat("EEE yyyy-MM-dd HH:mm");
}

function zonedSchedule(overrides: {
  rrule: string;
  dtstart: string;
  until?: string | null;
}): EventSeriesRecord["schedule"] {
  return {
    kind: "RRULE",
    rrule: overrides.rrule,
    dtstart: overrides.dtstart,
    until: overrides.until ?? null,
    dates: null,
    windowStart: null,
    windowEnd: null,
    maxOccurrencesPerExpand: 100,
  };
}

describe("expandSeries — RRULE is evaluated in the series' timezone", () => {
  it("FREQ=WEEKLY;BYDAY=MO at 19:00 America/Chicago persists Mondays at 19:00 local", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        timezone: "America/Chicago",
        // Mon 2026-09-14 19:00 Chicago == 2026-09-15T00:00Z, a TUESDAY in UTC.
        schedule: zonedSchedule({
          rrule: "FREQ=WEEKLY;BYDAY=MO",
          dtstart: "2026-09-14T19:00:00",
        }),
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({
        windowStart: "2026-09-01T00:00:00.000Z",
        windowEnd: "2026-11-01T00:00:00.000Z",
        clientKey: "expand-tz-chicago-weekly",
      }),
    );

    expect(
      result.occurrences.map((occ) =>
        localLabel(occ.startsAt, "America/Chicago"),
      ),
    ).toEqual([
      "Mon 2026-09-14 19:00",
      "Mon 2026-09-21 19:00",
      "Mon 2026-09-28 19:00",
      "Mon 2026-10-05 19:00",
      "Mon 2026-10-12 19:00",
      "Mon 2026-10-19 19:00",
      "Mon 2026-10-26 19:00",
    ]);

    for (const occ of result.occurrences) {
      const local = DateTime.fromJSDate(occ.startsAt).setZone(
        "America/Chicago",
      );
      expect(local.weekdayLong).toBe("Monday");
      expect(local.hour).toBe(19);
    }

    expect(createdIsoStarts(result)).toEqual([
      "2026-09-15T00:00:00.000Z",
      "2026-09-22T00:00:00.000Z",
      "2026-09-29T00:00:00.000Z",
      "2026-10-06T00:00:00.000Z",
      "2026-10-13T00:00:00.000Z",
      "2026-10-20T00:00:00.000Z",
      "2026-10-27T00:00:00.000Z",
    ]);

    // Ordinals stay contiguous from 1 — allocation is unchanged.
    expect(result.occurrences.map((occ) => occ.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("holds 19:00 America/New_York across the November fall-back", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        timezone: "America/New_York",
        schedule: zonedSchedule({
          rrule: "FREQ=WEEKLY;BYDAY=MO",
          dtstart: "2026-10-19T19:00:00",
        }),
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({
        windowStart: "2026-10-01T00:00:00.000Z",
        windowEnd: "2026-11-30T00:00:00.000Z",
        clientKey: "expand-tz-ny-dst",
      }),
    );

    expect(
      result.occurrences.map((occ) =>
        localLabel(occ.startsAt, "America/New_York"),
      ),
    ).toEqual([
      "Mon 2026-10-19 19:00",
      "Mon 2026-10-26 19:00",
      "Mon 2026-11-02 19:00",
      "Mon 2026-11-09 19:00",
      "Mon 2026-11-16 19:00",
      "Mon 2026-11-23 19:00",
    ]);

    // US DST ends Sun 2026-11-01: local 19:00 is pinned, the UTC instant steps.
    expect(createdIsoStarts(result)).toEqual([
      "2026-10-19T23:00:00.000Z", // EDT (-4)
      "2026-10-26T23:00:00.000Z", // EDT (-4)
      "2026-11-03T00:00:00.000Z", // EST (-5)
      "2026-11-10T00:00:00.000Z",
      "2026-11-17T00:00:00.000Z",
      "2026-11-24T00:00:00.000Z",
    ]);
  });

  it("FREQ=MONTHLY;BYDAY=1FR at 20:00 America/Chicago picks the first LOCAL Friday", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        timezone: "America/Chicago",
        schedule: zonedSchedule({
          rrule: "FREQ=MONTHLY;BYDAY=1FR",
          dtstart: "2026-09-04T20:00:00",
        }),
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({
        windowStart: "2026-09-01T00:00:00.000Z",
        windowEnd: "2027-01-01T00:00:00.000Z",
        clientKey: "expand-tz-chicago-monthly",
      }),
    );

    expect(
      result.occurrences.map((occ) =>
        localLabel(occ.startsAt, "America/Chicago"),
      ),
    ).toEqual([
      "Fri 2026-09-04 20:00",
      "Fri 2026-10-02 20:00",
      "Fri 2026-11-06 20:00",
      "Fri 2026-12-04 20:00",
    ]);

    for (const occ of result.occurrences) {
      const local = DateTime.fromJSDate(occ.startsAt).setZone(
        "America/Chicago",
      );
      expect(local.weekdayLong).toBe("Friday");
      expect(local.day).toBeLessThanOrEqual(7);
    }
  });

  it("works in a POSITIVE-offset zone too (Australia/Sydney, incl. its October DST start)", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        timezone: "Australia/Sydney",
        // 09:00 Sydney is the previous UTC day (a SUNDAY) — the mirror image
        // of the US-evening bug.
        schedule: zonedSchedule({
          rrule: "FREQ=WEEKLY;BYDAY=MO",
          dtstart: "2026-09-14T09:00:00",
        }),
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({
        windowStart: "2026-09-01T00:00:00.000Z",
        windowEnd: "2026-10-20T00:00:00.000Z",
        clientKey: "expand-tz-sydney",
      }),
    );

    expect(
      result.occurrences.map((occ) =>
        localLabel(occ.startsAt, "Australia/Sydney"),
      ),
    ).toEqual([
      "Mon 2026-09-14 09:00",
      "Mon 2026-09-21 09:00",
      "Mon 2026-09-28 09:00",
      "Mon 2026-10-05 09:00",
      "Mon 2026-10-12 09:00",
      "Mon 2026-10-19 09:00",
    ]);

    // Sydney DST starts Sun 2026-10-04 (+10 → +11).
    expect(createdIsoStarts(result)).toEqual([
      "2026-09-13T23:00:00.000Z",
      "2026-09-20T23:00:00.000Z",
      "2026-09-27T23:00:00.000Z",
      "2026-10-04T22:00:00.000Z",
      "2026-10-11T22:00:00.000Z",
      "2026-10-18T22:00:00.000Z",
    ]);
  });

  it("honours `until` as wall-time in the series' zone", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        timezone: "America/Chicago",
        schedule: zonedSchedule({
          rrule: "FREQ=WEEKLY;BYDAY=MO",
          dtstart: "2026-09-14T19:00:00",
          until: "2026-09-28T23:59:59",
        }),
      }),
    });

    const result = await expandSeries(
      deps,
      baseInput({
        windowStart: "2026-09-01T00:00:00.000Z",
        windowEnd: "2026-12-01T00:00:00.000Z",
        clientKey: "expand-tz-until",
      }),
    );

    expect(
      result.occurrences.map((occ) =>
        localLabel(occ.startsAt, "America/Chicago"),
      ),
    ).toEqual([
      "Mon 2026-09-14 19:00",
      "Mon 2026-09-21 19:00",
      "Mon 2026-09-28 19:00",
    ]);
  });

  it("UTC stays a no-op: an existing-occurrence dedupe in UTC is unchanged", async () => {
    const { deps } = makeDeps({
      series: makeSeriesRecord({
        timezone: "UTC",
        schedule: zonedSchedule({
          rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
          dtstart: DTSTART,
        }),
      }),
      seedOccurrences: [
        makeSeedOccurrence({
          startsAt: new Date(DTSTART),
          ordinal: 1,
          status: "PUBLISHED",
        }),
      ],
    });

    const result = await expandSeries(
      deps,
      baseInput({ clientKey: "expand-tz-utc-noop" }),
    );

    expect(createdIsoStarts(result)).toEqual([
      "2026-04-13T18:00:00.000Z",
      "2026-04-20T18:00:00.000Z",
    ]);
    expect(result.occurrences.map((occ) => occ.ordinal)).toEqual([2, 3]);
  });
});
