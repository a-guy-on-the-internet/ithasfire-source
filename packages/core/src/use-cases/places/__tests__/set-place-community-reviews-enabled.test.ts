import { describe, expect, it, vi } from "vitest";

import { setPlaceCommunityReviewsEnabled } from "../set-place-community-reviews-enabled";
import type { SetPlaceCommunityReviewsEnabledDeps } from "../set-place-community-reviews-enabled";
import type { PlaceFlag, PlaceRecord } from "@th/ports/repos/places";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";

const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_ORG_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-24T12:00:00.000Z");

function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: overrides.id ?? DEFAULT_PLACE_ID,
    name: overrides.name ?? "Fishbowl House",
    formattedAddress: overrides.formattedAddress ?? "123 Main St",
    addressLine1: overrides.addressLine1 ?? "123 Main St",
    addressLine2: overrides.addressLine2 ?? null,
    city: overrides.city ?? "City",
    region: overrides.region ?? "ST",
    postalCode: overrides.postalCode ?? "12345",
    countryCode: overrides.countryCode ?? "US",
    addressHash: overrides.addressHash ?? null,
    admissionTaxRateBps: overrides.admissionTaxRateBps ?? null,
    taxRateSource: overrides.taxRateSource ?? null,
    taxRateFetchedAt: overrides.taxRateFetchedAt ?? null,
    timezone: overrides.timezone ?? null,
    websiteSource: overrides.websiteSource ?? "UNKNOWN",
    capacity: overrides.capacity ?? null,
    lat: overrides.lat ?? null,
    lng: overrides.lng ?? null,
    locationMode: overrides.locationMode ?? "OBSCURED",
    locationRadiusMeters: overrides.locationRadiusMeters ?? null,
    locationLabel: overrides.locationLabel ?? null,
    status: overrides.status ?? "ACTIVE",
    verificationStatus: overrides.verificationStatus ?? "UNVERIFIED",
    orgIdsWithAccess: overrides.orgIdsWithAccess ?? [],
    humanIdsWithAccess: overrides.humanIdsWithAccess ?? [DEFAULT_ACTOR_ID],
    phone: overrides.phone ?? null,
    website: overrides.website ?? null,
    listedInDirectory: overrides.listedInDirectory ?? false,
    acceptsBookingRequests: overrides.acceptsBookingRequests ?? false,
    acceptsCommunityListings: overrides.acceptsCommunityListings ?? false,
    attendeeReviewsPublic: overrides.attendeeReviewsPublic ?? false,
    communityReviewsEnabled: overrides.communityReviewsEnabled ?? true,
    defaultPrimaryPayoutTermsId: overrides.defaultPrimaryPayoutTermsId ?? null,
    defaultResalePayoutTermsId: overrides.defaultResalePayoutTermsId ?? null,
    createdAt: overrides.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2024-01-01T00:00:00.000Z"),
  } satisfies PlaceRecord;
}

type BuildDepsOptions = {
  placeRecord?: PlaceRecord | null;
  membership?: OrgMembership | null;
  /** Multi-org actor — the answer must not depend on row order. */
  memberships?: OrgMembership[];
};

function buildDeps(options: BuildDepsOptions = {}) {
  const placesRepo = {
    getById: vi.fn(async () =>
      Object.prototype.hasOwnProperty.call(options, "placeRecord")
        ? options.placeRecord
        : buildPlaceRecord(),
    ),
    // Whole-row rebuild: must never be called by a switch flip.
    upsert: vi.fn(),
    // Stateful like the adapter's compare-and-set: `changed` only when the
    // stored row held the opposite value.
    setFlag: vi.fn(
      async (input: { placeId: string; flag: PlaceFlag; value: boolean }) => {
        const row = Object.prototype.hasOwnProperty.call(options, "placeRecord")
          ? options.placeRecord
          : buildPlaceRecord();
        return { changed: !!row && row[input.flag] !== input.value };
      },
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

  const membershipList: OrgMembership[] = Object.prototype.hasOwnProperty.call(
    options,
    "memberships",
  )
    ? (options.memberships ?? [])
    : membershipValue
      ? [membershipValue]
      : [];

  const authzRepo = {
    // Mirrors the real adapter's `where: { humanId, orgId: { in: orgIds } }`
    // so the mock can never be more permissive than production.
    getOrgMemberships: vi.fn(
      async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        membershipList.filter(
          (m) => orgIds.includes(m.orgId) && m.humanId === humanId,
        ),
    ),
  };

  const auditRepo = { log: vi.fn(async () => {}) };

  const txRepos = {
    places: placesRepo,
    authz: authzRepo,
    audit: auditRepo,
  };
  const tx = vi.fn(async (fn: (r: typeof txRepos) => Promise<unknown>) =>
    fn(txRepos),
  );
  // Outside the transaction the writers throw, so a write or audit that
  // escapes the tx callback fails the test instead of passing silently.
  const outsideTx = () => {
    throw new Error("written outside repos.tx");
  };
  const repos = {
    ...txRepos,
    places: { ...placesRepo, setFlag: vi.fn(outsideTx) },
    audit: { log: vi.fn(outsideTx) },
    tx,
  } as unknown as Repos;

  const deps: SetPlaceCommunityReviewsEnabledDeps = {
    repos: repos as SetPlaceCommunityReviewsEnabledDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks: { placesRepo, authzRepo, auditRepo, tx } };
}

describe("setPlaceCommunityReviewsEnabled", () => {
  it("a direct human owner turns performer reviews OFF and the disable is audited", async () => {
    const place = buildPlaceRecord({
      communityReviewsEnabled: true,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceCommunityReviewsEnabled(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      enabled: false,
    });

    expect(result).toEqual({
      placeId: DEFAULT_PLACE_ID,
      communityReviewsEnabled: false,
    });
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      flag: "communityReviewsEnabled",
      value: false,
    });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place",
        action: "place.community_reviews_disabled",
        data: expect.objectContaining({ previous: true, next: false }),
      }),
    );
    // A direct owner needs no org lookup at all.
    expect(mocks.authzRepo.getOrgMemberships).not.toHaveBeenCalled();
  });

  it("turns performer reviews back ON and audits the enable", async () => {
    const place = buildPlaceRecord({
      communityReviewsEnabled: false,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceCommunityReviewsEnabled(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      enabled: true,
    });

    expect(result.communityReviewsEnabled).toBe(true);
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      flag: "communityReviewsEnabled",
      value: true,
    });
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.community_reviews_enabled",
        data: expect.objectContaining({ previous: false, next: true }),
      }),
    );
  });

  it("never writes the ATTENDEE flag — the two tiers are independent (FR-001)", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({ humanIdsWithAccess: [DEFAULT_ACTOR_ID] }),
    });

    await setPlaceCommunityReviewsEnabled(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      enabled: false,
    });

    expect(mocks.placesRepo.setFlag).toHaveBeenCalledTimes(1);
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledWith(
      expect.objectContaining({ flag: "communityReviewsEnabled" }),
    );
  });

  it("is idempotent: the CAS changes nothing when already in the requested state, but still audits", async () => {
    const place = buildPlaceRecord({
      communityReviewsEnabled: true,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceCommunityReviewsEnabled(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      enabled: true,
    });

    expect(result.communityReviewsEnabled).toBe(true);
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.community_reviews_enabled",
        data: expect.objectContaining({ previous: true, next: true }),
      }),
    );
  });

  it("throws PLACE_NOT_FOUND for an unknown place, writing nothing", async () => {
    const { deps, mocks } = buildDeps({ placeRecord: null });

    await expect(
      setPlaceCommunityReviewsEnabled(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("rejects malformed input before any read", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      setPlaceCommunityReviewsEnabled(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        enabled: "no",
      }),
    ).rejects.toBeDefined();
    expect(mocks.placesRepo.getById).not.toHaveBeenCalled();
  });

  // ── The org-role bar ─────────────────────────────────────────────────────
  // ORG_ADMIN_ROLES, the same bar as the other three place switches (FR-005).
  // EDITOR is refused on purpose: `ensurePlaceOwnerAccess` would admit it,
  // which is exactly why this use case does not call that helper.

  const ORG_OWNED_PLACE = () =>
    buildPlaceRecord({
      communityReviewsEnabled: true,
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });

  for (const role of ["OWNER", "ADMIN"] as const) {
    it(`an org ${role} of an owning org may flip the switch`, async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: ORG_OWNED_PLACE(),
        membership: { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role },
      });

      const result = await setPlaceCommunityReviewsEnabled(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        enabled: false,
      });

      expect(result.communityReviewsEnabled).toBe(false);
      expect(mocks.placesRepo.setFlag).toHaveBeenCalled();
      expect(mocks.authzRepo.getOrgMemberships).toHaveBeenCalledWith({
        orgIds: [DEFAULT_ORG_ID],
        humanId: DEFAULT_ACTOR_ID,
      });
    });
  }

  for (const role of ["EDITOR", "SCANNER", "VIEWER", "FINANCE"] as const) {
    it(`an org ${role} is refused with NOT_RESOURCE_OWNER — membership alone is not ownership`, async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: ORG_OWNED_PLACE(),
        membership: { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role },
      });

      await expect(
        setPlaceCommunityReviewsEnabled(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          enabled: false,
        }),
      ).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "place" },
      });
      expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });
  }

  it("a SCANNER in one owning org but OWNER in another may flip it", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID, SECOND_ORG_ID],
      }),
      memberships: [
        { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "SCANNER" },
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "OWNER" },
      ],
    });

    const result = await setPlaceCommunityReviewsEnabled(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      enabled: false,
    });

    expect(result.communityReviewsEnabled).toBe(false);
    expect(mocks.placesRepo.setFlag).toHaveBeenCalled();
  });

  it("an OWNER role in an org that does NOT own this place grants nothing", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: ORG_OWNED_PLACE(),
      memberships: [
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "OWNER" },
      ],
    });

    await expect(
      setPlaceCommunityReviewsEnabled(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
  });
});

describe("setPlaceCommunityReviewsEnabled — one-column write (no whole-row rebuild)", () => {
  it("writes ONLY communityReviewsEnabled and never calls upsert: setFlag gets exactly {placeId, flag, value}", async () => {
    const place = {
      ...buildPlaceRecord({
        communityReviewsEnabled: true,
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      }),
      addressLine1: null,
      countryCode: null,
    };
    const { deps, mocks } = buildDeps({ placeRecord: place });

    await setPlaceCommunityReviewsEnabled(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      enabled: false,
    });

    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledTimes(1);
    const [args] = mocks.placesRepo.setFlag.mock.calls[0]!;
    expect(args).toEqual({
      placeId: DEFAULT_PLACE_ID,
      flag: "communityReviewsEnabled",
      value: false,
    });
  });

  it("writes and audits in ONE transaction", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        communityReviewsEnabled: true,
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      }),
    });

    // Record whether each write ran INSIDE the tx callback.
    let inTx = false;
    const runTx = mocks.tx.getMockImplementation()!;
    mocks.tx.mockImplementation(async (cb) => {
      inTx = true;
      try {
        return await runTx(cb);
      } finally {
        inTx = false;
      }
    });
    const seen: Array<[string, boolean]> = [];
    mocks.placesRepo.setFlag.mockImplementationOnce(async () => {
      seen.push(["setFlag", inTx]);
      return { changed: true };
    });
    mocks.auditRepo.log.mockImplementationOnce(async () => {
      seen.push(["audit", inTx]);
    });

    await setPlaceCommunityReviewsEnabled(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      enabled: false,
    });

    expect(mocks.tx).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      ["setFlag", true],
      ["audit", true],
    ]);
  });

  it("throws PLACE_NOT_FOUND when the row is gone by the write (no audit)", async () => {
    const place = buildPlaceRecord({ communityReviewsEnabled: true, humanIdsWithAccess: [DEFAULT_ACTOR_ID] });
    const { deps, mocks } = buildDeps({ placeRecord: place });
    // Deleted or merged between the read and the transaction.
    mocks.placesRepo.getById
      .mockResolvedValueOnce(place)
      .mockResolvedValueOnce(null);
    mocks.placesRepo.setFlag.mockResolvedValueOnce({ changed: false });

    await expect(
      setPlaceCommunityReviewsEnabled(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(mocks.placesRepo.getById).toHaveBeenCalledTimes(2);
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("audit previous comes from the WRITE, not a stale read", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        communityReviewsEnabled: true,
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      }),
    });
    // Read says ON; a concurrent request already turned it OFF.
    mocks.placesRepo.setFlag.mockResolvedValueOnce({ changed: false });

    await setPlaceCommunityReviewsEnabled(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      enabled: false,
    });

    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ previous: false, next: false }),
      }),
    );
  });
});
