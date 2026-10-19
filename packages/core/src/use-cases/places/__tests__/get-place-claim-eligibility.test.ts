import { describe, expect, it, vi } from "vitest";

import {
  getPlaceClaimEligibility,
  resolvePlaceClaimState,
} from "../get-place-claim-eligibility";
import type { GetPlaceClaimEligibilityDeps } from "../get-place-claim-eligibility";

import type { PlaceRecord } from "@th/ports/repos/places";
import type { PlaceOwnershipRecord } from "@th/types/repos/place-verification";
import type { EntityPageRecord } from "@th/types/repos/entity-pages";

const PLACE = "33333333-3333-4333-8333-333333333333";
const ORG = "22222222-2222-4222-8222-222222222222";
const HUMAN = "11111111-1111-4111-8111-111111111111";

function buildPlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE,
    name: "The Fillmore",
    slug: "the-fillmore",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    formattedAddress: "1805 Geary Blvd",
    addressLine1: "1805 Geary Blvd",
    addressLine2: null,
    city: "San Francisco",
    region: "CA",
    postalCode: "94115",
    countryCode: "US",
    capacity: 1200,
    lat: null,
    lng: null,
    phone: null,
    website: "https://thefillmore.com",
    websiteSource: "USER_STUB",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
    listedInDirectory: false,
    acceptsBookingRequests: false,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    ...overrides,
  } satisfies PlaceRecord;
}

function buildOwnership(
  overrides: Partial<PlaceOwnershipRecord> = {},
): PlaceOwnershipRecord {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    placeId: PLACE,
    ownerType: "ORGANIZATION",
    ownerId: ORG,
    verified: true,
    reviewerHumanId: null,
    reviewedAt: new Date("2026-07-02T00:00:00.000Z"),
    revokedAt: null,
    proof: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    ...overrides,
  } satisfies PlaceOwnershipRecord;
}

function buildPage(overrides: Partial<EntityPageRecord> = {}): EntityPageRecord {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    ownerType: "ORGANIZATION",
    ownerId: ORG,
    slug: "bay-area-festivals",
    displayName: "Bay Area Festivals",
    bio: null,
    avatarUrl: null,
    bannerUrl: null,
    visibility: "PUBLIC",
    allowFollows: true,
    showFollowerCount: false,
    category: null,
    templateAppliedCategories: [],
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as EntityPageRecord;
}

type Overrides = {
  place?: PlaceRecord;
  /**
   * What the repo returns. The repo method itself filters on
   * `verified = true AND revokedAt IS NULL`, so a revoked / unverified row is
   * modelled here as `null` (see the dedicated cases below).
   */
  verifiedOwner?: PlaceOwnershipRecord | null;
  activeClaim?: unknown;
  page?: EntityPageRecord | null;
  org?: { id: string; name: string } | null;
  human?: { id: string; name: string | null } | null;
  pageThrows?: boolean;
};

function buildDeps(overrides: Overrides = {}) {
  const reportError = vi.fn();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  const deps = {
    repos: {
      places: {
        getById: vi.fn(async () => overrides.place ?? buildPlace()),
        getVerifiedOwnershipForPlace: vi.fn(
          async () => overrides.verifiedOwner ?? null,
        ),
      },
      placeVerificationRequests: {
        getActiveClaimForPlace: vi.fn(async () => overrides.activeClaim ?? null),
      },
      entityPages: {
        getByOwner: vi.fn(async () => {
          if (overrides.pageThrows) throw new Error("entity_page_read_failed");
          return overrides.page === undefined ? buildPage() : overrides.page;
        }),
      },
      organizations: {
        getById: vi.fn(async () =>
          overrides.org === undefined ? { id: ORG, name: "Bay Area Festivals" } : overrides.org,
        ),
      },
      humans: {
        getById: vi.fn(async () =>
          overrides.human === undefined
            ? { id: HUMAN, name: "Morgan Kowalski" }
            : overrides.human,
        ),
      },
    },
    logger,
    reportError,
  } as unknown as GetPlaceClaimEligibilityDeps;

  return { deps, reportError, logger };
}

describe("getPlaceClaimEligibility — owner display (FR-007)", () => {
  it("names an ORGANIZATION owner and links its public page", async () => {
    const { deps } = buildDeps({
      verifiedOwner: buildOwnership(),
      place: buildPlace({ verificationStatus: "VERIFIED" }),
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("already_claimed");
    expect(out.owner).toEqual({
      type: "ORGANIZATION",
      displayName: "Bay Area Festivals",
      pageSlug: "bay-area-festivals",
    });
  });

  it("never names an ORGANIZATION owner with no entity page (uniform rule)", async () => {
    // An org name is only *usually* public (it rides published events). A sole
    // operator's self-identifying org with no page must not be first published
    // by this anonymous read.
    const { deps } = buildDeps({ verifiedOwner: buildOwnership(), page: null });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("already_claimed");
    expect(out.owner).toBeNull();
  });

  it("never names an ORGANIZATION owner whose page is PRIVATE", async () => {
    const { deps } = buildDeps({
      verifiedOwner: buildOwnership(),
      page: buildPage({ visibility: "PRIVATE" }),
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.owner).toBeNull();
  });

  it("never names an ORGANIZATION owner whose page is UNLISTED", async () => {
    // UNLISTED means "reachable by URL, not discoverable". Naming + linking it
    // from a public venue page IS discovery.
    const { deps } = buildDeps({
      verifiedOwner: buildOwnership(),
      page: buildPage({ visibility: "UNLISTED" }),
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.owner).toBeNull();
  });

  it("never names a HUMAN owner whose page is UNLISTED", async () => {
    const { deps } = buildDeps({
      verifiedOwner: buildOwnership({ ownerType: "HUMAN", ownerId: HUMAN }),
      page: buildPage({
        ownerType: "HUMAN",
        ownerId: HUMAN,
        slug: "morgan-kowalski",
        visibility: "UNLISTED",
      }),
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.owner).toBeNull();
  });

  it("falls back to Organization.name when a PUBLIC page has no displayName", async () => {
    const { deps } = buildDeps({
      verifiedOwner: buildOwnership(),
      page: buildPage({ displayName: null }),
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.owner).toEqual({
      type: "ORGANIZATION",
      displayName: "Bay Area Festivals",
      pageSlug: "bay-area-festivals",
    });
  });

  it("names a HUMAN owner with a PUBLIC entity page", async () => {
    const { deps } = buildDeps({
      verifiedOwner: buildOwnership({ ownerType: "HUMAN", ownerId: HUMAN }),
      page: buildPage({
        ownerType: "HUMAN",
        ownerId: HUMAN,
        slug: "morgan-kowalski",
        displayName: "Morgan Kowalski",
      }),
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.owner).toEqual({
      type: "HUMAN",
      displayName: "Morgan Kowalski",
      pageSlug: "morgan-kowalski",
    });
  });

  it("never names a HUMAN owner whose page is not PUBLIC (NFR-003)", async () => {
    const { deps } = buildDeps({
      verifiedOwner: buildOwnership({ ownerType: "HUMAN", ownerId: HUMAN }),
      page: buildPage({
        ownerType: "HUMAN",
        ownerId: HUMAN,
        slug: "morgan-kowalski",
        visibility: "PRIVATE",
      }),
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("already_claimed");
    expect(out.owner).toBeNull();
  });

  it("never names a HUMAN owner with no entity page at all (NFR-003)", async () => {
    const { deps } = buildDeps({
      verifiedOwner: buildOwnership({ ownerType: "HUMAN", ownerId: HUMAN }),
      page: null,
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.owner).toBeNull();
  });

  it("returns owner: null when a REVOKED ownership row is the only one", async () => {
    // A revoked row is filtered out by `getVerifiedOwnershipForPlace`
    // (`revokedAt IS NULL`), so the use case sees no owner at all — the place
    // stays claimable and nobody is named.
    const { deps } = buildDeps({ verifiedOwner: null });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("claimable");
    expect(out.owner).toBeNull();
  });

  it("returns owner: null when an UNVERIFIED (provisional) claim is the only ownership row", async () => {
    // `getVerifiedOwnershipForPlace` filters on `verified = true`; a provisional
    // row therefore never surfaces as "the owner". The in-flight claim shows as
    // pending instead.
    const { deps } = buildDeps({
      verifiedOwner: null,
      activeClaim: { id: "claim-1" },
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("pending");
    expect(out.owner).toBeNull();
  });

  it("returns owner: null for an unclaimed (claimable) place", async () => {
    const { deps } = buildDeps({ verifiedOwner: null });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("claimable");
    expect(out.owner).toBeNull();
    expect(out.reasons).toEqual([]);
  });

  it("still reports already_claimed with owner: null when the place is VERIFIED but has no ownership row", async () => {
    const { deps } = buildDeps({
      place: buildPlace({ verificationStatus: "VERIFIED" }),
      verifiedOwner: null,
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("already_claimed");
    expect(out.reasons).toEqual(["place_verified"]);
    expect(out.owner).toBeNull();
  });

  it("keeps the verified_owner_exists reason for an unverified place with a verified owner", async () => {
    const { deps } = buildDeps({ verifiedOwner: buildOwnership() });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("already_claimed");
    expect(out.reasons).toEqual(["verified_owner_exists"]);
  });

  it("degrades to owner: null AND reports when name resolution throws", async () => {
    const { deps, reportError, logger } = buildDeps({
      verifiedOwner: buildOwnership(),
      pageThrows: true,
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    // The claim state — which gates the dispute CTA — survives.
    expect(out.state).toBe("already_claimed");
    expect(out.owner).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "getPlaceClaimEligibility", ownerType: "ORGANIZATION" },
      extra: { placeId: PLACE },
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it("does not let a throwing reporter change the result", async () => {
    const { deps } = buildDeps({
      verifiedOwner: buildOwnership(),
      pageThrows: true,
    });
    (deps as { reportError?: () => void }).reportError = () => {
      throw new Error("sentry_down");
    };

    await expect(
      getPlaceClaimEligibility(deps, { placeId: PLACE }),
    ).resolves.toMatchObject({ state: "already_claimed", owner: null });
  });

  it("never resolves an owner for an archived place", async () => {
    const { deps } = buildDeps({
      place: buildPlace({ status: "ARCHIVED", verificationStatus: "VERIFIED" }),
      verifiedOwner: buildOwnership(),
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("not_eligible");
    expect(out.reasons).toEqual(["place_archived"]);
    expect(out.owner).toBeNull();
  });

  it("never resolves an owner for a SUSPENDED place", async () => {
    // Anyone holding the placeId can call this public read; a venue pulled from
    // public life must stop publishing who runs it.
    const { deps } = buildDeps({
      place: buildPlace({ status: "SUSPENDED", verificationStatus: "VERIFIED" }),
      verifiedOwner: buildOwnership(),
    });

    const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(out.state).toBe("not_eligible");
    expect(out.reasons).toEqual(["place_suspended"]);
    expect(out.owner).toBeNull();
  });

  it("does not even look up ownership for a non-ACTIVE place", async () => {
    const { deps } = buildDeps({
      place: buildPlace({ status: "SUSPENDED" }),
      verifiedOwner: buildOwnership(),
    });

    await getPlaceClaimEligibility(deps, { placeId: PLACE });

    expect(
      deps.repos.places.getVerifiedOwnershipForPlace,
    ).not.toHaveBeenCalled();
    expect(deps.repos.entityPages.getByOwner).not.toHaveBeenCalled();
  });
});

// The state decision is shared with the entity-page loader's `claimable` hint
// (entity-summary.ts), so the hero chip's server render and this public read
// cannot disagree. Pin the helper on its own, and pin that the use case's
// state and reasons ARE the helper's.
describe("resolvePlaceClaimState", () => {
  const ownership = buildOwnership();
  const cases: Array<[string, Overrides, string, string[]]> = [
    ["unverified, unowned, no claim", {}, "claimable", []],
    [
      "REJECTED",
      { place: buildPlace({ verificationStatus: "REJECTED" }) },
      "claimable",
      [],
    ],
    [
      "VERIFIED",
      { place: buildPlace({ verificationStatus: "VERIFIED" }) },
      "already_claimed",
      ["place_verified"],
    ],
    [
      "UNVERIFIED with a verified owner",
      { verifiedOwner: ownership },
      "already_claimed",
      ["verified_owner_exists"],
    ],
    [
      "PENDING status",
      { place: buildPlace({ verificationStatus: "PENDING" }) },
      "pending",
      ["verification_pending"],
    ],
    [
      "a claim in review",
      { activeClaim: { id: "req-1" } },
      "pending",
      ["claim_in_review"],
    ],
    [
      "ARCHIVED",
      { place: buildPlace({ status: "ARCHIVED" }) },
      "not_eligible",
      ["place_archived"],
    ],
    [
      "SUSPENDED",
      { place: buildPlace({ status: "SUSPENDED" }) },
      "not_eligible",
      ["place_suspended"],
    ],
  ];

  it.each(cases)(
    "%s → %s, and getPlaceClaimEligibility agrees",
    async (_label, overrides, state, reasons) => {
      const { deps } = buildDeps(overrides);
      const place = overrides.place ?? buildPlace();

      const resolved = await resolvePlaceClaimState(deps, place);
      expect(resolved.state).toBe(state);
      expect(resolved.reasons).toEqual(reasons);

      const out = await getPlaceClaimEligibility(deps, { placeId: PLACE });
      expect(out.state).toBe(state);
      expect(out.reasons).toEqual(reasons);
    },
  );

  it("hands back the verified ownership row, and never resolves a name", async () => {
    const { deps } = buildDeps({ verifiedOwner: ownership });

    const resolved = await resolvePlaceClaimState(deps, buildPlace());

    expect(resolved.verifiedOwner).toEqual(ownership);
    expect(deps.repos.entityPages.getByOwner).not.toHaveBeenCalled();
    expect(deps.repos.organizations.getById).not.toHaveBeenCalled();
    expect(deps.repos.humans.getById).not.toHaveBeenCalled();
  });

  it("skips the active-claim read once the place is already claimed", async () => {
    const { deps } = buildDeps({ verifiedOwner: ownership });

    await resolvePlaceClaimState(deps, buildPlace());

    expect(
      deps.repos.placeVerificationRequests.getActiveClaimForPlace,
    ).not.toHaveBeenCalled();
  });

  it("propagates a repo failure (no swallow)", async () => {
    const { deps } = buildDeps();
    const boom = new Error("db down");
    deps.repos.placeVerificationRequests.getActiveClaimForPlace = vi.fn(
      async () => {
        throw boom;
      },
    );

    await expect(resolvePlaceClaimState(deps, buildPlace())).rejects.toBe(boom);
  });
});
