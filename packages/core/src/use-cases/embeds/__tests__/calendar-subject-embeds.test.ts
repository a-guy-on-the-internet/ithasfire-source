import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EmbedRecord } from "@th/types/repos/embeds";
import type { OrgMembership } from "@th/ports/repos/authz";
import { createFakeCalendarsRepo } from "@th/test-utils/fakes/venue-hierarchy";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";

import { upsertEmbed } from "../upsert-embed";
import { listEmbeds } from "../list-embeds";
import { revokeEmbed } from "../revoke-embed";
import {
  getEmbedForWidget,
  type GetEmbedForWidgetDeps,
} from "../get-embed-for-widget";
import {
  getEmbedCalendarEvents,
  type GetEmbedCalendarEventsDeps,
} from "../get-embed-calendar-events";

/**
 * The "calendar" embed subject (venue-hierarchy FR-010 / NFR-002):
 *
 * - RBAC: managing a calendar-subject embed = place-EDIT access on the
 *   calendar's own place (requireCalendarSubjectAccess — the exact `place`
 *   subject gate), pinned across upsert/list/revoke.
 * - Widget resolution: both public resolvers ride `getCalendarEventsPublic`,
 *   so the payload is that read's PUBLISHED+PUBLIC events for THAT calendar
 *   only, behind the VERIFIED+ACTIVE place gate.
 * - LEAK PIN (NFR-002): the payload key-sets are asserted exactly — no
 *   conflicts, no availability internals, no non-PUBLISHED events, ever.
 */

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EMBED_ID = "00000000-0000-4000-8000-000000000002";
const PLACE_ID = "00000000-0000-4000-8000-000000000005";
const ORG_ID = "00000000-0000-4000-8000-000000000006";
const EVENT_OWN = "00000000-0000-4000-8000-000000000011";
const EVENT_DRAFT = "00000000-0000-4000-8000-000000000012";
const EVENT_OTHER_CAL = "00000000-0000-4000-8000-000000000013";
const DOMAIN = "venue.example.com";
const HOST_ORIGIN = "https://venue.example.com";

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "Drkmttr",
    slug: "drkmttr",
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    humanIdsWithAccess: [ACTOR_ID],
    orgIdsWithAccess: [],
    ...overrides,
  } as unknown as PlaceRecord;
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_OWN,
    orgId: null,
    humanId: null,
    title: "Social Night",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    timezone: "America/Chicago",
    startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000),
    placeId: PLACE_ID,
    slug: "social-night",
    heroImageUrl: null,
    addressText: null,
    locality: "Nashville",
    region: "TN",
    regionCode: "us-tn",
    ...overrides,
  } as unknown as EventRecord;
}

type WorldOpts = {
  place?: PlaceRecord | null;
  memberships?: OrgMembership[];
  embed?: EmbedRecord | null;
};

function buildWorld(opts: WorldOpts = {}) {
  const calendars = createFakeCalendarsRepo();
  const socialClub = calendars.seedCalendar({
    placeId: PLACE_ID,
    name: "Social Club",
    slug: "social-club",
    isDefault: true,
  });
  const liveMusic = calendars.seedCalendar({
    placeId: PLACE_ID,
    name: "Live Music",
    slug: "live-music",
  });

  const calendarEmbed: EmbedRecord = {
    id: EMBED_ID,
    subjectType: "calendar",
    subjectId: socialClub.id,
    domain: DOMAIN,
    status: "ACTIVE",
    requireAuth: false,
    linkOut: false,
    defaultView: "calendar",
    viewToggle: true,
    createdBy: ACTOR_ID,
    createdAt: new Date("2026-01-01"),
  };

  const {
    place = makePlace(),
    memberships = [],
    embed = calendarEmbed,
  } = opts;

  // One PUBLISHED event and one DRAFT on the subject calendar, plus a
  // PUBLISHED event on the OTHER calendar — only the first may ever surface.
  const allEvents = [
    makeEvent({ id: EVENT_OWN, calendarId: socialClub.id } as never),
    makeEvent({
      id: EVENT_DRAFT,
      title: "Secret Draft",
      slug: "secret-draft",
      status: "DRAFT",
      calendarId: socialClub.id,
    } as never),
    makeEvent({
      id: EVENT_OTHER_CAL,
      title: "Loud Band",
      slug: "loud-band",
      calendarId: liveMusic.id,
    } as never),
  ];

  const gate = makeImageModerationGateFake({});
  const upsertFn = vi.fn(async (input: Record<string, unknown>) => ({
    ...calendarEmbed,
    ...input,
  }));
  const revokeFn = vi.fn(async () => ({ ...calendarEmbed, status: "REVOKED" }));

  const txRepos: Partial<TxRepos> = {
    embeds: { upsert: upsertFn, revoke: revokeFn } as never,
    audit: { log: vi.fn() } as never,
  };

  const repos = {
    embeds: {
      getById: vi.fn(async () => embed),
      listBySubject: vi.fn(async () => (embed ? [embed] : [])),
    },
    calendars,
    places: {
      getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)),
    },
    events: {
      listByCalendar: vi.fn(
        async ({
          calendarId,
          publishedOnly,
        }: {
          calendarId: string;
          publishedOnly?: boolean;
        }) =>
          allEvents.filter(
            (e) =>
              (e as { calendarId?: string }).calendarId === calendarId &&
              (!publishedOnly ||
                (e.status === "PUBLISHED" && e.visibility === "PUBLIC")),
          ),
      ),
      // FR-001 timezone + FR-023 currency come from the row, not the index.
      findManyByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          timezone: "America/Chicago",
          currency: "usd",
          gateType: "NONE",
        })),
      ),
      // FR-022/FR-023: no ticket types ⇒ soldOut false, priceLabel null.
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    tickets: { countCapacityUsageForTicketTypes: vi.fn(async () => []) },
    eventDates: { listByEventIds: vi.fn(async () => []) },
    organizations: { getById: vi.fn(async () => null) },
    humans: { getById: vi.fn(async () => null) },
    imageModerationRecords: gate.imageModerationRecords,
    authz: {
      getOrgMemberships: vi.fn(async () => memberships),
    },
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as TxRepos),
    ),
  } as unknown as Repos;

  return { repos, calendars, socialClub, liveMusic, upsertFn, revokeFn };
}

const widgetDeps = (repos: Repos): GetEmbedForWidgetDeps => ({
  repos: repos as GetEmbedForWidgetDeps["repos"],
  // The calendar branch never touches search — a throwing stub proves it.
  search: {
    unifiedSearch: vi.fn(async () => {
      throw new Error("search must not be consulted for calendar subjects");
    }),
  } as unknown as GetEmbedForWidgetDeps["search"],
  clock: { now: () => new Date() },
  publicAppUrl: "https://ithasfire.com",
});

const calendarEventsDeps = (repos: Repos): GetEmbedCalendarEventsDeps => ({
  repos: repos as GetEmbedCalendarEventsDeps["repos"],
  search: {
    unifiedSearch: vi.fn(async () => {
      throw new Error("search must not be consulted for calendar subjects");
    }),
  } as unknown as GetEmbedCalendarEventsDeps["search"],
  clock: { now: () => new Date() },
  publicAppUrl: "https://ithasfire.com",
});

// ── RBAC: upsert / list / revoke ─────────────────────────────────────────────

describe("upsertEmbed — calendar subject", () => {
  const input = (subjectId: string) => ({
    actorHumanId: ACTOR_ID,
    subjectType: "calendar" as const,
    subjectId,
    domain: DOMAIN,
    defaultView: "calendar" as const,
    viewToggle: true,
  });

  it("allows a direct human owner of the calendar's place (view fields allowed — calendars are a browse widget)", async () => {
    const w = buildWorld();
    const result = await upsertEmbed({ repos: w.repos }, input(w.socialClub.id));
    expect(result.embed.subjectType).toBe("calendar");
    expect(w.upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "calendar",
        subjectId: w.socialClub.id,
        defaultView: "calendar",
        viewToggle: true,
      }),
    );
  });

  it("allows an owning-org member with an edit role", async () => {
    const w = buildWorld({
      place: makePlace({ humanIdsWithAccess: [], orgIdsWithAccess: [ORG_ID] }),
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" }],
    });
    const result = await upsertEmbed({ repos: w.repos }, input(w.socialClub.id));
    expect(result.embed.subjectType).toBe("calendar");
  });

  it("rejects an owning-org member with only a viewer role", async () => {
    const w = buildWorld({
      place: makePlace({ humanIdsWithAccess: [], orgIdsWithAccess: [ORG_ID] }),
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" }],
    });
    await expect(
      upsertEmbed({ repos: w.repos }, input(w.socialClub.id)),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(w.upsertFn).not.toHaveBeenCalled();
  });

  it("rejects an actor with no ownership at all", async () => {
    const w = buildWorld({
      place: makePlace({
        humanIdsWithAccess: ["00000000-0000-4000-8000-000000000099"],
        orgIdsWithAccess: [],
      }),
    });
    await expect(
      upsertEmbed({ repos: w.repos }, input(w.socialClub.id)),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("rejects an unknown calendar id with CALENDAR_NOT_FOUND", async () => {
    const w = buildWorld();
    await expect(
      upsertEmbed(
        { repos: w.repos },
        input("99999999-9999-4999-8999-999999999999"),
      ),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
  });
});

describe("listEmbeds / revokeEmbed — calendar subject", () => {
  it("lists for a place owner; rejects a viewer-role org member", async () => {
    const owner = buildWorld();
    const result = await listEmbeds(
      { repos: owner.repos },
      {
        actorHumanId: ACTOR_ID,
        subjectType: "calendar" as const,
        subjectId: owner.socialClub.id,
      },
    );
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]!.subjectType).toBe("calendar");

    const viewer = buildWorld({
      place: makePlace({ humanIdsWithAccess: [], orgIdsWithAccess: [ORG_ID] }),
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" }],
    });
    await expect(
      listEmbeds(
        { repos: viewer.repos },
        {
          actorHumanId: ACTOR_ID,
          subjectType: "calendar" as const,
          subjectId: viewer.socialClub.id,
        },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("revokes for a place owner; rejects a non-owner", async () => {
    const owner = buildWorld();
    const result = await revokeEmbed(
      { repos: owner.repos },
      { actorHumanId: ACTOR_ID, embedId: EMBED_ID },
    );
    expect(result.embed.status).toBe("REVOKED");
    expect(owner.revokeFn).toHaveBeenCalledWith(EMBED_ID);

    const outsider = buildWorld({
      place: makePlace({ humanIdsWithAccess: [], orgIdsWithAccess: [] }),
    });
    await expect(
      revokeEmbed(
        { repos: outsider.repos },
        { actorHumanId: ACTOR_ID, embedId: EMBED_ID },
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(outsider.revokeFn).not.toHaveBeenCalled();
  });
});

// ── Widget resolution + NFR-002 leak pins ────────────────────────────────────

describe("getEmbedForWidget — calendar subject", () => {
  it("returns ONLY the subject calendar's PUBLISHED events, with the payload key-set pinned (NFR-002)", async () => {
    const w = buildWorld();
    // Seed availability that would leak if the resolver ever read overlays.
    w.calendars.seedAvailability({
      placeId: PLACE_ID,
      calendarId: w.socialClub.id,
      dayOfWeek: 5,
      isOpen: false,
      note: "internal blackout note",
    });

    const result = await getEmbedForWidget(widgetDeps(w.repos), {
      embedId: EMBED_ID,
      hostOrigin: HOST_ORIGIN,
      scope: "own",
    });

    // Top-level key-set pinned exactly: no conflicts / availability /
    // organization / owner keys on a calendar subject.
    expect(Object.keys(result).sort()).toEqual(["calendar", "embed", "events"]);
    expect(result.calendar).toEqual({
      id: w.socialClub.id,
      name: "Social Club",
      slug: "social-club",
    });

    // PUBLISHED+PUBLIC events of THIS calendar only — the draft and the other
    // calendar's event never surface.
    expect(result.events!.map((e) => e.id)).toEqual([EVENT_OWN]);

    // Event item key-set pinned exactly (the shared card contract).
    expect(Object.keys(result.events![0]!).sort()).toEqual(
      [
        "addressText",
        "currency",
        "endsAt",
        "gateType",
        "hasFreeTier",
        "hasPayWhatYouWantTier",
        "heroImageUrl",
        "id",
        "locality",
        "lowestBuyerTotalCents",
        "lowestPriceCents",
        "paidTierCount",
        "placeLabel",
        "region",
        "slug",
        "startsAt",
        "timezone",
        "title",
      ].sort(),
    );
    // The gate is read from the event row (the calendar read has none).
    expect(result.events![0]!.gateType).toBe("NONE");
    // The card prints its date in the event's own zone (the calendar read's).
    expect(result.events![0]!.timezone).toBe("America/Chicago");
    // The calendar read projects no place name, so the card falls back to
    // locality / region.
    expect(result.events![0]!.placeLabel).toBeNull();

    // Nothing internal rides along in ANY nested corner of the payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("internal blackout note");
    expect(serialized).not.toContain("conflict");
    expect(serialized).not.toContain("availability");
    expect(serialized).not.toContain("Secret Draft");
  });

  it("each card carries its event's own zone, and the platform default for an unusable one", async () => {
    const w = buildWorld();
    const events = w.repos.events as unknown as {
      listByCalendar: (args: never) => Promise<EventRecord[]>;
    };
    const original = events.listByCalendar;
    const listWithZone = (timezone: string) =>
      vi.fn(async (args: never) =>
        (await original(args)).map((e) => ({ ...e, timezone })),
      );
    const run = () =>
      getEmbedForWidget(widgetDeps(w.repos), {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        scope: "own",
      });

    events.listByCalendar = listWithZone("America/Denver");
    expect((await run()).events!.map((e) => e.timezone)).toEqual([
      "America/Denver",
    ]);

    events.listByCalendar = listWithZone("Not/AZone");
    expect((await run()).events!.map((e) => e.timezone)).toEqual([
      "America/Chicago",
    ]);
  });

  it("gates an UNVERIFIED place exactly like the public calendar read (collapsed CALENDAR_NOT_FOUND — no existence oracle)", async () => {
    const w = buildWorld({
      place: makePlace({ verificationStatus: "UNVERIFIED" }),
    });
    await expect(
      getEmbedForWidget(widgetDeps(w.repos), {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        scope: "own",
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
  });
});

describe("getEmbedCalendarEvents — calendar subject", () => {
  it("returns the calendar's name as ownerName and link-out-only events, key-set pinned (NFR-002)", async () => {
    const w = buildWorld();
    w.calendars.seedAvailability({
      placeId: PLACE_ID,
      calendarId: null,
      date: new Date("2026-09-15T00:00:00Z"),
      isOpen: false,
      note: "venue closed",
    });

    const result = await getEmbedCalendarEvents(calendarEventsDeps(w.repos), {
      embedId: EMBED_ID,
      hostOrigin: HOST_ORIGIN,
      scope: "own",
    });

    expect(Object.keys(result).sort()).toEqual(["embed", "events", "ownerName"]);
    expect(result.ownerName).toBe("Social Club");
    expect(result.events.map((e) => e.id)).toEqual([EVENT_OWN]);
    expect(result.events[0]).toMatchObject({
      status: "PUBLISHED",
      // No calendar branch exists in assertEventAllowedForEmbed (fail-closed
      // checkout) — the widget must link out, never offer in-iframe checkout.
      checkoutEligible: false,
    });
    expect(Object.keys(result.events[0]!).sort()).toEqual(
      [
        "checkoutEligible",
        "city",
        "endsAt",
        "id",
        "listingPrice",
        "location",
        "occurrence",
        "placeLabel",
        "priceLabel",
        "region",
        "slug",
        "soldOut",
        "startsAt",
        "status",
        "timezone",
        "title",
      ].sort(),
    );
    expect(result.events[0]).toMatchObject({ timezone: "America/Chicago", occurrence: null });
    // The calendar read projects no place name, so the calendar view falls
    // back to city / region, as the list view does for this subject.
    expect(result.events[0]!.placeLabel).toBeNull();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("venue closed");
    expect(serialized).not.toContain("Secret Draft");
    expect(serialized).not.toContain("Loud Band");
  });

  // FR-022 / FR-023 reach the NAMED-CALENDAR leg too — this leg reads through
  // `getCalendarEventsPublic`, whose `.strict()` public shape carries neither
  // stock nor currency, so both are resolved here from batched event reads.
  it("carries soldOut and priceLabel on the calendar leg, in the event's own currency", async () => {
    const w = buildWorld();
    const repos = w.repos as unknown as {
      events: {
        findManyByIds: ReturnType<typeof vi.fn>;
        listTicketTypesForEventIds: ReturnType<typeof vi.fn>;
      };
      tickets: { countCapacityUsageForTicketTypes: ReturnType<typeof vi.fn> };
    };
    // A stamped 0% rate and no fee policy anywhere: the all-in figure is
    // exactly the face, so the label below reads like one.
    repos.events.findManyByIds = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        orgId: null,
        timezone: "America/Chicago",
        currency: "cad",
        admissionTaxRateBps: 0,
        placeId: null,
        savedLocationId: null,
      })),
    );
    Object.assign(w.repos, {
      payoutTerms: {
        listByEventIds: vi.fn(async (ids: readonly string[]) =>
          new Map(ids.map((id) => [id, []] as const)),
        ),
        listLinesByTermsIds: vi.fn(async () => new Map()),
      },
      feePolicies: {
        getByIds: vi.fn(async () => new Map()),
        resolveEffectiveForScopes: vi.fn(async () => new Map()),
        resolveEffective: vi.fn(async () => null),
      },
      savedLocations: { getById: vi.fn(async () => null) },
    });
    repos.events.listTicketTypesForEventIds = vi.fn(async (ids: string[]) =>
      ids.includes(EVENT_OWN)
        ? [
            {
              eventId: EVENT_OWN,
              id: "tt-ga",
              name: "GA",
              description: null,
              priceCents: 1800,
              pricingMode: "FIXED" as const,
              minimumCents: null,
              suggestedCents: null,
              capacity: 40,
              status: "ACTIVE",
              resaleAllowed: false,
              resaleCapCents: null,
              transferAllowed: true,
              scheduledPriceCents: null,
              scheduledPriceAt: null,
              salesOpenAt: null,
              salesCloseAt: null,
            },
          ]
        : [],
    );
    repos.tickets.countCapacityUsageForTicketTypes = vi.fn(async () => [
      { ticketTypeId: "tt-ga", issued: 40, held: 0 },
    ]);

    const result = await getEmbedCalendarEvents(calendarEventsDeps(w.repos), {
      embedId: EMBED_ID,
      hostOrigin: HOST_ORIGIN,
      scope: "own",
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: EVENT_OWN,
      soldOut: true,
      priceLabel: "CA$18",
    });
    // Still no stock internals on the unauthenticated wire.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("capacity");
    expect(serialized).not.toContain("issued");
  });

  // FR-003 (event-calendar-redesign) on the named-calendar leg: the core
  // read must admit a listing on ANY in-window night (opt-in flag), the
  // window must be explicit and equal to the read's own 90-day clamp, and
  // expansion must trim to that same window.
  it("opts the core read into includeDateOccurrences with an explicit to = from + 90d, and trims expanded nights to it", async () => {
    const w = buildWorld();
    const DAY = 24 * 60 * 60 * 1000;
    const nightIds = [
      "dddddddd-0001-4001-8001-dddddddddddd",
      "dddddddd-0002-4002-8002-dddddddddddd",
      "dddddddd-0003-4003-8003-dddddddddddd",
    ];
    // Nights at +7d (inside), +59d (inside, just under now + 60d) and +70d
    // (past `to`). The listing's pin mirrors the first night.
    (w.repos.eventDates.listByEventIds as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: nightIds[0], eventId: EVENT_OWN, ordinal: 1, startsAt: new Date(Date.now() + 7 * DAY), endsAt: null, status: "SCHEDULED", createdAt: new Date(), updatedAt: new Date() },
      { id: nightIds[1], eventId: EVENT_OWN, ordinal: 2, startsAt: new Date(Date.now() + 59 * DAY), endsAt: null, status: "SCHEDULED", createdAt: new Date(), updatedAt: new Date() },
      { id: nightIds[2], eventId: EVENT_OWN, ordinal: 3, startsAt: new Date(Date.now() + 70 * DAY), endsAt: null, status: "SCHEDULED", createdAt: new Date(), updatedAt: new Date() },
    ]);

    const result = await getEmbedCalendarEvents(calendarEventsDeps(w.repos), {
      embedId: EMBED_ID,
      hostOrigin: HOST_ORIGIN,
      scope: "own",
    });

    const call = (w.repos.events.listByCalendar as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { from: Date; to: Date; includeDateOccurrences?: boolean };
    expect(call.includeDateOccurrences).toBe(true);
    expect(call.to.getTime() - call.from.getTime()).toBe(90 * DAY);
    // ~30-day lookback (local-day arithmetic; allow DST slack).
    expect(Math.abs(Date.now() - call.from.getTime() - 30 * DAY)).toBeLessThan(2 * 60 * 60 * 1000);

    // Two in-window nights, absolute index over all three scheduled rows;
    // the +70d night is past `to` and gone.
    expect(result.events.map((e) => e.occurrence)).toEqual([
      { index: 1, total: 3, eventDateId: nightIds[0] },
      { index: 2, total: 3, eventDateId: nightIds[1] },
    ]);
    expect(result.events.every((e) => e.startsAt!.getTime() <= call.to.getTime())).toBe(true);
  });

  it("reads through the PUBLISHED-only core path (an inactive place yields the collapsed CALENDAR_NOT_FOUND, not data)", async () => {
    const w = buildWorld({ place: makePlace({ status: "SUSPENDED" }) });
    await expect(
      getEmbedCalendarEvents(calendarEventsDeps(w.repos), {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        scope: "own",
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
  });
});
