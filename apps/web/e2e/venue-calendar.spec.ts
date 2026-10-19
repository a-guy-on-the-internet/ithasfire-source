// Venue calendar — the PLACE mount of the redesigned calendar engine.
//
// docs/specs/2026-09-02/completed/event-calendar-redesign.spec.yaml, phase 4:
//
//   "apps/web/e2e/venue-calendar.spec.ts, week default, calendar selector,
//    hours window, peek actions, hold chips."
//
// The engine is one component mounted three ways; the unit tests cover it in
// isolation with the design system mocked away. What only a real browser can
// answer is whether the PLACE mount wires it up: that the venue's own zone
// paints the grid, that the toolbar's calendar selector actually re-scopes
// both the events and the hours window, that a chip press opens a peek beside
// itself, and that a booking hold reaches the grid as a dashed chip with its
// line intact.
//
// ── Running it (LIVE STACK, NON-DESTRUCTIVE) ────────────────────────────────
//
//   cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test \
//     e2e/venue-calendar.spec.ts --project=chromium --reporter=list --workers=1
//
// ── State discipline ────────────────────────────────────────────────────────
// This spec NEVER calls `resetE2eState` (it used to). That helper POSTs
// /e2e/reset, which deletes every order, event, place, org and auth user in
// whatever database the API points at — so under `E2E_USE_LIVE_STACK=1` it
// refuses to run at all, and the old spec could not be run against a live
// stack. Instead it mints its own org + venue + rooms + calendars + hours +
// events + booking holds through `/e2e/seed/venue-calendar` and deletes all of
// it in `afterAll` (which runs on failure too, and asserts the teardown
// landed). Nothing it touches is reachable from any other fixture.
//
// Serial, because every test shares one fixture and the project is
// `fullyParallel`.
import { expect, test } from "./fixtures";

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
  "playwright-setup@example.com";

const e2eHeaders = {
  "x-e2e-reset-secret": E2E_SECRET,
  "content-type": "application/json",
};

interface VenueCalendarSeed {
  humanId: string;
  orgId: string;
  orgSlug: string;
  placeId: string;
  placeName: string;
  /** The VENUE's IANA zone — the engine's paint zone on this surface. */
  timezone: string;

  mainCalendarId: string;
  mainCalendarName: string;
  backCalendarId: string;
  backCalendarName: string;
  mainSpaceId: string;
  backSpaceId: string;
  defaultStartTime: string;
  /** Rendered hours span per scope, e.g. "5:00 PM – 11:00 PM". */
  hoursMain: string;
  hoursBack: string;
  hoursAll: string;

  eventTodayId: string;
  eventTodayTitle: string;
  eventTodayDateKey: string;
  eventTomorrowId: string;
  eventTomorrowDateKey: string;
  eventFutureId: string;
  eventFutureDateKey: string;
  conflictAId: string;
  conflictBId: string;
  conflictDateKey: string;
  cancelledEventId: string;
  cancelledDateKey: string;

  seriesId: string;
  seriesName: string;
  seriesEvent1Id: string;
  seriesEvent1DateKey: string;
  seriesEvent2Id: string;
  seriesEvent2DateKey: string;

  activeHoldDateKey: string;
  holdActive1Id: string;
  holdActive1Title: string;
  holdActive2Id: string;
  holdActive2Title: string;
  challengedHoldDateKey: string;
  challengedHoldId: string;
  challengedHoldTitle: string;
  holdBookingRequestId: string;

  eventCount: number;
}

/** The engine keys a chip by ITEM id — an event item is `${eventId}:${occurrence}`. */
const eventChip = (eventId: string) => `calendar-event-chip-${eventId}:0`;
const holdChip = (holdId: string) => `calendar-hold-chip-${holdId}`;

test.describe.configure({ mode: "serial" });

test.describe("Venue calendar (place mount)", () => {
  let seed: VenueCalendarSeed;

  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  test.beforeAll(async ({ request }) => {
    // Admin gates need a verified email. Best-effort: auth.setup already does
    // this, and a long-lived dev database may have drifted.
    await request
      .post(`${API_BASE_URL}/e2e/auth/verify-email`, {
        headers: e2eHeaders,
        data: { email: TEST_EMAIL },
      })
      .catch(() => undefined);

    const res = await request.post(`${API_BASE_URL}/e2e/seed/venue-calendar`, {
      headers: e2eHeaders,
      data: { email: TEST_EMAIL },
    });
    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();

    seed = (await res.json()).seed as VenueCalendarSeed;
    expect(seed.orgSlug).toBeTruthy();
    expect(seed.placeId).toBeTruthy();
    expect(seed.mainCalendarId).toBeTruthy();
    expect(seed.holdActive1Id).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (!seed?.orgId) return;
    const res = await request.post(
      `${API_BASE_URL}/e2e/seed/venue-calendar/cleanup`,
      { headers: e2eHeaders, data: { orgId: seed.orgId, placeId: seed.placeId } },
    );
    // Teardown is the whole reason this spec is safe against a live dev
    // database — assert it rather than firing and forgetting.
    expect(res.ok(), `Cleanup failed: ${await res.text()}`).toBeTruthy();
  });

  /** `?view=…&date=…` — the place mount's URL state (FR-015). */
  function calendarUrl(query?: Record<string, string>) {
    const base = `/admin/${seed.orgSlug}/places/${seed.placeId}/calendar`;
    const search = query ? new URLSearchParams(query).toString() : "";
    return search ? `${base}?${search}` : base;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE SHELL
  // ═══════════════════════════════════════════════════════════════════════

  test("renders the calendar page, its heading and the engine", async ({
    page,
  }) => {
    await page.goto(calendarUrl());

    await expect(
      page.getByRole("heading", { name: "Place Calendar" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Back to place" }),
    ).toBeVisible();
    await expect(page.getByTestId("venue-calendar-place")).toHaveText(
      seed.placeName,
    );

    const calendar = page.getByTestId("event-calendar");
    await expect(calendar).toBeVisible();
    await expect(calendar).toHaveAttribute("data-mode", "internal");
    await expect(page.getByTestId("venue-calendar-event-count")).toBeVisible();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FR-007 / FR-008 — views
  // ═══════════════════════════════════════════════════════════════════════

  test("opens in WEEK view and offers month / week / agenda — day view is gone", async ({
    page,
  }) => {
    await page.goto(calendarUrl());

    // FR-008: the place mount's default.
    const calendar = page.getByTestId("event-calendar");
    await expect(calendar).toHaveAttribute("data-view", "week");
    await expect(page.getByTestId("calendar-week-grid")).toBeVisible();

    const toggle = page.getByTestId("calendar-view-mode-toggle");
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId("calendar-view-month")).toBeVisible();
    await expect(page.getByTestId("calendar-view-week")).toBeVisible();
    await expect(page.getByTestId("calendar-view-agenda")).toBeVisible();
    // FR-007: deleted, not hidden.
    await expect(page.getByTestId("calendar-view-day")).toHaveCount(0);

    await page.getByTestId("calendar-view-month").click();
    await expect(page.getByTestId("calendar-month-grid")).toBeVisible();
    await expect(calendar).toHaveAttribute("data-view", "month");
    // FR-015: the place persists view in the URL, not localStorage.
    await expect(page).toHaveURL(/[?&]view=month/);

    await page.getByTestId("calendar-view-agenda").click();
    await expect(page.getByTestId("calendar-agenda")).toBeVisible();
    // FR-009: agenda rolls from the anchor, so no prev/next arrows.
    await expect(page.getByTestId("calendar-nav-prev")).toHaveCount(0);
    await expect(page.getByTestId("calendar-nav-next")).toHaveCount(0);

    await page.getByTestId("calendar-view-week").click();
    await expect(page.getByTestId("calendar-week-grid")).toBeVisible();
    await expect(page.getByTestId("calendar-nav-prev")).toBeVisible();
  });

  test("a stale ?view=day link lands on the week default instead of erroring", async ({
    page,
  }) => {
    // FR-007's migration note: an old bookmarked day link has nowhere to go.
    await page.goto(calendarUrl({ view: "day" }));
    await expect(page.getByTestId("event-calendar")).toHaveAttribute(
      "data-view",
      "week",
    );
    await expect(page.getByTestId("calendar-week-grid")).toBeVisible();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FR-012 / FR-005 / FR-011 — the calendar selector and the hours window
  // ═══════════════════════════════════════════════════════════════════════

  test("the calendar selector re-scopes the events AND the week's hours window", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "week", date: seed.eventTodayDateKey }),
    );

    const caption = page.getByTestId("calendar-hours-caption");
    const picker = page.getByTestId("venue-calendar-picker");
    const todayChip = page.getByTestId(eventChip(seed.eventTodayId));

    // "All calendars" is the default scope: FR-005's union across both
    // calendars' hours (12:00 open from the back bar, 23:00 close from the
    // main room), painted in the VENUE's zone (FR-018).
    await expect(todayChip).toBeVisible({ timeout: 20_000 });
    await expect(caption).toHaveText(
      `Hours · All calendars · ${seed.hoursAll} · ${seed.timezone}`,
    );
    await expect(picker).toHaveValue("all");

    // One calendar in scope: its own hours, and its own events.
    await picker.selectOption(seed.mainCalendarId);
    await expect(page).toHaveURL(
      new RegExp(`[?&]calendar=${seed.mainCalendarId}`),
    );
    await expect(caption).toHaveText(
      `Hours · ${seed.mainCalendarName} · ${seed.hoursMain} · ${seed.timezone}`,
    );
    await expect(todayChip).toBeVisible();

    // The other calendar has hours but no events — the grid empties and the
    // heading count follows, which is the observable half of FR-012.
    await picker.selectOption(seed.backCalendarId);
    await expect(caption).toHaveText(
      `Hours · ${seed.backCalendarName} · ${seed.hoursBack} · ${seed.timezone}`,
    );
    await expect(todayChip).toHaveCount(0);
    await expect(page.getByTestId("venue-calendar-event-count")).toHaveText(
      "0 events",
    );

    // …and back to the union.
    await picker.selectOption("all");
    await expect(page).not.toHaveURL(/[?&]calendar=/);
    await expect(caption).toHaveText(
      `Hours · All calendars · ${seed.hoursAll} · ${seed.timezone}`,
    );
    await expect(todayChip).toBeVisible();
  });

  test("'Show all hours' expands the week from the venue window to the full day", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "week", date: seed.eventTodayDateKey }),
    );
    const expander = page.getByTestId("calendar-show-all-hours");
    const hourLabels = page.getByTestId("calendar-hour-label");

    await expect(expander).toHaveAttribute("aria-pressed", "false");
    const venueRows = await hourLabels.count();
    // The union window is 12:00–23:00, i.e. well short of a full day.
    expect(venueRows).toBeGreaterThan(0);
    expect(venueRows).toBeLessThan(24);

    await expander.click();
    await expect(expander).toHaveAttribute("aria-pressed", "true");
    await expect(hourLabels).toHaveCount(24);

    // The link is always rendered and always reversible (FR-011).
    await expander.click();
    await expect(expander).toHaveAttribute("aria-pressed", "false");
    await expect(hourLabels).toHaveCount(venueRows);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FR-013 / FR-014 — chips and the peek
  // ═══════════════════════════════════════════════════════════════════════

  test("pressing an event chip opens the peek with its details and actions", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "month", date: seed.eventTodayDateKey }),
    );

    const chip = page.getByTestId(eventChip(seed.eventTodayId));
    await expect(chip).toBeVisible({ timeout: 20_000 });
    // The peek is a dialog, and the chip advertises it.
    await expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    await expect(chip).toHaveAttribute("aria-expanded", "false");

    await chip.click();
    const peek = page.getByRole("dialog");
    await expect(peek).toBeVisible();
    await expect(peek).toHaveAttribute("data-testid", "calendar-peek");
    await expect(peek).toHaveAttribute("data-kind", "event");
    await expect(chip).toHaveAttribute("aria-expanded", "true");

    await expect(peek.getByText(seed.eventTodayTitle)).toBeVisible();
    await expect(peek.getByTestId("calendar-peek-kicker")).toBeVisible();
    await expect(peek.getByTestId("calendar-status-tag")).toHaveText(
      "Published",
    );
    await expect(peek.getByText(seed.placeName)).toBeVisible();

    // FR-014's action row.
    await expect(peek.getByTestId("calendar-peek-edit")).toHaveAttribute(
      "href",
      `/admin/${seed.orgSlug}/events/${seed.eventTodayId}/edit`,
    );
    await expect(peek.getByTestId("calendar-peek-public")).toBeVisible();
    await expect(peek.getByTestId("calendar-peek-copy")).toBeVisible();
    await expect(peek.getByTestId("calendar-peek-ics")).toBeVisible();

    // Escape closes it and focus returns to the chip.
    await page.keyboard.press("Escape");
    await expect(peek).toHaveCount(0);
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(chip).toBeFocused();
  });

  test("Edit on a series occurrence points at the series editor", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "month", date: seed.seriesEvent1DateKey }),
    );

    const chip = page.getByTestId(eventChip(seed.seriesEvent1Id));
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await chip.click();

    const peek = page.getByTestId("calendar-peek");
    await expect(peek).toBeVisible();
    await expect(peek.getByTestId("calendar-peek-series")).toHaveText(
      seed.seriesName,
    );
    await expect(peek.getByTestId("calendar-peek-series")).toHaveAttribute(
      "href",
      `/admin/${seed.orgSlug}/events/${seed.seriesEvent1Id}/dates`,
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FR-016 — hold chips
  // ═══════════════════════════════════════════════════════════════════════

  test("an ACTIVE hold paints a dashed chip carrying its place in the line", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "month", date: seed.activeHoldDateKey }),
    );

    const first = page.getByTestId(holdChip(seed.holdActive1Id));
    const second = page.getByTestId(holdChip(seed.holdActive2Id));
    await expect(first).toBeVisible({ timeout: 20_000 });
    await expect(second).toBeVisible();

    await expect(first).toHaveAttribute("data-hold-status", "ACTIVE");
    await expect(first).toHaveAttribute("data-kind", "hold");
    await expect(first).toHaveCSS("border-style", "dashed");
    await expect(
      page.getByTestId(`${holdChip(seed.holdActive1Id)}-row`),
    ).toHaveText("Hold · #1");
    await expect(
      page.getByTestId(`${holdChip(seed.holdActive2Id)}-row`),
    ).toHaveText("Hold · #2");
    await expect(first).toContainText(seed.holdActive1Title);

    // The heading's hold tag counts the same set.
    await expect(page.getByTestId("venue-calendar-hold-count")).toBeVisible();
  });

  test("a CHALLENGED hold carries the warning treatment and its respond-by", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "month", date: seed.challengedHoldDateKey }),
    );

    const chip = page.getByTestId(holdChip(seed.challengedHoldId));
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(chip).toHaveAttribute("data-hold-status", "CHALLENGED");
    // The glyph is the accessible signal; the row carries "#1 · <respond by>".
    await expect(chip.getByRole("img", { name: "Challenged" })).toBeVisible();
    await expect(
      page.getByTestId(`${holdChip(seed.challengedHoldId)}-row`),
    ).toHaveText(/^#1 · .+/);
  });

  test("a hold peek is reduced to the line and Open booking — no Edit, no ICS", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "month", date: seed.activeHoldDateKey }),
    );

    const chip = page.getByTestId(holdChip(seed.holdActive1Id));
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await chip.click();

    const peek = page.getByTestId("calendar-peek");
    await expect(peek).toBeVisible();
    await expect(peek).toHaveAttribute("data-kind", "hold");

    // The WHOLE line for that date, in position order.
    const line = peek.getByTestId("calendar-peek-hold-line");
    await expect(line).toBeVisible();
    await expect(peek.getByTestId("calendar-peek-hold-1")).toContainText(
      seed.holdActive1Title,
    );
    await expect(peek.getByTestId("calendar-peek-hold-2")).toContainText(
      seed.holdActive2Title,
    );

    await expect(peek.getByTestId("calendar-peek-booking")).toBeVisible();
    // FR-014: confirm / release / challenge stay in the booking thread.
    await expect(peek.getByTestId("calendar-peek-edit")).toHaveCount(0);
    await expect(peek.getByTestId("calendar-peek-ics")).toHaveCount(0);
    await expect(peek.getByTestId("calendar-peek-copy")).toHaveCount(0);
  });

  test("switching holds off through the filter chip removes them and lands in the URL", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "month", date: seed.activeHoldDateKey }),
    );
    const chip = page.getByTestId(holdChip(seed.holdActive1Id));
    await expect(chip).toBeVisible({ timeout: 20_000 });

    const holdsChip = page.getByTestId("calendar-filter-holds");
    await expect(holdsChip).toHaveAttribute("aria-pressed", "true");
    await holdsChip.click();

    await expect(chip).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]holds=0/);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Conflicts + status filters
  // ═══════════════════════════════════════════════════════════════════════

  test("two events in one room on one night raise the double-booking badge", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "month", date: seed.conflictDateKey }),
    );

    const badge = page.getByTestId("venue-calendar-conflict-badge");
    await expect(badge).toBeVisible({ timeout: 20_000 });
    await expect(badge).toHaveText("1 double-booking");

    await expect(page.getByTestId(eventChip(seed.conflictAId))).toBeVisible();
    await expect(page.getByTestId(eventChip(seed.conflictBId))).toBeVisible();
  });

  test("CANCELLED is off by default and its status chip brings it back", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "month", date: seed.cancelledDateKey }),
    );

    const cancelledChip = page.getByTestId(eventChip(seed.cancelledEventId));
    // Something from the same window must be painted first, or "not visible"
    // would also pass on a calendar that never loaded.
    await expect(page.getByTestId("calendar-month-grid")).toBeVisible();
    await expect(page.getByTestId(eventChip(seed.eventFutureId))).toBeVisible({
      timeout: 20_000,
    });
    await expect(cancelledChip).toHaveCount(0);

    const filterChip = page.getByTestId("calendar-filter-status-cancelled");
    await expect(filterChip).toHaveAttribute("aria-pressed", "false");
    await filterChip.click();

    await expect(cancelledChip).toBeVisible();
    await expect(page).toHaveURL(/[?&]status=[^&]*cancelled/);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FR-017 — toolbar
  // ═══════════════════════════════════════════════════════════════════════

  test("prev / next / Today move the range label and come back", async ({
    page,
  }) => {
    await page.goto(
      calendarUrl({ view: "month", date: seed.eventTodayDateKey }),
    );

    const label = page.getByTestId("calendar-nav-label");
    await expect(label).toBeVisible();
    // `textContent`, never `innerText`: the label READS uppercase but that is
    // `text-transform`, and `toHaveText` compares the DOM text. Snapshotting
    // the rendered form and asserting against the DOM one never matches.
    const initial = (await label.textContent()) ?? "";

    await page.getByTestId("calendar-nav-next").click();
    await expect(label).not.toHaveText(initial);

    await page.getByTestId("calendar-nav-prev").click();
    await expect(label).toHaveText(initial);

    await page.getByTestId("calendar-nav-next").click();
    await page.getByTestId("calendar-nav-today").click();
    await expect(label).toHaveText(initial);
  });

  test("the overflow menu offers Subscribe and Export month", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(calendarUrl());

    await page.getByTestId("calendar-overflow").click();
    await expect(
      page.getByRole("menuitem", { name: "Copy subscribe link (English)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Copy subscribe link (Español)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /export month/i }),
    ).toBeVisible();

    await page
      .getByRole("menuitem", { name: "Copy subscribe link (English)" })
      .click();
    const english = await page.evaluate(() => navigator.clipboard.readText());
    expect(english).toMatch(
      new RegExp(`^webcal:.*/api/venues/${seed.placeId}/calendar\\.ics$`),
    );

    await page.getByTestId("calendar-overflow").click();
    await page
      .getByRole("menuitem", { name: "Copy subscribe link (Español)" })
      .click();
    const spanish = await page.evaluate(() => navigator.clipboard.readText());
    expect(spanish).toBe(`${english}?lang=es`);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FR-010 — the 600px collapse
  // ═══════════════════════════════════════════════════════════════════════

  test("below 600px the month becomes a dot grid plus the tapped day's list, and week is gone", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(
      calendarUrl({ view: "month", date: seed.eventTodayDateKey }),
    );

    await expect(page.getByTestId("calendar-month-dotgrid")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("calendar-month-grid")).toHaveCount(0);
    // Week is hidden outright below 600px, with no fallback rendering.
    await expect(page.getByTestId("calendar-view-week")).toHaveCount(0);
    await expect(page.getByTestId("calendar-view-month")).toBeVisible();
    await expect(page.getByTestId("calendar-view-agenda")).toBeVisible();
    // The chip row collapses to one trigger at this width.
    await expect(page.getByTestId("calendar-filters-menu")).toBeVisible();

    // Tapping a day re-points the list beneath the grid.
    const list = page.getByTestId("calendar-day-list");
    await expect(list).toBeVisible();
    await page.getByTestId(`calendar-dot-${seed.eventTomorrowDateKey}`).click();
    await expect(
      list.getByTestId(`calendar-day-list-row-${seed.eventTomorrowId}:0`),
    ).toBeVisible();
    await expect(
      list.getByTestId(`calendar-day-list-row-${seed.eventTodayId}:0`),
    ).toHaveCount(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FR-013 / FR-018 — the timezone-mismatch signal
  // ═══════════════════════════════════════════════════════════════════════

  test.describe("viewed from another timezone", () => {
    test.use({ timezoneId: "Europe/London" });

    test("the chip flags the mismatch and the peek names the venue-local time", async ({
      page,
    }) => {
      await page.goto(
        calendarUrl({ view: "month", date: seed.eventTodayDateKey }),
      );

      const chip = page.getByTestId(eventChip(seed.eventTodayId));
      await expect(chip).toBeVisible({ timeout: 20_000 });
      // The grid still paints in the VENUE's zone (FR-018) — the glyph is
      // the only mismatch signal, and it carries the venue-local time.
      await expect(
        chip.getByRole("img", { name: /local time at the place/i }),
      ).toBeVisible();

      await chip.click();
      const peek = page.getByTestId("calendar-peek");
      await expect(peek.getByTestId("calendar-peek-local")).toBeVisible();
    });
  });
});
