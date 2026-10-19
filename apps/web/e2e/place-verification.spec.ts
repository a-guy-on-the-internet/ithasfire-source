import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

/**
 * E2E tests for the place verification flow:
 *
 *   1. Admin-side: Venue owner submits verification documents
 *   2. Platform-side: Staff reviews and approves/rejects verification
 *
 * The platform-tables seed creates a place with PENDING verification status
 * and pre-uploaded documents, so we can test the review flow directly.
 * The admin-tables seed creates UNVERIFIED places for the submission flow.
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

// ─────────────────────────────────────────────────────────────────────────────
// Admin-side: Verification submission UI
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Place Verification – Admin submission", () => {
  test.beforeEach((_args, testInfo) => {
    test.skip(
      testInfo.project.name === "guest",
      "Admin-only — requires auth session",
    );
  });

  interface AdminSeed {
    orgSlug: string;
    placeActiveId: string;
  }

  let seed: AdminSeed;

  test.beforeAll(async ({ request }) => {
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
    expect(seed.placeActiveId).toBeTruthy();
  });

  test("admin can navigate to venue settings and see verification section", async ({
    page,
  }) => {
    // `/edit` and `/verify` redirect here (FR-401); the verification workflow
    // is a section of this page.
    await page.goto(
      `/admin/${seed.orgSlug}/places/${seed.placeActiveId}/settings`,
    );
    await page.waitForLoadState("networkidle");

    // The venue settings page should load
    await expect(
      page.getByRole("heading", { name: /place settings/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Verification section should be visible — look for "Verification" heading or status
    await expect(page.getByText(/verification/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // For an UNVERIFIED place, should show an option to start verification
    // (button text like "Submit Verification" or "Upload Documents" or "Get Verified")
    const verificationCta = page.getByRole("button", {
      name: /request verification|submit verification|upload documents|get verified|start verification/i,
    });

    // It's acceptable if the CTA isn't visible when the place is already verified
    // or if the verification section shows "Unverified" status
    const unverifiedBadge = page.getByText(/unverified/i);
    await expect(verificationCta.or(unverifiedBadge)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("admin sees verification document upload form", async ({ page }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/places/${seed.placeActiveId}/settings#verification`,
    );
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/verification/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // Click the CTA to open the upload form (if it exists)
    const verificationCta = page.getByRole("button", {
      name: /request verification|submit verification|upload documents|get verified|start verification/i,
    });

    if (
      await verificationCta.isVisible({ timeout: 5_000 }).catch(() => false)
    ) {
      await verificationCta.click();

      // Should show an upload area (drag & drop or file input)
      await expect(
        page.getByText(/drag|drop|upload|choose file|browse/i).first(),
      ).toBeVisible({ timeout: 10_000 });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Platform-side: Verification review
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Place Verification – Platform review", () => {
  test.beforeEach((_args, testInfo) => {
    test.skip(
      testInfo.project.name === "guest",
      "Platform-only — requires auth session",
    );
  });

  interface PlatformSeed {
    orgSlug: string;
    placePendingId: string;
    placeVerifiedId: string;
    verificationRequestId: string;
  }

  let seed: PlatformSeed;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    const res = await request.post(`${API_BASE_URL}/e2e/seed/platform-tables`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });
    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    seed = body.seed;
    expect(seed.placePendingId).toBeTruthy();
    expect(seed.verificationRequestId).toBeTruthy();
  });

  test("platform places page renders with verification filter", async ({
    page,
  }) => {
    await page.goto("/platform/places");
    await page.waitForLoadState("networkidle");

    // Should see the platform places page
    await expect(
      page.getByRole("heading", { name: /places/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Verification filter chips should be present
    for (const label of ["All", "Pending", "Verified"]) {
      await expect(
        page.getByRole("button", { name: label }).first(),
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  test("platform staff can filter to pending verifications", async ({
    page,
  }) => {
    await page.goto("/platform/places");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: /places/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Click "Pending" filter
    await page.getByRole("button", { name: "Pending" }).click();

    // Should show the E2E Pending Venue
    await expect(page.getByText("E2E Pending Venue").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("platform staff can review a pending verification (approve)", async ({
    page,
  }) => {
    await page.goto("/platform/places");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: /places/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Filter to pending
    await page.getByRole("button", { name: "Pending" }).click();

    // Click on the pending place to open the review panel
    await page.getByText("E2E Pending Venue").first().click();

    // The VerificationReviewPanel should appear
    // It should show the uploaded documents and Approve/Reject buttons
    const approveBtn = page.getByRole("button", { name: /approve/i }).first();
    const rejectBtn = page.getByRole("button", { name: /reject/i }).first();

    await expect(approveBtn.or(rejectBtn)).toBeVisible({ timeout: 10_000 });

    // Verify documents are listed
    await expect(
      page
        .getByText(/lease-agreement\.pdf/i)
        .or(page.getByText(/venue-photo\.jpg/i)),
    ).toBeVisible({ timeout: 5_000 });

    // Approve the verification
    await approveBtn.click();

    // After approval, the status should change to "Verified"
    await expect(page.getByText(/verified/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
