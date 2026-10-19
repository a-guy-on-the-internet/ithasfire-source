import { vi, type Mock } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";
import type { OrgMembership, OrgRole } from "@th/ports/repos/authz";
import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import type {
  EventsRepo,
  SaveEventInput,
  EventRecord,
} from "@th/ports/repos/events";
import type {
  HumanRecord,
  HumansRepo,
  HumanWithIdentity,
} from "@th/ports/repos/humans";
import type { Repos, TxOptions, TxRepos } from "@th/ports/repos";
import type {
  CreateEventChangeNoticeInput,
  EventChangeNoticeRecord,
} from "@th/ports/repos/event-change-notices";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import type {
  PlaceListItemRecord,
  PlaceRecord,
} from "@th/types/repos/places";
import type { SavedLocationRecord } from "@th/types/repos/saved-locations";

import {
  createFakeIdempotencyPort,
  type FakeIdempotencyPort,
} from "./idempotency";
import { createTestLogger } from "./logger";
import {
  createFakeBookingRequestMessagesRepo,
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
  type FakeCalendarsRepo,
  type FakeSpacesRepo,
} from "./venue-hierarchy";
import {
  eventsRepoPrototype,
  savedLocationsRepoPrototype,
  auditRepoPrototype,
  authzRepoPrototype,
  organizationsRepoPrototype,
  placesRepoPrototype,
  humansRepoPrototype,
  feePoliciesRepoPrototype,
  entityPagesRepoPrototype,
  eventTemplatesRepoPrototype,
  eventHumansRepoPrototype,
  humanDelegatesRepoPrototype,
  pendingObjectDeletionsRepoPrototype,
} from "./prototypes/repos";
import {
  createInMemorySearchIndexState,
  createInMemorySearchReindexPending,
} from "./search-reindex-pending";

type EventBody = Awaited<ReturnType<EventsRepo["getContent"]>>;

/** Fake tax rate lookup that returns a predictable US rate. */
export function createFakeTaxRateLookup() {
  return {
    lookupByPostalCode: vi.fn(
      async (_input: { postalCode: string; countryCode: string }) => ({
        rateBps: 875,
        source: "fake",
      }),
    ),
  };
}

export type CreateEventDeps = {
  repos: Repos;
  idempotency: FakeIdempotencyPort;
  clock: ClockPort;
  logger: LoggerPort;
  taxRateLookup: ReturnType<typeof createFakeTaxRateLookup>;
  /**
   * lat/lng → IANA zone (venue-hierarchy FR-004). Defaults to a stub that
   * returns `null` ("unknown"), which is the pre-existing behaviour for every
   * suite that does not care: the save falls through to the platform default
   * exactly as it did before the freeform derivation landed. Suites that DO
   * care pass an explicit `timezoneLookup`.
   */
  timezoneLookup: TimezoneLookupPort;
  /** Reporter for the deliberate swallow branches (throwing tz lookup). */
  reportError: ReporterPort;
  /**
   * `canManagePlace` (REQUIRED on the save / publish deps). Defaults to
   * "manages nothing", so every suite that does not care keeps the
   * third-party classification it always had; W1 / N2 suites pass
   * `canManagePlace` or override the mock.
   */
  authz: {
    canManagePlace: ReturnType<
      typeof vi.fn<
        (input: {
          actorHumanId: string;
          placeId: string;
        }) => Promise<{ allowed: boolean }>
      >
    >;
  };
};

type HumanStub = {
  id: string;
  name?: string | null;
  status?: "INVITED" | "ACTIVE" | "SUSPENDED" | "BANNED";
  roles?: string[];
};

type IdentityStub = {
  email: string;
  emailVerified?: boolean;
  phone?: string | null;
  phoneVerified?: boolean;
};

export type MakeCreateEventDepsOptions = {
  org?: OrganizationRecord | null;
  membership?: OrgMembership | null;
  membershipRole?: OrgRole;
  place?: PlaceRecord | null;
  savedLocation?: SavedLocationRecord | null;
  human?: HumanStub | null;
  identity?: IdentityStub | null;
  actorHumanId?: string;
  now?: Date;
  eventId?: string;
  existingEvent?: EventRecord | null;
  idempotencyBeginSequence?: boolean[];
  /**
   * lat/lng → IANA zone. Omit for the default stub (always `null` = unknown);
   * pass a function to exercise the freeform derivation, or one that THROWS to
   * exercise the swallow-and-report branch.
   */
  timezoneLookup?: TimezoneLookupPort;
  /**
   * Which places the actor MANAGES (`authz.canManagePlace`). Default: none.
   */
  canManagePlace?: (input: {
    actorHumanId: string;
    placeId: string;
  }) => boolean;
};

export type CreateEventTestContext = {
  deps: CreateEventDeps;
  mocks: {
    events: EventsRepo;
    savedLocations: typeof savedLocationsRepoPrototype;
    audit: typeof auditRepoPrototype;
    authz: typeof authzRepoPrototype;
    organizations: typeof organizationsRepoPrototype;
    places: typeof placesRepoPrototype;
    humans: typeof humansRepoPrototype;
    feePolicies: typeof feePoliciesRepoPrototype;
    entityPages: typeof entityPagesRepoPrototype;
    eventTemplates: typeof eventTemplatesRepoPrototype;
    eventHumans: typeof eventHumansRepoPrototype;
    /** Map-backed venue-hierarchy fakes — seed spaces/calendars for placement tests. */
    spaces: FakeSpacesRepo;
    calendars: FakeCalendarsRepo;
    /** The tx's change-notice outbox; `create` records every RESCHEDULED write. */
    eventChangeNotices: {
      create: Mock<
        [CreateEventChangeNoticeInput],
        Promise<EventChangeNoticeRecord>
      >;
    };
    logger: LoggerPort;
    idempotency: FakeIdempotencyPort;
    taxRateLookup: ReturnType<typeof createFakeTaxRateLookup>;
    timezoneLookup: TimezoneLookupPort;
    reportError: ReporterPort;
    /** The `canManagePlace` port (distinct from the `authz` REPO above). */
    authzPort: CreateEventDeps["authz"];
  };
  defaults: {
    now: Date;
    orgId: string;
    humanId: string;
    actorHumanId: string;
    eventId: string;
  };
};

const DEFAULT_PLACE_TEMPLATE: PlaceRecord = {
  id: "",
  name: "Test Place",
  slug: "test-place",
  formattedAddress: "123 Main St",
  addressLine1: "123 Main St",
  addressLine2: null,
  city: "City",
  region: "ST",
  postalCode: "12345",
  countryCode: "US",
  addressHash: "123 main st",
  admissionTaxRateBps: null,
  taxRateSource: null,
  taxRateFetchedAt: null,
  // Null = no address-derived zone (no coordinates, or the lookup failed) —
  // the same state a real un-geocoded Place row is in. Tests that exercise
  // venue-timezone inheritance pass an explicit `place` with one set.
  timezone: null,
  capacity: null,
  lat: null,
  lng: null,
  phone: null,
  website: null,
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  listedInDirectory: false,
  acceptsBookingRequests: false,
  orgIdsWithAccess: [],
  humanIdsWithAccess: [],
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

const DEFAULT_SAVED_LOCATION_TEMPLATE: SavedLocationRecord = {
  id: "",
  name: "Test Location",
  address: "123 Test St, City, ST 12345",
  countryCode: "US",
  region: "ST",
  locality: "City",
  postalCode: "12345",
  lat: null,
  lng: null,
  // Null = no address-derived zone, the state every pre-column SavedLocation
  // row is in. Suites exercising freeform-timezone inheritance pass an
  // explicit `savedLocation` with one set.
  timezone: null,
  ownerType: "ORGANIZATION",
  ownerId: "",
  usageCount: 0,
  admissionTaxRateBps: null,
  taxRateFetchedAt: null,
  taxRateSource: null,
};

export const DEFAULT_ORG_ID = "11111111-1111-4111-8111-111111111111";
export const DEFAULT_ACTOR_ID = "22222222-2222-4222-8222-222222222222";
export const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";
export const DEFAULT_SAVED_LOCATION_ID = "44444444-4444-4444-8444-444444444444";
export const DEFAULT_EVENT_ID = "55555555-5555-4555-8555-555555555555";
export const DEFAULT_NOW = new Date("2024-01-05T12:00:00.000Z");
export const DEFAULT_PRIMARY_AGREEMENT_ID =
  "66666666-6666-4666-8666-666666666666";
export const DEFAULT_RESALE_AGREEMENT_ID =
  "77777777-7777-4777-8777-777777777777";

export function makeCreateEventTestContext(
  options: MakeCreateEventDepsOptions = {},
): CreateEventTestContext {
  const now = options.now ?? DEFAULT_NOW;
  const eventId = options.eventId ?? DEFAULT_EVENT_ID;
  const orgId = options.org?.id ?? DEFAULT_ORG_ID;
  const actorHumanId =
    options.actorHumanId ?? options.membership?.humanId ?? DEFAULT_ACTOR_ID;
  const humanId = options.human?.id ?? actorHumanId;
  let currentEvent: EventRecord | null = Object.prototype.hasOwnProperty.call(
    options,
    "existingEvent",
  )
    ? (options.existingEvent ?? null)
    : null;
  let slugHistoryRecords: Array<{ slug: string; recordedAt: Date }> = [];

  // Event content storage isn't part of most test flows, but `EventsRepo` now
  // includes these methods so our default fakes must implement them.
  // `EventsRepo.getContent()` is expected to return `EventBody | null`.
  // Keep this value explicitly typed so Vitest's mock return type doesn't degrade to `{}`.
  let currentContent: EventBody | null = null;

  const organizationsRepo = {
    getById: vi.fn(async (id: string): Promise<OrganizationRecord | null> => {
      if (Object.prototype.hasOwnProperty.call(options, "org")) {
        return options.org ?? null;
      }
      return {
        id,
        name: "Org",
        slug: "org",
        status: "ACTIVE",
        defaultLocale: null,
      } satisfies OrganizationRecord;
    }),
    getByIds: vi.fn(async (): Promise<OrganizationRecord[]> => []),
    create: vi.fn(),
    addMember: vi.fn(),
    countMembersByRole: vi.fn(),
    listActive: vi.fn(async () => ({ items: [], total: 0 })),
    listMembers: vi.fn(async () => ({ items: [], total: 0 })),
    removeMember: vi.fn(async () => true),
    createInvitation: vi.fn(),
    isMemberByEmail: vi.fn(async () => false),
    getInvitationByToken: vi.fn(async () => null),
    getInvitationByOrgAndEmail: vi.fn(async () => null),
    listInvitations: vi.fn(async () => ({ items: [], total: 0 })),
    updateInvitationStatus: vi.fn(),
    update: vi.fn(),
  };

  const membershipValue = (() => {
    if (Object.prototype.hasOwnProperty.call(options, "membership")) {
      return options.membership ?? null;
    }
    const role = options.membershipRole ?? "ADMIN";
    return {
      orgId,
      humanId: actorHumanId,
      role,
    } satisfies OrgMembership;
  })();

  const authzRepo = {
    getOrgMembership: vi.fn(
      async (): Promise<OrgMembership | null> => membershipValue,
    ),
    listOrgMembershipsByHumanId: vi.fn(
      async ({ humanId: queryHumanId }: { humanId: string }) => {
        const membership = membershipValue;
        if (!membership) return [];
        return membership.humanId === queryHumanId ? [membership] : [];
      },
    ),

    getStaffRolesForHumanId: vi.fn(async () => []),
    getEventOrgId: vi.fn(),
    getEventHumanId: vi.fn(async () => null),
    getPlaceAccessContext: vi.fn(),
    isPlaceVerifiedForOrg: vi.fn(),
    getHumanDelegation: vi.fn(async () => null),
  };

  const humansRepo = {
    getById: vi.fn(async (id: string): Promise<HumanRecord | null> => {
      if (Object.prototype.hasOwnProperty.call(options, "human")) {
        const provided = options.human;
        if (!provided) {
          return null;
        }
        return {
          id: provided.id,
          name: provided.name ?? null,
          status: provided.status ?? "ACTIVE",
          roles: provided.roles ?? ["USER"],
          phone: null,
          billingAddressLine1: null,
          billingAddressLine2: null,
          billingCity: null,
          billingState: null,
          billingPostalCode: null,
          billingCountry: null,
          defaultPrimaryPayoutTermsId: null,
          defaultResalePayoutTermsId: null,
          trustTier: "NEW",
          trustBadgeLabel: null,
          trustBadgeIcon: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
      }
      return {
        id,
        name: null,
        status: "ACTIVE" as const,
        roles: ["USER"],
        phone: null,
        billingAddressLine1: null,
        billingAddressLine2: null,
        billingCity: null,
        billingState: null,
        billingPostalCode: null,
        billingCountry: null,
        defaultPrimaryPayoutTermsId: null,
        defaultResalePayoutTermsId: null,
        trustTier: "NEW" as const,
        trustBadgeLabel: null,
        trustBadgeIcon: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };
    }),
    getByIdWithIdentity: vi.fn(
      async (id: string): Promise<HumanWithIdentity | null> => {
        const human = await humansRepo.getById(id);
        if (!human) return null;
        return {
          human,
          identity: {
            authUserId: `auth-${id}`,
            email: options.identity?.email ?? "human@example.com",
            emailVerified: options.identity?.emailVerified ?? false,
            phone: options.identity?.phone ?? null,
            phoneVerified: options.identity?.phoneVerified ?? false,
            username: null,
            displayUsername: null,
            image: null,
          },
        };
      },
    ),
    getByEmail: vi.fn(async () => null as unknown as HumanWithIdentity | null),
    getByPhone: vi.fn(async () => null as unknown as HumanWithIdentity | null),
    getHumanIdForAuthUserId: vi.fn(async () => ({ humanId })),
    linkAuthUserToHuman: vi.fn(
      async ({ humanId: linkedHumanId }: { humanId: string }) => ({
        humanId: linkedHumanId,
      }),
    ),
    create: vi.fn(
      async () =>
        ({
          id: humanId,
          name: null,
          status: "ACTIVE" as const,
          roles: ["USER"],
          phone: null,
          billingAddressLine1: null,
          billingAddressLine2: null,
          billingCity: null,
          billingState: null,
          billingPostalCode: null,
          billingCountry: null,
          defaultPrimaryPayoutTermsId: null,
          defaultResalePayoutTermsId: null,
        }) as HumanRecord,
    ),
    update: vi.fn(
      async () =>
        ({
          id: humanId,
          name: null,
          status: "ACTIVE" as const,
          roles: ["USER"],
          phone: null,
          billingAddressLine1: null,
          billingAddressLine2: null,
          billingCity: null,
          billingState: null,
          billingPostalCode: null,
          billingCountry: null,
          defaultPrimaryPayoutTermsId: null,
          defaultResalePayoutTermsId: null,
        }) as HumanRecord,
    ),
    ensureByProvider: vi.fn(),
    ensureGuestHuman: vi.fn(),
    listForSearchIndex: vi.fn(async ({ limit = 100, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items: [],
        limit,
        offset,
        total: 0,
      }),
    ),
    listAllWithMemberships: vi.fn(async ({ limit = 25, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items: [],
        limit,
        offset,
        total: 0,
      }),
    ),
    batchLookupHumanIdsByEmail: vi.fn(async () => new Map<string, string>()),
    searchByQuery: vi.fn(async () => []),
  };

  const defaultPlace: PlaceRecord = {
    ...DEFAULT_PLACE_TEMPLATE,
    id: DEFAULT_PLACE_ID,
    orgIdsWithAccess: [orgId],
    humanIdsWithAccess: [humanId],
  };

  /**
   * The Place a `{ kind: "place" }` save resolves to — the same answer
   * `placesRepo.getById` gives, hoisted so the events fake can mirror the
   * adapter's "linking a place copies its address onto the event".
   */
  const resolvePlace = (): PlaceRecord | null => {
    if (Object.prototype.hasOwnProperty.call(options, "place")) {
      return options.place ?? null;
    }
    return defaultPlace;
  };

  const placesRepo = {
    getById: vi.fn(async (id: string): Promise<PlaceRecord | null> => {
      if (Object.prototype.hasOwnProperty.call(options, "place")) {
        return options.place ?? null;
      }
      return { ...defaultPlace, id } satisfies PlaceRecord;
    }),
    getBySlug: vi.fn(async (): Promise<PlaceRecord | null> => null),
    upsert: vi.fn(async () => ({ ...defaultPlace }) satisfies PlaceRecord),
    listAccessibleByHuman: vi.fn(async () =>
      buildOffsetPaginatedResult({
        items: [] as PlaceListItemRecord[],
        limit: 100,
        offset: 0,
        total: 0,
      }),
    ),
    listOwnedBySubject: vi.fn(async (): Promise<PlaceRecord[]> => []),
    listWithheldOwnedNearPoint: vi.fn(async (): Promise<PlaceRecord[]> => []),
    listAll: vi.fn(async ({ limit = 100, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items: [],
        limit,
        offset,
        total: 0,
      }),
    ),
    listForSearchIndex: vi.fn(async ({ limit = 100, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items: [],
        limit,
        offset,
        total: 0,
      }),
    ),
    listForSitemap: vi.fn(async () => []),
    countDirectory: vi.fn(async () => 0),
    getSlugContext: vi.fn(async () => null),
    assignSlug: vi.fn(async () => ({ ...defaultPlace }) satisfies PlaceRecord),
    recordSlugHistory: vi.fn(async () => {}),
    resolveBySlug: vi.fn(async () => null),
    updateTaxRate: vi.fn(async () => {}),
    // Mirrors the adapter's compare-and-set: writes ONLY while the row's cache
    // is empty AND it still has the postal code / country the lookup was for.
    // Mutates the resolved record so a suite can assert the row's end state.
    fillTaxRateIfUnset: vi.fn(
      async (input: {
        id: string;
        expectedPostalCode: string | null;
        expectedCountryCode: string | null;
        admissionTaxRateBps: number;
        taxRateSource: string;
        taxRateFetchedAt: Date;
      }): Promise<boolean> => {
        const record = resolvePlace();
        if (!record) return false;
        if (
          Object.prototype.hasOwnProperty.call(options, "place") &&
          record.id !== input.id
        ) {
          return false;
        }
        if (
          record.admissionTaxRateBps != null ||
          (record.postalCode ?? null) !== input.expectedPostalCode ||
          (record.countryCode ?? null) !== input.expectedCountryCode
        ) {
          return false;
        }
        record.admissionTaxRateBps = input.admissionTaxRateBps;
        record.taxRateSource = input.taxRateSource;
        record.taxRateFetchedAt = input.taxRateFetchedAt;
        return true;
      },
    ),
    deletePlace: vi.fn(),
    bulkCreate: vi.fn(),
    getVerifiedOwnershipForPlace: vi.fn(),
    lockPlaceForClaim: vi.fn(),
    findActiveExactByNormalizedName: vi.fn(async (): Promise<PlaceRecord[]> => []),
    lockPlaceName: vi.fn(async () => undefined),
    setStatus: vi.fn(),
    compareAndSetStatus: vi.fn(),
    setDirectoryListing: vi.fn(),
    setVerificationStatus: vi.fn(),
    setFlag: vi.fn(),
    setCommunityListingAcceptance: vi.fn(),
    getOwnershipById: vi.fn(),
    listActiveOwnershipsForPlace: vi.fn(),
    createVerifiedOwnership: vi.fn(),
    createProvisionalOwnership: vi.fn(),
    verifyOwnership: vi.fn(),
    revokeOwnership: vi.fn(),
    lockClaimsByActor: vi.fn(async () => undefined),
  };

  const defaultSavedLocation: SavedLocationRecord = {
    ...DEFAULT_SAVED_LOCATION_TEMPLATE,
    id: DEFAULT_SAVED_LOCATION_ID,
    ownerId: orgId,
  };

  const resolveSavedLocation = () => {
    if (Object.prototype.hasOwnProperty.call(options, "savedLocation")) {
      return options.savedLocation ?? null;
    }
    return defaultSavedLocation;
  };

  /** Rows `savedLocations.create` minted in this context, by id. */
  const mintedSavedLocations = new Map<string, SavedLocationRecord>();
  const rememberMintedSavedLocation = (
    record: SavedLocationRecord,
  ): SavedLocationRecord => {
    mintedSavedLocations.set(record.id, record);
    return record;
  };

  const savedLocationsRepo = {
    getById: vi.fn(async (id: string): Promise<SavedLocationRecord | null> => {
      const record = resolveSavedLocation();
      if (!record || record.id !== id) return null;
      return record;
    }),
    getAccessibleByOrg: vi.fn(
      async ({
        id,
        orgId: queryOrgId,
      }: {
        id: string;
        orgId: string;
      }): Promise<SavedLocationRecord | null> => {
        const record = resolveSavedLocation();
        if (!record || record.id !== id) {
          return null;
        }
        if (record.ownerType === "ORGANIZATION") {
          return record.ownerId === queryOrgId ? record : null;
        }
        if (record.ownerType === "HUMAN") {
          return membershipValue &&
            membershipValue.orgId === queryOrgId &&
            membershipValue.humanId === record.ownerId
            ? record
            : null;
        }
        return null;
      },
    ),
    getAccessibleByHuman: vi.fn(
      async ({
        id,
        humanId: queryHumanId,
      }: {
        id: string;
        humanId: string;
      }) => {
        const record = resolveSavedLocation();
        if (!record || record.id !== id) {
          return null;
        }
        if (record.ownerType === "HUMAN" && record.ownerId === queryHumanId) {
          return record;
        }
        return null;
      },
    ),
    incrementUsage: vi.fn(async () => {}),
    create: vi.fn(
      async (input: any): Promise<SavedLocationRecord> =>
        rememberMintedSavedLocation({
        id: crypto.randomUUID(),
        name: input.name,
        address: input.address,
        countryCode: input.countryCode ?? null,
        region: input.region ?? null,
        locality: input.locality ?? null,
        postalCode: input.postalCode ?? null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        // Mirror the real adapter: whatever the caller derived is what the row
        // stores, so a suite can assert the persisted zone off the returned
        // record as well as off the `create` call args.
        timezone: input.timezone ?? null,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        usageCount: 1,
        admissionTaxRateBps: null,
        taxRateFetchedAt: null,
        taxRateSource: null,
      }),
    ),
    findByOwnerAndAddress: vi.fn(async () => null),
    updateTaxRate: vi.fn(async () => {}),
    // Adapter compare-and-set mirror (see the places fake). Rows minted by
    // `create` are reachable here, as they are to the same transaction in
    // Postgres; `getById` deliberately still serves only the seeded row.
    fillTaxRateIfUnset: vi.fn(
      async (input: {
        id: string;
        expectedPostalCode: string | null;
        expectedCountryCode: string | null;
        admissionTaxRateBps: number;
        taxRateSource: string;
        taxRateFetchedAt: Date;
      }): Promise<boolean> => {
        const seeded = resolveSavedLocation();
        const record =
          mintedSavedLocations.get(input.id) ??
          (seeded && seeded.id === input.id ? seeded : null);
        if (
          !record ||
          record.admissionTaxRateBps != null ||
          (record.postalCode ?? null) !== input.expectedPostalCode ||
          (record.countryCode ?? null) !== input.expectedCountryCode
        ) {
          return false;
        }
        record.admissionTaxRateBps = input.admissionTaxRateBps;
        record.taxRateSource = input.taxRateSource;
        record.taxRateFetchedAt = input.taxRateFetchedAt;
        return true;
      },
    ),
  };

  const eventsRepo: EventsRepo = {
    getById: vi.fn(async (id: string) => {
      if (currentEvent && currentEvent.id === id) {
        return currentEvent;
      }
      return null;
    }),
    findManyByIds: vi.fn(async (ids: string[]) => {
      if (currentEvent && ids.includes(currentEvent.id)) {
        return [currentEvent];
      }
      return [];
    }),
    listTicketTypes: vi.fn(),
    ensureHostPermission: vi.fn(),
    getContent: vi.fn(
      async ({
        eventId: _eventId,
      }: {
        eventId: string;
      }): Promise<EventBody | null> => currentContent,
    ),
    updateContent: vi.fn(
      async ({
        eventId: _eventId,
        content,
      }: {
        eventId: string;
        content: unknown;
      }) => {
        currentContent = content as EventBody;
        if (!currentEvent) {
          throw new Error("event not found");
        }
        currentEvent = { ...currentEvent, content: currentContent };
        return currentEvent;
      },
    ),
    listPublishedByCountry: vi.fn(
      async (_input: {
        countryCode: string;
        limit?: number;
        offset?: number;
      }) => ({
        items: [],
        pageInfo: {
          total: 0,
          limit: 0,
          offset: 0,
          count: 0,
          hasNextPage: false,
          nextOffset: null,
        },
      }),
    ),
    listPublishedByPlace: vi.fn(
      async ({
        placeId: _placeId,
        limit = 25,
        offset = 0,
        stewardship,
      }: {
        placeId: string;
        limit?: number;
        offset?: number;
        stewardship?: "OWNED" | "COMMUNITY";
      }) => {
        // `stewardship` is honoured because the real adapter applies it in SQL
        // BEFORE `take`: a fake that answered with the fixture regardless
        // would be more permissive than production, which is exactly the
        // divergence that makes a green test meaningless. The remaining
        // filters (`venueConfirmedFor`, `includeDateOccurrences`,
        // `excludeVenueConfirmationWithdrawn`) are still ignored here, as
        // they always have been — this fake serves one fixture event.
        const matches =
          currentEvent &&
          (stewardship === undefined || currentEvent.stewardship === stewardship)
            ? [currentEvent]
            : [];
        return buildOffsetPaginatedResult({
          items: matches,
          limit,
          offset,
          total: matches.length,
        });
      },
    ),
    listPublishedByPlaceIds: vi.fn(
      async ({ placeIds }: { placeIds: string[] }) =>
        placeIds.length > 0 && currentEvent ? [currentEvent] : [],
    ),
    // The fixture event is single-date, so its occurrence set is the pinned
    // instant — the same fallback the real adapter applies to an event with no
    // EventDate rows.
    listPublishedOccurrencesByPlace: vi.fn(async () =>
      currentEvent
        ? [
            {
              eventId: currentEvent.id,
              eventDateId: null,
              title: currentEvent.title,
              startsAt: currentEvent.startsAt,
              endsAt: currentEvent.endsAt ?? null,
              // Unknown placement — the conservative default, and what every
              // pre-venue-hierarchy event actually carries.
              spaceId: null,
            },
          ]
        : [],
    ),
    // Venue-confirmation stamp (venue-confirmation spec): mirrors the
    // adapter's contract — binds the stamp to `input.placeId`, clears any
    // withdrawal, returns the updated row. The save path calls it for a
    // GRANT-HOLDER's event (confirmed by construction, not an owner). CAS
    // on the place like production: a mismatch is the adapter's typed
    // `event_place_mismatch`.
    setVenueConfirmation: vi.fn(
      async (input: {
        eventId: string;
        placeId: string;
        confirmedByHumanId: string;
        bookingRequestId: string | null;
        at: Date;
      }): Promise<EventRecord> => {
        if (!currentEvent || currentEvent.placeId !== input.placeId) {
          throw {
            code: "event_place_mismatch",
            message: "event_place_mismatch",
          } as const;
        }
        currentEvent = {
          ...currentEvent,
          venueConfirmedAt: input.at,
          venueConfirmedByHumanId: input.confirmedByHumanId,
          venueConfirmedPlaceId: input.placeId,
          venueConfirmationRequestId: input.bookingRequestId,
          venueConfirmationWithdrawnAt: null,
          venueConfirmationWithdrawnReason: null,
          // Like the adapter: the date the venue vouched for is the ROW's
          // own start at the moment of the stamp.
          venueConfirmedStartsAt: currentEvent.startsAt,
        };
        return currentEvent;
      },
    ),
    upsertDraft: vi.fn(async (input: SaveEventInput) => {
      // Which branch the REAL adapter would take. A truthy `eventId` routes to
      // `p.event.update`; only a null/undefined one creates a fresh row. The
      // fake has to know the difference because the two branches disagree
      // about slug / shortId / publishedAt, and getting that wrong makes tests
      // agree with each other and disagree with production.
      const isUpdate = Boolean(input.eventId);
      const record: EventRecord = {
        id: input.eventId ?? currentEvent?.id ?? eventId,
        orgId: input.orgId,
        humanId: input.humanId,
        title: input.title,
        status: input.status,
        attendanceMode: currentEvent?.attendanceMode ?? "TICKETED",
        stewardship: currentEvent?.stewardship ?? "OWNED",
        visibility: currentEvent?.visibility ?? "PRIVATE",
        gateType: currentEvent?.gateType ?? "NONE",
        locationMode:
          input.locationMode ?? currentEvent?.locationMode ?? "EXACT",
        locationRadiusMeters:
          input.locationRadiusMeters ??
          currentEvent?.locationRadiusMeters ??
          null,
        locationLabel:
          input.locationLabel ?? currentEvent?.locationLabel ?? null,
        addressRevealAt:
          input.addressRevealAt ?? currentEvent?.addressRevealAt ?? null,
        addressRevealPreset:
          input.addressRevealPreset ??
          currentEvent?.addressRevealPreset ??
          null,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        // `EventRecord.timezone` is a NON-nullable string and the real adapter
        // selects it back on every upsert. The fake used to omit the key
        // entirely, so every read of the "saved" row got `undefined` — which
        // silently reported the zone as CHANGED on a save that changed
        // nothing. Mirror the adapter: an explicit zone wins, otherwise the
        // stored one survives.
        timezone: input.timezone ?? currentEvent?.timezone ?? "UTC",
        placeId: null,
        savedLocationId: null,
        // Venue-hierarchy placement: Prisma patch semantics — an ABSENT key
        // leaves the stored value alone, an explicit null clears it. The real
        // adapter behaves this way, so the fake must too or the "untouched"
        // cases would pass here and fail in production.
        calendarId:
          input.calendarId !== undefined
            ? input.calendarId
            : (currentEvent?.calendarId ?? null),
        spaceId:
          input.spaceId !== undefined
            ? input.spaceId
            : (currentEvent?.spaceId ?? null),
        categoryId: currentEvent?.categoryId ?? null,
        addressText: null,
        countryCode: currentEvent?.countryCode ?? null,
        region: currentEvent?.region ?? null,
        locality: currentEvent?.locality ?? null,
        postalCode: currentEvent?.postalCode ?? null,
        lat: null,
        lng: null,
        content: Object.prototype.hasOwnProperty.call(input, "content")
          ? (input.content ?? null)
          : (currentEvent?.content ?? null),
        // A CREATE mints a fresh row, so it has neither — the adapter's create
        // branch never writes these columns and Prisma defaults them to null.
        // Carrying the previous event's slug forward would have hidden the
        // whole point of slug-at-create behind a fake that pretended the row
        // already had one.
        slug: isUpdate ? (currentEvent?.slug ?? null) : null,
        shortId: isUpdate ? (currentEvent?.shortId ?? null) : null,
        regionCode: currentEvent?.regionCode ?? null,
        defaultLocale: Object.prototype.hasOwnProperty.call(
          input,
          "defaultLocale",
        )
          ? (input.defaultLocale ?? null)
          : (currentEvent?.defaultLocale ?? null),
        // NEVER derived from `input.status`. The real `upsertDraft` does not
        // include `publishedAt` in its update payload at all, and `unpublish`
        // preserves it on purpose ("a historical timestamp, not a lifecycle
        // flag"). Deriving it here NULLED the field on any save of a
        // previously-published event that is back in DRAFT — the exact field
        // `publishEvent`'s `wasNeverPublished` and the performer share-link
        // gate read, so a test would have agreed with itself while production
        // did the opposite. Update: leave the stored value alone. Create: a
        // fresh row has none.
        publishedAt: isUpdate ? (currentEvent?.publishedAt ?? null) : null,
        agreementPrimaryId:
          currentEvent?.agreementPrimaryId ?? DEFAULT_PRIMARY_AGREEMENT_ID,
        payoutTermsId:
          currentEvent?.payoutTermsId ??
          currentEvent?.agreementPrimaryId ??
          DEFAULT_PRIMARY_AGREEMENT_ID,
        agreementResaleId: currentEvent?.agreementResaleId ?? null,
        resalePayoutTermsId:
          currentEvent?.resalePayoutTermsId ??
          currentEvent?.agreementResaleId ??
          null,
        listingPriority: currentEvent?.listingPriority ?? null,
        passwordHash: currentEvent?.passwordHash ?? null,
        passwordUpdatedAt: currentEvent?.passwordUpdatedAt ?? null,
        waitlistStatus: currentEvent?.waitlistStatus ?? "DISABLED",
        waitlistPublishAt: currentEvent?.waitlistPublishAt ?? null,
        waitlistDescription: currentEvent?.waitlistDescription ?? null,
        waitlistCap: currentEvent?.waitlistCap ?? null,
        placeLayoutId: currentEvent?.placeLayoutId ?? null,
        currency: currentEvent?.currency ?? null,
        admissionTaxRateBps: currentEvent?.admissionTaxRateBps ?? null,
        taxRateSource: currentEvent?.taxRateSource ?? null,
        // Venue-confirmation columns ride along on update exactly as the
        // adapter's returned row carries them: the held-dates settle reads
        // the stamp off the row the save just wrote.
        venueConfirmedAt: currentEvent?.venueConfirmedAt ?? null,
        venueConfirmedByHumanId: currentEvent?.venueConfirmedByHumanId ?? null,
        venueConfirmedPlaceId: currentEvent?.venueConfirmedPlaceId ?? null,
        venueConfirmationRequestId:
          currentEvent?.venueConfirmationRequestId ?? null,
        venueConfirmationWithdrawnAt:
          currentEvent?.venueConfirmationWithdrawnAt ?? null,
        venueConfirmationWithdrawnReason:
          currentEvent?.venueConfirmationWithdrawnReason ?? null,
        venueConfirmedStartsAt: currentEvent?.venueConfirmedStartsAt ?? null,
        instructionalAdmission:
          input.instructionalAdmission ??
          currentEvent?.instructionalAdmission ??
          false,
        createdAt: currentEvent?.createdAt ?? now,
        updatedAt: currentEvent?.updatedAt ?? now,
      };

      switch (input.location.kind) {
        case "place": {
          record.placeId = input.location.placeId;
          // Mirror the Prisma adapter: linking a Place COPIES its address
          // fields onto the event. Without this the fake produced an event
          // with a null countryCode for every place-linked save, which
          // silently no-op'd create-time slug assignment (it refuses to build
          // a slug with no country) in every test that uses this fake.
          const linkedPlace = resolvePlace();
          if (linkedPlace) {
            if (linkedPlace.city) record.locality = linkedPlace.city;
            if (linkedPlace.region) record.region = linkedPlace.region;
            if (linkedPlace.countryCode) {
              record.countryCode = linkedPlace.countryCode;
            }
            // The adapter never copies a WITHHELD place's postcode (its row
            // gets the public projection — place-address-withholding D1).
            if (linkedPlace.postalCode && linkedPlace.locationMode === "EXACT") {
              record.postalCode = linkedPlace.postalCode;
            }
          }
          break;
        }
        case "saved-location":
          // Deliberately does NOT copy address fields — neither does the real
          // adapter. `getSlugContext` follows the relation instead.
          record.savedLocationId = input.location.savedLocationId;
          break;
        case "freeform":
          record.addressText = input.location.addressText;
          record.lat = input.location.lat;
          record.lng = input.location.lng;
          // Same adapter mirror as the place branch, for typed addresses.
          if (input.location.locality) record.locality = input.location.locality;
          if (input.location.region) record.region = input.location.region;
          if (input.location.countryCode) {
            record.countryCode = input.location.countryCode;
          }
          if (input.location.postalCode) {
            record.postalCode = input.location.postalCode;
          }
          break;
        default:
          break;
      }

      currentEvent = record;
      return record;
    }),
    // Place-address-withholding D1: the advisory lock is a no-op in memory,
    // and no fake event is re-projected unless a test stubs it.
    lockLocationsAtPlace: vi.fn(async () => undefined),
    lockRows: vi.fn(async () => undefined),
    hasOwnedLiveEventsAtPlace: vi.fn(async () => false),
    countLiveCommunityListingsAtPlace: vi.fn(async () => 0),
    reprojectLocationForPlace: vi.fn(async () => [] as string[]),
    followPlaceAddress: vi.fn(async () => ({
      followedIds: [] as string[],
      skippedIds: [] as string[],
    })),
    publish: vi.fn(
      async ({
        eventId,
        publishedAt,
        currency,
      }: {
        eventId: string;
        publishedAt: Date;
        currency?: string;
      }) => {
        if (!currentEvent || currentEvent.id !== eventId) {
          throw new Error("event not found");
        }
        currentEvent = {
          ...currentEvent,
          status: "PUBLISHED",
          publishedAt,
          currency: currency ?? currentEvent.currency,
        };
        return currentEvent;
      },
    ),
    setCategory: vi.fn(
      async ({
        eventId,
        categoryId,
      }: {
        eventId: string;
        categoryId: string | null;
      }) => {
        if (!currentEvent || currentEvent.id !== eventId) {
          throw new Error("event not found");
        }
        currentEvent = {
          ...currentEvent,
          categoryId,
        };
        return currentEvent;
      },
    ),
    filterByCategory: vi.fn(async ({ limit = 25, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items: currentEvent ? [currentEvent] : [],
        limit,
        offset,
        total: currentEvent ? 1 : 0,
      }),
    ),
    listPublishedByRegion: vi.fn(async ({ limit = 25, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items: currentEvent ? [currentEvent] : [],
        limit,
        offset,
        total: currentEvent ? 1 : 0,
      }),
    ),
    listPublished: vi.fn(async ({ limit = 100, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items: currentEvent?.status === "PUBLISHED" ? [currentEvent] : [],
        limit,
        offset,
        total: currentEvent?.status === "PUBLISHED" ? 1 : 0,
      }),
    ),
    getPopularityStats: vi.fn(async (eventIds: string[]) =>
      eventIds.map((eventId) => ({
        eventId,
        ticketsSold: 0,
        waitlistCount: 0,
        totalCapacity: 0,
      })),
    ),
    setListingPriority: vi.fn(
      async ({
        eventId,
        priority,
      }: {
        eventId: string;
        priority: number | null;
      }) => {
        if (!currentEvent || currentEvent.id !== eventId) {
          throw new Error("event not found");
        }
        currentEvent = { ...currentEvent, listingPriority: priority };
        return currentEvent;
      },
    ),
    searchPublished: vi.fn(async () => (currentEvent ? [currentEvent] : [])),
    listPublishedForSitemap: vi.fn(async () =>
      currentEvent?.slug
        ? [
            {
              slug: currentEvent.slug,
              updatedAt: currentEvent.updatedAt ?? null,
            },
          ]
        : [],
    ),
    updateVisibility: vi.fn(
      async ({
        eventId,
        visibility,
      }: {
        eventId: string;
        visibility: EventRecord["visibility"];
      }) => {
        if (!currentEvent || currentEvent.id !== eventId) {
          throw new Error("event not found");
        }
        currentEvent = { ...currentEvent, visibility };
        return currentEvent;
      },
    ),
    updateGateType: vi.fn(
      async ({
        eventId,
        gateType,
      }: {
        eventId: string;
        gateType: EventRecord["gateType"];
      }) => {
        if (!currentEvent || currentEvent.id !== eventId) {
          throw new Error("event not found");
        }
        currentEvent = { ...currentEvent, gateType };
        return currentEvent;
      },
    ),
    updatePassword: vi.fn(
      async ({
        eventId,
        passwordHash,
        passwordUpdatedAt,
      }: {
        eventId: string;
        passwordHash: string | null;
        passwordUpdatedAt: Date;
      }) => {
        if (!currentEvent || currentEvent.id !== eventId) {
          throw new Error("event not found");
        }
        currentEvent = { ...currentEvent, passwordHash, passwordUpdatedAt };
        return currentEvent;
      },
    ),
    updateWaitlistSettings: vi.fn(
      async ({
        eventId,
        status,
        publishAt,
        description,
        cap,
      }: {
        eventId: string;
        status: EventRecord["waitlistStatus"];
        publishAt?: Date | null;
        description?: string | null;
        cap?: number | null;
      }) => {
        if (!currentEvent || currentEvent.id !== eventId) {
          throw new Error("event not found");
        }
        currentEvent = {
          ...currentEvent,
          waitlistStatus: status,
          waitlistPublishAt: publishAt ?? null,
          waitlistDescription: description ?? null,
          waitlistCap: cap ?? null,
        };
        return currentEvent;
      },
    ),
    getGateSettings: vi.fn(async (id: string) => {
      if (!currentEvent || currentEvent.id !== id) {
        return null;
      }
      return {
        eventId: currentEvent.id,
        visibility: currentEvent.visibility,
        gateType: currentEvent.gateType,
        passwordHash: currentEvent.passwordHash ?? null,
        passwordUpdatedAt: currentEvent.passwordUpdatedAt ?? null,
        waitlistStatus: currentEvent.waitlistStatus,
        waitlistPublishAt: currentEvent.waitlistPublishAt ?? null,
        waitlistDescription: currentEvent.waitlistDescription ?? null,
        waitlistCap: currentEvent.waitlistCap ?? null,
      };
    }),
    assignSlug: vi.fn(async ({ eventId, slug, shortId, regionCode }) => {
      if (!currentEvent || currentEvent.id !== eventId) {
        throw new Error("event not found");
      }
      currentEvent = { ...currentEvent, slug, shortId, regionCode };
      return currentEvent;
    }),
    updateSlug: vi.fn(async ({ eventId, slug, regionCode }) => {
      if (!currentEvent || currentEvent.id !== eventId) {
        throw new Error("event not found");
      }
      currentEvent = { ...currentEvent, slug, regionCode };
      return currentEvent;
    }),
    listSluggedPage: vi.fn(async ({ afterId, limit }) => {
      const ev = currentEvent;
      if (!ev?.slug || limit < 1) return [];
      if (afterId !== null && ev.id <= afterId) return [];
      return [
        {
          id: ev.id,
          slug: ev.slug,
          startsAt: ev.startsAt,
          timezone: ev.timezone,
          status: ev.status,
          createdAt: ev.createdAt ?? new Date(0),
        },
      ];
    }),
    getSlugDateRow: vi.fn(async (eventId: string) => {
      const ev = currentEvent;
      if (!ev?.slug || ev.id !== eventId) return null;
      return {
        id: ev.id,
        slug: ev.slug,
        startsAt: ev.startsAt,
        timezone: ev.timezone,
        status: ev.status,
        createdAt: ev.createdAt ?? new Date(0),
      };
    }),
    setSlugOnly: vi.fn(async ({ eventId, slug }) => {
      if (!currentEvent || currentEvent.id !== eventId) {
        throw new Error("event not found");
      }
      currentEvent = { ...currentEvent, slug };
    }),
    recordSlugHistory: vi.fn(async ({ eventId, slug, recordedAt }) => {
      if (!currentEvent || currentEvent.id !== eventId) {
        throw new Error("event not found");
      }
      slugHistoryRecords = [...slugHistoryRecords, { slug, recordedAt }];
    }),
    resolveBySlug: vi.fn(async (slug: string) => {
      if (currentEvent?.slug === slug) {
        return {
          eventId: currentEvent.id,
          currentSlug: currentEvent.slug!,
          redirect: false,
        };
      }
      if (
        currentEvent &&
        slugHistoryRecords.some((record) => record.slug === slug)
      ) {
        return {
          eventId: currentEvent.id,
          currentSlug: currentEvent.slug!,
          redirect: true,
        };
      }
      return null;
    }),
    resolveByShortId: vi.fn(async (shortId: string) =>
      currentEvent?.shortId === shortId && currentEvent.slug
        ? { eventId: currentEvent.id, currentSlug: currentEvent.slug }
        : null,
    ),
    getSlugContext: vi.fn(async (eventId: string) => {
      if (!currentEvent || currentEvent.id !== eventId) {
        return null;
      }
      // Mirrors the adapter's `mapSlugContext`: the event's OWN address
      // columns win, then its linked SavedLocation, then its linked Place.
      // The fake used to read the event's columns only, so a saved-location
      // event looked country-less here even though production would have
      // resolved one through the relation.
      const linkedSavedLocation = currentEvent.savedLocationId
        ? resolveSavedLocation()
        : null;
      const linkedPlace = currentEvent.placeId ? resolvePlace() : null;

      const countryCode =
        currentEvent.countryCode ??
        linkedSavedLocation?.countryCode ??
        linkedPlace?.countryCode ??
        null;
      const regionCode =
        currentEvent.region ??
        linkedSavedLocation?.region ??
        linkedPlace?.region ??
        null;
      const cityOrRegionCode =
        currentEvent.locality ??
        linkedSavedLocation?.locality ??
        linkedPlace?.city ??
        regionCode ??
        null;

      return {
        eventId: currentEvent.id,
        orgId: currentEvent.orgId,
        humanId: currentEvent.humanId,
        eventTitle: currentEvent.title,
        startsAt: currentEvent.startsAt,
        timezone: currentEvent.timezone,
        // Relation-shaped, like the adapter: `org` / `human` are JOINs, so a
        // human-owned event has NO org name. The fake used to hand back "Org"
        // unconditionally, which meant every human event's slug came out under
        // the org host segment — wrong, and invisible until slugs were
        // generated somewhere a test could see them.
        orgName: currentEvent.orgId ? (options.org?.name ?? "Org") : null,
        countryCode,
        regionCode,
        cityOrRegionCode,
        shortId: currentEvent.shortId,
      };
    }),
    listByOwner: vi.fn(async () => {
      const items = currentEvent ? [currentEvent] : [];
      return {
        items,
        pageInfo: {
          total: items.length,
          count: items.length,
          limit: 50,
          offset: 0,
          hasNextPage: false,
          nextOffset: null,
        },
      };
    }),
    listAllByPlace: vi.fn(async () => (currentEvent ? [currentEvent] : [])),
    cancel: vi.fn(async ({ eventId }: { eventId: string }) => {
      if (!currentEvent || currentEvent.id !== eventId) {
        throw new Error("event not found");
      }
      // Mirrors the adapter: record the status the row had, once.
      currentEvent = {
        ...currentEvent,
        cancelledFromStatus:
          currentEvent.status === "CANCELLED"
            ? (currentEvent.cancelledFromStatus ?? null)
            : currentEvent.status,
        status: "CANCELLED" as EventRecord["status"],
      };
      return currentEvent;
    }),
    linkSavedLocation: vi.fn(
      async ({
        eventId,
        savedLocationId,
      }: {
        eventId: string;
        savedLocationId: string;
      }) => {
        if (!currentEvent || currentEvent.id !== eventId) {
          throw new Error("event not found");
        }
        currentEvent = { ...currentEvent, savedLocationId };
      },
    ),
    updateTaxRate: vi.fn(
      async ({
        eventId,
        admissionTaxRateBps,
        taxRateSource,
      }: {
        eventId: string;
        admissionTaxRateBps: number | null;
        taxRateSource: string | null;
      }) => {
        if (!currentEvent || currentEvent.id !== eventId) {
          throw new Error("event not found");
        }
        currentEvent = {
          ...currentEvent,
          admissionTaxRateBps,
          taxRateSource,
        };
      },
    ),
    findByPayoutTermsId: vi.fn(async (payoutTermsId: string) => {
      if (
        currentEvent &&
        (currentEvent.payoutTermsId === payoutTermsId ||
          currentEvent.resalePayoutTermsId === payoutTermsId)
      ) {
        return { ...currentEvent };
      }
      return null;
    }),
    updateRefundCutoff: vi.fn(async ({ eventId, refundCutoffAt }) => {
      if (currentEvent && currentEvent.id === eventId) {
        currentEvent = { ...currentEvent, refundCutoffAt };
      }
      return currentEvent!;
    }),
    updateInstructionalAdmission: vi.fn(
      async ({ eventId, instructionalAdmission }) => {
        if (currentEvent && currentEvent.id === eventId) {
          currentEvent = { ...currentEvent, instructionalAdmission };
        }
        return currentEvent!;
      },
    ),
    updateVolunteerSettings: vi.fn(
      async ({
        eventId,
        volunteeringEnabled,
        volunteerAutoApprove,
        volunteerIntroText,
      }) => {
        if (currentEvent && currentEvent.id === eventId) {
          currentEvent = {
            ...currentEvent,
            ...(volunteeringEnabled !== undefined
              ? { volunteeringEnabled }
              : {}),
            ...(volunteerAutoApprove !== undefined
              ? { volunteerAutoApprove }
              : {}),
            ...(volunteerIntroText !== undefined ? { volunteerIntroText } : {}),
          };
        }
        return currentEvent!;
      },
    ),
    createCommunityListing: vi.fn(async (input) => {
      const record: EventRecord = {
        ...(currentEvent ?? ({} as EventRecord)),
        id: currentEvent?.id ?? eventId,
        orgId: null,
        humanId: null,
        title: input.title,
        status: input.status,
        attendanceMode: input.attendanceMode,
        stewardship: input.stewardship,
        visibility: "PUBLIC",
        gateType: "NONE",
        locationMode: "EXACT",
        locationRadiusMeters: null,
        locationLabel: null,
        addressRevealAt: null,
        addressRevealPreset: null,
        timezone: input.timezone,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        placeId: null,
        savedLocationId: null,
        categoryId: input.categoryId ?? null,
        addressText: input.addressText,
        countryCode: input.countryCode,
        region: input.region ?? null,
        locality: input.locality ?? null,
        postalCode: input.postalCode ?? null,
        lat: input.lat,
        lng: input.lng,
        content: input.content ?? null,
        slug: input.slug,
        shortId: input.shortId,
        regionCode: input.regionCode ?? null,
        publishedAt: input.publishedAt,
        payoutTermsId: null,
        resalePayoutTermsId: null,
        agreementPrimaryId: null,
        agreementResaleId: null,
        placeLayoutId: null,
        defaultLocale: null,
        listingPriority: null,
        passwordHash: null,
        passwordUpdatedAt: null,
        waitlistStatus: "DISABLED",
        currency: null,
        ageLimit: input.ageLimit ?? null,
        createdAt: now,
        updatedAt: now,
      };
      currentEvent = record;
      return record;
    }),
    applyCommunityEdit: vi.fn(async ({ eventId: targetEventId, fields }) => {
      if (!currentEvent || currentEvent.id !== targetEventId) {
        throw new Error("event not found");
      }
      currentEvent = {
        ...currentEvent,
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.content !== undefined ? { content: fields.content } : {}),
        ...(fields.startsAt !== undefined ? { startsAt: fields.startsAt } : {}),
        ...(fields.endsAt !== undefined ? { endsAt: fields.endsAt } : {}),
        ...(fields.timezone !== undefined ? { timezone: fields.timezone } : {}),
        ...(fields.addressText !== undefined
          ? { addressText: fields.addressText }
          : {}),
        ...(fields.countryCode !== undefined
          ? { countryCode: fields.countryCode }
          : {}),
        ...(fields.region !== undefined ? { region: fields.region } : {}),
        ...(fields.locality !== undefined ? { locality: fields.locality } : {}),
        ...(fields.postalCode !== undefined
          ? { postalCode: fields.postalCode }
          : {}),
        ...(fields.lat !== undefined ? { lat: fields.lat } : {}),
        ...(fields.lng !== undefined ? { lng: fields.lng } : {}),
        ...(fields.categoryId !== undefined
          ? { categoryId: fields.categoryId }
          : {}),
        ...(fields.ageLimit !== undefined ? { ageLimit: fields.ageLimit } : {}),
      };
      return currentEvent;
    }),
    listRecurringEventIds: vi.fn(
      async (): Promise<{ ids: string[]; nextCursor?: string }> => ({
        ids: [],
      }),
    ),
    listCommunityListingsForPlatform: vi.fn(
      async (): ReturnType<EventsRepo["listCommunityListingsForPlatform"]> => ({
        items: [],
        nextCursor: null,
      }),
    ),
  };

  const auditRepo = {
    log: vi.fn(async (): Promise<void> => {}),
  };

  const feePoliciesRepo = {
    getById: vi.fn(async (): Promise<null> => null),
    resolveEffective: vi.fn(),
    upsert: vi.fn(),
  };

  const entityPagesRepo: typeof entityPagesRepoPrototype = {
    ...entityPagesRepoPrototype,
    getByOwner: vi.fn(async (): Promise<null> => null),
    upsert: vi.fn(async () => ({
      ownerType: "HUMAN",
      ownerId: humanId,
      slug: "",
      displayName: null,
    })),
  };

  const eventTemplatesRepo: typeof eventTemplatesRepoPrototype = {
    getById: vi.fn(),
    findByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    list: vi.fn(),
  };

  const eventHumansRepo: typeof eventHumansRepoPrototype = {
    attach: vi.fn(),
    detach: vi.fn(),
    listByEvent: vi.fn(),
    reorder: vi.fn(),
    getById: vi.fn(),
    linkHuman: vi.fn(),
  };

  const fakeSpaces = createFakeSpacesRepo();
  const fakeCalendars = createFakeCalendarsRepo({ spaces: fakeSpaces });
  const fakeBookingRequestMessages = createFakeBookingRequestMessagesRepo();

  // Booking-timeline plumbing. Every event SAVE asks "did this event come out
  // of a booking?" (`booking_event.modified`, save-event-shared) via the
  // reverse lookup on `Agreement.eventId` / `.draftEventId`. The default is
  // the overwhelmingly common answer — NO — so an ordinary save writes no
  // ledger entry; a suite that wants the booked shape overrides
  // `findByLinkedEventId` / `findByAgreementId` on these.
  const fakeAgreements = {
    findByLinkedEventId: vi.fn(async () => null),
    findManyByLinkedEventIds: vi.fn(async () => []),
    getById: vi.fn(async () => null),
    getByEventId: vi.fn(async () => null),
  } as unknown as TxRepos["agreements"];
  const fakeBookingRequests = {
    findByAgreementId: vi.fn(async () => null),
    findManyByAgreementIds: vi.fn(async () => []),
    getById: vi.fn(async () => null),
    touchLastMessageAt: vi.fn(async () => {}),
    // Event-first (venue-confirmation spec): the save creates the booking
    // request in-tx for a THIRD-PARTY event at a place with a calendar. The
    // default fixture place is VENUE-OWNED, so none of these run unless a
    // suite passes a foreign `place`; when one does, `create` echoes the
    // input as the row and the origin lookup reports "no request yet".
    findByOriginEventId: vi.fn(async () => null),
    findOpenByPerformerAndPlace: vi.fn(async () => null),
    create: vi.fn(async (input: Record<string, unknown>) => ({
      id: "b0000000-0000-4000-8000-00000000000b",
      direction: "TO_VENUE",
      status: "PENDING",
      calendarId: null,
      preferredDates: [],
      intent: "PERFORM",
      ...input,
    })),
  } as unknown as TxRepos["bookingRequests"];
  const fakePlaceBookingGrants = {
    findActiveForActor: vi.fn(async () => null),
    listActiveForActor: vi.fn(async () => []),
    listForPlace: vi.fn(async () => []),
    create: vi.fn(),
  } as unknown as TxRepos["placeBookingGrants"];
  const fakePerformerProfiles = {
    getByOwner: vi.fn(async () => null),
  } as unknown as TxRepos["performerProfiles"];
  // FR-013: a save that moves a PUBLISHED event's schedule writes a
  // RESCHEDULED outbox row through the tx. Recorded, not persisted.
  const eventChangeNoticesRepo = {
    create: vi.fn(
      async (
        input: CreateEventChangeNoticeInput,
      ): Promise<EventChangeNoticeRecord> => ({
        id: "c0000000-0000-4000-8000-00000000000c",
        ...input,
        createdAt: now,
        dispatchedAt: null,
        attempts: 0,
        notifiedHumanIds: [],
      }),
    ),
  };

  // Arrival areas (arrival-areas FR-014): an event save that changes place
  // or address switches the event's own areas off. No areas here, so the
  // save's hook reads an empty list and writes nothing.
  const arrivalAreasRepo = {
    listForEvent: vi.fn(async () => []),
    setDisabledForEvent: vi.fn(async () => 0),
    deleteHidesForEventNotInPlace: vi.fn(async () => []),
  } as unknown as TxRepos["arrivalAreas"];

  const txRepos: TxRepos = {
    events: eventsRepo,
    spaces: fakeSpaces,
    arrivalAreas: arrivalAreasRepo,
    calendars: fakeCalendars,
    bookingRequestMessages: fakeBookingRequestMessages,
    agreements: fakeAgreements,
    bookingRequests: fakeBookingRequests,
    placeBookingGrants: fakePlaceBookingGrants,
    performerProfiles: fakePerformerProfiles,
    eventChangeNotices:
      eventChangeNoticesRepo as unknown as TxRepos["eventChangeNotices"],
    featuredEvents: {} as TxRepos["featuredEvents"],
    eventApplications: {} as TxRepos["eventApplications"],
    eventWaitlists: {} as TxRepos["eventWaitlists"],
    inviteLists: {} as TxRepos["inviteLists"],
    tickets: {} as TxRepos["tickets"],
    seats: {} as TxRepos["seats"],
    savedLocations: savedLocationsRepo,
    audit: auditRepo as unknown as TxRepos["audit"],
    feePolicies: feePoliciesRepo as unknown as TxRepos["feePolicies"],
    entityPages: entityPagesRepo as unknown as TxRepos["entityPages"],
    eventTemplates: eventTemplatesRepo as unknown as TxRepos["eventTemplates"],
    eventHumans: eventHumansRepo as unknown as TxRepos["eventHumans"],
    promos: {} as TxRepos["promos"],
    orders: {} as TxRepos["orders"],
    orderItems: {
      markItemsPaidOut: vi.fn(async () => {}),
      // `updateStatus` is a CAS-capable write: `true` = "this write applied".
      updateStatus: vi.fn(async () => true),
      listByOrderId: vi.fn(async () => []),
      getById: vi.fn(async () => null),
    } as TxRepos["orderItems"],
    orderItemSettlementLines: {
      addDraft: vi.fn(async () => {}),
      listBySettlementLineId: vi.fn(async () => []),
      listByOrderItemId: vi.fn(async () => []),
      listByOrderItemIds: vi.fn(async () => []),
    } as TxRepos["orderItemSettlementLines"],
    payoutTerms: {} as TxRepos["payoutTerms"],
    splits: {} as TxRepos["splits"],
    payees: {} as TxRepos["payees"],
    // READ-ONLY: the settlement tables are frozen history post-cutover
    // (spec 2026-08-10 §7) — every write method is deleted from the port.
    settlements: {
      getById: vi.fn(async () => null),
      getByIds: vi.fn(async () => []),
      listForOrg: vi.fn(async () => ({ items: [], total: 0 })),
      listAll: vi.fn(async () => ({ items: [], total: 0 })),
    } as TxRepos["settlements"],
    settlementLines: {
      addDraft: vi.fn(async () => {}),
      listByOrderId: vi.fn(async () => []),
      listBySettlementId: vi.fn(async () => []),
      getById: vi.fn(async () => null),
    } as TxRepos["settlementLines"],
    idempotency: {} as TxRepos["idempotency"],
    authz: authzRepo,
    apiKeys: {} as TxRepos["apiKeys"],
    organizations: organizationsRepo,
    places: placesRepo,
    humans: humansRepo,
    categories: {
      listActive: vi.fn(),
      listAll: vi.fn(async () => []),
      getBySlug: vi.fn(),
      getById: vi.fn(),
      findSlug: vi.fn(async () => null),
      findSlugsBySlug: vi.fn(async () => []),
      listSlugs: vi.fn(async () => []),
      listAllSlugs: vi.fn(async () => []),
      listCurrentSlugs: vi.fn(async () => []),
      setCurrentSlug: vi.fn(),
      create: vi.fn(async (input: any) => ({
        id: "category-test-id",
        slug: input.slug,
        name: input.name,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
        seoType: input.seoType ?? "Event",
        createdAt: now,
        updatedAt: now,
      })),
      upsertSeed: vi.fn(),
      rename: vi.fn(async () => null),
      setActive: vi.fn(async () => null),
      lockSortOrder: vi.fn(async () => undefined),
      lockNaming: vi.fn(async () => undefined),
      setSortOrders: vi.fn(async (entries: any) => entries.length),
    } as TxRepos["categories"],
    categoryRequests: {
      create: vi.fn(async () => ({}) as any),
      findPending: vi.fn(async () => null),
      listPendingBySlug: vi.fn(async () => []),
      getById: vi.fn(async () => null),
      list: vi.fn(async () => ({ requests: [], total: 0 })),
      claimPendingForReview: vi.fn(async () => null),
      markReviewed: vi.fn(async () => ({}) as any),
    } as TxRepos["categoryRequests"],
    tags: {
      getBySlug: vi.fn(),
      findOrCreate: vi.fn(),
      search: vi.fn(),
      setEventTags: vi.fn(),
      getEventTags: vi.fn(),
    } as TxRepos["tags"],
    series: {
      getById: vi.fn(),
      findActiveByName: vi.fn(),
      nameExists: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      listByOwner: vi.fn(),
    } as TxRepos["series"],
    seriesOccurrences: {
      getById: vi.fn(),
      listBySeries: vi.fn(),
      bulkUpsert: vi.fn(),
      attachEvent: vi.fn(),
      applyOverrides: vi.fn(),
      markStatus: vi.fn(),
      uniqueCheck: vi.fn(),
      getCalendarInfoForEventIds: vi.fn().mockResolvedValue([]),
    } as TxRepos["seriesOccurrences"],
    pushDevices: {} as TxRepos["pushDevices"],
    notificationPrefs: {} as TxRepos["notificationPrefs"],
    notificationDigests: {} as TxRepos["notificationDigests"],
    notifications: undefined as unknown as TxRepos["notifications"],
    placeLayouts: {
      getById: vi.fn(async () => null),
      getByPlace: vi.fn(async () => null),
      listByPlace: vi.fn(async () => []),
      replaceWithSnapshot: vi.fn(),
      deleteForPlace: vi.fn(),
    } as TxRepos["placeLayouts"],
    placeLayoutBlobs: {
      putForPlace: vi.fn(),
      getGlyphUrl: vi.fn(),
      deleteForPlace: vi.fn(),
    } as TxRepos["placeLayoutBlobs"],
    placeLayoutStatuses: {
      upsertStatuses: vi.fn(),
      deleteByPlace: vi.fn(),
    } as TxRepos["placeLayoutStatuses"],
    payouts: {} as TxRepos["payouts"],
    resaleListings: {} as TxRepos["resaleListings"],
    claims: {} as TxRepos["claims"],
    images: {} as TxRepos["images"],
    eventUnlocks: {
      upsert: vi.fn(async () => ({
        id: "unlock-test-id",
        eventId: eventId,
        humanId: humanId,
        source: "PASSWORD",
        applicationSubmissionId: null,
        inviteId: null,
        metadata: {},
        expiresAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      })),
      isUnlocked: vi.fn(async () => false),
      get: vi.fn(async () => null),
      revoke: vi.fn(async () => null),
      listByEventId: vi.fn(async () => []),
      listByHumanId: vi.fn(async () => []),
    } as TxRepos["eventUnlocks"],
    eventInvites: {
      create: vi.fn(async (input: any) => ({
        id: "event-invite-test-id",
        eventId: input.eventId,
        kind: input.kind,
        inviteeName: input.inviteeName ?? null,
        inviteeEmail: input.inviteeEmail ?? null,
        tokenHash: input.tokenHash,
        createdByHumanId: input.createdByHumanId,
        inviteListEntryId: input.inviteListEntryId ?? null,
        metadata: input.metadata ?? {},
        revokedAt: null,
        firstRedeemedAt: null,
        redemptionCount: 0,
        sentAt: input.sentAt ?? null,
        createdAt: now,
        updatedAt: now,
      })),
      getById: vi.fn(async () => null),
      getByTokenHash: vi.fn(async () => null),
      getLiveShared: vi.fn(async () => null),
      listByEvent: vi.fn(async () => []),
      findLivePersonalByEmail: vi.fn(async () => null),
      revoke: vi.fn(async () => null),
      recordRedemption: vi.fn(async () => null),
      lockIfLive: vi.fn(async () => true),
      rotateShared: vi.fn(),
      markSent: vi.fn(async () => null),
    } as unknown as TxRepos["eventInvites"],
    audioUploads: {
      create: vi.fn(async () => ({})),
      getById: vi.fn(async () => null),
      resolveByIds: vi.fn(async () => []),
      markUploaded: vi.fn(async () => null),
      markTranscoding: vi.fn(async () => null),
      markTranscoded: vi.fn(async () => null),
      markFailed: vi.fn(async () => null),
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      softDelete: vi.fn(async () => {}),
      listByEventId: vi.fn(async () => []),
      listPendingTranscode: vi.fn(async () => []),
    } as unknown as TxRepos["audioUploads"],
    analytics: {} as TxRepos["analytics"],
    contactImports: {} as TxRepos["contactImports"],
    pendingTicketTransfers: {} as TxRepos["pendingTicketTransfers"],
    pendingObjectDeletions: {
      ...pendingObjectDeletionsRepoPrototype,
    } as TxRepos["pendingObjectDeletions"],
    searchReindexPending: createInMemorySearchReindexPending(),
    searchIndexState: createInMemorySearchIndexState(),
    humanDelegates: {
      ...humanDelegatesRepoPrototype,
    } as TxRepos["humanDelegates"],
    placeVerificationRequests: {
      create: vi.fn(async (input: any) => ({
        id: "pvr-test-id",
        placeId: input.placeId,
        orgId: input.orgId,
        submittedById: input.submittedById,
        status: "PENDING",
        reviewerNotes: null,
        reviewerHumanId: null,
        reviewedAt: null,
        createdAt: now,
        updatedAt: now,
      })),
      getById: vi.fn(async () => null),
      getLatestForPlace: vi.fn(async () => null),
      listForPlace: vi.fn(async () => []),
      hasPendingForPlace: vi.fn(async () => false),
      updateDecision: vi.fn(async (input: any) => ({
        id: input.requestId,
        placeId: "place-test-id",
        orgId: "org-test-id",
        submittedById: "human-test-id",
        status: input.status,
        reviewerNotes: input.reviewerNotes ?? null,
        reviewerHumanId: input.reviewerHumanId,
        reviewedAt: input.reviewedAt,
        createdAt: now,
        updatedAt: now,
      })),
    } as TxRepos["placeVerificationRequests"],
    placeVerificationDocuments: {
      createMany: vi.fn(async (input: any) =>
        (input.documents ?? []).map((d: any, i: number) => ({
          id: `pvd-test-${i}`,
          requestId: input.requestId,
          storageKey: d.storageKey,
          fileName: d.fileName,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
          deletedAt: null,
          createdAt: now,
        })),
      ),
      listByRequestId: vi.fn(async () => []),
      markDeleted: vi.fn(async () => 0),
      listStale: vi.fn(async () => []),
    } as TxRepos["placeVerificationDocuments"],
    embeds: {} as TxRepos["embeds"],
    platformSettings: {} as TxRepos["platformSettings"],
    payoutItems: {} as TxRepos["payoutItems"],
    placeWaivers: {} as TxRepos["placeWaivers"],
    announcements: {} as TxRepos["announcements"],
    resourceQuotas: {
      getDefaultLimit: vi.fn(async () => null),
      listDefaultLimits: vi.fn(async () => []),
      upsertDefaultLimit: vi.fn(async () => ({}) as any),
      getOverride: vi.fn(async () => null),
      upsertOverride: vi.fn(async () => ({}) as any),
      getUsage: vi.fn(async () => null),
      incrementUsage: vi.fn(async () => ({}) as any),
      getEffectiveQuota: vi.fn(async () => ({
        kind: "EVENTS_PER_ORG" as const,
        limitValue: 50n,
        currentUsage: 0n,
        isOverride: false,
      })),
      getExpansionRequestById: vi.fn(async () => null),
      createExpansionRequest: vi.fn(async () => ({}) as any),
      reviewExpansionRequest: vi.fn(async () => ({}) as any),
      listExpansionRequests: vi.fn(async () => ({ items: [], total: 0 })),
      hasPendingExpansionRequest: vi.fn(async () => false),
      getCompletedPayoutCountForOrg: vi.fn(async () => 0),
    } as TxRepos["resourceQuotas"],
    eventTypes: {} as TxRepos["eventTypes"],
    waiverTemplates: {} as TxRepos["waiverTemplates"],
    waiverAcceptances: {} as TxRepos["waiverAcceptances"],
  };

  const idempotency = createFakeIdempotencyPort({
    beginSequence: options.idempotencyBeginSequence,
  });
  const logger = createTestLogger();

  const repos: Repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>, _options?: TxOptions) =>
      fn(txRepos),
    events: eventsRepo,
    featuredEvents: txRepos.featuredEvents as Repos["featuredEvents"],
    eventApplications: txRepos.eventApplications as Repos["eventApplications"],
    eventWaitlists: txRepos.eventWaitlists as Repos["eventWaitlists"],
    inviteLists: txRepos.inviteLists as Repos["inviteLists"],
    orders: {} as Repos["orders"],
    orderItems: txRepos.orderItems as Repos["orderItems"],
    orderItemSettlementLines:
      txRepos.orderItemSettlementLines as Repos["orderItemSettlementLines"],
    tickets: {} as Repos["tickets"],
    seats: {} as Repos["seats"],
    payoutTerms: {} as Repos["payoutTerms"],
    feePolicies: feePoliciesRepo as unknown as Repos["feePolicies"],
    promos: {} as Repos["promos"],
    splits: {} as Repos["splits"],
    payees: {} as Repos["payees"],
    settlements: txRepos.settlements as Repos["settlements"],
    settlementLines: txRepos.settlementLines as Repos["settlementLines"],
    resaleListings: {} as Repos["resaleListings"],
    claims: {} as Repos["claims"],
    idempotency: {} as Repos["idempotency"],
    audit: auditRepo,
    arrivalAreas: arrivalAreasRepo,
    humans: humansRepo,
    authz: authzRepo,
    apiKeys: {} as Repos["apiKeys"],
    organizations: organizationsRepo,
    places: placesRepo,
    savedLocations: savedLocationsRepo,
    entityPages: entityPagesRepo,
    eventTemplates: eventTemplatesRepo as unknown as Repos["eventTemplates"],
    eventHumans: eventHumansRepo as unknown as Repos["eventHumans"],
    categories: txRepos.categories,
    categoryRequests: txRepos.categoryRequests,
    tags: txRepos.tags,
    series: txRepos.series,
    seriesOccurrences: txRepos.seriesOccurrences,
    pushDevices: txRepos.pushDevices,
    notificationPrefs: txRepos.notificationPrefs,
    notificationDigests: txRepos.notificationDigests,
    notifications: txRepos.notifications,
    placeLayouts: txRepos.placeLayouts,
    placeLayoutBlobs: txRepos.placeLayoutBlobs,
    placeLayoutStatuses: txRepos.placeLayoutStatuses,
    payouts: txRepos.payouts,
    images: txRepos.images,
    eventUnlocks: txRepos.eventUnlocks,
    eventInvites: txRepos.eventInvites,
    audioUploads: txRepos.audioUploads,
    analytics: txRepos.analytics,
    contactImports: txRepos.contactImports,
    pendingTicketTransfers: txRepos.pendingTicketTransfers,
    pendingObjectDeletions: txRepos.pendingObjectDeletions,
    searchReindexPending: txRepos.searchReindexPending,
    searchIndexState: txRepos.searchIndexState,
    humanDelegates: txRepos.humanDelegates,
    placeVerificationRequests: txRepos.placeVerificationRequests,
    placeVerificationDocuments: txRepos.placeVerificationDocuments,
    embeds: txRepos.embeds,
    platformSettings: txRepos.platformSettings,
    payoutItems: txRepos.payoutItems,
    placeWaivers: txRepos.placeWaivers,
    spaces: txRepos.spaces,
    calendars: txRepos.calendars,
    bookingRequestMessages: txRepos.bookingRequestMessages,
    agreements: txRepos.agreements,
    bookingRequests: txRepos.bookingRequests,
    placeBookingGrants: txRepos.placeBookingGrants,
    performerProfiles: txRepos.performerProfiles,
    announcements: txRepos.announcements,
    resourceQuotas: txRepos.resourceQuotas,
    eventTypes: txRepos.eventTypes,
    waiverTemplates: txRepos.waiverTemplates,
    waiverAcceptances: txRepos.waiverAcceptances,
  };

  const clock: ClockPort = {
    now: () => now,
  };

  const taxRateLookup = createFakeTaxRateLookup();
  const timezoneLookup: TimezoneLookupPort = vi.fn(
    options.timezoneLookup ?? (() => null),
  );
  const reportError: ReporterPort = vi.fn();
  const manages = options.canManagePlace ?? (() => false);
  const authzPort: CreateEventDeps["authz"] = {
    canManagePlace: vi.fn(
      async (input: { actorHumanId: string; placeId: string }) => ({
        allowed: manages(input),
      }),
    ),
  };

  return {
    deps: {
      repos,
      idempotency,
      clock,
      logger,
      taxRateLookup,
      timezoneLookup,
      reportError,
      authz: authzPort,
    },
    mocks: {
      events: eventsRepo,
      savedLocations: savedLocationsRepo,
      audit: auditRepo,
      authz: authzRepo,
      organizations: organizationsRepo,
      places: placesRepo,
      humans: humansRepo,
      feePolicies: feePoliciesRepo,
      entityPages: entityPagesRepo,
      eventTemplates: eventTemplatesRepo,
      eventHumans: eventHumansRepo,
      spaces: fakeSpaces,
      calendars: fakeCalendars,
      eventChangeNotices: eventChangeNoticesRepo,
      logger,
      idempotency,
      taxRateLookup,
      timezoneLookup,
      reportError,
      authzPort,
    },
    defaults: {
      now,
      orgId,
      humanId,
      actorHumanId,
      eventId,
    },
  } satisfies CreateEventTestContext;
}
