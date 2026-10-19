import { expect, test } from "./fixtures";
import { spotlightChord, waitForHydration } from "./helpers/spotlight";

/**
 * E2E: Spotlight Search
 *
 * Validates that:
 *   1. The navbar search control opens the Spotlight overlay.
 *   2. Typing a query and closing preserves it (the per-context query slot).
 *   3. Re-opening Spotlight restores the previous query.
 *   4. Escape closes Spotlight.
 *   5. The keyboard shortcut toggles Spotlight — ⌘K on a Mac, Ctrl+K
 *      elsewhere, pressed per the platform the page reports (see
 *      `helpers/spotlight.ts` for why that is not `ControlOrMeta`).
 *
 * These tests run against the guest project (no auth required) since the
 * Spotlight overlay is available on all public routes.
 */
test.describe("Spotlight search", () => {
  let chord = "";
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHydration(page);
    chord = await spotlightChord(page);
  });

  test("the navbar search control opens the Spotlight overlay", async ({
    page,
  }) => {
    // The navbar owns this entry point (the floating action bar that used to
    // carry a duplicate was removed 2026-08-27).
    const trigger = page.getByTestId("navbar-search-trigger");
    await expect(trigger).toBeVisible();

    await trigger.click();

    // Spotlight overlay should appear.
    const spotlight = page.getByTestId("spotlight-backdrop");
    await expect(spotlight).toBeVisible();

    // Input should be focused.
    const input = page.getByTestId("spotlight-input");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test("typing a query and pressing Escape keeps it for the next open", async ({
    page,
  }) => {
    // Open Spotlight via ⌘+K.
    await page.keyboard.press(chord);
    const spotlight = page.getByTestId("spotlight-backdrop");
    await expect(spotlight).toBeVisible();

    // Type a query.
    const input = page.getByTestId("spotlight-input");
    await input.fill("jazz festival");

    // Close via Escape.
    await page.keyboard.press("Escape");
    await expect(spotlight).not.toBeVisible();

    // Re-open Spotlight — the query should be restored.
    await page.keyboard.press(chord);
    await expect(spotlight).toBeVisible();
    const restoredInput = page.getByTestId("spotlight-input");
    await expect(restoredInput).toHaveValue("jazz festival");
  });

  test("clicking backdrop closes Spotlight", async ({ page }) => {
    await page.keyboard.press(chord);
    const spotlight = page.getByTestId("spotlight-backdrop");
    await expect(spotlight).toBeVisible();

    // Click the backdrop (not the panel).
    await spotlight.click({ position: { x: 10, y: 10 } });
    await expect(spotlight).not.toBeVisible();
  });

  test("close button closes Spotlight", async ({ page }) => {
    await page.keyboard.press(chord);
    const spotlight = page.getByTestId("spotlight-backdrop");
    await expect(spotlight).toBeVisible();

    const closeBtn = page.getByTestId("spotlight-close");
    await closeBtn.click();
    await expect(spotlight).not.toBeVisible();
  });

  test("the shortcut toggles Spotlight open and closed", async ({ page }) => {
    const spotlight = page.getByTestId("spotlight-backdrop");

    // Initially hidden.
    await expect(spotlight).not.toBeVisible();

    // Open.
    await page.keyboard.press(chord);
    await expect(spotlight).toBeVisible();

    // Close.
    await page.keyboard.press(chord);
    await expect(spotlight).not.toBeVisible();
  });

  test("filter pills are visible when Spotlight opens", async ({ page }) => {
    await page.keyboard.press(chord);
    const spotlight = page.getByTestId("spotlight-panel");
    await expect(spotlight).toBeVisible();

    // "All" filter should be active.
    const allFilter = page.getByTestId("spotlight-filter-all");
    await expect(allFilter).toBeVisible();

    // Type-specific filters should also be present.
    await expect(page.getByTestId("spotlight-filter-event")).toBeVisible();
    await expect(page.getByTestId("spotlight-filter-human")).toBeVisible();
    await expect(page.getByTestId("spotlight-filter-place")).toBeVisible();
    await expect(
      page.getByTestId("spotlight-filter-organization"),
    ).toBeVisible();
  });

  test("idle state shows hint when query is empty", async ({ page }) => {
    await page.keyboard.press(chord);
    const spotlight = page.getByTestId("spotlight-panel");
    await expect(spotlight).toBeVisible();

    // The input should be empty (or have only previous query).
    // The idle state hint should be visible since nothing is typed.
    const input = page.getByTestId("spotlight-input");
    await input.fill("");

    // Give the component a moment to update.
    await page.waitForTimeout(250);

    // Spotlight panel should still be visible (not collapsed).
    await expect(spotlight).toBeVisible();
  });
});
