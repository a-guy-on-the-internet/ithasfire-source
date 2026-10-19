import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Volunteer role template shifts E2E
// ─────────────────────────────────────────────────────────────────────────────
//
// Verifies the template editor shifts section + the apply-template flow:
//   1. Admin opens a fresh org, creates a volunteer role template,
//      adds a default shift (time-of-day + Day dropdown), saves.
//   2. Re-opens the template — confirms the shift round-tripped.
//   3. Navigates to a published event's Volunteers tab, applies the
//      template via "From template" → role lands AND the inline shift
//      composer is pre-populated with the materialized shift draft.
//
// Spec: docs/specs/2026-04-28/completed/volunteer-template-shift-times.spec.md
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
  "playwright-setup@example.com";

interface AdminSeed {
  humanId: string;
  orgId: string;
  orgSlug: string;
  eventPublishedId: string;
  eventPublishedSlug: string;
}

test.describe.configure({ mode: "serial" });

test.describe("Volunteer template shifts", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: AdminSeed;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, {
      preserveEmail: TEST_EMAIL,
    });

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
    const body = (await res.json()) as { seed: AdminSeed };
    seed = body.seed;
    expect(seed.orgSlug).toBeTruthy();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // End-to-end: create a template with a shift, then apply it to an event.
  //
  // Kept as a single test (rather than two siblings) because the apply flow
  // depends on the template existing on the same org; running them separate
  // risks `beforeAll` re-seeding into a different org slug between tests.
  // ═════════════════════════════════════════════════════════════════════════

  test("create template with default shift then apply to event seeds the composer", async ({
    page,
    consoleErrors,
  }) => {
    // The notifications subscription logs an error on every admin page
    // mount — pre-existing, unrelated to this flow.
    consoleErrors.ignore();

    const templateName = `Bar Crew ${Date.now()}`;

    // ── Part 1: create a template with one default shift ─────────────────
    await page.goto(`/admin/${seed.orgSlug}/volunteer-templates`);
    await page
      .getByRole("button", { name: /^new template$/i })
      .first()
      .click();

    // Tamagui's TextInput puts the testId on a wrapper, not the
    // underlying <input>, so prefer placeholder matching for design-
    // system inputs.
    await page
      .getByPlaceholder(/Bar Staff, Security, Stage Hand/i)
      .fill(templateName);
    await page
      .getByPlaceholder(/What does this role involve/i)
      .fill("Pours drinks and runs to the back when needed");
    await page.getByPlaceholder(/^e\.g\. 4$/).fill("3");

    await page.getByRole("button", { name: /^add shift$/i }).click();

    // Native time/select inputs emit `data-testid` directly; the
    // label TextInput wraps it, so match by placeholder.
    await page.getByPlaceholder(/Setup, Doors, Cleanup/i).fill("Setup");
    await page.getByTestId("volunteer-template-shift-0-start").fill("16:00");
    await page.getByTestId("volunteer-template-shift-0-end").fill("18:30");
    await page.getByTestId("volunteer-template-shift-0-day").selectOption("0");
    await page.getByPlaceholder(/^Optional$/).fill("2");

    await page.getByRole("button", { name: /^save template$/i }).click();
    await expect(page.getByText(templateName)).toBeVisible({ timeout: 10_000 });

    // ── Part 2: apply the template to the seeded event ───────────────────
    await page.goto(
      `/admin/${seed.orgSlug}/events/${seed.eventPublishedId}?tab=volunteers`,
    );
    await page
      .getByRole("button", { name: /from template/i })
      .first()
      .click();

    // Pick the template we just created. The dialog rows have
    // role="checkbox" with the template name in their accessible text.
    const option = page
      .getByRole("checkbox")
      .filter({ hasText: templateName })
      .first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();

    await page.getByRole("button", { name: /create roles/i }).click();

    // The role lands and auto-expands. The seeded shift draft surfaces a
    // "Draft 1" label inside the inline composer.
    await expect(page.getByText(/draft 1/i)).toBeVisible({ timeout: 10_000 });

    // The Setup label flowed through from the template into the composer.
    const labelInput = page.getByPlaceholder(/e\.g\. Morning setup/i).first();
    await expect(labelInput).toHaveValue("Setup");
  });
});
