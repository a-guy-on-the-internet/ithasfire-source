import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Event Location Preview E2E
// ─────────────────────────────────────────────────────────────────────────────
// Verifies that events seeded with lat/lng display the location text, map
// preview, and direction links on both the **public event detail page** and
// the **live draft preview** opened from the event builder's Preview action
// (FR-204 — the in-builder preview tab was removed).
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
  "playwright-setup@example.com";

const SEED_LOCATION = {
  addressText: "1 Infinite Loop, Cupertino, CA 95014",
  lat: 37.3318,
  lng: -122.0312,
  locality: "Cupertino",
  region: "CA",
  countryCode: "US",
};

// ─────────────────────────────────────────────────────────────────────────────
// Public event detail page
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Event Location — Public Detail Page", () => {
  let eventSlug: string;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL);

    const res = await request.post(`${API_BASE_URL}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: {
        priceCents: 2500,
        location: SEED_LOCATION,
      },
    });

    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    eventSlug = body.seed.eventSlug;
    expect(eventSlug).toBeTruthy();
  });

  test("displays location text on event detail page", async ({ page }) => {
    await page.goto(`/events/${eventSlug}`);

    // The location section should be visible in the logistics block
    const locationSection = page.getByTestId("event-location-section");
    await expect(locationSection).toBeVisible({ timeout: 15_000 });

    // The location text should contain the seeded address
    const locationText = page.getByTestId("event-location-text");
    await expect(locationText).toBeVisible();
    await expect(locationText).toContainText(SEED_LOCATION.addressText);
  });

  test("displays map preview on event detail page", async ({ page }) => {
    await page.goto(`/events/${eventSlug}`);

    // The map container should be visible
    const mapContainer = page.getByTestId("event-location-map-container");
    await expect(mapContainer).toBeVisible({ timeout: 15_000 });

    // The inner map preview component should be present (either the
    // actual MapLibre canvas or the fallback message if no API key)
    const mapPreview = page.getByTestId("location-map-preview");
    const mapFallback = mapContainer.locator("div").first();
    const hasMap = await mapPreview.isVisible().catch(() => false);
    const hasFallback = await mapFallback.isVisible().catch(() => false);
    expect(hasMap || hasFallback).toBeTruthy();
  });

  test("displays direction links on event detail page", async ({ page }) => {
    await page.goto(`/events/${eventSlug}`);

    // Wait for the location section to appear
    await expect(page.getByTestId("event-location-section")).toBeVisible({
      timeout: 15_000,
    });

    // Direction buttons (Google, Apple, Waze) should be present
    const directions = page.getByTestId("event-location-directions");
    await expect(directions).toBeVisible();

    // Should have three direction links
    const links = directions.locator("a");
    await expect(links).toHaveCount(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin event builder preview
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Event Location — Draft Preview (FR-204)", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  interface BuilderSeed {
    orgSlug: string;
    eventId: string;
  }

  let seed: BuilderSeed;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    // Ensure the auth user's email is verified
    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    // Seed an event with location coordinates
    const res = await request.post(`${API_BASE_URL}/e2e/seed/event-builder`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: {
        email: TEST_EMAIL,
        location: SEED_LOCATION,
      },
    });

    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    seed = body.seed;
  });

  // FR-204: the builder's Preview action opens the LIVE public draft page in
  // a new tab (the in-builder preview tab is gone), so the location render is
  // asserted on that page.
  test("preview action opens the draft page with location text and map", async ({
    page,
  }) => {
    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

    // "Open live draft" moved into the header's ⋯ menu (2026-08-30): as a bare
    // icon beside a labelled Preview it read as part of that button.
    await page.getByRole("button", { name: /more actions/i }).click();
    const previewLink = page.getByTestId("event-preview-link");
    await expect(previewLink).toBeVisible({ timeout: 15_000 });

    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      previewLink.click(),
    ]);
    await popup.waitForLoadState("domcontentloaded");

    // The draft page renders the seeded location text…
    const locationSection = popup.getByTestId("event-location-section");
    await expect(locationSection).toBeVisible({ timeout: 15_000 });
    const locationText = popup.getByTestId("event-location-text");
    await expect(locationText).toBeVisible();
    await expect(locationText).toContainText(SEED_LOCATION.addressText);

    // …and the map container (real MapLibre canvas or its fallback).
    const mapContainer = popup.getByTestId("event-location-map-container");
    await expect(mapContainer).toBeVisible({ timeout: 10_000 });
    const mapPreview = popup.getByTestId("location-map-preview");
    const hasFallback = mapContainer.locator("div").first();
    const hasMap = await mapPreview.isVisible().catch(() => false);
    const hasFb = await hasFallback.isVisible().catch(() => false);
    expect(hasMap || hasFb).toBeTruthy();
  });
});
