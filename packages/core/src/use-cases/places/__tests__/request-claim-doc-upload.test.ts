import { describe, expect, it, vi } from "vitest";

import { requestClaimDocUpload } from "../request-claim-doc-upload";
import type { RequestClaimDocUploadDeps } from "../request-claim-doc-upload";

import type { PlaceRecord } from "@th/ports/repos/places";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PLACE = "33333333-3333-4333-8333-333333333333";
const ORG = "22222222-2222-4222-8222-222222222222";

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

function buildDeps(
  overrides: {
    place?: PlaceRecord;
    verifiedOwner?: unknown;
    activeClaim?: unknown;
    orgRoleAllowed?: boolean;
  } = {},
) {
  const placesRepo = {
    getById: vi.fn(async () => overrides.place ?? buildPlace()),
    getVerifiedOwnershipForPlace: vi.fn(async () => overrides.verifiedOwner ?? null),
  };
  const verificationRequestsRepo = {
    getActiveClaimForPlace: vi.fn(async () => overrides.activeClaim ?? null),
  };
  const resourceQuotas = {
    // Unlimited effective quota → enforceQuota short-circuits without needing
    // the full quota machinery; we only care about the auth gate + increment.
    getEffectiveQuota: vi.fn(async () => ({
      limitValue: 9_999_999_999n,
      currentUsage: 0n,
    })),
    hasPendingExpansionRequest: vi.fn(async () => false),
    incrementUsage: vi.fn(async () => undefined),
  };
  const storage = {
    presignPutObject: vi.fn(async () => ({
      uploadUrl: "https://storage.example/put?sig=abc",
    })),
  };
  const authz = {
    hasOrgRole: vi.fn(async () => ({
      allowed: overrides.orgRoleAllowed ?? true,
    })),
  };

  const deps = {
    repos: {
      places: placesRepo,
      placeVerificationRequests: verificationRequestsRepo,
      resourceQuotas,
    },
    authz,
    storage,
    clock: { now: () => new Date("2026-07-05T00:00:00.000Z") },
  } as unknown as RequestClaimDocUploadDeps;

  return { deps, placesRepo, storage, resourceQuotas, authz };
}

const BASE_INPUT = {
  actorHumanId: ACTOR,
  placeId: PLACE,
  contentType: "application/pdf" as const,
  sizeBytes: 1000,
  fileName: "lease.pdf",
};

describe("requestClaimDocUpload — claim context", () => {
  it("presigns for a claimant on a CLAIMABLE stub (not an owner)", async () => {
    const { deps, storage, resourceQuotas } = buildDeps();
    const out = await requestClaimDocUpload(deps, {
      ...BASE_INPUT,
      context: "claim",
    });
    expect(out.uploadUrl).toContain("https://");
    expect(out.key).toMatch(/^place-verification\//);
    expect(storage.presignPutObject).toHaveBeenCalledOnce();
    // HUMAN claim (no orgId) → no org storage quota charged.
    expect(resourceQuotas.incrementUsage).not.toHaveBeenCalled();
  });

  it("rejects a claim presign on a VERIFIED (already-owned) place", async () => {
    const { deps } = buildDeps({
      place: buildPlace({ verificationStatus: "VERIFIED" }),
    });
    await expect(
      requestClaimDocUpload(deps, { ...BASE_INPUT, context: "claim" }),
    ).rejects.toMatchObject({ code: "PLACE_ALREADY_CLAIMED" });
  });

  it("rejects a claim presign when a claim is already pending", async () => {
    const { deps } = buildDeps({ activeClaim: { id: "req" } });
    await expect(
      requestClaimDocUpload(deps, { ...BASE_INPUT, context: "claim" }),
    ).rejects.toMatchObject({ code: "CLAIM_ALREADY_PENDING" });
  });

  it("rejects a claim presign on an ARCHIVED place", async () => {
    const { deps } = buildDeps({ place: buildPlace({ status: "ARCHIVED" }) });
    await expect(
      requestClaimDocUpload(deps, { ...BASE_INPUT, context: "claim" }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_CLAIMABLE" });
  });
});

describe("requestClaimDocUpload — org quota authorization (security)", () => {
  it("rejects charging an org's quota when the actor is NOT an org admin", async () => {
    const { deps, authz, resourceQuotas, storage } = buildDeps({
      orgRoleAllowed: false,
    });
    await expect(
      requestClaimDocUpload(deps, {
        ...BASE_INPUT,
        context: "claim",
        orgId: ORG,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    // The org-membership gate must be consulted, and NO quota mutation or
    // presign happens for the unauthorized org.
    expect(authz.hasOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ actorHumanId: ACTOR, orgId: ORG }),
    );
    expect(resourceQuotas.incrementUsage).not.toHaveBeenCalled();
    expect(storage.presignPutObject).not.toHaveBeenCalled();
  });

  it("presigns and charges the org quota when the actor IS an org admin", async () => {
    const { deps, authz, resourceQuotas, storage } = buildDeps({
      orgRoleAllowed: true,
    });
    const out = await requestClaimDocUpload(deps, {
      ...BASE_INPUT,
      context: "claim",
      orgId: ORG,
    });
    expect(out.uploadUrl).toContain("https://");
    expect(authz.hasOrgRole).toHaveBeenCalledOnce();
    expect(storage.presignPutObject).toHaveBeenCalledOnce();
    expect(resourceQuotas.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "ORG", subjectId: ORG }),
    );
  });
});

describe("requestClaimDocUpload — dispute context", () => {
  it("presigns when the place is already owned/verified", async () => {
    const { deps, storage } = buildDeps({
      place: buildPlace({ verificationStatus: "VERIFIED" }),
      verifiedOwner: { id: "own", ownerType: "HUMAN" },
    });
    const out = await requestClaimDocUpload(deps, {
      ...BASE_INPUT,
      context: "dispute",
    });
    expect(out.uploadUrl).toContain("https://");
    expect(storage.presignPutObject).toHaveBeenCalledOnce();
  });

  it("rejects a dispute presign on an unowned/unverified place", async () => {
    const { deps } = buildDeps(); // UNVERIFIED, no verified owner
    await expect(
      requestClaimDocUpload(deps, { ...BASE_INPUT, context: "dispute" }),
    ).rejects.toMatchObject({ code: "CLAIM_DISPUTE_NOT_APPLICABLE" });
  });
});
