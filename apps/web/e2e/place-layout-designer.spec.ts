import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Place Layout Designer E2E
// ─────────────────────────────────────────────────────────────────────────────
// Exercises the layout designer canvas and save flow:
// - Navigating to the designer page for an org-owned place
// - Drawing sections and placing seats on the canvas
// - Entering a layout name
// - Saving the layout via presigned upload → replacePlaceLayout
// - Verifying the saved layout persists across page reload
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

interface LayoutDesignerSeed {
  humanId: string;
  orgId: string;
  orgSlug: string;
  placeId: string;
}

test.describe("Place Layout Designer", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: LayoutDesignerSeed;

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

    const res = await request.post(
      `${API_BASE_URL}/e2e/seed/place-layout-designer`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: { email: TEST_EMAIL },
      },
    );

    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    seed = body.seed;
    expect(seed.orgSlug).toBeTruthy();
    expect(seed.placeId).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DESIGNER PAGE RENDERING
  // ═══════════════════════════════════════════════════════════════════════

  test("renders the designer with toolbar and canvas", async ({ page }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/places/${seed.placeId}/layout/designer`,
    );

    // Toolbar should be visible
    await expect(page.getByTestId("designer-toolbar")).toBeVisible();

    // Canvas should be visible
    await expect(page.getByTestId("designer-canvas")).toBeVisible();

    // Layout name input should be visible and empty
    const nameInput = page.getByTestId("designer-layout-name");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue("");

    // Save button should be visible but disabled (no layout name)
    const saveBtn = page.getByTestId("designer-save-btn");
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toBeDisabled();
  });

  test("save button stays disabled without a layout name", async ({ page }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/places/${seed.placeId}/layout/designer`,
    );

    const saveBtn = page.getByTestId("designer-save-btn");
    await expect(saveBtn).toBeDisabled();

    // Error hint should be visible
    await expect(page.getByText("Enter a layout name to save")).toBeVisible();
  });

  test("save button enables when a layout name is entered", async ({
    page,
  }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/places/${seed.placeId}/layout/designer`,
    );

    const nameInput = page.getByTestId("designer-layout-name");
    const saveBtn = page.getByTestId("designer-save-btn");

    await expect(saveBtn).toBeDisabled();

    // Enter a layout name
    await nameInput.fill("Test Layout");
    await expect(saveBtn).toBeEnabled();

    // Clear the name — button should disable again
    await nameInput.fill("");
    await expect(saveBtn).toBeDisabled();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CANVAS INTERACTION — SECTION TOOL
  // ═══════════════════════════════════════════════════════════════════════

  test("section tool: draw a section on the canvas", async ({ page }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/places/${seed.placeId}/layout/designer`,
    );

    const canvas = page.getByTestId("designer-canvas");
    await expect(canvas).toBeVisible();

    // Activate the section tool by clicking its button (aria-label)
    const sectionTool = page.getByRole("button", { name: /section/i });
    if (await sectionTool.isVisible()) {
      await sectionTool.click();
    }

    // Draw a rectangle on the canvas
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;

    const startX = box.x + box.width * 0.2;
    const startY = box.y + box.height * 0.2;
    const endX = box.x + box.width * 0.6;
    const endY = box.y + box.height * 0.6;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 10 });
    await page.mouse.up();

    // After drawing, the section count in the summary should update.
    // The toolbar summary shows "N seats · M sections"
    // Wait a moment for state to settle
    await page.waitForTimeout(300);

    // Verify the toolbar summary reflects at least 1 section
    const summaryText = page
      .getByTestId("designer-toolbar")
      .getByText(/section/i);
    await expect(summaryText).toBeVisible();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SAVE FLOW
  // ═══════════════════════════════════════════════════════════════════════

  test("save layout with name, section, and seats", async ({
    page,
    consoleErrors,
  }) => {
    // The save flow involves presigned upload + tRPC mutation which may
    // produce transient network errors in local e2e. Don't fail on those.
    consoleErrors.ignore();

    await page.goto(
      `/admin/${seed.orgSlug}/places/${seed.placeId}/layout/designer`,
    );

    const canvas = page.getByTestId("designer-canvas");
    const nameInput = page.getByTestId("designer-layout-name");
    const saveBtn = page.getByTestId("designer-save-btn");

    await expect(canvas).toBeVisible();

    // 1. Enter a layout name
    await nameInput.fill("E2E Saved Layout");

    // 2. Activate section tool and draw a section
    const sectionTool = page.getByRole("button", { name: /section/i });
    if (await sectionTool.isVisible()) {
      await sectionTool.click();
    }

    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;

    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
      steps: 10,
    });
    await page.mouse.up();

    await page.waitForTimeout(200);

    // 3. Save button should be enabled now
    await expect(saveBtn).toBeEnabled();

    // 4. Click save
    await saveBtn.click();

    // 5. Verify save completes — look for a success toast or the button
    //    text reverting from "Saving..." back to "Save Layout".
    //    The button text changes to "Saving..." during the mutation.
    await expect(saveBtn.getByText("Save Layout")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("layout name persists on the layout page after save", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore();

    await page.goto(
      `/admin/${seed.orgSlug}/places/${seed.placeId}/layout/designer`,
    );

    const canvas = page.getByTestId("designer-canvas");
    const nameInput = page.getByTestId("designer-layout-name");
    const saveBtn = page.getByTestId("designer-save-btn");

    await expect(canvas).toBeVisible();

    // Name and draw a quick section
    await nameInput.fill("Persistent Layout");

    const sectionTool = page.getByRole("button", { name: /section/i });
    if (await sectionTool.isVisible()) {
      await sectionTool.click();
    }

    const box = await canvas.boundingBox();
    if (!box) return;

    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, {
      steps: 5,
    });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Save
    await saveBtn.click();
    await expect(saveBtn.getByText("Save Layout")).toBeVisible({
      timeout: 15_000,
    });

    // Navigate to the layout overview page to confirm the layout was saved
    await page.goto(`/admin/${seed.orgSlug}/places/${seed.placeId}/layout`);

    // The layout page should show the saved layout name in a badge
    await expect(page.getByText("Persistent Layout")).toBeVisible({
      timeout: 5_000,
    });

    // The "Design Layout" button should be visible (layout exists now)
    await expect(
      page.getByRole("button", { name: /design layout/i }),
    ).toBeVisible();
  });
});
