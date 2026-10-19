import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Public Event-Series Date Picker Overlay E2E
// ─────────────────────────────────────────────────────────────────────────────
// Verifies the buyer-facing date-picker overlay on the public event-detail page:
// - Clicking the primary "Get Tickets" CTA on a SERIES event opens an overlay.
// - The overlay lists every published, public date for the series.
// - The date the buyer is currently viewing is preselected.
// - Choosing another date and continuing routes to that date's checkout page.
//
// Preconditions:
// - Local infra is running (postgres + redis) and API is reachable.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
  "public-series-organizer@example.com";

interface SeededDate {
  eventId: string;
  slug: string;
  title: string;
  startsAt: string;
}

interface PublicSeriesSeed {
  orgSlug: string;
  seriesId: string;
  seriesName: string;
  dates: SeededDate[];
}

test.describe("Public event-series date picker overlay", () => {
  test.describe.configure({ mode: "serial" });

  // Suppress the cookie-consent banner so it never intercepts CTA clicks.
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
  });

  let seed: PublicSeriesSeed;

  test.beforeAll(async ({ request }) => {
    // The public event page needs no auth, so this spec runs under the guest
    // project. Seed a verified auth user directly (the series owner) rather
    // than relying on the shared auth.setup session.
    await resetE2eState(request, API_BASE_URL);

    const authRes = await request.post(`${API_BASE_URL}/e2e/seed/auth-user`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL, name: "Public Series Organizer" },
    });
    expect(
      authRes.ok(),
      `Seed auth-user failed: ${await authRes.text()}`,
    ).toBeTruthy();

    const res = await request.post(`${API_BASE_URL}/e2e/seed/public-series`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL, dates: 3 },
    });

    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const json = await res.json();
    seed = json.seed;
    expect(seed.dates.length).toBe(3);
  });

  test("CTA opens an overlay listing every date with the current one preselected", async ({
    page,
  }) => {
    const [first] = seed.dates;
    await page.goto(`/events/${first.slug}`);

    // On a series event the primary CTA is a button (it opens the overlay)
    // rather than a plain link straight to checkout. The CAB is mounted twice
    // on public pages (AppShell + GlobalOverlays); both docks stack as fixed
    // elements and the last one in the DOM paints on top, so target it to
    // avoid the occluded dock intercepting the click. Either fires the same
    // registered action.
    const cta = page.getByTestId("event-get-tickets-btn");
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await cta.click();

    const dialog = page.getByTestId("series-date-picker");
    await expect(dialog).toBeVisible();

    // Every published date is offered, and exactly one is preselected — the
    // date the buyer is currently viewing.
    const options = page.getByTestId("series-date-option");
    await expect(options).toHaveCount(3);
    await expect(
      page.locator('[data-testid="series-date-option"][data-selected="true"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="series-date-option"][aria-checked="true"]'),
    ).toHaveCount(1);

    // Escape dismisses the overlay.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("choosing another date and continuing routes to that date's checkout", async ({
    page,
  }) => {
    const [first, second] = seed.dates;
    await page.goto(`/events/${first.slug}`);

    const cta = page.getByTestId("event-get-tickets-btn");
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await cta.click();

    await expect(page.getByTestId("series-date-picker")).toBeVisible();

    // Pick the second date by its slug, then continue to checkout.
    await page
      .locator(`[data-testid="series-date-option"][data-slug="${second.slug}"]`)
      .click();
    await page.getByTestId("series-date-continue").click();

    await page.waitForURL(
      (url) => url.pathname.includes(`/events/checkout/${second.slug}`),
    );
  });
});
