import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import {
  signInWithPasswordIfPrompted,
  signUpWithPassword,
} from "./helpers/sign-in";

/**
 * E2E: Checkout — step-aware page controls.
 *
 * Every checkout control is owned by the page (the floating action bar was
 * removed 2026-08-27). This walks the buyer through tickets → details →
 * payment and asserts which controls each step offers:
 *
 *   tickets (no selection): back-to-event link, no hold CTA
 *   tickets (with seats):   back-to-event link + hold CTA
 *   details:                continue CTA, stepper marks "details" current
 *   payment (resumed via ?orderId=): the "details" marker only — no hold,
 *                           continue or view-order CTA, no back-to-event link,
 *                           no "tickets" marker (Stripe owns the Pay button)
 *
 * The stepper and the back-to-event link are always mounted, so step state is
 * asserted through each step's own content and the stepper's markers
 * (`checkout-step-*`), not by the stepper's presence/absence.
 */
test.describe("Checkout — step-aware page controls", () => {
  const TICKET_PRICE_CENTS = 3500;

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(
      request,
      process.env.E2E_API_BASE_URL || "http://localhost:3001",
    );
  });

  test("page controls reflect tickets → details → payment", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    const stripeAccountIdOverride =
      process.env.PLAYWRIGHT_E2E_STRIPE_ACCOUNT_ID ??
      process.env.E2E_STRIPE_ACCOUNT_ID;

    // ── Seed event ─────────────────────────────────────────────────────
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

    // ── Sign up + verify + sign in ─────────────────────────────────────
    const uniqueId = Date.now();
    const buyerEmail = `cab-buyer-${uniqueId}@example.com`;
    const buyerPassword = "Password123!";
    const buyerUsername = `cabbuyer${uniqueId}`;

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "CAB Buyer",
      username: buyerUsername,
      email: buyerEmail,
      password: buyerPassword,
    });

    const mailpit = createMailpitClient({ request });
    const verificationEmail = await mailpit.waitForEmailTo(buyerEmail);
    await page.goto(extractFirstUrlFromMailpitMessage(verificationEmail));
    await page.waitForURL((url) => !url.pathname.includes("verify-email"), {
      timeout: 10_000,
    });
    await mailpit.clear();

    // Already authenticated by the sign-up above in most runs, so this is
    // "sign in IF the card asks". The two-step flow lives in the helper.
    await signInWithPasswordIfPrompted(page, {
      email: buyerEmail,
      password: buyerPassword,
    });

    // ── tRPC client (used for the payment-step short-circuit) ──────────
    const { token: buyerToken } = await signInAndGetToken(request, apiBaseUrl, {
      email: buyerEmail,
      password: buyerPassword,
    });
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: buyerToken,
    });

    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: Tickets — no selection
    // ═══════════════════════════════════════════════════════════════════
    await page.goto(`/events/checkout/${seed.eventSlug}`);
    await expect(page.getByText("Select your tickets")).toBeVisible({
      timeout: 15_000,
    });

    const co = page;

    // Back to the event is always reachable; nothing to hold yet.
    await expect(
      co.locator('[data-testid="checkout-back-to-event"]'),
    ).toBeVisible();
    await expect(
      co.locator('[data-testid="checkout-sidebar-hold-btn"]'),
    ).toHaveCount(0);
    await expect(
      co.locator('[data-testid="checkout-continue-btn"]'),
    ).toHaveCount(0);
    await expect(
      co.locator('[data-testid="checkout-step-tickets"]'),
    ).toBeVisible();

    // ═══════════════════════════════════════════════════════════════════
    // STEP 1b: Tickets — with selection → ctaHold appears
    // ═══════════════════════════════════════════════════════════════════
    const increase = page.getByRole("button", {
      name: /increase general admission quantity/i,
    });
    await expect(increase).toBeVisible();
    await increase.click();

    await expect(
      co.locator('[data-testid="checkout-back-to-event"]'),
    ).toBeVisible();
    await expect(
      co.locator('[data-testid="checkout-sidebar-hold-btn"]'),
    ).toBeVisible();

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: Details — Back to tickets + Continue to payment
    // ═══════════════════════════════════════════════════════════════════
    await co.locator('[data-testid="checkout-sidebar-hold-btn"]').click();

    await expect(page.getByText("Contact information")).toBeVisible({
      timeout: 15_000,
    });

    await expect(
      co.locator('[data-testid="checkout-continue-btn"]'),
    ).toBeVisible();
    await expect(
      co.locator('[data-testid="checkout-sidebar-hold-btn"]'),
    ).toHaveCount(0);

    // The stepper is the step indicator: "details" is current here.
    await expect(
      co.locator('[data-testid="checkout-step-details"]'),
    ).toBeVisible();

    // Clicking the completed "tickets" step navigates back.
    await co.locator('[data-testid="checkout-step-tickets"]').click();
    await expect(page.getByText("Select your tickets")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      co.locator('[data-testid="checkout-continue-btn"]'),
    ).toHaveCount(0);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: Payment — Back to details only (Stripe owns Pay button)
    //
    // Reaching the payment step from the UI requires filling the billing
    // form (incl. Stripe Address Element). Instead, we hold + create the
    // checkout via tRPC and resume with `?orderId=`, which is the same
    // path the UI takes when a held order already exists.
    // ═══════════════════════════════════════════════════════════════════
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-cab-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });

    await page.goto(
      `/events/checkout/${seed.eventSlug}?orderId=${checkoutResult.orderId}`,
    );

    await expect(page.getByText("Payment")).toBeVisible({ timeout: 15_000 });

    await expect(
      co.locator('[data-testid="checkout-step-details"]'),
    ).toBeVisible();
    await expect(
      co.locator('[data-testid="checkout-sidebar-hold-btn"]'),
    ).toHaveCount(0);
    await expect(
      co.locator('[data-testid="checkout-continue-btn"]'),
    ).toHaveCount(0);
    await expect(
      co.locator('[data-testid="checkout-view-order-btn"]'),
    ).toHaveCount(0);
    await expect(
      co.locator('[data-testid="checkout-back-to-event"]'),
    ).toHaveCount(0);
    await expect(
      co.locator('[data-testid="checkout-step-tickets"]'),
    ).toHaveCount(0);
  });
});
