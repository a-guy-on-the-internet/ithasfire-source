import { describe, expect, it } from "vitest";

import { buildEventSeo } from "./build-event-seo";

// Very small unit tests: we only care that the compiler is deterministic, null-safe,
// and preserves the existing public payload behavior.

describe("buildEventSeo", () => {
  it("builds a minimal seo payload with no location/pricing when missing", () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000001",
      slug: "demo/event",
      title: "Demo Event",
      status: "DRAFT",
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: null,
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),

      // location-ish values
      placeId: null,
      addressText: null,
      locality: null,
      region: null,
      postalCode: null,
      countryCode: null,
      lat: null,
      lng: null,
    } as any;

    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [] });

    expect(seo).toMatchObject({
      id: event.id,
      slug: event.slug,
      title: event.title,
      description: null,
      status: "DRAFT",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: null,
      updatedAt: "2026-01-02T00:00:00.000Z",
      images: [],
      ticketingUrl: null,
      location: null,
      organizer: null,
      pricing: null,
    });
  });

  // ── organizerName/organizerSlug: separate data path from `organizer`
  // (calm-honest-ux FR-003 — see build-event-seo.ts for the rationale). ─────

  it("surfaces organizerName/organizerSlug when an org is passed, without touching the schema.org organizer field", () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000006",
      slug: "demo/event-6",
      title: "Org Event",
      status: "PUBLISHED",
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: null,
      updatedAt: null,
      placeId: null,
      addressText: null,
      locality: null,
      region: null,
      postalCode: null,
      countryCode: null,
      lat: null,
      lng: null,
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      org: { name: "Brooklyn Promotions", slug: "brooklyn-promotions" },
    });

    expect(seo.organizerName).toBe("Brooklyn Promotions");
    expect(seo.organizerSlug).toBe("brooklyn-promotions");
    // The schema.org JSON-LD `organizer` is built from these two by the web
    // app (it needs the absolute site URL); this compiler leaves it null.
    expect(seo.organizer).toBeNull();
  });

  it("returns null organizerName/organizerSlug when org is absent (ownerless COMMUNITY listings)", () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000007",
      slug: "demo/event-7",
      title: "Community Event",
      status: "PUBLISHED",
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: null,
      updatedAt: null,
      placeId: null,
      addressText: null,
      locality: null,
      region: null,
      postalCode: null,
      countryCode: null,
      lat: null,
      lng: null,
    } as any;

    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [] });

    expect(seo.organizerName).toBeNull();
    expect(seo.organizerSlug).toBeNull();
  });

  it("includes pricing when ticket types have prices", () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000002",
      slug: "demo/event-2",
      title: "Demo Event 2",
      status: "PUBLISHED",
      startsAt: new Date("2026-01-10T00:00:00.000Z"),
      endsAt: new Date("2026-01-10T02:00:00.000Z"),
      updatedAt: null,

      placeId: null,
      addressText: null,
      locality: null,
      region: null,
      postalCode: null,
      countryCode: null,
      lat: null,
      lng: null,
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [
        { priceCents: 5000 },
        { priceCents: 2500 },
        { priceCents: 10000 },
      ] as any,
      eventHumans: [],
    });

    expect(seo.pricing).toEqual({
      currency: null,
      minPriceCents: 2500,
      maxPriceCents: 10000,
      minBuyerTotalCents: 2500,
      maxBuyerTotalCents: 10000,
      availability: null,
      validFrom: null,
    });
  });

  // ── Offer.validFrom + publishedAt (Search Console: "Missing field
  // validFrom (in offers)" on every event). ──────────────────────────────

  describe("validFrom / publishedAt", () => {
    const PUBLISHED_AT = new Date("2026-09-01T12:00:00.000Z");
    const eventWith = (publishedAt: Date | null) =>
      ({
        id: "00000000-0000-4000-8000-000000000010",
        slug: "demo/event-10",
        title: "Sales Window Event",
        status: "PUBLISHED",
        startsAt: new Date("2026-11-01T00:00:00.000Z"),
        endsAt: null,
        updatedAt: null,
        publishedAt,
        placeId: null,
        addressText: null,
        locality: null,
        region: null,
        postalCode: null,
        countryCode: null,
        lat: null,
        lng: null,
      }) as any;
    const tt = (salesOpenAt: Date | null, priceCents = 2500) =>
      ({ priceCents, salesOpenAt }) as any;
    const now = new Date("2026-10-18T00:00:00.000Z");

    it("is the earliest ticket type salesOpenAt", () => {
      const seo = buildEventSeo({
        event: eventWith(PUBLISHED_AT),
        ticketTypes: [
          tt(new Date("2026-09-20T00:00:00.000Z")),
          tt(new Date("2026-09-10T00:00:00.000Z"), 5000),
        ],
        eventHumans: [],
        now,
      });
      expect(seo.pricing?.validFrom).toBe("2026-09-10T00:00:00.000Z");
    });

    it("falls back to publishedAt when no ticket type has a sales opening", () => {
      const seo = buildEventSeo({
        event: eventWith(PUBLISHED_AT),
        ticketTypes: [tt(null), tt(null, 5000)],
        eventHumans: [],
        now,
      });
      expect(seo.pricing?.validFrom).toBe("2026-09-01T12:00:00.000Z");
    });

    it("an unbounded type opens at publishedAt, so a later bounded type does not win", () => {
      // Taking only the non-null openings would claim 09-20 while the
      // unbounded tier has been on sale since the event went live.
      const seo = buildEventSeo({
        event: eventWith(PUBLISHED_AT),
        ticketTypes: [tt(null), tt(new Date("2026-09-20T00:00:00.000Z"))],
        eventHumans: [],
        now,
      });
      expect(seo.pricing?.validFrom).toBe("2026-09-01T12:00:00.000Z");
    });

    it("never comes before publishedAt (sales 'open' on a draft count from going live)", () => {
      const seo = buildEventSeo({
        event: eventWith(new Date("2026-09-15T00:00:00.000Z")),
        ticketTypes: [
          tt(new Date("2026-09-01T00:00:00.000Z")),
          tt(new Date("2026-09-20T00:00:00.000Z")),
        ],
        eventHumans: [],
        now,
      });
      expect(seo.pricing?.validFrom).toBe("2026-09-15T00:00:00.000Z");
    });

    it("keeps an explicit opening when the event was never published", () => {
      const seo = buildEventSeo({
        event: eventWith(null),
        ticketTypes: [tt(new Date("2026-09-01T00:00:00.000Z"))],
        eventHumans: [],
        now,
      });
      expect(seo.pricing?.validFrom).toBe("2026-09-01T00:00:00.000Z");
    });

    it("is null when nothing says when sales opened (never published, no openings)", () => {
      const seo = buildEventSeo({
        event: eventWith(null),
        ticketTypes: [tt(null)],
        eventHumans: [],
        now,
      });
      expect(seo.pricing?.validFrom).toBeNull();
      expect(seo.publishedAt).toBeNull();
    });

    it("carries publishedAt as an ISO string, including for a listing with no pricing", () => {
      // A community listing has no ticket types, so `pricing` is null and
      // `publishedAt` is what its free Offer's validFrom is built from.
      const seo = buildEventSeo({
        event: eventWith(PUBLISHED_AT),
        ticketTypes: [],
        eventHumans: [],
        now,
      });
      expect(seo.pricing).toBeNull();
      expect(seo.publishedAt).toBe("2026-09-01T12:00:00.000Z");
    });

    it("passes the output schema's strict parse", async () => {
      const { getEventSeoOutputSchema } = await import("../get-event-seo");
      const seo = buildEventSeo({
        event: {
          ...eventWith(PUBLISHED_AT),
          attendanceMode: "RSVP",
          stewardship: "COMMUNITY",
          visibility: "PUBLIC",
        },
        ticketTypes: [tt(new Date("2026-09-10T00:00:00.000Z"))],
        eventHumans: [],
        now,
      });
      const parsed = getEventSeoOutputSchema.parse(seo);
      expect(parsed.publishedAt).toBe("2026-09-01T12:00:00.000Z");
      expect(parsed.pricing?.validFrom).toBe("2026-09-10T00:00:00.000Z");
    });
  });

  it("prefers buyer-total pricing when available", () => {
    const seo = buildEventSeo({
      event: {
        id: "00000000-0000-4000-8000-000000000005",
        slug: "demo/event-5",
        title: "Demo Event 5",
        status: "PUBLISHED",
        startsAt: new Date("2026-01-10T00:00:00.000Z"),
        endsAt: new Date("2026-01-10T02:00:00.000Z"),
        updatedAt: null,
        placeId: null,
        addressText: null,
        locality: null,
        region: null,
        postalCode: null,
        countryCode: null,
        lat: null,
        lng: null,
      } as any,
      ticketTypes: [{ priceCents: 2500 }, { priceCents: 5000 }] as any,
      eventHumans: [],
      buyerPricing: {
        minBuyerUnitTotalCents: 3375,
        maxBuyerUnitTotalCents: 6125,
      },
    });

    expect(seo.pricing).toMatchObject({
      minPriceCents: 2500,
      maxPriceCents: 5000,
      minBuyerTotalCents: 3375,
      maxBuyerTotalCents: 6125,
    });
  });

  it("includes heroImageUrl in images when present", () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000003",
      slug: "demo/event-3",
      title: "Hero Image Event",
      status: "PUBLISHED",
      startsAt: new Date("2026-02-01T00:00:00.000Z"),
      endsAt: null,
      updatedAt: null,
      heroImageUrl: "https://cdn.example.com/hero.jpg",

      placeId: null,
      addressText: null,
      locality: null,
      region: null,
      postalCode: null,
      countryCode: null,
      lat: null,
      lng: null,
    } as any;

    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [] });

    expect(seo.images).toEqual(["https://cdn.example.com/hero.jpg"]);
    // No size recorded (a pre-2026-10 upload): null, never invented.
    expect(seo.heroImageSize).toBeNull();
  });

  it("carries the hero's size with its url, and drops it with the url", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000005",
      slug: "demo/event-5",
      title: "Sized Hero Event",
      status: "PUBLISHED",
      startsAt: new Date("2026-02-01T00:00:00.000Z"),
      endsAt: null,
      updatedAt: null,
      heroImageSize: { width: 1080, height: 1350 },
      placeId: null,
      addressText: null,
      locality: null,
      region: null,
      postalCode: null,
      countryCode: null,
      lat: null,
      lng: null,
    };

    const shown = buildEventSeo({
      event: { ...base, heroImageUrl: "https://cdn.example.com/hero.jpg" } as any,
      ticketTypes: [],
      eventHumans: [],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(shown.heroImageSize).toEqual({ width: 1080, height: 1350 });

    // The moderation gate hides a hero by nulling its url; a stale size on
    // the record must not leak through on its own.
    const hidden = buildEventSeo({
      event: { ...base, heroImageUrl: null } as any,
      ticketTypes: [],
      eventHumans: [],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(hidden.images).toEqual([]);
    expect(hidden.heroImageSize).toBeNull();
  });

  it("returns empty images when heroImageUrl is absent", () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000004",
      slug: "demo/event-4",
      title: "No Hero Event",
      status: "DRAFT",
      startsAt: new Date("2026-03-01T00:00:00.000Z"),
      endsAt: null,
      updatedAt: null,
      heroImageUrl: null,

      placeId: null,
      addressText: null,
      locality: null,
      region: null,
      postalCode: null,
      countryCode: null,
      lat: null,
      lng: null,
    } as any;

    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [] });

    expect(seo.images).toEqual([]);
  });

  // ── placeSlug: only surfaced in exact/revealed branches, only for
  // directory-listed places (see build-event-seo.ts for the rationale). ──────

  const baseGeoEvent = {
    id: "00000000-0000-4000-8000-000000000010",
    slug: "demo/geo-event",
    title: "Geo Event",
    status: "PUBLISHED",
    startsAt: new Date("2026-04-01T00:00:00.000Z"),
    endsAt: null,
    updatedAt: null,
    placeId: "place-1",
    addressText: "1 Main St",
    locality: "Nashville",
    region: "TN",
    postalCode: "37203",
    countryCode: "US",
    lat: 36.16,
    lng: -86.78,
    locationRadiusMeters: null,
    addressRevealAt: null,
  };

  it("surfaces placeSlug when location is EXACT and the place is directory-listed", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: {
        pageSlug: "the-basement-east-a1b2c3d4",
        name: "The Basement East",
        listedInDirectory: true,
    locationMode: "EXACT",
        locationMode: "EXACT",
        venueConfirmed: true,
      },
    });

    expect(seo.location?.isExact).toBe(true);
    expect(seo.location?.placeSlug).toBe("the-basement-east-a1b2c3d4");
    expect(seo.location?.name).toBe("The Basement East");
  });

  it("GATE-GRANTED full read: a gated EXACT event keeps its address + pin (the public projector's gate rule does not apply — getEventSeo sits behind ensureFullEventReadAccess)", () => {
    for (const gateType of ["PASSWORD", "APPLICATION"]) {
      const event = { ...baseGeoEvent, locationMode: "EXACT", gateType } as any;
      const seo = buildEventSeo({
        event,
        ticketTypes: [],
        eventHumans: [],
        now: new Date("2026-03-01T00:00:00.000Z"),
        place: {
          pageSlug: "the-basement-east-a1b2c3d4",
          name: "The Basement East",
          listedInDirectory: true,
          locationMode: "EXACT",
          venueConfirmed: true,
        },
      });
      expect(seo.location?.isExact).toBe(true);
      expect(seo.location?.addressLine1).toBe("1 Main St");
      expect(seo.location?.latitude).toBe(36.16);
      expect(seo.location?.longitude).toBe(-86.78);
    }
  });

  it("omits placeSlug when the place is not directory-listed, even if location is EXACT", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: { pageSlug: "private-loft-9f8e7d6c", name: "Private Loft", listedInDirectory: false, venueConfirmed: true, locationMode: "EXACT" },
    });

    expect(seo.location?.isExact).toBe(true);
    expect(seo.location?.placeSlug).toBeNull();
    // The venue name rides the same gate: unlisted place → no name either.
    expect(seo.location?.name).toBeNull();
  });

  it("never surfaces placeSlug when location is redacted (OBSCURED circle)", () => {
    const event = {
      ...baseGeoEvent,
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
      addressRevealAt: new Date("2099-01-01T00:00:00.000Z"),
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: {
        pageSlug: "the-basement-east-a1b2c3d4",
        name: "The Basement East",
        listedInDirectory: true,
    locationMode: "EXACT",
        locationMode: "EXACT",
        venueConfirmed: true,
      },
    });

    expect(seo.location?.isExact).toBe(false);
    expect(seo.location?.placeSlug).toBeUndefined();
    // A recognizable venue name would deanonymize the obscured circle.
    expect(seo.location?.name).toBeNull();
  });

  it("never surfaces placeSlug when location is OBSCURED (fully hidden) and unrevealed", () => {
    const event = {
      ...baseGeoEvent,
      locationMode: "OBSCURED",
      addressRevealAt: new Date("2099-01-01T00:00:00.000Z"),
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      callerIsTicketHolder: false,
      place: {
        pageSlug: "the-basement-east-a1b2c3d4",
        name: "The Basement East",
        listedInDirectory: true,
    locationMode: "EXACT",
        locationMode: "EXACT",
        venueConfirmed: true,
      },
    });

    expect(seo.location?.isExact).toBe(false);
    expect(seo.location?.placeSlug).toBeUndefined();
    expect(seo.location?.name).toBeNull();
  });

  it("surfaces placeSlug for the lat/lng-absent revealUnlocked branch", () => {
    const event = {
      ...baseGeoEvent,
      lat: null,
      lng: null,
      locationMode: "EXACT",
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: {
        pageSlug: "the-basement-east-a1b2c3d4",
        name: "The Basement East",
        listedInDirectory: true,
    locationMode: "EXACT",
        locationMode: "EXACT",
        venueConfirmed: true,
      },
    });

    expect(seo.location?.isExact).toBe(true);
    expect(seo.location?.placeSlug).toBe("the-basement-east-a1b2c3d4");
    expect(seo.location?.name).toBe("The Basement East");
  });

  it("omits placeSlug for the lat/lng-absent, revealUnlocked=false branch", () => {
    const event = {
      ...baseGeoEvent,
      lat: null,
      lng: null,
      locationMode: "OBSCURED",
      addressRevealAt: new Date("2099-01-01T00:00:00.000Z"),
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      callerIsTicketHolder: false,
      place: {
        pageSlug: "the-basement-east-a1b2c3d4",
        name: "The Basement East",
        listedInDirectory: true,
    locationMode: "EXACT",
        locationMode: "EXACT",
        venueConfirmed: true,
      },
    });

    expect(seo.location?.isExact).toBe(false);
    expect(seo.location?.placeSlug).toBeUndefined();
    expect(seo.location?.name).toBeNull();
  });

  it("defaults placeSlug to null when no place is passed at all", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;

    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [] });

    expect(seo.location?.isExact).toBe(true);
    expect(seo.location?.placeSlug).toBeNull();
  });

  // ── The emitted slug is the ENTITY PAGE slug, never `Place.slug` ──────────
  //
  // A place carries TWO independent slugs, minted in the same transaction and
  // never equal in production: `Place.slug` is a multi-segment DIRECTORY key
  // (`us/tn/x--a1b2c3d4e5`, literal `/` included) that nothing routes on, and
  // `EntityPage.slug` is the flat `{name}-{id8}` value the single-segment
  // `/places/[slug]` route resolves on. Emitting the former put a dead link on
  // every public event page. Seeded dev DBs make the two identical, so these
  // fixtures deliberately use production-shaped, DIFFERENT values.

  it("emits the flat entity-page slug, not the multi-segment Place.slug, on the EXACT branch", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: {
        // What production actually stores on the EntityPage.
        pageSlug: "the-basement-east-9a3f1c02",
        name: "The Basement East",
        listedInDirectory: true,
    locationMode: "EXACT",
        locationMode: "EXACT",
        venueConfirmed: true,
      },
    });

    expect(seo.location?.placeSlug).toBe("the-basement-east-9a3f1c02");
    // The route is a single non-catch-all segment: any `/` in the emitted
    // value is proof a directory slug leaked back in.
    expect(seo.location?.placeSlug).not.toContain("/");
  });

  it("emits null — NOT the Place slug — for a directory-listed, confirmed venue with no entity page", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: {
        // Bulk-imported venues and places created before `upsertPlace`
        // auto-provisioned an EntityPage have no page at all.
        pageSlug: null,
        name: "Imported Venue",
        listedInDirectory: true,
    locationMode: "EXACT",
        locationMode: "EXACT",
        venueConfirmed: true,
      },
    });

    expect(seo.location?.isExact).toBe(true);
    expect(seo.location?.placeSlug).toBeNull();
    // …but the NAME survives. It is public directory data gated only on
    // directory-listed + venue-confirmed; the link is a separate,
    // reachability question. Folding the two dropped the venue entirely for
    // the whole bulk-imported population, which is the population that has no
    // EntityPage and no backfill.
    expect(seo.location?.name).toBe("Imported Venue");
  });

  it("emits null for a page-less venue on the lat/lng-absent revealed branch too", () => {
    const event = {
      ...baseGeoEvent,
      lat: null,
      lng: null,
      locationMode: "EXACT",
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: {
        pageSlug: null,
        name: "Imported Venue",
        listedInDirectory: true,
    locationMode: "EXACT",
        locationMode: "EXACT",
        venueConfirmed: true,
      },
    });

    expect(seo.location?.isExact).toBe(true);
    expect(seo.location?.placeSlug).toBeNull();
    expect(seo.location?.name).toBe("Imported Venue");
    // The address itself is untouched — this is a link gate, not a redaction.
    expect(seo.location?.addressLine1).toBe("1 Main St");
  });

  // ── NAME and LINK are separate gates ────────────────────────────────────
  it("renders an UNLINKED venue name for a page-less venue, and a linked one otherwise", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;
    const base = {
      name: "The Basement East",
      listedInDirectory: true,
    locationMode: "EXACT",
      venueConfirmed: true,
    };

    const linked = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: { ...base, pageSlug: "the-basement-east-a1b2c3d4" },
    });
    const unlinked = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: { ...base, pageSlug: null },
    });

    // Same name either way; only the link differs.
    expect(linked.location?.name).toBe("The Basement East");
    expect(unlinked.location?.name).toBe("The Basement East");
    expect(linked.location?.placeSlug).toBe("the-basement-east-a1b2c3d4");
    expect(unlinked.location?.placeSlug).toBeNull();
  });

  it("still drops BOTH name and link when the venue is unconfirmed or unlisted", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;

    // Unconfirmed: the venue-confirmation spec's address-only rule. The name
    // is a DISCLOSURE decision and this gate is unchanged by the split.
    const unconfirmed = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: {
        pageSlug: "the-basement-east-a1b2c3d4",
        name: "The Basement East",
        listedInDirectory: true,
    locationMode: "EXACT",
        locationMode: "EXACT",
        venueConfirmed: false,
      },
    });
    expect(unconfirmed.location?.name).toBeNull();
    expect(unconfirmed.location?.placeSlug).toBeNull();

    // Unlisted venue: an org's private room is not named either.
    const unlisted = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: {
        pageSlug: "private-loft-9f8e7d6c",
        name: "Private Loft",
        listedInDirectory: false,
        locationMode: "EXACT",
        venueConfirmed: true,
      },
    });
    expect(unlisted.location?.name).toBeNull();
    expect(unlisted.location?.placeSlug).toBeNull();
  });

  // ── Fully hidden (OBSCURED + locationRadiusMeters null, FR-003) ───────────

  it("fully-hidden pre-reveal → NO coordinates or radius, only areaLabel", () => {
    const event = {
      ...baseGeoEvent,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      addressRevealAt: new Date("2099-01-01T00:00:00.000Z"),
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      callerIsTicketHolder: false,
    });

    expect(seo.location?.isExact).toBe(false);
    expect(seo.location?.hidden).toBe(true);
    expect(seo.location?.latitude).toBeNull();
    expect(seo.location?.longitude).toBeNull();
    expect(seo.location?.radiusMeters).toBeNull();
    expect(seo.location?.addressLine1).toBeNull();
    expect(seo.location?.areaLabel).toBe("Nashville, TN");
  });

  it("fully-hidden + ticket holder pre-reveal → still hidden", () => {
    const event = {
      ...baseGeoEvent,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      addressRevealAt: new Date("2099-01-01T00:00:00.000Z"),
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      callerIsTicketHolder: true,
      now: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(seo.location?.isExact).toBe(false);
    expect(seo.location?.hidden).toBe(true);
    expect(seo.location?.latitude).toBeNull();
  });

  it("fully-hidden + ticket holder post-reveal → exact address + coordinates", () => {
    const event = {
      ...baseGeoEvent,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      addressRevealAt: new Date("2020-01-01T00:00:00.000Z"),
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      callerIsTicketHolder: true,
      // The event has a venue (`placeId`), and the holder reveal needs to know
      // it publishes its address — an unknown venue fails the reveal closed.
      place: {
        pageSlug: null,
        name: null,
        listedInDirectory: false,
        venueConfirmed: false,
        location: { id: "place-1", locationMode: "EXACT" },
      },
      now: new Date("2026-03-01T00:00:00.000Z"),
    } as any);

    expect(seo.location?.isExact).toBe(true);
    expect(seo.location?.latitude).toBe(36.16);
    expect(seo.location?.longitude).toBe(-86.78);
    expect(seo.location?.addressLine1).toBe("1 Main St");
  });

  it("the holder reveal edge is the INJECTED clock, never the wall clock", () => {
    // A reveal far in the wall-clock FUTURE but in the injected clock's
    // past: unlocked. And the reverse: locked. A `new Date()` inside the
    // compiler would get both of these wrong.
    const reveal = new Date("2099-06-01T00:00:00.000Z");
    const event = {
      ...baseGeoEvent,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      addressRevealAt: reveal,
    } as any;
    const place = {
      pageSlug: null,
      name: null,
      listedInDirectory: false,
      venueConfirmed: false,
      location: { id: "place-1", locationMode: "EXACT" },
    };
    const at = (now: Date) =>
      buildEventSeo({
        event,
        ticketTypes: [],
        eventHumans: [],
        callerIsTicketHolder: true,
        place,
        now,
      } as any);

    expect(at(new Date(reveal.getTime() + 1)).location?.isExact).toBe(true);
    expect(at(new Date(reveal.getTime() - 1)).location?.isExact).toBe(false);
  });

  it("OBSCURED circle pre-reveal → obfuscated point, never the true pin", () => {
    const event = {
      ...baseGeoEvent,
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
      addressRevealAt: new Date("2099-01-01T00:00:00.000Z"),
    } as any;

    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      callerIsTicketHolder: false,
    });

    expect(seo.location?.isExact).toBe(false);
    expect(seo.location?.hidden).toBeUndefined();
    expect(seo.location?.radiusMeters).toBe(500);
    expect(seo.location?.latitude).not.toBe(36.16);
    expect(seo.location?.longitude).not.toBe(-86.78);
    expect(seo.location?.addressLine1).toBeNull();
  });

  // ── refundCutoffAt: real, absolute deadline (calm-honest-ux FR-004) —
  // NEVER derived from the dead INSTANT_REFUND_CUTOFF_HOURS constant. ──────

  it("returns null refundCutoffAt when the organizer never overrode it", () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000008",
      slug: "demo/event-8",
      title: "No Override Event",
      status: "PUBLISHED",
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: null,
      updatedAt: null,
      refundCutoffAt: null,
      placeId: null,
      addressText: null,
      locality: null,
      region: null,
      postalCode: null,
      countryCode: null,
      lat: null,
      lng: null,
    } as any;

    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [] });

    expect(seo.refundCutoffAt).toBeNull();
  });

  it("surfaces refundCutoffAt as an ISO string when the organizer set an earlier deadline", () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000009",
      slug: "demo/event-9",
      title: "Custom Cutoff Event",
      status: "PUBLISHED",
      startsAt: new Date("2026-01-10T20:00:00.000Z"),
      endsAt: null,
      updatedAt: null,
      refundCutoffAt: new Date("2026-01-08T00:00:00.000Z"),
      placeId: null,
      addressText: null,
      locality: null,
      region: null,
      postalCode: null,
      countryCode: null,
      lat: null,
      lng: null,
    } as any;

    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [] });

    expect(seo.refundCutoffAt).toBe("2026-01-08T00:00:00.000Z");
  });

  // ── venueConfirmed: the venue-confirmation gate (docs/specs/2026-08-27) —
  // name + slug appear ONLY when the venue vouches for the event; otherwise
  // ADDRESS-ONLY, with the address fields untouched. ────────────────────────

  const listedPlace = (venueConfirmed: boolean) => ({
    pageSlug: "the-basement-east-a1b2c3d4",
    name: "The Basement East",
    listedInDirectory: true,
    locationMode: "EXACT",
    venueConfirmed,
  });

  it("UNCONFIRMED: EXACT location keeps its address but drops the venue name and slug, venueConfirmed false", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;
    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [], place: listedPlace(false) });
    expect(seo.location).toMatchObject({
      isExact: true,
      name: null,
      placeSlug: null,
      venueConfirmed: false,
      addressLine1: "1 Main St",
      city: "Nashville",
      region: "TN",
      postalCode: "37203",
      countryCode: "US",
      latitude: 36.16,
      longitude: -86.78,
    });
  });

  it("CONFIRMED: the same event surfaces name + slug and venueConfirmed true (withdrawn is the caller's false)", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;
    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [], place: listedPlace(true) });
    expect(seo.location).toMatchObject({
      name: "The Basement East",
      placeSlug: "the-basement-east-a1b2c3d4",
      venueConfirmed: true,
      addressLine1: "1 Main St",
    });
  });

  it("UNCONFIRMED on the lat/lng-absent revealed branch: address intact, no venue", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT", lat: null, lng: null } as any;
    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [], place: listedPlace(false) });
    expect(seo.location).toMatchObject({
      isExact: true,
      name: null,
      placeSlug: null,
      venueConfirmed: false,
      addressLine1: "1 Main St",
      city: "Nashville",
    });
  });

  it("the flag rides every redacted branch too, and is false with no place at all", () => {
    const obscured = {
      ...baseGeoEvent,
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
      addressRevealAt: new Date(Date.now() + 3_600_000),
    } as any;
    expect(
      buildEventSeo({ event: obscured, ticketTypes: [], eventHumans: [], place: listedPlace(true) }).location,
    ).toMatchObject({ isExact: false, venueConfirmed: true });
    const hidden = { ...obscured, locationRadiusMeters: null } as any;
    expect(
      buildEventSeo({ event: hidden, ticketTypes: [], eventHumans: [], place: listedPlace(false) }).location,
    ).toMatchObject({ hidden: true, venueConfirmed: false });
    const exact = { ...baseGeoEvent, locationMode: "EXACT" } as any;
    expect(buildEventSeo({ event: exact, ticketTypes: [], eventHumans: [], place: null }).location).toMatchObject({
      name: null,
      placeSlug: null,
      venueConfirmed: false,
    });
  });
  // ── Name-only display (owner ruling 2026-10-06, option B) ────────────────
  // An unconfirmed community listing may NAME its venue as plain text: name
  // set, placeSlug null, venueConfirmed false. The caller computes the gate
  // (`mayNameUnconfirmedVenue`) and passes `nameOnlyDisplay`.
  const nameOnlyPlace = (over: Record<string, unknown> = {}) => ({
    pageSlug: "the-basement-east-a1b2c3d4",
    name: "  The Basement East  ",
    listedInDirectory: false,
    locationMode: "EXACT",
    venueConfirmed: false,
    nameOnlyDisplay: true,
    ...over,
  });

  it("NAME-ONLY: EXACT → trimmed name, no slug (even if one is passed), venueConfirmed false", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;
    const seo = buildEventSeo({ event, ticketTypes: [], eventHumans: [], place: nameOnlyPlace() as any });
    expect(seo.location).toMatchObject({
      isExact: true,
      name: "The Basement East",
      placeSlug: null,
      venueConfirmed: false,
      addressLine1: "1 Main St",
    });
  });

  it("NAME-ONLY: a fully hidden location still emits no name", () => {
    const hidden = {
      ...baseGeoEvent,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      addressRevealAt: new Date(Date.now() + 3_600_000),
    } as any;
    const seo = buildEventSeo({ event: hidden, ticketTypes: [], eventHumans: [], place: nameOnlyPlace() as any });
    expect(seo.location).toMatchObject({ hidden: true, name: null, venueConfirmed: false });
  });

  it("NAME-ONLY at a WITHHELD venue (place OBSCURED, event row EXACT): drawn circle, no name", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;
    const seo = buildEventSeo({
      event,
      ticketTypes: [],
      eventHumans: [],
      place: nameOnlyPlace({
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        // The venue's full privacy row: it keys the circle to the place id.
        location: {
          id: "place-1",
          locationMode: "OBSCURED",
          locationRadiusMeters: 500,
          city: "Nashville",
          region: "TN",
          countryCode: "US",
          lat: 36.16,
          lng: -86.78,
        },
      }) as any,
    });
    // The drawn-circle branch: not exact, not fully hidden, a radius drawn.
    expect(seo.location?.isExact).toBe(false);
    expect((seo.location as any)?.hidden).not.toBe(true);
    expect((seo.location as any)?.radiusMeters).toBeGreaterThan(0);
    // Naming the venue would deanonymize the circle it withholds.
    expect(seo.location?.name).toBeNull();
    expect(seo.location?.venueConfirmed).toBe(false);
  });

  it("NAME-ONLY off (absent or false) → unchanged address-only", () => {
    const event = { ...baseGeoEvent, locationMode: "EXACT" } as any;
    for (const nameOnlyDisplay of [false, undefined]) {
      const seo = buildEventSeo({
        event,
        ticketTypes: [],
        eventHumans: [],
        place: nameOnlyPlace({ nameOnlyDisplay }) as any,
      });
      expect(seo.location).toMatchObject({ name: null, placeSlug: null, venueConfirmed: false });
    }
  });
});
