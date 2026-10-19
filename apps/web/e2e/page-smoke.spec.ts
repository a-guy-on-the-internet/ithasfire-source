import { expect, test, type Page } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import { collectConsoleErrors } from "./helpers/console-errors";

// ─────────────────────────────────────────────────────────────────────────────
// Page Smoke Tests — Console Error Detection
// ─────────────────────────────────────────────────────────────────────────────
// Navigates to every significant page in the app and asserts that zero
// console errors (React hooks violations, runtime exceptions, etc.) appear.
//
// This is the "canary in the coal mine" suite: if an AI or human introduces
// a hooks-order violation, a bad import, or a runtime crash, these tests
// will catch it before anyone has to open DevTools.
//
// Pages are grouped into:
//   1. Public (guest) — no auth required.
//   2. Admin — requires auth + org slug from the admin-tables seed.
//   3. Platform — requires auth + staff/platform seed.
//
// Preconditions:
//   - Playwright "setup" project has stored a signed-in session.
//   - Local infra is running (postgres + redis).
//   - API is reachable at PLAYWRIGHT_API_BASE_URL.
//
// NOTE: The entire file runs serially to prevent the admin reset from
//       racing with the platform seed on a different worker.
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Navigate, wait for network idle, then assert zero console errors. */
async function assertPageHasNoConsoleErrors(
  page: Page,
  path: string,
  /** Optional locator to wait for before checking errors (proves the page rendered). */
  waitForSelector?: string,
) {
  const collector = collectConsoleErrors(page);

  await page.goto(path, { waitUntil: "networkidle" });

  if (waitForSelector) {
    await page
      .locator(waitForSelector)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
  }

  // Give React a beat to finish any post-hydration effects.
  await page.waitForTimeout(1_000);

  const errors = collector.errors();
  collector.detach();

  if (errors.length > 0) {
    // Log all errors for the test report so failures are immediately actionable.
    console.error(
      `Console errors on ${path}:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}`,
    );
  }

  expect(errors, `Expected zero console errors on ${path}`).toHaveLength(0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PUBLIC / GUEST PAGES
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Smoke: Public pages (no console errors)", () => {
  test.beforeEach(async ({ context }) => {
    // Dismiss cookie consent so it never overlays content.
    await context.addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
  });

  const publicPages: { name: string; path: string; waitFor?: string }[] = [
    { name: "Home", path: "/" },
    { name: "About", path: "/about", waitFor: "h1" },
    { name: "Terms", path: "/terms", waitFor: "h1" },
    { name: "Privacy", path: "/privacy", waitFor: "h1" },
    { name: "Contact", path: "/contact", waitFor: "h1" },
    { name: "Cookie Policy", path: "/cookie-policy", waitFor: "h1" },
    { name: "Events listing", path: "/events" },
    { name: "Events search", path: "/search" },
    { name: "Lucky", path: "/lucky" },
  ];

  for (const pg of publicPages) {
    test(`${pg.name} (${pg.path})`, async ({ page }) => {
      await assertPageHasNoConsoleErrors(page, pg.path, pg.waitFor);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ADMIN PAGES (authenticated)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Smoke: Admin pages (no console errors)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ context }) => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
    await context.addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
  });

  let orgSlug = "";
  let eventPublishedId = "";
  let eventAppGatedId = "";
  let placeActiveId = "";

  test.beforeAll(async ({ request }, testInfo) => {
    // beforeAll still fires in the guest project even though beforeEach will
    // skip every test. Guard the seed so it doesn't fail on missing auth.
    if (testInfo.project.name === "guest") return;
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    // Verify email so admin gates pass.
    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    // Seed admin data — we only need the orgSlug.
    const res = await request.post(`${API_BASE_URL}/e2e/seed/admin-tables`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    expect(res.ok(), `Admin seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    orgSlug = body.seed.orgSlug;
    eventPublishedId = body.seed.eventPublishedId;
    eventAppGatedId = body.seed.eventAppGatedId;
    placeActiveId = body.seed.placeActiveId;
    expect(orgSlug).toBeTruthy();
    expect(eventPublishedId).toBeTruthy();
    expect(eventAppGatedId).toBeTruthy();
    expect(placeActiveId).toBeTruthy();
  });

  const adminSections = [
    { name: "Dashboard", route: "dashboard" },
    { name: "Events", route: "events" },
    { name: "Places", route: "places" },
    { name: "Orders", route: "orders" },
    { name: "Audiences", route: "audiences" },
    { name: "Payouts", route: "payouts" },
    { name: "Team", route: "team" },
  ];

  for (const section of adminSections) {
    test(`Admin > ${section.name} (/admin/{slug}/${section.route})`, async ({
      page,
    }) => {
      await assertPageHasNoConsoleErrors(
        page,
        `/admin/${orgSlug}/${section.route}`,
      );
    });
  }

  // ── Event sub-pages (require a seeded event) ───────────────────────────
  test("Admin > Event Builder — new (/admin/{slug}/events/new)", async ({
    page,
  }) => {
    await assertPageHasNoConsoleErrors(page, `/admin/${orgSlug}/events/new`);
  });

  test("Admin > Event Builder — edit (/admin/{slug}/events/{id})", async ({
    page,
  }) => {
    await assertPageHasNoConsoleErrors(
      page,
      `/admin/${orgSlug}/events/${eventPublishedId}`,
    );
  });

  test("Admin > Event Attendees (/admin/{slug}/events/{id}/attendees)", async ({
    page,
  }) => {
    await assertPageHasNoConsoleErrors(
      page,
      `/admin/${orgSlug}/events/${eventPublishedId}/attendees`,
    );
  });

  test("Admin > Event Applications (/admin/{slug}/events/{id}/applications)", async ({
    page,
  }) => {
    await assertPageHasNoConsoleErrors(
      page,
      `/admin/${orgSlug}/events/${eventAppGatedId}/applications`,
    );
  });

  // ── Place sub-pages (require a seeded place) ───────────────────────────
  test("Admin > Venue Settings (/admin/{slug}/places/{placeId}/settings)", async ({
    page,
  }) => {
    await assertPageHasNoConsoleErrors(
      page,
      `/admin/${orgSlug}/places/${placeActiveId}/settings`,
    );
  });

  test("Admin > Place Calendar (/admin/{slug}/places/{placeId}/calendar)", async ({
    page,
  }) => {
    await assertPageHasNoConsoleErrors(
      page,
      `/admin/${orgSlug}/places/${placeActiveId}/calendar`,
    );
  });

  test("Admin > Place Layout (/admin/{slug}/places/{placeId}/layout)", async ({
    page,
  }) => {
    await assertPageHasNoConsoleErrors(
      page,
      `/admin/${orgSlug}/places/${placeActiveId}/layout`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PLATFORM PAGES (authenticated, staff-gated)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Smoke: Platform pages (no console errors)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ context }) => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
    await context.addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
  });

  test.beforeAll(async ({ request }, testInfo) => {
    // Guard: seed only runs in authenticated projects.
    if (testInfo.project.name === "guest") return;

    // The admin seed above already reset state, but the platform tables seed
    // creates its own data. We re-seed to ensure platform pages have data.
    const res = await request.post(`${API_BASE_URL}/e2e/seed/platform-tables`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    expect(res.ok(), `Platform seed failed: ${await res.text()}`).toBeTruthy();
  });

  const platformPages = [
    { name: "Overview", route: "overview" },
    { name: "Orders", route: "orders" },
    { name: "Tickets", route: "tickets" },
    { name: "Places", route: "places" },
    { name: "Theme Editor", route: "theme-editor" },
  ];

  for (const section of platformPages) {
    test(`Platform > ${section.name} (/platform/${section.route})`, async ({
      page,
    }) => {
      await assertPageHasNoConsoleErrors(page, `/platform/${section.route}`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. AUTHENTICATED USER PAGES
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Smoke: User pages (no console errors)", () => {
  test.beforeEach(async ({ context }) => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
    await context.addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
  });

  const userPages = [{ name: "My Tickets", path: "/my-tickets" }];

  for (const pg of userPages) {
    test(`${pg.name} (${pg.path})`, async ({ page }) => {
      await assertPageHasNoConsoleErrors(page, pg.path);
    });
  }
});
