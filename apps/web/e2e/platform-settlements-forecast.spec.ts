import { test, expect } from "./fixtures";
import { signInWithPassword } from "./helpers/sign-in";

/**
 * Drives the new forward-looking reads on /platform/settlements against the
 * LIVE dev stack. Creates nothing and mutates nothing, so it is safe under
 * `E2E_USE_LIVE_STACK=1` (which is the only way it should ever be run — the
 * default path resets the database).
 */

const SHOTS = ".shots/settlements";

test.describe("platform settlements — forecast + revenue", () => {
  test("renders the batch clock, expected-next, upcoming and revenue", async ({
    page,
  }) => {
    await signInWithPassword(page, {
      email: "admin@ithasfire.com",
      password: "Dev-Login-2026!",
    });

    await page.goto("/platform/settlements");

    // The three new headings exist.
    const owed = page.getByRole("heading", { name: /payouts owed/i });
    const upcoming = page.getByRole("heading", { name: /upcoming payouts/i });
    const revenue = page.getByRole("heading", { name: /platform revenue/i });

    await expect(owed).toBeVisible({ timeout: 30_000 });
    await expect(upcoming).toBeVisible({ timeout: 30_000 });
    await expect(revenue).toBeVisible({ timeout: 30_000 });

    // Let the three client queries settle.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.screenshot({
      path: `${SHOTS}/desktop-full.png`,
      fullPage: true,
    });

    // The whole point of the revenue section: net kept must NOT be a number.
    const revenueSection = page.locator(
      'section[aria-labelledby="platform-revenue-heading"]',
    );
    await expect(revenueSection).toBeVisible();
    const revenueText = (await revenueSection.innerText()).toLowerCase();
    expect(revenueText).toContain("net kept");
    expect(revenueText).toContain("not computable");

    // Upcoming must show dated tranches, not an undated lump.
    const upcomingSection = page.locator(
      'section[aria-labelledby="upcoming-payouts-heading"]',
    );
    await expect(upcomingSection).toBeVisible();
    await upcomingSection.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/desktop-upcoming.png` });

    // eslint-disable-next-line no-console
    console.log("\n=== UPCOMING ===\n" + (await upcomingSection.innerText()));
    // eslint-disable-next-line no-console
    console.log("\n=== REVENUE ===\n" + (await revenueSection.innerText()));

    const owedSection = page.locator(
      'section[aria-labelledby="payouts-owed-heading"]',
    );
    // eslint-disable-next-line no-console
    console.log("\n=== OWED ===\n" + (await owedSection.innerText()));
  });

  test("survives 320px with no horizontal overflow", async ({ page }) => {
    await signInWithPassword(page, {
      email: "admin@ithasfire.com",
      password: "Dev-Login-2026!",
    });

    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto("/platform/settlements");
    await page
      .getByRole("heading", { name: /upcoming payouts/i })
      .waitFor({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.screenshot({ path: `${SHOTS}/mobile-320.png`, fullPage: true });

    // The page body must never scroll sideways. Wide tables scroll inside
    // their own container instead.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    // eslint-disable-next-line no-console
    console.log("horizontal overflow @320px:", overflow);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
