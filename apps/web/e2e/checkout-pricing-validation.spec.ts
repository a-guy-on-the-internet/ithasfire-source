import { expect, test } from "./fixtures";
import Stripe from "stripe";
import { resetE2eState } from "./helpers/e2e-reset";
import { createMailpitClient } from "./helpers/mailpit";
import { verifySignUpOtp } from "./helpers/verify-sign-up-otp";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
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
 * Comprehensive E2E test for the paid checkout flow.
 *
 * This test validates that pricing is consistent across the entire checkout pipeline:
 *   1. Seeded ticket price (via seed route)
 *   2. listEventTicketTypes tRPC response
 *   3. createCheckout order items
 *   4. Stripe PaymentIntent amount (via Stripe API)
 *   5. getMyOrder response after payment succeeds
 *   6. Minted tickets exist via listMyOrderTickets
 *
 * Fee calculation (every sale is priced PASS_THROUGH, `SALE_FEE_MODE`), once per ORDER:
 *   platformFee  = min(maxFeeCents, round(unitPrice * buyerFeePct))   per ticket
 *   net          = (unitPrice + platformFee) * qty              (no tax in this seed)
 *   processorFee = solveProcessingFeeGrossUp(net, processorFeePct, processorFixedCents)
 *   buyerTotal   = net + processorFee
 */
test.describe("Checkout Pricing Validation", () => {
  // Known ticket price for the test
  const TICKET_PRICE_CENTS = 4200; // $42.00
  const QTY = 2;

  // Rates are derived from PLATFORM_FEE_POLICY, which
  // `/e2e/seed/paid-checkout` materializes via `seedFeePolicy`.
  const PROCESSOR_FEE_PCT = PLATFORM_FEE_POLICY.processsorFeePct;
  const PROCESSOR_FIXED_CENTS = PLATFORM_FEE_POLICY.processorFixedCents;

  /**
   * Computes the platform fee per ticket (the order's feesPlatformCents is this
   * times the ticket count).
   */
  function computePlatformFee(unitPriceCents: number): number {
    return computePlatformFeePerTicketCents(
      unitPriceCents,
      PLATFORM_FEE_POLICY,
    );
  }

  /**
   * Computes the buyer total for the whole order, the way checkout does: the
   * processor fee is grossed up once over the order's net, not per ticket.
   * The seed carries no tax, so the net is face plus platform fee.
   */
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

  test("validates pricing consistency from seed to webhook", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = API_BASE_URL;
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    expect(stripeSecretKey).toBeTruthy();

    const stripe = new Stripe(stripeSecretKey);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Seed event with explicit price
    // ─────────────────────────────────────────────────────────────────────────
    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret":
          process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
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

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Create & authenticate buyer
    // ─────────────────────────────────────────────────────────────────────────
    const uniqueId = Date.now();
    const email = `buyer-pricing-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyerpricing${uniqueId}`;

    // Sign up via UI (to establish session properly)
    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Pricing Buyer",
      username,
      email,
      password,
    });

    // Verify email with the 6-digit code Mailpit received.
    const mailpit = createMailpitClient({ request });
    await verifySignUpOtp({ request, apiBaseUrl, email });
    await mailpit.clear();

    // Sign in via UI to establish session in browser context.
    // After email verification, we need to explicitly sign in.
    // If already signed in, /sign-in redirects straight back out — hence the
    // "if prompted" flavour. The two-step flow lives in the helper.
    await signInWithPasswordIfPrompted(page, { email, password });

    // User is now signed in via the sign-up flow. Get a JWT token and create tRPC client.
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    expect(token).toBeTruthy();

    // Create tRPC client with bearer token authentication
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3: Validate listEventTicketTypes returns expected price
    // ─────────────────────────────────────────────────────────────────────────
    const ticketTypesRes = await trpc.events.listEventTicketTypes.query({
      eventId: seed.eventId,
    });

    expect(ticketTypesRes.eventId).toBe(seed.eventId);
    expect(ticketTypesRes.ticketTypes.length).toBeGreaterThan(0);

    const targetTicketType = ticketTypesRes.ticketTypes.find(
      (tt) => tt.id === seed.ticketTypeId,
    );
    expect(
      targetTicketType,
      "Ticket type not found in listEventTicketTypes",
    ).toBeTruthy();
    expect(targetTicketType!.priceCents).toBe(TICKET_PRICE_CENTS);

    console.log(
      `✓ listEventTicketTypes priceCents = ${targetTicketType!.priceCents} (expected ${TICKET_PRICE_CENTS})`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 4: Hold tickets via updateOrderItems
    // ─────────────────────────────────────────────────────────────────────────
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });

    expect(holdResult.order?.id).toBeTruthy();
    expect(holdResult.holdExpiresAt).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5: Create checkout and validate returned order + client secret
    // ─────────────────────────────────────────────────────────────────────────
    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-pricing-${Date.now()}`,
      termsAccepted: true,
      refundPolicyAccepted: true,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });

    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    expect(paymentIntentId).toMatch(/^pi_/);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 6: Validate Stripe PaymentIntent amount matches expected total
    // ─────────────────────────────────────────────────────────────────────────
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    // In PASS_THROUGH mode the buyer pays the net plus one grossed-up processor fee.
    const expectedTotal = computeBuyerOrderTotal(TICKET_PRICE_CENTS, QTY);
    const expectedSubtotal = TICKET_PRICE_CENTS * QTY;
    const expectedPlatformFee = computePlatformFee(TICKET_PRICE_CENTS) * QTY;

    console.log(`Pricing breakdown:`);
    console.log(`  Unit price: ${TICKET_PRICE_CENTS} cents`);
    console.log(
      `  Platform fee/ticket: ${computePlatformFee(TICKET_PRICE_CENTS)} cents`,
    );
    console.log(`  Quantity: ${QTY}`);
    console.log(`  Expected PI total: ${expectedTotal} cents`);
    console.log(`  Stripe PI amount: ${paymentIntent.amount} cents`);

    // Literal from the runbook's worked example; guards the solver the
    // derived value relies on.
    expect(expectedTotal).toBe(8785);
    expect(paymentIntent.amount).toBe(expectedTotal);
    expect(paymentIntent.currency).toBe("usd");
    expect(paymentIntent.status).toBe("requires_payment_method");

    console.log(
      `✓ Stripe PaymentIntent amount = ${paymentIntent.amount} (expected ${expectedTotal})`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 7: Confirm payment → Stripe delivers webhook to API
    // ─────────────────────────────────────────────────────────────────────────
    await confirmStripePaymentIntent({
      stripeSecretKey,
      paymentIntentId,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 8: Poll for order success (webhook processing)
    // ─────────────────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 9: Validate getMyOrder pricing matches expected
    // ─────────────────────────────────────────────────────────────────────────
    const orderDetails = await trpc.orders.getMyOrder.query({
      orderId: checkoutResult.orderId,
    });

    expect(orderDetails.status).toBe("SUCCEEDED");
    expect(orderDetails.amountGrossCents).toBe(expectedSubtotal);
    expect(orderDetails.feesPlatformCents).toBe(expectedPlatformFee);
    expect(orderDetails.currency).toBe("usd");
    expect(orderDetails.stripePaymentIntentId).toBe(paymentIntentId);

    // Validate ticket items
    const ticketItems = orderDetails.items.filter((i) => i.kind === "ticket");
    // The order carries one item per ticket, each with qty 1.
    expect(ticketItems.length).toBe(QTY);
    for (const item of ticketItems) {
      expect(item.qty).toBe(1);
      expect(item.amountCents).toBe(TICKET_PRICE_CENTS);
      expect(item.ticketTypeId).toBe(seed.ticketTypeId);
    }
    expect(ticketItems.reduce((sum, i) => sum + i.amountCents, 0)).toBe(
      expectedSubtotal,
    );

    console.log(
      `✓ getMyOrder amountGrossCents = ${orderDetails.amountGrossCents} (expected ${expectedSubtotal})`,
    );
    console.log(
      `✓ getMyOrder feesPlatformCents = ${orderDetails.feesPlatformCents} (expected ${expectedPlatformFee})`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 10: Verify tickets were minted
    // ─────────────────────────────────────────────────────────────────────────
    const ticketsRes = await trpc.orders.listMyOrderTickets.query({
      orderId: checkoutResult.orderId,
    });

    expect(ticketsRes.tickets.length).toBe(QTY);
    for (const ticket of ticketsRes.tickets) {
      expect(ticket.code).toBeTruthy();
      // Note: ticketTypeId is not included in listMyOrderTickets output schema
      // The ticket's existence and valid status confirms successful minting
      expect(ticket.status).toBe("VALID");
    }

    console.log(`✓ ${ticketsRes.tickets.length} ticket(s) minted`);
    console.log(`\n✅ All pricing validations passed!`);
  });
});
