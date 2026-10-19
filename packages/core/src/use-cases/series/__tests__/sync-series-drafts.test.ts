import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";
import type {
  EventRecord,
  EventSeriesOccurrenceRecord,
  EventSeriesRecord,
} from "@th/types";

import { syncSeriesDrafts } from "../sync-series-drafts";
import type { SyncSeriesDraftsDeps } from "../sync-series-drafts";

// ── Fixtures ─────────────────────────────────────────────────────────────

const SERIES_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const PLACE_ID = "00000000-0000-4000-8000-000000000005";
const LAYOUT_ID = "00000000-0000-4000-8000-000000000006";
const TARGET_LAYOUT_ID = "00000000-0000-4000-8000-000000000007";

const SOURCE_EVENT_ID = "00000000-0000-4000-8000-000000000021";
const DRAFT_A_ID = "00000000-0000-4000-8000-000000000022";
const DRAFT_B_ID = "00000000-0000-4000-8000-000000000023";
const DRAFT_PAST_ID = "00000000-0000-4000-8000-000000000024";
const PUB_FUT_ID = "00000000-0000-4000-8000-000000000025";
const PUB_PAST_ID = "00000000-0000-4000-8000-000000000026";

const OCC_SOURCE = "00000000-0000-4000-8000-000000000011";
const OCC_FUT_A = "00000000-0000-4000-8000-000000000012";
const OCC_FUT_B = "00000000-0000-4000-8000-000000000013";
const OCC_PAST_GEN = "00000000-0000-4000-8000-000000000014";
const OCC_FUT_PUB = "00000000-0000-4000-8000-000000000015";
const OCC_PAST_PUB = "00000000-0000-4000-8000-000000000016";

const NOW = new Date("2026-04-01T12:00:00.000Z");
const PAST = new Date("2026-03-02T18:00:00.000Z");
const FUT_A = new Date("2026-04-13T18:00:00.000Z");
const FUT_B = new Date("2026-04-20T18:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

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
      titlePrefix: "Old Title",
      location: { kind: "none" },
      categories: ["music"],
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
    startsAt: FUT_A,
    endsAt: null,
    status: "GENERATED",
    eventId: null,
    overrides: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<EventRecord> & { id: string },
): EventRecord {
  return {
    orgId: null,
    humanId: ACTOR_ID,
    title: "Weekly Jam — a date",
    status: "DRAFT",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "UTC",
    startsAt: FUT_A,
    endsAt: null,
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    categorySeoType: null,
    addressText: null,
    lat: null,
    lng: null,
    content: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    placeLayoutId: null,
    defaultLocale: null,
    waitlistStatus: "DISABLED",
    currency: null,
    ...overrides,
  };
}

/** The edited pivot: place location + layout, body, EXACT visibility. */
function makeSourceEvent(overrides?: Partial<EventRecord>): EventRecord {
  return makeEvent({
    id: SOURCE_EVENT_ID,
    title: "New Title",
    status: "PUBLISHED",
    startsAt: new Date("2026-04-06T18:00:00.000Z"),
    placeId: PLACE_ID,
    placeLayoutId: LAYOUT_ID,
    content: { type: "doc", content: [] },
    defaultLocale: "en",
    locationLabel: "East Nashville",
    ...overrides,
  });
}

function defaultOccurrences(): EventSeriesOccurrenceRecord[] {
  return [
    makeOccurrence({
      id: OCC_SOURCE,
      ordinal: 1,
      status: "PUBLISHED",
      eventId: SOURCE_EVENT_ID,
      startsAt: new Date("2026-04-06T18:00:00.000Z"),
    }),
    makeOccurrence({
      id: OCC_PAST_PUB,
      ordinal: 2,
      status: "PUBLISHED",
      eventId: PUB_PAST_ID,
      startsAt: PAST,
    }),
    makeOccurrence({
      id: OCC_PAST_GEN,
      ordinal: 3,
      status: "GENERATED",
      eventId: DRAFT_PAST_ID,
      startsAt: PAST,
    }),
    makeOccurrence({
      id: OCC_FUT_A,
      ordinal: 4,
      status: "GENERATED",
      eventId: DRAFT_A_ID,
      startsAt: FUT_A,
    }),
    makeOccurrence({
      id: OCC_FUT_B,
      ordinal: 5,
      status: "GENERATED",
      eventId: DRAFT_B_ID,
      startsAt: FUT_B,
    }),
    makeOccurrence({
      id: OCC_FUT_PUB,
      ordinal: 6,
      status: "PUBLISHED",
      eventId: PUB_FUT_ID,
      startsAt: new Date("2026-04-27T18:00:00.000Z"),
    }),
  ];
}

function defaultEventsById(source?: EventRecord): Map<string, EventRecord> {
  return new Map<string, EventRecord>([
    [SOURCE_EVENT_ID, source ?? makeSourceEvent()],
    [DRAFT_A_ID, makeEvent({ id: DRAFT_A_ID, startsAt: FUT_A })],
    [
      DRAFT_B_ID,
      makeEvent({
        id: DRAFT_B_ID,
        startsAt: FUT_B,
        endsAt: new Date("2026-04-20T21:00:00.000Z"),
      }),
    ],
    [DRAFT_PAST_ID, makeEvent({ id: DRAFT_PAST_ID, startsAt: PAST })],
    [
      PUB_FUT_ID,
      makeEvent({ id: PUB_FUT_ID, status: "PUBLISHED", startsAt: FUT_B }),
    ],
    [
      PUB_PAST_ID,
      makeEvent({ id: PUB_PAST_ID, status: "PUBLISHED", startsAt: PAST }),
    ],
  ]);
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
  seriesUpdate?: AnyFn;
  listBySeriesAndStatuses?: AnyFn;
  eventsGetById?: AnyFn;
  upsertDraft?: AnyFn;
  placesGetById?: AnyFn;
  auditLog?: AnyFn;
};

function makeFakes(overrides?: FakeOverrides) {
  const eventsById = defaultEventsById();

  const fakes = {
    seriesGetById: overrides?.seriesGetById ?? vi.fn(async () => makeSeries()),
    seriesUpdate: overrides?.seriesUpdate ?? vi.fn(async () => makeSeries()),
    listBySeriesAndStatuses:
      overrides?.listBySeriesAndStatuses ??
      vi.fn(async () => defaultOccurrences()),
    eventsGetById:
      overrides?.eventsGetById ??
      vi.fn(async (id: string) => eventsById.get(id) ?? null),
    upsertDraft:
      overrides?.upsertDraft ??
      vi.fn(async (input: { eventId?: string | null }) => ({
        id: input.eventId,
      })),
    placesGetById:
      overrides?.placesGetById ??
      vi.fn(async () => ({
        id: PLACE_ID,
        status: "ACTIVE",
        orgIdsWithAccess: [],
        humanIdsWithAccess: [ACTOR_ID],
      })),
    auditLog: overrides?.auditLog ?? vi.fn(async () => undefined),
  };

  const tx = {
    series: { getById: fakes.seriesGetById, update: fakes.seriesUpdate },
    seriesOccurrences: {
      listBySeriesAndStatuses: fakes.listBySeriesAndStatuses,
    },
    events: {
      getById: fakes.eventsGetById,
      upsertDraft: fakes.upsertDraft,
    },
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
    // arrival-areas FR-014 (the sync's location hook) and FR-015 (the
    // draft's areas follow the source's): no areas or hides by default.
    arrivalAreas: {
      listForEvent: vi.fn(async () => []),
      setDisabledForEvent: vi.fn(async () => 0),
      deleteHidesForEventNotInPlace: vi.fn(async () => []),
      listHidesForEvent: vi.fn(async () => []),
    },
  };

  const repos = {
    tx: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as Repos;

  return { fakes, repos };
}

function makeDeps(overrides?: FakeOverrides): {
  deps: SyncSeriesDraftsDeps;
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
    seriesId: SERIES_ID,
    sourceEventId: SOURCE_EVENT_ID,
    scope: "future",
    clientKey: "sync-key-1",
    ...overrides,
  };
}

type UpsertCall = Record<string, unknown>;

function upsertCalls(fakes: ReturnType<typeof makeFakes>["fakes"]) {
  return (fakes.upsertDraft as ReturnType<typeof vi.fn>).mock
    .calls as unknown as [UpsertCall][];
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("syncSeriesDrafts", () => {
  it("scope future: updates only future GENERATED drafts with the exact field set, source excluded", async () => {
    // The default fixture's pivot occurrence is PUBLISHED — this doubles as
    // the explicit "a PUBLISHED sibling is a valid sync source" case.
    const { deps, fakes } = makeDeps();

    const result = await syncSeriesDrafts(deps, baseInput());

    expect(result).toEqual({
      updatedDraftCount: 2,
      skippedPublishedCount: 1, // future PUBLISHED only; past published + the source aren't counted
      skippedPastCount: 1, // the past GENERATED draft
    });

    const calls = upsertCalls(fakes);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[0].eventId)).toEqual([DRAFT_A_ID, DRAFT_B_ID]);

    // Exact synced payload for the first target: definition fields from the
    // SOURCE, schedule fields the TARGET's own, update-branch eventId.
    expect(calls[0]![0]).toEqual({
      eventId: DRAFT_A_ID,
      orgId: null,
      humanId: ACTOR_ID,
      startsAt: FUT_A, // target's own — never the source's
      endsAt: null,
      status: "DRAFT",
      title: "New Title",
      content: { type: "doc", content: [] },
      defaultLocale: "en",
      location: { kind: "place", placeId: PLACE_ID },
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: "East Nashville",
      addressRevealPreset: null, // EXACT ⇒ reveal fields nulled
      addressRevealAt: null,
      instructionalAdmission: false,
      resalePayoutReleaseDaysOverride: null,
    });

    // The second target keeps ITS schedule fields.
    expect(calls[1]![0]).toMatchObject({
      eventId: DRAFT_B_ID,
      startsAt: FUT_B,
      endsAt: new Date("2026-04-20T21:00:00.000Z"),
    });

    // Occurrence-owned / per-event-stateful keys are ABSENT (the adapter's
    // hasOwnProperty guards then leave the target's values untouched). The
    // SOURCE's placeLayoutId is never propagated (no seat materialization),
    // and these targets have no layout of their own to preserve.
    for (const [call] of calls) {
      expect(Object.keys(call)).not.toContain("timezone");
      expect(Object.keys(call)).not.toContain("heroImageId");
      expect(Object.keys(call)).not.toContain("ageLimit");
      expect(Object.keys(call)).not.toContain("createdAt");
      expect(Object.keys(call)).not.toContain("placeLayoutId");
    }

    expect(fakes.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_series",
        entityId: SERIES_ID,
        action: "drafts_synced",
        data: {
          sourceEventId: SOURCE_EVENT_ID,
          scope: "future",
          includeArrivalAreas: false,
          updatedDraftCount: 2,
          skippedPublishedCount: 1,
          skippedPastCount: 1,
        },
        at: NOW,
      }),
    );
  });

  it("scope all: past GENERATED drafts become targets and every published date is counted", async () => {
    const { deps, fakes } = makeDeps();

    const result = await syncSeriesDrafts(deps, baseInput({ scope: "all" }));

    expect(result).toEqual({
      updatedDraftCount: 3, // incl. the past GENERATED draft
      skippedPublishedCount: 2, // past + future published (source still excluded)
      skippedPastCount: 0,
    });

    const ids = upsertCalls(fakes).map((c) => c[0].eventId);
    expect(ids).toEqual([DRAFT_PAST_ID, DRAFT_A_ID, DRAFT_B_ID]);
  });

  it("preserves the TARGET's own layout (never the source's) when its place is unchanged", async () => {
    const eventsById = defaultEventsById();
    eventsById.set(
      DRAFT_A_ID,
      makeEvent({
        id: DRAFT_A_ID,
        startsAt: FUT_A,
        placeId: PLACE_ID, // same place as the source
        placeLayoutId: TARGET_LAYOUT_ID, // its own seated setup
      }),
    );
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    await syncSeriesDrafts(deps, baseInput());

    const calls = upsertCalls(fakes);
    // Same place ⇒ the target's OWN layout is re-sent so the adapter's
    // reset-then-reapply doesn't silently clear its seating link.
    expect(calls[0]![0]).toMatchObject({
      eventId: DRAFT_A_ID,
      placeLayoutId: TARGET_LAYOUT_ID,
    });
    // No layout of its own (DRAFT_B) ⇒ key absent; a layout from a CHANGED
    // place would likewise be left to clear (layouts are place-scoped).
    expect(Object.keys(calls[1]![0])).not.toContain("placeLayoutId");
  });

  it("skips a target that is no longer a DRAFT at write time (published out-of-band)", async () => {
    const eventsById = defaultEventsById();
    eventsById.set(
      DRAFT_B_ID,
      makeEvent({ id: DRAFT_B_ID, status: "PUBLISHED", startsAt: FUT_B }),
    );
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    const result = await syncSeriesDrafts(deps, baseInput());

    expect(result).toEqual({
      updatedDraftCount: 1,
      skippedPublishedCount: 2, // future published occurrence + the flipped target
      skippedPastCount: 1,
    });
    expect(upsertCalls(fakes).map((c) => c[0].eventId)).toEqual([DRAFT_A_ID]);
  });

  it("skips a target whose linked event row is gone (same counter, documented)", async () => {
    const eventsById = defaultEventsById();
    eventsById.delete(DRAFT_B_ID);
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    const result = await syncSeriesDrafts(deps, baseInput());

    expect(result.skippedPublishedCount).toBe(2);
    expect(result.updatedDraftCount).toBe(1);
    expect(upsertCalls(fakes).map((c) => c[0].eventId)).toEqual([DRAFT_A_ID]);
  });

  it("classifies targets by the EVENT's startsAt when it diverges from the occurrence", async () => {
    const eventsById = defaultEventsById();
    // Occurrence says past, but the draft was rescheduled to the future in
    // the builder ⇒ it IS a future target.
    eventsById.set(
      DRAFT_PAST_ID,
      makeEvent({ id: DRAFT_PAST_ID, startsAt: FUT_B }),
    );
    // Occurrence says future, but the draft was moved into the past ⇒
    // skippedPast under scope "future".
    eventsById.set(DRAFT_A_ID, makeEvent({ id: DRAFT_A_ID, startsAt: PAST }));
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    const result = await syncSeriesDrafts(deps, baseInput());

    expect(result).toEqual({
      updatedDraftCount: 2, // DRAFT_PAST (rescheduled future) + DRAFT_B
      skippedPublishedCount: 1,
      skippedPastCount: 1, // DRAFT_A (moved into the past)
    });
    expect(upsertCalls(fakes).map((c) => c[0].eventId)).toEqual([
      DRAFT_PAST_ID,
      DRAFT_B_ID,
    ]);
  });

  it("treats startsAt exactly at now as past (strict >)", async () => {
    const eventsById = defaultEventsById();
    eventsById.set(DRAFT_A_ID, makeEvent({ id: DRAFT_A_ID, startsAt: NOW }));
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    const result = await syncSeriesDrafts(deps, baseInput());

    expect(result).toEqual({
      updatedDraftCount: 1, // DRAFT_B only
      skippedPublishedCount: 1,
      skippedPastCount: 2, // DRAFT_PAST + the at-now DRAFT_A
    });
    expect(upsertCalls(fakes).map((c) => c[0].eventId)).toEqual([DRAFT_B_ID]);
  });

  it("recomputes the OBSCURED address reveal against each TARGET's startsAt", async () => {
    const eventsById = defaultEventsById(
      makeSourceEvent({
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date("2026-04-05T18:00:00.000Z"), // source-date-relative
      }),
    );
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    await syncSeriesDrafts(deps, baseInput());

    const calls = upsertCalls(fakes);
    expect(calls[0]![0]).toMatchObject({
      eventId: DRAFT_A_ID,
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: new Date(FUT_A.getTime() - DAY_MS), // target's date − 1d
    });
    expect(calls[1]![0]).toMatchObject({
      addressRevealAt: new Date(FUT_B.getTime() - DAY_MS),
    });
  });

  it("legacy OBSCURED source (no preset, stored reveal date) syncs as CUSTOM — never the target's own settings", async () => {
    const LEGACY_REVEAL = new Date("2026-04-03T18:00:00.000Z");
    const eventsById = defaultEventsById(
      makeSourceEvent({
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        addressRevealPreset: null, // legacy row
        addressRevealAt: LEGACY_REVEAL,
      }),
    );
    // Give a target its OWN divergent reveal settings that must NOT leak in.
    eventsById.set(
      DRAFT_A_ID,
      makeEvent({
        id: DRAFT_A_ID,
        startsAt: FUT_A,
        locationMode: "OBSCURED",
        addressRevealPreset: "WEEK_BEFORE",
        addressRevealAt: new Date(FUT_A.getTime() - 7 * DAY_MS),
      }),
    );
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    await syncSeriesDrafts(deps, baseInput());

    const calls = upsertCalls(fakes);
    expect(calls).toHaveLength(2);
    for (const [call] of calls) {
      expect(call).toMatchObject({
        addressRevealPreset: "CUSTOM",
        addressRevealAt: LEGACY_REVEAL, // the SOURCE's reveal, on every sibling
      });
    }
  });

  it("refreshes Series.defaults (title + location) preserving the other keys", async () => {
    const { deps, fakes } = makeDeps();

    await syncSeriesDrafts(deps, baseInput());

    expect(fakes.seriesUpdate).toHaveBeenCalledTimes(1);
    expect(fakes.seriesUpdate).toHaveBeenCalledWith(SERIES_ID, {
      defaults: expect.objectContaining({
        titlePrefix: "New Title",
        location: { kind: "place", placeId: PLACE_ID },
        categories: ["music"], // untouched
      }),
      updatedByHumanId: ACTOR_ID,
      updatedAt: NOW,
    });
  });

  it("clamps an over-120-char title before writing Series.defaults (drafts still get the full title)", async () => {
    const longTitle = "T".repeat(130); // valid event title (140 cap) but over the defaults cap (120)
    const eventsById = defaultEventsById(makeSourceEvent({ title: longTitle }));
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    await syncSeriesDrafts(deps, baseInput());

    // Sibling drafts carry the FULL title (event bound is 140)…
    expect(upsertCalls(fakes)[0]![0]).toMatchObject({ title: longTitle });
    // …while the stored defaults are clamped to the seriesDefaultsSchema
    // bound (plainTextRequired(120) THROWS on overflow at parse time — an
    // unclamped write would poison the JSON and break every later series
    // result-parse for this owner).
    const [, patch] = (fakes.seriesUpdate as ReturnType<typeof vi.fn>).mock
      .calls[0]! as [string, { defaults: { titlePrefix: string | null } }];
    expect(patch.defaults.titlePrefix).toBe("T".repeat(120));
  });

  it("keeps the PRIOR defaults location when the source's freeform address exceeds the defaults bound", async () => {
    const longAddress = "A".repeat(280); // valid on the event (280) but over the defaults cap (200)
    const eventsById = defaultEventsById(
      makeSourceEvent({
        placeId: null,
        placeLayoutId: null,
        addressText: longAddress,
        lat: 36.16,
        lng: -86.78,
      }),
    );
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    await syncSeriesDrafts(deps, baseInput());

    // Drafts still receive the full freeform location…
    expect(upsertCalls(fakes)[0]![0]).toMatchObject({
      location: expect.objectContaining({
        kind: "freeform",
        addressText: longAddress,
      }),
    });
    // …but the defaults keep the PRIOR location instead of a poisoning value.
    const [, patch] = (fakes.seriesUpdate as ReturnType<typeof vi.fn>).mock
      .calls[0]! as [
      string,
      { defaults: { titlePrefix: string | null; location: unknown } },
    ];
    expect(patch.defaults.location).toEqual({ kind: "none" });
    expect(patch.defaults.titlePrefix).toBe("New Title");
  });

  it("fails OCCURRENCE_NOT_FOUND when the source event is not attached to an active occurrence of this series", async () => {
    // Unattached / foreign-series source: THIS series' GENERATED/PUBLISHED
    // listing simply doesn't contain it.
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () =>
        defaultOccurrences().filter((occ) => occ.id !== OCC_SOURCE),
      ),
    });

    await expect(syncSeriesDrafts(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_NOT_FOUND",
    });
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
    expect(fakes.seriesUpdate).not.toHaveBeenCalled();
  });

  it("rejects a DETACHED occurrence's stale event as a sync source", async () => {
    // bulkDetach keeps eventId — the DETACHED row still points at the source
    // event, but the status-filtered listing (fake mirrors the adapter's
    // WHERE status IN (...)) excludes it, so the source guard fails.
    const detachedSource = makeOccurrence({
      id: OCC_SOURCE,
      ordinal: 1,
      status: "DETACHED",
      eventId: SOURCE_EVENT_ID,
      startsAt: new Date("2026-04-06T18:00:00.000Z"),
    });
    const rest = defaultOccurrences().filter((occ) => occ.id !== OCC_SOURCE);
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(
        async (_seriesId: string, statuses: string[]) =>
          [detachedSource, ...rest].filter((occ) =>
            statuses.includes(occ.status),
          ),
      ),
    });

    await expect(syncSeriesDrafts(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_NOT_FOUND",
    });
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
  });

  it("accepts a GENERATED occurrence's event as a sync source (draft pivot)", async () => {
    const occurrences = defaultOccurrences().map((occ) =>
      occ.id === OCC_SOURCE ? { ...occ, status: "GENERATED" as const } : occ,
    );
    const { deps, fakes } = makeDeps({
      listBySeriesAndStatuses: vi.fn(async () => occurrences),
    });

    const result = await syncSeriesDrafts(deps, baseInput());

    expect(result.updatedDraftCount).toBe(2);
    // The pivot itself is still excluded from targets.
    expect(upsertCalls(fakes).map((c) => c[0].eventId)).toEqual([
      DRAFT_A_ID,
      DRAFT_B_ID,
    ]);
  });

  it("fails EVENT_NOT_FOUND when the source event row is missing", async () => {
    const eventsById = defaultEventsById();
    eventsById.delete(SOURCE_EVENT_ID);
    const { deps } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
    });

    await expect(syncSeriesDrafts(deps, baseInput())).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
  });

  it("fails SERIES_INACTIVE for an archived series", async () => {
    const { deps } = makeDeps({
      seriesGetById: vi.fn(async () =>
        makeSeries({ active: false, archivedAt: new Date() }),
      ),
    });

    await expect(syncSeriesDrafts(deps, baseInput())).rejects.toMatchObject({
      code: "SERIES_INACTIVE",
    });
  });

  it("fails atomically on a mid-batch write failure (no commit, no defaults update)", async () => {
    const upsertDraft = vi
      .fn(async (input: { eventId?: string | null }) => ({ id: input.eventId }))
      .mockImplementationOnce(async (input: { eventId?: string | null }) => ({
        id: input.eventId,
      }))
      .mockImplementationOnce(async () => {
        throw new Error("db write failed");
      });
    const { deps, fakes } = makeDeps({ upsertDraft });

    await expect(syncSeriesDrafts(deps, baseInput())).rejects.toThrow();

    // The failure escapes the tx callback (rollback in production); the
    // idempotency record is marked failed and defaults were never written.
    expect(deps.idempotency.fail).toHaveBeenCalled();
    expect(deps.idempotency.commit).not.toHaveBeenCalled();
    expect(fakes.seriesUpdate).not.toHaveBeenCalled();
    expect(fakes.auditLog).not.toHaveBeenCalled();
  });

  it("denies an actor who is not the series owner", async () => {
    const { deps, fakes } = makeDeps();

    await expect(
      syncSeriesDrafts(
        deps,
        baseInput({ actorHumanId: "00000000-0000-4000-8000-000000000099" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
  });

  it("replays the stored response without re-executing", async () => {
    const { deps: firstDeps } = makeDeps();
    const first = await syncSeriesDrafts(firstDeps, baseInput());
    const committed = (firstDeps.idempotency.commit as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1];

    const { deps: replayDeps, fakes } = makeDeps();
    (replayDeps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      committed,
    );

    const replayed = await syncSeriesDrafts(replayDeps, baseInput());

    expect(replayed).toEqual(first);
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
    expect(fakes.seriesUpdate).not.toHaveBeenCalled();
    expect(replayDeps.idempotency.begin).not.toHaveBeenCalled();
  });

  it("throws IDEMPOTENCY_KEY_CONFLICT when the replayed payload hash differs", async () => {
    const { deps, fakes } = makeDeps();
    (deps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      payloadHash: "some-other-payload-hash",
      response: {
        updatedDraftCount: 0,
        skippedPublishedCount: 0,
        skippedPastCount: 0,
      },
    });

    await expect(syncSeriesDrafts(deps, baseInput())).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
  });

  it("fails atomically when the source's place is no longer accessible", async () => {
    const { deps, fakes } = makeDeps({
      placesGetById: vi.fn(async () => ({
        id: PLACE_ID,
        status: "ACTIVE",
        orgIdsWithAccess: [],
        humanIdsWithAccess: [], // owner lost access
      })),
    });

    await expect(syncSeriesDrafts(deps, baseInput())).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
    expect(fakes.upsertDraft).not.toHaveBeenCalled();
  });
});

describe("syncSeriesDrafts → arrival areas (FR-014)", () => {
  it.each([
    { includeArrivalAreas: false, label: "unticked (default)" },
    { includeArrivalAreas: true, label: "ticked" },
  ])("a sync that moves a sibling draft's place switches its event areas off and drops stale hides, audited — $label", async ({ includeArrivalAreas }) => {
    const OLD_PLACE_ID = "00000000-0000-4000-8000-000000000041";
    const AREA_ID = "00000000-0000-4000-8000-000000000042";
    const OLD_AREA_ID = "00000000-0000-4000-8000-000000000043";
    const eventsById = defaultEventsById();
    eventsById.set(
      DRAFT_A_ID,
      makeEvent({ id: DRAFT_A_ID, startsAt: FUT_A, placeId: OLD_PLACE_ID }),
    );
    const upsertDraft = vi.fn(async (input: { eventId?: string | null; startsAt: Date }) => ({
      ...eventsById.get(input.eventId as string),
      id: input.eventId,
      placeId: PLACE_ID,
      startsAt: input.startsAt,
    }));
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
      upsertDraft,
    });
    // The CAS token the FR-015 delete must carry.
    const AREA_UPDATED_AT = new Date("2026-10-01T00:00:00.000Z");
    const arrivalAreas = {
      listForEvent: vi.fn(async (eventId: string) =>
        eventId === DRAFT_A_ID
          ? [
              {
                id: AREA_ID,
                eventId,
                placeId: null,
                disabledAt: null,
                updatedAt: AREA_UPDATED_AT,
              },
            ]
          : [],
      ),
      setDisabledForEvent: vi.fn(async (eventId: string) => (eventId === DRAFT_A_ID ? 1 : 0)),
      deleteHidesForEventNotInPlace: vi.fn(async (eventId: string) =>
        eventId === DRAFT_A_ID ? [{ eventId, arrivalAreaId: OLD_AREA_ID }] : [],
      ),
      // FR-015: the source has no areas, so the sync then removes the
      // draft's (OVERWRITE, like its location).
      listHidesForEvent: vi.fn(async () => []),
      lockParent: vi.fn(async () => true),
      delete: vi.fn(async (id: string) => ({
        status: "deleted" as const,
        row: {
          id,
          eventId: DRAFT_A_ID,
          placeId: null,
          disabledAt: NOW,
          updatedAt: NOW,
        },
      })),
    };
    const originalTx = deps.repos.tx.bind(deps.repos);
    deps.repos.tx = (async <T>(fn: (t: never) => Promise<T>) =>
      originalTx(((t: Record<string, unknown>) =>
        fn({ ...t, arrivalAreas } as never)) as never)) as typeof deps.repos.tx;

    await syncSeriesDrafts(
      deps,
      includeArrivalAreas ? baseInput({ includeArrivalAreas }) : baseInput(),
    );

    // The FR-014 switch-off is a safety rule: it runs whether or not the
    // organiser asked to replace areas (owner Q13).
    expect(arrivalAreas.setDisabledForEvent).toHaveBeenCalledWith(DRAFT_A_ID, NOW);
    expect(arrivalAreas.deleteHidesForEventNotInPlace).toHaveBeenCalledWith(
      DRAFT_A_ID,
      PLACE_ID,
    );
    expect(fakes.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: DRAFT_A_ID,
        action: "arrival_areas.disabled_for_location_change",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          arrivalAreaIds: [AREA_ID],
          from: { placeId: OLD_PLACE_ID },
          to: { placeId: PLACE_ID },
        }),
      }),
    );
    expect(fakes.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "arrival_area_hides.removed_for_location_change",
        data: expect.objectContaining({ arrivalAreaIds: [OLD_AREA_ID] }),
      }),
    );
    // DRAFT_B stayed at its place: nothing switched off there.
    expect(arrivalAreas.setDisabledForEvent).not.toHaveBeenCalledWith(
      DRAFT_B_ID,
      expect.anything(),
    );
    if (!includeArrivalAreas) {
      // Unticked: the draft keeps its own (now switched-off) area.
      expect(arrivalAreas.lockParent).not.toHaveBeenCalled();
      expect(arrivalAreas.delete).not.toHaveBeenCalled();
      return;
    }
    // FR-015 ticked, after the hook: the switched-off area goes, audited.
    expect(arrivalAreas.delete).toHaveBeenCalledWith(AREA_ID, {
      expectedUpdatedAt: AREA_UPDATED_AT,
    });
    expect(fakes.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "arrival_area",
        entityId: AREA_ID,
        action: "arrival_area.removed",
        data: expect.objectContaining({ via: "series_sync", eventId: DRAFT_A_ID }),
      }),
    );
  });
});

describe("syncSeriesDrafts → arrival areas (FR-015)", () => {
  const SRC_LOT = "00000000-0000-4000-8000-000000000051";
  const SRC_LINE = "00000000-0000-4000-8000-000000000052";
  const A_OLD = "00000000-0000-4000-8000-000000000053";
  const HIDE_SRC = "00000000-0000-4000-8000-000000000054";
  const HIDE_A = "00000000-0000-4000-8000-000000000055";
  const AT = new Date("2026-03-01T00:00:00.000Z");

  type Row = {
    id: string;
    placeId: string | null;
    eventId: string | null;
    kind: "PARKING" | "ACCESSIBLE_DROP_OFF" | "LOAD_IN";
    geometry: unknown;
    label: string;
    cost: "FREE" | "PAID" | "UNKNOWN";
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
    geometry: { type: "Polygon", coordinates: [[[-86.7, 36.1], [-86.69, 36.1], [-86.69, 36.11], [-86.7, 36.1]]] },
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

  function setup(rows: Row[], hides: Array<{ eventId: string; arrivalAreaId: string }>) {
    const store = new Map(rows.map((r) => [r.id, { ...r }]));
    let n = 0;
    const arrivalAreas = {
      listForEvent: vi.fn(async (eventId: string) =>
        [...store.values()]
          .filter((r) => r.eventId === eventId)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((r) => ({ ...r })),
      ),
      setDisabledForEvent: vi.fn(async () => 0),
      deleteHidesForEventNotInPlace: vi.fn(async () => []),
      listHidesForEvent: vi.fn(async (eventId: string) =>
        hides.filter((h) => h.eventId === eventId).map((h) => h.arrivalAreaId),
      ),
      lockParent: vi.fn(async () => true),
      delete: vi.fn(async (id: string, opts: { expectedUpdatedAt: Date }) => {
        const r = store.get(id);
        if (!r) return { status: "not_found" as const };
        if (r.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()) {
          return { status: "conflict" as const, current: { ...r } };
        }
        store.delete(id);
        return { status: "deleted" as const, row: { ...r } };
      }),
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
      update: vi.fn(async (id: string, patch: Partial<Row>, opts: { expectedUpdatedAt: Date }) => {
        const r = store.get(id)!;
        if (r.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()) {
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
      unhide: vi.fn(async (eventId: string, arrivalAreaId: string) => {
        const i = hides.findIndex((h) => h.eventId === eventId && h.arrivalAreaId === arrivalAreaId);
        if (i < 0) return false;
        hides.splice(i, 1);
        return true;
      }),
    };

    // Every draft already sits at the source's place: the FR-014 hook is
    // quiet, and only FR-015's sync acts.
    const eventsById = defaultEventsById();
    for (const id of [DRAFT_A_ID, DRAFT_B_ID]) {
      eventsById.set(id, { ...eventsById.get(id)!, placeId: PLACE_ID });
    }
    const upsertDraft = vi.fn(async (input: { eventId?: string | null }) => ({
      ...eventsById.get(input.eventId as string),
      id: input.eventId,
      placeId: PLACE_ID,
    }));
    const { deps, fakes } = makeDeps({
      eventsGetById: vi.fn(async (id: string) => eventsById.get(id) ?? null),
      upsertDraft,
    });
    const originalTx = deps.repos.tx.bind(deps.repos);
    deps.repos.tx = (async <T>(fn: (t: never) => Promise<T>) =>
      originalTx(((t: Record<string, unknown>) =>
        fn({ ...t, arrivalAreas } as never)) as never)) as typeof deps.repos.tx;
    return { deps, fakes, arrivalAreas, store, hides };
  }

  it("a draft sibling's areas and hides become the source's: copies in order, a switched-off one stays off, audited", async () => {
    const OFF_AT = new Date("2026-03-02T00:00:00.000Z");
    const sourceRows = [
      row(SRC_LOT, SOURCE_EVENT_ID, { sortOrder: 0, label: "Main lot", cost: "PAID", priceText: "$5" }),
      row(SRC_LINE, SOURCE_EVENT_ID, {
        sortOrder: 1,
        kind: "LOAD_IN",
        geometry: { type: "LineString", coordinates: [[-86.7, 36.1], [-86.69, 36.1]] },
        disabledAt: OFF_AT,
      }),
    ];
    const hides = [
      { eventId: SOURCE_EVENT_ID, arrivalAreaId: HIDE_SRC },
      { eventId: DRAFT_A_ID, arrivalAreaId: HIDE_A },
    ];
    const { deps, fakes, arrivalAreas, store } = setup(
      [
        ...sourceRows,
        row(A_OLD, DRAFT_A_ID, { label: "Old lot" }),
        // DRAFT_B already matches the source.
        { ...sourceRows[0]!, id: "00000000-0000-4000-8000-000000000061", eventId: DRAFT_B_ID },
        { ...sourceRows[1]!, id: "00000000-0000-4000-8000-000000000062", eventId: DRAFT_B_ID },
      ],
      hides,
    );
    hides.push({ eventId: DRAFT_B_ID, arrivalAreaId: HIDE_SRC });

    await syncSeriesDrafts(deps, baseInput({ includeArrivalAreas: true }));

    const draftA = [...store.values()]
      .filter((r) => r.eventId === DRAFT_A_ID)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(store.has(A_OLD)).toBe(false);
    expect(draftA.map((r) => [r.label, r.kind, r.cost, r.priceText, r.sortOrder])).toEqual([
      ["Main lot", "PARKING", "PAID", "$5", 0],
      ["Lot 52", "LOAD_IN", "FREE", null, 1],
    ]);
    expect(draftA.map((r) => r.disabledAt)).toEqual([null, OFF_AT]);
    expect(draftA.every((r) => r.id !== SRC_LOT && r.id !== SRC_LINE)).toBe(true);
    // The source's own rows are untouched.
    expect(store.get(SRC_LOT)?.eventId).toBe(SOURCE_EVENT_ID);
    // Hides now mirror the source's.
    expect(hides.filter((h) => h.eventId === DRAFT_A_ID).map((h) => h.arrivalAreaId)).toEqual([
      HIDE_SRC,
    ]);
    // DRAFT_B already matched: never locked, nothing written.
    expect(arrivalAreas.lockParent).toHaveBeenCalledTimes(1);
    expect(arrivalAreas.lockParent).toHaveBeenCalledWith({ eventId: DRAFT_A_ID });

    const actions = (fakes.auditLog as ReturnType<typeof vi.fn>).mock.calls.map(
      ([e]) => e as { action: string; entityId: string; data: Record<string, unknown> },
    );
    const mine = actions.filter((e) => e.data?.via === "series_sync");
    expect(mine.map((e) => e.action)).toEqual([
      "arrival_area.removed",
      "arrival_area.created",
      "arrival_area.created",
      "arrival_area.hidden",
      "arrival_area.unhidden",
    ]);
    expect(mine[1]!.data).toMatchObject({
      actorHumanId: ACTOR_ID,
      sourceEventId: SOURCE_EVENT_ID,
      eventId: DRAFT_A_ID,
      sourceArrivalAreaId: SRC_LOT,
      before: null,
    });
  });

  it("published occurrences are never read or rewritten", async () => {
    const { deps, arrivalAreas } = setup(
      [row(SRC_LOT, SOURCE_EVENT_ID), row(A_OLD, PUB_FUT_ID)],
      [],
    );
    await syncSeriesDrafts(deps, baseInput({ scope: "all", includeArrivalAreas: true }));
    const touched = arrivalAreas.listForEvent.mock.calls.map(([id]) => id);
    expect(touched).not.toContain(PUB_FUT_ID);
    expect(touched).not.toContain(PUB_PAST_ID);
    expect(arrivalAreas.lockParent).not.toHaveBeenCalledWith({ eventId: PUB_FUT_ID });
  });

  it("a re-sync with nothing different writes nothing and takes no lock", async () => {
    const src = row(SRC_LOT, SOURCE_EVENT_ID);
    const { deps, arrivalAreas } = setup(
      [
        src,
        { ...src, id: "00000000-0000-4000-8000-000000000071", eventId: DRAFT_A_ID },
        { ...src, id: "00000000-0000-4000-8000-000000000072", eventId: DRAFT_B_ID },
      ],
      [],
    );
    await syncSeriesDrafts(deps, baseInput({ includeArrivalAreas: true }));
    expect(arrivalAreas.lockParent).not.toHaveBeenCalled();
    expect(arrivalAreas.create).not.toHaveBeenCalled();
    expect(arrivalAreas.delete).not.toHaveBeenCalled();
  });

  it.each([
    { name: "omitted", input: {} },
    { name: "false", input: { includeArrivalAreas: false } },
  ])("owner Q13: with includeArrivalAreas $name, a sibling draft's own areas and hides are left exactly as they are", async ({ input }) => {
    const hides = [
      { eventId: SOURCE_EVENT_ID, arrivalAreaId: HIDE_SRC },
      { eventId: DRAFT_A_ID, arrivalAreaId: HIDE_A },
    ];
    const { deps, fakes, arrivalAreas, store } = setup(
      [
        row(SRC_LOT, SOURCE_EVENT_ID, { label: "Main lot" }),
        row(A_OLD, DRAFT_A_ID, { label: "Old lot" }),
      ],
      hides,
    );

    const result = await syncSeriesDrafts(deps, baseInput(input));

    // The drafts' definition still synced.
    expect(result.updatedDraftCount).toBe(2);
    // Draft A keeps its own lot and its own hide; nothing was copied on.
    expect(store.get(A_OLD)).toMatchObject({ eventId: DRAFT_A_ID, label: "Old lot" });
    expect([...store.values()].filter((r) => r.eventId === DRAFT_A_ID)).toHaveLength(1);
    expect([...store.values()].filter((r) => r.eventId === DRAFT_B_ID)).toHaveLength(0);
    expect(hides.filter((h) => h.eventId === DRAFT_A_ID).map((h) => h.arrivalAreaId)).toEqual([
      HIDE_A,
    ]);
    expect(arrivalAreas.lockParent).not.toHaveBeenCalled();
    expect(arrivalAreas.create).not.toHaveBeenCalled();
    expect(arrivalAreas.delete).not.toHaveBeenCalled();
    expect(arrivalAreas.hide).not.toHaveBeenCalled();
    expect(arrivalAreas.unhide).not.toHaveBeenCalled();
    const audits = (fakes.auditLog as ReturnType<typeof vi.fn>).mock.calls.map(
      ([e]) => e as { action: string; data: Record<string, unknown> },
    );
    expect(audits.filter((e) => e.data?.via === "series_sync")).toEqual([]);
    expect(audits.find((e) => e.action === "drafts_synced")?.data).toMatchObject({
      includeArrivalAreas: false,
    });
  });

  it("owner Q13: the choice is part of the idempotency payload (same key, other choice → conflict)", async () => {
    const { deps } = setup([], []);
    const first = baseInput({ includeArrivalAreas: true });
    const commit = deps.idempotency.commit as ReturnType<typeof vi.fn>;
    await syncSeriesDrafts(deps, first);
    const stored = commit.mock.calls[0]![1];
    (deps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue(stored);
    await expect(syncSeriesDrafts(deps, baseInput())).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
    await expect(syncSeriesDrafts(deps, first)).resolves.toEqual(stored.response);
  });
});

