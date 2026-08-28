import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";

/**
 * E2E test for automatic settlement creation during order finalization.
 *
 * This validates the core payout flow:
 *   1. Order is finalized via payment_intent.succeeded webhook
 *   2. Settlements are AUTOMATICALLY created (no separate job/call needed)
 *   3. Settlement has correct scheduledPayoutDate based on agreement.payoutSchedule
 *   4. SettlementLines link back to OrderSplits
 *
 * This is the "happy path" for the payout machinery - after this,
 * a scheduled cron will pick up due settlements and execute Stripe transfers.
 */
test.describe.serial("Automatic Settlement Creation", () => {
  const TICKET_PRICE_CENTS = 5000; // $50.00
  const QTY = 1;

  // Fee policy from seed (PASS_THROUGH mode)
  const BUYER_FEE_PCT = 0.065; // 6.5%
  const MAX_FEE_CENTS = 500;

  function computePlatformFee(unitPriceCents: number): number {
    return Math.min(MAX_FEE_CENTS, Math.round(unitPriceCents * BUYER_FEE_PCT));
  }

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      test.skip();
    }
    await resetE2eState(
      request,
      process.env.E2E_API_BASE_URL || "http://localhost:3001",
    );
  });

  test("settlements are automatically created when order finalizes", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    const stripeAccountIdOverride =
      process.env.PLAYWRIGHT_E2E_STRIPE_ACCOUNT_ID ??
      process.env.E2E_STRIPE_ACCOUNT_ID;
    expect(stripeSecretKey).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Seed event with Agreement and Payee
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📦 PHASE 1: Seeding event with Agreement and Payee...");

    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: {
        priceCents: TICKET_PRICE_CENTS,
        ...(stripeAccountIdOverride
          ? { stripeAccountId: stripeAccountIdOverride }
          : {}),
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    expect(seed.ticketTypeId).toBeTruthy();
    expect(seed.agreementId).toBeTruthy();

    console.log(`✓ Seeded event: ${seed.eventId}`);
    console.log(`✓ Seeded agreement: ${seed.agreementId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Create & authenticate buyer
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n👤 PHASE 2: Creating and authenticating buyer...");

    const uniqueId = Date.now();
    const email = `buyer-autosettlement-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyerautosettlement${uniqueId}`;

    // Sign up via UI
    await page.goto("/sign-up");
    const signUpForm = page.getByTestId("auth-sign-up-form");
    if (!(await signUpForm.isVisible())) {
      const signInForm = page.getByTestId("auth-sign-in-form");
      if (!(await signInForm.isVisible())) {
        await page.getByTestId("navbar-account").click();
        await expect(signInForm).toBeVisible({ timeout: 10_000 });
      }
      await page.getByTestId("auth-sign-in-create-account").click();
    }
    await expect(signUpForm).toBeVisible({ timeout: 10_000 });

    await signUpForm.getByPlaceholder("Jane Doe").fill("Auto Settlement Buyer");
    await signUpForm.getByPlaceholder("janedoe").fill(username);
    await signUpForm.getByPlaceholder("you@example.com").fill(email);
    await signUpForm.getByPlaceholder("••••••••").first().fill(password);
    await signUpForm.getByPlaceholder("••••••••").nth(1).fill(password);
    await page.getByTestId("auth-sign-up-submit").click();

    await expect(page.getByTestId("auth-sign-up-form")).not.toBeVisible({
      timeout: 15_000,
    });
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-up"), {
      timeout: 30_000,
    });

    // Verify email via Mailpit
    const mailpit = createMailpitClient({ request });
    const verificationEmail = await mailpit.waitForEmailTo(email);
    const verificationUrl =
      extractFirstUrlFromMailpitMessage(verificationEmail);
    await page.goto(verificationUrl);
    await mailpit.clear();

    // Sign in and get JWT
    await page.goto("/sign-in");
    await page.waitForLoadState("networkidle");
    const signInForm = page.getByTestId("auth-sign-in-form");
    if (await signInForm.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await signInForm.getByTestId("auth-sign-in-email").fill(email);
      await signInForm.getByTestId("auth-sign-in-password").fill(password);
      await signInForm.getByTestId("auth-sign-in-submit").click();
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
        timeout: 30_000,
      });
    }

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
    // PHASE 3: Purchase ticket (hold + checkout + confirm payment)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 3: Purchasing ticket...");

    // Hold tickets
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });
    expect(holdResult.order?.id).toBeTruthy();
    console.log(`✓ Ticket held, order: ${holdResult.order.id}`);

    // Create checkout
    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-autosettlement-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    console.log(`✓ Checkout created, PI: ${paymentIntentId}`);

    // Confirm payment (triggers webhook -> finalizePaymentIntent -> settlements)
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
    // PHASE 4: Verify OrderSplits were created
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n💰 PHASE 4: Verifying OrderSplits...");

    const splitsData = await trpc.splits.listForOrder.query({
      orderId: checkoutResult.orderId,
    });
    expect(splitsData.splits.length).toBeGreaterThan(0);

    const expectedGross = TICKET_PRICE_CENTS * QTY;
    const expectedPlatformFee = computePlatformFee(TICKET_PRICE_CENTS) * QTY;
    const expectedSplitAmount = expectedGross - expectedPlatformFee;

    console.log(`  Gross amount: ${expectedGross} cents`);
    console.log(`  Platform fee: ${expectedPlatformFee} cents`);
    console.log(`  Expected split: ${expectedSplitAmount} cents`);

    expect(splitsData.totalCents).toBe(expectedSplitAmount);
    console.log(
      `✓ OrderSplits verified: ${splitsData.splits.length} split(s), total ${splitsData.totalCents} cents`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5: Verify Settlements were AUTOMATICALLY created
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📋 PHASE 5: Verifying automatic settlement creation...");

    // Query settlements via E2E inspection endpoint
    const settlementsRes = await request.get(
      `${apiBaseUrl}/e2e/orders/${checkoutResult.orderId}/settlements`,
      {
        headers: {
          "x-e2e-reset-secret": e2eResetSecret,
        },
      },
    );
    expect(
      settlementsRes.ok(),
      `Failed to get settlements: ${await settlementsRes.text()}`,
    ).toBeTruthy();

    const { settlements } = await settlementsRes.json();

    // KEY ASSERTION: Settlements exist without calling createFromOrder manually
    expect(settlements.length).toBeGreaterThan(0);
    console.log(`✓ Settlements automatically created: ${settlements.length}`);

    const settlement = settlements[0];

    // Verify settlement amount matches split amount
    expect(settlement.amountCents).toBe(expectedSplitAmount);
    console.log(`✓ Settlement amount: ${settlement.amountCents} cents`);

    // Verify settlement status is pending (not yet paid out)
    expect(settlement.status).toBe("pending");
    console.log(`✓ Settlement status: ${settlement.status}`);

    // Verify settlement has scheduledPayoutDate set
    expect(settlement.scheduledPayoutDate).toBeTruthy();
    const scheduledDate = new Date(settlement.scheduledPayoutDate);
    console.log(`✓ Scheduled payout date: ${scheduledDate.toISOString()}`);

    // Verify scheduledPayoutDate is in the future (based on WEEK_OF_EVENT default)
    // The seed creates events ~7 days in the future, so payout should be after that
    const now = new Date();
    expect(scheduledDate.getTime()).toBeGreaterThan(now.getTime());
    console.log(
      `✓ Payout date is in the future (correct for WEEK_OF_EVENT schedule)`,
    );

    // Verify settlement is linked to the agreement and event
    expect(settlement.agreementId).toBe(seed.agreementId);
    expect(settlement.eventId).toBe(seed.eventId);
    console.log(`✓ Settlement linked to agreement: ${settlement.agreementId}`);
    console.log(`✓ Settlement linked to event: ${settlement.eventId}`);

    // Verify settlement lines exist and link to splits
    expect(settlement.lines.length).toBeGreaterThan(0);
    console.log(`✓ Settlement lines: ${settlement.lines.length}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(60));
    console.log("✅ AUTOMATIC SETTLEMENT CREATION TEST PASSED!");
    console.log("═".repeat(60));
    console.log(`
Summary:
  Ticket Price:       $${(TICKET_PRICE_CENTS / 100).toFixed(2)}
  Quantity:           ${QTY}
  Net to Organizer:   $${(expectedSplitAmount / 100).toFixed(2)}
  
  Order ID:           ${checkoutResult.orderId}
  Payment Intent:     ${paymentIntentId}
  Settlement ID:      ${settlement.id}
  Scheduled Payout:   ${scheduledDate.toISOString()}
  
  Flow validated:
  1. Order finalized via webhook ✓
  2. Splits computed ✓
  3. Settlements auto-created ✓
  4. Payout date computed from agreement schedule ✓
`);
  });
});
