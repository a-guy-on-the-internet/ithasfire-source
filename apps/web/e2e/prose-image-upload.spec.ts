import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import path from "path";
import fs from "fs";
import os from "os";

// ─────────────────────────────────────────────────────────────────────────────
// ProseEditor Image Upload E2E
// ─────────────────────────────────────────────────────────────────────────────
// Verifies end-to-end that an image can be uploaded via the ProseEditor in the
// EventBuilder edit mode. The flow:
//   1. Seed a DRAFT event (via /e2e/seed/event-builder).
//   2. Navigate to the event edit page.
//   3. Locate the ProseEditor image upload button.
//   4. Upload a small synthetic PNG.
//   5. Assert the imageBlock renders with an <img> pointing at an R2 URL.
//
// Preconditions:
//   - Local infra + API running with R2 credentials configured.
//   - Playwright "setup" project has stored a signed-in session.
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

/**
 * Create a minimal valid 1x1 red PNG file for upload testing.
 * Returns the absolute path to the temporary file (cleaned up after tests).
 */
function createTestPng(): string {
  // Minimal 1x1 red PNG (67 bytes)
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8" +
      "/58BPQAY8gL+DAAAABJRU5ErkJggg==",
    "base64",
  );
  const tmpPath = path.join(os.tmpdir(), `e2e-test-image-${Date.now()}.png`);
  fs.writeFileSync(tmpPath, png);
  return tmpPath;
}

test.describe("ProseEditor Image Upload", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: EventBuilderSeed;
  let testImagePath: string;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, {
      preserveEmail: TEST_EMAIL,
    });

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

    // Create the temporary test image
    testImagePath = createTestPng();
  });

  test.afterAll(() => {
    // Clean up the temporary image file
    if (testImagePath && fs.existsSync(testImagePath)) {
      fs.unlinkSync(testImagePath);
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // Tests
  // ═════════════════════════════════════════════════════════════════════

  test("image upload button is visible in edit mode", async ({ page }) => {
    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
    await expect(page.getByTestId("prose-editor")).toBeVisible();

    // The ProseEditor should be on the page
    const editor = page.getByTestId("prose-editor");
    await expect(editor).toBeVisible();

    // Image upload button should be visible and enabled (we're in edit mode with eventId)
    const uploadBtn = page.getByTestId("prose-image-upload-btn");
    await expect(uploadBtn).toBeVisible();
  });

  test("image upload button is disabled in create mode (no eventId)", async ({
    page,
  }) => {
    await page.goto(`/admin/${seed.orgSlug}/events/new`);
    await expect(page.getByText("Create Event")).toBeVisible();

    // The image button should be shown but disabled — tooltip indicates "save first"
    const uploadBtn = page.getByTestId("prose-image-upload-btn");
    await expect(uploadBtn).toBeVisible();

    // In Tamagui the disabled variant adds opacity + cursor:not-allowed.
    // The button's disabled attribute should be reflected in the DOM.
    await expect(uploadBtn).toHaveAttribute("aria-disabled", "true");
  });

  test("uploading an image via the prose editor inserts an image block", async ({
    page,
  }) => {
    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
    await expect(page.getByTestId("prose-editor")).toBeVisible();

    const editor = page.getByTestId("prose-editor");
    await expect(editor).toBeVisible();

    // Get the hidden file input
    const fileInput = page.getByTestId("prose-image-file-input");

    // Upload the test PNG by setting the file on the hidden input
    await fileInput.setInputFiles(testImagePath);

    // The upload indicator should appear briefly
    // (may be too fast to reliably catch, so we check with a short timeout)
    // Instead, wait for the image block to appear in the editor
    const imageBlock = page.getByTestId("prose-image-block");
    await expect(imageBlock).toBeVisible({ timeout: 30_000 });

    // The rendered <img> inside the block should have a valid src
    const img = page.getByTestId("prose-image-block-img");
    await expect(img).toBeVisible({ timeout: 15_000 });

    // The src should be a real URL (either R2 public URL or presigned URL)
    const src = await img.getAttribute("src");
    expect(src).toBeTruthy();
    expect(src!.startsWith("http")).toBeTruthy();
  });

  test("uploaded image persists after saving and reloading", async ({
    page,
  }) => {
    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
    await expect(page.getByTestId("prose-editor")).toBeVisible();

    const editor = page.getByTestId("prose-editor");
    await expect(editor).toBeVisible();

    // Upload image
    const fileInput = page.getByTestId("prose-image-file-input");
    await fileInput.setInputFiles(testImagePath);

    // Wait for image block to appear
    const imageBlock = page.getByTestId("prose-image-block");
    await expect(imageBlock).toBeVisible({ timeout: 30_000 });

    // Save the event
    const saveBtn = page.getByTestId("event-save-btn");
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();

    // Wait for the save to complete (look for success indicator or just wait)
    await page.waitForTimeout(2_000);

    // Reload the page
    await page.reload();
    await expect(page.getByTestId("prose-editor")).toBeVisible();

    // The image block should still be present after reload
    const imageBlockAfterReload = page.getByTestId("prose-image-block");
    await expect(imageBlockAfterReload).toBeVisible({ timeout: 30_000 });

    // The <img> should still have a valid URL
    const img = page.getByTestId("prose-image-block-img");
    await expect(img).toBeVisible({ timeout: 15_000 });
    const src = await img.getAttribute("src");
    expect(src).toBeTruthy();
    expect(src!.startsWith("http")).toBeTruthy();
  });
});
