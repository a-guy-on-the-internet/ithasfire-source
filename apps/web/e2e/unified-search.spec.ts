import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import { createE2eTrpcClient } from "./helpers/trpc";
import { spotlightChord, waitForHydration } from "./helpers/spotlight";

/**
 * E2E tests for the unified search feature.
 *
 * The navbar search bar and mobile search bar are now visual triggers that
 * open the Spotlight overlay (⌘+K). All actual search logic lives in
 * SpotlightSearch.tsx. UI-based tests interact through the spotlight flow;
 * tRPC tests validate the API directly.
 *
 * Prerequisites:
 * - Meilisearch must be running (docker compose -f docker-compose.search.yml up -d)
 * - API must be running with MEILISEARCH_HOST and MEILISEARCH_API_KEY configured
 */
test.describe("Unified Search", () => {
  const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";
  const resetSecret = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

  interface SeedResult {
    ok: boolean;
    seed: {
      humans: Array<{ id: string; email: string }>;
      organizations: Array<{ id: string; name: string; slug: string }>;
      places: Array<{ id: string; name: string }>;
      events: Array<{ id: string; title: string; slug: string }>;
      indexingResult: {
        eventsIndexed: number;
        humansIndexed: number;
        placesIndexed: number;
        organizationsIndexed: number;
      } | null;
    };
  }

  let seedData: SeedResult["seed"];

  test.beforeAll(async ({ request }) => {
    // Reset DB state — preserve the Playwright test user so chromium
    // project's storageState cookies stay valid.
    const preserveEmail =
      process.env.PLAYWRIGHT_TEST_EMAIL ??
      process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
      "playwright-setup@example.com";
    await resetE2eState(request, apiBaseUrl, { preserveEmail });

    // Seed unified search test data
    const seedRes = await request.post(
      `${apiBaseUrl}/e2e/seed/unified-search`,
      {
        headers: {
          "x-e2e-reset-secret": resetSecret,
          "content-type": "application/json",
        },
        data: {},
      },
    );

    if (!seedRes.ok()) {
      const errorText = await seedRes.text();
      throw new Error(`Failed to seed unified search data: ${errorText}`);
    }

    const result = (await seedRes.json()) as SeedResult;
    expect(result.ok).toBeTruthy();
    seedData = result.seed;

    // Give Meilisearch a moment to index (it's async)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  // ── Spotlight overlay tests (via navbar trigger) ───────────────────────

  test("clicking navbar search trigger opens spotlight overlay", async ({
    page,
  }) => {
    await page.goto("/");

    // The navbar search is now a trigger button, not an input
    const trigger = page.getByTestId("navbar-search-trigger");
    await expect(trigger).toBeVisible();

    await trigger.click();

    // Spotlight overlay should appear with its search input
    const spotlightInput = page.getByTestId("spotlight-input");
    await expect(spotlightInput).toBeVisible({ timeout: 3000 });
    await expect(spotlightInput).toBeFocused();
  });

  test("⌘+K opens spotlight overlay", async ({ page }) => {
    await page.goto("/");

    // Press ⌘+K (or Ctrl+K on non-mac)
    await waitForHydration(page);
    await page.keyboard.press(await spotlightChord(page));

    const spotlightInput = page.getByTestId("spotlight-input");
    await expect(spotlightInput).toBeVisible({ timeout: 3000 });
  });

  test("displays search suggestions in spotlight when typing", async ({
    page,
  }) => {
    await page.goto("/");

    // Open spotlight via keyboard
    await waitForHydration(page);
    await page.keyboard.press(await spotlightChord(page));

    const spotlightInput = page.getByTestId("spotlight-input");
    await expect(spotlightInput).toBeVisible({ timeout: 3000 });

    // Type a search query
    await spotlightInput.fill("Jazz");
    await page.waitForTimeout(500);

    // Should see event suggestion in the spotlight results
    const eventSuggestion = page.getByText(/Summer Jazz Festival/i);
    await expect(eventSuggestion).toBeVisible({ timeout: 5000 });
  });

  test("navigates to event page when clicking spotlight suggestion", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForHydration(page);
    await page.keyboard.press(await spotlightChord(page));

    const spotlightInput = page.getByTestId("spotlight-input");
    await expect(spotlightInput).toBeVisible({ timeout: 3000 });

    await spotlightInput.fill("Electronic Music");
    await page.waitForTimeout(500);

    const eventSuggestion = page.getByText(/Electronic Music Night/i);
    await expect(eventSuggestion).toBeVisible({ timeout: 5000 });
    await eventSuggestion.click();

    // Should navigate to event page
    await page.waitForURL(/\/events\//);
    expect(page.url()).toContain("/events/");
  });

  test("navigates to organization page when clicking spotlight suggestion", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForHydration(page);
    await page.keyboard.press(await spotlightChord(page));

    const spotlightInput = page.getByTestId("spotlight-input");
    await expect(spotlightInput).toBeVisible({ timeout: 3000 });

    await spotlightInput.fill("Bay Area Music");
    await page.waitForTimeout(500);

    const orgSuggestion = page.getByText(/Bay Area Music Collective/i);
    await expect(orgSuggestion).toBeVisible({ timeout: 5000 });
    await orgSuggestion.click();

    // Should navigate to org page
    await page.waitForURL(/\/orgs\//);
    expect(page.url()).toContain("/orgs/");
  });

  test("navigates to human profile page when clicking spotlight suggestion", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForHydration(page);
    await page.keyboard.press(await spotlightChord(page));

    const spotlightInput = page.getByTestId("spotlight-input");
    await expect(spotlightInput).toBeVisible({ timeout: 3000 });

    await spotlightInput.fill("Alex Rivera");
    await page.waitForTimeout(500);

    const humanSuggestion = page.getByText(/Alex Rivera/i);
    await expect(humanSuggestion).toBeVisible({ timeout: 5000 });
    await humanSuggestion.click();

    // Should navigate to the human's entity page (never the dead /u/ route)
    await page.waitForURL(/\/humans\//);
    expect(page.url()).toContain("/humans/");
  });

  test("Escape closes the spotlight overlay", async ({ page }) => {
    await page.goto("/");
    await waitForHydration(page);
    await page.keyboard.press(await spotlightChord(page));

    const spotlightInput = page.getByTestId("spotlight-input");
    await expect(spotlightInput).toBeVisible({ timeout: 3000 });

    await page.keyboard.press("Escape");

    await expect(spotlightInput).not.toBeVisible({ timeout: 2000 });
  });

  test("pressing enter in spotlight navigates to search results page", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForHydration(page);
    await page.keyboard.press(await spotlightChord(page));

    const spotlightInput = page.getByTestId("spotlight-input");
    await expect(spotlightInput).toBeVisible({ timeout: 3000 });

    await spotlightInput.fill("music");
    await spotlightInput.press("Enter");

    // Should navigate to search results page
    await page.waitForURL(/\/search/);
    expect(page.url()).toContain("/search");
    expect(page.url()).toContain("search=music");
  });

  // ── Results map (desktop) ─────────────────────────────────────────────

  test("map pane stays mounted when a geo-filtered search returns zero events", async ({
    page,
  }) => {
    // Mid-Atlantic center — a geo filter guaranteed to match nothing. This is
    // the "search this area over open water" shape: an ACTIVE geo filter with
    // zero plottable results. Regression lock: showMap once required
    // mapEvents.length > 0, so a zero-result area search unmounted the map and
    // stranded the user with a "Map area" filter and no map to pan back with.
    await page.goto("/search?place=Map+area&lat=10.83&lng=-30.95&radius=500");

    // The empty state renders in the list column…
    await expect(page.getByText(/No events within/i)).toBeVisible();
    // …AND the map pane must still be mounted beside it. (The pane renders
    // even without a tile server — SearchResultsMap degrades to its
    // "Map unavailable" panel inside the same testid'd container.)
    await expect(page.getByTestId("search-map-pane")).toBeVisible();
  });

  // ── tRPC API tests (no UI) ────────────────────────────────────────────

  test("returns mixed results for broad searches", async ({
    page,
    request,
  }) => {
    const trpc = createE2eTrpcClient(request, apiBaseUrl);

    // Search for "San Francisco" which should match venues
    const result = await trpc.search.autocomplete.query({
      query: "San Francisco",
      limit: 10,
    });

    expect(result.suggestions.length).toBeGreaterThan(0);

    // Should have place results (venues are in San Francisco)
    const placeResults = result.suggestions.filter(
      (s: any) => s.type === "place",
    );
    expect(placeResults.length).toBeGreaterThan(0);
  });

  test("returns event results via tRPC", async ({ request }) => {
    const trpc = createE2eTrpcClient(request, apiBaseUrl);

    const result = await trpc.search.autocomplete.query({
      query: "Jazz Festival",
      limit: 10,
    });

    expect(result.suggestions.length).toBeGreaterThan(0);

    const eventResults = result.suggestions.filter(
      (s: any) => s.type === "event",
    );
    expect(eventResults.length).toBeGreaterThan(0);
    expect(eventResults[0].title).toContain("Jazz");
  });

  test("returns organization results via tRPC", async ({ request }) => {
    const trpc = createE2eTrpcClient(request, apiBaseUrl);

    const result = await trpc.search.autocomplete.query({
      query: "Nightlife Productions",
      limit: 10,
    });

    expect(result.suggestions.length).toBeGreaterThan(0);

    const orgResults = result.suggestions.filter(
      (s: any) => s.type === "organization",
    );
    expect(orgResults.length).toBeGreaterThan(0);
    expect(orgResults[0].title).toContain("Nightlife");
  });
});
