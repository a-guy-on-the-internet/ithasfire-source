import { describe, expect, it, vi } from "vitest";

import { submitPlaceVerification } from "../submit-place-verification";
import type {
  SubmitPlaceVerificationDeps,
  SubmitPlaceVerificationInput,
} from "../submit-place-verification";

import type { PlaceRecord } from "@th/ports/repos/places";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const DOC_KEY = `place-verification/${DEFAULT_PLACE_ID}/doc1.pdf`;

function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
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
    verificationStatus: "UNVERIFIED",
    orgIdsWithAccess: [DEFAULT_ORG_ID],
    humanIdsWithAccess: [],
    ...overrides,
  } satisfies PlaceRecord;
}

function buildDeps(
  overrides: {
    place?: PlaceRecord | null;
    orgRoleAllowed?: boolean;
    activeRequest?: { id: string; status: "PENDING" | "IN_REVIEW" } | null;
    /** Active request seen under the claim lock (defaults to none). */
    activeRequestUnderLock?: { id: string } | null;
    /** The row as read under the claim lock (defaults to `place`). */
    lockedPlace?: PlaceRecord;
    /** The row re-read after a lost CAS (defaults to `lockedPlace`). */
    afterLostCas?: PlaceRecord;
    casChanged?: boolean;
  } = {},
) {
  const place = overrides.place ?? buildPlaceRecord();
  const lockedPlace = overrides.lockedPlace ?? place;
  const afterLostCas = overrides.afterLostCas ?? lockedPlace;

  // Call order across the lock and the place reads.
  const calls: string[] = [];
  let reads = 0;
  const placesRepo = {
    // 1st read: before the lock; 2nd: under it; 3rd: after a lost CAS.
    getById: vi.fn(async () => {
      reads += 1;
      calls.push(`getById#${reads}`);
      if (reads === 1) return place;
      if (reads === 2) return lockedPlace;
      return afterLostCas;
    }),
    lockPlaceForClaim: vi.fn(async () => {
      calls.push("lockPlaceForClaim");
    }),
    setVerificationStatus: vi.fn(async () => {
      calls.push("setVerificationStatus");
      return { changed: overrides.casChanged ?? true };
    }),
    upsert: vi.fn(async (input: any) => ({
      ...place!,
      verificationStatus: input.verificationStatus ?? place!.verificationStatus,
    })),
  };

  const verificationRequestsRepo = {
    create: vi.fn(async () => ({
      id: DEFAULT_REQUEST_ID,
      placeId: DEFAULT_PLACE_ID,
      orgId: DEFAULT_ORG_ID,
      submittedById: DEFAULT_ACTOR_ID,
      status: "PENDING" as const,
      reviewerNotes: null,
      reviewerHumanId: null,
      reviewedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      createdAt: BASE_DATE,
      updatedAt: BASE_DATE,
    })),
    getById: vi.fn(async () => null),
    getActiveForPlace: vi.fn(),
  };
  let activeReads = 0;
  verificationRequestsRepo.getActiveForPlace.mockImplementation(async () => {
    activeReads += 1;
    if (activeReads > 1) {
      return overrides.activeRequestUnderLock
        ? {
            id: overrides.activeRequestUnderLock.id,
            placeId: DEFAULT_PLACE_ID,
            orgId: DEFAULT_ORG_ID,
            submittedById: DEFAULT_ACTOR_ID,
            status: "PENDING" as const,
            reviewerNotes: null,
            reviewerHumanId: null,
            reviewedAt: null,
            acknowledgedAt: null,
            acknowledgedBy: null,
            createdAt: BASE_DATE,
            updatedAt: BASE_DATE,
          }
        : null;
    }
    return overrides.activeRequest
        ? {
            id: overrides.activeRequest.id,
            placeId: DEFAULT_PLACE_ID,
            orgId: DEFAULT_ORG_ID,
            submittedById: DEFAULT_ACTOR_ID,
            status: overrides.activeRequest.status,
            reviewerNotes: null,
            reviewerHumanId: null,
            reviewedAt: null,
            acknowledgedAt: null,
            acknowledgedBy: null,
            createdAt: BASE_DATE,
            updatedAt: BASE_DATE,
          }
        : null;
  });

  const verificationDocumentsRepo = {
    createMany: vi.fn(async () => []),
    listByRequestId: vi.fn(async () => []),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const authzRepo = {
    getOrgMembership: vi.fn(),
  };

  const searchReindexPending = { mark: vi.fn(async () => undefined) };
  const txRepos = {
    places: placesRepo,
    placeVerificationRequests: verificationRequestsRepo,
    placeVerificationDocuments: verificationDocumentsRepo,
    authz: authzRepo,
    audit: auditRepo,
    searchReindexPending,
  };
  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
  } as unknown as SubmitPlaceVerificationDeps["repos"];

  const authz = {
    hasOrgRole: vi.fn(async () => ({
      allowed: overrides.orgRoleAllowed ?? true,
    })),
  };

  const clock = { now: vi.fn(() => BASE_DATE) };

  const storage = {
    headObject: vi.fn(async () => ({ exists: true, size: 500_000 })),
    deleteObject: vi.fn(async () => ({ ok: true as const })),
  };

  const deps: SubmitPlaceVerificationDeps = { repos, authz, clock, storage };

  return {
    deps,
    calls,
    mocks: {
      searchReindexPending,
      placesRepo,
      verificationRequestsRepo,
      verificationDocumentsRepo,
      auditRepo,
      authz,
      storage,
    },
  };
}

function makeInput(
  overrides: Partial<SubmitPlaceVerificationInput> = {},
): SubmitPlaceVerificationInput {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    placeId: DEFAULT_PLACE_ID,
    orgId: DEFAULT_ORG_ID,
    documents: [
      {
        storageKey: DOC_KEY,
        fileName: "business-license.pdf",
        contentType: "application/pdf",
        sizeBytes: 500_000,
      },
    ],
    ...overrides,
  };
}

describe("submitPlaceVerification", () => {
  it("creates a verification request with documents", async () => {
    const { deps, mocks } = buildDeps();
    const result = await submitPlaceVerification(deps, makeInput());

    expect(result.requestId).toBe(DEFAULT_REQUEST_ID);
    expect(mocks.verificationRequestsRepo.create).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      orgId: DEFAULT_ORG_ID,
      submittedById: DEFAULT_ACTOR_ID,
    });
    expect(mocks.verificationDocumentsRepo.createMany).toHaveBeenCalledWith({
      requestId: DEFAULT_REQUEST_ID,
      documents: [
        {
          storageKey: DOC_KEY,
          fileName: "business-license.pdf",
          contentType: "application/pdf",
          sizeBytes: 500_000,
        },
      ],
    });
    // Sets the place to PENDING: verification only, compare-and-set.
    expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      from: "UNVERIFIED",
      to: "PENDING",
    });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.searchReindexPending.mark).toHaveBeenCalledTimes(1);
  });

  it("rejects when actor is not org admin", async () => {
    const { deps } = buildDeps({ orgRoleAllowed: false });

    await expect(
      submitPlaceVerification(deps, makeInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects when place not found", async () => {
    const { deps } = buildDeps({ place: null });
    // Need to adjust mock for null place
    (deps.repos.places.getById as any).mockResolvedValue(null);

    await expect(
      submitPlaceVerification(deps, makeInput()),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("rejects when org does not own the place", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({ orgIdsWithAccess: ["other-org-id"] }),
    });

    await expect(
      submitPlaceVerification(deps, makeInput()),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("returns the existing active request when one is already open", async () => {
    const existingId = "55555555-5555-4555-8555-555555555555";
    const { deps, mocks } = buildDeps({
      activeRequest: { id: existingId, status: "PENDING" },
    });

    const result = await submitPlaceVerification(deps, makeInput());

    expect(result).toEqual({
      requestId: existingId,
      reusedActiveRequest: true,
      reusedDocumentCount: 0,
    });
    // Should NOT create a new request when an active one already exists.
    expect(mocks.verificationRequestsRepo.create).not.toHaveBeenCalled();
    expect(mocks.verificationDocumentsRepo.createMany).not.toHaveBeenCalled();
  });

  // F11 (2026-09-29): new documents are HEADed before anything is written.
  it("rejects, WITHOUT deleting, a document over only its re-stated size", async () => {
    const { deps, mocks } = buildDeps();
    mocks.storage.headObject.mockResolvedValue({
      exists: true,
      size: 500_001,
    });

    await expect(
      submitPlaceVerification(deps, makeInput()),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "upload_size_exceeded",
    });
    expect(mocks.storage.deleteObject).not.toHaveBeenCalled();
    expect(mocks.verificationRequestsRepo.create).not.toHaveBeenCalled();
  });

  it("deletes and rejects a document over its server-stamped presign size", async () => {
    const { deps, mocks } = buildDeps();
    mocks.storage.headObject.mockResolvedValue({
      exists: true,
      size: 400_000,
      metadata: { "th-declared-bytes": "1" },
    } as never);

    await expect(
      submitPlaceVerification(deps, makeInput()),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.storage.deleteObject).toHaveBeenCalledWith({ key: DOC_KEY });
    expect(mocks.verificationRequestsRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a document key outside this place's upload prefix", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      submitPlaceVerification(
        deps,
        makeInput({
          documents: [
            {
              storageKey: "place-verification/other-place/doc1.pdf",
              fileName: "x.pdf",
              contentType: "application/pdf",
              sizeBytes: 10,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "document_key_not_owned",
    });
    expect(mocks.storage.headObject).not.toHaveBeenCalled();
    expect(mocks.verificationRequestsRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a document that was never uploaded", async () => {
    const { deps, mocks } = buildDeps();
    mocks.storage.headObject.mockResolvedValue({ exists: false } as never);

    await expect(
      submitPlaceVerification(deps, makeInput()),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_COMPLETE" });
    expect(mocks.verificationRequestsRepo.create).not.toHaveBeenCalled();
  });

  it("accepts a document matching its declared size", async () => {
    const { deps, mocks } = buildDeps();
    await submitPlaceVerification(deps, makeInput());
    expect(mocks.storage.headObject).toHaveBeenCalledWith({ key: DOC_KEY });
    expect(mocks.storage.deleteObject).not.toHaveBeenCalled();
    expect(mocks.verificationDocumentsRepo.createMany).toHaveBeenCalled();
  });

  it("logs an audit entry on success", async () => {
    const { deps, mocks } = buildDeps();
    await submitPlaceVerification(deps, makeInput());

    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place_verification_request",
        action: "verification_submitted",
      }),
    );
  });

  // It used to write PENDING by rebuilding the whole row (NULL line1 /
  // country → "") outside any transaction, with no lock: a claim or staff
  // verify landing meanwhile was demoted or doubled.
  describe("under the claim lock", () => {
    it("takes the lock, then reads, then writes verification only", async () => {
      const place = {
        ...buildPlaceRecord(),
        countryCode: null,
        addressLine1: null,
      } as unknown as PlaceRecord;
      const { deps, calls, mocks } = buildDeps({ place });

      await submitPlaceVerification(deps, makeInput());

      expect(calls).toEqual([
        "getById#1",
        "lockPlaceForClaim",
        "getById#2",
        "setVerificationStatus",
      ]);
      expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
      const [arg] = mocks.placesRepo.setVerificationStatus.mock
        .calls[0] as unknown as [Record<string, unknown>];
      expect(Object.keys(arg).sort()).toEqual(["from", "placeId", "to"]);
    });

    it("CAS `from` is the under-lock status (REJECTED → PENDING)", async () => {
      const { deps, mocks } = buildDeps({
        lockedPlace: buildPlaceRecord({ verificationStatus: "REJECTED" }),
      });

      await submitPlaceVerification(deps, makeInput());

      expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith({
        placeId: DEFAULT_PLACE_ID,
        from: "REJECTED",
        to: "PENDING",
      });
    });

    it.each([
      ["VERIFIED", "PLACE_ALREADY_VERIFIED"],
      ["PENDING", "VERIFICATION_ALREADY_PENDING"],
    ] as const)(
      "refuses a place that became %s while waiting (%s), writing nothing",
      async (status, code) => {
        const { deps, mocks } = buildDeps({
          lockedPlace: buildPlaceRecord({ verificationStatus: status }),
        });

        await expect(
          submitPlaceVerification(deps, makeInput()),
        ).rejects.toMatchObject({ code });
        expect(mocks.verificationRequestsRepo.create).not.toHaveBeenCalled();
        expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
        expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      },
    );

    it("refuses a place already VERIFIED before the call (not demoted)", async () => {
      const { deps, mocks } = buildDeps({
        place: buildPlaceRecord({ verificationStatus: "VERIFIED" }),
      });

      await expect(
        submitPlaceVerification(deps, makeInput()),
      ).rejects.toMatchObject({ code: "PLACE_ALREADY_VERIFIED" });
      expect(mocks.verificationRequestsRepo.create).not.toHaveBeenCalled();
      expect(mocks.verificationDocumentsRepo.createMany).not.toHaveBeenCalled();
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
    });

    it("returns a request filed while it waited instead of a second one", async () => {
      const otherId = "66666666-6666-4666-8666-666666666666";
      const { deps, mocks } = buildDeps({
        activeRequestUnderLock: { id: otherId },
      });

      const result = await submitPlaceVerification(deps, makeInput());

      expect(result).toEqual({
        requestId: otherId,
        reusedActiveRequest: true,
        reusedDocumentCount: 0,
      });
      expect(mocks.verificationRequestsRepo.create).not.toHaveBeenCalled();
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
    });

    it("re-checks org ownership under the lock", async () => {
      const { deps, mocks } = buildDeps({
        lockedPlace: buildPlaceRecord({ orgIdsWithAccess: [] }),
      });

      await expect(
        submitPlaceVerification(deps, makeInput()),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.verificationRequestsRepo.create).not.toHaveBeenCalled();
    });
  });

  describe("lost compare-and-set", () => {
    it.each([
      ["VERIFIED", "PLACE_ALREADY_VERIFIED"],
      ["PENDING", "VERIFICATION_ALREADY_PENDING"],
    ] as const)(
      "refuses when the row is now %s (%s); no audit, no mark",
      async (status, code) => {
        const { deps, mocks } = buildDeps({
          casChanged: false,
          afterLostCas: buildPlaceRecord({ verificationStatus: status }),
        });

        await expect(
          submitPlaceVerification(deps, makeInput()),
        ).rejects.toMatchObject({ code });
        expect(mocks.auditRepo.log).not.toHaveBeenCalled();
        expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
      },
    );

    it("CONFLICT when the row moved between UNVERIFIED and REJECTED", async () => {
      const { deps, mocks } = buildDeps({
        casChanged: false,
        afterLostCas: buildPlaceRecord({ verificationStatus: "REJECTED" }),
      });

      await expect(
        submitPlaceVerification(deps, makeInput()),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        meta: expect.objectContaining({
          reason: "place_verification_changed",
        }),
      });
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });
  });
});
