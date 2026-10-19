import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type {
  ArrivalAreaHidePair,
  ArrivalAreaRow,
  UpdateArrivalAreaPatch,
} from "@th/ports/repos/arrival-areas";
import type {
  MovePlaceOperationsResult,
  PlaceMergeCounts,
  PlaceMergeMoveCounts,
  PlaceMergeOperationsCounts,
  PlaceMergeRow,
  PlaceMergeSide,
  RepointPlaceRowsResult,
} from "@th/ports/repos/place-merge";
import { isAppError } from "@th/errors";

const { reindexSpy } = vi.hoisted(() => ({ reindexSpy: vi.fn() }));
vi.mock("../../search/reindex-after-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../search/reindex-after-mutation")>();
  return {
    ...actual,
    reindexAfterMutation: (...args: unknown[]) => reindexSpy(...args),
  };
});

import { offset, squareAt } from "../../arrival-areas/__tests__/arrival-area-world";
import { mergePlaces, PLACE_MERGE_BLOCKED } from "../merge-places";
import { previewPlaceMerge } from "../preview-place-merge";

// ─────────────────────────────────────────────────────────────────────────────
// mergePlaces / previewPlaceMerge (merge-duplicate-places spec FR-001..007).
// The repo is a fake: these tests pin the DECISIONS (auth, blockers, fill,
// ownership, page, reindex, audit). The SQL is pinned by the adapter's
// integration test (packages/adapters/test/integration/place-merge.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR = "11111111-1111-4111-8111-111111111111";
// Survivor sorts AFTER merged on purpose: lock order must follow id, not role.
const SURVIVOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MERGED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-10-13T12:00:00.000Z");
// Page image names in the shapes the server mints (request-page-image-upload:
// `<day>/<uuid>.<ext>`; strippedImageKey: `<day>/<32 hex>.<ext>`). The merge's
// key scan matches only these shapes.
const AVATAR_NAME = "0f1e2d3c-4b5a-4697-8877-665544332211.jpg";
const BLOCK_NAME = "9a8b7c6d5e4f30211203f4e5d6c7b8a9.png";
const DRAFT_NAME = "c0ffee00-1234-4abc-9def-0123456789ab.webp";
const OTHER_PLACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function row(id: string, overrides: Partial<PlaceMergeRow> = {}): PlaceMergeRow {
  return {
    id,
    name: id === SURVIVOR ? "Springwater Supper Club" : "Springwater",
    address: "115 27th Ave N, Nashville, TN",
    addrLine1: "115 27th Ave N",
    addrLine2: null,
    city: "Nashville",
    region: "TN",
    postcode: "37203",
    country: "US",
    addressHash: "hash",
    capacity: null,
    lat: 36.15,
    lng: -86.81,
    phone: null,
    website: null,
    websiteSource: "UNKNOWN",
    status: "ACTIVE",
    verification: "UNVERIFIED",
    timezone: "America/Chicago",
    admissionTaxRateBps: 925,
    taxRateSource: "ziptax",
    taxRateFetchedAt: new Date("2026-10-06T00:00:00.000Z"),
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    listedInDirectory: true,
    acceptsBookingRequests: false,
    acceptsCommunityListings: false,
    attendeeReviewsPublic: false,
    communityReviewsEnabled: true,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2026-10-06T00:00:00.000Z"),
    updatedAt: new Date("2026-10-06T00:00:00.000Z"),
    ...overrides,
  };
}

function side(
  id: string,
  overrides: Partial<PlaceMergeSide> & { place?: Partial<PlaceMergeRow> } = {},
): PlaceMergeSide {
  const { place, ...rest } = overrides;
  const tag = id === SURVIVOR ? "s" : "m";
  return {
    place: row(id, place),
    defaultCalendarId: `cal-${tag}`,
    mainSpaceId: `space-${tag}`,
    page: { id: `page-${tag}`, slug: id === SURVIVOR ? "springwater-supper-club" : "springwater" },
    ownerships: [],
    calendars: [
      {
        id: `cal-${tag}`,
        name: "Main Calendar",
        slug: "main",
        isDefault: true,
        primarySpaceId: `space-${tag}`,
      },
    ],
    spaces: [{ id: `space-${tag}`, name: "Main Space" }],
    layouts: [],
    ...rest,
  };
}

const noSample = () => ({ count: 0, ids: [] as string[] });
const noIntents = () => ({
  mergedPlace: [],
  mergedDefaultCalendar: [],
  survivorPlace: [],
  survivorDefaultCalendar: [],
});

function zeroOps(): PlaceMergeOperationsCounts {
  return {
    activeVerificationRequests: 0,
    collidingEmbeds: 0,
    communityEvents: 0,
    holdLineConflicts: noSample(),
    holdSameNight: noSample(),
    openRequestConflicts: noSample(),
    activeWaivers: { survivor: 0, merged: 0 },
    availabilityOverlaps: noSample(),
    placeWideAvailability: 0,
    activeGrants: noSample(),
    wholePlaceGrants: noSample(),
    survivorControl: { openBookingRequests: 0, liveAgreements: 0 },
    standards: { items: noIntents(), examples: noIntents() },
  };
}

function moves(overrides: Partial<PlaceMergeMoveCounts> = {}): PlaceMergeMoveCounts {
  return {
    events: 2,
    venueConfirmedEvents: 1,
    eventsOnDefaultCalendar: 1,
    eventsOnMainSpace: 1,
    attendeeReviews: 0,
    postEventPrompts: 0,
    membershipBenefits: 0,
    savedLocations: 0,
    placeReviews: 0,
    placeReviewSessions: 0,
    placeReviewSessionsDropped: 0,
    volunteerAsks: 0,
    entityReports: 0,
    entityReportsDropped: 0,
    featuredItems: 0,
    featuredItemsDropped: 0,
    embeds: 0,
    verificationRequests: 0,
    follows: 3,
    followsDropped: 1,
    eventNotices: 0,
    eventNoticesDropped: 0,
    pageSlugHistory: 1,
    bookingRequests: 0,
    agreements: 0,
    bookingGrants: 0,
    waivers: 0,
    posReaders: 0,
    layouts: 0,
    calendarAvailability: 0,
    bookingHolds: 0,
    series: 0,
    templates: 0,
    occurrences: 0,
    imageModerationRecords: 0,
    ...overrides,
  };
}

function emptyOperationsResult(): MovePlaceOperationsResult {
  return {
    bookingHolds: [],
    bookingHoldsCalendarRepointed: [],
    bookingHoldsSpaceRepointed: [],
    bookingRequests: [],
    bookingRequestsCalendarRepointed: [],
    bookingRequestsSpaceRepointed: [],
    agreements: [],
    bookingGrants: [],
    bookingGrantsCalendarRepointed: [],
    bookingGrantsRevoked: [],
    bookingGrantsSplit: [],
    waivers: [],
    waiverStates: [],
    waiversDeactivated: [],
    posReaders: [],
    layouts: [],
    calendarAvailability: [],
    calendarAvailabilityCalendarRepointed: [],
    bookingStandardItems: [],
    bookingStandardItemsDropped: [],
    bookingPitchExamples: [],
    bookingPitchExamplesDropped: [],
    calendarsReparented: [],
    spacesReparented: [],
    calendarSpaceJoinsCreated: [],
    calendarSpaceJoinsDeleted: [],
    primarySpaceRepointedCalendars: [],
    eventsOnReparentedCalendars: [],
    series: [],
    templates: [],
    occurrences: [],
    deletedCalendar: { id: "cal-m" },
    deletedSpace: { id: "space-m" },
  };
}

function emptyRepointResult(): RepointPlaceRowsResult {
  return {
    events: [],
    venueConfirmedEvents: [],
    eventsCalendarRepointed: [],
    eventsSpaceRepointed: [],
    attendeeReviews: [],
    postEventPrompts: [],
    membershipBenefits: [],
    savedLocations: [],
    placeReviews: [],
    placeReviewSessions: [],
    placeReviewSessionsDropped: [],
    volunteerAsks: [],
    entityReports: [],
    entityReportsDropped: [],
    featuredItems: [],
    featuredItemsDropped: [],
    embeds: [],
    ownerships: [],
    ownershipsDropped: [],
    verificationRequests: [],
    imageModerationRecords: [],
    droppedRows: { placeReviewSessions: [], entityReports: [], featuredItems: [], ownerships: [] },
  };
}

type Setup = {
  survivor?: PlaceMergeSide | null;
  merged?: PlaceMergeSide | null;
  ops?: Partial<PlaceMergeOperationsCounts>;
  moves?: Partial<PlaceMergeMoveCounts>;
  repointed?: Partial<RepointPlaceRowsResult>;
  operations?: Partial<MovePlaceOperationsResult>;
  /** listFoldLineKeys answers, in call order (the last repeats). */
  lineKeys?: { calendarId: string; date: string }[][];
  allowed?: boolean;
  /** arrival-areas FR-012: area rows (place and event-only), and hides. */
  areas?: ArrivalAreaRow[];
  hides?: ArrivalAreaHidePair[];
  /** Area ids whose compare-and-set update loses (a concurrent writer). */
  areaConflicts?: string[];
};

function harness(setup: Setup = {}) {
  const survivor = setup.survivor === undefined ? side(SURVIVOR) : setup.survivor;
  const merged = setup.merged === undefined ? side(MERGED) : setup.merged;
  const counts: PlaceMergeCounts = {
    operations: { ...zeroOps(), ...setup.ops },
    moves: moves(setup.moves),
  };
  const calls: string[] = [];
  let lineKeyCalls = 0;
  const track =
    <T,>(name: string, impl: (...a: any[]) => T) =>
    vi.fn((...a: any[]) => {
      calls.push(name);
      return impl(...a);
    });

  const placeMerge = {
    lockForMerge: track("placeMerge.lockForMerge", async () => undefined),
    listFoldLineKeys: track("placeMerge.listFoldLineKeys", async () => {
      const answers = setup.lineKeys ?? [[]];
      const i = Math.min(lineKeyCalls++, answers.length - 1);
      return answers[i]!;
    }),
    getSide: track("placeMerge.getSide", async (id: string) =>
      id === SURVIVOR ? survivor : id === MERGED ? merged : null,
    ),
    count: track("placeMerge.count", async () => counts),
    fillFields: track("placeMerge.fillFields", async () => undefined),
    repointPlaceRows: track("placeMerge.repointPlaceRows", async () => ({
      ...emptyRepointResult(),
      events: ["ev-1", "ev-2"],
      // Only events still AT the merged place carry their stamp across.
      venueConfirmedEvents: ["ev-1"],
      eventsCalendarRepointed: ["ev-1"],
      eventsSpaceRepointed: ["ev-1"],
      ...setup.repointed,
    })),
    moveOperations: track("placeMerge.moveOperations", async () => ({
      ...emptyOperationsResult(),
      ...setup.operations,
    })),
    repointPageRows: track("placeMerge.repointPageRows", async () => ({
      follows: ["f-1", "f-2"],
      followsDropped: ["f-3"],
      eventNotices: [],
      eventNoticesDropped: [],
      pageSlugHistory: ["h-1"],
      droppedRows: {
        follows: [{ id: "f-3", followerHumanId: "h-x" }],
        eventNotices: [],
      },
    })),
    transferPage: track("placeMerge.transferPage", async () => undefined),
    deletePage: track("placeMerge.deletePage", async () => undefined),
    markPlaceStatsStale: track("placeMerge.markPlaceStatsStale", async () => undefined),
    deleteDerivedRows: track("placeMerge.deleteDerivedRows", async () => undefined),
    deletePlace: track("placeMerge.deletePlace", async () => undefined),
  };
  const events = {
    lockLocationsAtPlace: track("events.lockLocationsAtPlace", async () => undefined),
    reprojectLocationForPlace: track(
      "events.reprojectLocationForPlace",
      async () => ["ev-1", "ev-2", "ev-survivor"],
    ),
  };
  const places = {
    getById: track("places.getById", async (id: string) => ({
      id,
      name: "Springwater Supper Club",
      formattedAddress: "115 27th Ave N, Nashville, TN",
      city: "Nashville",
      region: "TN",
      postalCode: "37203",
      countryCode: "US",
      lat: 36.15,
      lng: -86.81,
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: null,
    })),
  };
  const mergedPrefix = `entity-pages/place/${MERGED}/`;
  const entityPages = {
    recordSlugHistory: track("entityPages.recordSlugHistory", async () => undefined),
    getById: vi.fn(async (id: string) => ({
      id,
      avatarUrl: `https://cdn.example/${mergedPrefix}2026-10-06/${AVATAR_NAME}`,
      // Another entity's object: never enqueued.
      bannerUrl: `https://cdn.example/entity-pages/place/${OTHER_PLACE}/2026-10-06/${BLOCK_NAME}`,
    })),
    getTheme: vi.fn(async () => null),
    listBlocks: vi.fn(async () => [
      { data: { html: `<img src="https://cdn.example/${mergedPrefix}2026-10-06/${BLOCK_NAME}">` } },
    ]),
    getDraft: vi.fn(async () => ({
      data: { "page.bannerUrl": `https://cdn.example/${mergedPrefix}2026-10-07/${DRAFT_NAME}` },
      placePatch: {},
    })),
  };
  const pendingObjectDeletions = {
    enqueueMany: track("pendingObjectDeletions.enqueueMany", async () => undefined),
  };
  const audit = { log: track("audit.log", async () => undefined) };
  const bookingHolds = {
    lockLine: track("bookingHolds.lockLine", async () => undefined),
  };
  const searchReindexPending = {
    mark: track("searchReindexPending.mark", async () => undefined),
  };
  // arrival-areas FR-012: a small in-memory area store.
  const areaStore = new Map(
    (setup.areas ?? []).map((row) => [row.id, { ...row }] as const),
  );
  const hides = [...(setup.hides ?? [])];
  const bySort = (a: ArrivalAreaRow, b: ArrivalAreaRow) =>
    a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();
  const areasOf = (placeId: string) =>
    [...areaStore.values()].filter((row) => row.placeId === placeId).sort(bySort);
  const arrivalAreas = {
    listForPlaces: track("arrivalAreas.listForPlaces", async (ids: string[]) =>
      ids.flatMap((id) => areasOf(id)).map((row) => ({ ...row })),
    ),
    listForPlace: vi.fn(async (id: string) => areasOf(id).map((row) => ({ ...row }))),
    // The events at the merged place are the ones repointPlaceRows returns;
    // after the repoint they sit at the survivor, beside its own
    // "ev-survivor" (which the merge must leave alone).
    listEventAreasAtPlace: track(
      "arrivalAreas.listEventAreasAtPlace",
      async (placeId: string) => {
        if (placeId !== MERGED && placeId !== SURVIVOR) return [];
        const repointedEvents = setup.repointed?.events ?? ["ev-1", "ev-2"];
        const atPlace = new Set(
          placeId === MERGED ? repointedEvents : [...repointedEvents, "ev-survivor"],
        );
        return [...areaStore.values()]
          .filter((row) => row.eventId !== null && atPlace.has(row.eventId))
          .sort((a, b) => (a.eventId ?? "").localeCompare(b.eventId ?? "") || bySort(a, b))
          .map((row) => ({ ...row }));
      },
    ),
    // The post-repoint read: exactly the given events' own areas.
    listForEvents: track(
      "arrivalAreas.listForEvents",
      async (eventIds: readonly string[]) => {
        const asked = new Set(eventIds);
        return [...areaStore.values()]
          .filter((row) => row.eventId !== null && asked.has(row.eventId))
          .sort((a, b) => (a.eventId ?? "").localeCompare(b.eventId ?? "") || bySort(a, b))
          .map((row) => ({ ...row }));
      },
    ),
    listForEvent: vi.fn(async (eventId: string) =>
      [...areaStore.values()]
        .filter((row) => row.eventId === eventId)
        .sort(bySort)
        .map((row) => ({ ...row })),
    ),
    movePlaceAreas: track(
      "arrivalAreas.movePlaceAreas",
      async (fromId: string, toId: string) => {
        const base = areasOf(toId).length;
        const moving = areasOf(fromId);
        moving.forEach((row, i) => {
          areaStore.set(row.id, {
            ...row,
            placeId: toId,
            sortOrder: base + i,
            updatedAt: new Date(row.updatedAt.getTime() + 1),
          });
        });
        return moving.map((row) => row.id);
      },
    ),
    update: track(
      "arrivalAreas.update",
      async (id: string, patch: UpdateArrivalAreaPatch, opts: { expectedUpdatedAt: Date }) => {
        const row = areaStore.get(id);
        if (!row) return { status: "not_found" as const };
        if (
          setup.areaConflicts?.includes(id) ||
          row.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()
        ) {
          return { status: "conflict" as const, current: { ...row } };
        }
        const next = { ...row, ...patch, updatedAt: new Date(row.updatedAt.getTime() + 1) };
        areaStore.set(id, next as ArrivalAreaRow);
        return { status: "updated" as const, row: { ...(next as ArrivalAreaRow) } };
      },
    ),
    deleteHidesForEventsNotInPlace: track(
      "arrivalAreas.deleteHidesForEventsNotInPlace",
      async (eventIds: string[], placeId: string) => {
        const scope = new Set(eventIds);
        const removed = hides.filter(
          (h) => scope.has(h.eventId) && areaStore.get(h.arrivalAreaId)?.placeId !== placeId,
        );
        for (const r of removed) hides.splice(hides.indexOf(r), 1);
        return removed;
      },
    ),
    deleteHidesForEventNotInPlace: track(
      "arrivalAreas.deleteHidesForEventNotInPlace",
      async (eventId: string, placeId: string | null) => {
        const removed = hides.filter(
          (h) =>
            h.eventId === eventId &&
            (placeId === null || areaStore.get(h.arrivalAreaId)?.placeId !== placeId),
        );
        for (const r of removed) hides.splice(hides.indexOf(r), 1);
        return removed;
      },
    ),
  };

  const txRepos = {
    bookingHolds,
    placeMerge,
    events,
    places,
    entityPages,
    pendingObjectDeletions,
    audit,
    searchReindexPending,
    arrivalAreas,
  };
  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;
  const authz = {
    hasStaffRole: vi.fn(async () => ({ allowed: setup.allowed ?? true })),
  };
  const deps = {
    repos,
    authz: authz as never,
    clock: { now: () => NOW } as never,
  };
  return {
    deps,
    placeMerge,
    bookingHolds,
    events,
    entityPages,
    pendingObjectDeletions,
    audit,
    searchReindexPending,
    authz,
    calls,
    arrivalAreas,
    areaStore,
    hides,
    places,
  };
}

const input = { actorHumanId: ACTOR, survivorId: SURVIVOR, mergedId: MERGED };

const WRITE_CALLS = [
  "placeMerge.fillFields",
  "placeMerge.repointPlaceRows",
  "placeMerge.moveOperations",
  "placeMerge.repointPageRows",
  "placeMerge.transferPage",
  "placeMerge.deletePage",
  "placeMerge.markPlaceStatsStale",
  "placeMerge.deleteDerivedRows",
  "placeMerge.deletePlace",
  "events.reprojectLocationForPlace",
  "entityPages.recordSlugHistory",
  "pendingObjectDeletions.enqueueMany",
  "audit.log",
  "searchReindexPending.mark",
  "arrivalAreas.movePlaceAreas",
  "arrivalAreas.update",
  "arrivalAreas.deleteHidesForEventNotInPlace",
  "arrivalAreas.deleteHidesForEventsNotInPlace",
];

async function expectBlocked(
  h: ReturnType<typeof harness>,
  code: string,
  count?: number,
) {
  const err = await mergePlaces(h.deps, input).catch((e: unknown) => e);
  expect(isAppError(err)).toBe(true);
  const appErr = err as { code: string; meta?: { reason?: string; blockers?: { code: string; count: number }[] } };
  expect(appErr.code).toBe("CONFLICT");
  expect(appErr.meta?.reason).toBe(PLACE_MERGE_BLOCKED);
  const blocker = appErr.meta?.blockers?.find((b) => b.code === code);
  expect(blocker).toBeDefined();
  if (count !== undefined) expect(blocker?.count).toBe(count);
  // Nothing written: the refusal happens before the first write.
  expect(h.calls.filter((c) => WRITE_CALLS.includes(c))).toEqual([]);
  expect(reindexSpy).not.toHaveBeenCalled();
}

beforeEach(() => {
  reindexSpy.mockReset();
});

describe("auth and input", () => {
  it("refuses a non-ADMIN with STAFF_ONLY and reads nothing", async () => {
    const h = harness({ allowed: false });
    await expect(mergePlaces(h.deps, input)).rejects.toMatchObject({
      code: "STAFF_ONLY",
    });
    await expect(previewPlaceMerge(h.deps, input)).rejects.toMatchObject({
      code: "STAFF_ONLY",
    });
    expect(h.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN"],
    });
    expect(h.calls).toEqual([]);
  });

  it("refuses merging a place into itself", async () => {
    const h = harness();
    await expect(
      mergePlaces(h.deps, { ...input, mergedId: SURVIVOR }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      previewPlaceMerge(h.deps, { ...input, mergedId: SURVIVOR }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.calls).toEqual([]);
  });

  it("rejects unknown keys and non-uuid ids", async () => {
    const h = harness();
    await expect(
      mergePlaces(h.deps, { ...input, extra: 1 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      mergePlaces(h.deps, { ...input, survivorId: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses with PLACE_NOT_FOUND when either row is missing, writing nothing", async () => {
    const h = harness({ merged: null });
    await expect(mergePlaces(h.deps, input)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
    expect(h.calls.filter((c) => WRITE_CALLS.includes(c))).toEqual([]);
  });
});

describe("locks (FR-001)", () => {
  it("takes the location locks and the row locks in id order before reading", async () => {
    const h = harness();
    await mergePlaces(h.deps, input);
    expect(h.events.lockLocationsAtPlace.mock.calls).toEqual([
      [{ placeId: MERGED, mode: "exclusive" }],
      [{ placeId: SURVIVOR, mode: "exclusive" }],
    ]);
    expect(h.placeMerge.lockForMerge).toHaveBeenCalledWith({
      placeIds: [MERGED, SURVIVOR],
      lineKeys: [],
    });
    const firstRead = h.calls.indexOf("placeMerge.getSide");
    expect(h.calls.indexOf("events.lockLocationsAtPlace")).toBeLessThan(firstRead);
    expect(h.calls.indexOf("placeMerge.lockForMerge")).toBeLessThan(firstRead);
  });
});

describe("blockers (FR-006, D6) — refused, named, nothing written", () => {
  it("booking and operations data no longer blocks (owner ruling 2026-10-15)", async () => {
    const h = harness({
      moves: {
        bookingRequests: 2,
        agreements: 1,
        bookingGrants: 1,
        waivers: 1,
        posReaders: 1,
        layouts: 1,
        calendarAvailability: 4,
        bookingHolds: 3,
        series: 1,
        templates: 1,
        occurrences: 1,
      },
      ops: { placeWideAvailability: 0 },
    });
    const preview = await previewPlaceMerge(h.deps, input);
    expect(preview.blockers).toEqual([]);
    expect(preview.canMerge).toBe(true);
    expect(preview.moves).toMatchObject({
      bookingRequests: 2,
      agreements: 1,
      bookingGrants: 1,
      waivers: 1,
      posReaders: 1,
      layouts: 1,
      calendarAvailability: 4,
      bookingHolds: 3,
      series: 1,
      templates: 1,
      occurrences: 1,
      defaultCalendarFolded: 1,
    });
  });

  it("the obsolete booking codes are gone from the code list", async () => {
    const { PLACE_MERGE_BLOCKER_CODES } = await import("../_shared/place-merge-plan");
    for (const gone of [
      "HAS_BOOKING_REQUESTS",
      "HAS_AGREEMENTS",
      "HAS_BOOKING_GRANTS",
      "HAS_WAIVERS",
      "HAS_POS_READERS",
      "HAS_LAYOUTS",
      "HAS_EXTRA_SPACES",
      "HAS_EXTRA_CALENDARS",
      "HAS_CALENDAR_AVAILABILITY",
      "HAS_BOOKING_HOLDS",
      "HAS_EVENTS_ON_OTHER_CALENDARS_OR_SPACES",
      "HAS_BOOKING_STANDARDS",
      "HAS_BOOKING_PITCH_EXAMPLES",
      "HAS_DEFAULT_PAYOUT_TERMS",
      "HAS_SERIES_OR_TEMPLATES",
      "SURVIVOR_LACKS_DEFAULT_CALENDAR",
    ]) {
      expect(PLACE_MERGE_BLOCKER_CODES as readonly string[]).not.toContain(gone);
    }
  });

  it.each([
    ["activeVerificationRequests", "HAS_ACTIVE_VERIFICATION_REQUEST"],
    ["collidingEmbeds", "EMBED_COLLISION"],
  ] as const)("%s > 0 → %s", async (field, code) => {
    await expectBlocked(harness({ ops: { [field]: 3 } }), code, 3);
  });

  it("a held night on both default calendars → BOOKING_HOLDS_OVERLAP naming the merged holds", async () => {
    const ops = { holdLineConflicts: { count: 2, ids: ["hold-1", "hold-2"] } };
    await expectBlocked(harness({ ops }), "BOOKING_HOLDS_OVERLAP", 2);
    const preview = await previewPlaceMerge(harness({ ops }).deps, input);
    expect(preview.blockers).toEqual([
      { code: "BOOKING_HOLDS_OVERLAP", count: 2, ids: ["hold-1", "hold-2"] },
    ]);
  });

  it("an open request from the same party on both → BOOKING_REQUESTS_OPEN_DUPLICATE", async () => {
    await expectBlocked(
      harness({ ops: { openRequestConflicts: { count: 1, ids: ["br-1"] } } }),
      "BOOKING_REQUESTS_OPEN_DUPLICATE",
      1,
    );
  });

  it("an active waiver on both: the survivor's stays, the merged ones move inactive (warning, no blocker)", async () => {
    const ops = { activeWaivers: { survivor: 1, merged: 2 } };
    const preview = await previewPlaceMerge(harness({ ops }).deps, input);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toEqual([{ code: "WAIVERS_DEACTIVATED", count: 2 }]);
    const h = harness({ ops });
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.moveOperations).toHaveBeenCalledWith(
      expect.objectContaining({ deactivateMergedWaivers: true }),
    );
  });

  it("an active waiver on the merged side only stays active (warning)", async () => {
    const ops = { activeWaivers: { survivor: 0, merged: 1 } };
    const preview = await previewPlaceMerge(harness({ ops }).deps, input);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toEqual([{ code: "WAIVER_BECOMES_ACTIVE", count: 1 }]);
    const h = harness({ ops });
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.moveOperations).toHaveBeenCalledWith(
      expect.objectContaining({ deactivateMergedWaivers: false }),
    );
  });

  it("two different default deals of the same kind → DEFAULT_PAYOUT_TERMS_CONFLICT", async () => {
    await expectBlocked(
      harness({
        survivor: side(SURVIVOR, {
          place: { defaultPrimaryPayoutTermsId: "pt-s", defaultResalePayoutTermsId: "pt-r" },
        }),
        merged: side(MERGED, {
          place: { defaultPrimaryPayoutTermsId: "pt-m", defaultResalePayoutTermsId: "pt-r" },
        }),
      }),
      "DEFAULT_PAYOUT_TERMS_CONFLICT",
      1,
    );
  });

  it("the merged default deal fills a survivor that has none; the same deal on both is fine", async () => {
    const h = harness({
      merged: side(MERGED, {
        place: { defaultPrimaryPayoutTermsId: "pt-m", defaultResalePayoutTermsId: "pt-r" },
      }),
      survivor: side(SURVIVOR, { place: { defaultResalePayoutTermsId: "pt-r" } }),
    });
    const out = await mergePlaces(h.deps, input);
    expect(h.placeMerge.fillFields).toHaveBeenCalledWith(SURVIVOR, {
      defaultPrimaryPayoutTermsId: "pt-m",
    });
    expect(out.filledFields).toEqual(["defaultPrimaryPayoutTermsId"]);
    const entry = h.audit.log.mock.calls[0]![0] as { data: Record<string, any> };
    expect(entry.data.operations.payoutTerms).toEqual({
      survivorBefore: {
        defaultPrimaryPayoutTermsId: null,
        defaultResalePayoutTermsId: "pt-r",
      },
      merged: { defaultPrimaryPayoutTermsId: "pt-m", defaultResalePayoutTermsId: "pt-r" },
      filled: ["defaultPrimaryPayoutTermsId"],
      carried: true,
    });
  });

  it("merged verification above the survivor's → VERIFICATION_ABOVE_SURVIVOR", async () => {
    await expectBlocked(
      harness({ merged: side(MERGED, { place: { verification: "VERIFIED" } }) }),
      "VERIFICATION_ABOVE_SURVIVOR",
    );
    // Equal or lower is fine.
    const ok = await previewPlaceMerge(
      harness({
        survivor: side(SURVIVOR, { place: { verification: "VERIFIED" } }),
        merged: side(MERGED, { place: { verification: "VERIFIED" } }),
      }).deps,
      input,
    );
    expect(ok.blockers).toEqual([]);
  });

  it("a different location mode → LOCATION_PRIVACY_DIFFERS (D6)", async () => {
    await expectBlocked(
      harness({
        survivor: side(SURVIVOR, { place: { locationMode: "EXACT" } }),
        merged: side(MERGED, {
          place: { locationMode: "OBSCURED", locationRadiusMeters: null },
        }),
      }),
      "LOCATION_PRIVACY_DIFFERS",
    );
  });

  it("the same mode with a different radius → LOCATION_PRIVACY_DIFFERS (D6)", async () => {
    await expectBlocked(
      harness({
        survivor: side(SURVIVOR, {
          place: { locationMode: "OBSCURED", locationRadiusMeters: 500 },
        }),
        merged: side(MERGED, {
          place: { locationMode: "OBSCURED", locationRadiusMeters: null },
        }),
      }),
      "LOCATION_PRIVACY_DIFFERS",
    );
  });

  it("an owner the survivor does not have, while the survivor has one → OWNER_CONFLICT", async () => {
    await expectBlocked(
      harness({
        survivor: side(SURVIVOR, {
          ownerships: [
            { id: "o-s", ownerType: "ORGANIZATION", ownerId: "org-a", verified: true, revoked: false },
          ],
        }),
        merged: side(MERGED, {
          ownerships: [
            { id: "o-m", ownerType: "ORGANIZATION", ownerId: "org-b", verified: false, revoked: false },
          ],
        }),
      }),
      "OWNER_CONFLICT",
      1,
    );
  });
});

describe("ownership (FR-006 move rules)", () => {
  it("moves the merged owner when the survivor has none, dropping nothing", async () => {
    const h = harness({
      merged: side(MERGED, {
        ownerships: [
          { id: "o-m", ownerType: "HUMAN", ownerId: "h-1", verified: true, revoked: false },
        ],
      }),
    });
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.repointPlaceRows).toHaveBeenCalledWith(
      expect.objectContaining({ dropOwnershipIds: [] }),
    );
  });

  it("the same owner on both: keeps the survivor's row, drops the merged one", async () => {
    const h = harness({
      survivor: side(SURVIVOR, {
        ownerships: [
          { id: "o-s", ownerType: "ORGANIZATION", ownerId: "org-a", verified: true, revoked: false },
        ],
      }),
      merged: side(MERGED, {
        ownerships: [
          { id: "o-m", ownerType: "ORGANIZATION", ownerId: "org-a", verified: true, revoked: false },
          { id: "o-m-old", ownerType: "HUMAN", ownerId: "h-gone", verified: false, revoked: true },
        ],
      }),
    });
    const preview = await previewPlaceMerge(h.deps, input);
    expect(preview.blockers).toEqual([]);
    expect(preview.moves.ownerships).toBe(1);
    expect(preview.moves.ownershipsDropped).toBe(1);
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.repointPlaceRows).toHaveBeenCalledWith(
      expect.objectContaining({ dropOwnershipIds: ["o-m"] }),
    );
  });

  it("pairs each dropped ownership with the kept row of the same owner", async () => {
    const h = harness({
      survivor: side(SURVIVOR, {
        ownerships: [
          { id: "o-s", ownerType: "ORGANIZATION", ownerId: "org-a", verified: true, revoked: false },
          { id: "o-s2", ownerType: "HUMAN", ownerId: "h-1", verified: false, revoked: false },
        ],
      }),
      merged: side(MERGED, {
        ownerships: [
          { id: "o-m", ownerType: "ORGANIZATION", ownerId: "org-a", verified: true, revoked: false },
          { id: "o-m2", ownerType: "HUMAN", ownerId: "h-1", verified: true, revoked: false },
        ],
      }),
    });
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.repointPlaceRows).toHaveBeenCalledWith(
      expect.objectContaining({
        dropOwnershipIds: ["o-m", "o-s2"],
        repointOwnershipIds: [
          { from: "o-m", to: "o-s" },
          { from: "o-s2", to: "o-m2" },
        ],
      }),
    );
  });

  it("an active merged row beats the survivor's revoked row for the same owner", async () => {
    const h = harness({
      survivor: side(SURVIVOR, {
        ownerships: [
          { id: "o-s", ownerType: "HUMAN", ownerId: "h-1", verified: true, revoked: true },
        ],
      }),
      merged: side(MERGED, {
        ownerships: [
          { id: "o-m", ownerType: "HUMAN", ownerId: "h-1", verified: true, revoked: false },
        ],
      }),
    });
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.repointPlaceRows).toHaveBeenCalledWith(
      expect.objectContaining({ dropOwnershipIds: ["o-s"] }),
    );
  });
});

describe("field fill (D2)", () => {
  it("fills empty survivor fields; survivor values win; address stays when the survivor has coordinates", async () => {
    const h = harness({
      survivor: side(SURVIVOR, { place: { phone: "", capacity: 300 } }),
      merged: side(MERGED, {
        place: {
          phone: "615-555-0100",
          capacity: 120,
          website: "https://springwater.example",
          websiteSource: "TRUSTED_IMPORT",
          address: "Somewhere else",
          lat: 1,
          lng: 2,
        },
      }),
    });
    const out = await mergePlaces(h.deps, input);
    expect(h.placeMerge.fillFields).toHaveBeenCalledWith(SURVIVOR, {
      phone: "615-555-0100",
      website: "https://springwater.example",
      websiteSource: "TRUSTED_IMPORT",
    });
    expect(out.filledFields).toEqual(["phone", "website", "websiteSource"]);
  });

  it("moves the whole address group when the survivor has no coordinates", async () => {
    const merged = side(MERGED, {
      place: { address: "115 27th Ave N", addrLine2: "Rear", lat: 36.1, lng: -86.8 },
    });
    const h = harness({
      survivor: side(SURVIVOR, {
        place: { address: "Springwater, Nashville", addrLine1: null, lat: null, lng: null, timezone: null },
      }),
      merged,
      // No event moves: the re-projection below is the address fill's alone.
      repointed: { events: [], venueConfirmedEvents: [] },
    });
    await mergePlaces(h.deps, input);
    const patch = h.placeMerge.fillFields.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).toMatchObject({
      address: "115 27th Ave N",
      addrLine1: merged.place.addrLine1,
      addrLine2: "Rear",
      city: merged.place.city,
      postcode: merged.place.postcode,
      lat: 36.1,
      lng: -86.8,
      timezone: merged.place.timezone,
      admissionTaxRateBps: merged.place.admissionTaxRateBps,
    });
    // Address filled → the survivor's events are re-projected even with none moved.
    expect(h.events.reprojectLocationForPlace).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: SURVIVOR }),
    );
  });

  it("does not move the address when the merged row has no coordinates either", async () => {
    const h = harness({
      survivor: side(SURVIVOR, { place: { lat: null, lng: null } }),
      merged: side(MERGED, { place: { lat: null, lng: null, address: "Other" } }),
    });
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.fillFields).toHaveBeenCalledWith(SURVIVOR, {});
  });
});

describe("re-point, page, reindex, audit (FR-003..FR-007)", () => {
  it("re-points events onto the survivor's default calendar and Main Space", async () => {
    const h = harness();
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.repointPlaceRows).toHaveBeenCalledWith({
      survivorId: SURVIVOR,
      mergedId: MERGED,
      calendar: { from: "cal-m", to: "cal-s" },
      space: { from: "space-m", to: "space-s" },
      dropOwnershipIds: [],
      repointOwnershipIds: [],
    });
  });

  it("moves the page's followers, records the merged slug against the survivor page, deletes the merged page", async () => {
    const h = harness();
    const out = await mergePlaces(h.deps, input);
    expect(h.placeMerge.repointPageRows).toHaveBeenCalledWith({
      fromPageId: "page-m",
      toPageId: "page-s",
    });
    expect(h.entityPages.recordSlugHistory).toHaveBeenCalledWith("page-s", "springwater");
    expect(h.placeMerge.deletePage).toHaveBeenCalledWith("page-m");
    // History moves before the page that owns it is deleted (FK cascade).
    expect(h.calls.indexOf("placeMerge.repointPageRows")).toBeLessThan(
      h.calls.indexOf("placeMerge.deletePage"),
    );
    expect(out.pageAction).toBe("MOVE_TO_SURVIVOR_PAGE");
    expect(out.moved.follows).toBe(2);
    expect(out.moved.followsDropped).toBe(1);
    expect(h.placeMerge.transferPage).not.toHaveBeenCalled();
  });

  it("gives the merged page to a survivor that has none", async () => {
    const h = harness({ survivor: side(SURVIVOR, { page: null }) });
    const out = await mergePlaces(h.deps, input);
    expect(h.placeMerge.transferPage).toHaveBeenCalledWith({
      pageId: "page-m",
      toPlaceId: SURVIVOR,
    });
    expect(h.placeMerge.deletePage).not.toHaveBeenCalled();
    expect(h.entityPages.recordSlugHistory).not.toHaveBeenCalled();
    expect(out.pageAction).toBe("TRANSFER_PAGE");
  });

  it("re-projects event locations from the survivor when events moved", async () => {
    const h = harness();
    const out = await mergePlaces(h.deps, input);
    expect(h.events.reprojectLocationForPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: SURVIVOR,
        now: NOW,
        projection: expect.objectContaining({ kind: "exact" }),
      }),
    );
    expect(out.eventsReprojected).toBe(3);
  });

  it("skips re-projection when no event moved and no address filled", async () => {
    const h = harness({ repointed: { events: [], venueConfirmedEvents: [] } });
    await mergePlaces(h.deps, input);
    expect(h.events.reprojectLocationForPlace).not.toHaveBeenCalled();
  });

  it("marks both places and every moved / confirmed / re-projected event for reindex, then reindexes both places after commit", async () => {
    const h = harness();
    await mergePlaces(h.deps, input);
    expect(h.searchReindexPending.mark).toHaveBeenCalledTimes(1);
    const [targets, at] = h.searchReindexPending.mark.mock.calls[0]!;
    expect(at).toBe(NOW);
    expect(targets).toEqual(
      expect.arrayContaining([
        { entityType: "place", entityId: SURVIVOR },
        { entityType: "place", entityId: MERGED },
        { entityType: "event", entityId: "ev-1" },
        { entityType: "event", entityId: "ev-2" },
        { entityType: "event", entityId: "ev-survivor" },
      ]),
    );
    expect((targets as unknown[]).length).toBe(5);
    expect(reindexSpy.mock.calls.map((c) => c[2])).toEqual([
      { kind: "place", id: SURVIVOR },
      { kind: "place", id: MERGED },
    ]);
  });

  it("marks survivor stats stale, drops the merged derived rows, deletes the merged place last", async () => {
    const h = harness();
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.markPlaceStatsStale).toHaveBeenCalledWith(SURVIVOR);
    expect(h.placeMerge.deleteDerivedRows).toHaveBeenCalledWith(MERGED);
    expect(h.placeMerge.deletePlace).toHaveBeenCalledWith(MERGED);
    expect(h.calls.at(-1)).toBe("placeMerge.deletePlace");
  });

  it("writes ONE audit row with the merged row, its page slug, filled fields and moved ids", async () => {
    const h = harness({
      survivor: side(SURVIVOR, { place: { phone: null } }),
      merged: side(MERGED, { place: { phone: "615-555-0100" } }),
    });
    await mergePlaces(h.deps, input);
    expect(h.audit.log).toHaveBeenCalledTimes(1);
    const entry = h.audit.log.mock.calls[0]![0] as {
      entity: string;
      entityId: string;
      action: string;
      at: Date;
      data: Record<string, any>;
    };
    expect(entry).toMatchObject({
      entity: "Place",
      entityId: SURVIVOR,
      action: "place.merged",
      at: NOW,
    });
    expect(entry.data).toMatchObject({
      actorHumanId: ACTOR,
      mergedId: MERGED,
      mergedPageSlug: "springwater",
      mergedPageId: "page-m",
      filledFields: ["phone"],
      survivorValuesBeforeFill: { phone: null },
      movedIds: expect.objectContaining({
        events: ["ev-1", "ev-2"],
        venueConfirmedEvents: ["ev-1"],
        follows: ["f-1", "f-2"],
        followsDropped: ["f-3"],
        pageSlugHistory: ["h-1"],
      }),
      reprojectedEventIds: ["ev-1", "ev-2", "ev-survivor"],
    });
    // The full field set, dates as ISO strings.
    expect(entry.data.mergedPlace).toMatchObject({
      id: MERGED,
      name: "Springwater",
      phone: "615-555-0100",
      createdAt: "2026-10-06T00:00:00.000Z",
    });
    expect(Object.keys(entry.data.mergedPlace)).toHaveLength(
      Object.keys(row(MERGED)).length,
    );
  });

  it("returns the counts from the writes", async () => {
    const out = await mergePlaces(harness().deps, input);
    expect(out).toMatchObject({
      survivorId: SURVIVOR,
      mergedId: MERGED,
      moved: { events: 2, venueConfirmedEvents: 1, pageSlugHistory: 1 },
    });
  });
});

describe("booking and operations moves (FR-003b, owner ruling 2026-10-15)", () => {
  it("folds the merged default calendar / Main Space into the survivor's, after events move and before the delete", async () => {
    const h = harness();
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.moveOperations).toHaveBeenCalledWith({
      survivorId: SURVIVOR,
      mergedId: MERGED,
      calendar: { from: "cal-m", to: "cal-s" },
      space: { from: "space-m", to: "space-s" },
      reparentCalendars: [],
      reparentSpaces: [],
      layouts: [],
      dropStandardItems: [],
      dropPitchExamples: [],
      deactivateMergedWaivers: false,
      revokeMergedGrants: false,
      splitWholePlaceGrantsOnto: ["cal-s"],
      revokeWholePlaceGrants: false,
      now: NOW,
    });
    expect(h.calls.indexOf("placeMerge.repointPlaceRows")).toBeLessThan(
      h.calls.indexOf("placeMerge.moveOperations"),
    );
    expect(h.calls.indexOf("placeMerge.moveOperations")).toBeLessThan(
      h.calls.indexOf("placeMerge.deletePlace"),
    );
  });

  it("moves the merged extra calendars and spaces whole, suffixing a taken name and slug", async () => {
    const merged = side(MERGED, {
      calendars: [
        { id: "cal-m", name: "Main Calendar", slug: "main", isDefault: true, primarySpaceId: "space-m" },
        { id: "cal-m-patio", name: "Patio", slug: "patio", isDefault: false, primarySpaceId: "space-m-patio" },
        { id: "cal-m-late", name: "Late Show", slug: "late", isDefault: false, primarySpaceId: "space-m" },
      ],
      spaces: [
        { id: "space-m", name: "Main Space" },
        { id: "space-m-patio", name: "Patio" },
      ],
      layouts: [{ id: "layout-m", name: "Default" }],
    });
    const survivor = side(SURVIVOR, {
      calendars: [
        { id: "cal-s", name: "Main Calendar", slug: "main", isDefault: true, primarySpaceId: "space-s" },
        { id: "cal-s-patio", name: "patio", slug: "patio", isDefault: false, primarySpaceId: "space-s-patio" },
      ],
      spaces: [
        { id: "space-s", name: "Main Space" },
        { id: "space-s-patio", name: "Patio" },
      ],
      layouts: [{ id: "layout-s", name: "Default" }],
    });
    const h = harness({ survivor, merged });
    const preview = await previewPlaceMerge(h.deps, input);
    expect(preview.renames).toEqual([
      {
        id: "cal-m-patio",
        kind: "calendar",
        from: { name: "Patio", slug: "patio" },
        to: { name: "Patio (from Springwater)", slug: "patio-2" },
      },
      {
        id: "space-m-patio",
        kind: "space",
        from: { name: "Patio" },
        to: { name: "Patio (from Springwater)" },
      },
      {
        id: "layout-m",
        kind: "layout",
        from: { name: "Default" },
        to: { name: "Default (from Springwater)" },
      },
    ]);
    expect(preview.moves).toMatchObject({ calendarsReparented: 2, spacesReparented: 1 });
    expect(preview.warnings).toContainEqual({
      code: "NAMES_SUFFIXED",
      count: 3,
      ids: ["cal-m-patio", "space-m-patio", "layout-m"],
    });

    const h2 = harness({ survivor, merged });
    await mergePlaces(h2.deps, input);
    expect(h2.placeMerge.moveOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        reparentCalendars: [
          { id: "cal-m-patio", name: "Patio (from Springwater)", slug: "patio-2" },
          { id: "cal-m-late", name: "Late Show", slug: "late" },
        ],
        reparentSpaces: [{ id: "space-m-patio", name: "Patio (from Springwater)" }],
        layouts: [{ id: "layout-m", name: "Default (from Springwater)" }],
      }),
    );
  });

  it("a survivor with no default calendar takes the merged one whole (still default) instead of refusing", async () => {
    const h = harness({
      survivor: side(SURVIVOR, {
        defaultCalendarId: null,
        mainSpaceId: null,
        calendars: [],
        spaces: [],
      }),
      moves: { eventsOnDefaultCalendar: 0, eventsOnMainSpace: 0 },
    });
    const out = await mergePlaces(h.deps, input);
    expect(h.placeMerge.repointPlaceRows).toHaveBeenCalledWith(
      expect.objectContaining({ calendar: null, space: null }),
    );
    expect(h.placeMerge.moveOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        calendar: null,
        space: null,
        reparentCalendars: [{ id: "cal-m", name: "Main Calendar", slug: "main" }],
        reparentSpaces: [{ id: "space-m", name: "Main Space" }],
      }),
    );
    expect(out.survivorId).toBe(SURVIVOR);
  });

  it("booking standards: the survivor's list wins per intent, the merged one moves where the survivor has none", async () => {
    const h = harness({
      ops: {
        standards: {
          items: {
            mergedPlace: [
              { intent: "PERFORM", count: 3 },
              { intent: "RENT", count: 2 },
            ],
            mergedDefaultCalendar: [{ intent: "USE", count: 1 }],
            survivorPlace: [{ intent: "PERFORM", count: 4 }],
            survivorDefaultCalendar: [{ intent: "USE", count: 2 }],
          },
          examples: {
            mergedPlace: [{ intent: "PERFORM", count: 1 }],
            mergedDefaultCalendar: [],
            survivorPlace: [],
            survivorDefaultCalendar: [],
          },
        },
      },
    });
    const preview = await previewPlaceMerge(h.deps, input);
    expect(preview.moves).toMatchObject({
      bookingStandardItems: 2,
      bookingStandardItemsDropped: 4,
      bookingPitchExamples: 1,
      bookingPitchExamplesDropped: 0,
    });
    expect(preview.warnings).toContainEqual({ code: "BOOKING_STANDARDS_REPLACED", count: 4 });

    const h3 = harness({
      ops: {
        standards: {
          items: {
            mergedPlace: [{ intent: "PERFORM", count: 3 }],
            mergedDefaultCalendar: [{ intent: "USE", count: 1 }],
            survivorPlace: [{ intent: "PERFORM", count: 4 }],
            survivorDefaultCalendar: [{ intent: "USE", count: 2 }],
          },
          examples: noIntents(),
        },
      },
    });
    await mergePlaces(h3.deps, input);
    expect(h3.placeMerge.moveOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        dropStandardItems: [
          { ownerType: "PLACE", ownerId: MERGED, intent: "PERFORM" },
          { ownerType: "CALENDAR", ownerId: "cal-m", intent: "USE" },
        ],
        dropPitchExamples: [],
      }),
    );
  });

  it("warnings: availability overlap, place-wide availability, same-night holds — none block", async () => {
    const preview = await previewPlaceMerge(
      harness({
        ops: {
          availabilityOverlaps: { count: 2, ids: ["av-1", "av-2"] },
          placeWideAvailability: 1,
          holdSameNight: { count: 1, ids: ["hold-9"] },
        },
      }).deps,
      input,
    );
    expect(preview.canMerge).toBe(true);
    expect(preview.warnings).toEqual([
      { code: "AVAILABILITY_OVERLAP", count: 2, ids: ["av-1", "av-2"] },
      { code: "PLACE_WIDE_AVAILABILITY_MOVED", count: 1 },
      { code: "HOLDS_SAME_NIGHT", count: 1, ids: ["hold-9"] },
    ]);
  });

  it("names every remaining reason at once", async () => {
    const preview = await previewPlaceMerge(
      harness({
        ops: {
          holdLineConflicts: { count: 1, ids: ["hold-1"] },
          openRequestConflicts: { count: 1, ids: ["br-1"] },
        },
        survivor: side(SURVIVOR, { place: { defaultPrimaryPayoutTermsId: "pt-s" } }),
        merged: side(MERGED, { place: { defaultPrimaryPayoutTermsId: "pt-m" } }),
      }).deps,
      input,
    );
    expect(preview.blockers.map((b) => b.code)).toEqual([
      "DEFAULT_PAYOUT_TERMS_CONFLICT",
      "BOOKING_HOLDS_OVERLAP",
      "BOOKING_REQUESTS_OPEN_DUPLICATE",
    ]);
  });

  it("marks events on moved calendars for reindex", async () => {
    const h = harness({ operations: { eventsOnReparentedCalendars: ["ev-patio"] } });
    await mergePlaces(h.deps, input);
    const [targets] = h.searchReindexPending.mark.mock.calls[0]!;
    expect(targets).toContainEqual({ entityType: "event", entityId: "ev-patio" });
  });

  it("the audit row carries every moved booking id, the folded rows and the renames", async () => {
    const operations = {
      bookingHolds: ["hold-1", "hold-2"],
      bookingHoldsCalendarRepointed: ["hold-1"],
      bookingRequests: ["br-1"],
      calendarAvailability: ["av-1"],
      series: ["series-1"],
      templates: ["tpl-1"],
      occurrences: ["occ-1"],
      bookingStandardItemsDropped: [{ id: "std-1", label: "Video link" }],
      deletedCalendar: { id: "cal-m", name: "Main Calendar" },
      deletedSpace: { id: "space-m", name: "Main Space" },
    };
    const h = harness({ operations });
    const out = await mergePlaces(h.deps, input);
    const entry = h.audit.log.mock.calls[0]![0] as { data: Record<string, any> };
    expect(entry.data.operations).toMatchObject({
      defaultCalendarFolded: true,
      survivorDefaultCalendarId: "cal-s",
      survivorMainSpaceId: "space-s",
      renames: [],
      warnings: [],
      ...operations,
    });
    expect(out.moved).toMatchObject({
      bookingHolds: 2,
      bookingRequests: 1,
      calendarAvailability: 1,
      series: 1,
      templates: 1,
      occurrences: 1,
      bookingStandardItemsDropped: 1,
      defaultCalendarFolded: 1,
    });
  });
});

describe("review round 1 (2026-10-15)", () => {
  const ownedBy = (ownerId: string) => [
    { id: `o-${ownerId}`, ownerType: "HUMAN" as const, ownerId, verified: true, revoked: false },
  ];

  it("takes the survivor's and merged default hold lines in sortLineKeys order, before the location locks and the row locks", async () => {
    const h = harness({
      lineKeys: [
        [
          { calendarId: "cal-s", date: "2026-12-11" },
          { calendarId: "cal-m", date: "2026-12-11" },
          { calendarId: "cal-s", date: "2026-12-04" },
          { calendarId: "cal-m", date: "2026-12-04" },
        ],
      ],
    });
    await mergePlaces(h.deps, input);
    expect(h.bookingHolds.lockLine.mock.calls.map((c) => c[0])).toEqual([
      { calendarId: "cal-m", date: "2026-12-04" },
      { calendarId: "cal-m", date: "2026-12-11" },
      { calendarId: "cal-s", date: "2026-12-04" },
      { calendarId: "cal-s", date: "2026-12-11" },
    ]);
    // Global order: hold lines BEFORE place_location (save-event-shared
    // note 4), then the row locks, which lock only the holds on these lines.
    const firstLocation = h.calls.indexOf("events.lockLocationsAtPlace");
    const lastLocation = h.calls.lastIndexOf("events.lockLocationsAtPlace");
    const lastLine = h.calls.lastIndexOf("bookingHolds.lockLine");
    expect(lastLine).toBeLessThan(firstLocation);
    expect(lastLocation).toBeLessThan(h.calls.indexOf("placeMerge.lockForMerge"));
    expect(h.placeMerge.lockForMerge).toHaveBeenCalledWith({
      placeIds: [MERGED, SURVIVOR],
      lineKeys: [
        { calendarId: "cal-m", date: "2026-12-04" },
        { calendarId: "cal-m", date: "2026-12-11" },
        { calendarId: "cal-s", date: "2026-12-04" },
        { calendarId: "cal-s", date: "2026-12-11" },
      ],
    });
    expect(h.calls.indexOf("placeMerge.lockForMerge")).toBeLessThan(
      h.calls.indexOf("placeMerge.getSide"),
    );
  });

  it("a held day that appeared before the row locks (its line unlocked) → CONFLICT PLACE_MERGE_RETRY, nothing written", async () => {
    const h = harness({
      lineKeys: [
        [],
        [
          { calendarId: "cal-s", date: "2026-12-04" },
          { calendarId: "cal-m", date: "2026-12-04" },
        ],
      ],
    });
    await expect(mergePlaces(h.deps, input)).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "PLACE_MERGE_RETRY" },
    });
    expect(h.calls.filter((c) => WRITE_CALLS.includes(c))).toEqual([]);
  });

  describe("ownersCompatible", () => {
    it.each([
      ["both ownerless", [], [], true],
      ["merged owners all own the survivor", ownedBy("h1"), ownedBy("h1"), true],
      ["merged ownerless, survivor owned", ownedBy("h1"), [], false],
      ["merged owned, survivor ownerless (the owner moves with the row)", [], ownedBy("h1"), true],
      ["a merged owner the survivor lacks", ownedBy("h1"), ownedBy("h2"), false],
    ] as const)("%s → %s", async (_label, s, m, expected) => {
      const { ownersCompatible } = await import("../_shared/place-merge-plan");
      expect(
        ownersCompatible(
          side(SURVIVOR, { ownerships: [...s] }),
          side(MERGED, { ownerships: [...m] }),
        ),
      ).toBe(expected);
    });

    it("not compatible: deals not carried, waivers inactive, grants ended — warnings only", async () => {
      const setup = {
        survivor: side(SURVIVOR, { ownerships: ownedBy("h-survivor") }),
        merged: side(MERGED, {
          place: { defaultPrimaryPayoutTermsId: "pt-m" },
          ownerships: [],
        }),
        ops: {
          activeWaivers: { survivor: 0, merged: 1 },
          activeGrants: { count: 2, ids: ["g-1", "g-2"] },
          wholePlaceGrants: { count: 1, ids: ["g-1"] },
        },
      };
      const preview = await previewPlaceMerge(harness(setup).deps, input);
      expect(preview.blockers).toEqual([]);
      expect(preview.filledFields).not.toContain("defaultPrimaryPayoutTermsId");
      expect(preview.warnings).toEqual(
        expect.arrayContaining([
          { code: "WAIVERS_DEACTIVATED", count: 1 },
          { code: "PAYOUT_DEFAULTS_NOT_CARRIED", count: 1 },
          { code: "GRANTS_ENDED", count: 2, ids: ["g-1", "g-2"] },
        ]),
      );
      expect(preview.warnings.map((w) => w.code)).not.toContain("GRANTS_SPLIT");
      expect(preview.warnings.map((w) => w.code)).not.toContain("WAIVER_BECOMES_ACTIVE");
      expect(preview.moves).toMatchObject({ bookingGrantsRevoked: 2, bookingGrantsSplit: 0 });

      const h = harness(setup);
      await mergePlaces(h.deps, input);
      expect(h.placeMerge.fillFields).toHaveBeenCalledWith(SURVIVOR, {});
      expect(h.placeMerge.moveOperations).toHaveBeenCalledWith(
        expect.objectContaining({
          deactivateMergedWaivers: true,
          revokeMergedGrants: true,
          now: NOW,
        }),
      );
      const entry = h.audit.log.mock.calls[0]![0] as { data: Record<string, any> };
      expect(entry.data.ownersCompatible).toBe(false);
      expect(entry.data.operations.payoutTerms).toMatchObject({
        merged: { defaultPrimaryPayoutTermsId: "pt-m" },
        filled: [],
        carried: false,
      });
    });

    it("not compatible: two different default deals do not block (neither is carried)", async () => {
      const preview = await previewPlaceMerge(
        harness({
          survivor: side(SURVIVOR, {
            place: { defaultPrimaryPayoutTermsId: "pt-s" },
            ownerships: ownedBy("h-survivor"),
          }),
          merged: side(MERGED, { place: { defaultPrimaryPayoutTermsId: "pt-m" } }),
        }).deps,
        input,
      );
      expect(preview.blockers).toEqual([]);
    });
  });

  describe("whole-place grants split onto the calendars the merged place brought", () => {
    it("fold: the survivor's default calendar, then each calendar that moves whole", async () => {
      const merged = side(MERGED, {
        calendars: [
          { id: "cal-m", name: "Main Calendar", slug: "main", isDefault: true, primarySpaceId: "space-m" },
          { id: "cal-m-patio", name: "Patio", slug: "patio", isDefault: false, primarySpaceId: "space-m" },
        ],
      });
      const ops = { wholePlaceGrants: { count: 1, ids: ["g-1"] }, activeGrants: { count: 1, ids: ["g-1"] } };
      const preview = await previewPlaceMerge(harness({ merged, ops }).deps, input);
      expect(preview.warnings).toContainEqual({ code: "GRANTS_SPLIT", count: 1, ids: ["g-1"] });
      expect(preview.moves.bookingGrantsSplit).toBe(1);
      const h = harness({ merged, ops });
      await mergePlaces(h.deps, input);
      expect(h.placeMerge.moveOperations).toHaveBeenCalledWith(
        expect.objectContaining({
          revokeMergedGrants: false,
          splitWholePlaceGrantsOnto: ["cal-s", "cal-m-patio"],
        }),
      );
    });

    it("no survivor default: the merged default (moving whole) comes first", async () => {
      const h = harness({
        survivor: side(SURVIVOR, { defaultCalendarId: null, mainSpaceId: null, calendars: [], spaces: [] }),
        merged: side(MERGED, {
          calendars: [
            { id: "cal-m-a", name: "A", slug: "a", isDefault: false, primarySpaceId: "space-m" },
            { id: "cal-m", name: "Main Calendar", slug: "main", isDefault: true, primarySpaceId: "space-m" },
          ],
        }),
        moves: { eventsOnDefaultCalendar: 0, eventsOnMainSpace: 0 },
      });
      await mergePlaces(h.deps, input);
      expect(h.placeMerge.moveOperations).toHaveBeenCalledWith(
        expect.objectContaining({ splitWholePlaceGrantsOnto: ["cal-m", "cal-m-a"] }),
      );
    });
  });

  it("a merged place with no calendar: its live whole-place grants END (GRANTS_ENDED), never widen to the survivor's rooms", async () => {
    const setup = {
      merged: side(MERGED, {
        defaultCalendarId: null,
        mainSpaceId: null,
        calendars: [],
        spaces: [],
      }),
      moves: { eventsOnDefaultCalendar: 0, eventsOnMainSpace: 0 },
      ops: {
        activeGrants: { count: 2, ids: ["g-cal", "g-whole"] },
        wholePlaceGrants: { count: 1, ids: ["g-whole"] },
      },
    };
    const preview = await previewPlaceMerge(harness(setup).deps, input);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toContainEqual({ code: "GRANTS_ENDED", count: 1, ids: ["g-whole"] });
    expect(preview.warnings.map((w) => w.code)).not.toContain("GRANTS_SPLIT");
    expect(preview.moves).toMatchObject({ bookingGrantsRevoked: 1, bookingGrantsSplit: 0 });

    const h = harness(setup);
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.moveOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        revokeMergedGrants: false,
        splitWholePlaceGrantsOnto: [],
        revokeWholePlaceGrants: true,
      }),
    );
  });

  it("no whole-place grants and no calendar: nothing to end", async () => {
    const h = harness({
      merged: side(MERGED, { defaultCalendarId: null, mainSpaceId: null, calendars: [], spaces: [] }),
      moves: { eventsOnDefaultCalendar: 0, eventsOnMainSpace: 0 },
    });
    await mergePlaces(h.deps, input);
    expect(h.placeMerge.moveOperations).toHaveBeenCalledWith(
      expect.objectContaining({ revokeWholePlaceGrants: false }),
    );
  });

  describe("OWNERSHIP_TRANSFERS", () => {
    it("merged owners landing on an ownerless survivor are named, with what of the survivor's they take over", async () => {
      const preview = await previewPlaceMerge(
        harness({
          merged: side(MERGED, {
            ownerships: [
              { id: "o-m", ownerType: "ORGANIZATION", ownerId: "org-1", verified: true, revoked: false },
              { id: "o-old", ownerType: "HUMAN", ownerId: "h-old", verified: false, revoked: true },
            ],
          }),
          ops: { survivorControl: { openBookingRequests: 3, liveAgreements: 1 } },
        }).deps,
        input,
      );
      expect(preview.blockers).toEqual([]);
      expect(preview.warnings).toContainEqual({
        code: "OWNERSHIP_TRANSFERS",
        count: 1,
        owners: [{ ownerType: "ORGANIZATION", ownerId: "org-1" }],
        survivorOpenBookingRequests: 3,
        survivorLiveAgreements: 1,
      });
    });

    it.each([
      ["the survivor is already owned", ownedBy("h1"), ownedBy("h1")],
      ["the merged place is ownerless too", [], []],
    ] as const)("not raised when %s", async (_label, s, m) => {
      const preview = await previewPlaceMerge(
        harness({
          survivor: side(SURVIVOR, { ownerships: [...s] }),
          merged: side(MERGED, { ownerships: [...m] }),
          ops: { survivorControl: { openBookingRequests: 3, liveAgreements: 1 } },
        }).deps,
        input,
      );
      expect(preview.warnings.map((w) => w.code)).not.toContain("OWNERSHIP_TRANSFERS");
    });
  });

  it("standards: a folded-calendar list is dropped when the survivor has a PLACE list for that intent", async () => {
    const h = harness({
      ops: {
        standards: {
          items: {
            mergedPlace: [],
            mergedDefaultCalendar: [{ intent: "PERFORM", count: 1 }],
            survivorPlace: [{ intent: "PERFORM", count: 2 }],
            survivorDefaultCalendar: [],
          },
          examples: {
            mergedPlace: [],
            mergedDefaultCalendar: [{ intent: "RENT", count: 1 }],
            survivorPlace: [{ intent: "RENT", count: 1 }],
            survivorDefaultCalendar: [],
          },
        },
      },
    });
    const out = await mergePlaces(h.deps, input);
    expect(h.placeMerge.moveOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        dropStandardItems: [{ ownerType: "CALENDAR", ownerId: "cal-m", intent: "PERFORM" }],
        dropPitchExamples: [{ ownerType: "CALENDAR", ownerId: "cal-m", intent: "RENT" }],
      }),
    );
    expect(out.warnings.map((w) => w.code)).toContain("BOOKING_STANDARDS_REPLACED");
  });

  it("the audit row keeps the ownership repoint pairs and every dropped row in full", async () => {
    const h = harness({
      survivor: side(SURVIVOR, { ownerships: ownedBy("h1") }),
      merged: side(MERGED, {
        ownerships: [{ id: "o-m", ownerType: "HUMAN", ownerId: "h1", verified: false, revoked: false }],
      }),
      repointed: {
        droppedRows: {
          placeReviewSessions: [{ id: "prs-1" }],
          entityReports: [{ id: "er-1" }],
          featuredItems: [{ id: "fi-1" }],
          ownerships: [{ id: "o-m" }],
        },
        imageModerationRecords: ["imr-1"],
      },
    });
    const out = await mergePlaces(h.deps, input);
    const entry = h.audit.log.mock.calls[0]![0] as { data: Record<string, any> };
    expect(entry.data.repointOwnershipIds).toEqual([{ from: "o-m", to: "o-h1" }]);
    expect(entry.data.movedIds.droppedRows).toEqual({
      placeReviewSessions: [{ id: "prs-1" }],
      entityReports: [{ id: "er-1" }],
      featuredItems: [{ id: "fi-1" }],
      ownerships: [{ id: "o-m" }],
      follows: [{ id: "f-3", followerHumanId: "h-x" }],
      eventNotices: [],
    });
    expect(entry.data.movedIds.imageModerationRecords).toEqual(["imr-1"]);
    expect(out.moved.imageModerationRecords).toBe(1);
  });
});

describe("previewPlaceMerge (FR-002)", () => {
  it("returns both rows, the move counts, the fill and no blockers for a clean pair", async () => {
    const h = harness({
      survivor: side(SURVIVOR, { place: { capacity: null } }),
      merged: side(MERGED, { place: { capacity: 150 } }),
    });
    const out = await previewPlaceMerge(h.deps, input);
    expect(out.canMerge).toBe(true);
    expect(out.survivor.id).toBe(SURVIVOR);
    expect(out.merged.id).toBe(MERGED);
    expect(out.survivorPage).toEqual({ id: "page-s", slug: "springwater-supper-club" });
    expect(out.mergedPage).toEqual({ id: "page-m", slug: "springwater" });
    expect(out.filledFields).toEqual(["capacity"]);
    expect(out.moves).toMatchObject({ events: 2, follows: 3, followsDropped: 1 });
    // Read-only: no lock, no write.
    expect(h.calls.filter((c) => WRITE_CALLS.includes(c))).toEqual([]);
    expect(h.placeMerge.lockForMerge).not.toHaveBeenCalled();
  });
});

describe("fix round 1: consent, status, images, deadlock", () => {
  it("merged consents to community listings, survivor does not, community events exist → COMMUNITY_LISTINGS_CONSENT_DIFFERS", async () => {
    await expectBlocked(
      harness({
        merged: side(MERGED, { place: { acceptsCommunityListings: true } }),
        ops: { communityEvents: 2 },
      }),
      "COMMUNITY_LISTINGS_CONSENT_DIFFERS",
      2,
    );
  });

  it.each([
    ["no community events", { acceptsCommunityListings: true }, false, 0],
    ["survivor consents too", { acceptsCommunityListings: true }, true, 2],
    ["merged never consented", { acceptsCommunityListings: false }, false, 2],
  ] as const)(
    "does not block when %s, and never ORs the flag",
    async (_label, mergedPlace, survivorConsents, communityEvents) => {
      const h = harness({
        survivor: side(SURVIVOR, {
          place: { acceptsCommunityListings: survivorConsents },
        }),
        merged: side(MERGED, { place: mergedPlace }),
        ops: { communityEvents },
      });
      const preview = await previewPlaceMerge(h.deps, input);
      expect(preview.blockers).toEqual([]);
      await mergePlaces(h.deps, input);
      const patch = h.placeMerge.fillFields.mock.calls[0]![1] as Record<string, unknown>;
      expect(patch).not.toHaveProperty("acceptsCommunityListings");
    },
  );

  it.each(["ARCHIVED", "SUSPENDED"] as const)(
    "a %s survivor → SURVIVOR_NOT_ACTIVE",
    async (status) => {
      await expectBlocked(
        harness({ survivor: side(SURVIVOR, { place: { status } }) }),
        "SURVIVOR_NOT_ACTIVE",
        1,
      );
    },
  );

  it("enqueues the merged page's own images (avatar, blocks, draft) before deleting it, never another entity's", async () => {
    const h = harness();
    await mergePlaces(h.deps, input);
    expect(h.pendingObjectDeletions.enqueueMany).toHaveBeenCalledTimes(1);
    const items = h.pendingObjectDeletions.enqueueMany.mock.calls[0]![0] as {
      targetKey: string;
      targetKind: string;
      source: string;
      sourceId: string;
    }[];
    const keys = items.map((i) => i.targetKey);
    const prefix = `entity-pages/place/${MERGED}/`;
    expect(keys).toEqual(
      expect.arrayContaining([
        `${prefix}2026-10-06/${AVATAR_NAME}`,
        `${prefix}2026-10-06/${BLOCK_NAME}`,
        `${prefix}2026-10-07/${DRAFT_NAME}`,
      ]),
    );
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => k.startsWith(prefix))).toBe(true);
    expect(items[0]).toMatchObject({
      targetKind: "KEY",
      source: "place_merge",
      sourceId: MERGED,
    });
    expect(h.calls.indexOf("pendingObjectDeletions.enqueueMany")).toBeLessThan(
      h.calls.indexOf("placeMerge.deletePage"),
    );
    const audit = h.audit.log.mock.calls[0]![0] as { data: { pageImageKeysEnqueued: string[] } };
    expect(audit.data.pageImageKeysEnqueued).toEqual(keys);
  });

  it("enqueues nothing when the page is transferred (it stays live)", async () => {
    const h = harness({ survivor: side(SURVIVOR, { page: null }) });
    await mergePlaces(h.deps, input);
    expect(h.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
  });

  it.each([
    ["Prisma P2034", { code: "P2034", message: "write conflict or a deadlock" }],
    ["pg 40P01 on the cause", Object.assign(new Error("tx failed"), { cause: { code: "40P01" } })],
    ["driver adapter message", new Error("deadlock detected")],
  ])("a deadlock (%s) is rethrown as a retryable CONFLICT", async (_label, dbError) => {
    const h = harness();
    (h.deps.repos.tx as ReturnType<typeof vi.fn>).mockRejectedValueOnce(dbError);
    const err = await mergePlaces(h.deps, input).catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "CONFLICT",
      message: "PLACE_MERGE_RETRY",
      meta: { reason: "PLACE_MERGE_RETRY" },
    });
    expect((err as Error).cause).toBe(dbError);
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("any other error passes through unchanged", async () => {
    const h = harness();
    const boom = new Error("connection reset");
    (h.deps.repos.tx as ReturnType<typeof vi.fn>).mockRejectedValueOnce(boom);
    await expect(mergePlaces(h.deps, input)).rejects.toBe(boom);
  });
});

// ── arrival-areas FR-012 / FR-013 / FR-014 ──────────────────────────────────

describe("arrival areas (arrival-areas FR-012)", () => {
  // places.getById in the harness puts the survivor at (36.15, -86.81).
  const PIN = { lat: 36.15, lng: -86.81 };
  const AREA_AT = new Date("2026-10-01T00:00:00.000Z");
  const area = (
    id: string,
    overrides: Partial<ArrivalAreaRow> = {},
  ): ArrivalAreaRow => ({
    id,
    placeId: MERGED,
    eventId: null,
    kind: "PARKING",
    geometry: squareAt(PIN.lat + 0.001, PIN.lng),
    label: `Lot ${id}`,
    cost: "FREE",
    priceText: null,
    note: null,
    accessibleSpots: false,
    sortOrder: 0,
    disabledAt: null,
    createdByHumanId: null,
    createdAt: AREA_AT,
    updatedAt: AREA_AT,
    ...overrides,
  });
  const many = (n: number, placeId: string, prefix: string) =>
    Array.from({ length: n }, (_, i) =>
      area(`${prefix}-${i}`, { placeId, sortOrder: i, label: `${prefix} ${i}` }),
    );

  it("moves the merged place's areas to the survivor by id, after the survivor's, before the delete", async () => {
    const h = harness({
      areas: [
        area("s-1", { placeId: SURVIVOR, sortOrder: 0 }),
        area("m-1", { sortOrder: 0 }),
        area("m-2", { sortOrder: 1, kind: "LOAD_IN" }),
      ],
    });
    const out = await mergePlaces(h.deps, input);

    expect(h.arrivalAreas.movePlaceAreas).toHaveBeenCalledWith(MERGED, SURVIVOR);
    expect(h.areaStore.get("m-1")).toMatchObject({ placeId: SURVIVOR, sortOrder: 1 });
    expect(h.areaStore.get("m-2")).toMatchObject({ placeId: SURVIVOR, sortOrder: 2 });
    expect(h.calls.indexOf("arrivalAreas.movePlaceAreas")).toBeLessThan(
      h.calls.indexOf("placeMerge.deletePlace"),
    );
    expect(out.moved.arrivalAreas).toBe(2);
  });

  it("writes one audit row per moved area (before and after), and the merge row names them", async () => {
    const h = harness({ areas: [area("m-1"), area("m-2", { sortOrder: 1 })] });
    await mergePlaces(h.deps, input);

    const entries = h.audit.log.mock.calls.map(
      ([e]) => e as { entity: string; entityId: string; action: string; data: any },
    );
    const moved = entries.filter((e) => e.action === "arrival_area.moved_for_place_merge");
    expect(moved.map((e) => e.entityId)).toEqual(["m-1", "m-2"]);
    expect(moved[0]).toMatchObject({
      entity: "arrival_area",
      data: {
        actorHumanId: ACTOR,
        via: "place_merge",
        mergedId: MERGED,
        survivorId: SURVIVOR,
        before: { id: "m-1", placeId: MERGED },
        after: { id: "m-1", placeId: SURVIVOR },
      },
    });
    const merge = entries.find((e) => e.action === "place.merged");
    expect(merge?.data.arrivalAreas).toEqual({
      movedIds: ["m-1", "m-2"],
      disabledIds: [],
      removedHideIds: [],
    });
  });

  it("an event hide of a moved area keeps pointing at it", async () => {
    const h = harness({
      areas: [area("m-1")],
      hides: [{ eventId: "ev-1", arrivalAreaId: "m-1" }],
    });
    await mergePlaces(h.deps, input);

    // The cleanup ran once for every moved event, against the survivor,
    // after the move, and kept it.
    expect(h.arrivalAreas.deleteHidesForEventsNotInPlace).toHaveBeenCalledTimes(1);
    expect(h.arrivalAreas.deleteHidesForEventsNotInPlace).toHaveBeenCalledWith(
      ["ev-1", "ev-2"],
      SURVIVOR,
    );
    expect(h.arrivalAreas.deleteHidesForEventNotInPlace).not.toHaveBeenCalled();
    expect(h.calls.indexOf("arrivalAreas.movePlaceAreas")).toBeLessThan(
      h.calls.indexOf("arrivalAreas.deleteHidesForEventsNotInPlace"),
    );
    expect(h.hides).toEqual([{ eventId: "ev-1", arrivalAreaId: "m-1" }]);
    const actions = h.audit.log.mock.calls.map(([e]) => (e as { action: string }).action);
    expect(actions).not.toContain("arrival_area_hides.removed_for_location_change");
  });

  it("a stale hide on a moved event goes in the one batch, audited per event", async () => {
    const h = harness({
      areas: [area("elsewhere", { placeId: OTHER_PLACE })],
      hides: [
        { eventId: "ev-1", arrivalAreaId: "elsewhere" },
        { eventId: "ev-survivor", arrivalAreaId: "elsewhere" },
      ],
    });
    const out = await mergePlaces(h.deps, input);
    // The survivor's own event is not a moved event: its hide is not touched.
    expect(h.hides).toEqual([{ eventId: "ev-survivor", arrivalAreaId: "elsewhere" }]);
    const removed = h.audit.log.mock.calls
      .map(([e]) => e as { entityId: string; action: string; data: any })
      .filter((e) => e.action === "arrival_area_hides.removed_for_location_change");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      entityId: "ev-1",
      data: {
        arrivalAreaIds: ["elsewhere"],
        from: { placeId: MERGED },
        to: { placeId: SURVIVOR },
        via: "place_merge",
      },
    });
    expect(out.moved.arrivalAreas).toBe(0);
  });

  it("queries do not scale with the moved events: 1,500 events, none with areas", async () => {
    const events = Array.from({ length: 1_500 }, (_, i) => `ev-${i}`);
    const h = harness({ repointed: { events } });
    const out = await mergePlaces(h.deps, input);
    expect(out.eventArrivalAreasSwitchedOff).toBe(0);
    expect(h.arrivalAreas.listForEvent).not.toHaveBeenCalled();
    expect(h.arrivalAreas.update).not.toHaveBeenCalled();
    expect(h.arrivalAreas.deleteHidesForEventNotInPlace).not.toHaveBeenCalled();
    // One read after the repoint (plus the plan's one), one batched delete.
    expect(
      h.calls.filter((c) => c === "arrivalAreas.listEventAreasAtPlace"),
    ).toHaveLength(1);
    expect(h.arrivalAreas.listEventAreasAtPlace).toHaveBeenCalledWith(MERGED);
    expect(h.arrivalAreas.listForEvents).toHaveBeenCalledTimes(1);
    expect(
      [...(h.arrivalAreas.listForEvents.mock.calls[0]![0] as string[])].sort(),
    ).toEqual([...events].sort());
    expect(h.arrivalAreas.deleteHidesForEventsNotInPlace).toHaveBeenCalledTimes(1);
  });

  it("a moved event's own areas stay on inside 3 km of the survivor's pin; outside, they switch off, audited", async () => {
    const far = offset(PIN.lat, PIN.lng, 0, 5_000);
    const h = harness({
      areas: [
        area("e-near", { placeId: null, eventId: "ev-1" }),
        area("e-far", {
          placeId: null,
          eventId: "ev-1",
          geometry: squareAt(far.lat, far.lng),
        }),
        // Not an event the merge moved: never touched.
        area("e-other", {
          placeId: null,
          eventId: "ev-elsewhere",
          geometry: squareAt(far.lat, far.lng),
        }),
        // The survivor's own event: the merge did not move it, so it is
        // never read, let alone switched off.
        area("e-survivor-far", {
          placeId: null,
          eventId: "ev-survivor",
          geometry: squareAt(far.lat, far.lng),
        }),
      ],
    });
    await mergePlaces(h.deps, input);

    expect(h.areaStore.get("e-near")?.disabledAt).toBeNull();
    expect(h.areaStore.get("e-far")?.disabledAt).toEqual(NOW);
    expect(h.areaStore.get("e-other")?.disabledAt).toBeNull();
    expect(h.areaStore.get("e-survivor-far")?.disabledAt).toBeNull();
    // The post-merge read names only the moved events, never the survivor's.
    expect(h.arrivalAreas.listForEvents).toHaveBeenCalledTimes(1);
    expect(
      [...(h.arrivalAreas.listForEvents.mock.calls[0]![0] as string[])].sort(),
    ).toEqual(["ev-1", "ev-2"]);
    expect(h.arrivalAreas.listEventAreasAtPlace).not.toHaveBeenCalledWith(SURVIVOR);
    const off = h.audit.log.mock.calls
      .map(([e]) => e as { entityId: string; action: string; data: any })
      .filter((e) => e.action === "arrival_areas.disabled_for_location_change");
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({
      entityId: "ev-1",
      data: {
        actorHumanId: ACTOR,
        arrivalAreaIds: ["e-far"],
        from: { placeId: MERGED },
        to: { placeId: SURVIVOR },
        via: "place_merge",
        reason: "outside_survivor_envelope",
      },
    });
  });

  it("a switch-off that loses its compare-and-set rolls the merge back as PLACE_MERGE_RETRY", async () => {
    const far = offset(PIN.lat, PIN.lng, 0, 5_000);
    const h = harness({
      areas: [
        area("e-far", {
          placeId: null,
          eventId: "ev-1",
          geometry: squareAt(far.lat, far.lng),
        }),
      ],
      areaConflicts: ["e-far"],
    });
    await expect(mergePlaces(h.deps, input)).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "PLACE_MERGE_RETRY" },
    });
    expect(h.calls).not.toContain("placeMerge.deletePlace");
  });

  it("over the limit together → ARRIVAL_AREA_LIMIT naming every area by side; nothing written", async () => {
    const h = harness({
      areas: [...many(6, SURVIVOR, "s"), ...many(5, MERGED, "m")],
    });
    await expectBlocked(h, "ARRIVAL_AREA_LIMIT", 11);
    const err = (await mergePlaces(h.deps, input).catch((e: unknown) => e)) as {
      meta: { blockers: Array<{ code: string; arrivalAreas?: unknown[]; limit?: number }> };
    };
    const blocker = err.meta.blockers.find((b) => b.code === "ARRIVAL_AREA_LIMIT");
    expect(blocker?.limit).toBe(10);
    expect(blocker?.arrivalAreas).toHaveLength(11);
    expect(blocker?.arrivalAreas?.[0]).toEqual({
      id: "s-0",
      placeId: SURVIVOR,
      side: "survivor",
      kind: "PARKING",
      label: "s 0",
    });
    expect(blocker?.arrivalAreas?.[6]).toMatchObject({ id: "m-0", side: "merged", placeId: MERGED });
    expect(h.arrivalAreas.movePlaceAreas).not.toHaveBeenCalled();
  });

  it("the limit is re-checked under the merge lock: the read follows lockForMerge", async () => {
    const h = harness({
      areas: [...many(6, SURVIVOR, "s"), ...many(5, MERGED, "m")],
    });
    await mergePlaces(h.deps, input).catch(() => undefined);
    expect(h.calls.indexOf("placeMerge.lockForMerge")).toBeLessThan(
      h.calls.indexOf("arrivalAreas.listForPlaces"),
    );
  });

  it("exactly at the limit merges", async () => {
    const h = harness({
      areas: [...many(6, SURVIVOR, "s"), ...many(4, MERGED, "m")],
    });
    const out = await mergePlaces(h.deps, input);
    expect(out.moved.arrivalAreas).toBe(4);
  });

  it("previewPlaceMerge shows the same blocker and the move count, read-only", async () => {
    const over = harness({
      areas: [...many(6, SURVIVOR, "s"), ...many(5, MERGED, "m")],
    });
    const blocked = await previewPlaceMerge(over.deps, input);
    expect(blocked.canMerge).toBe(false);
    expect(blocked.blockers).toEqual([
      expect.objectContaining({ code: "ARRIVAL_AREA_LIMIT", count: 11, limit: 10 }),
    ]);
    expect(blocked.moves.arrivalAreas).toBe(5);
    expect(over.calls.filter((c) => WRITE_CALLS.includes(c))).toEqual([]);

    const fine = harness({ areas: many(3, MERGED, "m") });
    const ok = await previewPlaceMerge(fine.deps, input);
    expect(ok.canMerge).toBe(true);
    expect(ok.moves.arrivalAreas).toBe(3);
  });

  describe("a non-active merged place's areas become public (MERGED_PLACE_AREAS_BECOME_PUBLIC)", () => {
    const publicWarning = (warnings: Array<{ code: string }>) =>
      warnings.find((w) => w.code === "MERGED_PLACE_AREAS_BECOME_PUBLIC");

    it.each(["SUSPENDED", "ARCHIVED"] as const)(
      "a %s merged place: the preview warns with the switched-on areas, and the merge carries the same warning",
      async (status) => {
        const setup = () => ({
          merged: side(MERGED, { place: { status } }),
          areas: [
            area("m-1"),
            area("m-2", { sortOrder: 1 }),
            // Switched off: stays hidden after the move, so not counted.
            area("m-off", { sortOrder: 2, disabledAt: AREA_AT }),
            // The survivor's own area: already public.
            area("s-1", { placeId: SURVIVOR }),
          ],
        });
        const p = harness(setup());
        const preview = await previewPlaceMerge(p.deps, input);
        expect(publicWarning(preview.warnings)).toEqual({
          code: "MERGED_PLACE_AREAS_BECOME_PUBLIC",
          count: 2,
          ids: ["m-1", "m-2"],
        });
        expect(preview.blockers).toEqual([]);
        expect(p.calls.filter((c) => WRITE_CALLS.includes(c))).toEqual([]);

        const out = await mergePlaces(harness(setup()).deps, input);
        expect(publicWarning(out.warnings)).toEqual(publicWarning(preview.warnings));
      },
    );

    it("caps the ids at 20 and keeps the full count", async () => {
      const areas = Array.from({ length: 25 }, (_, i) =>
        area(`m-${String(i).padStart(2, "0")}`, { sortOrder: i }),
      );
      const h = harness({
        merged: side(MERGED, { place: { status: "SUSPENDED" } }),
        areas,
      });
      const preview = await previewPlaceMerge(h.deps, input);
      const warning = publicWarning(preview.warnings) as
        | { count: number; ids: string[] }
        | undefined;
      expect(warning?.count).toBe(25);
      expect(warning?.ids).toEqual(areas.slice(0, 20).map((a) => a.id));
    });

    it("no warning for an ACTIVE merged place, or a non-active one with no switched-on area", async () => {
      const active = await previewPlaceMerge(
        harness({ areas: [area("m-1")] }).deps,
        input,
      );
      expect(publicWarning(active.warnings)).toBeUndefined();

      const onlyOff = await previewPlaceMerge(
        harness({
          merged: side(MERGED, { place: { status: "ARCHIVED" } }),
          areas: [area("m-off", { disabledAt: AREA_AT })],
        }).deps,
        input,
      );
      expect(publicWarning(onlyOff.warnings)).toBeUndefined();

      const none = await previewPlaceMerge(
        harness({ merged: side(MERGED, { place: { status: "ARCHIVED" } }) }).deps,
        input,
      );
      expect(publicWarning(none.warnings)).toBeUndefined();
    });

    it("counts only what the survivor's page shows the public: parking and drop-off, never load-in", async () => {
      const preview = await previewPlaceMerge(
        harness({
          merged: side(MERGED, { place: { status: "SUSPENDED" } }),
          areas: [
            area("m-park"),
            area("m-drop", { kind: "ACCESSIBLE_DROP_OFF", sortOrder: 1 }),
            area("m-load", { kind: "LOAD_IN", sortOrder: 2 }),
          ],
        }).deps,
        input,
      );
      expect(publicWarning(preview.warnings)).toEqual({
        code: "MERGED_PLACE_AREAS_BECOME_PUBLIC",
        count: 2,
        ids: ["m-park", "m-drop"],
      });
    });

    it("a load-in-only merged place: no warning (the public never sees load-in)", async () => {
      const preview = await previewPlaceMerge(
        harness({
          merged: side(MERGED, { place: { status: "ARCHIVED" } }),
          areas: [area("m-load", { kind: "LOAD_IN" })],
        }).deps,
        input,
      );
      expect(publicWarning(preview.warnings)).toBeUndefined();
    });

    it("a survivor that withholds its address: no warning (its page shows no areas)", async () => {
      const preview = await previewPlaceMerge(
        harness({
          survivor: side(SURVIVOR, { place: { locationMode: "OBSCURED" } }),
          merged: side(MERGED, {
            place: { status: "SUSPENDED", locationMode: "OBSCURED" },
          }),
          areas: [area("m-park"), area("m-drop", { kind: "ACCESSIBLE_DROP_OFF" })],
        }).deps,
        input,
      );
      expect(publicWarning(preview.warnings)).toBeUndefined();
    });

    it("a non-active survivor is a blocker, not this warning", async () => {
      const preview = await previewPlaceMerge(
        harness({
          survivor: side(SURVIVOR, { place: { status: "SUSPENDED" } }),
          merged: side(MERGED, { place: { status: "SUSPENDED" } }),
          areas: [area("m-1")],
        }).deps,
        input,
      );
      expect(preview.blockers.map((b) => b.code)).toContain("SURVIVOR_NOT_ACTIVE");
      expect(publicWarning(preview.warnings)).toBeUndefined();
    });
  });

  describe("event areas the merge switches off (FR-014), preview and merge agree", () => {
    const far = offset(PIN.lat, PIN.lng, 0, 5_000);
    const eventAreas = () => [
      area("e-near", { placeId: null, eventId: "ev-1" }),
      area("e-far", {
        placeId: null,
        eventId: "ev-2",
        geometry: squareAt(far.lat, far.lng),
      }),
      // Already off: not switched off again, not counted.
      area("e-far-off", {
        placeId: null,
        eventId: "ev-1",
        sortOrder: 1,
        geometry: squareAt(far.lat, far.lng),
        disabledAt: AREA_AT,
      }),
      // An event the merge does not move.
      area("e-other", {
        placeId: null,
        eventId: "ev-elsewhere",
        geometry: squareAt(far.lat, far.lng),
      }),
    ];
    const warningOf = (warnings: Array<{ code: string }>) =>
      warnings.find((w) => w.code === "EVENT_ARRIVAL_AREAS_SWITCH_OFF");

    it("the preview warns of the far areas, read-only; the merge switches off exactly those", async () => {
      const p = harness({ areas: eventAreas() });
      const preview = await previewPlaceMerge(p.deps, input);
      expect(warningOf(preview.warnings)).toEqual({
        code: "EVENT_ARRIVAL_AREAS_SWITCH_OFF",
        count: 1,
        ids: ["e-far"],
        survivorHasPin: true,
      });
      expect(p.calls.filter((c) => WRITE_CALLS.includes(c))).toEqual([]);
      expect(p.arrivalAreas.update).not.toHaveBeenCalled();

      const m = harness({ areas: eventAreas() });
      const out = await mergePlaces(m.deps, input);
      const switchedOff = [...m.areaStore.values()]
        .filter((row) => row.disabledAt?.getTime() === NOW.getTime())
        .map((row) => row.id);
      expect(switchedOff).toEqual(["e-far"]);
      expect(out.eventArrivalAreasSwitchedOff).toBe(1);
      expect(warningOf(out.warnings)).toEqual(warningOf(preview.warnings));
    });

    it("no warning when nothing would switch off", async () => {
      const h = harness({ areas: [area("e-near", { placeId: null, eventId: "ev-1" })] });
      const preview = await previewPlaceMerge(h.deps, input);
      expect(warningOf(preview.warnings)).toBeUndefined();
      const out = await mergePlaces(harness({ areas: [area("e-near", { placeId: null, eventId: "ev-1" })] }).deps, input);
      expect(out.eventArrivalAreasSwitchedOff).toBe(0);
    });

    it("the survivor's pin is the one after the fill: a pin-less survivor takes the merged pin", async () => {
      const setup = {
        survivor: side(SURVIVOR, { place: { lat: null, lng: null } }),
        areas: eventAreas(),
      };
      const preview = await previewPlaceMerge(harness(setup).deps, input);
      // The merged row's pin (36.15, -86.81) fills in: only e-far is out.
      expect(warningOf(preview.warnings)).toMatchObject({
        count: 1,
        ids: ["e-far"],
        survivorHasPin: true,
      });
      const out = await mergePlaces(harness(setup).deps, input);
      expect(out.eventArrivalAreasSwitchedOff).toBe(1);
    });

    it("no pin on either side: every switched-on event area is counted, and switched off", async () => {
      const setup = {
        survivor: side(SURVIVOR, { place: { lat: null, lng: null } }),
        merged: side(MERGED, { place: { lat: null, lng: null } }),
        areas: eventAreas(),
      };
      const preview = await previewPlaceMerge(harness(setup).deps, input);
      expect(warningOf(preview.warnings)).toMatchObject({
        count: 2,
        ids: ["e-near", "e-far"],
        survivorHasPin: false,
      });
      const m = harness(setup);
      // The filled survivor row has no point either.
      m.places.getById.mockImplementation((async (id: string) => ({
        id,
        name: "Springwater Supper Club",
        lat: null,
        lng: null,
        locationMode: "EXACT",
        locationRadiusMeters: null,
        locationLabel: null,
      })) as never);
      const out = await mergePlaces(m.deps, input);
      expect(out.eventArrivalAreasSwitchedOff).toBe(2);
      expect(m.areaStore.get("e-near")?.disabledAt).toEqual(NOW);
      expect(m.areaStore.get("e-other")?.disabledAt).toBeNull();
    });
  });
});
