import { vi } from "vitest";

import type { PlaceRecord } from "@th/ports/repos/places";
import type { PlaceOwnershipRecord } from "@th/types/repos/place-verification";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { ok } from "@th/ports/search/types";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createPlaceNameFinderFake } from "@th/test-utils/fakes/place-name-finder";
import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

import type { CreateCommunityPlaceDeps } from "../create-community-place";
import {
  ADMIN_ID,
  MODERATOR_ID,
  NOW,
  makeClock,
  makeContentFilter,
  makeStaffAuthz,
} from "./helpers";

/**
 * A shared harness for the three community-place use cases. The places
 * table is STATEFUL and its `upsert` mirrors the Prisma adapter's
 * omitted-means-preserve contract (undefined skips a column, null writes
 * NULL), so a test can see what a write would leave behind. The name finder
 * is the shared fake that applies the adapter's SQL filter.
 */

export const NEW_PLACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const EXISTING_PLACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const OTHER_PLACE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const PIN = { lat: 36.1186, lng: -86.7553 };

export const ADDRESS = {
  formatted: "2190A Nolensville Pike, Nashville, TN 37211, USA",
  line1: "2190A Nolensville Pike",
  city: "Nashville",
  region: "TN",
  postalCode: "37211",
  countryCode: "us",
  lat: PIN.lat,
  lng: PIN.lng,
};

export function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  const formattedAddress =
    overrides.formattedAddress !== undefined
      ? overrides.formattedAddress
      : "Somewhere else entirely";
  return {
    id: EXISTING_PLACE_ID,
    name: "Corner Bar South",
    createdAt: NOW,
    updatedAt: NOW,
    formattedAddress,
    addressLine1: null,
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37211",
    countryCode: "US",
    capacity: null,
    lat: PIN.lat,
    lng: PIN.lng,
    phone: null,
    website: null,
    websiteSource: "USER_STUB",
    addressHash: formattedAddress ? formattedAddress.toLowerCase() : null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: "America/Chicago",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
    listedInDirectory: false,
    acceptsBookingRequests: false,
    acceptsCommunityListings: false,
    attendeeReviewsPublic: false,
    communityReviewsEnabled: true,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    ...overrides,
  } as PlaceRecord;
}

type UpsertCall = {
  placeId?: string | null;
  owner?: unknown;
  name: string;
  address: {
    formatted: string;
    line1?: string;
    line2?: string | null;
    city?: string | null;
    region?: string | null;
    postalCode?: string | null;
    countryCode?: string;
  };
  geo?: { lat?: number | null; lng?: number | null } | null;
  [key: string]: unknown;
};

/** undefined = keep `current`; anything else (null included) is written. */
function keep<T>(next: T | undefined, current: T): T {
  return next === undefined ? current : next;
}

export function makeSearchFake() {
  return {
    ensureIndexes: vi.fn(async () => ok(undefined)),
    upsertDocuments: vi.fn(async ({ documents }: { documents: unknown[] }) =>
      ok({ indexed: documents.length }),
    ),
    deleteDocuments: vi.fn(async () => ok(undefined)),
    getStats: vi.fn(async () => ok({} as never)),
    autocomplete: vi.fn(async () => ok({} as never)),
  };
}

export type HarnessOptions = {
  /** Rows already in the table. */
  places?: PlaceRecord[];
  roles?: Record<string, string[]>;
  timezoneLookup?: CreateCommunityPlaceDeps["timezoneLookup"];
  blocked?: string[];
  /** Verified, unrevoked owner per placeId. */
  verifiedOwners?: Record<string, PlaceOwnershipRecord>;
  /** Non-revoked PROVISIONAL claim per placeId (a claim in review). */
  provisionalClaims?: Record<string, PlaceOwnershipRecord>;
  /** Places an organiser's LIVE (OWNED, PUBLISHED, not ended) event uses. */
  ownedEventPlaceIds?: string[];
  /** Audit rows already in the log (e.g. who archived a place). */
  auditSeed?: Array<{ entityId: string; action: string; at: Date }>;
  /** Live published community listings per placeId. */
  liveListingCounts?: Record<string, number>;
  /** Runs inside `lockPlaceName` (a competing write committing). */
  onNameLock?: (normalizedName: string) => void;
  /** Runs inside `lockPlaceForClaim` (a claim verified meanwhile). */
  onClaimLock?: (placeId: string) => void;
  withSearch?: boolean;
};

export function buildHarness(options: HarnessOptions = {}) {
  const rows = new Map<string, PlaceRecord>();
  for (const place of options.places ?? []) rows.set(place.id, place);
  const verifiedOwners = new Map(Object.entries(options.verifiedOwners ?? {}));
  const provisionalClaims = new Map(
    Object.entries(options.provisionalClaims ?? {}),
  );
  const ownedEventPlaceIds = new Set(options.ownedEventPlaceIds ?? []);
  const liveListingCounts = new Map(
    Object.entries(options.liveListingCounts ?? {}),
  );
  const order: string[] = [];

  const finder = createPlaceNameFinderFake(() => [...rows.values()], {
    onLock: (name) => {
      order.push(`lockPlaceName:${name}`);
      options.onNameLock?.(name);
    },
  });

  const placesRepo = {
    upsert: vi.fn(async (input: UpsertCall) => {
      order.push("upsert");
      const id = input.placeId ?? NEW_PLACE_ID;
      const current = rows.get(id) ?? makePlace({ id, timezone: null });
      const formatted = input.address.formatted.trim();
      const record: PlaceRecord = {
        ...current,
        id,
        name: input.name,
        formattedAddress: formatted,
        addressHash: formatted ? formatted.toLowerCase() : null,
        addressLine1: keep(input.address.line1, current.addressLine1),
        addressLine2: keep(input.address.line2, current.addressLine2),
        city: keep(input.address.city, current.city),
        region: keep(input.address.region, current.region),
        postalCode: keep(input.address.postalCode, current.postalCode),
        countryCode: keep(input.address.countryCode, current.countryCode),
        ...("geo" in input
          ? { lat: input.geo?.lat ?? null, lng: input.geo?.lng ?? null }
          : {}),
        capacity: keep(input.capacity as number | null | undefined, current.capacity),
        phone: keep(input.phone as string | null | undefined, current.phone),
        website: keep(input.website as string | null | undefined, current.website),
        websiteSource: keep(
          input.websiteSource as PlaceRecord["websiteSource"] | undefined,
          current.websiteSource,
        ),
        status: keep(input.status as PlaceRecord["status"] | undefined, current.status),
        listedInDirectory: keep(
          input.listedInDirectory as boolean | undefined,
          current.listedInDirectory,
        ),
        locationMode: keep(
          input.locationMode as PlaceRecord["locationMode"] | undefined,
          current.locationMode,
        ),
        // The adapter writes an ownership row only for a non-null owner.
      };
      rows.set(id, record);
      return record;
    }),
    getById: vi.fn(async (id: string) => rows.get(id) ?? null),
    setStatus: vi.fn(
      async (input: { placeId: string; status: PlaceRecord["status"] }) => {
        order.push(`setStatus:${input.status}`);
        const row = rows.get(input.placeId);
        if (!row) throw new Error(`no place ${input.placeId}`);
        const next = { ...row, status: input.status };
        rows.set(input.placeId, next);
        return next;
      },
    ),
    updateTaxRate: vi.fn(
      async (input: { id: string; admissionTaxRateBps: number | null }) => {
        const row = rows.get(input.id);
        if (row) {
          rows.set(input.id, {
            ...row,
            admissionTaxRateBps: input.admissionTaxRateBps,
          });
        }
      },
    ),
    updateTimezone: vi.fn(async (input: { id: string; timezone: string }) => {
      const row = rows.get(input.id);
      if (row) rows.set(input.id, { ...row, timezone: input.timezone });
    }),
    getVerifiedOwnershipForPlace: vi.fn(
      async (placeId: string) => verifiedOwners.get(placeId) ?? null,
    ),
    listActiveOwnershipsForPlace: vi.fn(async (placeId: string) =>
      [verifiedOwners.get(placeId), provisionalClaims.get(placeId)].filter(
        (row): row is PlaceOwnershipRecord => row !== undefined,
      ),
    ),
    lockPlaceForClaim: vi.fn(async (placeId: string) => {
      order.push(`lockPlaceForClaim:${placeId}`);
      options.onClaimLock?.(placeId);
    }),
    findActiveExactByNormalizedName: finder.findActiveExactByNormalizedName,
    lockPlaceName: finder.lockPlaceName,
  };

  // `log` appends to an in-memory log `list` reads back, newest first, with
  // the adapter's contains-style `action` filter.
  type AuditRow = { entity: string; entityId: string; action: string; at: Date };
  const auditLog: AuditRow[] = (options.auditSeed ?? []).map((row) => ({
    entity: "place",
    ...row,
  }));
  const auditRepo = {
    log: vi.fn(
      async (entry: { entity: string; entityId?: string | null; action: string; at?: Date }) => {
        auditLog.push({
          entity: entry.entity,
          entityId: entry.entityId ?? "",
          action: entry.action,
          at: entry.at ?? NOW,
        });
      },
    ),
    list: vi.fn(
      async (input: {
        entityId?: string | null;
        action?: string | null;
        limit?: number;
        offset?: number;
      }) => {
        const matched = auditLog
          .map((row, seq) => ({ row, seq }))
          .filter(
            ({ row }) =>
              (!input.entityId || row.entityId === input.entityId) &&
              (!input.action || row.action.includes(input.action)),
          )
          // Newest first; a later append wins a tie on `at`.
          .sort((a, b) => b.row.at.getTime() - a.row.at.getTime() || b.seq - a.seq);
        // Paged like the adapter (`skip`/`take`), `total` over every match.
        const offset = input.offset ?? 0;
        const items = matched
          .slice(offset, offset + (input.limit ?? 25))
          .map(({ row }, i) => ({
            id: `audit-${i}`,
            ...row,
            data: null,
            actorHumanId: null,
          }));
        return { items, total: matched.length };
      },
    ),
  };
  const entityPagesRepo = {
    upsert: vi.fn(async (input: { slug: string; ownerId: string }) => ({
      id: "page-1",
      ...input,
    })),
    getByOwner: vi.fn(async () => null),
  };
  const spacesFake = createFakeSpacesRepo();
  const calendarsFake = createFakeCalendarsRepo({ spaces: spacesFake });

  // ONE object is both the repos and the tx repos: `tx(fn)` runs fn on it.
  const repos = {
    places: placesRepo,
    audit: auditRepo,
    entityPages: entityPagesRepo,
    spaces: spacesFake,
    calendars: calendarsFake,
    events: {
      lockLocationsAtPlace: vi.fn(
        async (input: { placeId: string; mode: "shared" | "exclusive" }) => {
          order.push(`lockLocationsAtPlace:${input.mode}`);
        },
      ),
      reprojectLocationForPlace: vi.fn(async () => [] as string[]),
      followPlaceAddress: vi.fn(async () => ({
        followedIds: [] as string[],
        skippedIds: [] as string[],
      })),
      hasOwnedLiveEventsAtPlace: vi.fn(
        async (input: { placeId: string; now: Date }) =>
          ownedEventPlaceIds.has(input.placeId),
      ),
      countLiveCommunityListingsAtPlace: vi.fn(
        async (input: { placeId: string; now: Date }) =>
          liveListingCounts.get(input.placeId) ?? 0,
      ),
    },
  } as Record<string, unknown>;
  repos.tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repos));
  // Adds the in-memory SearchReindexPending table and the fence surface the
  // real after-commit reindex needs.
  withSearchIndexFence(repos);

  const search = options.withSearch ? makeSearchFake() : undefined;
  const reportError = vi.fn();
  const taxRateLookup = {
    lookupByPostalCode: vi.fn(async () => ({ rateBps: 925, source: "ziptax" })),
  };
  const timezoneLookup =
    "timezoneLookup" in options
      ? options.timezoneLookup
      : vi.fn(() => "America/Chicago");

  const idempotency = createFakeIdempotencyPort();
  const deps: CreateCommunityPlaceDeps = {
    repos: repos as unknown as Repos,
    authz: makeStaffAuthz(
      options.roles ?? {
        [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
        [ADMIN_ID]: ["ADMIN"],
      },
    ) as unknown as CreateCommunityPlaceDeps["authz"],
    idempotency,
    clock: makeClock(),
    contentFilter: makeContentFilter(options.blocked ?? []),
    taxRateLookup:
      taxRateLookup as unknown as CreateCommunityPlaceDeps["taxRateLookup"],
    timezoneLookup: timezoneLookup ?? null,
    reportError,
    ...(search ? { search: search as unknown as MultiSearchPort } : {}),
  };

  const pending = (
    repos as { searchReindexPending: { mark: (...a: unknown[]) => unknown } }
  ).searchReindexPending;
  const markSpy = vi.spyOn(pending, "mark");

  return {
    deps,
    rows,
    order,
    finder,
    search,
    verifiedOwners,
    provisionalClaims,
    ownedEventPlaceIds,
    liveListingCounts,
    mocks: {
      placesRepo,
      auditRepo,
      entityPagesRepo,
      spacesFake,
      calendarsFake,
      taxRateLookup,
      reportError,
      idempotency,
      markSpy,
      tx: repos.tx as ReturnType<typeof vi.fn>,
      lockLocationsAtPlace: (repos.events as { lockLocationsAtPlace: ReturnType<typeof vi.fn> })
        .lockLocationsAtPlace,
    },
  };
}

export function auditRows(
  auditLog: { mock: { calls: unknown[][] } },
): Array<{ action: string; data: Record<string, unknown> }> {
  return auditLog.mock.calls.map(
    (call) => call[0] as { action: string; data: Record<string, unknown> },
  );
}

/** A claim in review: non-revoked, not yet verified. */
export function provisionalClaim(placeId: string): PlaceOwnershipRecord {
  return { ...verifiedOwnership(placeId), id: "ownership-2", verified: false };
}

export function verifiedOwnership(placeId: string): PlaceOwnershipRecord {
  return {
    id: "ownership-1",
    placeId,
    ownerType: "HUMAN",
    ownerId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    verified: true,
    revokedAt: null,
  } as unknown as PlaceOwnershipRecord;
}
