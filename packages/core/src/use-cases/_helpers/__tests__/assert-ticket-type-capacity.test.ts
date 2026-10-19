import { describe, expect, it, vi } from "vitest";

import type {
  CapacityBearingTicketType,
  CapacityCountingRepos,
} from "../assert-ticket-type-capacity";
import { assertTicketTypeCapacity } from "../assert-ticket-type-capacity";

const NOW = new Date("2026-08-12T20:00:00Z");
const TT_GA = "00000000-0000-4000-8000-0000000000a1";
const CART_ORDER_ID = "00000000-0000-4000-8000-0000000000b1";

function ticketType(capacity: number): CapacityBearingTicketType {
  return { capacity };
}

function makeTx(counts: Record<string, { issued: number; held: number }>) {
  const calls: { ticketTypeId: string; excludeOrderId?: string | null }[] = [];
  const tx = {
    tickets: {
      lockAndCountCapacityForTicketType: vi.fn(
        async (input: {
          ticketTypeId: string;
          heldSince: Date;
          excludeOrderId?: string | null;
        }) => {
          calls.push({
            ticketTypeId: input.ticketTypeId,
            excludeOrderId: input.excludeOrderId,
          });
          return counts[input.ticketTypeId] ?? { issued: 0, held: 0 };
        },
      ),
    },
  } satisfies CapacityCountingRepos;
  return { tx, calls };
}

describe("assertTicketTypeCapacity — boundary", () => {
  // The two cases that decide whether the last ticket is sellable. An
  // off-by-one here is a charge with no ticket in one direction and a
  // needlessly refused sale in the other.
  it("permits issued + requested === capacity", async () => {
    const { tx } = makeTx({ [TT_GA]: { issued: 8, held: 0 } });

    await expect(
      assertTicketTypeCapacity(tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 2 }],
        ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
        now: NOW,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses issued + requested === capacity + 1", async () => {
    const { tx } = makeTx({ [TT_GA]: { issued: 9, held: 0 } });

    await expect(
      assertTicketTypeCapacity(tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 2 }],
        ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });
  });

  it("counts holds in the same basis: issued + held + requested > capacity refuses", async () => {
    // The reason the basis is issued+held and not issued alone: two buyers
    // mid-checkout would otherwise both pass for the same last ticket, and
    // the loser only finds out post-charge in the mint webhook.
    const { tx } = makeTx({ [TT_GA]: { issued: 8, held: 1 } });

    await expect(
      assertTicketTypeCapacity(tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 2 }],
        ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_TEMPORARILY_HELD" });
  });
});

describe("assertTicketTypeCapacity — excludeOrderId", () => {
  it("forwards the exclusion to every ticket type it locks", async () => {
    const { tx, calls } = makeTx({ [TT_GA]: { issued: 0, held: 0 } });

    await assertTicketTypeCapacity(tx, {
      requests: [{ ticketTypeId: TT_GA, qty: 1 }],
      ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
      now: NOW,
      excludeOrderId: CART_ORDER_ID,
    });

    expect(calls).toEqual([
      { ticketTypeId: TT_GA, excludeOrderId: CART_ORDER_ID },
    ]);
  });

  it("passes null — never undefined — when there is no cart to exclude", async () => {
    // The adapter's predicate keys off SQL NULL. Leaving this `undefined`
    // would make the parameter's type depend on the call site.
    const { tx, calls } = makeTx({ [TT_GA]: { issued: 0, held: 0 } });

    await assertTicketTypeCapacity(tx, {
      requests: [{ ticketTypeId: TT_GA, qty: 1 }],
      ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
      now: NOW,
    });

    expect(calls).toEqual([{ ticketTypeId: TT_GA, excludeOrderId: null }]);
  });

  it("still refuses on issued even when a cart is excluded", async () => {
    // Exclusion only ever discounts `held`. A minted ticket holds its place
    // no matter which order produced it (only a refund or revocation gives
    // it back), so a buyer cannot grow their own cart past capacity by
    // re-pricing it.
    const { tx } = makeTx({ [TT_GA]: { issued: 10, held: 0 } });

    await expect(
      assertTicketTypeCapacity(tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 1 }],
        ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
        now: NOW,
        excludeOrderId: CART_ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });
  });
});
