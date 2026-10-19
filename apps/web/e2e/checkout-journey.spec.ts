import Stripe from "stripe";
import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import { createMailpitClient } from "./helpers/mailpit";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { verifySignUpOtp } from "./helpers/verify-sign-up-otp";
import { PLATFORM_FEE_POLICY } from "@th/core/lib/pricing/platform-fee-policy";
import { computePlatformFeePerTicketCents } from "@th/core/lib/pricing/compute-ticket-price-for-agreement";
import { solveProcessingFeeGrossUp } from "@th/core/lib/pricing/processing-cost-schedule";
import {
  signInWithPasswordIfPrompted,
  signUpWithPassword,
} from "./helpers/sign-in";

// One resolution for both the reset call and the test body. Playwright's
// readiness probe reads PLAYWRIGHT_API_BASE_URL, so fall back to it before
// :3001, or a missing E2E_API_BASE_URL would reset the shared dev database.
const API_BASE_URL =
  process.env.E2E_API_BASE_URL ||
  process.env.PLAYWRIGHT_API_BASE_URL ||
  "http://localhost:3001";

/**
 * End-to-end checkout journey test.
 *
 * Validates the buyer-visible checkout pipeline through these stages:
 *
 *   1. **Event detail page** — event heading, location preview (map + text),
 *      ticket types section, and "Get Tickets" CTA.
 *   2. **Checkout: Ticket selection** — ticket type grid with names and prices,
 *      quantity steppers, order summary sidebar, and "Select your tickets" heading.
 *   3. **Checkout: Details → Payment** — a hold and checkout made over tRPC are
 *      resumed in the page (`?resumeOrderId=`), which lands on the Details step.
 *      The spec fills billing details, accepts the terms and refund policy, and
 *      continues to payment. That UI call replaces the tRPC order and
 *      PaymentIntent; the spec asserts the old ones are cancelled. The Payment
 *      Element shows its card field and the Pay button carries the all-in total.
 *   4. **Pay** — the UI's PaymentIntent amount is verified against the expected
 *      total, then confirmed programmatically (Stripe iframes can't be filled by
 *      Playwright) and the order is followed to SUCCEEDED.
 *
 * Fee calculation (every sale is priced PASS_THROUGH, `SALE_FEE_MODE`), once per ORDER:
 *   platformFee  = min(maxFeeCents, round(unitPrice * buyerFeePct))   per ticket
 *   net          = (unitPrice + platformFee) * qty              (no tax in this seed)
 *   processorFee = solveProcessingFeeGrossUp(net, processorFeePct, processorFixedCents)
 *   buyerTotal   = net + processorFee
 */
test.describe("Checkout Journey (event detail → ticket selection → payment)", () => {
  const TICKET_PRICE_CENTS = 3500; // $35.00

  // DERIVED from PLATFORM_FEE_POLICY, which is what `/e2e/seed/paid-checkout`
  // materializes via `seedFeePolicy`.
  const PROCESSOR_FEE_PCT = PLATFORM_FEE_POLICY.processsorFeePct;
  const PROCESSOR_FIXED_CENTS = PLATFORM_FEE_POLICY.processorFixedCents;

  function computePlatformFee(unitPriceCents: number): number {
    return computePlatformFeePerTicketCents(
      unitPriceCents,
      PLATFORM_FEE_POLICY,
    );
  }

  // Mirrors checkout: the processor fee is grossed up once over the order's
  // net. The seed carries no tax, so the net is face plus platform fee.
  function computeBuyerOrderTotal(unitPriceCents: number, qty: number): number {
    const net = (unitPriceCents + computePlatformFee(unitPriceCents)) * qty;
    const processorFee = solveProcessingFeeGrossUp(
      net,
      PROCESSOR_FEE_PCT,
      PROCESSOR_FIXED_CENTS,
    );
    return net + processorFee;
  }

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(request, API_BASE_URL);
  });

  test("walks through event detail, ticket selection, and stripe payment", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = API_BASE_URL;
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    const stripeAccountIdOverride =
      process.env.PLAYWRIGHT_E2E_STRIPE_ACCOUNT_ID ??
      process.env.E2E_STRIPE_ACCOUNT_ID;
    expect(stripeSecretKey).toBeTruthy();

    const stripe = new Stripe(stripeSecretKey);

    // ── PHASE 1: Seed event with location data ──────────────────────────
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
        location: {
          addressText: "100 Broadway",
          lat: 40.7128,
          lng: -74.006,
          locality: "New York",
          region: "NY",
          countryCode: "US",
        },
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventSlug).toBeTruthy();

    // ── PHASE 2: Sign up buyer ──────────────────────────────────────────
    const uniqueId = Date.now();
    const buyerEmail = `buyer-journey-e2e-${uniqueId}@example.com`;
    const buyerPassword = "Password123!";
    const buyerUsername = `buyerjourney${uniqueId}`;

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Journey Buyer",
      username: buyerUsername,
      email: buyerEmail,
      password: buyerPassword,
    });

    // Verify email via OTP. The link-flow was retired; sign-up now
    // emails a 6-digit code that we POST back to the email-otp endpoint.
    const mailpit = createMailpitClient({ request });
    await verifySignUpOtp({ request, apiBaseUrl, email: buyerEmail });
    await mailpit.clear();

    // Sign in to establish session
    // Already authenticated by the sign-up above in most runs, so this is
    // "sign in IF the card asks". The two-step flow lives in the helper.
    await signInWithPasswordIfPrompted(page, {
      email: buyerEmail,
      password: buyerPassword,
    });

    // Get JWT for tRPC
    const { token: buyerToken } = await signInAndGetToken(request, apiBaseUrl, {
      email: buyerEmail,
      password: buyerPassword,
    });
    expect(buyerToken).toBeTruthy();

    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: buyerToken,
    });

    // ═════════════════════════════════════════════════════════════════════
    // STAGE 1: Event Detail Page
    // ═════════════════════════════════════════════════════════════════════

    await page.goto(`/events/${seed.eventSlug}`);

    // Event heading
    await expect(
      page.getByRole("heading", { name: "E2E Paid Checkout Event" }),
    ).toBeVisible({ timeout: 15_000 });

    // Location text should be visible (seeded as "New York, NY" or "100 Broadway")
    await expect(page.getByText("100 Broadway")).toBeVisible({
      timeout: 5_000,
    });

    // Ticket types section: "General Admission" with price
    await expect(page.getByText("General Admission")).toBeVisible();
    await expect(page.getByText("$35.00")).toBeVisible();

    // "Get Tickets" CTA. The contextual action bar mounts twice on public
    // routes (shell + global overlays), so scope to the topmost dock to avoid
    // a strict-mode multiple-match.
    const getTicketsLink = page.getByTestId("event-get-tickets-btn");
    await expect(getTicketsLink).toBeVisible();

    // ═════════════════════════════════════════════════════════════════════
    // STAGE 2: Checkout — Ticket Selection
    // ═════════════════════════════════════════════════════════════════════

    await getTicketsLink.click();
    await page.waitForURL(
      (url) => url.pathname.includes(`/events/checkout/${seed.eventSlug}`),
      { timeout: 15_000 },
    );

    // "Select your tickets" heading
    await expect(page.getByText("Select your tickets")).toBeVisible({
      timeout: 10_000,
    });

    // Ticket type grid shows "General Admission" with price
    await expect(page.getByText("General Admission")).toBeVisible();
    await expect(page.getByText("$36.87")).toBeVisible();

    // Order summary sidebar prompt
    await expect(page.getByText("Order summary")).toBeVisible();
    await expect(
      page.getByText("Select tickets to see your order total"),
    ).toBeVisible();

    // Click + to select 1 ticket
    const increaseButton = page.getByRole("button", {
      name: /increase quantity — general admission/i,
    });
    await expect(increaseButton).toBeVisible();
    await increaseButton.click();

    // After selecting, order summary should update — "Select tickets..." prompt should disappear
    await expect(
      page.getByText("Select tickets to see your order total"),
    ).not.toBeVisible({ timeout: 5_000 });

    // The subtotal should show $35.00
    await expect(page.getByText("Subtotal")).toBeVisible();

    // ═════════════════════════════════════════════════════════════════════
    // STAGE 3: Checkout — Resume hold, Details → Payment Form
    // ═════════════════════════════════════════════════════════════════════

    // Hold tickets via tRPC so the page has a held order to resume
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(holdResult.order?.id).toBeTruthy();

    // Create checkout → generates PaymentIntent with clientSecret
    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-journey-${Date.now()}`,
      termsAccepted: true,
      refundPolicyAccepted: true,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const apiPaymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0]!;
    expect(apiPaymentIntentId).toMatch(/^pi_/);

    // Open the checkout page on the held order. A resumed hold restores the
    // cart and lands on the Details step, not on payment.
    await page.goto(
      `/events/checkout/${seed.eventSlug}?resumeOrderId=${checkoutResult.orderId}`,
    );

    // The buyer still gives billing details and accepts the terms and refund
    // policy before "Continue to payment" opens the Stripe form.
    await expect(page.getByText("Contact information")).toBeVisible({
      timeout: 15_000,
    });
    await page.locator("#checkout-address1").fill("100 Broadway");
    await page.locator("#checkout-city").fill("New York");
    await page.locator("#checkout-country").selectOption("US");
    await page.locator("#checkout-state").selectOption("NY");
    await page.locator("#checkout-postal").fill("10005");
    await page
      .getByRole("checkbox", { name: /terms of service.*refund policy/i })
      .check();
    // "Continue to payment" runs createCheckout again from the UI, which mints
    // a fresh PaymentIntent and cancels the one the tRPC call above made. Pay
    // (and assert the amount of) the UI's PaymentIntent, read off that response.
    const uiCheckoutResponse = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        res.url().includes("orders.createCheckout"),
      { timeout: 15_000 },
    );
    await page.getByTestId("checkout-continue-btn").click();
    const uiCheckoutBody = await (await uiCheckoutResponse).text();
    const uiPaymentIntentId = uiCheckoutBody.match(/(pi_\w+?)_secret_/)?.[1];
    expect(uiPaymentIntentId).toMatch(/^pi_/);
    expect(uiPaymentIntentId).not.toBe(apiPaymentIntentId);
    const paymentIntentId = uiPaymentIntentId!;
    // The UI's createCheckout also answers with the order it settles.
    const uiOrderId = uiCheckoutBody.match(/"orderId":"([^"]+)"/)?.[1];
    expect(uiOrderId).toBeTruthy();
    const orderId = uiOrderId!;

    // The UI's call retired the tRPC call's cart: its PaymentIntent must be
    // cancelled in Stripe (not left chargeable) and its order cancelled.
    const supersededPaymentIntent =
      await stripe.paymentIntents.retrieve(apiPaymentIntentId);
    expect(supersededPaymentIntent.status).toBe("canceled");
    const supersededOrder = await trpc.orders.getMyOrder.query({
      orderId: checkoutResult.orderId,
    });
    expect(supersededOrder.status).toBe("CANCELLED");

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    // Stripe payment card form should be visible
    // "Payment" heading
    await expect(page.getByRole("heading", { name: "Payment" })).toBeVisible({
      timeout: 15_000,
    });

    // The card field lives inside Stripe's Payment Element iframe, so it is
    // matched by Stripe's own accessible name, not the app's catalog copy.
    const cardFrame = page.frameLocator(
      // Stripe mounts three frames with this title (Link/Amazon Pay accessory
      // frames and the Payment Element); only the Payment Element's `allow`
      // grants passkey (`publickey-credentials-get`) access.
      'iframe[title="Secure payment input frame"][allow*="publickey-credentials-get"]',
    );
    await expect(
      cardFrame.getByRole("textbox", { name: "Card number" }),
    ).toBeVisible({ timeout: 15_000 });

    // The Pay button carries the all-in total, tied to the PaymentIntent's
    // amount so the charge and the label cannot drift apart.
    await expect(
      page.getByRole("button", {
        name: `Pay $${(paymentIntent.amount / 100).toFixed(2)}`,
        exact: true,
      }),
    ).toBeVisible();

    // ═════════════════════════════════════════════════════════════════════
    // STAGE 4: Verify PaymentIntent amount matches expected total
    // ═════════════════════════════════════════════════════════════════════

    const expectedBuyerTotal = computeBuyerOrderTotal(TICKET_PRICE_CENTS, 1);
    // Literal from the runbook's pricing formula for a $35.00 ticket; guards
    // the solver the derived value relies on.
    expect(expectedBuyerTotal).toBe(3687);
    expect(paymentIntent.amount).toBe(expectedBuyerTotal);
    expect(paymentIntent.currency).toBe("usd");

    // ═════════════════════════════════════════════════════════════════════
    // STAGE 5: Confirm payment → finalize order
    // ═════════════════════════════════════════════════════════════════════

    await confirmStripePaymentIntent({
      stripeSecretKey,
      paymentIntentId,
    });

    // Poll for order success (webhook processing)
    await expect
      .poll(
        async () => {
          try {
            const order = await trpc.orders.getMyOrder.query({
              orderId,
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

    // Final validation: the order's gross amount matches the seeded price
    const orderDetails = await trpc.orders.getMyOrder.query({
      orderId,
    });
    expect(orderDetails.status).toBe("SUCCEEDED");
    expect(orderDetails.amountGrossCents).toBe(TICKET_PRICE_CENTS);
    expect(orderDetails.feesPlatformCents).toBe(
      computePlatformFee(TICKET_PRICE_CENTS),
    );
    expect(orderDetails.stripePaymentIntentId).toBe(paymentIntentId);
  });
});
