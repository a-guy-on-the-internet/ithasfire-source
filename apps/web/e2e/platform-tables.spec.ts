import { expect, test, type Page } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Platform Tables E2E
// ─────────────────────────────────────────────────────────────────────────────
// Verifies that the platform-level (staff-only) pages render correctly and
// their interactive elements (buttons, filters, forms, navigation cards)
// produce the expected effects.
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

interface PlatformTablesSeed {
  humanId: string;
  orgId: string;
  orgSlug: string;
  placePendingId: string;
  placeVerifiedId: string;
  verificationRequestId: string;
  docIds: string[];
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  orderSucceededId: string;
  orderPendingId: string;
  ticketId: string;
  ticketCode: string;
  buyerHumanId: string;
  buyerEmail: string;
}

test.describe("Platform Tables", () => {
  // Force serial execution: the beforeAll reset+seed must run exactly once,
  // and subsequent tests depend on the seeded state.
  test.describe.configure({ mode: "serial" });

  // Platform pages require an authenticated session with staff role.
  // Skip the whole suite for the unauthenticated `guest` project.
  // Also suppress the cookie-consent banner so it never blocks clicks.
  test.beforeEach(async ({ context }) => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
    await context.addCookies([
      {
        name: "th-consent",
        value: "all",
        domain: "localhost",
        path: "/",
      },
    ]);
  });

  let seed: PlatformTablesSeed;

  test.beforeAll(async ({ request }) => {
    // Reset domain data but preserve the Playwright test user's auth session
    // so the storageState cookies remain valid.
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    // Ensure email is marked as verified so platform/staff gates pass.
    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    const res = await request.post(`${API_BASE_URL}/e2e/seed/platform-tables`, {
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
  // Overview
  // ─────────────────────────────────────────────────────────────────────────

  test.describe("Overview page", () => {
    test("renders stats section and navigation cards", async ({ page }) => {
      await page.goto("/platform/overview");

      // Heading
      await expect(page.getByText("Platform")).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText("Internal tools for Ithas Fire staff"),
      ).toBeVisible();

      // Stats section title
      await expect(page.getByText("Platform at a Glance")).toBeVisible();

      // Quick links section with three cards
      await expect(page.getByText("Quick Links")).toBeVisible();
      await expect(page.getByText("Orders").first()).toBeVisible();
      await expect(page.getByText("Tickets").first()).toBeVisible();
      await expect(
        page.getByText("Place Verification", { exact: true }),
      ).toBeVisible();
    });

    test("Orders card navigates to /platform/orders", async ({ page }) => {
      await page.goto("/platform/overview");
      await expect(page.getByText("Platform")).toBeVisible({ timeout: 15_000 });

      // Click the Orders card (the card containing the text "Orders" and
      // its description about searching orders).
      await page
        .getByText("Search and review orders across all organizations")
        .click();

      await page.waitForURL(/\/platform\/orders/, { timeout: 10_000 });
      expect(page.url()).toContain("/platform/orders");
    });

    test("Tickets card navigates to /platform/tickets", async ({ page }) => {
      await page.goto("/platform/overview");
      await expect(page.getByText("Platform")).toBeVisible({ timeout: 15_000 });

      await page.getByText("Look up tickets across all events").click();

      await page.waitForURL(/\/platform\/tickets/, { timeout: 10_000 });
      expect(page.url()).toContain("/platform/tickets");
    });

    test("Place Verification card navigates to /platform/places", async ({
      page,
    }) => {
      await page.goto("/platform/overview");
      await expect(page.getByText("Platform")).toBeVisible({ timeout: 15_000 });

      await page
        .getByText("Review and approve place verification requests")
        .click();

      await page.waitForURL(/\/platform\/places/, { timeout: 10_000 });
      expect(page.url()).toContain("/platform/places");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Orders
  // ─────────────────────────────────────────────────────────────────────────

  test.describe("Orders page", () => {
    test("renders table with tabs, search, filter chips, and order rows", async ({
      page,
    }) => {
      await page.goto("/platform/orders");

      // Wait for the table to appear.
      await expect(page.getByTestId("platform-orders-table")).toBeVisible({
        timeout: 15_000,
      });

      // Tabs should be present.
      for (const label of ["All Orders", "Active Carts", "Disputed"]) {
        await expect(
          page.getByText(label, { exact: true }).first(),
        ).toBeVisible();
      }

      // Status filter chips should be visible on the "All Orders" tab.
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

      // Source filter chips.
      for (const label of ["Primary", "Resale"]) {
        await expect(page.getByText(label).first()).toBeVisible();
      }

      // Refresh button.
      await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();

      // Should have at least one row action (View details chevron).
      await expect(
        page.getByRole("button", { name: "View details" }).first(),
      ).toBeVisible();
    });

    test("View details button toggles the order detail panel", async ({
      page,
    }) => {
      await page.goto("/platform/orders");
      await expect(page.getByTestId("platform-orders-table")).toBeVisible({
        timeout: 15_000,
      });

      const viewDetailsBtn = page
        .getByRole("button", { name: "View details" })
        .first();
      await expect(viewDetailsBtn).toBeVisible();

      // Click to open the detail panel.
      await viewDetailsBtn.click();

      // The detail panel should render with a Close button.
      await expect(
        page.getByRole("button", { name: "Close" }).first(),
      ).toBeVisible({ timeout: 5_000 });

      // Detail panel buttons.
      await expect(page.getByRole("button", { name: "Copy ID" })).toBeVisible();

      // Click again to close.
      await viewDetailsBtn.click();
      await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0, {
        timeout: 3_000,
      });
    });

    test("View in Stripe button is present for orders with a payment intent", async ({
      page,
    }) => {
      await page.goto("/platform/orders");
      await expect(page.getByTestId("platform-orders-table")).toBeVisible({
        timeout: 15_000,
      });

      // Seed creates one order with stripePaymentIntentId and one without.
      await expect(
        page.getByRole("button", { name: "View in Stripe" }).first(),
      ).toBeVisible();
    });

    test("tab switching changes active tab and hides status chips when appropriate", async ({
      page,
    }) => {
      await page.goto("/platform/orders");
      await expect(page.getByTestId("platform-orders-table")).toBeVisible({
        timeout: 15_000,
      });

      // Status chips should be visible on "All Orders" tab.
      await expect(page.getByRole("button", { name: "Pending" })).toBeVisible();

      // Switch to "Active Carts" tab.
      await page.getByText("Active Carts", { exact: true }).first().click();

      // Status chips should be hidden on non-"all" tabs.
      // Table should still be visible.
      await expect(page.getByTestId("platform-orders-table")).toBeVisible();

      // Switch to "Disputed" tab.
      await page.getByText("Disputed", { exact: true }).first().click();
      await expect(page.getByTestId("platform-orders-table")).toBeVisible();

      // Switch back to "All Orders".
      await page.getByText("All Orders", { exact: true }).first().click();
      await expect(page.getByRole("button", { name: "Pending" })).toBeVisible();
    });

    test("status filter chips narrow the visible rows", async ({ page }) => {
      await page.goto("/platform/orders");
      await expect(page.getByTestId("platform-orders-table")).toBeVisible({
        timeout: 15_000,
      });

      // Click "Succeeded" chip.
      await page.getByRole("button", { name: "Succeeded" }).click();

      // Table should still be visible.
      await expect(page.getByTestId("platform-orders-table")).toBeVisible();

      // Click again to deselect.
      await page.getByRole("button", { name: "Succeeded" }).click();
    });

    test("search input accepts text and filters", async ({ page }) => {
      await page.goto("/platform/orders");
      await expect(page.getByTestId("platform-orders-table")).toBeVisible({
        timeout: 15_000,
      });

      // Find the search input by placeholder.
      const search = page.getByPlaceholder(
        "Search by buyer, email, or order ID...",
      );
      await expect(search).toBeVisible();

      // Type a search term (buyer name from seed).
      await search.fill("E2E Platform Buyer");

      // Allow debounce.
      await page.waitForTimeout(500);

      // Table should still be present.
      await expect(page.getByTestId("platform-orders-table")).toBeVisible();
    });

    test("clear filters button appears when filters are active", async ({
      page,
    }) => {
      await page.goto("/platform/orders");
      await expect(page.getByTestId("platform-orders-table")).toBeVisible({
        timeout: 15_000,
      });

      // Clear button should not be visible initially.
      await expect(
        page.getByRole("button", { name: "Clear", exact: true }),
      ).not.toBeVisible();

      // Type something in search.
      const search = page.getByPlaceholder(
        "Search by buyer, email, or order ID...",
      );
      await search.fill("test");
      await page.waitForTimeout(400);

      // Clear button should now appear.
      await expect(
        page.getByRole("button", { name: "Clear", exact: true }),
      ).toBeVisible();

      // Click it.
      await page.getByRole("button", { name: "Clear", exact: true }).click();

      // Search should be cleared.
      await expect(search).toHaveValue("");
    });

    test("Refresh button triggers a refetch", async ({ page }) => {
      await page.goto("/platform/orders");
      await expect(page.getByTestId("platform-orders-table")).toBeVisible({
        timeout: 15_000,
      });

      // Clicking refresh should not error.
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByTestId("platform-orders-table")).toBeVisible();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tickets
  // ─────────────────────────────────────────────────────────────────────────

  test.describe("Tickets page", () => {
    test("renders table with search, status filter chips, and ticket rows", async ({
      page,
    }) => {
      await page.goto("/platform/tickets");

      // Wait for the table to appear.
      await expect(page.getByTestId("platform-tickets-table")).toBeVisible({
        timeout: 15_000,
      });

      // Status filter chips.
      for (const label of [
        "Valid",
        "Scanned",
        "Invalid",
        "Refunded",
        "Listed",
      ]) {
        await expect(
          page.getByRole("button", { name: label, exact: true }),
        ).toBeVisible();
      }

      // Refresh button.
      await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    });

    test("search input accepts text and filters", async ({ page }) => {
      await page.goto("/platform/tickets");
      await expect(page.getByTestId("platform-tickets-table")).toBeVisible({
        timeout: 15_000,
      });

      const search = page.getByPlaceholder(
        "Search by ticket code, owner name or email...",
      );
      await expect(search).toBeVisible();

      // Search by the seeded ticket code.
      await search.fill(seed.ticketCode);
      await page.waitForTimeout(500);

      await expect(page.getByTestId("platform-tickets-table")).toBeVisible();
    });

    test("status filter chips narrow the visible rows", async ({ page }) => {
      await page.goto("/platform/tickets");
      await expect(page.getByTestId("platform-tickets-table")).toBeVisible({
        timeout: 15_000,
      });

      // Click "Valid" chip.
      await page.getByRole("button", { name: "Valid", exact: true }).click();

      // Table should still be visible.
      await expect(page.getByTestId("platform-tickets-table")).toBeVisible();

      // Click again to deselect.
      await page.getByRole("button", { name: "Valid", exact: true }).click();
    });

    test("clear button appears and works when filters are active", async ({
      page,
    }) => {
      await page.goto("/platform/tickets");
      await expect(page.getByTestId("platform-tickets-table")).toBeVisible({
        timeout: 15_000,
      });

      // Type in search to activate a filter.
      const search = page.getByPlaceholder(
        "Search by ticket code, owner name or email...",
      );
      await search.fill("something");
      await page.waitForTimeout(400);

      // Clear button should appear.
      await expect(
        page.getByRole("button", { name: "Clear", exact: true }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await expect(search).toHaveValue("");
    });

    test("clicking a ticket row opens the detail panel", async ({ page }) => {
      await page.goto("/platform/tickets");
      await expect(page.getByTestId("platform-tickets-table")).toBeVisible({
        timeout: 15_000,
      });

      // Wait for at least one row to be rendered, then click it.
      // The detail panel renders "Ticket Detail" heading and a "Close" button.
      const firstRow = page
        .getByTestId("platform-tickets-table")
        .locator("tr")
        .nth(1);
      await expect(firstRow).toBeVisible({ timeout: 5_000 });
      await firstRow.click();

      await expect(page.getByText("Ticket Detail")).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByRole("button", { name: "Close" })).toBeVisible();

      // Detail panel should have Copy Code button.
      await expect(
        page.getByRole("button", { name: "Copy Code" }),
      ).toBeVisible();
    });

    test("Refresh button triggers a refetch", async ({ page }) => {
      await page.goto("/platform/tickets");
      await expect(page.getByTestId("platform-tickets-table")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByTestId("platform-tickets-table")).toBeVisible();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Places
  // ─────────────────────────────────────────────────────────────────────────

  test.describe("Places page", () => {
    test("renders table with search, verification filter buttons, and place rows", async ({
      page,
    }) => {
      await page.goto("/platform/places");

      // Wait for the table to appear.
      await expect(page.getByTestId("platform-places-table")).toBeVisible({
        timeout: 15_000,
      });

      // Verification filter buttons (rendered as styled divs, not role="button").
      for (const label of [
        "All",
        "Pending",
        "Unverified",
        "Verified",
        "Rejected",
      ]) {
        await expect(
          page.getByText(label, { exact: true }).first(),
        ).toBeVisible();
      }

      // Refresh button.
      await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    });

    test("search input accepts text and filters", async ({ page }) => {
      await page.goto("/platform/places");
      await expect(page.getByTestId("platform-places-table")).toBeVisible({
        timeout: 15_000,
      });

      const search = page.getByPlaceholder("Search places...");
      await expect(search).toBeVisible();

      await search.fill("E2E Pending Venue");
      await page.waitForTimeout(500);

      await expect(page.getByTestId("platform-places-table")).toBeVisible();
    });

    test("verification filter buttons switch the displayed places", async ({
      page,
    }) => {
      await page.goto("/platform/places");
      await expect(page.getByTestId("platform-places-table")).toBeVisible({
        timeout: 15_000,
      });

      // Default filter is "Pending" -- the pending venue should be visible.
      await expect(page.getByText("E2E Pending Venue")).toBeVisible({
        timeout: 5_000,
      });

      // Click "All" to see all places.
      await page.getByText("All", { exact: true }).first().click();
      await expect(page.getByTestId("platform-places-table")).toBeVisible();

      // Click "Verified" to filter to verified places.
      await page.getByText("Verified", { exact: true }).first().click();
      await expect(page.getByTestId("platform-places-table")).toBeVisible();

      // Click back to "Pending".
      await page.getByText("Pending", { exact: true }).first().click();
      await expect(page.getByText("E2E Pending Venue")).toBeVisible({
        timeout: 5_000,
      });
    });

    test("Review button is visible for PENDING places", async ({ page }) => {
      await page.goto("/platform/places");
      await expect(page.getByTestId("platform-places-table")).toBeVisible({
        timeout: 15_000,
      });

      // On the "Pending" tab the seed place should have a Review button.
      await expect(page.getByRole("button", { name: "Review" })).toBeVisible();
    });

    test("Review button opens the Verification Review Panel", async ({
      page,
    }) => {
      await page.goto("/platform/places");
      await expect(page.getByTestId("platform-places-table")).toBeVisible({
        timeout: 15_000,
      });

      // Click Review to open the panel.
      await page.getByRole("button", { name: "Review" }).click();

      // The panel should render with action buttons (place name appears both
      // in the table and in the panel, so we verify the panel via its buttons).
      await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    });

    test("Verification Review Panel shows uploaded documents", async ({
      page,
    }) => {
      await page.goto("/platform/places");
      await expect(page.getByTestId("platform-places-table")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByRole("button", { name: "Review" }).click();

      // Wait for the panel to load the verification request details.
      await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
        timeout: 5_000,
      });

      // The seeded documents should appear.
      await expect(page.getByText("lease-agreement.pdf")).toBeVisible();
      await expect(page.getByText("venue-photo.jpg")).toBeVisible();
    });

    test("Verification Review Panel has a reviewer notes textarea", async ({
      page,
    }) => {
      await page.goto("/platform/places");
      await expect(page.getByTestId("platform-places-table")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByRole("button", { name: "Review" }).click();
      await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
        timeout: 5_000,
      });

      // Notes textarea should be present and accept input.
      const textarea = page
        .getByPlaceholder(/notes/i)
        .or(page.locator("textarea"));
      await expect(textarea.first()).toBeVisible();

      await textarea.first().fill("Looks good, ownership docs confirmed.");
      await expect(textarea.first()).toHaveValue(
        "Looks good, ownership docs confirmed.",
      );
    });

    test("Cancel button closes the Verification Review Panel", async ({
      page,
    }) => {
      await page.goto("/platform/places");
      await expect(page.getByTestId("platform-places-table")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByRole("button", { name: "Review" }).click();
      await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
        timeout: 5_000,
      });

      // Click Cancel to close the panel.
      await page.getByRole("button", { name: "Cancel" }).click();

      // Approve button should no longer be visible (panel closed).
      await expect(
        page.getByRole("button", { name: "Approve" }),
      ).not.toBeVisible({ timeout: 3_000 });
    });

    test("Refresh button triggers a refetch", async ({ page }) => {
      await page.goto("/platform/places");
      await expect(page.getByTestId("platform-places-table")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByTestId("platform-places-table")).toBeVisible();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Theme Editor
  // ─────────────────────────────────────────────────────────────────────────

  test.describe("Theme Editor page", () => {
    /** Wait for the Theme Editor page content to load. */
    async function waitForThemeEditorPage(page: Page) {
      // Wait for the subtitle text which is unique to the theme editor page
      // content area (avoids the sidebar "Theme Editor" nav link ambiguity).
      await expect(
        page.getByText("Edit token values for the dark theme"),
      ).toBeVisible({ timeout: 15_000 });
    }

    test("renders heading and toolbar buttons", async ({ page }) => {
      await page.goto("/platform/theme-editor");
      await waitForThemeEditorPage(page);

      // Toolbar buttons.
      await expect(page.getByText("Reset")).toBeVisible();
      await expect(page.getByText("Copy JSON")).toBeVisible();
      await expect(page.getByText("Export")).toBeVisible();
    });

    test("mode toggle switches between Dark and Light", async ({ page }) => {
      await page.goto("/platform/theme-editor");
      await waitForThemeEditorPage(page);

      // Default mode should be "Dark".
      await expect(page.getByText("Dark", { exact: true })).toBeVisible();

      // Click mode toggle to switch to Light.
      await page.getByText("Dark", { exact: true }).click();
      await expect(page.getByText("Light", { exact: true })).toBeVisible({
        timeout: 3_000,
      });

      // Click again to switch back to Dark.
      await page.getByText("Light", { exact: true }).click();
      await expect(page.getByText("Dark", { exact: true })).toBeVisible({
        timeout: 3_000,
      });
    });

    test("Live Preview section is visible", async ({ page }) => {
      await page.goto("/platform/theme-editor");
      await waitForThemeEditorPage(page);

      await expect(page.getByText("Live Preview")).toBeVisible();
      await expect(page.getByText("Surface Card").first()).toBeVisible();
      await expect(page.getByText("Muted Surface").first()).toBeVisible();
    });

    test("token groups render with editable inputs", async ({ page }) => {
      await page.goto("/platform/theme-editor");
      await waitForThemeEditorPage(page);

      // At least one token input should be present (text input for hex value).
      const tokenInputs = page.locator('input[type="text"]');
      const count = await tokenInputs.count();
      expect(count).toBeGreaterThan(0);
    });

    test("editing a token shows 'changed' badge", async ({ page }) => {
      await page.goto("/platform/theme-editor");
      await waitForThemeEditorPage(page);

      // Modify the first text input value.
      const firstInput = page.locator('input[type="text"]').first();
      await expect(firstInput).toBeVisible();

      const originalValue = await firstInput.inputValue();
      await firstInput.fill("#FF0000");

      // A "changed" badge should appear.
      await expect(page.getByText("changed").first()).toBeVisible({
        timeout: 3_000,
      });

      // The description should mention "1 change pending" or similar.
      await expect(page.getByText(/change.*pending/i)).toBeVisible();

      // Reset to original value.
      await firstInput.fill(originalValue);
    });

    test("Reset button restores all defaults", async ({ page }) => {
      await page.goto("/platform/theme-editor");
      await waitForThemeEditorPage(page);

      // Change a token.
      const firstInput = page.locator('input[type="text"]').first();
      await firstInput.fill("#FF0000");
      await expect(page.getByText("changed").first()).toBeVisible({
        timeout: 3_000,
      });

      // Click Reset.
      await page.getByText("Reset").click();

      // "changed" badge should disappear.
      await expect(page.getByText("changed")).not.toBeVisible({
        timeout: 3_000,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Sidebar Navigation
  // ─────────────────────────────────────────────────────────────────────────

  test.describe("Sidebar navigation", () => {
    test("all five sidebar links are present and navigable", async ({
      page,
    }) => {
      await page.goto("/platform/overview");
      const sidebar = page.getByRole("navigation");
      await expect(
        sidebar.getByRole("button", { name: "Overview" }),
      ).toBeVisible({ timeout: 15_000 });

      // The sidebar should contain all five navigation items.
      const navLinks = [
        { label: "Overview", url: /\/platform\/overview/ },
        { label: "Orders", url: /\/platform\/orders/ },
        { label: "Tickets", url: /\/platform\/tickets/ },
        { label: "Places", url: /\/platform\/places/ },
        { label: "Theme Editor", url: /\/platform\/theme-editor/ },
      ];

      for (const link of navLinks) {
        const navItem = sidebar.getByRole("button", { name: link.label });
        await expect(navItem).toBeVisible();
      }
    });

    test("clicking sidebar Orders navigates to /platform/orders", async ({
      page,
    }) => {
      await page.goto("/platform/overview");
      const sidebar = page.getByRole("navigation");
      await expect(
        sidebar.getByRole("button", { name: "Overview" }),
      ).toBeVisible({ timeout: 15_000 });

      await sidebar.getByRole("button", { name: "Orders" }).click();
      await page.waitForURL(/\/platform\/orders/, { timeout: 10_000 });
    });

    test("clicking sidebar Places navigates to /platform/places", async ({
      page,
    }) => {
      await page.goto("/platform/overview");
      const sidebar = page.getByRole("navigation");
      await expect(
        sidebar.getByRole("button", { name: "Overview" }),
      ).toBeVisible({ timeout: 15_000 });

      await sidebar.getByRole("button", { name: "Places" }).click();
      await page.waitForURL(/\/platform\/places/, { timeout: 10_000 });
    });
  });
});
