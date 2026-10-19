import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { router } from "../../init";
import { attendeeReviewsRouter } from "../attendee-reviews";
import { claimsRouter } from "../claims";
import { creditsRouter } from "../credits";
import { eventHumansRouter } from "../event-humans";
import { humansRouter } from "../humans";
import { ordersRouter } from "../orders";
import { resaleRouter } from "../resale";
import { ticketsRouter } from "../tickets";
import { walletPassesRouter } from "../wallet-passes";
import * as listMyOrdersModule from "@th/core/use-cases/orders/list-my-orders";
import * as getActiveCartHoldsModule from "@th/core/use-cases/orders/get-active-cart-holds";
import * as coreModule from "@th/core";
import * as creditsModule from "@th/core/use-cases/credits";
import * as listMyLineupsModule from "@th/core/use-cases/event-humans/list-my-lineups";
import * as leaveEventLineupModule from "@th/core/use-cases/event-humans/leave-event-lineup";
import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import { createCaller } from "./test-helpers";

/**
 * B2, account squatting through guest checkout (owner ruling 2026-10-16).
 *
 * Someone signs up with a password under another person's address and never
 * verifies. Guest checkout, comps, door sales and volunteer rewards resolve the
 * buyer BY EMAIL, so the real person's orders and tickets land on that
 * account's Human. Every surface where a signed-in actor reads or acts on their
 * own orders and tickets must refuse an unverified actor BEFORE the use case
 * runs (the repos below hold nothing else, so a use case that ran would fail
 * with a different error). Ambient widgets answer empty instead.
 */
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";

const appRouter = {
  orders: router(ordersRouter),
  resale: router(resaleRouter),
  walletPasses: router(walletPassesRouter),
  tickets: router(ticketsRouter),
  claims: router(claimsRouter),
  humans: router(humansRouter),
  attendeeReviews: router(attendeeReviewsRouter),
  credits: router(creditsRouter),
  eventHumans: router(eventHumansRouter),
};

function reposFor(emailVerified: boolean) {
  const getByIdWithIdentity = vi.fn(async () => ({
    human: { id: ACTOR_ID },
    identity: { emailVerified },
  }));
  return {
    repos: { humans: { getByIdWithIdentity } } as unknown as Ctx["repos"],
    getByIdWithIdentity,
  };
}

function callerFor(emailVerified: boolean) {
  const { repos, getByIdWithIdentity } = reposFor(emailVerified);
  const { caller } = createCaller(appRouter, {
    repos,
    actorHumanId: ACTOR_ID,
    clock: { now: () => new Date("2026-10-16T12:00:00.000Z") } as Ctx["clock"],
  });
  return { caller, getByIdWithIdentity };
}

type Call = [name: string, run: (caller: any) => Promise<unknown>];

const GATED: Call[] = [
  ["orders.getMyOrder", (c) => c.orders.getMyOrder({ orderId: ORDER_ID })],
  ["orders.listMyOrders", (c) => c.orders.listMyOrders({})],
  [
    "orders.listMyOrderTickets",
    (c) => c.orders.listMyOrderTickets({ orderId: ORDER_ID }),
  ],
  ["orders.quoteFullRefund", (c) => c.orders.quoteFullRefund({ orderId: ORDER_ID })],
  ["orders.refundFullOrder", (c) => c.orders.refundFullOrder({ orderId: ORDER_ID })],
  [
    "orders.getRefundEligibility",
    (c) => c.orders.getRefundEligibility({ orderId: ORDER_ID }),
  ],
  ["orders.quoteItemRefund", (c) => c.orders.quoteItemRefund({ orderId: ORDER_ID })],
  ["orders.refundOrderItems", (c) => c.orders.refundOrderItems({ orderId: ORDER_ID })],
  ["orders.releaseCartHold", (c) => c.orders.releaseCartHold({ orderId: ORDER_ID })],
  ["resale.createListing", (c) => c.resale.createListing({})],
  ["resale.estimateListing", (c) => c.resale.estimateListing({})],
  ["resale.cancelListing", (c) => c.resale.cancelListing({})],
  ["resale.listMyListings", (c) => c.resale.listMyListings({})],
  ["resale.createCheckout", (c) => c.resale.createCheckout({})],
  ["walletPasses.generate", (c) => c.walletPasses.generate({})],
  ["tickets.cancelPendingTransfer", (c) => c.tickets.cancelPendingTransfer({})],
  ["tickets.getPendingTransfers", (c) => c.tickets.getPendingTransfers()],
  ["claims.create", (c) => c.claims.create({})],
  ["claims.respond", (c) => c.claims.respond({})],
  ["claims.list", (c) => c.claims.list({})],
  ["claims.listMy", (c) => c.claims.listMy({})],
  ["claims.get", (c) => c.claims.get({})],
  ["credits.listMine", (c) => c.credits.listMine()],
  [
    "attendeeReviews.submit",
    (c) => c.attendeeReviews.submit({ eventId: ORDER_ID }),
  ],
  [
    "attendeeReviews.getEligibility",
    (c) => c.attendeeReviews.getEligibility({ eventId: ORDER_ID }),
  ],
  // Lineup rows linked BY EMAIL (`events.inviteLineupHumanToRegister`).
  ["eventHumans.listMine", (c) => c.eventHumans.listMine({})],
  ["eventHumans.leave", (c) => c.eventHumans.leave({ eventId: ORDER_ID })],
];

describe("verified-email gate on own orders and tickets (B2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each(GATED)(
    "%s refuses an unverified actor with email_verification_required",
    async (_name, run) => {
      const { caller, getByIdWithIdentity } = callerFor(false);

      await expect(run(caller)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "email_verification_required",
      });
      expect(getByIdWithIdentity).toHaveBeenCalledWith(ACTOR_ID);
    },
  );

  it.each(GATED)(
    "%s lets a verified actor through to the procedure",
    async (_name, run) => {
      const { caller } = callerFor(true);

      // The procedure runs (and fails on the empty repos or the empty
      // input) — anything but the verification refusal.
      const outcome = await run(caller).then(
        () => null,
        (err: { message?: string }) => err,
      );
      expect(outcome?.message).not.toBe("email_verification_required");
    },
  );

  it("listMyOrders reaches the use case for a verified actor", async () => {
    const spy = vi
      .spyOn(listMyOrdersModule, "listMyOrders")
      .mockResolvedValue(buildOffsetPaginatedResult({ items: [], limit: 20 }) as any);
    const { caller } = callerFor(true);

    await caller.orders.listMyOrders({});

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorHumanId: ACTOR_ID }),
    );
  });

  it("listMyOrders never reaches the use case for an unverified actor", async () => {
    const spy = vi.spyOn(listMyOrdersModule, "listMyOrders");
    const { caller } = callerFor(false);

    await expect(caller.orders.listMyOrders({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  // A valid submit under whichever attendee-review schema is live: the 2026-09
  // question-set rebuild swaps the required `overallRating` for `wouldReturn`,
  // and both schemas are strict. These cases test the gate, not the questions.
  const reviewInput = () =>
    ("wouldReturn" in coreModule.submitAttendeeReviewInputSchema.shape
      ? { eventId: ORDER_ID, wouldReturn: "YES" }
      : { eventId: ORDER_ID, overallRating: 5 }) as Parameters<
      ReturnType<typeof callerFor>["caller"]["attendeeReviews"]["submit"]
    >[0];

  // The two late additions to GATED, checked with a spy on the use case the
  // router really calls: a verified actor reaches it, an unverified one not.
  it("attendeeReviews.submit reaches the use case for a verified actor", async () => {
    const spy = vi
      .spyOn(coreModule, "submitAttendeeReview")
      .mockResolvedValue({ reviewId: ORDER_ID });
    const { caller } = callerFor(true);

    await expect(
      caller.attendeeReviews.submit(reviewInput()),
    ).resolves.toEqual({ reviewId: ORDER_ID });

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventId: ORDER_ID, actorHumanId: ACTOR_ID }),
    );
  });

  it("attendeeReviews.submit never reaches the use case for an unverified actor", async () => {
    const spy = vi.spyOn(coreModule, "submitAttendeeReview");
    const { caller } = callerFor(false);

    await expect(
      caller.attendeeReviews.submit(reviewInput()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("credits.listMine reaches the use case for a verified actor", async () => {
    const listed = { credits: [], balanceCents: 0 };
    const spy = vi
      .spyOn(creditsModule, "listCreditsForHuman")
      .mockResolvedValue(listed as any);
    const { caller } = callerFor(true);

    await expect(caller.credits.listMine()).resolves.toEqual(listed);

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ humanId: ACTOR_ID }),
    );
  });

  it("credits.listMine never reaches the use case for an unverified actor", async () => {
    const spy = vi.spyOn(creditsModule, "listCreditsForHuman");
    const { caller } = callerFor(false);

    await expect(caller.credits.listMine()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("eventHumans.listMine reaches the use case for a verified actor", async () => {
    const listed = { items: [], nextCursor: null };
    const spy = vi
      .spyOn(listMyLineupsModule, "listMyLineups")
      .mockResolvedValue(listed as any);
    const { caller } = callerFor(true);

    await expect(caller.eventHumans.listMine({})).resolves.toEqual(listed);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorHumanId: ACTOR_ID }),
    );
  });

  it("eventHumans.listMine and leave never reach the use case for an unverified actor", async () => {
    const listSpy = vi.spyOn(listMyLineupsModule, "listMyLineups");
    const leaveSpy = vi.spyOn(leaveEventLineupModule, "leaveEventLineup");
    const { caller } = callerFor(false);

    await expect(caller.eventHumans.listMine({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.eventHumans.leave({ eventId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(listSpy).not.toHaveBeenCalled();
    expect(leaveSpy).not.toHaveBeenCalled();
  });

  it("refuses an actor whose AuthUser cannot be found", async () => {
    const { caller } = createCaller(appRouter, {
      repos: {
        humans: { getByIdWithIdentity: vi.fn(async () => null) },
      } as unknown as Ctx["repos"],
      actorHumanId: ACTOR_ID,
    });

    await expect(caller.orders.listMyOrders({})).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  describe("ambient widgets answer empty instead of throwing", () => {
    it("getActiveCartHolds returns no carts for an unverified actor", async () => {
      const spy = vi.spyOn(getActiveCartHoldsModule, "getActiveCartHolds");
      const { caller } = callerFor(false);

      await expect(caller.orders.getActiveCartHolds({})).resolves.toEqual({
        carts: [],
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it("getActiveCartHolds reaches the use case for a verified actor", async () => {
      const spy = vi
        .spyOn(getActiveCartHoldsModule, "getActiveCartHolds")
        .mockResolvedValue({ carts: [] });
      const { caller } = callerFor(true);

      await caller.orders.getActiveCartHolds({});

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ actorHumanId: ACTOR_ID }),
      );
    });

    it("getMyNextNight returns null for an unverified actor without reading tickets", async () => {
      const listUpcomingHeldEvents = vi.fn(async () => []);
      const { repos } = reposFor(false);
      const { caller } = createCaller(appRouter, {
        repos: {
          ...repos,
          tickets: { listUpcomingHeldEvents },
        } as unknown as Ctx["repos"],
        actorHumanId: ACTOR_ID,
      });

      await expect(caller.humans.getMyNextNight()).resolves.toBeNull();
      expect(listUpcomingHeldEvents).not.toHaveBeenCalled();
    });
  });
});
