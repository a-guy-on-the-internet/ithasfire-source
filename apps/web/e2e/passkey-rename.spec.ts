import { expect, test, type Page } from "./fixtures";
import { installVirtualAuthenticator } from "./helpers/virtual-authenticator";

/**
 * Passkey RENAME coverage (the Passkeys card on /account/settings/security).
 *
 * Why this exists as an e2e at all, when PasskeysSection has 27 unit tests:
 * those tests mock `tamagui`, `@th/ui` and the settings primitives away, so
 * they render the section in ISOLATION. That makes a whole class of defect
 * structurally invisible to them — most sharply, accessible-name collisions
 * with the rest of the page. Settings used to render several "Save" buttons on
 * one scroll (Booking defaults has one), which a section-scoped unit test can
 * never see. That defect shipped through a full review and was only caught by
 * driving the real page. Keep at least one spec here that touches the real
 * thing.
 *
 * Settings is now one route per section, so this drives
 * `/account/settings/security` — the route that owns the Security cluster
 * (password, phone, TOTP, passkeys). Landing on the bare `/account/settings`
 * would render Profile and find no passkey UI at all.
 *
 * ⚠️ Do NOT run the passkey specs CONCURRENTLY with each other. The repo config
 * sets `fullyParallel: true`, and every passkey spec enrols against the SAME
 * `auth.setup.ts` account, so two files racing on one credential list fail in
 * confusing ways: WebAuthn sends `excludeCredentials` for existing passkeys and
 * the virtual authenticator then refuses to register, while each spec's cleanup
 * deletes rows the other is mid-assertion on. Measured: the two passkey files
 * together → 2 failed; the same two with `--workers=1` → 4 passed, DB left at 0.
 *
 *   cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test \
 *     e2e/passkey.spec.ts e2e/passkey-rename.spec.ts --project=chromium --workers=1
 *
 * The durable fix is to give each passkey spec its OWN account rather than
 * sharing the setup user. Until then, pass `--workers=1` when running more than
 * one of them.
 *
 * Run it WITHOUT wiping your dev database:
 *   cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test \
 *     e2e/passkey-rename.spec.ts --project=chromium --reporter=list
 *
 * The default path resets + reseeds the DB (see playwright.config.ts).
 *
 * Because it may run against a live shared database, this spec creates only
 * passkeys and removes every one it creates, including on failure.
 */

/** Row action labels are `Rename <name>, added <date>` — strip the qualifier. */
async function passkeyNames(page: Page): Promise<string[]> {
  return page
    .getByRole("button", { name: /^Rename/ })
    .evaluateAll((els) =>
      els.map((el) =>
        (el.getAttribute("aria-label") ?? "")
          .replace(/^Rename /, "")
          .replace(/, added .*$/, "")
          .trim(),
      ),
    );
}

/**
 * Remove every passkey on the account.
 *
 * Waits for the list to SETTLE before counting: the list loads asynchronously,
 * so a count of 0 taken too early is indistinguishable from "none exist" and
 * exits the loop having deleted nothing.
 */
async function removeAllPasskeys(page: Page): Promise<void> {
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

test.describe("Passkey rename", () => {
  test("derives a dateless name, then renames it", async ({ page }) => {
    const auth = await installVirtualAuthenticator(page);
    // Unique per run so a previous failed run's leftovers can never collide
    // with (and silently block) this run's rename.
    const target = `E2E renamed ${process.pid}`;
    try {
      await page.goto("/account/settings/security");
      const addBtn = page.getByTestId("passkey-add");
      await expect(addBtn).toBeVisible({ timeout: 30_000 });
      await removeAllPasskeys(page);

      // ── Enrollment name ────────────────────────────────────────────────
      await addBtn.click();
      const rename = page.getByRole("button", { name: /^Rename/ }).first();
      await expect(rename).toBeVisible({ timeout: 20_000 });

      const derived = (await passkeyNames(page))[0] ?? "";
      expect(derived.length).toBeGreaterThan(0);
      // No date in the NAME. The row already renders "Added <date>" on its own
      // line directly beneath it, so a date here duplicated an adjacent field.
      // The old format was e.g. "MacIntel · 7/27/2026".
      expect(derived).not.toMatch(/\d{4}/);
      expect(derived).not.toMatch(/\d+\/\d+\/\d+/);
      // Possessive composition uses U+2019, never an ASCII apostrophe.
      if (derived.includes("s ")) expect(derived).not.toContain("'");

      // ── Rename persists ────────────────────────────────────────────────
      await rename.click();
      const input = page.getByLabel(/^New name for/);
      await expect(input).toBeVisible();
      await input.fill(target);
      await page.getByRole("button", { name: /^Save new name for/ }).click();
      const renamed = page.getByRole("button", {
        name: new RegExp(`^Rename ${target}`),
      });
      await expect(renamed).toBeVisible({ timeout: 20_000 });

      // Reload to prove it reached the server, not just local state.
      await page.reload();
      await expect(
        page.getByRole("button", { name: new RegExp(`^Rename ${target}`) }),
      ).toBeVisible({ timeout: 30_000 });

      // ── Escape cancels without saving ──────────────────────────────────
      await page
        .getByRole("button", { name: new RegExp(`^Rename ${target}`) })
        .click();
      const editing = page.getByLabel(/^New name for/);
      await editing.fill("DISCARDED");
      await editing.press("Escape");
      await expect(page.getByLabel(/^New name for/)).toBeHidden();
      await page.reload();
      await expect(
        page.getByRole("button", { name: new RegExp(`^Rename ${target}`) }),
      ).toBeVisible({ timeout: 30_000 });

      // ── A blank name cannot be saved ───────────────────────────────────
      await page
        .getByRole("button", { name: new RegExp(`^Rename ${target}`) })
        .click();
      const blank = page.getByLabel(/^New name for/);
      await blank.fill("   ");
      await expect(
        page.getByRole("button", { name: /^Save new name for/ }),
      ).toHaveAttribute("aria-disabled", "true");
      await blank.press("Escape");
    } finally {
      // Cleanup runs even on failure — this may be a shared live database.
      await removeAllPasskeys(page).catch(() => {
        /* best-effort */
      });
      await auth.cleanup();
    }
  });
});

/**
 * NOT covered here on purpose: the duplicate-name warning. It needs TWO
 * credentials on one account, and a virtual authenticator intermittently
 * refuses the second enrollment via `excludeCredentials` (see
 * helpers/virtual-authenticator.ts). A test that flakes on infrastructure
 * rather than on the behaviour under test is worse than no test. The collision
 * guard is covered deterministically by the PasskeysSection unit tests.
 */
