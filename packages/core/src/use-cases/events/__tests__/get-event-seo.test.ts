import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type {
  EventRecord,
  EventSlugResolution,
  EventTicketTypeSummary,
} from "@th/ports/repos/events";
import type {
  ImageModerationRecord,
  ImageModerationStatus,
} from "@th/ports/repos/image-moderation-records";
import type {
  EventHumanRecord,
  OrganizationRecord,
  PlaceRecord,
} from "@th/types";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { getEventSeo, type GetEventSeoDeps } from "../get-event-seo";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment; no fixture here carries a schedule, so
// the resolved price is the list price and every existing expectation holds.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const BASE_EVENT: EventRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: null,
  humanId: "22222222-2222-4222-8222-222222222222",
  title: "Mission Supper Club",
  status: "PUBLISHED",
  attendanceMode: "TICKETED",
  stewardship: "OWNED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  timezone: "America/Los_Angeles",
  startsAt: new Date("2024-11-20T20:00:00.000Z"),
  endsAt: new Date("2024-11-20T23:00:00.000Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: "123 Valencia St",
  countryCode: "US",
  region: "CA",
  locality: "San Francisco",
  postalCode: "94103",
  lat: 37.7675,
  lng: -122.421,
  slug: "mission-supper-club",
  shortId: "msn123",
  regionCode: "us-ca",
  publishedAt: new Date("2024-10-01T00:00:00.000Z"),
  agreementPrimaryId: "33333333-3333-4333-8333-333333333333",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
  createdAt: new Date("2024-08-01T00:00:00.000Z"),
  updatedAt: new Date("2024-10-05T12:00:00.000Z"),
};

const BASE_PLACE: PlaceRecord = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "The Basement East",
  // PRODUCTION SHAPE: `Place.slug` is a multi-segment DIRECTORY key that no
  // route resolves. Seeded dev DBs write a flat slug instead, which is exactly
  // what hid the dead-link bug — so this fixture keeps the real shape, and it
  // must never appear in an emitted `placeSlug`.
  slug: "us/tn/the-basement-east--a1b2c3d4e5",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  formattedAddress: "917 Woodland St, Nashville, TN",
  addressLine1: "917 Woodland St",
  addressLine2: null,
  city: "Nashville",
  region: "TN",
  postalCode: "37206",
  countryCode: "US",
  capacity: 400,
  lat: 36.176,
  lng: -86.751,
  phone: null,
  website: null,
  websiteSource: "UNKNOWN",
  addressHash: null,
  admissionTaxRateBps: null,
  taxRateSource: null,
  taxRateFetchedAt: null,
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  listedInDirectory: true,
  acceptsBookingRequests: false,
  // A venue that publishes its address. EXPLICIT because the venue ceiling in
  // `buildEventSeo` fails closed: a place fake that omits this withholds, and
  // every event at it renders withheld too.
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  orgIdsWithAccess: [],
  humanIdsWithAccess: [],
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
};

const TICKET_TYPES: EventTicketTypeSummary[] = [
  {
    id: "tt-ga",
    name: "GA",
    priceCents: 4500,
    capacity: 100,
    status: "ACTIVE",
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
  },
  {
    id: "tt-vip",
    name: "VIP",
    priceCents: 9000,
    capacity: 25,
    status: "ACTIVE",
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
  },
];

const createDeps = () => {
  const resolveBySlug = vi.fn<
    [slug: string],
    Promise<EventSlugResolution | null>
  >();
  const getById = vi.fn<[eventId: string], Promise<EventRecord | null>>();
  const listTicketTypes = vi.fn<
    [eventId: string],
    Promise<EventTicketTypeSummary[]>
  >();
  const listByEvent = vi.fn<[eventId: string], Promise<EventHumanRecord[]>>();
  const viewerHoldsActiveTicketForEvent = vi.fn();
  const rsvpExistsForUser = vi.fn(async () => false);
  const listPayoutTermsByEvent = vi.fn<[eventId: string], Promise<[]>>(
    async () => [],
  );
  const listPayoutTermLines = vi.fn<[agreementId: string], Promise<[]>>(
    async () => [],
  );
  const getFeePolicyById = vi.fn(async () => null);
  const findActiveFeePolicyAtScope = vi.fn(async () => null);
  const resolveEffective = vi.fn(async () => null);
  const getPlaceById = vi.fn<[placeId: string], Promise<PlaceRecord | null>>(
    async () => null,
  );
  const getOrgById = vi.fn<[orgId: string], Promise<OrganizationRecord | null>>(
    async () => null,
  );
  const resolveByKeys = vi.fn(
    async (_keys: string[]) => new Map<string, ImageModerationRecord>(),
  );
  // The venue's EntityPage — its `slug` is the ONLY value `/places/[slug]`
  // resolves on, so it (not `Place.slug`) is what `placeSlug` must carry.
  // Defaults to "no page", the state bulk-imported venues are actually in.
  const getEntityPageByOwner = vi.fn<
    [ownerType: string, ownerId: string],
    Promise<{ slug: string; visibility: "PUBLIC" | "PRIVATE" | "UNLISTED" } | null>
  >(async () => null);

  // Edit rights on an unpublished event (N3): org membership / staff roles.
  const getOrgMembership = vi.fn(async () => null as { role: string } | null);
  const getStaffRolesForHumanId = vi.fn(async () => [] as string[]);

  const repos = {
    authz: {
      getOrgMembership,
      getStaffRolesForHumanId,
      getHumanDelegation: vi.fn(async () => null),
    },
    events: {
      resolveBySlug,
      getById,
      listTicketTypes,
    },
    places: {
      getById: getPlaceById,
    },
    entityPages: {
      getByOwner: getEntityPageByOwner,
    },
    organizations: {
      getById: getOrgById,
    },
    eventHumans: {
      listByEvent,
    },
    tickets: {
      viewerHoldsActiveTicketForEvent,
    },
    eventRsvps: {
      existsForUser: rsvpExistsForUser,
    },
    payoutTerms: {
      listByEvent: listPayoutTermsByEvent,
      listLines: listPayoutTermLines,
    },
    feePolicies: {
      getById: getFeePolicyById,
      findActiveAtScope: findActiveFeePolicyAtScope,
      resolveEffective,
    },
    imageModerationRecords: {
      resolveByKeys,
    },
  } as unknown as Repos;

  const logger = createTestLogger();

  const deps: GetEventSeoDeps = {
    repos,
    authz: { hasStaffRole: async () => ({ allowed: false }) },
    clock: testClock,
    logger,
  };

  return {
    deps,
    logger,
    resolveBySlug,
    getById,
    listTicketTypes,
    listByEvent,
    viewerHoldsActiveTicketForEvent,
    rsvpExistsForUser,
    getPlaceById,
    getEntityPageByOwner,
    getOrgById,
    resolveByKeys,
    getOrgMembership,
    getStaffRolesForHumanId,
  };
};

const HERO_KEY = "events/hero/images/hero-1.png";
const HERO_URL = `https://cdn.example/${HERO_KEY}`;

function heroModerationRecord(
  status: ImageModerationStatus,
): ImageModerationRecord {
  return {
    id: "rec-hero",
    storageKey: HERO_KEY,
    kind: "EVENT_HERO",
    status,
    subjectType: "EVENT",
    subjectId: BASE_EVENT.id,
    publicUrl: HERO_URL,
    contentType: "image/png",
    createdByHumanId: "human-1",
    maxSeverity: null,
    categories: null,
    provider: null,
    degraded: false,
    moderatedAt: null,
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date("2026-07-08T00:00:00.000Z"),
    createdAt: new Date("2026-07-08T00:00:00.000Z"),
    updatedAt: new Date("2026-07-08T00:00:00.000Z"),
  };
}

describe("getEventSeo", () => {
  let context: ReturnType<typeof createDeps>;

  beforeEach(() => {
    context = createDeps();
  });

  it("returns seo payload with pricing information", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(BASE_EVENT);
    context.listTicketTypes.mockResolvedValue(TICKET_TYPES);
    context.listByEvent.mockResolvedValue([]);
    context.viewerHoldsActiveTicketForEvent.mockResolvedValue(false);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result).toMatchObject({
      id: BASE_EVENT.id,
      slug: BASE_EVENT.slug,
      title: BASE_EVENT.title,
      startsAt: BASE_EVENT.startsAt.toISOString(),
      endsAt: BASE_EVENT.endsAt?.toISOString(),
      timezone: BASE_EVENT.timezone,
      viewerHasTicket: false,
      attendanceMode: "TICKETED",
      stewardship: "OWNED",
      visibility: "PUBLIC",
      status: BASE_EVENT.status,
      location: {
        addressLine1: BASE_EVENT.addressText,
        city: BASE_EVENT.locality,
        region: BASE_EVENT.region,
        postalCode: BASE_EVENT.postalCode,
      },
      pricing: {
        minPriceCents: 4500,
        maxPriceCents: 9000,
      },
    });
    expect(context.logger.info).toHaveBeenCalledWith(
      "events.get_seo",
      expect.objectContaining({
        slug: "mission-supper-club",
        eventId: BASE_EVENT.id,
      }),
    );
    // TICKETED events never query RSVP state.
    expect(context.rsvpExistsForUser).not.toHaveBeenCalled();
    expect(result.viewerRsvped).toBeUndefined();
  });

  it("exposes attendanceMode/stewardship and the viewer's RSVP state for community listings", async () => {
    const communityEvent: EventRecord = {
      ...BASE_EVENT,
      humanId: null,
      attendanceMode: "RSVP",
      stewardship: "COMMUNITY",
    };
    context.resolveBySlug.mockResolvedValue({
      eventId: communityEvent.id,
      currentSlug: communityEvent.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(communityEvent);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
    context.rsvpExistsForUser.mockResolvedValue(true);

    const viewerHumanId = "99999999-9999-4999-8999-999999999999";
    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
      viewerHumanId,
    });

    expect(result.attendanceMode).toBe("RSVP");
    expect(result.stewardship).toBe("COMMUNITY");
    expect(result.viewerRsvped).toBe(true);
    expect(context.rsvpExistsForUser).toHaveBeenCalledWith({
      eventId: communityEvent.id,
      humanId: viewerHumanId,
    });

    // Anonymous viewers get no RSVP state (and no query).
    context.rsvpExistsForUser.mockClear();
    const anonResult = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });
    expect(anonResult.viewerRsvped).toBeUndefined();
    expect(context.rsvpExistsForUser).not.toHaveBeenCalled();
  });

  it("passes visibility through for PRIVATE published events", async () => {
    // The UI gates the universal "Suggest an edit" CTA on PUBLIC visibility
    // (FR-006) — a PRIVATE published event must surface its visibility.
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue({
      ...BASE_EVENT,
      visibility: "PRIVATE",
    });
    context.listTicketTypes.mockResolvedValue(TICKET_TYPES);
    context.listByEvent.mockResolvedValue([]);
    context.viewerHoldsActiveTicketForEvent.mockResolvedValue(false);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result.visibility).toBe("PRIVATE");
  });

  it("throws not_found when slug resolution fails", async () => {
    context.resolveBySlug.mockResolvedValue(null);

    await expect(
      getEventSeo(context.deps, { slug: "missing-event" }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(context.getById).not.toHaveBeenCalled();
  });

  it("throws not_found when slug redirects", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: true,
    });
    // The readability check runs first, so the target must be readable.
    context.getById.mockResolvedValue(BASE_EVENT);

    await expect(
      getEventSeo(context.deps, { slug: "legacy-slug" }),
    ).rejects.toMatchObject({ code: "EVENT_SLUG_REDIRECT" });
  });

  it("throws when event record does not exist", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(null);

    await expect(
      getEventSeo(context.deps, { slug: "missing-record" }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("keeps the location redacted for ticket holders before the reveal time", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue({
      ...BASE_EVENT,
      locationMode: "OBSCURED",
      locationLabel: "Downtown Los Angeles",
      addressRevealAt: new Date(TEST_NOW.getTime() + 60 * 60 * 1000),
    });
    context.listTicketTypes.mockResolvedValue(TICKET_TYPES);
    context.listByEvent.mockResolvedValue([]);
    context.viewerHoldsActiveTicketForEvent.mockResolvedValue(true);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
      viewerHumanId: "99999999-9999-4999-8999-999999999999",
    });

    expect(result.viewerHasTicket).toBe(true);
    expect(result.timezone).toBe("America/Los_Angeles");
    expect(result.location?.isExact).toBe(false);
    expect(result.location?.areaLabel).toBe("Downtown Los Angeles");
    expect(result.location?.addressLine1).toBeNull();
  });

  it("reveals the exact address to ticket holders after the reveal time", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue({
      ...BASE_EVENT,
      locationMode: "OBSCURED",
      addressRevealAt: new Date(TEST_NOW.getTime() - 60 * 60 * 1000),
    });
    context.listTicketTypes.mockResolvedValue(TICKET_TYPES);
    context.listByEvent.mockResolvedValue([]);
    context.viewerHoldsActiveTicketForEvent.mockResolvedValue(true);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
      viewerHumanId: "99999999-9999-4999-8999-999999999999",
    });

    expect(result.viewerHasTicket).toBe(true);
    expect(result.location?.isExact).toBe(true);
    expect(result.location?.addressLine1).toBe(BASE_EVENT.addressText);
  });

  it("maps eventHumans to performers, filtering by role and respecting sortOrder", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(BASE_EVENT);
    context.listTicketTypes.mockResolvedValue(TICKET_TYPES);
    context.viewerHoldsActiveTicketForEvent.mockResolvedValue(false);

    const now = new Date();
    context.listByEvent.mockResolvedValue([
      // VENDOR — should be excluded
      {
        id: "eh-vendor",
        eventId: BASE_EVENT.id,
        humanId: null,
        externalName: "Merch Tent",
        externalUrl: null,
        role: "VENDOR" as const,
        customRoleLabel: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
      // PERFORMER with URL — should appear, sortOrder 2
      {
        id: "eh-perf",
        eventId: BASE_EVENT.id,
        humanId: null,
        externalName: "Alice Coltrane",
        externalUrl: "https://alice.example.com",
        role: "PERFORMER" as const,
        customRoleLabel: null,
        sortOrder: 2,
        createdAt: now,
        updatedAt: now,
      },
      // DJ without URL — should appear, sortOrder 1 (comes first)
      {
        id: "eh-dj",
        eventId: BASE_EVENT.id,
        humanId: null,
        externalName: "DJ Shadow",
        externalUrl: null,
        role: "DJ" as const,
        customRoleLabel: null,
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      },
      // INSTRUCTOR — should appear, sortOrder 3
      {
        id: "eh-inst",
        eventId: BASE_EVENT.id,
        humanId: null,
        externalName: "Yoga Teacher",
        externalUrl: null,
        role: "INSTRUCTOR" as const,
        customRoleLabel: null,
        sortOrder: 3,
        createdAt: now,
        updatedAt: now,
      },
      // null externalName — should fall back to "Unknown"
      {
        id: "eh-null",
        eventId: BASE_EVENT.id,
        humanId: null,
        externalName: null,
        externalUrl: null,
        role: "SPEAKER" as const,
        customRoleLabel: null,
        sortOrder: 4,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    // Sorted by sortOrder: DJ(1), PERFORMER(2), INSTRUCTOR(3), SPEAKER(4)
    // VENDOR excluded
    expect(result.performers).toEqual([
      { eventHumanId: "eh-dj", name: "DJ Shadow", role: "DJ", url: null },
      {
        eventHumanId: "eh-perf",
        name: "Alice Coltrane",
        role: "PERFORMER",
        url: "https://alice.example.com",
      },
      {
        eventHumanId: "eh-inst",
        name: "Yoga Teacher",
        role: "INSTRUCTOR",
        url: null,
      },
      { eventHumanId: "eh-null", name: "Unknown", role: "SPEAKER", url: null },
    ]);
  });

  it("resolves the linked place and surfaces its slug when directory-listed and location is exact", async () => {
    const eventWithPlace: EventRecord = {
      ...BASE_EVENT,
      placeId: "44444444-4444-4444-8444-444444444444",
    };
    context.resolveBySlug.mockResolvedValue({
      eventId: eventWithPlace.id,
      currentSlug: eventWithPlace.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(eventWithPlace);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
    // Venue-owned (the event's human owns the place) → confirmed by
    // construction; the directory-listed gate is what this case pins.
    context.getPlaceById.mockResolvedValue({
      ...BASE_PLACE,
      id: eventWithPlace.placeId!,
      humanIdsWithAccess: [BASE_EVENT.humanId!],
    });
    context.getEntityPageByOwner.mockResolvedValue({
      slug: "the-basement-east-a1b2c3d4",
      visibility: "PUBLIC",
    });

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(context.getPlaceById).toHaveBeenCalledWith(eventWithPlace.placeId);
    expect(context.getEntityPageByOwner).toHaveBeenCalledWith(
      "PLACE",
      eventWithPlace.placeId,
    );
    expect(result.location?.isExact).toBe(true);
    expect(result.location).toMatchObject({
      // The ENTITY PAGE slug, not `Place.slug`.
      placeSlug: "the-basement-east-a1b2c3d4",
      name: "The Basement East",
      venueConfirmed: true,
    });
    // The route is a single non-catch-all segment; a `/` here means the
    // directory key leaked back into the link.
    expect(result.location?.placeSlug).not.toContain("/");
    expect(result.location?.placeSlug).not.toBe(BASE_PLACE.slug);
  });

  // ── EntityPage.visibility gates the link ────────────────────────────────
  //
  // A PRIVATE page keeps its slug while `/places/[slug]` 404s for everyone; an
  // UNLISTED page renders, but its owner was told "it stays out of search and
  // browse" when they chose it — and the public event page is crawler-visible,
  // so linking one there manufactures exactly that discovery. Both must emit
  // null, the same way `humans.listForSearchIndex` refuses to index a
  // non-PUBLIC human page.
  it.each([
    ["PRIVATE", "the route 404s for everyone"],
    ["UNLISTED", "the owner opted out of discovery"],
  ] as const)(
    "emits a NULL placeSlug for a %s venue page (%s)",
    async (visibility) => {
      const eventWithPlace: EventRecord = {
        ...BASE_EVENT,
        placeId: "44444444-4444-4444-8444-444444444444",
      };
      context.resolveBySlug.mockResolvedValue({
        eventId: eventWithPlace.id,
        currentSlug: eventWithPlace.slug!,
        redirect: false,
      });
      context.getById.mockResolvedValue(eventWithPlace);
      context.listTicketTypes.mockResolvedValue([]);
      context.listByEvent.mockResolvedValue([]);
      context.getPlaceById.mockResolvedValue({
        ...BASE_PLACE,
        id: eventWithPlace.placeId!,
        humanIdsWithAccess: [BASE_EVENT.humanId!],
      });
      context.getEntityPageByOwner.mockResolvedValue({
        slug: "the-basement-east-a1b2c3d4",
        visibility,
      });

      const result = await getEventSeo(context.deps, {
        slug: "mission-supper-club",
      });

      expect(result.location?.placeSlug).toBeNull();
      // The venue NAME survives: it is gated on directory-listed +
      // venue-confirmed (a DISCLOSURE decision), which is unaffected by the
      // page being hidden. Only the link is a reachability question, so the
      // badge renders as plain text.
      expect(result.location?.name).toBe("The Basement East");
      // The address is untouched: this is a link gate, not a redaction.
      expect(result.location?.addressLine1).toBe(BASE_EVENT.addressText);
      // And the directory key never substitutes for the missing page slug.
      expect(JSON.stringify(result)).not.toContain(BASE_PLACE.slug);
    },
  );

  // NIT: the entity-page read is gated on the two predicates `buildEventSeo`
  // applies to its result anyway, both computable without IO. An event that
  // would discard the row must not pay for the round trip.
  it("does not read the entity page at all when the venue is not directory-listed", async () => {
    const eventWithPlace: EventRecord = {
      ...BASE_EVENT,
      placeId: "44444444-4444-4444-8444-444444444444",
    };
    context.resolveBySlug.mockResolvedValue({
      eventId: eventWithPlace.id,
      currentSlug: eventWithPlace.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(eventWithPlace);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
    context.getPlaceById.mockResolvedValue({
      ...BASE_PLACE,
      id: eventWithPlace.placeId!,
      listedInDirectory: false,
      humanIdsWithAccess: [BASE_EVENT.humanId!],
    });

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(context.getEntityPageByOwner).not.toHaveBeenCalled();
    expect(result.location?.placeSlug).toBeNull();
  });

  it("does not read the entity page for an UNCONFIRMED third-party event", async () => {
    const eventWithPlace: EventRecord = {
      ...BASE_EVENT,
      placeId: "44444444-4444-4444-8444-444444444444",
    };
    context.resolveBySlug.mockResolvedValue({
      eventId: eventWithPlace.id,
      currentSlug: eventWithPlace.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(eventWithPlace);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
    // Owned by neither the event's human nor its org, and never stamped.
    context.getPlaceById.mockResolvedValue({
      ...BASE_PLACE,
      id: eventWithPlace.placeId!,
      orgIdsWithAccess: ["99999999-9999-4999-8999-999999999999"],
      humanIdsWithAccess: [],
    });

    await getEventSeo(context.deps, { slug: "mission-supper-club" });

    expect(context.getEntityPageByOwner).not.toHaveBeenCalled();
  });

  it("emits a NULL placeSlug — never the Place slug — when the venue has no entity page", async () => {
    const eventWithPlace: EventRecord = {
      ...BASE_EVENT,
      placeId: "44444444-4444-4444-8444-444444444444",
    };
    context.resolveBySlug.mockResolvedValue({
      eventId: eventWithPlace.id,
      currentSlug: eventWithPlace.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(eventWithPlace);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
    context.getPlaceById.mockResolvedValue({
      ...BASE_PLACE,
      id: eventWithPlace.placeId!,
      humanIdsWithAccess: [BASE_EVENT.humanId!],
    });
    // Bulk-imported venue: a `Place` row with a directory slug, no EntityPage.
    context.getEntityPageByOwner.mockResolvedValue(null);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result.location?.isExact).toBe(true);
    expect(result.location?.placeSlug).toBeNull();
    // The bulk-imported population: no EntityPage, no backfill. It keeps its
    // NAME (and its schema.org `location.name`) and simply has no link.
    expect(result.location?.name).toBe("The Basement East");
    // The address is untouched — this is a link gate, not a redaction.
    expect(result.location?.addressLine1).toBe(BASE_EVENT.addressText);
  });

  it("does not surface placeSlug when the linked place is not directory-listed", async () => {
    const eventWithPlace: EventRecord = {
      ...BASE_EVENT,
      placeId: "55555555-5555-4555-8555-555555555555",
    };
    context.resolveBySlug.mockResolvedValue({
      eventId: eventWithPlace.id,
      currentSlug: eventWithPlace.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(eventWithPlace);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
    context.getPlaceById.mockResolvedValue({
      ...BASE_PLACE,
      id: eventWithPlace.placeId!,
      slug: "private-loft",
      listedInDirectory: false,
      humanIdsWithAccess: [BASE_EVENT.humanId!],
    });

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result.location?.placeSlug).toBeNull();
  });

  it("never resolves placeSlug when the location is redacted (OBSCURED, no ticket)", async () => {
    const eventWithPlace: EventRecord = {
      ...BASE_EVENT,
      placeId: "66666666-6666-4666-8666-666666666666",
      locationMode: "OBSCURED",
      addressRevealAt: new Date(TEST_NOW.getTime() + 60 * 60 * 1000),
    };
    context.resolveBySlug.mockResolvedValue({
      eventId: eventWithPlace.id,
      currentSlug: eventWithPlace.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(eventWithPlace);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
    context.viewerHoldsActiveTicketForEvent.mockResolvedValue(false);
    context.getPlaceById.mockResolvedValue({
      ...BASE_PLACE,
      id: eventWithPlace.placeId!,
    });

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result.location?.isExact).toBe(false);
    expect(result.location?.placeSlug).toBeUndefined();
  });

  it("does not query the places repo when the event has no placeId", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(BASE_EVENT);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);

    await getEventSeo(context.deps, { slug: "mission-supper-club" });

    expect(context.getPlaceById).not.toHaveBeenCalled();
  });

  // ── "Presented by" organizer attribution (calm-honest-ux FR-003) ────────
  // Separate data path from the schema.org `organizer` field (always null
  // here) — see build-event-seo.ts.

  it("joins the org and surfaces organizerName/organizerSlug for an org-owned event", async () => {
    const orgEvent: EventRecord = {
      ...BASE_EVENT,
      orgId: "77777777-7777-4777-8777-777777777777",
    };
    context.resolveBySlug.mockResolvedValue({
      eventId: orgEvent.id,
      currentSlug: orgEvent.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(orgEvent);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
    context.getOrgById.mockResolvedValue({
      id: orgEvent.orgId!,
      name: "Brooklyn Promotions",
      slug: "brooklyn-promotions",
      status: "ACTIVE",
      trustTier: "STANDARD",
      trustBadgeLabel: null,
      trustBadgeIcon: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    } as OrganizationRecord);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(context.getOrgById).toHaveBeenCalledWith(orgEvent.orgId);
    expect(result.organizerName).toBe("Brooklyn Promotions");
    expect(result.organizerSlug).toBe("brooklyn-promotions");
    // The separate schema.org `organizer` field stays null (FR-003 is a
    // distinct data path, not a reuse of the JSON-LD shape).
    expect(result.organizer).toBeNull();
  });

  it("does not query the orgs repo and returns null organizer fields for an ownerless (orgId=null) event", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(BASE_EVENT);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(context.getOrgById).not.toHaveBeenCalled();
    expect(result.organizerName).toBeNull();
    expect(result.organizerSlug).toBeNull();
  });

  // ── refundCutoffAt: real, absolute deadline (calm-honest-ux FR-004) ─────
  // The old display logic fabricated a static hours-before-event cutoff from
  // a dead constant; this is the actual field `get-refund-eligibility.ts`
  // enforces (`event.refundCutoffAt ?? eventStartsAt`).

  it("surfaces refundCutoffAt as null when the organizer never overrode it", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(BASE_EVENT);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result.refundCutoffAt).toBeNull();
  });

  it("surfaces refundCutoffAt as an ISO string when the organizer set a custom deadline", async () => {
    const eventWithCutoff: EventRecord = {
      ...BASE_EVENT,
      refundCutoffAt: new Date("2024-11-18T00:00:00.000Z"),
    };
    context.resolveBySlug.mockResolvedValue({
      eventId: eventWithCutoff.id,
      currentSlug: eventWithCutoff.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(eventWithCutoff);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result.refundCutoffAt).toBe("2024-11-18T00:00:00.000Z");
  });

  // ── Hero image moderation gate (FR-005) ─────────────────────────────────
  // The public event-detail read hides a hero (from the page hero AND the
  // og:image list) unless its moderation record is APPROVED. Absent record
  // (legacy) is treated as visible so nothing already-live disappears.

  const eventWithHero: EventRecord = {
    ...BASE_EVENT,
    heroImageUrl: HERO_URL,
    heroImageKey: HERO_KEY,
    heroImageSize: { width: 1080, height: 1350 },
  };

  const primeHeroEvent = () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: eventWithHero.id,
      currentSlug: eventWithHero.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(eventWithHero);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
  };

  it("surfaces the hero when its moderation record is APPROVED", async () => {
    primeHeroEvent();
    context.resolveByKeys.mockResolvedValue(
      new Map([[HERO_KEY, heroModerationRecord("APPROVED")]]),
    );

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result.images).toEqual([HERO_URL]);
    // The poster's size rides with it, so the page can reserve its box.
    expect(result.heroImageSize).toEqual({ width: 1080, height: 1350 });
    expect(context.resolveByKeys).toHaveBeenCalledWith([HERO_KEY]);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits the hero when its moderation record is %s",
    async (status) => {
      primeHeroEvent();
      context.resolveByKeys.mockResolvedValue(
        new Map([[HERO_KEY, heroModerationRecord(status)]]),
      );

      const result = await getEventSeo(context.deps, {
        slug: "mission-supper-club",
      });

      expect(result.images ?? []).not.toContain(HERO_URL);
      // A hidden hero exposes nothing about itself, size included.
      expect(result.heroImageSize ?? null).toBeNull();
    },
  );

  it("surfaces a legacy hero with NO moderation record (fail-open)", async () => {
    primeHeroEvent();
    context.resolveByKeys.mockResolvedValue(new Map());

    const result = await getEventSeo(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result.images).toEqual([HERO_URL]);
  });

  it("does not query moderation records when the event has no hero", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(BASE_EVENT);
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);

    await getEventSeo(context.deps, { slug: "mission-supper-club" });

    expect(context.resolveByKeys).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue confirmation (docs/specs/2026-08-27): venue name + link render ONLY
// when venue-owned or venue-confirmed; otherwise address-only. Withdrawn and
// never-confirmed are indistinguishable. `placeId` never leaves the server.
// ─────────────────────────────────────────────────────────────────────────────

describe("getEventSeo — venue confirmation", () => {
  const PLACE_ID = "44444444-4444-4444-8444-444444444444";
  const THIRD_PARTY_EVENT: EventRecord = { ...BASE_EVENT, placeId: PLACE_ID };
  let context: ReturnType<typeof createDeps>;

  beforeEach(() => {
    context = createDeps();
    context.resolveBySlug.mockResolvedValue({
      eventId: THIRD_PARTY_EVENT.id,
      currentSlug: THIRD_PARTY_EVENT.slug!,
      redirect: false,
    });
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
    // The place is owned by an org the event's human does not belong to.
    context.getPlaceById.mockResolvedValue({
      ...BASE_PLACE,
      id: PLACE_ID,
      orgIdsWithAccess: ["99999999-9999-4999-8999-999999999999"],
      humanIdsWithAccess: [],
    });
    // The venue's public page. `placeSlug` must come from HERE, never from
    // `Place.slug` (the multi-segment directory key on BASE_PLACE).
    context.getEntityPageByOwner.mockResolvedValue({
      slug: "the-basement-east-a1b2c3d4",
      visibility: "PUBLIC",
    });
  });

  it("UNCONFIRMED third-party event: address intact, no venue name, no slug, venueConfirmed false, no placeId anywhere", async () => {
    context.getById.mockResolvedValue(THIRD_PARTY_EVENT);
    const result = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(result.location).toMatchObject({
      isExact: true,
      name: null,
      placeSlug: null,
      venueConfirmed: false,
      addressLine1: "123 Valencia St",
      city: "San Francisco",
      region: "CA",
      postalCode: "94103",
      latitude: 37.7675,
      longitude: -122.421,
    });
    expect(JSON.stringify(result)).not.toContain(PLACE_ID);
  });

  it("WITHDRAWN confirmation renders exactly like never-confirmed", async () => {
    context.getById.mockResolvedValue({
      ...THIRD_PARTY_EVENT,
      venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
      venueConfirmationWithdrawnAt: new Date("2026-08-02T00:00:00.000Z"),
      venueConfirmationWithdrawnReason: "double booked",
    });
    const withdrawn = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    context.getById.mockResolvedValue(THIRD_PARTY_EVENT);
    const never = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(withdrawn.location).toEqual(never.location);
    expect(withdrawn.location?.venueConfirmed).toBe(false);
  });

  it("STAMPED (confirmed, not withdrawn): venue name + slug present, venueConfirmed true", async () => {
    context.getById.mockResolvedValue({
      ...THIRD_PARTY_EVENT,
      venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
      venueConfirmedByHumanId: "99999999-9999-4999-8999-999999999998",
      venueConfirmationWithdrawnAt: null,
    });
    const result = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(result.location).toMatchObject({
      name: "The Basement East",
      placeSlug: "the-basement-east-a1b2c3d4",
      venueConfirmed: true,
    });
  });

  it("VENUE-OWNED (the place's org owns the event): confirmed by construction without a stamp", async () => {
    context.getById.mockResolvedValue({
      ...THIRD_PARTY_EVENT,
      orgId: "99999999-9999-4999-8999-999999999999",
      humanId: null,
    });
    const result = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(result.location).toMatchObject({ placeSlug: "the-basement-east-a1b2c3d4", venueConfirmed: true });
  });

  it("an event with no place is address-only with venueConfirmed false", async () => {
    context.getById.mockResolvedValue(BASE_EVENT);
    const result = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(result.location).toMatchObject({ name: null, placeSlug: null, venueConfirmed: false });
  });

  // ── Name-only display (owner ruling 2026-10-06, option B) ────────────────
  const COMMUNITY_LISTING: EventRecord = {
    ...THIRD_PARTY_EVENT,
    orgId: null,
    humanId: null,
    stewardship: "COMMUNITY",
  };
  const UNOWNED_PLACE = {
    ...BASE_PLACE,
    id: PLACE_ID,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    acceptsCommunityListings: false,
    status: "ACTIVE" as const,
    listedInDirectory: false,
  };

  it("NAME-ONLY: unconfirmed community listing at an ACTIVE unowned place → plain name, no slug, venueConfirmed false, entity page NOT read", async () => {
    context.getById.mockResolvedValue(COMMUNITY_LISTING);
    context.getPlaceById.mockResolvedValue(UNOWNED_PLACE);
    const result = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(result.location).toMatchObject({
      isExact: true,
      name: "The Basement East",
      placeSlug: null,
      venueConfirmed: false,
      addressLine1: "123 Valencia St",
    });
    expect(context.getEntityPageByOwner).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("the-basement-east-a1b2c3d4");
    expect(JSON.stringify(result)).not.toContain(PLACE_ID);
  });

  it("NAME-ONLY: a hidden location keeps the name hidden", async () => {
    context.getById.mockResolvedValue({
      ...COMMUNITY_LISTING,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      addressRevealAt: new Date(Date.now() + 24 * 3_600_000),
    });
    context.getPlaceById.mockResolvedValue(UNOWNED_PLACE);
    const result = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(result.location).toMatchObject({ hidden: true, name: null, venueConfirmed: false });
  });

  it("NAME-ONLY at a WITHHELD venue (place OBSCURED, event row EXACT): no name", async () => {
    context.getById.mockResolvedValue(COMMUNITY_LISTING);
    context.getPlaceById.mockResolvedValue({
      ...UNOWNED_PLACE,
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
    });
    const result = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(result.location?.isExact).toBe(false);
    expect(result.location).toMatchObject({ name: null, venueConfirmed: false });
    expect(JSON.stringify(result)).not.toContain("The Basement East");
  });

  it("NAME-ONLY: a withdrawn community listing is not named", async () => {
    context.getById.mockResolvedValue({
      ...COMMUNITY_LISTING,
      venueConfirmationWithdrawnAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    context.getPlaceById.mockResolvedValue(UNOWNED_PLACE);
    const result = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(result.location).toMatchObject({ name: null, placeSlug: null, venueConfirmed: false });
  });

  it("NAME-ONLY re-derives at read time: a PUBLISHED listing re-linked to another place shows THAT place's name (nothing cached)", async () => {
    const OTHER_PLACE_ID = "45454545-4545-4454-8454-454545454545";
    context.getPlaceById.mockImplementation(async (id: string) =>
      id === PLACE_ID
        ? UNOWNED_PLACE
        : id === OTHER_PLACE_ID
          ? { ...UNOWNED_PLACE, id: OTHER_PLACE_ID, name: "Corner Bar" }
          : null,
    );
    context.getById.mockResolvedValue({ ...COMMUNITY_LISTING, status: "PUBLISHED" });
    const before = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(before.location?.name).toBe("The Basement East");

    context.getById.mockResolvedValue({
      ...COMMUNITY_LISTING,
      status: "PUBLISHED",
      placeId: OTHER_PLACE_ID,
    });
    const after = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(after.location).toMatchObject({ name: "Corner Bar", placeSlug: null, venueConfirmed: false });

    // Re-linked to a place that is no longer ACTIVE → no name, not the old one.
    context.getPlaceById.mockResolvedValue({ ...UNOWNED_PLACE, id: OTHER_PLACE_ID, status: "ARCHIVED" });
    const archived = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(archived.location?.name).toBeNull();
  });

  it("NAME-ONLY does not apply to a non-community event at an unconfirmed place (unchanged)", async () => {
    context.getById.mockResolvedValue(THIRD_PARTY_EVENT);
    context.getPlaceById.mockResolvedValue(UNOWNED_PLACE);
    const result = await getEventSeo(context.deps, { slug: "mission-supper-club" });
    expect(result.location).toMatchObject({ name: null, placeSlug: null, venueConfirmed: false });
  });
});

// ── C1: the holder reveal at a WITHHELD venue needs the venue's word ─────────

describe("getEventSeo — a withheld venue releases its address only where it vouched", () => {
  const PLACE_ID = BASE_PLACE.id;
  const VENUE_HUMAN = BASE_EVENT.humanId!;
  const HOLDER = "99999999-9999-4999-8999-999999999999";
  const HOUR = 60 * 60 * 1000;

  const withheldHouse: PlaceRecord = {
    ...BASE_PLACE,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    addressLine1: "901 Porter Rd",
    locationMode: "OBSCURED",
    locationRadiusMeters: null,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [VENUE_HUMAN],
    acceptsCommunityListings: true,
  } as PlaceRecord;

  /** At the house, stored as its projection, revealed IMMEDIATELY an hour ago. */
  const atHouse: EventRecord = {
    ...BASE_EVENT,
    placeId: PLACE_ID,
    locationMode: "OBSCURED",
    locationRadiusMeters: null,
    addressRevealPreset: "IMMEDIATELY",
    addressRevealAt: new Date(TEST_NOW.getTime() - HOUR),
    addressText: "East Nashville",
    startsAt: new Date(TEST_NOW.getTime() + 14 * 24 * HOUR),
  };

  let context: ReturnType<typeof createDeps>;
  async function viewAsHolder(event: EventRecord) {
    context = createDeps();
    context.resolveBySlug.mockResolvedValue({
      eventId: event.id,
      currentSlug: event.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(event);
    context.listTicketTypes.mockResolvedValue(TICKET_TYPES);
    context.listByEvent.mockResolvedValue([]);
    context.getPlaceById.mockResolvedValue(withheldHouse);
    context.viewerHoldsActiveTicketForEvent.mockResolvedValue(true);
    return getEventSeo(context.deps, {
      slug: event.slug!,
      viewerHumanId: HOLDER,
    });
  }

  it("the house's own show: the holder gets the Place's street", async () => {
    const result = await viewAsHolder(atHouse);
    expect(result.location?.isExact).toBe(true);
    expect(result.location?.addressLine1).toBe("901 Porter Rd");
  });

  it("C1: a stranger's UNCONFIRMED event at the house, IMMEDIATELY, with a real ticket: nothing", async () => {
    const result = await viewAsHolder({
      ...atHouse,
      humanId: "77777777-7777-4777-8777-777777777777",
    });
    expect(result.viewerHasTicket).toBe(true);
    expect(result.location?.isExact).toBe(false);
    expect(result.location?.addressLine1).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Porter");
    // And the page promises no reveal date for it.
    expect(result.addressRevealAt).toBeNull();
  });

  it("C1: an ownerless community listing the house accepts: nothing", async () => {
    const result = await viewAsHolder({
      ...atHouse,
      humanId: null,
      stewardship: "COMMUNITY",
    });
    expect(result.location?.isExact).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Porter");
  });

  it("stamp arm: a confirmed stranger's event waits for startsAt − 24h, and the page says so", async () => {
    const event: EventRecord = {
      ...atHouse,
      humanId: "77777777-7777-4777-8777-777777777777",
      venueConfirmedAt: new Date(TEST_NOW.getTime() - 2 * HOUR),
      venueConfirmationWithdrawnAt: null,
      venueConfirmedPlaceId: PLACE_ID,
    };
    const result = await viewAsHolder(event);
    expect(result.location?.isExact).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Porter");
    expect(result.addressRevealAt).toBe(
      new Date(event.startsAt.getTime() - 24 * HOUR).toISOString(),
    );
  });
});

describe("getEventSeo — a page that was never public is not readable by slug (N3)", () => {
  const ORG_ID = "55555555-5555-4555-8555-555555555555";
  const OWNER_HUMAN = BASE_EVENT.humanId!;
  const STRANGER = "66666666-6666-4666-8666-666666666666";
  let context: ReturnType<typeof createDeps>;

  beforeEach(() => {
    context = createDeps();
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.listTicketTypes.mockResolvedValue([]);
    context.listByEvent.mockResolvedValue([]);
  });

  const draft: EventRecord = { ...BASE_EVENT, status: "DRAFT", publishedAt: null };

  it("a DRAFT is EVENT_NOT_FOUND for an anonymous reader — the same error as a missing event", async () => {
    context.getById.mockResolvedValue(draft);

    await expect(
      getEventSeo(context.deps, { slug: BASE_EVENT.slug! }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    // Nothing else about the draft is read.
    expect(context.listTicketTypes).not.toHaveBeenCalled();
    expect(context.getPlaceById).not.toHaveBeenCalled();
  });

  it("a DRAFT is EVENT_NOT_FOUND for a signed-in stranger", async () => {
    context.getById.mockResolvedValue(draft);

    await expect(
      getEventSeo(context.deps, { slug: BASE_EVENT.slug!, viewerHumanId: STRANGER }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("a DRAFT is readable by its human owner (the builder's live-draft preview)", async () => {
    context.getById.mockResolvedValue(draft);

    const result = await getEventSeo(context.deps, {
      slug: BASE_EVENT.slug!,
      viewerHumanId: OWNER_HUMAN,
    });

    expect(result).toMatchObject({ id: BASE_EVENT.id, status: "DRAFT" });
  });

  it("an org DRAFT is readable by an edit-role member, not by a VIEWER", async () => {
    const orgDraft: EventRecord = { ...draft, orgId: ORG_ID, humanId: null };
    context.getById.mockResolvedValue(orgDraft);

    context.getOrgMembership.mockResolvedValue({ role: "EDITOR" });
    await expect(
      getEventSeo(context.deps, { slug: BASE_EVENT.slug!, viewerHumanId: STRANGER }),
    ).resolves.toMatchObject({ status: "DRAFT" });

    context.getOrgMembership.mockResolvedValue({ role: "VIEWER" });
    await expect(
      getEventSeo(context.deps, { slug: BASE_EVENT.slug!, viewerHumanId: STRANGER }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("a COMMUNITY draft is readable by a community moderator only", async () => {
    const communityDraft: EventRecord = {
      ...draft,
      orgId: null,
      humanId: null,
      stewardship: "COMMUNITY",
      attendanceMode: "RSVP",
    };
    context.getById.mockResolvedValue(communityDraft);

    context.deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: true })) };
    await expect(
      getEventSeo(context.deps, { slug: BASE_EVENT.slug!, viewerHumanId: STRANGER }),
    ).resolves.toMatchObject({ status: "DRAFT" });

    context.deps.authz = { hasStaffRole: vi.fn(async () => ({ allowed: false })) };
    await expect(
      getEventSeo(context.deps, { slug: BASE_EVENT.slug!, viewerHumanId: STRANGER }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("an event CANCELLED without ever going live is not readable either", async () => {
    context.getById.mockResolvedValue({
      ...BASE_EVENT,
      status: "CANCELLED",
      publishedAt: null,
    });

    await expect(
      getEventSeo(context.deps, { slug: BASE_EVENT.slug! }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it.each(["COMPLETED", "CANCELLED", "ARCHIVED"] as const)(
    "a %s event that WAS live stays readable (track record, my-tickets, shared links)",
    async (status) => {
      context.getById.mockResolvedValue({ ...BASE_EVENT, status });

      await expect(
        getEventSeo(context.deps, { slug: BASE_EVENT.slug! }),
      ).resolves.toMatchObject({ status });
      expect(context.getOrgMembership).not.toHaveBeenCalled();
    },
  );

  it("a COMPLETED legacy row with no publishedAt is still readable (only a PUBLISHED event can complete)", async () => {
    context.getById.mockResolvedValue({
      ...BASE_EVENT,
      status: "COMPLETED",
      publishedAt: null,
    });

    await expect(
      getEventSeo(context.deps, { slug: BASE_EVENT.slug! }),
    ).resolves.toMatchObject({ status: "COMPLETED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Jurisdictional taxable base in the JSON-LD price
//
// `pricing.minBuyerTotalCents` becomes `offers.price` — a public, machine-read
// number. In Tennessee the admission tax applies to the buyer's platform and
// processing fees too, so a total built on the face-only base advertises below
// what checkout charges.
// ─────────────────────────────────────────────────────────────────────────────
describe("getEventSeo — taxable base in the advertised price", () => {
  const FACE_CENTS = 2500;
  /** The charge for this fixture, pinned in create-checkout.test.ts. */
  const TN_CHARGE_CENTS = 2925;
  /** What HEAD advertised for the same event (face-only base). */
  const FACE_CHARGE_CENTS = 2909;

  const passThroughPolicy = {
    id: "policy-tn",
    version: 1,
    status: "ACTIVE",
    feeMode: "PASS_THROUGH",
    buyerFeePct: 0,
    maxFeeCents: null,
    minFeeCents: 0,
    maxPlatformFeeCents: null,
    platformFixedCents: 50,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  };

  const minBuyerTotalFor = async (region: string) => {
    const context = createDeps();
    const event = {
      ...BASE_EVENT,
      admissionTaxRateBps: 975,
      // Inline jurisdiction — no Place read needed.
      countryCode: "US",
      region,
      postalCode: region === "TN" ? "37203" : "33139",
    } as typeof BASE_EVENT;

    context.resolveBySlug.mockResolvedValue({
      eventId: event.id,
      currentSlug: event.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(event);
    context.listTicketTypes.mockResolvedValue([
      { ...TICKET_TYPES[0]!, priceCents: FACE_CENTS },
    ]);
    context.listByEvent.mockResolvedValue([]);
    context.viewerHoldsActiveTicketForEvent.mockResolvedValue(false);

    const repos = context.deps.repos as unknown as {
      payoutTerms: {
        listByEvent: ReturnType<typeof vi.fn>;
        listLines: ReturnType<typeof vi.fn>;
      };
      feePolicies: { getById: ReturnType<typeof vi.fn> };
    };
    repos.payoutTerms.listByEvent.mockResolvedValue([
      {
        id: "agreement-tn",
        kind: "PRIMARY",
        status: "ACTIVE",
        feeMode: "PASS_THROUGH",
        feePolicyId: "policy-tn",
        version: 1,
      },
    ]);
    repos.payoutTerms.listLines.mockResolvedValue([
      {
        id: "line-tn",
        agreementId: "agreement-tn",
        payeeId: "payee-tn",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ]);
    repos.feePolicies.getById.mockResolvedValue(passThroughPolicy);

    const result = await getEventSeo(context.deps, { slug: event.slug! });
    return result.pricing?.minBuyerTotalCents;
  };

  it("US/TN advertises the CHARGE (2925), not the face-only 2909", async () => {
    expect(await minBuyerTotalFor("TN")).toBe(TN_CHARGE_CENTS);
  });

  it("US/FL advertises exactly what HEAD advertised", async () => {
    expect(await minBuyerTotalFor("FL")).toBe(FACE_CHARGE_CENTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tax-unresolved rule — a NULL `admissionTaxRateBps` means checkout resolves the
// rate LIVE, so a buyer total built at 0% would understate the charge. With no
// stamp the estimate is skipped and the buyer totals fall back to the face
// range (`buildEventSeo`'s existing no-estimate fallback), never a 0%-tax
// all-in figure. Same rule as `ticketTiersForCard` / `buyerTotalForIndex`.
// ─────────────────────────────────────────────────────────────────────────────
describe("getEventSeo — tax unresolved (NULL stamp)", () => {
  const FACE_CENTS = 2500;
  /**
   * Face + 50¢ platform fee + processor gross-up at 0% tax — the understated
   * figure: ceil((2500 + 50 + 30) / (1 − 0.029)) = 2658.
   */
  const ZERO_TAX_ALL_IN_CENTS = 2658;

  const pricingFor = async (admissionTaxRateBps: number | null | undefined) => {
    const context = createDeps();
    const event = {
      ...BASE_EVENT,
      admissionTaxRateBps,
      countryCode: "US",
      region: "FL",
      postalCode: "33139",
    } as typeof BASE_EVENT;

    context.resolveBySlug.mockResolvedValue({
      eventId: event.id,
      currentSlug: event.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(event);
    context.listTicketTypes.mockResolvedValue([
      { ...TICKET_TYPES[0]!, priceCents: FACE_CENTS },
    ]);
    context.listByEvent.mockResolvedValue([]);
    context.viewerHoldsActiveTicketForEvent.mockResolvedValue(false);

    const repos = context.deps.repos as unknown as {
      payoutTerms: {
        listByEvent: ReturnType<typeof vi.fn>;
        listLines: ReturnType<typeof vi.fn>;
      };
      feePolicies: { getById: ReturnType<typeof vi.fn> };
    };
    repos.payoutTerms.listByEvent.mockResolvedValue([
      {
        id: "agreement-unstamped",
        kind: "PRIMARY",
        status: "ACTIVE",
        feeMode: "PASS_THROUGH",
        feePolicyId: "policy-unstamped",
        version: 1,
      },
    ]);
    repos.payoutTerms.listLines.mockResolvedValue([
      {
        id: "line-unstamped",
        agreementId: "agreement-unstamped",
        payeeId: "payee-unstamped",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ]);
    repos.feePolicies.getById.mockResolvedValue({
      id: "policy-unstamped",
      version: 1,
      status: "ACTIVE",
      feeMode: "PASS_THROUGH",
      buyerFeePct: 0,
      maxFeeCents: null,
      minFeeCents: 0,
      maxPlatformFeeCents: null,
      platformFixedCents: 50,
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
    });

    const result = await getEventSeo(context.deps, { slug: event.slug! });
    return result.pricing;
  };

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])(
    "a %s stamp reports the face range, not a 0%%-tax all-in total",
    async (_label, stamp) => {
      const pricing = await pricingFor(stamp);
      expect(pricing?.minPriceCents).toBe(FACE_CENTS);
      expect(pricing?.minBuyerTotalCents).toBe(FACE_CENTS);
      expect(pricing?.maxBuyerTotalCents).toBe(FACE_CENTS);
      expect(pricing?.minBuyerTotalCents).not.toBe(ZERO_TAX_ALL_IN_CENTS);
    },
  );

  it("a stamped event still reports the all-in total (2909 at 9.75%)", async () => {
    expect((await pricingFor(975))?.minBuyerTotalCents).toBe(2909);
  });

  it("a stamped 0% event is a KNOWN rate: all-in total at 0% tax", async () => {
    expect((await pricingFor(0))?.minBuyerTotalCents).toBe(
      ZERO_TAX_ALL_IN_CENTS,
    );
  });
});
