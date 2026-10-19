import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Event Builder Preview E2E (FR-204/D4)
// ─────────────────────────────────────────────────────────────────────────────
// Preview is no longer a builder tab: it's a header/CAB action opening the
// event's LIVE public draft page in a new tab. The public route renders
// non-PUBLISHED events (noindexed) with a "Draft preview" status banner.
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

interface EventBuilderSeed {
  orgSlug: string;
  eventId: string;
}

test.describe("Event Builder Preview", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: EventBuilderSeed;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    const res = await request.post(`${API_BASE_URL}/e2e/seed/event-builder`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    seed = body.seed;
  });

  test("preview tab is gone; header Preview action is present for drafts", async ({
    page,
  }) => {
    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

    // The builder still shows the Edit tab, but preview is no longer a tab.
    await expect(page.getByTestId("tab-edit")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("tab-preview")).toHaveCount(0);

    // The header carries the Preview action (draft events only), in its ⋯ menu.
    await page.getByRole("button", { name: /more actions/i }).click();
    await expect(page.getByTestId("event-preview-link")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("preview opens the live draft page in a new tab with a draft banner", async ({
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

    // The popup is the real public event page rendering the DRAFT with its
    // "Draft preview" status banner.
    expect(popup.url()).toContain("/events/");
    const banner = popup.getByTestId("event-status-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toHaveAttribute("data-status", "DRAFT");
  });
});
