// Calendar-cell create (venue-hierarchy FR-011)
//
// docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml:
//
//   "Clicking an empty cell on an admin calendar lands on quick-create with
//    date, time, calendar, space, and category prefilled; the created event
//    carries that spaceId and calendarId."
//
// That acceptance criterion spans four modules that unit tests only ever see
// in isolation: the venue calendar's month cell, the `useCreateDraftEvent`
// navigation, the `quick-create-prefill` query-string vocabulary, and the save
// mutation that stamps the placement. The seam between them is a URL, and a
// URL contract is exactly the kind of thing that passes every unit test on
// both sides while being wrong in the middle. This spec is the observation.
//
// ── Running it (LIVE STACK, NON-DESTRUCTIVE) ────────────────────────────────
//
//   cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test \
//     e2e/venue-calendar-cell-create.spec.ts --project=chromium \
//     --reporter=list --workers=1
//
// `E2E_USE_LIVE_STACK=1` is MANDATORY here. Without it Playwright boots
// `scripts/wait-api-healthy.cjs`, whose readiness path runs
// `prisma migrate reset --force` and WIPES the local dev database. With it,
// both `webServer` entries are pure readiness probes against the stack you
// already have up (`reuseExistingServer: true`), and `global-teardown.ts`
// early-returns instead of SIGTERMing the API.
//
// ── State discipline ────────────────────────────────────────────────────────
// This spec NEVER calls `resetE2eState`. It mints its own org + venue + space +
// calendar through `/e2e/seed/venue-cell-create`, creates exactly one event
// through the product's own UI, and deletes all of it in `afterAll` — which
// runs on failure too, and asserts the teardown landed rather than trusting
// it. Nothing it touches is reachable from any other fixture.
//
// Serial, because the tests share one fixture and one created event, and the
// project is `fullyParallel`.
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

interface CellCreateSeed {
  humanId: string;
  orgId: string;
  orgSlug: string;
  placeId: string;
  placeName: string;
  spaceId: string;
  calendarId: string;
  calendarName: string;
  /** "HH:mm" — deliberately NOT the web helper's 19:00 fallback. */
  defaultStartTime: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A day inside the CURRENT month that the quick-create form will accept.
 *
 * The date input carries `min={now}`, so the target must be in the future;
 * staying inside this month keeps it on the default month grid with no
 * navigation. Day 20 is late enough to always be ahead of a run early in the
 * month and early enough to exist in February — and when today is already
 * past it, the spec walks forward instead of guessing.
 */
function pickTargetDay(): Date {
  const now = new Date();
  const preferred = new Date(now.getFullYear(), now.getMonth(), 20);
  if (preferred.getTime() > now.getTime()) return preferred;
  // Late in the month: take tomorrow, and roll into next month if need be.
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return tomorrow;
}

const TARGET_DAY = pickTargetDay();
const TARGET_DATE_KEY = `${TARGET_DAY.getFullYear()}-${pad2(
  TARGET_DAY.getMonth() + 1,
)}-${pad2(TARGET_DAY.getDate())}`;

const EVENT_TITLE = `E2E Cell Create ${Date.now()}`;

test.describe.configure({ mode: "serial" });

test.describe("Calendar-cell create (FR-011)", () => {
  let seed: CellCreateSeed;
  /** Set by the create test; read by the placement + cleanup steps. */
  let createdEventId: string | null = null;

  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  test.beforeAll(async ({ request }) => {
    // Admin gates require a verified email. Best-effort: auth.setup already
    // does this, and a stale live DB may have drifted.
    await request
      .post(`${API_BASE_URL}/e2e/auth/verify-email`, {
        headers: e2eHeaders,
        data: { email: TEST_EMAIL },
      })
      .catch(() => undefined);

    const res = await request.post(`${API_BASE_URL}/e2e/seed/venue-cell-create`, {
      headers: e2eHeaders,
      data: { email: TEST_EMAIL },
    });
    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();

    seed = (await res.json()).seed as CellCreateSeed;
    expect(seed.orgSlug).toBeTruthy();
    expect(seed.placeId).toBeTruthy();
    expect(seed.calendarId).toBeTruthy();
    expect(seed.spaceId).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (!seed?.orgId) return;

    const res = await request.post(
      `${API_BASE_URL}/e2e/seed/venue-cell-create/cleanup`,
      {
        headers: e2eHeaders,
        data: { orgId: seed.orgId, placeId: seed.placeId },
      },
    );
    // Teardown is the whole reason this spec is safe to run against a live dev
    // database, so assert it rather than firing and forgetting.
    expect(res.ok(), `Cleanup failed: ${await res.text()}`).toBeTruthy();

    if (createdEventId) {
      const gone = await request.get(
        `${API_BASE_URL}/e2e/seed/venue-cell-create/event/${createdEventId}`,
        { headers: e2eHeaders },
      );
      expect(gone.status(), "created event survived teardown").toBe(404);
    }
  });

  /** The place calendar keeps view + anchor in the query string (FR-015). */
  const calendarUrl = (query?: Record<string, string>) => {
    const base = `/admin/${seed.orgSlug}/places/${seed.placeId}/calendar`;
    const search = query ? new URLSearchParams(query).toString() : "";
    return search ? `${base}?${search}` : base;
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 1. The cell → the prefilled form
  // ═══════════════════════════════════════════════════════════════════════

  test("clicking a day cell lands on quick-create prefilled with that date, time, calendar and space", async ({
    page,
  }) => {
    // The place mount now OPENS in week (FR-008), so the month grid this test
    // needs is reached through the URL rather than assumed.
    await page.goto(calendarUrl({ view: "month" }));
    await expect(page.getByTestId("event-calendar")).toBeVisible();
    await expect(page.getByTestId("calendar-month-grid")).toBeVisible();

    const createButton = page.getByTestId(
      `calendar-day-create-${TARGET_DATE_KEY}`,
    );
    // The month grid usually carries the target already; when a run lands on
    // the last days of a month the target is next month's, so step forward
    // once rather than failing on a calendar-arithmetic edge.
    if (!(await createButton.isVisible().catch(() => false))) {
      await page.getByTestId("calendar-nav-next").click();
    }
    await expect(createButton).toBeVisible();
    // The glyph is aria-hidden on purpose — the DATE is the button's whole
    // accessible name, so a cell grid of 30+ identical "Create" buttons stays
    // distinguishable. Pin that here, because it is invisible to a click.
    await expect(createButton).toHaveAttribute(
      "aria-label",
      /create event on/i,
    );

    // The create control is hidden until its cell is hovered, so that the month
    // grid does not paint 42 glyphs at rest. Playwright's hit-target check runs
    // before it moves the mouse, so hover the cell explicitly first.
    await page.getByTestId(`calendar-day-${TARGET_DATE_KEY}`).hover();
    await createButton.click();

    // Moderators get a Ticketed-vs-Community choice first. The Playwright user
    // normally isn't one, but the dialog must not be able to silently strand
    // this spec if that ever changes.
    const ticketedChoice = page.getByRole("button", { name: /ticketed/i });
    if (await ticketedChoice.isVisible().catch(() => false)) {
      await ticketedChoice.click();
    }

    await page.waitForURL(/\/events\/new(\?|$)/, { timeout: 30_000 });

    // ── The URL contract (quick-create-prefill.ts vocabulary) ────────────
    const url = new URL(page.url());
    expect(url.searchParams.get("placeId")).toBe(seed.placeId);
    expect(url.searchParams.get("calendarId")).toBe(seed.calendarId);
    expect(url.searchParams.get("spaceId")).toBe(seed.spaceId);
    // A month cell carries a DATE only, so the clock has to come from the
    // calendar's own defaultStartTime — NOT the "19:00" fallback the helper
    // uses when no calendar is known. The fixture picks 20:30 precisely so
    // those two are distinguishable.
    expect(url.searchParams.get("startsAt")).toBe(
      `${TARGET_DATE_KEY}T${seed.defaultStartTime}`,
    );

    // ── The rendered form ────────────────────────────────────────────────
    await expect(page.getByTestId("quick-create-card")).toBeVisible();
    await expect(page.getByTestId("quick-create-starts-at")).toHaveValue(
      `${TARGET_DATE_KEY}T${seed.defaultStartTime}`,
    );
    // The venue arrives as an id and resolves once the places query lands.
    await expect(page.getByText(seed.placeName).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Submit → the placement persists
  // ═══════════════════════════════════════════════════════════════════════

  test("submitting the prefilled form creates an event carrying that calendar and space", async ({
    page,
  }) => {
    const query = new URLSearchParams({
      startsAt: `${TARGET_DATE_KEY}T${seed.defaultStartTime}`,
      placeId: seed.placeId,
      calendarId: seed.calendarId,
      spaceId: seed.spaceId,
    });
    await page.goto(`/admin/${seed.orgSlug}/events/new?${query.toString()}`);

    await expect(page.getByTestId("quick-create-card")).toBeVisible();
    await expect(page.getByText(seed.placeName).first()).toBeVisible({
      timeout: 20_000,
    });

    const titleInput = page.getByTestId("quick-create-title");
    await titleInput.fill(EVENT_TITLE);
    // The submit button is gated on REACT state, not on the DOM value — assert
    // the value round-tripped so a controlled-input regression fails HERE
    // rather than as an opaque click timeout (the trap auth.setup documents).
    await expect(titleInput).toHaveValue(EVENT_TITLE);

    const submit = page.getByTestId("quick-create-submit");
    await expect(submit).toBeEnabled();
    await expect(submit).not.toHaveAttribute("aria-disabled", "true");
    await submit.click();

    // Quick create routes into the full builder at /events/:id/edit.
    await page.waitForURL(/\/events\/[0-9a-f-]{36}\/edit/, { timeout: 45_000 });
    createdEventId = page.url().match(/\/events\/([0-9a-f-]{36})\/edit/)?.[1] ?? null;
    expect(createdEventId, "could not read the created event id").toBeTruthy();

    // THE assertion of this spec. `Event.calendarId` / `Event.spaceId` are the
    // two columns FR-011 exists to stamp, and no public read projects them —
    // a UI-only check here would pass on an event with a null placement.
    const res = await page.request.get(
      `${API_BASE_URL}/e2e/seed/venue-cell-create/event/${createdEventId}`,
      { headers: e2eHeaders },
    );
    expect(res.ok(), `Event read-back failed: ${await res.text()}`).toBeTruthy();

    const { event } = await res.json();
    expect(event.title).toBe(EVENT_TITLE);
    expect(event.status).toBe("DRAFT");
    expect(event.placeId).toBe(seed.placeId);
    expect(event.calendarId).toBe(seed.calendarId);
    expect(event.spaceId).toBe(seed.spaceId);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. FR-005: the event renders on ITS calendar, not via the space join
  // ═══════════════════════════════════════════════════════════════════════

  test("the created event shows on the venue calendar", async ({ page }) => {
    expect(createdEventId, "previous test did not create an event").toBeTruthy();

    await page.goto(
      calendarUrl({ view: "month", date: TARGET_DATE_KEY }),
    );
    await expect(page.getByTestId("calendar-month-grid")).toBeVisible();

    // The redesigned engine keys a chip by ITEM id, and an event item is
    // `${eventId}:${occurrenceIndex}` — a single-date listing is occurrence 0.
    await expect(
      page.getByTestId(`calendar-event-chip-${createdEventId}:0`),
    ).toBeVisible({ timeout: 20_000 });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. FR-019: the WEEK slot carries a TIME, not the calendar's default
  // ═══════════════════════════════════════════════════════════════════════

  test("the week view's day-column create affordance prefills the slot's own time", async ({
    page,
  }) => {
    await page.goto(calendarUrl({ view: "week", date: TARGET_DATE_KEY }));
    await expect(page.getByTestId("calendar-week-grid")).toBeVisible({
      timeout: 20_000,
    });

    const createButton = page.getByTestId(`calendar-week-create-${TARGET_DATE_KEY}`);
    await expect(createButton).toBeVisible();
    await expect(createButton).toHaveAttribute("aria-label", /create event on/i);
    // Hidden until its column header is hovered (see the month cell note above).
    await page.getByTestId(`calendar-week-header-${TARGET_DATE_KEY}`).hover();
    await createButton.click();

    const ticketedChoice = page.getByRole("button", { name: /ticketed/i });
    if (await ticketedChoice.isVisible().catch(() => false)) {
      await ticketedChoice.click();
    }

    await page.waitForURL(/\/events\/new(\?|$)/, { timeout: 30_000 });
    const url = new URL(page.url());
    expect(url.searchParams.get("placeId")).toBe(seed.placeId);
    expect(url.searchParams.get("calendarId")).toBe(seed.calendarId);
    expect(url.searchParams.get("spaceId")).toBe(seed.spaceId);
    // A WEEK cell names an hour, so the clock comes from the SLOT, never from
    // the calendar's `defaultStartTime` (20:30 here — the fixture picks a
    // value that would be indistinguishable from a date-only prefill).
    // The header affordance lands on the window's first hour, and this venue
    // seeds no CalendarAvailability at all, so that is FR-011's auto-fit
    // floor: 09:00.
    expect(url.searchParams.get("startsAt")).toBe(`${TARGET_DATE_KEY}T09:00`);
    expect(url.searchParams.get("startsAt")).not.toBe(
      `${TARGET_DATE_KEY}T${seed.defaultStartTime}`,
    );

    await expect(page.getByTestId("quick-create-card")).toBeVisible();
    await expect(page.getByTestId("quick-create-starts-at")).toHaveValue(
      `${TARGET_DATE_KEY}T09:00`,
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. FR-019: a PERSONAL dashboard says who the draft is created as
  // ═══════════════════════════════════════════════════════════════════════
  //
  //   "On a personal (human) dashboard the draft's owner is that human, and
  //    the event builder shows the owner prominently in its header."
  //
  // A personal dashboard spans the human PLUS every org they belong to, so
  // "which owner is this draft under" is a real question there and nowhere
  // else. The header line is the answer, and it is the only place the app
  // ever states it.

  test("a personal dashboard's cell create opens the builder with the owner named in its header", async ({
    page,
  }) => {
    const personalSlug = `@${seed.humanId}`;
    await page.goto(`/admin/${encodeURIComponent(personalSlug)}`);

    try {
      const calendar = page.getByTestId("event-calendar");
      await expect(calendar).toBeVisible({ timeout: 30_000 });
      // The dashboard opens in AGENDA (FR-008), which carries no cell-create
      // affordance — month is where an empty day can be clicked.
      await page.getByTestId("calendar-view-month").click();
      await expect(page.getByTestId("calendar-month-grid")).toBeVisible();

      const createButton = page.getByTestId(
        `calendar-day-create-${TARGET_DATE_KEY}`,
      );
      if (!(await createButton.isVisible().catch(() => false))) {
        await page.getByTestId("calendar-nav-next").click();
      }
      await expect(createButton).toBeVisible();
      await page.getByTestId(`calendar-day-${TARGET_DATE_KEY}`).hover();
      await createButton.click();

      const ticketedChoice = page.getByRole("button", { name: /ticketed/i });
      if (await ticketedChoice.isVisible().catch(() => false)) {
        await ticketedChoice.click();
      }

      await page.waitForURL(/\/events\/new(\?|$)/, { timeout: 30_000 });
      await expect(page.getByTestId("quick-create-card")).toBeVisible();

      const owner = page.getByTestId("event-builder-owner");
      await expect(owner).toBeVisible();
      // "Creating as · {owner}" — the name is the human's, resolved live, so
      // the assertion pins the shape and that a name actually landed in it.
      await expect(owner).toHaveText(/^Creating as · \S.*/);
    } finally {
      // The dashboard persists the view choice globally
      // (`th:calendar:viewMode`), which would otherwise outlive this spec.
      await page
        .evaluate(() => window.localStorage.removeItem("th:calendar:viewMode"))
        .catch(() => undefined);
    }
  });
});
