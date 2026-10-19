import { TRPCClientError } from "@trpc/client";
import type { AppRouter } from "@th/trpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLocalEventsQuery = vi.fn();
const mockGetEventSeoQuery = vi.fn();
const mockListEventSitemapEntriesQuery = vi.fn();
const mockResolveEventBySlugQuery = vi.fn();
const mockGetPublicEventBodyQuery = vi.fn();
const mockGetGateStateQuery = vi.fn();
const mockListEventDatesQuery = vi.fn();
/**
 * The DE-IDENTIFIED client's `getEventSeo`, kept as a SEPARATE spy from
 * `mockGetEventSeoQuery` so a test can assert not just what the payload
 * contained but WHICH transport asked for it. That distinction is the fix:
 * only a client with no bearer token gets an obscured location back for a
 * ticket holder, and no amount of downstream field-stripping substitutes.
 */
const mockPublicGetEventSeoQuery = vi.fn();
/** The DE-IDENTIFIED client's `resolveEventBySlug` — see above. */
const mockPublicResolveEventBySlugQuery = vi.fn();
/** The DE-IDENTIFIED client's `resolveEventShortLink` (`/e/<shortId>`). */
const mockPublicResolveEventShortLinkQuery = vi.fn();

vi.mock("@/server/trpc-client", () => ({
  getPublicTrpcClient: vi.fn(() => ({
    events: {
      getEventSeo: { query: mockPublicGetEventSeoQuery },
      resolveEventBySlug: { query: mockPublicResolveEventBySlugQuery },
      resolveEventShortLink: { query: mockPublicResolveEventShortLinkQuery },
    },
  })),
  getServerTrpcClient: vi.fn(() => ({
    community: {
      listEventDates: { query: mockListEventDatesQuery },
    },
    events: {
      localEvents: {
        query: mockLocalEventsQuery,
      },
      getEventSeo: {
        query: mockGetEventSeoQuery,
      },
      resolveEventBySlug: {
        query: mockResolveEventBySlugQuery,
      },
      listEventSitemapEntries: {
        query: mockListEventSitemapEntriesQuery,
      },
      getPublicEventBody: {
        query: mockGetPublicEventBodyQuery,
      },
      getGateState: {
        query: mockGetGateStateQuery,
      },
    },
  })),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  mockLocalEventsQuery.mockReset();
  mockGetEventSeoQuery.mockReset();
  mockResolveEventBySlugQuery.mockReset();
  mockListEventSitemapEntriesQuery.mockReset();
  mockLocalEventsQuery.mockResolvedValue({ events: [] });
  mockResolveEventBySlugQuery.mockResolvedValue({
    eventId: "evt-123",
    currentSlug: "great-show",
    redirect: false,
  });
  mockGetEventSeoQuery.mockResolvedValue(null);
  mockListEventSitemapEntriesQuery.mockResolvedValue([]);
  mockGetPublicEventBodyQuery.mockReset();
  mockGetPublicEventBodyQuery.mockResolvedValue({ body: null, imageMap: {} });
  mockGetGateStateQuery.mockReset();
  mockListEventDatesQuery.mockReset();
  mockListEventDatesQuery.mockResolvedValue({
    dates: [],
    recurrence: null,
    truncated: false,
  });
  mockPublicGetEventSeoQuery.mockReset();
  mockPublicGetEventSeoQuery.mockResolvedValue(null);
  mockPublicResolveEventBySlugQuery.mockReset();
  mockPublicResolveEventBySlugQuery.mockResolvedValue({
    eventId: "evt-123",
    currentSlug: "great-show",
    redirect: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.env = ORIGINAL_ENV;
});

describe("event server helpers", () => {
  it("loads event SEO payload from API response", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tickets.local";

    mockGetEventSeoQuery.mockResolvedValueOnce({
      id: "evt-123",
      slug: "great-show",
      title: "Great Show",
      description: "A wonderful evening of music.",
      startsAt: "2025-04-01T19:00:00.000Z",
      endsAt: "2025-04-01T21:00:00.000Z",
      status: "PUBLISHED",
      updatedAt: "2025-03-01T12:00:00.000Z",
      ticketingUrl: "https://tickets.local/checkout/great-show",
      images: ["https://cdn.local/great-show.jpg"],
      pricing: {
        currency: "USD",
        minPriceCents: 4500,
        availability: "limited",
        validFrom: "2025-02-15T00:00:00.000Z",
      },
    });

    const { loadEventSeo } = await import("../events");
    const event = await loadEventSeo("great-show");

    expect(event).not.toBeNull();
    expect(event?.url).toBe("https://tickets.local/events/great-show");
    expect(event?.pricing?.availability).toBe("limited");
    expect(event?.ticketingUrl).toBe(
      "https://tickets.local/checkout/great-show",
    );
    // No organizer override in the mocked payload — defaults to null, never
    // the dead hours-based constant (calm-honest-ux FR-004).
    expect(event?.refundCutoffAt).toBeNull();
  });

  it("passes the organizer's refundCutoffAt override through untouched", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tickets.local";

    mockGetEventSeoQuery.mockResolvedValueOnce({
      id: "evt-123",
      slug: "great-show",
      title: "Great Show",
      startsAt: "2025-04-01T19:00:00.000Z",
      status: "PUBLISHED",
      images: [],
      refundCutoffAt: "2025-03-30T00:00:00.000Z",
    });

    const { loadEventSeo } = await import("../events");
    const event = await loadEventSeo("great-show");

    expect(event?.refundCutoffAt).toBe("2025-03-30T00:00:00.000Z");
  });

  it("renders a SLUGLESS event instead of throwing (500 class closed)", async () => {
    // `mapEventToSeo` throws `TypeError("event.slug is required")` on a null
    // slug and `fetchEventSeo` only catches NOT_FOUND, so before this the
    // public page of every never-published draft 500'd. Drafts are slugged at
    // create now, but that is BEST-EFFORT (an event with no resolvable country
    // gets none), so the fallback has to hold here too.
    process.env.NEXT_PUBLIC_SITE_URL = "https://tickets.local";

    mockResolveEventBySlugQuery.mockResolvedValueOnce({
      eventId: "8f2e1a30-0000-4000-8000-00000000abcd",
      currentSlug: "8f2e1a30-0000-4000-8000-00000000abcd",
      redirect: false,
    });
    mockGetEventSeoQuery.mockResolvedValueOnce({
      id: "8f2e1a30-0000-4000-8000-00000000abcd",
      slug: null,
      title: "Untitled Draft",
      startsAt: "2025-04-01T19:00:00.000Z",
      status: "DRAFT",
      images: [],
    });

    const { loadEventSeo } = await import("../events");
    const event = await loadEventSeo("8f2e1a30-0000-4000-8000-00000000abcd");

    expect(event).not.toBeNull();
    // The id is the canonical fallback — `events.resolveBySlug` accepts a UUID
    // as a stable identifier, so the link resolves. A uuid canonical on a
    // noindex draft page is fine.
    expect(event?.url).toBe(
      "https://tickets.local/events/8f2e1a30-0000-4000-8000-00000000abcd",
    );
    expect(event?.slug).toBe("8f2e1a30-0000-4000-8000-00000000abcd");
  });

  it("returns null when API responds with 404", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tickets.local";

    const notFoundError = Object.create(
      TRPCClientError.prototype,
    ) as TRPCClientError<AppRouter>;
    Object.assign(notFoundError, { data: { code: "NOT_FOUND" } });
    mockResolveEventBySlugQuery.mockRejectedValueOnce(notFoundError);

    const { loadEventSeo } = await import("../events");
    const event = await loadEventSeo("missing");
    expect(event).toBeNull();
  });

  it("lists sitemap entries from collection endpoint", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tickets.local";

    mockListEventSitemapEntriesQuery.mockResolvedValueOnce([
      { slug: "alpha", updatedAt: "2025-01-01T00:00:00.000Z" },
      { slug: "beta", updatedAt: null },
    ]);

    mockResolveEventBySlugQuery
      .mockResolvedValueOnce({
        eventId: "evt-alpha",
        currentSlug: "alpha",
        redirect: false,
      })
      .mockResolvedValueOnce({
        eventId: "evt-beta",
        currentSlug: "beta",
        redirect: false,
      });

    mockGetEventSeoQuery
      .mockResolvedValueOnce({
        id: "evt-alpha",
        slug: "alpha",
        title: "Alpha",
        description: null,
        startsAt: "2025-01-01T00:00:00.000Z",
        endsAt: null,
        status: "PUBLISHED",
        updatedAt: null,
        ticketingUrl: null,
        images: [],
        pricing: null,
      })
      .mockResolvedValueOnce({
        id: "evt-beta",
        slug: "beta",
        title: "Beta",
        description: null,
        startsAt: "2025-01-02T00:00:00.000Z",
        endsAt: null,
        status: "PUBLISHED",
        updatedAt: null,
        ticketingUrl: null,
        images: [],
        pricing: null,
      });

    const { listEventSitemapEntries } = await import("../events");
    const entries = await listEventSitemapEntries();

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      url: "https://tickets.local/events/alpha",
    });
  });

  it("summarizes local events for the homepage", async () => {
    mockLocalEventsQuery.mockResolvedValueOnce({
      events: [
        {
          id: "evt-100",
          slug: "late-show",
          title: "Late Night Show",
          date: "Thu, May 1, 2025",
          venue: "Midnight Theater — Chicago, IL",
          priceLabel: "See details",
        },
      ],
    });

    const { listLocalEventSummaries } = await import("../events");
    const events = await listLocalEventSummaries();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "evt-100",
      title: "Late Night Show",
      priceLabel: "See details",
      venue: "Midnight Theater — Chicago, IL",
    });
  });

  it("falls back to smoke summaries when WEB_SMOKE_BUILD is true", async () => {
    process.env.WEB_SMOKE_BUILD = "true";
    const { listLocalEventSummaries } = await import("../events");
    const events = await listLocalEventSummaries();

    expect(events).not.toHaveLength(0);
    expect(events[0]?.title).toContain("Brooklyn");
    expect(mockLocalEventsQuery).not.toHaveBeenCalled();
  });

  it("derives a plaintext description excerpt from the body when SEO description is absent", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tickets.local";

    // Community listing: SEO payload carries no description; the copy lives in
    // the prose body. loadEventSeo should fall back to a body excerpt.
    mockGetEventSeoQuery.mockResolvedValueOnce({
      id: "evt-123",
      slug: "great-show",
      title: "Great Show",
      description: null,
      startsAt: "2025-04-01T19:00:00.000Z",
      endsAt: null,
      status: "PUBLISHED",
      updatedAt: null,
      ticketingUrl: null,
      images: [],
      pricing: null,
    });

    const longBodyText =
      "Join us every Monday for an intimate open mic night featuring local " +
      "songwriters, poets, and comedians sharing brand new work in a warm " +
      "candlelit room with great coffee and even better company all evening.";
    mockGetPublicEventBodyQuery.mockResolvedValueOnce({
      body: {
        blocks: [
          {
            type: "richText",
            doc: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: longBodyText }],
                },
              ],
            },
          },
        ],
      },
      imageMap: {},
    });

    const { loadEventSeo } = await import("../events");
    const event = await loadEventSeo("great-show");

    expect(event?.description).toBeTruthy();
    expect(event?.description).toMatch(/^Join us every Monday/);
    // Truncated on a word boundary with an ellipsis, kept near ~160 chars.
    expect(event?.description?.endsWith("…")).toBe(true);
    expect(event?.description?.length).toBeLessThanOrEqual(161);
    // No mid-word break: every token except the trailing ellipsis is intact.
    expect(longBodyText).toContain(
      event!.description!.replace(/…$/, "").trim(),
    );
  });

  it("keeps the existing null description when there is no body", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tickets.local";

    mockGetEventSeoQuery.mockResolvedValueOnce({
      id: "evt-123",
      slug: "great-show",
      title: "Great Show",
      description: null,
      startsAt: "2025-04-01T19:00:00.000Z",
      endsAt: null,
      status: "PUBLISHED",
      updatedAt: null,
      ticketingUrl: null,
      images: [],
      pricing: null,
    });
    mockGetPublicEventBodyQuery.mockResolvedValueOnce({
      body: null,
      imageMap: {},
    });

    const { loadEventSeo } = await import("../events");
    const event = await loadEventSeo("great-show");

    expect(event?.description ?? null).toBeNull();
  });

  it("does NOT fetch the body when the SEO payload already has a description", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tickets.local";

    mockGetEventSeoQuery.mockResolvedValueOnce({
      id: "evt-123",
      slug: "great-show",
      title: "Great Show",
      description: "A wonderful evening of music.",
      startsAt: "2025-04-01T19:00:00.000Z",
      endsAt: null,
      status: "PUBLISHED",
      updatedAt: null,
      ticketingUrl: null,
      images: [],
      pricing: null,
    });

    const { loadEventSeo } = await import("../events");
    const event = await loadEventSeo("great-show");

    expect(event?.description).toBe("A wonderful evening of music.");
    expect(mockGetPublicEventBodyQuery).not.toHaveBeenCalled();
  });
});

describe("isLockedByEventGate", () => {
  type GateState = import("../events").EventGateState;

  const gate = (overrides: Partial<GateState>): GateState => ({
    eventId: "evt-1",
    gateType: "NONE",
    passwordRequired: false,
    applicationRequired: false,
    viewerCanBypass: false,
    viewerIsUnlocked: false,
    viewerHasApplicationGrant: false,
    viewerHasInviteGrant: false,
    viewerRemovedByInviteReset: false,
    waitlistOpen: false,
    waitlistDescription: null,
    ...overrides,
  });

  it.each(["PASSWORD", "APPLICATION"] as const)(
    "does NOT lock a %s event when the API confirmed the viewer's invite grant",
    async (gateType) => {
      // The signed-out invite-link path: the API verified the forwarded
      // `th_ei_` grant, re-checked the invite, and folded it into the
      // gate's *Required flag. No password cookie is involved.
      const { isLockedByEventGate } = await import("../events");
      const state = gate({ gateType, viewerHasInviteGrant: true });
      expect(isLockedByEventGate(state, false)).toBe(false);
    },
  );

  it("does NOT lock an ungated (gateType NONE) event for an anonymous viewer", async () => {
    // Community listings / ordinary ungated events viewed by a crawler must
    // stay indexable — this is the SEO regression being fixed.
    const { isLockedByEventGate } = await import("../events");
    expect(isLockedByEventGate(gate({ gateType: "NONE" }), false)).toBe(false);
  });

  it("does NOT lock when there is no gate state", async () => {
    const { isLockedByEventGate } = await import("../events");
    expect(isLockedByEventGate(null, false)).toBe(false);
  });

  it("locks a PASSWORD event for an anonymous viewer without an unlock cookie", async () => {
    const { isLockedByEventGate } = await import("../events");
    const state = gate({ gateType: "PASSWORD", passwordRequired: true });
    expect(isLockedByEventGate(state, false)).toBe(true);
  });

  it("does NOT lock a PASSWORD event once a valid unlock cookie is present", async () => {
    const { isLockedByEventGate } = await import("../events");
    const state = gate({ gateType: "PASSWORD", passwordRequired: true });
    expect(isLockedByEventGate(state, true)).toBe(false);
  });

  it("does NOT lock a PASSWORD event when the viewer can bypass", async () => {
    // getEventGateState folds viewerCanBypass/viewerIsUnlocked into
    // passwordRequired, so a privileged viewer arrives with it already false.
    const { isLockedByEventGate } = await import("../events");
    const state = gate({
      gateType: "PASSWORD",
      passwordRequired: false,
      viewerCanBypass: true,
    });
    expect(isLockedByEventGate(state, false)).toBe(false);
  });

  it("locks an APPLICATION event for an anonymous viewer", async () => {
    const { isLockedByEventGate } = await import("../events");
    const state = gate({ gateType: "APPLICATION", applicationRequired: true });
    expect(isLockedByEventGate(state, false)).toBe(true);
  });

  it("does NOT lock an APPLICATION event once the viewer is approved/unlocked", async () => {
    const { isLockedByEventGate } = await import("../events");
    const state = gate({
      gateType: "APPLICATION",
      applicationRequired: false,
      viewerIsUnlocked: true,
    });
    expect(isLockedByEventGate(state, false)).toBe(false);
  });

  it("does NOT lock an APPLICATION event when the API confirmed the viewer's application grant", async () => {
    // The anonymous approved-applicant path: the API verified the forwarded
    // `th_ea_` grant, found its submission still APPROVED, and folded that
    // into applicationRequired. The web adds nothing of its own.
    const { isLockedByEventGate } = await import("../events");
    const state = gate({
      gateType: "APPLICATION",
      applicationRequired: false,
      viewerHasApplicationGrant: true,
    });
    expect(isLockedByEventGate(state, false)).toBe(false);
  });

  it("locks an APPLICATION event when the API did not honour a grant (revoked / other event / forged)", async () => {
    const { isLockedByEventGate } = await import("../events");
    const state = gate({
      gateType: "APPLICATION",
      applicationRequired: true,
      viewerHasApplicationGrant: false,
    });
    expect(isLockedByEventGate(state, false)).toBe(true);
  });

  it("does NOT lock an APPLICATION event once a valid unlock cookie is present", async () => {
    // Pins the pure function's contract only. NO CALLER supplies `true` here for
    // an APPLICATION event: both `unlocked-view/route.ts` and the checkout page
    // read the `th_eu_` cookie only when `gateType === "PASSWORD"`, matching the
    // API's own `event-read-access.ts`. Approved applicants come through
    // `applicationRequired` instead (the API-judged `th_ea_` grant).
    const { isLockedByEventGate } = await import("../events");
    const state = gate({ gateType: "APPLICATION", applicationRequired: true });
    expect(isLockedByEventGate(state, true)).toBe(false);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The edge-cache boundary.
//
// `/events/[...slug]` is served `public, s-maxage=120` with a `Vary` that has
// no `Cookie` in it, so anything the SSR render branches on is shared with
// every other viewer behind that colo. These two exports are what keep the
// viewer out of that render.
// ─────────────────────────────────────────────────────────────────────────────

describe("isEventGateActive", () => {
  type Gate = import("../events").PublicEventGate;

  const gate = (overrides: Partial<Gate>): Gate => ({
    eventId: "evt-1",
    gateType: "NONE",
    waitlistOpen: false,
    waitlistDescription: null,
    ...overrides,
  });

  it("is false for an ungated event", async () => {
    const { isEventGateActive } = await import("../events");
    expect(isEventGateActive(gate({ gateType: "NONE" }))).toBe(false);
  });

  it("is false when there is no gate state", async () => {
    const { isEventGateActive } = await import("../events");
    expect(isEventGateActive(null)).toBe(false);
  });

  it("is true for a PASSWORD event", async () => {
    const { isEventGateActive } = await import("../events");
    expect(isEventGateActive(gate({ gateType: "PASSWORD" }))).toBe(true);
  });

  it("is true for an APPLICATION event", async () => {
    const { isEventGateActive } = await import("../events");
    expect(isEventGateActive(gate({ gateType: "APPLICATION" }))).toBe(true);
  });

  it("takes NO viewer input at all — the whole point", async () => {
    // The signature has one parameter and `PublicEventGate` carries no viewer
    // field, so there is nothing here to vary the cached document by. If this
    // ever grows a second argument, the leak is back.
    const { isEventGateActive } = await import("../events");
    expect(isEventGateActive.length).toBe(1);
  });
});

describe("loadPublicEventGate", () => {
  const fullGateStatePayload = {
    eventId: "evt-1",
    visibility: "PUBLIC",
    gateType: "PASSWORD",
    passwordRequired: false,
    passwordSet: true,
    applicationRequired: false,
    waitlistStatus: "OPEN",
    waitlistOpen: true,
    waitlistOpensAt: null,
    waitlistDescription: "Tell me when tickets drop",
    waitlistCap: null,
    // The three viewer-scoped fields. A privileged viewer arrives with these
    // set; none of them may survive the boundary.
    viewerCanBypass: true,
    viewerIsUnlocked: true,
  };

  it("returns ONLY event-intrinsic fields", async () => {
    mockGetGateStateQuery.mockResolvedValue(fullGateStatePayload);
    const { loadPublicEventGate } = await import("../events");

    const gate = await loadPublicEventGate("evt-1");

    expect(gate).toEqual({
      eventId: "evt-1",
      gateType: "PASSWORD",
      waitlistOpen: true,
      waitlistDescription: "Tell me when tickets drop",
    });
    // Exact key set, not just "contains" — a future field added upstream must
    // be opted IN here rather than riding along into the cached document.
    expect(Object.keys(gate ?? {}).sort()).toEqual([
      "eventId",
      "gateType",
      "waitlistDescription",
      "waitlistOpen",
    ]);
  });

  it("drops viewerCanBypass / viewerIsUnlocked / passwordRequired / applicationRequired", async () => {
    mockGetGateStateQuery.mockResolvedValue(fullGateStatePayload);
    const { loadPublicEventGate } = await import("../events");

    const gate = await loadPublicEventGate("evt-1");

    for (const leaked of [
      "viewerCanBypass",
      "viewerIsUnlocked",
      "passwordRequired",
      "applicationRequired",
    ]) {
      expect(gate).not.toHaveProperty(leaked);
    }
  });

  it("returns the SAME gate regardless of who the upstream says the viewer is", async () => {
    const { loadPublicEventGate } = await import("../events");

    mockGetGateStateQuery.mockResolvedValue(fullGateStatePayload);
    const privileged = await loadPublicEventGate("evt-1");

    vi.resetModules();
    mockGetGateStateQuery.mockResolvedValue({
      ...fullGateStatePayload,
      passwordRequired: true,
      viewerCanBypass: false,
      viewerIsUnlocked: false,
    });
    const { loadPublicEventGate: reloaded } = await import("../events");
    const anonymous = await reloaded("evt-1");

    expect(anonymous).toEqual(privileged);
  });

  it("returns null for an unknown event", async () => {
    mockGetGateStateQuery.mockRejectedValue(
      new TRPCClientError("nope", {
        result: { error: { data: { code: "NOT_FOUND" } } },
      } as never),
    );
    const { loadPublicEventGate } = await import("../events");
    await expect(loadPublicEventGate("evt-missing")).resolves.toBeNull();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The de-identified loaders (edge-cache safety)
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPublicEventSeo", () => {
  /**
   * An OBSCURED event as the API resolves it FOR A TICKET HOLDER: exact street,
   * postcode and true coordinates, plus the two viewer scalars. Everything in
   * here is what must never reach a document served
   * `public, s-maxage=120` with no `Cookie` in its `Vary`.
   */
  const holderResolvedPayload = {
    id: "evt-123",
    slug: "great-show",
    title: "Great Show",
    description: "A wonderful evening of music.",
    startsAt: "2025-04-01T19:00:00.000Z",
    endsAt: null,
    status: "PUBLISHED",
    updatedAt: null,
    ticketingUrl: null,
    images: [],
    pricing: null,
    viewerHasTicket: true,
    viewerRsvped: true,
    location: {
      addressLine1: "411 Hidden Barn Rd",
      city: "Nashville",
      region: "TN",
      postalCode: "37209",
      countryCode: "US",
      latitude: 36.1601234,
      longitude: -86.7891234,
      isExact: true,
    },
  };

  /** The same event resolved for NOBODY: obfuscated circle, no address. */
  const anonymousResolvedPayload = {
    ...holderResolvedPayload,
    viewerHasTicket: false,
    viewerRsvped: undefined,
    location: {
      latitude: 36.1640678811007,
      longitude: -86.78964551850218,
      isExact: false,
      radiusMeters: 800,
      areaLabel: "Nashville, TN",
    },
  };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tickets.local";
  });

  it("asks the DE-IDENTIFIED client, never the identity-carrying one", async () => {
    // The load-bearing assertion. `getServerTrpcClient` mints a Bearer token
    // from the viewer's session; asking it for an OBSCURED event's SEO payload
    // is what wrote a hidden venue's street address into the shared document.
    mockPublicGetEventSeoQuery.mockResolvedValueOnce(anonymousResolvedPayload);

    const { loadPublicEventSeo } = await import("../events");
    await loadPublicEventSeo("great-show");

    expect(mockPublicGetEventSeoQuery).toHaveBeenCalledTimes(1);
    expect(mockGetEventSeoQuery).not.toHaveBeenCalled();
    // The slug resolution too: a redirect answered for an EDITOR of a draft
    // would put that draft's new slug in the shared document (N3).
    expect(mockPublicResolveEventBySlugQuery).toHaveBeenCalledWith({
      slug: "great-show",
    });
    expect(mockResolveEventBySlugQuery).not.toHaveBeenCalled();
  });

  it("drops viewerHasTicket and viewerRsvped even if the upstream sends them", async () => {
    // Belt to the transport's braces: if the de-identified client ever LOSES
    // its de-identification, the two scalars still do not ship.
    mockPublicGetEventSeoQuery.mockResolvedValueOnce(holderResolvedPayload);

    const { loadPublicEventSeo } = await import("../events");
    const event = await loadPublicEventSeo("great-show");

    expect(event).not.toBeNull();
    expect(event).not.toHaveProperty("viewerHasTicket");
    expect(event).not.toHaveProperty("viewerRsvped");
  });

  it("carries whatever location the de-identified read returned — obscured", async () => {
    mockPublicGetEventSeoQuery.mockResolvedValueOnce(anonymousResolvedPayload);

    const { loadPublicEventSeo } = await import("../events");
    const event = await loadPublicEventSeo("great-show");

    expect(event?.location?.isExact).toBe(false);
    expect(JSON.stringify(event)).not.toContain("411 Hidden Barn Rd");
    expect(JSON.stringify(event)).not.toContain("37209");
    expect(JSON.stringify(event)).not.toContain("36.1601234");
  });

  it("still falls back to a body excerpt when the payload has no description", async () => {
    mockPublicGetEventSeoQuery.mockResolvedValueOnce({
      ...anonymousResolvedPayload,
      description: null,
    });
    mockGetPublicEventBodyQuery.mockResolvedValueOnce({
      body: {
        version: 1,
        sections: [
          {
            id: "s1",
            kind: "section",
            layout: {
              type: "singleColumn",
              columns: [
                {
                  blocks: [
                    {
                      id: "b1",
                      type: "richText",
                      doc: {
                        type: "doc",
                        content: [
                          {
                            type: "paragraph",
                            content: [{ type: "text", text: "Body copy here." }],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      imageMap: {},
    });

    const { loadPublicEventSeo } = await import("../events");
    const event = await loadPublicEventSeo("great-show");

    expect(event?.description).toContain("Body copy here.");
    expect(event).not.toHaveProperty("viewerHasTicket");
  });

  // `publishedAt` crosses the wire as an ISO string and is the JSON-LD free
  // Offer's `validFrom` fallback. An older API omits it; a bad value must
  // degrade to null, never an Invalid Date that `toISOString()` throws on.
  it.each([
    [
      "a valid ISO string → Date",
      { publishedAt: "2026-09-01T12:00:00.000Z" },
      new Date("2026-09-01T12:00:00.000Z"),
    ],
    ["null → null", { publishedAt: null }, null],
    ["absent (an older API) → null", {}, null],
    ["not a date → null", { publishedAt: "not-a-date" }, null],
  ])("maps publishedAt: %s", async (_label, extra, expected) => {
    mockPublicGetEventSeoQuery.mockResolvedValueOnce({
      ...anonymousResolvedPayload,
      ...extra,
    });

    const { loadPublicEventSeo } = await import("../events");
    const event = await loadPublicEventSeo("great-show");

    expect(event).not.toBeNull();
    expect(event).toHaveProperty("publishedAt");
    expect(event?.publishedAt).toEqual(expected);
  });

  it("returns null for an unknown slug", async () => {
    mockPublicResolveEventBySlugQuery.mockRejectedValueOnce(
      new TRPCClientError("nope", {
        result: { error: { data: { code: "NOT_FOUND" } } },
      } as never),
    );
    const { loadPublicEventSeo } = await import("../events");
    await expect(loadPublicEventSeo("missing")).resolves.toBeNull();
  });
});

describe("slug resolution: viewer vs public", () => {
  it("resolvePublicEventSlug asks ONLY the de-identified client", async () => {
    mockPublicResolveEventBySlugQuery.mockResolvedValueOnce({
      eventId: "evt-123",
      currentSlug: "new-slug",
      redirect: true,
    });
    const { resolvePublicEventSlug } = await import("../events");

    await expect(resolvePublicEventSlug("old-slug")).resolves.toEqual({
      eventId: "evt-123",
      currentSlug: "new-slug",
      redirect: true,
    });
    expect(mockResolveEventBySlugQuery).not.toHaveBeenCalled();
  });

  it("resolvePublicEventSlug reads a withheld redirect (NOT_FOUND) as null", async () => {
    mockPublicResolveEventBySlugQuery.mockRejectedValueOnce(
      new TRPCClientError("nope", {
        result: { error: { data: { code: "NOT_FOUND" } } },
      } as never),
    );
    const { resolvePublicEventSlug } = await import("../events");

    await expect(resolvePublicEventSlug("old-draft-slug")).resolves.toBeNull();
  });

  it("resolvePublicEventShortLink asks ONLY the de-identified client", async () => {
    mockPublicResolveEventShortLinkQuery.mockResolvedValueOnce({
      currentSlug: "org/us/general/show--wqsdk6pxzi",
    });
    const { resolvePublicEventShortLink } = await import("../events");

    await expect(resolvePublicEventShortLink("wqsdk6pxzi")).resolves.toEqual({
      currentSlug: "org/us/general/show--wqsdk6pxzi",
    });
    expect(mockPublicResolveEventShortLinkQuery).toHaveBeenCalledWith({
      shortId: "wqsdk6pxzi",
    });
  });

  it("resolvePublicEventShortLink reads NOT_FOUND (a draft, an unknown id) as null", async () => {
    mockPublicResolveEventShortLinkQuery.mockRejectedValueOnce(
      new TRPCClientError("nope", {
        result: { error: { data: { code: "NOT_FOUND" } } },
      } as never),
    );
    const { resolvePublicEventShortLink } = await import("../events");

    await expect(resolvePublicEventShortLink("zzzzzzzzzz")).resolves.toBeNull();
  });

  it("resolvePublicEventShortLink rethrows anything that is not NOT_FOUND", async () => {
    mockPublicResolveEventShortLinkQuery.mockRejectedValueOnce(
      new Error("api down"),
    );
    const { resolvePublicEventShortLink } = await import("../events");

    await expect(resolvePublicEventShortLink("yyyyyyyyyy")).rejects.toThrow(
      "api down",
    );
  });

  it("resolveEventSlug asks the viewer's client (the checkout's editor bar)", async () => {
    const { resolveEventSlug } = await import("../events");

    await resolveEventSlug("old-slug");

    expect(mockResolveEventBySlugQuery).toHaveBeenCalledWith({
      slug: "old-slug",
    });
    expect(mockPublicResolveEventBySlugQuery).not.toHaveBeenCalled();
  });
});

describe("loadPublicEventDates", () => {
  const DATE = {
    eventDateId: "d1",
    startsAt: "2025-04-01T19:00:00.000Z",
    endsAt: null,
    viewerRsvped: true,
    status: "SCHEDULED" as const,
  };
  /** Weekly-Wednesday summary as the use-case returns it (`until` as a Date). */
  const RECURRENCE = {
    freq: "WEEKLY" as const,
    interval: 1,
    byday: ["WE"],
    until: new Date("2026-12-31T05:59:00.000Z"),
  };

  it("drops the per-date viewerRsvped at the boundary", async () => {
    mockListEventDatesQuery.mockResolvedValueOnce({
      dates: [DATE],
      recurrence: null,
      truncated: false,
    });

    const { loadPublicEventDates } = await import("../events");
    const { dates } = await loadPublicEventDates("evt-1");

    expect(dates).toHaveLength(1);
    expect(dates[0]).toMatchObject({ eventDateId: "d1" });
    expect(dates[0]).not.toHaveProperty("viewerRsvped");
  });

  it("returns the SAME payload whether or not the upstream says the viewer is going", async () => {
    mockListEventDatesQuery.mockResolvedValue({
      dates: [DATE],
      recurrence: RECURRENCE,
      truncated: true,
    });
    const { loadPublicEventDates } = await import("../events");
    const going = await loadPublicEventDates("evt-1");

    vi.resetModules();
    mockListEventDatesQuery.mockResolvedValue({
      dates: [{ ...DATE, viewerRsvped: false }],
      recurrence: RECURRENCE,
      truncated: true,
    });
    const { loadPublicEventDates: reloaded } = await import("../events");
    const notGoing = await reloaded("evt-1");

    expect(notGoing).toEqual(going);
  });

  it("carries the recurrence through, with `until` serialized as an ISO string", async () => {
    // The cadence is event-intrinsic, so unlike viewerRsvped it is ALLOWED to
    // ride the edge-cached document.
    mockListEventDatesQuery.mockResolvedValueOnce({
      dates: [DATE],
      recurrence: RECURRENCE,
      truncated: false,
    });

    const { loadPublicEventDates } = await import("../events");
    const { recurrence } = await loadPublicEventDates("evt-1");

    expect(recurrence).toEqual({
      freq: "WEEKLY",
      interval: 1,
      byday: ["WE"],
      until: "2026-12-31T05:59:00.000Z",
    });
  });

  it("carries the STATUS, the lead date and the rule flag through", async () => {
    // All three describe the schedule, not the reader, so they ride the cached
    // document. `status` in particular is what lets an ANONYMOUS reader see a
    // called-off night struck through instead of watching it vanish — while
    // the moderator controls beside it can never ride this payload.
    mockListEventDatesQuery.mockResolvedValueOnce({
      dates: [
        { ...DATE, status: "CANCELLED" },
        { ...DATE, eventDateId: "d2", status: "SCHEDULED" },
      ],
      recurrence: RECURRENCE,
      truncated: true,
      nextScheduledEventDateId: "d2",
      hasRecurrenceRule: true,
    });

    const { loadPublicEventDates } = await import("../events");
    const payload = await loadPublicEventDates("evt-1");

    expect(payload.dates.map((d) => d.status)).toEqual([
      "CANCELLED",
      "SCHEDULED",
    ]);
    // Not `dates[0]`: a called-off night sorts first like any other.
    expect(payload.nextScheduledEventDateId).toBe("d2");
    expect(payload.hasRecurrenceRule).toBe(true);
  });

  it("carries `truncated` through — the page cannot derive it", async () => {
    // The server's two caps (row limit + materialisation window) are invisible
    // from here, so the flag is the ONLY thing standing between an open-ended
    // weekly rule and a page printing "52 dates through Sep 2027". It is
    // event-intrinsic, so like the cadence it rides the cached document.
    mockListEventDatesQuery.mockResolvedValueOnce({
      dates: [DATE],
      recurrence: RECURRENCE,
      truncated: true,
    });

    const { loadPublicEventDates } = await import("../events");

    await expect(loadPublicEventDates("evt-1")).resolves.toMatchObject({
      truncated: true,
    });
  });

  it("degrades to an empty payload when the upstream read fails", async () => {
    // Non-blocking by design: the event page still renders, minus the dates.
    mockListEventDatesQuery.mockRejectedValueOnce(new Error("api down"));

    const { loadPublicEventDates } = await import("../events");

    await expect(loadPublicEventDates("evt-1")).resolves.toEqual({
      dates: [],
      recurrence: null,
      // A failed read knows nothing about the series, and "there is more"
      // is a claim — so the degraded payload makes none.
      truncated: false,
      nextScheduledEventDateId: null,
      // Same "we do not know", resolved toward the UNCHANGED single-date
      // rendering: `true` here would make a degraded read print "this series
      // has ended" over a listing that is running fine.
      hasRecurrenceRule: false,
    });
  });
});

describe("loadViewerDateRsvps", () => {
  const DATES = [
    {
      eventDateId: "d1",
      startsAt: "2025-04-01T19:00:00.000Z",
      endsAt: null,
      viewerRsvped: true,
    },
    {
      eventDateId: "d2",
      startsAt: "2025-04-08T19:00:00.000Z",
      endsAt: null,
      viewerRsvped: false,
    },
  ];

  it("asks the API to SKIP the recurrence read and returns just the flag map", async () => {
    // This backs `POST /api/events/[id]/viewer-state` — `private, no-store`,
    // rendering no cadence. Leaving `includeRecurrence` at its default cost one
    // extra Event row read per viewer per RSVP event page, for a value the
    // endpoint then threw away.
    mockListEventDatesQuery.mockResolvedValueOnce({
      dates: DATES,
      recurrence: null,
      truncated: false,
    });

    const { loadViewerDateRsvps } = await import("../events");

    await expect(loadViewerDateRsvps("evt-1")).resolves.toEqual({
      d1: true,
      d2: false,
    });
    expect(mockListEventDatesQuery).toHaveBeenCalledWith({
      eventId: "evt-1",
      includeRecurrence: false,
    });
  });

  it("degrades to an empty map when the upstream read fails", async () => {
    mockListEventDatesQuery.mockRejectedValueOnce(new Error("api down"));

    const { loadViewerDateRsvps } = await import("../events");

    await expect(loadViewerDateRsvps("evt-1")).resolves.toEqual({});
  });
});
