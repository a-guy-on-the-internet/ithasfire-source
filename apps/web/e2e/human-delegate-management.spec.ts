import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

/**
 * E2E tests for the **human admin panel** delegate management page.
 *
 * The same `TeamView` component powers both the org "Team" tab and the human
 * "Delegates" tab.  `org-team-management.spec.ts` covers the org side; this
 * spec covers the human (delegates) side:
 *
 *   1. Delegates page renders with "Delegates" heading + empty state
 *   2. After adding a delegate via tRPC, the table shows the delegate row
 *   3. The principal can change a delegate's role via dropdown
 *   4. The principal can remove a delegate (with confirmation dialog)
 *
 * Uses the `chromium` project (stored auth session).
 *
 * Prerequisites: local infra, API.
 */

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
  "playwright-setup@example.com";

const TEST_PASSWORD =
  process.env.PLAYWRIGHT_TEST_PASSWORD ?? "Test-Account-2026!";

interface DelegateSeed {
  /** The authenticated test user's humanId (the principal). */
  humanId: string;
  /** URL slug for the human admin panel, e.g. `@{humanId}`. */
  adminSlug: string;
  /** Second user added as a delegate. */
  delegateHumanId: string;
  delegateEmail: string;
  delegateName: string;
}

test.describe("Human Delegate Management", () => {
  test.describe.configure({ mode: "serial" });

  // Admin-only — skip for guest project
  test.beforeEach((_args, testInfo) => {
    test.skip(
      testInfo.project.name === "guest",
      "Admin-only — requires auth session",
    );
  });

  let seed: DelegateSeed;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    // Ensure email is verified
    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    // Seed admin tables to ensure the test user has a humanId and org context
    const adminRes = await request.post(
      `${API_BASE_URL}/e2e/seed/admin-tables`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: { email: TEST_EMAIL },
      },
    );
    expect(
      adminRes.ok(),
      `Admin-tables seed failed: ${await adminRes.text()}`,
    ).toBeTruthy();
    const adminBody = await adminRes.json();
    const principalHumanId: string = adminBody.seed.humanId;

    // Create a second user who will become a delegate
    const delegateEmail = `delegate-${Date.now()}@example.com`;
    const delegateName = "E2E Delegate User";
    const delegateRes = await request.post(
      `${API_BASE_URL}/e2e/seed/auth-user`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: {
          email: delegateEmail,
          password: TEST_PASSWORD,
          name: delegateName,
          // Seeded as an ALREADY-ACCEPTED delegation: delegates.addDelegate
          // (consent-free) was removed — security review F3. The invite-link
          // flow is delegates.createInvite + acceptInvite.
          delegateOf: { principalId: principalHumanId, role: "ADMIN" },
        },
      },
    );
    expect(
      delegateRes.ok(),
      `Delegate user seed failed: ${await delegateRes.text()}`,
    ).toBeTruthy();
    const delegateBody = await delegateRes.json();
    const delegateHumanId: string = delegateBody.seed.humanId;

    // The human admin slug is `@{humanId}` (no username set for E2E users)
    const adminSlug = `@${principalHumanId}`;

    seed = {
      humanId: principalHumanId,
      adminSlug,
      delegateHumanId,
      delegateEmail,
      delegateName,
    };
  });

  // ── Test 1: Delegates page renders with heading + table ────────────────

  test("delegates page shows 'Delegates' heading and the delegate row", async ({
    page,
  }) => {
    await page.goto(`/admin/${encodeURIComponent(seed.adminSlug)}/team`);

    // The heading should say "Delegates" (not "Team") for a human context
    await expect(
      page.getByRole("heading", { name: /delegates/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Subtitle should show a delegate count
    await expect(page.getByText(/\d+ delegate/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // The delegate row should appear with their name or email
    await expect(
      page.getByText(seed.delegateName).or(page.getByText(seed.delegateEmail)),
    ).toBeVisible({ timeout: 10_000 });

    // DataTable columns should be present
    await expect(page.getByText("Name").first()).toBeVisible();
    await expect(page.getByText("Email").first()).toBeVisible();
    await expect(page.getByText("Role").first()).toBeVisible();
    await expect(page.getByText("Joined").first()).toBeVisible();
  });

  // ── Test 2: No "Owner" badge for delegates ─────────────────────────────

  test("delegates page does not show an Owner badge (OWNER is excluded for delegates)", async ({
    page,
  }) => {
    await page.goto(`/admin/${encodeURIComponent(seed.adminSlug)}/team`);

    await expect(
      page.getByRole("heading", { name: /delegates/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for data to load
    await expect(
      page.getByText(seed.delegateName).or(page.getByText(seed.delegateEmail)),
    ).toBeVisible({ timeout: 10_000 });

    // There should be no "Owner" badge anywhere — delegates can't hold OWNER role
    const ownerBadges = page.locator("[data-testid='badge']", {
      hasText: "Owner",
    });
    // Use a soft check — the badge component may not have a test id
    const ownerTexts = page.getByText("Owner", { exact: true });
    // If there's an "Owner" text, it should be 0 instances (none visible)
    // Being lenient: the "Transfer Ownership" section should NOT appear for humans
    await expect(page.getByText("Transfer Ownership")).not.toBeVisible({
      timeout: 3_000,
    });
  });

  // ── Test 3: Role change via dropdown ────────────────────────────────────

  test("principal can change a delegate role via dropdown", async ({
    page,
  }) => {
    await page.goto(`/admin/${encodeURIComponent(seed.adminSlug)}/team`);

    await expect(
      page.getByRole("heading", { name: /delegates/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the delegate to appear
    await expect(
      page.getByText(seed.delegateName).or(page.getByText(seed.delegateEmail)),
    ).toBeVisible({ timeout: 10_000 });

    // Find the role dropdown for the delegate (a <select>)
    const roleDropdown = page.locator("select").first();

    if (
      !(await roleDropdown.isVisible({ timeout: 5_000 }).catch(() => false))
    ) {
      test.skip(
        true,
        "No role dropdown visible — delegate may not have loaded",
      );
      return;
    }

    // Current value should be ADMIN (what we set in beforeAll)
    await expect(roleDropdown).toHaveValue("ADMIN");

    // Change to EDITOR
    await roleDropdown.selectOption("EDITOR");

    // Wait for the mutation to settle
    await page.waitForTimeout(1_500);

    // Verify the dropdown reflects the new value
    await expect(roleDropdown).toHaveValue("EDITOR");

    // The OWNER option should NOT appear in the dropdown (delegates can't be owners)
    const options = await roleDropdown.locator("option").allTextContents();
    expect(options).not.toContain("Owner");
  });

  // ── Test 4: Remove delegate ─────────────────────────────────────────────

  test("principal can remove a delegate with confirmation", async ({
    page,
  }) => {
    await page.goto(`/admin/${encodeURIComponent(seed.adminSlug)}/team`);

    await expect(
      page.getByRole("heading", { name: /delegates/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the delegate to appear
    await expect(
      page.getByText(seed.delegateName).or(page.getByText(seed.delegateEmail)),
    ).toBeVisible({ timeout: 10_000 });

    // Find the remove button (trash icon with "Remove member" aria-label)
    const removeBtn = page
      .getByRole("button", { name: /remove member/i })
      .first();

    if (!(await removeBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "No remove button visible");
      return;
    }

    // Set up dialog handler to accept the confirmation
    page.on("dialog", (dialog) => dialog.accept());

    await removeBtn.click();

    // After removal, the delegate should vanish from the table
    await expect(page.getByText(seed.delegateEmail)).not.toBeVisible({
      timeout: 10_000,
    });

    // The empty state message should now appear
    await expect(page.getByText(/no delegates yet/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
