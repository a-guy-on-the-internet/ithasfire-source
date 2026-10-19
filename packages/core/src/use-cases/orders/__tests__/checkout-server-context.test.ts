import { describe, expect, it, vi } from "vitest";

import { createCheckout, createCheckoutInputSchema } from "../create-checkout";
import type { CreateCheckoutDeps } from "../create-checkout";
import {
  applyCheckoutServerContextToMetadata,
  checkoutServerContextSchema,
} from "../_shared/checkout-server-context";

/**
 * The embed binding (`metadata.embedId` on an embed order's PaymentIntent) is
 * what lets a guest release an order, and only through the embed that made
 * it. It must be impossible for a client to set: a forged binding would let
 * the secret of any order cancel that order through an embed.
 *
 * So it is NOT a field of `createCheckout`'s input (which transports build
 * from a client's body). It rides the use case's third, server-only argument.
 */

const EMBED_ID = "00000000-0000-4000-8000-0000000000e1";
const ACTOR = "00000000-0000-4000-8000-0000000000e2";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e3";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-0000000000e4";

const validInput = {
  actorHumanId: ACTOR,
  buyerHumanId: ACTOR,
  eventId: EVENT_ID,
  clientKey: "server-context-key",
  items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
  termsAccepted: true,
  refundPolicyAccepted: true,
};

describe("createCheckout input — the embed binding is not a field", () => {
  it("the input schema has no embedId key, so no transport deriving from it can accept one", () => {
    expect(Object.keys(createCheckoutInputSchema.shape)).not.toContain(
      "embedId",
    );
  });

  it("an embedId smuggled into the input is dropped by the parse, never carried", () => {
    const parsed = createCheckoutInputSchema.parse({
      ...validInput,
      embedId: EMBED_ID,
    });

    expect(parsed).not.toHaveProperty("embedId");
  });
});

describe("checkout server context", () => {
  it("accepts an embed id and nothing else", () => {
    expect(checkoutServerContextSchema.parse({ embedId: EMBED_ID })).toEqual({
      embedId: EMBED_ID,
    });
    expect(checkoutServerContextSchema.parse({})).toEqual({});
    expect(
      checkoutServerContextSchema.safeParse({ embedId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      checkoutServerContextSchema.safeParse({
        embedId: EMBED_ID,
        orderId: EMBED_ID,
      }).success,
    ).toBe(false);
  });

  it("writes embedId into the PaymentIntent metadata beside the keys already there", () => {
    const metadata: Record<string, string> = {
      orderId: "order-1",
      source: "primary",
    };

    const out = applyCheckoutServerContextToMetadata(metadata, {
      embedId: EMBED_ID,
    });

    expect(out).toBe(metadata);
    expect(metadata).toEqual({
      orderId: "order-1",
      source: "primary",
      embedId: EMBED_ID,
    });
  });

  it("adds no key at all for a checkout with no embed (the main checkout)", () => {
    const metadata: Record<string, string> = { orderId: "order-1" };

    applyCheckoutServerContextToMetadata(metadata, {});

    expect(metadata).toEqual({ orderId: "order-1" });
    expect(metadata).not.toHaveProperty("embedId");
    expect(metadata).not.toHaveProperty("receiptSecretHash");
  });

  it("accepts a receipt-secret hash only as lowercase hex SHA-256", () => {
    const hash = "a".repeat(64);
    expect(
      checkoutServerContextSchema.parse({ embedId: EMBED_ID, receiptSecretHash: hash }),
    ).toEqual({ embedId: EMBED_ID, receiptSecretHash: hash });
    for (const bad of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64), "a".repeat(65)]) {
      expect(
        checkoutServerContextSchema.safeParse({ receiptSecretHash: bad }).success,
      ).toBe(false);
    }
  });

  it("writes receiptSecretHash into the PaymentIntent metadata beside embedId", () => {
    const hash = "0123456789abcdef".repeat(4);
    const metadata: Record<string, string> = { orderId: "order-1" };

    applyCheckoutServerContextToMetadata(metadata, {
      embedId: EMBED_ID,
      receiptSecretHash: hash,
    });

    expect(metadata).toEqual({
      orderId: "order-1",
      embedId: EMBED_ID,
      receiptSecretHash: hash,
    });
    // Stripe's metadata value limit is 500 characters.
    expect(metadata.receiptSecretHash!.length).toBeLessThanOrEqual(500);
  });
});

describe("createCheckout input — the receipt-secret hash is not a field", () => {
  it("the input schema has no receiptSecretHash key, and a smuggled one is dropped", () => {
    expect(Object.keys(createCheckoutInputSchema.shape)).not.toContain(
      "receiptSecretHash",
    );
    const parsed = createCheckoutInputSchema.parse({
      ...validInput,
      receiptSecretHash: "a".repeat(64),
    });
    expect(parsed).not.toHaveProperty("receiptSecretHash");
  });
});

describe("createCheckout — the server context is validated before anything runs", () => {
  const untouchedDeps = () => {
    const get = vi.fn();
    const deps = {
      repos: {},
      payments: {},
      idempotency: { get, begin: vi.fn(), commit: vi.fn(), fail: vi.fn() },
      clock: { now: () => new Date("2026-10-11T12:00:00Z") },
    } as unknown as CreateCheckoutDeps;
    return { deps, get };
  };

  it.each([
    ["an embed id that is not a uuid", { embedId: "shop" }],
    ["a key it does not know", { embedId: EMBED_ID, source: "resale" }],
  ])("refuses %s as invalid input, before the idempotency read", async (_l, ctx) => {
    const { deps, get } = untouchedDeps();

    await expect(
      createCheckout(deps, validInput, ctx as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(get).not.toHaveBeenCalled();
  });
});
