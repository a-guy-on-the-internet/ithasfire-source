import { describe, expect, it, vi } from "vitest";

import {
  MIDDLEWARE_STAFF_PROBE,
  createCaller,
  portHasStaffRole,
} from "./test-helpers";
import { placeReviewsRouter } from "../place-reviews";

// ---------------------------------------------------------------------------
// `placeReviews.recalculateStats` is platform-ADMIN only (review follow-up to
// docs/specs/2026-09-24/completed/venue-track-record-and-review-switch.spec.yaml).
// A plain `authedProcedure` let any signed-in account force up to 500 place
// recomputes per call. REAL router mounted at its production path
// (`placeReviews.*`, so the step-up 2FA allowlist is exercised too), REAL use
// case, fake repos. "The use case ran" is observed as the stale-place read,
// its first repo call.
// ---------------------------------------------------------------------------

const ACTOR = "11111111-1111-4111-8111-111111111111";

function setup(opts: { staff: boolean; secondFactor?: boolean }) {
  const listStalePlaceIds = vi.fn(async () => [] as string[]);
  // Answers as the authz port does: an ADMIN with no second factor enrolled
  // is refused with `secondFactorRequired`.
  const hasStaffRole = portHasStaffRole({
    held: opts.staff ? ["ADMIN"] : [],
    enrolled: opts.secondFactor ?? true,
  });
  const { caller } = createCaller(
    { placeReviews: placeReviewsRouter },
    {
      actorHumanId: ACTOR,
      authz: { hasStaffRole } as any,
      repos: {
        placeStats: { listStalePlaceIds },
      } as any,
    },
  );
  return { caller, listStalePlaceIds, hasStaffRole };
}

describe("placeReviews.recalculateStats — platform admin gate", () => {
  it("non-staff signed-in user → FORBIDDEN, and the use case never runs", async () => {
    const { caller, listStalePlaceIds, hasStaffRole } = setup({ staff: false });

    await expect(
      caller.placeReviews.recalculateStats({ batchSize: 500 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(listStalePlaceIds).not.toHaveBeenCalled();
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN"],
    });
  });

  it("platform admin → the use case runs with the requested batch size", async () => {
    const { caller, listStalePlaceIds } = setup({ staff: true });

    await expect(
      caller.placeReviews.recalculateStats({ batchSize: 7 }),
    ).resolves.toEqual({ placesProcessed: 0, placeIds: [], failedPlaceIds: [] });

    expect(listStalePlaceIds).toHaveBeenCalledWith(7);
  });

  it("platform admin WITHOUT an enrolled second factor → SECOND_FACTOR_REQUIRED, use case never runs", async () => {
    const { caller, listStalePlaceIds, hasStaffRole } = setup({
      staff: true,
      secondFactor: false,
    });

    await expect(
      caller.placeReviews.recalculateStats({}),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      meta: { appCode: "SECOND_FACTOR_REQUIRED" },
    });

    // The step-up middleware asked (the path is on its list) and stopped the
    // call before the router's own ADMIN check or the use case.
    expect(hasStaffRole).toHaveBeenCalledTimes(1);
    expect(hasStaffRole).toHaveBeenCalledWith(MIDDLEWARE_STAFF_PROBE(ACTOR));
    expect(listStalePlaceIds).not.toHaveBeenCalled();
  });
});
