import { request as pwRequest, type APIRequestContext } from "@playwright/test";

import { expect, test } from "./fixtures";
import { createE2eTrpcClient } from "./helpers/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// Event slug history → 308 redirects
// ─────────────────────────────────────────────────────────────────────────────
// A slug that has been superseded lives in `EventSlugHistory`; the event page
// and the checkout page both resolve it and PERMANENTLY (308) redirect to the
// canonical slug, forwarding every query param (`forwardSearchParams`).
//
// But ONLY to a viewer who may read the event (N3, `resolveEventBySlug`): the
// redirect names the event's new slug, so an old slug of an event that is not
// publicly readable — this spec's DRAFT — is a plain 404, with no `location`,
// for anyone who cannot edit it. The edge-cached event page asks as NOBODY (a
// viewer-scoped 308 there would be cached and served to everyone), so it 404s
// the draft's old slug even for its owner, exactly as it 404s the draft's
// canonical slug for its owner. The uncached checkout asks as the viewer, so
// the owner is redirected there and a stranger is not. The published-event
// 308 on the event page is covered in core (`resolve-event-by-slug.test.ts`):
// a published event cannot be deleted, so this spec does not make one.
//
// The spec makes its own event rather than borrowing one: it creates a
// person-owned DRAFT, renames it, and calls `events.regenerateEventSlug`,
// which is the path that writes the old slug into `EventSlugHistory`
// (regenerate returns the SAME slug when nothing that feeds it changed, so the
// rename is what makes this a real redirect). The event is never published, so
// `events.deleteEvent` can remove it outright afterwards — `EventSlugHistory`
// cascades from Event, so the history row goes with it. Safe to run against a
// live dev stack (`E2E_USE_LIVE_STACK=1`); it does not call `resetE2eState()`.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const QUERY = "?ref=e2e&utm_source=x";

// Fixed address so the owner's auto-created SavedLocation is REUSED across
// runs (it is keyed by owner + address) instead of piling up one per run.
const LOCATION = {
  addressText: "E2E Slug History St, Austin, TX 78701, United States",
  lat: 30.2672,
  lng: -97.7431,
  locality: "Austin",
  region: "Texas",
  countryCode: "US",
  postalCode: "78701",
};

type Trpc = ReturnType<typeof createE2eTrpcClient>;

test.describe("Event slug history redirects", () => {
  test.describe.configure({ mode: "serial" });

  let apiCtx: APIRequestContext | null = null;
  let trpc: Trpc | null = null;
  let eventId: string | null = null;
  let previousSlug = "";
  let newSlug = "";

  // eslint-disable-next-line no-empty-pattern -- Playwright needs the fixture slot
  test.beforeAll(async ({}, testInfo) => {
    if (testInfo.project.name === "guest") return;

    // Reuse the session `auth.setup.ts` stored rather than signing in again:
    // a second password sign-in right after setup trips Better Auth's rate
    // limit (429). The session cookie is exchanged for the bearer JWT tRPC
    // wants, the same way the web client does it.
    apiCtx = await pwRequest.newContext({
      storageState: testInfo.project.use.storageState,
    });
    const tokenRes = await apiCtx.get(
      `${API_BASE_URL.replace(/\/+$/, "")}/api/auth/token`,
    );
    expect(tokenRes.ok(), await tokenRes.text()).toBeTruthy();
    const { token } = (await tokenRes.json()) as { token?: string };
    expect(token, "session should mint a JWT").toBeTruthy();
    trpc = createE2eTrpcClient(apiCtx, API_BASE_URL, { bearerToken: token });

    const run = `${Date.now()}`;
    const startsAt = new Date(Date.now() + 14 * 86_400_000);
    startsAt.setUTCSeconds(0, 0);
    const endsAt = new Date(startsAt.getTime() + 2 * 3_600_000);
    const base = {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timezone: "America/Chicago",
      location: LOCATION,
    };

    const created = await trpc.events.createEventForHuman.mutate({
      ...base,
      title: `E2E Slug Before ${run}`,
      clientKey: `e2e-slug-create-${run}`,
    });
    eventId = created.eventId;

    // Rename — the title is a slug segment, so regenerate now has a
    // different slug to move to.
    await trpc.events.createEventForHuman.mutate({
      ...base,
      eventId,
      title: `E2E Slug After ${run}`,
      clientKey: `e2e-slug-rename-${run}`,
    });

    const regen = await trpc.events.regenerateEventSlug.mutate({
      eventId,
      clientKey: `e2e-slug-regen-${run}`,
    });
    expect(regen.eventId).toBe(eventId);
    previousSlug = regen.previousSlug;
    newSlug = regen.newSlug;
  });

  test.afterAll(async () => {
    try {
      if (trpc && eventId) {
        await trpc.events.deleteEvent.mutate({ eventId });
      }
    } finally {
      await apiCtx?.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  test("regenerate moved the slug to the renamed title", () => {
    expect(previousSlug).toContain("e2e-slug-before-");
    expect(newSlug).toContain("e2e-slug-after-");
    expect(newSlug).not.toBe(previousSlug);
    // Person-owned events carry the neutral `event` host segment, on
    // create as well as on regenerate.
    expect(previousSlug.startsWith("event/")).toBe(true);
    expect(newSlug.startsWith("event/")).toBe(true);
  });

  test("a DRAFT's old /events/:slug is a plain 404 on the edge-cached page, even for its owner", async ({
    page,
    consoleErrors,
  }) => {
    const res = await page.request.get(`/events/${previousSlug}${QUERY}`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
    expect(res.headers()["location"]).toBeUndefined();
    expect(await res.text()).not.toContain(newSlug);

    const landed = await page.goto(`/events/${previousSlug}`, {
      waitUntil: "domcontentloaded",
    });
    // No hop: the browser stays on the old URL and is told it does not exist.
    expect(landed?.request().redirectedFrom()).toBeNull();
    expect(landed?.status()).toBe(404);
    await expect(page).toHaveURL(
      new RegExp(`/events/${escapeRegExp(previousSlug)}/?$`),
    );
    // The document 404 is the ONE console error this test expects; anything
    // else still fails it. Let the page finish before the exact comparison:
    // ignore() below switches off the fixture's own end-of-test check.
    await page.waitForLoadState("load");
    expect(consoleErrors.errors()).toEqual([
      "Failed to load resource: the server responded with a status of 404 (Not Found)",
    ]);
    consoleErrors.ignore();
  });

  test("a DRAFT's old slug does not redirect a signed-out visitor on either route", async ({
    baseURL,
  }) => {
    // No storage state: nobody signed in. The response must be the same as for
    // a slug that never existed — 404, no `location`, the new slug nowhere in
    // the body — or the 308 hands a stranger the draft's new title and date.
    //
    // The empty storage state is LOAD-BEARING: under the test runner a bare
    // `newContext()` inherits the project's `use.storageState` (the signed-in
    // test user — the API log shows its actor on the "anonymous" request).
    const anon = await pwRequest.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    // With `buyTickets` off the checkout route 404s before it resolves the
    // slug, so a 404 there would prove nothing: skip THAT route (annotated),
    // keep the event-page check.
    const { buyTickets } = await trpc!.features.getFeatureGates.query();
    try {
      for (const route of ["/events", "/events/checkout"]) {
        if (route === "/events/checkout" && !buyTickets) {
          test.info().annotations.push({
            type: "skip",
            description:
              "signed-out /events/checkout check skipped: buyTickets gate is off, so the route 404s before resolving the slug",
          });
          continue;
        }
        const res = await anon.get(`${route}/${previousSlug}${QUERY}`, {
          maxRedirects: 0,
        });
        expect(res.status(), route).toBe(404);
        expect(res.headers()["location"], route).toBeUndefined();
        expect(await res.text(), route).not.toContain(newSlug);
      }
    } finally {
      await anon.dispose();
    }
  });

  test("a DRAFT's old /events/checkout/:slug 308s its OWNER to the canonical checkout slug", async ({
    page,
  }) => {
    const gates = await trpc!.features.getFeatureGates.query();
    test.skip(
      !gates.buyTickets,
      "buyTickets feature gate is off — the checkout route 404s before it resolves the slug",
    );

    const res = await page.request.get(
      `/events/checkout/${previousSlug}${QUERY}`,
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(308);
    expect(res.headers()["location"]).toMatch(
      new RegExp(
        `/events/checkout/${escapeRegExp(newSlug)}${escapeRegExp(QUERY)}$`,
      ),
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
