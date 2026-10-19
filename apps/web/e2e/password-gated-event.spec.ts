import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

test.describe("Password-Gated Events", () => {
  const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";

  test.beforeEach(async ({ request }) => {
    await resetE2eState(request, apiBaseUrl);
  });

  test("shows password gate and unlocks on correct password", async ({
    page,
    request,
  }) => {
    // Seed a password-gated event
    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/gated-event`, {
      headers: {
        "x-e2e-reset-secret":
          process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
        "content-type": "application/json",
      },
      data: {
        gateType: "PASSWORD",
        password: "secret-party-2026",
      },
    });

    expect(seedRes.ok()).toBeTruthy();
    const { seed } = await seedRes.json();
    expect(seed.eventSlug).toBeTruthy();
    expect(seed.eventPassword).toBe("secret-party-2026");

    // Navigate to the event page
    await page.goto(`/events/${seed.eventSlug}`);

    // Should see the password gate UI
    await expect(
      page.getByText("This event is password protected"),
    ).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();

    // Enter wrong password
    await page.locator('input[type="password"]').fill("wrong-password");
    await page.getByRole("button", { name: /enter event/i }).click();

    // Should see error message
    await expect(page.getByText(/incorrect password/i)).toBeVisible();

    // Enter correct password
    await page.locator('input[type="password"]').fill("secret-party-2026");
    await page.getByRole("button", { name: /enter event/i }).click();

    // Should be unlocked and see event content
    // Wait for the page to refresh and show full event details
    await expect(page.getByText(/general admission/i)).toBeVisible({
      timeout: 10000,
    });

    // Password gate should no longer be visible
    await expect(
      page.getByText("This event is password protected"),
    ).not.toBeVisible();
  });

  test("password gate shows blurred hero image", async ({ page, request }) => {
    // Seed event with a hero image
    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/gated-event`, {
      headers: {
        "x-e2e-reset-secret":
          process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
        "content-type": "application/json",
      },
      data: {
        gateType: "PASSWORD",
        password: "vip-only",
      },
    });

    expect(seedRes.ok()).toBeTruthy();
    const { seed } = await seedRes.json();

    await page.goto(`/events/${seed.eventSlug}`);

    // Should show the gate UI with the event title
    await expect(
      page.getByText(seed.eventSlug, { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("This event is password protected"),
    ).toBeVisible();
  });

  test("remembers unlock after page refresh", async ({ page, request }) => {
    // Seed a password-gated event
    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/gated-event`, {
      headers: {
        "x-e2e-reset-secret":
          process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
        "content-type": "application/json",
      },
      data: {
        gateType: "PASSWORD",
        password: "remember-me",
      },
    });

    expect(seedRes.ok()).toBeTruthy();
    const { seed } = await seedRes.json();

    // First visit - enter password
    await page.goto(`/events/${seed.eventSlug}`);
    await expect(
      page.getByText("This event is password protected"),
    ).toBeVisible();

    await page.locator('input[type="password"]').fill("remember-me");
    await page.getByRole("button", { name: /enter event/i }).click();

    // Wait for unlock
    await expect(page.getByText(/general admission/i)).toBeVisible({
      timeout: 10000,
    });

    // Refresh page
    await page.reload();

    // Should still be unlocked (no password gate)
    await expect(page.getByText(/general admission/i)).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.getByText("This event is password protected"),
    ).not.toBeVisible();
  });

  test("unauthenticated user can unlock with password", async ({
    page,
    request,
  }) => {
    // Seed event
    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/gated-event`, {
      headers: {
        "x-e2e-reset-secret":
          process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
        "content-type": "application/json",
      },
      data: {
        gateType: "PASSWORD",
        password: "guest-friendly",
      },
    });

    expect(seedRes.ok()).toBeTruthy();
    const { seed } = await seedRes.json();

    // Clear any existing auth state
    await page.context().clearCookies();

    // Navigate to event (as unauthenticated user)
    await page.goto(`/events/${seed.eventSlug}`);

    // Should see password gate
    await expect(
      page.getByText("This event is password protected"),
    ).toBeVisible();

    // Enter correct password
    await page.locator('input[type="password"]').fill("guest-friendly");
    await page.getByRole("button", { name: /enter event/i }).click();

    // Should see event content
    await expect(page.getByText(/general admission/i)).toBeVisible({
      timeout: 10000,
    });
  });
});
