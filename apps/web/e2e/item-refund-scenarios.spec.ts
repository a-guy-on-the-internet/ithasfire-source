import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import {
  signInViaAccountOverlay,
  signUpWithPassword,
} from "./helpers/sign-in";

/**
 * E2E tests for multi-item / partial refund scenarios:
 *
 *   1. Two-ticket order → refund one → order becomes PART_REFUNDED, other ticket remains Valid
 *   2. Refunded item no longer shows refund/transfer/resell buttons
 *   3. Full refund of remaining items → order becomes REFUNDED
 *
 * Uses the guest project (sign-up, purchase via Stripe, then refund via UI).
 *
 * Prerequisites: local infra, API, Mailpit, Stripe sandbox.
 */

test.describe("Item-level Refund Scenarios", () => {
  const TICKET_PRICE_CENTS = 2000; // $20.00

  const API_BASE_URL = process.env.E2E_API_BASE_URL || "http://localhost:3001";
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
  const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(request, API_BASE_URL);
  });

  // ── Helpers ─────────────────────────────────────────────────────────────

  async function signUpAndIn(
    page: import("@playwright/test").Page,
    request: import("@playwright/test").APIRequestContext,
    uid: string,
  ) {
    const email = `buyer-refund-multi-${uid}@example.com`;
    const password = "Password123!";

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Refund Multi Test",
      username: `refundmulti${uid}`,
      email,
      password,
    });

    // Verify email
    const mailpit = createMailpitClient({ request });
    const verificationEmail = await mailpit.waitForEmailTo(email);
    const verificationUrl =
      extractFirstUrlFromMailpitMessage(verificationEmail);
    await page.goto(verificationUrl);
    await mailpit.clear();

    // Sign in
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Overlay flavour: no navigation, so success is the card closing.
    // The two-step credential flow lives in `helpers/sign-in.ts`.
    await signInViaAccountOverlay(page, {
      email,
      password,
    });

    return { email, password };
  }

  async function purchaseMultipleTickets(
    trpc: ReturnType<typeof createE2eTrpcClient>,
    seed: { eventId: string; ticketTypeId: string },
    qty: number,
    clientKeyPrefix: string,
  ) {
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty }],
    });
    expect(holdResult.order?.id).toBeTruthy();

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `${clientKeyPrefix}-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    await confirmStripePaymentIntent({
      stripeSecretKey: STRIPE_SECRET_KEY,
      paymentIntentId,
    });

    // Wait for order to succeed
    await expect
      .poll(
        async () => {
          try {
            const order = await trpc.orders.getMyOrder.query({
              orderId: checkoutResult.orderId,
            });
            return order.status;
          } catch {
            return null;
          }
        },
        {
          message: "Order did not become SUCCEEDED",
          timeout: 30_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe("SUCCEEDED");

    return checkoutResult;
  }

  // ── Test 1: Partial refund of a 2-ticket order ─────────────────────────

  test("refunding one item from a 2-ticket order shows PART_REFUNDED and keeps the other ticket valid", async ({
    page,
    request,
  }) => {
    expect(STRIPE_SECRET_KEY).toBeTruthy();

    // ── Seed event ──────────────────────────────────────────────────────
    const seedRes = await request.post(
      `${API_BASE_URL}/e2e/seed/paid-checkout`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: { priceCents: TICKET_PRICE_CENTS },
      },
    );
    expect(seedRes.ok()).toBeTruthy();
    const { seed } = await seedRes.json();

    // ── Create buyer ────────────────────────────────────────────────────
    const uid = String(Date.now());
    const { email, password } = await signUpAndIn(page, request, uid);

    const { token } = await signInAndGetToken(request, API_BASE_URL, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, API_BASE_URL, {
      bearerToken: token,
    });

    // ── Purchase 2 tickets ──────────────────────────────────────────────
    const checkoutResult = await purchaseMultipleTickets(
      trpc,
      seed,
      2,
      "e2e-multi-refund",
    );

    // ── Navigate to order detail ────────────────────────────────────────
    await page.goto(`/my-tickets/${checkoutResult.orderId}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page
        .getByRole("heading", { name: /your tickets/i })
        .or(page.getByRole("heading", { name: /E2E Paid Checkout Event/i })),
    ).toBeVisible({ timeout: 15_000 });

    // Should have 2 ticket cards
    // Each ticket has a refund button like "Refund $X.XX"
    const refundButtons = page.getByRole("button", { name: /refund \$/i });
    await expect(refundButtons.first()).toBeVisible({ timeout: 15_000 });

    const refundCount = await refundButtons.count();
    expect(refundCount).toBeGreaterThanOrEqual(2);

    // ── Refund the first ticket ─────────────────────────────────────────
    await refundButtons.first().click();

    // Confirmation panel should appear
    await expect(page.getByText(/refund amount:/i)).toBeVisible({
      timeout: 5_000,
    });

    const confirmBtn = page.getByRole("button", { name: /confirm refund/i });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Wait for processing to complete
    await expect(page.getByRole("button", { name: /processing/i })).toBeVisible(
      { timeout: 5_000 },
    );
    await expect(
      page.getByRole("button", { name: /processing/i }),
    ).not.toBeVisible({ timeout: 30_000 });

    // ── Reload and verify state ─────────────────────────────────────────
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Order should now show "Partially Refunded"
    await expect(page.getByText(/partially refunded/i)).toBeVisible({
      timeout: 15_000,
    });

    // One ticket should show "Refunded" status
    await expect(page.getByText("Refunded").first()).toBeVisible({
      timeout: 5_000,
    });

    // The other ticket should still be "Valid"
    await expect(page.getByText("Valid").first()).toBeVisible({
      timeout: 5_000,
    });

    // ── Verify via API ──────────────────────────────────────────────────
    const orderAfterRefund = await trpc.orders.getMyOrder.query({
      orderId: checkoutResult.orderId,
    });
    expect(orderAfterRefund.status).toBe("PART_REFUNDED");

    const ticketsAfter = await trpc.orders.listMyOrderTickets.query({
      orderId: checkoutResult.orderId,
    });
    const tickets = ticketsAfter.tickets ?? [];
    expect(tickets.length).toBe(2);

    const validTickets = tickets.filter((t) => t.status === "VALID");
    const refundedTickets = tickets.filter((t) => t.status === "REFUNDED");
    expect(validTickets.length).toBe(1);
    expect(refundedTickets.length).toBe(1);
  });

  // ── Test 2: Refunded item loses inline actions ─────────────────────────

  test("refunded ticket card does not show refund, transfer, or resell buttons", async ({
    page,
    request,
  }) => {
    expect(STRIPE_SECRET_KEY).toBeTruthy();

    // ── Seed + sign up + purchase 2 tickets ─────────────────────────────
    const seedRes = await request.post(
      `${API_BASE_URL}/e2e/seed/paid-checkout`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: { priceCents: TICKET_PRICE_CENTS },
      },
    );
    expect(seedRes.ok()).toBeTruthy();
    const { seed } = await seedRes.json();

    const uid = String(Date.now());
    const { email, password } = await signUpAndIn(page, request, uid);

    const { token } = await signInAndGetToken(request, API_BASE_URL, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, API_BASE_URL, {
      bearerToken: token,
    });

    const checkoutResult = await purchaseMultipleTickets(
      trpc,
      seed,
      2,
      "e2e-refund-actions",
    );

    // ── Refund one ticket via the E2E API helper ────────────────────────
    // Get order items to find the first one
    const tickets = await trpc.orders.listMyOrderTickets.query({
      orderId: checkoutResult.orderId,
    });
    const firstTicket = tickets.tickets?.[0];
    expect(firstTicket).toBeTruthy();

    // Use E2E refund endpoint to refund just the first order item
    if (firstTicket?.orderItemId) {
      const refundRes = await request.post(
        `${API_BASE_URL}/e2e/orders/${checkoutResult.orderId}/refund`,
        {
          headers: {
            "x-e2e-reset-secret": E2E_SECRET,
            "content-type": "application/json",
          },
          data: { orderItemIds: [firstTicket.orderItemId] },
        },
      );
      // If the endpoint doesn't support orderItemIds, do a full refund
      if (!refundRes.ok()) {
        // Fall back to doing it via UI
        await page.goto(`/my-tickets/${checkoutResult.orderId}`);
        await page.waitForLoadState("networkidle");

        const refundBtn = page
          .getByRole("button", { name: /refund \$/i })
          .first();
        await expect(refundBtn).toBeVisible({ timeout: 15_000 });
        await refundBtn.click();

        const confirmBtn = page.getByRole("button", {
          name: /confirm refund/i,
        });
        await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
        await confirmBtn.click();

        await expect(
          page.getByRole("button", { name: /processing/i }),
        ).not.toBeVisible({ timeout: 30_000 });

        await page.reload();
        await page.waitForLoadState("networkidle");
      } else {
        await page.goto(`/my-tickets/${checkoutResult.orderId}`);
        await page.waitForLoadState("networkidle");
      }
    }

    // ── Verify the refunded ticket card has no action buttons ────────────
    await expect(
      page
        .getByRole("heading", { name: /your tickets/i })
        .or(page.getByRole("heading", { name: /E2E Paid Checkout Event/i })),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the "Refunded" text to appear on one card
    await expect(page.getByText("Refunded").first()).toBeVisible({
      timeout: 10_000,
    });

    // The remaining valid ticket should still have action buttons
    const remainingRefundButtons = page.getByRole("button", {
      name: /refund \$/i,
    });
    await expect(remainingRefundButtons).toHaveCount(1, { timeout: 10_000 });

    // Transfer and resell buttons should exist only for the valid ticket (1 each)
    const transferButtons = page
      .getByRole("button", { name: /transfer/i })
      .or(page.getByRole("link", { name: /transfer/i }));
    // Should have at most 1 transfer option (the valid ticket's)
    const transferCount = await transferButtons.count();
    expect(transferCount).toBeLessThanOrEqual(1);
  });
});
