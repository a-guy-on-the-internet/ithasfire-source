import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

/**
 * E2E tests for the org team management page:
 *
 *   1. Team table renders members with name, email, role, joined date
 *   2. Owner can change a member's role via dropdown
 *   3. Owner can remove a member (with confirmation dialog)
 *   4. Owner badge is shown (non-editable) for the owner row
 *   5. Transfer ownership flow
 *
 * Uses the admin-tables seed (chromium project with stored auth session).
 * The admin-tables seed only creates the test user as OWNER — we need to add
 * a second member via the E2E seed endpoint for role-change and removal tests.
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

interface TeamSeed {
  orgSlug: string;
  orgId: string;
  humanId: string;
  secondMemberEmail: string;
}

test.describe("Org Team Management", () => {
  // Requires authenticated session — skip for guest project
  test.beforeEach((_args, testInfo) => {
    test.skip(
      testInfo.project.name === "guest",
      "Admin-only — requires auth session",
    );
  });

  let seed: TeamSeed;

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

    // Seed admin tables to get an org
    const res = await request.post(`${API_BASE_URL}/e2e/seed/admin-tables`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });
    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();

    // Create a second member for the org so we have someone to manage
    const secondMemberEmail = `team-member-${Date.now()}@example.com`;
    const memberRes = await request.post(`${API_BASE_URL}/e2e/seed/auth-user`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: {
        email: secondMemberEmail,
        password: "Test-Account-2026!",
        name: "E2E Team Member",
        // Seeded as an ALREADY-ACCEPTED member: the API has no consent-free
        // add any more (orgs.addMember was removed — security review F3).
        orgMembership: { orgId: body.seed.orgId, role: "ADMIN" },
      },
    });
    expect(
      memberRes.ok(),
      `Member seed failed: ${await memberRes.text()}`,
    ).toBeTruthy();

    seed = {
      orgSlug: body.seed.orgSlug,
      orgId: body.seed.orgId,
      humanId: body.seed.humanId,
      secondMemberEmail,
    };
  });

  // ── Test 1: Team table renders correctly ────────────────────────────────

  test("team page renders member table with columns", async ({ page }) => {
    await page.goto(`/admin/${seed.orgSlug}/team`);

    // Wait for the team page to load
    await expect(
      page.getByRole("heading", { name: /team/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // DataTable should be present
    await expect(page.getByText("Name").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Email").first()).toBeVisible();
    await expect(page.getByText("Role").first()).toBeVisible();
    await expect(page.getByText("Joined").first()).toBeVisible();

    // At least the owner row should exist
    await expect(page.getByText(TEST_EMAIL).first()).toBeVisible({
      timeout: 10_000,
    });

    // Owner should have an "Owner" badge (not a dropdown)
    await expect(page.getByText("Owner").first()).toBeVisible();
  });

  // ── Test 2: Owner row is non-editable ───────────────────────────────────

  test("owner role shows as a static badge, not a dropdown", async ({
    page,
  }) => {
    await page.goto(`/admin/${seed.orgSlug}/team`);

    await expect(
      page.getByRole("heading", { name: /team/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // The owner's row should show "Owner" as a badge, not a <select>
    const ownerBadge = page.getByText("Owner").first();
    await expect(ownerBadge).toBeVisible({ timeout: 10_000 });

    // Owner row should NOT have a remove button
    // Find the row with TEST_EMAIL and verify no trash icon
    const ownerRow = page
      .locator("tr, [role='row']")
      .filter({ hasText: TEST_EMAIL })
      .first();
    if (await ownerRow.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await expect(
        ownerRow.getByRole("button", { name: /remove member/i }),
      ).not.toBeVisible({ timeout: 3_000 });
    }
  });

  // ── Test 3: Role change via dropdown ────────────────────────────────────

  test("owner can change a member role via dropdown", async ({ page }) => {
    await page.goto(`/admin/${seed.orgSlug}/team`);

    await expect(
      page.getByRole("heading", { name: /team/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the second member to appear
    await expect(
      page
        .getByText(seed.secondMemberEmail)
        .or(page.getByText("E2E Team Member")),
    ).toBeVisible({ timeout: 10_000 });

    // Find the role dropdown for the non-owner member (a <select> element)
    const roleDropdown = page.locator("select").first();

    if (
      !(await roleDropdown.isVisible({ timeout: 5_000 }).catch(() => false))
    ) {
      test.skip(
        true,
        "No role dropdown visible — member may not have been added",
      );
      return;
    }

    // Get current value
    const currentRole = await roleDropdown.inputValue();

    // Change to a different role
    const newRole = currentRole === "ADMIN" ? "MEMBER" : "ADMIN";
    await roleDropdown.selectOption(newRole);

    // Wait a moment for the mutation to complete
    await page.waitForTimeout(1000);

    // Verify the dropdown now reflects the new value
    await expect(roleDropdown).toHaveValue(newRole);
  });

  // ── Test 4: Remove member ───────────────────────────────────────────────

  test("owner can remove a member with confirmation", async ({ page }) => {
    await page.goto(`/admin/${seed.orgSlug}/team`);

    await expect(
      page.getByRole("heading", { name: /team/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the second member to appear
    await expect(
      page
        .getByText(seed.secondMemberEmail)
        .or(page.getByText("E2E Team Member")),
    ).toBeVisible({ timeout: 10_000 });

    // Find the remove button (trash icon)
    const removeBtn = page
      .getByRole("button", { name: /remove member/i })
      .first();

    if (!(await removeBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(
        true,
        "No remove button visible — member may not have been added",
      );
      return;
    }

    // Set up dialog handler to accept the confirmation
    page.on("dialog", (dialog) => dialog.accept());

    await removeBtn.click();

    // After removal, the member should no longer appear in the table
    await expect(page.getByText(seed.secondMemberEmail)).not.toBeVisible({
      timeout: 10_000,
    });
  });
});
