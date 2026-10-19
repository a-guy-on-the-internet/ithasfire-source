import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { signUpWithPassword } from "./helpers/sign-in";

/**
 * End-to-end checkout → settlement UI test.
 *
 * Validates the real buyer journey through the UI and then verifies the data
 * is visible in both the buyer's My Tickets page and the org admin's
 * Payouts page — without ever reading the database directly.
 *
 * Flow:
 *   1. Seed event with org, payee, agreement, fee policy.
 *   2. Sign up a buyer via the UI, verify email.
 *   3. Browse to the event page → click "Get Tickets" → select tickets in
 *      the checkout UI.
 *   4. Hold + create checkout via tRPC (Stripe iframes can't be filled by
 *      Playwright), confirm payment via Stripe test API.
 *   5. Verify buyer-side: /my-tickets/<orderId> shows "Confirmed" status,
 *      ticket cards with QR codes.
 *   6. Sign in as the org admin → navigate to admin orders page → switch to
 *      the Payouts page → verify the register, breakdown and ledger show
 *      correct event title, amount, and "pending" status.
 */
test.describe("Checkout to Settlement (UI-driven)", () => {
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

  test("buyer purchases ticket via UI, settlement appears in admin", async ({
    page,
    request,
    consoleErrors,
  }) => {
    consoleErrors.ignore();
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    const stripeAccountIdOverride =
      process.env.PLAYWRIGHT_E2E_STRIPE_ACCOUNT_ID ??
      process.env.E2E_STRIPE_ACCOUNT_ID;
    expect(stripeSecretKey).toBeTruthy();
    await page
      .context()
      .addCookies([
        { name: "th-consent", value: "all", domain: "localhost", path: "/" },
      ]);

    // ── PHASE 1: Seed event with payee + agreement ──────────────────
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
    expect(seed.eventSlug).toBeTruthy();
    expect(seed.orgSlug).toBeTruthy();

    // ── PHASE 2: Sign up buyer via UI ───────────────────────────────
    const uniqueId = Date.now();
    const buyerEmail = `buyer-checkout-e2e-${uniqueId}@example.com`;
    const buyerPassword = "Password123!";
    const buyerUsername = `buyercheckout${uniqueId}`;

    // Create the account through the UI. This spec already drove the
    // `auth-sign-up-expand-form` disclosure and filled by test id — the helper
    // now owns both, so the ritual has one definition.
    await signUpWithPassword(page, {
      displayName: "Checkout Buyer",
      username: buyerUsername,
      email: buyerEmail,
      password: buyerPassword,
    });

    // The card is now on step 2 (verify email). This spec verifies through
    // the e2e API instead of typing the OTP, so the UI panel is left where it
    // is; the browser session created at sign-up is what the rest of the
    // spec needs, and it is verified server-side below.
    const verifyBuyerRes = await request.post(
      `${apiBaseUrl}/e2e/auth/verify-email`,
      {
        headers: {
          "x-e2e-reset-secret": e2eResetSecret,
          "content-type": "application/json",
        },
        data: { email: buyerEmail },
      },
    );
    expect(
      verifyBuyerRes.ok(),
      `Buyer verification failed: ${await verifyBuyerRes.text()}`,
    ).toBeTruthy();
    // No "Skip for now" to click: that button belonged to the old
    // post-sign-up passkey prompt, which never rendered on the standalone
    // page (the shell handed off to verify-email first) and no longer exists.
    // Onboarding's own skip lives on step 3, behind the OTP — irrelevant here.

    // Sign in through the API request context to get a JWT for tRPC calls.
    // The browser session was established by the UI sign-up flow above.
    const { token: buyerToken } = await signInAndGetToken(
      page.request,
      apiBaseUrl,
      { email: buyerEmail, password: buyerPassword },
    );
    expect(buyerToken).toBeTruthy();

    const trpc = createE2eTrpcClient(page.request, apiBaseUrl, {
      bearerToken: buyerToken,
    });

    // ── PHASE 3: Browse to event → checkout UI ──────────────────────
    await page.goto(`/events/${seed.eventSlug}`);

    // Verify event page renders
    await expect(
      page.getByRole("heading", { name: "E2E Paid Checkout Event" }),
    ).toBeVisible({ timeout: 15_000 });

    // Click "Get tickets" to navigate to the checkout page.
    const getTicketsButton = page.getByTestId("event-get-tickets-btn");
    await getTicketsButton.click();
    await page.waitForURL(
      (url) => url.pathname.includes(`/events/checkout/${seed.eventSlug}`),
      { timeout: 15_000 },
    );

    // Select a ticket using the + button in the UI
    await page
      .getByRole("group", { name: /general admission quantity/i })
      .getByRole("button", { name: /increase/i })
      .click();

    // Verify the order summary shows the selected ticket
    await expect(
      page
        .getByRole("region", { name: /order summary/i })
        .getByText(/general admission/i),
    ).toBeVisible();

    // ── PHASE 4: Hold + checkout + confirm payment ──────────────────
    // Stripe Elements live in sandboxed iframes that Playwright can't
    // interact with, so we complete the payment programmatically while
    // keeping the browser on the checkout page for visual continuity.
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(holdResult.order?.id).toBeTruthy();

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-checkout-settlement-${Date.now()}`,
      termsAccepted: true,
      // Checkout gates on the buyer acknowledging the refund policy too
      // (create-checkout.ts: REFUND_POLICY_REQUIRED). The UI ticks it; this
      // programmatic completion must say so explicitly.
      refundPolicyAccepted: true,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];

    await confirmStripePaymentIntent({
      stripeSecretKey,
      paymentIntentId,
    });
    const finalizeRes = await request.post(`${apiBaseUrl}/e2e/finalize-order`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: {
        orderId: checkoutResult.orderId,
        paymentIntentId,
      },
    });
    expect(
      finalizeRes.ok(),
      `Order finalization failed: ${await finalizeRes.text()}`,
    ).toBeTruthy();
    const finalized = await finalizeRes.json();
    expect(finalized.status).toBe("SUCCEEDED");
    expect(finalized.ticketCount).toBeGreaterThan(0);

    // Wait for order to succeed (webhook processing)
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

    // ── PHASE 5: Verify buyer's My Tickets page ─────────────────────
    await page.goto(`/my-tickets/${checkoutResult.orderId}`);

    // Order detail content should load
    await expect(page.getByTestId("order-detail-content")).toBeVisible({
      timeout: 15_000,
    });

    // Event name should be visible in the header
    await expect(page.getByTestId("order-detail-event-name")).toContainText(
      "E2E Paid Checkout Event",
    );

    // Order should show as "Confirmed" (SUCCEEDED maps to "Confirmed")
    await expect(page.getByText("Confirmed")).toBeVisible();

    // Order summary card should be visible
    await expect(page.getByTestId("order-detail-summary")).toBeVisible();

    // Ticket section should contain at least one ticket card
    const ticketsSection = page.getByTestId("order-detail-tickets");
    await expect(ticketsSection).toBeVisible();
    await expect(ticketsSection.getByText("Your Tickets")).toBeVisible();

    // There should be at least one ticket card with a QR code
    // (ticket cards have data-testid="ticket-card-<id>")
    await expect(
      ticketsSection.locator('[data-testid^="ticket-card-"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // Ticket should show as "Valid"
    await expect(ticketsSection.getByText("Valid")).toBeVisible();

    // Total paid should be visible
    await expect(page.getByText("Total Paid")).toBeVisible();

    // ── PHASE 6: Sign in as org admin → check settlements ───────────
    // The paid-checkout seed creates the org with the seed human as OWNER
    // and a Better Auth credential account, so we can sign in as that user.
    // Use a separate browser context so the admin session doesn't collide
    // with the buyer session.
    const webBaseUrl =
      process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const adminContext = await page.context().browser()!.newContext({
      baseURL: webBaseUrl,
    });
    await adminContext.addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
    const adminPage = await adminContext.newPage();
    const { token: adminToken } = await signInAndGetToken(
      adminContext.request,
      apiBaseUrl,
      { email: seed.email, password: seed.password },
    );
    expect(adminToken).toBeTruthy();

    // Navigate to the organiser's Payouts page. The Settlements tab under
    // Orders read the frozen `Settlement` table (zero writers since the
    // 2026-08-10 ledger cutover) and was removed; the money now lives in the
    // payee ledger, which this page reads.
    await adminPage.goto(`/admin/${seed.orgSlug}/payouts`);
    await expect(
      adminPage.getByRole("heading", { name: /payouts/i }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The register: the organiser is OWED the post-platform-fee net of the
    // sale, matured or not. Nothing is ready yet — the credit matures on the
    // event's payout schedule — so "Owed to you" is where the $49.50 shows.
    const owedCell = adminPage.getByTestId("payout-panel");
    await expect(owedCell).toBeVisible({ timeout: 15_000 });
    await expect(owedCell).toContainText("$49.50");

    // "Coming up" names the show the money came from.
    await expect(
      adminPage.getByRole("heading", { name: /coming up/i }).first(),
    ).toBeVisible();
    await expect(
      adminPage.getByText(/E2E Paid Checkout Event/i).first(),
    ).toBeVisible({ timeout: 15_000 });

    // The ledger: one sales credit, and the balance it left behind is the
    // same figure the register shows.
    const ledger = adminPage.getByTestId("payout-ledger");
    await ledger.scrollIntoViewIfNeeded();
    await expect(ledger).toContainText(/sales credit/i);
    await expect(ledger).toContainText("+$49.50");
    await expect(ledger).toContainText("$49.50");

    // Clean up
    await adminPage.close();
    await adminContext.close();
  });
});
