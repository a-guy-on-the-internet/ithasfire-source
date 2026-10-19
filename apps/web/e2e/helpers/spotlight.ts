import type { Page } from "@playwright/test";

/**
 * The Spotlight chord the PAGE expects: ⌘K where the browser reports an Apple
 * platform, Ctrl+K everywhere else.
 *
 * MIRROR of `isApplePlatform` in
 * `packages/ui/src/ui/shell/utils/command-palette-chord.ts` (`@th/ui/keyboard`),
 * the one source of the rule. It cannot be imported: this runs inside
 * `page.evaluate`, in the browser, where only serialisable code goes. Change
 * the two together.
 *
 * Not Playwright's `ControlOrMeta`: that follows the HOST OS, while the app
 * follows what the browser reports, and the two disagree under the
 * "Desktop Chrome" device — it spoofs a Windows UA, so on a Mac host
 * `userAgentData.platform` says "Windows" and `ControlOrMeta` presses Meta.
 * Measured: every shortcut press then missed. Reading the page's own
 * platform keeps the press and the rule in agreement on any host.
 */
export async function spotlightChord(page: Page): Promise<string> {
  const apple = await page.evaluate(() => {
    const nav = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    const platform = nav.userAgentData?.platform || nav.platform || "";
    return /mac|iphone|ipad/i.test(platform);
  });
  return apple ? "Meta+k" : "Control+k";
}

/**
 * The shortcut listener attaches in an effect, so a keypress before React has
 * hydrated goes nowhere. Wait for the fiber rather than guessing a delay.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Object.keys(document.body).some((k) => k.startsWith("__reactFiber")),
  );
}
