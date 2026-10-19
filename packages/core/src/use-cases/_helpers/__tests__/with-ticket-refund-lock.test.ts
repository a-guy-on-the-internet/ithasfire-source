import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import {
  ORDER_REFUND_MUTEX_TTL_SECONDS,
  withOrderRefundMutex,
} from "../../orders/_shared/refund-mutex";
import {
  TICKET_MOVE_REFUND_LOCK_TTL_SECONDS,
  ensureTicketRefundLockHeld,
  withTicketRefundLock,
  type TicketRefundLock,
} from "../with-ticket-refund-lock";

// Owner ruling 2026-10-05: while a refund on a ticket's order is in flight,
// nothing can happen to the ticket. Moves take the same per-order mutex the
// refund paths hold.

const TICKET_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ITEM_ID = "88888888-8888-4888-8888-888888888888";
const ORDER_ID = "77777777-7777-4777-8777-777777777777";
const KEY = `refund-op:${ORDER_ID}`;
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_KEY = `cancel-op:${EVENT_ID}`;

function makeDeps(
  ticket: { orderItemId: string | null } | null = {
    orderItemId: ORDER_ITEM_ID,
  },
  opts: { withStatus?: boolean } = {},
) {
  const idempotency = createFakeIdempotencyPort({
    withStatus: opts.withStatus ?? true,
  });
  const ticketsGetById = vi.fn(async () =>
    ticket ? { id: TICKET_ID, eventId: EVENT_ID, ...ticket } : null,
  );
  const orderItemsGetById = vi.fn(async (id: string) => ({
    id,
    orderId: ORDER_ID,
  }));
  const reportError = vi.fn();
  const logger = { error: vi.fn() };
  const repos = {
    tickets: { getById: ticketsGetById },
    orderItems: { getById: orderItemsGetById },
  } as unknown as Pick<Repos, "tickets" | "orderItems">;
  return {
    deps: { repos, idempotency, reportError, logger: logger as never },
    idempotency,
    ticketsGetById,
    orderItemsGetById,
    reportError,
  };
}

describe("withTicketRefundLock", () => {
  it("holds refund-op:<the ticket's order> with a short TTL while fn runs, then frees it", async () => {
    const { deps, idempotency, orderItemsGetById } = makeDeps();
    let seen: TicketRefundLock | undefined;
    let heldDuringFn = false;

    const result = await withTicketRefundLock(deps, TICKET_ID, async (lock) => {
      seen = lock;
      // A refund arriving now is refused: the move holds the order.
      heldDuringFn = !(await idempotency.begin(KEY, 600, "refund-token"));
      return "moved";
    });

    expect(result).toBe("moved");
    expect(orderItemsGetById).toHaveBeenCalledWith(ORDER_ITEM_ID);
    expect(idempotency.__mocks.begin).toHaveBeenCalledWith(
      KEY,
      TICKET_MOVE_REFUND_LOCK_TTL_SECONDS,
      expect.any(String),
    );
    expect(TICKET_MOVE_REFUND_LOCK_TTL_SECONDS).toBe(60);
    expect(heldDuringFn).toBe(true);
    expect(seen).toEqual({
      orderItemId: ORDER_ITEM_ID,
      refundInProgress: false,
    });
    // Freed with its own token: the next refund acquires at once.
    const token = idempotency.__mocks.begin.mock.calls[0]![2];
    expect(idempotency.__mocks.release).toHaveBeenCalledWith(KEY, token);
    expect(await idempotency.begin(KEY, 600, "next")).toBe(true);
  });

  it("frees the lock when fn throws, and rethrows the original error", async () => {
    const { deps, idempotency } = makeDeps();
    const boom = new Error("tx failed");

    await expect(
      withTicketRefundLock(deps, TICKET_ID, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(idempotency.__mocks.release).toHaveBeenCalledTimes(1);
    expect(await idempotency.begin(KEY, 600, "next")).toBe(true);
  });

  it("while a refund holds the order: runs fn flagged refundInProgress and never frees the refund's lock", async () => {
    const { deps, idempotency } = makeDeps();
    expect(
      await idempotency.begin(KEY, ORDER_REFUND_MUTEX_TTL_SECONDS, "refund"),
    ).toBe(true);

    const seen = await withTicketRefundLock(
      deps,
      TICKET_ID,
      async (lock) => lock,
    );

    expect(seen).toEqual({
      orderItemId: ORDER_ITEM_ID,
      refundInProgress: true,
    });
    expect(idempotency.__mocks.release).not.toHaveBeenCalled();
    expect(idempotency.__tokens.get(KEY)).toBe("refund");
  });

  it("excludes a real refund holder (withOrderRefundMutex) end to end", async () => {
    const { deps } = makeDeps();
    let inner: TicketRefundLock | undefined;
    await withOrderRefundMutex(deps, ORDER_ID, async () => {
      inner = await withTicketRefundLock(deps, TICKET_ID, async (lock) => lock);
    });
    expect(inner?.refundInProgress).toBe(true);

    // …and the other way round: a refund arriving mid-move is refused with
    // the code every refund path already surfaces as "retry shortly".
    await withTicketRefundLock(deps, TICKET_ID, async () => {
      await expect(
        withOrderRefundMutex(deps, ORDER_ID, async () => "refunded"),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });
    });
  });

  it("takes no lock for a ticket with no order item", async () => {
    const { deps, idempotency, orderItemsGetById } = makeDeps({
      orderItemId: null,
    });

    const seen = await withTicketRefundLock(
      deps,
      TICKET_ID,
      async (lock) => lock,
    );

    expect(seen).toEqual({ orderItemId: null, refundInProgress: false });
    expect(orderItemsGetById).not.toHaveBeenCalled();
    expect(idempotency.__mocks.begin).not.toHaveBeenCalled();
  });

  it("takes no lock for a missing ticket or no ticket id (the tx reports not-found)", async () => {
    const missing = makeDeps(null);
    await withTicketRefundLock(missing.deps, TICKET_ID, async () => undefined);
    expect(missing.idempotency.__mocks.begin).not.toHaveBeenCalled();

    const none = makeDeps();
    await withTicketRefundLock(none.deps, null, async () => undefined);
    expect(none.ticketsGetById).not.toHaveBeenCalled();
    expect(none.idempotency.__mocks.begin).not.toHaveBeenCalled();
  });

  it("a lost lock on release is reported, never thrown", async () => {
    const { deps, idempotency, reportError } = makeDeps();

    const result = await withTicketRefundLock(deps, TICKET_ID, async () => {
      // Simulate the TTL lapsing and a refund re-acquiring mid-move.
      idempotency.__tokens.set(KEY, "someone-else");
      return "moved";
    });

    expect(result).toBe("moved");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "order_refund_mutex_lock_lost" }),
      expect.anything(),
    );
  });
});

describe("ensureTicketRefundLockHeld", () => {
  const free = { orderItemId: ORDER_ITEM_ID, refundInProgress: false };

  it("passes when the lock is held for the ticket's current order item", () => {
    expect(() =>
      ensureTicketRefundLockHeld(free, { orderItemId: ORDER_ITEM_ID }),
    ).not.toThrow();
    expect(() =>
      ensureTicketRefundLockHeld(
        { orderItemId: null, refundInProgress: false },
        { orderItemId: null },
      ),
    ).not.toThrow();
  });

  it("refuses with TICKET_REFUND_IN_PROGRESS and no meta while a refund holds the order", () => {
    let thrown: unknown;
    try {
      ensureTicketRefundLockHeld(
        { ...free, refundInProgress: true },
        { orderItemId: ORDER_ITEM_ID },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "TICKET_REFUND_IN_PROGRESS" });
    expect((thrown as { meta?: unknown }).meta).toBeUndefined();
  });

  it("refuses when the ticket was re-pointed to another order item since the lock was picked", () => {
    expect(() =>
      ensureTicketRefundLockHeld(free, {
        orderItemId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toThrow(expect.objectContaining({ code: "TICKET_REFUND_IN_PROGRESS" }));
    expect(() =>
      ensureTicketRefundLockHeld(
        { orderItemId: null, refundInProgress: false },
        { orderItemId: ORDER_ITEM_ID },
      ),
    ).toThrow(expect.objectContaining({ code: "TICKET_REFUND_IN_PROGRESS" }));
  });
});

// The event-level lock cancelEvent holds while it refunds (owner ruling
// 2026-10-05; events/_shared/event-cancel-mutex.ts).
describe("withTicketRefundLock — event cancellation in progress", () => {
  it("refuses while cancel-op:<eventId> is held, without taking the order's mutex", async () => {
    const { deps, idempotency } = makeDeps();
    await idempotency.begin(EVENT_KEY, 3600, "cancel");

    const seen = await withTicketRefundLock(deps, TICKET_ID, async (l) => l);

    expect(seen).toEqual({
      orderItemId: ORDER_ITEM_ID,
      refundInProgress: true,
    });
    expect(idempotency.__mocks.begin).not.toHaveBeenCalledWith(
      KEY,
      expect.anything(),
      expect.anything(),
    );
    expect(idempotency.__tokens.get(EVENT_KEY)).toBe("cancel");
  });

  it("re-checks inside the held order mutex: a cancel that starts after check 1 still refuses the move", async () => {
    const { deps, idempotency, orderItemsGetById } = makeDeps();
    // The cancel takes its event lock between the pre-check and the order
    // mutex acquire.
    orderItemsGetById.mockImplementationOnce(async (id: string) => {
      await idempotency.begin(EVENT_KEY, 3600, "cancel");
      return { id, orderId: ORDER_ID };
    });

    const seen = await withTicketRefundLock(deps, TICKET_ID, async (l) => l);

    expect(seen.refundInProgress).toBe(true);
    // The order mutex it did take is freed again.
    expect(idempotency.__mocks.release).toHaveBeenCalledWith(
      KEY,
      expect.any(String),
    );
    expect(await idempotency.begin(KEY, 600, "refund")).toBe(true);
  });

  it("refuses a ticket with no order item while its event is being cancelled, and lets it through otherwise", async () => {
    const held = makeDeps({ orderItemId: null });
    await held.idempotency.begin(EVENT_KEY, 3600, "cancel");
    expect(
      (await withTicketRefundLock(held.deps, TICKET_ID, async (l) => l))
        .refundInProgress,
    ).toBe(true);

    const free = makeDeps({ orderItemId: null });
    expect(
      await withTicketRefundLock(free.deps, TICKET_ID, async (l) => l),
    ).toEqual({ orderItemId: null, refundInProgress: false });
  });

  it("asks nothing about events when there is no ticket (no eventId)", async () => {
    const { deps, idempotency } = makeDeps(null);
    await withTicketRefundLock(deps, TICKET_ID, async () => undefined);
    expect(idempotency.__mocks.status).not.toHaveBeenCalled();
  });

  it("only another event's cancellation does not block this ticket", async () => {
    const { deps, idempotency } = makeDeps();
    await idempotency.begin(
      "cancel-op:22222222-2222-4222-8222-222222222222",
      3600,
      "cancel",
    );
    expect(
      (await withTicketRefundLock(deps, TICKET_ID, async (l) => l))
        .refundInProgress,
    ).toBe(false);
  });

  it("treats a port without status() as no cancellation (test fakes only)", async () => {
    const { deps, idempotency } = makeDeps(undefined, { withStatus: false });
    await idempotency.begin(EVENT_KEY, 3600, "cancel");
    expect(
      (await withTicketRefundLock(deps, TICKET_ID, async (l) => l))
        .refundInProgress,
    ).toBe(false);
  });
});

// Review round 1: a caller who could never be authorized must not be able to
// hold the seller's order mutex (ticket ids are public on resale listings).
describe("withTicketRefundLock — mayLock pre-filter", () => {
  it("a caller who fails mayLock takes no lock and reads nothing more", async () => {
    const { deps, idempotency, orderItemsGetById } = makeDeps();
    const mayLock = vi.fn(() => false);

    const seen = await withTicketRefundLock(
      deps,
      TICKET_ID,
      async (lock) => lock,
      { mayLock },
    );

    expect(mayLock).toHaveBeenCalledWith(
      expect.objectContaining({ id: TICKET_ID, orderItemId: ORDER_ITEM_ID }),
    );
    expect(seen).toEqual({
      orderItemId: ORDER_ITEM_ID,
      refundInProgress: false,
      skipped: true,
    });
    expect(orderItemsGetById).not.toHaveBeenCalled();
    expect(idempotency.__mocks.begin).not.toHaveBeenCalled();
    expect(idempotency.__mocks.status).not.toHaveBeenCalled();
  });

  it("the in-tx guard refuses a skipped lock (safety net if the tx's authz ever admitted the caller)", () => {
    expect(() =>
      ensureTicketRefundLockHeld(
        { orderItemId: ORDER_ITEM_ID, refundInProgress: false, skipped: true },
        { orderItemId: ORDER_ITEM_ID },
      ),
    ).toThrow(expect.objectContaining({ code: "TICKET_REFUND_IN_PROGRESS" }));
  });

  it("a caller who passes mayLock (sync or async) is locked as usual", async () => {
    const { deps, idempotency } = makeDeps();

    const seen = await withTicketRefundLock(
      deps,
      TICKET_ID,
      async (lock) => lock,
      { mayLock: async () => true },
    );

    expect(seen).toEqual({
      orderItemId: ORDER_ITEM_ID,
      refundInProgress: false,
    });
    expect(idempotency.__mocks.begin).toHaveBeenCalledWith(
      KEY,
      TICKET_MOVE_REFUND_LOCK_TTL_SECONDS,
      expect.any(String),
    );
  });

  it("is not consulted for a missing ticket", async () => {
    const { deps } = makeDeps(null);
    const mayLock = vi.fn(() => true);
    await withTicketRefundLock(deps, TICKET_ID, async () => undefined, {
      mayLock,
    });
    expect(mayLock).not.toHaveBeenCalled();
  });
});
