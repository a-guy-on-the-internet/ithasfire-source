import { beforeEach, describe, expect, it, vi } from "vitest";

import * as checkoutModule from "@th/core/use-cases/orders/create-checkout";
import { createTestLogger } from "@th/test-utils";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";

import type { Ctx } from "../../context";
import { router as trpcRouter } from "../../init";
import { router } from "../../trpc";
import { ordersRouter } from "../orders";

/**
 * A guest may release an embed order only through the embed that made it,
 * and that embed is read from the PaymentIntent's `metadata.embedId`. If a
 * signed-in client could set that key on its own order through
 * `orders.createCheckout`, it could mark a main-checkout order as an embed's.
 *
 * It cannot: the binding is `createCheckout`'s third, server-only argument,
 * and this procedure passes two. In its own file because
 * `orders.test.ts` carries another session's uncommitted work.
 */

const ACTOR = "11111111-1111-4111-8111-111111111111";
const EMBED_ID = "00000000-0000-4000-8000-0000000000f1";

const buildCtx = (): Ctx =>
  ({
    repos: {
      humans: {
        getByIdWithIdentity: vi.fn(async () => ({
          identity: { emailVerified: true },
        })),
      },
    },
    payments: {},
    idempotency: {},
    clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
    logger: createTestLogger(),
    notify: vi.fn(),
    rateLimit: withConsumeMany({
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterSeconds: 0,
      })),
    }),
    auth: { userId: "user-1", sessionId: null, token: "token" },
    authToken: "token",
    apiKey: null,
    actorHumanId: ACTOR,
    viewerLocation: null,
    clientIp: "203.0.113.44",
    userAgent: "vitest",
    eventUnlockSecret: null,
    cookieHeader: null,
  }) as unknown as Ctx;

const checkoutResult = {
  orderId: "123e4567-e89b-12d3-a456-426614174000",
  clientSecret: "secret_test", // gitleaks:allow (fake test fixture)
  amountGrossCents: 2000,
  feesPlatformCents: 100,
  buyerFeesCents: 100,
  processorFeeCents: 50,
  feeMode: "ABSORB" as const,
  taxAmountCents: 0,
  creditAppliedCents: 0,
  holdExpiresAt: "2026-01-01T00:15:00.000Z",
};

const validInput = {
  eventId: "33333333-3333-4333-8333-333333333333",
  clientKey: "checkout-key",
  items: [{ ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 }],
  refundPolicyAccepted: true,
};

describe("orders.createCheckout — a client cannot set the embed binding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["a top-level embedId", { embedId: EMBED_ID }],
    ["a serverContext object", { serverContext: { embedId: EMBED_ID } }],
    ["a metadata object", { metadata: { embedId: EMBED_ID } }],
  ])(
    "%s in the request reaches createCheckout neither as input nor as the server-only argument",
    async (_label, smuggled) => {
      const spy = vi
        .spyOn(checkoutModule, "createCheckout")
        .mockResolvedValue(checkoutResult);
      const caller = trpcRouter({ orders: router(ordersRouter) }).createCaller(
        buildCtx(),
      );

      await caller.orders.createCheckout({
        ...validInput,
        ...smuggled,
      } as never);

      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0]!;
      // Two arguments: deps and input. The third (server context) is never
      // passed by this procedure, so its embed id is always absent.
      expect(args).toHaveLength(2);
      const forwarded = args[1] as Record<string, unknown>;
      expect(forwarded).not.toHaveProperty("embedId");
      expect(forwarded).not.toHaveProperty("serverContext");
      expect(forwarded).not.toHaveProperty("metadata");
      expect(JSON.stringify(forwarded)).not.toContain(EMBED_ID);
      // The request itself went through as the signed-in buyer's.
      expect(forwarded).toMatchObject({
        actorHumanId: ACTOR,
        buyerHumanId: ACTOR,
        eventId: validInput.eventId,
      });
    },
  );
});

describe("orders.createCheckout — the embed clientKey namespace is reserved", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["embed:checkout-key", "embed:emb_1760000000000_abcdefgh"])(
    "a client key %s is refused as BAD_REQUEST before createCheckout runs",
    async (clientKey) => {
      const spy = vi
        .spyOn(checkoutModule, "createCheckout")
        .mockResolvedValue(checkoutResult);
      const caller = trpcRouter({ orders: router(ordersRouter) }).createCaller(
        buildCtx(),
      );

      await expect(
        caller.orders.createCheckout({ ...validInput, clientKey }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each([
    "123e4567-e89b-12d3-a456-426614174000",
    "my-embed:key-1",
    "Embed:checkout-key",
  ])("a client key %s outside the namespace goes through", async (clientKey) => {
    const spy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue(checkoutResult);
    const caller = trpcRouter({ orders: router(ordersRouter) }).createCaller(
      buildCtx(),
    );

    await caller.orders.createCheckout({ ...validInput, clientKey });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toMatchObject({ clientKey });
  });
});
