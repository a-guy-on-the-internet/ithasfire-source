import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type {
  EventSeriesOccurrenceRecord,
  EventSeriesRecord,
} from "@th/types";

import { listSeriesDatesForAdmin } from "../list-series-dates-for-admin";
import type { ListSeriesDatesForAdminDeps } from "../list-series-dates-for-admin";

const SERIES_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000021";
const OCC_1_ID = "00000000-0000-4000-8000-000000000011";
const OCC_2_ID = "00000000-0000-4000-8000-000000000012";
const OCC_3_ID = "00000000-0000-4000-8000-000000000013";

function makeSeries(overrides?: Partial<EventSeriesRecord>): EventSeriesRecord {
  return {
    id: SERIES_ID,
    ownerScope: "HUMAN",
    ownerId: ACTOR_ID,
    name: "Weekly Jam",
    description: null,
    active: true,
    timezone: "America/Chicago",
    schedule: {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstart: "2026-04-06T18:00:00.000Z",
      until: "2026-06-01T18:00:00.000Z",
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

type AnyFn = (...args: never[]) => unknown;

type FakeOverrides = {
  seriesGetById?: AnyFn;
  listBySeries?: AnyFn;
  countBySeries?: AnyFn;
  findManyByIds?: AnyFn;
  listTicketTypesForEventIds?: AnyFn;
  getPopularityStats?: AnyFn;
};

function makeDeps(overrides?: FakeOverrides): {
  deps: ListSeriesDatesForAdminDeps;
  fakes: Required<FakeOverrides>;
} {
  const fakes = {
    seriesGetById: overrides?.seriesGetById ?? vi.fn(async () => makeSeries()),
    listBySeries:
      overrides?.listBySeries ??
      vi.fn(async () => ({ items: [], nextCursor: undefined })),
    countBySeries: overrides?.countBySeries ?? vi.fn(async () => 0),
    findManyByIds: overrides?.findManyByIds ?? vi.fn(async () => []),
    listTicketTypesForEventIds:
      overrides?.listTicketTypesForEventIds ?? vi.fn(async () => []),
    getPopularityStats:
      overrides?.getPopularityStats ?? vi.fn(async () => []),
  };

  const tx = {
    series: { getById: fakes.seriesGetById },
    seriesOccurrences: {
      listBySeries: fakes.listBySeries,
      countBySeries: fakes.countBySeries,
    },
    events: {
      findManyByIds: fakes.findManyByIds,
      listTicketTypesForEventIds: fakes.listTicketTypesForEventIds,
      getPopularityStats: fakes.getPopularityStats,
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    authz: {
      getHumanDelegation: vi.fn(async () => null),
      getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })),
    },
  };

  const repos = {
    tx: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as Repos;

  return { deps: { repos }, fakes: fakes as Required<FakeOverrides> };
}

function baseInput(overrides?: Record<string, unknown>) {
  return {
    actorHumanId: ACTOR_ID,
    seriesId: SERIES_ID,
    ...overrides,
  };
}

describe("listSeriesDatesForAdmin", () => {
  it("returns occurrence rows joined with linked-event summaries and a series header", async () => {
    const linked = makeOccurrence({
      id: OCC_1_ID,
      ordinal: 1,
      status: "PUBLISHED",
      eventId: EVENT_ID,
    });
    const skipped = makeOccurrence({
      id: OCC_2_ID,
      ordinal: 2,
      startsAt: new Date("2026-04-13T18:00:00.000Z"),
      status: "SKIPPED",
      overrides: { skipNote: "band unavailable" },
    });
    const manual = makeOccurrence({
      id: OCC_3_ID,
      ordinal: 3,
      startsAt: new Date("2026-04-15T20:00:00.000Z"),
      overrides: { manual: true, note: "one-off" },
    });

    const { deps, fakes } = makeDeps({
      listBySeries: vi.fn(async () => ({
        items: [linked, skipped, manual],
        nextCursor: "1765000000000::next-id",
      })),
      countBySeries: vi.fn(async () => 12),
      findManyByIds: vi.fn(async () => [
        {
          id: EVENT_ID,
          title: "Weekly Jam — Apr 6",
          slug: "weekly-jam-apr-6",
          status: "PUBLISHED",
        },
      ]),
      listTicketTypesForEventIds: vi.fn(async () => [
        { eventId: EVENT_ID, id: "tt-1", name: "GA" },
        { eventId: EVENT_ID, id: "tt-2", name: "VIP" },
      ]),
      getPopularityStats: vi.fn(async () => [
        {
          eventId: EVENT_ID,
          ticketsSold: 42,
          waitlistCount: 0,
          totalCapacity: 100,
        },
      ]),
    });

    const result = await listSeriesDatesForAdmin(deps, baseInput());

    expect(result.series).toEqual({
      seriesId: SERIES_ID,
      name: "Weekly Jam",
      timezone: "America/Chicago",
      schedule: {
        kind: "RRULE",
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        until: "2026-06-01T18:00:00.000Z",
      },
      totalCount: 12,
    });

    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toEqual({
      occurrenceId: OCC_1_ID,
      startsAt: linked.startsAt,
      endsAt: null,
      status: "PUBLISHED",
      manual: false,
      skipNote: null,
      note: null,
      event: {
        eventId: EVENT_ID,
        title: "Weekly Jam — Apr 6",
        slug: "weekly-jam-apr-6",
        status: "PUBLISHED",
        ticketTypeCount: 2,
        soldCount: 42,
      },
    });
    expect(result.items[1]).toEqual(
      expect.objectContaining({
        occurrenceId: OCC_2_ID,
        status: "SKIPPED",
        manual: false,
        skipNote: "band unavailable",
        event: null,
      }),
    );
    expect(result.items[2]).toEqual(
      expect.objectContaining({
        occurrenceId: OCC_3_ID,
        manual: true,
        note: "one-off",
        event: null,
      }),
    );
    expect(result.nextCursor).toBe("1765000000000::next-id");

    // Batched lookups — one call each, only for linked event ids.
    expect(fakes.findManyByIds).toHaveBeenCalledWith([EVENT_ID]);
    expect(fakes.listTicketTypesForEventIds).toHaveBeenCalledWith([EVENT_ID]);
    expect(fakes.getPopularityStats).toHaveBeenCalledWith([EVENT_ID]);
  });

  it("skips event lookups entirely when no occurrence has a linked event", async () => {
    const { deps, fakes } = makeDeps({
      listBySeries: vi.fn(async () => ({
        items: [makeOccurrence({ id: OCC_1_ID })],
        nextCursor: undefined,
      })),
      countBySeries: vi.fn(async () => 1),
    });

    const result = await listSeriesDatesForAdmin(deps, baseInput());

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.event).toBeNull();
    expect(fakes.findManyByIds).not.toHaveBeenCalled();
    expect(fakes.getPopularityStats).not.toHaveBeenCalled();
  });

  it("forwards limit + cursor to the occurrence listing (startsAt-asc stable cursor)", async () => {
    const { deps, fakes } = makeDeps();

    await listSeriesDatesForAdmin(
      deps,
      baseInput({ limit: 10, cursor: "1764000000000::occ-x" }),
    );

    expect(fakes.listBySeries).toHaveBeenCalledWith({
      seriesId: SERIES_ID,
      limit: 10,
      cursor: "1764000000000::occ-x",
    });
  });

  it("returns event: null when the linked event row is missing", async () => {
    const { deps } = makeDeps({
      listBySeries: vi.fn(async () => ({
        items: [
          makeOccurrence({ id: OCC_1_ID, status: "GENERATED", eventId: EVENT_ID }),
        ],
        nextCursor: undefined,
      })),
      countBySeries: vi.fn(async () => 1),
      findManyByIds: vi.fn(async () => []),
    });

    const result = await listSeriesDatesForAdmin(deps, baseInput());

    expect(result.items[0]!.event).toBeNull();
  });

  it("fails SERIES_NOT_FOUND for a missing series", async () => {
    const { deps } = makeDeps({
      seriesGetById: vi.fn(async () => null),
    });

    await expect(
      listSeriesDatesForAdmin(deps, baseInput()),
    ).rejects.toMatchObject({ code: "SERIES_NOT_FOUND" });
  });

  it("denies an actor who is not the series owner", async () => {
    const { deps } = makeDeps();

    await expect(
      listSeriesDatesForAdmin(
        deps,
        baseInput({ actorHumanId: "00000000-0000-4000-8000-000000000099" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});
