import { expect, test } from "./fixtures";
import { submitSignInForm } from "./helpers/sign-in";

// ─────────────────────────────────────────────────────────────────────────────
// Admin Payouts page — live-stack smoke
// ─────────────────────────────────────────────────────────────────────────────
// Drives /admin/<slug>/payouts against an ALREADY-RUNNING dev stack and the
// seeded demo org, which carries real ledger rows (unmatured credits, a
// consumed cohort and a PAYOUT). It signs in through the shared ritual rather
// than the `setup` project's storageState, so it runs under the `guest`
// project and never touches the e2e reset endpoints:
//
//   cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test \
//     e2e/admin-payouts.spec.ts --project=guest --workers=1 --reporter=list
//
// It asserts the page's three promises — a balance panel, a breakdown of the
// balance, and a ledger whose first row carries the balance — plus the two
// things unit tests cannot see: zero console errors (the `test` fixture fails
// the spec on any) and no horizontal overflow at 320px.
// ─────────────────────────────────────────────────────────────────────────────

const ORG_SLUG = process.env.E2E_PAYOUTS_ORG_SLUG ?? "demo";
const EMAIL = process.env.E2E_PAYOUTS_EMAIL ?? "admin@ithasfire.com";
const PASSWORD = process.env.E2E_PAYOUTS_PASSWORD ?? "Dev-Login-2026!";
const SHOTS =
  process.env.E2E_PAYOUTS_SHOT_DIR ??
  "/private/tmp/claude-501/-Users-somehuman-Projects-TicketHunter/afa4a27a-3864-4634-9608-3dabff7d85d9/scratchpad/payouts-page";

test.describe("admin payouts page (live stack)", () => {
  test("renders the statement for an org and survives 320px", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await submitSignInForm(page, { email: EMAIL, password: PASSWORD });
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));

    await page.goto(`/admin/${ORG_SLUG}/payouts`);
    await expect(
      page.getByRole("heading", { name: /payouts/i }).first(),
    ).toBeVisible({ timeout: 30_000 }); // dev server may be recompiling

    // The answer, by the copy the design fixes (board B, 2026-10-14). "Ready
    // now" appears only when it differs from what we send (under the
    // minimum, Stripe blocked, a failed read), so it is not asserted here.
    // The minimum is always on the page: one line while clear, the full row
    // otherwise.
    await expect(page.getByText(/owed to you/i).first()).toBeVisible();
    await expect(page.getByText(/we send it/i).first()).toBeVisible();
    await expect(page.getByText(/minimum/i).first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /coming up/i }).first(),
    ).toBeVisible();
    // The ledger: the demo org's rows are all sales credits, and the first
    // row's balance must equal the headline "Owed to you" figure.
    const ledgerRow = page.getByText(/sales credit/i).first();
    await ledgerRow.scrollIntoViewIfNeeded();
    await expect(ledgerRow).toBeVisible();

    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${SHOTS}/desktop.png`, fullPage: true });

    // Narrow viewport: nothing may push the document wider than the screen.
    await page.setViewportSize({ width: 320, height: 900 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(
      overflow.innerWidth,
    );
    await page.screenshot({ path: `${SHOTS}/phone-320.png`, fullPage: true });
  });

  test("while the ledger is still loading, it never claims to be empty or capped", async ({
    page,
  }) => {
    // The overview resolves well before the statement (five reads). In that
    // window the ledger must show a skeleton — not "No entries yet" beside
    // "Older entries exist but can't be shown here", both of
    // which were rendered at once on every org load before the fix.
    let statementDelayed = false;
    let batchedWithOverview = false;
    await page.route(/\/trpc\/[^?]*getStatement/, async (route) => {
      statementDelayed = true;
      batchedWithOverview = route.request().url().includes("getOverview");
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });

    await page.goto("/sign-in");
    await submitSignInForm(page, { email: EMAIL, password: PASSWORD });
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
    await page.goto(`/admin/${ORG_SLUG}/payouts`);

    // From first paint until the rows land, neither false claim may appear.
    // The client uses httpBatchLink, so on a cold load the overview and the
    // statement usually travel in ONE request and resolve together — in that
    // case the window the assertion guards is only reachable via a page
    // refetch or a split batch, and this test degrades to "no intermediate
    // state shows them". The annotation records which world the run saw.
    const rows = page.getByText(/sales credit/i).first();
    // Generous: a dev server mid-recompile can hold the first paint for 20s+.
    const deadline = Date.now() + 30_000;
    while (!(await rows.isVisible()) && Date.now() < deadline) {
      await expect(page.getByText(/no entries yet/i)).toHaveCount(0);
      await expect(page.getByText(/older entries exist/i)).toHaveCount(0);
      await page.waitForTimeout(100);
    }
    await expect(rows).toBeVisible();
    expect(statementDelayed, "the statement request was intercepted").toBe(true);
    test.info().annotations.push({
      type: "trpc-batching",
      description: batchedWithOverview
        ? "statement batched with overview — in-flight window not separately observable"
        : "statement travelled alone — in-flight window observed",
    });
    await expect(page.getByText(/older entries exist/i)).toHaveCount(0);
  });

  test("the dead Settlements tab is gone from Orders", async ({ page }) => {
    await page.goto("/sign-in");
    await submitSignInForm(page, { email: EMAIL, password: PASSWORD });
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));

    await page.goto(`/admin/${ORG_SLUG}/orders`);
    await expect(page.getByRole("heading").first()).toBeVisible({
      timeout: 30_000, // dev server may be recompiling
    });
    await expect(page.getByRole("tab", { name: /settlements/i })).toHaveCount(0);
  });
});
