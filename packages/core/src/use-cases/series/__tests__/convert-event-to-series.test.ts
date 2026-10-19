import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/types";

import { convertEventToSeries } from "../convert-event-to-series";
import type { ConvertEventToSeriesDeps } from "../convert-event-to-series";

// ── Fixtures ─────────────────────────────────────────────────────────────

const SERIES_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const OCCURRENCE_ID = "00000000-0000-4000-8000-000000000004";
const PLACE_ID = "00000000-0000-4000-8000-000000000005";
const ORG_ID = "00000000-0000-4000-8000-000000000006";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000099";
const NOW = new Date("2026-04-01T12:00:00.000Z");

/** Weekly on Mondays; the event start below (Mon Apr 13) is ON this grid. */
const WEEKLY_MONDAY_SCHEDULE = {
  kind: "RRULE" as const,
  rrule: "FREQ=WEEKLY;BYDAY=MO",
  dtstart: "2026-04-06T18:00:00.000Z",
  until: "2026-06-01T18:00:00.000Z",
};
const ON_GRID_START = new Date("2026-04-13T18:00:00.000Z");
const OFF_GRID_START = new Date("2026-04-14T18:00:00.000Z");

function makeEvent(overrides?: Partial<EventRecord>): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: ACTOR_ID,
    title: "Weekly Jam",
    status: "PUBLISHED",
    timezone: "UTC",
    startsAt: ON_GRID_START,
    endsAt: null,
    placeId: PLACE_ID,
    savedLocationId: null,
    addressText: null,
    lat: null,
    lng: null,
    ...overrides,
  } as EventRecord;
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
    run: vi.fn(async () => {
      throw new Error("not used");
    }),
    purgeExpired: async () => 0,
  };
}

// Loose fn type so typed vi.fn() mocks stay assignable.
type AnyFn = (...args: never[]) => unknown;

type FakeOverrides = {
  eventsGetById?: AnyFn;
  findActiveByName?: AnyFn;
  nameExists?: AnyFn;
  seriesCreate?: AnyFn;
  findSeriesIdByEventId?: AnyFn;
  bulkUpsert?: AnyFn;
  listBySeries?: AnyFn;
  attachEvent?: AnyFn;
  auditLog?: AnyFn;
  getOrgMembership?: AnyFn;
  getHumanDelegation?: AnyFn;
};

function makeFakes(overrides?: FakeOverrides) {
  const fakes = {
    eventsGetById: overrides?.eventsGetById ?? vi.fn(async () => makeEvent()),
    findActiveByName: overrides?.findActiveByName ?? vi.fn(async () => null),
    nameExists: overrides?.nameExists ?? vi.fn(async () => false),
    seriesCreate:
      overrides?.seriesCreate ??
      vi.fn(async (input: Record<string, unknown>) => ({
        id: SERIES_ID,
        ...input,
      })),
    findSeriesIdByEventId:
      overrides?.findSeriesIdByEventId ?? vi.fn(async () => null),
    bulkUpsert: overrides?.bulkUpsert ?? vi.fn(async () => ({ count: 1 })),
    listBySeries:
      overrides?.listBySeries ??
      vi.fn(async () => ({
        items: [
          {
            id: OCCURRENCE_ID,
            seriesId: SERIES_ID,
            ordinal: 1,
            startsAt: ON_GRID_START,
            endsAt: null,
            status: "PUBLISHED",
            eventId: null,
            overrides: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        nextCursor: null,
      })),
    attachEvent:
      overrides?.attachEvent ??
      vi.fn(async () => ({ id: OCCURRENCE_ID, eventId: EVENT_ID })),
    auditLog: overrides?.auditLog ?? vi.fn(async () => undefined),
    getOrgMembership:
      overrides?.getOrgMembership ?? vi.fn(async () => ({ role: "EDITOR" })),
    getHumanDelegation:
      overrides?.getHumanDelegation ?? vi.fn(async () => null),
  };

  const tx = {
    events: { getById: fakes.eventsGetById },
    series: {
      findActiveByName: fakes.findActiveByName,
      nameExists: fakes.nameExists,
      create: fakes.seriesCreate,
    },
    seriesOccurrences: {
      findSeriesIdByEventId: fakes.findSeriesIdByEventId,
      bulkUpsert: fakes.bulkUpsert,
      listBySeries: fakes.listBySeries,
      attachEvent: fakes.attachEvent,
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    authz: {
      getHumanDelegation: fakes.getHumanDelegation,
      getOrgMembership: fakes.getOrgMembership,
    },
    audit: { log: fakes.auditLog },
  };

  const repos = {
    tx: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as Repos;

  return { fakes, repos };
}

function makeDeps(overrides?: FakeOverrides): {
  deps: ConvertEventToSeriesDeps;
  fakes: ReturnType<typeof makeFakes>["fakes"];
} {
  const { fakes, repos } = makeFakes(overrides);
  return {
    deps: { repos, idempotency: makeIdempotency(), clock: makeClock() },
    fakes,
  };
}

function baseInput(overrides?: Record<string, unknown>) {
  return {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    schedule: WEEKLY_MONDAY_SCHEDULE,
    clientKey: "convert-key-1",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("convertEventToSeries", () => {
  it("converts a PUBLISHED event into a series with a PUBLISHED occurrence", async () => {
    const { deps, fakes } = makeDeps();

    const result = await convertEventToSeries(deps, baseInput());

    expect(result).toEqual({
      seriesId: SERIES_ID,
      occurrenceId: OCCURRENCE_ID,
    });

    // Series carries the event's timezone + minimal defaults (title/location)
    expect(fakes.seriesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerScope: "HUMAN",
        ownerId: ACTOR_ID,
        name: "Weekly Jam",
        timezone: "UTC",
        templateId: null,
        defaults: expect.objectContaining({
          titlePrefix: "Weekly Jam",
          location: { kind: "place", placeId: PLACE_ID },
        }),
      }),
    );

    // Occurrence #1 mirrors the event's dates + PUBLISHED status
    expect(fakes.bulkUpsert).toHaveBeenCalledWith({
      occurrences: [
        {
          seriesId: SERIES_ID,
          ordinal: 1,
          startsAt: ON_GRID_START,
          endsAt: null,
          status: "PUBLISHED",
        },
      ],
    });

    expect(fakes.attachEvent).toHaveBeenCalledWith({
      occurrenceId: OCCURRENCE_ID,
      eventId: EVENT_ID,
      updatedAt: NOW,
    });

    expect(fakes.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_series",
        entityId: SERIES_ID,
        action: "converted_from_event",
        data: expect.objectContaining({
          eventId: EVENT_ID,
          occurrenceId: OCCURRENCE_ID,
          occurrenceStatus: "PUBLISHED",
        }),
      }),
    );
  });

  it("clamps an over-120-char event title before writing defaults.titlePrefix", async () => {
    // Event titles allow 140 chars; seriesDefaultsSchema.titlePrefix caps at
    // 120 and THROWS on overflow at parse time — an unclamped write poisons
    // the stored defaults and breaks every later series read for the owner.
    const longTitle = "T".repeat(130);
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () => makeEvent({ title: longTitle })),
    });

    const result = await convertEventToSeries(deps, baseInput());

    expect(result.seriesId).toBe(SERIES_ID);
    const createInput = (fakes.seriesCreate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      defaults: { titlePrefix: string | null };
    };
    expect(createInput.defaults.titlePrefix).toBe("T".repeat(120));
  });

  it("drops the defaults location when a freeform address exceeds the defaults bound", async () => {
    // Event freeform addresses allow 280 chars; the defaults locationSchema
    // caps at 200 (same throw-on-overflow poisoning). Truncating an address
    // would corrupt it, so the location default is dropped instead.
    const longAddress = "A".repeat(280);
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({
          placeId: null,
          addressText: longAddress,
          lat: 36.16,
          lng: -86.78,
        }),
      ),
    });

    const result = await convertEventToSeries(deps, baseInput());

    expect(result.seriesId).toBe(SERIES_ID);
    const createInput = (fakes.seriesCreate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      defaults: { titlePrefix: string | null; location: unknown };
    };
    expect(createInput.defaults.location).toBeNull();
    expect(createInput.defaults.titlePrefix).toBe("Weekly Jam");
  });

  it("creates a GENERATED occurrence for a DRAFT event", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () => makeEvent({ status: "DRAFT" })),
    });

    await convertEventToSeries(deps, baseInput());

    expect(fakes.bulkUpsert).toHaveBeenCalledWith({
      occurrences: [expect.objectContaining({ status: "GENERATED" })],
    });
  });

  it("uses the provided name instead of the event title", async () => {
    const { deps, fakes } = makeDeps();

    await convertEventToSeries(
      deps,
      baseInput({ name: "Monday Residency", clientKey: "convert-key-2" }),
    );

    expect(fakes.seriesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Monday Residency" }),
    );
  });

  it("resolves ORGANIZATION ownership from an org-owned event", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ orgId: ORG_ID, humanId: null }),
      ),
    });

    await convertEventToSeries(deps, baseInput());

    expect(fakes.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
    });
    expect(fakes.seriesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerScope: "ORGANIZATION",
        ownerId: ORG_ID,
      }),
    );
  });

  it("rejects an event that already belongs to a series", async () => {
    const { deps, fakes } = makeDeps({
      findSeriesIdByEventId: vi.fn(async () => ({
        seriesId: SERIES_ID,
        seriesName: "Existing",
      })),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "EVENT_ALREADY_IN_SERIES" },
    );
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  it("rejects when the event start is not on the RRULE grid", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () => makeEvent({ startsAt: OFF_GRID_START })),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "EVENT_START_NOT_IN_SCHEDULE" },
    );
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
    expect(fakes.bulkUpsert).not.toHaveBeenCalled();
  });

  it("accepts a FIXED_DATES schedule containing the event start (instant compare)", async () => {
    const { deps, fakes } = makeDeps();

    // Same instant expressed with a different offset — must still match.
    await convertEventToSeries(
      deps,
      baseInput({
        schedule: {
          kind: "FIXED_DATES",
          dates: ["2026-04-13T13:00:00.000-05:00"],
        },
        clientKey: "convert-key-3",
      }),
    );

    expect(fakes.seriesCreate).toHaveBeenCalled();
  });

  it("rejects a FIXED_DATES schedule that misses the event start", async () => {
    const { deps } = makeDeps();

    await expect(
      convertEventToSeries(
        deps,
        baseInput({
          schedule: {
            kind: "FIXED_DATES",
            dates: ["2026-04-20T18:00:00.000Z"],
          },
          clientKey: "convert-key-4",
        }),
      ),
    ).rejects.toMatchObject({ code: "EVENT_START_NOT_IN_SCHEDULE" });
  });

  it("fails SERIES_NAME_TAKEN when an ACTIVE series holds the name", async () => {
    const { deps } = makeDeps({
      findActiveByName: vi.fn(async () => ({ id: SERIES_ID })),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "SERIES_NAME_TAKEN" },
    );
  });

  it("retries with a numeric suffix when an ARCHIVED twin holds the name", async () => {
    // findActiveByName misses (twin is archived) but the DB unique constraint
    // spans archived rows — nameExists sees it.
    const nameExists = vi.fn(
      async (_scope: string, _owner: string, normalized: string) =>
        normalized === "weekly jam",
    );
    const { deps, fakes } = makeDeps({ nameExists });

    const result = await convertEventToSeries(deps, baseInput());

    expect(result.seriesId).toBe(SERIES_ID);
    expect(fakes.seriesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Weekly Jam (2)" }),
    );
  });

  it("fails SERIES_NAME_TAKEN when all suffix candidates are taken", async () => {
    const { deps, fakes } = makeDeps({
      nameExists: vi.fn(async () => true),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "SERIES_NAME_TAKEN" },
    );
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  it("maps a raced unique violation from create to SERIES_NAME_TAKEN", async () => {
    const { deps } = makeDeps({
      seriesCreate: vi.fn(async () => {
        throw { code: "P2002" };
      }),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "SERIES_NAME_TAKEN" },
    );
  });

  it("rejects a CANCELLED event", async () => {
    const { deps } = makeDeps({
      eventsGetById: vi.fn(async () => makeEvent({ status: "CANCELLED" })),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "EVENT_ALREADY_CANCELLED" },
    );
  });

  it("rejects a missing event", async () => {
    const { deps } = makeDeps({
      eventsGetById: vi.fn(async () => null),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "EVENT_NOT_FOUND" },
    );
  });

  it("rejects an ownerless (community) event", async () => {
    const { deps } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ orgId: null, humanId: null }),
      ),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "NOT_RESOURCE_OWNER" },
    );
  });

  it("denies an actor who is not the owning human", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () => makeEvent({ humanId: OTHER_HUMAN_ID })),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "NOT_RESOURCE_OWNER" },
    );
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  // Owner ruling 2026-09-28: the builder's series save works for an edit-role
  // delegate of the owning human — the series is the PRINCIPAL's.
  it.each(["OWNER", "ADMIN", "EDITOR"])(
    "a %s delegate of the owning human converts it; the series is owned by the principal",
    async (role) => {
      const { deps, fakes } = makeDeps({
        eventsGetById: vi.fn(async () => makeEvent({ humanId: OTHER_HUMAN_ID })),
        getHumanDelegation: vi.fn(async () => ({
          orgId: OTHER_HUMAN_ID,
          humanId: ACTOR_ID,
          role,
        })),
      });

      await convertEventToSeries(deps, baseInput());

      expect(fakes.seriesCreate).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(fakes.seriesCreate.mock.calls[0])).toContain(
        OTHER_HUMAN_ID,
      );
      expect(JSON.stringify(fakes.seriesCreate.mock.calls[0])).not.toContain(
        `"ownerId":"${ACTOR_ID}"`,
      );
    },
  );

  it.each(["VIEWER", "FINANCE", "SCANNER"])(
    "a %s delegate cannot convert",
    async (role) => {
      const { deps, fakes } = makeDeps({
        eventsGetById: vi.fn(async () => makeEvent({ humanId: OTHER_HUMAN_ID })),
        getHumanDelegation: vi.fn(async () => ({
          orgId: OTHER_HUMAN_ID,
          humanId: ACTOR_ID,
          role,
        })),
      });

      await expect(
        convertEventToSeries(deps, baseInput()),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(fakes.seriesCreate).not.toHaveBeenCalled();
    },
  );

  it("rejects an event whose start is already in the past", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ startsAt: new Date("2026-03-30T18:00:00.000Z") }),
      ),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "EVENT_ALREADY_ENDED" },
    );
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  it("rejects when the event start is beyond maxOccurrencesPerExpand instants", async () => {
    // Event startsAt = Apr 13 = instant #2 of the weekly rule; cap of 1 means
    // reconcile would never materialize it → must be rejected here.
    const { deps, fakes } = makeDeps();

    await expect(
      convertEventToSeries(
        deps,
        baseInput({
          schedule: { ...WEEKLY_MONDAY_SCHEDULE, maxOccurrencesPerExpand: 1 },
          clientKey: "convert-cap-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "EVENT_START_NOT_IN_SCHEDULE" });
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  it("accepts the first enumerated instant when maxOccurrencesPerExpand is 1", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ startsAt: new Date("2026-04-06T18:00:00.000Z") }),
      ),
    });

    await convertEventToSeries(
      deps,
      baseInput({
        schedule: { ...WEEKLY_MONDAY_SCHEDULE, maxOccurrencesPerExpand: 1 },
        clientKey: "convert-cap-2",
      }),
    );

    expect(fakes.seriesCreate).toHaveBeenCalled();
  });

  it("denies an actor with no membership in the owning org", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ orgId: ORG_ID, humanId: null }),
      ),
      getOrgMembership: vi.fn(async () => null),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "INSUFFICIENT_ROLE" },
    );
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  it("maps a raced unique violation from attachEvent to EVENT_ALREADY_IN_SERIES", async () => {
    const { deps } = makeDeps({
      attachEvent: vi.fn(async () => {
        throw { code: "P2002" };
      }),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "EVENT_ALREADY_IN_SERIES" },
    );
  });

  it("replays the stored response without re-executing", async () => {
    const { deps: firstDeps } = makeDeps();
    const first = await convertEventToSeries(firstDeps, baseInput());
    const committed = (firstDeps.idempotency.commit as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1];

    const { deps: replayDeps, fakes } = makeDeps();
    (replayDeps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      committed,
    );

    const replayed = await convertEventToSeries(replayDeps, baseInput());

    expect(replayed).toEqual(first);
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
    expect(fakes.bulkUpsert).not.toHaveBeenCalled();
    expect(replayDeps.idempotency.begin).not.toHaveBeenCalled();
  });

  it("throws IDEMPOTENCY_KEY_CONFLICT when the replayed payload hash differs", async () => {
    const { deps, fakes } = makeDeps();
    (deps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      payloadHash: "some-other-payload-hash",
      response: { seriesId: SERIES_ID, occurrenceId: OCCURRENCE_ID },
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "IDEMPOTENCY_KEY_CONFLICT" },
    );
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  it("marks the idempotency record failed on error", async () => {
    const { deps } = makeDeps({
      eventsGetById: vi.fn(async () => null),
    });

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "EVENT_NOT_FOUND" },
    );
    expect(deps.idempotency.fail).toHaveBeenCalled();
    expect(deps.idempotency.commit).not.toHaveBeenCalled();
  });

  it("throws IDEMPOTENCY_LOCK_IN_PROGRESS when a concurrent run holds the key", async () => {
    const { deps } = makeDeps();
    (deps.idempotency.begin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      false,
    );

    await expect(convertEventToSeries(deps, baseInput())).rejects.toMatchObject(
      { code: "IDEMPOTENCY_LOCK_IN_PROGRESS" },
    );
  });

  // ── RRULE shapes from the recurrence UI: COUNT / INTERVAL / BYSETPOS ──

  /** Weekly Mondays ending after 3 occurrences: Apr 6, 13, 20. */
  const WEEKLY_COUNT3_SCHEDULE = {
    kind: "RRULE" as const,
    rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
    dtstart: "2026-04-06T18:00:00.000Z",
  };

  /** Every third Monday: Apr 6, Apr 27, May 18, … */
  const INTERVAL3_SCHEDULE = {
    kind: "RRULE" as const,
    rrule: "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO",
    dtstart: "2026-04-06T18:00:00.000Z",
  };

  /** Last Friday of the month: Apr 24, May 29 (5-Friday May), Jun 26, … */
  const LAST_FRIDAY_SCHEDULE = {
    kind: "RRULE" as const,
    rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
    dtstart: "2026-04-24T18:00:00.000Z",
  };

  it("COUNT=3: accepts an event start within the COUNT window (occurrence #2)", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ startsAt: new Date("2026-04-13T18:00:00.000Z") }),
      ),
    });

    await convertEventToSeries(
      deps,
      baseInput({
        schedule: WEEKLY_COUNT3_SCHEDULE,
        clientKey: "convert-count-ok",
      }),
    );

    expect(fakes.seriesCreate).toHaveBeenCalled();
  });

  it("COUNT=3: rejects an event start at occurrence #4 (dtstart counts as #1)", async () => {
    // Apr 27 is the 4th Monday from dtstart — beyond COUNT=3, so reconcile
    // would never materialize it. Rejecting proves dtstart's own occurrence
    // consumes COUNT slot #1.
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ startsAt: new Date("2026-04-27T18:00:00.000Z") }),
      ),
    });

    await expect(
      convertEventToSeries(
        deps,
        baseInput({
          schedule: WEEKLY_COUNT3_SCHEDULE,
          clientKey: "convert-count-beyond",
        }),
      ),
    ).rejects.toMatchObject({ code: "EVENT_START_NOT_IN_SCHEDULE" });
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  it("INTERVAL=3: accepts an event on an on-interval Monday (Apr 27)", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ startsAt: new Date("2026-04-27T18:00:00.000Z") }),
      ),
    });

    await convertEventToSeries(
      deps,
      baseInput({ schedule: INTERVAL3_SCHEDULE, clientKey: "convert-int3-ok" }),
    );

    expect(fakes.seriesCreate).toHaveBeenCalled();
  });

  it("INTERVAL=3: rejects an event on an off-interval Monday (Apr 20)", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ startsAt: new Date("2026-04-20T18:00:00.000Z") }),
      ),
    });

    await expect(
      convertEventToSeries(
        deps,
        baseInput({
          schedule: INTERVAL3_SCHEDULE,
          clientKey: "convert-int3-off",
        }),
      ),
    ).rejects.toMatchObject({ code: "EVENT_START_NOT_IN_SCHEDULE" });
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  it("BYSETPOS=-1: accepts an event on the last Friday of a 5-Friday month", async () => {
    // May 2026 has Fridays 1, 8, 15, 22, 29 — May 29 is the last.
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ startsAt: new Date("2026-05-29T18:00:00.000Z") }),
      ),
    });

    await convertEventToSeries(
      deps,
      baseInput({
        schedule: LAST_FRIDAY_SCHEDULE,
        clientKey: "convert-bysetpos-ok",
      }),
    );

    expect(fakes.seriesCreate).toHaveBeenCalled();
  });

  it("BYSETPOS=-1: rejects an event on the 2nd Friday of the month", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ startsAt: new Date("2026-05-08T18:00:00.000Z") }),
      ),
    });

    await expect(
      convertEventToSeries(
        deps,
        baseInput({
          schedule: LAST_FRIDAY_SCHEDULE,
          clientKey: "convert-bysetpos-2nd",
        }),
      ),
    ).rejects.toMatchObject({ code: "EVENT_START_NOT_IN_SCHEDULE" });
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });

  it("round-trips COUNT/INTERVAL/BYSETPOS rrule strings through the schema unmangled", async () => {
    // The zod schedule schema + normalizeSchedule must store the rrule
    // verbatim — enumeration semantics depend on the exact token set.
    const rrule = "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;INTERVAL=2;COUNT=10";
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ startsAt: new Date("2026-04-24T18:00:00.000Z") }),
      ),
    });

    await convertEventToSeries(
      deps,
      baseInput({
        schedule: {
          kind: "RRULE" as const,
          rrule,
          dtstart: "2026-04-24T18:00:00.000Z",
        },
        clientKey: "convert-roundtrip",
      }),
    );

    expect(fakes.seriesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: expect.objectContaining({
          kind: "RRULE",
          rrule,
          dtstart: "2026-04-24T18:00:00.000Z",
        }),
      }),
    );
  });
});

// ── Timezone regression ──────────────────────────────────────────────────
//
// `isInstantOnSchedule` drives the `rrule` package, which is timezone-blind:
// it reads/writes a Date's UTC fields and treats them as floating wall-clock.
// Driving it with real UTC instants evaluates BYDAY/BYHOUR against the UTC
// calendar, so in a negative-offset zone this gate REJECTS the very instants
// that reconcileSeriesSchedule materializes — and would ACCEPT an instant
// that the next builder save then detaches. The gate and reconcile must agree.
//
// Every case in the suite above uses `timezone: "UTC"`, where the bug is
// invisible.

/** Weekly Mondays at 19:00 America/Chicago (wall-time dtstart). */
const CHICAGO_WEEKLY_MONDAY = {
  kind: "RRULE" as const,
  rrule: "FREQ=WEEKLY;BYDAY=MO",
  dtstart: "2026-09-14T19:00:00",
  until: "2026-12-01T19:00:00",
};

/** Mon 2026-09-28 19:00 America/Chicago — ON the local grid. */
const CHICAGO_ON_GRID = new Date("2026-09-29T00:00:00.000Z");
/** Sun 2026-09-27 19:00 America/Chicago — the instant the OLD, UTC-calendar
 *  enumeration wrongly considered on-grid. */
const CHICAGO_OFF_GRID = new Date("2026-09-28T00:00:00.000Z");

describe("convertEventToSeries — the grid gate is evaluated in the event's timezone", () => {
  it("ACCEPTS a Monday 19:00 America/Chicago start against a BYDAY=MO rule", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ timezone: "America/Chicago", startsAt: CHICAGO_ON_GRID }),
      ),
    });

    await convertEventToSeries(
      deps,
      baseInput({
        schedule: CHICAGO_WEEKLY_MONDAY,
        clientKey: "converttz01",
      }),
    );

    expect(fakes.seriesCreate).toHaveBeenCalled();
  });

  it("REJECTS the Sunday instant the UTC-calendar enumeration used to accept", async () => {
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async () =>
        makeEvent({ timezone: "America/Chicago", startsAt: CHICAGO_OFF_GRID }),
      ),
    });

    await expect(
      convertEventToSeries(
        deps,
        baseInput({
          schedule: CHICAGO_WEEKLY_MONDAY,
          clientKey: "converttz02",
        }),
      ),
    ).rejects.toMatchObject({ code: "EVENT_START_NOT_IN_SCHEDULE" });
    expect(fakes.seriesCreate).not.toHaveBeenCalled();
  });
});
