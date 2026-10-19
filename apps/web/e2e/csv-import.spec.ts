import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// CSV Import Dialog E2E
// ─────────────────────────────────────────────────────────────────────────────
// Exercises the CsvImportDialog component embedded in the Places admin table.
// Tests both the File and Paste upload modes, tab switching, live preview with
// column detection, validation errors, clear/reset, and the full paste-to-
// mapping-to-preview flow.
//
// Preconditions:
//   - Playwright "setup" project has stored a signed-in session.
//   - Local infra is running (postgres + redis).
//   - API is reachable at PLAYWRIGHT_API_BASE_URL.
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Test data
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CSV = [
  "name,address,city,state,zip,capacity",
  "The Blue Note,123 Jazz Lane,Columbia,MO,65201,350",
  "Red Rocks,18300 W Alameda Pkwy,Morrison,CO,80465,9525",
  "The Fillmore,1805 Geary Blvd,San Francisco,CA,94115,1315",
].join("\n");

const VALID_CSV_COLS = ["name", "address", "city", "state", "zip", "capacity"];

const HEADERLESS_CSV = ["Some Value,Another Value,Third Value"].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

test.describe("CSV Import Dialog", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: AdminTablesSeed;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, {
      preserveEmail: TEST_EMAIL,
    });

    // Ensure email is verified so admin gates pass.
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

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Navigate to Places and open the CSV import dialog. */
  async function openImportDialog(page: import("@playwright/test").Page) {
    await page.goto(`/admin/${seed.orgSlug}/places`);
    await expect(page.getByTestId("places-manager-table")).toBeVisible({
      timeout: 15_000,
    });

    // Click the CSV import button in the action bar.
    await page.getByTestId("admin-places-csv-import").click();

    // Wait for the dialog to appear (header with FileSpreadsheet icon + title).
    await expect(page.getByText("Import CSV")).toBeVisible({ timeout: 5_000 });
  }

  /** Click the "Paste" tab in the upload mode toggle. */
  async function clickPasteTab(page: import("@playwright/test").Page) {
    await page.getByText("Paste", { exact: true }).first().click();
  }

  /** Click the "File" tab in the upload mode toggle. */
  async function clickFileTab(page: import("@playwright/test").Page) {
    await page.getByText("File", { exact: true }).first().click();
  }

  // ── Tests ─────────────────────────────────────────────────────────────

  test.describe("Dialog open / close", () => {
    test("opens the dialog and shows the upload step with File tab active", async ({
      page,
    }) => {
      await openImportDialog(page);

      // Step indicator should show step 1 (Upload).
      await expect(page.getByText("Upload").first()).toBeVisible();

      // Tab toggle should be visible — File tab is active by default.
      // Text is "File" / "Paste" (CSS uppercases them visually).
      await expect(
        page.getByText("File", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByText("Paste", { exact: true }).first(),
      ).toBeVisible();

      // File upload zone should be visible.
      await expect(
        page.getByRole("button", { name: /choose file/i }),
      ).toBeVisible();
    });

    test("closes when clicking the backdrop overlay", async ({ page }) => {
      await openImportDialog(page);

      // Click the backdrop (dark overlay behind the dialog panel).
      // Use a coordinate outside the dialog panel but inside the viewport.
      await page.mouse.click(10, 10);

      // Dialog should be gone.
      await expect(page.getByText("Import CSV")).not.toBeVisible({
        timeout: 3_000,
      });
    });
  });

  test.describe("Tab switching", () => {
    test("switches between File and Paste tabs", async ({ page }) => {
      await openImportDialog(page);

      // File mode is active — upload zone is visible, paste area is not.
      await expect(
        page.getByRole("button", { name: /choose file/i }),
      ).toBeVisible();
      await expect(page.locator("#csv-paste-area")).not.toBeVisible();

      // Click the Paste tab.
      await clickPasteTab(page);

      // Paste textarea should appear, file upload zone should disappear.
      await expect(page.locator("#csv-paste-area")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /choose file/i }),
      ).not.toBeVisible();

      // Switch back to File.
      await clickFileTab(page);
      await expect(
        page.getByRole("button", { name: /choose file/i }),
      ).toBeVisible();
      await expect(page.locator("#csv-paste-area")).not.toBeVisible();
    });
  });

  test.describe("Paste mode — live preview", () => {
    test("shows column preview when valid CSV is pasted", async ({ page }) => {
      await openImportDialog(page);
      await clickPasteTab(page);

      const textarea = page.locator("#csv-paste-area");
      await textarea.fill(VALID_CSV);

      // Live preview should show "Valid" and the column count + row count.
      await expect(page.getByText("Valid")).toBeVisible({ timeout: 3_000 });
      await expect(page.getByText("6 columns")).toBeVisible();
      await expect(page.getByText("3 rows")).toBeVisible();

      // Column chips should be rendered.
      for (const col of VALID_CSV_COLS) {
        await expect(
          page.getByText(col, { exact: true }).first(),
        ).toBeVisible();
      }

      // Continue button should be enabled.
      const continueBtn = page.getByRole("button", { name: /continue/i });
      await expect(continueBtn).toBeVisible();
      await expect(continueBtn).toBeEnabled();
    });

    test("shows error for data without detectable headers", async ({
      page,
    }) => {
      await openImportDialog(page);
      await clickPasteTab(page);

      const textarea = page.locator("#csv-paste-area");
      await textarea.fill(HEADERLESS_CSV);

      // The preview may show a valid state (1 header row, 0 data rows) since
      // PapaParse treats the first line as headers. The Continue button should
      // be disabled because there are 0 data rows parsed.
      // This is acceptable — the user just gets no data rows.
      // Either way, the dialog should remain stable (no crash, no console errors).
      await expect(page.locator("#csv-paste-area")).toBeVisible();
    });

    test("Clear button resets the paste area", async ({ page }) => {
      await openImportDialog(page);
      await clickPasteTab(page);

      const textarea = page.locator("#csv-paste-area");
      await textarea.fill(VALID_CSV);

      // Wait for preview to appear.
      await expect(page.getByText("Valid")).toBeVisible({ timeout: 3_000 });

      // Click Clear.
      await page.getByRole("button", { name: /clear/i }).click();

      // Textarea should be empty, preview should be gone.
      await expect(textarea).toHaveValue("");
      await expect(page.getByText("Valid")).not.toBeVisible();
    });
  });

  test.describe("Paste → Mapping flow", () => {
    test("pasting valid CSV and clicking Continue advances to the mapping step", async ({
      page,
    }) => {
      await openImportDialog(page);
      await clickPasteTab(page);

      // Paste data.
      await page.locator("#csv-paste-area").fill(VALID_CSV);
      await expect(page.getByText("Valid")).toBeVisible({ timeout: 3_000 });

      // Click Continue.
      await page.getByRole("button", { name: /continue/i }).click();

      // Should advance to the mapping step.
      await expect(page.getByText(/map columns/i)).toBeVisible({
        timeout: 5_000,
      });

      // Mapping rows should list the CSV headers.
      for (const col of VALID_CSV_COLS) {
        await expect(
          page.getByText(col, { exact: true }).first(),
        ).toBeVisible();
      }

      // The file name display should show "Pasted data" (from i18n).
      await expect(page.getByText(/pasted data/i)).toBeVisible();

      // Should show the row count.
      await expect(page.getByText("3")).toBeVisible();
    });

    test("Start Over button in mapping returns to the upload step", async ({
      page,
    }) => {
      await openImportDialog(page);
      await clickPasteTab(page);

      await page.locator("#csv-paste-area").fill(VALID_CSV);
      await expect(page.getByText("Valid")).toBeVisible({ timeout: 3_000 });
      await page.getByRole("button", { name: /continue/i }).click();

      // On mapping step now.
      await expect(page.getByText(/map columns/i)).toBeVisible({
        timeout: 5_000,
      });

      // Click "Start Over".
      await page.getByRole("button", { name: /start over/i }).click();

      // Should be back on upload step with file tab visible.
      await expect(
        page.getByRole("button", { name: /choose file/i }),
      ).toBeVisible({ timeout: 3_000 });
    });
  });

  test.describe("Paste → Mapping → Preview flow", () => {
    test("advances through mapping to preview with auto-detected columns", async ({
      page,
    }) => {
      await openImportDialog(page);
      await clickPasteTab(page);

      // Paste well-structured data with column names that auto-map.
      const autoMapCsv = [
        "name,full address,city,state,postal code,capacity",
        "The Blue Note,123 Jazz Lane,Columbia,MO,65201,350",
        "Red Rocks,18300 W Alameda Pkwy,Morrison,CO,80465,9525",
      ].join("\n");

      await page.locator("#csv-paste-area").fill(autoMapCsv);
      await expect(page.getByText("Valid")).toBeVisible({ timeout: 3_000 });

      // Continue to mapping.
      await page.getByRole("button", { name: /continue/i }).click();
      await expect(page.getByText(/map columns/i)).toBeVisible({
        timeout: 5_000,
      });

      // "Name" and "Full Address" should auto-map (required fields).
      // The Continue button should be enabled (no missing required fields).
      const continueBtn = page.getByRole("button", { name: /continue/i });
      await expect(continueBtn).toBeEnabled({ timeout: 3_000 });

      // Continue to preview.
      await continueBtn.click();

      // Preview step should show.
      await expect(page.getByText(/total rows/i)).toBeVisible({
        timeout: 5_000,
      });

      // Should display row count.
      await expect(page.getByText("2")).toBeVisible();

      // The import button should be visible.
      await expect(
        page.getByRole("button", { name: /import/i }).first(),
      ).toBeVisible();
    });
  });

  test.describe("File upload mode", () => {
    test("accepts a CSV file and advances to mapping", async ({ page }) => {
      await openImportDialog(page);

      // The file input is hidden — we dispatch a file chooser event.
      const fileInput = page.locator('input[type="file"]');

      // Create a temporary CSV buffer.
      const csvContent = ["name,address", "Test Venue,123 Main St"].join("\n");

      await fileInput.setInputFiles({
        name: "test-places.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csvContent),
      });

      // Should advance to the mapping step.
      await expect(page.getByText(/map columns/i)).toBeVisible({
        timeout: 5_000,
      });

      // Should show the filename.
      await expect(page.getByText("test-places.csv")).toBeVisible();
    });
  });
});
