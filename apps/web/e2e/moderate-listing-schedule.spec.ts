import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";

/**
 * `/moderate/listings/[eventId]/schedule` against a weekly community listing
 * with no end date, stored the way production holds one: the rule's `dtstart`
 * on a Thursday already past, the listing's `startsAt` on the next one,
 * because the server re-pins `Event.startsAt` to the next upcoming night and
 * never moves the stored anchor. Two things are held: CHANGE RULE opens the
 * editor on that stored rule, and the editor does the job it exists for —
 * giving an open-ended listing an end date, which takes every later night off.
 *
 * ── LIVE STACK ONLY ──────────────────────────────────────────────────────
 *
 * `/moderate` needs a second factor. Locally the API's `DEV_BYPASS_STAFF_2FA`
 * stands in for one; the CI e2e job boots the API with no env file and no
 * such flag, so there the gate sends the admin to `/enroll-2fa` and this spec
 * could not get past it. Hence the skip below, and the readable failure in
 * `openSchedule` when the flag is missing locally.
 *
 * ── WHAT A RUN LEAVES BEHIND ─────────────────────────────────────────────
 *
 * ONE CANCELLED listing per test. Each test creates a never-published DRAFT
 * through `community.createListing` at a seeded place and takes it down
 * afterwards through `events.cancelEvent`, the ADMIN takedown. There is no
 * supported hard delete for it: `events.deleteEvent` refuses an ownerless
 * community listing (NOT_RESOURCE_OWNER), and the owner ruled 2026-10-14 that
 * removing a listing means cancel then archive. It never calls
 * `resetE2eState`.
 *
 * Project-agnostic: it signs in as the seeded admin itself and starts from an
 * empty storage state, so it runs the same under `chromium` and `guest`.
 */

const API = process.env.E2E_API_BASE_URL || "http://localhost:3001";
/** `apps/api/src/scripts/seed/ids.ts` — the seeded platform admin. */
const ADMIN = { email: "admin@ithasfire.com", password: "Dev-Login-2026!" };
/** `place2` in `apps/api/src/scripts/seed/ids.ts`, a seeded Chicago place. */
const PLACE_ID = "00000000-0000-4000-8000-00000000d031";
const TZ = "America/Chicago";
/** Nights the bounding test keeps; every later one comes off. */
const KEPT = 4;

/** Wall-clock parts of an instant on the Chicago calendar. */
function chicagoParts(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") };
}

/** The instant of 21:00 Chicago wall time on a Chicago calendar date. */
function chicagoNinePm(y: number, m: number, d: number): Date {
  // Chicago is UTC-5 (CDT) or UTC-6 (CST); keep the offset that reads back as
  // 21:00 on the same date.
  for (const offset of [5, 6]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, 21 + offset));
    const p = chicagoParts(candidate);
    if (p.y === y && p.m === m && p.d === d && p.h === 21) return candidate;
  }
  throw new Error(`no 21:00 on ${y}-${m}-${d} in ${TZ}`);
}

/**
 * The most recent Thursday 21:00 Chicago strictly before `now`. Walked on the
 * Chicago CALENDAR (date arithmetic at UTC noon, never a 24-hour subtraction
 * from an instant, which DST would knock an hour off), so on a Thursday
 * before 21:00 it is the Thursday a week back, never today.
 */
function lastThursdayNinePmChicago(now: Date): Date {
  const today = chicagoParts(now);
  for (let back = 0; back <= 7; back++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d - back, 12));
    if (day.getUTCDay() !== 4) continue;
    const ninePm = chicagoNinePm(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
    );
    if (ninePm.getTime() < now.getTime()) return ninePm;
  }
  throw new Error("no past Thursday in the last eight days");
}

/** "YYYY-MM-DD" of an instant on the Chicago calendar. */
function chicagoDate(instant: Date): string {
  const p = chicagoParts(instant);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** The `datetime` instants of the listed dates, in page order. */
function listedInstants(page: Page): Promise<string[]> {
  return page
    .getByTestId("schedule-date-row")
    .locator("time")
    .evaluateAll((els) => els.map((el) => el.getAttribute("datetime")!));
}

/**
 * Open the schedule and return how many dates it lists. The count is READ,
 * never assumed: the server materialises a 12-month window from now, so a
 * weekly rule lists 52 or 53 nights depending on the day and the leap year.
 */
async function openSchedule(page: Page, eventId: string): Promise<number> {
  await page.goto(`/moderate/listings/${eventId}/schedule`);
  if (new URL(page.url()).pathname.startsWith("/enroll-2fa")) {
    throw new Error(
      "/moderate sent the seeded admin to /enroll-2fa: start the API with " +
        "DEV_BYPASS_STAFF_2FA=1 (apps/api/.env.local) to run this spec.",
    );
  }
  const rows = page.getByTestId("schedule-date-row");
  await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(
    KEPT,
  );
  return rows.count();
}

test.describe.serial("moderate listing schedule — weekly, no end", () => {
  test.skip(
    process.env.E2E_USE_LIVE_STACK !== "1",
    "needs the local API's DEV_BYPASS_STAFF_2FA; live stack only",
  );
  // Sign-in, a cold /moderate compile and an Apply share one budget.
  test.slow();
  // Signs in as the admin itself, whatever the project would have loaded.
  test.use({ storageState: { cookies: [], origins: [] } });

  let eventId: string | null = null;
  let token: string | null = null;

  /**
   * Signs in through the API on the PAGE's request context, which shares the
   * browser's cookie jar: the session lands in the browser and the bearer
   * token for the setup calls comes from the same sign-in. The sign-in form
   * is not what this spec is about, and driving it doubled the sign-ins per
   * test.
   */
  test.beforeEach(async ({ page }) => {
    ({ token } = await signInAndGetToken(page.request, API, ADMIN));
    const trpc = createE2eTrpcClient(page.request, API, {
      bearerToken: token,
    });
    const dtstart = lastThursdayNinePmChicago(new Date());
    const created = await trpc.community.createListing.mutate({
      title: `E2E weekly schedule ${Date.now()}`,
      startsAt: dtstart,
      endsAt: new Date(dtstart.getTime() + 2 * 60 * 60 * 1000),
      timezone: TZ,
      placeId: PLACE_ID,
      recurrenceSchedule: {
        kind: "RRULE",
        rrule: "FREQ=WEEKLY;BYDAY=TH",
        dtstart: dtstart.toISOString(),
      },
      // Never published: no hold notices owed at a shared place, and nothing
      // indexed for search.
      status: "DRAFT",
    });
    eventId = created.event.id;
  });

  /**
   * Takes the listing down (see WHAT A RUN LEAVES BEHIND). The id is cleared
   * first, so a failed takedown never hands the next test a stale one, and a
   * failure names the listing it left live rather than losing it.
   */
  test.afterEach(async ({ request }) => {
    const id = eventId;
    eventId = null;
    if (!id || !token) return;
    try {
      const trpc = createE2eTrpcClient(request, API, { bearerToken: token });
      await trpc.events.cancelEvent.mutate({
        eventId: id,
        clientKey: `e2e-schedule-teardown-${id}`,
      });
    } catch (err) {
      console.error(`[e2e] listing ${id} was not removed:`, err);
      throw err;
    }
  });

  test("CHANGE RULE opens the editor on the stored rule", async ({ page }) => {
    await openSchedule(page, eventId!);

    const changeRule = page.getByTestId("schedule-change-rule");
    await changeRule.click();
    await expect(page.getByTestId("schedule-rule-editor")).toBeVisible();
    await expect(changeRule).toHaveAttribute("aria-expanded", "true");
    // Prefilled from the stored rule, so untouched it drops nothing.
    await expect(page.getByTestId("recurrence-end-never")).toBeChecked();
    await expect(page.getByTestId("schedule-would-drop")).toContainText(
      "No date now on this schedule would come off.",
    );

    // Same element, swapped role: pressing it again discards.
    await changeRule.click();
    await expect(page.getByTestId("schedule-rule-editor")).toHaveCount(0);
    await expect(changeRule).toHaveAttribute("aria-expanded", "false");
  });

  test("an end date drops every later date, and Apply takes them off", async ({
    page,
  }) => {
    const total = await openSchedule(page, eventId!);
    const instants = await listedInstants(page);
    expect(instants).toHaveLength(total);
    // End the series on the last night kept.
    const lastKept = chicagoDate(new Date(instants[KEPT - 1]!));

    await page.getByTestId("schedule-change-rule").click();
    await page.getByTestId("recurrence-end-on").check();
    await page.getByTestId("recurrence-until").fill(lastKept);

    await expect(page.getByTestId("schedule-would-drop")).toContainText(
      `${total - KEPT} of the ${total} dates now on this schedule would come off.`,
    );
    await expect(
      page.locator('[data-testid="schedule-date-row"][data-doomed="true"]'),
    ).toHaveCount(total - KEPT);

    await page.getByTestId("schedule-apply").click();
    // ConfirmDialog renders no test ids; its confirm is the dialog's button.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Apply new rule" })
      .click();

    // The editor closes on success and the list is re-read.
    await expect(page.getByTestId("schedule-rule-editor")).toHaveCount(0);
    await expect(page.getByTestId("schedule-date-row")).toHaveCount(KEPT);
    expect(await listedInstants(page)).toEqual(instants.slice(0, KEPT));

    // And the stored rule carries the end.
    const trpc = createE2eTrpcClient(page.request, API, {
      bearerToken: token!,
    });
    const read = await trpc.community.listEventDates.query({
      eventId: eventId!,
    });
    expect(read.recurrence?.until).toBeTruthy();
    expect(chicagoDate(new Date(read.recurrence!.until!))).toBe(lastKept);
  });
});
