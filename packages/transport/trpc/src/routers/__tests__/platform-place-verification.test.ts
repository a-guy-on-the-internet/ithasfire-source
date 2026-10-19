import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { platformRouter } from "../platform";
import { placesRouter } from "../places";
import * as placeUseCases from "@th/core/use-cases/places";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";

const staffAuthz = (allowed: boolean) => {
  const hasStaffRole = vi.fn(async () => ({ allowed }));
  return {
    authz: {
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(),
      canFinanceOrg: vi.fn(),
      hasStaffRole,
    } as any,
    hasStaffRole,
  };
};

/**
 * Asserts a call failed BECAUSE the input schema rejected an unknown key —
 * `BAD_REQUEST` carrying a zod `unrecognized_keys` issue naming that key.
 *
 * A bare `.rejects.toThrow()` would also pass if the key were silently
 * STRIPPED and the call then blew up further downstream on mock repos, which
 * is the opposite of what these tests exist to prove.
 */
async function expectStrictKeyRejection(
  promise: Promise<unknown>,
  key: string,
): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e as { code?: string; message?: string },
  );

  expect(err, `expected a rejection naming "${key}"`).not.toBeNull();
  expect(err?.code).toBe("BAD_REQUEST");
  expect(err?.message).toContain("unrecognized_keys");
  expect(err?.message).toContain(key);
}

/**
 * `platform.updatePlaceVerificationStatus` backs BOTH the staff "Verify"
 * button and the "Waive verification" action (FR-014). The waive path is the
 * same procedure with `reason: "WAIVED_DOCUMENT_REVIEW"`, so these tests pin
 * the transport contract that makes that safe: the role gate, and the
 * `authz` handoff the use case's staff bypass depends on.
 */
describe("platform.updatePlaceVerificationStatus", () => {
  it("rejects an unauthenticated caller", async () => {
    const { caller } = createCaller(
      {
        updatePlaceVerificationStatus:
          platformRouter.updatePlaceVerificationStatus,
      },
      { actorHumanId: null },
    );

    await expect(
      caller.updatePlaceVerificationStatus({
        placeId: PLACE_ID,
        verificationStatus: "VERIFIED",
        clientKey: "waive-key-12345678",
      }),
    ).rejects.toThrow("unauthorized");
  });

  it("rejects a non-staff caller with FORBIDDEN before the use case runs", async () => {
    const spy = vi.spyOn(placeUseCases, "updatePlaceVerificationStatus");
    const { authz } = staffAuthz(false);

    const { caller } = createCaller(
      {
        updatePlaceVerificationStatus:
          platformRouter.updatePlaceVerificationStatus,
      },
      { actorHumanId: ACTOR_ID, authz },
    );

    await expect(
      caller.updatePlaceVerificationStatus({
        placeId: PLACE_ID,
        verificationStatus: "VERIFIED",
        clientKey: "waive-key-12345678",
        reason: "WAIVED_DOCUMENT_REVIEW",
      }),
    ).rejects.toThrow(/forbidden|Staff access required/i);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("gates on ADMIN/REVIEWER — not the wider platform staff set", async () => {
    const spy = vi
      .spyOn(placeUseCases, "updatePlaceVerificationStatus")
      .mockResolvedValue({
        placeId: PLACE_ID,
        verificationStatus: "VERIFIED",
      });
    const { authz, hasStaffRole } = staffAuthz(true);

    const { caller } = createCaller(
      {
        updatePlaceVerificationStatus:
          platformRouter.updatePlaceVerificationStatus,
      },
      { actorHumanId: ACTOR_ID, authz },
    );

    await caller.updatePlaceVerificationStatus({
      placeId: PLACE_ID,
      verificationStatus: "VERIFIED",
      clientKey: "waive-key-12345678",
    });

    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "REVIEWER"],
    });
    spy.mockRestore();
  });

  it("forwards authz to the use case so the staff bypass actually applies", async () => {
    const spy = vi
      .spyOn(placeUseCases, "updatePlaceVerificationStatus")
      .mockResolvedValue({
        placeId: PLACE_ID,
        verificationStatus: "VERIFIED",
      });
    const { authz } = staffAuthz(true);

    const { caller } = createCaller(
      {
        updatePlaceVerificationStatus:
          platformRouter.updatePlaceVerificationStatus,
      },
      { actorHumanId: ACTOR_ID, authz },
    );

    await caller.updatePlaceVerificationStatus({
      placeId: PLACE_ID,
      verificationStatus: "VERIFIED",
      clientKey: "waive-key-12345678",
    });

    // Regression guard: this dep was missing, which silently pushed every
    // platform staff call down the org-membership branch.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ authz }),
      expect.anything(),
    );
    spy.mockRestore();
  });

  it("injects the actor id and forwards reason + note for the waive path", async () => {
    const spy = vi
      .spyOn(placeUseCases, "updatePlaceVerificationStatus")
      .mockResolvedValue({
        placeId: PLACE_ID,
        verificationStatus: "VERIFIED",
      });
    const { authz } = staffAuthz(true);

    const { caller } = createCaller(
      {
        updatePlaceVerificationStatus:
          platformRouter.updatePlaceVerificationStatus,
      },
      { actorHumanId: ACTOR_ID, authz },
    );

    await caller.updatePlaceVerificationStatus({
      placeId: PLACE_ID,
      verificationStatus: "VERIFIED",
      clientKey: "waive-key-12345678",
      reason: "WAIVED_DOCUMENT_REVIEW",
      note: "Owner confirmed on a call with ops",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        placeId: PLACE_ID,
        verificationStatus: "VERIFIED",
        reason: "WAIVED_DOCUMENT_REVIEW",
        note: "Owner confirmed on a call with ops",
      }),
    );
    spy.mockRestore();
  });

  it("refuses a client-supplied actorHumanId (strict input)", async () => {
    const { authz } = staffAuthz(true);
    const { caller } = createCaller(
      {
        updatePlaceVerificationStatus:
          platformRouter.updatePlaceVerificationStatus,
      },
      { actorHumanId: ACTOR_ID, authz },
    );

    await expectStrictKeyRejection(
      caller.updatePlaceVerificationStatus({
        placeId: PLACE_ID,
        verificationStatus: "VERIFIED",
        clientKey: "waive-key-12345678",
        actorHumanId: "99999999-9999-4999-8999-999999999999",
      } as never),
      "actorHumanId",
    );
  });
});

/**
 * The org-side sibling `places.updatePlaceVerificationStatus` was DELETED as a
 * privilege-escalation hole: it forwarded any authenticated caller into the
 * use case, whose org-governance fallback clears any ORG_ADMIN_ROLES member of
 * an owning org — so an org owner could POST
 * `{ verificationStatus: "VERIFIED" }` and mint their own verified badge with
 * no document reviewed. Living under `places.*` it ALSO sidestepped guard.ts's
 * staff second-factor gate (which covers `platform.*` wholesale).
 *
 * These tests pin the removal structurally, so re-adding the procedure trips
 * a test rather than silently reopening the hole. The use case ALSO refuses
 * terminal decisions from non-staff actors now
 * (`update-place-verification-status.test.ts`) — belt and braces, because the
 * transport shape is the weaker of the two guarantees.
 */
describe("places.updatePlaceVerificationStatus (org-side) is REMOVED", () => {
  it("no longer exists on the places router", () => {
    expect(placesRouter).not.toHaveProperty("updatePlaceVerificationStatus");
  });

  it("leaves no other org-side procedure that writes a verification STATUS", () => {
    // Verification-adjacent procedures that legitimately remain on `places.*`.
    // `submitPlaceVerification` / `withdrawPlaceVerification` are the org-side
    // submit + withdraw flows; the rest are staff-only (and now second-factor
    // gated, see guard.ts). None of them is a free-form status write.
    const verificationProcedures = Object.keys(placesRouter).filter((k) =>
      /erification/.test(k),
    );

    expect(verificationProcedures.sort()).toEqual([
      "acknowledgePlaceVerification",
      "getPlatformVerificationQueue",
      "getVerificationDocumentUrl",
      "releasePlaceVerification",
      "requestVerificationDocUpload",
      "reviewPlaceVerification",
      "submitPlaceVerification",
      "withdrawPlaceVerification",
    ]);
  });

  it("keeps the staff route as the only transport into the use case", () => {
    // The core function is still exported and still used — by `platform.*`,
    // which pre-checks ADMIN/REVIEWER and inherits the wholesale 2FA gate.
    expect(placeUseCases.updatePlaceVerificationStatus).toBeTypeOf("function");
    expect(platformRouter).toHaveProperty("updatePlaceVerificationStatus");
  });
});
