/**
 * Event-first booking request — the builder's third-party venue picker
 * (venue-confirmation Phase 2, docs/specs/2026-08-27, "UI / Flow › Event builder").
 *
 * LIVE-STACK ONLY. This spec deliberately does NOT call `resetE2eState`: it
 * runs against the seeded dev database, creates exactly one draft event and
 * the booking request that save produces, and removes both in `afterAll`
 * through the same tRPC procedures a user would hit (withdraw as the
 * requester, delete as the owner). Run it as:
 *
 *   cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test \
 *     e2e/event-first-venue-request.spec.ts --project=chromium --workers=1
 *
 * Drives:
 *  1. A third-party venue WITH opening hours (see THIRD_PARTY_ID) picked from the "All
 *     venues" group by the dev admin in their PERSONAL admin → the intent /
 *     calendar / space cascade appears with "Play here" selected → save →
 *     the request band appears without a reload → reload → the band comes
 *     back from provenance → 320px: nothing overflows.
 *  2. An OWNED venue (The Paramount Theatre, owned by the dev admin's org)
 *     picked in the ORG admin → NO cascade, NO intent control (owner ruling
 *     2026-09-08: owners and grantees see nothing new).
 *  3. A third-party venue with NO opening hours (see NO_HOURS_ID) picked in
 *     the PERSONAL admin → the cascade appears → save → the save succeeds but
 *     the request is refused at the server's gates (`bookingRequest.outcome
 *     === "skipped"`) → the "request wasn't sent" notice appears under the
 *     cascade with `data-code="PLACE_NOT_ACCEPTING_REQUESTS"`, NO band →
 *     320px: nothing overflows → moving the start date (a snapshot input,
 *     cascade still mounted) clears it, and so does switching the venue
 *     field away → reload: nothing renders (a refusal leaves no request
 *     for provenance; the unsaved edits are dropped — no autosave).
 *
 * The `test` fixture fails the spec on any console error.
 */
import { test, expect, type Page } from "./fixtures";
import { signInWithPassword } from "./helpers/sign-in";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";

const API_BASE_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const ADMIN = { email: "admin@ithasfire.com", password: "Dev-Login-2026!" };
const ORG_ID = "00000000-0000-4000-8000-00000000d001"; // org d001, owns The Paramount Theatre
// Admin slugs are resolved at runtime from the signed-in user's owner entities —
// the personal slug is NOT the profile slug, and hardcoding either drifts.
const slugs: { personal: string | null; org: string | null } = { personal: null, org: null };
// The third-party venue must have OPENING HOURS (CalendarAvailability rows) or the
// server treats every date as unavailable and silently skips the request — a
// product gap recorded 2026-09-08. No seeded demo venue outside the dev admin's
// ownership has hours, so this uses an indexed venue left by the booking e2e
// suite (verified, accepting, PERFORM calendar, 2 hours rows). If it is gone,
// pick any active third-party venue with hours and update these two lines.
const THIRD_PARTY_ID = "78a16536-2886-4922-9ae1-017280e99043";
const THIRD_PARTY_NAME = "E2E Booking Venue 1788892623787";
const PARAMOUNT_NAME = "The Paramount Theatre";
// Part 3's venue must be ACTIVE + VERIFIED + accepting requests, own a
// PERFORM calendar, and have ZERO CalendarAvailability rows — so the gate
// walk refuses PERFORM with `booking_requests_unconfigured` and the save
// reports the skip. Stubb's BBQ is seed `place2`: org2-owned, no
// `openingHours` in its fixture. The dev admin is an org2 ADMIN, but the
// PERSONAL admin saves under the HUMAN, and venue ownership is checked on
// the owner pair (not on membership) — so it is a third party there.
// If a reseed ever gives it hours, pick another accepting venue with none.
const NO_HOURS_ID = "00000000-0000-4000-8000-00000000d031";
const NO_HOURS_NAME = "Stubb's BBQ";

const created: { eventId: string | null; requestId: string | null } = {
  eventId: null,
  requestId: null,
};
let ownedDraftId: string | null = null;
let skipDraftId: string | null = null;

/** Creates a draft through quick-create and opens the full builder in My Places mode. Returns the draft id. */
async function startNewEvent(
  page: Page,
  slug: string,
  title: string,
  quickCreateVenue?: string,
): Promise<string | null> {
  // /events/new is the QUICK-CREATE form (title, start, optional venue,
  // "Create draft"); the full builder — where the third-party cascade lives —
  // comes after it. Quick-create's own picker lists only OWNED venues (no
  // "All venues" mode, by design), and the venue is optional there (owner
  // ruling 2026-09-08): pass no `quickCreateVenue` to create a venue-less
  // draft and pick the venue in the full builder.
  await page.goto(`/admin/${slug}/events/new`);
  if (page.url().includes("/sign-in")) {
    await signInWithPassword(page, ADMIN);
    await page.goto(`/admin/${slug}/events/new`);
  }
  await expect(page).toHaveURL((u) => u.pathname.endsWith("/events/new"));
  const ticketed = page.getByRole("button", { name: /^Ticketed event/ });
  if (await ticketed.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await ticketed.click();
  }
  const titleBox = page.getByPlaceholder("What's the event called?");
  await expect(titleBox).toBeVisible({ timeout: 15_000 });
  await titleBox.fill(title);
  // The third-party venue is open Friday + Saturday only (its two availability
  // rows); a closed day makes the server treat the date as unavailable and skip
  // the request silently. Always set a FRIDAY at least two months out.
  const starts = page.getByRole("textbox").nth(1);
  const future = new Date();
  future.setMonth(future.getMonth() + 2);
  while (future.getDay() !== 5) future.setDate(future.getDate() + 1);
  const day = future.toISOString().slice(0, 10);
  const type = await starts.getAttribute("type");
  await starts.fill(type === "date" ? day : `${day}T20:00`);
  if (quickCreateVenue) {
    // An OWNED place, picked at quick-create through the My Places toggle.
    await page.getByRole("button", { name: "My Places" }).click();
    await page.getByRole("combobox").first().click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("option", { name: new RegExp(quickCreateVenue) }).first().click();
  } else {
    // No venue: the field reads as optional and the draft is created with
    // `location: {}`. No field error may appear.
    await expect(page.getByTestId("quick-create-venue-hint")).toBeVisible();
  }
  await page.getByRole("button", { name: "Create draft" }).click();
  if (!quickCreateVenue) {
    await expect(page.getByTestId("quick-create-venue-error")).toHaveCount(0);
  }
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const draftId = page.url().match(/\/events\/([0-9a-f-]{36})/)?.[1] ?? null;
  await expect(page.getByTestId("event-title")).toBeVisible({ timeout: 20_000 });
  // A venue-less draft opens the builder in Address mode with an empty box;
  // a draft created with an owned place opens in My Places mode already
  // (the click below is then a no-op).
  await page.getByTestId("location-mode-place").click();
  return draftId;
}

/** `YYYY-MM-DDTHH:mm` → the same wall-clock time one day later, in the same format. */
function nextDayLocal(dateTimeLocal: string): string {
  const [datePart, timePart = "20:00"] = dateTimeLocal.split("T");
  const [y, m, d] = datePart!.split("-").map(Number);
  const next = new Date(y!, m! - 1, d! + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${timePart.slice(0, 5)}`;
}

async function openVenuePicker(page: Page) {
  await page.getByRole("combobox").first().click();
  await expect(page.getByRole("listbox")).toBeVisible();
}

test.describe("Event-first venue request (builder)", () => {
  // Sign in per test through the page fixture: the project's auth.setup state
  // belongs to the harness's own test user, not the seeded dev admin.
  test.beforeAll(async ({ request }) => {
    const { token } = await signInAndGetToken(request, API_BASE_URL, ADMIN);
    const trpc = createE2eTrpcClient(request, API_BASE_URL, { bearerToken: token });
    type Owner =
      | { kind: "human"; humanId: string; humanUsername: string | null; humanProfileSlug: string | null }
      | { kind: "org"; orgId: string; orgSlug?: string | null };
    const res = (await trpc.events.listEventOwnerEntities.query({})) as { owners: Owner[] };
    const human = res.owners.find((o): o is Extract<Owner, { kind: "human" }> => o.kind === "human");
    const org = res.owners.find(
      (o): o is Extract<Owner, { kind: "org" }> => o.kind === "org" && o.orgId === ORG_ID,
    );
    // Mirror apps/web/src/hooks/useEventOwnerEntities.ts: a human's admin slug is
    // their username (else profile slug) with the decorative "@"; an org's is its slug.
    const personal = human?.humanUsername ?? human?.humanProfileSlug ?? null;
    slugs.personal = personal ? `@${personal}` : null;
    slugs.org = org?.orgSlug ?? null;
    expect(slugs.personal, "personal admin slug resolved").toBeTruthy();
    expect(slugs.org, "org admin slug resolved").toBeTruthy();
  });

  test.beforeEach(async ({ page }) => {
    // The project's auth.setup signed this context in as the harness's test
    // user; drop that session, then sign in as the seeded dev admin.
    await page.context().clearCookies();
    await signInWithPassword(page, ADMIN);
  });

  test("third-party venue → cascade → save → band → provenance → 320px; then an owned venue shows nothing new", async ({
    page,
  }) => {
    // The draft is created with NO venue; the third-party venue is named here,
    // in the builder, where the "All venues" group and the cascade live.
    created.eventId = await startNewEvent(page, slugs.personal!, "E2E event-first request");
    await openVenuePicker(page);
    await page.getByPlaceholder('Search your places...').fill(THIRD_PARTY_NAME.slice(0, 24));
    await expect(page.getByTestId("place-picker-group-all")).toBeVisible();
    await page.getByTestId(`place-picker-all-${THIRD_PARTY_ID}`).click();

    // Direction A: the cascade, with "Play here" selected by default.
    const cascade = page.getByTestId("venue-booking-cascade");
    await expect(cascade).toBeVisible();
    const intents = page.getByRole("radiogroup", { name: "Book this place for" });
    await expect(intents).toBeVisible();
    await expect(intents.getByRole("radio", { name: "Play here" })).toBeChecked();
    // This venue only takes performances: the other two intents are disabled, not hidden.
    await expect(intents.getByRole("radio", { name: "Rent a space" })).toBeDisabled();
    await expect(intents.getByRole("radio", { name: "Use a space" })).toBeDisabled();
    await expect(cascade.getByRole("combobox", { name: "Calendar" })).toBeVisible();

    // Save: the band must appear from the mutation result, without a reload.
    // Instrumented: capture the save call and its response so a miss is diagnosable.
    const saveBtn = page.getByTestId("event-save-btn");
    await expect(saveBtn).toBeEnabled();
    const saveResponse = page.waitForResponse(
      (r) => /trpc\/.*(createEventFor|updateEventFor|saveEventFor)/.test(r.url()),
      { timeout: 30_000 },
    );
    await saveBtn.click();
    const res = await saveResponse;
    const reqBody = res.request().postData() ?? "";
    const keys = (reqBody.match(/"(calendarId|spaceId|bookingIntent|eventId)"/g) ?? []).join(",");
    const body = await res.text();
    const brIdx = body.indexOf("bookingRequest");
    console.log(`[drive] save ${res.status()} ${res.url().split("/trpc/")[1]?.slice(0, 60)} | sent keys: ${keys || "(none of calendarId/spaceId/bookingIntent)"} | bookingRequest: ${brIdx >= 0 ? body.slice(brIdx, brIdx + 220) : "(absent)"} | error: ${body.includes('"error"') ? body.slice(body.indexOf('"error"'), body.indexOf('"error"') + 200) : "none"}`);
    expect(res.status(), "save responded 2xx").toBeLessThan(300);
    const headline = page.getByTestId("event-provenance-note-band-headline");
    await expect(headline).toBeVisible({ timeout: 15_000 });
    await expect(headline).toContainText(THIRD_PARTY_NAME);
    const threadLink = page.getByTestId("event-provenance-note-thread-link");
    await expect(threadLink).toBeVisible();

    // Capture ids for cleanup: the event from the URL, the request from the link.
    await expect(page).toHaveURL(/\/events\/([0-9a-f-]{36})/);
    created.eventId = page.url().match(/\/events\/([0-9a-f-]{36})/)?.[1] ?? null;
    const href = (await threadLink.getAttribute("href")) ?? "";
    created.requestId = href.match(/request=([0-9a-f-]{36})/)?.[1] ?? null;
    expect(created.eventId, "event id captured").toBeTruthy();
    expect(created.requestId, "request id captured from the thread link").toBeTruthy();

    // Reload: the band must come back from provenance, not the save result.
    await page.reload();
    await expect(page.getByTestId("event-provenance-note-band-headline")).toContainText(THIRD_PARTY_NAME, {
      timeout: 15_000,
    });
    // The stored placement hydrates: the cascade shows and "Play here" is still selected.
    await expect(page.getByTestId("venue-booking-cascade")).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "Book this place for" }).getByRole("radio", { name: "Play here" }),
    ).toBeChecked();

    // 320px: no horizontal overflow on the page, the band or the cascade.
    await page.setViewportSize({ width: 320, height: 720 });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      band: (() => {
        const el = document.querySelector('[data-testid="event-provenance-note"]');
        return el ? el.scrollWidth - el.clientWidth : 0;
      })(),
      cascade: (() => {
        const el = document.querySelector('[data-testid="venue-booking-cascade"]');
        return el ? el.scrollWidth - el.clientWidth : 0;
      })(),
    }));
    expect(overflow.page, "page has no horizontal scroll at 320").toBeLessThanOrEqual(0);
    expect(overflow.band, "band has no horizontal overflow at 320").toBeLessThanOrEqual(0);
    expect(overflow.cascade, "cascade has no horizontal overflow at 320").toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 900 });

    // ── Part 2: an OWNED venue in the org admin → nothing new ──────────────
    // This test creates a draft via quick-create as well; it is deleted in afterAll.
    // An owned venue CAN still be picked at quick-create — that path stays exercised here.
    ownedDraftId = await startNewEvent(page, slugs.org!, "E2E owned venue", PARAMOUNT_NAME);
    // The Paramount is already the venue (chosen in quick-create, owned by this org).

    // Give the authority read time to settle, then assert the negative space.
    await expect(page.getByTestId("venue-booking-loading")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("venue-booking-cascade")).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Book this place for" })).toHaveCount(0);
    await expect(page.getByTestId("event-provenance-note")).toHaveCount(0);

    // ── Part 3: a third-party venue with NO opening hours → refused, the event still saves ──
    // Owner ruling 2026-09-08: surface the skip in the builder. The venue
    // refuses PERFORM at the gate walk (`booking_requests_unconfigured`); the
    // save returns 2xx with `bookingRequest.outcome === "skipped"` and the
    // notice — not the band — appears under the cascade.
    skipDraftId = await startNewEvent(page, slugs.personal!, "E2E event-first skip (no hours)");
    await openVenuePicker(page);
    await page.getByPlaceholder("Search your places...").fill("Stubb");
    await expect(page.getByTestId("place-picker-group-all")).toBeVisible();
    await page.getByTestId(`place-picker-all-${NO_HOURS_ID}`).click();
    await expect(page.getByTestId("venue-booking-cascade")).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "Book this place for" }).getByRole("radio", { name: "Play here" }),
    ).toBeChecked();

    const skipSaveBtn = page.getByTestId("event-save-btn");
    await expect(skipSaveBtn).toBeEnabled();
    const skipSaveResponse = page.waitForResponse(
      (r) => /trpc\/.*(createEventFor|updateEventFor|saveEventFor)/.test(r.url()),
      { timeout: 30_000 },
    );
    await skipSaveBtn.click();
    const skipRes = await skipSaveResponse;
    const skipBody = await skipRes.text();
    const skipIdx = skipBody.indexOf("bookingRequest");
    console.log(`[drive] skip save ${skipRes.status()} | bookingRequest: ${skipIdx >= 0 ? skipBody.slice(skipIdx, skipIdx + 260) : "(absent)"}`);
    expect(skipRes.status(), "save responded 2xx despite the refused ask").toBeLessThan(300);

    const notice = page.getByTestId("event-first-skip-notice");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveAttribute("data-code", "PLACE_NOT_ACCEPTING_REQUESTS");
    const noticeHeadline = page.getByTestId("event-first-skip-notice-headline");
    await expect(noticeHeadline).toContainText(NO_HOURS_NAME);
    await expect(noticeHeadline).toContainText("wasn’t sent");
    await expect(page.getByTestId("event-first-skip-notice-status")).toHaveAttribute("role", "status");
    // A refused ask is not a request: no band, no thread link.
    await expect(page.getByTestId("event-provenance-note")).toHaveCount(0);
    await expect(page.getByTestId("event-provenance-note-thread-link")).toHaveCount(0);

    // 320px: neither the page nor the notice overflows.
    await page.setViewportSize({ width: 320, height: 720 });
    await page.waitForTimeout(300);
    const skipOverflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      notice: (() => {
        const el = document.querySelector('[data-testid="event-first-skip-notice"]');
        return el ? el.scrollWidth - el.clientWidth : 0;
      })(),
    }));
    expect(skipOverflow.page, "page has no horizontal scroll at 320 with the notice").toBeLessThanOrEqual(0);
    expect(skipOverflow.notice, "notice has no horizontal overflow at 320").toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 900 });

    // A fresh attempt clears it — WITHOUT leaving place mode, so this fails
    // on a snapshot regression rather than on the branch unmounting: move
    // the start date one day (a snapshot input; the builder does not
    // autosave, so nothing is sent) and the notice must go while the
    // cascade stays.
    const startsAtInput = page
      .locator('input[data-testid="event-starts-at"], [data-testid="event-starts-at"] input')
      .first();
    const currentStart = await startsAtInput.inputValue();
    expect(currentStart, "start date read back from the builder").toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await startsAtInput.fill(nextDayLocal(currentStart));
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId("venue-booking-cascade")).toBeVisible();
    // Second check: leaving the venue (Address mode drops the placement)
    // keeps it gone.
    await page.getByTestId("location-mode-address").click();
    await expect(notice).toHaveCount(0);

    // Reload: nothing renders. A refusal leaves no request row, so the
    // provenance read has nothing to report — expected, not a gap.
    await page.reload();
    await expect(page.getByTestId("event-title")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("event-first-skip-notice")).toHaveCount(0);
    await expect(page.getByTestId("event-provenance-note")).toHaveCount(0);
  });

  test.afterAll(async ({ request }) => {
    if (!created.eventId && !created.requestId && !ownedDraftId && !skipDraftId) return;
    const { token } = await signInAndGetToken(request, API_BASE_URL, ADMIN);
    const trpc = createE2eTrpcClient(request, API_BASE_URL, { bearerToken: token });
    if (created.requestId) {
      await trpc.bookingRequests.withdraw
        .mutate({ bookingRequestId: created.requestId })
        .catch((err: unknown) => console.warn("[cleanup] withdraw failed", err));
    }
    for (const eventId of [created.eventId, ownedDraftId, skipDraftId]) {
      if (!eventId) continue;
      await trpc.events.deleteEvent
        .mutate({ eventId })
        .catch((err: unknown) => console.warn("[cleanup] deleteEvent failed", eventId, err));
    }
  });
});
