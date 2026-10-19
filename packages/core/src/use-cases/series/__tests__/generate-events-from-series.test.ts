import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";
import type { EventSeriesOccurrenceRecord, EventSeriesRecord } from "@th/types";

import { generateEventsFromSeries } from "../generate-events-from-series";
import type { GenerateEventsFromSeriesDeps } from "../generate-events-from-series";

// ── Fixtures ─────────────────────────────────────────────────────────────

const SERIES_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const TEMPLATE_ID = "00000000-0000-4000-8000-000000000007";
const PLACE_ID = "00000000-0000-4000-8000-000000000005";
const OCC_1_ID = "00000000-0000-4000-8000-000000000011";
const OCC_2_ID = "00000000-0000-4000-8000-000000000012";
const OCC_3_ID = "00000000-0000-4000-8000-000000000013";
const EXISTING_EVENT_ID = "00000000-0000-4000-8000-000000000021";
const NOW = new Date("2026-04-01T12:00:00.000Z");

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
    defaults: {
      titlePrefix: "Open Mic",
      location: { kind: "place", placeId: PLACE_ID },
      categories: null,
      types: null,
      attributes: null,
      feePolicyId: null,
      payoutTermsDraft: null,
      agreementDraft: null,
      ticketTypes: null,
    },
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
    startsAt: new Date("2026-04-13T18:00:00.000Z"),
    endsAt: null,
    status: "PLANNED",
    eventId: null,
    overrides: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
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
    run: vi.fn(async () => {
      throw new Error("not used");
    }),
    purgeExpired: async () => 0,
  };
}

// Loose fn type so typed vi.fn() mocks stay assignable.
type AnyFn = (...args: never[]) => unknown;

type FakeOverrides = {
  seriesGetById?: AnyFn;
  occurrenceGetById?: AnyFn;
  listBySeriesAndStatuses?: AnyFn;
  attachEvent?: AnyFn;
  markStatus?: AnyFn;
  upsertDraft?: AnyFn;
  templatesGetById?: AnyFn;
  placesGetById?: AnyFn;
  auditLog?: AnyFn;
  listTicketTypes?: AnyFn;
  createTicketType?: AnyFn;
  getSlugContext?: AnyFn;
  assignSlug?: AnyFn;
  eventsGetById?: AnyFn;
  arrivalAreas?: Record<string, AnyFn>;
};

/**
 * Strict upsertDraft fake mirroring the REAL Prisma adapter contract
 * (packages/adapters/src/db/prisma/events.ts): a truthy `eventId` routes to
 * `p.event.update`, which throws P2025 when the row does not exist — only a
 * falsy `eventId` takes the create branch. Passing a fresh UUID as `eventId`
 * therefore explodes exactly like production would.
 */
function makeStrictUpsertDraft() {
  const knownIds = new Set<string>();
  return vi.fn(async (input: { eventId?: string | null }) => {
    if (input.eventId) {
      if (!knownIds.has(input.eventId)) {
        throw Object.assign(new Error("Record to update not found."), {
          code: "P2025",
        });
      }
      return { id: input.eventId };
    }
    const id = randomUUID();
    knownIds.add(id);
    return { id };
  });
}

function makeFakes(overrides?: FakeOverrides) {
  const fakes = {
    seriesGetById: overrides?.seriesGetById ?? vi.fn(async () => makeSeries()),
    occurrenceGetById: overrides?.occurrenceGetById ?? vi.fn(async () => null),
    listBySeriesAndStatuses:
      overrides?.listBySeriesAndStatuses ?? vi.fn(async () => []),
    attachEvent:
      overrides?.attachEvent ?? vi.fn(async () => ({ id: "attached" })),
    markStatus: overrides?.markStatus ?? vi.fn(async () => ({ id: "marked" })),
    upsertDraft: overrides?.upsertDraft ?? makeStrictUpsertDraft(),
    templatesGetById: overrides?.templatesGetById ?? vi.fn(async () => null),
    placesGetById:
      overrides?.placesGetById ??
      vi.fn(async () => ({
        id: PLACE_ID,
        status: "ACTIVE",
        orgIdsWithAccess: [],
        humanIdsWithAccess: [ACTOR_ID],
      })),
    auditLog: overrides?.auditLog ?? vi.fn(async () => undefined),
    listTicketTypes: overrides?.listTicketTypes ?? vi.fn(async () => []),
    createTicketType:
      overrides?.createTicketType ?? vi.fn(async () => ({ id: "tt-created" })),
    // Slug-at-create runs on this path too (it calls `upsertDraft` directly
    // rather than going through `finalizeSaveEvent`). These fakes have to
    // exist or `assignSlugOnCreate` would just catch the TypeError from
    // calling `undefined` and no test would ever exercise the path.
    getSlugContext:
      overrides?.getSlugContext ??
      vi.fn(async (eventId: string) => ({
        eventId,
        orgId: null,
        humanId: ACTOR_ID,
        eventTitle: "Open Mic",
        // 18:00Z is 13:00 CDT: the slug's date segment is the LOCAL start.
        startsAt: new Date("2026-04-13T18:00:00.000Z"),
        timezone: "America/Chicago",
        orgName: null,
        countryCode: "US",
        regionCode: "TN",
        cityOrRegionCode: "Nashville",
        shortId: null,
      })),
    assignSlug:
      overrides?.assignSlug ?? vi.fn(async () => ({ id: "slug-assigned" })),
  };

  const tx = {
    series: { getById: fakes.seriesGetById },
    seriesOccurrences: {
      getById: fakes.occurrenceGetById,
      listBySeriesAndStatuses: fakes.listBySeriesAndStatuses,
      attachEvent: fakes.attachEvent,
      markStatus: fakes.markStatus,
    },
    events: {
      upsertDraft: fakes.upsertDraft,
      listTicketTypes: fakes.listTicketTypes,
      getSlugContext: fakes.getSlugContext,
      assignSlug: fakes.assignSlug,
      getById: overrides?.eventsGetById ?? vi.fn(async () => null),
    },
    // arrival-areas owner Q12: the copy source has no areas or hides by
    // default, so generation writes none.
    arrivalAreas: overrides?.arrivalAreas ?? {
      listForEvent: vi.fn(async () => []),
      listHidesForEvent: vi.fn(async () => []),
    },
    tickets: { createTicketType: fakes.createTicketType },
    eventTemplates: { getById: fakes.templatesGetById },
    places: { getById: fakes.placesGetById },
    savedLocations: {
      getAccessibleByOrg: vi.fn(async () => null),
      getAccessibleByHuman: vi.fn(async () => ({ id: "sl" })),
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

  // The SAME bag is reachable transactionally and non-transactionally, which
  // is what the real `Repos` shape is (`TxRepos = Omit<Repos, "tx">`). It used
  // to expose `tx` alone, so any post-commit repo call — like the slug
  // assignment, which is deliberately outside the generate transaction — hit
  // `undefined` and got silently swallowed by the helper's own catch.
  const repos = {
    ...tx,
    tx: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as Repos;

  return { fakes, repos };
}

function makeDeps(
  overrides?: FakeOverrides & { reportError?: AnyFn },
): {
  deps: GenerateEventsFromSeriesDeps;
  fakes: ReturnType<typeof makeFakes>["fakes"];
} {
  const { fakes, repos } = makeFakes(overrides);
  return {
    deps: {
      repos,
      idempotency: makeIdempotency(),
      clock: makeClock(),
      ...(overrides?.reportError
        ? { reportError: overrides.reportError as never }
        : {}),
    },
    fakes,
  };
}

function baseInput(overrides?: Record<string, unknown>) {
  return {
    actorHumanId: ACTOR_ID,
    seriesId: SERIES_ID,
    limit: 10,
    clientKey: "generate-key-1",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("generateEventsFromSeries", () => {
  it("creates DRAFT events for future PLANNED occurrences and marks them GENERATED", async () => {
    const occurrence = makeOccurrence({ id: OCC_1_ID });
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () => [occurrence]),
    });

    const result = await generateEventsFromSeries(deps, baseInput());

    expect(result.skipped).toEqual([]);
    expect(result.generated).toHaveLength(1);
    expect(result.generated[0]!.occurrenceId).toBe(OCC_1_ID);

    // Draft stamped from Series.defaults (title + location), series timezone,
    // owned by the series owner, ALWAYS status DRAFT. eventId must be null so
    // the adapter takes its CREATE branch (truthy id = UPDATE = P2025).
    expect(fakes.upsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: null,
        orgId: null,
        humanId: ACTOR_ID,
        title: "Open Mic",
        startsAt: occurrence.startsAt,
        endsAt: null,
        status: "DRAFT",
        timezone: "UTC",
        location: { kind: "place", placeId: PLACE_ID },
      }),
    );

    // The result carries the id the draft primitive returned.
    const createdDraft = (await (fakes.upsertDraft as ReturnType<typeof vi.fn>)
      .mock.results[0]!.value) as { id: string };
    expect(result.generated[0]!.eventId).toBe(createdDraft.id);

    expect(fakes.attachEvent).toHaveBeenCalledWith({
      occurrenceId: OCC_1_ID,
      eventId: result.generated[0]!.eventId,
      updatedAt: NOW,
    });
    expect(fakes.markStatus).toHaveBeenCalledWith({
      occurrenceId: OCC_1_ID,
      status: "GENERATED",
      updatedAt: NOW,
    });

    expect(fakes.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_series",
        entityId: SERIES_ID,
        action: "events_generated",
        data: expect.objectContaining({
          generatedCount: 1,
          skippedCount: 0,
        }),
      }),
    );
  });

  it("merges Template.defaults → Series.defaults → Occurrence.overrides (later wins)", async () => {
    const withOverride = makeOccurrence({
      id: OCC_1_ID,
      ordinal: 1,
      overrides: { title: "Override Title" },
    });
    const withoutOverride = makeOccurrence({
      id: OCC_2_ID,
      ordinal: 2,
      startsAt: new Date("2026-04-20T18:00:00.000Z"),
    });

    const { deps, fakes } = makeDeps({
      seriesGetById: vi.fn(async () => makeSeries({ templateId: TEMPLATE_ID })),
      listBySeriesAndStatuses: vi.fn(async () => [
        withOverride,
        withoutOverride,
      ]),
      templatesGetById: vi.fn(async () => ({
        id: TEMPLATE_ID,
        ownerScope: "HUMAN",
        ownerId: ACTOR_ID,
        active: true,
        archivedAt: null,
        defaults: { title: "Template Title" },
      })),
    });

    await generateEventsFromSeries(deps, baseInput());

    // Occurrence override beats series + template
    expect(fakes.upsertDraft).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ title: "Override Title" }),
    );
    // Series titlePrefix beats template title
    expect(fakes.upsertDraft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: "Open Mic" }),
    );
  });

  it("falls back to Template.defaults title when the series has none", async () => {
    const { deps, fakes } = makeDeps({
      seriesGetById: vi.fn(async () =>
        makeSeries({ templateId: TEMPLATE_ID, defaults: null }),
      ),
      listBySeriesAndStatuses: vi.fn(async () => [
        makeOccurrence({ id: OCC_1_ID }),
      ]),
      templatesGetById: vi.fn(async () => ({
        id: TEMPLATE_ID,
        ownerScope: "HUMAN",
        ownerId: ACTOR_ID,
        active: true,
        archivedAt: null,
        defaults: { title: "Template Title" },
      })),
    });

    await generateEventsFromSeries(deps, baseInput());

    expect(fakes.upsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Template Title",
        location: { kind: "none" },
      }),
    );
  });

  it("treats an archived template as absent instead of failing", async () => {
    const { deps, fakes } = makeDeps({
      seriesGetById: vi.fn(async () =>
        makeSeries({ templateId: TEMPLATE_ID, defaults: null }),
      ),
      listBySeriesAndStatuses: vi.fn(async () => [
        makeOccurrence({ id: OCC_1_ID }),
      ]),
      templatesGetById: vi.fn(async () => ({
        id: TEMPLATE_ID,
        ownerScope: "HUMAN",
        ownerId: ACTOR_ID,
        active: false,
        archivedAt: new Date(),
        defaults: { title: "Template Title" },
      })),
    });

    const result = await generateEventsFromSeries(deps, baseInput());

    expect(result.generated).toHaveLength(1);
    // Falls through to the series name
    expect(fakes.upsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Weekly Jam" }),
    );
  });

  it("skips non-PLANNED, already-attached, and past occurrences", async () => {
    const generatedOcc = makeOccurrence({
      id: OCC_1_ID,
      status: "GENERATED",
      eventId: EXISTING_EVENT_ID,
    });
    const attachedPlanned = makeOccurrence({
      id: OCC_2_ID,
      status: "PLANNED",
      eventId: EXISTING_EVENT_ID,
    });
    const pastPlanned = makeOccurrence({
      id: OCC_3_ID,
      status: "PLANNED",
      startsAt: new Date("2026-03-02T18:00:00.000Z"),
    });

    const getById = vi.fn(async (id: string) => {
      if (id === OCC_1_ID) return generatedOcc;
      if (id === OCC_2_ID) return attachedPlanned;
      if (id === OCC_3_ID) return pastPlanned;
      return null;
    });

    const { deps, fakes } = makeDeps({ occurrenceGetById: getById });

    const result = await generateEventsFromSeries(
      deps,
      baseInput({
        occurrenceIds: [OCC_1_ID, OCC_2_ID, OCC_3_ID],
        limit: undefined,
      }),
    );

    expect(result.generated).toEqual([]);
    expect(result.skipped).toEqual([OCC_1_ID, OCC_2_ID, OCC_3_ID]);
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
    expect(fakes.markStatus).not.toHaveBeenCalled();
  });

  it("respects the limit when selecting PLANNED occurrences", async () => {
    const occurrences = [
      makeOccurrence({ id: OCC_1_ID, ordinal: 1 }),
      makeOccurrence({
        id: OCC_2_ID,
        ordinal: 2,
        startsAt: new Date("2026-04-20T18:00:00.000Z"),
      }),
      makeOccurrence({
        id: OCC_3_ID,
        ordinal: 3,
        startsAt: new Date("2026-04-27T18:00:00.000Z"),
      }),
    ];
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () => occurrences),
    });

    const result = await generateEventsFromSeries(
      deps,
      baseInput({ limit: 2 }),
    );

    expect(result.generated).toHaveLength(2);
    expect(result.generated.map((g) => g.occurrenceId)).toEqual([
      OCC_1_ID,
      OCC_2_ID,
    ]);
    expect(fakes.upsertDraft).toHaveBeenCalledTimes(2);
  });

  it("resolves explicit occurrenceIds via getById (not the PLANNED listing)", async () => {
    const occurrence = makeOccurrence({ id: OCC_1_ID });
    const getById = vi.fn(async () => occurrence);
    const listSpy = vi.fn(async (..._args: unknown[]) => []);

    const { deps } = makeDeps({
      occurrenceGetById: getById,
      listBySeriesAndStatuses: listSpy,
    });

    const result = await generateEventsFromSeries(
      deps,
      baseInput({ occurrenceIds: [OCC_1_ID], limit: undefined }),
    );

    expect(result.generated).toHaveLength(1);
    expect(getById).toHaveBeenCalledWith(OCC_1_ID);
    // The all-statuses listing IS called once for the ticket-copy source
    // scan, but never with the PLANNED-only target filter.
    const plannedTargetCalls = listSpy.mock.calls.filter(
      (call) =>
        Array.isArray(call[1]) &&
        (call[1] as string[]).length === 1 &&
        (call[1] as string[])[0] === "PLANNED",
    );
    expect(plannedTargetCalls).toHaveLength(0);
  });

  it("fails OCCURRENCE_NOT_FOUND for an id from another series", async () => {
    const foreign = makeOccurrence({
      id: OCC_1_ID,
      seriesId: "00000000-0000-4000-8000-00000000ffff",
    });
    const { deps } = makeDeps({
      occurrenceGetById: vi.fn(async () => foreign),
    });

    await expect(
      generateEventsFromSeries(
        deps,
        baseInput({ occurrenceIds: [OCC_1_ID], limit: undefined }),
      ),
    ).rejects.toMatchObject({ code: "OCCURRENCE_NOT_FOUND" });
  });

  it("returns an empty result when nothing is eligible", async () => {
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () => []),
    });

    const result = await generateEventsFromSeries(deps, baseInput());

    expect(result).toEqual({ generated: [], skipped: [] });
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
  });

  it("fails atomically when a defaults place is no longer accessible", async () => {
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () => [
        makeOccurrence({ id: OCC_1_ID }),
      ]),
      placesGetById: vi.fn(async () => ({
        id: PLACE_ID,
        status: "ACTIVE",
        orgIdsWithAccess: [],
        humanIdsWithAccess: [], // owner lost access
      })),
    });

    await expect(
      generateEventsFromSeries(deps, baseInput()),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
    expect(fakes.markStatus).not.toHaveBeenCalled();
  });

  it("fails SERIES_NOT_FOUND for a missing series", async () => {
    const { deps } = makeDeps({
      seriesGetById: vi.fn(async () => null),
    });

    await expect(
      generateEventsFromSeries(deps, baseInput()),
    ).rejects.toMatchObject({ code: "SERIES_NOT_FOUND" });
  });

  it("fails SERIES_INACTIVE for an archived series", async () => {
    const { deps } = makeDeps({
      seriesGetById: vi.fn(async () =>
        makeSeries({ active: false, archivedAt: new Date() }),
      ),
    });

    await expect(
      generateEventsFromSeries(deps, baseInput()),
    ).rejects.toMatchObject({ code: "SERIES_INACTIVE" });
  });

  it("denies an actor who is not the series owner", async () => {
    const { deps } = makeDeps();

    await expect(
      generateEventsFromSeries(
        deps,
        baseInput({ actorHumanId: "00000000-0000-4000-8000-000000000099" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("replays the stored response without re-executing", async () => {
    const { deps: firstDeps } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () => [
        makeOccurrence({ id: OCC_1_ID }),
      ]),
    });
    const first = await generateEventsFromSeries(firstDeps, baseInput());
    expect(first.generated).toHaveLength(1);
    const committed = (firstDeps.idempotency.commit as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1];

    const { deps: replayDeps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () => [
        makeOccurrence({ id: OCC_1_ID }),
      ]),
    });
    (replayDeps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      committed,
    );

    const replayed = await generateEventsFromSeries(replayDeps, baseInput());

    expect(replayed).toEqual(first);
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
    expect(fakes.markStatus).not.toHaveBeenCalled();
    expect(replayDeps.idempotency.begin).not.toHaveBeenCalled();
  });

  it("throws IDEMPOTENCY_KEY_CONFLICT when the replayed payload hash differs", async () => {
    const { deps, fakes } = makeDeps();
    (deps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      payloadHash: "some-other-payload-hash",
      response: { generated: [], skipped: [] },
    });

    await expect(
      generateEventsFromSeries(deps, baseInput()),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
  });

  it("marks the idempotency record failed on error", async () => {
    const { deps } = makeDeps({
      seriesGetById: vi.fn(async () => null),
    });

    await expect(
      generateEventsFromSeries(deps, baseInput()),
    ).rejects.toMatchObject({ code: "SERIES_NOT_FOUND" });
    expect(deps.idempotency.fail).toHaveBeenCalled();
    expect(deps.idempotency.commit).not.toHaveBeenCalled();
  });

  it("rejects when neither occurrenceIds nor limit is provided", async () => {
    const { deps } = makeDeps();

    await expect(
      generateEventsFromSeries(deps, baseInput({ limit: undefined })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("never touches a SKIPPED occurrence (explicit ids or PLANNED listing)", async () => {
    const skipped = makeOccurrence({
      id: OCC_1_ID,
      status: "SKIPPED",
      overrides: { skipNote: "band unavailable" },
    });

    // Explicit-id path: SKIPPED is reported as skipped, no draft created.
    const { deps, fakes } = makeDeps({
      occurrenceGetById: vi.fn(async () => skipped),
      // Source scan (all statuses) sees the SKIPPED row; target selection
      // must not pick it up.
      listBySeriesAndStatuses: vi.fn(async (..._args: unknown[]) => [skipped]),
    });

    const explicit = await generateEventsFromSeries(
      deps,
      baseInput({ occurrenceIds: [OCC_1_ID], limit: undefined }),
    );
    expect(explicit.generated).toEqual([]);
    expect(explicit.skipped).toEqual([OCC_1_ID]);
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
    expect(fakes.markStatus).not.toHaveBeenCalled();

    // Bulk path: target selection is PLANNED-only, so a SKIPPED row is never
    // even a candidate (arg-aware fake mirrors the adapter's status filter).
    const { deps: bulkDeps, fakes: bulkFakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(
        async (_seriesId: string, statuses: string[]) =>
          statuses.includes("SKIPPED") ? [skipped] : [],
      ),
    });
    const bulk = await generateEventsFromSeries(bulkDeps, baseInput());
    expect(bulk.generated).toEqual([]);
    expect(bulk.skipped).toEqual([]);
    expect(bulkFakes.upsertDraft).not.toHaveBeenCalled();
  });

  it("materializes a manual PLANNED occurrence (overrides.manual) like any other", async () => {
    const manual = makeOccurrence({
      id: OCC_1_ID,
      overrides: { manual: true, note: "one-off holiday show" },
    });
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async (..._args: unknown[]) => [manual]),
    });

    const result = await generateEventsFromSeries(deps, baseInput());

    expect(result.generated).toHaveLength(1);
    expect(result.generated[0]!.occurrenceId).toBe(OCC_1_ID);
    expect(fakes.markStatus).toHaveBeenCalledWith({
      occurrenceId: OCC_1_ID,
      status: "GENERATED",
      updatedAt: NOW,
    });
  });

  describe("ticket-type copy", () => {
    const SOURCE_EVENT_ID = "00000000-0000-4000-8000-000000000031";

    const sourceTicketType = {
      id: "00000000-0000-4000-8000-000000000041",
      name: "GA",
      description: "General admission",
      priceCents: 2500,
      pricingMode: "FIXED" as const,
      minimumCents: null,
      suggestedCents: null,
      capacity: 120,
      status: "ACTIVE" as const,
      seatSectionId: "00000000-0000-4000-8000-000000000051",
      resaleAllowed: true,
      resaleCapCents: 5000,
      transferAllowed: true,
    };

    function sourceOccurrence(ordinal: number, eventId: string) {
      return makeOccurrence({
        id: `00000000-0000-4000-8000-0000000000${60 + ordinal}`,
        ordinal,
        status: "GENERATED",
        eventId,
        startsAt: new Date("2026-04-06T18:00:00.000Z"),
      });
    }

    it("copies the source event's ticket-type definitions onto each new draft", async () => {
      const source = sourceOccurrence(1, SOURCE_EVENT_ID);
      const target = makeOccurrence({ id: OCC_2_ID, ordinal: 2 });

      const listTicketTypes = vi.fn(async () => [sourceTicketType]);
      const createTicketType = vi.fn(async (..._args: unknown[]) => ({
        id: "tt-copy",
      }));

      const { deps, fakes } = makeDeps({
        listBySeriesAndStatuses: vi.fn(
          async (_seriesId: string, statuses: string[]) =>
            statuses.includes("GENERATED") ? [source, target] : [target],
        ),
        listTicketTypes,
        createTicketType,
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated).toHaveLength(1);
      const newEventId = result.generated[0]!.eventId;

      expect(listTicketTypes).toHaveBeenCalledTimes(1);
      expect(listTicketTypes).toHaveBeenCalledWith(SOURCE_EVENT_ID);
      expect(createTicketType).toHaveBeenCalledTimes(1);
      expect(createTicketType).toHaveBeenCalledWith({
        eventId: newEventId,
        name: "GA",
        description: "General admission",
        priceCents: 2500,
        pricingMode: "FIXED",
        minimumCents: null,
        suggestedCents: null,
        capacity: 120,
        status: "DRAFT", // non-purchasable until publish activates it
        createdAt: NOW,
        seatSectionId: null, // event-scoped — never cross-linked
        resaleAllowed: true,
        resaleCapCents: 5000,
        transferAllowed: true,
      });
      // No per-event state (sold counts / stripe ids / source type id) is
      // ever forwarded — the exact-call assertion above proves the payload
      // contains ONLY definition fields.
      expect(fakes.markStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: "GENERATED" }),
      );
    });

    // ── FR-004 + Q-005: schedule copy, gated on whether it has elapsed ────
    //
    // `scheduledPriceAt` is the one ABSOLUTE-dated field in this copy. A LIVE
    // (future) schedule rides along; an already-elapsed one is NULLED, because
    // a weekly series with "early bird until Jan 1" would otherwise give every
    // February occurrence a schedule that fires the instant it publishes —
    // full price from birth, across twelve dates nobody audits. The relative
    // { anchor, offsetMinutes } encoding (Phase 3 / FR-011) is the real fix.

    function scheduleFixture(flipAt: Date) {
      const source = sourceOccurrence(1, SOURCE_EVENT_ID);
      const target = makeOccurrence({ id: OCC_2_ID, ordinal: 2 });

      const listTicketTypes = vi.fn(async () => [
        {
          ...sourceTicketType,
          priceCents: 1200,
          scheduledPriceCents: 2000,
          scheduledPriceAt: flipAt,
        },
      ]);
      const createTicketType = vi.fn(async (..._args: unknown[]) => ({
        id: "tt-copy",
      }));

      const { deps, fakes } = makeDeps({
        listBySeriesAndStatuses: vi.fn(
          async (_seriesId: string, statuses: string[]) =>
            statuses.includes("GENERATED") ? [source, target] : [target],
        ),
        listTicketTypes,
        createTicketType,
      });

      return { deps, fakes, createTicketType };
    }

    it("copies a FUTURE scheduled price change onto each generated draft, as a pair", async () => {
      const flipAt = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
      const { deps, createTicketType } = scheduleFixture(flipAt);

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(createTicketType).toHaveBeenCalledWith(
        expect.objectContaining({
          priceCents: 1200,
          scheduledPriceCents: 2000,
          scheduledPriceAt: flipAt,
          status: "DRAFT",
        }),
      );
      expect(result.generated[0]!.scheduledPricesDropped).toBe(0);
    });

    it("Q-005: NULLS an already-ELAPSED schedule on each generated draft and reports the drop", async () => {
      const flipAt = new Date(NOW.getTime() - 1);
      const { deps, createTicketType } = scheduleFixture(flipAt);

      const result = await generateEventsFromSeries(deps, baseInput());

      // Nulled as a PAIR; the base price — what the source charges today —
      // survives.
      expect(createTicketType).toHaveBeenCalledWith(
        expect.objectContaining({
          priceCents: 1200,
          scheduledPriceCents: null,
          scheduledPriceAt: null,
          status: "DRAFT",
        }),
      );
      expect(result.generated[0]!.scheduledPricesDropped).toBe(1);
    });

    it("Q-005: a flip at EXACTLY now counts as elapsed (inclusive, same as the resolver)", async () => {
      const { deps, createTicketType } = scheduleFixture(new Date(NOW.getTime()));

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(createTicketType).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledPriceCents: null }),
      );
      expect(result.generated[0]!.scheduledPricesDropped).toBe(1);
    });

    // ── FR-014: sales-window copy, gated on whether the window has CLOSED ──
    //
    // Same decision, same reasoning as the schedule above, and deliberately not
    // a different rule: salesOpenAt / salesCloseAt are absolute instants too,
    // so a weekly series whose advance tier "closes 14 days before the January
    // show" would otherwise give every February occurrence a tier that is
    // closed the day it is created. FR-016's convention for the analogous
    // template case is "null window + surface it", so that is what happens.
    //
    // An elapsed OPEN alone is NOT a drop: it means "already open", which is
    // what no lower bound means anyway.

    function windowFixture(window: {
      salesOpenAt?: Date | null;
      salesCloseAt?: Date | null;
    }) {
      const source = sourceOccurrence(1, SOURCE_EVENT_ID);
      const target = makeOccurrence({ id: OCC_2_ID, ordinal: 2 });

      const listTicketTypes = vi.fn(async () => [
        {
          ...sourceTicketType,
          salesOpenAt: null,
          salesCloseAt: null,
          ...window,
        },
      ]);
      const createTicketType = vi.fn(async (..._args: unknown[]) => ({
        id: "tt-copy",
      }));

      const { deps } = makeDeps({
        listBySeriesAndStatuses: vi.fn(
          async (_seriesId: string, statuses: string[]) =>
            statuses.includes("GENERATED") ? [source, target] : [target],
        ),
        listTicketTypes,
        createTicketType,
      });

      return { deps, createTicketType };
    }

    const DAY_MS = 24 * 60 * 60 * 1000;

    it("copies a FUTURE window onto each generated draft untouched", async () => {
      const salesOpenAt = new Date(NOW.getTime() + DAY_MS);
      const salesCloseAt = new Date(NOW.getTime() + 10 * DAY_MS);
      const { deps, createTicketType } = windowFixture({
        salesOpenAt,
        salesCloseAt,
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(createTicketType).toHaveBeenCalledWith(
        expect.objectContaining({ salesOpenAt, salesCloseAt }),
      );
      expect(result.generated[0]!.salesWindowsDropped).toBe(0);
    });

    it("NULLS an already-CLOSED window as a pair and reports the drop", async () => {
      const { deps, createTicketType } = windowFixture({
        salesOpenAt: new Date(NOW.getTime() - 10 * DAY_MS),
        salesCloseAt: new Date(NOW.getTime() - DAY_MS),
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(createTicketType).toHaveBeenCalledWith(
        expect.objectContaining({
          // The tier survives, fully sellable, at its base price.
          priceCents: 2500,
          salesOpenAt: null,
          salesCloseAt: null,
          status: "DRAFT",
        }),
      );
      expect(result.generated[0]!.salesWindowsDropped).toBe(1);
    });

    it("a close at EXACTLY now counts as elapsed (the close bound is EXCLUSIVE)", async () => {
      const { deps, createTicketType } = windowFixture({
        salesCloseAt: new Date(NOW.getTime()),
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(createTicketType).toHaveBeenCalledWith(
        expect.objectContaining({ salesCloseAt: null }),
      );
      expect(result.generated[0]!.salesWindowsDropped).toBe(1);
    });

    it("an elapsed OPEN with no close rides along — it just means 'already open'", async () => {
      const salesOpenAt = new Date(NOW.getTime() - 10 * DAY_MS);
      const { deps, createTicketType } = windowFixture({ salesOpenAt });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(createTicketType).toHaveBeenCalledWith(
        expect.objectContaining({ salesOpenAt, salesCloseAt: null }),
      );
      expect(result.generated[0]!.salesWindowsDropped).toBe(0);
    });

    it("NFR-001: an UNWINDOWED source drops nothing", async () => {
      const { deps } = windowFixture({});

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated[0]!.salesWindowsDropped).toBe(0);
    });

    it("picks the EARLIEST-ordinal occurrence with an event as the source", async () => {
      const laterSource = sourceOccurrence(
        5,
        "00000000-0000-4000-8000-000000000099",
      );
      const earliestSource = sourceOccurrence(2, SOURCE_EVENT_ID);
      const target = makeOccurrence({ id: OCC_2_ID, ordinal: 7 });

      const listTicketTypes = vi.fn(async () => []);
      const { deps } = makeDeps({
        listBySeriesAndStatuses: vi.fn(
          async (_seriesId: string, statuses: string[]) =>
            statuses.includes("GENERATED")
              ? [laterSource, earliestSource, target]
              : [target],
        ),
        listTicketTypes,
      });

      await generateEventsFromSeries(deps, baseInput());

      expect(listTicketTypes).toHaveBeenCalledTimes(1);
      expect(listTicketTypes).toHaveBeenCalledWith(SOURCE_EVENT_ID);
    });

    it("never picks a DETACHED/CANCELLED occurrence's stale event over an active sibling", async () => {
      // bulkDetach doesn't clear eventId — a detached ordinal-1 occurrence
      // keeps its stale event link. The ACTIVE (GENERATED/PUBLISHED) sibling
      // must win even with a higher ordinal, or reprices on the orphaned
      // event would leak into every future draft.
      const detachedFirst = makeOccurrence({
        id: "00000000-0000-4000-8000-000000000061",
        ordinal: 1,
        status: "DETACHED",
        eventId: "00000000-0000-4000-8000-000000000098",
        startsAt: new Date("2026-04-06T18:00:00.000Z"),
      });
      const activeLater = sourceOccurrence(4, SOURCE_EVENT_ID); // GENERATED
      const target = makeOccurrence({ id: OCC_2_ID, ordinal: 7 });

      const listTicketTypes = vi.fn(async () => []);
      const { deps } = makeDeps({
        listBySeriesAndStatuses: vi.fn(
          async (_seriesId: string, statuses: string[]) =>
            statuses.includes("DETACHED")
              ? [detachedFirst, activeLater, target]
              : [target],
        ),
        listTicketTypes,
      });

      await generateEventsFromSeries(deps, baseInput());

      expect(listTicketTypes).toHaveBeenCalledTimes(1);
      expect(listTicketTypes).toHaveBeenCalledWith(SOURCE_EVENT_ID);
    });

    it("falls back to a non-active occurrence's event only when NO active source exists", async () => {
      const detachedOnly = makeOccurrence({
        id: "00000000-0000-4000-8000-000000000061",
        ordinal: 1,
        status: "DETACHED",
        eventId: SOURCE_EVENT_ID,
        startsAt: new Date("2026-04-06T18:00:00.000Z"),
      });
      const target = makeOccurrence({ id: OCC_2_ID, ordinal: 2 });

      const listTicketTypes = vi.fn(async () => []);
      const { deps } = makeDeps({
        listBySeriesAndStatuses: vi.fn(
          async (_seriesId: string, statuses: string[]) =>
            statuses.includes("DETACHED") ? [detachedOnly, target] : [target],
        ),
        listTicketTypes,
      });

      await generateEventsFromSeries(deps, baseInput());

      expect(listTicketTypes).toHaveBeenCalledTimes(1);
      expect(listTicketTypes).toHaveBeenCalledWith(SOURCE_EVENT_ID);
    });

    it("creates drafts WITHOUT ticket types when the series has no source event", async () => {
      const target = makeOccurrence({ id: OCC_1_ID });
      const createTicketType = vi.fn(async () => ({ id: "tt" }));
      const listTicketTypes = vi.fn(async () => [sourceTicketType]);

      const { deps } = makeDeps({
        listBySeriesAndStatuses: vi.fn(async (..._args: unknown[]) => [target]),
        listTicketTypes,
        createTicketType,
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated).toHaveLength(1);
      expect(listTicketTypes).not.toHaveBeenCalled();
      expect(createTicketType).not.toHaveBeenCalled();
    });

    it("fails atomically when a ticket-type copy write fails", async () => {
      const source = sourceOccurrence(1, SOURCE_EVENT_ID);
      const target = makeOccurrence({ id: OCC_2_ID, ordinal: 2 });

      const { deps } = makeDeps({
        listBySeriesAndStatuses: vi.fn(
          async (_seriesId: string, statuses: string[]) =>
            statuses.includes("GENERATED") ? [source, target] : [target],
        ),
        listTicketTypes: vi.fn(async () => [sourceTicketType]),
        createTicketType: vi.fn(async () => {
          throw new Error("db write failed");
        }),
      });

      await expect(
        generateEventsFromSeries(deps, baseInput()),
      ).rejects.toThrow();
      // The failure escapes the tx callback (rollback in production) and the
      // idempotency record is marked failed — no committed partial result.
      expect(deps.idempotency.fail).toHaveBeenCalled();
      expect(deps.idempotency.commit).not.toHaveBeenCalled();
    });
  });
  // ── Arrival areas (owner Q12, 2026-10-17) ──────────────────────────────
  describe("arrival areas copy (owner Q12)", () => {
    const SOURCE_EVENT_ID = "00000000-0000-4000-8000-000000000031";
    const LATER_EVENT_ID = "00000000-0000-4000-8000-000000000032";
    const OTHER_PLACE_ID = "00000000-0000-4000-8000-000000000006";
    const SRC_LOT = "00000000-0000-4000-8000-000000000081";
    const SRC_FAR = "00000000-0000-4000-8000-000000000082";
    const SRC_OFF = "00000000-0000-4000-8000-000000000083";
    const PLACE_AREA = "00000000-0000-4000-8000-000000000084";
    const AT = new Date("2026-03-01T00:00:00.000Z");
    const OFF_AT = new Date("2026-03-02T00:00:00.000Z");
    const LAT = 36.1862;
    const LNG = -86.7291;

    /** A ~40 m square `dx` metres east of the pin. */
    const lotAt = (dx: number) => {
      const dLng = dx / (111_195 * Math.cos((LAT * Math.PI) / 180));
      const h = 20 / 111_195;
      const w = 20 / (111_195 * Math.cos((LAT * Math.PI) / 180));
      const x = LNG + dLng;
      return {
        type: "Polygon" as const,
        coordinates: [
          [
            [x - w, LAT - h],
            [x + w, LAT - h],
            [x + w, LAT + h],
            [x - w, LAT + h],
            [x - w, LAT - h],
          ],
        ],
      };
    };

    type Row = {
      id: string;
      placeId: string | null;
      eventId: string | null;
      kind: string;
      geometry: unknown;
      label: string;
      cost: string;
      priceText: string | null;
      note: string | null;
      accessibleSpots: boolean;
      sortOrder: number;
      disabledAt: Date | null;
      createdByHumanId: string | null;
      createdAt: Date;
      updatedAt: Date;
    };
    const row = (id: string, eventId: string, over: Partial<Row> = {}): Row => ({
      id,
      placeId: null,
      eventId,
      kind: "PARKING",
      geometry: lotAt(100),
      label: `Lot ${id.slice(-2)}`,
      cost: "FREE",
      priceText: null,
      note: null,
      accessibleSpots: false,
      sortOrder: 0,
      disabledAt: null,
      createdByHumanId: null,
      createdAt: AT,
      updatedAt: AT,
      ...over,
    });

    function setup(opts: {
      rows: Row[];
      hides: Array<{ eventId: string; arrivalAreaId: string }>;
      sourcePlaceId?: string | null;
      /** Where the generated drafts land (the series defaults). */
      draftLocation?: { placeId: string | null; lat?: number; lng?: number };
      /** The place row's pin; null = a place saved without coordinates. */
      placePin?: { lat: number; lng: number } | null;
      extraOccurrences?: EventSeriesOccurrenceRecord[];
    }) {
      const store = new Map(opts.rows.map((r) => [r.id, { ...r }]));
      const hides = [...opts.hides];
      let n = 0;
      const arrivalAreas = {
        listForEvent: vi.fn(async (eventId: string) =>
          [...store.values()].filter((r) => r.eventId === eventId).map((r) => ({ ...r })),
        ),
        listHidesForEvent: vi.fn(async (eventId: string) =>
          hides.filter((h) => h.eventId === eventId).map((h) => h.arrivalAreaId),
        ),
        create: vi.fn(async (input: Partial<Row> & { eventId: string }) => {
          n += 1;
          const r = row(`00000000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`, input.eventId, {
            ...input,
            createdAt: NOW,
            updatedAt: NOW,
          } as Partial<Row>);
          store.set(r.id, r);
          return { ...r };
        }),
        update: vi.fn(async (id: string, patch: Partial<Row>, o: { expectedUpdatedAt: Date }) => {
          const r = store.get(id)!;
          if (r.updatedAt.getTime() !== o.expectedUpdatedAt.getTime()) {
            return { status: "conflict" as const, current: { ...r } };
          }
          const next = { ...r, ...patch, updatedAt: new Date(r.updatedAt.getTime() + 1) };
          store.set(id, next);
          return { status: "updated" as const, row: { ...next } };
        }),
        hide: vi.fn(async (eventId: string, arrivalAreaId: string) => {
          hides.push({ eventId, arrivalAreaId });
          return true;
        }),
        lockParent: vi.fn(async () => true),
      };
      const draftLocation = opts.draftLocation ?? { placeId: PLACE_ID };
      const upsertDraft = vi.fn(async () => ({
        id: randomUUID(),
        placeId: draftLocation.placeId,
        lat: draftLocation.lat ?? null,
        lng: draftLocation.lng ?? null,
      }));
      const source = makeOccurrence({
        id: "00000000-0000-4000-8000-000000000061",
        ordinal: 1,
        status: "GENERATED",
        eventId: SOURCE_EVENT_ID,
        startsAt: new Date("2026-04-06T18:00:00.000Z"),
      });
      const t1 = makeOccurrence({ id: OCC_2_ID, ordinal: 2 });
      const t2 = makeOccurrence({
        id: OCC_3_ID,
        ordinal: 3,
        startsAt: new Date("2026-04-20T18:00:00.000Z"),
      });
      const eventsGetById = vi.fn(async (id: string) =>
        id === SOURCE_EVENT_ID
          ? { id, placeId: opts.sourcePlaceId === undefined ? PLACE_ID : opts.sourcePlaceId }
          : null,
      );
      // The series defaults say where the drafts land; keep them in step
      // with what the fake `upsertDraft` returns.
      const seriesLocation = draftLocation.placeId
        ? { kind: "place" as const, placeId: draftLocation.placeId }
        : draftLocation.lat !== undefined && draftLocation.lng !== undefined
          ? {
              kind: "freeform" as const,
              addressText: "12 Side St",
              lat: draftLocation.lat,
              lng: draftLocation.lng,
            }
          : { kind: "none" as const };
      const base = makeSeries();
      const placePin = opts.placePin === undefined ? { lat: LAT, lng: LNG } : opts.placePin;
      const placesGetById = vi.fn(async (id: string) => ({
        id,
        status: "ACTIVE",
        orgIdsWithAccess: [],
        humanIdsWithAccess: [ACTOR_ID],
        locationMode: "EXACT",
        lat: placePin?.lat ?? null,
        lng: placePin?.lng ?? null,
      }));
      const { deps, fakes } = makeDeps({
        seriesGetById: vi.fn(async () =>
          makeSeries({ defaults: { ...base.defaults, location: seriesLocation } }),
        ),
        listBySeriesAndStatuses: vi.fn(async (_s: string, statuses: string[]) =>
          statuses.includes("GENERATED")
            ? [source, ...(opts.extraOccurrences ?? []), t1, t2]
            : [t1, t2],
        ),
        upsertDraft,
        eventsGetById,
        placesGetById,
        arrivalAreas: arrivalAreas as unknown as Record<string, AnyFn>,
      });
      return { deps, fakes, arrivalAreas, store, hides, eventsGetById, placesGetById };
    }

    const audits = (fakes: { auditLog: AnyFn }) =>
      (fakes.auditLog as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
        ([e]) => e as { action: string; entityId: string; data: Record<string, unknown> },
      );

    it("each new draft at the source's place gets its event-only areas in order and its hides, audited per area", async () => {
      const { deps, fakes, store, hides } = setup({
        rows: [
          row(SRC_LOT, SOURCE_EVENT_ID, { sortOrder: 0, label: "Main lot", cost: "PAID", priceText: "$5" }),
          row(SRC_OFF, SOURCE_EVENT_ID, { sortOrder: 1, kind: "LOAD_IN", disabledAt: OFF_AT }),
          // A place area is never copied (only the source's own areas are).
          { ...row(PLACE_AREA, SOURCE_EVENT_ID), eventId: null, placeId: PLACE_ID },
        ],
        hides: [{ eventId: SOURCE_EVENT_ID, arrivalAreaId: PLACE_AREA }],
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated).toHaveLength(2);
      for (const { eventId } of result.generated) {
        const copies = [...store.values()]
          .filter((r) => r.eventId === eventId)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        expect(copies.map((r) => [r.label, r.kind, r.cost, r.priceText, r.sortOrder, r.disabledAt])).toEqual([
          ["Main lot", "PARKING", "PAID", "$5", 0, null],
          ["Lot 83", "LOAD_IN", "FREE", null, 1, OFF_AT],
        ]);
        expect(copies.every((r) => r.id !== SRC_LOT && r.id !== SRC_OFF)).toBe(true);
        expect(hides.filter((h) => h.eventId === eventId).map((h) => h.arrivalAreaId)).toEqual([
          PLACE_AREA,
        ]);
      }
      // The source keeps its own rows.
      expect(store.get(SRC_LOT)?.eventId).toBe(SOURCE_EVENT_ID);

      const mine = audits(fakes).filter((e) => e.data?.via === "series_generate");
      expect(mine.map((e) => e.action)).toEqual([
        "arrival_area.created",
        "arrival_area.created",
        "arrival_area.hidden",
        "arrival_area.created",
        "arrival_area.created",
        "arrival_area.hidden",
      ]);
      expect(mine[0]!.data).toMatchObject({
        actorHumanId: ACTOR_ID,
        sourceEventId: SOURCE_EVENT_ID,
        eventId: result.generated[0]!.eventId,
        sourceArrivalAreaId: SRC_LOT,
        before: null,
      });
      expect(mine[0]!.data.switchedOffOutsideEnvelope).toBeUndefined();
      // Every area row is written before the run's series audit row (the
      // same transaction; slugs come after the commit).
      const actions = audits(fakes).map((e) => e.action);
      expect(actions.lastIndexOf("arrival_area.hidden")).toBeLessThan(
        actions.indexOf("events_generated"),
      );
    });

    it("FR-014: a copy not within 3 km of the new draft's pin is copied switched off; one inside stays on", async () => {
      const { deps, fakes, store } = setup({
        rows: [
          row(SRC_LOT, SOURCE_EVENT_ID, { sortOrder: 0, geometry: lotAt(500) }),
          row(SRC_FAR, SOURCE_EVENT_ID, { sortOrder: 1, geometry: lotAt(5_000) }),
        ],
        hides: [],
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      const copies = [...store.values()]
        .filter((r) => r.eventId === result.generated[0]!.eventId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      expect(copies.map((r) => r.disabledAt)).toEqual([null, NOW]);
      const far = audits(fakes).find(
        (e) => e.action === "arrival_area.created" && e.data.sourceArrivalAreaId === SRC_FAR,
      );
      expect(far?.data).toMatchObject({
        via: "series_generate",
        switchedOffOutsideEnvelope: true,
        after: expect.objectContaining({ disabledAt: NOW.toISOString() }),
      });
    });

    it("a draft the series puts at ANOTHER place copies no areas and no hides", async () => {
      const { deps, fakes, store, hides, arrivalAreas, placesGetById } = setup({
        rows: [row(SRC_LOT, SOURCE_EVENT_ID)],
        hides: [{ eventId: SOURCE_EVENT_ID, arrivalAreaId: PLACE_AREA }],
        sourcePlaceId: OTHER_PLACE_ID,
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated).toHaveLength(2);
      expect(arrivalAreas.create).not.toHaveBeenCalled();
      expect(arrivalAreas.hide).not.toHaveBeenCalled();
      expect([...store.values()].filter((r) => r.eventId !== SOURCE_EVENT_ID)).toEqual([]);
      expect(hides.filter((h) => h.eventId !== SOURCE_EVENT_ID)).toEqual([]);
      expect(audits(fakes).filter((e) => e.action.startsWith("arrival_area."))).toEqual([]);
      // The draft's place is read once per draft, by the access check only.
      expect(placesGetById).toHaveBeenCalledTimes(2);
    });

    it("freeform source and freeform draft (no place on either side) copy nothing", async () => {
      const { deps, fakes, store, arrivalAreas } = setup({
        rows: [row(SRC_LOT, SOURCE_EVENT_ID)],
        hides: [],
        sourcePlaceId: null,
        draftLocation: { placeId: null, lat: LAT, lng: LNG },
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated).toHaveLength(2);
      expect(arrivalAreas.create).not.toHaveBeenCalled();
      expect(arrivalAreas.hide).not.toHaveBeenCalled();
      expect([...store.values()].filter((r) => r.eventId !== SOURCE_EVENT_ID)).toEqual([]);
      expect(audits(fakes).filter((e) => e.action.startsWith("arrival_area."))).toEqual([]);
    });

    it("a draft with no location copies nothing", async () => {
      const { deps, arrivalAreas } = setup({
        rows: [row(SRC_LOT, SOURCE_EVENT_ID)],
        hides: [],
        draftLocation: { placeId: null },
      });

      await generateEventsFromSeries(deps, baseInput());

      expect(arrivalAreas.create).not.toHaveBeenCalled();
    });

    it("same place with no pin on the place row: copies are switched off (FR-014)", async () => {
      const { deps, store } = setup({
        rows: [row(SRC_LOT, SOURCE_EVENT_ID)],
        hides: [],
        placePin: null,
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      const copies = [...store.values()].filter((r) => r.eventId === result.generated[0]!.eventId);
      expect(copies.map((r) => r.disabledAt)).toEqual([NOW]);
    });

    it("copies from the ticket-type source (earliest active occurrence), never a later sibling", async () => {
      const later = makeOccurrence({
        id: "00000000-0000-4000-8000-000000000065",
        ordinal: 5,
        status: "GENERATED",
        eventId: LATER_EVENT_ID,
        startsAt: new Date("2026-05-04T18:00:00.000Z"),
      });
      const { deps, arrivalAreas, store } = setup({
        rows: [
          row(SRC_LOT, SOURCE_EVENT_ID, { label: "From the source" }),
          row(SRC_FAR, LATER_EVENT_ID, { label: "From a later show" }),
        ],
        hides: [],
        extraOccurrences: [later],
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(arrivalAreas.listForEvent).toHaveBeenCalledTimes(1);
      expect(arrivalAreas.listForEvent).toHaveBeenCalledWith(SOURCE_EVENT_ID);
      const labels = [...store.values()]
        .filter((r) => r.eventId === result.generated[0]!.eventId)
        .map((r) => r.label);
      expect(labels).toEqual(["From the source"]);
    });

    it("a source with no areas and no hides writes nothing and never reads the source event", async () => {
      const { deps, arrivalAreas, eventsGetById } = setup({ rows: [], hides: [] });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated).toHaveLength(2);
      expect(arrivalAreas.listForEvent).toHaveBeenCalledTimes(1);
      expect(arrivalAreas.create).not.toHaveBeenCalled();
      expect(arrivalAreas.hide).not.toHaveBeenCalled();
      expect(eventsGetById).not.toHaveBeenCalled();
    });

    it("fails atomically when an area copy write fails", async () => {
      const { deps, arrivalAreas } = setup({ rows: [row(SRC_LOT, SOURCE_EVENT_ID)], hides: [] });
      arrivalAreas.create.mockRejectedValueOnce(new Error("db write failed"));

      await expect(generateEventsFromSeries(deps, baseInput())).rejects.toThrow();
      expect(deps.idempotency.fail).toHaveBeenCalled();
      expect(deps.idempotency.commit).not.toHaveBeenCalled();
    });
  });

  // ── Slug at create ─────────────────────────────────────────────────────
  describe("slug at create", () => {
    it("slugs every generated draft", async () => {
      // This path calls `upsertDraft` DIRECTLY — it never goes through
      // `finalizeSaveEvent` — so without its own call every series-generated
      // draft would be slugless and its public preview would 500.
      const { deps, fakes } = makeDeps({
        listBySeriesAndStatuses: vi.fn(async () => [
          makeOccurrence({ id: OCC_1_ID }),
          makeOccurrence({ id: OCC_2_ID, ordinal: 2 }),
        ]),
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated).toHaveLength(2);
      expect(fakes.assignSlug).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(fakes.assignSlug).mock.calls) {
        expect(call[0].slug).toMatch(
          /^event\/us\/nashville\/open-mic-2026-04-13-1300--[a-z0-9]{10}$/,
        );
      }
      // Each draft is slugged under ITS OWN id.
      const slugged = vi
        .mocked(fakes.assignSlug)
        .mock.calls.map((c) => c[0].eventId);
      expect(new Set(slugged).size).toBe(2);
    });

    it("generates the drafts ANYWAY when there is no country code", async () => {
      const { deps, fakes } = makeDeps({
        listBySeriesAndStatuses: vi.fn(async () => [
          makeOccurrence({ id: OCC_1_ID }),
        ]),
        getSlugContext: vi.fn(async (eventId: string) => ({
          eventId,
          orgId: null,
          humanId: ACTOR_ID,
          eventTitle: "Open Mic",
          startsAt: new Date("2026-04-13T18:00:00.000Z"),
          timezone: "America/Chicago",
          orgName: null,
          countryCode: null,
          regionCode: null,
          cityOrRegionCode: null,
          shortId: null,
        })),
        reportError: vi.fn(),
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated).toHaveLength(1);
      expect(fakes.assignSlug).not.toHaveBeenCalled();
      // Expected outcome, not an incident.
      expect(deps.reportError).not.toHaveBeenCalled();
    });

    it("generates the drafts ANYWAY when assignSlug fails, and REPORTS it", async () => {
      const boom = { code: "conflict" };
      const reportError = vi.fn();
      const { deps } = makeDeps({
        listBySeriesAndStatuses: vi.fn(async () => [
          makeOccurrence({ id: OCC_1_ID }),
        ]),
        assignSlug: vi.fn(async () => {
          throw boom;
        }),
        reportError,
      });

      const result = await generateEventsFromSeries(deps, baseInput());

      expect(result.generated).toHaveLength(1);
      expect(reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = reportError.mock.calls[0]!;
      expect(reported).toBe(boom);
      expect(context?.tags?.useCase).toBe("generateEventsFromSeries");
      expect(context?.tags?.stage).toBe("assign_slug_on_create");
    });
  });
});
