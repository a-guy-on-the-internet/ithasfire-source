/**
 * ⌘K / Ctrl+K opens Spotlight on every surface GlobalOverlays mounts on.
 *
 * The shortcut went dead once because its registration rode along inside the
 * contextual-action-bar wiring, and deleting that wiring (dc66e1b22) deleted
 * the listener with it. Unit tests could not see that: they render the hook,
 * not the app. This drives the real page, public and admin, and pins the
 * layering with the alerts panel — Spotlight opens over it, and the Escape
 * that closes Spotlight must not also close the panel underneath.
 *
 * Creates no data, so there is nothing to clean up. It needs the signed-in
 * storageState (the bell and /admin are signed-in only).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { spotlightChord, waitForHydration } from "./helpers/spotlight";

const ADMIN_SLUG = process.env.E2E_ADMIN_SLUG ?? "demo";
// The bell is the only `aria-haspopup="dialog"` in the navbar; matching on
// that keeps the locator out of the i18n catalogs.
const BELL = 'button[aria-haspopup="dialog"][aria-expanded]';
// The alerts panel: a dialog that is not Spotlight's backdrop.
const ALERTS_PANEL = '[role="dialog"]:not([data-testid="spotlight-backdrop"])';

async function expectShortcutRoundTrip(page: Page) {
  const backdrop = page.getByTestId("spotlight-backdrop");
  const input = page.getByTestId("spotlight-input");
  const chord = await spotlightChord(page);

  await expect(backdrop).toHaveCount(0);
  await page.keyboard.press(chord);
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(backdrop).toHaveCount(0);

  // And again — a second listener would toggle open-then-closed on one press.
  await page.keyboard.press(chord);
  await expect(input).toBeVisible();
  // ⌘K from inside the open overlay's own input toggles it closed.
  await page.keyboard.press(chord);
  await expect(backdrop).toHaveCount(0);
}

test.describe("⌘K opens Spotlight", () => {
  test("on the public home page", async ({ page }) => {
    await page.goto("/");
    await waitForHydration(page);
    await expectShortcutRoundTrip(page);
  });

  test("on an org admin page", async ({ page }) => {
    await page.goto(`/admin/${ADMIN_SLUG}`);
    await waitForHydration(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${ADMIN_SLUG}`));
    await expectShortcutRoundTrip(page);
  });

  test.describe("at 320px", () => {
    test.use({ viewport: { width: 320, height: 640 } });

    // The full-screen sheet layout. Focus used to land on <body> here every
    // time: the input was focused on a timer that beat the portal's render.
    test("on an org admin page, focus lands in the input", async ({ page }) => {
      await page.goto(`/admin/${ADMIN_SLUG}`);
      await waitForHydration(page);
      await expectShortcutRoundTrip(page);
    });
  });

  test("over the alerts panel: Escape closes Spotlight, not the panel", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForHydration(page);

    const bell = page.locator(BELL).first();
    await expect(bell).toBeVisible();
    await bell.click();
    const panel = page.locator(ALERTS_PANEL);
    await expect(panel).toBeVisible();

    const input = page.getByTestId("spotlight-input");
    const chord = await spotlightChord(page);
    await page.keyboard.press(chord);
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    // Spotlight paints above the panel, so it is the layer the user can see
    // and click — not just later in the DOM.
    const z = await page.evaluate(() => {
      const top = (el: Element | null) => {
        while (el && el.parentElement !== document.body) el = el.parentElement;
        return el ? Number(getComputedStyle(el).zIndex) : NaN;
      };
      return {
        spotlight: top(document.querySelector('[data-testid="spotlight-input"]')),
        panel: top(
          document.querySelector(
            '[role="dialog"]:not([data-testid="spotlight-backdrop"])',
          ),
        ),
      };
    });
    expect(z.spotlight).toBeGreaterThan(z.panel);

    // Tab stays in Spotlight: the panel's boundary trap must not pull focus
    // back down into the panel from a layer above it.
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("spotlight-backdrop")).toHaveCount(0);
    await expect(panel).toBeVisible();
    // Focus came back into the panel, where it was when ⌘K was pressed.
    expect(
      await panel.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);

    // A second Escape is the panel's own, and closes it.
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });
});
