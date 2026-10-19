import { describe, expect, it } from "vitest";

import {
  hasReleasedLeftOrder,
  isSameEmbedCart,
  leftOrderReservedUntil,
  leftOrdersReservedUntil,
  leftOrderUsuallyReleasedBy,
  withoutLapsedLeftOrders,
  withoutReleasedLeftOrders,
  type LeftEmbedOrders,
} from "./embed-payment-order";
import { embedCheckoutItems } from "./embed-pwyw";
import type { CartItem } from "./embed-types";

const ga = (qty: number): CartItem => ({ ticketTypeId: "tt-ga", qty });
const seated = (over: Partial<CartItem> = {}): CartItem => ({
  ticketTypeId: "tt-seat",
  qty: 2,
  seatIds: ["seat-a", "seat-b"],
  seatQuotes: [
    { seatId: "seat-a", unitPriceCents: 4500 },
    { seatId: "seat-b", unitPriceCents: 5000 },
  ],
  seatSectionId: "sec-1",
  ...over,
});

describe("isSameEmbedCart — whether two carts are the same purchase", () => {
  it("the same cart, rebuilt as new objects, is the same order", () => {
    expect(isSameEmbedCart([ga(1), seated()], [ga(1), seated()])).toBe(true);
  });

  it("order never matters: lines, seats and seat quotes listed differently are the same purchase", () => {
    const reordered = seated({
      seatIds: ["seat-b", "seat-a"],
      seatQuotes: [
        { seatId: "seat-b", unitPriceCents: 5000 },
        { seatId: "seat-a", unitPriceCents: 4500 },
      ],
    });
    expect(isSameEmbedCart([ga(1), seated()], [reordered, ga(1)])).toBe(true);
  });

  it("a field left undefined is the field absent", () => {
    expect(
      isSameEmbedCart([ga(1)], [{ ...ga(1), donationAmountCents: undefined }]),
    ).toBe(true);
  });

  it.each<[string, CartItem[]]>([
    ["another quantity", [ga(3), seated()]],
    ["a line removed", [seated()]],
    ["a line added", [ga(1), seated(), { ticketTypeId: "tt-vip", qty: 1 }]],
    ["another seat", [ga(1), seated({ seatIds: ["seat-a", "seat-c"] })]],
    // The server's idempotency hash does NOT cover seat ids, so this is the
    // case the widget must catch itself: same tickets, same count, other seats.
    [
      "the same number of seats, all different",
      [ga(1), seated({ seatIds: ["seat-c", "seat-d"] })],
    ],
    [
      "another pay-what-you-want amount",
      [{ ...ga(1), donationAmountCents: 2500 }, seated()],
    ],
  ])("%s is a different purchase", (_label, changed) => {
    expect(isSameEmbedCart([ga(1), seated()], changed)).toBe(false);
  });

  // Not WHAT is bought: once an order exists its figures come from the
  // server, so neither of these is a reason to discard it.
  it.each<[string, CartItem[]]>([
    [
      "a seat re-quoted at a new price",
      [
        ga(1),
        seated({
          seatQuotes: [
            { seatId: "seat-a", unitPriceCents: 4500 },
            { seatId: "seat-b", unitPriceCents: 5500 },
          ],
        }),
      ],
    ],
    ["a quote dropped", [ga(1), seated({ seatQuotes: undefined })]],
    ["another seat section label", [ga(1), seated({ seatSectionId: "sec-2" })]],
  ])("%s is the same purchase", (_label, changed) => {
    expect(isSameEmbedCart([ga(1), seated()], changed)).toBe(true);
  });

  it("the empty cart matches only itself", () => {
    expect(isSameEmbedCart([], [])).toBe(true);
    expect(isSameEmbedCart([], [ga(1)])).toBe(false);
  });

  it("a line at quantity zero is no line: the server is never sent one", () => {
    const withEmptyLine = [ga(1), seated(), { ticketTypeId: "tt-vip", qty: 0 }];
    expect(isSameEmbedCart([ga(1), seated()], withEmptyLine)).toBe(true);
    expect(isSameEmbedCart([], [{ ticketTypeId: "tt-vip", qty: 0 }])).toBe(true);
    // Not a way to hide a real line.
    expect(
      isSameEmbedCart([ga(1), seated()], [ga(0), seated()]),
    ).toBe(false);
  });
});

// The widget keeps its checkout key for any cart `isSameEmbedCart` calls the
// same purchase, and the server's idempotency hash reads `items` in the order
// they arrive (ticket type, quantity, pay-what-you-want amount). So two such
// carts must send the same `items`, or a retry under the kept key is refused
// as a conflict instead of replaying its order.
describe("the same purchase sends the same items, however the cart lists it", () => {
  const TIERS = [
    {
      id: "tt-ga",
      name: "General",
      priceCents: 2000,
      pricingMode: "FIXED" as const,
      minimumCents: null,
      suggestedCents: null,
      buyerUnitTotalCents: 2200,
    },
    {
      id: "tt-seat",
      name: "Reserved",
      priceCents: 4500,
      pricingMode: "FIXED" as const,
      minimumCents: null,
      suggestedCents: null,
      buyerUnitTotalCents: 4900,
    },
    {
      id: "tt-vip",
      name: "VIP",
      priceCents: 9000,
      pricingMode: "FIXED" as const,
      minimumCents: null,
      suggestedCents: null,
      buyerUnitTotalCents: 9800,
    },
  ];
  /** What the server hashes: the lines in order, without seats or quotes. */
  const hashed = (cart: CartItem[]) =>
    JSON.stringify(
      embedCheckoutItems(cart, TIERS).map((item) => ({
        ticketTypeId: item.ticketTypeId,
        qty: item.qty,
        donationAmountCents: item.donationAmountCents,
      })),
    );

  it.each<[string, CartItem[], CartItem[]]>([
    [
      "lines in another order",
      [seated(), ga(1), { ticketTypeId: "tt-vip", qty: 2 }],
      [{ ticketTypeId: "tt-vip", qty: 2 }, seated(), ga(1)],
    ],
    [
      "an empty line among them",
      [ga(1), seated()],
      [{ ticketTypeId: "tt-vip", qty: 0 }, seated(), ga(1)],
    ],
    [
      "one ticket type on two lines, in either order",
      [
        seated({ qty: 1, seatIds: ["seat-a"], seatQuotes: undefined }),
        seated({ qty: 2, seatIds: ["seat-c", "seat-b"], seatQuotes: undefined }),
      ],
      [
        seated({ qty: 2, seatIds: ["seat-b", "seat-c"], seatQuotes: undefined }),
        seated({ qty: 1, seatIds: ["seat-a"], seatQuotes: undefined }),
      ],
    ],
  ])("%s", (_label, a, b) => {
    expect(isSameEmbedCart(a, b)).toBe(true);
    expect(hashed(a)).toBe(hashed(b));
  });

  it("the order sent is by ticket type, then by seats", () => {
    expect(
      embedCheckoutItems(
        [
          { ticketTypeId: "tt-vip", qty: 2 },
          seated({ qty: 1, seatIds: ["seat-b"], seatQuotes: undefined }),
          ga(1),
          seated({ qty: 1, seatIds: ["seat-a"], seatQuotes: undefined }),
        ],
        TIERS,
      ).map((item) => [item.ticketTypeId, item.seatIds ?? null]),
    ).toEqual([
      ["tt-ga", null],
      ["tt-seat", ["seat-a"]],
      ["tt-seat", ["seat-b"]],
      ["tt-vip", null],
    ]);
  });

  it("the seats on a line go out as the buyer picked them", () => {
    expect(
      embedCheckoutItems(
        [seated({ seatIds: ["seat-b", "seat-a"], seatQuotes: undefined })],
        TIERS,
      )[0]!.seatIds,
    ).toEqual(["seat-b", "seat-a"]);
  });
});

describe("the orders the buyer left, each remembered by itself", () => {
  const NOW = Date.parse("2026-10-10T18:00:00.000Z");
  const IN_5 = "2026-10-10T18:05:00.000Z";
  const IN_12 = "2026-10-10T18:12:00.000Z";
  const PAST = "2026-10-10T17:59:59.000Z";
  const reserved = (eventId: string, reservedUntil: string | null) =>
    ({ eventId, reservedUntil, status: "reserved" }) as const;

  const ORDERS: LeftEmbedOrders = {
    secret_a: reserved("event-1", IN_5),
    secret_b: reserved("event-1", IN_12),
    secret_c: { eventId: "event-1", reservedUntil: IN_12, status: "releasing" },
    secret_d: { eventId: "event-1", reservedUntil: IN_12, status: "released" },
    secret_e: reserved("event-2", IN_5),
  };

  it("an event's tickets stop being reserved at the latest end among its RESERVED orders", () => {
    expect(leftOrdersReservedUntil(ORDERS, "event-1")).toBe(IN_12);
    expect(leftOrdersReservedUntil(ORDERS, "event-2")).toBe(IN_5);
    expect(leftOrdersReservedUntil(ORDERS, "event-3")).toBeNull();
  });

  it("an order being released, or released, reserves nothing", () => {
    const { secret_b: _b, ...withoutB } = ORDERS;
    // Without B, the event's only reserved order is A: C and D do not count.
    expect(leftOrdersReservedUntil(withoutB, "event-1")).toBe(IN_5);
    const { secret_a: _a, ...neither } = withoutB;
    expect(leftOrdersReservedUntil(neither, "event-1")).toBeNull();
  });

  it("releasing one order leaves the other's reservation as it was", () => {
    const afterA: LeftEmbedOrders = {
      ...ORDERS,
      secret_b: { ...ORDERS.secret_b!, status: "released" },
    };
    expect(leftOrdersReservedUntil(afterA, "event-1")).toBe(IN_5);
  });

  it("an end that has passed is still the answer (the caller watches the clock); one that cannot be read is none", () => {
    expect(
      leftOrdersReservedUntil({ s: reserved("event-1", PAST) }, "event-1"),
    ).toBe(PAST);
    expect(
      leftOrdersReservedUntil(
        { s: reserved("event-1", "soon"), t: reserved("event-1", null) },
        "event-1",
      ),
    ).toBeNull();
  });

  it("whether an event has a released order", () => {
    expect(hasReleasedLeftOrder(ORDERS, "event-1")).toBe(true);
    expect(hasReleasedLeftOrder(ORDERS, "event-2")).toBe(false);
  });

  it("lapsed: a reserved order whose time is up or unreadable is dropped; the rest stay, whatever their time", () => {
    const orders: LeftEmbedOrders = {
      over: reserved("event-1", PAST),
      rightNow: reserved("event-1", "2026-10-10T18:00:00.000Z"),
      noTime: reserved("event-1", null),
      ahead: reserved("event-1", IN_5),
      releasing: { eventId: "event-1", reservedUntil: PAST, status: "releasing" },
      released: { eventId: "event-1", reservedUntil: null, status: "released" },
    };
    expect(Object.keys(withoutLapsedLeftOrders(orders, NOW))).toEqual([
      "ahead",
      "releasing",
      "released",
    ]);
  });

  it("released orders are dropped for one event only", () => {
    const orders: LeftEmbedOrders = {
      a: { eventId: "event-1", reservedUntil: null, status: "released" },
      b: { eventId: "event-2", reservedUntil: null, status: "released" },
      c: reserved("event-1", IN_5),
    };
    expect(Object.keys(withoutReleasedLeftOrders(orders, "event-1"))).toEqual([
      "b",
      "c",
    ]);
  });

  it("nothing to drop: the same object back, so no state changes", () => {
    const orders: LeftEmbedOrders = { a: reserved("event-1", IN_5) };
    expect(withoutLapsedLeftOrders(orders, NOW)).toBe(orders);
    expect(withoutReleasedLeftOrders(orders, "event-1")).toBe(orders);
  });
});

describe("leftOrderReservedUntil — when an order the buyer left lets go of its tickets", () => {
  it("65 minutes after its time to pay ran out (80 from its creation), not when the countdown ends", () => {
    expect(leftOrderReservedUntil("2026-10-10T18:15:00.000Z")).toBe(
      "2026-10-10T19:20:00.000Z",
    );
  });

  it("no time, or one that cannot be read: none claimed", () => {
    expect(leftOrderReservedUntil(null)).toBeNull();
    expect(leftOrderReservedUntil("soon")).toBeNull();
  });

  it("usually 30 minutes before that (50 from its creation): one clean-up pass on time", () => {
    expect(leftOrderUsuallyReleasedBy("2026-10-10T19:20:00.000Z")).toBe(
      "2026-10-10T18:50:00.000Z",
    );
    expect(leftOrderUsuallyReleasedBy(null)).toBeNull();
    expect(leftOrderUsuallyReleasedBy("soon")).toBeNull();
  });
});
