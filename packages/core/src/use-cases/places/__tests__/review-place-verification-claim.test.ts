import { describe, expect, it, vi } from "vitest";

import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { reviewPlaceVerification } from "../review-place-verification";
import type { ReviewPlaceVerificationDeps } from "../review-place-verification";

const NOW = new Date("2026-07-05T00:00:00.000Z");
const ADMIN = "11111111-1111-4111-8111-111111111111";
const PLACE = "33333333-3333-4333-8333-333333333333";
const REQUEST = "66666666-6666-4666-8666-666666666666";
const OWNERSHIP = "55555555-5555-4555-8555-555555555555";
const CLAIMANT = "99999999-9999-4999-8999-999999999999";
const PREV_OWNER = "88888888-8888-4888-8888-888888888888";
const PREV_OWNERSHIP = "77777777-7777-4777-8777-777777777777";
const PROVISIONAL_OWNERSHIP = "44444444-4444-4444-8444-444444444444";
const NEW_OWNERSHIP = "22222222-2222-4222-8222-222222222222";

function ownershipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PREV_OWNERSHIP,
    placeId: PLACE,
    ownerType: "HUMAN" as const,
    ownerId: PREV_OWNER,
    verified: true,
    reviewerHumanId: null,
    reviewedAt: NOW,
    revokedAt: null,
    proof: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildDeps(
  overrides: {
    source?: "ORG_SUBMISSION" | "OWNERSHIP_CLAIM" | "OWNERSHIP_DISPUTE";
    ownershipId?: string | null;
    orgId?: string | null;
    claimOwnerType?: "HUMAN" | "ORGANIZATION" | null;
    claimOwnerId?: string | null;
    activeOwnerships?: ReturnType<typeof ownershipRow>[];
    newOwnershipId?: string;
    /** The PlaceOwnership row behind request.ownershipId (claim requests). */
    claimOwnership?: ReturnType<typeof ownershipRow> | null;
    /** `Place.acceptsCommunityListings` on the place row under review (FR-006). */
    acceptsCommunityListings?: boolean;
    /** Rows `listActiveOwnershipsForPlace` returns AFTER the revocations. */
    remainingOwnerships?: ReturnType<typeof ownershipRow>[];
    /** `Place.verification` on the row under review (default PENDING). */
    verificationStatus?: "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";
  } = {},
) {
  const source = overrides.source ?? "OWNERSHIP_CLAIM";
  const request = {
    id: REQUEST,
    placeId: PLACE,
    orgId: overrides.orgId ?? null,
    submittedById: CLAIMANT,
    status: "PENDING" as const,
    source,
    claimantHumanId: source === "ORG_SUBMISSION" ? null : CLAIMANT,
    claimOwnerType:
      overrides.claimOwnerType !== undefined
        ? overrides.claimOwnerType
        : source === "ORG_SUBMISSION"
          ? null
          : ("HUMAN" as const),
    claimOwnerId:
      overrides.claimOwnerId !== undefined
        ? overrides.claimOwnerId
        : source === "ORG_SUBMISSION"
          ? null
          : CLAIMANT,
    ownershipId:
      overrides.ownershipId === undefined
        ? source === "ORG_SUBMISSION"
          ? null
          : OWNERSHIP
        : overrides.ownershipId,
    reviewerNotes: null,
    reviewerHumanId: null,
    reviewedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const place = {
    id: PLACE,
    name: "The Fillmore",
    formattedAddress: "1805 Geary Blvd",
    addressLine1: "1805 Geary Blvd",
    addressLine2: null,
    city: "San Francisco",
    region: "CA",
    postalCode: "94115",
    countryCode: "US",
    lat: null,
    lng: null,
    capacity: 1200,
    status: "ACTIVE",
    verificationStatus: overrides.verificationStatus ?? "PENDING",
    listedInDirectory: false,
    acceptsCommunityListings: overrides.acceptsCommunityListings ?? false,
  };

  const activeOwnerships = overrides.activeOwnerships ?? [];
  // The provisional row the claim request points at (active by default).
  const claimOwnership =
    overrides.claimOwnership !== undefined
      ? overrides.claimOwnership
      : ownershipRow({
          id: OWNERSHIP,
          ownerId: CLAIMANT,
          verified: false,
          reviewerHumanId: null,
          reviewedAt: null,
        });
  // Stateful, like the table: each compare-and-set writes into `row`.
  let row: Record<string, unknown> = { ...place };
  const placesRepo = {
    getById: vi.fn(async () => ({ ...row })),
    // A tripwire: the whole-row rebuild this use case used to do.
    upsert: vi.fn(),
    // The adapters' `updateMany` where-clauses.
    setVerificationStatus: vi.fn(
      async (input: { from: string; to: string }) => {
        if (row.verificationStatus !== input.from) return { changed: false };
        row = { ...row, verificationStatus: input.to };
        return { changed: true };
      },
    ),
    setDirectoryListing: vi.fn(async (input: { listedInDirectory: boolean }) => {
      if (row.listedInDirectory === input.listedInDirectory) {
        return { changed: false };
      }
      row = { ...row, listedInDirectory: input.listedInDirectory };
      return { changed: true };
    }),
    setCommunityListingAcceptance: vi.fn(async (input: { accepts: boolean }) => {
      if (row.acceptsCommunityListings === input.accepts) {
        return { changed: false };
      }
      row = { ...row, acceptsCommunityListings: input.accepts };
      return { changed: true };
    }),
    getOwnershipById: vi.fn(async (id: string) =>
      claimOwnership && claimOwnership.id === id ? claimOwnership : null,
    ),
    // Honest fake: mirrors the adapter's conditional update — refuses to
    // verify a missing or revoked row (throws the adapter's conflict shape).
    verifyOwnership: vi.fn(async (input: any) => {
      const row =
        claimOwnership && claimOwnership.id === input.ownershipId
          ? claimOwnership
          : null;
      if (!row || row.revokedAt !== null) {
        throw {
          code: "conflict",
          message: "ownership_revoked_or_missing",
        } as const;
      }
      return {
        ...row,
        verified: true,
        reviewerHumanId: input.reviewerHumanId,
        reviewedAt: input.reviewedAt,
      };
    }),
    revokeOwnership: vi.fn(async () => ({ id: OWNERSHIP })),
    lockPlaceForClaim: vi.fn(async () => undefined),
    // Two callers, and they never co-occur in one fixture: the DISPUTE path
    // reads this to enumerate the rows it is about to revoke
    // (`activeOwnerships`), and the FR-006 check reads it after a CLAIM
    // REJECTION to ask "is anyone still an owner?" (`remainingOwnerships`).
    // A dispute transfer short-circuits the FR-006 check before it reads, so
    // one knob per fixture is unambiguous.
    listActiveOwnershipsForPlace: vi.fn(async () =>
      overrides.remainingOwnerships ?? activeOwnerships,
    ),
    createVerifiedOwnership: vi.fn(async (input: any) =>
      ownershipRow({
        id: overrides.newOwnershipId ?? NEW_OWNERSHIP,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        reviewerHumanId: input.reviewerHumanId,
        reviewedAt: input.reviewedAt,
        proof: input.proof,
      }),
    ),
  };
  const requestsRepo = {
    getById: vi.fn(async () => request),
    updateDecision: vi.fn(async () => ({ ...request, status: "APPROVED" })),
  };
  const docsRepo = {
    listByRequestId: vi.fn(async () => []),
    markDeleted: vi.fn(async () => 0),
  };
  const auditRepo = { log: vi.fn(async () => undefined) };
  const notificationsRepo = {
    create: vi.fn(async () => ({ id: "n", createdAt: NOW })),
  };

  // A TRIPWIRE since the 2026-09-25 amendment removed parking: a review no
  // longer touches any booking request, so nothing here may be called.
  const bookingRequestsRepo = {
    listOpenParked: vi.fn(async () => []),
    expireParked: vi.fn(async () => null),
    touchLastMessageAt: vi.fn(async () => undefined),
  };

  const repos: any = {
    places: placesRepo,
    placeVerificationRequests: requestsRepo,
    placeVerificationDocuments: docsRepo,
    audit: auditRepo,
    resourceQuotas: {},
    notifications: notificationsRepo,
    bookingRequests: bookingRequestsRepo,
    bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
    // The FR-006 reset enumerates the place's COMMUNITY listings to mark.
    events: {
      listPublishedByPlace: vi.fn(async () => ({
        items: [{ id: "event-listing-1" }, { id: "event-listing-2" }],
      })),
    },
    searchReindexPending: { mark: vi.fn(async () => undefined) },
  };
  repos.tx = vi.fn(async (fn: any) => fn(repos));

  const deps = {
    repos,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: true })) },
    storage: { deleteObject: vi.fn(async () => undefined) },
    clock: { now: () => NOW },
  } as unknown as ReviewPlaceVerificationDeps;

  return {
    deps,
    repos,
    currentRow: () => row,
    placesRepo,
    requestsRepo,
    auditRepo,
    notificationsRepo,
    bookingRequestsRepo,
  };
}

describe("reviewPlaceVerification — OWNERSHIP_CLAIM extension", () => {
  it("APPROVE flips the provisional ownership to verified + place VERIFIED + listed", async () => {
    const { deps, placesRepo, notificationsRepo, currentRow } = buildDeps();
    const out = await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "APPROVED",
    });
    expect(out.decision).toBe("APPROVED");
    expect(placesRepo.verifyOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ ownershipId: OWNERSHIP, reviewerHumanId: ADMIN }),
    );
    expect(currentRow()).toMatchObject({
      verificationStatus: "VERIFIED",
      listedInDirectory: true,
    });
    expect(notificationsRepo.create).toHaveBeenCalled(); // claimant notified
    // Regression: admin approve must NOT touch the venue's website/phone —
    // and now writes no column beyond verification and the listing.
    expect(placesRepo.upsert).not.toHaveBeenCalled();
    expect(placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
  });

  it("APPROVE of a stale claim (row revoked by a dispute transfer) throws PLACE_ALREADY_CLAIMED and resurrects nothing", async () => {
    const { deps, placesRepo, auditRepo, notificationsRepo } = buildDeps({
      claimOwnership: ownershipRow({
        id: OWNERSHIP,
        ownerId: CLAIMANT,
        verified: false,
        revokedAt: NOW, // revoked out from under the pending claim
      }),
    });

    await expect(
      reviewPlaceVerification(deps, {
        actorHumanId: ADMIN,
        requestId: REQUEST,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "PLACE_ALREADY_CLAIMED" });

    // No verified co-owner resurrection: the revoked row is never re-verified
    // and nothing else in the tx path lands.
    expect(placesRepo.verifyOwnership).not.toHaveBeenCalled();
    expect(placesRepo.setVerificationStatus).not.toHaveBeenCalled();
    expect(auditRepo.log).not.toHaveBeenCalled();
    expect(notificationsRepo.create).not.toHaveBeenCalled();
  });

  it("REJECT soft-revokes the provisional ownership and reverts place to UNVERIFIED", async () => {
    const { deps, placesRepo, currentRow } = buildDeps();
    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "REJECTED",
      reviewerNotes: "Could not confirm ownership from the documents provided.",
    });
    expect(placesRepo.revokeOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ ownershipId: OWNERSHIP }),
    );
    expect(placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: PLACE,
      from: "PENDING",
      to: "UNVERIFIED",
    });
    expect(currentRow().listedInDirectory).toBe(false);
    expect(placesRepo.lockPlaceForClaim).toHaveBeenCalledWith(PLACE);
    expect(placesRepo.verifyOwnership).not.toHaveBeenCalled();
  });
});

describe("reviewPlaceVerification — ORG_SUBMISSION unchanged", () => {
  it("REJECT of a legacy org submission still sets place REJECTED and touches no ownership", async () => {
    const { deps, placesRepo } = buildDeps({
      source: "ORG_SUBMISSION",
      orgId: "org-1",
    });
    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "REJECTED",
      reviewerNotes: "Documents did not establish a connection to the venue.",
    });
    expect(placesRepo.setVerificationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ to: "REJECTED" }),
    );
    expect(placesRepo.verifyOwnership).not.toHaveBeenCalled();
    expect(placesRepo.revokeOwnership).not.toHaveBeenCalled();
  });
});

describe("reviewPlaceVerification — OWNERSHIP_DISPUTE resolution", () => {
  it("APPROVE revokes all active ownerships, installs the disputant verified, and sets place VERIFIED + listed", async () => {
    const activeOwnerships = [
      ownershipRow(), // verified previous owner (human)
      ownershipRow({
        id: PROVISIONAL_OWNERSHIP,
        ownerType: "ORGANIZATION",
        ownerId: "12121212-1212-4212-8212-121212121212",
        verified: false, // pending provisional claim on the same place
      }),
    ];
    const {
      deps,
      placesRepo,
      requestsRepo,
      auditRepo,
      notificationsRepo,
      currentRow,
    } = buildDeps({
      source: "OWNERSHIP_DISPUTE",
      ownershipId: null,
      activeOwnerships,
    });

    const out = await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "APPROVED",
    });
    expect(out.decision).toBe("APPROVED");

    // Serialized against concurrent claim writers of the same place — and the
    // lock is the FIRST tx statement (before the decision write).
    expect(placesRepo.lockPlaceForClaim).toHaveBeenCalledWith(PLACE);
    expect(
      placesRepo.lockPlaceForClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(requestsRepo.updateDecision.mock.invocationCallOrder[0]);

    // Revoke-all: BOTH the verified owner and the provisional claim.
    expect(placesRepo.revokeOwnership).toHaveBeenCalledTimes(2);
    expect(placesRepo.revokeOwnership).toHaveBeenCalledWith({
      ownershipId: PREV_OWNERSHIP,
      revokedAt: NOW,
    });
    expect(placesRepo.revokeOwnership).toHaveBeenCalledWith({
      ownershipId: PROVISIONAL_OWNERSHIP,
      revokedAt: NOW,
    });

    // New verified ownership for the dispute's target identity.
    expect(placesRepo.createVerifiedOwnership).toHaveBeenCalledWith({
      placeId: PLACE,
      ownerType: "HUMAN",
      ownerId: CLAIMANT,
      reviewerHumanId: ADMIN,
      reviewedAt: NOW,
      proof: { kind: "ownership_dispute", requestId: REQUEST },
    });

    // Place mutates like a claim approval: VERIFIED + listed.
    expect(currentRow()).toMatchObject({
      verificationStatus: "VERIFIED",
      listedInDirectory: true,
    });

    // Audit payload carries the transfer trail.
    expect(auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.ownership_dispute_resolved_approved",
        data: expect.objectContaining({
          revokedOwnershipIds: [PREV_OWNERSHIP, PROVISIONAL_OWNERSHIP],
          newOwnershipId: NEW_OWNERSHIP,
          newOwnerType: "HUMAN",
          newOwnerId: CLAIMANT,
        }),
      }),
    );

    // Disputant + previous HUMAN owner both notified.
    const notified = notificationsRepo.create.mock.calls.map(
      (c: any[]) => c[0].humanId,
    );
    expect(notified).toContain(CLAIMANT);
    expect(notified).toContain(PREV_OWNER);
  });

  it("APPROVE with no active ownerships still installs the disputant and verifies the place", async () => {
    const { deps, placesRepo, currentRow } = buildDeps({
      source: "OWNERSHIP_DISPUTE",
      ownershipId: null,
      activeOwnerships: [],
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "APPROVED",
    });

    expect(placesRepo.revokeOwnership).not.toHaveBeenCalled();
    expect(placesRepo.createVerifiedOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "HUMAN", ownerId: CLAIMANT }),
    );
    expect(currentRow()).toMatchObject({
      verificationStatus: "VERIFIED",
      listedInDirectory: true,
    });
  });

  it("APPROVE excludes the disputant's own reused row from the revoked audit set", async () => {
    // The disputant already held an active row; createVerifiedOwnership reuses
    // it (same id), so it must NOT appear in revokedOwnershipIds.
    const disputantRow = ownershipRow({
      id: NEW_OWNERSHIP,
      ownerId: CLAIMANT,
      verified: false,
    });
    const { deps, auditRepo, notificationsRepo } = buildDeps({
      source: "OWNERSHIP_DISPUTE",
      ownershipId: null,
      activeOwnerships: [ownershipRow(), disputantRow],
      newOwnershipId: NEW_OWNERSHIP,
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "APPROVED",
    });

    expect(auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revokedOwnershipIds: [PREV_OWNERSHIP],
          newOwnershipId: NEW_OWNERSHIP,
        }),
      }),
    );
    // No "ownership transferred" self-notification for the disputant; they get
    // the approval notification instead (one create per human here).
    const notified = notificationsRepo.create.mock.calls.map(
      (c: any[]) => c[0].humanId,
    );
    expect(notified.filter((id: string) => id === CLAIMANT)).toHaveLength(1);
    expect(notified).toContain(PREV_OWNER);
  });

  it("APPROVE of a degenerate dispute (null claim target) fails before mutating anything", async () => {
    const { deps, placesRepo, requestsRepo, auditRepo } = buildDeps({
      source: "OWNERSHIP_DISPUTE",
      ownershipId: null,
      claimOwnerType: null,
      claimOwnerId: null,
      activeOwnerships: [ownershipRow()],
    });

    await expect(
      reviewPlaceVerification(deps, {
        actorHumanId: ADMIN,
        requestId: REQUEST,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_TARGET_OWNER_MISSING" });

    expect(requestsRepo.updateDecision).not.toHaveBeenCalled();
    expect(placesRepo.revokeOwnership).not.toHaveBeenCalled();
    expect(placesRepo.createVerifiedOwnership).not.toHaveBeenCalled();
    expect(placesRepo.setVerificationStatus).not.toHaveBeenCalled();
    expect(auditRepo.log).not.toHaveBeenCalled();
  });

  it("REJECT records the decision without mutating place or ownership, and notifies the disputant with reviewer notes", async () => {
    const { deps, placesRepo, requestsRepo, notificationsRepo } = buildDeps({
      source: "OWNERSHIP_DISPUTE",
      ownershipId: null,
      activeOwnerships: [ownershipRow()],
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "REJECTED",
      reviewerNotes: "Provided documents do not establish ownership.",
    });

    expect(requestsRepo.updateDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "REJECTED" }),
    );
    expect(placesRepo.setVerificationStatus).not.toHaveBeenCalled();
    expect(placesRepo.setDirectoryListing).not.toHaveBeenCalled();
    expect(placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
    // A dispute REJECT never touches the place, so it takes no claim lock.
    expect(placesRepo.lockPlaceForClaim).not.toHaveBeenCalled();
    expect(placesRepo.revokeOwnership).not.toHaveBeenCalled();
    expect(placesRepo.createVerifiedOwnership).not.toHaveBeenCalled();
    expect(placesRepo.verifyOwnership).not.toHaveBeenCalled();

    expect(notificationsRepo.create).toHaveBeenCalledTimes(1);
    expect(notificationsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: CLAIMANT,
        body: expect.stringContaining(
          "Provided documents do not establish ownership.",
        ),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parking is gone (amendment 2026-09-25): a claim or dispute approval verifies
// the owner and touches no booking request, owing no notification.
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewPlaceVerification — claim / dispute approval has no booking-request side effects", () => {
  for (const [label, overrides] of [
    ["APPROVED claim", {}],
    ["APPROVED dispute", { source: "OWNERSHIP_DISPUTE", activeOwnerships: [ownershipRow()] }],
  ] as const) {
    it(`${label}: no ledger entry, no request read, no intent`, async () => {
      const { deps, bookingRequestsRepo } = buildDeps(overrides as never);
      const out = await reviewPlaceVerification(deps, {
        actorHumanId: ADMIN,
        requestId: REQUEST,
        decision: "APPROVED",
      });
      expect(out).not.toHaveProperty("notificationIntents");
      expect(bookingRequestsRepo.listOpenParked).not.toHaveBeenCalled();
      expect(bookingRequestsRepo.expireParked).not.toHaveBeenCalled();
      expect(bookingRequestsRepo.touchLastMessageAt).not.toHaveBeenCalled();
      const ledger = (deps.repos as any).bookingRequestMessages;
      expect([...ledger.rows.values()]).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-006 — revocation resets community-listing consent
// (community-listings-at-claimed-venues, ruling
// `revocation_reverts_to_address_only`).
//
// `Place.acceptsCommunityListings` is a STANDING consent read live by
// `isVenueConfirmed`, so while it is true every ownerless COMMUNITY listing at
// the place renders as venue-confirmed AND occupies its slot for booking
// availability. It must not outlive the owner who gave it — that is the exact
// state ("unowned consent") the model exists to prevent. The reset commits in
// the SAME transaction as the revocation.
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewPlaceVerification — FR-006 community-listing consent reset", () => {
  it("a DISPUTE TRANSFER always resets it — the new owner never consented", async () => {
    const { deps, placesRepo } = buildDeps({
      source: "OWNERSHIP_DISPUTE",
      ownershipId: null,
      activeOwnerships: [ownershipRow()],
      acceptsCommunityListings: true,
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "APPROVED",
    });

    // The place still HAS an owner after a transfer — it is simply a different
    // one. Inheriting a venue does not inherit its consent.
    expect(placesRepo.setCommunityListingAcceptance).toHaveBeenCalledWith({
      placeId: PLACE,
      accepts: false,
    });
  });

  it("a CLAIM REJECTION that leaves the place with NO verified owner resets it", async () => {
    const { deps, placesRepo } = buildDeps({
      acceptsCommunityListings: true,
      remainingOwnerships: [],
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "REJECTED",
      reviewerNotes: "Could not confirm ownership from the documents provided.",
    });

    expect(placesRepo.revokeOwnership).toHaveBeenCalled();
    expect(placesRepo.setCommunityListingAcceptance).toHaveBeenCalledWith({
      placeId: PLACE,
      accepts: false,
    });
  });

  it("a CLAIM REJECTION that leaves a VERIFIED CO-OWNER standing does NOT reset it", async () => {
    // The sharp edge: a provisional claimant could never have set the flag
    // (the toggle needs a verified owner on a VERIFIED place), so a blanket
    // reset here would wipe a legitimate co-owner's consent because someone
    // else's unrelated claim was turned down.
    const { deps, placesRepo } = buildDeps({
      acceptsCommunityListings: true,
      remainingOwnerships: [ownershipRow({ verified: true })],
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "REJECTED",
      reviewerNotes: "Could not confirm ownership from the documents provided.",
    });

    expect(placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
  });

  it("a rejection leaving only an UNVERIFIED row standing still resets it", async () => {
    // A provisional row is not an owner. Consent must not survive on it.
    const { deps, placesRepo } = buildDeps({
      acceptsCommunityListings: true,
      remainingOwnerships: [ownershipRow({ verified: false })],
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "REJECTED",
      reviewerNotes: "Could not confirm ownership from the documents provided.",
    });

    expect(placesRepo.setCommunityListingAcceptance).toHaveBeenCalledWith({
      placeId: PLACE,
      accepts: false,
    });
  });

  it("a place that never consented is not touched — no pointless write", async () => {
    const { deps, placesRepo } = buildDeps({
      acceptsCommunityListings: false,
      remainingOwnerships: [],
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "REJECTED",
      reviewerNotes: "Could not confirm ownership from the documents provided.",
    });

    expect(placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
  });

  it("an APPROVED claim keeps it — approving an owner is not revoking one", async () => {
    const { deps, placesRepo } = buildDeps({ acceptsCommunityListings: true });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "APPROVED",
    });

    expect(placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
  });
});

describe("reviewPlaceVerification — FR-006 reset decides from the under-lock read", () => {
  it("consent granted after the pre-transaction read is still reset by a dispute transfer", async () => {
    // Pre-tx read: no consent. Under the lock: consent (an owner flipped it
    // in between). The reset must follow the under-lock row.
    const { deps, placesRepo, auditRepo } = buildDeps({
      source: "OWNERSHIP_DISPUTE",
      ownershipId: null,
      activeOwnerships: [ownershipRow()],
      acceptsCommunityListings: true,
    });
    const real = placesRepo.getById.getMockImplementation()!;
    placesRepo.getById.mockImplementationOnce(async () => ({
      ...(await real()),
      acceptsCommunityListings: false,
    }));

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "APPROVED",
    });

    expect(placesRepo.setCommunityListingAcceptance).toHaveBeenCalledWith({
      placeId: PLACE,
      accepts: false,
    });
    expect(auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.ownership_dispute_resolved_approved",
        data: expect.objectContaining({ communityListingConsentReset: true }),
      }),
    );
  });
});

describe("reviewPlaceVerification — a claim rejection never demotes a place off PENDING", () => {
  for (const status of ["VERIFIED", "REJECTED", "UNVERIFIED"] as const) {
    it(`REJECT of a claim on a ${status} place writes no verification, audits none, and marks nothing`, async () => {
      // Reachable before the update-place-verification-status claim guard:
      // claim → PENDING, staff set VERIFIED, reviewer rejects the claim.
      const { deps, placesRepo, auditRepo, currentRow, repos } = buildDeps({
        verificationStatus: status,
      });

      await reviewPlaceVerification(deps, {
        actorHumanId: ADMIN,
        requestId: REQUEST,
        decision: "REJECTED",
        reviewerNotes: "Could not confirm ownership from the documents provided.",
      });

      expect(placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(currentRow().verificationStatus).toBe(status);
      // The provisional ownership is still revoked: that is the claim's own.
      expect(placesRepo.revokeOwnership).toHaveBeenCalledWith(
        expect.objectContaining({ ownershipId: OWNERSHIP }),
      );
      const decision = auditRepo.log.mock.calls
        .map((c: any[]) => c[0])
        .find((e: any) => e.action === "place.ownership_claim_rejected");
      expect(decision.data).not.toHaveProperty("placeVerification");
      expect(repos.searchReindexPending.mark).not.toHaveBeenCalled();
    });
  }

  it("a claim on a VERIFIED place whose co-owner consented keeps the consent", async () => {
    const { deps, placesRepo } = buildDeps({
      verificationStatus: "VERIFIED",
      acceptsCommunityListings: true,
      remainingOwnerships: [ownershipRow({ verified: true })],
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "REJECTED",
      reviewerNotes: "Could not confirm ownership from the documents provided.",
    });

    expect(placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
  });

  it("a PENDING place is still reverted to UNVERIFIED", async () => {
    const { deps, currentRow } = buildDeps({ verificationStatus: "PENDING" });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "REJECTED",
      reviewerNotes: "Could not confirm ownership from the documents provided.",
    });

    expect(currentRow().verificationStatus).toBe("UNVERIFIED");
  });
});

describe("reviewPlaceVerification — the FR-006 reset marks the place's community listings", () => {
  it("a consent reset marks every enumerated COMMUNITY listing in the decision's transaction", async () => {
    const { deps, repos } = buildDeps({
      source: "OWNERSHIP_DISPUTE",
      ownershipId: null,
      activeOwnerships: [ownershipRow()],
      acceptsCommunityListings: true,
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "APPROVED",
    });

    expect(repos.events.listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: PLACE, stewardship: "COMMUNITY" }),
    );
    expect(repos.searchReindexPending.mark).toHaveBeenCalledWith(
      [
        { entityType: "event", entityId: "event-listing-1" },
        { entityType: "event", entityId: "event-listing-2" },
      ],
      NOW,
    );
  });

  it("no reset, no enumeration", async () => {
    const { deps, repos } = buildDeps({
      source: "OWNERSHIP_DISPUTE",
      ownershipId: null,
      activeOwnerships: [ownershipRow()],
      acceptsCommunityListings: false,
    });

    await reviewPlaceVerification(deps, {
      actorHumanId: ADMIN,
      requestId: REQUEST,
      decision: "APPROVED",
    });

    expect(repos.events.listPublishedByPlace).not.toHaveBeenCalled();
  });
});
