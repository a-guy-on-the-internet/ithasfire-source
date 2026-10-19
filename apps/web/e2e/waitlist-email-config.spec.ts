import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";

// ─────────────────────────────────────────────────────────────────────────────
// Waitlist Email Configuration E2E — SKIPPED
// ─────────────────────────────────────────────────────────────────────────────
// Exercises the organizer-facing waitlist confirmation email settings inside
// the EventGateSettings panel (edit mode):
//   - Enabling the waitlist reveals the email config section
//   - Email toggle switch, subject input, rich-text body editor
//   - Saving email settings persists across page reload
//   - Disabling the waitlist hides the email section
//
// ── WHY THIS IS SKIPPED (2026-08) ───────────────────────────────────────────
// Three independent reasons, any one of which is fatal:
//
//   1. The `waitlists` feature gate is default-OFF. EventGateSettings now
//      omits the entire Notify-Me section when the gate is off, so
//      `enableWaitlist()`'s `getByTestId("waitlist-option-open")` matches
//      nothing and tests 2–7 fail. Only the join half of waitlists exists
//      (nothing sets NOTIFIED; no release trigger, job or admin roster), so
//      the gate stays off until the notify half ships.
//
//   2. The copy it waits on is stale independently of the gate: it expects
//      "Waitlist message" and the placeholder "Optional message shown on the
//      waitlist signup"; the shipped strings are `gsWaitlistMessage`
//      ("Message to interested fans") and `gsWaitlistOpen` ("Collect
//      sign-ups").
//
//   3. Most importantly, the surface under test DOES NOT EXIST. There is no
//      waitlist-confirmation-email section in EventGateSettings.tsx — no
//      subject input, no body editor, no "Save email" button. Flipping the
//      gate back on would NOT make this spec pass.
//
// Because of (3) this cannot simply be un-skipped when the gate flips. If the
// waitlist notify half ships with an email-config surface, rewrite this spec
// against the real markup rather than restoring it as-is.
//
// Preconditions (for whenever it is rewritten):
//   - Playwright "setup" project has stored a signed-in session.
//   - Local infra is running (postgres + redis).
//   - API is reachable at PLAYWRIGHT_API_BASE_URL.
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

interface Seed {
  humanId: string;
  orgId: string;
  orgSlug: string;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  ticketTypeId: string;
}

// SKIPPED — see the block above: the `waitlists` gate is off AND the
// email-config surface this spec drives does not exist in EventGateSettings.
test.describe.skip("Waitlist Email Configuration", () => {
  // These tests share a single seeded event and modify its state sequentially,
  // so they must run serially in one worker to avoid unique-constraint races.
  test.describe.configure({ mode: "serial" });

  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    // Verify the test user's email so admin gates pass.
    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    const res = await request.post(`${API_BASE_URL}/e2e/seed/event-builder`, {
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
    expect(seed.eventId).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  /** Navigate to the event edit page and wait for the gate settings panel. */
  async function gotoEdit(page: import("@playwright/test").Page) {
    // Ensure cookie consent is set so the banner doesn't block interactions.
    await page
      .context()
      .addCookies([
        { name: "th-consent", value: "all", domain: "localhost", path: "/" },
      ]);
    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
    await expect(page.getByTestId("gate-settings")).toBeVisible();
  }

  /** Enable the waitlist by clicking the "Open" option card. */
  async function enableWaitlist(page: import("@playwright/test").Page) {
    const openCard = page.getByTestId("waitlist-option-open");
    await openCard.click();
    // Wait for the waitlist detail section to appear (description label).
    await expect(page.getByText("Waitlist message")).toBeVisible({
      timeout: 5_000,
    });
  }

  /** Locators — Tamagui strips data-testid on some primitives (Switch, Input),
   *  so we use accessible roles/placeholders instead of getByTestId. */
  const loc = {
    waitlistDescription: (page: import("@playwright/test").Page) =>
      page.getByPlaceholder("Optional message shown on the waitlist signup"),
    emailSubject: (page: import("@playwright/test").Page) =>
      page.getByPlaceholder("You\u2019re on the waitlist!"),
    /** The only <switch> role on this page lives inside the email section. */
    emailToggle: (page: import("@playwright/test").Page) =>
      page.getByRole("switch"),
    emailSaveBtn: (page: import("@playwright/test").Page) =>
      page.getByRole("button", { name: /save email/i }),
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Tests — run serially; each test inherits DB state from the previous.
  // State flow: DISABLED → OPEN → emailEnabled=true → subject saved →
  //             DISABLED → OPEN → toggle off → toggle on + prose editor
  // ═══════════════════════════════════════════════════════════════════════

  test("1 — email config section is hidden when waitlist is disabled", async ({
    page,
    consoleErrors,
  }) => {
    // Known admin page noise: notification subscription + Tamagui hydration.
    consoleErrors.ignore();
    await gotoEdit(page);

    // Waitlist defaults to DISABLED — email toggle must not be visible.
    await expect(loc.emailToggle(page)).not.toBeVisible();
  });

  test("2 — enabling waitlist reveals the email config section", async ({
    page,
    consoleErrors,
  }) => {
    // DB state: waitlist=DISABLED
    consoleErrors.ignore();
    await gotoEdit(page);
    await enableWaitlist(page);

    // The email toggle switch should now be visible.
    await expect(loc.emailToggle(page)).toBeVisible();
    // Subject should NOT be visible yet (emailEnabled is still false).
    await expect(loc.emailSubject(page)).not.toBeVisible();
  });

  test("3 — email toggle enables subject and body fields", async ({
    page,
    consoleErrors,
  }) => {
    // DB state: waitlist=OPEN, emailEnabled=false
    consoleErrors.ignore();
    await gotoEdit(page);
    // Waitlist already OPEN from test 2 — just wait for the section.
    await expect(page.getByText("Waitlist message")).toBeVisible({
      timeout: 5_000,
    });

    // Subject/body hidden because emailEnabled is still false.
    await expect(loc.emailSubject(page)).not.toBeVisible();

    // Click the toggle switch to enable email.
    await loc.emailToggle(page).click();

    // Subject input and save button should now appear.
    await expect(loc.emailSubject(page)).toBeVisible({ timeout: 5_000 });
    await expect(loc.emailSaveBtn(page)).toBeVisible();
    // DB state after: waitlist=OPEN, emailEnabled=true (persisted by toggle handler)
  });

  test("4 — fill subject, save, and verify persistence on reload", async ({
    page,
    consoleErrors,
  }) => {
    // DB state: waitlist=OPEN, emailEnabled=true
    consoleErrors.ignore();
    await gotoEdit(page);
    // Waitlist is OPEN and emailEnabled is true — subject should be visible already.
    await expect(loc.emailSubject(page)).toBeVisible({ timeout: 5_000 });

    // Fill in a custom subject line.
    await loc.emailSubject(page).fill("You're on the list!");

    // Save.
    await loc.emailSaveBtn(page).click();

    // Wait for save to complete (button text reverts to enabled state).
    await expect(loc.emailSaveBtn(page)).toBeEnabled({ timeout: 5_000 });

    // Reload the page and verify the value persisted.
    await page.reload();
    await expect(page.getByTestId("gate-settings")).toBeVisible();

    // The waitlist should still be OPEN, email toggle ON, subject filled.
    await expect(loc.emailSubject(page)).toBeVisible({ timeout: 5_000 });
    await expect(loc.emailSubject(page)).toHaveValue("You're on the list!");
    // DB state after: waitlist=OPEN, emailEnabled=true, emailSubject="You're on the list!"
  });

  test("5 — disabling waitlist hides the email config section", async ({
    page,
    consoleErrors,
  }) => {
    // DB state: waitlist=OPEN, emailEnabled=true, emailSubject set
    consoleErrors.ignore();
    await gotoEdit(page);
    await expect(loc.emailToggle(page)).toBeVisible();

    // Switch waitlist to DISABLED.
    await page.getByTestId("waitlist-option-disabled").click();

    // Email config should disappear.
    await expect(loc.emailToggle(page)).not.toBeVisible();
    // DB state after: waitlist=DISABLED
  });

  test("6 — toggling email off hides subject and body but keeps toggle visible", async ({
    page,
    consoleErrors,
  }) => {
    // DB state: waitlist=DISABLED (but emailEnabled=true is still in DB)
    consoleErrors.ignore();
    await gotoEdit(page);
    // Re-enable waitlist.
    await enableWaitlist(page);

    // emailEnabled is true from the DB, so subject should be visible right away.
    await expect(loc.emailSubject(page)).toBeVisible({ timeout: 5_000 });

    // Turn email OFF via the toggle.
    await loc.emailToggle(page).click();

    // Subject should disappear, but the toggle itself stays visible.
    await expect(loc.emailSubject(page)).not.toBeVisible();
    await expect(loc.emailToggle(page)).toBeVisible();
    // DB state after: waitlist=OPEN, emailEnabled=false
  });

  test("7 — prose editor for email body is rendered when email is enabled", async ({
    page,
    consoleErrors,
  }) => {
    // DB state: waitlist=OPEN, emailEnabled=false
    consoleErrors.ignore();
    await gotoEdit(page);
    await expect(page.getByText("Waitlist message")).toBeVisible({
      timeout: 5_000,
    });

    // Enable email.
    await loc.emailToggle(page).click();
    await expect(loc.emailSubject(page)).toBeVisible({ timeout: 5_000 });

    // The ProseMirror editor for the email body sits inside the "Organizer message" section.
    // There may be other ProseMirror editors on the page (e.g., event description),
    // so we scope within the label text to avoid strict-mode violations.
    const emailBodySection = page.getByText("Organizer message").locator("..");
    const editorContent = emailBodySection.locator(
      ".ProseMirror[contenteditable='true']",
    );
    await expect(editorContent).toBeVisible({ timeout: 5_000 });

    // Type some content into it.
    await editorContent.click();
    await editorContent.type("Thanks for joining the waitlist!");

    // The text should appear in the editor.
    await expect(editorContent).toContainText(
      "Thanks for joining the waitlist!",
    );
  });
});
