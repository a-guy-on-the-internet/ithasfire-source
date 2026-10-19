import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";

import { router, t } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { ordersRouter } from "../orders";
import * as checkoutModule from "@th/core/use-cases/orders/create-checkout";
import * as updateOrderItemsModule from "@th/core/use-cases/orders/update-order-items";
import * as listOrgModule from "@th/core/use-cases/orders/list-org-orders";
import * as listMyEventModule from "@th/core/use-cases/orders/list-my-event-orders";
import * as staffRefundOrderModule from "@th/core/use-cases/orders/staff-refund-order";
import * as orgQuoteItemRefundModule from "@th/core/use-cases/orders/org-quote-item-refund";
import * as orgRefundOrderItemsModule from "@th/core/use-cases/orders/org-refund-order-items";
import * as orgRefundFullOrderModule from "@th/core/use-cases/orders/org-refund-full-order";
import * as confirmPaymentModule from "@th/core/use-cases/orders/confirm-payment";
import { createTestLogger } from "@th/test-utils";
import { fail } from "@th/errors";

const hasOwn = <T extends object>(obj: T | undefined, key: keyof T): boolean =>
  !!obj && Object.prototype.hasOwnProperty.call(obj, key);

const createRepos = (
  emailVerified = true,
  extra?: Partial<Ctx["repos"]>,
): Ctx["repos"] =>
  ({
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified },
      })),
    },
    ...extra,
  }) as unknown as Ctx["repos"];

const buildEventUnlockCookie = (eventId: string, secret: string): string => {
  const exp = Date.now() + 60_000;
  const signature = createHmac("sha256", secret)
    .update(`${eventId}|${exp}`)
    .digest("base64url");
  return `th_eu_${eventId}=${exp}.${signature}`;
};

const buildBaseCtx = (overrides?: Partial<Ctx>): Ctx => {
  const repos = hasOwn(overrides, "repos")
    ? (overrides!.repos as Ctx["repos"])
    : createRepos();
  const payments =
    overrides?.payments ??
    ({
      createPaymentIntent: vi.fn(),
      refundPaymentIntent: vi.fn(),
      createTransfer: vi.fn(),
      getChargeIdForPaymentIntent: vi.fn(),
      getPaymentMethodType: vi.fn(),
    } as unknown as Ctx["payments"]);
  const authn =
    overrides?.authn ??
    ({
      ensureAuthedHuman: vi.fn(),
      ensureAuthedHumanFromApiKey: vi.fn(),
      getProviderUserId: vi.fn(),
    } as unknown as Ctx["authn"]);
  const authz =
    overrides?.authz ??
    ({
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(),
      canFinanceOrg: vi.fn(),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"]);
  const idempotency =
    overrides?.idempotency ??
    ({
      begin: vi.fn(),
      get: vi.fn(),
      commit: vi.fn(),
      fail: vi.fn(),
    } as unknown as Ctx["idempotency"]);
  const clock =
    overrides?.clock ??
    ({
      now: vi.fn(() => new Date("2024-01-01T00:00:00.000Z")),
    } as unknown as Ctx["clock"]);
  const logger = hasOwn(overrides, "logger")
    ? (overrides!.logger as Ctx["logger"])
    : createTestLogger();
  const placeLayoutParser =
    overrides?.placeLayoutParser ??
    ({
      parse: vi.fn(),
    } as unknown as Ctx["placeLayoutParser"]);
  const placeLayoutStreaming =
    overrides?.placeLayoutStreaming ??
    ({
      publishPlaceLayoutReplaced: vi.fn(),
    } as unknown as Ctx["placeLayoutStreaming"]);
  const searchQuery =
    overrides?.searchQuery ??
    ({
      search: vi.fn(),
    } as unknown as Ctx["searchQuery"]);
  const searchPrompts =
    overrides?.searchPrompts ??
    ({
      listPrompts: vi.fn(),
      getPrompt: vi.fn(),
    } as unknown as Ctx["searchPrompts"]);
  const geo =
    overrides?.geo ??
    ({
      geocodeAddress: vi.fn(),
      reverseGeocode: vi.fn(),
      placeAutocomplete: vi.fn(),
    } as unknown as Ctx["geo"]);
  const notify = overrides?.notify ?? (vi.fn() as unknown as Ctx["notify"]);

  const fileStorage =
    overrides?.fileStorage ?? ({} as unknown as Ctx["fileStorage"]);

  const rateLimit =
    overrides?.rateLimit ??
    (withConsumeMany({
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterSeconds: 0,
      })),
    }) as unknown as Ctx["rateLimit"]);

  return {
    repos,
    fileStorage,
    payments,
    authn,
    authz,
    idempotency,
    clock,
    logger,
    placeLayoutParser,
    placeLayoutStreaming,
    searchQuery,
    searchPrompts,
    geo,
    notify,
    rateLimit,
    auth: hasOwn(overrides, "auth")
      ? (overrides!.auth ?? null)
      : { userId: "user-1", sessionId: null, token: "token" },
    authToken: hasOwn(overrides, "authToken")
      ? (overrides!.authToken ?? null)
      : "token",
    apiKey: hasOwn(overrides, "apiKey") ? (overrides!.apiKey ?? null) : null,
    actorHumanId: hasOwn(overrides, "actorHumanId")
      ? (overrides!.actorHumanId ?? null)
      : "11111111-1111-4111-8111-111111111111",
    viewerLocation: hasOwn(overrides, "viewerLocation")
      ? (overrides!.viewerLocation ?? null)
      : null,
    clientIp: hasOwn(overrides, "clientIp")
      ? (overrides!.clientIp ?? null)
      : "203.0.113.44",
    userAgent: hasOwn(overrides, "userAgent")
      ? (overrides!.userAgent ?? null)
      : "vitest",
    eventUnlockSecret: hasOwn(overrides, "eventUnlockSecret")
      ? (overrides!.eventUnlockSecret ?? null)
      : null,
    cookieHeader: hasOwn(overrides, "cookieHeader")
      ? (overrides!.cookieHeader ?? null)
      : null,
  };
};

const createCaller = (ctxOverrides?: Partial<Ctx>) => {
  const ctx = buildBaseCtx(ctxOverrides);
  const testRouter = trpcRouter({ orders: router(ordersRouter) });
  const caller = testRouter.createCaller(ctx);
  return { caller, ctx };
};

describe("ordersRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards dependencies and actor human id to staffRefundOrder", async () => {
    const refundSpy = vi
      .spyOn(staffRefundOrderModule, "staffRefundOrder")
      .mockResolvedValue({
        ok: true,
        orderId: "123e4567-e89b-12d3-a456-426614174000",
        refundId: "re_123",
        currency: "usd",
        amountPaidCents: 1000,
        stripeFeeCents: 59,
        refundedCents: 941,
        refundedItems: [],
        skippedItems: [],
        newOrderStatus: "REFUNDED",
      });

    const { caller, ctx } = createCaller();

    const input = {
      orderId: "123e4567-e89b-12d3-a456-426614174000",
      note: "support refund",
      reason: "requested_by_customer" as const,
    };

    const out = await caller.orders.staffRefundOrder(input);

    expect(out.ok).toBe(true);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        payments: ctx.payments,
        clock: ctx.clock,
        authz: ctx.authz,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        orderId: input.orderId,
        note: input.note,
        reason: input.reason,
      }),
    );
  });

  it("forwards dependencies and actor human id to orgQuoteItemRefund", async () => {
    const quoteSpy = vi
      .spyOn(orgQuoteItemRefundModule, "orgQuoteItemRefund")
      .mockResolvedValue({
        orderId: "123e4567-e89b-12d3-a456-426614174000",
        currency: "usd",
        orderTotalPaidCents: 3300,
        orderStripeFeeCents: 100,
        totalRefundableCents: 3200,
        hasTransferReversals: false,
        items: [],
      });

    const { caller, ctx } = createCaller();

    const input = {
      orgId: "223e4567-e89b-12d3-a456-426614174000",
      orderId: "123e4567-e89b-12d3-a456-426614174000",
      orderItemIds: ["323e4567-e89b-12d3-a456-426614174000"],
    };

    const out = await caller.orders.orgQuoteItemRefund(input);

    expect(out.totalRefundableCents).toBe(3200);
    expect(quoteSpy).toHaveBeenCalledTimes(1);
    expect(quoteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        payments: ctx.payments,
        authz: ctx.authz,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        orgId: input.orgId,
        orderId: input.orderId,
        orderItemIds: input.orderItemIds,
      }),
    );
  });

  it("forwards dependencies and actor human id to orgRefundOrderItems", async () => {
    const refundSpy = vi
      .spyOn(orgRefundOrderItemsModule, "orgRefundOrderItems")
      .mockResolvedValue({
        ok: true,
        orderId: "123e4567-e89b-12d3-a456-426614174000",
        refundId: "re_123",
        currency: "usd",
        totalRefundedCents: 3200,
        items: [],
        newOrderStatus: "PART_REFUNDED",
      });

    const { caller, ctx } = createCaller();

    const input = {
      orgId: "223e4567-e89b-12d3-a456-426614174000",
      orderId: "123e4567-e89b-12d3-a456-426614174000",
      orderItemIds: ["323e4567-e89b-12d3-a456-426614174000"],
      note: "moved event, refunding attendee",
    };

    const out = await caller.orders.orgRefundOrderItems(input);

    expect(out.ok).toBe(true);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        authz: ctx.authz,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        orgId: input.orgId,
        orderId: input.orderId,
        orderItemIds: input.orderItemIds,
        note: input.note,
      }),
    );
  });

  it("forwards dependencies and actor human id to orgRefundFullOrder", async () => {
    const refundSpy = vi
      .spyOn(orgRefundFullOrderModule, "orgRefundFullOrder")
      .mockResolvedValue({
        ok: true,
        orderId: "123e4567-e89b-12d3-a456-426614174000",
        refundId: "re_123",
        currency: "usd",
        amountPaidCents: 5500,
        stripeFeeCents: 300,
        refundedCents: 5200,
        refundedItems: [
          {
            orderItemId: "323e4567-e89b-12d3-a456-426614174000",
            refundedCents: 5200,
          },
        ],
        skippedItems: [],
        newOrderStatus: "REFUNDED",
      });

    const { caller, ctx } = createCaller();

    const input = {
      orgId: "223e4567-e89b-12d3-a456-426614174000",
      orderId: "123e4567-e89b-12d3-a456-426614174000",
      note: "resale buyer disputed, unwinding to the seller",
    };

    const out = await caller.orders.orgRefundFullOrder(input);

    expect(out.ok).toBe(true);
    expect(out.newOrderStatus).toBe("REFUNDED");
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        authz: ctx.authz,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        orgId: input.orgId,
        orderId: input.orderId,
        note: input.note,
      }),
    );
  });

  it("returns clientSecret: null for free checkouts", async () => {
    vi.spyOn(checkoutModule, "createCheckout").mockResolvedValue({
      orderId: "123e4567-e89b-12d3-a456-426614174000",
      clientSecret: null,
      amountGrossCents: 0,
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      processorFeeCents: 0,
      feeMode: "ABSORB",
      taxAmountCents: 0,
      holdExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    });

    const { caller } = createCaller();

    const result = await caller.orders.createCheckout({
      eventId: "33333333-3333-4333-8333-333333333333",
      clientKey: "checkout-key",
      items: [{ ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 }],
    });

    expect(result.clientSecret).toBeNull();
  });

  it("rejects createCheckout for unverified actors before invoking the use case", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: "123e4567-e89b-12d3-a456-426614174000",
        clientSecret: null,
        amountGrossCents: 0,
        feesPlatformCents: 0,
        buyerFeesCents: 0,
        processorFeeCents: 0,
        feeMode: "ABSORB",
        taxAmountCents: 0,
        holdExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      });

    const { caller } = createCaller({ repos: createRepos(false) });

    await expect(
      caller.orders.createCheckout({
        eventId: "33333333-3333-4333-8333-333333333333",
        clientKey: "checkout-key",
        items: [
          { ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 },
        ],
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "email_verification_required",
    });
    expect(createCheckoutSpy).not.toHaveBeenCalled();
  });

  it("rejects updateOrderItems for unverified actors before invoking the use case", async () => {
    const updateOrderItemsSpy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockResolvedValue({
        order: {
          id: "123e4567-e89b-12d3-a456-426614174000",
          eventId: "33333333-3333-4333-8333-333333333333",
          buyerHumanId: "11111111-1111-4111-8111-111111111111",
          amountGrossCents: 1000,
          feesPlatformCents: 100,
          buyerFeesCents: 100,
          processorFeeCents: 50,
          currency: "usd",
          status: "PENDING",
          items: [],
        },
        holdExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      });

    const { caller } = createCaller({ repos: createRepos(false) });

    await expect(
      caller.orders.updateOrderItems({
        eventId: "33333333-3333-4333-8333-333333333333",
        items: [
          { ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 },
        ],
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "email_verification_required",
    });
    expect(updateOrderItemsSpy).not.toHaveBeenCalled();
  });

  it("persists a signed password unlock cookie before holding tickets", async () => {
    const eventId = "33333333-3333-4333-8333-333333333333";
    const eventUnlocks = {
      upsert: vi.fn(async () => ({
        id: "unlock-1",
        eventId,
        humanId: "11111111-1111-4111-8111-111111111111",
        source: "PASSWORD",
        applicationSubmissionId: null,
        metadata: {},
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    };
    const repos = createRepos(true, {
      events: {
        getById: vi.fn(async () => ({ id: eventId, gateType: "PASSWORD" })),
      } as unknown as Ctx["repos"]["events"],
      eventUnlocks: eventUnlocks as unknown as Ctx["repos"]["eventUnlocks"],
    });
    const updateOrderItemsSpy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockResolvedValue({
        order: {
          id: "123e4567-e89b-12d3-a456-426614174000",
          eventId,
          buyerHumanId: "11111111-1111-4111-8111-111111111111",
          amountGrossCents: 1000,
          feesPlatformCents: 100,
          buyerFeesCents: 100,
          processorFeeCents: 50,
          currency: "usd",
          status: "PENDING",
          items: [],
        },
        holdExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
    const secret = "event-unlock-secret-with-at-least-32-chars";

    const { caller, ctx } = createCaller({
      repos,
      eventUnlockSecret: secret,
      cookieHeader: buildEventUnlockCookie(eventId, secret),
    });

    await caller.orders.updateOrderItems({
      eventId,
      items: [
        { ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 },
      ],
    });

    expect(eventUnlocks.upsert).toHaveBeenCalledWith({
      eventId,
      humanId: ctx.actorHumanId,
      source: "PASSWORD",
      metadata: { proof: "signed_cookie" },
    });
    expect(updateOrderItemsSpy).toHaveBeenCalledTimes(1);
  });

  it("maps stripe_not_connected to TRPC CONFLICT", async () => {
    vi.spyOn(checkoutModule, "createCheckout").mockRejectedValue({
      code: "conflict",
      message: "stripe_not_connected",
    });

    const { caller } = createCaller();

    await expect(
      caller.orders.createCheckout({
        eventId: "33333333-3333-4333-8333-333333333333",
        clientKey: "checkout-key",
        items: [
          { ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "stripe_not_connected",
    });
  });

  it("forwards dependencies and actor human id to createCheckout", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: "123e4567-e89b-12d3-a456-426614174000",
        clientSecret: "secret_test",
        amountGrossCents: 2000,
        feesPlatformCents: 100,
        buyerFeesCents: 100,
        processorFeeCents: 50,
        feeMode: "ABSORB",
        taxAmountCents: 0,
        holdExpiresAt: "2026-01-01T00:15:00.000Z",
      });

    const { caller, ctx } = createCaller();

    const input = {
      eventId: "33333333-3333-4333-8333-333333333333",
      clientKey: "checkout-key",
      items: [{ ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 2 }],
      refundPolicyAccepted: true,
      requestIp: "198.51.100.99",
    } as const;

    const result = await caller.orders.createCheckout(input);

    expect(result).toEqual({
      orderId: "123e4567-e89b-12d3-a456-426614174000",
      clientSecret: "secret_test",
      amountGrossCents: 2000,
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      processorFeeCents: 50,
      feeMode: "ABSORB",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: "2026-01-01T00:15:00.000Z",
    });
    expect(createCheckoutSpy).toHaveBeenCalledTimes(1);
    expect(createCheckoutSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        buyerHumanId: ctx.actorHumanId,
        eventId: input.eventId,
        refundPolicyAccepted: true,
        requestIp: ctx.clientIp,
      }),
    );
  });

  it("drops a client-sent applyPlatformCredit — credit policy is server-side only", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: "123e4567-e89b-12d3-a456-426614174000",
        clientSecret: "secret_test", // gitleaks:allow (fake test fixture)
        amountGrossCents: 2000,
        feesPlatformCents: 100,
        buyerFeesCents: 100,
        processorFeeCents: 50,
        feeMode: "ABSORB",
        taxAmountCents: 0,
        creditAppliedCents: 0,
        holdExpiresAt: "2026-01-01T00:15:00.000Z",
      });
    const { caller } = createCaller();

    await caller.orders.createCheckout({
      eventId: "33333333-3333-4333-8333-333333333333",
      clientKey: "checkout-key",
      items: [{ ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 }],
      refundPolicyAccepted: true,
      applyPlatformCredit: false,
    } as never);

    const forwarded = createCheckoutSpy.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    // Stripped by the omitted input schema, so createCheckout's default
    // (credit applies) governs the main checkout.
    expect(forwarded).not.toHaveProperty("applyPlatformCredit");
  });

  it("maps use case errors to TRPC errors", async () => {
    vi.spyOn(checkoutModule, "createCheckout").mockRejectedValue({
      code: "invalid_input",
      message: "bad",
    });
    const { caller } = createCaller();

    await expect(
      caller.orders.createCheckout({
        eventId: "33333333-3333-4333-8333-333333333333",
        clientKey: "checkout-key",
        items: [
          { ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "bad" });
  });

  it.each([
    ["omitted", {}],
    ["false", { refundPolicyAccepted: false }],
  ] as const)(
    "maps refund_policy_required to PRECONDITION_FAILED when refund policy acknowledgement is %s",
    async (_label, refundPolicyInput) => {
      vi.spyOn(checkoutModule, "createCheckout").mockRejectedValue({
        code: "refund_policy_required",
        message:
          "You must accept the refund policy before purchasing tickets.",
      });
      const { caller } = createCaller();

      await expect(
        caller.orders.createCheckout({
          eventId: "33333333-3333-4333-8333-333333333333",
          clientKey: "checkout-key",
          items: [
            {
              ticketTypeId: "44444444-4444-4444-8444-444444444444",
              qty: 1,
            },
          ],
          ...refundPolicyInput,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "You must accept the refund policy before purchasing tickets.",
      });
    },
  );

  it("rejects when actor human id is missing", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: "123e4567-e89b-12d3-a456-426614174000",
        clientSecret: "secret_test",
        amountGrossCents: 2000,
        feesPlatformCents: 100,
        buyerFeesCents: 100,
        processorFeeCents: 50,
        feeMode: "ABSORB",
        taxAmountCents: 0,
        holdExpiresAt: "2026-01-01T00:15:00.000Z",
      });
    const { caller } = createCaller({
      actorHumanId: null,
      auth: null,
      authToken: null,
    });

    await expect(
      caller.orders.createCheckout({
        eventId: "33333333-3333-4333-8333-333333333333",
        clientKey: "checkout-key",
        items: [
          { ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(createCheckoutSpy).not.toHaveBeenCalled();
  });

  it("forwards dependencies and actor human id to listOrgOrders", async () => {
    const listOrgSpy = vi
      .spyOn(listOrgModule, "listOrgOrders")
      .mockResolvedValue({
        items: [],
        pageInfo: {
          total: 0,
          count: 0,
          limit: 25,
          offset: 0,
          hasNextPage: false,
          nextOffset: null,
        },
      });

    const { caller, ctx } = createCaller();

    const input = {
      orgId: "22222222-2222-4222-8222-222222222222",
      limit: 10,
      offset: 0,
    };

    await caller.orders.listOrgOrders(input);

    expect(listOrgSpy).toHaveBeenCalledTimes(1);
    expect(listOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        authz: ctx.authz,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        orgId: input.orgId,
        limit: input.limit,
        offset: input.offset,
      }),
    );
  });

  it("forwards dependencies and actor human id to listMyEventOrders", async () => {
    const listMyEventSpy = vi
      .spyOn(listMyEventModule, "listMyEventOrders")
      .mockResolvedValue({
        items: [],
        pageInfo: {
          total: 0,
          count: 0,
          limit: 25,
          offset: 0,
          hasNextPage: false,
          nextOffset: null,
        },
      });

    const { caller, ctx } = createCaller();

    const input = {
      limit: 5,
      offset: 0,
    };

    await caller.orders.listMyEventOrders(input);

    expect(listMyEventSpy).toHaveBeenCalledTimes(1);
    expect(listMyEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        authz: ctx.authz,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        limit: input.limit,
        offset: input.offset,
      }),
    );
  });
});

// Redirect payment methods (Amazon Pay, Cash App) return the buyer to a
// freshly mounted page that has no order id, or only a stale one. The
// contract: `paymentIntentId` alone is enough, and the order confirmed is the
// one the PaymentIntent's metadata names. Runs the REAL use case (the
// "processing" branch, which stops short of finalize) so the router's input
// schema and the use case are exercised together.
// A US bank debit Stripe reports `processing` can still fail days later: the
// checkout must tell it from a paid order from this answer alone (owner,
// 2026-10-14). The processing outcome is exercised against the real use case
// below; `confirmed` runs finalize, so it is stubbed here.
describe("ordersRouter.confirmPayment — the outcome reaches the client", () => {
  const BUYER = "11111111-1111-4111-8111-111111111111";
  const ORDER = "33333333-3333-4333-8333-333333333333";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a confirmed payment answers outcome confirmed", async () => {
    vi.spyOn(confirmPaymentModule, "confirmPayment").mockResolvedValue({
      ok: true,
      orderId: ORDER,
      outcome: "confirmed",
    });
    const { caller } = createCaller({ actorHumanId: BUYER });
    await expect(
      caller.orders.confirmPayment({ paymentIntentId: "pi_paid1" }),
    ).resolves.toEqual({ ok: true, orderId: ORDER, outcome: "confirmed" });
  });

  it("an answer without an outcome fails the procedure's output schema", async () => {
    vi.spyOn(confirmPaymentModule, "confirmPayment").mockResolvedValue({
      ok: true,
      orderId: ORDER,
    } as never);
    const { caller } = createCaller({ actorHumanId: BUYER });
    await expect(
      caller.orders.confirmPayment({ paymentIntentId: "pi_paid1" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});

describe("ordersRouter.confirmPayment — orderId is optional", () => {
  const BUYER = "11111111-1111-4111-8111-111111111111";
  const PI_ORDER = "33333333-3333-4333-8333-333333333333";
  const STALE_ORDER = "44444444-4444-4444-8444-444444444444";

  const setup = () => {
    const orders = {
      getById: vi.fn(async (id: string) =>
        id === PI_ORDER || id === STALE_ORDER
          ? { id, buyerHumanId: BUYER, status: "PENDING" }
          : null,
      ),
      markProcessingIfPending: vi.fn(async () => true),
    };
    const retrievePaymentIntent = vi.fn(async () => ({
      id: "pi_redirect1",
      status: "processing",
      amountReceived: 0,
      currency: "usd",
      metadata: { orderId: PI_ORDER },
    }));
    const { caller } = createCaller({
      actorHumanId: BUYER,
      repos: createRepos(true, { orders } as never),
      payments: { retrievePaymentIntent } as unknown as Ctx["payments"],
    });
    return { caller, orders };
  };

  it("accepts a PaymentIntent id alone and confirms the PI's order", async () => {
    const { caller, orders } = setup();
    await expect(
      caller.orders.confirmPayment({ paymentIntentId: "pi_redirect1" }),
    ).resolves.toEqual({ ok: true, orderId: PI_ORDER, outcome: "processing" });
    expect(orders.markProcessingIfPending).toHaveBeenCalledWith(PI_ORDER);
  });

  it("a stale orderId resolves to the PI's order", async () => {
    const { caller, orders } = setup();
    await expect(
      caller.orders.confirmPayment({
        paymentIntentId: "pi_redirect1",
        orderId: STALE_ORDER,
      }),
    ).resolves.toEqual({ ok: true, orderId: PI_ORDER, outcome: "processing" });
    expect(orders.markProcessingIfPending).toHaveBeenCalledWith(PI_ORDER);
  });

  it.each(["", "pi_", "pi_abc def", "pi_abc/../x", "pi_a.b", "cs_live_123", "PI_abc123"])(
    "a malformed PaymentIntent id (%s) is BAD_REQUEST and never reaches Stripe",
    async (paymentIntentId) => {
      const retrievePaymentIntent = vi.fn();
      const { caller } = createCaller({
        actorHumanId: BUYER,
        repos: createRepos(true),
        payments: { retrievePaymentIntent } as unknown as Ctx["payments"],
      });
      await expect(
        caller.orders.confirmPayment({ paymentIntentId }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(retrievePaymentIntent).not.toHaveBeenCalled();
    },
  );

  it("an id Stripe does not know is NOT_FOUND (4xx), not INTERNAL_SERVER_ERROR", async () => {
    const retrievePaymentIntent = vi.fn(async () => {
      throw fail("NOT_FOUND", { meta: { paymentIntentId: "pi_unknown1" } });
    });
    const { caller } = createCaller({
      actorHumanId: BUYER,
      repos: createRepos(true),
      payments: { retrievePaymentIntent } as unknown as Ctx["payments"],
    });
    await expect(
      caller.orders.confirmPayment({ paymentIntentId: "pi_unknown1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["requires_action", "requires_payment_method"])(
    "a PI still %s is PAYMENT_NOT_SUCCEEDED with its status in the client error's data.meta",
    async (piStatus) => {
      const orders = {
        getById: vi.fn(async () => ({
          id: PI_ORDER,
          buyerHumanId: BUYER,
          status: "PENDING",
        })),
        markProcessingIfPending: vi.fn(),
      };
      const retrievePaymentIntent = vi.fn(async () => ({
        id: "pi_redirect1",
        status: piStatus,
        amountReceived: 0,
        currency: "usd",
        metadata: { orderId: PI_ORDER },
      }));
      const { caller } = createCaller({
        actorHumanId: BUYER,
        repos: createRepos(true, { orders } as never),
        payments: { retrievePaymentIntent } as unknown as Ctx["payments"],
      });
      const caught = await caller.orders
        .confirmPayment({ paymentIntentId: "pi_redirect1" })
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect(caught).toMatchObject({ code: "CONFLICT" });
      // `createCaller` never runs the errorFormatter: run the router's own.
      const { data } = (
        t._config.errorFormatter as unknown as (opts: {
          shape: unknown;
          error: unknown;
        }) => { data: Record<string, unknown> }
      )({
        shape: { message: "x", code: -32009, data: { code: "CONFLICT", httpStatus: 409 } },
        error: caught,
      });
      expect(data.appCode).toBe("PAYMENT_NOT_SUCCEEDED");
      expect(data.meta).toMatchObject({ status: piStatus });
      expect(orders.markProcessingIfPending).not.toHaveBeenCalled();
    },
  );

  it("is rate-limited per buyer (10/60s) BEFORE any Stripe call", async () => {
    const consume = vi.fn(async (key: string) =>
      key === `order:confirmPayment:${BUYER}`
        ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
        : { allowed: true, remaining: 99, retryAfterSeconds: 0 },
    );
    const retrievePaymentIntent = vi.fn();
    const { caller } = createCaller({
      actorHumanId: BUYER,
      repos: createRepos(true),
      payments: { retrievePaymentIntent } as unknown as Ctx["payments"],
      rateLimit: withConsumeMany({ consume }) as unknown as Ctx["rateLimit"],
    });
    await expect(
      caller.orders.confirmPayment({ paymentIntentId: "pi_redirect1" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(
      `order:confirmPayment:${BUYER}`,
      10,
      60,
    );
    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });
});
