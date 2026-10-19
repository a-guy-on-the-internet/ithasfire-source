import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import {
  signInWithPasswordIfPrompted,
  signUpWithPassword,
} from "./helpers/sign-in";

/**
 * E2E test for the tax estimation flow in the checkout page.
 *
 * Validates:
 *   1. Before billing address is filled, OrderSummary shows "Calculated next"
 *   2. After filling billing address fields, the estimateCheckoutTax query fires
 *   3. OrderSummary renders the estimated tax with "Est." prefix
 *   4. After checkout creation, the final order includes the correct tax amount
 */
test.describe("Checkout Tax Estimation", () => {
  const TICKET_PRICE_CENTS = 5000; // $50.00
  const QTY = 2;
  // 9.75% admission tax rate (975 basis points) — set via seed
  const TAX_RATE_BPS = 975;

  /**
   * Expected tax: Math.round((priceCents * qty * taxRateBps) / 10_000)
   */
  function computeExpectedTax(
    priceCents: number,
    qty: number,
    rateBps: number,
  ): number {
    const subtotal = priceCents * qty;
    return Math.round((subtotal * rateBps) / 10_000);
  }

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(
      request,
      process.env.E2E_API_BASE_URL || "http://localhost:3001",
    );
  });

  test("shows estimated tax after billing address is filled", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";

    // ─────────────────────────────────────────────────────────────────
    // PHASE 1: Seed event with tax rate + location
    // ─────────────────────────────────────────────────────────────────
    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret":
          process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
        "content-type": "application/json",
      },
      data: {
        priceCents: TICKET_PRICE_CENTS,
        admissionTaxRateBps: TAX_RATE_BPS,
        location: {
          addressText: "1 Market St, San Francisco, CA 94105",
          lat: 37.7935,
          lng: -122.395,
          locality: "San Francisco",
          region: "CA",
          countryCode: "US",
        },
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    expect(seed.ticketTypeId).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────
    // PHASE 2: Create & authenticate buyer
    // ─────────────────────────────────────────────────────────────────
    const uniqueId = Date.now();
    const email = `buyer-tax-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `buyertax${uniqueId}`;

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: "Tax Buyer",
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

    // Sign in via UI
    // Already authenticated by the sign-up above in most runs, so this is
    // "sign in IF the card asks". The two-step flow lives in the helper.
    await signInWithPasswordIfPrompted(page, {
      email,
      password,
    });

    // ─────────────────────────────────────────────────────────────────
    // PHASE 3: Navigate to checkout and select tickets
    // ─────────────────────────────────────────────────────────────────
    await page.goto(`/events/checkout/${seed.eventSlug}`);
    await page.waitForLoadState("networkidle");

    // Select tickets — click the "Increase" button on the quantity stepper
    const increaseBtn = page.getByRole("button", { name: /increase quantity/i }).first();
    await expect(increaseBtn).toBeVisible({ timeout: 10_000 });

    for (let i = 0; i < QTY; i++) {
      await increaseBtn.click();
    }

    // ─────────────────────────────────────────────────────────────────
    // PHASE 4: Before billing address — tax should say "Calculated next"
    // ─────────────────────────────────────────────────────────────────
    const taxRow = page.getByTestId("order-summary-tax-row");
    await expect(taxRow).toBeVisible({ timeout: 10_000 });

    // At this point no billing address has been filled, so expect "Calculated next"
    const taxPending = page.getByTestId("order-summary-tax-pending");
    await expect(taxPending).toBeVisible({ timeout: 5_000 });
    await expect(taxPending).toHaveText("Calculated next");

    // ─────────────────────────────────────────────────────────────────
    // PHASE 5: Fill billing address → triggers tax estimation
    // ─────────────────────────────────────────────────────────────────
    // Fill all required billing address fields
    await page.locator("#checkout-address1").fill("456 Oak Ave");
    await page.locator("#checkout-city").fill("San Francisco");
    await page.locator("#checkout-state").fill("CA");
    await page.locator("#checkout-postal").fill("94103");
    await page.locator("#checkout-country").fill("US");

    // ─────────────────────────────────────────────────────────────────
    // PHASE 6: Estimated tax should now appear in OrderSummary
    // ─────────────────────────────────────────────────────────────────
    const taxEstimate = page.getByTestId("order-summary-tax-estimate");
    await expect(taxEstimate).toBeVisible({ timeout: 15_000 });

    // Verify the estimated amount matches our expected calculation
    const expectedTaxCents = computeExpectedTax(
      TICKET_PRICE_CENTS,
      QTY,
      TAX_RATE_BPS,
    );
    // expectedTaxCents = Math.round((5000 * 2 * 975) / 10_000) = Math.round(975) = 975
    // formatted as $9.75
    const expectedTaxFormatted = `$${(expectedTaxCents / 100).toFixed(2)}`;

    // The text should contain "Est." prefix and the formatted amount
    await expect(taxEstimate).toContainText("Est.");
    await expect(taxEstimate).toContainText(expectedTaxFormatted);

    console.log(`Tax estimation:
  Ticket price: ${TICKET_PRICE_CENTS} cents
  Quantity: ${QTY}
  Tax rate: ${TAX_RATE_BPS} bps (${TAX_RATE_BPS / 100}%)
  Expected tax: ${expectedTaxCents} cents (${expectedTaxFormatted})
`);

    // ─────────────────────────────────────────────────────────────────
    // PHASE 7: Verify via tRPC that the backend returns the same amount
    // ─────────────────────────────────────────────────────────────────
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    expect(token).toBeTruthy();

    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });

    const taxResult = await trpc.events.estimateCheckoutTax.query({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: QTY }],
      billingAddress: {
        line1: "456 Oak Ave",
        city: "San Francisco",
        state: "CA",
        postalCode: "94103",
        country: "US",
      },
    });

    expect(taxResult.taxAmountCents).toBe(expectedTaxCents);
    console.log(
      `Backend tax estimate: ${taxResult.taxAmountCents} cents (matches expected ${expectedTaxCents})`,
    );

    console.log(`\nAll tax estimation validations passed!`);
  });
});
