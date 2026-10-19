import { describe, expect, it, vi } from "vitest";

import { confirmBookingHold } from "../confirm-booking-hold";
import { makeFakeIdempotency } from "../../booking-requests/__tests__/helpers";
import {
  ACT_A_ID,
  OUTSIDER_ID,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
  buildHoldTestContext,
} from "./hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// confirmBookingHold is RETIRED from the request flow (booking-the-night N4,
// FR-005). Its body lives on as `bookNightWithoutTerms`
// (book-night-without-terms.test.ts); this pins that the old entry point
// books nothing, for anyone, and that it still authorises first.
// ─────────────────────────────────────────────────────────────────────────────

const mintForHold = vi.fn();
vi.mock("../../booking-agreements/create-event-from-agreement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../booking-agreements/create-event-from-agreement")>()),
  createEventFromAgreementForHold: (...args: unknown[]) => mintForHold(...args),
}));

function buildDeps() {
  const ctx = buildHoldTestContext();
  const deps = {
    repos: ctx.repos,
    idempotency: makeFakeIdempotency(),
    clock: ctx.deps.clock,
    reportError: vi.fn(),
    authz: { canManagePlace: vi.fn(async () => ({ allowed: true })) },
  };
  return { ...ctx, deps };
}

describe("confirmBookingHold (retired, FR-005)", () => {
  it("refuses a request-linked hold with HOLD_CONFIRM_RETIRED — nothing confirmed, released, accepted, ledgered or minted", async () => {
    const ctx = buildDeps();
    const winner = ctx.seedHold(REQUEST_A);
    const competitor = ctx.seedHold(REQUEST_B);

    await expect(
      confirmBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id }),
    ).rejects.toMatchObject({
      code: "HOLD_CONFIRM_RETIRED",
      meta: { holdId: winner.id, bookingRequestId: REQUEST_A },
    });

    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("PENDING");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    expect(ctx.audit.log).not.toHaveBeenCalled();
    expect(mintForHold).not.toHaveBeenCalled();
  });

  it("still authorises first: the act and a stranger get the venue gate's refusal, not the retirement", async () => {
    const ctx = buildDeps();
    const hold = ctx.seedHold(REQUEST_A);

    await expect(
      confirmBookingHold(ctx.deps, { actorHumanId: ACT_A_ID, holdId: hold.id }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      confirmBookingHold(ctx.deps, { actorHumanId: OUTSIDER_ID, holdId: hold.id }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("an unknown hold is not found (no retirement leak)", async () => {
    const ctx = buildDeps();
    await expect(
      confirmBookingHold(ctx.deps, {
        actorHumanId: STAFF_ID,
        holdId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
      }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_NOT_FOUND" });
  });
});
