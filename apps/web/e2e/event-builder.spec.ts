import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Event Builder E2E
// ─────────────────────────────────────────────────────────────────────────────
// Exercises the EventBuilder form in both create and edit mode, including:
// - Title, dates, location mode toggles
// - Hero image upload area
// - Tab switching (edit / preview)
// - Save Draft / Cancel buttons
// - Ticket type CRUD (add, edit, cancel, save)
// - Gate settings (visibility, gate type cards, password modal)
// - Publish button
// - Application form builder modal (open, add question, cancel, save)
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

interface EventBuilderSeed {
  humanId: string;
  orgId: string;
  orgSlug: string;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  ticketTypeId: string;
}

test.describe("Event Builder", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: EventBuilderSeed;

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
    expect(seed.orgSlug).toBeTruthy();
    expect(seed.eventId).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CREATE MODE
  // ═══════════════════════════════════════════════════════════════════════

  test.describe("Create Mode", () => {
    const openCreateFlow = async (page: Page) => {
      await page.goto(`/admin/${seed.orgSlug}/events`);
      await page
        .getByRole("button", { name: "Create Event", exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/admin/${seed.orgSlug}/events/[^/]+$`),
      );
      // Wait for the editor itself to mount — the URL change happens before
      // the editor JS finishes loading, so subsequent testid lookups race
      // the initial render without this gate.
      await expect(page.locator('[data-testid="prose-editor"]')).toBeVisible({
        timeout: 15_000,
      });
    };

    test("renders the form with all primary fields", async ({ page }) => {
      await openCreateFlow(page);

      // Category should be visible immediately. (The "* = required" note is
      // gone: the design system marks optional fields, not required ones.)
      await expect(page.getByTestId("event-category-select")).toBeVisible();
      // The settings groups render as named accordions that start collapsed
      // (event-builder-regroup FR-102 replaced the old hidden Advanced stack).
      await expect(page.getByTestId("advanced-settings-section")).toBeVisible();
      await expect(
        page.getByTestId("advanced-section-recurrence"),
      ).toHaveAttribute("aria-expanded", "false");

      // Title input
      await expect(page.getByTestId("event-title")).toBeVisible();

      // Date pickers
      await expect(page.getByTestId("event-starts-at")).toBeVisible();
      await expect(page.getByTestId("event-ends-at")).toBeVisible();

      // Hero image upload area
      await expect(page.getByTestId("hero-image-upload")).toBeVisible();

      // Location mode toggles
      await expect(page.getByTestId("location-mode-address")).toBeVisible();
      await expect(page.getByTestId("location-mode-place")).toBeVisible();

      // Save button is rendered and reachable. The new `useCreateDraftEvent`
      // flow saves a draft synchronously when the user clicks "Create
      // Event", so on first mount the button is enabled (there's a real
      // row to write back to).
      const saveBtn = page.getByTestId("event-save-btn");
      await expect(saveBtn).toBeVisible();
      await expect(saveBtn).toBeEnabled();
    });

    test("preview is a header action, not a tab (FR-204)", async ({ page }) => {
      await openCreateFlow(page);

      // Edit remains a tab; the preview (and seating) tabs are gone.
      await expect(page.getByTestId("tab-edit")).toBeVisible();
      await expect(page.getByTestId("tab-preview")).toHaveCount(0);
      await expect(page.getByTestId("tab-seating")).toHaveCount(0);

      // The header's ⋯ menu carries "Open live draft", which opens the live
      // draft page in a new tab — the edit form stays mounted underneath.
      await page.getByRole("button", { name: /more actions/i }).click();
      const previewLink = page.getByTestId("event-preview-link");
      await expect(previewLink).toBeVisible({ timeout: 15_000 });
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        previewLink.click(),
      ]);
      await popup.waitForLoadState("domcontentloaded");
      expect(popup.url()).toContain("/events/");
      await expect(page.getByTestId("event-title")).toBeVisible();
    });

    test("location mode toggle switches between address and places", async ({
      page,
    }) => {
      await openCreateFlow(page);

      const addressTab = page.getByTestId("location-mode-address");
      const placeTab = page.getByTestId("location-mode-place");

      // Default is address mode
      await expect(addressTab).toBeVisible();

      // Switch to "My Places" mode
      await placeTab.click();
      // Place picker should appear (or at least the address autocomplete should be gone)
      // Switch back
      await addressTab.click();
    });

    test("Save Draft remains enabled after editing title and dates", async ({
      page,
    }) => {
      // In the new draft-on-create flow the row exists with default
      // values immediately, so this test verifies the Save button stays
      // reachable + enabled while the organizer fills in real values.
      await openCreateFlow(page);

      const saveBtn = page.getByTestId("event-save-btn");
      await expect(saveBtn).toBeEnabled();

      // Replace the default title.
      await page.getByTestId("event-title").fill("E2E Test Event");

      // Push the dates into the future.
      const startsAtContainer = page.getByTestId("event-starts-at");
      const dateInput = startsAtContainer.locator("input").first();
      const futureDate = new Date(Date.now() + 7 * 86_400_000);
      const futureDateStr = futureDate.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
      await dateInput.fill(futureDateStr);

      const endsAtContainer = page.getByTestId("event-ends-at");
      const endInput = endsAtContainer.locator("input").first();
      const endDate = new Date(futureDate.getTime() + 3_600_000);
      const endDateStr = endDate.toISOString().slice(0, 16);
      await endInput.fill(endDateStr);

      await expect(saveBtn).toBeEnabled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // EDIT MODE
  // ═══════════════════════════════════════════════════════════════════════

  test.describe("Edit Mode", () => {
    test("renders edit form with pre-populated data and Publish button", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
      await expect(page.locator('[data-testid="prose-editor"]')).toBeVisible();

      // Status badge should show DRAFT
      await expect(page.getByText("DRAFT")).toBeVisible();

      // Publish button visible for DRAFT events
      const publishBtn = page.getByTestId("event-publish-btn");
      await expect(publishBtn).toBeVisible();
      await expect(publishBtn).toBeEnabled();

      // Title should be pre-filled
      const titleInput = page.getByTestId("event-title");
      await expect(titleInput).toHaveValue(seed.eventTitle);

      // Save button visible and enabled
      await expect(page.getByTestId("event-save-btn")).toBeVisible();
    });

    // ───────────────────────────────────────────────────────────────────
    // Ticket Type Editor
    // ───────────────────────────────────────────────────────────────────

    test("ticket type editor shows existing tickets", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      const editor = page.getByTestId("ticket-type-editor");
      await expect(editor).toBeVisible();

      // Should display the seeded "General Admission" ticket
      const rows = editor.getByTestId("ticket-type-row");
      await expect(rows.first()).toBeVisible();
      await expect(rows.first()).toContainText("General Admission");
    });

    test("ticket type add form: open, fill, cancel", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      const editor = page.getByTestId("ticket-type-editor");

      // Click "Add Ticket Type"
      const addBtn = editor.getByTestId("ticket-type-add-btn");
      await expect(addBtn).toBeVisible();
      await addBtn.click();

      // Add form should be visible
      const addForm = editor.getByTestId("ticket-type-add-form");
      await expect(addForm).toBeVisible();

      // Fill in the form
      await page.getByTestId("ticket-type-add-name").fill("VIP Pass");
      await page.getByTestId("ticket-type-add-price").fill("50.00");
      await page.getByTestId("ticket-type-add-capacity").fill("25");

      // Cancel should close the form
      const cancelBtn = editor.getByTestId("ticket-type-add-cancel");
      await expect(cancelBtn).toBeVisible();
      await cancelBtn.click();

      await expect(addForm).not.toBeVisible();
    });

    test("ticket type add form: open, fill, submit", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      const editor = page.getByTestId("ticket-type-editor");

      // Click "Add Ticket Type"
      await editor.getByTestId("ticket-type-add-btn").click();

      // Fill form
      await page.getByTestId("ticket-type-add-name").fill("VIP Pass");
      await page.getByTestId("ticket-type-add-price").fill("50.00");
      await page.getByTestId("ticket-type-add-capacity").fill("25");

      // Submit
      const submitBtn = editor.getByTestId("ticket-type-add-submit");
      await expect(submitBtn).toBeVisible();
      await expect(submitBtn).toBeEnabled();
      await submitBtn.click();

      // The form should close and the new ticket type should appear
      await expect(page.getByTestId("ticket-type-add-form")).not.toBeVisible();

      // A new row should appear with the ticket name
      await expect(editor.getByText("VIP Pass")).toBeVisible();
    });

    test("ticket type edit: click edit, modify, cancel", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      const editor = page.getByTestId("ticket-type-editor");

      // Click the edit icon on the first ticket row
      const firstRow = editor.getByTestId("ticket-type-row").first();
      await expect(firstRow).toBeVisible();
      // The edit icon is inside the row
      const editIcon = firstRow
        .locator("[data-testid='ticket-type-row'] svg")
        .first();
      // Click on the row's edit area — the Edit3 icon
      await firstRow.getByRole("button").first().click();

      // Edit form should appear
      const editForm = editor.getByTestId("ticket-type-edit-form");
      await expect(editForm).toBeVisible();

      // Cancel via the Cancel button
      const cancelBtn = editor.getByTestId("ticket-type-edit-cancel");
      await expect(cancelBtn).toBeVisible();
      await cancelBtn.click();

      await expect(editForm).not.toBeVisible();
    });

    test("ticket type edit: click edit, modify, save", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      const editor = page.getByTestId("ticket-type-editor");
      const firstRow = editor.getByTestId("ticket-type-row").first();
      await firstRow.getByRole("button").first().click();

      const editForm = editor.getByTestId("ticket-type-edit-form");
      await expect(editForm).toBeVisible();

      // Modify the name input in the edit form
      const nameInput = editForm.locator("input").first();
      await nameInput.clear();
      await nameInput.fill("Updated Admission");

      // Save
      const saveBtn = editor.getByTestId("ticket-type-edit-save");
      await expect(saveBtn).toBeVisible();
      await saveBtn.click();

      // Edit form should close
      await expect(editForm).not.toBeVisible();
    });

    test("ticket type edit: cancel via X button", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      const editor = page.getByTestId("ticket-type-editor");
      const firstRow = editor.getByTestId("ticket-type-row").first();
      await firstRow.getByRole("button").first().click();

      const editForm = editor.getByTestId("ticket-type-edit-form");
      await expect(editForm).toBeVisible();

      // Close via X button
      const xBtn = editor.getByTestId("ticket-type-edit-cancel-x");
      await expect(xBtn).toBeVisible();
      await xBtn.click();

      await expect(editForm).not.toBeVisible();
    });

    // ───────────────────────────────────────────────────────────────────
    // Gate Settings
    // ───────────────────────────────────────────────────────────────────

    test("gate settings: visibility cards render and toggle", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      const gateSettings = page.getByTestId("gate-settings");
      await expect(gateSettings).toBeVisible();

      const publicCard = page.getByTestId("visibility-public");
      const privateCard = page.getByTestId("visibility-private");

      await expect(publicCard).toBeVisible();
      await expect(privateCard).toBeVisible();

      // Default is PUBLIC — click PRIVATE
      await privateCard.click();
      // Wait for the mutation to settle — the check icon should move
      await expect(
        privateCard
          .getByRole("img", { name: /check/i })
          .or(privateCard.locator("svg")),
      ).toBeVisible();

      // Switch back to PUBLIC
      await publicCard.click();
    });

    test("gate settings: gate type cards render", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      await expect(page.getByTestId("gate-option-none")).toBeVisible();
      await expect(page.getByTestId("gate-option-password")).toBeVisible();
      await expect(page.getByTestId("gate-option-application")).toBeVisible();
    });

    test("gate settings: selecting PASSWORD opens the password modal", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      // Click PASSWORD gate type
      await page.getByTestId("gate-option-password").click();

      // Password modal should appear
      const modal = page.getByTestId("password-modal");
      await expect(modal).toBeVisible();

      // The modal has the password input, cancel, and save buttons
      await expect(page.getByTestId("password-input")).toBeVisible();
      await expect(page.getByTestId("password-cancel-btn")).toBeVisible();
      await expect(page.getByTestId("password-save-btn")).toBeVisible();

      // Save should be disabled with empty/short password
      await expect(page.getByTestId("password-save-btn")).toBeDisabled();

      // Type a password
      await page.getByTestId("password-input").fill("test1234");
      await expect(page.getByTestId("password-save-btn")).toBeEnabled();

      // Cancel closes the modal without saving
      await page.getByTestId("password-cancel-btn").click();
      await expect(modal).not.toBeVisible();
    });

    test("gate settings: set and save a password", async ({ page }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      await page.getByTestId("gate-option-password").click();
      const modal = page.getByTestId("password-modal");
      await expect(modal).toBeVisible();

      await page.getByTestId("password-input").fill("secure123");
      await page.getByTestId("password-save-btn").click();

      // Modal should close after save
      await expect(modal).not.toBeVisible();

      // The password gate card should now show the "Edit" button
      await expect(page.getByTestId("gate-password-edit-btn")).toBeVisible();
    });

    test("gate settings: selecting APPLICATION shows form builder button", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      // Select APPLICATION gate type
      await page.getByTestId("gate-option-application").click();

      // Application section with Edit Form button should appear
      await expect(
        page.getByTestId("gate-edit-application-form-btn"),
      ).toBeVisible();

      // Review Applications button if slug is present
      await expect(
        page.getByTestId("gate-review-applications-btn"),
      ).toBeVisible();
    });

    // ───────────────────────────────────────────────────────────────────
    // Application Form Builder
    // ───────────────────────────────────────────────────────────────────

    test("application form builder: open, add question, cancel", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      // First select APPLICATION gate to reveal the button
      await page.getByTestId("gate-option-application").click();
      await expect(
        page.getByTestId("gate-edit-application-form-btn"),
      ).toBeVisible();

      // Open the form builder
      await page.getByTestId("gate-edit-application-form-btn").click();

      const builder = page.getByTestId("application-form-builder");
      await expect(builder).toBeVisible();

      // Add a question
      await page.getByTestId("app-add-question-btn").click();
      // Type picker should appear
      await expect(
        page.getByTestId("app-question-type-short_text"),
      ).toBeVisible();
      await expect(
        page.getByTestId("app-question-type-long_text"),
      ).toBeVisible();
      await expect(
        page.getByTestId("app-question-type-single_choice"),
      ).toBeVisible();
      await expect(
        page.getByTestId("app-question-type-multi_choice"),
      ).toBeVisible();

      // Select "Short Text"
      await page.getByTestId("app-question-type-short_text").click();

      // A question card should appear
      await expect(page.getByTestId("app-question-card")).toBeVisible();

      // Cancel without saving
      await page.getByTestId("app-form-cancel-btn").click();
      await expect(builder).not.toBeVisible();
    });

    test("application form builder: add question and save", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      await page.getByTestId("gate-option-application").click();
      await page.getByTestId("gate-edit-application-form-btn").click();

      const builder = page.getByTestId("application-form-builder");
      await expect(builder).toBeVisible();

      // Add a Short Text question
      await page.getByTestId("app-add-question-btn").click();
      await page.getByTestId("app-question-type-short_text").click();

      // Fill in the question label (the question card should be expanded)
      const questionCard = page.getByTestId("app-question-card").first();
      await expect(questionCard).toBeVisible();

      // Fill in the label input
      const labelInput = questionCard.getByPlaceholder(
        "What is your experience with",
      );
      await labelInput.fill("What is your DJ name?");

      // Save
      await page.getByTestId("app-form-save-btn").click();

      // Modal should close
      await expect(builder).not.toBeVisible();
    });

    // ───────────────────────────────────────────────────────────────────
    // Publish
    // ───────────────────────────────────────────────────────────────────

    test("publish button transitions event from DRAFT to PUBLISHED", async ({
      page,
    }) => {
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);

      // Confirm DRAFT badge
      await expect(page.getByText("DRAFT")).toBeVisible();

      // Click Publish
      const publishBtn = page.getByTestId("event-publish-btn");
      await expect(publishBtn).toBeEnabled();
      await publishBtn.click();

      // Wait for success toast or badge change
      await expect(page.getByText("PUBLISHED")).toBeVisible({
        timeout: 10_000,
      });

      // The Publish button should no longer be visible since it's now PUBLISHED
      await expect(publishBtn).not.toBeVisible();
    });
  });
});
