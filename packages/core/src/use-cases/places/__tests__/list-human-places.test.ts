import { describe, expect, it, vi } from "vitest";

import { listHumanPlaces } from "../list-human-places";
import type { ListHumanPlacesDeps } from "../list-human-places";
import type { PlaceListItemRecord } from "@th/ports/repos/places";
import type { HumanRecord } from "@th/ports/repos/humans";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";
import type { OffsetPaginatedResult } from "@th/ports/pagination";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const DEFAULT_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_ORG_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_PLACE_ID = "44444444-4444-4444-8444-444444444444";

function buildPlaceRecord(
  overrides: Partial<PlaceListItemRecord> = {},
): PlaceListItemRecord {
  return {
    eventsCount: overrides.eventsCount ?? 0,
    id: overrides.id ?? DEFAULT_PLACE_ID,
    name: overrides.name ?? "Nomad Warehouse",
    slug: "test-place",
    formattedAddress: overrides.formattedAddress ?? "123 Main St",
    addressLine1: overrides.addressLine1 ?? "123 Main St",
    addressLine2: overrides.addressLine2 ?? null,
    city: overrides.city ?? "Los Angeles",
    region: overrides.region ?? "CA",
    postalCode: overrides.postalCode ?? "90001",
    countryCode: overrides.countryCode ?? "US",
    capacity: overrides.capacity ?? 1200,
    lat: overrides.lat ?? 34.0447,
    lng: overrides.lng ?? -118.2519,
    timezone: overrides.timezone ?? null,
    status: overrides.status ?? "ACTIVE",
    verificationStatus: overrides.verificationStatus ?? "VERIFIED",
    orgIdsWithAccess: overrides.orgIdsWithAccess ?? [DEFAULT_ORG_ID],
    humanIdsWithAccess: overrides.humanIdsWithAccess ?? [DEFAULT_HUMAN_ID],
    defaultPrimaryPayoutTermsId: overrides.defaultPrimaryPayoutTermsId ?? null,
    defaultResalePayoutTermsId: overrides.defaultResalePayoutTermsId ?? null,
    phone: overrides.phone ?? null,
    website: overrides.website ?? null,
    listedInDirectory: overrides.listedInDirectory ?? false,
    createdAt: overrides.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2024-01-01T00:00:00.000Z"),
    // Not every PlaceRecord field matters here; the use case only maps the
    // summary subset (same shortcut the pre-eventsCount version took).
  } as PlaceListItemRecord;
}

function wrapPaginated(
  places: PlaceListItemRecord[],
): OffsetPaginatedResult<PlaceListItemRecord> {
  return {
    items: places,
    pageInfo: {
      total: places.length,
      count: places.length,
      limit: 20,
      offset: 0,
      hasNextPage: false,
      nextOffset: null,
    },
  };
}

type BuildDepsOptions = {
  human?: HumanRecord | null;
  places?: PlaceListItemRecord[];
  orgMemberships?: Record<string, OrgMembership | null>;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const humanRecord: HumanRecord | null =
    options.human === undefined
      ? {
          id: DEFAULT_HUMAN_ID,
          name: "Event Owner",
          status: "ACTIVE",
          roles: ["USER"],
          locale: null,
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
          createdAt: new Date(),
        }
      : options.human;

  const placesRepo = {
    listAccessibleByHuman: vi.fn(async () =>
      wrapPaginated(options.places ?? [buildPlaceRecord()]),
    ),
  };

  const humansRepo = {
    getById: vi.fn(async () => humanRecord),
  };

  const authzRepo = {
    getOrgMemberships: vi.fn(
      async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) => {
        const memberships = options.orgMemberships ?? {};
        if (!humanRecord || humanId !== DEFAULT_HUMAN_ID) {
          return [];
        }
        return orgIds
          .filter(
            (orgId) =>
              Object.prototype.hasOwnProperty.call(memberships, orgId) &&
              memberships[orgId] != null,
          )
          .map((orgId) => memberships[orgId]!);
      },
    ),
    getStaffRolesForHumanId: vi.fn(async () => []),
  };

  const placeVerificationRequestsRepo = {
    getActiveStatusByPlaceIds: vi.fn(
      async () => new Map<string, "PENDING" | "IN_REVIEW">(),
    ),
  };

  const repos = {
    places: placesRepo,
    humans: humansRepo,
    authz: authzRepo,
    placeVerificationRequests: placeVerificationRequestsRepo,
  } as unknown as Repos;

  // The D5 manage bar, answered the way the real `canManagePlace` does: a
  // verified direct owner, or OWNER/ADMIN/EDITOR in an owning org.
  const authz = {
    canManagePlace: vi.fn(
      async ({ placeId }: { placeId: string; actorHumanId: string }) => {
        const place = (options.places ?? []).find((p) => p.id === placeId);
        const memberships = options.orgMemberships ?? {};
        const allowed =
          !!place &&
          (place.humanIdsWithAccess.includes(DEFAULT_HUMAN_ID) ||
            place.orgIdsWithAccess.some((orgId) =>
              ["OWNER", "ADMIN", "EDITOR"].includes(
                memberships[orgId]?.role ?? "",
              ),
            ));
        return { allowed };
      },
    ),
  };

  const deps: ListHumanPlacesDeps = {
    repos,
    authz,
    logger: createTestLogger(),
  };

  return { deps, mocks: { placesRepo, humansRepo, authzRepo, authz } };
}

describe("listHumanPlaces", () => {
  it("delegates verified-only filtering to the repo and reports honest totals", async () => {
    // verifiedOnly is enforced in the ADAPTER's where clause (shared by
    // count + findMany) via includeOwnedUnverified=false. The use case must
    // NOT post-filter after pagination — rows and pageInfo pass through 1:1,
    // otherwise pageInfo.total lies about the visible rows (the exact bug
    // class this listing slice exists to fix).
    const verified = buildPlaceRecord({
      id: DEFAULT_PLACE_ID,
      verificationStatus: "VERIFIED",
    });
    const alsoReturned = buildPlaceRecord({
      id: "55555555-5555-4555-8555-555555555555",
      verificationStatus: "UNVERIFIED",
    });

    const { deps, mocks } = buildDeps({ places: [verified, alsoReturned] });

    const result = await listHumanPlaces(deps, {
      actorHumanId: DEFAULT_HUMAN_ID,
    });

    // Whatever the repo returns is surfaced — no silent dropping.
    expect(result.places).toHaveLength(2);
    expect(result.pageInfo).toMatchObject({
      total: 2,
      count: 2,
      limit: 20,
      offset: 0,
    });
    expect(mocks.placesRepo.listAccessibleByHuman).toHaveBeenCalledWith({
      humanId: DEFAULT_HUMAN_ID,
      orgIds: undefined,
      query: undefined,
      limit: 20,
      offset: 0,
      includeOwnedUnverified: false,
      ownedOnly: false,
      includeActorOwnedWithOrgs: false,
      sort: { field: "name", direction: "asc" },
      status: undefined,
    });
  });

  it("includes unverified places when requested", async () => {
    const verified = buildPlaceRecord({
      id: DEFAULT_PLACE_ID,
      verificationStatus: "VERIFIED",
    });
    const pending = buildPlaceRecord({
      id: "66666666-6666-4666-8666-666666666666",
      verificationStatus: "PENDING",
    });

    const { deps } = buildDeps({ places: [verified, pending] });

    const result = await listHumanPlaces(deps, {
      actorHumanId: DEFAULT_HUMAN_ID,
      verifiedOnly: false,
    });

    expect(result.places).toHaveLength(2);
    expect(result.pageInfo).toMatchObject({
      total: 2,
      count: 2,
      limit: 20,
      offset: 0,
    });
    expect(result.places.map((place) => place.placeId)).toEqual([
      DEFAULT_PLACE_ID,
      "66666666-6666-4666-8666-666666666666",
    ]);
  });

  it("filters org ids to memberships", async () => {
    const memberships: Record<string, OrgMembership | null> = {
      [DEFAULT_ORG_ID]: {
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_HUMAN_ID,
        role: "EDITOR",
      },
      [SECOND_ORG_ID]: null,
    };

    const { deps, mocks } = buildDeps({ orgMemberships: memberships });

    await listHumanPlaces(deps, {
      actorHumanId: DEFAULT_HUMAN_ID,
      orgIds: [DEFAULT_ORG_ID, SECOND_ORG_ID],
    });

    expect(mocks.authzRepo.getOrgMemberships).toHaveBeenCalledWith({
      orgIds: [DEFAULT_ORG_ID, SECOND_ORG_ID],
      humanId: DEFAULT_HUMAN_ID,
    });
    expect(mocks.placesRepo.listAccessibleByHuman).toHaveBeenLastCalledWith({
      humanId: DEFAULT_HUMAN_ID,
      orgIds: [DEFAULT_ORG_ID],
      query: undefined,
      limit: 20,
      offset: 0,
      includeOwnedUnverified: false,
      ownedOnly: false,
      includeActorOwnedWithOrgs: false,
      sort: { field: "name", direction: "asc" },
      status: undefined,
    });
  });

  it("threads sort and status filter through to the repo", async () => {
    const { deps, mocks } = buildDeps();

    await listHumanPlaces(deps, {
      actorHumanId: DEFAULT_HUMAN_ID,
      sort: { field: "capacity", direction: "desc" },
      status: "archived",
    });

    expect(mocks.placesRepo.listAccessibleByHuman).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: { field: "capacity", direction: "desc" },
        status: "archived",
      }),
    );
  });

  it("surfaces the repo's eventsCount aggregate on each row", async () => {
    const withEvents = buildPlaceRecord({
      id: DEFAULT_PLACE_ID,
      eventsCount: 7,
    });
    const withoutEvents = buildPlaceRecord({
      id: "55555555-5555-4555-8555-555555555555",
      eventsCount: 0,
    });

    const { deps } = buildDeps({ places: [withEvents, withoutEvents] });

    const result = await listHumanPlaces(deps, {
      actorHumanId: DEFAULT_HUMAN_ID,
      verifiedOnly: false,
    });

    expect(result.places.map((p) => p.eventsCount)).toEqual([7, 0]);
  });

  it("projects the place's derived timezone (the event builder types the organizer's wall clock in it)", async () => {
    const withZone = buildPlaceRecord({
      id: DEFAULT_PLACE_ID,
      timezone: "America/New_York",
    });
    const withoutZone = buildPlaceRecord({
      id: "55555555-5555-4555-8555-555555555555",
      timezone: null,
    });

    const { deps } = buildDeps({ places: [withZone, withoutZone] });

    const result = await listHumanPlaces(deps, {
      actorHumanId: DEFAULT_HUMAN_ID,
      verifiedOnly: false,
    });

    // Null must survive as null — the picker's contract is "unknown means
    // leave the current zone alone", never "fall back to the browser's".
    expect(result.places.map((p) => p.timezone)).toEqual([
      "America/New_York",
      null,
    ]);
  });

  it("rejects an unknown sort field at the input boundary", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      listHumanPlaces(deps, {
        actorHumanId: DEFAULT_HUMAN_ID,
        sort: { field: "verification", direction: "asc" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.placesRepo.listAccessibleByHuman).not.toHaveBeenCalled();
  });

  it("rejects an unknown status filter at the input boundary", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      listHumanPlaces(deps, {
        actorHumanId: DEFAULT_HUMAN_ID,
        status: "ACTIVE", // must be the lowercase filter vocab, not the enum
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.placesRepo.listAccessibleByHuman).not.toHaveBeenCalled();
  });

  it("throws when the human does not exist", async () => {
    const { deps } = buildDeps({ human: null });

    await expect(
      listHumanPlaces(deps, { actorHumanId: DEFAULT_HUMAN_ID }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });
});

describe("listHumanPlaces — admin-context scoping", () => {
  it("forwards includeActorOwnedWithOrgs so the PERSONAL admin keeps its own venues", async () => {
    // The personal admin is a hub: `ownedOnly` + `orgIds` would otherwise mean
    // ORG-owned only (the event-builder rule) and drop a venue the person
    // holds directly out of their own Places table.
    const { deps, mocks } = buildDeps({
      orgMemberships: {
        [DEFAULT_ORG_ID]: {
          orgId: DEFAULT_ORG_ID,
          humanId: DEFAULT_HUMAN_ID,
          role: "ADMIN",
        },
      },
    });

    await listHumanPlaces(deps, {
      actorHumanId: DEFAULT_HUMAN_ID,
      orgIds: [DEFAULT_ORG_ID],
      ownedOnly: true,
      includeActorOwnedWithOrgs: true,
    });

    expect(mocks.placesRepo.listAccessibleByHuman).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ownedOnly: true,
        includeActorOwnedWithOrgs: true,
      }),
    );
  });

  it("defaults the flag OFF so org-scoped pickers keep their exact result set", async () => {
    const { deps, mocks } = buildDeps({
      orgMemberships: {
        [DEFAULT_ORG_ID]: {
          orgId: DEFAULT_ORG_ID,
          humanId: DEFAULT_HUMAN_ID,
          role: "ADMIN",
        },
      },
    });

    await listHumanPlaces(deps, {
      actorHumanId: DEFAULT_HUMAN_ID,
      orgIds: [DEFAULT_ORG_ID],
      ownedOnly: true,
    });

    expect(mocks.placesRepo.listAccessibleByHuman).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeActorOwnedWithOrgs: false }),
    );
  });
});
