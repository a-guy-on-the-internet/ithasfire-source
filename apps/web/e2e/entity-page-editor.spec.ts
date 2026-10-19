import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

/**
 * Profile + Theme moved into the collapsible PageSettingsDisclosure. A single
 * expand exposes both subsections, so this is a no-op when already open.
 */
async function ensureSettingsOpen(
  page: import("@playwright/test").Page,
): Promise<void> {
  const toggle = page.getByTestId("entity-page-settings-toggle");
  await toggle.scrollIntoViewIfNeeded();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.locator("#entity-page-settings-panel")).toBeVisible();
}

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
  "playwright-setup@example.com";

interface EntityPageEditorSeed {
  humanId: string;
  orgId: string;
  orgSlug: string;
  orgPageSlug: string;
  placeArchivedId: string;
  placePageSlug: string;
  legacyCustomPageSlug: string;
}

test.describe.configure({ mode: "serial" });

test.describe("Entity page editor", () => {
  let seed: EntityPageEditorSeed;

  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  test.beforeAll(async ({ request }, testInfo) => {
    if (testInfo.project.name === "guest") return;

    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

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
    expect(seed.orgPageSlug).toBeTruthy();
    expect(seed.placeArchivedId).toBeTruthy();
    expect(seed.placePageSlug).toBeTruthy();
    expect(seed.legacyCustomPageSlug).toBeTruthy();
  });

  test("org page editor renders block canvas and excludes Custom HTML", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore();

    await page.goto(`/admin/${seed.orgSlug}/page`);

    await expect(
      page.getByRole("heading", { name: /E2E Admin Org.*Page/ }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("E2E organization about block")).toBeVisible();

    const addBlockRail = page.getByTestId("entity-page-add-block-palette");
    const blockPalette = page.getByTestId("entity-page-add-block-kind-select");
    await expect(addBlockRail).toBeVisible();
    await expect(blockPalette).toBeVisible();
    const aboutBlockButton = page.getByTestId(
      "entity-page-add-block-kind-about",
    );
    await expect(aboutBlockButton).toBeVisible();
    await expect(blockPalette.getByText(/^Custom HTML$/)).toHaveCount(0);
    await expect(blockPalette.getByText(/^Mission$/)).toHaveCount(0);
    await expect(blockPalette.getByText(/^Past Events$/)).toHaveCount(0);

    const paletteBox = await addBlockRail.boundingBox();
    const aboutBlockBox = await page
      .getByText("E2E organization about block")
      .boundingBox();
    const aboutButtonBox = await aboutBlockButton.boundingBox();
    expect(paletteBox, "palette should have a layout box").not.toBeNull();
    expect(
      aboutBlockBox,
      "page canvas content should have a layout box",
    ).not.toBeNull();
    expect(
      aboutButtonBox,
      "palette row should have a compact layout box",
    ).not.toBeNull();
    expect(paletteBox!.x).toBeGreaterThan(
      aboutBlockBox!.x + aboutBlockBox!.width - 4,
    );
    expect(aboutButtonBox!.height).toBeLessThan(44);

    await ensureSettingsOpen(page);
    await page.getByTestId("entity-page-theme-layout").selectOption("grid");
    // One Save for the whole settings panel, in the editor toolbar — it
    // commits whichever sections are dirty (here: the theme).
    await page.getByTestId("entity-page-save").click();
    await expect(page.getByText("Theme updated")).toBeVisible();

    const grid = page.getByTestId("entity-page-block-grid");
    await expect(grid).toHaveAttribute("data-grid-visible", "true");

    const editableBlock = page
      .locator('[data-testid^="entity-page-editable-block-"]')
      .first();
    await expect(editableBlock).toBeVisible();
    const blockTestId = await editableBlock.getAttribute("data-testid");
    expect(
      blockTestId,
      "editable block should expose its id in a test id",
    ).toBeTruthy();
    const blockId = blockTestId!.replace("entity-page-editable-block-", "");

    await editableBlock.hover();
    await page.getByTestId(`entity-page-block-span-${blockId}-1`).click();
    await expect(async () => {
      const gridBox = await grid.boundingBox();
      const resizedBox = await editableBlock.boundingBox();
      expect(gridBox, "grid should have a layout box").not.toBeNull();
      expect(
        resizedBox,
        "resized block should have a layout box",
      ).not.toBeNull();
      expect(resizedBox!.width).toBeLessThan(gridBox!.width * 0.7);
    }).toPass({ timeout: 8_000 });

    await editableBlock.click({ position: { x: 32, y: 80 } });
    await expect(
      page.getByTestId(`entity-page-block-settings-${blockId}`),
    ).toBeVisible();

    await editableBlock.hover();
    await page.getByTestId(`entity-page-block-span-${blockId}-2`).click();
    await expect(async () => {
      const gridBox = await grid.boundingBox();
      const resizedBox = await editableBlock.boundingBox();
      expect(gridBox, "grid should have a layout box").not.toBeNull();
      expect(
        resizedBox,
        "resized block should have a layout box",
      ).not.toBeNull();
      expect(resizedBox!.width).toBeGreaterThan(gridBox!.width * 0.85);
    }).toPass({ timeout: 8_000 });

    // The canvas is authoring only — the device switch belongs to Preview now.
    await expect(page.getByTestId("entity-page-edit-canvas")).toBeVisible();
    await expect(page.getByTestId("entity-page-preview-desktop")).toHaveCount(0);
    await expect(page.getByTestId("entity-page-preview-mobile")).toHaveCount(0);
    await expect(addBlockRail).toBeVisible();
    // Editable content renders inline in the canvas (true WYSIWYG).
    await expect(page.getByText("E2E organization about block")).toBeVisible();

    // "View live" stays the canonical final preview — opens /p/<slug> in a tab.
    // Page-owned control in the editor toolbar; there is no action bar.
    const popupPromise = page.waitForEvent("popup");
    await page.getByTestId("entity-page-view-live").click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(new URL(popup.url()).pathname).toBe(`/p/${seed.orgPageSlug}`);
    await popup.close();

    await ensureSettingsOpen(page);
    await page.getByLabel("Display name").fill("E2E Admin Org Saved");
    await page.getByTestId("entity-page-save").click();
    await expect(page.getByText("Page updated")).toBeVisible();

    // The canvas stays mounted alongside the settings panel.
    await expect(page.getByTestId("entity-page-edit-canvas")).toBeVisible();
    await expect(addBlockRail).toBeVisible();

    // Preview: the real page render fed with the CURRENT in-memory state, and
    // the one place the device switch lives. The authoring surface stays in
    // the DOM (display:none) so nothing is remounted on the round trip.
    await page.getByTestId("entity-page-view-mode-preview").click();
    await expect(page.getByTestId("entity-page-preview-surface")).toBeVisible();
    await expect(page.getByTestId("entity-page-edit-surface")).toBeHidden();
    await expect(addBlockRail).toBeHidden();
    await expect(page).toHaveURL(/[?&]view=preview\b/);
    await expect(
      page.getByTestId("entity-page-preview-frame-desktop"),
    ).toBeVisible();

    await page.getByTestId("entity-page-preview-mobile").click();
    await expect(
      page.getByTestId("entity-page-preview-frame-mobile"),
    ).toBeVisible();

    // Back to authoring: Escape leaves preview, the URL unwinds, and the
    // structural chrome comes back.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("entity-page-preview-surface")).toHaveCount(0);
    await expect(page.getByTestId("entity-page-edit-surface")).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]view=preview\b/);
    await expect(addBlockRail).toBeVisible();
  });

  test("verified place page editor renders without exposing Custom HTML", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore();

    await page.goto(
      `/admin/${seed.orgSlug}/places/${seed.placeArchivedId}/page`,
    );

    await expect(
      page.getByRole("heading", { name: "Place profile" }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("E2E place about block")).toBeVisible();

    await expect(
      page.getByTestId("entity-page-add-block-palette"),
    ).toBeVisible();
    const blockPalette = page.getByTestId("entity-page-add-block-kind-select");
    await expect(blockPalette).toBeVisible();
    await expect(blockPalette.getByText(/^Custom HTML$/)).toHaveCount(0);
  });

  test("legacy custom HTML blocks do not render HTML on public pages", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore();

    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await page.goto(`/p/${seed.legacyCustomPageSlug}`, {
      waitUntil: "networkidle",
    });

    await expect(page.getByText("E2E Legacy Custom HTML")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText("UNSAFE CUSTOM HTML SHOULD NOT RENDER"),
    ).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
});
