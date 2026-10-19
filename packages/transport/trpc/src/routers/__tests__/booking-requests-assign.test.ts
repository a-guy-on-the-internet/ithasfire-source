import { describe, expect, it } from "vitest";

import {
  ASSIGNEE_ID,
  OUTSIDER_ID,
  REQUEST_A,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "@th/core/use-cases/booking-holds/__tests__/hold-test-context";

import { bookingRequestsRouter } from "../booking-requests";
import { createCaller } from "./test-helpers";

/**
 * Transport contract for `bookingRequests.assign` (booking-holds FR-015):
 * auth, actor injection, error mapping, and the output shape. Eligibility
 * and the ledger line are core's.
 */

function build(actorHumanId: string | null = STAFF_ID) {
  const harness = buildHoldTestContext();
  const { caller } = createCaller(bookingRequestsRouter, {
    repos: harness.repos,
    actorHumanId,
  });
  return { ...harness, caller };
}

describe("bookingRequestsRouter.assign", () => {
  it("requires an authed actor", async () => {
    const { caller } = build(null);
    await expect(
      caller.assign({ bookingRequestId: REQUEST_A, assigneeHumanId: STAFF_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("takes actorHumanId from ctx and rejects a client-supplied one", async () => {
    const { caller } = build();
    await expect(
      caller.assign({
        bookingRequestId: REQUEST_A,
        assigneeHumanId: STAFF_ID,
        actorHumanId: OUTSIDER_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("assigns (\"assign to me\") and clears, returning the previous assignee", async () => {
    const { caller, entries } = build();
    // Harness seeds ASSIGNEE_ID as the current assignee.
    const mine = await caller.assign({ bookingRequestId: REQUEST_A, assigneeHumanId: STAFF_ID });
    expect(mine).toEqual({
      bookingRequestId: REQUEST_A,
      assigneeHumanId: STAFF_ID,
      previousAssigneeHumanId: ASSIGNEE_ID,
    });
    const cleared = await caller.assign({ bookingRequestId: REQUEST_A, assigneeHumanId: null });
    expect(cleared).toEqual({
      bookingRequestId: REQUEST_A,
      assigneeHumanId: null,
      previousAssigneeHumanId: STAFF_ID,
    });
    expect(entries(REQUEST_A).map((e) => e.kind)).toEqual([
      "booking_request.assigned",
      "booking_request.assigned",
    ]);
  });

  it("maps an ineligible assignee to BAD_REQUEST and a VIEWER actor to FORBIDDEN", async () => {
    const { caller } = build();
    await expect(
      caller.assign({ bookingRequestId: REQUEST_A, assigneeHumanId: VIEWER_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const viewer = build(VIEWER_ID);
    await expect(
      viewer.caller.assign({ bookingRequestId: REQUEST_A, assigneeHumanId: STAFF_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
