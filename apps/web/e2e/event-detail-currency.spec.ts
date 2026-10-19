import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Event Detail — Currency Display E2E
// ─────────────────────────────────────────────────────────────────────────────
// Seeds a published event with an MXN-denominated payee and verifies that the
// public event detail page renders ticket prices using the correct currency
// symbol (MX$) rather than the default USD ($).
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

const TICKET_PRICE_CENTS = 2500; // $25.00 / MX$25.00

test.describe("Event Detail — Currency Display", () => {
  let seedUsd: { eventSlug: string };
  let seedMxn: { eventSlug: string };

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL);

    // Seed a USD event (default currency).
    const usdRes = await request.post(
      `${API_BASE_URL}/e2e/seed/paid-checkout`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: {
          priceCents: TICKET_PRICE_CENTS,
          currency: "usd",
        },
      },
    );
    expect(usdRes.ok(), `USD seed failed: ${await usdRes.text()}`).toBeTruthy();
    const usdBody = await usdRes.json();
    seedUsd = { eventSlug: usdBody.seed.eventSlug };

    // Seed an MXN event.
    const mxnRes = await request.post(
      `${API_BASE_URL}/e2e/seed/paid-checkout`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: {
          priceCents: TICKET_PRICE_CENTS,
          currency: "mxn",
          stripeAccountId: `acct_mxn_e2e_${Date.now()}`,
        },
      },
    );
    expect(mxnRes.ok(), `MXN seed failed: ${await mxnRes.text()}`).toBeTruthy();
    const mxnBody = await mxnRes.json();
    seedMxn = { eventSlug: mxnBody.seed.eventSlug };
  });

  test("renders USD prices with $ symbol", async ({ page }) => {
    await page.goto(`/events/${seedUsd.eventSlug}`);

    // Wait for the event heading to be visible.
    await expect(
      page.getByRole("heading", { name: "E2E Paid Checkout Event" }),
    ).toBeVisible({ timeout: 15_000 });

    // The ticket price should show the USD format: $25.00
    await expect(page.getByText("$25.00")).toBeVisible({ timeout: 5_000 });

    // "MX$" should NOT appear anywhere on the page.
    await expect(page.getByText("MX$")).not.toBeVisible();
  });

  test("renders MXN prices with MX$ symbol", async ({ page }) => {
    await page.goto(`/events/${seedMxn.eventSlug}`);

    // Wait for the event heading to be visible.
    await expect(
      page.getByRole("heading", { name: "E2E Paid Checkout Event" }),
    ).toBeVisible({ timeout: 15_000 });

    // The ticket price should show the MXN format: MX$25.00
    await expect(page.getByText("MX$25.00")).toBeVisible({ timeout: 5_000 });
  });
});
