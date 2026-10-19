import { expect, test } from "./fixtures";
import Stripe from "stripe";
import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { ensureStripeTestFunds } from "./helpers/stripe-test-funds";
import {
  signInWithPasswordIfPrompted,
  signUpWithPassword,
} from "./helpers/sign-in";

/**
 * E2E tests for item-level settlements with FULL Stripe integration:
 *
 *   1. Verifies that settlements create OrderItemSettlementLine records
 *      linking each OrderItem to its corresponding SettlementLine
 *   2. Validates that Stripe transfers mark items as paid out
 *   3. Validates that refund eligibility checks item-level paidOutAt
 *   4. Verifies Stripe transfer amounts match expected settlement amounts
 *
 * These tests exercise the complete money flow through Stripe to validate:
 * - Item-level payout tracking
 * - OrderItemSettlementLine join table population
 * - Stripe transfer creation and verification
 * - Post-transfer refund blocking
 */
/**
 * ⚠ SKIPPED — pending the ledger-cutover e2e rewrite.
 *
 * These specs drive per-ITEM settlement assertions through
 * `trpc.settlements.executeTransfer` and the `settlements` / `settlementLines`
 * shape of `createFromOrder`. Both were deleted by the ledger-authoritative
 * cutover (docs/specs/2026-08-10/completed/ledger-authoritative-settlement.spec.md §7):
 * money now moves only through `settlements.run-batch`, and item-level
 * attribution lives in each SETTLEMENT_CREDIT's `metadata.items` rather than
 * in `OrderItemSettlementLine` rows.
 *
 * Rewriting them is a real piece of work (the whole point of the file is
 * per-item settlement granularity, which is exactly the thing that changed
 * shape), so they are skipped rather than left red or silently deleted.
 * `full-money-flow.spec.ts` HAS been rewritten onto the real batch and is the
 * green end-to-end money proof in the meantime.
 *
 * TODO(ledger-cutover-e2e): rebuild against `POST /e2e/settlements/run-batch`
 * + `GET /e2e/payees/:payeeId/ledger`, asserting item attribution from the
 * credit metadata and `paidOutAt` on the order items.
 */
test.describe.skip("Item-Level Settlements (Full Stripe Flow)", () => {
  test.describe.configure({ mode: "serial" });

  const TICKET_PRICE_CENTS = 5000; // $50.00
  const QTY = 2; // Buy 2 tickets to test item-level tracking

  // Fee policy from seed (PASS_THROUGH mode)
  const BUYER_FEE_PCT = 0.065; // 6.5%
  const MAX_FEE_CENTS = 500;

  /**
   * Computes the platform fee per ticket.
   */
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

  test("full Stripe settlement flow creates OrderItemSettlementLine records and marks items paid out", async ({
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
    expect(seed.stripeAccountId).toBeTruthy();

    console.log(`✓ Seeded event: ${seed.eventId}`);
    console.log(`✓ Seeded stripeAccountId: ${seed.stripeAccountId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Create & authenticate buyer
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n👤 PHASE 2: Creating and authenticating buyer...");

    const uniqueId = Date.now();
    const email = `buyer-itemsettlement-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyeritemsettlement${uniqueId}`;

    // Sign up via UI
    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Item Settlement Buyer",
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

    // Sign in and get JWT
    // Already authenticated by the sign-up above in most runs, so this is
    // "sign in IF the card asks". The two-step flow lives in the helper.
    await signInWithPasswordIfPrompted(page, {
      email,
      password,
    });

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
    // PHASE 3: Purchase 2 tickets
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 3: Purchasing 2 tickets...");

    // Hold tickets
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });
    expect(holdResult.order?.id).toBeTruthy();
    console.log(`✓ Tickets held, order: ${holdResult.order.id}`);

    // Create checkout
    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-itemsettlement-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    console.log(`✓ Checkout created, PI: ${paymentIntentId}`);

    // Confirm payment via Stripe
    await confirmStripePaymentIntent({
      stripeSecretKey,
      paymentIntentId,
    });
    console.log(`✓ Payment confirmed via Stripe`);

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
    console.log(`  Actual split total: ${splitsData.totalCents} cents`);

    expect(splitsData.totalCents).toBe(expectedSplitAmount);
    console.log(`✓ OrderSplits verified: ${splitsData.splits.length} split(s)`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5: Create Settlement from Order (via tRPC)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📋 PHASE 5: Creating Settlement...");

    // DELETED SURFACE (spec 2026-08-10 §7): `createFromOrder` now returns
    // ledger `credits`, not `settlements`/`settlementLines`. Cast keeps this
    // skipped body readable for the rewrite instead of deleting the intent.
    const settlementData = (await trpc.settlements.createFromOrder.mutate({
      orderId: checkoutResult.orderId,
    })) as any;
    expect(settlementData.settlements.length).toBeGreaterThan(0);
    expect(settlementData.settlementLines.length).toBeGreaterThan(0);

    const settlementId = settlementData.settlements[0].id;
    const settlementAmount = settlementData.settlements[0].amountCents;
    console.log(`✓ Settlement created: ${settlementId}`);
    console.log(`✓ Settlement amount: ${settlementAmount} cents`);
    console.log(`✓ Settlement lines: ${settlementData.settlementLines.length}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 6: Verify OrderItemSettlementLine records were created
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🔗 PHASE 6: Verifying OrderItemSettlementLine records...");

    const settlementDetailsRes = await request.get(
      `${apiBaseUrl}/e2e/orders/${checkoutResult.orderId}/settlement-details`,
      {
        headers: {
          "x-e2e-reset-secret": e2eResetSecret,
        },
      },
    );
    expect(settlementDetailsRes.ok()).toBeTruthy();

    const settlementDetails = await settlementDetailsRes.json();

    // We bought 2 tickets of the same ticket type, so we have 2 OrderItems (one per ticket)
    // This enables partial refunds - each ticket can be settled/refunded independently
    expect(settlementDetails.items.length).toBe(QTY);
    for (const item of settlementDetails.items) {
      expect(item.qty).toBe(1); // Each OrderItem represents a single ticket
    }
    console.log(
      `✓ Order has ${settlementDetails.items.length} item(s) (1 per ticket)`,
    );

    // Should have 2 OrderItemSettlementLine records (one per OrderItem/ticket)
    expect(settlementDetails.orderItemSettlementLines.length).toBe(QTY);
    console.log(
      `✓ Found ${settlementDetails.orderItemSettlementLines.length} OrderItemSettlementLine record(s)`,
    );

    // Verify each item has a corresponding settlement line record
    for (const oisl of settlementDetails.orderItemSettlementLines) {
      expect(oisl.orderItemId).toBeTruthy();
      expect(oisl.settlementLineId).toBeTruthy();
      expect(oisl.amountCents).toBeGreaterThan(0);
      console.log(
        `  ✓ Item ${oisl.orderItemId} → SettlementLine ${oisl.settlementLineId} (${oisl.amountCents} cents)`,
      );
    }

    // Verify settlement status is "pending" before transfer
    const preTransferSettlement =
      settlementDetails.orderItemSettlementLines[0].settlement;
    expect(preTransferSettlement.status).toBe("pending");
    console.log(
      `✓ Settlement status before transfer: ${preTransferSettlement.status}`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 7: Execute Stripe Transfer (via tRPC)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🏦 PHASE 7: Executing Stripe Transfer...");

    // Ensure Stripe test account has sufficient funds for the transfer
    const hasFunds = await ensureStripeTestFunds(
      request,
      apiBaseUrl,
      settlementAmount,
    );
    expect(
      hasFunds,
      "Failed to ensure Stripe test funds for transfer",
    ).toBeTruthy();

    // Execute the transfer via tRPC
    // DELETED SURFACE: money moves only through `settlements.run-batch` now.
    const transferData = await (trpc.settlements as any).executeTransfer.mutate(
      { settlementId },
    );
    expect(transferData.stripeTransferId).toBeTruthy();
    expect(transferData.stripeTransferId).toMatch(/^tr_/);

    console.log(`✓ Stripe Transfer created: ${transferData.stripeTransferId}`);
    console.log(`✓ Transfer amount: ${transferData.amountCents} cents`);
    console.log(`✓ Destination: ${transferData.destinationAccountId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 8: Verify Stripe Transfer details
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n✅ PHASE 8: Verifying Stripe Transfer...");

    const transfer = await stripe.transfers.retrieve(
      transferData.stripeTransferId,
    );
    expect(transfer.id).toBe(transferData.stripeTransferId);
    expect(transfer.amount).toBe(expectedSplitAmount);
    expect(transfer.currency).toBe("usd");
    expect(transfer.destination).toBe(seed.stripeAccountId);

    console.log(`✓ Stripe Transfer verified:`);
    console.log(`  ID: ${transfer.id}`);
    console.log(`  Amount: ${transfer.amount} cents`);
    console.log(`  Currency: ${transfer.currency}`);
    console.log(`  Destination: ${transfer.destination}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 9: Verify items are marked as paid out
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 9: Verifying items are marked as paid out...");

    // Get order details via tRPC to check item paidOutAt
    const orderAfterTransfer = await trpc.orders.getMyOrder.query({
      orderId: checkoutResult.orderId,
    });

    expect(orderAfterTransfer.items).toBeTruthy();
    // 2 tickets = 2 OrderItems (one per ticket for granular refund/settlement tracking)
    expect(orderAfterTransfer.items.length).toBe(QTY);
    for (const item of orderAfterTransfer.items) {
      expect(item.qty).toBe(1); // Each item represents a single ticket
    }

    // Each item should have paidOutAt set
    for (const item of orderAfterTransfer.items) {
      expect(item.paidOutAt).toBeTruthy();
      expect(item.status).toBe("active");
      console.log(
        `✓ Item ${item.id}: paidOutAt = ${item.paidOutAt}, status = ${item.status}`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 10: Verify settlement status changed to "transferred"
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📊 PHASE 10: Verifying settlement status...");

    const settlementAfterTransfer = await trpc.settlements.get.query({
      settlementId,
    });
    expect(settlementAfterTransfer.settlement.status).toBe("transferred");
    expect(settlementAfterTransfer.settlement.stripeTransferId).toBe(
      transfer.id,
    );

    console.log(
      `✓ Settlement status: ${settlementAfterTransfer.settlement.status}`,
    );
    console.log(
      `✓ Settlement stripeTransferId: ${settlementAfterTransfer.settlement.stripeTransferId}`,
    );

    // Also verify via E2E endpoint that OrderItemSettlementLine settlement is updated
    const postTransferDetailsRes = await request.get(
      `${apiBaseUrl}/e2e/orders/${checkoutResult.orderId}/settlement-details`,
      {
        headers: {
          "x-e2e-reset-secret": e2eResetSecret,
        },
      },
    );
    const postTransferDetails = await postTransferDetailsRes.json();

    for (const oisl of postTransferDetails.orderItemSettlementLines) {
      expect(oisl.settlement.status).toBe("transferred");
      expect(oisl.settlement.stripeTransferId).toBe(transfer.id);
    }
    console.log(
      `✓ All OrderItemSettlementLine records show settlement as transferred`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 11: Verify refund is blocked for paid out items
    // ─────────────────────────────────────────────────────────────────────────
    console.log(
      "\n🔒 PHASE 11: Verifying refund blocked for paid out order...",
    );

    const eligibility = await trpc.orders.getRefundEligibility.query({
      orderId: checkoutResult.orderId,
    });

    expect(eligibility.isEligible).toBe(false);
    // Refund should be blocked because the order is settled/paid out
    expect(eligibility.reason).toMatch(/settled|paid_out/i);

    console.log(`✓ Refund eligibility: ${eligibility.isEligible}`);
    console.log(`✓ Reason: ${eligibility.reason}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(70));
    console.log("✅ ITEM-LEVEL SETTLEMENT (FULL STRIPE FLOW) TEST PASSED!");
    console.log("═".repeat(70));
    console.log(`
Summary:
  Ticket Price:               $${(TICKET_PRICE_CENTS / 100).toFixed(2)}
  Quantity:                   ${QTY}
  Gross Amount:               $${(expectedGross / 100).toFixed(2)}
  Platform Fee:               $${(expectedPlatformFee / 100).toFixed(2)}
  Net to Organizer:           $${(expectedSplitAmount / 100).toFixed(2)}
  
  Order ID:                   ${checkoutResult.orderId}
  Payment Intent:             ${paymentIntentId}
  Settlement ID:              ${settlementId}
  Stripe Transfer:            ${transfer.id}
  
  OrderItemSettlementLines:   ${settlementDetails.orderItemSettlementLines.length}
  Items Paid Out:             ${orderAfterTransfer.items.length}
  Refund Blocked:             Yes (items already settled via Stripe)
`);
  });

  test("verifies item-level paidOutAt via Stripe transfer (not E2E helper)", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
    expect(stripeSecretKey).toBeTruthy();

    const stripe = new Stripe(stripeSecretKey);

    // ─────────────────────────────────────────────────────────────────────────
    // Setup: Seed event and authenticate buyer (abbreviated)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📦 Setup: Seeding event and authenticating buyer...");

    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: { priceCents: TICKET_PRICE_CENTS },
    });
    expect(seedRes.ok()).toBeTruthy();
    const { seed } = await seedRes.json();

    const uniqueId = Date.now();
    const email = `buyer-itemlevel-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyeritemlevel${uniqueId}`;

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Item Level Buyer",
      username,
      email,
      password,
    });

    const mailpit = createMailpitClient({ request });
    const verificationEmail = await mailpit.waitForEmailTo(email);
    await page.goto(extractFirstUrlFromMailpitMessage(verificationEmail));
    await mailpit.clear();

    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });
    console.log(`✓ Setup complete`);

    // ─────────────────────────────────────────────────────────────────────────
    // Purchase tickets
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🎫 Purchasing tickets...");

    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });

    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-itemlevel-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    await confirmStripePaymentIntent({ stripeSecretKey, paymentIntentId });

    await expect
      .poll(
        async () => {
          try {
            return (
              await trpc.orders.getMyOrder.query({
                orderId: checkoutResult.orderId,
              })
            ).status;
          } catch {
            return null;
          }
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe("SUCCEEDED");

    console.log(`✓ Order succeeded: ${checkoutResult.orderId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Verify items have NO paidOutAt before settlement
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📊 Verifying items have NO paidOutAt before settlement...");

    const orderBeforeSettlement = await trpc.orders.getMyOrder.query({
      orderId: checkoutResult.orderId,
    });

    for (const item of orderBeforeSettlement.items) {
      expect(item.paidOutAt).toBeFalsy();
      console.log(
        `  Item ${item.id}: paidOutAt = ${item.paidOutAt} (expected: null)`,
      );
    }
    console.log(`✓ All items have paidOutAt = null before settlement`);

    // ─────────────────────────────────────────────────────────────────────────
    // Create and execute settlement via Stripe
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🏦 Creating and executing settlement via Stripe...");

    // DELETED SURFACE (spec 2026-08-10 §7): `createFromOrder` now returns
    // ledger `credits`, not `settlements`/`settlementLines`. Cast keeps this
    // skipped body readable for the rewrite instead of deleting the intent.
    const settlementData = (await trpc.settlements.createFromOrder.mutate({
      orderId: checkoutResult.orderId,
    })) as any;
    const settlementId = settlementData.settlements[0].id;
    const settlementAmount = settlementData.settlements[0].amountCents;

    // Ensure Stripe test account has sufficient funds for the transfer
    const hasFunds = await ensureStripeTestFunds(
      request,
      apiBaseUrl,
      settlementAmount,
    );
    expect(
      hasFunds,
      "Failed to ensure Stripe test funds for transfer",
    ).toBeTruthy();

    // DELETED SURFACE: money moves only through `settlements.run-batch` now.
    const transferData = await (trpc.settlements as any).executeTransfer.mutate(
      { settlementId },
    );
    expect(transferData.stripeTransferId).toMatch(/^tr_/);
    console.log(`✓ Stripe transfer executed: ${transferData.stripeTransferId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Verify items NOW have paidOutAt after Stripe transfer
    // ─────────────────────────────────────────────────────────────────────────
    console.log(
      "\n✅ Verifying items NOW have paidOutAt after Stripe transfer...",
    );

    const orderAfterSettlement = await trpc.orders.getMyOrder.query({
      orderId: checkoutResult.orderId,
    });

    for (const item of orderAfterSettlement.items) {
      expect(item.paidOutAt).toBeTruthy();
      console.log(`  Item ${item.id}: paidOutAt = ${item.paidOutAt} ✓`);
    }
    console.log(`✓ All items have paidOutAt set after Stripe transfer`);

    // ─────────────────────────────────────────────────────────────────────────
    // Verify refund is blocked
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🔒 Verifying refund is blocked...");

    const eligibility = await trpc.orders.getRefundEligibility.query({
      orderId: checkoutResult.orderId,
    });
    expect(eligibility.isEligible).toBe(false);
    console.log(`✓ Refund blocked: ${eligibility.reason}`);

    console.log("\n" + "═".repeat(60));
    console.log("✅ ITEM-LEVEL PAIDOUTAT VIA STRIPE TEST PASSED!");
    console.log("═".repeat(60));
  });
});
