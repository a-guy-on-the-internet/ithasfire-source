import { expect, type Page } from "@playwright/test";

/**
 * Remove every passkey on the currently signed-in account.
 *
 * The settle-wait at the top is the whole point. The passkey list loads
 * asynchronously after navigation, so a `count()` taken immediately returns 0 —
 * indistinguishable from "there are none" — and a naive loop exits having
 * deleted nothing while reporting success. That exact bug let credentials
 * accumulate across runs under `E2E_USE_LIVE_STACK=1` (which does NOT reset the
 * database), producing rows with duplicate names: enrolling while the list is
 * still loading also sees an empty `existingNames` and skips the disambiguating
 * suffix.
 *
 * Wait for the list to reach a KNOWN state — at least one row, or the empty
 * state — before believing any count.
 */
export async function removeAllPasskeys(page: Page): Promise<void> {
  const rows = page.getByRole("button", { name: /^Remove/ });
  const emptyState = page.getByText(/No passkeys yet/i);

  await expect
    .poll(
      async () =>
        (await rows.count()) > 0 ||
        (await emptyState.isVisible().catch(() => false)),
      { timeout: 30_000 },
    )
    .toBeTruthy();

  for (let i = 0; i < 15; i++) {
    const count = await rows.count();
    if (count === 0) return;
    await rows.first().click();
    await expect(rows).toHaveCount(count - 1, { timeout: 20_000 });
  }
  await expect(rows).toHaveCount(0);
}
