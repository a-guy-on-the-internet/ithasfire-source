import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACT_A_ID,
  ASSIGNEE_ID,
  ORG_ID,
  PLACE_ID,
  REQUEST_A,
  REQUEST_B,
  NOW,
  STAFF_ID,
  buildHoldTestContext,
} from "@th/core/use-cases/booking-holds/__tests__/hold-test-context";
import { makeFakeIdempotency } from "@th/core/use-cases/booking-requests/__tests__/helpers";

import { bookingRequestsRouter } from "../booking-requests";
import { createCaller } from "./test-helpers";

vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
import { dispatchBookingHoldIntents } from "@th/core/use-cases/booking-holds";

/**
 * Booking-holds FR-009 at the transport: a withdraw releases the request's
 * live holds and the OTHER acts' move-up intents ride the use-case output.
 * Those intents name other requests' ids, so they are server-side only:
 * dispatched post-commit here, NEVER returned to the withdrawing act.
 */

const dispatchMock = vi.mocked(dispatchBookingHoldIntents);

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(undefined);
});

describe("bookingRequestsRouter.withdraw — hold intents", () => {
  it("strips holdNotificationIntents from the wire and dispatches them post-commit", async () => {
    const harness = buildHoldTestContext();
    harness.seedHold(REQUEST_A);
    const other = harness.seedHold(REQUEST_B);
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: harness.repos,
      clock: { now: () => NOW },
      actorHumanId: ACT_A_ID,
    });

    const result = await caller.withdraw({ bookingRequestId: REQUEST_A });

    expect(result).toEqual({ bookingRequestId: REQUEST_A, status: "WITHDRAWN" });
    expect(result).not.toHaveProperty("holdNotificationIntents");
    expect(harness.bookingHolds.rows.get(other.id)?.position).toBe(1);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [, args] = dispatchMock.mock.calls[0]!;
    expect(args.bookingRequestId).toBe(REQUEST_A);
    expect(args.intents).toEqual([
      expect.objectContaining({
        kind: "hold.position_changed",
        audience: "act",
        bookingRequestId: REQUEST_B,
        holdId: other.id,
        position: 1,
      }),
    ]);
    // No hint on withdraw's output → resolved from the request + place.
    expect(args.hint).toEqual({
      assigneeHumanId: ASSIGNEE_ID,
      placedByHumanId: ACT_A_ID,
      orgId: ORG_ID,
      placeId: PLACE_ID,
    });
  });

  it("does not dispatch when nothing moved, and a dispatcher failure never fails the withdraw", async () => {
    const harness = buildHoldTestContext();
    harness.seedHold(REQUEST_A);
    dispatchMock.mockRejectedValueOnce(new Error("mailer down"));
    const reportError = vi.fn();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: harness.repos,
      clock: { now: () => NOW },
      actorHumanId: ACT_A_ID,
      reportError,
    });

    // Only REQUEST_A held the line → no movers → nothing to dispatch.
    await expect(caller.withdraw({ bookingRequestId: REQUEST_A })).resolves.toMatchObject({
      status: "WITHDRAWN",
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("bookingRequestsRouter.respond (decline) — hold intents", () => {
  it("dispatches move-ups on a live decline and NOT on the cached idempotent replay", async () => {
    const harness = buildHoldTestContext();
    harness.seedHold(REQUEST_A);
    const other = harness.seedHold(REQUEST_B);
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: harness.repos,
      clock: { now: () => NOW },
      idempotency: makeFakeIdempotency(),
      actorHumanId: STAFF_ID,
    });
    const input = {
      bookingRequestId: REQUEST_A,
      action: "decline" as const,
      declineReason: "Booked that night already.",
    };

    const first = await caller.respond(input);
    expect(first).toEqual({ bookingRequestId: REQUEST_A, status: "DECLINED" });
    expect(first).not.toHaveProperty("holdNotificationIntents");
    expect(harness.bookingHolds.rows.get(other.id)?.position).toBe(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1].intents).toEqual([
      expect.objectContaining({ kind: "hold.position_changed", bookingRequestId: REQUEST_B, position: 1 }),
    ]);

    // Replay: served from the idempotency record, which carries no intents.
    const replay = await caller.respond(input);
    expect(replay).toEqual(first);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});
