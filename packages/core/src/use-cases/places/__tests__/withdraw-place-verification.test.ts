import { describe, expect, it, vi } from "vitest";

import { withdrawPlaceVerification } from "../withdraw-place-verification";
import type { WithdrawPlaceVerificationDeps } from "../withdraw-place-verification";

import type { PlaceRecord } from "@th/ports/repos/places";
import type { PlaceVerificationRequestRecord } from "@th/ports/repos/place-verification-requests";
import type { PlaceOwnershipRecord } from "@th/types/repos/place-verification";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "66666666-6666-4666-8666-666666666666";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

function buildRequest(
  overrides: Partial<PlaceVerificationRequestRecord> = {},
): PlaceVerificationRequestRecord {
  return {
    id: REQUEST_ID,
    placeId: PLACE_ID,
    orgId: ORG_ID,
    submittedById: ACTOR_ID,
    status: "PENDING",
    source: "ORG_SUBMISSION",
    claimantHumanId: null,
    claimOwnerType: null,
    claimOwnerId: null,
    ownershipId: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
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
    id: PLACE_ID,
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
    phone: null,
    website: null,
    websiteSource: "UNKNOWN",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: null,
    status: "ACTIVE",
    verificationStatus: "PENDING",
    listedInDirectory: false,
    acceptsBookingRequests: false,
    attendeeReviewsPublic: false,
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    ...overrides,
  };
}

function buildDeps(
  overrides: {
    request?: PlaceVerificationRequestRecord | null;
    place?: PlaceRecord | null;
    withdrawSucceeds?: boolean;
    manageAllowed?: boolean;
    /** The row a writer that skips the claim lock leaves as the CAS runs; `null` deletes it. */
    rowAtWrite?: Partial<PlaceRecord> | null;
    /** The PlaceOwnership row behind `request.ownershipId`. */
    ownership?: PlaceOwnershipRecord | null;
  } = {},
) {
  const request =
    overrides.request === undefined ? buildRequest() : overrides.request;
  const place = overrides.place === undefined ? buildPlace() : overrides.place;

  const verificationRequestsRepo = {
    getById: vi.fn(async () => request),
    withdraw: vi.fn(async () =>
      (overrides.withdrawSucceeds ?? true)
        ? { ...request!, status: "WITHDRAWN" as const }
        : null,
    ),
  };

  // Stateful, like the table: the compare-and-set writes into `row`.
  let row: PlaceRecord | null = place ? { ...place } : null;
  const placesRepo = {
    getById: vi.fn(async () => (row ? { ...row } : null)),
    // A tripwire: the whole-row rebuild this use case used to do.
    upsert: vi.fn(),
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
        row = {
          ...row,
          verificationStatus: input.to as PlaceRecord["verificationStatus"],
        };
        return { changed: true };
      },
    ),
    getOwnershipById: vi.fn(async (id: string) =>
      overrides.ownership && overrides.ownership.id === id
        ? overrides.ownership
        : null,
    ),
    revokeOwnership: vi.fn(async (input: { ownershipId: string }) => ({
      ...overrides.ownership!,
      id: input.ownershipId,
      verified: false,
      revokedAt: BASE_DATE,
    })),
  };

  const auditRepo = { log: vi.fn(async () => undefined) };
  const searchReindexPending = { mark: vi.fn(async () => undefined) };

  // `tx` hands the SAME repo object back, so every assertion below also proves
  // the write happened inside the transaction callback.
  const txSpy = vi.fn(async (fn: (t: unknown) => unknown) => fn(repos));
  const repos = {
    tx: txSpy,
    places: placesRepo,
    placeVerificationRequests: verificationRequestsRepo,
    audit: auditRepo,
    searchReindexPending,
  } as unknown as WithdrawPlaceVerificationDeps["repos"];

  const authz = {
    canManagePlace: vi.fn(async () => ({
      allowed: overrides.manageAllowed ?? true,
    })),
  };

  const deps: WithdrawPlaceVerificationDeps = {
    repos,
    authz: authz as unknown as WithdrawPlaceVerificationDeps["authz"],
    clock: { now: vi.fn(() => BASE_DATE) },
  };

  return {
    deps,
    mocks: {
      verificationRequestsRepo,
      placesRepo,
      auditRepo,
      authz,
      txSpy,
      searchReindexPending,
    },
    currentRow: () => row,
  };
}

describe("withdrawPlaceVerification", () => {
  it("withdraws the request and hands the place back to UNVERIFIED", async () => {
    // The lockout this guards: `submitPlaceVerification` sets the place to
    // PENDING, and EVERY request affordance in the web app gates on
    // UNVERIFIED|REJECTED. Leaving the place PENDING after a withdraw means
    // the organiser can never ask again and no reviewer ever sees a request.
    const { deps, mocks } = buildDeps();

    const result = await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ requestId: REQUEST_ID, placeId: PLACE_ID });
    expect(mocks.verificationRequestsRepo.withdraw).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
    });
    expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledTimes(1);
    expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      from: "PENDING",
      to: "UNVERIFIED",
    });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "verification_withdrawn",
        data: expect.objectContaining({
          placeVerification: { from: "PENDING", to: "UNVERIFIED" },
        }),
      }),
    );
    // verification is on the place's search document.
    expect(mocks.searchReindexPending.mark).toHaveBeenCalledWith(
      [{ entityType: "place", entityId: PLACE_ID }],
      BASE_DATE,
    );
  });

  it("commits the request update and the place reset in ONE transaction", async () => {
    const { deps, mocks } = buildDeps();

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.txSpy).toHaveBeenCalledTimes(1);
  });

  it("the reset touches only verification — a NULL street line and country stay NULL", async () => {
    // The whole-row upsert this replaced wrote NULL `addrLine1` / `country`
    // back as "" (an ownerless community place can have neither).
    const { deps, mocks, currentRow } = buildDeps({
      place: buildPlace({ addressLine1: null, countryCode: null }),
    });

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(currentRow()).toMatchObject({
      verificationStatus: "UNVERIFIED",
      addressLine1: null,
      countryCode: null,
      name: "Test Venue",
    });
  });

  it("takes the claim lock FIRST and decides from a read taken under it", async () => {
    const { deps, mocks } = buildDeps();

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.placesRepo.lockPlaceForClaim).toHaveBeenCalledWith(PLACE_ID);
    const lockAt = mocks.placesRepo.lockPlaceForClaim.mock.invocationCallOrder[0]!;
    expect(lockAt).toBeLessThan(
      mocks.verificationRequestsRepo.withdraw.mock.invocationCallOrder[0]!,
    );
    // The only place read is the one under the lock.
    expect(mocks.placesRepo.getById).toHaveBeenCalledTimes(1);
    expect(mocks.placesRepo.getById.mock.invocationCallOrder[0]!).toBeGreaterThan(
      lockAt,
    );
  });

  it("a moderator's name edit landing before the CAS survives the reset", async () => {
    const { deps, currentRow } = buildDeps({
      rowAtWrite: { name: "Renamed By Moderator" },
    });

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(currentRow()).toMatchObject({
      name: "Renamed By Moderator",
      verificationStatus: "UNVERIFIED",
    });
  });

  it("a lost CAS (staff verified it meanwhile) leaves the place alone, still withdraws, and marks nothing", async () => {
    const { deps, mocks, currentRow } = buildDeps({
      rowAtWrite: { verificationStatus: "VERIFIED" },
    });

    await expect(
      withdrawPlaceVerification(deps, {
        actorHumanId: ACTOR_ID,
        requestId: REQUEST_ID,
      }),
    ).resolves.toEqual({ requestId: REQUEST_ID, placeId: PLACE_ID });

    expect(currentRow()?.verificationStatus).toBe("VERIFIED");
    expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
    const data = (mocks.auditRepo.log.mock.calls[0] as unknown[])[0] as {
      data: Record<string, unknown>;
    };
    expect(data.data).not.toHaveProperty("placeVerification");
  });

  it("a lost CAS on a row removed meanwhile is PLACE_NOT_FOUND and rolls back", async () => {
    const { deps, mocks } = buildDeps({ rowAtWrite: null });

    await expect(
      withdrawPlaceVerification(deps, {
        actorHumanId: ACTOR_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("does NOT demote a VERIFIED place whose re-verification request is cancelled", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlace({ verificationStatus: "VERIFIED" }),
    });

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.verificationRequestsRepo.withdraw).toHaveBeenCalled();
    expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
    expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
  });

  it("leaves a REJECTED place rejected", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlace({ verificationStatus: "REJECTED" }),
    });

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
  });

  it("still withdraws when the place row cannot be read", async () => {
    const { deps, mocks } = buildDeps({ place: null });

    await expect(
      withdrawPlaceVerification(deps, {
        actorHumanId: ACTOR_ID,
        requestId: REQUEST_ID,
      }),
    ).resolves.toEqual({ requestId: REQUEST_ID, placeId: PLACE_ID });
    expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
  });

  it("rolls back (throws out of the tx) when the request left PENDING mid-flight", async () => {
    const { deps, mocks } = buildDeps({ withdrawSucceeds: false });

    await expect(
      withdrawPlaceVerification(deps, {
        actorHumanId: ACTOR_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow();

    // The place reset must NOT have run — that is the whole point of the tx.
    expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("refuses a non-PENDING request before touching anything", async () => {
    const { deps, mocks } = buildDeps({
      request: buildRequest({ status: "IN_REVIEW" }),
    });

    await expect(
      withdrawPlaceVerification(deps, {
        actorHumanId: ACTOR_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow();

    expect(mocks.txSpy).not.toHaveBeenCalled();
    expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
  });

  it("refuses an unknown request", async () => {
    const { deps, mocks } = buildDeps({ request: null });

    await expect(
      withdrawPlaceVerification(deps, {
        actorHumanId: ACTOR_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow();
    expect(mocks.txSpy).not.toHaveBeenCalled();
  });

  it("lets a co-admin withdraw someone else's request", async () => {
    const { deps, mocks } = buildDeps({
      request: buildRequest({ submittedById: OTHER_HUMAN_ID }),
    });

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.authz.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      placeId: PLACE_ID,
    });
    expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ to: "UNVERIFIED" }),
    );
  });

  it("refuses a stranger, and writes nothing", async () => {
    const { deps, mocks } = buildDeps({
      request: buildRequest({ submittedById: OTHER_HUMAN_ID }),
      manageAllowed: false,
    });

    await expect(
      withdrawPlaceVerification(deps, {
        actorHumanId: ACTOR_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow();

    expect(mocks.txSpy).not.toHaveBeenCalled();
    expect(mocks.verificationRequestsRepo.withdraw).not.toHaveBeenCalled();
    expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
  });

  // ── A withdrawn CLAIM takes its provisional ownership with it ─────────────

  const OWNERSHIP_ID = "77777777-7777-4777-8777-777777777777";
  function ownership(
    overrides: Partial<PlaceOwnershipRecord> = {},
  ): PlaceOwnershipRecord {
    return {
      id: OWNERSHIP_ID,
      placeId: PLACE_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      verified: false,
      reviewerHumanId: null,
      reviewedAt: null,
      revokedAt: null,
      proof: null,
      createdAt: BASE_DATE,
      updatedAt: BASE_DATE,
      ...overrides,
    } as PlaceOwnershipRecord;
  }
  const claimRequest = () =>
    buildRequest({
      source: "OWNERSHIP_CLAIM",
      orgId: null,
      claimantHumanId: ACTOR_ID,
      claimOwnerType: "HUMAN",
      claimOwnerId: ACTOR_ID,
      ownershipId: OWNERSHIP_ID,
    });

  it("withdrawing a claim soft-revokes its provisional ownership in the same tx, and audits it", async () => {
    const { deps, mocks } = buildDeps({
      request: claimRequest(),
      ownership: ownership(),
    });

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.placesRepo.revokeOwnership).toHaveBeenCalledWith({
      ownershipId: OWNERSHIP_ID,
      revokedAt: BASE_DATE,
    });
    expect(mocks.txSpy).toHaveBeenCalledTimes(1);
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "OWNERSHIP_CLAIM",
          revokedOwnershipId: OWNERSHIP_ID,
        }),
      }),
    );
  });

  it("never revokes a VERIFIED ownership behind a claim request", async () => {
    const { deps, mocks } = buildDeps({
      request: claimRequest(),
      ownership: ownership({ verified: true }),
    });

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.placesRepo.revokeOwnership).not.toHaveBeenCalled();
  });

  it("does not re-revoke an ownership a dispute transfer already revoked", async () => {
    const { deps, mocks } = buildDeps({
      request: claimRequest(),
      ownership: ownership({ revokedAt: BASE_DATE }),
    });

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.placesRepo.revokeOwnership).not.toHaveBeenCalled();
  });

  it("an ORG_SUBMISSION withdraw touches no ownership", async () => {
    const { deps, mocks } = buildDeps({ ownership: ownership() });

    await withdrawPlaceVerification(deps, {
      actorHumanId: ACTOR_ID,
      requestId: REQUEST_ID,
    });

    expect(mocks.placesRepo.getOwnershipById).not.toHaveBeenCalled();
    expect(mocks.placesRepo.revokeOwnership).not.toHaveBeenCalled();
  });

  it("a claim whose withdraw loses the request race revokes nothing", async () => {
    const { deps, mocks } = buildDeps({
      request: claimRequest(),
      ownership: ownership(),
      withdrawSucceeds: false,
    });

    await expect(
      withdrawPlaceVerification(deps, {
        actorHumanId: ACTOR_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_NOT_PENDING" });
    expect(mocks.placesRepo.revokeOwnership).not.toHaveBeenCalled();
  });
});
