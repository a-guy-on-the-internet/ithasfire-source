import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

import { createApp } from "../src/app";

/**
 * Smoke test for the Stripe webhook route.
 *
 * This verifies:
 * - Route is registered: POST /webhooks/stripe
 * - Raw body is preserved for signature verification
 * - Signature verification via stripe.webhooks.constructEvent works
 *
 * It does NOT hit real Stripe.
 */

describe("stripe webhook route", () => {
  const webhookSecret = "whsec_test_local";

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    // Needed by verify code path (client init). Not a real-looking key.
    process.env.STRIPE_SECRET_KEY = "stripe-mock";
  });

  afterAll(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("accepts a signed payment_intent.succeeded event", async () => {
    const app = await createApp();

    // Stub finalizePaymentIntent side effects indirectly by stubbing deps.
    // We only need to prove signature verification + handler plumbing works.
    const mark = vi.spyOn(app.deps.trpc.idempotency, "begin");

    const stripe = new Stripe("stripe-mock", {
      apiVersion: "2025-08-27.basil" as any,
    });

    const payloadObj = {
      id: "evt_test_webhook",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_123456789",
          status: "succeeded",
          amount_received: 1000,
          currency: "usd",
          metadata: {
            orderId: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
    };

    const payload = JSON.stringify(payloadObj);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });

    // The route should have attempted to process the event (begin lock).
    expect(mark).toHaveBeenCalled();

    await app.close();
  });
});
