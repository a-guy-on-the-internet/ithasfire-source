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
import { PLATFORM_FEE_POLICY } from "@th/core/lib/pricing/platform-fee-policy";
import { computePlatformFeePerTicketCents } from "@th/core/lib/pricing/compute-ticket-price-for-agreement";
import {
  signInWithPasswordIfPrompted,
  signUpWithPassword,
} from "./helpers/sign-in";

/**
 * Comprehensive E2E test for the full money flow:
 *
 *   1. Seed event with Agreement, AgreementLine, Payee, FeePolicy
 *   2. Buy a ticket (checkout + payment + webhook)
 *   3. Verify OrderSplits were created
 *   4. Create Settlement from OrderSplits
 *   5. Execute Payout (Stripe Transfer)
 *   6. Verify transfer shows in Stripe
 *
 * This test validates the entire revenue pipeline from ticket purchase
 * through to organizer payout.
 */
test.describe.serial("Full Money Flow", () => {
  const TICKET_PRICE_CENTS = 5000; // $50.00
  const QTY = 1;

  // DERIVED, not hand-copied. The seed route (`/e2e/seed/paid-checkout` →
  // `seedFeePolicy`) materializes PLATFORM_FEE_POLICY, so the expected fee is
  // computed from that same constant with the same single-sourced formula
  // production uses. A hardcoded 50 was green under BOTH the old flat-50¢
  // policy and the new capped 3.33% one — it could not tell them apart.
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

  test("validates full money flow from purchase to payout", async ({
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
    const e2eHeaders = {
      "x-e2e-reset-secret": e2eResetSecret,
      "content-type": "application/json",
    };

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Seed event with Agreement, Payee, and FeePolicy
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
    console.log(`✓ Seeded ticketType: ${seed.ticketTypeId}`);
    console.log(`✓ Seeded stripeAccountId: ${seed.stripeAccountId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Create & authenticate buyer
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n👤 PHASE 2: Creating and authenticating buyer...");

    const uniqueId = Date.now();
    const email = `buyer-moneyflow-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyermoneyflow${uniqueId}`;

    // Sign up via UI
    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Money Flow Buyer",
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
    // PHASE 3: Purchase ticket
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 3: Purchasing ticket...");

    // Hold tickets
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });
    expect(holdResult.order?.id).toBeTruthy();
    console.log(`✓ Ticket held, order: ${holdResult.order.id}`);

    // Create checkout
    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-moneyflow-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    console.log(`✓ Checkout created, PI: ${paymentIntentId}`);

    // Confirm payment
    await confirmStripePaymentIntent({
      stripeSecretKey,
      paymentIntentId,
    });
    console.log(`✓ Payment confirmed`);

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
    // PHASE 4: Verify OrderSplits were created (via tRPC)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n💰 PHASE 4: Verifying OrderSplits...");

    const splitsData = await trpc.splits.listForOrder.query({
      orderId: checkoutResult.orderId,
    });
    expect(splitsData.splits.length).toBeGreaterThan(0);

    // In NET_AFTER_PLATFORM_FEES mode, split amount = gross - platform fees
    const expectedGross = TICKET_PRICE_CENTS * QTY;
    const expectedPlatformFee = PLATFORM_FEE_CENTS * QTY;
    const expectedSplitAmount = expectedGross - expectedPlatformFee;

    console.log(`  Gross amount: ${expectedGross} cents`);
    console.log(`  Platform fee: ${expectedPlatformFee} cents`);
    console.log(`  Expected split: ${expectedSplitAmount} cents`);
    console.log(`  Actual split total: ${splitsData.totalCents} cents`);

    expect(splitsData.totalCents).toBe(expectedSplitAmount);
    console.log(
      `✓ OrderSplits verified: ${splitsData.splits.length} split(s), total ${splitsData.totalCents} cents`,
    );

    // Verify the payee has a Stripe account
    // `payee` is nullable on the wire: `splits.listForOrder` degrades a split
    // whose payee row does not resolve to `payee: null` rather than failing
    // the whole read. This flow seeds the payee, so a null here means the
    // seed or the split is wrong — throw rather than `!`, so the failure
    // names itself instead of surfacing as a property access on null.
    const payee = splitsData.splits[0].payee;
    if (!payee) {
      throw new Error(
        "splits.listForOrder returned payee: null for the seeded split — " +
          "the payee row did not resolve",
      );
    }
    expect(payee.stripeAccountId).toBeTruthy();
    expect(payee.payoutsEnabled).toBe(true);
    console.log(
      `✓ Payee verified: ${payee.id} with Stripe account ${payee.stripeAccountId}`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5: Write the ledger credits from the order's splits
    // ─────────────────────────────────────────────────────────────────────────
    // Post-cutover (spec 2026-08-10) revenue IS a SETTLEMENT_CREDIT ledger
    // entry — there is no Settlement row and no per-settlement transfer. In
    // production these are written inline at order finalize; this endpoint is
    // the same use case, driven explicitly.
    console.log("\n📋 PHASE 5: Writing ledger credits...");

    const creditsResponse = await request.post(
      `${apiBaseUrl}/e2e/settlements/create-from-order`,
      {
        headers: e2eHeaders,
        data: { orderId: checkoutResult.orderId },
      },
    );
    expect(
      creditsResponse.ok(),
      `create-from-order failed: ${await creditsResponse.text()}`,
    ).toBeTruthy();
    const creditsData = await creditsResponse.json();
    expect(creditsData.credits.length).toBeGreaterThan(0);

    const payeeCredit = creditsData.credits.find(
      (c: { payeeId: string }) => c.payeeId === payee.id,
    );
    expect(payeeCredit, "no ledger credit for the seeded payee").toBeTruthy();
    console.log(
      `✓ Ledger credit written: ${payeeCredit.entryId} for ${payeeCredit.amountCents} cents`,
    );
    expect(payeeCredit.amountCents).toBe(expectedSplitAmount);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 6: Run the REAL payout batch (the only path that moves money)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🏦 PHASE 6: Running the payout batch...");

    // Ensure the platform has available funds in test mode
    const hasFunds = await ensureStripeTestFunds(
      request,
      apiBaseUrl,
      payeeCredit.amountCents,
    );
    expect(
      hasFunds,
      "Failed to ensure Stripe test funds for transfer",
    ).toBeTruthy();

    const batchResponse = await request.post(
      `${apiBaseUrl}/e2e/settlements/run-batch`,
      { headers: e2eHeaders, data: { limit: 100 } },
    );
    expect(
      batchResponse.ok(),
      `run-batch failed: ${await batchResponse.text()}`,
    ).toBeTruthy();
    const batchResult = await batchResponse.json();

    console.log(
      `✓ Batch: ${batchResult.itemsTransferred} transferred, ` +
        `${batchResult.itemsFailed} failed, ` +
        `${batchResult.totalTransferredCents} cents out, ` +
        `${batchResult.totalPayableClaimedCents} cents claimed`,
    );
    expect(batchResult.itemsFailed).toBe(0);
    expect(batchResult.itemsTransferred).toBeGreaterThan(0);

    // The payout item for OUR payee. Other seeded payees may also be payable
    // in a shared dev database, so assert on ours specifically rather than on
    // the batch totals.
    const itemsResponse = await request.get(
      `${apiBaseUrl}/e2e/payouts/${batchResult.payoutId}/items`,
      { headers: e2eHeaders },
    );
    expect(
      itemsResponse.ok(),
      `payout items lookup failed: ${await itemsResponse.text()}`,
    ).toBeTruthy();
    const itemsData = await itemsResponse.json();
    const ourItem = itemsData.items.find(
      (i: { payeeId: string }) => i.payeeId === payee.id,
    );
    expect(ourItem, "no payout item for the seeded payee").toBeTruthy();
    expect(ourItem.status).toBe("transferred");
    expect(ourItem.stripeTransferId).toMatch(/^tr_/);
    // The PAYABLE CLAIMED equals the split; with no reserve or Connect fee in
    // play the transfer equals it too.
    expect(ourItem.amountCents).toBe(expectedSplitAmount);
    expect(ourItem.plannedNetCents).toBe(expectedSplitAmount);
    // The durable plan names the credit this payout consumed.
    expect(ourItem.plannedCreditEntryIds).toContain(payeeCredit.entryId);

    const transferData = { stripeTransferId: ourItem.stripeTransferId };
    console.log(`✓ Stripe Transfer created: ${transferData.stripeTransferId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 7: Verify transfer in Stripe
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n✅ PHASE 7: Verifying Stripe Transfer...");

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
    // PHASE 8: Verify the LEDGER settled — the money's actual source of truth
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🔍 PHASE 8: Verifying the ledger...");

    const ledgerResponse = await request.get(
      `${apiBaseUrl}/e2e/payees/${payee.id}/ledger?currency=usd`,
      { headers: e2eHeaders },
    );
    expect(
      ledgerResponse.ok(),
      `ledger lookup failed: ${await ledgerResponse.text()}`,
    ).toBeTruthy();
    const ledger = await ledgerResponse.json();

    // The credit is CONSUMED by the payout entry, and a PAYOUT entry records
    // the payable claimed. Together they net this order to zero: the payee has
    // been paid and the balance no longer says they are owed.
    const credit = ledger.entries.find(
      (e: { id: string }) => e.id === payeeCredit.entryId,
    );
    expect(credit, "the settlement credit vanished").toBeTruthy();
    expect(credit.consumedByEntryId).toBeTruthy();

    const payoutEntry = ledger.entries.find(
      (e: { id: string }) => e.id === credit.consumedByEntryId,
    );
    expect(payoutEntry, "the consuming payout entry is missing").toBeTruthy();
    expect(payoutEntry.type).toBe("PAYOUT");
    expect(payoutEntry.amountCents).toBe(expectedSplitAmount);
    expect(payoutEntry.metadata.consumedCreditEntryIds).toContain(
      payeeCredit.entryId,
    );

    console.log(
      `✓ Credit ${credit.id} consumed by PAYOUT ${payoutEntry.id} (${payoutEntry.amountCents} cents)`,
    );

    // Re-running the batch must NOT pay again: the PAYOUT entry drove the
    // payable to zero and the credit is consumed. This is spec §11's
    // idempotency criterion, driven end to end.
    const replayResponse = await request.post(
      `${apiBaseUrl}/e2e/settlements/run-batch`,
      { headers: e2eHeaders, data: { limit: 100 } },
    );
    expect(replayResponse.ok()).toBeTruthy();
    const replay = await replayResponse.json();
    const replayItems = replay.payoutId
      ? await (
          await request.get(
            `${apiBaseUrl}/e2e/payouts/${replay.payoutId}/items`,
            { headers: e2eHeaders },
          )
        ).json()
      : { items: [] };
    expect(
      replayItems.items.filter(
        (i: { payeeId: string }) => i.payeeId === payee.id,
      ),
    ).toHaveLength(0);
    console.log("✓ Re-running the batch paid this payee nothing (idempotent)");

    // ─────────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(60));
    console.log("✅ FULL MONEY FLOW TEST PASSED!");
    console.log("═".repeat(60));
    console.log(`
Summary:
  Ticket Price:     $${(TICKET_PRICE_CENTS / 100).toFixed(2)}
  Quantity:         ${QTY}
  Gross Amount:     $${(expectedGross / 100).toFixed(2)}
  Platform Fee:     $${(expectedPlatformFee / 100).toFixed(2)}
  Net to Organizer: $${(expectedSplitAmount / 100).toFixed(2)}
  
  Order ID:         ${checkoutResult.orderId}
  Payment Intent:   ${paymentIntentId}
  Ledger Credit:    ${payeeCredit.entryId}
  Stripe Transfer:  ${transfer.id}
`);
  });

  test("validates refund flow for buyer's order (pre-settlement)", async ({
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
    // PHASE 1: Seed event with Agreement, Payee, and FeePolicy
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📦 PHASE 1: Seeding event with Agreement and Payee...");

    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": e2eResetSecret,
        "content-type": "application/json",
      },
      data: {
        priceCents: TICKET_PRICE_CENTS,
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    console.log(`✓ Seeded event: ${seed.eventId}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Create & authenticate buyer
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n👤 PHASE 2: Creating and authenticating buyer...");

    const uniqueId = Date.now();
    const email = `buyer-refund-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyerrefund${uniqueId}`;

    // Sign up via UI
    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Refund Test Buyer",
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
    // PHASE 3: Purchase ticket
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 3: Purchasing ticket...");

    // Hold tickets
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });
    expect(holdResult.order?.id).toBeTruthy();
    console.log(`✓ Ticket held, order: ${holdResult.order.id}`);

    // Create checkout
    const checkoutResult = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-refund-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
    });
    expect(checkoutResult.orderId).toBeTruthy();
    expect(checkoutResult.clientSecret).toBeTruthy();

    const paymentIntentId = checkoutResult.clientSecret!.split("_secret_")[0];
    console.log(`✓ Checkout created, PI: ${paymentIntentId}`);

    // Confirm payment
    await confirmStripePaymentIntent({
      stripeSecretKey,
      paymentIntentId,
    });
    console.log(`✓ Payment confirmed`);

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
    // PHASE 4: Quote refund via tRPC (with retry for balance_transaction)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n💰 PHASE 4: Quoting refund...");

    // Stripe's balance_transaction may not be available immediately after payment.
    // Poll until we get a successful quote.
    let quoteResult: Awaited<
      ReturnType<typeof trpc.orders.quoteFullRefund.query>
    > | null = null;
    const quoteStartTime = Date.now();
    const quoteTimeout = 30_000; // 30 seconds
    const quoteIntervals = [500, 1000, 2000, 3000, 5000];
    let quoteAttempt = 0;

    while (!quoteResult && Date.now() - quoteStartTime < quoteTimeout) {
      try {
        quoteResult = await trpc.orders.quoteFullRefund.query({
          orderId: checkoutResult.orderId,
        });
      } catch (err) {
        const error = err as { message?: string };
        console.log(
          `  Attempt ${quoteAttempt + 1}: ${error.message || "unknown error"}`,
        );
        const interval =
          quoteIntervals[Math.min(quoteAttempt, quoteIntervals.length - 1)];
        await new Promise((r) => setTimeout(r, interval));
        quoteAttempt++;
      }
    }

    if (!quoteResult) {
      throw new Error(
        "Failed to get refund quote after polling - balance_transaction may not be ready",
      );
    }

    expect(quoteResult.orderId).toBe(checkoutResult.orderId);
    expect(quoteResult.currency).toBe("usd");
    expect(quoteResult.amountPaidCents).toBeGreaterThan(0);
    expect(quoteResult.stripeFeeCents).toBeGreaterThan(0);
    expect(quoteResult.refundableCents).toBe(
      quoteResult.amountPaidCents - quoteResult.stripeFeeCents,
    );

    console.log(`✓ Refund quote:`);
    console.log(`  Amount paid: ${quoteResult.amountPaidCents} cents`);
    console.log(`  Stripe fee: ${quoteResult.stripeFeeCents} cents`);
    console.log(`  Refundable: ${quoteResult.refundableCents} cents`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5: Execute refund via tRPC
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🔄 PHASE 5: Executing refund...");

    const refundResult = await trpc.orders.refundFullOrder.mutate({
      orderId: checkoutResult.orderId,
      reason: "requested_by_customer",
    });

    expect(refundResult.ok).toBe(true);
    expect(refundResult.orderId).toBe(checkoutResult.orderId);
    expect(refundResult.refundId).toBeTruthy();
    expect(refundResult.refundId).toMatch(/^re_/);
    expect(refundResult.refundedCents).toBe(quoteResult.refundableCents);

    console.log(`✓ Refund executed:`);
    console.log(`  Refund ID: ${refundResult.refundId}`);
    console.log(`  Refunded: ${refundResult.refundedCents} cents`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 6: Verify refund in Stripe
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n✅ PHASE 6: Verifying refund in Stripe...");

    const refund = await stripe.refunds.retrieve(refundResult.refundId);
    expect(refund.id).toBe(refundResult.refundId);
    expect(refund.amount).toBe(refundResult.refundedCents);
    expect(refund.status).toBe("succeeded");
    expect(refund.payment_intent).toBe(paymentIntentId);
    expect(refund.reason).toBe("requested_by_customer");

    console.log(`✓ Stripe Refund verified:`);
    console.log(`  ID: ${refund.id}`);
    console.log(`  Amount: ${refund.amount} cents`);
    console.log(`  Status: ${refund.status}`);
    console.log(`  Payment Intent: ${refund.payment_intent}`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 7: Verify order status changed to REFUNDED
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🔍 PHASE 7: Verifying order status...");

    const orderAfterRefund = await trpc.orders.getMyOrder.query({
      orderId: checkoutResult.orderId,
    });
    // We refund minus Stripe fees, so status should be PART_REFUNDED
    expect(orderAfterRefund.status).toBe("PART_REFUNDED");

    console.log(`✓ Order status: ${orderAfterRefund.status}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(60));
    console.log("✅ REFUND FLOW TEST PASSED!");
    console.log("═".repeat(60));
    console.log(`
Summary:
  Ticket Price:     $${(TICKET_PRICE_CENTS / 100).toFixed(2)}
  Amount Paid:      $${(quoteResult.amountPaidCents / 100).toFixed(2)}
  Stripe Fee:       $${(quoteResult.stripeFeeCents / 100).toFixed(2)}
  Amount Refunded:  $${(refundResult.refundedCents / 100).toFixed(2)}
  
  Order ID:         ${checkoutResult.orderId}
  Payment Intent:   ${paymentIntentId}
  Refund ID:        ${refund.id}
`);
  });
});
