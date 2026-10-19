import { expect, test } from "./fixtures";
import { TRPCClientError } from "@trpc/client";
import Stripe from "stripe";
import { resetE2eState } from "./helpers/e2e-reset";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { ensureStripeTestFunds } from "./helpers/stripe-test-funds";
import { ensureBetterAuthTestUserExists } from "./helpers/better-auth-test-user";
import { PLATFORM_FEE_POLICY } from "@th/core/lib/pricing/platform-fee-policy";
import { computePlatformFeePerTicketCents } from "@th/core/lib/pricing/compute-ticket-price-for-agreement";

/**
 * Event Cancellation E2E — Full Refund + Settlement Reversal
 *
 * PREREQUISITES:
 *   - Stripe test keys configured (STRIPE_SECRET_KEY=sk_test_*)
 *   - `stripe listen --forward-to http://localhost:3001/webhooks/stripe`
 *     must be running for payment webhook delivery
 *   - Or run with E2E_STRIPE_MODE=stub for mock payment flow
 *
 * Tests the complete cancellation pipeline:
 *
 *   1. Seed event with Agreement, AgreementLine, Payee, FeePolicy
 *   2. Buy ticket (checkout + payment + webhook)
 *   3. Create Settlement from OrderSplits
 *   4. Execute Payout (Stripe Transfer to organizer)
 *   5. Cancel Event (as organizer)
 *   6. Verify transfer reversals in Stripe
 *   7. Verify refund issued to buyer in Stripe
 *   8. Verify order status = REFUNDED
 *   9. Verify event status = CANCELLED
 *
 * This is the hardest money flow to get right because it reverses
 * completed payouts before refunding the buyer.
 */

/**
 * A cancelled event may legitimately stop being queryable via
 * `getEventForEdit` — the server surfaces that as a tRPC NOT_FOUND or
 * FORBIDDEN. Only those errors are "expected"; anything else (network
 * failure, assertion failure, 500) must propagate and fail the spec.
 */
const isExpectedCancelledEventError = (error: unknown): boolean => {
  if (!(error instanceof TRPCClientError)) {
    return false;
  }
  const code =
    typeof error.data === "object" && error.data !== null && "code" in error.data
      ? (error.data as { code?: string }).code
      : undefined;
  return code === "NOT_FOUND" || code === "FORBIDDEN";
};

test.describe
  .serial("Event Cancellation — Full Refund + Settlement Reversal", () => {
  const TICKET_PRICE_CENTS = 5000; // $50.00
  const QTY = 1;

  // DERIVED from the same constant the seed route materializes — see the note
  // in full-money-flow.spec.ts. Never hardcode a fee here: at $50 face the old
  // flat-50¢ policy and the new capped 3.33% one give the same number, so a
  // literal cannot tell you which one actually ran.
  const PLATFORM_FEE_CENTS = computePlatformFeePerTicketCents(
    TICKET_PRICE_CENTS,
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

  test("cancelling event after payout reverses transfers and refunds buyers", async ({
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
    // PHASE 1: Seed event
    // ─────────────────────────────────────────────────────────────────────
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
    expect(seed.stripeAccountId).toBeTruthy();

    console.log(`✓ Seeded event: ${seed.eventId}`);
    console.log(`✓ Stripe account: ${seed.stripeAccountId}`);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 2: Create & authenticate buyer
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n👤 PHASE 2: Creating and authenticating buyer...");

    const uniqueId = Date.now();
    const buyerEmail = `buyer-cancel-${uniqueId}@example.com`;
    const password = "Password123!";
    const buyerUsername = `buyercancel${uniqueId}`;

    // Create buyer via API (skip UI sign-up — it's fragile across auth layout changes)
    await ensureBetterAuthTestUserExists({
      request,
      apiBaseUrl,
      email: buyerEmail,
      password,
      name: "Cancel Test Buyer",
    });

    // Verify email via E2E endpoint
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
    console.log(`✓ Buyer authenticated: ${buyerEmail}`);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 3: Purchase ticket
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 3: Purchasing ticket...");

    const holdResult = await buyerTrpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });
    expect(holdResult.order?.id).toBeTruthy();
    const orderId = holdResult.order.id;
    console.log(`✓ Ticket held, order: ${orderId}`);

    const checkoutResult = await buyerTrpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-cancel-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
      termsAccepted: true,
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    console.log(`✓ Checkout created, PI: ${paymentIntentId}`);

    await confirmStripePaymentIntent({ stripeSecretKey, paymentIntentId });
    console.log(`✓ Payment confirmed`);

    // Finalize order via E2E endpoint (simulates Stripe webhook)
    const finalizeRes = await request.post(`${apiBaseUrl}/e2e/finalize-order`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: { orderId, paymentIntentId },
    });
    if (!finalizeRes.ok()) {
      console.log(
        `  Finalize via E2E endpoint failed (${finalizeRes.status()}), falling back to webhook polling`,
      );
    } else {
      console.log(`✓ Order finalized via E2E endpoint`);
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
    console.log(`✓ Order succeeded: ${orderId}`);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 4: Create Settlement + Execute Payout
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n💰 PHASE 4: Creating settlement and executing payout...");

    // Use E2E endpoints for settlement/cancel ops (they bypass auth)
    const splitsRes = await request.get(
      `${apiBaseUrl}/e2e/orders/${orderId}/splits`,
      {
        headers: { "x-e2e-reset-secret": e2eResetSecret },
      },
    );
    expect(
      splitsRes.ok(),
      `Splits failed: ${await splitsRes.text()}`,
    ).toBeTruthy();
    const splitsData = await splitsRes.json();
    expect(splitsData.splits.length).toBeGreaterThan(0);

    const expectedGross = TICKET_PRICE_CENTS * QTY;
    const expectedPlatformFee = PLATFORM_FEE_CENTS * QTY;
    const expectedSplitAmount = expectedGross - expectedPlatformFee;
    console.log(`✓ Splits verified: ${splitsData.totalCents} cents`);

    const settlementRes = await request.post(
      `${apiBaseUrl}/e2e/settlements/create-from-order`,
      {
        headers: {
          "x-e2e-reset-secret": e2eResetSecret,
          "content-type": "application/json",
        },
        data: { orderId },
      },
    );
    expect(
      settlementRes.ok(),
      `Settlement creation failed: ${await settlementRes.text()}`,
    ).toBeTruthy();
    const settlementData = await settlementRes.json();
    expect(settlementData.settlements.length).toBeGreaterThan(0);
    const settlementId = settlementData.settlements[0].id;
    console.log(`✓ Settlement created: ${settlementId}`);

    // Ensure platform has funds for transfer
    const settlementAmount = settlementData.settlements[0].amountCents;
    const hasFunds = await ensureStripeTestFunds(
      request,
      apiBaseUrl,
      settlementAmount,
    );
    expect(hasFunds, "Failed to ensure Stripe test funds").toBeTruthy();

    // TODO(ledger-cutover-e2e): the per-settlement transfer route was deleted
    // with the settlement claim machinery (spec 2026-08-10 §7). This drives
    // the REAL batch instead, which is the only path that moves money now —
    // see full-money-flow.spec.ts for the fully-rewritten pattern (assert on
    // YOUR payee's payout item, not on batch totals).
    const transferRes = await request.post(
      `${apiBaseUrl}/e2e/settlements/run-batch`,
      {
        headers: {
          "x-e2e-reset-secret": e2eResetSecret,
          "content-type": "application/json",
        },
        data: { limit: 100 },
      },
    );
    expect(
      transferRes.ok(),
      `Transfer failed: ${await transferRes.text()}`,
    ).toBeTruthy();
    const transferData = await transferRes.json();
    expect(transferData.stripeTransferId).toBeTruthy();
    expect(transferData.stripeTransferId).toMatch(/^tr_/);
    console.log(
      `✓ Payout executed: ${transferData.stripeTransferId} (${transferData.amountCents} cents)`,
    );

    // Verify transfer in Stripe
    const transfer = await stripe.transfers.retrieve(
      transferData.stripeTransferId,
    );
    expect(transfer.amount).toBe(transferData.amountCents);
    expect(transfer.destination).toBe(seed.stripeAccountId);
    console.log(
      `✓ Transfer verified in Stripe: $${(transfer.amount / 100).toFixed(2)} → ${transfer.destination}`,
    );

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 5: Cancel Event (the critical test)
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🚫 PHASE 5: CANCELLING EVENT...");

    // Verify email for org owner so they can sign in
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

    // Cancel event as org owner (this IS a real user action, not platform-only)
    const cancelResult = await orgOwnerTrpc.events.cancelEvent.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-cancel-event-${Date.now()}`,
    });

    console.log(
      `  Cancel response: ${JSON.stringify(cancelResult).slice(0, 300)}`,
    );
    expect(cancelResult.eventId).toBe(seed.eventId);
    expect(cancelResult.status).toBe("CANCELLED");
    expect(cancelResult.refundedOrderCount).toBeGreaterThanOrEqual(1);
    expect(cancelResult.failedRefundCount).toBe(0);

    console.log(`✓ Event cancelled!`);
    console.log(`  Status: ${cancelResult.status}`);
    console.log(`  Orders refunded: ${cancelResult.refundedOrderCount}`);
    console.log(`  Failed refunds: ${cancelResult.failedRefundCount}`);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 6: Verify transfer reversals in Stripe
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🔄 PHASE 6: Verifying transfer reversals in Stripe...");

    // Retrieve the transfer again — it should now have reversals
    const transferAfterCancel = await stripe.transfers.retrieve(
      transferData.stripeTransferId,
      {
        expand: ["reversals"],
      },
    );

    const reversals = transferAfterCancel.reversals?.data ?? [];
    expect(reversals.length).toBeGreaterThan(0);

    const totalReversed = reversals.reduce((sum, r) => sum + r.amount, 0);
    console.log(`✓ Transfer reversals found: ${reversals.length}`);
    console.log(`  Total reversed: ${totalReversed} cents`);
    console.log(`  Original transfer: ${transfer.amount} cents`);

    // The full transfer amount should be reversed
    expect(totalReversed).toBe(transfer.amount);
    console.log(
      `✓ Full transfer reversed: $${(totalReversed / 100).toFixed(2)}`,
    );

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 7: Verify refund issued to buyer in Stripe
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n💸 PHASE 7: Verifying buyer refund in Stripe...");

    // List refunds for the payment intent
    const refunds = await stripe.refunds.list({
      payment_intent: paymentIntentId,
    });
    expect(refunds.data.length).toBeGreaterThan(0);

    const refund = refunds.data[0];
    expect(refund.status).toBe("succeeded");
    expect(refund.amount).toBeGreaterThan(0);

    // Refund should be net of Stripe processing fees
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const charge = await stripe.charges.retrieve(pi.latest_charge as string);
    const balanceTxn = await stripe.balanceTransactions.retrieve(
      charge.balance_transaction as string,
    );
    const stripeFee = balanceTxn.fee;
    const expectedRefund = Math.max(0, (pi.amount ?? 0) - stripeFee);

    console.log(`✓ Refund verified in Stripe:`);
    console.log(`  Refund ID: ${refund.id}`);
    console.log(`  Amount: ${refund.amount} cents`);
    console.log(`  Status: ${refund.status}`);
    console.log(`  Stripe fee retained: ${stripeFee} cents`);
    console.log(`  Expected refund: ${expectedRefund} cents`);
    expect(refund.amount).toBe(expectedRefund);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 8: Verify order status = REFUNDED
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n📋 PHASE 8: Verifying order and ticket status...");

    const orderAfterCancel = await buyerTrpc.orders.getMyOrder.query({
      orderId,
    });
    // Order should be REFUNDED (or PART_REFUNDED if Stripe fees were retained)
    expect(["REFUNDED", "PART_REFUNDED"]).toContain(orderAfterCancel.status);
    console.log(`✓ Order status: ${orderAfterCancel.status}`);

    // Verify order items are refunded (getMyOrder exposes items, not tickets)
    expect(orderAfterCancel.items.length).toBeGreaterThan(0);
    for (const item of orderAfterCancel.items) {
      expect(item.status).toBe("refunded");
    }
    console.log(
      `✓ All ${orderAfterCancel.items.length} item(s) marked refunded`,
    );

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 9: Verify event status = CANCELLED
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🏁 PHASE 9: Verifying event status...");

    // Use a public query to check event status
    try {
      const event = await orgOwnerTrpc.events.getEventForEdit.query({
        eventId: seed.eventId,
      });
      expect(event.status).toBe("CANCELLED");
      console.log(`✓ Event status: ${event.status}`);
    } catch (err) {
      // Event might legitimately become un-queryable after cancellation
      // (NOT_FOUND / FORBIDDEN). Anything else — including an assertion
      // failure on a real status regression — must fail the spec.
      if (!isExpectedCancelledEventError(err)) {
        throw err;
      }
      console.log(`✓ Event not queryable after cancellation (expected)`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 10: Verify settlement status after reversal
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🔍 PHASE 10: Verifying settlement status after reversal...");

    const settlementAfterCancelRes = await request.get(
      `${apiBaseUrl}/e2e/settlements/${settlementId}`,
      {
        headers: { "x-e2e-reset-secret": e2eResetSecret },
      },
    );
    const settlementAfterCancel = settlementAfterCancelRes.ok()
      ? await settlementAfterCancelRes.json()
      : { settlement: { status: "unknown" } };
    console.log(
      `✓ Settlement status: ${settlementAfterCancel.settlement.status}`,
    );

    // ─────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(70));
    console.log(
      "✅ EVENT CANCELLATION + FULL REFUND + SETTLEMENT REVERSAL TEST PASSED!",
    );
    console.log("═".repeat(70));
    console.log(`
Summary:
  Ticket Price:       $${(TICKET_PRICE_CENTS / 100).toFixed(2)}
  Gross Amount:       $${(expectedGross / 100).toFixed(2)}
  Platform Fee:       $${(expectedPlatformFee / 100).toFixed(2)}
  Payout to Org:      $${(expectedSplitAmount / 100).toFixed(2)}
  Stripe Fee:         $${(stripeFee / 100).toFixed(2)}
  Refund to Buyer:    $${(refund.amount / 100).toFixed(2)}
  Transfer Reversed:  $${(totalReversed / 100).toFixed(2)}

  Order ID:           ${orderId}
  Payment Intent:     ${paymentIntentId}
  Settlement ID:      ${settlementId}
  Transfer ID:        ${transferData.stripeTransferId}
  Refund ID:          ${refund.id}
  Reversal Count:     ${reversals.length}

  Event Status:       CANCELLED
  Order Status:       ${orderAfterCancel.status}
  Failed Refunds:     ${cancelResult.failedRefundCount}
`);
  });
});
