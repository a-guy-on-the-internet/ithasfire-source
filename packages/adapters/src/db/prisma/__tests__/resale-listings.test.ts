import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import type { PrismaClientOrTx } from "../types";
import { makeResaleListingsRepo } from "../resale-listings";

const EVENT_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_EVENT_ID = "40000000-0000-4000-8000-000000000002";
const ACTIVE_LISTING = "40000000-0000-4000-8000-000000000010";
const HELD_LISTING = "40000000-0000-4000-8000-000000000011";
const ACTIVE_TICKET = "40000000-0000-4000-8000-000000000020";
const HELD_TICKET = "40000000-0000-4000-8000-000000000021";
const SELLER_ID = "40000000-0000-4000-8000-000000000030";
const BUYER_ID = "40000000-0000-4000-8000-000000000031";
const BUYER_ORDER_ID = "40000000-0000-4000-8000-000000000040";

type Call = { model: string; op: string; args: unknown };

/**
 * Mock Prisma that records every call in order (so the lock-order contract
 * — tickets before listings — is asserted, not assumed) and lets each test
 * script the `findMany` answers.
 */
function makePrisma(options: {
  candidates?: Array<{ id: string; ticketId: string }>;
  cancelledAfterUpdate?: Array<{ id: string }>;
  commitListing?: unknown;
  commitUpdateCount?: number;
}) {
  const calls: Call[] = [];
  const record =
    <T>(model: string, op: string, result: T) =>
    async (args: unknown) => {
      calls.push({ model, op, args });
      return result;
    };

  let listingFindManyCall = 0;
  const p = {
    resaleListing: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ model: "resaleListing", op: "findMany", args });
        listingFindManyCall += 1;
        return listingFindManyCall === 1
          ? (options.candidates ?? [])
          : (options.cancelledAfterUpdate ?? options.candidates ?? []);
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ model: "resaleListing", op: "updateMany", args });
        return { count: options.commitUpdateCount ?? 1 };
      }),
      findUnique: record("resaleListing", "findUnique", options.commitListing),
      update: record("resaleListing", "update", undefined),
    },
    resaleListingHold: {
      deleteMany: record("resaleListingHold", "deleteMany", { count: 1 }),
    },
    ticket: {
      updateMany: record("ticket", "updateMany", { count: 1 }),
      update: record("ticket", "update", undefined),
    },
    ticketTransfer: {
      create: record("ticketTransfer", "create", undefined),
    },
    orderItem: {
      updateMany: record("orderItem", "updateMany", { count: 1 }),
    },
  };
  return { p: p as unknown as PrismaClientOrTx, calls };
}

describe("resaleListings.cancelOpenForEvent", () => {
  it("cancels ACTIVE and HELD listings of the event only, releases holds, resets LISTED tickets and clears order-item pointers", async () => {
    const { p, calls } = makePrisma({
      candidates: [
        { id: ACTIVE_LISTING, ticketId: ACTIVE_TICKET },
        { id: HELD_LISTING, ticketId: HELD_TICKET },
      ],
    });
    const repo = makeResaleListingsRepo(p);

    const result = await repo.cancelOpenForEvent(EVENT_ID);

    expect(result).toEqual({
      cancelledListingIds: [ACTIVE_LISTING, HELD_LISTING],
    });

    // Candidate select: this event, open statuses only.
    expect(calls[0]).toMatchObject({
      model: "resaleListing",
      op: "findMany",
      args: {
        where: { eventId: EVENT_ID, status: { in: ["ACTIVE", "HELD"] } },
      },
    });

    // Lock order: tickets BEFORE listings — the same order `commit` takes
    // (ticket.update, then resaleListing update), so the two can never
    // deadlock.
    const ticketIdx = calls.findIndex(
      (c) => c.model === "ticket" && c.op === "updateMany",
    );
    const listingIdx = calls.findIndex(
      (c) => c.model === "resaleListing" && c.op === "updateMany",
    );
    expect(ticketIdx).toBeGreaterThan(0);
    expect(ticketIdx).toBeLessThan(listingIdx);

    expect(calls[ticketIdx]!.args).toEqual({
      where: { id: { in: [ACTIVE_TICKET, HELD_TICKET] }, status: "LISTED" },
      data: { status: "VALID" },
    });

    // Status-conditional flip — a row that went SOLD between the select and
    // the update is left alone.
    expect(calls[listingIdx]!.args).toEqual({
      where: {
        id: { in: [ACTIVE_LISTING, HELD_LISTING] },
        eventId: EVENT_ID,
        status: { in: ["ACTIVE", "HELD"] },
      },
      data: { status: "CANCELLED" },
    });

    expect(calls).toContainEqual({
      model: "resaleListingHold",
      op: "deleteMany",
      args: { where: { listingId: { in: [ACTIVE_LISTING, HELD_LISTING] } } },
    });
    expect(calls).toContainEqual({
      model: "orderItem",
      op: "updateMany",
      args: {
        where: { resaleListingId: { in: [ACTIVE_LISTING, HELD_LISTING] } },
        data: { resaleListingId: null },
      },
    });

    // Never a write scoped by anything other than the candidate ids — so
    // another event's listings are unreachable by construction.
    for (const c of calls) {
      const where = (c.args as { where?: Record<string, unknown> })?.where;
      if (!where) continue;
      expect(JSON.stringify(where)).not.toContain(OTHER_EVENT_ID);
    }
  });

  it("is a no-op (no writes) when the event has no open listings — replay-safe", async () => {
    const { p, calls } = makePrisma({ candidates: [] });
    const repo = makeResaleListingsRepo(p);

    const result = await repo.cancelOpenForEvent(EVENT_ID);

    expect(result).toEqual({ cancelledListingIds: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "resaleListing", op: "findMany" });
  });

  it("reports only the rows it actually flipped when a candidate raced to SOLD", async () => {
    const { p, calls } = makePrisma({
      candidates: [
        { id: ACTIVE_LISTING, ticketId: ACTIVE_TICKET },
        { id: HELD_LISTING, ticketId: HELD_TICKET },
      ],
      // HELD_LISTING committed SOLD under us; the re-select finds only one.
      cancelledAfterUpdate: [{ id: ACTIVE_LISTING }],
    });
    const repo = makeResaleListingsRepo(p);

    const result = await repo.cancelOpenForEvent(EVENT_ID);

    expect(result).toEqual({ cancelledListingIds: [ACTIVE_LISTING] });
    expect(calls).toContainEqual({
      model: "resaleListingHold",
      op: "deleteMany",
      args: { where: { listingId: { in: [ACTIVE_LISTING] } } },
    });
    expect(calls).toContainEqual({
      model: "orderItem",
      op: "updateMany",
      args: {
        where: { resaleListingId: { in: [ACTIVE_LISTING] } },
        data: { resaleListingId: null },
      },
    });
  });
});

describe("resaleListings.commit — cannot commit a listing that was cancelled under it", () => {
  const heldListing = {
    id: HELD_LISTING,
    ticketId: HELD_TICKET,
    sellerHumanId: SELLER_ID,
    status: "HELD",
    hold: { buyerHumanId: BUYER_ID },
  };

  it("happy path: HELD listing with a matching hold commits via a status-conditional update", async () => {
    const { p, calls } = makePrisma({
      commitListing: heldListing,
      commitUpdateCount: 1,
    });
    const repo = makeResaleListingsRepo(p);

    const result = await repo.commit(HELD_LISTING, BUYER_ID, BUYER_ORDER_ID);

    expect(result).toEqual({ ok: true, ticketId: HELD_TICKET });
    expect(calls).toContainEqual({
      model: "resaleListing",
      op: "updateMany",
      args: {
        where: { id: HELD_LISTING, status: "HELD" },
        data: { status: "SOLD", buyerOrderId: BUYER_ORDER_ID },
      },
    });
    // Ticket lock is taken BEFORE the listing lock (see cancelOpenForEvent).
    const ticketIdx = calls.findIndex((c) => c.model === "ticket");
    const listingIdx = calls.findIndex(
      (c) => c.model === "resaleListing" && c.op === "updateMany",
    );
    expect(ticketIdx).toBeLessThan(listingIdx);
  });

  it("throws a conflict when the listing is already CANCELLED (hold gone) — never a silent ok:false the finalizer reads as a replay", async () => {
    const { p, calls } = makePrisma({
      commitListing: { ...heldListing, status: "CANCELLED", hold: null },
    });
    const repo = makeResaleListingsRepo(p);

    await expect(
      repo.commit(HELD_LISTING, BUYER_ID, BUYER_ORDER_ID),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "resale_listing_not_sellable",
      listingId: HELD_LISTING,
      buyerOrderId: BUYER_ORDER_ID,
      listingStatus: "CANCELLED",
    });
    // No ownership transfer was attempted.
    expect(calls.some((c) => c.model === "ticket")).toBe(false);
    expect(calls.some((c) => c.model === "ticketTransfer")).toBe(false);
  });

  it("throws a conflict when the conditional update flips 0 rows (cancelled while blocked on the row lock)", async () => {
    const { p } = makePrisma({
      commitListing: heldListing,
      commitUpdateCount: 0,
    });
    const repo = makeResaleListingsRepo(p);

    await expect(
      repo.commit(HELD_LISTING, BUYER_ID, BUYER_ORDER_ID),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "resale_listing_commit_mismatch",
      listingId: HELD_LISTING,
      buyerOrderId: BUYER_ORDER_ID,
    });
  });

  it("keeps ok:false for the genuine replay (SOLD, hold already deleted) and for a hold-buyer mismatch", async () => {
    const replay = makePrisma({
      commitListing: { ...heldListing, status: "SOLD", hold: null },
    });
    await expect(
      makeResaleListingsRepo(replay.p).commit(
        HELD_LISTING,
        BUYER_ID,
        BUYER_ORDER_ID,
      ),
    ).resolves.toEqual({ ok: false });

    const mismatch = makePrisma({
      commitListing: {
        ...heldListing,
        hold: { buyerHumanId: "someone-else" },
      },
    });
    await expect(
      makeResaleListingsRepo(mismatch.p).commit(
        HELD_LISTING,
        BUYER_ID,
        BUYER_ORDER_ID,
      ),
    ).resolves.toEqual({ ok: false });
  });
});

// ── assertHeldBy / releaseHold (createResaleCheckout's link + unwind) ──────

const HELD_UNTIL = new Date("2026-03-10T12:15:00.123Z");

/** Mock Prisma for the hold fence: scripted lock count, hold row, delete count. */
function makeHoldPrisma(options: {
  lockCount: number;
  hold?: { buyerHumanId: string; heldUntil: Date } | null;
  deleteCount?: number;
}) {
  const calls: Call[] = [];
  const p = {
    resaleListing: {
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ model: "resaleListing", op: "updateMany", args });
        return { count: options.lockCount };
      }),
    },
    resaleListingHold: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ model: "resaleListingHold", op: "findUnique", args });
        return options.hold ?? null;
      }),
      deleteMany: vi.fn(async (args: unknown) => {
        calls.push({ model: "resaleListingHold", op: "deleteMany", args });
        return { count: options.deleteCount ?? 0 };
      }),
    },
  };
  return { p: p as unknown as PrismaClientOrTx, calls };
}

describe("resaleListings.assertHeldBy", () => {
  it("locks the listing row with a HELD-conditional update BEFORE reading the hold, and matches buyer + heldUntil to the ms", async () => {
    const { p, calls } = makeHoldPrisma({
      lockCount: 1,
      hold: { buyerHumanId: BUYER_ID, heldUntil: new Date(HELD_UNTIL) },
    });

    await expect(
      makeResaleListingsRepo(p).assertHeldBy(HELD_LISTING, {
        buyerHumanId: BUYER_ID,
        heldUntil: HELD_UNTIL,
      }),
    ).resolves.toBe(true);

    expect(calls.map((c) => `${c.model}.${c.op}`)).toEqual([
      "resaleListing.updateMany",
      "resaleListingHold.findUnique",
    ]);
    expect(calls[0]!.args).toEqual({
      where: { id: HELD_LISTING, status: "HELD" },
      data: { status: "HELD" },
    });
  });

  it("is false (and reads no hold) when the listing is no longer HELD — e.g. cancelled with its event", async () => {
    const { p, calls } = makeHoldPrisma({ lockCount: 0 });
    await expect(
      makeResaleListingsRepo(p).assertHeldBy(HELD_LISTING, {
        buyerHumanId: BUYER_ID,
        heldUntil: HELD_UNTIL,
      }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("is false for another buyer's hold, a newer hold of the same buyer, or no hold", async () => {
    const cases = [
      { buyerHumanId: SELLER_ID, heldUntil: HELD_UNTIL },
      { buyerHumanId: BUYER_ID, heldUntil: new Date(HELD_UNTIL.getTime() + 1) },
      null,
    ];
    for (const hold of cases) {
      const { p } = makeHoldPrisma({ lockCount: 1, hold });
      await expect(
        makeResaleListingsRepo(p).assertHeldBy(HELD_LISTING, {
          buyerHumanId: BUYER_ID,
          heldUntil: HELD_UNTIL,
        }),
      ).resolves.toBe(false);
    }
  });
});

/**
 * Mock Prisma for `releaseHold` / `lockHold`: every call recorded in order,
 * so the lock order (ticket FOR UPDATE, then the listing row, then the hold)
 * and each target-status branch are asserted, not assumed.
 */
function makeReleasePrisma(options: {
  lockCount?: number;
  deleteCount?: number;
  ticketStatus?: string | null;
  originalItem?: { status: string; refundedAt: Date | null } | null;
  eventStatus?: string;
  expiresAt?: Date | null;
  hold?: { buyerHumanId: string; heldUntil: Date } | null;
}) {
  const calls: Call[] = [];
  const rec =
    (model: string, op: string, answer: (args: unknown) => unknown) =>
    vi.fn(async (args: unknown) => {
      calls.push({ model, op, args });
      return answer(args);
    });
  const p = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      calls.push({ model: "$queryRaw", op: "ticketForUpdate", args: strings.join("?") });
      return options.ticketStatus === null
        ? []
        : [
            {
              id: HELD_TICKET,
              status: options.ticketStatus ?? "LISTED",
              orderItemId: "seller-item-1",
            },
          ];
    }),
    resaleListing: {
      findUnique: rec("resaleListing", "findUnique", () => ({
        ticketId: HELD_TICKET,
        eventId: EVENT_ID,
        expiresAt: options.expiresAt ?? null,
      })),
      updateMany: rec("resaleListing", "updateMany", (args) => {
        const data = (args as { data: { status: string } }).data;
        return { count: data.status === "HELD" ? (options.lockCount ?? 1) : 1 };
      }),
    },
    resaleListingHold: {
      deleteMany: rec("resaleListingHold", "deleteMany", () => ({
        count: options.deleteCount ?? 1,
      })),
      findUnique: rec("resaleListingHold", "findUnique", () => options.hold ?? null),
    },
    orderItem: {
      findUnique: rec("orderItem", "findUnique", () =>
        options.originalItem === undefined
          ? { status: "active", refundedAt: null }
          : options.originalItem,
      ),
      updateMany: rec("orderItem", "updateMany", () => ({ count: 1 })),
    },
    event: {
      findUnique: rec("event", "findUnique", () => ({
        status: options.eventStatus ?? "PUBLISHED",
      })),
    },
    ticket: {
      updateMany: rec("ticket", "updateMany", () => ({ count: 1 })),
    },
  };
  return { p: p as unknown as PrismaClientOrTx, calls };
}

const writes = (calls: Call[]) =>
  calls
    .filter((c) => c.op === "updateMany" || c.op === "deleteMany")
    .map((c) => [`${c.model}.${c.op}`, c.args]);

const FENCE = { buyerHumanId: BUYER_ID, heldUntil: HELD_UNTIL };
const NOW_AT = new Date("2026-03-10T13:00:00.000Z");

describe("resaleListings.releaseHold", () => {
  it("locks the ticket FIRST (FOR NO KEY UPDATE), then the listing, deletes only the matching hold, then flips HELD → ACTIVE", async () => {
    const { p, calls } = makeReleasePrisma({});

    await expect(
      makeResaleListingsRepo(p).releaseHold(HELD_LISTING, FENCE, { now: NOW_AT }),
    ).resolves.toEqual({ released: true, listingStatus: "ACTIVE" });

    const order = calls.map((c) => `${c.model}.${c.op}`);
    expect(order.indexOf("$queryRaw.ticketForUpdate")).toBeLessThan(
      order.indexOf("resaleListing.updateMany"),
    );
    expect(String(calls.find((c) => c.model === "$queryRaw")!.args)).toContain(
      "FOR NO KEY UPDATE",
    );
    expect(writes(calls)).toEqual([
      [
        "resaleListing.updateMany",
        { where: { id: HELD_LISTING, status: "HELD" }, data: { status: "HELD" } },
      ],
      [
        "resaleListingHold.deleteMany",
        {
          where: {
            listingId: HELD_LISTING,
            buyerHumanId: BUYER_ID,
            heldUntil: HELD_UNTIL,
          },
        },
      ],
      [
        "resaleListing.updateMany",
        { where: { id: HELD_LISTING, status: "HELD" }, data: { status: "ACTIVE" } },
      ],
    ]);
  });

  it("leaves the listing HELD when the hold is someone else's (the fenced delete matched nothing)", async () => {
    const { p, calls } = makeReleasePrisma({ deleteCount: 0 });
    await expect(
      makeResaleListingsRepo(p).releaseHold(HELD_LISTING, FENCE),
    ).resolves.toEqual({ released: false });
    expect(writes(calls).map((w) => w[0])).toEqual([
      "resaleListing.updateMany",
      "resaleListingHold.deleteMany",
    ]);
  });

  it("does nothing to a listing that is not HELD (SOLD / CANCELLED already dropped the hold)", async () => {
    const { p, calls } = makeReleasePrisma({ lockCount: 0 });
    await expect(
      makeResaleListingsRepo(p).releaseHold(HELD_LISTING, FENCE),
    ).resolves.toEqual({ released: false });
    expect(writes(calls).map((w) => w[0])).toEqual(["resaleListing.updateMany"]);
  });

  it.each(["REFUNDED", "INVALID", "VALID"])(
    "a ticket that is %s (not LISTED) → CANCELLED, ticket untouched, pointers cleared",
    async (ticketStatus) => {
      const { p, calls } = makeReleasePrisma({ ticketStatus });
      await expect(
        makeResaleListingsRepo(p).releaseHold(HELD_LISTING, FENCE),
      ).resolves.toEqual({
        released: true,
        listingStatus: "CANCELLED",
        reason: "ticket_not_listed",
      });
      expect(writes(calls).slice(2)).toEqual([
        [
          "resaleListing.updateMany",
          { where: { id: HELD_LISTING, status: "HELD" }, data: { status: "CANCELLED" } },
        ],
        [
          "orderItem.updateMany",
          { where: { resaleListingId: HELD_LISTING }, data: { resaleListingId: null } },
        ],
      ]);
      expect(calls.some((c) => c.model === "ticket")).toBe(false);
    },
  );

  it.each([
    { status: "refunded", refundedAt: null },
    { status: "active", refundedAt: new Date("2026-03-01T00:00:00Z") },
  ])(
    "the seller's original item refunded (%o) → CANCELLED, ticket untouched",
    async (originalItem) => {
      const { p, calls } = makeReleasePrisma({ originalItem });
      await expect(
        makeResaleListingsRepo(p).releaseHold(HELD_LISTING, FENCE),
      ).resolves.toEqual({
        released: true,
        listingStatus: "CANCELLED",
        reason: "original_item_refunded",
      });
      expect(calls.some((c) => c.model === "ticket")).toBe(false);
    },
  );

  it("event CANCELLED → CANCELLED with ticket LISTED → VALID (cancelOpenForEvent for one row)", async () => {
    const { p, calls } = makeReleasePrisma({ eventStatus: "CANCELLED" });
    await expect(
      makeResaleListingsRepo(p).releaseHold(HELD_LISTING, FENCE),
    ).resolves.toEqual({
      released: true,
      listingStatus: "CANCELLED",
      reason: "event_cancelled",
    });
    expect(writes(calls).slice(2)).toEqual([
      [
        "ticket.updateMany",
        { where: { id: HELD_TICKET, status: "LISTED" }, data: { status: "VALID" } },
      ],
      [
        "resaleListing.updateMany",
        { where: { id: HELD_LISTING, status: "HELD" }, data: { status: "CANCELLED" } },
      ],
      [
        "orderItem.updateMany",
        { where: { resaleListingId: HELD_LISTING }, data: { resaleListingId: null } },
      ],
    ]);
  });

  it("expiresAt passed → EXPIRED with ticket LISTED → VALID and the seller item's pointer cleared (expireStale for one row)", async () => {
    const { p, calls } = makeReleasePrisma({
      expiresAt: new Date(NOW_AT.getTime() - 1),
    });
    await expect(
      makeResaleListingsRepo(p).releaseHold(HELD_LISTING, FENCE, { now: NOW_AT }),
    ).resolves.toEqual({
      released: true,
      listingStatus: "EXPIRED",
      reason: "listing_expired",
    });
    expect(writes(calls).slice(2)).toEqual([
      [
        "ticket.updateMany",
        { where: { id: HELD_TICKET, status: "LISTED" }, data: { status: "VALID" } },
      ],
      [
        "resaleListing.updateMany",
        { where: { id: HELD_LISTING, status: "HELD" }, data: { status: "EXPIRED" } },
      ],
      [
        "orderItem.updateMany",
        {
          where: { id: "seller-item-1", resaleListingId: HELD_LISTING },
          data: { resaleListingId: null },
        },
      ],
    ]);
  });

  it("expiresAt still ahead → ACTIVE", async () => {
    const { p } = makeReleasePrisma({ expiresAt: new Date(NOW_AT.getTime() + 1) });
    await expect(
      makeResaleListingsRepo(p).releaseHold(HELD_LISTING, FENCE, { now: NOW_AT }),
    ).resolves.toEqual({ released: true, listingStatus: "ACTIVE" });
  });
});

describe("resaleListings.lockHold", () => {
  it("locks the ticket, then the listing, then matches the hold", async () => {
    const { p, calls } = makeReleasePrisma({ hold: { ...FENCE } });
    await expect(makeResaleListingsRepo(p).lockHold(HELD_LISTING, FENCE)).resolves.toBe(
      true,
    );
    expect(calls.map((c) => `${c.model}.${c.op}`)).toEqual([
      "resaleListing.findUnique",
      "$queryRaw.ticketForUpdate",
      "resaleListing.updateMany",
      "resaleListingHold.findUnique",
    ]);
  });

  it("is false for a newer hold or a listing no longer HELD", async () => {
    const newer = makeReleasePrisma({
      hold: { buyerHumanId: BUYER_ID, heldUntil: new Date(HELD_UNTIL.getTime() + 1) },
    });
    await expect(
      makeResaleListingsRepo(newer.p).lockHold(HELD_LISTING, FENCE),
    ).resolves.toBe(false);
    const gone = makeReleasePrisma({ lockCount: 0, hold: { ...FENCE } });
    await expect(
      makeResaleListingsRepo(gone.p).lockHold(HELD_LISTING, FENCE),
    ).resolves.toBe(false);
  });
});

describe("resaleListings.hold — a CAS on ACTIVE, listing row before hold row", () => {
  function makeHoldWritePrisma(options: {
    flipCount: number;
    existingHold?: unknown;
  }) {
    const calls: Call[] = [];
    const p = {
      resaleListing: {
        updateMany: vi.fn(async (args: unknown) => {
          calls.push({ model: "resaleListing", op: "updateMany", args });
          return { count: options.flipCount };
        }),
      },
      resaleListingHold: {
        findUnique: vi.fn(async (args: unknown) => {
          calls.push({ model: "resaleListingHold", op: "findUnique", args });
          return options.existingHold ?? null;
        }),
        create: vi.fn(async (args: unknown) => {
          calls.push({ model: "resaleListingHold", op: "create", args });
          return {};
        }),
      },
    };
    return { p: p as unknown as PrismaClientOrTx, calls };
  }

  it("flips ACTIVE → HELD conditionally, THEN writes the hold row", async () => {
    const { p, calls } = makeHoldWritePrisma({ flipCount: 1 });
    await expect(
      makeResaleListingsRepo(p).hold(HELD_LISTING, BUYER_ID, HELD_UNTIL),
    ).resolves.toEqual({ ok: true });
    expect(calls.map((c) => [`${c.model}.${c.op}`, c.args])).toEqual([
      [
        "resaleListing.updateMany",
        {
          where: { id: HELD_LISTING, status: "ACTIVE" },
          data: { status: "HELD" },
        },
      ],
      ["resaleListingHold.findUnique", { where: { listingId: HELD_LISTING } }],
      [
        "resaleListingHold.create",
        {
          data: {
            listingId: HELD_LISTING,
            buyerHumanId: BUYER_ID,
            heldUntil: HELD_UNTIL,
          },
        },
      ],
    ]);
  });

  it("refuses (no hold row written) when the listing is no longer ACTIVE — never overwrites a CANCELLED back to HELD", async () => {
    const { p, calls } = makeHoldWritePrisma({ flipCount: 0 });
    await expect(
      makeResaleListingsRepo(p).hold(HELD_LISTING, BUYER_ID, HELD_UNTIL),
    ).resolves.toEqual({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it("refuses an ACTIVE listing that still carries a hold row", async () => {
    const { p, calls } = makeHoldWritePrisma({
      flipCount: 1,
      existingHold: { listingId: HELD_LISTING },
    });
    await expect(
      makeResaleListingsRepo(p).hold(HELD_LISTING, BUYER_ID, HELD_UNTIL),
    ).resolves.toEqual({ ok: false });
    expect(calls.map((c) => c.op)).not.toContain("create");
  });
});

// ── Stale-hold sweep reads (expireResaleListings) ───────────────────────────

describe("resaleListings — stale-hold sweep reads", () => {
  function makeReadPrisma(answers: {
    holds?: unknown[];
    listings?: unknown[];
    orders?: unknown[];
  }) {
    const resaleListingHold = { findMany: vi.fn(async () => answers.holds ?? []) };
    const resaleListing = { findMany: vi.fn(async () => answers.listings ?? []) };
    const order = { findMany: vi.fn(async () => answers.orders ?? []) };
    const p = { resaleListingHold, resaleListing, order } as unknown as PrismaClientOrTx;
    return { p, resaleListingHold, resaleListing, order };
  }

  it("listExpiredHolds reads holds before the cutoff on HELD listings only, oldest first, bounded", async () => {
    const heldBefore = new Date("2026-10-04T11:00:00.000Z");
    const row = { listingId: HELD_LISTING, buyerHumanId: BUYER_ID, heldUntil: new Date(0) };
    const { p, resaleListingHold } = makeReadPrisma({ holds: [row] });

    await expect(
      makeResaleListingsRepo(p).listExpiredHolds({ heldBefore, limit: 7 }),
    ).resolves.toEqual([row]);
    expect(resaleListingHold.findMany).toHaveBeenCalledWith({
      where: { heldUntil: { lt: heldBefore }, listing: { status: "HELD" } },
      orderBy: [{ heldUntil: "asc" }, { listingId: "asc" }],
      take: 7,
      select: { listingId: true, buyerHumanId: true, heldUntil: true },
    });
  });

  it("listExpiredHolds resumes strictly after a (heldUntil, listingId) cursor", async () => {
    const heldBefore = new Date("2026-10-04T11:00:00.000Z");
    const after = { heldUntil: new Date("2026-10-04T09:00:00.000Z"), listingId: "L5" };
    const { p, resaleListingHold } = makeReadPrisma({});

    await makeResaleListingsRepo(p).listExpiredHolds({ heldBefore, limit: 7, after });
    expect(resaleListingHold.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          heldUntil: { lt: heldBefore },
          listing: { status: "HELD" },
          OR: [
            { heldUntil: { gt: after.heldUntil } },
            { heldUntil: after.heldUntil, listingId: { gt: "L5" } },
          ],
        },
      }),
    );
  });

  it("listHeldWithoutHold reads HELD listings with no hold row", async () => {
    const { p, resaleListing } = makeReadPrisma({ listings: [{ id: HELD_LISTING }] });

    await expect(
      makeResaleListingsRepo(p).listHeldWithoutHold(5),
    ).resolves.toEqual([HELD_LISTING]);
    expect(resaleListing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "HELD", hold: { is: null } },
        take: 5,
      }),
    );
  });

  it("listOrdersForHold matches the buyer's orders by item column OR meta copy, every status", async () => {
    const { p, order } = makeReadPrisma({
      orders: [
        {
          id: BUYER_ORDER_ID,
          status: "CANCELLED",
          items: [{ meta: { holdExpiresAt: "2026-10-04T12:15:00.000Z" } }],
        },
        { id: "o-no-meta", status: "REFUNDED", items: [{ meta: {} }] },
      ],
    });

    await expect(
      makeResaleListingsRepo(p).listOrdersForHold(HELD_LISTING, BUYER_ID),
    ).resolves.toEqual([
      {
        id: BUYER_ORDER_ID,
        status: "CANCELLED",
        holdExpiresAt: "2026-10-04T12:15:00.000Z",
      },
      { id: "o-no-meta", status: "REFUNDED", holdExpiresAt: null },
    ]);
    const itemForListing = {
      OR: [
        { resaleListingId: HELD_LISTING },
        { meta: { path: ["resaleListingId"], equals: HELD_LISTING } },
      ],
    };
    expect(order.findMany).toHaveBeenCalledWith({
      where: { buyerHumanId: BUYER_ID, items: { some: itemForListing } },
      select: {
        id: true,
        status: true,
        items: { where: itemForListing, select: { meta: true } },
      },
    });
  });
});

// ── One row per listing, one LIVE listing per ticket ────────────────────────
//
// The partial unique index itself is proved against Postgres in
// test/integration/resale-listings-relist.test.ts. These pin the two things a
// stub can: the reads `getByTicketId` issues, that only the live index's
// P2002 becomes the domain conflict, and that `cancelHold` never reopens a
// past listing.

describe("resaleListings — a ticket with several listings", () => {
  const listingRow = (id: string, status: string) => ({
    id,
    ticketId: ACTIVE_TICKET,
    eventId: EVENT_ID,
    sellerHumanId: SELLER_ID,
    askPriceCents: 5000,
    faceValueCents: null,
    processingPassThroughCents: 0,
    processingFeeConfigRef: null,
    saleCutoffAt: null,
    payoutReleaseAt: null,
    currency: "usd",
    status,
    expiresAt: null,
    source: "internal",
    externalRef: null,
    resalePayoutTermsId: null,
    buyerOrderId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  it("getByTicketId returns the live listing and never reads further", async () => {
    const findFirst = vi.fn(async () => listingRow(ACTIVE_LISTING, "HELD"));
    const p = { resaleListing: { findFirst } } as unknown as PrismaClientOrTx;

    const found = await makeResaleListingsRepo(p).getByTicketId(ACTIVE_TICKET);

    expect(found).toMatchObject({ id: ACTIVE_LISTING, status: "HELD" });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { ticketId: ACTIVE_TICKET, status: { in: ["ACTIVE", "HELD"] } },
    });
  });

  it("getByTicketId falls back to the most recently created listing when none is live", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(listingRow(HELD_LISTING, "SOLD"));
    const p = { resaleListing: { findFirst } } as unknown as PrismaClientOrTx;

    const found = await makeResaleListingsRepo(p).getByTicketId(ACTIVE_TICKET);

    expect(found).toMatchObject({ id: HELD_LISTING, status: "SOLD" });
    expect(findFirst).toHaveBeenNthCalledWith(2, {
      where: { ticketId: ACTIVE_TICKET },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  it("getByTicketId returns null for a ticket that was never listed", async () => {
    const findFirst = vi.fn(async () => null);
    const p = { resaleListing: { findFirst } } as unknown as PrismaClientOrTx;

    await expect(
      makeResaleListingsRepo(p).getByTicketId(ACTIVE_TICKET),
    ).resolves.toBeNull();
  });

  const createInput = {
    ticketId: ACTIVE_TICKET,
    eventId: EVENT_ID,
    sellerHumanId: SELLER_ID,
    askPriceCents: 5000,
  };

  /**
   * A P2002 as `@prisma/adapter-pg` reports it (the shape is pinned against
   * Postgres in test/integration/resale-listings-relist.test.ts).
   */
  const uniqueViolation = (meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      ...(meta ? { meta } : {}),
    });
  const pgMeta = (constraintName: string, column: string) => ({
    modelName: "ResaleListing",
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23505",
        originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
        kind: "UniqueConstraintViolation",
        constraint: { fields: [`"${column}"`] },
      },
    },
  });
  const fieldsOnly = (column: string) => ({
    driverAdapterError: { cause: { constraint: { fields: [`"${column}"`] } } },
  });

  const liveIndexShapes: Array<[string, Record<string, unknown> | undefined]> = [
    ["names the live index (pg driver adapter)", pgMeta("Listing_ticketId_live_key", "ticketId")],
    ["names only the ticketId column", fieldsOnly("ticketId")],
    ["names the live index as meta.target (query engine)", { target: "Listing_ticketId_live_key" }],
    ["names ticketId as meta.target fields", { target: ["ticketId"] }],
    // Documented fallback: a driver that reports nothing keeps the mapping.
    ["carries no detail at all", undefined],
  ];
  const otherConstraintShapes: Array<[string, Record<string, unknown>]> = [
    ["the buyerOrderId unique index", pgMeta("Listing_buyerOrderId_key", "buyerOrderId")],
    ["the primary key", pgMeta("Listing_pkey", "id")],
    // The name wins over the column: a later unique that includes ticketId.
    ["another index on ticketId, by name", pgMeta("Listing_ticketId_other_key", "ticketId")],
    ["only the buyerOrderId column", fieldsOnly("buyerOrderId")],
    ["a composite that includes ticketId", { target: ["ticketId", "eventId"] }],
    ["another index as meta.target", { target: "Listing_buyerOrderId_key" }],
  ];

  for (const method of ["create", "createExternal"] as const) {
    for (const [label, meta] of liveIndexShapes) {
      it(`${method} maps a P2002 that ${label} to resale_listing_live_exists`, async () => {
        const p2002 = uniqueViolation(meta);
        const p = {
          resaleListing: { create: vi.fn(async () => Promise.reject(p2002)) },
        } as unknown as PrismaClientOrTx;

        await expect(
          makeResaleListingsRepo(p)[method]({
            ...createInput,
            externalRef: { platform: "x" },
          } as never),
        ).rejects.toMatchObject({
          code: "conflict",
          message: "resale_listing_live_exists",
          ticketId: ACTIVE_TICKET,
          cause: p2002,
        });
      });
    }

    for (const [label, meta] of otherConstraintShapes) {
      it(`${method} does NOT relabel a P2002 on ${label}`, async () => {
        const p2002 = uniqueViolation(meta);
        const p = {
          resaleListing: { create: vi.fn(async () => Promise.reject(p2002)) },
        } as unknown as PrismaClientOrTx;

        await expect(
          makeResaleListingsRepo(p)[method]({
            ...createInput,
            externalRef: { platform: "x" },
          } as never),
        ).rejects.toBe(p2002);
      });
    }

    it(`${method} turns a unique violation into the resale_listing_live_exists conflict`, async () => {
      const p2002 = uniqueViolation(pgMeta("Listing_ticketId_live_key", "ticketId"));
      const p = {
        resaleListing: { create: vi.fn(async () => Promise.reject(p2002)) },
      } as unknown as PrismaClientOrTx;

      await expect(
        makeResaleListingsRepo(p)[method]({
          ...createInput,
          externalRef: { platform: "x" },
        } as never),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "resale_listing_live_exists",
        ticketId: ACTIVE_TICKET,
        cause: p2002,
      });
    });

    it(`${method} lets every other failure through untouched`, async () => {
      const other = new Prisma.PrismaClientKnownRequestError("fk", {
        code: "P2003",
        clientVersion: "test",
      });
      const p = {
        resaleListing: { create: vi.fn(async () => Promise.reject(other)) },
      } as unknown as PrismaClientOrTx;

      await expect(
        makeResaleListingsRepo(p)[method]({
          ...createInput,
          externalRef: { platform: "x" },
        } as never),
      ).rejects.toBe(other);
    });
  }

  // `cancelHold` and `unwindSale(…, "ACTIVE")` are the only writes from a
  // past status back to a live one. A ticket now keeps its past listings, so
  // an unconditional reopen could put a second live row beside a newer one.
  describe("cancelHold — HELD → ACTIVE only", () => {
    function makeCancelHoldPrisma(flipped: number) {
      const calls: Call[] = [];
      const p = {
        resaleListing: {
          updateMany: vi.fn(async (args: unknown) => {
            calls.push({ model: "resaleListing", op: "updateMany", args });
            return { count: flipped };
          }),
          update: vi.fn(async (args: unknown) => {
            calls.push({ model: "resaleListing", op: "update", args });
          }),
        },
        resaleListingHold: {
          deleteMany: vi.fn(async (args: unknown) => {
            calls.push({ model: "resaleListingHold", op: "deleteMany", args });
            return { count: 1 };
          }),
        },
      };
      return { p: p as unknown as PrismaClientOrTx, calls };
    }

    it("reopens a HELD listing with a status-conditional update, listing row before hold row", async () => {
      const { p, calls } = makeCancelHoldPrisma(1);

      await expect(
        makeResaleListingsRepo(p).cancelHold(HELD_LISTING),
      ).resolves.toBeUndefined();

      expect(calls).toEqual([
        {
          model: "resaleListing",
          op: "updateMany",
          args: {
            where: { id: HELD_LISTING, status: "HELD" },
            data: { status: "ACTIVE" },
          },
        },
        {
          model: "resaleListingHold",
          op: "deleteMany",
          args: { where: { listingId: HELD_LISTING } },
        },
      ]);
    });

    it("throws a conflict and writes nothing more when the listing is not HELD (SOLD / CANCELLED / EXPIRED / missing)", async () => {
      const { p, calls } = makeCancelHoldPrisma(0);

      await expect(
        makeResaleListingsRepo(p).cancelHold(HELD_LISTING),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "resale_listing_cancel_hold_mismatch",
        listingId: HELD_LISTING,
      });

      // Only the refused compare-and-swap ran: never an unconditional
      // `update`, and the hold row is left alone.
      expect(calls.map((c) => `${c.model}.${c.op}`)).toEqual([
        "resaleListing.updateMany",
      ]);
    });
  });
});
