import {
  request as pwRequest,
  type FrameLocator,
  type Page,
} from "@playwright/test";

import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import { createMailpitClient } from "./helpers/mailpit";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import {
  API_BASE_URL,
  EMPTY_STORAGE_STATE,
  TEST_EMAIL,
  seedBookingLoop,
  signInContext,
  startEmbedHostServer,
  verifyEmail,
  type BookingLoopSeed,
  type EmbedHostServer,
} from "./helpers/booking-loop";

/**
 * Booking loop — anonymous EMBED path + claim:
 *
 *   A cross-origin host page (bare Node HTTP server on another localhost
 *   port; Embed.domain = "localhost" matches any local port, hostname-only
 *   allowlist) carries the REAL stub-queue snippet → widget:"booking" modal
 *   → anonymous inquiry → venue inbox (VIA YOUR WEBSITE) → Accept & send
 *   invite → performer claims via the emailed link (Mailpit-gated).
 *
 * Negotiation / event creation are covered by booking-loop.spec.ts — this
 * spec ends at the claimed agreement existing.
 *
 * Turnstile: local keys are Cloudflare's always-pass test pair, so the
 * widget renders and auto-resolves; if it renders and does NOT resolve
 * (e.g. no network to challenges.cloudflare.com), the submission tests
 * skip with an explanation.
 *
 * Prerequisites: local infra (postgres, redis, Mailpit for the claim leg),
 * API, web dev server.
 */

const CLAIM_TOKEN_RE = /\/booking-requests\/claim\/([A-Za-z0-9_-]{43})/;

test.describe.configure({ mode: "serial" });

test.describe("Booking loop — embed + claim", () => {
  test.beforeEach(async ({ context }, testInfo) => {
    test.skip(
      testInfo.project.name === "guest",
      "Venue-inbox steps need the authenticated storage state",
    );
    // The API-only auth setup branch doesn't persist the consent cookie, and
    // the cookie banner intercepts clicks on admin pages.
    await context.addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
  });

  let seed: BookingLoopSeed;
  let host: EmbedHostServer;
  // Unique per ATTEMPT (assigned in beforeAll, which re-runs on CI retries)
  // — the anonymous dedupe is (place, contactEmail), and a retry must never
  // consume a stale invite email minted by a previous attempt against the
  // re-seeded DB.
  let anonEmail = "";
  const anonName = "Ana Nonymous";
  const anonActName = "Embedded Echoes";
  let claimPath: string | null = null;

  test.beforeAll(async ({ request }, testInfo) => {
    // beforeAll still fires in the guest project even though beforeEach will
    // skip every test. Guard the seed so it doesn't fail on missing auth
    // (page-smoke precedent).
    if (testInfo.project.name === "guest") return;
    anonEmail = `anon-booker-${Date.now()}@example.com`;
    // Second staleness belt: drop any invite emails from previous attempts
    // when Mailpit is reachable (the claim test skips itself when it isn't).
    const mailpit = createMailpitClient({ request });
    try {
      await mailpit.ready();
      await mailpit.clear();
    } catch {
      // Mailpit unavailable — the claim leg will skip with its own reason.
    }
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });
    await verifyEmail(request, TEST_EMAIL);
    // Embed.domain "localhost" matches the host page's hostname on any port.
    seed = await seedBookingLoop(request, { embedDomain: "localhost" });
    host = await startEmbedHostServer(seed.embedId);
  });

  test.afterAll(async () => {
    await host?.close();
  });

  // ── Shared widget steps ────────────────────────────────────────────────

  async function openBookingWidget(page: Page): Promise<FrameLocator> {
    // The SDK replaces the container with its branded trigger button.
    const trigger = page.locator(`#hf-book-${seed.embedId} button`);
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await expect(trigger).toHaveText(/request to book/i);
    await trigger.click();

    const overlay = page.locator('[role="dialog"]');
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    const frame = page.frameLocator('[role="dialog"] iframe');
    // Place name in the widget header proves the origin allowlist admitted
    // the cross-origin host page.
    await expect(frame.getByText(seed.placeName).first()).toBeVisible({
      timeout: 20_000,
    });
    return frame;
  }

  /**
   * Wait out the Turnstile challenge when the widget renders one. With the
   * local always-pass test keys the "Complete the verification to continue"
   * hint disappears within a few seconds; if it never does, skip — the
   * environment can't complete a bot check headlessly.
   */
  async function ensureTurnstileResolved(frame: FrameLocator) {
    const hint = frame.getByText("Complete the verification to continue");
    if (!(await hint.isVisible().catch(() => false))) return;
    try {
      await expect(hint).not.toBeVisible({ timeout: 20_000 });
    } catch {
      test.skip(
        true,
        "Turnstile rendered but did not auto-resolve locally — cannot submit the anonymous inquiry headlessly",
      );
    }
  }

  async function fillAndSubmitInquiry(
    frame: FrameLocator,
    args: { name: string; email: string },
  ) {
    const dateIso = futureDateIso(21);
    await frame.getByLabel("Your name").fill(args.name);
    await frame.getByLabel("Email", { exact: true }).fill(args.email);
    await frame.getByLabel(/act or band name/i).fill(anonActName);
    await frame
      .getByLabel("Your pitch")
      .fill("Hello from your own website — we bring our own crowd.");
    await frame.getByLabel("Preferred date 1").fill(dateIso);
    await ensureTurnstileResolved(frame);
    await frame.getByRole("button", { name: "Send request" }).click();
  }

  // ── 1. Widget renders + anonymous submit + duplicate ──────────────────

  test("anonymous inquiry submits through the cross-origin widget; duplicate email is rejected inline", async ({
    page,
    consoleErrors,
  }) => {
    test.setTimeout(120_000);

    await page.goto(host.url);

    const frame = await openBookingWidget(page);
    await fillAndSubmitInquiry(frame, { name: anonName, email: anonEmail });

    await expect(frame.getByText("Request sent")).toBeVisible({
      timeout: 20_000,
    });
    await expect(frame.getByText(anonEmail)).toBeVisible();

    // Pin the SDK stub-queue race fix: a host page whose DOMContentLoaded
    // beats the async SDK used to throw "HF is not defined". Assert no such
    // error surfaced anywhere up to the successful submit.
    const raceErrors = consoleErrors
      .errors()
      .filter((entry) =>
        /HF is not defined|is not a function|\[pageerror\]/i.test(entry),
      );
    expect(raceErrors, "SDK stub-queue race regression").toEqual([]);

    // The duplicate submission below INTENTIONALLY triggers a 409 CONFLICT
    // (logged to the console by the browser + tRPC devtools), and the
    // embed/Turnstile iframes emit benign permissions-policy notices on this
    // bare host page — opt out of the blanket zero-console-errors assertion
    // (the explicit race check above already ran).
    consoleErrors.ignore();

    // Close the modal, reopen a fresh widget, resubmit with the same email.
    await page
      .locator('[role="dialog"] button[aria-label="Close"]')
      .click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    const frame2 = await openBookingWidget(page);
    await fillAndSubmitInquiry(frame2, { name: anonName, email: anonEmail });
    await expect(
      frame2.getByText(
        "You already have an open request with this venue. They can reply to that one.",
      ),
    ).toBeVisible({ timeout: 20_000 });
  });

  // ── 2. Venue inbox: anonymous row → Accept & send invite ──────────────

  test("venue inbox shows the anonymous row and accepting sends the claim invite", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto(`/admin/${seed.orgSlug}/places/${seed.placeId}/bookings`);

    // Desktop DataTable rows are plain <tr role="row"> (no row testid).
    const row = page.getByRole("row").filter({ hasText: anonName }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("Via your website")).toBeVisible();
    await row.click();

    // Anonymous provenance: contact email as a mailto reply channel.
    const mailto = page.locator(`a[href="mailto:${anonEmail}"]`);
    await expect(mailto).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid^="booking-accept-"]').first().click();
    const confirm = page.getByRole("dialog");
    await expect(
      confirm.getByText(
        `Accept & send an invite — ${anonName} will get an email link`,
        { exact: false },
      ),
    ).toBeVisible();
    await confirm
      .getByRole("button", { name: "Accept & send invite" })
      .click();

    await expect(page.getByText("Invite sent").first()).toBeVisible({
      timeout: 15_000,
    });

    // Accepting follows the row to the Agreement stage view (a pressed-toggle
    // group, not a tablist); the expanded panel shows the INVITE SENT state
    // with a resend affordance.
    await expect(page.getByTestId("booking-inbox-tab-agreement")).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 15_000 },
    );
    const acceptedRow = page
      .getByRole("row")
      .filter({ hasText: anonName })
      .first();
    await expect(acceptedRow).toBeVisible({ timeout: 15_000 });
    if (
      !(await page
        .locator('[data-testid^="booking-resend-invite-"]')
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      await acceptedRow.click();
    }
    await expect(
      page.locator('[data-testid^="booking-resend-invite-"]').first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(
        `${anonName} got an email link to set up their account and finalize the booking.`,
        { exact: false },
      ),
    ).toBeVisible();
  });

  // ── 3. Claim leg (Mailpit-gated) ───────────────────────────────────────

  test("performer claims the accepted inquiry via the emailed link; replay is idempotent", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    const mailpit = createMailpitClient({ request });
    try {
      await mailpit.ready();
    } catch (error) {
      test.skip(
        true,
        `Mailpit unreachable at ${mailpit.origin} — claim leg needs the local mail sink (${String(
          error,
        )})`,
      );
      return;
    }

    const message = await mailpit.waitForEmailTo(anonEmail, {
      timeoutMs: 30_000,
    });
    const body = `${message.HTML ?? ""}\n${message.Text ?? ""}`;
    const match = CLAIM_TOKEN_RE.exec(body);
    expect(match, "Invite email should contain a claim link").toBeTruthy();
    claimPath = `/booking-requests/claim/${match![1]}`;

    const performerContext = await browser.newContext({ storageState: EMPTY_STORAGE_STATE });
    await performerContext.addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
    const performerPage = await performerContext.newPage();

    // Signed out → the claim route lands on first-party sign-in (via the
    // route guard redirect, or the page's own sign-in CTA).
    await performerPage.goto(claimPath);
    const form = performerPage.getByTestId("auth-sign-in-form");
    const claimSignInCta = performerPage.getByRole("link", {
      name: /sign in/i,
    });
    await expect(form.or(claimSignInCta).first()).toBeVisible({
      timeout: 20_000,
    });
    if (!(await form.isVisible().catch(() => false))) {
      await claimSignInCta.click();
    }
    await expect(form).toBeVisible({ timeout: 20_000 });
    // Passkey-first layout keeps the password form collapsed (inert) behind
    // the "Use password instead" expander, which lives OUTSIDE the <form>.
    // Interactions that land before Next dev hydration can no-op — so
    // expand + fill + check as one retried unit until the controlled form
    // holds the values (submit enables). The aria-expanded guard keeps the
    // retry from toggling the section closed again.
    const expander = performerPage.getByRole("button", {
      name: /use password instead/i,
    });
    const emailInput = form.getByLabel(/email or username/i);
    const submit = form.getByTestId("auth-sign-in-submit");
    await expect(expander).toBeVisible({ timeout: 20_000 });
    await expect(async () => {
      if ((await expander.getAttribute("aria-expanded")) !== "true") {
        await expander.click();
      }
      await emailInput.fill(seed.performer.email);
      await form.getByLabel(/^password$/i).fill(seed.performer.password);
      await expect(submit).toBeEnabled({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await submit.click();

    // Back on the claim page → one-click performer-mode gate → claim form.
    await performerPage.waitForURL((url) =>
      url.pathname.startsWith("/booking-requests/claim/"),
      { timeout: 30_000 },
    );
    const enable = performerPage.getByRole("button", {
      name: "Turn on performer mode",
    });
    const claimSubmit = performerPage.getByTestId("claim-booking-submit");
    await expect(enable.or(claimSubmit)).toBeVisible({ timeout: 20_000 });
    if (await enable.isVisible().catch(() => false)) {
      await enable.click();
    }

    // CLAIM AS — the self identity is the default selection.
    await expect(claimSubmit).toBeVisible({ timeout: 20_000 });
    await expect(claimSubmit).toBeEnabled();
    await claimSubmit.click();

    await expect(performerPage.getByText("Booking claimed")).toBeVisible({
      timeout: 20_000,
    });
    const agreementLink = performerPage.getByRole("link", {
      name: "Open the agreement",
    });
    const agreementHref = await agreementLink.getAttribute("href");
    expect(agreementHref).toMatch(/\/agreements\/[0-9a-f-]{36}/);

    // The claimed agreement exists and the performer is a party.
    await agreementLink.click();
    await expect(
      performerPage.getByText(`Booking — ${seed.placeName}`),
    ).toBeVisible({ timeout: 20_000 });

    // ── Replay: redeeming the same link again is a friendly success ──────
    await performerPage.goto(claimPath);
    const replaySubmit = performerPage.getByTestId("claim-booking-submit");
    await expect(replaySubmit).toBeVisible({ timeout: 20_000 });
    await replaySubmit.click();
    await expect(performerPage.getByText("Booking claimed")).toBeVisible({
      timeout: 20_000,
    });
    const replayHref = await performerPage
      .getByRole("link", { name: "Open the agreement" })
      .getAttribute("href");
    expect(replayHref).toBe(agreementHref);

    await performerContext.close();
  });

  // ── 4. Fabricated token → calm invalid state (Mailpit-independent) ────

  test("a fabricated claim token shows the calm invalid state", async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    // Well-formed (43-char base64url) but never issued.
    const fakeToken = "A".repeat(42) + "B";

    const performerContext = await browser.newContext({ storageState: EMPTY_STORAGE_STATE });
    const performerPage = await performerContext.newPage();
    await signInContext(performerContext, seed.performer);

    // The claim form needs performer mode; enable idempotently through the
    // real API in case the Mailpit-gated test (which exercises the UI gate)
    // was skipped.
    const apiCtx = await pwRequest.newContext();
    const { token } = await signInAndGetToken(apiCtx, API_BASE_URL, {
      email: seed.performer.email,
      password: seed.performer.password,
    });
    const trpc = createE2eTrpcClient(apiCtx, API_BASE_URL, {
      bearerToken: token,
    });
    await trpc.performers.setMode.mutate({
      ownerType: "human",
      ownerId: seed.performer.humanId,
      enabled: true,
    });

    await performerPage.goto(`/booking-requests/claim/${fakeToken}`);
    const claimSubmit = performerPage.getByTestId("claim-booking-submit");
    await expect(claimSubmit).toBeVisible({ timeout: 20_000 });
    await claimSubmit.click();

    await expect(
      performerPage.getByText("This link is no longer active"),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      performerPage.getByText(
        "It was already used, or a newer invite email replaced it.",
        { exact: false },
      ),
    ).toBeVisible();

    await performerContext.close();
    await apiCtx.dispose();
  });
});

function futureDateIso(daysAhead: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}
