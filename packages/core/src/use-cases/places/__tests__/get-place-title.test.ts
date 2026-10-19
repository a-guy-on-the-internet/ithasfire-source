import { describe, expect, it, vi } from "vitest";

import { getPlaceTitle } from "../get-place-title";
import type { GetPlaceTitleDeps } from "../get-place-title";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { OrgMembership, OrgRole } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";

const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";

function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: overrides.id ?? DEFAULT_PLACE_ID,
    name: overrides.name ?? "Test Place",
    formattedAddress: overrides.formattedAddress ?? "123 Main St",
    addressLine1: overrides.addressLine1 ?? "123 Main St",
    addressLine2: overrides.addressLine2 ?? null,
    city: overrides.city ?? "City",
    region: overrides.region ?? "ST",
    postalCode: overrides.postalCode ?? "12345",
    countryCode: overrides.countryCode ?? "US",
    timezone: overrides.timezone ?? null,
    capacity: overrides.capacity ?? null,
    lat: overrides.lat ?? null,
    lng: overrides.lng ?? null,
    status: overrides.status ?? "ACTIVE",
    verificationStatus: overrides.verificationStatus ?? "UNVERIFIED",
    orgIdsWithAccess: overrides.orgIdsWithAccess ?? [],
    humanIdsWithAccess: overrides.humanIdsWithAccess ?? [DEFAULT_ACTOR_ID],
    phone: overrides.phone ?? null,
    website: overrides.website ?? null,
    listedInDirectory: overrides.listedInDirectory ?? false,
    acceptsBookingRequests: overrides.acceptsBookingRequests ?? false,
    attendeeReviewsPublic: overrides.attendeeReviewsPublic ?? false,
    defaultPrimaryPayoutTermsId: overrides.defaultPrimaryPayoutTermsId ?? null,
    defaultResalePayoutTermsId: overrides.defaultResalePayoutTermsId ?? null,
    createdAt: overrides.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2024-01-01T00:00:00.000Z"),
  } satisfies PlaceRecord;
}

type BuildDepsOptions = {
  placeRecord?: PlaceRecord | null;
  membership?: OrgMembership | null;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const placesRepo = {
    getById: vi.fn(async () =>
      Object.prototype.hasOwnProperty.call(options, "placeRecord")
        ? options.placeRecord
        : buildPlaceRecord(),
    ),
  };

  const membershipValue = Object.prototype.hasOwnProperty.call(
    options,
    "membership",
  )
    ? options.membership
    : ({
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "ADMIN",
      } satisfies OrgMembership);

  const authzRepo = {
    getOrgMemberships: vi.fn(async () =>
      membershipValue ? [membershipValue] : [],
    ),
  };

  const repos = {
    places: placesRepo,
    authz: authzRepo,
  } as unknown as Repos;

  const deps: GetPlaceTitleDeps = {
    repos: repos as GetPlaceTitleDeps["repos"],
  };

  return { deps, mocks: { placesRepo, authzRepo } };
}

describe("getPlaceTitle", () => {
  it("returns the light title payload for a place owned by the requesting human", async () => {
    const place = buildPlaceRecord({
      name: "The Basement",
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await getPlaceTitle(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    // The whole contract: id, name, status, verification, plus the zone
    // name (the one allowed non-identity field: coarse, not a location) —
    // and nothing else (no address/access leakage from the edit payload, and
    // no `slug`: `Place.slug` was a directory key nothing routed on, now
    // deprecated).
    expect(result).toEqual({
      id: DEFAULT_PLACE_ID,
      name: "The Basement",
      status: "ACTIVE",
      verification: "VERIFIED",
      timezone: null,
    });
    expect(mocks.placesRepo.getById).toHaveBeenCalledWith(DEFAULT_PLACE_ID);
    // No org membership check needed — direct human owner.
    expect(mocks.authzRepo.getOrgMemberships).not.toHaveBeenCalled();
  });

  it("returns the place's own zone, and null (not a default) when it has none", async () => {
    const withZone = buildDeps({
      placeRecord: buildPlaceRecord({ timezone: "America/New_York" }),
    });
    const a = await getPlaceTitle(withZone.deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });
    expect(a.timezone).toBe("America/New_York");

    const without = buildDeps({
      placeRecord: buildPlaceRecord({ timezone: null }),
    });
    const b = await getPlaceTitle(without.deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });
    expect(b.timezone).toBeNull();
  });

  it("returns a place owned by an org the actor belongs to", async () => {
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });
    const membership: OrgMembership = {
      orgId: DEFAULT_ORG_ID,
      humanId: DEFAULT_ACTOR_ID,
      role: "ADMIN",
    };
    const { deps, mocks } = buildDeps({ placeRecord: place, membership });

    const result = await getPlaceTitle(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result.id).toBe(DEFAULT_PLACE_ID);
    expect(mocks.authzRepo.getOrgMemberships).toHaveBeenCalledWith({
      orgIds: [DEFAULT_ORG_ID],
      humanId: DEFAULT_ACTOR_ID,
    });
  });

  it("accepts ANY org role — place access is boolean ownership (spec D4)", async () => {
    const roles: OrgRole[] = [
      "OWNER",
      "ADMIN",
      "EDITOR",
      "FINANCE",
      "SCANNER",
      "VIEWER",
    ];

    for (const role of roles) {
      const place = buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      });
      const { deps } = buildDeps({
        placeRecord: place,
        membership: {
          orgId: DEFAULT_ORG_ID,
          humanId: DEFAULT_ACTOR_ID,
          role,
        },
      });

      const result = await getPlaceTitle(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      });

      expect(result.name).toBe("Test Place");
    }
  });

  it("throws not_found when place does not exist", async () => {
    const { deps } = buildDeps({ placeRecord: null });

    await expect(
      getPlaceTitle(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("throws forbidden when actor has no ownership at all", async () => {
    const otherHumanId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const place = buildPlaceRecord({
      humanIdsWithAccess: [otherHumanId],
      orgIdsWithAccess: [],
    });
    const { deps } = buildDeps({ placeRecord: place, membership: null });

    await expect(
      getPlaceTitle(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws forbidden when actor is not a member of the owning org", async () => {
    // Same shape as a revoked/lapsed membership: the authz repo returns no
    // membership rows for the owning orgs. Ownership-revocation filtering
    // itself lives in the repo (the access arrays arrive pre-filtered),
    // matching getPlaceForEdit's exact semantics.
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });
    const { deps } = buildDeps({ placeRecord: place, membership: null });

    await expect(
      getPlaceTitle(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("emits no slug at all — the deprecated Place.slug is off the payload", async () => {
    const { deps } = buildDeps({ placeRecord: buildPlaceRecord() });

    const result = await getPlaceTitle(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result).not.toHaveProperty("slug");
  });

  it("rejects invalid input (missing placeId)", async () => {
    const { deps } = buildDeps();

    await expect(
      getPlaceTitle(deps, { actorHumanId: DEFAULT_ACTOR_ID }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
