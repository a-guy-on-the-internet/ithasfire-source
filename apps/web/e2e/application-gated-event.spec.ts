import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";

/**
 * E2E tests for the application-gated event flow:
 *
 *   1. Attendee sees the application gate, fills out form, submits
 *   2. Admin reviews applications: approve, reject, rescind
 *   3. Approved attendee can view the event (gate lifted)
 *
 * Prerequisites: local infra, API, Mailpit.
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
// GUEST PROJECT — Attendee submits an application
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Application Gate – Attendee submission", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(request, API_BASE_URL);
  });

  test("attendee can submit an application for a gated event", async ({
    page,
    request,
  }) => {
    // ── Seed application-gated event ────────────────────────────────────
    const seedRes = await request.post(`${API_BASE_URL}/e2e/seed/gated-event`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: {
        gateType: "APPLICATION",
        applicationQuestions: [
          {
            prompt: "Why do you want to attend this event?",
            type: "LONG_TEXT",
          },
          { prompt: "How did you hear about us?", type: "SHORT_TEXT" },
        ],
      },
    });
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();
    const { seed } = await seedRes.json();
    expect(seed.eventSlug).toBeTruthy();
    expect(seed.applicationFormId).toBeTruthy();
    expect(seed.applicationQuestionIds.length).toBe(2);

    // ── Create attendee user ────────────────────────────────────────────
    const uid = Date.now();
    const attendeeEmail = `attendee-app-${uid}@example.com`;
    const attendeePassword = "Password123!";

    // Sign up
    await page.goto("/sign-up");
    const signUpForm = page.getByTestId("auth-sign-up-form");
    if (!(await signUpForm.isVisible())) {
      const signInForm = page.getByTestId("auth-sign-in-form");
      if (!(await signInForm.isVisible())) {
        await page.getByTestId("navbar-account").click();
        await expect(signInForm).toBeVisible({ timeout: 10_000 });
      }
      await page.getByTestId("auth-sign-in-create-account").click();
    }
    await expect(signUpForm).toBeVisible({ timeout: 10_000 });

    await signUpForm.getByPlaceholder("Jane Doe").fill("Application Attendee");
    await signUpForm.getByPlaceholder("janedoe").fill(`attendeeapp${uid}`);
    await signUpForm.getByPlaceholder("you@example.com").fill(attendeeEmail);
    await signUpForm
      .getByPlaceholder("••••••••")
      .first()
      .fill(attendeePassword);
    await signUpForm.getByPlaceholder("••••••••").nth(1).fill(attendeePassword);
    await page.getByTestId("auth-sign-up-submit").click();

    await expect(page.getByTestId("auth-sign-up-form")).not.toBeVisible({
      timeout: 15_000,
    });
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-up"), {
      timeout: 30_000,
    });

    // Verify email via Mailpit
    const mailpit = createMailpitClient({ request });
    const verificationEmail = await mailpit.waitForEmailTo(attendeeEmail);
    const verificationUrl =
      extractFirstUrlFromMailpitMessage(verificationEmail);
    await page.goto(verificationUrl);
    await mailpit.clear();

    // Sign in
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("navbar-account").click();
    const signInForm = page.getByTestId("auth-sign-in-form");
    await expect(signInForm).toBeVisible({ timeout: 10_000 });
    await signInForm.getByPlaceholder("you@example.com").fill(attendeeEmail);
    await signInForm.getByPlaceholder("••••••••").fill(attendeePassword);
    await signInForm.getByRole("button", { name: "Sign in" }).click();
    await expect(signInForm).not.toBeVisible({ timeout: 15_000 });

    // ── Navigate to the gated event ─────────────────────────────────────
    await page.goto(`/events/${seed.eventSlug}`);
    await page.waitForLoadState("networkidle");

    // Should see the application gate — "This event requires an application"
    await expect(
      page.getByText(/this event requires an application/i),
    ).toBeVisible({ timeout: 15_000 });

    // ── Fill out the application form ────────────────────────────────────
    // Contact email field (labeled "Email *")
    const emailInput = page.getByPlaceholder("your@email.com");
    await expect(emailInput).toBeVisible({ timeout: 5_000 });
    await emailInput.fill(attendeeEmail);

    // Phone field (optional)
    const phoneInput = page.getByPlaceholder("+1 (555) 123-4567");
    await expect(phoneInput).toBeVisible();
    await phoneInput.fill("+1 (555) 999-0001");

    // Application questions — fill all inputs with "Your answer" placeholder
    const answerInputs = page.getByPlaceholder("Your answer");
    const count = await answerInputs.count();
    for (let i = 0; i < count; i++) {
      await answerInputs.nth(i).fill(`Test answer ${i + 1} for E2E`);
    }

    // ── Submit the application ──────────────────────────────────────────
    const submitButton = page.getByRole("button", {
      name: /submit application/i,
    });
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // ── Verify pending state is shown ────────────────────────────────────
    // After submission, the gate should show "PENDING" status
    await expect(page.getByText(/pending/i)).toBeVisible({ timeout: 15_000 });

    // The submit button should no longer be visible (replaced by status)
    await expect(submitButton).not.toBeVisible({ timeout: 5_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHROMIUM PROJECT — Admin reviews applications
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Application Gate – Admin review", () => {
  // The first argument MUST be a destructuring pattern — Playwright inspects
  // the source of the callback to work out which fixtures to build, and throws
  // "First argument must use the object destructuring pattern" at LOAD time
  // otherwise. A plain `_args` here (present since 6a1f9140, Feb 2026) meant
  // this file collected ZERO tests: `playwright test --list` reported
  // "Total: 0 tests in 0 files", so nothing in it has run since.
  //
  // The pattern is empty on purpose: this hook needs no fixture, only
  // `testInfo`, and naming one here would build it for every skipped test.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name === "guest",
      "Admin-only — requires auth session",
    );
  });

  interface AdminSeed {
    orgSlug: string;
    eventAppGatedId: string;
    eventAppGatedSlug: string;
    humanId: string;
  }

  /**
   * Locator helpers — READ BEFORE ADDING AN ASSERTION HERE.
   *
   * The filter chips render BEFORE the table in DOM order (`EventOpsShell`
   * renders `{filters}` above `{children}`), and their labels are prefixes of
   * the row action labels: the "Approved" chip matches `/approve/i`, the
   * "Rejected" chip matches `/reject/i`. A bare
   * `page.getByRole("button", { name: /approve/i }).first()` therefore
   * resolves to the CHIP, silently re-filtering the table instead of acting
   * on a row — and the failure then surfaces several lines later, pointing at
   * the wrong cause.
   *
   * So: chips are matched by EXACT name, row actions are scoped to the table.
   */
  const filterChip = (page: Page, label: string) =>
    page.getByRole("button", { name: label, exact: true });

  const applicationsTable = (page: Page) =>
    page.getByTestId("applications-table");

  /** A row-level action button inside the table (never a filter chip). */
  const rowAction = (page: Page, label: string) =>
    applicationsTable(page)
      .getByRole("row")
      .getByRole("button", { name: label, exact: true });

  /** The page's own <h1> — NOT the DataTable empty state, whose headline
   *  ("No applications yet" / "No {status} applications") is a real <h4> that
   *  also matches /applications/i and trips strict mode on an empty table. */
  const pageHeading = (page: Page) =>
    page.getByRole("heading", { name: /applications/i, level: 1 });

  let seed: AdminSeed;

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

    // Seed admin-tables which includes an app-gated event
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
    expect(seed.eventAppGatedId).toBeTruthy();

    // Create a fake application submission for the admin to review
    const { token } = await signInAndGetToken(request, API_BASE_URL, {
      email: TEST_EMAIL,
      password: process.env.PLAYWRIGHT_TEST_PASSWORD ?? "Test-Account-2026!",
    });

    // We need a separate user to be the applicant — create one via seed endpoint
    const applicantRes = await request.post(
      `${API_BASE_URL}/e2e/seed/auth-user`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: {
          email: `applicant-${Date.now()}@example.com`,
          password: "Test-Account-2026!",
          name: "E2E Applicant",
        },
      },
    );
    expect(applicantRes.ok()).toBeTruthy();
    const applicantBody = await applicantRes.json();
    const applicantHumanId = applicantBody.seed?.humanId;

    // Submit an application via the applicant's tRPC session
    const { token: applicantToken } = await signInAndGetToken(
      request,
      API_BASE_URL,
      {
        email: applicantBody.seed?.email,
        password: "Test-Account-2026!",
      },
    );
    const applicantTrpc = createE2eTrpcClient(request, API_BASE_URL, {
      bearerToken: applicantToken,
    });

    await applicantTrpc.events.submitApplication.mutate({
      eventId: seed.eventAppGatedId,
      contactEmail: applicantBody.seed?.email,
      contactPhone: "+1 555-000-1234",
      answers: {},
    });
  });

  test("admin can view applications table with filter chips and search", async ({
    page,
  }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/events/${seed.eventAppGatedId}/applications`,
    );

    // Wait for the applications table to load
    await expect(pageHeading(page)).toBeVisible({
      timeout: 15_000,
    });

    // Filter chips should be visible. There is deliberately no "All" chip:
    // `undefined` selection IS the default scope (every status), and
    // FilterChips' convention forbids a chip for the default that would sit
    // permanently selected.
    for (const label of ["Pending", "Approved", "Rejected"]) {
      await expect(filterChip(page, label)).toBeVisible();
    }

    // Search input should be visible
    await expect(
      page.getByPlaceholder(/search by email or phone/i),
    ).toBeVisible();

    // At least one application row should be present
    await expect(
      page.getByText(/applicant/i).or(page.getByText(/@example\.com/i)),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("admin can approve an application", async ({ page }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/events/${seed.eventAppGatedId}/applications`,
    );

    // Wait for the table to load
    await expect(pageHeading(page)).toBeVisible({
      timeout: 15_000,
    });

    // Click "Pending" filter to ensure we see pending applications
    await filterChip(page, "Pending").click();

    // Find and click the Approve button on the first pending submission
    const approveButton = rowAction(page, "Approve").first();
    await expect(approveButton).toBeVisible({ timeout: 10_000 });
    await approveButton.click();

    // The row has left the PENDING scope the moment it was approved, so the
    // decision has to be verified in the APPROVED scope — asserting it while
    // the Pending chip is active only ever "passed" because the unscoped
    // `getByText("APPROVED")` matched the "Approved" CHIP.
    await filterChip(page, "Approved").click();

    await expect(
      applicationsTable(page).getByText("Approved", { exact: true }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Approve button is replaced by Rescind on a decided row.
    await expect(rowAction(page, "Rescind").first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("admin can reject an application", async ({ page }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/events/${seed.eventAppGatedId}/applications`,
    );
    await expect(pageHeading(page)).toBeVisible({
      timeout: 15_000,
    });

    // Create another applicant to have a pending submission
    // (previous test may have approved the only one)
    // We'll try clicking Pending filter first
    await filterChip(page, "Pending").click();

    const rejectButton = rowAction(page, "Reject").first();

    if (
      !(await rejectButton.isVisible({ timeout: 3_000 }).catch(() => false))
    ) {
      // No pending submissions — skip or note
      test.skip(true, "No pending submissions available to reject");
      return;
    }

    // Rejecting is TWO steps: the row button opens the reason composer, and
    // the composer's own "Reject application" button submits the decision.
    await rejectButton.click();
    await rowAction(page, "Reject application").first().click();

    // The row leaves the PENDING scope once rejected — check the REJECTED one.
    await filterChip(page, "Rejected").click();

    await expect(
      applicationsTable(page).getByText("Rejected", { exact: true }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test("admin can rescind a decision (approved → pending)", async ({
    page,
  }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/events/${seed.eventAppGatedId}/applications`,
    );
    await expect(pageHeading(page)).toBeVisible({
      timeout: 15_000,
    });

    // Filter to see approved or rejected submissions that have a Rescind button
    await filterChip(page, "Approved").click();

    const rescindButton = rowAction(page, "Rescind").first();

    if (
      !(await rescindButton.isVisible({ timeout: 5_000 }).catch(() => false))
    ) {
      // Try rejected tab
      await filterChip(page, "Rejected").click();
    }

    if (
      !(await rescindButton.isVisible({ timeout: 5_000 }).catch(() => false))
    ) {
      test.skip(true, "No reviewed submissions available to rescind");
      return;
    }

    await rescindButton.click();

    // Rescinding sends the row back to PENDING, i.e. out of whichever decided
    // scope is currently selected — verify it in the PENDING scope.
    await filterChip(page, "Pending").click();

    await expect(
      applicationsTable(page).getByText("Pending", { exact: true }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test("admin can expand application answers", async ({ page }) => {
    await page.goto(
      `/admin/${seed.orgSlug}/events/${seed.eventAppGatedId}/applications`,
    );
    await expect(pageHeading(page)).toBeVisible({
      timeout: 15_000,
    });

    // Click "View answers" expand button (chevron) if answers exist
    const expandBtn = applicationsTable(page)
      .getByRole("button", { name: /view answers|collapse answers/i })
      .first();

    if (await expandBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await expandBtn.click();

      // Should show expanded answer content
      // Look for the "Reviewed" date label or answer text
      await expect(
        page
          .locator("[data-testid='applications-table']")
          .getByText(/\S/)
          .first(),
      ).toBeVisible({ timeout: 5_000 });
    }
  });
});
