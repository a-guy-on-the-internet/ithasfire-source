import { describe, expect, it, vi } from "vitest";

import { reviewPlaceVerification } from "../review-place-verification";
import type {
  ReviewPlaceVerificationDeps,
  ReviewPlaceVerificationInput,
} from "../review-place-verification";

import type { PlaceRecord } from "@th/ports/repos/places";
import type { PlaceVerificationRequestRecord } from "@th/ports/repos/place-verification-requests";
import type { PlaceVerificationDocumentRecord } from "@th/ports/repos/place-verification-documents";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_REQUEST_ID = "44444444-4444-4444-8444-444444444444";

function buildRequest(
  overrides: Partial<PlaceVerificationRequestRecord> = {},
): PlaceVerificationRequestRecord {
  return {
    id: DEFAULT_REQUEST_ID,
    placeId: DEFAULT_PLACE_ID,
    orgId: DEFAULT_ORG_ID,
    submittedById: "55555555-5555-5555-5555-555555555555",
    status: "PENDING",
    reviewerNotes: null,
    reviewerHumanId: null,
    reviewedAt: null,
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    ...overrides,
  };
}

function buildPlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: DEFAULT_PLACE_ID,
    name: "Test Venue",
    slug: "test-venue",
    formattedAddress: "123 Main St",
    addressLine1: "123 Main St",
    addressLine2: null,
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    countryCode: "US",
    capacity: 500,
    lat: 30.267,
    lng: -97.743,
    status: "ACTIVE",
    verificationStatus: "PENDING",
    orgIdsWithAccess: [DEFAULT_ORG_ID],
    humanIdsWithAccess: [],
    ...overrides,
  };
}

function buildDocuments(): PlaceVerificationDocumentRecord[] {
  return [
    {
      id: "doc-1",
      requestId: DEFAULT_REQUEST_ID,
      storageKey: "place-verification/test/doc1.pdf",
      fileName: "license.pdf",
      contentType: "application/pdf",
      sizeBytes: 100_000,
      deletedAt: null,
      createdAt: BASE_DATE,
    },
    {
      id: "doc-2",
      requestId: DEFAULT_REQUEST_ID,
      storageKey: "place-verification/test/doc2.jpg",
      fileName: "lease.jpg",
      contentType: "image/jpeg",
      sizeBytes: 200_000,
      deletedAt: null,
      createdAt: BASE_DATE,
    },
  ];
}

function buildDeps(
  overrides: {
    request?: PlaceVerificationRequestRecord | null;
    place?: PlaceRecord | null;
    documents?: PlaceVerificationDocumentRecord[];
    staffAllowed?: boolean;
    /** The row a writer that skips the claim lock leaves as the verification CAS runs; `null` deletes it. */
    rowAtWrite?: Partial<PlaceRecord> | null;
  } = {},
) {
  const request = overrides.request ?? buildRequest();
  const place = overrides.place ?? buildPlace();
  const documents = overrides.documents ?? buildDocuments();

  const verificationRequestsRepo = {
    getById: vi.fn(async () => request),
    updateDecision: vi.fn(async () => ({
      ...request!,
      status: "APPROVED" as const,
      reviewerHumanId: DEFAULT_ACTOR_ID,
      reviewedAt: BASE_DATE,
    })),
  };

  const verificationDocumentsRepo = {
    listByRequestId: vi.fn(async () => documents),
    markDeleted: vi.fn(async () => documents.length),
  };

  // Stateful, like the table: each compare-and-set writes into `row`.
  let row: PlaceRecord | null = place ? { ...place } : null;
  const placesRepo = {
    getById: vi.fn(async () => (row ? { ...row } : null)),
    // A tripwire: the whole-row rebuild this use case used to do.
    upsert: vi.fn(),
    // Every decision that writes the place takes the claim lock first.
    lockPlaceForClaim: vi.fn(async () => undefined),
    // Mirrors the adapter: `updateMany where { id, verification: from }`.
    setVerificationStatus: vi.fn(
      async (input: { placeId: string; from: string; to: string }) => {
        if (Object.prototype.hasOwnProperty.call(overrides, "rowAtWrite")) {
          row =
            overrides.rowAtWrite === null || !row
              ? null
              : { ...row, ...overrides.rowAtWrite };
        }
        if (!row || row.verificationStatus !== input.from) {
          return { changed: false };
        }
        row = { ...row, verificationStatus: input.to as any };
        return { changed: true };
      },
    ),
    setDirectoryListing: vi.fn(
      async (input: { placeId: string; listedInDirectory: boolean }) => {
        if (!row || row.listedInDirectory === input.listedInDirectory) {
          return { changed: false };
        }
        row = { ...row, listedInDirectory: input.listedInDirectory };
        return { changed: true };
      },
    ),
    setCommunityListingAcceptance: vi.fn(async () => ({ changed: false })),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };
  const searchReindexPending = { mark: vi.fn(async () => undefined) };

  const quotasRepo = {
    incrementUsage: vi.fn(async (input: any) => ({
      id: "usage-1",
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      currentUsage: input.delta,
      updatedAt: BASE_DATE,
      createdAt: BASE_DATE,
    })),
  };

  // A TRIPWIRE since the 2026-09-25 amendment removed parking: a review no
  // longer touches any booking request, so nothing here may be called.
  const bookingRequestsRepo = {
    listOpenParked: vi.fn(async () => []),
    expireParked: vi.fn(async () => null),
    touchLastMessageAt: vi.fn(async () => undefined),
  };

  const repos = {
    tx: vi.fn(async (fn: any) => fn(repos)),
    places: placesRepo,
    placeVerificationRequests: verificationRequestsRepo,
    placeVerificationDocuments: verificationDocumentsRepo,
    audit: auditRepo,
    resourceQuotas: quotasRepo,
    bookingRequests: bookingRequestsRepo,
    bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
    searchReindexPending,
  } as unknown as ReviewPlaceVerificationDeps["repos"];

  const authz = {
    hasStaffRole: vi.fn(async () => ({
      allowed: overrides.staffAllowed ?? true,
    })),
  };

  const storage = {
    deleteObject: vi.fn(async () => undefined),
  };

  const clock = { now: vi.fn(() => BASE_DATE) };

  const deps: ReviewPlaceVerificationDeps = {
    repos,
    authz,
    storage: storage as any,
    clock,
  };

  return {
    deps,
    mocks: {
      verificationRequestsRepo,
      verificationDocumentsRepo,
      placesRepo,
      auditRepo,
      quotasRepo,
      authz,
      storage,
      bookingRequestsRepo,
      searchReindexPending,
    },
    currentRow: () => row,
  };
}

function makeInput(
  overrides: Partial<ReviewPlaceVerificationInput> = {},
): ReviewPlaceVerificationInput {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    requestId: DEFAULT_REQUEST_ID,
    decision: "APPROVED",
    reviewerNotes: null,
    ...overrides,
  };
}

describe("reviewPlaceVerification", () => {
  it("approves a verification request and sets place to VERIFIED", async () => {
    const { deps, mocks } = buildDeps();
    const result = await reviewPlaceVerification(
      deps,
      makeInput({ decision: "APPROVED" }),
    );

    expect(result.decision).toBe("APPROVED");
    expect(result.placeId).toBe(DEFAULT_PLACE_ID);
    expect(mocks.verificationRequestsRepo.updateDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "APPROVED",
        reviewerHumanId: DEFAULT_ACTOR_ID,
      }),
    );
    expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      from: "PENDING",
      to: "VERIFIED",
    });
    expect(mocks.placesRepo.setDirectoryListing).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      listedInDirectory: true,
    });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("rejects a verification request and sets place to REJECTED", async () => {
    const { deps, mocks } = buildDeps();
    const result = await reviewPlaceVerification(
      deps,
      makeInput({ decision: "REJECTED", reviewerNotes: "Documents unclear" }),
    );

    expect(result.decision).toBe("REJECTED");
    expect(mocks.verificationRequestsRepo.updateDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "REJECTED",
        reviewerNotes: "Documents unclear",
      }),
    );
    expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      from: "PENDING",
      to: "REJECTED",
    });
    // A rejection never lists the place.
    expect(mocks.placesRepo.setDirectoryListing).not.toHaveBeenCalled();
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("deletes documents from R2 after decision", async () => {
    const { deps, mocks } = buildDeps();
    await reviewPlaceVerification(deps, makeInput());

    expect(mocks.storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(mocks.storage.deleteObject).toHaveBeenCalledWith({
      key: "place-verification/test/doc1.pdf",
    });
    expect(mocks.storage.deleteObject).toHaveBeenCalledWith({
      key: "place-verification/test/doc2.jpg",
    });
  });

  it("marks documents as deleted in DB", async () => {
    const { deps, mocks } = buildDeps();
    await reviewPlaceVerification(deps, makeInput());

    expect(mocks.verificationDocumentsRepo.markDeleted).toHaveBeenCalledWith({
      requestId: DEFAULT_REQUEST_ID,
      deletedAt: BASE_DATE,
    });
  });

  it("rejects non-staff actors", async () => {
    const { deps } = buildDeps({ staffAllowed: false });

    await expect(
      reviewPlaceVerification(deps, makeInput()),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("rejects if request not found", async () => {
    const { deps } = buildDeps({ request: null });
    (deps.repos.placeVerificationRequests.getById as any).mockResolvedValue(
      null,
    );

    await expect(
      reviewPlaceVerification(deps, makeInput()),
    ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_NOT_FOUND" });
  });

  it("rejects if request already decided", async () => {
    const { deps } = buildDeps({
      request: buildRequest({ status: "APPROVED" }),
    });

    await expect(
      reviewPlaceVerification(deps, makeInput()),
    ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_ALREADY_DECIDED" });
  });

  it("continues gracefully if R2 delete fails", async () => {
    const { deps, mocks } = buildDeps();
    mocks.storage.deleteObject.mockRejectedValue(new Error("R2 timeout"));

    // Should not throw
    const result = await reviewPlaceVerification(deps, makeInput());
    expect(result.decision).toBe("APPROVED");
  });

  it("logs an audit entry with reviewer notes", async () => {
    const { deps, mocks } = buildDeps();
    await reviewPlaceVerification(
      deps,
      makeInput({ decision: "REJECTED", reviewerNotes: "Unclear docs" }),
    );

    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place_verification_request",
        action: "verification_rejected",
        data: expect.objectContaining({ reviewerNotes: "Unclear docs" }),
      }),
    );
  });

  it("decrements STORAGE_BYTES_ORG for successfully deleted documents", async () => {
    const { deps, mocks } = buildDeps();
    await reviewPlaceVerification(deps, makeInput());

    // Two docs: 100_000 + 200_000 = 300_000 bytes
    expect(mocks.quotasRepo.incrementUsage).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: DEFAULT_ORG_ID,
      kind: "STORAGE_BYTES_ORG",
      delta: -300_000n,
    });
  });

  it("does not decrement storage quota when all R2 deletes fail", async () => {
    const { deps, mocks } = buildDeps();
    mocks.storage.deleteObject.mockRejectedValue(new Error("R2 timeout"));

    await reviewPlaceVerification(deps, makeInput());

    expect(mocks.quotasRepo.incrementUsage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parking is gone (amendment 2026-09-25): an approval keeps the claim lock but
// touches no booking request and owes no notification.
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewPlaceVerification — no booking-request side effects (parking removed)", () => {
  it("legacy ORG_SUBMISSION approval still takes the claim lock FIRST, and touches no booking request", async () => {
    const { deps, mocks } = buildDeps();
    const out = await reviewPlaceVerification(deps, makeInput());
    expect(mocks.placesRepo.lockPlaceForClaim).toHaveBeenCalledWith(DEFAULT_PLACE_ID);
    expect(mocks.placesRepo.lockPlaceForClaim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.verificationRequestsRepo.updateDecision.mock.invocationCallOrder[0]!,
    );
    expect(mocks.bookingRequestsRepo.listOpenParked).not.toHaveBeenCalled();
    expect(mocks.bookingRequestsRepo.expireParked).not.toHaveBeenCalled();
    expect(mocks.bookingRequestsRepo.touchLastMessageAt).not.toHaveBeenCalled();
    expect(out).toEqual({
      requestId: expect.any(String),
      decision: "APPROVED",
      placeId: DEFAULT_PLACE_ID,
    });
  });

  it("rejection takes the claim lock too (it writes the place) and owes nothing", async () => {
    const { deps, mocks } = buildDeps();
    const out = await reviewPlaceVerification(
      deps,
      makeInput({ decision: "REJECTED", reviewerNotes: "Documents do not match the venue." }),
    );
    expect(mocks.placesRepo.lockPlaceForClaim).toHaveBeenCalledWith(DEFAULT_PLACE_ID);
    expect(out).not.toHaveProperty("notificationIntents");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The place writes are compare-and-sets deciding from a read taken under the
// claim lock. They used to rebuild the whole row through `places.upsert` from
// a read taken before the transaction.
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewPlaceVerification — one-column writes from the under-lock read", () => {
  it("the CAS `from` is the status read UNDER the lock, not the pre-transaction read", async () => {
    const { deps, mocks } = buildDeps();
    // Pre-tx read says PENDING; by the time the lock is held a writer that
    // skips it (the place editor) has written REJECTED.
    mocks.placesRepo.getById
      .mockResolvedValueOnce(buildPlace({ verificationStatus: "PENDING" }))
      .mockResolvedValueOnce(buildPlace({ verificationStatus: "REJECTED" }));
    mocks.placesRepo.setVerificationStatus.mockResolvedValueOnce({
      changed: true,
    });

    await reviewPlaceVerification(deps, makeInput({ decision: "APPROVED" }));

    expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      from: "REJECTED",
      to: "VERIFIED",
    });
    const lockAt = mocks.placesRepo.lockPlaceForClaim.mock.invocationCallOrder[0]!;
    expect(mocks.placesRepo.getById.mock.invocationCallOrder[1]!).toBeGreaterThan(
      lockAt,
    );
  });

  it("a NULL street line and country stay NULL, and a concurrent name edit survives", async () => {
    const { deps, currentRow } = buildDeps({
      place: buildPlace({ addressLine1: null, countryCode: null }),
      rowAtWrite: { name: "Renamed By Moderator" },
    });

    await reviewPlaceVerification(deps, makeInput({ decision: "APPROVED" }));

    expect(currentRow()).toMatchObject({
      verificationStatus: "VERIFIED",
      listedInDirectory: true,
      addressLine1: null,
      countryCode: null,
      name: "Renamed By Moderator",
    });
  });

  it("approve audits the listing as place.directory_listed and marks the place for reindex", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlace({ listedInDirectory: false }),
    });

    await reviewPlaceVerification(deps, makeInput({ decision: "APPROVED" }));

    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place",
        entityId: DEFAULT_PLACE_ID,
        action: "place.directory_listed",
        data: expect.objectContaining({
          previous: false,
          next: true,
          actorHumanId: DEFAULT_ACTOR_ID,
        }),
      }),
    );
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "verification_approved",
        data: expect.objectContaining({
          placeVerification: { from: "PENDING", to: "VERIFIED" },
        }),
      }),
    );
    expect(mocks.searchReindexPending.mark).toHaveBeenCalledTimes(1);
  });

  it("an already-listed place gets no listing audit row", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlace({ listedInDirectory: true }),
    });

    await reviewPlaceVerification(deps, makeInput({ decision: "APPROVED" }));

    const actions = mocks.auditRepo.log.mock.calls.map(
      (c: any[]) => c[0].action,
    );
    expect(actions).not.toContain("place.directory_listed");
  });

  it("a place already at the target is not written and not marked", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlace({ verificationStatus: "REJECTED" }),
    });

    await reviewPlaceVerification(
      deps,
      makeInput({ decision: "REJECTED", reviewerNotes: "Documents unclear" }),
    );

    expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
    expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
  });

  it("a lost CAS that finds the row already at the target is success, not CONFLICT", async () => {
    const { deps, mocks, currentRow } = buildDeps({
      rowAtWrite: { verificationStatus: "VERIFIED" },
    });

    await expect(
      reviewPlaceVerification(deps, makeInput({ decision: "APPROVED" })),
    ).resolves.toMatchObject({ decision: "APPROVED" });
    expect(currentRow()?.verificationStatus).toBe("VERIFIED");
    const decisionAudit = mocks.auditRepo.log.mock.calls
      .map((c: any[]) => c[0])
      .find((e: any) => e.action === "verification_approved");
    expect(decisionAudit.data).not.toHaveProperty("placeVerification");
  });

  it("a lost CAS on a row moved elsewhere is CONFLICT and rolls the decision back", async () => {
    const { deps, mocks } = buildDeps({
      rowAtWrite: { verificationStatus: "UNVERIFIED" },
    });

    await expect(
      reviewPlaceVerification(deps, makeInput({ decision: "APPROVED" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    expect(mocks.storage.deleteObject).not.toHaveBeenCalled();
  });

  it("a lost CAS on a row removed meanwhile is PLACE_NOT_FOUND", async () => {
    const { deps } = buildDeps({ rowAtWrite: null });

    await expect(
      reviewPlaceVerification(deps, makeInput({ decision: "APPROVED" })),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The post-commit swallows report (CLAUDE.md "Error Reporting Convention"):
// `logger.warn` never reaches Sentry.
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewPlaceVerification — swallowed post-commit failures are reported", () => {
  it("reports a failed R2 delete, once per document, and still succeeds", async () => {
    const { deps, mocks } = buildDeps();
    const reportError = vi.fn();
    deps.reportError = reportError;
    const boom = new Error("R2 timeout");
    mocks.storage.deleteObject.mockRejectedValue(boom);

    await expect(
      reviewPlaceVerification(deps, makeInput()),
    ).resolves.toMatchObject({ decision: "APPROVED" });

    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "reviewPlaceVerification", op: "r2_delete" },
      extra: {
        requestId: DEFAULT_REQUEST_ID,
        storageKey: "place-verification/test/doc1.pdf",
      },
    });
  });

  it("reports a failed storage-quota decrement and still succeeds", async () => {
    const { deps, mocks } = buildDeps();
    const reportError = vi.fn();
    deps.reportError = reportError;
    const boom = new Error("quota down");
    mocks.quotasRepo.incrementUsage.mockRejectedValue(boom);

    await expect(
      reviewPlaceVerification(deps, makeInput()),
    ).resolves.toMatchObject({ decision: "APPROVED" });

    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: {
        useCase: "reviewPlaceVerification",
        op: "storage_quota_decrement",
      },
      extra: {
        requestId: DEFAULT_REQUEST_ID,
        orgId: DEFAULT_ORG_ID,
        reclaimedBytes: "300000",
      },
    });
  });

  it("a throwing reporter changes nothing", async () => {
    const { deps, mocks } = buildDeps();
    deps.reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    mocks.storage.deleteObject.mockRejectedValue(new Error("R2 timeout"));

    await expect(
      reviewPlaceVerification(deps, makeInput()),
    ).resolves.toMatchObject({ decision: "APPROVED" });
  });

  it("nothing is reported when cleanup succeeds", async () => {
    const { deps } = buildDeps();
    const reportError = vi.fn();
    deps.reportError = reportError;

    await reviewPlaceVerification(deps, makeInput());

    expect(reportError).not.toHaveBeenCalled();
  });
});
