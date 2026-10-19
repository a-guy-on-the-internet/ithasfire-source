import { describe, expect, it } from "vitest";

import { assignBookingRequest } from "../assign-booking-request";
import { postBookingRequestMessage } from "../messages/post-message";
import {
  ASSIGNEE_ID,
  OUTSIDER_ID,
  REQUEST_A,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "../../booking-holds/__tests__/hold-test-context";
import { buildOrganizerBookingRequestRecord } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// FR-015 — assignment + the first-staff-message auto-assign.
// ─────────────────────────────────────────────────────────────────────────────

describe("assignBookingRequest", () => {
  it("sets the assignee, writes booking_request.assigned with the previous value, audits", async () => {
    const ctx = buildHoldTestContext();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, assigneeHumanId: null });

    const result = await assignBookingRequest(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      assigneeHumanId: ASSIGNEE_ID,
    });

    expect(result).toEqual({ bookingRequestId: REQUEST_A, assigneeHumanId: ASSIGNEE_ID, previousAssigneeHumanId: null });
    expect(ctx.requests.get(REQUEST_A)?.assigneeHumanId).toBe(ASSIGNEE_ID);
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_request.assigned", data: { assigneeHumanId: ASSIGNEE_ID, previousAssigneeHumanId: null }, actor: STAFF_ID },
    ]);

    // Clear.
    const cleared = await assignBookingRequest(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, assigneeHumanId: null });
    expect(cleared).toEqual({ bookingRequestId: REQUEST_A, assigneeHumanId: null, previousAssigneeHumanId: ASSIGNEE_ID });
  });

  it("is idempotent: the same assignee writes nothing", async () => {
    const ctx = buildHoldTestContext();
    const result = await assignBookingRequest(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, assigneeHumanId: ASSIGNEE_ID });
    expect(result.assigneeHumanId).toBe(ASSIGNEE_ID);
    expect(ctx.bookingRequests.setAssignee).not.toHaveBeenCalled();
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("the assignee must hold an edit role in an owning org (a VIEWER or an outsider is not eligible)", async () => {
    const ctx = buildHoldTestContext();
    for (const assigneeHumanId of [VIEWER_ID, OUTSIDER_ID]) {
      await expect(
        assignBookingRequest(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, assigneeHumanId }),
      ).rejects.toMatchObject({ code: "BOOKING_ASSIGNEE_NOT_ELIGIBLE" });
    }
  });

  it("only edit-role staff may assign; the act cannot", async () => {
    const ctx = buildHoldTestContext();
    await expect(
      assignBookingRequest(ctx.deps, { actorHumanId: VIEWER_ID, bookingRequestId: REQUEST_A, assigneeHumanId: STAFF_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("human-owned venues have no assignee (NOT_APPLICABLE); TO_PERFORMER rows are venue-only", async () => {
    const human = buildHoldTestContext({ place: { orgIdsWithAccess: [], humanIdsWithAccess: [OUTSIDER_ID] } });
    await expect(
      assignBookingRequest(human.deps, { actorHumanId: OUTSIDER_ID, bookingRequestId: REQUEST_A, assigneeHumanId: OUTSIDER_ID }),
    ).rejects.toMatchObject({ code: "BOOKING_ASSIGNMENT_NOT_APPLICABLE" });

    const ctx = buildHoldTestContext();
    const organizer = buildOrganizerBookingRequestRecord({ id: "47474747-4747-4747-8747-474747474747" });
    ctx.requests.set(organizer.id, organizer);
    await expect(
      assignBookingRequest(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: organizer.id, assigneeHumanId: STAFF_ID }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLDS_VENUE_ONLY" });
  });
});

describe("postBookingRequestMessage — auto-assign (FR-015)", () => {
  function deps(ctx: ReturnType<typeof buildHoldTestContext>) {
    return { repos: ctx.repos as never, clock: ctx.deps.clock };
  }

  it("the first STAFF message on an unassigned org-owned request assigns its author, in the same tx, with a ledger entry", async () => {
    const ctx = buildHoldTestContext();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, assigneeHumanId: null });

    await postBookingRequestMessage(deps(ctx), {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      side: "VENUE",
      body: "Hey — Friday could work.",
    });

    expect(ctx.requests.get(REQUEST_A)?.assigneeHumanId).toBe(STAFF_ID);
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_request.assigned", data: { assigneeHumanId: STAFF_ID, previousAssigneeHumanId: null }, actor: STAFF_ID },
    ]);
  });

  it("does NOT reassign when someone already holds it, and never on the act's messages", async () => {
    const ctx = buildHoldTestContext(); // A is assigned to ASSIGNEE_ID
    await postBookingRequestMessage(deps(ctx), { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, side: "VENUE", body: "Still on?" });
    expect(ctx.requests.get(REQUEST_A)?.assigneeHumanId).toBe(ASSIGNEE_ID);

    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, assigneeHumanId: null });
    await postBookingRequestMessage(deps(ctx), {
      actorHumanId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
      bookingRequestId: REQUEST_A,
      side: "PERFORMER",
      body: "Yes!",
    });
    expect(ctx.requests.get(REQUEST_A)?.assigneeHumanId).toBeNull();
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("a human-owned venue never gets an assignee", async () => {
    const ctx = buildHoldTestContext({ place: { orgIdsWithAccess: [], humanIdsWithAccess: [OUTSIDER_ID] } });
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, assigneeHumanId: null });
    await postBookingRequestMessage(deps(ctx), { actorHumanId: OUTSIDER_ID, bookingRequestId: REQUEST_A, side: "VENUE", body: "Hello" });
    expect(ctx.requests.get(REQUEST_A)?.assigneeHumanId).toBeNull();
    expect(ctx.bookingRequests.setAssignee).not.toHaveBeenCalled();
  });
});
