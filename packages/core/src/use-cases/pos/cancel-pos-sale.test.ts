import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

import { SEAT_FENCE_SLACK_SECONDS } from "../orders/_shared/cart-seat-release";
import { cancelPosSale } from "./cancel-pos-sale";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000b1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000f1";
const READER_ID = "00000000-0000-4000-8000-0000000000c1";
const PI_ID = "pi_test_pos_void";
const STRIPE_READER = "tmr_test_frontdoor";
const NOW = new Date("2026-08-25T20:00:00Z");

/** The POS order was opened fifteen minutes before the operator voided it. */
const OCCURRED_AT = new Date(NOW.getTime() - 15 * 60_000);

const SLACK_MS = SEAT_FENCE_SLACK_SECONDS * 1000;

type SeatRow = { status: "HELD" | "AVAILABLE" | "SOLD"; updatedAt: Date };

function makeDeps(
  opts: {
    order?: Record<string, unknown> | null;
    reader?: { orgId: string } | null;
    cancelPiError?: unknown;
    /** What the port's `cancelPaymentIntent` reports back. */
    piCanceled?: boolean;
    /** Status `retrievePaymentIntent` answers with after a no-op cancel. */
    piStatus?: string;
    cancelledOrder?: boolean;
    /** Seed the seat table. Defaults to one seat this order holds. */
    seats?: Record<string, SeatRow>;
  } = {},
) {
  const seats = new Map<string, SeatRow>(
    Object.entries(
      opts.seats ?? { "seat-1": { status: "HELD", updatedAt: OCCURRED_AT } },
    ),
  );

  const state = {
    orderStatus: "PENDING" as string,
    promoHoldsReleased: false,
  };

  const orderRecord = () => ({
    id: ORDER_ID,
    eventId: EVENT_ID,
    status: state.orderStatus,
    paymentChannel: "POS",
    stripePaymentIntentId: PI_ID,
    occurredAt: OCCURRED_AT,
    items: [{ kind: "ticket", meta: { seatIds: ["seat-1"] } }],
    ...(opts.order ?? {}),
  });

  let txDepth = 0;
  const txDepths: Record<string, number[]> = {
    cancelPendingOrder: [],
    releaseHoldsForOrder: [],
    releaseFeeWaiver: [],
    releaseSeats: [],
  };
  const callLog: string[] = [];

  const repoMocks = {
    orders: {
      getById: vi.fn(async () =>
        opts.order === null ? null : (orderRecord() as never),
      ),
      cancelPendingOrder: vi.fn(async () => {
        txDepths.cancelPendingOrder.push(txDepth);
        callLog.push("order");
        if (opts.cancelledOrder === false) return false;
        if (state.orderStatus !== "PENDING") return false;
        state.orderStatus = "CANCELLED";
        return true;
      }),
    },
    events: {
      getById: vi.fn(async () => ({ id: EVENT_ID, orgId: ORG_ID })),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR,
        role: "SCANNER" as const,
      })),
    },
    posReaders: {
      getById: vi.fn(async () =>
        opts.reader === undefined
          ? {
              id: READER_ID,
              orgId: ORG_ID,
              stripeReaderId: STRIPE_READER,
            }
          : opts.reader && {
              id: READER_ID,
              stripeReaderId: STRIPE_READER,
              ...opts.reader,
            },
      ),
    },
    promos: {
      releaseHoldsForOrder: vi.fn(async () => {
        txDepths.releaseHoldsForOrder.push(txDepth);
        callLog.push("promos");
        state.promoHoldsReleased = true;
      }),
    },
    feeWaivers: {
      // A door card sale can reserve organiser-side fee-waiver allowance
      // (spec 2026-10-07 FR-002), so the void must hand it back.
      release: vi.fn(async () => {
        txDepths.releaseFeeWaiver.push(txDepth);
        callLog.push("feeWaiver");
        return { releasedTickets: 0 };
      }),
    },
    seats: {
      /**
       * Mirrors the Prisma adapter's predicate exactly
       * (`packages/adapters/src/db/prisma/seats.ts`): `status = "HELD"`, plus
       * `updatedAt <= heldBefore` when the caller supplies the ownership
       * fence. Without that second clause the fence is untestable at this
       * level — an unfenced call and a fenced one both "succeed".
       */
      releaseSeats: vi.fn(
        async (input: {
          seatIds: string[];
          releasedAt: Date;
          heldBefore?: Date;
        }) => {
          txDepths.releaseSeats.push(txDepth);
          callLog.push("seats");
          for (const id of input.seatIds) {
            const row = seats.get(id);
            if (!row || row.status !== "HELD") continue;
            if (input.heldBefore && row.updatedAt > input.heldBefore) continue;
            row.status = "AVAILABLE";
            row.updatedAt = input.releasedAt;
          }
        },
      ),
    },
  };

  const repos = {
    ...repoMocks,
    /**
     * Snapshot/restore so a throw inside the callback actually ROLLS BACK, the
     * way a real `repos.tx` does. A fake that merely re-throws would let a
     * half-applied cancel pass for atomic.
     */
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = {
        state: { ...state },
        seats: new Map(
          [...seats].map(([id, row]) => [id, { ...row }] as const),
        ),
      };
      txDepth += 1;
      try {
        return await fn(repoMocks);
      } catch (err) {
        state.orderStatus = snapshot.state.orderStatus;
        state.promoHoldsReleased = snapshot.state.promoHoldsReleased;
        seats.clear();
        for (const [id, row] of snapshot.seats) seats.set(id, row);
        throw err;
      } finally {
        txDepth -= 1;
      }
    }),
  } as unknown as Repos;

  const payments = {
    cancelPaymentIntent: vi.fn(async () => {
      callLog.push("pi");
      if (opts.cancelPiError) throw opts.cancelPiError;
      return { canceled: opts.piCanceled ?? true };
    }),
    retrievePaymentIntent: vi.fn(async () => ({
      id: PI_ID,
      status: opts.piStatus ?? "canceled",
      amountReceived: 0,
      currency: "usd",
      metadata: {},
    })),
    cancelReaderAction: vi.fn(async () => {}),
  } as unknown as PaymentProcessorPort;

  const clock: ClockPort = { now: () => NOW };
  return { repos, repoMocks, payments, clock, seats, state, txDepths, callLog };
}

describe("cancelPosSale", () => {
  it("kills the charge before the order, then releases the stock", async () => {
    const h = makeDeps();

    await expect(
      cancelPosSale(
        { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).resolves.toMatchObject({ cancelled: true });

    // A cancelled order with a live PI is the dangerous state: the webhook
    // would find nothing to finalise and the buyer would still be charged.
    expect(h.callLog).toEqual(["pi", "order", "promos", "feeWaiver", "seats"]);
    expect(h.repoMocks.seats.releaseSeats).toHaveBeenCalledWith(
      expect.objectContaining({ seatIds: ["seat-1"] }),
    );
    expect(h.repoMocks.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
    expect(h.seats.get("seat-1")?.status).toBe("AVAILABLE");
  });

  it("runs the cancel, the promo release and the seat release in ONE transaction", async () => {
    const h = makeDeps();

    await cancelPosSale(
      { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    // Depth 1 on every write. Zero would mean it escaped onto bare
    // `deps.repos`, which is what made a partial void unrollbackable.
    expect(h.txDepths).toEqual({
      cancelPendingOrder: [1],
      releaseHoldsForOrder: [1],
      releaseFeeWaiver: [1],
      releaseSeats: [1],
    });
    expect(h.repoMocks.feeWaivers.release).toHaveBeenCalledWith(ORDER_ID);
    expect(h.repos.tx).toHaveBeenCalledTimes(1);
  });

  it("rolls the whole void back when a step inside the transaction throws", async () => {
    const h = makeDeps();
    const boom = new Error("seat release exploded");
    (h.repoMocks.seats.releaseSeats as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(boom);

    await expect(
      cancelPosSale(
        { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toThrow("seat release exploded");

    // The order is NOT cancelled and the promo codes are NOT burnt: the
    // operator retries and gets a clean void, rather than being told the sale
    // was killed while its seats stayed HELD for the reaper's whole TTL.
    expect(h.state.orderStatus).toBe("PENDING");
    expect(h.state.promoHoldsReleased).toBe(false);
    expect(h.seats.get("seat-1")?.status).toBe("HELD");
  });

  it("does not free a seat a different, live order is holding", async () => {
    // The seat-hold reaper (900s) fires long before a PENDING POS order stops
    // reserving capacity, so this order's `meta.seatIds` can name a seat that
    // has since been re-let. It is HELD — by somebody else, under their live
    // PaymentIntent.
    const reheldAt = new Date(OCCURRED_AT.getTime() + 11 * 60_000);
    const h = makeDeps({
      seats: { "seat-1": { status: "HELD", updatedAt: reheldAt } },
    });

    await cancelPosSale(
      { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(h.repoMocks.seats.releaseSeats).toHaveBeenCalledWith(
      expect.objectContaining({
        heldBefore: new Date(OCCURRED_AT.getTime() + SLACK_MS),
      }),
    );
    // Still the other buyer's. Freeing it here is the double-sell.
    expect(h.seats.get("seat-1")?.status).toBe("HELD");
    expect(h.seats.get("seat-1")?.updatedAt).toEqual(reheldAt);
  });

  it("fences on the order's own LAST hold instant, not on occurredAt", async () => {
    // POS never re-holds an existing order's seats today, so `occurredAt` and
    // the last hold coincide. This pins the SHARED resolver's contract anyway:
    // an `occurredAt`-only fence declines a legitimately re-held seat, leaves
    // it HELD, and the next hold attempt then fails for the cart's own seats.
    const reheldAt = new Date(OCCURRED_AT.getTime() + 10 * 60_000);
    const h = makeDeps({
      order: {
        items: [
          {
            kind: "ticket",
            meta: {
              seatIds: ["seat-1"],
              // Written from the same `now` as the seat stamp, 900s out.
              holdExpiresAt: new Date(
                reheldAt.getTime() + 900_000,
              ).toISOString(),
            },
          },
        ],
      },
      seats: { "seat-1": { status: "HELD", updatedAt: reheldAt } },
    });

    await cancelPosSale(
      { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(h.repoMocks.seats.releaseSeats).toHaveBeenCalledWith(
      expect.objectContaining({
        heldBefore: new Date(reheldAt.getTime() + SLACK_MS),
      }),
    );
    expect(h.seats.get("seat-1")?.status).toBe("AVAILABLE");
  });

  it("releases nothing and reports when the order carries no usable fence", async () => {
    const h = makeDeps({
      order: { occurredAt: null },
      seats: { "seat-1": { status: "HELD", updatedAt: OCCURRED_AT } },
    });
    const reportError = vi.fn();

    await cancelPosSale(
      {
        repos: h.repos,
        authz: denyingAuthz,
        payments: h.payments,
        clock: h.clock,
        reportError,
      },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(h.repoMocks.seats.releaseSeats).not.toHaveBeenCalled();
    expect(h.seats.get("seat-1")?.status).toBe("HELD");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "pos_cancel_sale_seat_fence_missing",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "cancelPosSale" }),
      }),
    );
    // The order itself is still voided — the seats merely wait for the reaper.
    expect(h.state.orderStatus).toBe("CANCELLED");
  });

  it("KEEPS a sale whose PaymentIntent already succeeded", async () => {
    // Card-present: the buyer taps while the operator is reaching for cancel.
    // Stripe's cancel is a graceful no-op (`{ canceled: false }`) rather than a
    // throw, so a cancel that ignores the verdict strands a real charge.
    const h = makeDeps({ piCanceled: false, piStatus: "succeeded" });
    const reportError = vi.fn();

    const err = await cancelPosSale(
      {
        repos: h.repos,
        authz: denyingAuthz,
        payments: h.payments,
        clock: h.clock,
        reportError,
      },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    ).catch((e) => e);

    expect(h.repoMocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(h.repoMocks.seats.releaseSeats).not.toHaveBeenCalled();
    expect(h.state.orderStatus).toBe("PENDING");
    expect(h.seats.get("seat-1")?.status).toBe("HELD");
    expect(reportError).toHaveBeenCalled();

    // NOT `ORDER_NOT_PENDING`: the till reads that code as "the order is
    // definitely not holding stock" and rings the same tickets up for cash
    // (`closeOpenOrder` in `SellView.tsx`), which against a paid card sale is
    // a double-sell wearing an error handler's clothes.
    expect((err as { code?: string }).code).toBe("ORDER_NOT_PROCESSABLE");
    expect((err as { code?: string }).code).not.toBe("ORDER_NOT_PENDING");
  });

  it("still voids when the PaymentIntent was already cancelled by someone else", async () => {
    // The other half of `{ canceled: false }` — an idempotent replay, where
    // proceeding is exactly right.
    const h = makeDeps({ piCanceled: false, piStatus: "canceled" });

    await expect(
      cancelPosSale(
        { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).resolves.toMatchObject({ cancelled: true });

    expect(h.state.orderStatus).toBe("CANCELLED");
    expect(h.seats.get("seat-1")?.status).toBe("AVAILABLE");
  });

  it("refuses rather than leaving a confirmable PI attached", async () => {
    const stripeErr = new Error("stripe 500");
    const h = makeDeps({ cancelPiError: stripeErr });
    const reportError = vi.fn();

    await expect(
      cancelPosSale(
        {
          repos: h.repos,
          authz: denyingAuthz,
          payments: h.payments,
          clock: h.clock,
          reportError,
        },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toThrow("stripe 500");

    expect(h.repoMocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalled();
  });

  it("clears the reader prompt when one was dispatched to", async () => {
    const h = makeDeps();

    await cancelPosSale(
      { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID, posReaderId: READER_ID },
    );

    expect(h.payments.cancelReaderAction).toHaveBeenCalledWith({
      readerId: STRIPE_READER,
    });
  });

  it("ignores a reader belonging to another org", async () => {
    const h = makeDeps({ reader: { orgId: OTHER_ORG } });

    await cancelPosSale(
      { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID, posReaderId: READER_ID },
    );

    expect(h.payments.cancelReaderAction).not.toHaveBeenCalled();
  });

  it("refuses a sale that already succeeded — that is a refund, not a void", async () => {
    const h = makeDeps({ order: { status: "SUCCEEDED" } });

    await expect(
      cancelPosSale(
        { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" });

    expect(h.payments.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("refuses a non-POS order", async () => {
    const h = makeDeps({ order: { paymentChannel: "WEB" } });

    await expect(
      cancelPosSale(
        { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "NOT_A_POS_ORDER" });
  });

  it("treats losing the race with the finaliser as success", async () => {
    // The PI is already dead by this point, so someone else ending the sale is
    // the desired end state, not an error to surface at a door.
    const h = makeDeps({ cancelledOrder: false });

    await expect(
      cancelPosSale(
        { repos: h.repos, authz: denyingAuthz, payments: h.payments, clock: h.clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).resolves.toMatchObject({ cancelled: true });

    // The CAS lost, so nothing else in the transaction ran.
    expect(h.repoMocks.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(h.repoMocks.seats.releaseSeats).not.toHaveBeenCalled();
  });
});
