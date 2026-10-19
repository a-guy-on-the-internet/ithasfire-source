import { describe, expect, it, vi } from "vitest";

import { updatePlaceVerificationStatus } from "../update-place-verification-status";
import type {
  UpdatePlaceVerificationStatusDeps,
  UpdatePlaceVerificationStatusInput,
} from "../update-place-verification-status";

import type { PlaceRecord } from "@th/ports/repos/places";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { Repos, TxRepos } from "@th/ports/repos";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";

function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: overrides.id ?? DEFAULT_PLACE_ID,
    name: overrides.name ?? "Test Place",
    slug: "test-place",
    formattedAddress: overrides.formattedAddress ?? "123 Main St",
    addressLine1: overrides.addressLine1 ?? "123 Main St",
    addressLine2: overrides.addressLine2 ?? null,
    city: overrides.city ?? "City",
    region: overrides.region ?? "ST",
    postalCode: overrides.postalCode ?? "12345",
    countryCode: overrides.countryCode ?? "US",
    capacity: overrides.capacity ?? 1000,
    lat: overrides.lat ?? 37.123,
    lng: overrides.lng ?? -122.123,
    status: overrides.status ?? "ACTIVE",
    verificationStatus: overrides.verificationStatus ?? "UNVERIFIED",
    orgIdsWithAccess: overrides.orgIdsWithAccess ?? [DEFAULT_ORG_ID],
    humanIdsWithAccess: overrides.humanIdsWithAccess ?? [],
  } satisfies PlaceRecord;
}

type BuildDepsOptions = {
  existingPlace?: PlaceRecord | null;
  membership?: OrgMembership | null;
  /**
   * Status of an open PlaceVerificationRequest for this place, or null for
   * "no open request" (the default). Drives the orphaned-request guard.
   */
  openRequestStatus?: "PENDING" | "IN_REVIEW" | null;
  /** Verification status the row holds when the tx writes (a race). */
  storedStatus?: PlaceRecord["verificationStatus"];
  /** Open request seen only INSIDE the tx (filed after the pre-check). */
  openRequestInTx?: "PENDING" | "IN_REVIEW";
  /** Open OWNERSHIP_CLAIM (`getActiveClaimForPlace`), before the tx. */
  openClaimStatus?: "PENDING" | "IN_REVIEW" | null;
  /** Open OWNERSHIP_CLAIM seen only INSIDE the tx (filed after the pre-check). */
  openClaimInTx?: "PENDING" | "IN_REVIEW";
};

function buildDeps(options: BuildDepsOptions = {}) {
  const existingPlace = Object.prototype.hasOwnProperty.call(
    options,
    "existingPlace",
  )
    ? (options.existingPlace ?? null)
    : buildPlaceRecord();

  const placesRepo = {
    getById: vi.fn(async () => existingPlace),
    upsert: vi.fn(),
    // The adapter's compare-and-set: writes `to` only while the stored
    // status is `from`. `storedStatus` is what the row holds at write time.
    setVerificationStatus: vi.fn(
      async (input: {
        placeId: string;
        from: PlaceRecord["verificationStatus"];
        to: PlaceRecord["verificationStatus"];
      }) => {
        if (!existingPlace) return { changed: false };
        const stored =
          options.storedStatus ?? existingPlace.verificationStatus;
        return { changed: stored === input.from };
      },
    ),
    lockPlaceForClaim: vi.fn(async () => undefined),
    listAccessibleByHuman: vi.fn(async () => ({
      items: [],
      pageInfo: {
        total: 0,
        count: 0,
        limit: 20,
        offset: 0,
        hasNextPage: false,
        nextOffset: null,
      },
    })),
  };

  const membershipValue = Object.prototype.hasOwnProperty.call(
    options,
    "membership",
  )
    ? (options.membership ?? null)
    : ({
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "ADMIN",
      } satisfies OrgMembership);

  const authzRepo = {
    getOrgMemberships: vi.fn(async () =>
      membershipValue ? [membershipValue] : [],
    ),
    getStaffRolesForHumanId: vi.fn(async () => []),
    getEventOrgId: vi.fn(),
    getPlaceAccessContext: vi.fn(),
    isPlaceVerifiedForOrg: vi.fn(),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const openRequestStatus = options.openRequestStatus ?? null;
  const openClaimStatus = options.openClaimStatus ?? null;
  const verificationRequestsRepo = {
    getActiveForPlace: vi.fn(async () =>
      openRequestStatus
        ? { id: "req-1", placeId: DEFAULT_PLACE_ID, status: openRequestStatus }
        : null,
    ),
    getActiveClaimForPlace: vi.fn(async () =>
      openClaimStatus
        ? {
            id: "claim-1",
            placeId: DEFAULT_PLACE_ID,
            source: "OWNERSHIP_CLAIM",
            status: openClaimStatus,
          }
        : null,
    ),
  };

  const txVerificationRequestsRepo = {
    getActiveForPlace: vi.fn(async () => {
      const status = options.openRequestInTx ?? openRequestStatus;
      return status
        ? { id: "req-1", placeId: DEFAULT_PLACE_ID, status }
        : null;
    }),
    getActiveClaimForPlace: vi.fn(async () => {
      const status = options.openClaimInTx ?? openClaimStatus;
      return status
        ? {
            id: "claim-1",
            placeId: DEFAULT_PLACE_ID,
            source: "OWNERSHIP_CLAIM",
            status,
          }
        : null;
    }),
  };

  const searchReindexPending = { mark: vi.fn(async () => undefined) };

  const txRepos = {
    places: placesRepo,
    audit: auditRepo,
    placeVerificationRequests: txVerificationRequestsRepo,
    searchReindexPending,
  } as unknown as TxRepos;

  const repos = {
    places: placesRepo,
    authz: authzRepo,
    audit: auditRepo,
    placeVerificationRequests: verificationRequestsRepo,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const idempotency = createFakeIdempotencyPort();
  const clock = { now: vi.fn(() => BASE_DATE) };
  const logger = createTestLogger();

  const deps: UpdatePlaceVerificationStatusDeps = {
    repos,
    idempotency,
    clock,
    logger,
  };

  return {
    deps,
    mocks: {
      placesRepo,
      authzRepo,
      auditRepo,
      verificationRequestsRepo,
      txVerificationRequestsRepo,
      searchReindexPending,
    },
  };
}

function makeInput(
  overrides: Partial<UpdatePlaceVerificationStatusInput> = {},
): UpdatePlaceVerificationStatusInput {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    placeId: DEFAULT_PLACE_ID,
    verificationStatus: "VERIFIED",
    clientKey: "place-verify-key-123456",
    ...overrides,
  } satisfies UpdatePlaceVerificationStatusInput;
}

describe("updatePlaceVerificationStatus", () => {
  // ── Privilege escalation: org admin self-issuing a verified badge ─────
  //
  // Regression pin for the hole this file used to encode as intended
  // behaviour ("updates verification status when actor is org ADMIN"). An
  // ORG_ADMIN_ROLES member of an owning org clears
  // `ensureActorIsPrivilegedForPlace` — that gate only answers "may you touch
  // verification at all", which is right for submit/reset and wrong for a
  // terminal decision. `Place.verification === "VERIFIED"` gates directory
  // visibility and is the precondition for enabling booking, so reaching it
  // without staff review is a trust mint.
  //
  // Asserted at the USE CASE, not the transport: the org-side tRPC procedure
  // that used to reach this path is deleted, but the invariant must hold for
  // any future transport.
  describe("terminal decisions are staff-only (privilege escalation)", () => {
    const nonStaffOrgAdminDeps = (
      verificationStatus: PlaceRecord["verificationStatus"] = "UNVERIFIED",
    ) => {
      const built = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus }),
        // Default membership is org ADMIN of the owning org.
      });
      built.deps.authz = {
        hasStaffRole: vi.fn(async () => ({ allowed: false })),
      };
      return built;
    };

    it("REFUSES VERIFIED for a non-staff org ADMIN — nothing written", async () => {
      const { deps, mocks } = nonStaffOrgAdminDeps();

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({ verificationStatus: "VERIFIED" }),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

      // Nothing was written — no place upsert, no audit row, no transaction.
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      expect(deps.repos.tx).not.toHaveBeenCalled();
    });

    it("REFUSES REJECTED for a non-staff org ADMIN — nothing written", async () => {
      const { deps, mocks } = nonStaffOrgAdminDeps();

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({ verificationStatus: "REJECTED" }),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      expect(deps.repos.tx).not.toHaveBeenCalled();
    });

    it("REFUSES VERIFIED for a non-staff org OWNER too, not just ADMIN", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: {
          orgId: DEFAULT_ORG_ID,
          humanId: DEFAULT_ACTOR_ID,
          role: "OWNER",
        },
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: false })) };

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({ verificationStatus: "VERIFIED" }),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("REFUSES VERIFIED when no authz port is wired at all (fails closed)", async () => {
      // A composition root that forgets `authz` must NOT get an implicitly
      // trusted actor. `deps.authz` is left undefined here on purpose.
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
      });

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({ verificationStatus: "VERIFIED" }),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("REFUSES a non-staff org ADMIN escalating an already-REJECTED place", async () => {
      const { deps, mocks } = nonStaffOrgAdminDeps("REJECTED");

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({ verificationStatus: "VERIFIED" }),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("STILL ALLOWS the org-side submit (PENDING) for a non-staff org ADMIN", async () => {
      const { deps, mocks } = nonStaffOrgAdminDeps();

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "PENDING" }),
      );

      expect(result.verificationStatus).toBe("PENDING");
      expect(mocks.auditRepo.log).toHaveBeenCalledTimes(1);
    });

    it("STILL ALLOWS the org-side reset (UNVERIFIED) for a non-staff org ADMIN", async () => {
      const { deps, mocks } = nonStaffOrgAdminDeps("PENDING");

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "UNVERIFIED" }),
      );

      expect(result.verificationStatus).toBe("UNVERIFIED");
      expect(mocks.auditRepo.log).toHaveBeenCalledTimes(1);
    });

    it("stays a no-op (not an error) when the place is ALREADY VERIFIED", async () => {
      // Re-asserting existing state writes nothing and escalates nothing, so
      // the guard sits after the unchanged-status early return.
      const { deps, mocks } = nonStaffOrgAdminDeps("VERIFIED");

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      );

      expect(result.verificationStatus).toBe("VERIFIED");
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("still lets ADMIN/REVIEWER staff reach VERIFIED", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      );

      expect(result.verificationStatus).toBe("VERIFIED");
      expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          placeId: DEFAULT_PLACE_ID,
          to: "VERIFIED",
        }),
      );
      expect(mocks.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "verification_status_updated" }),
      );
    });

    it("writes only the verification column, never the row read before the transaction", async () => {
      // The place is read before `repos.tx`. Rebuilding the whole row from
      // that read (the old `places.upsert`) overwrote a moderator's
      // concurrent name/address/pin edit; the narrow write carries nothing
      // else.
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      );

      expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
      expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith({
        placeId: DEFAULT_PLACE_ID,
        from: "UNVERIFIED",
        to: "VERIFIED",
      });
    });

    it("race: the status moved after the read: CONFLICT, no audit, no false `from`", async () => {
      // Read says UNVERIFIED; another staff write moved it to REJECTED
      // before this tx. The CAS on `from` misses, so nothing is written and
      // no audit row claims "UNVERIFIED -> VERIFIED".
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
        storedStatus: "REJECTED",
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      // Re-read under the lock (second getById) sees REJECTED.
      mocks.placesRepo.getById
        .mockResolvedValueOnce(
          buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        )
        .mockResolvedValueOnce(
          buildPlaceRecord({ verificationStatus: "REJECTED" }),
        );

      const err = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "CONFLICT" });
      // No custom message: the wire message is the code, so the web
      // resolves `errors.conflict` instead of the generic fallback.
      expect((err as Error).message).toBe("CONFLICT");
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
    });

    it("race: the status moved to the target already: success, no audit, no mark", async () => {
      // Another staff write set VERIFIED between the read and this tx. That
      // is the outcome this call asked for: the normal success result, and
      // no audit row claiming this call made the change.
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
        storedStatus: "VERIFIED",
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };
      mocks.placesRepo.getById
        .mockResolvedValueOnce(
          buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        )
        .mockResolvedValueOnce(
          buildPlaceRecord({ verificationStatus: "VERIFIED" }),
        );

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      );

      expect(result).toEqual({
        placeId: DEFAULT_PLACE_ID,
        verificationStatus: "VERIFIED",
      });
      expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledTimes(1);
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
    });

    it("a normal flip marks the place for search once", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      );

      expect(mocks.searchReindexPending.mark).toHaveBeenCalledTimes(1);
    });

    it("race: a request filed after the pre-check is caught under the claim lock", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
        openRequestInTx: "PENDING",
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({ verificationStatus: "VERIFIED" }),
        ),
      ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_IN_PROGRESS" });
      expect(mocks.placesRepo.lockPlaceForClaim).toHaveBeenCalledWith(
        DEFAULT_PLACE_ID,
      );
      // The lock is taken before the in-tx re-check.
      expect(
        mocks.placesRepo.lockPlaceForClaim.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.txVerificationRequestsRepo.getActiveForPlace.mock
          .invocationCallOrder[0]!,
      );
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("resolves staff-ness with a SINGLE authz round trip", async () => {
      // The staff answer feeds three decisions (privilege gate, PENDING
      // eligibility bypass, terminal-decision gate). Pinning one call keeps
      // them from drifting apart into inconsistent answers.
      const hasStaffRole = vi.fn(async () => ({ allowed: true }));
      const { deps } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole };

      await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "PENDING" }),
      );

      expect(hasStaffRole).toHaveBeenCalledTimes(1);
      expect(hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: DEFAULT_ACTOR_ID,
        requiredRoles: ["ADMIN", "REVIEWER"],
      });
    });
  });

  it("rejects if place has no org owner (no org-based governance)", async () => {
    const { deps } = buildDeps({
      existingPlace: buildPlaceRecord({
        orgIdsWithAccess: [],
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      }),
    });

    await expect(
      updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_REQUIRES_ORG_OWNER" });
  });

  it("rejects if actor is not OWNER/ADMIN in any owning org", async () => {
    const { deps } = buildDeps({
      membership: {
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "EDITOR",
      },
    });

    await expect(
      updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("is idempotent for identical payloads", async () => {
    const { deps, mocks } = buildDeps({
      existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
    });

    const input = makeInput({ verificationStatus: "PENDING" });
    const first = await updatePlaceVerificationStatus(deps, input);
    const second = await updatePlaceVerificationStatus(deps, input);

    expect(first).toEqual(second);
    expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when verification status is unchanged", async () => {
    const { deps, mocks } = buildDeps({
      existingPlace: buildPlaceRecord({ verificationStatus: "VERIFIED" }),
    });

    const result = await updatePlaceVerificationStatus(
      deps,
      makeInput({ verificationStatus: "VERIFIED" }),
    );

    expect(result).toEqual({
      placeId: DEFAULT_PLACE_ID,
      verificationStatus: "VERIFIED",
    });
    expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("allows staff with REVIEWER role to verify a place without org membership", async () => {
    const { deps, mocks } = buildDeps({
      existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
      membership: null,
    });

    // Add authz with staff fallback
    deps.authz = {
      hasStaffRole: vi.fn(async () => ({ allowed: true })),
    };

    const result = await updatePlaceVerificationStatus(
      deps,
      makeInput({ verificationStatus: "VERIFIED" }),
    );

    expect(result).toEqual({
      placeId: DEFAULT_PLACE_ID,
      verificationStatus: "VERIFIED",
    });
    expect(deps.authz.hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: DEFAULT_ACTOR_ID,
        requiredRoles: ["ADMIN", "REVIEWER"],
      }),
    );
  });

  it("falls through to org check when staff role check fails", async () => {
    const { deps } = buildDeps({
      existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
      membership: null,
    });

    // Staff check returns not allowed, and org membership is null → should fail
    deps.authz = {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    };

    await expect(
      updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects PENDING when place has incomplete data (non-staff)", async () => {
    const { deps } = buildDeps({
      existingPlace: buildPlaceRecord({
        verificationStatus: "UNVERIFIED",
        name: "New Place",
        addressLine1: "TBD",
        city: null,
      }),
    });

    await expect(
      updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "PENDING" }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "place_not_eligible_for_verification",
    });
  });

  it("allows PENDING for a complete place (non-staff)", async () => {
    const { deps } = buildDeps({
      existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
    });

    const result = await updatePlaceVerificationStatus(
      deps,
      makeInput({ verificationStatus: "PENDING" }),
    );

    expect(result.verificationStatus).toBe("PENDING");
  });

  // ── Waive verification (FR-014) ──────────────────────────────────────
  //
  // "Waive" is not a separate use case: the platform action sends
  // reason: "WAIVED_DOCUMENT_REVIEW" through THIS path so it inherits the
  // same staff gate, the same transaction, and the same audit write
  // (NFR-004). These tests pin exactly that.
  describe("waive verification (reason: WAIVED_DOCUMENT_REVIEW)", () => {
    it("REJECTS a non-staff actor with no org access — the gate is server-side", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: false })) };

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({
            verificationStatus: "VERIFIED",
            reason: "WAIVED_DOCUMENT_REVIEW",
            note: "confirmed by phone",
          }),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

      // Nothing was written — not the place, not the audit row.
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("REJECTS a non-staff actor who is only an org EDITOR", async () => {
      const { deps, mocks } = buildDeps({
        membership: {
          orgId: DEFAULT_ORG_ID,
          humanId: DEFAULT_ACTOR_ID,
          role: "EDITOR",
        },
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: false })) };

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({
            verificationStatus: "VERIFIED",
            reason: "WAIVED_DOCUMENT_REVIEW",
          }),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("checks the staff gate against ADMIN/REVIEWER only", async () => {
      const { deps } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      const hasStaffRole = vi.fn(async () => ({ allowed: true }));
      deps.authz = { hasStaffRole };

      await updatePlaceVerificationStatus(
        deps,
        makeInput({
          verificationStatus: "VERIFIED",
          reason: "WAIVED_DOCUMENT_REVIEW",
        }),
      );

      expect(hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: DEFAULT_ACTOR_ID,
        requiredRoles: ["ADMIN", "REVIEWER"],
      });
    });

    it("transitions UNVERIFIED → VERIFIED and audit-logs the reason + note", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({
          verificationStatus: "VERIFIED",
          reason: "WAIVED_DOCUMENT_REVIEW",
          note: "Owner confirmed on a call with ops",
        }),
      );

      expect(result).toEqual({
        placeId: DEFAULT_PLACE_ID,
        verificationStatus: "VERIFIED",
      });
      expect(mocks.placesRepo.setVerificationStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          placeId: DEFAULT_PLACE_ID,
          to: "VERIFIED",
        }),
      );
      expect(mocks.auditRepo.log).toHaveBeenCalledTimes(1);
      expect(mocks.auditRepo.log).toHaveBeenCalledWith({
        entity: "place",
        entityId: DEFAULT_PLACE_ID,
        action: "verification_status_updated",
        data: {
          actorHumanId: DEFAULT_ACTOR_ID,
          from: "UNVERIFIED",
          to: "VERIFIED",
          reason: "WAIVED_DOCUMENT_REVIEW",
          note: "Owner confirmed on a call with ops",
        },
        at: BASE_DATE,
      });
      // Audit write happened inside the same tx as the place write.
      expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    });

    it("also works from REJECTED (override) and records the reason", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "REJECTED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({
          verificationStatus: "VERIFIED",
          reason: "WAIVED_DOCUMENT_REVIEW",
        }),
      );

      expect(result.verificationStatus).toBe("VERIFIED");
      expect(mocks.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            from: "REJECTED",
            to: "VERIFIED",
            reason: "WAIVED_DOCUMENT_REVIEW",
          }),
        }),
      );
    });

    it("sanitizes the note before it reaches the audit row", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      await updatePlaceVerificationStatus(
        deps,
        makeInput({
          verificationStatus: "VERIFIED",
          reason: "WAIVED_DOCUMENT_REVIEW",
          note: "<img src=x onerror=alert(1)>called   the\nowner",
        }),
      );

      const auditCall = mocks.auditRepo.log.mock.calls[0]?.[0] as {
        data: { note?: string };
      };
      expect(auditCall.data.note).toBe("called the owner");
      expect(auditCall.data.note).not.toContain("<");
      expect(auditCall.data.note).not.toContain("onerror");
    });

    it("omits reason/note from the audit payload when the caller sends neither", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      );

      expect(mocks.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            actorHumanId: DEFAULT_ACTOR_ID,
            from: "UNVERIFIED",
            to: "VERIFIED",
          },
        }),
      );
    });

    it("drops an all-markup note rather than storing an empty string", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      await updatePlaceVerificationStatus(
        deps,
        makeInput({
          verificationStatus: "VERIFIED",
          reason: "WAIVED_DOCUMENT_REVIEW",
          note: "<b></b>   ",
        }),
      );

      const auditCall = mocks.auditRepo.log.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(auditCall.data).not.toHaveProperty("note");
      expect(auditCall.data.reason).toBe("WAIVED_DOCUMENT_REVIEW");
    });

    it("rejects a note longer than the 280-char bound", async () => {
      const { deps } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({
            verificationStatus: "VERIFIED",
            reason: "WAIVED_DOCUMENT_REVIEW",
            note: "x".repeat(281),
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("rejects an unknown reason value", async () => {
      const { deps } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      await expect(
        updatePlaceVerificationStatus(deps, {
          ...makeInput({ verificationStatus: "VERIFIED" }),
          reason: "TOTALLY_MADE_UP",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("replays idempotently and only writes one audit row", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      const input = makeInput({
        verificationStatus: "VERIFIED",
        reason: "WAIVED_DOCUMENT_REVIEW",
        note: "double click",
      });
      const first = await updatePlaceVerificationStatus(deps, input);
      const second = await updatePlaceVerificationStatus(deps, input);

      expect(first).toEqual(second);
      expect(mocks.auditRepo.log).toHaveBeenCalledTimes(1);
    });

    it("conflicts when the same client key is reused with a different reason", async () => {
      const { deps } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        membership: null,
      });
      deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };

      await updatePlaceVerificationStatus(
        deps,
        makeInput({
          verificationStatus: "VERIFIED",
          reason: "WAIVED_DOCUMENT_REVIEW",
        }),
      );

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({
            verificationStatus: "VERIFIED",
            reason: "STAFF_DIRECT",
          }),
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    });
  });

  // ── Orphaned-request guard ───────────────────────────────────────────
  //
  // This use case flips Place.verification and nothing else. Letting it reach
  // a TERMINAL state while a request is still open leaves that request in the
  // platform queue, where the next reviewer's Approve/Reject silently
  // overwrites the decision made here (reverting a waive) or grants verified
  // ownership + a directory listing on unread documents.
  describe("an open OWNERSHIP_CLAIM blocks a direct terminal decision, exactly like an org submission", () => {
    // `getActiveForPlace` returns ORG_SUBMISSION rows only. Without the claim
    // check, staff could set VERIFIED under a pending claim, and rejecting
    // the claim afterwards demoted the staff-verified place.
    const claimDeps = (
      opts: Pick<BuildDepsOptions, "openClaimStatus" | "openClaimInTx">,
    ) => {
      const built = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "PENDING" }),
        membership: null,
        ...opts,
      });
      built.deps.authz = {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      };
      return built;
    };

    for (const status of ["PENDING", "IN_REVIEW"] as const) {
      for (const to of ["VERIFIED", "REJECTED"] as const) {
        it(`refuses ${to} while a ${status} claim is open — nothing written`, async () => {
          const { deps, mocks } = claimDeps({ openClaimStatus: status });

          await expect(
            updatePlaceVerificationStatus(
              deps,
              makeInput({ verificationStatus: to }),
            ),
          ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_IN_PROGRESS" });
          expect(
            mocks.verificationRequestsRepo.getActiveClaimForPlace,
          ).toHaveBeenCalledWith(DEFAULT_PLACE_ID);
          expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
          expect(mocks.auditRepo.log).not.toHaveBeenCalled();
          expect(deps.repos.tx).not.toHaveBeenCalled();
        });
      }
    }

    it("re-checks claims under the claim lock: one filed after the pre-check is refused", async () => {
      const { deps, mocks } = claimDeps({ openClaimInTx: "PENDING" });

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({ verificationStatus: "VERIFIED" }),
        ),
      ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_IN_PROGRESS" });
      expect(
        mocks.placesRepo.lockPlaceForClaim.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.txVerificationRequestsRepo.getActiveClaimForPlace.mock
          .invocationCallOrder[0]!,
      );
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
    });

    it("does NOT block a reset to UNVERIFIED under an open claim", async () => {
      const { deps, mocks } = claimDeps({ openClaimStatus: "PENDING" });

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "UNVERIFIED" }),
      );

      expect(result.verificationStatus).toBe("UNVERIFIED");
      expect(
        mocks.verificationRequestsRepo.getActiveClaimForPlace,
      ).not.toHaveBeenCalled();
    });
  });

  describe("open verification request blocks a direct terminal decision", () => {
    const staffDeps = (
      openRequestStatus: "PENDING" | "IN_REVIEW" | null,
      verificationStatus: PlaceRecord["verificationStatus"] = "UNVERIFIED",
    ) => {
      const built = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus }),
        membership: null,
        openRequestStatus,
      });
      built.deps.authz = {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      };
      return built;
    };

    it("REJECTS a waive while a PENDING request is open — nothing written", async () => {
      const { deps, mocks } = staffDeps("PENDING");

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({
            verificationStatus: "VERIFIED",
            reason: "WAIVED_DOCUMENT_REVIEW",
            note: "confirmed by phone",
          }),
        ),
      ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_IN_PROGRESS" });

      expect(
        mocks.verificationRequestsRepo.getActiveForPlace,
      ).toHaveBeenCalledWith(DEFAULT_PLACE_ID);
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      expect(deps.repos.tx).not.toHaveBeenCalled();
    });

    it("REJECTS a waive while an IN_REVIEW request is open — nothing written", async () => {
      const { deps, mocks } = staffDeps("IN_REVIEW");

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({
            verificationStatus: "VERIFIED",
            reason: "WAIVED_DOCUMENT_REVIEW",
          }),
        ),
      ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_IN_PROGRESS" });

      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("REJECTS the plain staff Verify path too, not just the waive", async () => {
      const { deps, mocks } = staffDeps("PENDING");

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({ verificationStatus: "VERIFIED" }),
        ),
      ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_IN_PROGRESS" });
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("REJECTS a direct REJECTED decision while a request is open", async () => {
      const { deps, mocks } = staffDeps("PENDING");

      await expect(
        updatePlaceVerificationStatus(
          deps,
          makeInput({ verificationStatus: "REJECTED" }),
        ),
      ).rejects.toMatchObject({ code: "VERIFICATION_REQUEST_IN_PROGRESS" });
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("ALLOWS a waive on UNVERIFIED with no open request", async () => {
      const { deps, mocks } = staffDeps(null, "UNVERIFIED");

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({
          verificationStatus: "VERIFIED",
          reason: "WAIVED_DOCUMENT_REVIEW",
        }),
      );

      expect(result.verificationStatus).toBe("VERIFIED");
      expect(mocks.auditRepo.log).toHaveBeenCalledTimes(1);
    });

    it("ALLOWS a waive on REJECTED with no open request", async () => {
      const { deps, mocks } = staffDeps(null, "REJECTED");

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({
          verificationStatus: "VERIFIED",
          reason: "WAIVED_DOCUMENT_REVIEW",
        }),
      );

      expect(result.verificationStatus).toBe("VERIFIED");
      expect(mocks.auditRepo.log).toHaveBeenCalledTimes(1);
    });

    it("does NOT block the org-side submit path (target PENDING)", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
        openRequestStatus: "PENDING",
      });

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "PENDING" }),
      );

      expect(result.verificationStatus).toBe("PENDING");
      // Never consulted — the guard is scoped to terminal decisions.
      expect(
        mocks.verificationRequestsRepo.getActiveForPlace,
      ).not.toHaveBeenCalled();
    });

    it("does NOT block a reset to UNVERIFIED", async () => {
      const { deps, mocks } = staffDeps("PENDING", "VERIFIED");

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "UNVERIFIED" }),
      );

      expect(result.verificationStatus).toBe("UNVERIFIED");
      expect(
        mocks.verificationRequestsRepo.getActiveForPlace,
      ).not.toHaveBeenCalled();
    });

    it("stays a clean no-op when the status already matches, even with an open request", async () => {
      const { deps, mocks } = staffDeps("PENDING", "VERIFIED");

      const result = await updatePlaceVerificationStatus(
        deps,
        makeInput({ verificationStatus: "VERIFIED" }),
      );

      expect(result.verificationStatus).toBe("VERIFIED");
      expect(mocks.placesRepo.setVerificationStatus).not.toHaveBeenCalled();
      expect(
        mocks.verificationRequestsRepo.getActiveForPlace,
      ).not.toHaveBeenCalled();
    });
  });

  it("staff can set PENDING even on an incomplete place", async () => {
    const { deps } = buildDeps({
      existingPlace: buildPlaceRecord({
        verificationStatus: "UNVERIFIED",
        name: "New Place",
        addressLine1: null,
        city: null,
      }),
      membership: null,
    });

    deps.authz = {
      hasStaffRole: vi.fn(async () => ({ allowed: true })),
    };

    const result = await updatePlaceVerificationStatus(
      deps,
      makeInput({ verificationStatus: "PENDING" }),
    );

    expect(result.verificationStatus).toBe("PENDING");
  });
});
