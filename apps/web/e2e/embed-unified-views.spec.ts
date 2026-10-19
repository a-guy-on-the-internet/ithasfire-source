// Embed unified views (FR-011 of docs/specs/2026-08-04/embed-unified-views.spec.yaml)
//
// The feature shipped in 02193a89: list and calendar are two VIEWS of one Embed
// row, resolved by the fixed precedence
//
//     route pin (/embed/calendar/[id]) > ?view= > embed.defaultView > "list"
//
// with an optional viewer-facing List/Calendar switcher that flips client-side
// inside the same iframe. Unit tests mock the widget's data layer away, so the
// contracts that actually matter here — which query fires, how MANY fire, and
// that a pasted URL still renders what it always did — are only observable
// against the real stack. This spec is that observation.
//
// It runs on the live dev stack:
//
//   cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test \
//     e2e/embed-unified-views.spec.ts --project=chromium --no-deps --reporter=list
//
// ── State, and why this spec is allowed to mutate it ────────────────────────
// The seeded org embed (`ids.embedDemoOrg`) is ACTIVE on domain `localhost`
// with defaultView="list" / viewToggle=false / linkOut=false. Half of FR-011
// is unobservable at those values, so the spec drives the SAME row through the
// other combinations and restores the snapshot it took in `beforeAll`.
//
// Mutations go through the PUBLIC tRPC mutation the admin page itself calls —
// `embeds.upsert`, keyed on (subjectType, subjectId, domain) — using the
// established `helpers/trpc.ts` sign-in + client pattern. Not raw SQL: the key
// already exists, so an upsert can only ever UPDATE that one row (it cannot
// mint a second), it goes through the same validation and RBAC a real
// organiser does, and it needs no DB credentials in the test process. Omitted
// fields preserve stored values (FR-002), so `status` / `requireAuth` are never
// touched.
//
// `afterAll` restores unconditionally — it runs even when a test fails, and it
// reads the row back and asserts the restore landed rather than trusting it.
// Serial mode is mandatory: every test in this file shares that one row, and
// the project is `fullyParallel`.
//
// Patterns follow embed-iframe-framing.spec.ts / embed-sdk-smoke.spec.ts
// (public widget, no fixture reset, no `resetE2eState` — this spec must never
// wipe the dev database).
import {
  request as pwRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { expect, test } from "./fixtures";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";

const WEB_ORIGIN =
  process.env.PLAYWRIGHT_BASE_URL ??
  process.env.WEB_BASE_URL ??
  "http://localhost:3000";
const API_BASE_URL =
  process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";

/** Seeded org-subject embed on domain `localhost` (apps/api/src/scripts/seed/ids.ts → embedDemoOrg). */
const ORG_EMBED_ID = "00000000-0000-4000-8000-00000000d060";
/** Its subject — the upsert key is (subjectType, subjectId, domain). */
const ORG_SUBJECT_ID = "00000000-0000-4000-8000-00000000d001";
const EMBED_DOMAIN = "localhost";

/**
 * An EVENT-subject embed on the same domain, used only by the "event subjects
 * never get a switcher" case. It is NOT part of the base seed, so that test
 * probes for it and skips when it is absent rather than minting a row this
 * spec would then have to garbage-collect.
 */
const EVENT_EMBED_ID =
  process.env.E2E_EVENT_EMBED_ID ?? "651970ea-b9db-4925-8b71-39af040676d6";

// Dev seed credentials (apps/api/src/scripts/seed/ids.ts → DEV_LOGIN_USER).
// ADMIN on the demo org, i.e. inside ORG_EDIT_ROLES, which is what
// `embeds.upsert` requires.
const DEV_LOGIN = {
  email: "admin@ithasfire.com",
  password: "Dev-Login-2026!",
};

type EmbedView = "list" | "calendar";
type EmbedViewState = {
  defaultView: EmbedView;
  viewToggle: boolean;
  linkOut: boolean;
};

// The two BROWSE queries. NFR-002's budget is stated in terms of these two and
// nothing else — `getPlatformPublicSettings`, `getEventDetail` and friends are
// deliberately outside the count.
const LIST_QUERY = "embeds.getForWidget";
const CALENDAR_QUERY = "embeds.getCalendarEvents";

// ─────────────────────────────────────────────────────────────────────────────
// tRPC-call counter
// ─────────────────────────────────────────────────────────────────────────────
// `httpBatchLink` puts every procedure in a batch into the URL PATH, comma
// separated (`/trpc/a.b,c.d?batch=1&input=…`), for GET and POST alike — so the
// path is a complete, transport-agnostic record of what the browser asked for,
// including retries. Counting it is what pins "exactly one browse query".
//
// The canonical route ALSO resolves `defaultView` server-side
// (src/server/embeds.ts). That call is server→server and correctly invisible
// here: NFR-002's budget is about what the BROWSER fetches to paint a view.
function trackTrpcCalls(page: Page) {
  const procedures: string[] = [];

  page.on("request", (req) => {
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return;
    }
    const marker = "/trpc/";
    const at = url.pathname.indexOf(marker);
    if (at === -1) return;
    for (const raw of url.pathname.slice(at + marker.length).split(",")) {
      const name = decodeURIComponent(raw).trim();
      if (name) procedures.push(name);
    }
  });

  return {
    count: (procedure: string) =>
      procedures.filter((p) => p === procedure).length,
    all: () => [...procedures],
  };
}

/**
 * Give any late/duplicate browse query a chance to show up before counting.
 * A count assertion that runs the instant the view paints would pass on a
 * widget that fires the second query 200ms later — exactly the regression
 * NFR-002 exists to catch.
 */
async function settle(page: Page) {
  await page.waitForTimeout(1_500);
}

// ─────────────────────────────────────────────────────────────────────────────
// View assertions
// ─────────────────────────────────────────────────────────────────────────────

/** The grid/list browse view: owner heading + "N upcoming events" + cards. */
async function expectListView(page: Page) {
  await expect(page.getByText(/\d+ upcoming events?/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("calendar-month-grid")).toHaveCount(0);
  await expect(page.getByTestId("calendar-month-dotgrid")).toHaveCount(0);
}

/**
 * The engine's PAINT ZONE, as its own toolbar reports it.
 *
 * Since event-calendar-redesign (FR-018) the embed paints in the VENUE's
 * timezone, not the browser's. A month label computed from the runner's local
 * clock therefore disagrees with the rendered one for a cross-zone venue
 * whenever the two are on opposite sides of a month boundary — a test that
 * passes for 29 days and fails on the 30th at 11pm. The toolbar's timezone
 * label keeps the full IANA name as its accessible name (the visible text is
 * shortened below 600px), so read the zone from the payload's own rendering
 * and compute the expected label in it.
 */
async function calendarPaintZone(page: Page): Promise<string> {
  const label = page.getByTestId("calendar-timezone");
  await expect(label).toBeAttached({ timeout: 20_000 });
  const zone = await label.getAttribute("aria-label");
  expect(zone, "the calendar toolbar must expose its paint zone").toBeTruthy();
  return zone!;
}

/** Now's month as the nav label renders it in `zone`, e.g. "August 2026". */
function monthLabelIn(zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "long",
    year: "numeric",
  }).format(new Date());
}

/**
 * The calendar browse view at desktop width: the month grid plus its uppercase
 * month header. (Below 600px the engine swaps the grid for a dot grid plus the
 * tapped day's list — see `expectCalendarViewNarrow`.)
 *
 * The header READS uppercase, but that is `text-transform` — the DOM text is
 * title case, so the text and the transform are asserted separately rather
 * than against a shouted string that never exists in the document.
 */
async function expectCalendarView(page: Page) {
  await expect(page.getByTestId("calendar-month-grid")).toBeVisible({
    timeout: 20_000,
  });
  const navLabel = page.getByTestId("calendar-nav-label");
  await expect(navLabel).toHaveText(monthLabelIn(await calendarPaintZone(page)));
  await expect(navLabel).toHaveCSS("text-transform", "uppercase");
  await expect(page.getByText(/\d+ upcoming events?/)).toHaveCount(0);
}

/**
 * The calendar browse view below the 600px breakpoint (FR-010): the month
 * collapses to a dot grid with the selected day's list beneath it. The old
 * bespoke `EmbedCalendarAgenda` (test id `embed-agenda`) that used to stand in
 * here was deleted with the redesign — one mobile shape now serves admin and
 * embed alike.
 */
async function expectCalendarViewNarrow(page: Page) {
  await expect(page.getByTestId("calendar-month-dotgrid")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("calendar-day-list")).toBeVisible();
  await expect(page.getByTestId("calendar-month-grid")).toHaveCount(0);
  // Week is hidden outright below 600px, with no fallback rendering.
  await expect(page.getByTestId("calendar-view-week")).toHaveCount(0);
}

/**
 * Public mode draws no internal chrome (FR-020): no filter-chip row, no
 * overflow menu, no create affordance, no workflow status on a chip, and no
 * agenda in the view toggle. Asserted wherever the calendar is up, because
 * every one of these is a leak of organiser-facing vocabulary onto somebody
 * else's website.
 */
async function expectPublicCalendarChrome(page: Page) {
  await expect(page.getByTestId("event-calendar")).toHaveAttribute(
    "data-mode",
    "public",
  );
  await expect(page.getByTestId("calendar-filters")).toHaveCount(0);
  await expect(page.getByTestId("calendar-filters-menu")).toHaveCount(0);
  await expect(page.getByTestId("calendar-overflow")).toHaveCount(0);
  await expect(page.getByTestId("calendar-status-tag")).toHaveCount(0);
  await expect(page.getByTestId("calendar-hold-tag")).toHaveCount(0);
  await expect(page.locator('[data-testid^="calendar-day-create-"]')).toHaveCount(0);
  // FR-008: month and week only — the embed offers no agenda.
  await expect(page.getByTestId("calendar-view-month")).toBeVisible();
  await expect(page.getByTestId("calendar-view-week")).toBeVisible();
  await expect(page.getByTestId("calendar-view-agenda")).toHaveCount(0);
  await expect(page.getByTestId("calendar-view-day")).toHaveCount(0);
}

async function expectNoErrorScreen(page: Page) {
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
}

const viewToggle = (page: Page) =>
  page.getByRole("group", { name: "Browse view" });

// ─────────────────────────────────────────────────────────────────────────────
// Fixture-state plumbing
// ─────────────────────────────────────────────────────────────────────────────

let apiCtx: APIRequestContext | undefined;
let authedTrpc: ReturnType<typeof createE2eTrpcClient>;
let publicTrpc: ReturnType<typeof createE2eTrpcClient>;
/** Undefined until the snapshot lands — `afterAll` must not "restore" a guess. */
let originalOrgState: EmbedViewState | undefined;

async function readOrgEmbedState(): Promise<EmbedViewState> {
  // The public widget procedure already returns all three flags (FR-005), so
  // the snapshot needs no extra privilege.
  const res = await publicTrpc.embeds.getForWidget.query({
    embedId: ORG_EMBED_ID,
    hostOrigin: WEB_ORIGIN,
  });
  return {
    defaultView: res.embed.defaultView as EmbedView,
    viewToggle: res.embed.viewToggle,
    linkOut: res.embed.linkOut,
  };
}

async function writeOrgEmbedState(state: EmbedViewState): Promise<void> {
  await authedTrpc.embeds.upsert.mutate({
    subjectType: "organization",
    subjectId: ORG_SUBJECT_ID,
    domain: EMBED_DOMAIN,
    defaultView: state.defaultView,
    viewToggle: state.viewToggle,
    linkOut: state.linkOut,
  });
}

/**
 * Wait until the CANONICAL route's server render agrees with the stored
 * default.
 *
 * `/embed/[embedId]` is a server component with `export const revalidate = 60`
 * that resolves `defaultView` before first paint and ships it as
 * `initialDefaultView`. Under `next dev` there is no full-route cache and the
 * flip is visible immediately; against a production build the ISR window means
 * a config change reaches bare URLs within ~60s. Polling the rendered payload
 * makes the difference between "the feature is broken" and "the cache has not
 * turned over yet" a legible failure instead of a mystery.
 */
async function waitForSsrDefaultView(expected: EmbedView): Promise<void> {
  const marker = new RegExp(`initialDefaultView.{0,8}${expected}`);
  await expect
    .poll(
      async () => {
        const res = await apiCtx!.get(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`);
        return marker.test(await res.text());
      },
      {
        timeout: 20_000,
        message: `Canonical route never SSR'd initialDefaultView="${expected}" (ISR window, or the prop was renamed)`,
      },
    )
    .toBe(true);
}

test.describe("Embed unified views (FR-011)", () => {
  // One shared mutable Embed row ⇒ these must not interleave.
  test.describe.configure({ mode: "serial" });

  // Explicitly guest. The widget is a public surface served to third-party
  // iframes; running it under the suite's shared storageState would be a claim
  // this spec is not making (and a stale session cookie is a source of console
  // noise the fixture would attribute to the widget).
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    apiCtx = await pwRequest.newContext();
    publicTrpc = createE2eTrpcClient(apiCtx, API_BASE_URL);
    const { token } = await signInAndGetToken(apiCtx, API_BASE_URL, DEV_LOGIN);
    authedTrpc = createE2eTrpcClient(apiCtx, API_BASE_URL, {
      bearerToken: token,
    });

    originalOrgState = await readOrgEmbedState();
  });

  test.afterAll(async () => {
    // Runs even when a test above failed — this is the whole cleanup contract.
    try {
      if (originalOrgState) {
        await writeOrgEmbedState(originalOrgState);
        const restored = await readOrgEmbedState();
        expect(
          restored,
          "org embed row must be restored to its pre-spec state",
        ).toEqual(originalOrgState);
      }
    } finally {
      await apiCtx?.dispose();
    }
  });

  // ── FR-003 / NFR-001 — the frozen URL contracts ───────────────────────────

  test("bare /embed/[id] on a list-default row renders the grid and fires exactly one browse query", async ({
    page,
  }) => {
    await writeOrgEmbedState({
      defaultView: "list",
      viewToggle: false,
      linkOut: false,
    });
    await waitForSsrDefaultView("list");

    const calls = trackTrpcCalls(page);
    await page.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`, {
      waitUntil: "domcontentloaded",
    });

    await expectListView(page);
    await expectNoErrorScreen(page);
    await settle(page);

    // NFR-002: ONE browse query, and it is the list one. A calendar query here
    // would mean the widget probed for its own config and threw a payload away.
    expect(calls.count(LIST_QUERY), calls.all().join(", ")).toBe(1);
    expect(calls.count(CALENDAR_QUERY), calls.all().join(", ")).toBe(0);

    // viewToggle is off ⇒ no switcher.
    await expect(viewToggle(page)).toHaveCount(0);
  });

  test("/embed/[id]?view=calendar renders the calendar and never fetches the grid", async ({
    page,
  }) => {
    await writeOrgEmbedState({
      defaultView: "list",
      viewToggle: false,
      linkOut: false,
    });

    const calls = trackTrpcCalls(page);
    await page.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}?view=calendar`, {
      waitUntil: "domcontentloaded",
    });

    await expectCalendarView(page);
    await expectNoErrorScreen(page);
    await settle(page);

    expect(calls.count(CALENDAR_QUERY), calls.all().join(", ")).toBe(1);
    expect(calls.count(LIST_QUERY), calls.all().join(", ")).toBe(0);
  });

  test("REGRESSION CANARY: legacy /embed/calendar/[id] still pins the calendar on a list-default row", async ({
    page,
  }) => {
    // This URL is pasted on third-party sites. It is a permanent alias that
    // must NEVER consult `defaultView` and must never be redirected — if this
    // test goes red, live embeds in the wild changed what they render.
    await writeOrgEmbedState({
      defaultView: "list",
      viewToggle: false,
      linkOut: false,
    });
    await waitForSsrDefaultView("list");

    const calls = trackTrpcCalls(page);
    const url = `${WEB_ORIGIN}/embed/calendar/${ORG_EMBED_ID}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await expectCalendarView(page);
    // FR-024 freezes the URL; FR-020 freezes what it may render.
    await expectPublicCalendarChrome(page);
    await expectNoErrorScreen(page);
    // Aliasing is internal (both routes render EmbedWidget) — no redirect.
    expect(page.url()).toBe(url);

    await settle(page);
    expect(calls.count(CALENDAR_QUERY), calls.all().join(", ")).toBe(1);
    expect(calls.count(LIST_QUERY), calls.all().join(", ")).toBe(0);
  });

  test("public mode never opens a peek: a chip press goes straight to the mount's own click behaviour", async ({
    page,
  }) => {
    // FR-020: "Clicking an event keeps today's existing checkout-launch
    // behaviour unchanged, this requirement touches rendering only, never the
    // click handler's target." The engine's peek is internal-mode only, so the
    // observable is that a press moves the widget on and leaves no dialog
    // behind — a peek here would put Edit / Copy link / ICS on a stranger's
    // website.
    await writeOrgEmbedState({
      defaultView: "calendar",
      viewToggle: false,
      linkOut: false,
    });
    await waitForSsrDefaultView("calendar");

    await page.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expectCalendarView(page);
    await expectPublicCalendarChrome(page);

    const chip = page.locator('[data-testid^="calendar-event-chip-"]').first();
    await expect(chip).toBeVisible({ timeout: 20_000 });
    // A public chip advertises no dialog, because there is none to open.
    await expect(chip).not.toHaveAttribute("aria-haspopup", "dialog");

    await chip.click();
    // The in-iframe detail screen is the existing target, unchanged.
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("calendar-peek")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectNoErrorScreen(page);
  });

  test("an unknown ?view= value falls through to the stored default without erroring", async ({
    page,
  }) => {
    await writeOrgEmbedState({
      defaultView: "list",
      viewToggle: false,
      linkOut: false,
    });
    await waitForSsrDefaultView("list");

    const calls = trackTrpcCalls(page);
    await page.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}?view=map`, {
      waitUntil: "domcontentloaded",
    });

    // Falls THROUGH to defaultView ("list") — it must not short-circuit, and it
    // must not render the error boundary.
    await expectListView(page);
    await expectNoErrorScreen(page);
    await settle(page);

    expect(calls.count(LIST_QUERY), calls.all().join(", ")).toBe(1);
    expect(calls.count(CALENDAR_QUERY), calls.all().join(", ")).toBe(0);
  });

  // ── D-002 — URL beats config, config beats the fallback ───────────────────

  test("with defaultView=calendar stored: bare URL renders the calendar, ?view=list still wins", async ({
    page,
  }) => {
    await writeOrgEmbedState({
      defaultView: "calendar",
      viewToggle: false,
      linkOut: false,
    });
    await waitForSsrDefaultView("calendar");

    // (a) config retargets the bare canonical URL — and does it in ONE query.
    const bareCalls = trackTrpcCalls(page);
    await page.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expectCalendarView(page);
    await expectNoErrorScreen(page);
    await settle(page);
    expect(
      bareCalls.count(CALENDAR_QUERY),
      bareCalls.all().join(", "),
    ).toBe(1);
    expect(bareCalls.count(LIST_QUERY), bareCalls.all().join(", ")).toBe(0);

    // (b) an explicit ?view= outranks the stored default. Fresh page ⇒ fresh
    // counter, so the two halves can't contaminate each other's counts.
    const listPage = await page.context().newPage();
    try {
      const listCalls = trackTrpcCalls(listPage);
      await listPage.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}?view=list`, {
        waitUntil: "domcontentloaded",
      });
      await expectListView(listPage);
      await expectNoErrorScreen(listPage);
      await settle(listPage);
      expect(listCalls.count(LIST_QUERY), listCalls.all().join(", ")).toBe(1);
      expect(
        listCalls.count(CALENDAR_QUERY),
        listCalls.all().join(", "),
      ).toBe(0);
    } finally {
      await listPage.close();
    }
  });

  // ── FR-004 — the viewer toggle ────────────────────────────────────────────

  test("viewToggle: the switcher flips views in place and fetches each view exactly once", async ({
    page,
  }) => {
    await writeOrgEmbedState({
      defaultView: "list",
      viewToggle: true,
      linkOut: false,
    });
    await waitForSsrDefaultView("list");

    const calls = trackTrpcCalls(page);
    await page.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`, {
      waitUntil: "domcontentloaded",
    });

    const group = viewToggle(page);
    await expect(group).toBeVisible({ timeout: 20_000 });
    const listBtn = group.getByRole("button", { name: "List" });
    const calendarBtn = group.getByRole("button", { name: "Calendar" });

    // Initial position is the FR-003 resolved view.
    await expectListView(page);
    await expect(listBtn).toHaveAttribute("aria-pressed", "true");
    await expect(calendarBtn).toHaveAttribute("aria-pressed", "false");

    // Stamp the window so a reload — the thing "flips client-side inside the
    // same iframe" forbids — is detectable rather than inferred.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__thEmbedSentinel =
        "no-reload";
    });
    let mainFrameNavigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) mainFrameNavigations += 1;
    });

    // list → calendar → list → calendar
    await calendarBtn.click();
    await expectCalendarView(page);
    await expect(calendarBtn).toHaveAttribute("aria-pressed", "true");

    await listBtn.click();
    await expectListView(page);

    await calendarBtn.click();
    await expectCalendarView(page);

    await settle(page);

    // The sentinel survived ⇒ same document, same iframe, no navigation.
    const sentinel = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>)
          .__thEmbedSentinel as string | undefined,
    );
    expect(sentinel).toBe("no-reload");
    expect(mainFrameNavigations).toBe(0);
    expect(page.url()).toBe(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`);

    // NFR-002: the lazily-enabled view is fetched ONCE for the widget's
    // lifetime, no matter how many times the viewer flips.
    expect(calls.count(CALENDAR_QUERY), calls.all().join(", ")).toBe(1);
    expect(calls.count(LIST_QUERY), calls.all().join(", ")).toBe(1);
  });

  // Deliberately a SEPARATE test from the flip counting above, and deliberately
  // reached WITHOUT flipping first. Doing both in one test made it fail ~2 runs
  // in 3 on an unhandled
  //
  //   [pageerror] Transition was aborted because of timeout in DOM update
  //
  // — Chrome's View Transition API giving up on `updateCallbackDone` after its
  // 4s cap. `/embed/*` is wrapped by the root `<PageTransition>`
  // (app/_components/PageTransition.tsx: the embed paths are in neither opt-out
  // list), so React starts a page view transition for the detail-screen commit
  // and HOLDS the DOM update until `embeds.getEventDetail` resolves. Measured,
  // not guessed: flips with no detail step 3/3 clean, detail step with the
  // switcher absent 3/3 clean, detail step with the switcher present but no
  // prior flip 4/4 clean, flips-then-detail 2/3 dirty. That last combination is
  // a real (if cosmetic — the transition just doesn't animate) defect on this
  // feature's own path, and it is NOT covered here: an allowance for it would
  // put a permanently-yellow console gate in this file. It is reported instead,
  // for a fix at the source (should an embed served into a third-party iframe
  // participate in the site's page transitions at all?), after which
  // flips→detail can be folded back in under the full gate.
  test("viewToggle: the switcher never renders over the event detail screen, and returns on back", async ({
    page,
  }) => {
    await writeOrgEmbedState({
      defaultView: "list",
      viewToggle: true,
      linkOut: false,
    });
    await waitForSsrDefaultView("list");

    await page.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`, {
      waitUntil: "domcontentloaded",
    });

    const group = viewToggle(page);
    await expect(group).toBeVisible({ timeout: 20_000 });
    await expectListView(page);

    // The switcher is a BROWSE-screen control: entering event detail removes
    // it, and going back restores it (with the browse screen intact).
    //
    // The card is the design system's own `EventGridCard` now (it used to be
    // a bespoke card with a "View {title}" button), so it is one `role="link"`
    // whose accessible name is the event title — there is no stable label to
    // match on, and its own automation id is what identifies it.
    await page.locator('[data-testid^="event-card-"]').first().click();
    const backBtn = page.getByRole("button", { name: "Back" });
    await expect(backBtn).toBeVisible({ timeout: 20_000 });
    await expect(group).toHaveCount(0);

    await backBtn.click();
    await expect(group).toBeVisible();
    await expectListView(page);
  });

  test("event-subject embeds never render the switcher, even with viewToggle on", async ({
    page,
  }) => {
    // The base seed carries no event-subject embed. Rather than mint one this
    // spec would then have to garbage-collect — leaking a row into a database
    // other sessions share if teardown ever failed — probe for it and skip
    // when it is absent. `E2E_EVENT_EMBED_ID` points the probe elsewhere.
    const probe = await publicTrpc.embeds.getForWidget
      .query({ embedId: EVENT_EMBED_ID, hostOrigin: WEB_ORIGIN })
      .catch(() => null);

    test.skip(
      probe?.embed.subjectType !== "event",
      `No event-subject embed at ${EVENT_EMBED_ID} on domain ${EMBED_DOMAIN} — seed one (or set E2E_EVENT_EMBED_ID) to cover the event-subject exclusion.`,
    );

    const embed = probe!.embed;
    const restore = {
      subjectType: "event" as const,
      subjectId: embed.subjectId,
      domain: embed.domain,
      defaultView: embed.defaultView as EmbedView,
      viewToggle: embed.viewToggle,
      linkOut: embed.linkOut,
    };

    try {
      // Force the flag ON. Asserting "no switcher" against a row that already
      // has viewToggle=false would prove nothing — the switcher is absent for
      // the wrong reason.
      await authedTrpc.embeds.upsert.mutate({
        subjectType: "event",
        subjectId: embed.subjectId,
        domain: embed.domain,
        viewToggle: true,
      });

      await page.goto(`${WEB_ORIGIN}/embed/${EVENT_EMBED_ID}`, {
        waitUntil: "domcontentloaded",
      });

      // An event-subject list embed auto-skips the grid straight to detail.
      await expect(page.getByRole("button", { name: /Get tickets|Back/i }))
        .toBeVisible({ timeout: 20_000 });
      await expect(viewToggle(page)).toHaveCount(0);

      // …and on the calendar entry path too (a calendar of one event still has
      // a browse screen, so this is the case the exclusion actually guards).
      await page.goto(`${WEB_ORIGIN}/embed/calendar/${EVENT_EMBED_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expectCalendarView(page);
      await expect(viewToggle(page)).toHaveCount(0);
    } finally {
      await authedTrpc.embeds.upsert.mutate(restore);
    }
  });

  // ── FR-009 — commerce rules are view-independent ──────────────────────────

  test("linkOut: a calendar reached VIA THE TOGGLE links out to the canonical event page instead of opening in-iframe checkout", async ({
    page,
  }) => {
    // FR-009 says the eligibility / linkOut rules must not fork on how the
    // calendar was reached. The legacy route's linkOut behaviour was verified
    // when the calendar shipped; the TOGGLE path is the one this feature added
    // and the one nothing else covers.
    await writeOrgEmbedState({
      defaultView: "list",
      viewToggle: true,
      linkOut: true,
    });
    await waitForSsrDefaultView("list");

    await page.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`, {
      waitUntil: "domcontentloaded",
    });

    const group = viewToggle(page);
    await expect(group).toBeVisible({ timeout: 20_000 });
    await group.getByRole("button", { name: "Calendar" }).click();
    await expectCalendarView(page);

    const chip = page.locator('[data-testid^="calendar-event-chip-"]').first();
    await expect(chip).toBeVisible({ timeout: 20_000 });

    // The observable contract: `window.open(canonicalUrl, "_blank", …)` —
    // a NEW TAB, never a navigation of the widget's own frame. Playwright
    // surfaces that as a popup.
    const popupPromise = page.waitForEvent("popup", { timeout: 20_000 });
    await chip.click();
    const popup = await popupPromise;
    await popup.waitForURL(/\/events\//, { timeout: 20_000 });
    const popupUrl = popup.url();
    await popup.close();

    expect(popupUrl.startsWith(`${WEB_ORIGIN}/events/`)).toBe(true);

    // …and the widget stayed on the calendar browse screen: no in-iframe
    // detail, no checkout, no navigation.
    expect(page.url()).toBe(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`);
    await expect(group).toBeVisible();
    await expectCalendarView(page);
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
  });

  // ── FR-011 — 320px ────────────────────────────────────────────────────────

  test("320px: both views render without horizontal document overflow", async ({
    page,
  }) => {
    await writeOrgEmbedState({
      defaultView: "list",
      viewToggle: true,
      linkOut: false,
    });
    await waitForSsrDefaultView("list");

    await page.setViewportSize({ width: 320, height: 720 });

    const noOverflow = async () => {
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return {
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
        };
      });
      // 1px of slack for sub-pixel layout rounding.
      expect(
        overflow.scrollWidth,
        `horizontal overflow at 320px: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    };

    await page.goto(`${WEB_ORIGIN}/embed/${ORG_EMBED_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expectListView(page);
    await noOverflow();

    // Below 600px the engine swaps its month grid for the dot grid + day list.
    await viewToggle(page).getByRole("button", { name: "Calendar" }).click();
    await expectCalendarViewNarrow(page);
    await noOverflow();
    await expectNoErrorScreen(page);
  });
});
