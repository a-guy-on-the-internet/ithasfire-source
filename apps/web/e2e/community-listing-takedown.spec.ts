import { request as pwRequest } from "@playwright/test";

import { expect, test } from "./fixtures";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";

/**
 * Taking a community listing down, as the platform ADMIN does it: one "Take
 * down listing" action (`cancelEvent`) from the community editor's `⋯` menu.
 * Held: every remaining night is called off (the per-night RSVPers' notices
 * are core's tests), the row leaves the default `/platform/community-listings`
 * view, lists under the Cancelled filter, and carries no take-down button
 * there. The button appears only where the server would accept it.
 *

 * ── LIVE STACK ONLY ──────────────────────────────────────────────────────
 *
 * `/platform` and the take-down mutations need a second factor; locally the
 * API's `DEV_BYPASS_STAFF_2FA` stands in for one (see
 * `moderate-listing-schedule.spec.ts`).
 *
 * ── WHAT A RUN LEAVES BEHIND ─────────────────────────────────────────────
 *
 * One CANCELLED listing, and two cancelled per-night RSVPs by the MXN dev
 * user. A failed run leaves the listing at whatever step it reached; the
 * afterAll takes it down (cancel, then archive) through the same use cases.
 */

const API = process.env.E2E_API_BASE_URL || "http://localhost:3001";
/** `apps/api/src/scripts/seed/ids.ts`. */
const ADMIN = { email: "admin@ithasfire.com", password: "Dev-Login-2026!" };
const ATTENDEE = {
  email: "dev-login-mxn@ithasfire.local",
  password: "Dev-Login-MXN-2026!",
};
/** `place2`, a seeded Chicago place. */
const PLACE_ID = "00000000-0000-4000-8000-00000000d031";
const TZ = "America/Chicago";

test.describe.serial("community listing take-down", () => {
  test.skip(
    process.env.E2E_USE_LIVE_STACK !== "1",
    "needs the local API's DEV_BYPASS_STAFF_2FA; live stack only",
  );
  test.slow();
  test.use({ storageState: { cookies: [], origins: [] } });

  const title = `E2E takedown ${Date.now()}`;
  let eventId: string | null = null;
  let adminToken: string | null = null;

  test.afterAll(async () => {
    if (!eventId || !adminToken) return;
    const ctx = await pwRequest.newContext();
    const trpc = createE2eTrpcClient(ctx, API, { bearerToken: adminToken });
    await trpc.events.cancelEvent
      .mutate({ eventId, clientKey: `e2e-takedown-teardown-${eventId}` })
      .catch(() => undefined);
    await trpc.events.archiveEvent.mutate({ eventId }).catch(() => undefined);
    await ctx.dispose();
  });

  test("take down from the editor, then find it under Cancelled on /platform", async ({ page }) => {
    ({ token: adminToken } = await signInAndGetToken(page.request, API, ADMIN));
    const admin = createE2eTrpcClient(page.request, API, {
      bearerToken: adminToken,
    });

    // A published weekly listing, nights from next week on.
    const dtstart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    dtstart.setUTCHours(2, 0, 0, 0);
    const created = await admin.community.createListing.mutate({
      title,
      startsAt: dtstart,
      endsAt: new Date(dtstart.getTime() + 2 * 60 * 60 * 1000),
      timezone: TZ,
      placeId: PLACE_ID,
      recurrenceSchedule: {
        kind: "RRULE",
        rrule: "FREQ=WEEKLY",
        dtstart: dtstart.toISOString(),
      },
      status: "DRAFT",
    });
    eventId = created.event.id;
    await admin.community.publishListing.mutate({ eventId });

    // Someone RSVPs to the first two nights.
    const before = await admin.community.listEventDates.query({ eventId });
    const nights = before.dates.filter((d) => d.status === "SCHEDULED");
    expect(nights.length).toBeGreaterThan(2);
    const attendeeCtx = await pwRequest.newContext();
    const { token: attendeeToken } = await signInAndGetToken(
      attendeeCtx,
      API,
      ATTENDEE,
    );
    const attendee = createE2eTrpcClient(attendeeCtx, API, {
      bearerToken: attendeeToken,
    });
    for (const night of nights.slice(0, 2)) {
      await attendee.community.rsvpToDate.mutate({
        eventDateId: night.eventDateId,
      });
    }
    // ...and suggests an edit, still PENDING when the listing comes down.
    await attendee.eventSuggestions.submit.mutate({
      eventId,
      fields: { title: `${title} (renamed)` },
    });
    await attendeeCtx.dispose();

    // /platform lists it, with Take down.
    await page.goto("/platform/community-listings");
    await page.getByRole("searchbox").or(page.getByRole("textbox")).first().fill(title);
    const takeDownOnPlatform = page.getByRole("button", {
      name: `Take down listing: ${title}`,
    });
    await expect(takeDownOnPlatform).toBeVisible({ timeout: 30_000 });
    // The title search narrows the list to this one listing.
    await expect(
      page.getByRole("button", { name: /^Take down listing: / }),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.screenshot({
      path: test.info().outputPath("platform-published.png"),
      fullPage: true,
    });

    // Edit opens the community editor; Take down listing is in its ⋯ menu.
    await page.getByRole("link", { name: `Edit: ${title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/events/${eventId}/edit`));
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Take down listing" }).click();
    await page.getByTestId("event-listing-takedown-confirm-btn").click();
    // The listing is CANCELLED now: the menu no longer offers the action.
    await expect
      .poll(
        async () => {
          const res = await admin.community.listEventDates.query({ eventId: eventId! });
          return res.dates.filter((d) => d.status === "SCHEDULED").length;
        },
        { timeout: 30_000 },
      )
      .toBe(0);
    // The menu no longer offers the action.
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Take down listing" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: test.info().outputPath("editor-taken-down.png"),
    });

    // Every remaining night is off.
    const after = await admin.community.listEventDates.query({ eventId });
    expect(after.dates.filter((d) => d.status === "SCHEDULED")).toHaveLength(0);

    // /platform at 320px: gone from the default view, under Cancelled.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/platform/community-listings");
    await page.getByRole("searchbox").or(page.getByRole("textbox")).first().fill(title);
    // Wait for the filtered table to settle before asserting absence.
    await expect(page.getByText("No listings match.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("link", { name: `Edit: ${title}` }),
    ).toHaveCount(0, { timeout: 30_000 });

    await page
      .locator("#community-listings-status")
      .selectOption({ value: "CANCELLED" });
    const editLink = page.getByRole("link", { name: `Edit: ${title}` });
    await expect(editLink).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: /^Take down listing: / }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    // The platform panel scrolls inside the shell, so a full-page shot
    // misses the rows: bring the row into view and shoot the viewport.
    await editLink.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("platform-cancelled-320.png"),
    });

    // The schedule page says the listing is down and offers no Put back and
    // no rule change.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/moderate/listings/${eventId}/schedule`);
    await expect(page.getByTestId("schedule-closed-notice")).toHaveText(
      /taken down/i,
      { timeout: 30_000 },
    );
    await expect(page.getByRole("button", { name: /^Put .* back on$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change rule" })).toHaveCount(0);
    await expect(page.getByTestId("schedule-consequence")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("schedule-taken-down.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("schedule-taken-down-320.png"),
      fullPage: true,
    });

    // The suggestion on it is labelled, and only Reject is offered.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/moderate/suggestions");
    const row = page.getByText(title, { exact: false }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(page.getByText("TAKEN DOWN").first()).toBeVisible();
    await expect(
      page.getByText("The listing is over, so this can only be rejected."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("suggestions-taken-down.png"),
      fullPage: true,
    });
    // Close it out, so the queue is left as it was found.
    await page.getByRole("button", { name: "Reject" }).click();
    await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0, {
      timeout: 30_000,
    });
  });
});
