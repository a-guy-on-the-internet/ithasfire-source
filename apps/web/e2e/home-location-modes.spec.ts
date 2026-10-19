import { test, expect } from "./fixtures";

// These scenarios are explicitly for signed-out behavior.
// Ensure they don't pull in the auth.setup dependency.
test.use({ storageState: undefined });

/**
 * Home should "load" in each location mode:
 * - default country fallback (no coords, no explicit region)
 * - explicit region selection
 * - geolocation granted (nearby)
 *
 * These are smoke-level assertions: page renders, and the state transitions don't crash.
 */

test.describe("Home location modes", () => {
  test("guest default uses country fallback", async ({ page }) => {
    // Simulate a US locale so our country inference code picks `US`.
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nav: any = navigator;
      try {
        Object.defineProperty(nav, "language", {
          value: "en-US",
          configurable: true,
        });
        Object.defineProperty(nav, "languages", {
          value: ["en-US"],
          configurable: true,
        });
      } catch {
        // ignore
      }
    });

    await page.goto("/");

    await expect(
      page.getByTestId("web-navbar"),
      "navbar renders",
    ).toBeVisible();

    // We expect the Home page to render an events list region. The exact titles depend
    // on seed state (the Playwright webServer currently resets DB), so keep this one light.
    // The Playwright API startup seeds deterministic demo events.
    // Default flow (no coords, no explicit region) should render country-based events.
    const grid = page.getByTestId("home-events-container");
    await expect(grid, "event grid renders").toBeVisible();
    await expect(
      grid.getByText("SOMA Warehouse Rave"),
      "seeded event title is visible",
    ).toBeVisible();
  });

  test("guest selecting a location shows Nashville seeded events", async ({
    page,
  }) => {
    await page.goto("/");

    // Home hero location uses LocationAutocompleteField under testIdBase `home-hero-location`.
    const location = page.getByTestId("home-hero-location");
    await expect(location).toBeVisible();
    // Type a location and select the suggestion.
    // Home should treat this as a coordinates-based selection (nearbyEvents), not a regionCode.
    await location.getByPlaceholder("Choose a Location").fill("Nashville, tn");

    // Suggestions are generated as:
    // `${testIdBase}-section-locations-suggestion-${suggestion.id}`
    // In non-maps mode, we still support a fallback suggestion list, so select by text.
    await page
      .getByRole("button", { name: /nashville/i })
      .first()
      .click();

    const grid = page.getByTestId("home-events-container");
    await expect(grid, "event grid renders").toBeVisible();

    // Use a title that exists in the seed script for Nashville.
    await expect(
      grid.getByText("East Nashville Indie Showcase"),
      "seeded Nashville event visible",
    ).toBeVisible();
  });

  test("guest with geolocation granted can render nearby mode", async ({
    context,
    page,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 37.7749, longitude: -122.4194 });

    await page.goto("/");

    // Trigger the geolocation flow via the button.
    await page.getByTestId("home-use-my-location").click();

    const grid = page.getByTestId("home-events-container");
    await expect(grid, "event grid renders").toBeVisible();
    // Nearby mode (SF coords) should include SF fixtures.
    await expect(
      grid.getByText("SOMA Warehouse Rave"),
      "seeded SF event visible",
    ).toBeVisible();
  });
});
