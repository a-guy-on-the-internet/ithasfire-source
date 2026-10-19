import { describe, expect, it, vi } from "vitest";

import { getVerificationRequest } from "../get-verification-request";
import type { GetVerificationRequestDeps } from "../get-verification-request";
import type {
  PlaceVerificationRequestRecord,
  PlaceVerificationDocumentRecord,
} from "@th/types/repos/place-verification";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";

function buildRequest(
  overrides: Partial<PlaceVerificationRequestRecord> = {},
): PlaceVerificationRequestRecord {
  return {
    id: DEFAULT_REQUEST_ID,
    placeId: DEFAULT_PLACE_ID,
    orgId: DEFAULT_ORG_ID,
    submittedById: DEFAULT_ACTOR_ID,
    status: "PENDING",
    source: "ORG_SUBMISSION",
    claimantHumanId: null,
    claimOwnerType: null,
    claimOwnerId: null,
    ownershipId: null,
    reviewerNotes: null,
    reviewerHumanId: null,
    reviewedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    ...overrides,
  };
}

function buildDoc(
  overrides: Partial<PlaceVerificationDocumentRecord> = {},
): PlaceVerificationDocumentRecord {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    requestId: DEFAULT_REQUEST_ID,
    storageKey: "place-verification/place1/doc1.pdf",
    fileName: "lease.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
    deletedAt: null,
    createdAt: BASE_DATE,
    ...overrides,
  };
}

function buildDeps(
  overrides: {
    request?: PlaceVerificationRequestRecord | null;
    documents?: PlaceVerificationDocumentRecord[];
    staffAllowed?: boolean;
  } = {},
) {
  const request =
    overrides.request !== undefined ? overrides.request : buildRequest();
  const documents = overrides.documents ?? [buildDoc()];

  const requestsRepo = {
    getById: vi.fn(async () => request),
    getLatestForPlace: vi.fn(async () => request),
  };

  const documentsRepo = {
    listByRequestId: vi.fn(async () => documents),
  };

  const authz = {
    hasStaffRole: vi.fn(async () => ({
      allowed: overrides.staffAllowed ?? true,
      roles: overrides.staffAllowed === false ? [] : ["ADMIN"],
    })),
  };

  const storage = {
    getObjectUrl: vi.fn(async () => ({
      url: "https://r2.example.com/signed/doc.pdf",
    })),
  };

  const deps: GetVerificationRequestDeps = {
    repos: {
      placeVerificationRequests: requestsRepo,
      placeVerificationDocuments: documentsRepo,
    } as any,
    authz: authz as any,
    storage: storage as any,
  };

  return { deps, requestsRepo, documentsRepo, authz, storage };
}

describe("getVerificationRequest", () => {
  it("returns request with signed document URLs", async () => {
    const { deps } = buildDeps();

    const result = await getVerificationRequest(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      requestId: DEFAULT_REQUEST_ID,
    });

    expect(result.id).toBe(DEFAULT_REQUEST_ID);
    expect(result.status).toBe("PENDING");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].viewUrl).toBe(
      "https://r2.example.com/signed/doc.pdf",
    );
    expect(result.documents[0].fileName).toBe("lease.pdf");
  });

  it("sets viewUrl to null for deleted documents", async () => {
    const deletedDoc = buildDoc({ deletedAt: BASE_DATE });
    const { deps, storage } = buildDeps({ documents: [deletedDoc] });

    const result = await getVerificationRequest(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      requestId: DEFAULT_REQUEST_ID,
    });

    expect(result.documents[0].viewUrl).toBeNull();
    expect(storage.getObjectUrl).not.toHaveBeenCalled();
  });

  it("throws forbidden when actor lacks staff role", async () => {
    const { deps } = buildDeps({ staffAllowed: false });

    await expect(
      getVerificationRequest(deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        requestId: DEFAULT_REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws not_found when request does not exist", async () => {
    const { deps } = buildDeps({ request: null });

    await expect(
      getVerificationRequest(deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        requestId: DEFAULT_REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_NOT_FOUND" });
  });

  it("sets viewUrl to null when signed URL generation fails", async () => {
    const { deps, storage } = buildDeps();
    storage.getObjectUrl.mockRejectedValueOnce(new Error("R2 unavailable"));

    const logger = {
      child: () => logger,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withTime: vi.fn(async (_label: string, fn: () => Promise<any>) => fn()),
    };
    (deps as any).logger = logger;

    const result = await getVerificationRequest(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      requestId: DEFAULT_REQUEST_ID,
    });

    expect(result.documents[0].viewUrl).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "signed_url_failed",
      expect.any(Object),
    );
  });

  it("returns multiple documents with their respective URLs", async () => {
    const doc1 = buildDoc({
      id: "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",
      fileName: "lease.pdf",
    });
    const doc2 = buildDoc({
      id: "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2",
      fileName: "license.jpg",
    });
    const { deps, storage } = buildDeps({ documents: [doc1, doc2] });

    storage.getObjectUrl
      .mockResolvedValueOnce({ url: "https://r2.example.com/signed/lease.pdf" })
      .mockResolvedValueOnce({
        url: "https://r2.example.com/signed/license.jpg",
      });

    const result = await getVerificationRequest(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      requestId: DEFAULT_REQUEST_ID,
    });

    expect(result.documents).toHaveLength(2);
    expect(result.documents[0].viewUrl).toBe(
      "https://r2.example.com/signed/lease.pdf",
    );
    expect(result.documents[1].viewUrl).toBe(
      "https://r2.example.com/signed/license.jpg",
    );
  });

  it("resolves by placeId when requestId is not provided", async () => {
    const { deps, requestsRepo } = buildDeps();

    const result = await getVerificationRequest(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      placeId: DEFAULT_PLACE_ID,
    });

    expect(result.id).toBe(DEFAULT_REQUEST_ID);
    expect(requestsRepo.getLatestForPlace).toHaveBeenCalledWith(
      DEFAULT_PLACE_ID,
    );
    expect(requestsRepo.getById).not.toHaveBeenCalled();
  });

  it("throws not_found when no request exists for placeId", async () => {
    const { deps, requestsRepo } = buildDeps({ request: null });
    requestsRepo.getLatestForPlace.mockResolvedValueOnce(null);

    await expect(
      getVerificationRequest(deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        placeId: DEFAULT_PLACE_ID,
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_NOT_FOUND" });
  });
});
