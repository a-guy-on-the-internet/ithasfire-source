import { describe, it, expect, vi } from "vitest";

import { getMyOrder, getMyOrderOutputSchema } from "./get-my-order";
import type { Repos } from "@th/ports/repos";

function makeFakeRepos(overrides: {
  orderData?: any;
  eventData?: any;
  ticketTypes?: any[];
  orgData?: any;
}): Repos {
  return {
    orders: {
      getById: async () => overrides.orderData ?? null,
    },
    events: {
      getById: async () => overrides.eventData ?? null,
      listTicketTypes: async () => overrides.ticketTypes ?? [],
    },
    organizations: {
      getById: async () => overrides.orgData ?? null,
    },
    tickets: {
      viewerHoldsActiveTicketForEvent: async () => true,
    },
  } as unknown as Repos;
}

const ACTOR_ID = "00000000-0000-4000-8000-00000000d005";
const ORDER_ID = "00000000-0000-4000-8000-d00500000000";
const EVENT_ID = "00000000-0000-4000-8000-100000000000";
const ITEM_ID = "00000000-0000-4000-8000-c10500000000";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-200000000000";

describe("getMyOrder", () => {
  it("should return data that passes output schema validation", async () => {
    const repos = makeFakeRepos({
      orderData: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: ACTOR_ID,
        amountGrossCents: 5000,
        feesPlatformCents: 250,
        taxAmountCents: 222,
        currency: "usd",
        status: "SUCCEEDED",
        stripePaymentIntentId: "pi_test_123",
        source: "PRIMARY",
        nonRefundable: false,
        occurredAt: new Date(),
        feePolicySnapshot: {},
        parentOrderId: null,
        paidOutAt: null,
        items: [
          {
            id: ITEM_ID,
            orderId: ORDER_ID,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 2,
            unitPriceCents: 2500,
            amountCents: 5000,
            meta: {},
            resaleListingId: null,
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
        ],
      },
      eventData: {
        id: EVENT_ID,
        title: "Test Event",
        startsAt: new Date(),
        addressText: "123 Main St",
        locality: "Test City",
      },
      ticketTypes: [{ id: TICKET_TYPE_ID, name: "General Admission" }],
    });

    const result = await getMyOrder(
      { repos },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    // Validate against the output schema (same as tRPC .output())
    const parsed = getMyOrderOutputSchema.safeParse(result);
    if (!parsed.success) {
      console.error(
        "Validation errors:",
        JSON.stringify(parsed.error.issues, null, 2),
      );
    }
    expect(parsed.success).toBe(true);
    // Tax from the order flows through to the buyer-facing output.
    expect(result.taxAmountCents).toBe(222);
  });

  it("should handle null event fields gracefully", async () => {
    const repos = makeFakeRepos({
      orderData: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: ACTOR_ID,
        amountGrossCents: 5000,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        source: "PRIMARY",
        nonRefundable: false,
        occurredAt: new Date(),
        feePolicySnapshot: {},
        parentOrderId: null,
        paidOutAt: null,
        items: [
          {
            id: ITEM_ID,
            orderId: ORDER_ID,
            kind: "ticket",
            ticketTypeId: null,
            qty: 1,
            unitPriceCents: 5000,
            amountCents: 5000,
            meta: {},
            resaleListingId: null,
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
        ],
      },
      eventData: {
        id: EVENT_ID,
        title: "Test Event",
        startsAt: null,
        addressText: null,
        locality: null,
      },
    });

    const result = await getMyOrder(
      { repos },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    const parsed = getMyOrderOutputSchema.safeParse(result);
    if (!parsed.success) {
      console.error(
        "Validation errors:",
        JSON.stringify(parsed.error.issues, null, 2),
      );
    }
    expect(parsed.success).toBe(true);
    expect(result.eventStartsAt).toBeNull();
    expect(result.eventVenue).toBeNull();
    expect(result.stripePaymentIntentId).toBeNull();
    // Order with no tax → defaults to 0.
    expect(result.taxAmountCents).toBe(0);
    // Human-owned event (no orgId) → organiser contact fields are null.
    expect(result.organiserName).toBeNull();
    expect(result.organiserContactEmail).toBeNull();
  });

  it("populates organiser contact for org-owned events", async () => {
    const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
    const repos = makeFakeRepos({
      orderData: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: ACTOR_ID,
        amountGrossCents: 5000,
        feesPlatformCents: 250,
        currency: "usd",
        status: "SUCCEEDED",
        stripePaymentIntentId: "pi_test_org",
        source: "PRIMARY",
        nonRefundable: false,
        occurredAt: new Date(),
        feePolicySnapshot: {},
        parentOrderId: null,
        paidOutAt: null,
        items: [
          {
            id: ITEM_ID,
            orderId: ORDER_ID,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 1,
            unitPriceCents: 5000,
            amountCents: 5000,
            meta: {},
            resaleListingId: null,
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
        ],
      },
      eventData: {
        id: EVENT_ID,
        title: "Org Event",
        startsAt: new Date(),
        addressText: "123 Main St",
        locality: "Test City",
        orgId: ORG_ID,
      },
      ticketTypes: [{ id: TICKET_TYPE_ID, name: "General Admission" }],
      orgData: {
        id: ORG_ID,
        name: "Acme Org",
        contactEmail: "hello@acme.example",
      },
    });

    const result = await getMyOrder(
      { repos },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    expect(result.organiserName).toBe("Acme Org");
    expect(result.organiserContactEmail).toBe("hello@acme.example");
  });

  it("returns null organiser contact when the org lookup misses", async () => {
    const ORG_ID = "00000000-0000-4000-8000-0000000000a2";
    const repos = makeFakeRepos({
      orderData: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: ACTOR_ID,
        amountGrossCents: 5000,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        source: "PRIMARY",
        nonRefundable: false,
        occurredAt: new Date(),
        feePolicySnapshot: {},
        parentOrderId: null,
        paidOutAt: null,
        items: [],
      },
      eventData: {
        id: EVENT_ID,
        title: "Org Event",
        startsAt: new Date(),
        addressText: "123 Main St",
        locality: "Test City",
        orgId: ORG_ID,
      },
      // orgData omitted → organizations.getById resolves null
    });

    const result = await getMyOrder(
      { repos },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    expect(result.organiserName).toBeNull();
    expect(result.organiserContactEmail).toBeNull();
  });

  it("should handle refunded item status", async () => {
    const repos = makeFakeRepos({
      orderData: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: ACTOR_ID,
        amountGrossCents: 5000,
        feesPlatformCents: 250,
        currency: "usd",
        status: "PART_REFUNDED",
        stripePaymentIntentId: "pi_test_456",
        source: "PRIMARY",
        nonRefundable: false,
        occurredAt: new Date(),
        feePolicySnapshot: {},
        parentOrderId: null,
        paidOutAt: null,
        items: [
          {
            id: ITEM_ID,
            orderId: ORDER_ID,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 1,
            unitPriceCents: 2500,
            amountCents: 2500,
            meta: {},
            resaleListingId: null,
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
          {
            id: "00000000-0000-4000-8000-c20500000000",
            orderId: ORDER_ID,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 1,
            unitPriceCents: 2500,
            amountCents: 2500,
            meta: {},
            resaleListingId: null,
            paidOutAt: null,
            refundedAt: new Date(),
            transferredAt: null,
            status: "refunded",
          },
        ],
      },
      eventData: {
        id: EVENT_ID,
        title: "Test Event",
        startsAt: new Date(),
        addressText: "456 Oak Ave",
        locality: "Oak Town",
      },
      ticketTypes: [{ id: TICKET_TYPE_ID, name: "General Admission" }],
    });

    const result = await getMyOrder(
      { repos },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    const parsed = getMyOrderOutputSchema.safeParse(result);
    if (!parsed.success) {
      console.error(
        "Validation errors:",
        JSON.stringify(parsed.error.issues, null, 2),
      );
    }
    expect(parsed.success).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[1]?.status).toBe("refunded");
  });

  it("should throw not_found for missing order", async () => {
    const repos = makeFakeRepos({ orderData: null });

    await expect(
      getMyOrder({ repos }, { actorHumanId: ACTOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("should throw not_found when actor is not the buyer", async () => {
    const repos = makeFakeRepos({
      orderData: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: "00000000-0000-4000-8000-999999999999",
        amountGrossCents: 5000,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        source: "PRIMARY",
        nonRefundable: false,
        occurredAt: new Date(),
        feePolicySnapshot: {},
        parentOrderId: null,
        paidOutAt: null,
        items: [],
      },
    });

    await expect(
      getMyOrder({ repos }, { actorHumanId: ACTOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("includes resale listing linkage for owned tickets", async () => {
    const resaleListingId = "00000000-0000-4000-8000-333333333333";
    const repos = makeFakeRepos({
      orderData: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: ACTOR_ID,
        amountGrossCents: 5000,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        source: "PRIMARY",
        nonRefundable: false,
        occurredAt: new Date(),
        feePolicySnapshot: {},
        parentOrderId: null,
        paidOutAt: null,
        items: [
          {
            id: ITEM_ID,
            orderId: ORDER_ID,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 1,
            unitPriceCents: 5000,
            amountCents: 5000,
            meta: {},
            resaleListingId,
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
        ],
      },
      eventData: {
        id: EVENT_ID,
        title: "Test Event",
        startsAt: new Date(),
        addressText: "123 Main St",
        locality: "Test City",
      },
      ticketTypes: [{ id: TICKET_TYPE_ID, name: "General Admission" }],
    });

    const result = await getMyOrder(
      { repos },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    expect(result.items[0]?.resaleListingId).toBe(resaleListingId);
  });
});

// ── The address a ticket holder sees ─────────────────────────────────────────
//
// `eventVenue` used to be `[event.addressText, event.locality]` with no mode,
// reveal-date or NEVER check, so the order page printed the street for an
// OBSCURED event before its reveal and for NEVER events forever. It now goes
// through `resolveHolderAddress`, the decision every holder surface shares.

describe("getMyOrder — address reveal gate", () => {
  const PLACE_ID = "00000000-0000-4000-8000-0000000000b1";
  const VENUE_ORG = "00000000-0000-4000-8000-0000000000c1";
  const STRANGER_ORG = "00000000-0000-4000-8000-0000000000c2";
  const HOUR = 60 * 60 * 1000;

  const baseOrder = {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: ACTOR_ID,
    amountGrossCents: 5000,
    feesPlatformCents: 0,
    currency: "usd",
    status: "SUCCEEDED",
    stripePaymentIntentId: null,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date(),
    feePolicySnapshot: {},
    parentOrderId: null,
    paidOutAt: null,
    items: [],
  };

  /** An EXACT event holding its true street, as every event did before. */
  const exactEvent = {
    id: EVENT_ID,
    title: "Porch Show",
    startsAt: new Date(Date.now() + 72 * HOUR),
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: "East Nashville",
    addressRevealAt: null,
    addressRevealPreset: null,
    placeId: null,
    addressText: "1114 Fatherland St, Nashville, TN 37206",
    locality: "Nashville",
    region: "TN",
    postalCode: "37206",
    lat: 36.1773,
    lng: -86.7554,
  };

  /**
   * A venue that withholds its address. The truth lives only here. Its owner
   * is `VENUE_ORG`, which also owns `projectionEvent`: the venue's own show.
   */
  const withheldPlace = {
    id: PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    // Street only, like every real `Place.address`; the city is `city`.
    formattedAddress: "901 Porter Rd",
    addressLine1: "901 Porter Rd",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: 36.1862,
    lng: -86.7291,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Nashville",
  };

  /**
   * The event at that venue as part 1 stores it: the Event row is the
   * venue's PUBLIC projection, never the truth.
   */
  const projectionEvent = {
    ...exactEvent,
    orgId: VENUE_ORG,
    humanId: null,
    stewardship: "OWNED",
    placeId: PLACE_ID,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    addressRevealPreset: "DAY_BEFORE",
    addressText: "East Nashville",
    postalCode: null,
    lat: 36.18,
    lng: -86.75,
  };

  function run(
    event: Record<string, unknown>,
    place: unknown = null,
    holder: { orderStatus?: string; holdsTicket?: boolean } = {},
  ) {
    const getPlace = vi.fn(async () => place);
    const viewerHoldsActiveTicketForEvent = vi.fn(
      async () => holder.holdsTicket ?? true,
    );
    const repos = {
      orders: {
        getById: async () => ({
          ...baseOrder,
          status: holder.orderStatus ?? baseOrder.status,
        }),
      },
      events: {
        getById: async () => event,
        listTicketTypes: async () => [],
      },
      organizations: { getById: async () => null },
      places: { getById: getPlace },
      tickets: { viewerHoldsActiveTicketForEvent },
    } as unknown as Repos;
    return {
      getPlace,
      viewerHoldsActiveTicketForEvent,
      result: getMyOrder(
        { repos },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      ),
    };
  }

  it("EXACT: unchanged — street + locality, not locked, no place lookup", async () => {
    const { result, getPlace } = run(exactEvent);
    const out = await result;
    expect(out.eventVenue).toBe(
      "1114 Fatherland St, Nashville, TN 37206, Nashville",
    );
    expect(out.eventAddressLocked).toBe(false);
    expect(out.eventAddressRevealAt).toBeNull();
    expect(out.eventAddressNeverShared).toBe(false);
    expect(getPlace).not.toHaveBeenCalled();
    expect(getMyOrderOutputSchema.safeParse(out).success).toBe(true);
  });

  it("NEVER: locked forever — the coarse label only, flagged never-shared", async () => {
    const { result } = run({
      ...exactEvent,
      locationMode: "OBSCURED",
      addressRevealPreset: "NEVER",
      addressRevealAt: null,
      startsAt: new Date(Date.now() - 365 * 24 * HOUR),
    });
    const out = await result;
    expect(out.eventVenue).toBe("Nashville, TN");
    expect(out.eventAddressLocked).toBe(true);
    expect(out.eventAddressNeverShared).toBe(true);
    expect(out.eventAddressRevealAt).toBeNull();
    expect(JSON.stringify(out)).not.toContain("Fatherland");
    expect(getMyOrderOutputSchema.safeParse(out).success).toBe(true);
  });

  it("before the reveal: locked, with the reveal date, no street", async () => {
    const revealAt = new Date(Date.now() + 24 * HOUR);
    const { result } = run({
      ...exactEvent,
      locationMode: "OBSCURED",
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: revealAt,
    });
    const out = await result;
    expect(out.eventVenue).toBe("Nashville, TN");
    expect(out.eventAddressLocked).toBe(true);
    expect(out.eventAddressRevealAt).toEqual(revealAt);
    expect(out.eventAddressNeverShared).toBe(false);
    expect(JSON.stringify(out)).not.toContain("Fatherland");
  });

  it("after the reveal (freeform): the Event row's street", async () => {
    const { result } = run({
      ...exactEvent,
      locationMode: "OBSCURED",
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: new Date(Date.now() - HOUR),
    });
    const out = await result;
    expect(out.eventVenue).toBe(
      "1114 Fatherland St, Nashville, TN 37206, Nashville",
    );
    expect(out.eventAddressLocked).toBe(false);
  });

  it("after the reveal at a withheld venue: the Place's TRUE address, not the Event projection", async () => {
    const { result, getPlace } = run(
      { ...projectionEvent, addressRevealAt: new Date(Date.now() - HOUR) },
      withheldPlace,
    );
    const out = await result;
    expect(getPlace).toHaveBeenCalledWith(PLACE_ID);
    // Same "street, locality" shape an EXACT event at a public venue shows.
    expect(out.eventVenue).toBe("901 Porter Rd, Nashville");
    expect(out.eventAddressLocked).toBe(false);
    // The projection's area label is what the public sees; it is not the
    // address and must not be what a revealed holder gets.
    expect(out.eventVenue).not.toContain(projectionEvent.addressText);
  });

  it("before the reveal at a withheld venue: locked, and neither the street nor the venue name leaks", async () => {
    const { result } = run(
      { ...projectionEvent, addressRevealAt: new Date(Date.now() + HOUR) },
      withheldPlace,
    );
    const out = await result;
    expect(out.eventAddressLocked).toBe(true);
    expect(out.eventVenue).toBe("Nashville, TN");
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("Porter");
    expect(serialized).not.toContain("Blue Door");
  });

  it("an EXACT event row at a withheld venue (published before the venue hid) is locked", async () => {
    const { result } = run({ ...exactEvent, placeId: PLACE_ID }, withheldPlace);
    const out = await result;
    expect(out.eventAddressLocked).toBe(true);
    expect(out.eventVenue).toBe("Nashville, TN");
    expect(JSON.stringify(out)).not.toContain("Fatherland");
  });

  // ── C1: who a withheld venue releases its address to ─────────────────────

  /** Revealed on its own schedule: IMMEDIATELY, an hour ago. */
  const immediately = {
    addressRevealPreset: "IMMEDIATELY",
    addressRevealAt: new Date(Date.now() - HOUR),
  };

  function expectNoVenueTruth(out: unknown) {
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("Porter");
    expect(serialized).not.toContain("Blue Door");
    expect(serialized).not.toContain("37206");
  }

  it("C1: a stranger's UNCONFIRMED event at the house, IMMEDIATELY, with a paid ticket: locked, venueUnconfirmed", async () => {
    const { result } = run(
      { ...projectionEvent, ...immediately, orgId: STRANGER_ORG },
      withheldPlace,
    );
    const out = await result;
    expect(out.eventAddressLocked).toBe(true);
    expect(out.eventAddressLockReason).toBe("venueUnconfirmed");
    expect(out.eventAddressRevealAt).toBeNull();
    expect(out.eventAddressNeverShared).toBe(false);
    expect(out.eventVenue).toBe("Nashville, TN");
    expectNoVenueTruth(out);
    expect(getMyOrderOutputSchema.safeParse(out).success).toBe(true);
  });

  it("C1: a WITHDRAWN confirmation releases nothing", async () => {
    const { result } = run(
      {
        ...projectionEvent,
        ...immediately,
        orgId: STRANGER_ORG,
        venueConfirmedAt: new Date(Date.now() - 48 * HOUR),
        venueConfirmationWithdrawnAt: new Date(Date.now() - 24 * HOUR),
        venueConfirmedPlaceId: PLACE_ID,
      },
      withheldPlace,
    );
    const out = await result;
    expect(out.eventAddressLockReason).toBe("venueUnconfirmed");
    expectNoVenueTruth(out);
  });

  it("C1: an ownerless community listing the house accepts by blanket consent: locked", async () => {
    const { result } = run(
      {
        ...projectionEvent,
        ...immediately,
        orgId: null,
        stewardship: "COMMUNITY",
      },
      withheldPlace,
    );
    const out = await result;
    expect(out.eventAddressLockReason).toBe("venueUnconfirmed");
    expectNoVenueTruth(out);
  });

  it("stamp arm: a stranger's event the venue CONFIRMED, IMMEDIATELY: locked until startsAt − 24h, then the Place's truth", async () => {
    const stamped = {
      ...projectionEvent,
      ...immediately,
      orgId: STRANGER_ORG,
      venueConfirmedAt: new Date(Date.now() - 48 * HOUR),
      venueConfirmationWithdrawnAt: null,
      venueConfirmedPlaceId: PLACE_ID,
    };
    // Starts in 72h: the floor is 48h out.
    const early = await run(stamped, withheldPlace).result;
    expect(early.eventAddressLocked).toBe(true);
    expect(early.eventAddressLockReason).toBe("notYetRevealed");
    expect(early.eventAddressRevealAt).toEqual(
      new Date(stamped.startsAt.getTime() - 24 * HOUR),
    );
    expectNoVenueTruth(early);

    // Starts in 23h: inside the day-before floor.
    const late = await run(
      { ...stamped, startsAt: new Date(Date.now() + 23 * HOUR) },
      withheldPlace,
    ).result;
    expect(late.eventAddressLocked).toBe(false);
    expect(late.eventVenue).toBe("901 Porter Rd, Nashville");
  });

  it("N1: a confirmed show its organizer moved EARLIER keeps the venue's floor (a day before the CONFIRMED start)", async () => {
    const confirmedStartsAt = new Date(Date.now() + 90 * 24 * HOUR);
    const moved = {
      ...projectionEvent,
      ...immediately,
      orgId: STRANGER_ORG,
      venueConfirmedAt: new Date(Date.now() - 48 * HOUR),
      venueConfirmationWithdrawnAt: null,
      venueConfirmedPlaceId: PLACE_ID,
      venueConfirmedStartsAt: confirmedStartsAt,
      // Moved to 23h from now: inside the day-before of the MOVED date.
      startsAt: new Date(Date.now() + 23 * HOUR),
    };
    const out = await run(moved, withheldPlace).result;
    expect(out.eventAddressLocked).toBe(true);
    expect(out.eventAddressLockReason).toBe("notYetRevealed");
    expect(out.eventAddressRevealAt).toEqual(
      new Date(confirmedStartsAt.getTime() - 24 * HOUR),
    );
    expectNoVenueTruth(out);
  });

  it("a venue that could not be read: locked as placeUnavailable (not venueUnconfirmed), and the output schema accepts it", async () => {
    const { result } = run({ ...projectionEvent, ...immediately }, null);
    const out = await result;
    expect(out.eventAddressLocked).toBe(true);
    expect(out.eventAddressLockReason).toBe("placeUnavailable");
    expect(out.eventAddressRevealAt).toBeNull();
    expectNoVenueTruth(out);
    expect(getMyOrderOutputSchema.safeParse(out).success).toBe(true);
  });

  // ── H2: the viewer must be an ACTIVE holder ─────────────────────────────

  const revealedOwnShow = { ...projectionEvent, ...immediately };

  it("H2: a PENDING order (checkout written, never paid) gets no street — and no ticket read", async () => {
    const { result, viewerHoldsActiveTicketForEvent } = run(revealedOwnShow, withheldPlace, {
      orderStatus: "PENDING",
    });
    const out = await result;
    expect(out.eventAddressLocked).toBe(true);
    expect(out.eventAddressLockReason).toBe("notHolder");
    expect(out.eventAddressRevealAt).toBeNull();
    expect(out.eventVenue).toBe("Nashville, TN");
    expectNoVenueTruth(out);
    expect(viewerHoldsActiveTicketForEvent).not.toHaveBeenCalled();
  });

  it.each(["PROCESSING", "REFUNDED", "CANCELLED"])(
    "H2: a %s order gets no street",
    async (orderStatus) => {
      const out = await run(revealedOwnShow, withheldPlace, { orderStatus }).result;
      expect(out.eventAddressLockReason).toBe("notHolder");
      expectNoVenueTruth(out);
    },
  );

  it("H2: a paid order whose tickets were all transferred away (or self-refunded) gets no street", async () => {
    const { result, viewerHoldsActiveTicketForEvent } = run(revealedOwnShow, withheldPlace, {
      holdsTicket: false,
    });
    const out = await result;
    expect(viewerHoldsActiveTicketForEvent).toHaveBeenCalledWith(EVENT_ID, ACTOR_ID);
    expect(out.eventAddressLockReason).toBe("notHolder");
    expectNoVenueTruth(out);
  });

  it("H2: the same gate on a freeform event (the Event row's street)", async () => {
    const out = await run(
      { ...exactEvent, locationMode: "OBSCURED", ...immediately },
      null,
      { orderStatus: "PENDING" },
    ).result;
    expect(out.eventAddressLockReason).toBe("notHolder");
    expect(JSON.stringify(out)).not.toContain("Fatherland");
  });

  it.each(["SUCCEEDED", "PART_REFUNDED", "DISPUTED"])(
    "a %s order still holding a ticket is a holder",
    async (orderStatus) => {
      const out = await run(revealedOwnShow, withheldPlace, { orderStatus }).result;
      expect(out.eventAddressLocked).toBe(false);
      expect(out.eventAddressLockReason).toBeNull();
      expect(out.eventVenue).toBe("901 Porter Rd, Nashville");
    },
  );

  it("an EXACT event's address is public: a PENDING order still sees it", async () => {
    const out = await run(exactEvent, null, { orderStatus: "PENDING" }).result;
    expect(out.eventAddressLocked).toBe(false);
    expect(out.eventVenue).toContain("1114 Fatherland St");
  });
});

// Owner rule 2026-09-28: the page hides "Transfer" once the event is over, and
// reads that from here so the rule lives in core (`isEventPast`), not the UI.
describe("getMyOrder — eventEnded", () => {
  const NOW = new Date("2026-10-01T12:00:00.000Z");
  const clock = { now: () => NOW };

  function reposFor(event: { startsAt: Date; endsAt: Date | null } | null) {
    return makeFakeRepos({
      orderData: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: ACTOR_ID,
        amountGrossCents: 5000,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        source: "PRIMARY",
        nonRefundable: false,
        occurredAt: NOW,
        feePolicySnapshot: {},
        parentOrderId: null,
        paidOutAt: null,
        items: [],
      },
      eventData: event
        ? { id: EVENT_ID, title: "Show", addressText: null, ...event }
        : null,
    });
  }

  const input = { actorHumanId: ACTOR_ID, orderId: ORDER_ID };

  it("is false before the end and true from the end instant on", async () => {
    const startsAt = new Date(NOW.getTime() - 3 * 3600_000);
    const before = await getMyOrder(
      {
        repos: reposFor({ startsAt, endsAt: new Date(NOW.getTime() + 1) }),
        clock,
      },
      input,
    );
    expect(before.eventEnded).toBe(false);

    const at = await getMyOrder(
      { repos: reposFor({ startsAt, endsAt: NOW }), clock },
      input,
    );
    expect(at.eventEnded).toBe(true);
    expect(getMyOrderOutputSchema.safeParse(at).success).toBe(true);
  });

  it("falls back to the start when the event has no end", async () => {
    const out = await getMyOrder(
      { repos: reposFor({ startsAt: NOW, endsAt: null }), clock },
      input,
    );
    expect(out.eventEnded).toBe(true);
  });

  it("is false when the event row is missing", async () => {
    const out = await getMyOrder({ repos: reposFor(null), clock }, input);
    expect(out.eventEnded).toBe(false);
  });
});

describe("getMyOrder — resale claim window", () => {
  const DAY = 24 * 3600_000;
  const startsAt = new Date("2026-10-01T18:00:00.000Z");

  function reposFor(
    source: "PRIMARY" | "RESALE" | "COMP",
    endsAt: Date | null,
  ) {
    return makeFakeRepos({
      orderData: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: ACTOR_ID,
        amountGrossCents: 5000,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        source,
        nonRefundable: false,
        occurredAt: startsAt,
        feePolicySnapshot: {},
        parentOrderId: null,
        paidOutAt: null,
        items: [],
      },
      eventData: {
        id: EVENT_ID,
        title: "Show",
        addressText: null,
        startsAt,
        endsAt,
      },
    });
  }
  const input = { actorHumanId: ACTOR_ID, orderId: ORDER_ID };

  it("RESALE with an end: closes at endsAt + 3 days", async () => {
    const endsAt = new Date(startsAt.getTime() + 2 * DAY);
    const out = await getMyOrder({ repos: reposFor("RESALE", endsAt) }, input);
    expect(out.source).toBe("RESALE");
    expect(out.resaleClaimWindowClosesAt).toBe(
      new Date(endsAt.getTime() + 3 * DAY).toISOString(),
    );
    expect(getMyOrderOutputSchema.safeParse(out).success).toBe(true);
  });

  it("RESALE without an end: closes at startsAt + 3 days", async () => {
    const out = await getMyOrder({ repos: reposFor("RESALE", null) }, input);
    expect(out.resaleClaimWindowClosesAt).toBe(
      new Date(startsAt.getTime() + 3 * DAY).toISOString(),
    );
  });

  it("a non-resale order has no window", async () => {
    for (const source of ["PRIMARY", "COMP"] as const) {
      const out = await getMyOrder(
        { repos: reposFor(source, new Date(startsAt.getTime() + DAY)) },
        input,
      );
      expect(out.source).toBe(source);
      expect(out.resaleClaimWindowClosesAt).toBeNull();
    }
  });
});
