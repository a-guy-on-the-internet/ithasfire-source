import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import {
  signInViaAccountOverlay,
  signUpWithPassword,
} from "./helpers/sign-in";

/**
 * E2E tests for My Tickets pages rendering:
 *
 *   - /my-tickets list page loads and shows order cards
 *   - Order card displays event name, ticket count, total, status
 *   - "View Tickets" button navigates to order detail
 *   - Order detail page renders header, summary, QR codes, and action buttons
 *   - Back link returns to My Tickets list
 *   - Empty state renders when user has no orders
 *
 * These tests validate that the pages render correctly and the navigation
 * works end-to-end. Heavier flows (refunds, per-item actions) live in
 * my-tickets-detail.spec.ts and my-tickets-refund.spec.ts.
 */
test.describe.serial("My Tickets — Page Rendering", () => {
  const TICKET_PRICE_CENTS = 2500; // $25.00

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(
      request,
      process.env.E2E_API_BASE_URL || "http://localhost:3001",
    );
  });

  test("my tickets list page renders order cards with correct layout", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    expect(stripeSecretKey).toBeTruthy();

    // ── Seed event ────────────────────────────────────────────────────────
    console.log("\n--- Seeding event...");

    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: { priceCents: TICKET_PRICE_CENTS },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    expect(seed.ticketTypeId).toBeTruthy();

    // ── Sign up buyer ─────────────────────────────────────────────────────
    console.log("\n--- Creating buyer...");

    const uniqueId = Date.now();
    const email = `buyer-render-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyerrender${uniqueId}`;

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Render Test Buyer",
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

    // Sign in via browser UI
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Overlay flavour: no navigation, so success is the card closing.
    // The two-step credential flow lives in `helpers/sign-in.ts`.
    await signInViaAccountOverlay(page, {
      email,
      password,
    });

    // Get API token for tRPC calls
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });

    // ── Purchase ticket via tRPC ──────────────────────────────────────────
    console.log("\n--- Purchasing ticket...");

    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 2 }],
    });
    expect(holdResult.order?.id).toBeTruthy();

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-render-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 2 }],
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

    console.log(`  Order confirmed: ${checkoutResult.orderId}`);

    // ── My Tickets list page ──────────────────────────────────────────────
    console.log("\n--- Verifying My Tickets list page...");

    await page.goto("/my-tickets");
    await page.waitForLoadState("networkidle");

    // Page heading — "My events" since the /saved watchlist merged in
    // (2026-08-31); the URL is still /my-tickets.
    await expect(
      page.getByRole("heading", { name: /my events/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Content container loaded (not in loading/empty state)
    await expect(page.getByTestId("my-tickets-content")).toBeVisible({
      timeout: 10_000,
    });

    // "Upcoming" is the selected top-level TAB now, not a section heading —
    // the sections inside it are "Tickets" and "Saved".
    await expect(page.getByRole("tab", { name: /^upcoming$/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("my-events-section-tickets")).toBeVisible({
      timeout: 5_000,
    });

    // Order card renders with event name
    await expect(
      page.getByText(/E2E Paid Checkout Event/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    // Order card shows "Confirmed" status
    await expect(page.getByText("Confirmed")).toBeVisible({ timeout: 5_000 });

    // Order card shows ticket count
    await expect(page.getByText(/2 tickets/i)).toBeVisible();

    // Order card shows formatted total ($50.00 for 2 x $25.00)
    await expect(page.getByText("$50.00")).toBeVisible();

    // "View Tickets" button is present in the card footer (right-aligned)
    const viewTicketsLink = page
      .getByRole("link", { name: /view tickets/i })
      .first();
    await expect(viewTicketsLink).toBeVisible({ timeout: 5_000 });

    console.log("  Order card rendered with correct layout");

    // ── Navigate to order detail via View Tickets button ──────────────────
    console.log("\n--- Navigating to order detail...");

    await viewTicketsLink.click();
    await page.waitForURL(
      (url) =>
        url.pathname.includes("/my-tickets/") &&
        url.pathname !== "/my-tickets/",
      { timeout: 10_000 },
    );

    // Order detail content container
    await expect(page.getByTestId("order-detail-content")).toBeVisible({
      timeout: 10_000,
    });

    // Event name in header
    await expect(page.getByTestId("order-detail-event-name")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("order-detail-event-name")).toContainText(
      /E2E Paid Checkout Event/i,
    );

    // Order status
    await expect(page.getByText("Confirmed")).toBeVisible();

    // Order Summary card
    await expect(page.getByTestId("order-detail-summary")).toBeVisible();
    await expect(page.getByText("Order Summary")).toBeVisible();
    await expect(page.getByText("2 tickets")).toBeVisible();
    await expect(page.getByText("$50.00")).toBeVisible();

    // Tickets section with QR codes
    await expect(page.getByTestId("order-detail-tickets")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("heading", { name: /your tickets/i }),
    ).toBeVisible();

    // QR code SVGs are rendered (one per ticket)
    const qrCodes = page.locator("svg").filter({ has: page.locator("path") });
    await expect(qrCodes.first()).toBeVisible({ timeout: 10_000 });
    // We bought 2 tickets, so there should be at least 2 QR codes
    const qrCount = await qrCodes.count();
    expect(qrCount).toBeGreaterThanOrEqual(2);

    // Ticket codes are displayed
    await expect(page.getByText(/ticket code/i).first()).toBeVisible();

    // Ticket status "Valid"
    await expect(page.getByText("Valid").first()).toBeVisible();

    // Inline actions (refund/resell/transfer) are rendered inside each ticket card
    // when the ticket's order item is refundable. Verify at least one refund button.
    const refundButton = page.getByRole("button", { name: /refund/i });
    await expect(refundButton.first()).toBeVisible({ timeout: 10_000 });

    // Full refund card
    await expect(page.getByText(/need a full refund\?/i)).toBeVisible();
    const fullRefundLink = page.getByRole("link", {
      name: /request full refund/i,
    });
    await expect(fullRefundLink).toBeVisible();

    // Help section
    await expect(page.getByText(/need help\?/i)).toBeVisible();

    console.log("  Order detail page fully rendered");

    // ── Back navigation ───────────────────────────────────────────────────
    console.log("\n--- Verifying back navigation...");

    await page.getByText(/← back to my tickets/i).click();
    await page.waitForURL("/my-tickets", { timeout: 10_000 });

    await expect(
      page.getByRole("heading", { name: /my tickets/i }),
    ).toBeVisible({ timeout: 5_000 });

    console.log("  Back navigation works");
  });

  test("my tickets shows empty state for user with no orders", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

    // Seed to ensure the API is healthy (but we won't buy anything)
    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: { priceCents: 1000 },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    // ── Sign up a fresh buyer (no purchases) ──────────────────────────────
    const uniqueId = Date.now();
    const email = `buyer-empty-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyerempty${uniqueId}`;

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Empty Tickets Buyer",
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

    // Sign in
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Overlay flavour: no navigation, so success is the card closing.
    // The two-step credential flow lives in `helpers/sign-in.ts`.
    await signInViaAccountOverlay(page, {
      email,
      password,
    });

    // ── Navigate to My Tickets ────────────────────────────────────────────
    await page.goto("/my-tickets");
    await page.waitForLoadState("networkidle");

    // Empty state should render
    await expect(page.getByTestId("my-tickets-empty")).toBeVisible({
      timeout: 10_000,
    });
    // The copy is scope-scoped now: this is the Upcoming tab holding neither
    // tickets NOR saved events. "No tickets yet" would be wrong on a page that
    // also holds a watchlist.
    await expect(page.getByText(/nothing coming up/i)).toBeVisible();
    await expect(
      page.getByText(/tickets you buy and events you save/i),
    ).toBeVisible();

    // "Browse Events" link is present
    const browseLink = page.getByRole("link", { name: /browse events/i });
    await expect(browseLink).toBeVisible();

    console.log("  Empty state rendered correctly");
  });

  test("order detail shows not-found for invalid order ID", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

    // Seed to ensure API is healthy
    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: { priceCents: 1000 },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    // Sign up and authenticate
    const uniqueId = Date.now();
    const email = `buyer-notfound-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyernotfound${uniqueId}`;

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "NotFound Test Buyer",
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

    // Sign in
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Overlay flavour: no navigation, so success is the card closing.
    // The two-step credential flow lives in `helpers/sign-in.ts`.
    await signInViaAccountOverlay(page, {
      email,
      password,
    });

    // ── Navigate to a bogus order ID ──────────────────────────────────────
    await page.goto("/my-tickets/00000000-0000-0000-0000-000000000000");
    await page.waitForLoadState("networkidle");

    // Should show not-found state
    await expect(page.getByTestId("order-detail-not-found")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/order not found/i)).toBeVisible();

    // Back link to My Tickets
    const backLink = page.getByRole("link", { name: /back to my tickets/i });
    await expect(backLink).toBeVisible();

    console.log("  Not-found state rendered correctly");
  });
});
