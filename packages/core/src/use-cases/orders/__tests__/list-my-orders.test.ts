import { describe, expect, it, vi } from "vitest";

import { holderVenueLine, listMyOrders } from "../list-my-orders";
import type { Repos } from "@th/ports/repos";
import type {
  ListOrdersByBuyerEventLocation,
  ListOrdersByBuyerItem,
} from "@th/ports/repos/orders";

const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const TRANSFER_ORDER_ID = "11111111-1111-4111-8111-111111111111";

describe("listMyOrders", () => {
  it("widens the buyer query with order ids the actor owns tickets in via transfer", async () => {
    const listByBuyer = vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 });
    const listOrderIdsOwnedByHuman = vi
      .fn()
      .mockResolvedValue([TRANSFER_ORDER_ID]);

    const repos = {
      orders: { listByBuyer },
      tickets: { listOrderIdsOwnedByHuman },
    } as unknown as Repos;

    await listMyOrders({ repos }, { actorHumanId: ACTOR_ID });

    expect(listOrderIdsOwnedByHuman).toHaveBeenCalledWith(ACTOR_ID);
    expect(listByBuyer).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerHumanId: ACTOR_ID,
        extraOrderIds: [TRANSFER_ORDER_ID],
      }),
    );
  });

  it("passes an empty extraOrderIds when the actor has no transferred-in tickets", async () => {
    const listByBuyer = vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 });
    const repos = {
      orders: { listByBuyer },
      tickets: { listOrderIdsOwnedByHuman: vi.fn().mockResolvedValue([]) },
    } as unknown as Repos;

    await listMyOrders({ repos }, { actorHumanId: ACTOR_ID });

    expect(listByBuyer).toHaveBeenCalledWith(
      expect.objectContaining({ extraOrderIds: [] }),
    );
  });
});

// ── The venue line a holder sees ─────────────────────────────────────────────
//
// The adapter used to build this row's venue as "place.name, place.city" with
// no mode, reveal-date or NEVER check. A named venue is a de-facto exact
// address, so that undid an OBSCURED event's obscurity on the holder's own
// ticket list. The adapter now returns raw inputs; the use case decides.

describe("listMyOrders — venue line gate", () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = new Date("2026-09-25T12:00:00.000Z");
  const ORDER_ID = "33333333-3333-4333-8333-333333333333";
  const EVENT_ID = "44444444-4444-4444-8444-444444444444";
  const PLACE_ID = "55555555-5555-4555-8555-555555555555";
  const VENUE_ORG = "66666666-6666-4666-8666-666666666666";
  const STRANGER_ORG = "77777777-7777-4777-8777-777777777777";

  const publicVenue = {
    name: "The Basement East",
    city: "Nashville",
    locationMode: "EXACT" as const,
    locationRadiusMeters: null,
  };
  const withheldVenue = {
    name: "The Blue Door House",
    city: "Nashville",
    locationMode: "OBSCURED" as const,
    locationRadiusMeters: 800,
  };
  /** The same withheld venue as `places.getById` returns it (owners included). */
  const withheldPlaceRecord = {
    id: PLACE_ID,
    ...withheldVenue,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
  };

  function location(
    overrides: Partial<ListOrdersByBuyerEventLocation> = {},
  ): ListOrdersByBuyerEventLocation {
    return {
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: "East Nashville",
      addressRevealAt: null,
      addressRevealPreset: null,
      locality: "Nashville",
      region: "TN",
      placeId: PLACE_ID,
      orgId: VENUE_ORG,
      humanId: null,
      stewardship: "OWNED",
      venueConfirmedAt: null,
      venueConfirmationWithdrawnAt: null,
      venueConfirmedPlaceId: null,
      startsAt: new Date(NOW.getTime() + 14 * 24 * HOUR),
      place: publicVenue,
      ...overrides,
    };
  }

  /** An active holder at the venue's own show, unless a case says otherwise. */
  const HOLDER = { venueConfirmationArm: "owner" as const, activeHolder: true };

  /** Revealed on its own schedule an hour ago, at the withheld venue. */
  const revealedAtWithheld = {
    place: withheldVenue,
    locationMode: "OBSCURED" as const,
    locationRadiusMeters: 800,
    addressRevealPreset: "IMMEDIATELY" as const,
    addressRevealAt: new Date(NOW.getTime() - HOUR),
  };

  it("EXACT at a public venue: unchanged — 'name, city'", () => {
    expect(holderVenueLine(location(), NOW, HOLDER)).toBe(
      "The Basement East, Nashville",
    );
  });

  it("freeform events: null in every state, as before", () => {
    expect(holderVenueLine(location({ place: null }), NOW, HOLDER)).toBeNull();
    expect(
      holderVenueLine(
        location({ place: null, locationMode: "OBSCURED", addressRevealPreset: "NEVER" }),
        NOW,
        HOLDER,
      ),
    ).toBeNull();
  });

  it("NEVER: the coarse label, not the venue's name, forever", () => {
    const line = holderVenueLine(
      location({
        locationMode: "OBSCURED",
        addressRevealPreset: "NEVER",
        addressRevealAt: null,
      }),
      new Date("2099-01-01T00:00:00.000Z"),
      HOLDER,
    );
    expect(line).toBe("Nashville, TN");
  });

  it("before the reveal: the coarse label, not the venue's name", () => {
    const line = holderVenueLine(
      location({
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date(NOW.getTime() + HOUR),
      }),
      NOW,
      HOLDER,
    );
    expect(line).toBe("Nashville, TN");
  });

  it("after the reveal: the venue's name again", () => {
    const line = holderVenueLine(
      location({
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date(NOW.getTime() - HOUR),
      }),
      NOW,
      HOLDER,
    );
    expect(line).toBe("The Basement East, Nashville");
  });

  it("an EXACT event row at a withheld venue is floored and locked", () => {
    expect(
      holderVenueLine(location({ place: withheldVenue }), NOW, HOLDER),
    ).toBe("Nashville, TN");
  });

  it("the venue's own show at a withheld venue, after the reveal: its name to the holder", () => {
    expect(holderVenueLine(location(revealedAtWithheld), NOW, HOLDER)).toBe(
      "The Blue Door House, Nashville",
    );
  });

  it("C1: an UNCONFIRMED third party at a withheld venue: the label, for good", () => {
    for (const now of [NOW, new Date("2099-01-01T00:00:00.000Z")]) {
      expect(
        holderVenueLine(location(revealedAtWithheld), now, {
          venueConfirmationArm: null,
          activeHolder: true,
        }),
      ).toBe("Nashville, TN");
    }
  });

  it("C1: a community listing (blanket consent) at a withheld venue: the label", () => {
    expect(
      holderVenueLine(location(revealedAtWithheld), NOW, {
        venueConfirmationArm: "community",
        activeHolder: true,
      }),
    ).toBe("Nashville, TN");
  });

  it("stamp arm: the label until startsAt − 24h, then the name", () => {
    const loc = location(revealedAtWithheld);
    const floor = new Date(loc.startsAt.getTime() - 24 * HOUR);
    const stamp = { venueConfirmationArm: "stamp" as const, activeHolder: true };
    expect(holderVenueLine(loc, new Date(floor.getTime() - 1), stamp)).toBe(
      "Nashville, TN",
    );
    expect(holderVenueLine(loc, floor, stamp)).toBe(
      "The Blue Door House, Nashville",
    );
  });

  it("H2: a row that does not make the viewer a holder: the label", () => {
    expect(
      holderVenueLine(location(revealedAtWithheld), NOW, {
        venueConfirmationArm: "owner",
        activeHolder: false,
      }),
    ).toBe("Nashville, TN");
  });

  // ── The use case end to end over repo rows ──────────────────────────────

  function row(overrides: Partial<ListOrdersByBuyerItem> = {}): ListOrdersByBuyerItem {
    return {
      id: ORDER_ID,
      eventId: EVENT_ID,
      eventSlug: "porch-show",
      eventName: "Porch Show",
      eventStartsAt: new Date(Date.now() + 72 * HOUR),
      eventLocation: location({
        ...revealedAtWithheld,
        addressRevealAt: new Date(Date.now() - HOUR),
      }),
      amountGrossCents: 2000,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      chargeLines: [
        { kind: "ticket", amountCents: 2000, meta: { buyerTotalCents: 2000 } },
      ],
      stripePaymentIntentId: "pi_row",
      buyerHumanId: ACTOR_ID,
      currency: "usd",
      status: "SUCCEEDED",
      occurredAt: new Date(),
      source: "PRIMARY",
      ticketCount: 1,
      tiers: ["GA"],
      ...overrides,
    };
  }

  function reposFor(
    items: ListOrdersByBuyerItem[],
    heldEventIds: string[] = [EVENT_ID],
  ) {
    const getPlace = vi.fn(async () => withheldPlaceRecord);
    const listEventIdsWithActiveTicket = vi.fn(async () => heldEventIds);
    const repos = {
      orders: {
        listByBuyer: vi.fn().mockResolvedValue({
          items,
          total: items.length,
          limit: 25,
          offset: 0,
        }),
      },
      tickets: {
        listOrderIdsOwnedByHuman: vi.fn().mockResolvedValue([]),
        listEventIdsWithActiveTicket,
      },
      places: { getById: getPlace },
    } as unknown as Repos;
    return { repos, getPlace, listEventIdsWithActiveTicket };
  }

  it("maps the repo rows: computes eventVenue and drops the raw inputs", async () => {
    const { repos } = reposFor([
      row({
        eventLocation: location({
          place: withheldVenue,
          locationMode: "OBSCURED",
          addressRevealPreset: "NEVER",
        }),
      }),
    ]);

    const result = await listMyOrders({ repos }, { actorHumanId: ACTOR_ID });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.eventVenue).toBe("Nashville, TN");
    expect(result.items[0]).not.toHaveProperty("eventLocation");
    expect(JSON.stringify(result)).not.toContain("Blue Door");
  });

  it("an active holder of the venue's own show sees the venue's name; the page costs one place read and one ticket read", async () => {
    const { repos, getPlace, listEventIdsWithActiveTicket } = reposFor([
      row(),
      row({ id: "88888888-8888-4888-8888-888888888888" }),
    ]);
    const result = await listMyOrders({ repos }, { actorHumanId: ACTOR_ID });
    expect(result.items.map((i) => i.eventVenue)).toEqual([
      "The Blue Door House, Nashville",
      "The Blue Door House, Nashville",
    ]);
    expect(getPlace).toHaveBeenCalledTimes(1);
    expect(listEventIdsWithActiveTicket).toHaveBeenCalledTimes(1);
    expect(listEventIdsWithActiveTicket).toHaveBeenCalledWith(ACTOR_ID, [EVENT_ID]);
  });

  it("C1: a stranger's unconfirmed event at the house: the label, whatever the ticket", async () => {
    const { repos } = reposFor([
      row({
        eventLocation: location({
          ...revealedAtWithheld,
          addressRevealAt: new Date(Date.now() - HOUR),
          orgId: STRANGER_ORG,
        }),
      }),
    ]);
    const result = await listMyOrders({ repos }, { actorHumanId: ACTOR_ID });
    expect(result.items[0]!.eventVenue).toBe("Nashville, TN");
    expect(JSON.stringify(result)).not.toContain("Blue Door");
  });

  it.each(["PENDING", "REFUNDED", "CANCELLED"] as const)(
    "H2: a %s order row: the label",
    async (status) => {
      const { repos } = reposFor([row({ status })]);
      const result = await listMyOrders(
        { repos },
        { actorHumanId: ACTOR_ID, statuses: [status] },
      );
      expect(result.items[0]!.eventVenue).toBe("Nashville, TN");
      expect(JSON.stringify(result)).not.toContain("Blue Door");
    },
  );

  it("H2: a paid order whose tickets all went elsewhere (transferred away): the label", async () => {
    const { repos } = reposFor([row()], []);
    const result = await listMyOrders({ repos }, { actorHumanId: ACTOR_ID });
    expect(result.items[0]!.eventVenue).toBe("Nashville, TN");
  });

  it("an empty page reads no tickets and no places", async () => {
    const { repos, getPlace, listEventIdsWithActiveTicket } = reposFor([]);
    await listMyOrders({ repos }, { actorHumanId: ACTOR_ID });
    expect(getPlace).not.toHaveBeenCalled();
    expect(listEventIdsWithActiveTicket).not.toHaveBeenCalled();
  });
});

describe("listMyOrders — Total paid on each row", () => {
  const baseItem = {
    id: "33333333-3333-4333-8333-333333333333",
    eventId: "44444444-4444-4444-8444-444444444444",
    eventSlug: "show",
    eventName: "Show",
    eventStartsAt: null,
    eventLocation: {
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: null,
      addressRevealAt: null,
      addressRevealPreset: null,
      locality: null,
      region: null,
      placeId: null,
      orgId: null,
      humanId: null,
      stewardship: "OWNED",
      venueConfirmedAt: null,
      venueConfirmationWithdrawnAt: null,
      venueConfirmedPlaceId: null,
      venueConfirmedStartsAt: null,
      startsAt: new Date("2026-10-01T00:00:00Z"),
      place: null,
    },
    amountGrossCents: 1000,
    feesPlatformCents: 33,
    taxAmountCents: 89,
    stripePaymentIntentId: "pi_1",
    buyerHumanId: ACTOR_ID,
    currency: "usd",
    status: "SUCCEEDED",
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    source: "PRIMARY",
    ticketCount: 1,
    tiers: ["GA"],
  } as unknown as ListOrdersByBuyerItem;

  const run = async (row: ListOrdersByBuyerItem) => {
    const repos = {
      orders: {
        listByBuyer: vi
          .fn()
          .mockResolvedValue({ items: [row], total: 1, limit: 25, offset: 0 }),
      },
      tickets: {
        listOrderIdsOwnedByHuman: vi.fn().mockResolvedValue([]),
        listEventIdsWithActiveTicket: vi.fn().mockResolvedValue([]),
      },
      places: { getById: vi.fn() },
    } as unknown as Repos;
    return (await listMyOrders({ repos }, { actorHumanId: ACTOR_ID })).items[0]!;
  };

  it("ABSORB: Total paid is face + tax; the raw inputs are dropped", async () => {
    const item = await run({
      ...baseItem,
      feePolicySnapshot: { feeMode: "ABSORB" },
      chargeLines: [
        { kind: "ticket", amountCents: 1000, meta: { buyerTotalCents: 1000 } },
      ],
    });

    expect(item.charges!.totalCents).toBe(1089);
    expect(item.charges!.platformFeeCents).toBe(0);
    expect(item).not.toHaveProperty("chargeLines");
    expect(item).not.toHaveProperty("feePolicySnapshot");
    expect(item).not.toHaveProperty("taxAmountCents");
  });

  it("PASS_THROUGH: Total paid includes the fees and tax, not gross alone", async () => {
    const item = await run({
      ...baseItem,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      chargeLines: [
        { kind: "ticket", amountCents: 1000, meta: { buyerTotalCents: 1097 } },
      ],
    });

    expect(item.charges!.totalCents).toBe(1186);
    expect(item.amountGrossCents).toBe(1000);
  });

  it("a transferred-in ticket: no charges, because the viewer did not buy the order", async () => {
    const item = await run({
      ...baseItem,
      buyerHumanId: "99999999-9999-4999-8999-999999999999",
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      chargeLines: [
        { kind: "ticket", amountCents: 1000, meta: { buyerTotalCents: 1097 } },
      ],
    });

    expect(item.charges).toBeNull();
    // The buyer's amounts are zeroed too (int contract kept for old clients).
    expect(item.amountGrossCents).toBe(0);
    expect(item.feesPlatformCents).toBe(0);
    expect(item).not.toHaveProperty("buyerHumanId");
    expect(item).not.toHaveProperty("stripePaymentIntentId");
  });
});
