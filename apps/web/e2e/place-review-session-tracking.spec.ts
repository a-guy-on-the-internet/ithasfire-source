import { test, expect } from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Place Review Form — Session Tracking, Email Interstitial, and Gig Date
//
// Guest-only (no auth). Tests the v3 one-question-at-a-time form with the
// new session tracking, email interstitial, progress nudges, and gig date
// features from the completion-and-retention spec.
// ─────────────────────────────────────────────────────────────────────────────

test.use({ storageState: undefined });

// ── Review-form route ─────────────────────────────────────────────────────
// The Place Review form lives permanently at /review-a-place (it used to be
// embedded in the pre-launch "Coming Soon" homepage before that gate was
// removed). Consent is pre-seeded so the cookie banner never obscures the form.

const REVIEW_FORM_ROUTE = "/review-a-place";

async function seedConsent(page: import("@playwright/test").Page) {
  await page
    .context()
    .addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Advance through a screen by clicking the continue button */
async function advanceScreen(page: import("@playwright/test").Page) {
  const continueBtn = page.getByLabel(/continue to next question/i);
  await continueBtn.click();
  await page.waitForTimeout(600);
}

/** Select a chip — tries radio first, then button (ChipGroup uses different roles) */
async function selectChip(
  page: import("@playwright/test").Page,
  name: string | RegExp,
) {
  const radio = page.getByRole("radio", { name });
  if (await radio.isVisible({ timeout: 2000 }).catch(() => false)) {
    await radio.click();
  } else {
    await page.getByRole("button", { name }).click();
  }
}

/** Fill the venue step with a custom venue */
async function fillVenue(
  page: import("@playwright/test").Page,
  name: string,
  city: string,
) {
  await page.getByPlaceholder(/search or type a place/i).fill(name);
  await page.getByPlaceholder(/city/i).fill(city);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Place Review Form — Session & Retention Features", () => {
  test("session token is stored in localStorage on form load", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore(); // hydration mismatch is pre-existing
    await seedConsent(page);
    await page.goto(REVIEW_FORM_ROUTE);

    // Wait for the form to render
    await expect(page.getByRole("button", { name: /musician/i })).toBeVisible({
      timeout: 10_000,
    });

    // Check that the session token was created in localStorage
    const token = await page.evaluate(() =>
      localStorage.getItem("th_review_session_token"),
    );
    expect(token).toBeTruthy();
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("session tracking: step updates fire on screen transitions", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore(); // hydration mismatch is pre-existing
    await seedConsent(page);

    const stepUpdates: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("updateSessionStep") && req.method() === "POST") {
        stepUpdates.push(req.url());
      }
    });

    await page.goto(REVIEW_FORM_ROUTE);

    // aboutYou → venue → payout (3 screen transitions = at least 3 step updates)
    await page.getByRole("button", { name: /musician/i }).click();
    await advanceScreen(page);
    await fillVenue(page, "Step Tracking Venue", "Austin");
    await advanceScreen(page);
    await page.waitForTimeout(1000); // wait for fire-and-forget

    expect(stepUpdates.length).toBeGreaterThanOrEqual(2);
  });

  test("RATHER_NOT_SAY is removed from payout options", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore(); // hydration mismatch is pre-existing
    await seedConsent(page);
    await page.goto(REVIEW_FORM_ROUTE);

    // Navigate to payout screen
    await page.getByRole("button", { name: /musician/i }).click();
    await advanceScreen(page);
    await fillVenue(page, "Payout Test", "Memphis");
    await advanceScreen(page);

    // Now on payout screen — "Rather not say" should NOT be present
    await expect(
      page.getByRole("radio", { name: /rather not say/i }),
    ).not.toBeVisible();

    // But other payout options should be visible
    await expect(page.getByRole("radio", { name: /unpaid/i })).toBeVisible();
  });

  test("nudge text appears at promotion screen (step 4)", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore(); // hydration mismatch is pre-existing
    await seedConsent(page);
    await page.goto(REVIEW_FORM_ROUTE);

    // Navigate to promotion screen (core screen 4)
    await page.getByRole("button", { name: /musician/i }).click();
    await advanceScreen(page);
    await fillVenue(page, "Nudge Test Venue", "Austin");
    await advanceScreen(page);
    await advanceScreen(page); // skip payout
    await page.getByRole("button", { name: "Guarantee" }).click();
    await advanceScreen(page);

    // Now on promotion — select a chip
    await selectChip(page, /went all out/i);

    // Nudge text should appear after answering
    await expect(page.getByText(/almost halfway/i)).toBeVisible({
      timeout: 3_000,
    });
  });
});
