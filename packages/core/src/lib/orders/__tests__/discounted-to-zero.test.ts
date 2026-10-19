import { describe, expect, it } from "vitest";

import {
  allocateDiscountsToTickets,
  ticketsDiscountedToZero,
  type TicketDiscount,
} from "../discounted-to-zero";

/**
 * Owner ruling, 2026-10-10: "yes a promo brought down to $0 should have no fee
 * too." These pin the DEFINITION of "brought down to $0" that the fee rule
 * hangs on: each discount is spread over the tickets it applies to, in
 * proportion to price, and a ticket is at $0 when the shares cover its price.
 */

const GA = "type-ga";
const VIP = "type-vip";

const ticket = (ticketTypeId: string, unitPriceCents: number) => ({
  ticketTypeId,
  unitPriceCents,
});
const onType = (ticketTypeId: string, discountCents: number): TicketDiscount => ({
  ticketTypeId,
  discountCents,
});
const onOrder = (discountCents: number): TicketDiscount => ({
  ticketTypeId: null,
  discountCents,
});

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("allocateDiscountsToTickets", () => {
  it("puts a ticket-type discount on that type's tickets only", () => {
    const tickets = [ticket(GA, 3000), ticket(VIP, 5000)];
    expect(allocateDiscountsToTickets(tickets, [onType(VIP, 5000)])).toEqual([
      0, 5000,
    ]);
    expect(ticketsDiscountedToZero(tickets, [onType(VIP, 5000)])).toEqual([
      false,
      true,
    ]);
  });

  it("zeroes every ticket of the type when the discount covers them all, at different prices too", () => {
    // Two VIP seats, one with a $20 override: 100% off the type is $70.
    const tickets = [ticket(VIP, 5000), ticket(GA, 3000), ticket(VIP, 2000)];
    expect(allocateDiscountsToTickets(tickets, [onType(VIP, 7000)])).toEqual([
      5000, 0, 2000,
    ]);
    expect(ticketsDiscountedToZero(tickets, [onType(VIP, 7000)])).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("a fixed amount that covers one of two tickets of the type zeroes NEITHER: it is split by price", () => {
    const tickets = [ticket(VIP, 3000), ticket(VIP, 3000), ticket(GA, 3000)];
    expect(allocateDiscountsToTickets(tickets, [onType(VIP, 3000)])).toEqual([
      1500, 1500, 0,
    ]);
    expect(ticketsDiscountedToZero(tickets, [onType(VIP, 3000)])).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("spreads an order-wide discount over every ticket in proportion to price", () => {
    // $30 off a $30 + $50 cart: 3000 × 30/80 = 1125 and 3000 × 50/80 = 1875.
    const tickets = [ticket(GA, 3000), ticket(VIP, 5000)];
    expect(allocateDiscountsToTickets(tickets, [onOrder(3000)])).toEqual([
      1125, 1875,
    ]);
    expect(ticketsDiscountedToZero(tickets, [onOrder(3000)])).toEqual([
      false,
      false,
    ]);
  });

  it("an order-wide discount zeroes a ticket only when it zeroes the order (to within a cent)", () => {
    const tickets = [ticket(GA, 3000), ticket(VIP, 5000)];
    // $79.98 off $80: 2999.25 and 4998.75 → 2999 and 4999. A cent left on each.
    expect(allocateDiscountsToTickets(tickets, [onOrder(7998)])).toEqual([
      2999, 4999,
    ]);
    expect(ticketsDiscountedToZero(tickets, [onOrder(7998)])).toEqual([
      false,
      false,
    ]);
    expect(ticketsDiscountedToZero(tickets, [onOrder(8000)])).toEqual([
      true,
      true,
    ]);
  });

  it("rounds with largest remainders, so the shares sum to the discount exactly", () => {
    // 1000 over three $9.99 tickets: 333.33 each → 334, 333, 333.
    const tickets = [ticket(GA, 999), ticket(GA, 999), ticket(GA, 999)];
    const allocated = allocateDiscountsToTickets(tickets, [onOrder(1000)]);
    expect(allocated).toEqual([334, 333, 333]);
    expect(sum(allocated)).toBe(1000);
  });

  it("applies discounts in order, each to what the ones before it left", () => {
    // 50% off the order, then 100% of VIP's LIST price (what the evaluation
    // computes), clamped by the evaluation to the $40 the order has left.
    const tickets = [ticket(GA, 3000), ticket(VIP, 5000)];
    const discounts = [onOrder(4000), onType(VIP, 4000)];
    // After the first: GA 1500 left, VIP 2500 left. The second takes VIP's
    // 2500 and the 1500 that does not fit there comes off the rest.
    expect(allocateDiscountsToTickets(tickets, discounts)).toEqual([3000, 5000]);
    expect(ticketsDiscountedToZero(tickets, discounts)).toEqual([true, true]);
  });

  it("spills a ticket-type discount larger than its tickets onto the rest of the order", () => {
    const tickets = [ticket(GA, 3000), ticket(VIP, 5000)];
    const allocated = allocateDiscountsToTickets(tickets, [onType(VIP, 6000)]);
    expect(allocated).toEqual([1000, 5000]);
    expect(sum(allocated)).toBe(6000);
  });

  it("never allocates more than the order costs, or more than a ticket costs", () => {
    const tickets = [ticket(GA, 3000), ticket(VIP, 5000)];
    const allocated = allocateDiscountsToTickets(tickets, [
      onOrder(6000),
      onOrder(6000),
    ]);
    expect(allocated).toEqual([3000, 5000]);
  });

  it("the one-cent edge: a discount that leaves fewer cents than tickets zeroes the rest", () => {
    // $99.99 off two $50.00 tickets: one keeps the cent, the other is $0.
    const tickets = [ticket(GA, 5000), ticket(GA, 5000)];
    const allocated = allocateDiscountsToTickets(tickets, [onOrder(9999)]);
    expect(sum(allocated)).toBe(9999);
    expect([...allocated].sort()).toEqual([4999, 5000]);
    expect(
      ticketsDiscountedToZero(tickets, [onOrder(9999)]).filter(Boolean),
    ).toHaveLength(1);
  });

  it("a ticket whose price is already $0 is not 'brought down': it has no price to discount", () => {
    const tickets = [ticket(GA, 0), ticket(VIP, 5000)];
    expect(allocateDiscountsToTickets(tickets, [onOrder(5000)])).toEqual([
      0, 5000,
    ]);
    expect(ticketsDiscountedToZero(tickets, [onOrder(5000)])).toEqual([
      false,
      true,
    ]);
  });

  it("no discounts, a zero discount and a discount for a type not in the cart change nothing", () => {
    const tickets = [ticket(GA, 3000), ticket(VIP, 5000)];
    expect(ticketsDiscountedToZero(tickets, [])).toEqual([false, false]);
    expect(allocateDiscountsToTickets(tickets, [onOrder(0)])).toEqual([0, 0]);
    expect(ticketsDiscountedToZero([], [onOrder(500)])).toEqual([]);
  });

  it("rounding edge (module doc): a ticket is $0 as soon as its share rounds to its price, with cents still to pay elsewhere", () => {
    // $99.60 off a $1.00 and a $99.00 ticket: exact shares 99.6¢ and
    // $98.604; floored 99 and 9860; the one cent left goes to the larger
    // remainder (0.6), the $1.00 ticket's. It is $0 with 40¢ left on the other.
    const tickets = [ticket(GA, 100), ticket(VIP, 9900)];
    expect(allocateDiscountsToTickets(tickets, [onOrder(9960)])).toEqual([
      100, 9860,
    ]);
    expect(ticketsDiscountedToZero(tickets, [onOrder(9960)])).toEqual([
      true,
      false,
    ]);
    // One cent less and the same ticket keeps a cent (and so its fee).
    expect(allocateDiscountsToTickets(tickets, [onOrder(9900)])).toEqual([
      99, 9801,
    ]);
    expect(ticketsDiscountedToZero(tickets, [onOrder(9900)])).toEqual([
      false,
      false,
    ]);
  });

  it("order-of-entry edge (module doc): the same two stackable codes free VIP one way round and not the other", () => {
    const tickets = [ticket(GA, 3000), ticket(VIP, 5000)];
    // $10 off the order, then $45 off VIP: VIP has $43.75 left, the VIP code
    // clears it and its last $1.25 comes off the order.
    const orderFirst = [onOrder(1000), onType(VIP, 4500)];
    expect(allocateDiscountsToTickets(tickets, orderFirst)).toEqual([
      500, 5000,
    ]);
    expect(ticketsDiscountedToZero(tickets, orderFirst)).toEqual([
      false,
      true,
    ]);
    // $45 off VIP, then $10 off the order: VIP has $5.00 left, the order code
    // takes $1.43 of it. VIP is $3.57 and keeps its fee.
    const vipFirst = [onType(VIP, 4500), onOrder(1000)];
    expect(allocateDiscountsToTickets(tickets, vipFirst)).toEqual([857, 4643]);
    expect(ticketsDiscountedToZero(tickets, vipFirst)).toEqual([false, false]);
    // The buyer's discount is the same $55.00 either way.
    expect(sum(allocateDiscountsToTickets(tickets, orderFirst))).toBe(5500);
    expect(sum(allocateDiscountsToTickets(tickets, vipFirst))).toBe(5500);
  });

  it("is a pure function of the cart: the same input gives the same marks", () => {
    const tickets = [
      ticket(GA, 1234),
      ticket(VIP, 4321),
      ticket(GA, 1234),
      ticket(VIP, 1),
    ];
    const discounts = [onType(GA, 2000), onOrder(1777), onType(VIP, 1000)];
    const first = allocateDiscountsToTickets(tickets, discounts);
    expect(allocateDiscountsToTickets(tickets, discounts)).toEqual(first);
    expect(sum(first)).toBe(2000 + 1777 + 1000);
    // More discount than the cart costs stops at the cart.
    expect(
      sum(allocateDiscountsToTickets(tickets, [...discounts, onOrder(99999)])),
    ).toBe(1234 + 4321 + 1234 + 1);
    for (let i = 0; i < tickets.length; i++) {
      expect(first[i]).toBeLessThanOrEqual(tickets[i]!.unitPriceCents);
      expect(first[i]).toBeGreaterThanOrEqual(0);
    }
  });
});
