import { beforeEach, describe, expect, it, vi } from "vitest";

import * as resaleUseCases from "@th/core/use-cases/resale";
import { resaleRouter } from "../resale";
import { createCaller } from "./test-helpers";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const LISTING_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_ID = "44444444-4444-4444-8444-444444444444";

// The actor's email is verified: the seller flow and `createCheckout` sit
// behind the B2 verified-email gate (verified-email-gate.test.ts covers the
// refusal).
const createResaleCaller = (ctxOverrides?: Parameters<typeof createCaller>[1]) =>
  createCaller(resaleRouter, {
    ...ctxOverrides,
    repos: {
      ...((ctxOverrides?.repos ?? {}) as object),
      humans: {
        getByIdWithIdentity: vi.fn(async () => ({
          identity: { emailVerified: true },
        })),
      },
    } as any,
  });

describe("resaleRouter.createCheckout", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards refund policy acknowledgement and server-observed request IP", async () => {
    const spy = vi
      .spyOn(resaleUseCases, "createResaleCheckout")
      .mockResolvedValue({
        orderId: "33333333-3333-4333-8333-333333333333",
        clientSecret: "pi_resale_secret",
        amountGrossCents: 5000,
        buyerFeesCents: 175,
        taxAmountCents: 0,
        holdExpiresAt: "2026-03-10T12:15:00.000Z",
      });

    const { caller, ctx } = createResaleCaller({
      actorHumanId: ACTOR_ID,
      clientIp: "203.0.113.44",
      enableResale: true,
    });

    const result = await caller.createCheckout({
      buyerHumanId: ACTOR_ID,
      listingId: LISTING_ID,
      clientKey: "ck_resale_abcdefgh",
      termsAccepted: true,
      refundPolicyAccepted: true,
      requestIp: "198.51.100.99",
    });

    expect(result.clientSecret).toBe("pi_resale_secret");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        buyerHumanId: ACTOR_ID,
        listingId: LISTING_ID,
        termsAccepted: true,
        refundPolicyAccepted: true,
        requestIp: "203.0.113.44",
      }),
    );
  });

  it("rejects with FORBIDDEN when the resale gate is off (env default)", async () => {
    const spy = vi.spyOn(resaleUseCases, "createResaleCheckout");

    // No enableResale override and no platformSettings repo → the gate
    // resolves to its default-OFF state.
    const { caller } = createResaleCaller({ actorHumanId: ACTOR_ID });

    await expect(
      caller.createCheckout({
        buyerHumanId: ACTOR_ID,
        listingId: LISTING_ID,
        clientKey: "ck_resale_abcdefgh",
        termsAccepted: true,
        refundPolicyAccepted: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("honours a DB override turning resale off even when env enables it", async () => {
    const spy = vi.spyOn(resaleUseCases, "createResaleCheckout");

    const { caller } = createResaleCaller({
      actorHumanId: ACTOR_ID,
      enableResale: true,
      repos: {
        platformSettings: {
          getAll: vi
            .fn()
            .mockResolvedValue([{ key: "feature:resale", value: "false" }]),
        },
      } as any,
    });

    await expect(
      caller.createCheckout({
        buyerHumanId: ACTOR_ID,
        listingId: LISTING_ID,
        clientKey: "ck_resale_abcdefgh",
        termsAccepted: true,
        refundPolicyAccepted: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("resaleRouter.createListing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const listingInput = {
    ticketId: TICKET_ID,
    askPriceCents: 5000,
    clientKey: "ck_listing_abcdefgh",
  };

  const listingOutput = {
    listingId: LISTING_ID,
    ticketId: TICKET_ID,
    askPriceCents: 5000,
    currency: "usd",
    expiresAt: "2026-03-10T12:15:00.000Z",
  };

  it("rejects with FORBIDDEN when the resale gate is off (env default)", async () => {
    const spy = vi.spyOn(resaleUseCases, "createResaleListing");

    const { caller } = createResaleCaller({ actorHumanId: ACTOR_ID });

    await expect(caller.createListing(listingInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("forwards to the use case when the resale gate is on via env", async () => {
    const spy = vi
      .spyOn(resaleUseCases, "createResaleListing")
      .mockResolvedValue(listingOutput);

    const { caller } = createResaleCaller({
      actorHumanId: ACTOR_ID,
      enableResale: true,
    });

    const result = await caller.createListing(listingInput);

    expect(result.listingId).toBe(LISTING_ID);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorHumanId: ACTOR_ID, ticketId: TICKET_ID }),
    );
  });

  it("honours a DB override turning resale on when env leaves it off", async () => {
    const spy = vi
      .spyOn(resaleUseCases, "createResaleListing")
      .mockResolvedValue(listingOutput);

    const { caller } = createResaleCaller({
      actorHumanId: ACTOR_ID,
      repos: {
        platformSettings: {
          getAll: vi
            .fn()
            .mockResolvedValue([{ key: "feature:resale", value: "true" }]),
        },
      } as any,
    });

    const result = await caller.createListing(listingInput);

    expect(result.listingId).toBe(LISTING_ID);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
