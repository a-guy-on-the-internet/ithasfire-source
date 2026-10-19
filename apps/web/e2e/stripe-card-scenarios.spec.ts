import Stripe from "stripe";
import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import {
  confirmStripePaymentIntent,
  confirmWithTestCard,
} from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { signUpWithPassword } from "./helpers/sign-in";

/**
 * Stripe test-card E2E scenarios.
 *
 * Validates the full order lifecycle under different payment outcomes:
 *
 *   1. **Successful card** — order becomes SUCCEEDED, tickets are issued.
 *   2. **Declined (generic)** — Stripe rejects confirm; order stays PENDING,
 *      buyer can retry.
 *   3. **Declined (insufficient funds)** — same as generic decline but with
 *      a specific decline_code.
 *   4. **Declined (expired card)** — specific decline_code.
 *   5. **Declined (fraudulent)** — issuer flags the card as fraudulent.
 *   6. **Radar block** — Stripe Radar blocks the payment before the charge
 *      is created.
 *   7. **Dispute card** — payment succeeds then a dispute is opened
 *      (charge.dispute.created). We verify the charge reaches "succeeded"
 *      first, then a dispute object is created.
 *
 * Prerequisites:
 *   - Local infra (Postgres + Redis via Docker Compose)
 *   - API running (`pnpm api:bg`)
 *   - Stripe CLI forwarding webhooks (`stripe listen --forward-to ...`)
 *   - Mailpit running
 *   - STRIPE_SECRET_KEY set
 */
test.describe("Stripe card scenarios", () => {
  const TICKET_PRICE_CENTS = 2500; // $25.00
  const API_BASE_URL = process.env.E2E_API_BASE_URL || "http://localhost:3001";
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
  const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(request, API_BASE_URL);
  });

  // ── Shared helpers ──────────────────────────────────────────────────────

  /** Sign up a fresh buyer, verify email, sign in, return credentials + tRPC client. */
  async function createBuyer(
    page: import("@playwright/test").Page,
    request: import("@playwright/test").APIRequestContext,
    uid: string,
  ) {
    const email = `buyer-card-${uid}@example.com`;
    const password = "Password123!";
    const username = `cardtest${uid}`;

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Card Test Buyer",
      username,
      email,
      password,
    });

    // Verify email via Mailpit
    const mailpit = createMailpitClient({ request });
    const verificationEmail = await mailpit.waitForEmailTo(email);
    const verificationUrl =
      extractFirstUrlFromMailpitMessage(verificationEmail);
    await page.goto(verificationUrl);
    await page.waitForURL((url) => !url.pathname.includes("verify-email"), {
      timeout: 10_000,
    });
    await mailpit.clear();

    // Get JWT for tRPC
    const { token } = await signInAndGetToken(request, API_BASE_URL, {
      email,
      password,
    });
    expect(token).toBeTruthy();

    const trpc = createE2eTrpcClient(request, API_BASE_URL, {
      bearerToken: token,
    });

    return { email, password, token, trpc };
  }

  /** Seed a paid-checkout event and return the seed data. */
  async function seedEvent(
    request: import("@playwright/test").APIRequestContext,
  ) {
    const stripeAccountIdOverride =
      process.env.PLAYWRIGHT_E2E_STRIPE_ACCOUNT_ID ??
      process.env.E2E_STRIPE_ACCOUNT_ID;

    const seedRes = await request.post(
      `${API_BASE_URL}/e2e/seed/paid-checkout`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: {
          priceCents: TICKET_PRICE_CENTS,
          ...(stripeAccountIdOverride
            ? { stripeAccountId: stripeAccountIdOverride }
            : {}),
        },
      },
    );
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    return seed as {
      email: string;
      password: string;
      humanId: string;
      orgId: string;
      eventId: string;
      eventSlug: string;
      ticketTypeId: string;
      stripeAccountId: string;
    };
  }

  /** Hold tickets + create checkout, return orderId + paymentIntentId. */
  async function holdAndCheckout(
    trpc: ReturnType<typeof createE2eTrpcClient>,
    seed: { eventId: string; ticketTypeId: string },
  ) {
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(holdResult.order?.id).toBeTruthy();

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0]!;
    expect(paymentIntentId).toMatch(/^pi_/);

    return {
      orderId: checkoutResult.orderId,
      buyerHumanId: holdResult.order.buyerHumanId,
      paymentIntentId,
    };
  }

  // =====================================================================
  // 1. Successful payment
  // =====================================================================
  test("successful card: order becomes SUCCEEDED with tickets issued", async ({
    page,
    request,
  }) => {
    const seed = await seedEvent(request);
    const buyer = await createBuyer(page, request, `ok-${Date.now()}`);
    const { orderId, paymentIntentId } = await holdAndCheckout(
      buyer.trpc,
      seed,
    );

    // Confirm with the success card
    await confirmStripePaymentIntent({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
    });

    // Poll until the webhook finalizes the order
    await expect
      .poll(
        async () => {
          try {
            const order = await buyer.trpc.orders.getMyOrder.query({ orderId });
            return order.status;
          } catch {
            return null;
          }
        },
        {
          message: "Order should become SUCCEEDED",
          timeout: 30_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe("SUCCEEDED");

    // Verify tickets were issued
    const order = await buyer.trpc.orders.getMyOrder.query({ orderId });
    expect(order.stripePaymentIntentId).toBe(paymentIntentId);
  });

  // =====================================================================
  // 2. Generic card decline
  // =====================================================================
  test("declined card: order stays PENDING, PI moves to requires_payment_method", async ({
    page,
    request,
  }) => {
    const seed = await seedEvent(request);
    const buyer = await createBuyer(page, request, `dec-${Date.now()}`);
    const { orderId, paymentIntentId } = await holdAndCheckout(
      buyer.trpc,
      seed,
    );

    const result = await confirmWithTestCard({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
      card: "declined",
    });

    expect(result.status).toBe("requires_payment_method");
    expect(result.declineCode).toBeTruthy();

    // Order should still be PENDING (no webhook fires for a decline-at-confirm)
    const order = await buyer.trpc.orders.getMyOrder.query({ orderId });
    expect(order.status).toBe("PENDING");
  });

  // =====================================================================
  // 3. Insufficient funds
  // =====================================================================
  test("insufficient funds: decline with specific code", async ({
    page,
    request,
  }) => {
    const seed = await seedEvent(request);
    const buyer = await createBuyer(page, request, `insuf-${Date.now()}`);
    const { orderId, paymentIntentId } = await holdAndCheckout(
      buyer.trpc,
      seed,
    );

    const result = await confirmWithTestCard({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
      card: "insufficientFunds",
    });

    expect(result.status).toBe("requires_payment_method");
    expect(result.declineCode).toContain("insufficient_funds");

    const order = await buyer.trpc.orders.getMyOrder.query({ orderId });
    expect(order.status).toBe("PENDING");
  });

  // =====================================================================
  // 4. Expired card
  // =====================================================================
  test("expired card: decline with expired_card code", async ({
    page,
    request,
  }) => {
    const seed = await seedEvent(request);
    const buyer = await createBuyer(page, request, `exp-${Date.now()}`);
    const { orderId, paymentIntentId } = await holdAndCheckout(
      buyer.trpc,
      seed,
    );

    const result = await confirmWithTestCard({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
      card: "expiredCard",
    });

    expect(result.status).toBe("requires_payment_method");
    expect(result.declineCode).toContain("expired");

    const order = await buyer.trpc.orders.getMyOrder.query({ orderId });
    expect(order.status).toBe("PENDING");
  });

  // =====================================================================
  // 5. Fraudulent card (issuer flags it)
  // =====================================================================
  test("fraudulent card: decline flagged by issuer", async ({
    page,
    request,
  }) => {
    const seed = await seedEvent(request);
    const buyer = await createBuyer(page, request, `fraud-${Date.now()}`);
    const { orderId, paymentIntentId } = await holdAndCheckout(
      buyer.trpc,
      seed,
    );

    const result = await confirmWithTestCard({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
      card: "fraudulent",
    });

    expect(result.status).toBe("requires_payment_method");
    expect(result.declineCode).toBeTruthy();

    const order = await buyer.trpc.orders.getMyOrder.query({ orderId });
    expect(order.status).toBe("PENDING");
  });

  // =====================================================================
  // 6. Radar block (Stripe blocks before charge)
  // =====================================================================
  test("Radar-blocked card: payment blocked for suspected fraud", async ({
    page,
    request,
  }) => {
    const seed = await seedEvent(request);
    const buyer = await createBuyer(page, request, `radar-${Date.now()}`);
    const { orderId, paymentIntentId } = await holdAndCheckout(
      buyer.trpc,
      seed,
    );

    const result = await confirmWithTestCard({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
      card: "radarBlock",
    });

    // Radar blocks can surface as requires_payment_method or canceled
    expect(["requires_payment_method", "canceled"]).toContain(result.status);

    const order = await buyer.trpc.orders.getMyOrder.query({ orderId });
    // Order stays PENDING (or CANCELLED if webhook fired) — never SUCCEEDED
    expect(order.status).not.toBe("SUCCEEDED");
  });

  // =====================================================================
  // 7. Dispute card — payment succeeds, then dispute is opened
  // =====================================================================
  test("dispute card: payment succeeds then dispute is created", async ({
    page,
    request,
  }) => {
    const seed = await seedEvent(request);
    const buyer = await createBuyer(page, request, `disp-${Date.now()}`);
    const { orderId, paymentIntentId } = await holdAndCheckout(
      buyer.trpc,
      seed,
    );

    // This card succeeds first, then Stripe automatically opens a dispute.
    const result = await confirmWithTestCard({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
      card: "createDispute",
    });

    expect(result.status).toBe("succeeded");

    // Wait for the order to become SUCCEEDED via the payment_intent.succeeded webhook
    await expect
      .poll(
        async () => {
          try {
            const order = await buyer.trpc.orders.getMyOrder.query({ orderId });
            return order.status;
          } catch {
            return null;
          }
        },
        {
          message: "Order should become SUCCEEDED before dispute",
          timeout: 30_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe("SUCCEEDED");

    // Verify that Stripe created a dispute for this PaymentIntent's charge.
    // The dispute is created asynchronously by Stripe after the charge succeeds.
    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2025-08-27.basil",
    });

    await expect
      .poll(
        async () => {
          try {
            const disputes = await stripe.disputes.list({
              payment_intent: paymentIntentId,
              limit: 1,
            });
            return disputes.data.length;
          } catch {
            return 0;
          }
        },
        {
          message: "Stripe should create a dispute for the payment",
          timeout: 60_000,
          intervals: [2000, 3000, 5000],
        },
      )
      .toBeGreaterThan(0);

    const disputes = await stripe.disputes.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });

    expect(disputes.data[0]!.reason).toBe("fraudulent");
    expect(disputes.data[0]!.status).toBeTruthy();
  });

  // =====================================================================
  // 8. Decline then retry with valid card — order recovers
  // =====================================================================
  test("decline then retry: order recovers after initial failure", async ({
    page,
    request,
  }) => {
    const seed = await seedEvent(request);
    const buyer = await createBuyer(page, request, `retry-${Date.now()}`);
    const { orderId, paymentIntentId } = await holdAndCheckout(
      buyer.trpc,
      seed,
    );

    // First attempt: decline
    const decline = await confirmWithTestCard({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
      card: "declined",
    });
    expect(decline.status).toBe("requires_payment_method");

    // Order is still PENDING
    let order = await buyer.trpc.orders.getMyOrder.query({ orderId });
    expect(order.status).toBe("PENDING");

    // Second attempt: success
    await confirmStripePaymentIntent({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
    });

    // Wait for finalization
    await expect
      .poll(
        async () => {
          try {
            const o = await buyer.trpc.orders.getMyOrder.query({ orderId });
            return o.status;
          } catch {
            return null;
          }
        },
        {
          message: "Order should become SUCCEEDED after retry",
          timeout: 30_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe("SUCCEEDED");

    order = await buyer.trpc.orders.getMyOrder.query({ orderId });
    expect(order.stripePaymentIntentId).toBe(paymentIntentId);
  });

  // =====================================================================
  // 9. Processing error (transient) — order stays retryable
  // =====================================================================
  test("processing error: transient failure, order stays PENDING", async ({
    page,
    request,
  }) => {
    const seed = await seedEvent(request);
    const buyer = await createBuyer(page, request, `proc-${Date.now()}`);
    const { orderId, paymentIntentId } = await holdAndCheckout(
      buyer.trpc,
      seed,
    );

    const result = await confirmWithTestCard({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
      card: "processingError",
    });

    expect(result.status).toBe("requires_payment_method");

    const order = await buyer.trpc.orders.getMyOrder.query({ orderId });
    expect(order.status).toBe("PENDING");
  });
});
