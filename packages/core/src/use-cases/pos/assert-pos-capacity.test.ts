import { describe, expect, it, vi } from "vitest";

import type {
  CapacityBearingTicketType,
  CapacityCountingRepos,
} from "./assert-pos-capacity";
import {
  assertPosCapacity,
  heldSinceFor,
  POS_HELD_WINDOW_SECONDS,
} from "./assert-pos-capacity";
import {
  CART_REAPER_PERIOD_SECONDS,
  DEFAULT_CART_TTL_SECONDS,
} from "../orders/release-expired-carts";

const NOW = new Date("2026-07-27T20:00:00Z");
const TT_GA = "00000000-0000-4000-8000-0000000000a1";
const TT_STUDENT = "00000000-0000-4000-8000-0000000000a2";

function ticketType(capacity: number): CapacityBearingTicketType {
  return { capacity };
}

function makeTx(counts: Record<string, { issued: number; held: number }>) {
  const seen: string[] = [];
  const heldSinceSeen: Date[] = [];
  const tx = {
    tickets: {
      lockAndCountCapacityForTicketType: vi.fn(
        async ({
          ticketTypeId,
          heldSince,
        }: {
          ticketTypeId: string;
          heldSince: Date;
        }) => {
          seen.push(ticketTypeId);
          heldSinceSeen.push(heldSince);
          return counts[ticketTypeId] ?? { issued: 0, held: 0 };
        },
      ),
    },
  } satisfies CapacityCountingRepos;
  return { tx, seen, heldSinceSeen };
}

describe("assertPosCapacity", () => {
  it("allows a sale that fits", async () => {
    const { tx } = makeTx({ [TT_GA]: { issued: 8, held: 0 } });

    await expect(
      assertPosCapacity(tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 2 }],
        ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
        now: NOW,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a sale that would oversell on issued tickets alone", async () => {
    const { tx } = makeTx({ [TT_GA]: { issued: 9, held: 0 } });

    await expect(
      assertPosCapacity(tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 2 }],
        ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });
  });

  it("counts another sale's live hold against capacity", async () => {
    // 9 issued + 1 held = the house is full even though only 9 tickets exist.
    // This is the case that used to charge a card and mint nothing.
    const { tx } = makeTx({ [TT_GA]: { issued: 9, held: 1 } });

    await expect(
      assertPosCapacity(tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 1 }],
        ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_TEMPORARILY_HELD" });
  });

  it("distinguishes a transient hold from a genuinely sold-out type", async () => {
    // Same refusal, different truth: one is worth waiting out, the other
    // never will be. A door manager told "sold out" for a half-empty room is
    // how you get someone overriding the system by hand.
    const held = makeTx({ [TT_GA]: { issued: 0, held: 10 } });
    await expect(
      assertPosCapacity(held.tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 1 }],
        ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_TEMPORARILY_HELD" });

    const soldOut = makeTx({ [TT_GA]: { issued: 10, held: 0 } });
    await expect(
      assertPosCapacity(soldOut.tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 1 }],
        ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });
  });

  it("sums duplicate lines for the same ticket type before judging", async () => {
    // Two lines of 1 must be judged as 2 — otherwise a split cart walks past
    // a capacity of 1 twice.
    const { tx, seen } = makeTx({ [TT_GA]: { issued: 0, held: 0 } });

    await expect(
      assertPosCapacity(tx, {
        requests: [
          { ticketTypeId: TT_GA, qty: 1 },
          { ticketTypeId: TT_GA, qty: 1 },
        ],
        ticketTypesById: new Map([[TT_GA, ticketType(1)]]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });

    // ...and the row is locked once, not once per line.
    expect(seen).toEqual([TT_GA]);
  });

  it("locks ticket types in a deterministic order", async () => {
    // Two operators ringing up the same pair in opposite order must not be
    // able to deadlock each other.
    const counts = {
      [TT_GA]: { issued: 0, held: 0 },
      [TT_STUDENT]: { issued: 0, held: 0 },
    };
    const types = new Map([
      [TT_GA, ticketType(50)],
      [TT_STUDENT, ticketType(50)],
    ]);

    const a = makeTx(counts);
    await assertPosCapacity(a.tx, {
      requests: [
        { ticketTypeId: TT_STUDENT, qty: 1 },
        { ticketTypeId: TT_GA, qty: 1 },
      ],
      ticketTypesById: types,
      now: NOW,
    });

    const b = makeTx(counts);
    await assertPosCapacity(b.tx, {
      requests: [
        { ticketTypeId: TT_GA, qty: 1 },
        { ticketTypeId: TT_STUDENT, qty: 1 },
      ],
      ticketTypesById: types,
      now: NOW,
    });

    expect(a.seen).toEqual(b.seen);
    expect(a.seen).toEqual([...a.seen].sort());
  });

  it("rejects an unknown ticket type before locking anything", async () => {
    const { tx, seen } = makeTx({});

    await expect(
      assertPosCapacity(tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 1 }],
        ticketTypesById: new Map(),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_NOT_FOUND" });

    expect(seen).toEqual([]);
  });

  it("treats a zero-capacity type as sold out", async () => {
    const { tx } = makeTx({ [TT_GA]: { issued: 0, held: 0 } });

    await expect(
      assertPosCapacity(tx, {
        requests: [{ ticketTypeId: TT_GA, qty: 1 }],
        ticketTypesById: new Map([[TT_GA, ticketType(0)]]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });
  });
});

describe("reservation window", () => {
  it("covers the reaper's TTL plus two of its REAL cron periods", () => {
    // The window is not a hold duration anyone picked — it is how long a
    // PaymentIntent can still be confirmed. `releaseExpiredCarts` cancels the
    // order AND the PI, but it is a cron: an order becomes ELIGIBLE at the
    // TTL and is only REAPED on a later pass. Sizing the window to the TTL
    // alone leaves a full cron period where a reservation has lapsed but the
    // charge it protected can still land.
    //
    // Read from the constants, never restated here: until 2026-09-30 this
    // test hard-coded a 5-minute period while prod ran the reaper every 15,
    // so it stayed green over a window 5+ minutes too short. The period is
    // drift-guarded against the manifest by validate-manifest (§8).
    expect(POS_HELD_WINDOW_SECONDS).toBeGreaterThanOrEqual(
      DEFAULT_CART_TTL_SECONDS + 2 * CART_REAPER_PERIOD_SECONDS,
    );
    // Pinned so a change to either input is a deliberate, reviewed number:
    // 20 min TTL + 2 × 30 min reaper period = 80 min.
    expect(POS_HELD_WINDOW_SECONDS).toBe(4800);
  });

  it("asks the repo for orders no older than that window", async () => {
    // Reservation is derived from the order's own age. No second expiry stamp
    // exists to drift against the reaper.
    const { tx, heldSinceSeen } = makeTx({ [TT_GA]: { issued: 0, held: 0 } });

    await assertPosCapacity(tx, {
      requests: [{ ticketTypeId: TT_GA, qty: 1 }],
      ticketTypesById: new Map([[TT_GA, ticketType(10)]]),
      now: NOW,
    });

    expect(heldSinceSeen).toEqual([heldSinceFor(NOW)]);
    expect(NOW.getTime() - heldSinceSeen[0]!.getTime()).toBe(
      POS_HELD_WINDOW_SECONDS * 1000,
    );
  });
});
