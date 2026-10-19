import { describe, expect, it, vi } from "vitest";

import { makeSeatsRepo } from "../seats";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// `releaseSeats` puts seats back on sale, and it is reached from paths whose
// seat ids are STALE by construction (the expired-cart reaper reads
// `meta.seatIds` off an order that expired 20+ minutes ago). Both predicates
// in its `where` are load-bearing, and both are invisible to a call-shape
// assertion in the use case — they only exist here:
//
//   status: "HELD"                  — never un-sell a SOLD seat.
//   updatedAt: { lte: heldBefore }  — never steal a seat somebody else is
//                                     holding right now.
//
// A stub, not a database: the point is the query this repo builds, and these
// assertions must fail the moment a predicate is dropped.
// ---------------------------------------------------------------------------

function makePrisma() {
  const updateMany = vi.fn(async () => ({ count: 0 }));
  const prisma = { seat: { updateMany } } as unknown as PrismaClientOrTx;
  return { prisma, updateMany };
}

const SEAT_IDS = ["seat-a", "seat-b"];
const HELD_BEFORE = new Date("2024-02-01T00:00:00.000Z");
const RELEASED_AT = new Date("2024-02-01T00:20:00.000Z");

describe("makeSeatsRepo.releaseSeats", () => {
  it("guards on HELD and does not fence on time when no `heldBefore` is given", async () => {
    // The in-transaction callers (`create-checkout`, `update-order-items`,
    // `claim-free-tickets`, both POS paths) hold the seats right now, so an
    // ownership fence would only decline their own release.
    const { prisma, updateMany } = makePrisma();

    await makeSeatsRepo(prisma).releaseSeats({
      seatIds: SEAT_IDS,
      releasedAt: RELEASED_AT,
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: SEAT_IDS }, status: "HELD" },
      data: { status: "AVAILABLE", updatedAt: RELEASED_AT },
    });
  });

  it("adds the `updatedAt <= heldBefore` ownership fence when given one", async () => {
    // `Seat` has no holder column, so `status: "HELD"` proves somebody holds
    // the seat, not that the caller does. Without this predicate the cart
    // reaper frees a seat a live checkout is holding, that buyer's
    // PaymentIntent stays confirmable, and two people mint a ticket on one
    // chair.
    const { prisma, updateMany } = makePrisma();

    await makeSeatsRepo(prisma).releaseSeats({
      seatIds: SEAT_IDS,
      releasedAt: RELEASED_AT,
      heldBefore: HELD_BEFORE,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: SEAT_IDS },
        status: "HELD",
        updatedAt: { lte: HELD_BEFORE },
      },
      data: { status: "AVAILABLE", updatedAt: RELEASED_AT },
    });
  });

  it("issues no statement at all for an empty seat list", async () => {
    // `updateMany({ where: { id: { in: [] } } })` is a table-wide no-op that
    // still costs a round-trip per reaped cart.
    const { prisma, updateMany } = makePrisma();

    await makeSeatsRepo(prisma).releaseSeats({
      seatIds: [],
      releasedAt: RELEASED_AT,
      heldBefore: HELD_BEFORE,
    });

    expect(updateMany).not.toHaveBeenCalled();
  });
});
