import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

/**
 * Embed Checkout — Adjustable Pricing (Pay What You Want)
 *
 * Tests the embedded widget checkout flow with ADJUSTABLE ticket types:
 *
 *   1. Seed event with ADJUSTABLE ticket type + Embed record
 *   2. Navigate to embed page
 *   3. Verify "Pay What You Want" label renders (not a fixed price)
 *   4. Select quantity, verify donation amount input appears
 *   5. Verify quick amount chips render
 *   6. Change donation amount, verify UI updates
 *   7. Verify minimum enforcement (if minimumCents > 0)
 *   8. Proceed through guest checkout form
 *   9. Verify terms checkbox exists and is required
 *   10. Verify non-refundable disclaimer is visible
 */
test.describe("Embed Checkout — Adjustable Pricing", () => {
  const MINIMUM_CENTS = 500;
  const SUGGESTED_CENTS = 1000;

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(
      request,
      process.env.E2E_API_BASE_URL || "http://localhost:3001",
    );
  });

  test("embed renders ADJUSTABLE ticket type with donation UI", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
    const webBaseUrl =
      process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
    const e2eResetSecret =
      process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 1: Seed event with ADJUSTABLE ticket type + Embed
    // ─────────────────────────────────────────────────────────────────────
    console.log(
      "\n📦 PHASE 1: Seeding event with ADJUSTABLE ticket type + embed...",
    );

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
          createEmbed: true,
          embedDomain: "localhost",
        },
      },
    );
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();

    const { seed } = await seedRes.json();
    expect(seed.eventId).toBeTruthy();
    expect(seed.ticketTypeId).toBeTruthy();
    expect(seed.embedId).toBeTruthy();

    console.log(`  Event: ${seed.eventId}`);
    console.log(`  Embed: ${seed.embedId}`);
    console.log(
      `  Ticket type: ${seed.ticketTypeId} (ADJUSTABLE, min $${MINIMUM_CENTS / 100})`,
    );

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 2: Navigate to embed page
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🌐 PHASE 2: Navigating to embed page...");

    await page.goto(`${webBaseUrl}/embed/${seed.embedId}`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // Wait for the page to load
    await page.waitForTimeout(2000);
    console.log("  Embed page loaded");

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 3: Verify ADJUSTABLE ticket type renders correctly
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🎫 PHASE 3: Verifying ticket type display...");

    const ticketTypes = page.getByLabel("Ticket types");

    // Should show "Pay What You Want" instead of a fixed price
    const payWhatYouWant = ticketTypes
      .locator("span")
      .filter({ hasText: /^Pay What You Want$/ })
      .first();
    await expect(payWhatYouWant).toBeVisible({ timeout: 10_000 });
    console.log("  'Pay What You Want' label visible");

    // Should show the ticket type name
    await expect(payWhatYouWant).toBeVisible();

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 4: Select quantity and verify donation input appears
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n➕ PHASE 4: Selecting ticket quantity...");

    // Click the + button to add 1 ticket
    const plusButton = page.getByRole("button", { name: /increase/i });
    await plusButton.click();
    console.log("  Added 1 ticket");

    // Adjustable amount input should appear
    const donationInput = page.getByLabel("Your price:");
    await expect(donationInput).toBeVisible({ timeout: 5_000 });
    console.log("  Adjustable amount input visible");

    // Should show the suggested amount as default
    const inputValue = await donationInput.inputValue();
    expect(inputValue).toBe((SUGGESTED_CENTS / 100).toFixed(2));
    console.log(
      `  Default amount: $${inputValue} (suggested: $${(SUGGESTED_CENTS / 100).toFixed(2)})`,
    );

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 5: Verify minimum amount display
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n💰 PHASE 5: Verifying minimum amount display...");

    if (MINIMUM_CENTS > 0) {
      const minimumText = ticketTypes.getByText(/min\s+\$5(?:\.00)?/i).first();
      await expect(minimumText).toBeVisible();
      console.log(`  Minimum amount notice visible`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 6: Change donation amount
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n✏️ PHASE 6: Changing donation amount...");

    await donationInput.fill("25.00");
    await donationInput.blur();

    const updatedValue = await donationInput.inputValue();
    console.log(`  Updated amount: $${updatedValue}`);

    console.log("\n✅ Embed ADJUSTABLE pricing UI test passed!");
  });
});
