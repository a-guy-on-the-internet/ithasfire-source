/**
 * The alerts panel holds the consumer navbar SHOWN while it is open.
 *
 * The defect this pins, measured at 320px: scroll down far enough that
 * `ScrollAwareNavbar` auto-hides (`transform: translateY(-88px)` plus
 * `pointer-events: none`), open the panel from the keyboard, then press Escape.
 * Focus goes back to the bell — which was sitting at `top: -76`, outside the
 * viewport and untappable. The panel's body portal cannot help and neither can
 * its scroll lock: the navbar was ALREADY hidden before the panel opened.
 *
 * So this is a real-browser test by necessity. The navbar's hide is driven by
 * scroll events, `window.innerWidth` and a CSS transform; nothing about it
 * exists in jsdom.
 *
 * Creates no data, so there is nothing to clean up — it only needs a signed-in
 * session (the bell is signed-in-only) and a page tall enough to scroll.
 */
import { expect, test } from "./fixtures";

const NAVBAR_WRAPPER = ".swiss-navbar-wrapper";
// The bell is the only `aria-haspopup="dialog"` in the navbar, and matching on
// that rather than its label keeps the locator out of the i18n catalogs (user
// WIP).
const BELL = 'button[aria-haspopup="dialog"][aria-expanded]';

test.use({ viewport: { width: 320, height: 640 } });

type NavbarMetrics = {
  navTop: number | null;
  navPointerEvents: string | null;
  bellTop: number | null;
  bellBottom: number | null;
  bellInViewport: boolean;
  bellHasFocus: boolean;
};

test.describe("alerts panel holds the navbar shown", () => {
  test("Escape restores focus to a bell the user can actually see", async ({
    page,
  }) => {
    await page.goto("/");

    const bell = page.locator(BELL).first();
    await expect(bell).toBeVisible();

    const readMetrics = (): Promise<NavbarMetrics> =>
      page.evaluate(
        ({ wrapperSelector, bellSelector }) => {
          const wrapper = document.querySelector(wrapperSelector);
          const bellEl = document.querySelector(bellSelector);
          const wrapperRect = wrapper?.getBoundingClientRect() ?? null;
          const bellRect = bellEl?.getBoundingClientRect() ?? null;
          return {
            navTop: wrapperRect ? Math.round(wrapperRect.top) : null,
            navPointerEvents: wrapper
              ? getComputedStyle(wrapper).pointerEvents
              : null,
            bellTop: bellRect ? Math.round(bellRect.top) : null,
            bellBottom: bellRect ? Math.round(bellRect.bottom) : null,
            bellInViewport: bellRect
              ? bellRect.top >= 0 && bellRect.bottom <= window.innerHeight
              : false,
            bellHasFocus: document.activeElement === bellEl,
          };
        },
        { wrapperSelector: NAVBAR_WRAPPER, bellSelector: BELL },
      );

    // The whole scenario needs a page that scrolls past the hide threshold.
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(
      scrollable,
      "the home page must be taller than the viewport for the navbar to hide",
    ).toBeGreaterThan(400);

    // Wheel in steps: the scroll handler needs a per-frame delta of at least
    // 8px, so one big jump would be ignored as jitter.
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, 80);
      await page.waitForTimeout(120);
    }
    // Let the 420ms slide finish.
    await page.waitForTimeout(700);

    // Precondition — the navbar is hidden and inert BEFORE the panel opens.
    // This is the state no portal or scroll lock can recover from.
    const hiddenState = await readMetrics();
    expect(hiddenState.navTop).toBeLessThan(0);
    expect(hiddenState.navPointerEvents).toBe("none");
    expect(hiddenState.bellInViewport).toBe(false);

    // Open from the keyboard, because the hidden navbar is `pointer-events:
    // none` and a click cannot reach the bell at all. `preventScroll` keeps the
    // browser's own scroll-into-view out of the measurement: what is under test
    // is the navbar's position, not where the page scrolled to.
    await bell.evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(700);

    // The hold is in effect: the bar is back at the top, live again, and the
    // panel's own trigger is on screen.
    const openState = await readMetrics();
    expect(openState.navTop).toBe(0);
    expect(openState.navPointerEvents).toBe("auto");
    expect(openState.bellInViewport).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Long enough for a re-hide to have played out if the hold only suspended
    // the hide instead of cancelling it.
    await page.waitForTimeout(900);

    const closedState = await readMetrics();
    expect(closedState.bellHasFocus).toBe(true);
    expect(
      closedState.bellInViewport,
      `focus came back to a bell outside the viewport (top ${closedState.bellTop}, bottom ${closedState.bellBottom})`,
    ).toBe(true);
    expect(closedState.navPointerEvents).toBe("auto");
  });
});
