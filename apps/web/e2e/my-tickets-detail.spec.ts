import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { ensureBetterAuthTestUserExists } from "./helpers/better-auth-test-user";
import { signInWithPassword } from "./helpers/sign-in";

/**
 * E2E tests for the order detail page and per-ticket management features:
 *
 *   - Order detail header, summary, and QR code display
 *   - Unified ticket cards with inline refund, resell, and transfer actions
 *   - Per-ticket refund via inline ItemRefundAction (quote → confirm → success)
 *   - Transfer button visibility (hidden when paid out)
 *   - Resell link navigates to the seller hub and supports listing creation
 *
 * The full-order refund flow is covered in my-tickets-refund.spec.ts.
 * This spec focuses on the inline per-ticket actions and detail page UI.
 */
test.describe.serial("Order Detail — Per-Item Management", () => {
  const TICKET_PRICE_CENTS = 3500; // $35.00

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(
      request,
      process.env.E2E_API_BASE_URL || "http://localhost:3001",
    );
  });

  test("order detail shows QR codes, inline refund, transfer, and resell actions", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    expect(stripeSecretKey).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Seed event
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 1: Seeding event...");

    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: {
        priceCents: TICKET_PRICE_CENTS,
        enableResale: true,
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    expect(seed.ticketTypeId).toBeTruthy();
    console.log(`  Seeded event: ${seed.eventId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Create and authenticate buyer
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 2: Signing in as the seeded buyer...");

    // The buyer is the seed's own user: `enableResale` gives exactly that
    // human an ACTIVE HUMAN payee with payouts on, which `createListing` now
    // requires (SELLER_PAYOUT_NOT_SETUP otherwise) for PHASE 8's listing. The
    // seed already creates the verified auth user and its credential account.
    const { email, password } = seed as { email: string; password: string };

    // The two-step credential flow lives in `helpers/sign-in.ts`: the password
    // field only mounts after the identifier is submitted, so a single view
    // that filled both by label no longer exists.
    await signInWithPassword(page, { email, password });

    // Also get API token for tRPC calls
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });
    console.log(`  Buyer authenticated: ${email}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3: Purchase ticket via tRPC
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 3: Purchasing ticket...");

    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(holdResult.order?.id).toBeTruthy();

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-detail-${Date.now()}`,
      termsAccepted: true,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

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
        {
          message: "Order did not become SUCCEEDED",
          timeout: 30_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe("SUCCEEDED");

    console.log(`  Order succeeded: ${checkoutResult.orderId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 4: Navigate to order detail page and verify structure
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 4: Verifying order detail page...");

    await page.goto(`/my-tickets/${checkoutResult.orderId}`);
    await page.waitForLoadState("networkidle");

    // Event name heading
    await expect(
      page.getByRole("heading", { name: /E2E Paid Checkout Event/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Order status "Confirmed"
    await expect(page.getByText("Confirmed")).toBeVisible({ timeout: 5_000 });

    // Order Summary card
    await expect(page.getByText("Order Summary")).toBeVisible();
    await expect(page.getByText("1 ticket")).toBeVisible();

    // Total paid
    await expect(page.getByText("$35.00")).toBeVisible();

    console.log("  Order detail header and summary verified");

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5: Verify QR code and ticket code displayed
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 5: Verifying QR code display...");

    // "Your Tickets" section heading
    await expect(
      page.getByRole("heading", { name: /your tickets/i }),
    ).toBeVisible({
      timeout: 10_000,
    });

    // QR code SVG is rendered (qrcode.react produces an <svg> inside the card)
    const qrCode = page
      .locator("svg")
      .filter({ has: page.locator("path") })
      .first();
    await expect(qrCode).toBeVisible({ timeout: 10_000 });

    // Ticket code label and value
    await expect(page.getByText(/ticket code/i)).toBeVisible();

    // Ticket status "Valid"
    await expect(page.getByText("Valid")).toBeVisible();

    console.log("  QR code and ticket details verified");

    // ─────────────────────────────────────────────────────────────
    // PHASE 6: Verify per-ticket inline actions (inside unified ticket cards)
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 6: Verifying per-ticket inline actions...");

    // Actions are now rendered inline inside each ticket card (no separate section).
    // Per-item refund button (shows "Refund" — the quote is fetched lazily on click)
    const refundButton = page.getByRole("button", { name: /^refund$/i });
    await expect(refundButton).toBeVisible({ timeout: 15_000 });

    // Resell button
    const resellButton = page.getByRole("button", { name: /resell/i });
    await expect(resellButton).toBeVisible({ timeout: 5_000 });

    // Transfer button/link
    const transferButton = page.getByRole("button", { name: /transfer/i });
    await expect(transferButton).toBeVisible({ timeout: 5_000 });

    console.log(
      "  Per-ticket inline actions (refund, resell, transfer) verified",
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 7: Verify full refund CTA
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 7: Verifying full refund CTA...");

    await expect(page.getByText(/need a full refund\?/i)).toBeVisible({
      timeout: 5_000,
    });
    const fullRefundButton = page.getByRole("button", {
      name: /request full refund/i,
    });
    await expect(fullRefundButton).toBeVisible();

    console.log("  Full refund CTA verified");

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 8: Navigate to seller resale flow and create a listing
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 8: Creating resale listing from seller hub...");

    await resellButton.click();
    await page.waitForURL(
      (url) => url.pathname.includes("/sell/listings/new"),
      { timeout: 10_000 },
    );

    // Verify seller hub resale form loaded
    await expect(
      page.getByRole("heading", { name: /ticket resale/i }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/seller economics/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/select a ticket to resell/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/face value: \$35\.00/i)).toBeVisible({
      timeout: 10_000,
    });

    // The price field opens under a ticket once it is picked. The ticket's
    // header is the button, named by its own text ("Ticket", face value,
    // estimate).
    const ticketButton = page.getByRole("button", {
      name: /face value: \$35\.00/i,
    });
    await ticketButton.click();
    await expect(ticketButton).toHaveAttribute("aria-pressed", "true");

    const askPriceInput = page.getByTestId("resale-ask-price");
    await expect(askPriceInput).toBeVisible({ timeout: 10_000 });
    await askPriceInput.fill("42.00");
    await page.getByRole("button", { name: /list for sale/i }).click();

    await expect
      .poll(
        async () => {
          const listings = await trpc.resale.listMyListings.query({
            status: ["ACTIVE", "HELD"],
          });
          return listings.items.length;
        },
        {
          message: "Resale listing was not created",
          timeout: 15_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe(1);

    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/your active listings/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/no tickets available to resell/i)).toBeVisible(
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("resale-ask-price")).toHaveCount(0);

    console.log(
      "  Seller hub listing flow verified, including already-listed suppression",
    );

    // Navigate back to order detail
    await page.getByRole("button", { name: /back to my order/i }).click();
    await page.waitForURL(
      (url) =>
        url.pathname.includes("/my-tickets/") &&
        !url.pathname.includes("/sell/listings/new"),
      { timeout: 10_000 },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 9: Execute per-item refund via inline UI
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 9: Executing per-item refund...");

    // Wait for page to reload and inline actions to reappear inside ticket cards
    await expect(
      page.getByRole("heading", { name: /your tickets/i }),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Click the inline "Refund" button — this triggers the lazy quote fetch
    const inlineRefundButton = page.getByRole("button", { name: /^refund$/i });
    await expect(inlineRefundButton).toBeVisible({ timeout: 15_000 });
    await inlineRefundButton.click();

    // Wait for the quote to load (spinner → confirmation panel with "Refund amount:")
    await expect(page.getByText(/refund amount:/i)).toBeVisible({
      timeout: 15_000,
    });

    const confirmRefundButton = page.getByRole("button", {
      name: /confirm refund/i,
    });
    await expect(confirmRefundButton).toBeVisible({ timeout: 5_000 });
    await expect(confirmRefundButton).toBeEnabled();

    // Also verify there's a Cancel button
    const cancelButton = page.getByRole("button", { name: /^cancel$/i });
    await expect(cancelButton).toBeVisible();

    // Execute the refund
    await confirmRefundButton.click();

    // Wait for the refund to complete — the confirmation panel should disappear
    // and the inline actions should no longer render (item is refunded)
    await expect(page.getByRole("button", { name: /processing/i })).toBeVisible(
      { timeout: 5_000 },
    );
    await expect(
      page.getByRole("button", { name: /processing/i }),
    ).not.toBeVisible({ timeout: 30_000 });

    console.log("  Per-item refund executed");

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 10: Verify order status updated after per-item refund
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 10: Verifying post-refund state...");

    // Reload to see fresh data
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Order status should change (PART_REFUNDED since Stripe fees are retained)
    await expect(
      page.getByText(/partially refunded/i).or(page.getByText(/^Refunded$/i)),
    ).toBeVisible({ timeout: 15_000 });

    // The refund button should no longer appear inside the ticket card
    // (the item is now refunded, so canRefund is false and no actions render).
    // With a single-ticket order the inline actions section disappears entirely.
    const refundButtonAfter = page.getByRole("button", { name: /^refund$/i });

    // The refund button should be gone
    await expect(refundButtonAfter).not.toBeVisible({ timeout: 10_000 });

    // The ticket card should now show "Refunded" status
    await expect(page.getByText("Refunded").first()).toBeVisible({
      timeout: 5_000,
    });
    console.log("  Ticket card shows refunded status — inline actions removed");

    // Verify via API that the order status changed
    const orderAfterRefund = await trpc.orders.getMyOrder.query({
      orderId: checkoutResult.orderId,
    });
    expect(["PART_REFUNDED", "REFUNDED"]).toContain(orderAfterRefund.status);
    console.log(`  Order status after refund: ${orderAfterRefund.status}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 11: Verify ticket status changed to REFUNDED
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 11: Verifying ticket status...");

    const ticketsAfter = await trpc.orders.listMyOrderTickets.query({
      orderId: checkoutResult.orderId,
    });
    const tickets = ticketsAfter.tickets ?? [];
    expect(tickets.length).toBeGreaterThan(0);
    // At least one ticket should be REFUNDED
    const hasRefundedTicket = tickets.some((t) => t.status === "REFUNDED");
    expect(hasRefundedTicket).toBeTruthy();

    console.log(
      `  Ticket statuses: ${tickets.map((t) => t.status).join(", ")}`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 12: Help section visible
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- PHASE 12: Verifying help section...");

    await expect(page.getByText(/need help\?/i)).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      page.getByText(/contact the event organizer or reach out to support/i),
    ).toBeVisible();

    console.log("  Help section verified");
    console.log("\n=== Order Detail E2E test complete ===");
  });

  test("paid-out items do not show transfer button", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    expect(stripeSecretKey).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────────────
    // Seed event
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Seeding event for paid-out transfer test...");

    const futureStartDate = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
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

    // ─────────────────────────────────────────────────────────────────────────
    // Create buyer and purchase
    // ─────────────────────────────────────────────────────────────────────────
    const uniqueId = Date.now();
    const email = `buyer-paidout-xfer-${uniqueId}@example.com`;
    const password = "Password123!";

    await ensureBetterAuthTestUserExists({
      request,
      apiBaseUrl,
      email,
      password,
      name: "Paid Out Transfer Test",
    });

    await request.post(`${apiBaseUrl}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: { email },
    });

    // The two-step credential flow lives in `helpers/sign-in.ts`: the password
    // field only mounts after the identifier is submitted, so a single view
    // that filled both by label no longer exists.
    await signInWithPassword(page, { email, password });

    // API auth
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });

    // Purchase
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-paidout-xfer-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    await confirmStripePaymentIntent({ stripeSecretKey, paymentIntentId });

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

    console.log(`  Order succeeded: ${checkoutResult.orderId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Mark order as paid out
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Marking order as paid out...");

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

    console.log("  Order marked as paid out");

    // ─────────────────────────────────────────────────────────────────────────
    // Navigate to order detail and verify transfer button is hidden
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Verifying transfer button hidden for paid-out item...");

    await page.goto(`/my-tickets/${checkoutResult.orderId}`);
    await page.waitForLoadState("networkidle");

    // Page should load with event name
    await expect(
      page.getByRole("heading", { name: /E2E Paid Checkout Event/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // The paid-out item's order item has status !== "active", so canRefund is
    // false and no inline actions (refund/resell/transfer) render inside the
    // ticket card.  Verify the transfer button is not present anywhere.
    const anyTransferButton = page.getByRole("button", { name: /transfer/i });
    await expect(anyTransferButton).not.toBeVisible({ timeout: 5_000 });

    console.log("  Paid-out transfer button test complete");
  });
});
