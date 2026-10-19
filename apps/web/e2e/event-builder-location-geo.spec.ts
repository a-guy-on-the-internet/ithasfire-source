import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Event Builder — Location Geo Fields E2E
// ─────────────────────────────────────────────────────────────────────────────
// Verifies that when a user types an address into the location autocomplete,
// selects a geocoded result, and saves the event, the structured geo fields
// (region, locality, countryCode, postalCode) are persisted to the database.
//
// The Geoapify geocoding API is intercepted via Playwright route mocking so
// the test is deterministic and doesn't depend on an API key or network.
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

// ── Deterministic geocoding fixture ──────────────────────────────────────
// Mirrors the Geoapify GeoJSON response format that mapGeoapifyFeature parses.
const MOCK_GEOCODE_RESPONSE = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        lat: 30.2672,
        lon: -97.7431,
        formatted: "Austin, TX 78701, United States",
        city: "Austin",
        state: "Texas",
        country_code: "us",
        postcode: "78701",
      },
      geometry: { type: "Point", coordinates: [-97.7431, 30.2672] },
    },
  ],
};

interface Seed {
  orgSlug: string;
}

test.describe("Event Builder — Location Geo Fields", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    // Verify the test user's email so admin gates pass.
    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    // Seed an org (reuse the event-builder seed — it gives us an org).
    const res = await request.post(`${API_BASE_URL}/e2e/seed/event-builder`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });
    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    seed = { orgSlug: body.seed.orgSlug };
  });

  test("saves region, locality, countryCode, postalCode from geocoded address to the database", async ({
    page,
    request,
  }) => {
    // ── 1. Mock Geoapify geocoding API ──────────────────────────────
    await page.route("**/api.geoapify.com/v1/geocode/**", (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_GEOCODE_RESPONSE),
      });
    });

    // ── 2. Capture the event ID from the tRPC mutation response ─────
    let createdEventId: string | null = null;
    await page.route("**/trpc/**createEventForOrg**", async (route) => {
      // Let the real request go through, then capture the response.
      const response = await route.fetch();
      const body = await response.json();
      // tRPC wraps results: { result: { data: { json: { eventId, ... } } } }
      // or sometimes: { result: { data: { eventId, ... } } }
      try {
        const data = body?.result?.data;
        createdEventId = data?.json?.eventId ?? data?.eventId ?? null;
      } catch {
        // parsing failed — leave null
      }
      await route.fulfill({ response });
    });

    // ── 3. Navigate to the event builder ────────────────────────────
    await page.goto(`/admin/${seed.orgSlug}/events/new`);
    await expect(page.getByText("Create Event")).toBeVisible();

    // ── 4. Fill required fields ─────────────────────────────────────
    await page.getByTestId("event-title").fill("Geo Fields E2E Test");

    const futureDate = new Date(Date.now() + 7 * 86_400_000);
    const futureDateStr = futureDate.toISOString().slice(0, 16);
    const endDate = new Date(futureDate.getTime() + 3_600_000);
    const endDateStr = endDate.toISOString().slice(0, 16);

    await page
      .getByTestId("event-starts-at")
      .locator("input")
      .first()
      .fill(futureDateStr);
    await page
      .getByTestId("event-ends-at")
      .locator("input")
      .first()
      .fill(endDateStr);

    // ── 5. Type in the location autocomplete ────────────────────────
    // The autocomplete debounces for 350ms then calls forwardGeocode,
    // which we've mocked above.
    const locationInput = page.getByTestId("location-autocomplete-input");
    await locationInput.fill("Austin TX");

    // Wait for the suggestion to appear. The mocked lat/lng gives us
    // a suggestion ID of "30.2672,-97.7431-0" (lat,lng-index).
    const firstSuggestion = page.getByTestId(
      "location-autocomplete-section-locations-suggestion-30.2672,-97.7431-0",
    );
    await expect(firstSuggestion).toBeVisible({ timeout: 10_000 });

    // ── 6. Select the suggestion ────────────────────────────────────
    await firstSuggestion.click();

    // Verify the input was updated with the formatted address.
    await expect(locationInput).toHaveValue("Austin, TX 78701, United States");

    // ── 7. Save the event ───────────────────────────────────────────
    const saveBtn = page.getByTestId("event-save-btn");
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Wait for the tRPC response so we have the event ID.
    await page.waitForTimeout(3_000);
    expect(
      createdEventId,
      "Should have captured the event ID from the mutation response",
    ).toBeTruthy();

    // ── 8. Verify geo fields in the database ────────────────────────
    const eventRes = await request.get(
      `${API_BASE_URL}/e2e/events/${createdEventId}`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
        },
      },
    );
    expect(
      eventRes.ok(),
      `Event lookup failed: ${await eventRes.text()}`,
    ).toBeTruthy();

    const event = await eventRes.json();

    expect(event.addressText).toBe("Austin, TX 78701, United States");
    expect(event.lat).toBeCloseTo(30.2672, 3);
    expect(event.lng).toBeCloseTo(-97.7431, 3);
    expect(event.locality).toBe("Austin");
    expect(event.region).toBe("Texas");
    expect(event.countryCode).toBe("US");
    expect(event.postalCode).toBe("78701");
  });
});
