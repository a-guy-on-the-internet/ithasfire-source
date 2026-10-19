import { expect, test } from "./fixtures";
import Stripe from "stripe";
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
 * E2E test for My Tickets page and Refund flow:
 *
 *   1. Seed event with ticket type
 *   2. Sign up and verify email
 *   3. Buy a ticket
 *   4. Navigate to /my-tickets and verify order appears
 *   5. Click into order detail and verify QR code displays
 *   6. Navigate to refund page and verify eligibility check
 *   7. Execute refund via UI
 *   8. Verify refund in Stripe
 *
 * This test validates the buyer-facing ticket management and refund UI.
 */
test.describe.serial("My Tickets and Refund Flow", () => {
  const TICKET_PRICE_CENTS = 5000; // $50.00

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(
      request,
      process.env.E2E_API_BASE_URL || "http://localhost:3001",
    );
  });

  test("buyer can view tickets and request refund through UI", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    expect(stripeSecretKey).toBeTruthy();

    const stripe = new Stripe(stripeSecretKey);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Seed event
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📦 PHASE 1: Seeding event...");

    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: {
        priceCents: TICKET_PRICE_CENTS,
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    expect(seed.ticketTypeId).toBeTruthy();
    console.log(`✓ Seeded event: ${seed.eventId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Create & authenticate buyer
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n👤 PHASE 2: Creating and authenticating buyer...");

    const uniqueId = Date.now();
    const email = `buyer-mytickets-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyermytickets${uniqueId}`;

    // Sign up via UI
    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "My Tickets Test Buyer",
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
    await mailpit.clear();

    // Sign in via browser UI to establish browser session
    // The /sign-in page may redirect to home, so navigate to home and click navbar sign-in
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Overlay flavour: no navigation, so success is the card closing.
    // The two-step credential flow lives in `helpers/sign-in.ts`.
    await signInViaAccountOverlay(page, {
      email,
      password,
    });

    // Also get a JWT token for API calls via the standalone request context
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    expect(token).toBeTruthy();

    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });
    console.log(`✓ Buyer authenticated: ${email}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3: Purchase ticket via tRPC
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 3: Purchasing ticket...");

    // Hold tickets
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(holdResult.order?.id).toBeTruthy();
    console.log(`✓ Ticket held, order: ${holdResult.order.id}`);

    // Create checkout
    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-mytickets-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    console.log(`✓ Checkout created, PI: ${paymentIntentId}`);

    // Confirm payment
    await confirmStripePaymentIntent({
      stripeSecretKey,
      paymentIntentId,
    });
    console.log(`✓ Payment confirmed`);

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
          message: "Order did not become SUCCEEDED within timeout",
          timeout: 30_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe("SUCCEEDED");
    console.log(`✓ Order succeeded: ${checkoutResult.orderId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 4: Navigate to My Tickets page and verify order appears
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📋 PHASE 4: Navigating to My Tickets page...");

    // Browser should still be signed in from PHASE 2
    await page.goto("/my-tickets");
    await page.waitForLoadState("networkidle");

    // Should see the page heading — "My events" since the /saved watchlist
    // merged into this route (2026-08-31); the URL is unchanged.
    await expect(
      page.getByRole("heading", { name: /my events/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Should see the order card with event name
    const orderCard = page.locator('[data-testid="order-card"]').first();
    // If no test id, look for the event name text
    await expect(
      page.getByText(/E2E Paid Checkout Event/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    console.log(`✓ My Tickets page loaded with order`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5: Click into order detail and verify QR code displays
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 5: Viewing order detail...");

    // Click on the order to view details (it's a button styled as a link via Tamagui)
    await page
      .getByRole("button", { name: /view tickets/i })
      .first()
      .click();
    await page.waitForURL((url) => url.pathname.includes("/my-tickets/"), {
      timeout: 10_000,
    });

    // Verify we're on the order detail page (use first() since event name appears in both h2 and h4)
    await expect(
      page.getByRole("heading", { name: /E2E Paid Checkout Event/i }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Verify QR code is displayed (SVG element from qrcode.react)
    const qrCode = page
      .locator("svg")
      .filter({ has: page.locator("path") })
      .first();
    await expect(qrCode).toBeVisible({ timeout: 10_000 });

    // Verify ticket code is displayed
    await expect(page.getByText(/ticket code/i)).toBeVisible();

    // Verify "Request Refund" button is visible for succeeded orders (it's a button styled as a link via Tamagui)
    const refundButton = page.getByRole("button", { name: /request refund/i });
    await expect(refundButton).toBeVisible({ timeout: 5_000 });

    console.log(`✓ Order detail page loaded with QR code and refund button`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 6: Navigate to refund page and verify eligibility
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n💰 PHASE 6: Checking refund eligibility...");

    await refundButton.click();
    await page.waitForURL((url) => url.pathname.includes("/refund"), {
      timeout: 10_000,
    });

    // Verify refund page loaded
    await expect(
      page.getByRole("heading", { name: /request refund/i }),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Wait for eligibility check to complete
    await expect(
      page.getByText(/checking refund eligibility/i),
    ).not.toBeVisible({ timeout: 30_000 });

    // Should show "Eligible for Refund" since event hasn't started
    await expect(page.getByText(/eligible for refund/i)).toBeVisible({
      timeout: 10_000,
    });

    // Verify fee breakdown is displayed (use first() since labels appear twice: as label and in explanation)
    await expect(page.getByText(/amount paid/i).first()).toBeVisible();
    await expect(
      page.getByText(/payment processing fee/i).first(),
    ).toBeVisible();
    await expect(page.getByText(/you will receive/i).first()).toBeVisible();

    // Verify confirm refund button is enabled
    const confirmRefundButton = page.getByRole("button", {
      name: /confirm refund/i,
    });
    await expect(confirmRefundButton).toBeVisible({ timeout: 5_000 });
    await expect(confirmRefundButton).toBeEnabled();

    console.log(`✓ Refund page loaded, order is eligible for refund`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 7: Execute refund via UI
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🔄 PHASE 7: Executing refund via UI...");

    // Click confirm refund
    await confirmRefundButton.click();

    // Wait for refund to process (button shows "Processing..." - use button role to be specific)
    await expect(page.getByRole("button", { name: /processing/i })).toBeVisible(
      { timeout: 5_000 },
    );

    // Wait for success message
    await expect(page.getByText(/refund processed/i)).toBeVisible({
      timeout: 30_000,
    });

    // Verify success details
    await expect(page.getByText(/your refund of/i)).toBeVisible();
    await expect(page.getByText(/5-10 business days/i)).toBeVisible();

    console.log(`✓ Refund executed successfully via UI`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 8: Verify refund in Stripe
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n✅ PHASE 8: Verifying refund in Stripe...");

    // Get the refund from Stripe by listing refunds for the payment intent
    const refunds = await stripe.refunds.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });

    expect(refunds.data.length).toBe(1);
    const refund = refunds.data[0];
    expect(refund.status).toBe("succeeded");
    expect(refund.amount).toBeGreaterThan(0);

    console.log(`✓ Stripe Refund verified:`);
    console.log(`  ID: ${refund.id}`);
    console.log(`  Amount: ${refund.amount} cents`);
    console.log(`  Status: ${refund.status}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 9: Verify order status changed
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🔍 PHASE 9: Verifying order status...");

    const orderAfterRefund = await trpc.orders.getMyOrder.query({
      orderId: checkoutResult.orderId,
    });
    // Refund minus Stripe fees = PART_REFUNDED
    expect(orderAfterRefund.status).toBe("PART_REFUNDED");

    console.log(`✓ Order status: ${orderAfterRefund.status}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 10: Navigate back to My Tickets and verify status changed
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📋 PHASE 10: Verifying My Tickets shows updated status...");

    // It's a button styled as link (Tamagui pattern)
    await page.getByRole("button", { name: /back to my tickets/i }).click();
    await page.waitForURL("/my-tickets", { timeout: 10_000 });

    // Reload to ensure we get fresh data (works around stale tRPC cache)
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Should show refunded status - use .first() since "Confirmed" text may still be in DOM
    await expect(
      page.getByText(/partially refunded/i).or(page.getByText(/^Refunded$/i)),
    ).toBeVisible({ timeout: 10_000 });

    console.log(`✓ My Tickets shows refunded status`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 11: Verify refund page shows not eligible for already-refunded order
    // ─────────────────────────────────────────────────────────────────────────
    console.log(
      "\n🔒 PHASE 11: Verifying refund blocked for already-refunded order...",
    );

    // Navigate back to refund page - should show not eligible
    await page.goto(`/my-tickets/${checkoutResult.orderId}/refund`);
    await page.waitForLoadState("networkidle");

    // Wait for eligibility check loading to disappear
    await expect(
      page.getByText(/checking refund eligibility/i),
    ).not.toBeVisible({ timeout: 30_000 });

    // Should show not eligible status
    await expect(page.getByText("Not Eligible for Refund")).toBeVisible({
      timeout: 10_000,
    });

    // Should show "already been refunded" reason
    await expect(
      page.getByText("This order has already been refunded."),
    ).toBeVisible({ timeout: 5_000 });

    // "Refund Not Available" button should be visible and disabled
    const disabledRefundButton = page.getByRole("button", {
      name: "Refund Not Available",
    });
    await expect(disabledRefundButton).toBeVisible({ timeout: 5_000 });
    await expect(disabledRefundButton).toBeDisabled();

    console.log(`✓ Refund correctly blocked for already-refunded order`);

    // ─────────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(60));
    console.log("✅ MY TICKETS & REFUND FLOW TEST PASSED!");
    console.log("═".repeat(60));
    console.log(`
Summary:
  Order ID:         ${checkoutResult.orderId}
  Payment Intent:   ${paymentIntentId}
  Refund ID:        ${refund.id}
  Refund Amount:    ${refund.amount} cents
  Final Status:     ${orderAfterRefund.status}
`);
  });

  test("refund page shows not eligible after event starts", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    expect(stripeSecretKey).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────────────
    // Seed event that starts in the past
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📦 Seeding event that already started...");

    const pastStartDate = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString(); // Yesterday

    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: {
        priceCents: TICKET_PRICE_CENTS,
        startsAt: pastStartDate,
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────────────
    // Create buyer and purchase ticket
    // ─────────────────────────────────────────────────────────────────────────
    const uniqueId = Date.now();
    const email = `buyer-pastevt-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyerpastevt${uniqueId}`;

    // Sign up
    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Past Event Buyer",
      username,
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

    // Sign in via browser (needed for navigating to protected pages)
    await page.goto("/");
    // Overlay flavour: no navigation, so success is the card closing.
    // The two-step credential flow lives in `helpers/sign-in.ts`.
    await signInViaAccountOverlay(page, {
      email,
      password,
    });

    // Sign in via API
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });

    // Purchase ticket
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-pastevt-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    await confirmStripePaymentIntent({ stripeSecretKey, paymentIntentId });

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
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe("SUCCEEDED");

    // ─────────────────────────────────────────────────────────────────────────
    // Navigate to refund page and verify not eligible
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n💰 Checking refund eligibility for past event...");

    // Navigate directly to refund page
    await page.goto(`/my-tickets/${checkoutResult.orderId}/refund`);
    await page.waitForLoadState("networkidle");

    // Wait for eligibility check loading to disappear
    await expect(
      page.getByText(/checking refund eligibility/i),
    ).not.toBeVisible({ timeout: 30_000 });

    // Should show not eligible because event has started
    await expect(page.getByText("Not Eligible for Refund")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText(
        "The event has already started. Refunds are no longer available.",
      ),
    ).toBeVisible({ timeout: 5_000 });

    // "Refund Not Available" button should be visible and disabled
    const disabledButton = page.getByRole("button", {
      name: "Refund Not Available",
    });
    await expect(disabledButton).toBeVisible({ timeout: 5_000 });
    await expect(disabledButton).toBeDisabled();

    console.log(`✓ Refund correctly blocked for past event`);
  });

  test("refund page shows not eligible when past refund cutoff but event not started", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    expect(stripeSecretKey).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────────────
    // Seed event with refund cutoff in the past but event in the future
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📦 Seeding event with past refund cutoff...");

    // Event starts in 2 days, but refund cutoff was yesterday
    const futureStartDate = new Date(
      Date.now() + 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const pastCutoffDate = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();

    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: {
        priceCents: TICKET_PRICE_CENTS,
        startsAt: futureStartDate,
        refundCutoffAt: pastCutoffDate,
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    console.log(
      `✓ Seeded event: ${seed.eventId} (starts in future, cutoff in past)`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Create buyer and purchase ticket
    // ─────────────────────────────────────────────────────────────────────────
    const uniqueId = Date.now();
    const email = `buyer-pastcutoff-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyerpastcutoff${uniqueId}`;

    // Sign up
    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Past Cutoff Buyer",
      username,
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

    // Sign in via browser (needed for navigating to protected pages)
    await page.goto("/");
    // Overlay flavour: no navigation, so success is the card closing.
    // The two-step credential flow lives in `helpers/sign-in.ts`.
    await signInViaAccountOverlay(page, {
      email,
      password,
    });

    // Sign in via API
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });

    // Purchase ticket
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-pastcutoff-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    await confirmStripePaymentIntent({ stripeSecretKey, paymentIntentId });

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
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe("SUCCEEDED");

    console.log(`✓ Order succeeded: ${checkoutResult.orderId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Navigate to refund page and verify not eligible due to past cutoff
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n💰 Checking refund eligibility for past cutoff...");

    await page.goto(`/my-tickets/${checkoutResult.orderId}/refund`);
    await page.waitForLoadState("networkidle");

    // Wait for eligibility check loading to disappear
    await expect(
      page.getByText(/checking refund eligibility/i),
    ).not.toBeVisible({ timeout: 30_000 });

    // Should show not eligible because refund cutoff has passed
    await expect(page.getByText("Not Eligible for Refund")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("The refund deadline has passed.")).toBeVisible(
      { timeout: 5_000 },
    );

    // "Refund Not Available" button should be visible and disabled
    const disabledButton = page.getByRole("button", {
      name: "Refund Not Available",
    });
    await expect(disabledButton).toBeVisible({ timeout: 5_000 });
    await expect(disabledButton).toBeDisabled();

    console.log(`✓ Refund correctly blocked for past refund cutoff`);
  });

  test("refund page shows not eligible for already paid-out order", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    expect(stripeSecretKey).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────────────
    // Seed event for future (eligible for refund by default)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📦 Seeding event for paid-out test...");

    const futureStartDate = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 1 week from now

    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: {
        priceCents: TICKET_PRICE_CENTS,
        startsAt: futureStartDate,
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    console.log(`✓ Seeded event: ${seed.eventId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Create buyer and purchase ticket
    // ─────────────────────────────────────────────────────────────────────────
    const uniqueId = Date.now();
    const email = `buyer-paidout-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyerpaidout${uniqueId}`;

    // Sign up
    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Paid Out Buyer",
      username,
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

    // Sign in via browser
    await page.goto("/");
    // Overlay flavour: no navigation, so success is the card closing.
    // The two-step credential flow lives in `helpers/sign-in.ts`.
    await signInViaAccountOverlay(page, {
      email,
      password,
    });

    // Sign in via API
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });

    // Purchase ticket
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-paidout-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    await confirmStripePaymentIntent({ stripeSecretKey, paymentIntentId });

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
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe("SUCCEEDED");

    console.log(`✓ Order succeeded: ${checkoutResult.orderId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Mark the order as paid out via E2E endpoint
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n💸 Marking order as paid out...");

    const markPaidOutRes = await request.post(
      `${apiBaseUrl}/e2e/orders/${checkoutResult.orderId}/mark-paid-out`,
      {
        headers: {
          "x-e2e-reset-secret": e2eResetSecret,
          "content-type": "application/json",
        },
        data: {},
      },
    );
    expect(
      markPaidOutRes.ok(),
      `Mark paid out failed: ${await markPaidOutRes.text()}`,
    ).toBeTruthy();

    const { items: updatedItems } = (await markPaidOutRes.json()) as {
      items: Array<{ id: string; paidOutAt?: string | null }>;
    };
    expect(Array.isArray(updatedItems)).toBeTruthy();
    expect(updatedItems.some((i) => Boolean(i.paidOutAt))).toBeTruthy();
    const examplePaidOutAt = updatedItems.find((i) => i.paidOutAt)?.paidOutAt;
    console.log(
      `✓ Items marked as paid out. Example paidOutAt: ${examplePaidOutAt}`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Navigate to refund page and verify not eligible due to payout
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n💰 Checking refund eligibility for paid-out order...");

    await page.goto(`/my-tickets/${checkoutResult.orderId}/refund`);
    await page.waitForLoadState("networkidle");

    // Wait for eligibility check loading to disappear
    await expect(
      page.getByText(/checking refund eligibility/i),
    ).not.toBeVisible({ timeout: 30_000 });

    // Should show not eligible because order was already paid out
    await expect(page.getByText("Not Eligible for Refund")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText(/already been settled to the organizer/i),
    ).toBeVisible({ timeout: 5_000 });

    // "Refund Not Available" button should be visible and disabled
    const disabledButton = page.getByRole("button", {
      name: "Refund Not Available",
    });
    await expect(disabledButton).toBeVisible({ timeout: 5_000 });
    await expect(disabledButton).toBeDisabled();

    console.log(`✓ Refund correctly blocked for paid-out order`);
  });
});
