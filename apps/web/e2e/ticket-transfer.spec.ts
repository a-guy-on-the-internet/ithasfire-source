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
 * E2E tests for the ticket transfer flow:
 *
 *   1. Direct transfer to an existing user (search, select, confirm, success)
 *   2. Email-based transfer invitation to a non-existent user
 *   3. Transfer page shows "no transferable tickets" for fully-refunded orders
 *
 * Prerequisites: local infra, API, Mailpit, Stripe sandbox.
 */
test.describe.serial("Ticket Transfer Flow", () => {
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

  // ── Shared sign-up helper ──────────────────────────────────────────────

  async function signUpUser(
    page: import("@playwright/test").Page,
    request: import("@playwright/test").APIRequestContext,
    opts: { email: string; password: string; name: string; username: string },
  ) {
    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: opts.name,
      username: opts.username,
      email: opts.email,
      password: opts.password,
    });

    // Verify email via Mailpit
    const mailpit = createMailpitClient({ request });
    const verificationEmail = await mailpit.waitForEmailTo(opts.email);
    const verificationUrl =
      extractFirstUrlFromMailpitMessage(verificationEmail);
    await page.goto(verificationUrl);
    await mailpit.clear();
  }

  async function signInUser(
    page: import("@playwright/test").Page,
    opts: { email: string; password: string },
  ) {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Overlay flavour: no navigation, so success is the card closing.
    // The two-step credential flow lives in `helpers/sign-in.ts`.
    await signInViaAccountOverlay(page, {
      email: opts.email,
      password: opts.password,
    });

  }

  async function purchaseTicket(
    trpc: ReturnType<typeof createE2eTrpcClient>,
    seed: { eventId: string; ticketTypeId: string },
    clientKeyPrefix: string,
  ) {
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(holdResult.order?.id).toBeTruthy();

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `${clientKeyPrefix}-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
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

  // ── Test 1: Direct transfer to existing user ───────────────────────────

  test("buyer can transfer a ticket to another user via the transfer page", async ({
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
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();
    const { seed } = await seedRes.json();

    // ── Create recipient user via API seed ──────────────────────────────
    const recipientEmail = `recipient-${Date.now()}@example.com`;
    const recipientRes = await request.post(
      `${API_BASE_URL}/e2e/seed/auth-user`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: {
          email: recipientEmail,
          password: "Test-Account-2026!",
          name: "Transfer Recipient",
        },
      },
    );
    expect(
      recipientRes.ok(),
      `Recipient seed failed: ${await recipientRes.text()}`,
    ).toBeTruthy();

    // ── Create buyer, sign up, verify email, sign in ────────────────────
    const uid = Date.now();
    const buyerEmail = `buyer-xfer-${uid}@example.com`;
    const buyerPassword = "Password123!";

    await signUpUser(page, request, {
      email: buyerEmail,
      password: buyerPassword,
      name: "Transfer Buyer",
      username: `buyerxfer${uid}`,
    });
    await signInUser(page, { email: buyerEmail, password: buyerPassword });

    // Get API token for tRPC calls
    const { token } = await signInAndGetToken(request, API_BASE_URL, {
      email: buyerEmail,
      password: buyerPassword,
    });
    const trpc = createE2eTrpcClient(request, API_BASE_URL, {
      bearerToken: token,
    });

    // ── Purchase a ticket ───────────────────────────────────────────────
    const checkoutResult = await purchaseTicket(trpc, seed, "e2e-xfer");

    // ── Navigate to transfer page ───────────────────────────────────────
    await page.goto(`/my-tickets/${checkoutResult.orderId}`);
    await page.waitForLoadState("networkidle");

    // Wait for the order detail to load
    await expect(
      page.getByRole("heading", { name: /E2E Paid Checkout Event/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Click the transfer button/link on the ticket card
    const transferLink = page
      .getByRole("button", { name: /transfer/i })
      .or(page.getByRole("link", { name: /transfer/i }));
    await expect(transferLink).toBeVisible({ timeout: 10_000 });
    await transferLink.click();

    // Wait for the transfer page to load
    await page.waitForURL((url) => url.pathname.includes("/transfer"), {
      timeout: 10_000,
    });
    await expect(
      page.getByRole("heading", { name: /transfer a ticket/i }),
    ).toBeVisible({
      timeout: 10_000,
    });

    // ── Step 1: Select a ticket ─────────────────────────────────────────
    await expect(page.getByText("1. Select a ticket")).toBeVisible();

    // There should be exactly one transferable ticket card
    const ticketCard = page.locator("[data-testid^='select-ticket-']").first();
    await expect(ticketCard).toBeVisible({ timeout: 10_000 });
    await ticketCard.click();

    // ── Step 2: Search for recipient ────────────────────────────────────
    await expect(page.getByText("2. Find recipient")).toBeVisible();

    const searchInput = page.getByTestId("recipient-search-input");
    await expect(searchInput).toBeVisible();
    await searchInput.fill(recipientEmail);

    // Wait for search results — either a user card or the email invite option
    const recipientCard = page.locator("[data-testid^='recipient-']").first();
    const emailInvite = page.getByTestId("invite-by-email");
    await expect(recipientCard.or(emailInvite)).toBeVisible({
      timeout: 10_000,
    });

    // Click whichever option appeared
    if (await recipientCard.isVisible()) {
      await recipientCard.click();
    } else {
      await emailInvite.click();
    }

    // Recipient should now be selected (search input replaced with selection card)
    await expect(page.getByRole("button", { name: /change/i })).toBeVisible({
      timeout: 5_000,
    });

    // ── Step 3: Confirm ─────────────────────────────────────────────────
    await expect(page.getByText("3. Confirm transfer")).toBeVisible();

    // Click review
    const reviewBtn = page.getByTestId("transfer-review-btn");
    await expect(reviewBtn).toBeVisible();
    await reviewBtn.click();

    // Confirmation warning should appear
    await expect(
      page.getByText(/are you sure|invitation will be sent/i),
    ).toBeVisible({ timeout: 5_000 });

    // Confirm the transfer
    const confirmBtn = page.getByTestId("transfer-confirm-btn");
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // ── Success screen ──────────────────────────────────────────────────
    await expect(
      page.getByRole("heading", {
        name: /ticket transferred|transfer invitation sent/i,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // "Back to My Order" button should be present
    await expect(
      page
        .getByRole("button", { name: /back to my order/i })
        .or(page.getByRole("link", { name: /back to my order/i })),
    ).toBeVisible();
  });

  // ── Test 2: Email-based transfer invitation ────────────────────────────

  test("buyer can send a transfer invitation to an email address", async ({
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
    const uid = Date.now();
    const buyerEmail = `buyer-email-xfer-${uid}@example.com`;
    const buyerPassword = "Password123!";

    await signUpUser(page, request, {
      email: buyerEmail,
      password: buyerPassword,
      name: "Email Transfer Buyer",
      username: `emailxfer${uid}`,
    });
    await signInUser(page, { email: buyerEmail, password: buyerPassword });

    const { token } = await signInAndGetToken(request, API_BASE_URL, {
      email: buyerEmail,
      password: buyerPassword,
    });
    const trpc = createE2eTrpcClient(request, API_BASE_URL, {
      bearerToken: token,
    });

    // ── Purchase ────────────────────────────────────────────────────────
    const checkoutResult = await purchaseTicket(trpc, seed, "e2e-email-xfer");

    // ── Navigate to transfer page ───────────────────────────────────────
    await page.goto(`/my-tickets/${checkoutResult.orderId}/transfer`);
    await expect(
      page.getByRole("heading", { name: /transfer a ticket/i }),
    ).toBeVisible({
      timeout: 15_000,
    });

    // ── Step 1: Select ticket ───────────────────────────────────────────
    const ticketCard = page.locator("[data-testid^='select-ticket-']").first();
    await expect(ticketCard).toBeVisible({ timeout: 10_000 });
    await ticketCard.click();

    // ── Step 2: Search for a non-existent email ─────────────────────────
    const nonExistentEmail = `nobody-${Date.now()}@example.com`;
    const searchInput = page.getByTestId("recipient-search-input");
    await searchInput.fill(nonExistentEmail);

    // Should show "invite by email" option since no user matches
    const emailInvite = page.getByTestId("invite-by-email");
    await expect(emailInvite).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/send to/i)).toBeVisible();
    await emailInvite.click();

    // Selection should show the email with "Will be invited to create an account"
    await expect(page.getByText(/will be invited/i)).toBeVisible({
      timeout: 5_000,
    });

    // ── Step 3: Confirm ─────────────────────────────────────────────────
    const reviewBtn = page.getByTestId("transfer-review-btn");
    await expect(reviewBtn).toBeVisible();
    await reviewBtn.click();

    // Should show email-specific confirmation text
    await expect(page.getByText(/invitation will be sent/i)).toBeVisible({
      timeout: 5_000,
    });

    // Method should say "Email invitation"
    await expect(page.getByText(/email invitation/i)).toBeVisible();

    const confirmBtn = page.getByTestId("transfer-confirm-btn");
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // ── Success screen (email variant) ──────────────────────────────────
    await expect(
      page.getByRole("heading", { name: /transfer invitation sent/i }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText(/invitation has been sent/i)).toBeVisible();
  });

  // ── Test 3: Transfer page with no transferable tickets ──────────────────

  test("transfer page shows empty state for fully refunded order", async ({
    page,
    request,
  }) => {
    expect(STRIPE_SECRET_KEY).toBeTruthy();

    // ── Seed + purchase + refund ────────────────────────────────────────
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

    const uid = Date.now();
    const email = `buyer-xfer-empty-${uid}@example.com`;
    const password = "Password123!";

    await signUpUser(page, request, {
      email,
      password,
      name: "Refunded Transfer Test",
      username: `xferempty${uid}`,
    });
    await signInUser(page, { email, password });

    const { token } = await signInAndGetToken(request, API_BASE_URL, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, API_BASE_URL, {
      bearerToken: token,
    });

    const checkoutResult = await purchaseTicket(trpc, seed, "e2e-xfer-empty");

    // Refund the order via E2E helper
    const refundRes = await request.post(
      `${API_BASE_URL}/e2e/orders/${checkoutResult.orderId}/refund`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: {},
      },
    );
    expect(
      refundRes.ok(),
      `Refund failed: ${await refundRes.text()}`,
    ).toBeTruthy();

    // ── Navigate to transfer page ───────────────────────────────────────
    await page.goto(`/my-tickets/${checkoutResult.orderId}/transfer`);
    await expect(
      page.getByRole("heading", { name: /transfer a ticket/i }),
    ).toBeVisible({
      timeout: 15_000,
    });

    // Should show "No transferable tickets available" empty state
    await expect(page.getByText(/no transferable tickets/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
