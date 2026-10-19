import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";
import type { EventSeriesOccurrenceRecord, EventSeriesRecord } from "@th/types";

import { AppError } from "@th/errors";

import { addSeriesOccurrence } from "../add-series-occurrence";
import type { AddSeriesOccurrenceDeps } from "../add-series-occurrence";

const SERIES_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const NEW_OCC_ID = "00000000-0000-4000-8000-000000000031";
const NOW = new Date("2026-04-01T12:00:00.000Z");
const FUTURE_STARTS_AT = "2026-04-08T20:00:00.000Z";

function makeSeries(overrides?: Partial<EventSeriesRecord>): EventSeriesRecord {
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
      dtstart: "2026-04-06T18:00:00.000Z",
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

function makeOccurrence(
  overrides: Partial<EventSeriesOccurrenceRecord> & { id: string },
): EventSeriesOccurrenceRecord {
  return {
    seriesId: SERIES_ID,
    ordinal: 1,
    startsAt: new Date("2026-04-06T18:00:00.000Z"),
    endsAt: null,
    status: "PLANNED",
    eventId: null,
    overrides: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
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

type AnyFn = (...args: never[]) => unknown;

type FakeOverrides = {
  seriesGetById?: AnyFn;
  listBySeriesAndStatuses?: AnyFn;
  create?: AnyFn;
  auditLog?: AnyFn;
};

function makeDeps(overrides?: FakeOverrides): {
  deps: AddSeriesOccurrenceDeps;
  fakes: Required<FakeOverrides>;
} {
  const fakes = {
    seriesGetById: overrides?.seriesGetById ?? vi.fn(async () => makeSeries()),
    listBySeriesAndStatuses:
      overrides?.listBySeriesAndStatuses ?? vi.fn(async () => []),
    create:
      overrides?.create ??
      vi.fn(async (input: { ordinal: number }) =>
        makeOccurrence({
          id: NEW_OCC_ID,
          ordinal: input.ordinal,
          startsAt: new Date(FUTURE_STARTS_AT),
          overrides: { manual: true },
        }),
      ),
    auditLog: overrides?.auditLog ?? vi.fn(async () => undefined),
  };

  const tx = {
    series: { getById: fakes.seriesGetById },
    seriesOccurrences: {
      listBySeriesAndStatuses: fakes.listBySeriesAndStatuses,
      create: fakes.create,
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    authz: {
      getHumanDelegation: vi.fn(async () => null),
      getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })),
    },
    audit: { log: fakes.auditLog },
  };

  const repos = {
    tx: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as Repos;

  const clock: ClockPort = { now: () => NOW };

  return {
    deps: { repos, idempotency: makeIdempotency(), clock },
    fakes: fakes as Required<FakeOverrides>,
  };
}

function baseInput(overrides?: Record<string, unknown>) {
  return {
    actorHumanId: ACTOR_ID,
    seriesId: SERIES_ID,
    startsAt: FUTURE_STARTS_AT,
    clientKey: "add-occ-key-1",
    ...overrides,
  };
}

describe("addSeriesOccurrence", () => {
  it("creates a PLANNED manual occurrence with ordinal = max over ALL occurrences + 1", async () => {
    // Includes a PAST DETACHED row with the highest ordinal — the allocation
    // scan must span all statuses/dates, not just future PLANNED rows.
    const existing = [
      makeOccurrence({
        id: "00000000-0000-4000-8000-000000000021",
        ordinal: 2,
      }),
      makeOccurrence({
        id: "00000000-0000-4000-8000-000000000022",
        ordinal: 7,
        status: "DETACHED",
        startsAt: new Date("2026-01-05T18:00:00.000Z"),
      }),
    ];
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () => existing),
    });

    const result = await addSeriesOccurrence(
      deps,
      baseInput({ note: "one-off holiday show" }),
    );

    expect(result).toEqual({ occurrenceId: NEW_OCC_ID });
    expect(fakes.create).toHaveBeenCalledWith({
      seriesId: SERIES_ID,
      ordinal: 8,
      startsAt: new Date(FUTURE_STARTS_AT),
      endsAt: null,
      status: "PLANNED",
      overrides: { manual: true, note: "one-off holiday show" },
      createdAt: NOW,
    });
    // The all-statuses scan runs from epoch (past rows included).
    expect(fakes.listBySeriesAndStatuses).toHaveBeenCalledWith(
      SERIES_ID,
      expect.arrayContaining([
        "PLANNED",
        "SKIPPED",
        "GENERATED",
        "PUBLISHED",
        "CANCELLED",
        "DETACHED",
      ]),
      new Date(0),
    );
    expect(fakes.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_series",
        entityId: SERIES_ID,
        action: "occurrence_added",
        data: expect.objectContaining({ manual: true, ordinal: 8 }),
      }),
    );
    expect(deps.idempotency.commit).toHaveBeenCalled();
  });

  it("passes endsAt through and omits note when absent", async () => {
    const endsAt = "2026-04-08T23:00:00.000Z";
    const { deps, fakes } = makeDeps();

    await addSeriesOccurrence(deps, baseInput({ endsAt }));

    expect(fakes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ordinal: 1,
        endsAt: new Date(endsAt),
        overrides: { manual: true },
      }),
    );
  });

  it("rejects OCCURRENCE_DUPLICATE_DATE when an occurrence already holds that startsAt", async () => {
    const clash = makeOccurrence({
      id: "00000000-0000-4000-8000-000000000021",
      startsAt: new Date(FUTURE_STARTS_AT),
      status: "SKIPPED", // even non-PLANNED rows block the date
    });
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () => [clash]),
    });

    await expect(addSeriesOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_DUPLICATE_DATE",
    });
    expect(fakes.create).not.toHaveBeenCalled();
    expect(deps.idempotency.fail).toHaveBeenCalled();
  });

  it("rejects EVENT_DATE_IN_PAST for a startsAt not in the future", async () => {
    const { deps, fakes } = makeDeps();

    await expect(
      addSeriesOccurrence(
        deps,
        baseInput({ startsAt: "2026-03-01T18:00:00.000Z" }),
      ),
    ).rejects.toMatchObject({ code: "EVENT_DATE_IN_PAST" });
    expect(fakes.create).not.toHaveBeenCalled();
  });

  it("rejects invalid_input when endsAt is not after startsAt", async () => {
    const { deps } = makeDeps();

    await expect(
      addSeriesOccurrence(
        deps,
        baseInput({ endsAt: "2026-04-08T19:00:00.000Z" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects SERIES_INACTIVE for an archived series", async () => {
    const { deps } = makeDeps({
      seriesGetById: vi.fn(async () =>
        makeSeries({ active: false, archivedAt: new Date() }),
      ),
    });

    await expect(addSeriesOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "SERIES_INACTIVE",
    });
  });

  it("denies an actor who is not the series owner", async () => {
    const { deps } = makeDeps();

    await expect(
      addSeriesOccurrence(
        deps,
        baseInput({ actorHumanId: "00000000-0000-4000-8000-000000000099" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("replays the stored response without re-executing", async () => {
    const { deps: firstDeps } = makeDeps();
    const first = await addSeriesOccurrence(firstDeps, baseInput());
    const committed = (firstDeps.idempotency.commit as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1];

    const { deps: replayDeps, fakes } = makeDeps();
    (replayDeps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      committed,
    );

    const replayed = await addSeriesOccurrence(replayDeps, baseInput());

    expect(replayed).toEqual(first);
    expect(fakes.create).not.toHaveBeenCalled();
  });

  it("propagates a typed OCCURRENCE_ALLOCATION_CONFLICT when the insert loses an ordinal race", async () => {
    // The adapter maps a (seriesId, ordinal) P2002 (e.g. a concurrent
    // reconcile insert allocated the same ordinal) to this typed conflict.
    const { deps } = makeDeps({
      create: vi.fn(async () => {
        throw new AppError("OCCURRENCE_ALLOCATION_CONFLICT");
      }),
    });

    await expect(addSeriesOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_ALLOCATION_CONFLICT",
    });
    expect(deps.idempotency.fail).toHaveBeenCalled();
    expect(deps.idempotency.commit).not.toHaveBeenCalled();
  });

  it("throws IDEMPOTENCY_KEY_CONFLICT when the replayed payload differs", async () => {
    const { deps } = makeDeps();
    (deps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      payloadHash: "different-hash",
      response: { occurrenceId: NEW_OCC_ID },
    });

    await expect(addSeriesOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
  });
});
