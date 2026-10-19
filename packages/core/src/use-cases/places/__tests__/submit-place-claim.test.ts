import { describe, expect, it, vi } from "vitest";

import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { MAX_OPEN_CLAIMS_PER_ACTOR, submitPlaceClaim } from "../submit-place-claim";
import type { SubmitPlaceClaimDeps } from "../submit-place-claim";

import type { PlaceRecord, PlaceWebsiteSource } from "@th/ports/repos/places";
// Deliberate cross-layer import: the regression at the bottom of this file
// asserts on the provenance the REAL bulk-import adapter writes, not a
// hardcoded copy of it.
import { makePlacesRepo } from "../../../../../adapters/src/db/prisma/places";

const BASE_DATE = new Date("2026-07-05T00:00:00.000Z");
const ACTOR = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const PLACE = "33333333-3333-4333-8333-333333333333";
const OWNERSHIP = "55555555-5555-4555-8555-555555555555";
const REQUEST = "66666666-6666-4666-8666-666666666666";
const CHALLENGE = "77777777-7777-4777-8777-777777777777";

function buildPlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE,
    name: "The Fillmore",
    slug: "the-fillmore",
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    formattedAddress: "1805 Geary Blvd",
    addressLine1: "1805 Geary Blvd",
    addressLine2: null,
    city: "San Francisco",
    region: "CA",
    postalCode: "94115",
    countryCode: "US",
    capacity: 1200,
    lat: 37.78,
    lng: -122.43,
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
    orgRoleAllowed?: boolean;
    verifiedOwner?: unknown;
    activeClaim?: unknown;
    /**
     * Open claims the ACTOR has filed: a number, or a per-claimant map (any
     * claimant not in the map has 0).
     */
    openClaimCount?: number | Record<string, number>;
    identityEmail?: string;
    emailVerified?: boolean;
    challenge?: {
      placeId: string;
      humanId: string;
      verifiedAt: Date | null;
      email: string;
    } | null;
    /** Booking requests parked at the place while it was unclaimed. */
    /** FR-007 count, or an Error to force its deliberate swallow. */
    communityListingCount?: number | Error;
  } = {},
) {
  const place = overrides.place ?? buildPlace();

  const created: Record<string, unknown> = {};

  const placesRepo = {
    getById: vi.fn(async () => place),
    upsert: vi.fn(async (input: any) => ({ ...place, ...input })),
    setVerificationStatus: vi.fn(async (_input: any) => ({ changed: true })),
    setDirectoryListing: vi.fn(async (_input: any) => ({ changed: true })),
    lockPlaceForClaim: vi.fn(async () => undefined),
    getVerifiedOwnershipForPlace: vi.fn(
      async () => overrides.verifiedOwner ?? null,
    ),
    lockClaimsByActor: vi.fn(async (_actorHumanId: string) => undefined),
    createProvisionalOwnership: vi.fn(async (input: any) => {
      created.ownership = input;
      return {
        id: OWNERSHIP,
        placeId: input.placeId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        verified: false,
        reviewerHumanId: null,
        reviewedAt: null,
        revokedAt: null,
        proof: input.proof,
        createdAt: BASE_DATE,
        updatedAt: BASE_DATE,
      };
    }),
    verifyOwnership: vi.fn(async (input: any) => {
      created.verified = input;
      return { id: input.ownershipId } as any;
    }),
  };

  const verificationRequestsRepo = {
    getActiveClaimForPlace: vi.fn(async () => overrides.activeClaim ?? null),
    countOpenClaimsByClaimant: vi.fn(async (claimantHumanId: string) => {
      const c = overrides.openClaimCount;
      if (c === undefined) return 0;
      return typeof c === "number" ? c : (c[claimantHumanId] ?? 0);
    }),
    create: vi.fn(async (input: any) => {
      created.request = input;
      return {
        id: REQUEST,
        placeId: input.placeId,
        orgId: input.orgId ?? null,
        submittedById: input.submittedById,
        status: "PENDING" as const,
        source: input.source,
        claimantHumanId: input.claimantHumanId ?? null,
        claimOwnerType: input.claimOwnerType ?? null,
        claimOwnerId: input.claimOwnerId ?? null,
        ownershipId: input.ownershipId ?? null,
        reviewerNotes: null,
        reviewerHumanId: null,
        reviewedAt: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        createdAt: BASE_DATE,
        updatedAt: BASE_DATE,
      };
    }),
  };

  const verificationDocumentsRepo = {
    createMany: vi.fn(async () => []),
  };

  const humansRepo = {
    getByIdWithIdentity: vi.fn(async () => ({
      human: { id: ACTOR },
      identity: {
        authUserId: ACTOR,
        email: overrides.identityEmail ?? "owner@thefillmore.com",
        emailVerified: overrides.emailVerified ?? true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    })),
  };

  const challengeRepo = {
    getById: vi.fn(async () =>
      overrides.challenge === undefined
        ? {
            id: CHALLENGE,
            placeId: PLACE,
            humanId: ACTOR,
            email: "owner@thefillmore.com",
            codeHash: "x",
            expiresAt: new Date(BASE_DATE.getTime() + 60_000),
            verifiedAt: BASE_DATE,
            attempts: 0,
            createdAt: BASE_DATE,
          }
        : overrides.challenge,
    ),
  };

  const auditRepo = { log: vi.fn(async () => undefined) };
  const authzRepo = {
    listHumanIdsByStaffRole: vi.fn(async () => ["admin-1"]),
  };
  const notificationsRepo = { create: vi.fn(async () => ({ id: "n", createdAt: BASE_DATE })) };

  // A TRIPWIRE since the 2026-09-25 amendment removed parking: a claim no
  // longer touches any booking request, so nothing here may be called.
  const bookingRequestsRepo = {
    listOpenParked: vi.fn(async () => []),
    expireParked: vi.fn(async () => null),
    touchLastMessageAt: vi.fn(async () => undefined),
  };

  // Without this fake markForSearchReindex treats the structural double as
  // a repos bag that predates the repo and skips the mark silently.
  // The tx hands its callback a DISTINCT bag whose searchReindexPending is
  // the one returned; the outer bag's must never be marked, so a mark made
  // outside the transaction shows up as a call on the wrong fake.
  const searchReindexPending = { mark: vi.fn(async (..._args: any[]) => undefined) };
  const outsideTxSearchReindexPending = {
    mark: vi.fn(async (..._args: any[]) => undefined),
  };

  const repos = {
    tx: vi.fn(async (fn: any) => fn({ ...repos, searchReindexPending })),
    places: placesRepo,
    searchReindexPending: outsideTxSearchReindexPending,
    placeVerificationRequests: verificationRequestsRepo,
    placeVerificationDocuments: verificationDocumentsRepo,
    placeClaimEmailChallenges: challengeRepo,
    humans: humansRepo,
    audit: auditRepo,
    authz: authzRepo,
    notifications: notificationsRepo,
    bookingRequests: bookingRequestsRepo,
    bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
    // FR-005/FR-007: the count rides back on the claim result, because a
    // provisional claimant cannot reach `getPlaceForEdit` to ask for it.
    events: {
      countCommunityListingsAtPlace: vi.fn(async () => {
        const c = overrides.communityListingCount;
        if (c instanceof Error) throw c;
        return c ?? 0;
      }),
    },
  } as unknown as SubmitPlaceClaimDeps["repos"];

  const authz = {
    hasOrgRole: vi.fn(async () => ({
      allowed: overrides.orgRoleAllowed ?? true,
    })),
  };

  const idem = {
    begin: vi.fn(async () => true),
    get: vi.fn(async () => null),
    commit: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    run: vi.fn(),
  };

  const storage = {
    headObject: vi.fn(async () => ({ exists: true, size: 1000 })),
    deleteObject: vi.fn(async () => ({ ok: true as const })),
  };

  const deps = {
    repos,
    authz: authz as any,
    idempotency: idem as any,
    clock: { now: () => BASE_DATE },
    storage,
  } satisfies SubmitPlaceClaimDeps;

  return { deps, placesRepo, verificationRequestsRepo, verificationDocumentsRepo, auditRepo, notificationsRepo, created, idem, bookingRequestsRepo, storage, searchReindexPending, outsideTxSearchReindexPending };
}

const humanDomainProof = {
  placeId: PLACE,
  owner: { kind: "human" as const, humanId: ACTOR },
  proof: { kind: "email_domain_match" as const },
};

describe("submitPlaceClaim — claimable gating", () => {
  it("rejects an ARCHIVED place with PLACE_NOT_CLAIMABLE", async () => {
    const { deps } = buildDeps({ place: buildPlace({ status: "ARCHIVED" }) });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_CLAIMABLE" });
  });

  it("rejects a VERIFIED place with PLACE_ALREADY_CLAIMED", async () => {
    const { deps } = buildDeps({
      place: buildPlace({ verificationStatus: "VERIFIED" }),
    });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "PLACE_ALREADY_CLAIMED" });
  });

  it("rejects a PENDING place with CLAIM_ALREADY_PENDING", async () => {
    const { deps } = buildDeps({
      place: buildPlace({ verificationStatus: "PENDING" }),
    });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_ALREADY_PENDING" });
  });

  it("rejects when a verified owner already exists (collision)", async () => {
    const { deps } = buildDeps({ verifiedOwner: { id: "own", ownerType: "HUMAN" } });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "PLACE_ALREADY_CLAIMED" });
  });

  it("rejects when an active claim already exists", async () => {
    const { deps } = buildDeps({ activeClaim: { id: "req" } });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_ALREADY_PENDING" });
  });
});

describe("submitPlaceClaim — owner authorization", () => {
  it("rejects a human claiming for someone else (HUMAN_MISMATCH)", async () => {
    const { deps } = buildDeps();
    await expect(
      submitPlaceClaim(deps, {
        actorHumanId: ACTOR,
        placeId: PLACE,
        owner: { kind: "human", humanId: ORG },
        proof: { kind: "email_domain_match" },
      }),
    ).rejects.toMatchObject({ code: "HUMAN_MISMATCH" });
  });

  it("rejects an org claim without admin role (INSUFFICIENT_ROLE)", async () => {
    const { deps } = buildDeps({ orgRoleAllowed: false });
    await expect(
      submitPlaceClaim(deps, {
        actorHumanId: ACTOR,
        placeId: PLACE,
        owner: { kind: "org", orgId: ORG },
        proof: { kind: "email_domain_match" },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

describe("submitPlaceClaim — anti-squatting cap", () => {
  const OTHER_ACTOR = "88888888-8888-4888-8888-888888888888";
  const orgDomainProof = {
    placeId: PLACE,
    owner: { kind: "org" as const, orgId: ORG },
    proof: { kind: "email_domain_match" as const },
  };

  it("blocks the 21st open claim with CLAIM_LIMIT_REACHED", async () => {
    const { deps } = buildDeps({ openClaimCount: MAX_OPEN_CLAIMS_PER_ACTOR });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_LIMIT_REACHED" });
  });

  it("an ORG claim by an actor at the cap is refused too, before anything is written", async () => {
    const { deps, placesRepo, verificationRequestsRepo } = buildDeps({
      openClaimCount: MAX_OPEN_CLAIMS_PER_ACTOR,
    });
    await expect(
      submitPlaceClaim(deps, { ...orgDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_LIMIT_REACHED" });
    expect(
      verificationRequestsRepo.countOpenClaimsByClaimant,
    ).toHaveBeenCalledWith(ACTOR);
    expect(placesRepo.createProvisionalOwnership).not.toHaveBeenCalled();
    expect(verificationRequestsRepo.create).not.toHaveBeenCalled();
  });

  it("counts by the person who FILED, so human and org claims share one budget", async () => {
    // The adapter counts open OWNERSHIP_CLAIM rows by claimantHumanId, which
    // is the actor for both kinds; the use case must ask by actor, never by
    // the owner id (an org claim's owner id is the org).
    const { deps, verificationRequestsRepo } = buildDeps({
      openClaimCount: { [ACTOR]: MAX_OPEN_CLAIMS_PER_ACTOR, [ORG]: 0 },
    });
    await expect(
      submitPlaceClaim(deps, { ...orgDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_LIMIT_REACHED" });
    expect(
      verificationRequestsRepo.countOpenClaimsByClaimant,
    ).not.toHaveBeenCalledWith(ORG);
  });

  it("one below the cap, an org claim goes through", async () => {
    const { deps, verificationRequestsRepo } = buildDeps({
      openClaimCount: MAX_OPEN_CLAIMS_PER_ACTOR - 1,
    });
    const out = await submitPlaceClaim(deps, {
      ...orgDomainProof,
      actorHumanId: ACTOR,
    });
    expect(out.placeVerification).toBe("PENDING");
    expect(verificationRequestsRepo.create).toHaveBeenCalledOnce();
  });

  it("another actor's open claims do not count against this one", async () => {
    const { deps, verificationRequestsRepo } = buildDeps({
      openClaimCount: { [OTHER_ACTOR]: 500 },
    });
    const out = await submitPlaceClaim(deps, {
      ...humanDomainProof,
      actorHumanId: ACTOR,
    });
    expect(out.placeVerification).toBe("PENDING");
    expect(verificationRequestsRepo.create).toHaveBeenCalledOnce();
  });

  it("re-counts under the actor lock: a claim that reached the cap while this one waited is refused", async () => {
    const { deps, placesRepo, verificationRequestsRepo } = buildDeps();
    // First read (outside the tx) sees 19; by the time the actor lock is
    // held, a parallel submit has committed the 20th.
    let locked = false;
    placesRepo.lockClaimsByActor.mockImplementation(async () => {
      locked = true;
    });
    verificationRequestsRepo.countOpenClaimsByClaimant.mockImplementation(
      async () => (locked ? MAX_OPEN_CLAIMS_PER_ACTOR : MAX_OPEN_CLAIMS_PER_ACTOR - 1),
    );
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_LIMIT_REACHED" });
    expect(placesRepo.lockClaimsByActor).toHaveBeenCalledWith(ACTOR);
    expect(placesRepo.createProvisionalOwnership).not.toHaveBeenCalled();
    expect(verificationRequestsRepo.create).not.toHaveBeenCalled();
  });

  it("provisional path: actor lock, then the count, then the place lock", async () => {
    const { deps, placesRepo, verificationRequestsRepo } = buildDeps();
    await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });
    const actorLock = placesRepo.lockClaimsByActor.mock.invocationCallOrder[0]!;
    const counts =
      verificationRequestsRepo.countOpenClaimsByClaimant.mock.invocationCallOrder;
    const placeLock = placesRepo.lockPlaceForClaim.mock.invocationCallOrder[0]!;
    // Two counts: the early refusal, then the binding one under the lock.
    expect(counts).toHaveLength(2);
    expect(counts[0]!).toBeLessThan(actorLock);
    expect(actorLock).toBeLessThan(counts[1]!);
    expect(counts[1]!).toBeLessThan(placeLock);
  });
});

describe("submitPlaceClaim — proof kinds", () => {
  it("email_domain_match on a USER_STUB domain → provisional PENDING + request", async () => {
    const { deps, created, verificationRequestsRepo, notificationsRepo, placesRepo } =
      buildDeps();
    const out = await submitPlaceClaim(deps, {
      ...humanDomainProof,
      actorHumanId: ACTOR,
    });
    expect(out.placeVerification).toBe("PENDING");
    expect(out.autoVerified).toBe(false);
    expect(out.requestId).toBe(REQUEST);
    expect((created.ownership as any).ownerType).toBe("HUMAN");
    expect((created.request as any).source).toBe("OWNERSHIP_CLAIM");
    expect(verificationRequestsRepo.create).toHaveBeenCalledOnce();
    expect(notificationsRepo.create).toHaveBeenCalled(); // admins notified
    // The claim moves `verification` only: no row rebuild, so the venue's
    // website (the ownership proof), phone and address are never rewritten.
    expect(placesRepo.upsert).not.toHaveBeenCalled();
    expect(placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: PLACE,
      from: "UNVERIFIED",
      to: "PENDING",
    });
    expect(placesRepo.setDirectoryListing).not.toHaveBeenCalled();
  });

  it("email_domain_match on a TRUSTED_IMPORT domain → fast-track VERIFIED, no request", async () => {
    const { deps, verificationRequestsRepo, placesRepo, created } = buildDeps({
      place: buildPlace({ websiteSource: "TRUSTED_IMPORT" }),
    });
    const out = await submitPlaceClaim(deps, {
      ...humanDomainProof,
      actorHumanId: ACTOR,
    });
    expect(out.placeVerification).toBe("VERIFIED");
    expect(out.autoVerified).toBe(true);
    expect(out.requestId).toBeNull();
    expect(verificationRequestsRepo.create).not.toHaveBeenCalled();
    expect(placesRepo.verifyOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerHumanId: null }),
    );
    expect((created.verified as any).ownershipId).toBe(OWNERSHIP);
    // Fast-track: verification + directory listing, nothing else.
    expect(placesRepo.upsert).not.toHaveBeenCalled();
    expect(placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: PLACE,
      from: "UNVERIFIED",
      to: "VERIFIED",
    });
    expect(placesRepo.setDirectoryListing).toHaveBeenCalledWith({
      placeId: PLACE,
      listedInDirectory: true,
    });
  });

  it("rejects a free-email domain website with CLAIM_FREE_EMAIL_NOT_ALLOWED", async () => {
    const { deps } = buildDeps({
      place: buildPlace({ website: "https://gmail.com" }),
    });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_FREE_EMAIL_NOT_ALLOWED" });
  });

  it("rejects a mismatched account domain with CLAIM_EMAIL_DOMAIN_MISMATCH", async () => {
    const { deps } = buildDeps({ identityEmail: "me@somewhereelse.com" });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_EMAIL_DOMAIN_MISMATCH" });
  });

  it("rejects domain match when the account email is unverified", async () => {
    const { deps } = buildDeps({ emailVerified: false });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("email_challenge proof requires a verified challenge → provisional", async () => {
    const { deps, created } = buildDeps();
    const out = await submitPlaceClaim(deps, {
      actorHumanId: ACTOR,
      placeId: PLACE,
      owner: { kind: "human", humanId: ACTOR },
      proof: { kind: "email_challenge", challengeId: CHALLENGE },
    });
    expect(out.placeVerification).toBe("PENDING");
    expect((created.request as any).source).toBe("OWNERSHIP_CLAIM");
  });

  it("email_challenge proof rejects an unverified challenge", async () => {
    const { deps } = buildDeps({
      challenge: {
        placeId: PLACE,
        humanId: ACTOR,
        verifiedAt: null,
        email: "owner@thefillmore.com",
      },
    });
    await expect(
      submitPlaceClaim(deps, {
        actorHumanId: ACTOR,
        placeId: PLACE,
        owner: { kind: "human", humanId: ACTOR },
        proof: { kind: "email_challenge", challengeId: CHALLENGE },
      }),
    ).rejects.toMatchObject({ code: "CLAIM_CHALLENGE_NOT_VERIFIED" });
  });

  it("document proof attaches documents to the request → provisional", async () => {
    const { deps, verificationDocumentsRepo } = buildDeps();
    const out = await submitPlaceClaim(deps, {
      actorHumanId: ACTOR,
      placeId: PLACE,
      owner: { kind: "human", humanId: ACTOR },
      proof: {
        kind: "document",
        documents: [
          {
            storageKey: `place-verification/${PLACE}/lease.pdf`,
            fileName: "lease.pdf",
            contentType: "application/pdf",
            sizeBytes: 1000,
          },
        ],
      },
    });
    expect(out.placeVerification).toBe("PENDING");
    expect(verificationDocumentsRepo.createMany).toHaveBeenCalledOnce();
  });

  // F11 (2026-09-29): the doc is HEADed before the claim is written.
  it("document proof: deletes and rejects a document bigger than declared", async () => {
    const { deps, verificationRequestsRepo, storage } = buildDeps();
    storage.headObject.mockResolvedValue({ exists: true, size: 50_000_000 });
    const key = `place-verification/${PLACE}/lease.pdf`;

    await expect(
      submitPlaceClaim(deps, {
        actorHumanId: ACTOR,
        placeId: PLACE,
        owner: { kind: "human", humanId: ACTOR },
        proof: {
          kind: "document",
          documents: [
            {
              storageKey: key,
              fileName: "lease.pdf",
              contentType: "application/pdf",
              sizeBytes: 1000,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "upload_size_exceeded",
    });
    expect(storage.deleteObject).toHaveBeenCalledWith({ key });
    expect(verificationRequestsRepo.create).not.toHaveBeenCalled();
  });

  it("document proof: rejects a key that isn't this place's upload", async () => {
    const { deps, verificationRequestsRepo, storage } = buildDeps();

    await expect(
      submitPlaceClaim(deps, {
        actorHumanId: ACTOR,
        placeId: PLACE,
        owner: { kind: "human", humanId: ACTOR },
        proof: {
          kind: "document",
          documents: [
            {
              storageKey: "uploads/audio/someone-elses.mp3",
              fileName: "lease.pdf",
              contentType: "application/pdf",
              sizeBytes: 1000,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "document_key_not_owned",
    });
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(verificationRequestsRepo.create).not.toHaveBeenCalled();
  });
});

describe("submitPlaceClaim — concurrency backstops (P2002)", () => {
  it("maps a provisional-path unique violation to CLAIM_ALREADY_PENDING", async () => {
    const { deps, verificationRequestsRepo } = buildDeps();
    // The "one active OWNERSHIP_CLAIM per place" partial-unique index fires when
    // a racing claimant wins; the tx rolls back and we surface the friendly code.
    (verificationRequestsRepo.create as any).mockRejectedValueOnce({
      code: "P2002",
    });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_ALREADY_PENDING" });
  });

  it("fast-track takes the advisory lock and re-checks the verified owner", async () => {
    const { deps, placesRepo } = buildDeps({
      place: buildPlace({ websiteSource: "TRUSTED_IMPORT" }),
    });
    await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });
    // The place must be locked before the in-tx re-check + verify.
    expect(placesRepo.lockPlaceForClaim).toHaveBeenCalledWith(PLACE);
    const lockOrder = (placesRepo.lockPlaceForClaim as any).mock
      .invocationCallOrder[0];
    const verifyOrder = (placesRepo.verifyOwnership as any).mock
      .invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(verifyOrder);
  });

  it("fast-track re-check under the lock maps a raced verified owner to PLACE_ALREADY_CLAIMED", async () => {
    const { deps, placesRepo } = buildDeps({
      place: buildPlace({ websiteSource: "TRUSTED_IMPORT" }),
    });
    // Pre-tx check sees no owner; a competitor verifies while we wait for the
    // lock, so the in-tx re-check (2nd call) finds one.
    (placesRepo.getVerifiedOwnershipForPlace as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "raced", ownerType: "ORGANIZATION" });
    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "PLACE_ALREADY_CLAIMED" });
    expect(placesRepo.verifyOwnership).not.toHaveBeenCalled();
  });
});

describe("submitPlaceClaim — the place row is read under the claim lock (no lost update)", () => {
  // A community moderator's correction or archive takes the same lock. Here
  // it "commits" while the claim waits for the lock: getById answers with
  // the corrected row once the lock is granted.
  function moderatorWritesWhileClaimWaits(
    placesRepo: { getById: any; lockPlaceForClaim: any },
    after: PlaceRecord,
  ) {
    let locked = false;
    placesRepo.lockPlaceForClaim.mockImplementation(async () => {
      locked = true;
    });
    const before = placesRepo.getById.getMockImplementation();
    placesRepo.getById.mockImplementation(async (...args: unknown[]) =>
      locked ? after : before(...args),
    );
  }

  const corrected = buildPlace({
    name: "The Fillmore Auditorium",
    formattedAddress: "1805 Geary Blvd, San Francisco, CA 94115",
    lat: 37.784,
    lng: -122.433,
  });

  // The moderator's edit also moved the verification status (REJECTED), so
  // the CAS `from` shows which read the claim used.
  const correctedRejected = { ...corrected, verificationStatus: "REJECTED" as const };

  it("provisional path: takes the lock, CASes from the under-lock read, never rewrites the row", async () => {
    const { deps, placesRepo } = buildDeps();
    moderatorWritesWhileClaimWaits(placesRepo, correctedRejected);

    await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });

    expect(placesRepo.lockPlaceForClaim).toHaveBeenCalledWith(PLACE);
    expect(placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: PLACE,
      from: "REJECTED",
      to: "PENDING",
    });
    // The moderator's name/address/pin are not written over.
    expect(placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("fast-track: CASes from the under-lock read, never rewrites the row", async () => {
    const { deps, placesRepo } = buildDeps({
      place: buildPlace({ websiteSource: "TRUSTED_IMPORT" }),
    });
    moderatorWritesWhileClaimWaits(placesRepo, {
      ...correctedRejected,
      websiteSource: "TRUSTED_IMPORT",
    });

    await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });

    expect(placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: PLACE,
      from: "REJECTED",
      to: "VERIFIED",
    });
    expect(placesRepo.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["provisional", buildPlace(), "ARCHIVED"],
    ["fast-track", buildPlace({ websiteSource: "TRUSTED_IMPORT" as PlaceWebsiteSource }), "ARCHIVED"],
    ["provisional", buildPlace(), "SUSPENDED"],
    ["fast-track", buildPlace({ websiteSource: "TRUSTED_IMPORT" as PlaceWebsiteSource }), "SUSPENDED"],
  ] as const)(
    "%s: a place %s while the claim waited is PLACE_NOT_CLAIMABLE, and is not written back",
    async (_label, place, status) => {
      const { deps, placesRepo, verificationRequestsRepo } = buildDeps({ place });
      moderatorWritesWhileClaimWaits(placesRepo, { ...place, status });

      await expect(
        submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
      ).rejects.toMatchObject({ code: "PLACE_NOT_CLAIMABLE" });
      expect(placesRepo.upsert).not.toHaveBeenCalled();
      expect(placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(verificationRequestsRepo.create).not.toHaveBeenCalled();
    },
  );

  // assertPlaceClaimable ran before the tx; a staff waive or another claim
  // that committed while this one waited must still be refused, or the CAS
  // (whose `from` is this read) would demote a VERIFIED place or hand it over.
  it.each([
    ["provisional", buildPlace(), "VERIFIED", "PLACE_ALREADY_CLAIMED"],
    ["fast-track", buildPlace({ websiteSource: "TRUSTED_IMPORT" as PlaceWebsiteSource }), "VERIFIED", "PLACE_ALREADY_CLAIMED"],
    ["provisional", buildPlace(), "PENDING", "CLAIM_ALREADY_PENDING"],
    ["fast-track", buildPlace({ websiteSource: "TRUSTED_IMPORT" as PlaceWebsiteSource }), "PENDING", "CLAIM_ALREADY_PENDING"],
  ] as const)(
    "%s: a place made %s while the claim waited is %s, and is not written",
    async (_label, place, verificationStatus, code) => {
      const { deps, placesRepo, verificationRequestsRepo, searchReindexPending } =
        buildDeps({ place });
      moderatorWritesWhileClaimWaits(placesRepo, { ...place, verificationStatus });

      await expect(
        submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
      ).rejects.toMatchObject({ code });
      expect(placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(placesRepo.setDirectoryListing).not.toHaveBeenCalled();
      expect(placesRepo.createProvisionalOwnership).not.toHaveBeenCalled();
      expect(verificationRequestsRepo.create).not.toHaveBeenCalled();
      expect(searchReindexPending.mark).not.toHaveBeenCalled();
    },
  );
});

describe("submitPlaceClaim — search reindex mark and listing audit", () => {
  const fastTrackPlace = () => buildPlace({ websiteSource: "TRUSTED_IMPORT" });
  const placeMark = [{ entityType: "place", entityId: PLACE }];

  it("provisional path: marks the place once, inside the tx", async () => {
    const { deps, searchReindexPending, outsideTxSearchReindexPending } = buildDeps();
    await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });
    expect(outsideTxSearchReindexPending.mark).not.toHaveBeenCalled();
    expect(searchReindexPending.mark).toHaveBeenCalledTimes(1);
    expect(searchReindexPending.mark).toHaveBeenCalledWith(placeMark, BASE_DATE);
  });

  it("fast-track: marks the place once, inside the tx", async () => {
    const { deps, searchReindexPending, outsideTxSearchReindexPending } = buildDeps({
      place: fastTrackPlace(),
    });
    await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });
    expect(outsideTxSearchReindexPending.mark).not.toHaveBeenCalled();
    expect(searchReindexPending.mark).toHaveBeenCalledTimes(1);
    expect(searchReindexPending.mark).toHaveBeenCalledWith(placeMark, BASE_DATE);
  });

  it("fast-track: listing the place writes a place.directory_listed audit row", async () => {
    const { deps, auditRepo } = buildDeps({ place: fastTrackPlace() });
    await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });
    const listed = (auditRepo.log.mock.calls as any[]).filter(
      ([row]) => row.action === "place.directory_listed",
    );
    expect(listed).toHaveLength(1);
    expect(listed[0][0]).toEqual({
      entity: "place",
      entityId: PLACE,
      action: "place.directory_listed",
      data: {
        previous: false,
        next: true,
        reason: "claim_autoverified",
        actorHumanId: ACTOR,
      },
      at: BASE_DATE,
    });
  });

  it("fast-track: an already-listed place writes no listing audit row", async () => {
    const { deps, auditRepo, placesRepo } = buildDeps({ place: fastTrackPlace() });
    placesRepo.setDirectoryListing.mockResolvedValueOnce({ changed: false });
    await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });
    const actions = (auditRepo.log.mock.calls as any[]).map(([row]) => row.action);
    expect(actions).not.toContain("place.directory_listed");
    expect(actions).toContain("place.ownership_claim_autoverified");
  });
});

describe("submitPlaceClaim — the claim writes only the verification column", () => {
  // An ownerless community place can have no street line and no country.
  // The old whole-row rebuild wrote those NULLs back as "".
  const bare = buildPlace({
    formattedAddress: null,
    addressLine1: null,
    countryCode: null,
    lat: null,
    lng: null,
  });

  it.each([
    ["provisional", bare],
    ["fast-track", { ...bare, websiteSource: "TRUSTED_IMPORT" as PlaceWebsiteSource }],
  ] as const)(
    "%s: a place with NULL line1 / country is not rewritten (no \"\" written)",
    async (_label, place) => {
      const { deps, placesRepo } = buildDeps({ place });

      await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });

      expect(placesRepo.upsert).not.toHaveBeenCalled();
      // Every place write carries only placeId + the one column it moves.
      for (const [arg] of placesRepo.setVerificationStatus.mock.calls) {
        expect(Object.keys(arg).sort()).toEqual(["from", "placeId", "to"]);
      }
      for (const [arg] of placesRepo.setDirectoryListing.mock.calls) {
        expect(Object.keys(arg).sort()).toEqual(["listedInDirectory", "placeId"]);
      }
    },
  );

  it("a lost CAS whose re-read finds PENDING is CLAIM_ALREADY_PENDING, not success", async () => {
    // Under the lock the claim reads UNVERIFIED; a lockless writer
    // (submit-place-verification) makes it PENDING before the CAS.
    const { deps, placesRepo, verificationRequestsRepo, idem } = buildDeps();
    let casLost = false;
    placesRepo.setVerificationStatus.mockImplementationOnce(async () => {
      casLost = true;
      return { changed: false };
    });
    placesRepo.getById.mockImplementation(async () =>
      buildPlace(casLost ? { verificationStatus: "PENDING" } : {}),
    );

    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CLAIM_ALREADY_PENDING" });
    expect(verificationRequestsRepo.create).not.toHaveBeenCalled();
    expect(idem.fail).toHaveBeenCalled();
  });

  it("a lost CAS to any other status is CONFLICT and opens no request", async () => {
    const { deps, placesRepo, verificationRequestsRepo } = buildDeps();
    let casLost = false;
    placesRepo.setVerificationStatus.mockImplementationOnce(async () => {
      casLost = true;
      return { changed: false };
    });
    placesRepo.getById.mockImplementation(async () =>
      buildPlace(casLost ? { verificationStatus: "REJECTED" } : {}),
    );

    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(verificationRequestsRepo.create).not.toHaveBeenCalled();
  });

  function loseFastTrackCas(
    placesRepo: { setVerificationStatus: any; getById: any },
    reRead: Partial<PlaceRecord>,
  ) {
    let casLost = false;
    placesRepo.setVerificationStatus.mockImplementationOnce(async () => {
      casLost = true;
      return { changed: false };
    });
    placesRepo.getById.mockImplementation(async () =>
      buildPlace({
        websiteSource: "TRUSTED_IMPORT",
        ...(casLost ? reRead : {}),
      }),
    );
  }

  it("fast-track: a lost CAS whose re-read finds VERIFIED is PLACE_ALREADY_CLAIMED, not success", async () => {
    const { deps, placesRepo, auditRepo, idem } = buildDeps({
      place: buildPlace({ websiteSource: "TRUSTED_IMPORT" }),
    });
    loseFastTrackCas(placesRepo, { verificationStatus: "VERIFIED" });

    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "PLACE_ALREADY_CLAIMED" });
    const actions = (auditRepo.log.mock.calls as any[]).map(([row]) => row.action);
    expect(actions).not.toContain("place.ownership_claim_autoverified");
    expect(placesRepo.setDirectoryListing).not.toHaveBeenCalled();
    expect(idem.fail).toHaveBeenCalled();
  });

  it.each(["ARCHIVED", "SUSPENDED"] as const)(
    "fast-track: a lost CAS whose re-read finds the place %s is PLACE_NOT_CLAIMABLE",
    async (status) => {
      // update-place-status rebuilds the row without the claim lock.
      const { deps, placesRepo, auditRepo, idem } = buildDeps({
        place: buildPlace({ websiteSource: "TRUSTED_IMPORT" }),
      });
      loseFastTrackCas(placesRepo, { status });

      await expect(
        submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
      ).rejects.toMatchObject({ code: "PLACE_NOT_CLAIMABLE" });
      const actions = (auditRepo.log.mock.calls as any[]).map(([row]) => row.action);
      expect(actions).not.toContain("place.ownership_claim_autoverified");
      expect(idem.fail).toHaveBeenCalled();
    },
  );

  it("fast-track: a lost CAS to any other status is CONFLICT, with no autoverified audit", async () => {
    const { deps, placesRepo, auditRepo, idem } = buildDeps({
      place: buildPlace({ websiteSource: "TRUSTED_IMPORT" }),
    });
    loseFastTrackCas(placesRepo, { verificationStatus: "REJECTED" });

    await expect(
      submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const actions = (auditRepo.log.mock.calls as any[]).map(([row]) => row.action);
    expect(actions).not.toContain("place.ownership_claim_autoverified");
    expect(placesRepo.setDirectoryListing).not.toHaveBeenCalled();
    expect(idem.fail).toHaveBeenCalled();
  });
});

describe("submitPlaceClaim — co-ownership (removed unique index stays gone)", () => {
  it("fast-track creates + verifies a new owner without any single-verified-owner precondition", async () => {
    // The place is claimable (no verified owner at gate time), but the model
    // ALLOWS a place to accumulate multiple verified owners (co-ownership) — the
    // "one verified owner per place" unique index was deliberately removed. The
    // fast-track therefore creates + verifies an ownership row with NO check that
    // the place has zero other verified owners; the only owner gate is the
    // claimable predicate (getVerifiedOwnershipForPlace) + the advisory-lock
    // re-check. If a unique index were re-introduced, verifyOwnership would
    // start failing on co-owned places. (The adapter-level co-ownership proof
    // lives in places-access-gating.test.ts.)
    const { deps, placesRepo, created } = buildDeps({
      place: buildPlace({ websiteSource: "TRUSTED_IMPORT" }),
    });
    const out = await submitPlaceClaim(deps, {
      ...humanDomainProof,
      actorHumanId: ACTOR,
    });
    expect(out.placeVerification).toBe("VERIFIED");
    expect(placesRepo.createProvisionalOwnership).toHaveBeenCalledOnce();
    expect(placesRepo.verifyOwnership).toHaveBeenCalledOnce();
    expect((created.verified as any).ownershipId).toBe(OWNERSHIP);
  });
});

describe("submitPlaceClaim — idempotency", () => {
  it("returns the prior committed result on a replay (begin=false)", async () => {
    const { deps, idem } = buildDeps();
    const prior = {
      requestId: REQUEST,
      ownershipId: OWNERSHIP,
      placeVerification: "PENDING" as const,
      autoVerified: false,
      proofKind: "email_domain_match" as const,
    };
    idem.begin.mockResolvedValueOnce(false);
    idem.get.mockResolvedValueOnce(prior);
    const out = await submitPlaceClaim(deps, {
      ...humanDomainProof,
      actorHumanId: ACTOR,
    });
    // The stored result is the WIRE shape.
    //
    // `prior` deliberately OMITS `communityListingCount` — it is the exact
    // shape a record written BEFORE that field existed has. A required field
    // would throw here, i.e. the first replay of any claim in flight across
    // the deploy would show the claimant an error for a claim that already
    // succeeded. The schema's `.default(0)` is what makes this parse, and 0
    // reads as "nothing to ask about", which is the safe degradation.
    expect(out).toEqual({
      ...prior,
      communityListingCount: 0,
    });
  });

  it("a replay of a record stored BEFORE the 2026-09-25 amendment drops its stale notificationIntents", async () => {
    const { deps, idem } = buildDeps();
    const prior = {
      requestId: null,
      ownershipId: OWNERSHIP,
      placeVerification: "VERIFIED" as const,
      autoVerified: true,
      proofKind: "email_domain_match" as const,
      communityListingCount: 1,
      // What the output carried while parking existed.
      notificationIntents: [],
    };
    idem.begin.mockResolvedValueOnce(false);
    // Typed as today's wire shape; the stale key is the point of the test.
    idem.get.mockResolvedValueOnce(prior as never);
    const out = await submitPlaceClaim(deps, {
      ...humanDomainProof,
      actorHumanId: ACTOR,
    });
    const { notificationIntents: _stale, ...wire } = prior;
    expect(out).toEqual(wire);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk-import provenance × the FR-010 fast-track (regression)
// ─────────────────────────────────────────────────────────────────────────────
//
// Bulk-imported venues are UNOWNED so their real operator can claim them. That
// removed the guard which had been (accidentally) keeping the fast-track out of
// reach for this population: `assertPlaceClaimable` throws PLACE_ALREADY_CLAIMED
// whenever a verified owner exists, so while every import minted one, no
// imported place could ever reach the auto-verify branch.
//
// With imports unowned, the ONLY thing standing between a scraped row and
// no-admin auto-verification is `Place.websiteSource`. Several hundred scraped
// venues carry municipal / parent-company / aggregator websites that
// `isFreeEmailDomain` does not screen, so an armed fast-track would hand
// VERIFIED ownership — place edit access, booking surfaces, payout-terms
// defaults — to any holder of a mailbox at those domains.
//
// This test spans core + adapter ON PURPOSE. It reads the provenance the REAL
// `bulkCreate` writes for the row shape the importers actually send, rather
// than hardcoding "UNKNOWN", so flipping the adapter default back to
// TRUSTED_IMPORT fails HERE — at the security boundary that default controls —
// and not just in an adapter unit test that would look like a cosmetic change.
describe("submitPlaceClaim — a bulk-imported place never auto-verifies (FR-010 provenance)", () => {
  async function websiteSourceWrittenByBulkImport(): Promise<PlaceWebsiteSource> {
    const createMany = vi.fn(async () => ({ count: 1 }));
    const repo = makePlacesRepo({
      place: { createMany },
      placeOwnership: { createMany: vi.fn() },
    } as unknown as Parameters<typeof makePlacesRepo>[0]);

    // Exactly what handleCsvImport / toBulkImportRow send: no owner, no
    // websiteSource.
    await repo.bulkCreate([
      {
        id: PLACE,
        name: "Scraped Civic Auditorium",
        address: {
          formatted: "417 4th Ave N, Nashville, TN 37201, US",
          line1: "417 4th Ave N",
          city: "Nashville",
          region: "TN",
          postalCode: "37201",
          countryCode: "US",
        },
        website: "https://www.nashville.gov/venue",
        listedInDirectory: true,
      },
    ]);

    const { data } = createMany.mock.calls[0]![0] as unknown as {
      data: { websiteSource: PlaceWebsiteSource }[];
    };
    return data[0]!.websiteSource;
  }

  it("writes a provenance that is NOT TRUSTED_IMPORT", async () => {
    expect(await websiteSourceWrittenByBulkImport()).not.toBe("TRUSTED_IMPORT");
  });

  it("email_domain_match on a bulk-imported venue stays PROVISIONAL behind the admin backstop", async () => {
    const websiteSource = await websiteSourceWrittenByBulkImport();

    const { deps, verificationRequestsRepo, notificationsRepo, placesRepo } =
      buildDeps({
        place: buildPlace({
          website: "https://www.nashville.gov/venue",
          websiteSource,
          // Unowned + unverified: precisely the state a fresh import lands in.
          verificationStatus: "UNVERIFIED",
        }),
        // A verified mailbox at the venue's own website domain — the exact
        // shape that fast-tracks when provenance is TRUSTED_IMPORT.
        identityEmail: "someone@nashville.gov",
        emailVerified: true,
      });

    const out = await submitPlaceClaim(deps, {
      ...humanDomainProof,
      actorHumanId: ACTOR,
    });

    // The claim is still ACCEPTED — it just does not skip the human.
    expect(out.autoVerified).toBe(false);
    expect(out.placeVerification).toBe("PENDING");
    expect(out.requestId).toBe(REQUEST);
    expect(verificationRequestsRepo.create).toHaveBeenCalledOnce();
    expect(notificationsRepo.create).toHaveBeenCalled(); // admin backstop
    // No ownership was stamped verified by SYSTEM.
    expect(placesRepo.verifyOwnership).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parking is gone (amendment 2026-09-25: unclaimed venues take no requests).
// A claim, fast-tracked or provisional, touches no booking request and owes
// no notification.
// ─────────────────────────────────────────────────────────────────────────────

describe("submitPlaceClaim — no booking-request side effects (parking removed)", () => {
  it("fast-track: verifies the owner, writes no ledger entry, reads no request, owes nothing", async () => {
    const { deps, bookingRequestsRepo } = buildDeps({
      place: buildPlace({ websiteSource: "TRUSTED_IMPORT" }),
    });
    const out = await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });
    expect(out.autoVerified).toBe(true);
    expect(out).not.toHaveProperty("notificationIntents");
    expect(bookingRequestsRepo.listOpenParked).not.toHaveBeenCalled();
    expect(bookingRequestsRepo.expireParked).not.toHaveBeenCalled();
    expect(bookingRequestsRepo.touchLastMessageAt).not.toHaveBeenCalled();
    const ledger = (deps.repos as any).bookingRequestMessages;
    expect([...ledger.rows.values()]).toEqual([]);
  });

  it("provisional path: same — nothing touched, nothing owed", async () => {
    const { deps, bookingRequestsRepo } = buildDeps();
    const out = await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });
    expect(out.autoVerified).toBe(false);
    expect(out).not.toHaveProperty("notificationIntents");
    expect(bookingRequestsRepo.listOpenParked).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-005 / FR-007 — the community-listing count rides back on the claim
// (community-listings-at-claimed-venues).
//
// It is returned here rather than fetched by the client because
// `getPlaceForEdit` gates on `humanIdsWithAccess`, which is built from VERIFIED
// unrevoked ownerships only — a provisional claimant is not in that set and
// would get NOT_RESOURCE_OWNER on the pending path, which is the exact path
// that needs the number.
// ─────────────────────────────────────────────────────────────────────────────

describe("submitPlaceClaim — FR-007 community listing count", () => {
  it("returns the count on the PROVISIONAL path (where the claimant cannot ask for it)", async () => {
    const { deps } = buildDeps({ communityListingCount: 3 });
    const out = await submitPlaceClaim(deps, {
      ...humanDomainProof,
      actorHumanId: ACTOR,
    });
    expect(out.autoVerified).toBe(false);
    expect(out.communityListingCount).toBe(3);
  });

  it("counts against the place being claimed, at the claim's clock", async () => {
    const { deps, placesRepo } = buildDeps({ communityListingCount: 2 });
    await submitPlaceClaim(deps, { ...humanDomainProof, actorHumanId: ACTOR });
    const events = (deps.repos as unknown as {
      events: { countCommunityListingsAtPlace: ReturnType<typeof vi.fn> };
    }).events;
    expect(events.countCommunityListingsAtPlace).toHaveBeenCalledWith({
      placeId: PLACE,
      now: BASE_DATE,
    });
    expect(placesRepo).toBeDefined();
  });

  it("a FAILED count degrades to 0 rather than failing a committed claim", async () => {
    // The claim has already been written by the time this runs. Throwing here
    // would show the claimant an error for a claim that succeeded.
    const reportError = vi.fn();
    const { deps } = buildDeps({
      communityListingCount: new Error("db is down"),
    });
    const out = await submitPlaceClaim(
      { ...deps, reportError },
      { ...humanDomainProof, actorHumanId: ACTOR },
    );
    expect(out.communityListingCount).toBe(0);
    expect(out.ownershipId).toBeTruthy();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "countCommunityListings" }),
      }),
    );
  });

  it("survives a reporter AND a logger that themselves throw", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    // A Proxy, not a hand-listed fake: this use case calls `logger.child(...)`
    // and the child's own surface (`withTime`, …), so an enumerated stub goes
    // stale the moment the port grows a method — and it fails with an
    // unrelated TypeError that looks like a product bug.
    const loggerError = vi.fn(() => {
      throw new Error("log transport down");
    });
    const logger: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "error") return loggerError;
          if (prop === "child") return () => logger;
          // `withTime` WRAPS the whole use case (`logger.withTime("submit…",
          // execute)`), so a blanket no-op stub silently swallows the entire
          // call and the use case returns undefined. Run the callback.
          if (prop === "withTime")
            return (_label: string, fn: () => unknown) => fn();
          return () => undefined;
        },
      },
    );
    const { deps } = buildDeps({
      communityListingCount: new Error("db is down"),
    });
    const out = await submitPlaceClaim(
      { ...deps, reportError, logger: logger as never },
      { ...humanDomainProof, actorHumanId: ACTOR },
    );
    expect(out.communityListingCount).toBe(0);
  });
});
