import { expect, test } from "./fixtures";
import Stripe from "stripe";
import { resetE2eState } from "./helpers/e2e-reset";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { ensureBetterAuthTestUserExists } from "./helpers/better-auth-test-user";
import { PLATFORM_FEE_POLICY } from "@th/core/lib/pricing/platform-fee-policy";
import { computePlatformFeePerTicketCents } from "@th/core/lib/pricing/compute-ticket-price-for-agreement";

/**
 * Adjustable Pricing (Donation / Pay-What-You-Want) E2E
 *
 * PREREQUISITES:
 *   - Stripe test keys configured (STRIPE_SECRET_KEY=sk_test_*)
 *   - `stripe listen --forward-to http://localhost:3001/webhooks/stripe`
 *   - Or run with E2E_STRIPE_MODE=stub for mock payment flow
 *
 * Tests the complete adjustable pricing flow:
 *
 *   1. Seed event with ADJUSTABLE ticket type (min $5, suggested $10)
 *   2. Buy ticket with donationAmountCents=$15 (buyer chooses $15)
 *   3. Verify order is marked nonRefundable
 *   4. Verify self-serve refund is blocked (getRefundEligibility)
 *   5. Verify buyer-initiated refundFullOrder throws forbidden
 *   6. Cancel event as organizer
 *   7. Verify refund IS issued (cancellation overrides non-refundable)
 *   8. Verify order status = REFUNDED
 *
 *   Also tests validation:
 *   - donationAmountCents below minimum is rejected
 *   - donationAmountCents missing for ADJUSTABLE type is rejected
 */
test.describe.serial("Adjustable Pricing — Donation Checkout Flow", () => {
  const DONATION_AMOUNT_CENTS = 1500; // buyer pays $15
  const MINIMUM_CENTS = 500; // $5 minimum
  const SUGGESTED_CENTS = 1000; // $10 suggested
  // DERIVED from the same constant the seed route materializes. For a donation
  // the "face" IS the chosen amount, so the fee is 3.33% of $15 = 50¢, which is
  // also exactly where the per-ticket cap binds.
  const PLATFORM_FEE_CENTS = computePlatformFeePerTicketCents(
    DONATION_AMOUNT_CENTS,
    PLATFORM_FEE_POLICY,
  );

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(
      request,
      process.env.E2E_API_BASE_URL || "http://localhost:3001",
    );
  });

  test("full adjustable pricing lifecycle: checkout, non-refundable, cancel override", async ({
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

    const stripe = new Stripe(stripeSecretKey);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 1: Seed event with ADJUSTABLE ticket type
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n📦 PHASE 1: Seeding event with ADJUSTABLE ticket type...");

    const seedRes = await request.post(
      `${apiBaseUrl}/e2e/seed/adjustable-checkout`,
      {
        headers: {
          "x-e2e-reset-secret": e2eResetSecret,
          "content-type": "application/json",
        },
        data: {
          minimumCents: MINIMUM_CENTS,
          suggestedCents: SUGGESTED_CENTS,
          ...(stripeAccountIdOverride
            ? { stripeAccountId: stripeAccountIdOverride }
            : {}),
        },
      },
    );
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    expect(seed.ticketTypeId).toBeTruthy();
    expect(seed.minimumCents).toBe(MINIMUM_CENTS);
    expect(seed.suggestedCents).toBe(SUGGESTED_CENTS);

    console.log(`  Event: ${seed.eventId}`);
    console.log(
      `  Ticket type: ${seed.ticketTypeId} (ADJUSTABLE, min $${MINIMUM_CENTS / 100})`,
    );

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 2: Create & authenticate buyer
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n👤 PHASE 2: Creating buyer...");

    const uniqueId = Date.now();
    const buyerEmail = `buyer-donation-${uniqueId}@example.com`;
    const password = "Password123!";

    await ensureBetterAuthTestUserExists({
      request,
      apiBaseUrl,
      email: buyerEmail,
      password,
      name: "Donation Test Buyer",
    });

    await request.post(`${apiBaseUrl}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: { email: buyerEmail },
    });

    const { token: buyerToken } = await signInAndGetToken(request, apiBaseUrl, {
      email: buyerEmail,
      password,
    });
    expect(buyerToken).toBeTruthy();

    const buyerTrpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: buyerToken,
    });
    console.log(`  Buyer: ${buyerEmail}`);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 3: Validate donation amount enforcement
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🔒 PHASE 3: Validating donation amount rules...");

    // 3a: Attempt checkout WITHOUT donationAmountCents — should fail
    try {
      await buyerTrpc.orders.createCheckout.mutate({
        eventId: seed.eventId,
        clientKey: `e2e-no-amount-${Date.now()}`,
        items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
        termsAccepted: true,
      });
      throw new Error("Should have rejected missing donationAmountCents");
    } catch (err: any) {
      expect(err.message).toContain("donation_amount_required");
      console.log("  Missing donationAmountCents correctly rejected");
    }

    // 3b: Attempt checkout with amount BELOW minimum — should fail
    try {
      await buyerTrpc.orders.createCheckout.mutate({
        eventId: seed.eventId,
        clientKey: `e2e-below-min-${Date.now()}`,
        items: [
          { ticketTypeId: seed.ticketTypeId, qty: 1, donationAmountCents: 100 },
        ],
        termsAccepted: true,
      });
      throw new Error("Should have rejected below-minimum amount");
    } catch (err: any) {
      expect(err.message).toContain("donation_below_minimum");
      console.log("  Below-minimum amount correctly rejected");
    }

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 4: Successful checkout with valid donation amount
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 4: Purchasing with $15 donation...");

    const checkoutResult = await buyerTrpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-donation-${Date.now()}`,
      items: [
        {
          ticketTypeId: seed.ticketTypeId,
          qty: 1,
          donationAmountCents: DONATION_AMOUNT_CENTS,
        },
      ],
      termsAccepted: true,
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    // Verify the gross amount is the donation amount (not a fixed price)
    expect(checkoutResult.amountGrossCents).toBe(DONATION_AMOUNT_CENTS);
    // Platform fee should be $0.50 (3.33% of $15, at the cap)
    expect(checkoutResult.feesPlatformCents).toBe(PLATFORM_FEE_CENTS);

    const orderId = checkoutResult.orderId;
    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    console.log(`  Order: ${orderId}`);
    console.log(
      `  Gross: $${(checkoutResult.amountGrossCents / 100).toFixed(2)}`,
    );
    console.log(
      `  Platform fee: $${(checkoutResult.feesPlatformCents / 100).toFixed(2)}`,
    );
    console.log(`  PI: ${paymentIntentId}`);

    // Confirm payment in Stripe
    await confirmStripePaymentIntent({ stripeSecretKey, paymentIntentId });
    console.log("  Payment confirmed");

    // Finalize via E2E endpoint
    const finalizeRes = await request.post(`${apiBaseUrl}/e2e/finalize-order`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: { orderId, paymentIntentId },
    });
    if (!finalizeRes.ok()) {
      console.log(
        `  Finalize via E2E endpoint failed (${finalizeRes.status()}), waiting for webhook`,
      );
    } else {
      console.log("  Order finalized via E2E endpoint");
    }

    // Wait for order to succeed
    await expect
      .poll(
        async () => {
          try {
            const order = await buyerTrpc.orders.getMyOrder.query({ orderId });
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
    console.log("  Order SUCCEEDED");

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 5: Verify order is non-refundable
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🚫 PHASE 5: Verifying order is non-refundable...");

    // 5a: Check refund eligibility returns non_refundable_order
    const eligibility = await buyerTrpc.orders.getRefundEligibility.query({
      orderId,
    });
    expect(eligibility.isEligible).toBe(false);
    expect(eligibility.reason).toBe("non_refundable_order");
    console.log(`  Eligibility: ${eligibility.reason} (correct!)`);

    // 5b: Attempt self-serve refund — should throw forbidden
    try {
      await buyerTrpc.orders.refundFullOrder.mutate({ orderId });
      throw new Error("Should have blocked buyer-initiated refund");
    } catch (err: any) {
      // The error should indicate the order is non-refundable
      expect(err.message).toMatch(/non_refundable|forbidden/i);
      console.log("  Buyer refund correctly blocked");
    }

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 6: Cancel event — should override non-refundable
    // ─────────────────────────────────────────────────────────────────────
    console.log(
      "\n🔥 PHASE 6: Cancelling event (should refund despite non-refundable)...",
    );

    // Authenticate as org owner
    await request.post(`${apiBaseUrl}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: { email: seed.email },
    });
    const { token: orgOwnerToken } = await signInAndGetToken(
      request,
      apiBaseUrl,
      {
        email: seed.email,
        password: seed.password,
      },
    );
    expect(orgOwnerToken).toBeTruthy();
    const orgOwnerTrpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: orgOwnerToken,
    });

    const cancelResult = await orgOwnerTrpc.events.cancelEvent.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-cancel-donation-${Date.now()}`,
    });

    expect(cancelResult.eventId).toBe(seed.eventId);
    expect(cancelResult.status).toBe("CANCELLED");
    expect(cancelResult.refundedOrderCount).toBeGreaterThanOrEqual(1);
    expect(cancelResult.failedRefundCount).toBe(0);

    console.log(`  Event cancelled: ${cancelResult.status}`);
    console.log(`  Orders refunded: ${cancelResult.refundedOrderCount}`);
    console.log(`  Failed refunds: ${cancelResult.failedRefundCount}`);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 7: Verify refund in Stripe
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n💰 PHASE 7: Verifying Stripe refund...");

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["charges.data.refunds"],
    });

    const charge = pi.latest_charge;
    expect(charge).toBeTruthy();

    const chargeObj =
      typeof charge === "string"
        ? await stripe.charges.retrieve(charge, { expand: ["refunds"] })
        : charge;

    const refunds = (chargeObj as any)?.refunds?.data ?? [];
    expect(refunds.length).toBeGreaterThan(0);

    const totalRefunded = refunds.reduce(
      (sum: number, r: any) => sum + (r.amount ?? 0),
      0,
    );
    expect(totalRefunded).toBeGreaterThan(0);

    console.log(`  Refund found: $${(totalRefunded / 100).toFixed(2)}`);
    console.log(`  Refund status: ${refunds[0]?.status}`);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 8: Verify final order status
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n✅ PHASE 8: Verifying final state...");

    const finalOrder = await buyerTrpc.orders.getMyOrder.query({ orderId });
    expect(finalOrder.status).toBe("REFUNDED");
    console.log(`  Order status: ${finalOrder.status}`);

    console.log("\n🎉 All adjustable pricing assertions passed!");
  });
});
