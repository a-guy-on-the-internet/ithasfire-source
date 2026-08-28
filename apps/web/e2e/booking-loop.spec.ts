import { request as pwRequest, type Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import {
  API_BASE_URL,
  EMPTY_STORAGE_STATE,
  TEST_EMAIL,
  seedBookingLoop,
  signInContext,
  type BookingLoopSeed,
} from "./helpers/booking-loop";

/**
 * Booking loop end to end — the OWNED path (no email, no Turnstile, no
 * cross-origin):
 *
 *   performer (2nd browser context) pitches a verified venue from /p/[slug]
 *   → venue (storage-state user) accepts from the BookingInbox → agreement
 *   minted → venue negotiates a DIFFERENT date + payout lines → performer
 *   accepts → venue creates the event from the booking.
 *
 * Both create-event outcome branches are covered:
 *   1. BLOCKED → CONVERGE: an unconfirmed third-party payout line blocks the
 *      finalize; the draft event still exists (idempotently), and once the
 *      payee confirms, a re-click converges via the alreadyLinked path
 *      (toast + inline open-event, NO redirect).
 *   2. DIRECT FINALIZE: party-only lines are implied-confirmed → create
 *      finalizes immediately and redirects into the event editor.
 *
 * Prerequisites: local infra (docker postgres + redis), API, web dev server.
 */

const VENUE_PASSWORD =
  process.env.PLAYWRIGHT_TEST_PASSWORD ?? "Test-Account-2025!";

test.describe.configure({ mode: "serial" });

test.describe("Booking loop — owned path", () => {
  test.beforeEach(async ({ context }, testInfo) => {
    test.skip(
      testInfo.project.name === "guest",
      "Needs the authenticated venue storage state",
    );
    // The API-only auth setup branch doesn't persist the consent cookie, and
    // the cookie banner intercepts clicks on admin pages.
    await context.addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
  });

  let seed: BookingLoopSeed;

  test.beforeAll(async ({ request }, testInfo) => {
    // beforeAll still fires in the guest project even though beforeEach will
    // skip every test. Guard the seed so it doesn't fail on missing auth
    // (page-smoke precedent).
    if (testInfo.project.name === "guest") return;
    await resetE2eState(request, API_BASE_URL, { preserveEmail: TEST_EMAIL });

    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret":
          process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    seed = await seedBookingLoop(request);
  });

  // ── Shared UI steps ────────────────────────────────────────────────────

  /** Performer pitches the venue through the /p/[slug] dialog. */
  async function submitBookingRequest(
    performerPage: Page,
    args: { actName: string; message: string; requestedDateIso: string },
  ) {
    await performerPage.goto(`/p/${seed.pageSlug}`);

    const heroCta = performerPage
      .getByRole("button", { name: "Request to book" })
      .first();
    await expect(heroCta).toBeVisible({ timeout: 20_000 });
    await heroCta.click();

    const dialog = performerPage.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // One-click performer-mode gate (first pitch only; later pitches skip it).
    const enableButton = dialog.getByRole("button", {
      name: "Turn on performer mode",
    });
    const messageField = dialog.getByLabel("Message");
    await expect(enableButton.or(messageField)).toBeVisible({
      timeout: 15_000,
    });
    if (await enableButton.isVisible().catch(() => false)) {
      await enableButton.click();
    }

    await expect(messageField).toBeVisible({ timeout: 15_000 });
    await dialog.getByLabel(/act \/ band name/i).fill(args.actName);
    await messageField.fill(args.message);
    await dialog.getByLabel("Preferred dates 1").fill(args.requestedDateIso);

    await dialog.getByRole("button", { name: "Send request" }).click();
    await expect(
      dialog.getByText(`Request sent to ${seed.placeName}`),
    ).toBeVisible({ timeout: 15_000 });
    // Both the footer "Close" button and the header X (aria-label "Close")
    // match — either dismisses the dialog.
    await dialog.getByRole("button", { name: "Close" }).first().click();
  }

  /**
   * Venue accepts the request with the given preferred date and opens the
   * minted agreement. Returns the agreementId parsed from the editor URL.
   *
   * Row disambiguation: the collapsed inbox row never renders the actName
   * (only sender / genre / preferred date / status), and both tests share
   * one performer — so the per-test UNIQUE preferred date is the stable
   * discriminator against sort-order changes on the Agreement view.
   */
  async function venueAcceptAndOpenAgreement(
    page: Page,
    requestedDateIso: string,
  ): Promise<string> {
    const dateLabel = preferredDateLabel(requestedDateIso);
    await page.goto(`/admin/${seed.orgSlug}/places/${seed.placeId}/bookings`);

    // Desktop DataTable rows are plain <tr role="row"> (no row testid).
    const openRow = page
      .getByRole("row")
      .filter({ hasText: seed.performer.displayName })
      .filter({ hasText: dateLabel })
      .first();
    await expect(openRow).toBeVisible({ timeout: 20_000 });
    await openRow.click();

    const acceptButton = page
      .locator('[data-testid^="booking-accept-"]')
      .first();
    await expect(acceptButton).toBeVisible({ timeout: 10_000 });
    await acceptButton.click();

    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("Accept this request?")).toBeVisible();
    await confirm.getByRole("button", { name: "Accept", exact: true }).click();

    // Accepting follows the row to the Agreement stage view (the inbox
    // filters by where the booking IS: Open / Agreement / Event / Closed,
    // as a pressed-toggle group, not a tablist).
    await expect(page.getByTestId("booking-inbox-tab-agreement")).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 15_000 },
    );
    const acceptedRow = page
      .getByRole("row")
      .filter({ hasText: seed.performer.displayName })
      .filter({ hasText: dateLabel })
      .first();
    await expect(acceptedRow).toBeVisible({ timeout: 15_000 });
    // The stage rail's agreement leg is lit: the request leg is done and
    // the agreement leg is where the booking now is.
    await expect(
      acceptedRow.locator('[data-testid$="-stage-rail-bar-agreement"]'),
    ).toHaveAttribute("data-state", "current", { timeout: 15_000 });

    const openAgreement = page
      .locator('[data-testid^="booking-open-agreement-"]')
      .first();
    try {
      // The row usually stays expanded across the accept refetch…
      await expect(openAgreement).toBeVisible({ timeout: 3_000 });
    } catch {
      // …but if it collapsed, expand it again.
      await acceptedRow.click();
      await expect(openAgreement).toBeVisible({ timeout: 10_000 });
    }
    await openAgreement.click();

    // The venue lands on the agreement INSIDE its admin shell.
    await page.waitForURL(/\/admin\/[^/]+\/bookings\/agreement\/[0-9a-f-]{36}/, {
      timeout: 20_000,
    });
    const agreementId = page
      .url()
      .match(/\/bookings\/agreement\/([0-9a-f-]{36})/)?.[1];
    expect(agreementId, `No agreementId in url ${page.url()}`).toBeTruthy();
    return agreementId as string;
  }

  /**
   * Venue sets the NEGOTIATED date (≠ requested) and saves the header.
   * NOTE: the header's TextInputs carry `testID` (capital D), which the
   * shared TextInput does not forward to the DOM — locate by label instead.
   */
  async function venueSetNegotiatedDate(page: Page, negotiatedLocal: string) {
    const dateInput = page.getByLabel("Proposed date", { exact: true });
    await expect(dateInput).toBeVisible({ timeout: 15_000 });
    await dateInput.fill(negotiatedLocal);
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("Agreement updated")).toBeVisible({
      timeout: 15_000,
    });
  }

  /** Venue adds a payout line for a human payee via the search combobox. */
  async function venueAddPayoutLine(
    page: Page,
    payee: { humanId: string; displayName: string },
    percent: number,
  ) {
    await page.getByTestId("ba-add-payee-search").fill(payee.displayName);
    const option = page.getByTestId(
      `ba-add-payee-search-option-${payee.humanId}`,
    );
    await expect(option).toBeVisible({ timeout: 15_000 });
    await option.click();
    // "Share %" is a TextInput with the non-forwarded `testID` prop — label it.
    await page.getByLabel("Share %", { exact: true }).fill(String(percent));
    await page.getByTestId("ba-add-line").click();
    await expect(page.getByText("Line saved")).toBeVisible({
      timeout: 15_000,
    });
  }

  async function venueSendForReview(page: Page) {
    await page.getByTestId("ba-send-for-review").click();
    await expect(page.getByText("Sent for review")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Under review").first()).toBeVisible({
      timeout: 15_000,
    });
  }

  async function performerAcceptAgreement(
    performerPage: Page,
    agreementId: string,
  ) {
    await performerPage.goto(`/agreements/${agreementId}`);
    const accept = performerPage.getByTestId("ba-accept");
    await expect(accept).toBeVisible({ timeout: 20_000 });
    await accept.click();
    const confirm = performerPage.getByRole("dialog");
    await expect(confirm.getByText("Accept this agreement?")).toBeVisible();
    await confirm.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(performerPage.getByText("Agreement accepted")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      performerPage.getByText("Accepted", { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
  }

  /**
   * Click "Create event from this booking" until the inline outcome renders.
   * A rapid re-click can land inside the finalize envelope's ~1s
   * failed-marker window (IDEMPOTENCY_LOCK_IN_PROGRESS) — the UI's own copy
   * says "give it a moment, then try again", so the retry does exactly that.
   */
  async function clickCreateEventUntilOutcome(page: Page) {
    const outcome = page.getByTestId("ba-create-event-outcome");
    const lockNotice = page.getByText(
      "This event is already being created. Give it a moment, then try again.",
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await page.getByTestId("ba-create-event").click();
      try {
        await expect(outcome).toBeVisible({ timeout: 15_000 });
        return;
      } catch {
        await expect(lockNotice).toBeVisible({ timeout: 2_000 });
        // Deliberate pause: the failed marker expires after ~1s.
        await page.waitForTimeout(1_500);
      }
    }
    await expect(outcome).toBeVisible({ timeout: 15_000 });
  }

  /** eventId behind the inline "Open event" affordance in the dialog. */
  async function openEventHrefEventId(page: Page): Promise<string> {
    const href = await page
      .getByTestId("ba-create-event-open")
      .evaluate((el) => (el.closest("a") as HTMLAnchorElement | null)?.href);
    const eventId = href?.match(/\/events\/([0-9a-f-]{36})/)?.[1];
    expect(eventId, `No eventId in Open-event href: ${href}`).toBeTruthy();
    return eventId as string;
  }

  // ── Branch 1: blocked → converge ──────────────────────────────────────

  test("blocked create-event: third-party line gates finalize, confirm converges via alreadyLinked", async ({
    page,
    browser,
    consoleErrors,
  }) => {
    test.setTimeout(240_000);

    const actName = "The Night Owls";
    const requestedDate = new Date();
    requestedDate.setDate(requestedDate.getDate() + 28);
    const requestedDateIso = requestedDate.toISOString().slice(0, 10);
    // Negotiated date deliberately DIFFERENT from the requested one — pins
    // that the minted event uses the agreement's proposedDate.
    const negotiated = new Date();
    negotiated.setDate(negotiated.getDate() + 35);
    negotiated.setHours(19, 30, 0, 0);
    const negotiatedLocal = toDatetimeLocal(negotiated);

    // ── Performer pitches ───────────────────────────────────────────────
    const performerContext = await browser.newContext({ storageState: EMPTY_STORAGE_STATE });
    const performerPage = await performerContext.newPage();
    await signInContext(performerContext, seed.performer);
    await submitBookingRequest(performerPage, {
      actName,
      message: "We would love to play your room — 45 minute original set.",
      requestedDateIso,
    });

    // ── Venue accepts + negotiates ──────────────────────────────────────
    const agreementId = await venueAcceptAndOpenAgreement(page, requestedDateIso);
    await venueSetNegotiatedDate(page, negotiatedLocal);
    await venueAddPayoutLine(page, seed.performer, 60);
    // Third-party payee → requiresConfirmation → blocks finalize.
    await venueAddPayoutLine(page, seed.thirdPayee, 20);
    await venueSendForReview(page);

    // ── Performer accepts ───────────────────────────────────────────────
    await performerAcceptAgreement(performerPage, agreementId);

    // ── Negative: the PERFORMER's finalize dialog has no create section ──
    await performerPage.getByTestId("ba-finalize-open").click();
    const performerDialog = performerPage.getByRole("dialog");
    await expect(performerDialog).toBeVisible();
    await expect(
      performerDialog.getByText("Finalize agreement"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      performerPage.getByTestId("ba-create-event"),
    ).toHaveCount(0);
    await expect(
      performerDialog.getByText("Create a new event"),
    ).toHaveCount(0);
    // FinalizeDialog's header X is not a semantic button — dismiss via the
    // footer "Cancel".
    await performerDialog.getByRole("button", { name: "Cancel" }).click();

    // ── Venue: create event → BLOCKED (lines unconfirmed) ───────────────
    await page.goto(`/admin/${seed.orgSlug}/bookings/agreement/${agreementId}`);
    await page.getByTestId("ba-finalize-open").click();
    await clickCreateEventUntilOutcome(page);
    const outcome = page.getByTestId("ba-create-event-outcome");
    await expect(
      outcome.getByText("Event created — finalize when payouts are confirmed"),
    ).toBeVisible();
    const eventId = await openEventHrefEventId(page);

    // ── Idempotency: re-click → same event, still blocked ───────────────
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await page.getByTestId("ba-finalize-open").click();
    await clickCreateEventUntilOutcome(page);
    const eventIdAgain = await openEventHrefEventId(page);
    expect(eventIdAgain).toBe(eventId);

    // Authoritative single-event check via the venue's own API view.
    const venueApiCtx = await pwRequest.newContext();
    const { token: venueToken } = await signInAndGetToken(
      venueApiCtx,
      API_BASE_URL,
      { email: TEST_EMAIL, password: VENUE_PASSWORD },
    );
    const venueTrpc = createE2eTrpcClient(venueApiCtx, API_BASE_URL, {
      bearerToken: venueToken,
    });
    const expectedTitle = `${actName} at ${seed.placeName}`;
    const listed = await venueTrpc.events.listMine.query({
      ownerType: "ORGANIZATION",
      ownerId: seed.orgId,
      status: ["DRAFT", "PUBLISHED"],
      limit: 50,
    });
    const matching = listed.items.filter(
      (item: { title: string | null }) => item.title === expectedTitle,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]!.id).toBe(eventId);

    // ── Third actor confirms their line (payee-side authz, real API) ─────
    const agreementView = await venueTrpc.bookingAgreements.get.query({
      agreementId,
    });
    const pendingLine = agreementView.lines.find(
      (line: {
        requiresConfirmation: boolean;
        confirmationStatus: string | null;
      }) =>
        line.requiresConfirmation && line.confirmationStatus !== "CONFIRMED",
    );
    expect(pendingLine, "Expected an unconfirmed third-party line").toBeTruthy();

    const thirdApiCtx = await pwRequest.newContext();
    const { token: thirdToken } = await signInAndGetToken(
      thirdApiCtx,
      API_BASE_URL,
      { email: seed.thirdPayee.email, password: seed.thirdPayee.password },
    );
    const thirdTrpc = createE2eTrpcClient(thirdApiCtx, API_BASE_URL, {
      bearerToken: thirdToken,
    });
    await thirdTrpc.payoutTerms.confirmPayoutLine.mutate({
      payoutTermsLineId: (pendingLine as { id: string }).id,
      decision: "CONFIRM",
    });

    // ── Venue re-clicks create → CONVERGE (alreadyLinked, NO redirect) ───
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await page.getByTestId("ba-finalize-open").click();
    await clickCreateEventUntilOutcome(page);
    await expect(
      page.getByText("Agreement linked to its event"),
    ).toBeVisible({ timeout: 15_000 });
    const convergedOutcome = page.getByTestId("ba-create-event-outcome");
    await expect(
      convergedOutcome.getByText(
        "This agreement is already linked to its event.",
      ),
    ).toBeVisible();
    await expect(convergedOutcome.getByTestId("ba-create-event-open")).toBeVisible();
    // The alreadyLinked path deliberately does NOT redirect: the finalize
    // dialog stays open on the agreement page.
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(page.url()).toContain(
      `/admin/${seed.orgSlug}/bookings/agreement/${agreementId}`,
    );

    // ── Event assertions: editor loads, title, NEGOTIATED start, lineup ──
    await page.goto(`/admin/${seed.orgSlug}/events/${eventId}`);
    await expect(page.getByTestId("event-title")).toHaveValue(expectedTitle, {
      timeout: 30_000,
    });

    const afterFinalize = await venueTrpc.events.listMine.query({
      ownerType: "ORGANIZATION",
      ownerId: seed.orgId,
      status: ["DRAFT", "PUBLISHED"],
      limit: 50,
    });
    const created = afterFinalize.items.find(
      (item: { id: string }) => item.id === eventId,
    ) as { startsAt: string | Date | null } | undefined;
    expect(created).toBeTruthy();
    expect(new Date(created!.startsAt as string | Date).getTime()).toBe(
      negotiated.getTime(),
    );

    const lineup = await venueTrpc.eventHumans.list.query({ eventId });
    expect(
      lineup.map((entry: { humanId: string | null }) => entry.humanId),
    ).toContain(seed.performer.humanId);

    // clickCreateEventUntilOutcome deliberately rides through the designed
    // IDEMPOTENCY_LOCK_IN_PROGRESS retry window ("give it a moment, then try
    // again"), whose 429s land in the console. Exempt ONLY that noise —
    // the tRPC devtools line names the procedure, and each such lock error
    // also emits one anonymous "Failed to load resource … 429" browser line,
    // so allow at most one generic 429 per attributed lock error. Everything
    // else keeps the zero-console-errors guarantee.
    const collectedErrors = consoleErrors.errors();
    const isCreateEventLockError = (entry: string) =>
      /bookingAgreements\.createEventFromAgreement[\s\S]*IDEMPOTENCY_LOCK_IN_PROGRESS/.test(
        entry,
      );
    let allowedGeneric429 = collectedErrors.filter(isCreateEventLockError).length;
    const unexpectedConsoleErrors = collectedErrors.filter((entry) => {
      if (isCreateEventLockError(entry)) return false;
      if (
        /^Failed to load resource:.*429 \(Too Many Requests\)/.test(entry) &&
        allowedGeneric429 > 0
      ) {
        allowedGeneric429 -= 1;
        return false;
      }
      return true;
    });
    expect(unexpectedConsoleErrors, "unexpected console errors").toEqual([]);
    consoleErrors.ignore();

    await performerContext.close();
    await venueApiCtx.dispose();
    await thirdApiCtx.dispose();
  });

  // ── Branch 2: direct finalize ─────────────────────────────────────────

  test("direct finalize: party-only lines → event created, agreement finalized, redirect to editor", async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);

    const actName = "Direct Finalize Trio";
    const requestedDate = new Date();
    requestedDate.setDate(requestedDate.getDate() + 30);
    const requestedDateIso = requestedDate.toISOString().slice(0, 10);
    const negotiated = new Date();
    negotiated.setDate(negotiated.getDate() + 42);
    negotiated.setHours(20, 0, 0, 0);
    const negotiatedLocal = toDatetimeLocal(negotiated);

    const performerContext = await browser.newContext({ storageState: EMPTY_STORAGE_STATE });
    const performerPage = await performerContext.newPage();
    await signInContext(performerContext, seed.performer);
    await submitBookingRequest(performerPage, {
      actName,
      message: "Round two — this time with a party-only payout split.",
      requestedDateIso,
    });

    const agreementId = await venueAcceptAndOpenAgreement(page, requestedDateIso);
    await venueSetNegotiatedDate(page, negotiatedLocal);
    // Party payee only (the performer) → implied-confirmed line.
    await venueAddPayoutLine(page, seed.performer, 100);
    await venueSendForReview(page);

    await performerAcceptAgreement(performerPage, agreementId);

    // ── Venue: create event → immediate finalize + redirect ─────────────
    await page.goto(`/admin/${seed.orgSlug}/bookings/agreement/${agreementId}`);
    await page.getByTestId("ba-finalize-open").click();
    await page.getByTestId("ba-create-event").click();

    await expect(
      page.getByText("Event created and agreement finalized"),
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForURL(
      new RegExp(`/admin/${seed.orgSlug}/events/[0-9a-f-]{36}`),
      { timeout: 30_000 },
    );
    const eventId = page.url().match(/\/events\/([0-9a-f-]{36})/)?.[1];
    expect(eventId).toBeTruthy();

    const expectedTitle = `${actName} at ${seed.placeName}`;
    await expect(page.getByTestId("event-title")).toHaveValue(expectedTitle, {
      timeout: 30_000,
    });

    // ── STARTS = negotiated date; lineup contains the performer ─────────
    const venueApiCtx = await pwRequest.newContext();
    const { token: venueToken } = await signInAndGetToken(
      venueApiCtx,
      API_BASE_URL,
      { email: TEST_EMAIL, password: VENUE_PASSWORD },
    );
    const venueTrpc = createE2eTrpcClient(venueApiCtx, API_BASE_URL, {
      bearerToken: venueToken,
    });

    const listed = await venueTrpc.events.listMine.query({
      ownerType: "ORGANIZATION",
      ownerId: seed.orgId,
      status: ["DRAFT", "PUBLISHED"],
      limit: 50,
    });
    const created = listed.items.find(
      (item: { id: string }) => item.id === eventId,
    ) as { startsAt: string | Date | null; title: string | null } | undefined;
    expect(created).toBeTruthy();
    expect(created!.title).toBe(expectedTitle);
    expect(new Date(created!.startsAt as string | Date).getTime()).toBe(
      negotiated.getTime(),
    );

    const lineup = await venueTrpc.eventHumans.list.query({
      eventId: eventId as string,
    });
    expect(
      lineup.map((entry: { humanId: string | null }) => entry.humanId),
    ).toContain(seed.performer.humanId);

    // Agreement is now finalized — the editor shows the linked notice.
    const agreementView = await venueTrpc.bookingAgreements.get.query({
      agreementId,
    });
    expect(agreementView.agreement.status).toBe("ACCEPTED");
    expect(agreementView.agreement.eventId).toBe(eventId);

    await performerContext.close();
    await venueApiCtx.dispose();
  });
});

/**
 * How the inbox's "Preferred dates" column renders an ISO `YYYY-MM-DD`
 * (BookingInbox: `fmt.dateTime(isoDateToLocal(d), { dateStyle: "medium" })`,
 * app locale "en", anchored at local midnight).
 */
function preferredDateLabel(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
    new Date(year as number, (month as number) - 1, day as number),
  );
}

/** Date → `datetime-local` input value in the machine's local timezone. */
function toDatetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
