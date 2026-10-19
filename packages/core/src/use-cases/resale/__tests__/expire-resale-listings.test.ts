import { describe, it, expect, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import {
  expireResaleListings,
  STALE_HOLD_SWEEP_CURSOR_KEY,
  STALE_RESALE_HOLD_GRACE_SECONDS,
  type ExpireResaleListingsDeps,
} from "../expire-resale-listings";

// ── Constants ──────────────────────────────────────────────────────────────

const NOW = new Date("2026-03-10T12:00:00Z");
const GRACE_MS = STALE_RESALE_HOLD_GRACE_SECONDS * 1000;
/** Past the grace: the sweep's to look at. */
const STALE_HELD_UNTIL = new Date(NOW.getTime() - GRACE_MS - 60_000);
/** Expired, but still inside the grace. */
const RECENT_HELD_UNTIL = new Date(NOW.getTime() - GRACE_MS + 60_000);

type OrderStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "PART_REFUNDED"
  | "REFUNDED"
  | "DISPUTED"
  | "CANCELLED";

type FakeListing = {
  status: "ACTIVE" | "HELD" | "SOLD" | "CANCELLED" | "EXPIRED";
  hold: { buyerHumanId: string; heldUntil: Date } | null;
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * A stateful fake of the four resale-listing calls the sweep makes, with the
 * adapter's semantics: `listExpiredHolds` filters on HELD + heldUntil,
 * `lockHold` / `releaseHold` are fenced on buyer + heldUntil.
 */
function makeDeps(
  opts: {
    expiredCount?: number;
    listings?: Record<string, FakeListing>;
    orders?: Array<{
      id: string;
      listingId: string;
      buyerHumanId: string;
      status: OrderStatus;
      /** Defaults to the listing's current hold's `heldUntil` (this hold). */
      holdExpiresAt?: string | null;
    }>;
    /** Where `releaseHold` sends a released listing (default ACTIVE). */
    releaseTo?:
      | { listingStatus: "ACTIVE" }
      | { listingStatus: "CANCELLED"; reason: "ticket_not_listed" }
      | { listingStatus: "EXPIRED"; reason: "listing_expired" };
    cursor?: unknown;
  } = {},
) {
  const listings = opts.listings ?? {};
  const orders = opts.orders ?? [];
  const calls: string[] = [];
  let storedCursor: unknown = opts.cursor ?? null;
  const jobCursors = {
    get: vi.fn(async (_key: string) => storedCursor),
    set: vi.fn(async (_key: string, value: unknown) => {
      storedCursor = value;
    }),
  };

  const matches = (
    listing: FakeListing | undefined,
    fence: { buyerHumanId: string; heldUntil: Date },
  ) =>
    listing?.status === "HELD" &&
    listing.hold != null &&
    listing.hold.buyerHumanId === fence.buyerHumanId &&
    listing.hold.heldUntil.getTime() === fence.heldUntil.getTime();

  const resaleListings = {
    expireStale: vi.fn(async () => {
      calls.push("expireStale");
      return { expiredCount: opts.expiredCount ?? 0 };
    }),
    // The adapter's keyset: (heldUntil, listingId) ascending, strictly
    // after `after`, at most `limit`.
    listExpiredHolds: vi.fn(
      async ({
        heldBefore,
        limit,
        after,
      }: {
        heldBefore: Date;
        limit: number;
        after?: { heldUntil: Date; listingId: string } | null;
      }) =>
        Object.entries(listings)
          .filter(
            ([, l]) =>
              l.status === "HELD" &&
              l.hold != null &&
              l.hold.heldUntil.getTime() < heldBefore.getTime(),
          )
          .map(([listingId, l]) => ({ listingId, ...l.hold! }))
          .sort(
            (a, b) =>
              a.heldUntil.getTime() - b.heldUntil.getTime() ||
              a.listingId.localeCompare(b.listingId),
          )
          .filter(
            (h) =>
              !after ||
              h.heldUntil.getTime() > after.heldUntil.getTime() ||
              (h.heldUntil.getTime() === after.heldUntil.getTime() &&
                h.listingId > after.listingId),
          )
          .slice(0, limit),
    ),
    listHeldWithoutHold: vi.fn(async () =>
      Object.entries(listings)
        .filter(([, l]) => l.status === "HELD" && l.hold == null)
        .map(([id]) => id),
    ),
    lockHold: vi.fn(
      async (
        listingId: string,
        fence: { buyerHumanId: string; heldUntil: Date },
      ) => {
        calls.push(`lockHold:${listingId}`);
        return matches(listings[listingId], fence);
      },
    ),
    listOrdersForHold: vi.fn(async (listingId: string, buyerHumanId: string) => {
      calls.push(`listOrdersForHold:${listingId}`);
      return orders
        .filter(
          (o) => o.listingId === listingId && o.buyerHumanId === buyerHumanId,
        )
        .map(({ id, status, holdExpiresAt }) => ({
          id,
          status,
          holdExpiresAt:
            holdExpiresAt === undefined
              ? (listings[listingId]?.hold?.heldUntil.toISOString() ?? null)
              : holdExpiresAt,
        }));
    }),
    releaseHold: vi.fn(
      async (
        listingId: string,
        fence: { buyerHumanId: string; heldUntil: Date },
      ) => {
        calls.push(`releaseHold:${listingId}`);
        const listing = listings[listingId];
        if (!matches(listing, fence)) return { released: false as const };
        const to = opts.releaseTo ?? { listingStatus: "ACTIVE" as const };
        listing!.hold = null;
        listing!.status = to.listingStatus;
        return { released: true as const, ...to };
      },
    ),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ resaleListings, audit }),
  );

  const repos = { resaleListings, tx, jobCursors } as unknown as Repos;
  const clock: ClockPort = { now: () => NOW };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(),
  };
  const reportError = vi.fn();

  return {
    deps: {
      repos,
      clock,
      logger: logger as unknown as LoggerPort,
      reportError,
    } satisfies ExpireResaleListingsDeps,
    mocks: { ...resaleListings, logger, reportError, audit, tx, jobCursors },
    listings,
    calls,
    get storedCursor() {
      return storedCursor;
    },
  };
}

function heldBy(buyerHumanId: string, heldUntil: Date): FakeListing {
  return { status: "HELD", hold: { buyerHumanId, heldUntil } };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("expireResaleListings — expiry", () => {
  it("calls expireStale with the current time and returns the count", async () => {
    const { deps, mocks } = makeDeps({ expiredCount: 5 });

    const result = await expireResaleListings(deps);

    expect(result.expiredCount).toBe(5);
    expect(mocks.expireStale).toHaveBeenCalledWith(NOW);
  });

  it("logs when listings are expired", async () => {
    const { deps, mocks } = makeDeps({ expiredCount: 3 });

    await expireResaleListings(deps);

    expect(mocks.logger.info).toHaveBeenCalledWith(
      "expireResaleListings.completed",
      { expiredCount: 3 },
    );
  });

  it("does not log when nothing was expired or swept", async () => {
    const { deps, mocks } = makeDeps();

    const result = await expireResaleListings(deps);

    expect(mocks.logger.info).not.toHaveBeenCalled();
    expect(result).toEqual({
      expiredCount: 0,
      releasedHoldCount: 0,
      closedOnReleaseCount: 0,
      keptLiveHoldCount: 0,
      keptPaidHoldCount: 0,
      failedHoldCount: 0,
      heldWithoutHoldCount: 0,
    });
  });
});

describe("expireResaleListings — stale-hold sweep (G1 backstop)", () => {
  it("the grace covers the checkout claim, the cart TTL and two reaper cycles", () => {
    // 900 s claim < 1200 s cart TTL + 1800 s reaper cycle = 3000 s < grace.
    expect(STALE_RESALE_HOLD_GRACE_SECONDS).toBe(5400);
  });

  it("releases an expired hold whose only order is CANCELLED, audits it, then expires in the same pass", async () => {
    const { deps, mocks, listings, calls } = makeDeps({
      listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
      orders: [
        { id: "o1", listingId: "L1", buyerHumanId: "buyer-1", status: "CANCELLED" },
      ],
    });

    const result = await expireResaleListings(deps);

    expect(result.releasedHoldCount).toBe(1);
    expect(listings.L1).toEqual({ status: "ACTIVE", hold: null });
    // Lock + fence check first, orders read under it, release last; the
    // expiry runs after the sweep so a released past-expiry listing expires.
    expect(calls).toEqual([
      "lockHold:L1",
      "listOrdersForHold:L1",
      "releaseHold:L1",
      "expireStale",
    ]);
    expect(mocks.listExpiredHolds).toHaveBeenCalledWith({
      heldBefore: new Date(NOW.getTime() - GRACE_MS),
      limit: 200,
      after: null,
    });
    expect(mocks.releaseHold).toHaveBeenCalledWith(
      "L1",
      { buyerHumanId: "buyer-1", heldUntil: STALE_HELD_UNTIL },
      { now: NOW },
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "resale_listing",
        entityId: "L1",
        action: "resale_listing_stale_hold_released",
        data: expect.objectContaining({
          cancelledOrderIds: ["o1"],
          listingStatus: "ACTIVE",
        }),
      }),
    );
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "expireResaleListings.stale_holds_swept",
      expect.objectContaining({ scanned: 1, releasedHoldCount: 1 }),
    );
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("releases an expired hold with no order of that buyer for the listing", async () => {
    const { deps, listings } = makeDeps({
      listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
    });

    await expireResaleListings(deps);

    expect(listings.L1!.status).toBe("ACTIVE");
  });

  it.each(["PENDING", "PROCESSING"] as const)(
    "keeps an expired hold whose order is %s (the reaper's), unreported",
    async (status) => {
      const { deps, mocks, listings } = makeDeps({
        listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
        orders: [
          { id: "old", listingId: "L1", buyerHumanId: "buyer-1", status: "CANCELLED" },
          { id: "o1", listingId: "L1", buyerHumanId: "buyer-1", status },
        ],
      });

      const result = await expireResaleListings(deps);

      expect(result.keptLiveHoldCount).toBe(1);
      expect(result.releasedHoldCount).toBe(0);
      expect(listings.L1!.status).toBe("HELD");
      expect(mocks.releaseHold).not.toHaveBeenCalled();
      expect(mocks.audit.log).not.toHaveBeenCalled();
      expect(mocks.reportError).not.toHaveBeenCalled();
    },
  );

  it.each(["SUCCEEDED", "PART_REFUNDED", "REFUNDED", "DISPUTED"] as const)(
    "keeps an expired hold whose order is %s and reports it",
    async (status) => {
      const { deps, mocks, listings } = makeDeps({
        listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
        orders: [
          { id: "o1", listingId: "L1", buyerHumanId: "buyer-1", status },
        ],
      });

      const result = await expireResaleListings(deps);

      expect(result.keptPaidHoldCount).toBe(1);
      expect(listings.L1!.status).toBe("HELD");
      expect(mocks.releaseHold).not.toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalledWith(
        "expireResaleListings.stale_hold_paid_order",
        expect.objectContaining({ listingId: "L1" }),
      );
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "resale_stale_hold_has_paid_order" }),
        expect.objectContaining({
          extra: expect.objectContaining({ listingId: "L1" }),
        }),
      );
    },
  );

  it("leaves an expired hold inside its grace alone", async () => {
    const { deps, mocks, listings } = makeDeps({
      listings: { L1: heldBy("buyer-1", RECENT_HELD_UNTIL) },
      orders: [
        { id: "o1", listingId: "L1", buyerHumanId: "buyer-1", status: "CANCELLED" },
      ],
    });

    const result = await expireResaleListings(deps);

    expect(result.releasedHoldCount).toBe(0);
    expect(listings.L1!.status).toBe("HELD");
    expect(mocks.lockHold).not.toHaveBeenCalled();
  });

  it("does nothing when the hold changed between the scan and the lock", async () => {
    const { deps, mocks, listings } = makeDeps({
      listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
    });
    // Another buyer's hold replaced it after the scan read it.
    mocks.lockHold.mockImplementationOnce(async () => {
      listings.L1 = heldBy("buyer-2", new Date(NOW.getTime() + 60_000));
      return false;
    });

    const result = await expireResaleListings(deps);

    expect(result.releasedHoldCount).toBe(0);
    expect(mocks.listOrdersForHold).not.toHaveBeenCalled();
    expect(mocks.releaseHold).not.toHaveBeenCalled();
    expect(listings.L1!.hold!.buyerHumanId).toBe("buyer-2");
  });

  it("a failing listing is logged, reported and counted; the rest of the pass goes on", async () => {
    const { deps, mocks, listings } = makeDeps({
      listings: {
        L1: heldBy("buyer-1", STALE_HELD_UNTIL),
        L2: heldBy("buyer-2", STALE_HELD_UNTIL),
      },
    });
    mocks.lockHold.mockImplementationOnce(async () => {
      throw new Error("lock_timeout");
    });

    const result = await expireResaleListings(deps);

    expect(result.failedHoldCount).toBe(1);
    expect(result.releasedHoldCount).toBe(1);
    expect(listings.L2!.status).toBe("ACTIVE");
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "expireResaleListings.stale_hold_release_failed",
      expect.objectContaining({ listingId: "L1" }),
    );
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "lock_timeout" }),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "sweepStaleHolds" }),
      }),
    );
    // Expiry still ran.
    expect(mocks.expireStale).toHaveBeenCalled();
  });

  it("a throwing reporter does not change the pass", async () => {
    const { deps, mocks } = makeDeps({
      listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
    });
    mocks.lockHold.mockImplementationOnce(async () => {
      throw new Error("lock_timeout");
    });
    mocks.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(expireResaleListings(deps)).resolves.toMatchObject({
      failedHoldCount: 1,
    });
  });

  it("reports HELD listings that have no hold row", async () => {
    const { deps, mocks } = makeDeps({
      listings: { L9: { status: "HELD", hold: null } },
    });

    const result = await expireResaleListings(deps);

    expect(result.heldWithoutHoldCount).toBe(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "resale_listing_held_without_hold" }),
      expect.objectContaining({ extra: { listingIds: ["L9"] } }),
    );
  });

  // ── Fix round: only the orders that took THIS hold count ────────────────

  it("an earlier REFUNDED purchase by the same buyer (a different hold) does not keep the hold", async () => {
    const { deps, listings } = makeDeps({
      listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
      orders: [
        {
          id: "old-sale",
          listingId: "L1",
          buyerHumanId: "buyer-1",
          status: "REFUNDED",
          holdExpiresAt: "2026-01-01T00:00:00.000Z",
        },
        { id: "this-hold", listingId: "L1", buyerHumanId: "buyer-1", status: "CANCELLED" },
      ],
    });

    const result = await expireResaleListings(deps);

    expect(result.releasedHoldCount).toBe(1);
    expect(result.keptPaidHoldCount).toBe(0);
    expect(listings.L1!.status).toBe("ACTIVE");
  });

  it.each([null, "not-a-date"])(
    "an order whose holdExpiresAt is %s cannot be ruled out: it keeps the hold",
    async (holdExpiresAt) => {
      const { deps, listings } = makeDeps({
        listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
        orders: [
          {
            id: "unknown",
            listingId: "L1",
            buyerHumanId: "buyer-1",
            status: "PENDING",
            holdExpiresAt,
          },
        ],
      });

      const result = await expireResaleListings(deps);

      expect(result.keptLiveHoldCount).toBe(1);
      expect(listings.L1!.status).toBe("HELD");
    },
  );

  // ── Fix round: a release can close the listing instead ───────────────────

  it.each([
    { listingStatus: "CANCELLED" as const, reason: "ticket_not_listed" as const },
    { listingStatus: "EXPIRED" as const, reason: "listing_expired" as const },
  ])(
    "a release that closes the listing ($listingStatus) is counted and audited with its reason",
    async (releaseTo) => {
      const { deps, mocks, listings } = makeDeps({
        listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
        releaseTo,
      });

      const result = await expireResaleListings(deps);

      expect(result.releasedHoldCount).toBe(1);
      expect(result.closedOnReleaseCount).toBe(1);
      expect(listings.L1!.status).toBe(releaseTo.listingStatus);
      expect(mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            listingStatus: releaseTo.listingStatus,
            closeReason: releaseTo.reason,
          }),
        }),
      );
    },
  );

  // ── Fix round: a durable cursor, so kept holds cannot starve newer ones ──

  function manyKeptHolds(count: number) {
    const listings: Record<string, FakeListing> = {};
    const orders: Array<{
      id: string;
      listingId: string;
      buyerHumanId: string;
      status: OrderStatus;
    }> = [];
    for (let i = 0; i < count; i++) {
      const id = `K${String(i).padStart(4, "0")}`;
      listings[id] = heldBy("buyer-k", new Date(STALE_HELD_UNTIL.getTime() - (count - i) * 1000));
      orders.push({ id: `o-${id}`, listingId: id, buyerHumanId: "buyer-k", status: "PENDING" });
    }
    return { listings, orders };
  }

  it("a full page of kept holds stores a cursor, and the next pass reaches the newer hold behind them", async () => {
    const kept = manyKeptHolds(200);
    const ctx = makeDeps({
      listings: { ...kept.listings, NEW: heldBy("buyer-1", STALE_HELD_UNTIL) },
      orders: kept.orders,
    });

    const first = await expireResaleListings(ctx.deps);
    expect(first.keptLiveHoldCount).toBe(200);
    expect(first.releasedHoldCount).toBe(0);
    expect(ctx.listings.NEW!.status).toBe("HELD");
    expect(ctx.mocks.jobCursors.set).toHaveBeenLastCalledWith(
      STALE_HOLD_SWEEP_CURSOR_KEY,
      { heldUntil: ctx.listings.K0199!.hold!.heldUntil.toISOString(), listingId: "K0199" },
    );

    const second = await expireResaleListings(ctx.deps);
    expect(second.releasedHoldCount).toBe(1);
    expect(ctx.listings.NEW!.status).toBe("ACTIVE");
    // A short page: the cursor wraps to the start for the next pass.
    expect(ctx.storedCursor).toBeNull();
    expect(ctx.mocks.logger.info).toHaveBeenCalledWith(
      "expireResaleListings.stale_holds_swept",
      expect.objectContaining({ resumedFromCursor: true }),
    );
  });

  it.each([
    ["a non-object", "garbage"],
    ["a bad date", { heldUntil: "nope", listingId: "L1" }],
    ["no listing id", { heldUntil: STALE_HELD_UNTIL.toISOString() }],
  ])("an unreadable stored cursor (%s) restarts the scan", async (_label, cursor) => {
    const { deps, mocks } = makeDeps({
      listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
      cursor,
    });

    await expireResaleListings(deps);

    expect(mocks.listExpiredHolds).toHaveBeenCalledWith(
      expect.objectContaining({ after: null }),
    );
  });

  it("a cursor read or write that fails is logged and reported; the sweep still runs", async () => {
    const { deps, mocks, listings } = makeDeps({
      listings: { L1: heldBy("buyer-1", STALE_HELD_UNTIL) },
    });
    mocks.jobCursors.get.mockRejectedValueOnce(new Error("cursor_down"));
    mocks.jobCursors.set.mockRejectedValueOnce(new Error("cursor_write_down"));

    const result = await expireResaleListings(deps);

    expect(result.releasedHoldCount).toBe(1);
    expect(listings.L1!.status).toBe("ACTIVE");
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cursor_down" }),
      expect.objectContaining({ tags: expect.objectContaining({ step: "cursorRead" }) }),
    );
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cursor_write_down" }),
      expect.objectContaining({ tags: expect.objectContaining({ step: "cursorWrite" }) }),
    );
  });
});
