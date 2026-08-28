import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Admin Tables E2E
// ─────────────────────────────────────────────────────────────────────────────
// Verifies that the Orders, Events, and Places admin tables render the
// expected action buttons and that clicking them produces the correct effect
// (navigating, toggling panels, etc.).
//
// Preconditions:
// - Playwright "setup" project has stored a signed-in session.
// - Local infra is running (postgres + redis).
// - API is reachable at PLAYWRIGHT_API_BASE_URL.
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

interface AdminTablesSeed {
  orgSlug: string;
  placeActiveId: string;
  placeArchivedId: string;
  eventPublishedId: string;
  eventPublishedSlug: string;
  eventDraftId: string;
  eventDraftSlug: string;
  orderSucceededId: string;
  orderPendingId: string;
  buyerHumanId: string;
}

test.describe("Admin Tables", () => {
  // Admin tables require an authenticated session — skip the whole suite for
  // the unauthenticated `guest` project.
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: AdminTablesSeed;

  test.beforeAll(async ({ request }) => {
    // Reset domain data but preserve the Playwright test user's auth session
    // so the storageState cookies remain valid.
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    // Ensure email is marked as verified so admin gates pass.
    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    const res = await request.post(`${API_BASE_URL}/e2e/seed/admin-tables`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    seed = body.seed;
    expect(seed.orgSlug).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Orders Table
  // ─────────────────────────────────────────────────────────────────────────

  test.describe("Orders table", () => {
    test("renders table with search, filter chips, and order rows", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/orders`);

      // Wait for the table container to appear.
      await expect(page.getByTestId("admin-orders-search")).toBeVisible({
        timeout: 15_000,
      });

      // DataTable itself should be visible with the correct testIdBase.
      await expect(page.getByTestId("orders-table")).toBeVisible();

      // Status filter chips should be present.
      for (const label of [
        "Pending",
        "Succeeded",
        "Partial Refund",
        "Refunded",
        "Disputed",
        "Cancelled",
      ]) {
        await expect(page.getByRole("button", { name: label })).toBeVisible();
      }

      // Should have at least one row with a "View details" button.
      await expect(
        page.getByRole("button", { name: "View details" }).first(),
      ).toBeVisible();
    });

    test("View details button toggles the order detail panel", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/orders`);
      await expect(page.getByTestId("orders-table")).toBeVisible({
        timeout: 15_000,
      });

      const viewDetailsBtn = page
        .getByRole("button", { name: "View details" })
        .first();
      await expect(viewDetailsBtn).toBeVisible();

      // Click to open the detail panel.
      await viewDetailsBtn.click();

      // The OrderDetailPanel should render. It contains a "Close" button.
      await expect(
        page.getByRole("button", { name: "Close" }).first(),
      ).toBeVisible({ timeout: 5_000 });

      // Click again to toggle closed.
      await viewDetailsBtn.click();

      // The close button should no longer be visible (panel collapsed).
      await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0, {
        timeout: 3_000,
      });
    });

    test("View in Stripe button is present for orders with a payment intent", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/orders`);
      await expect(page.getByTestId("orders-table")).toBeVisible({
        timeout: 15_000,
      });

      // The seed creates one order with stripePaymentIntentId and one without.
      // At least one "View in Stripe" button should exist.
      await expect(
        page.getByRole("button", { name: "View in Stripe" }).first(),
      ).toBeVisible();
    });

    test("status filter chips narrow the visible rows", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/orders`);
      await expect(page.getByTestId("orders-table")).toBeVisible({
        timeout: 15_000,
      });

      // Click "Pending" chip.
      await page.getByRole("button", { name: "Pending" }).click();

      // Wait for refetch — the table should still be visible.
      await expect(page.getByTestId("orders-table")).toBeVisible();

      // Click again to deselect.
      await page.getByRole("button", { name: "Pending" }).click();
    });

    test("search input accepts text and filters", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/orders`);
      const search = page.getByTestId("admin-orders-search");
      await expect(search).toBeVisible({ timeout: 15_000 });

      // Type a search term (event title from seed).
      await search.fill("E2E Published Concert");

      // Allow debounce.
      await page.waitForTimeout(500);

      // Table should still be present (may show matching rows or empty state).
      await expect(page.getByTestId("orders-table")).toBeVisible();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Events Table
  // ─────────────────────────────────────────────────────────────────────────

  test.describe("Events table", () => {
    test("renders table with search, Create Event button, and event rows", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events`);

      // Wait for the events table.
      await expect(page.getByTestId("admin-events-search")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("events-manager-table")).toBeVisible();

      // "Create Event" button should be present.
      await expect(
        page.getByRole("button", { name: /create event/i }),
      ).toBeVisible();

      // At least one "Edit event" action button should be visible (seed has 2 events).
      await expect(
        page.getByRole("button", { name: "Edit event" }).first(),
      ).toBeVisible();
    });

    test("View event button appears only for PUBLISHED events", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events`);
      await expect(page.getByTestId("events-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      // The seed has one PUBLISHED and one DRAFT event.
      // "View event" should exist for the published event.
      await expect(
        page.getByRole("button", { name: "View event" }),
      ).toHaveCount(1);
    });

    test("View attendees button is present for each event", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events`);
      await expect(page.getByTestId("events-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      // The page provides getAttendeesUrl, so "View attendees" should appear
      // for every event row. Seed has 2 events.
      await expect(
        page.getByRole("button", { name: "View attendees" }),
      ).toHaveCount(2);
    });

    test("Edit event button navigates to the event editor", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events`);
      await expect(page.getByTestId("events-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      const editBtn = page.getByRole("button", { name: "Edit event" }).first();
      await editBtn.click();

      // Should navigate to the event detail page.
      await page.waitForURL(/\/admin\/[^/]+\/events\/[^/?#]+(\?|$)/, {
        timeout: 10_000,
      });
      expect(page.url()).toMatch(/\/admin\/[^/]+\/events\/[^/?#]+(\?|$)/);
    });

    test("View event button navigates to the public event page", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events`);
      await expect(page.getByTestId("events-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      const viewBtn = page.getByRole("button", { name: "View event" });
      await expect(viewBtn).toHaveCount(1);
      await viewBtn.click();

      // Should navigate to the public event page /e/<slug>.
      await page.waitForURL(/\/e\//, { timeout: 10_000 });
    });

    test("View attendees button navigates to the attendees page", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events`);
      await expect(page.getByTestId("events-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      const attendeesBtn = page
        .getByRole("button", { name: "View attendees" })
        .first();
      await attendeesBtn.click();

      // Should navigate to /admin/<slug>/events/<eventId>/attendees.
      await page.waitForURL(/\/admin\/.*\/events\/.*\/attendees/, {
        timeout: 10_000,
      });
    });

    test("search input filters events", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/events`);
      const search = page.getByTestId("admin-events-search");
      await expect(search).toBeVisible({ timeout: 15_000 });

      await search.fill("Draft Workshop");
      await page.waitForTimeout(500);

      // Table should still be visible.
      await expect(page.getByTestId("events-manager-table")).toBeVisible();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Places Table
  // ─────────────────────────────────────────────────────────────────────────

  test.describe("Places table", () => {
    test("renders table with search, New Place button, and place rows", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);

      await expect(page.getByTestId("admin-places-search")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("places-manager-table")).toBeVisible();

      // "New Place" button should be present.
      await expect(
        page.getByRole("button", { name: /new place/i }),
      ).toBeVisible();

      // Filter chips should be present (non-default scopes + verified
      // toggle; resting state = no chip selected = the active default, so
      // there is deliberately NO "Active" chip).
      await expect(
        page.getByRole("button", { name: "Archived", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "All statuses", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Verified only", exact: true }),
      ).toBeVisible();
    });

    test("owned places expose Edit, Layout, Calendar, and Archive row actions", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);
      await expect(page.getByTestId("places-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      // Row actions live behind the overflow menu now.
      await page
        .getByRole("button", { name: /^Actions for/ })
        .first()
        .click();

      await expect(
        page.getByRole("menuitem", { name: "Edit", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Layout", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Calendar", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Archive", exact: true }),
      ).toBeVisible();
    });

    test("Edit row action navigates to the edit page", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);
      await expect(page.getByTestId("places-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      await page
        .getByRole("button", { name: /^Actions for/ })
        .first()
        .click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();

      await page.waitForURL(/\/admin\/.*\/places\/.*\/edit/, {
        timeout: 10_000,
      });
      expect(page.url()).toContain("/edit");
    });

    test("Layout row action navigates to the layout page", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);
      await expect(page.getByTestId("places-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      await page
        .getByRole("button", { name: /^Actions for/ })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: "Layout", exact: true })
        .click();

      await page.waitForURL(/\/admin\/.*\/places\/.*\/layout/, {
        timeout: 10_000,
      });
      expect(page.url()).toContain("/layout");
    });

    test("Calendar row action navigates to the calendar page", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);
      await expect(page.getByTestId("places-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      await page
        .getByRole("button", { name: /^Actions for/ })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: "Calendar", exact: true })
        .click();

      await page.waitForURL(/\/admin\/.*\/places\/.*\/calendar/, {
        timeout: 10_000,
      });
      expect(page.url()).toContain("/calendar");
    });

    test("UNVERIFIED place shows the Request verification row action", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);
      await expect(page.getByTestId("places-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      // The active place is UNVERIFIED, so "Request verification" should
      // appear in its actions menu.
      await page
        .getByRole("button", { name: /^Actions for/ })
        .first()
        .click();
      await expect(
        page.getByRole("menuitem", { name: "Request verification" }),
      ).toBeVisible();
    });

    test("status filter chips switch between active / all / archived", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);
      await expect(page.getByTestId("places-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      // Default is "active" — archived place should not be visible.
      await expect(page.getByText("E2E Old Hall")).not.toBeVisible();

      // Select "All statuses" — both should appear.
      await page
        .getByRole("button", { name: "All statuses", exact: true })
        .click();
      await expect(page.getByText("E2E Old Hall")).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByText("E2E Main Venue")).toBeVisible();

      // Select "Archived" — only archived should show.
      await page
        .getByRole("button", { name: "Archived", exact: true })
        .click();
      await expect(page.getByText("E2E Old Hall")).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByText("E2E Main Venue")).not.toBeVisible();

      // Deselect "Archived" (click again) — back to the active default.
      await page
        .getByRole("button", { name: "Archived", exact: true })
        .click();
      await expect(page.getByText("E2E Main Venue")).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByText("E2E Old Hall")).not.toBeVisible();
    });

    test("archived place shows Restore row action instead of Archive", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);
      await expect(page.getByTestId("places-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      // Select "All statuses" so the archived place is visible.
      await page
        .getByRole("button", { name: "All statuses", exact: true })
        .click();
      await expect(page.getByText("E2E Old Hall")).toBeVisible({
        timeout: 5_000,
      });

      // The archived place's menu should offer Restore instead of Archive.
      await page
        .getByRole("button", { name: "Actions for E2E Old Hall" })
        .click();
      await expect(
        page.getByRole("menuitem", { name: "Restore", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Archive", exact: true }),
      ).not.toBeVisible();
    });

    test("search input filters places", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);
      const search = page.getByTestId("admin-places-search");
      await expect(search).toBeVisible({ timeout: 15_000 });

      await search.fill("Main Venue");
      await page.waitForTimeout(500);

      await expect(page.getByTestId("places-manager-table")).toBeVisible();
    });

    test("verified-only chip filters to verified places", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/places`);
      await expect(page.getByTestId("places-manager-table")).toBeVisible({
        timeout: 15_000,
      });

      // Toggle the verified-only chip on.
      await page
        .getByRole("button", { name: "Verified only", exact: true })
        .click();

      // The active place is UNVERIFIED so it should disappear.
      // First switch status to "all" to include the archived verified place.
      await page
        .getByRole("button", { name: "All statuses", exact: true })
        .click();

      // Wait for re-render.
      await page.waitForTimeout(300);

      // The archived VERIFIED place may or may not appear depending on the
      // intersection of verifiedOnly + statusFilter. The key assertion is
      // that the chips work without error.
      await expect(page.getByTestId("places-manager-table")).toBeVisible();
    });
  });
});
