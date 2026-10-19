import { describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  ACTOR_ID,
  EVENT_ID,
  NOW,
  PRICED,
  makeCashWorld,
  type CashWorld,
} from "../../pos/__tests__/cash-refund-world";
import { createCartReapQuarantine } from "../../orders/_shared/cart-reap-quarantine";
import { cancelEvent, type CancelEventDeps } from "../cancel-event";
import {
  settleDoorOrdersOnCancelledEvents,
  type SettleDoorOrdersOnCancelledEventsDeps,
} from "../settle-door-orders-on-cancelled-events";

/**
 * Door orders on a cancelled event (code review 2026-10-07):
 *
 *  - `cancelEvent` voids the event's PENDING door card sales after its
 *    commit (Phase 4), the way the operator's own "cancel this sale" does;
 *  - the door sweep (`settleDoorOrdersOnCancelledEvents`, run by the cart
 *    reaper's job) finishes what a cancellation left undone at the door —
 *    including a cancellation that crashed between its commit and its cash
 *    phase, which nothing else ever re-runs.
 */

/**
 * The crash seam: when armed, the cancellation's cash phase dies the way a
 * killed process does — after the marking transaction committed, before any
 * cash order was touched. Disarmed, it is the real phase (the sweep runs it).
 */
const crash = vi.hoisted(() => ({ armed: false }));
vi.mock("../_shared/refund-cash-orders-for-cancelled-event", async () => {
  const actual = await vi.importActual<
    typeof import("../_shared/refund-cash-orders-for-cancelled-event")
  >("../_shared/refund-cash-orders-for-cancelled-event");
  return {
    ...actual,
    refundCashOrdersForCancelledEvent: async (
      ...args: Parameters<typeof actual.refundCashOrdersForCancelledEvent>
    ) => {
      if (crash.armed) {
        crash.armed = false;
        throw new Error("process killed after the cancel committed");
      }
      return actual.refundCashOrdersForCancelledEvent(...args);
    },
  };
});

const CASH_A = "c0000000-0000-4000-8000-00000000b001";
const CASH_B = "c0000000-0000-4000-8000-00000000b002";
const POS_PENDING = "c0000000-0000-4000-8000-00000000b003";
const POS_PAID = "c0000000-0000-4000-8000-00000000b004";
const WEB_CART = "c0000000-0000-4000-8000-00000000b005";
const LEGACY_CASH = "c0000000-0000-4000-8000-00000000b006";
const OLD_COMP = "c0000000-0000-4000-8000-00000000b007";

type PiStatus = "canceled" | "succeeded";

/**
 * Stripe for the door: each PI cancels unless it was already paid. `down`
 * makes every cancel throw (an outage: may clear on its own).
 */
function makePayments(
  paid: ReadonlySet<string> = new Set(),
  opts: { down?: boolean } = {},
) {
  const piStatus = (id: string): PiStatus =>
    [...paid].some((orderId) => id === `pi_${orderId.slice(-6)}`)
      ? "succeeded"
      : "canceled";
  return {
    cancelPaymentIntent: vi.fn(async ({ paymentIntentId }: { paymentIntentId: string }) => {
      if (opts.down) throw new Error("stripe unavailable");
      return { canceled: piStatus(paymentIntentId) === "canceled" };
    }),
    retrievePaymentIntent: vi.fn(async ({ paymentIntentId }: { paymentIntentId: string }) => ({
      id: paymentIntentId,
      status: piStatus(paymentIntentId),
    })),
    refundPaymentIntent: vi.fn(async () => ({
      refundId: "re_card",
      status: "succeeded" as const,
    })),
    getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 100 })),
  };
}

function cancelDeps(w: CashWorld, payments = makePayments()) {
  const reportError = vi.fn();
  const deps: CancelEventDeps = {
    repos: w.repos,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    payments: payments as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: w.clock,
    logger: createTestLogger(),
    reportError,
  };
  return { deps, reportError, payments };
}

function sweepDeps(
  w: CashWorld,
  payments: ReturnType<typeof makePayments> | null = makePayments(),
  quarantine = createCartReapQuarantine(),
) {
  const reportError = vi.fn();
  const deps: SettleDoorOrdersOnCancelledEventsDeps = {
    repos: w.repos,
    payments: payments as unknown as SettleDoorOrdersOnCancelledEventsDeps["payments"],
    clock: w.clock,
    logger: createTestLogger(),
    reportError,
    quarantine,
  };
  return { deps, reportError, quarantine };
}

const input = (clientKey = "cancel-door-orders-key-1") => ({
  actorHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  clientKey,
});

const reportsAt = (reportError: ReturnType<typeof vi.fn>, step: string) =>
  reportError.mock.calls.filter(
    ([, ctx]) => (ctx as { tags?: { step?: string } })?.tags?.step === step,
  );

async function doorWorld(): Promise<CashWorld> {
  const w = makeCashWorld();
  await w.addPricedCashOrder(CASH_A);
  await w.addPricedCashOrder(CASH_B);
  w.addPendingCardSale(POS_PENDING);
  w.addPendingCardSale(WEB_CART, { channel: "WEB" });
  // Cancelling needs Owner or Admin.
  w.setRole("OWNER");
  return w;
}

describe("cancelEvent — PENDING door card sales (Phase 4)", () => {
  it("voids every PENDING door card sale: PI cancelled first, order CANCELLED, holds released; an online cart is left to the reaper", async () => {
    const w = await doorWorld();
    const { deps, reportError, payments } = cancelDeps(w);

    const out = await cancelEvent(deps, input());

    expect(out).toMatchObject({
      status: "CANCELLED",
      voidedPendingPosOrderCount: 1,
      failedPendingPosVoidCount: 0,
      pendingPosScanFailed: false,
    });
    expect(w.orders.get(POS_PENDING)!.status).toBe("CANCELLED");
    expect(payments.cancelPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: `pi_${POS_PENDING.slice(-6)}` }),
    );
    // The PI died before the order did.
    expect(payments.cancelPaymentIntent.mock.invocationCallOrder[0]).toBeLessThan(
      w.tx.orders.cancelPendingOrder.mock.invocationCallOrder[0]!,
    );
    expect(w.tx.promos.releaseHoldsForOrder).toHaveBeenCalledWith(POS_PENDING);
    expect(w.tx.feeWaivers.release).toHaveBeenCalledWith(POS_PENDING);

    // The online cart is the cart reaper's, not the door's.
    expect(w.orders.get(WEB_CART)!.status).toBe("PENDING");
    expect(payments.cancelPaymentIntent).not.toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: `pi_${WEB_CART.slice(-6)}` }),
    );
    expect(reportsAt(reportError, "voidPendingPosOrders")).toHaveLength(0);
  });

  it("a sale the buyer already paid is not voided: reported, counted, left for finalize; the rest carry on and the cancel succeeds", async () => {
    const w = await doorWorld();
    w.addPendingCardSale(POS_PAID);
    const { deps, reportError } = cancelDeps(w, makePayments(new Set([POS_PAID])));

    const out = await cancelEvent(deps, input());

    expect(out).toMatchObject({
      status: "CANCELLED",
      voidedPendingPosOrderCount: 1,
      failedPendingPosVoidCount: 1,
    });
    expect(w.orders.get(POS_PAID)!.status).toBe("PENDING");
    expect(w.orders.get(POS_PENDING)!.status).toBe("CANCELLED");
    const reports = reportsAt(reportError, "voidPendingPosOrders");
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { area: "pos", useCase: "cancelEvent" },
      extra: { eventId: EVENT_ID, orderId: POS_PAID },
    });
    // The cash phase was not stopped by it.
    expect(out.refundedCashOrderCount).toBe(2);
  });
});

describe("the door sweep finishes a cancellation that crashed after its commit", () => {
  it("crash between the commit and the cash phase: the event is CANCELLED, nothing re-runs the phase, the sweep completes it", async () => {
    const w = await doorWorld();
    const { deps } = cancelDeps(w);

    crash.armed = true;
    await expect(cancelEvent(deps, input())).rejects.toThrow(
      "process killed after the cancel committed",
    );

    // The commit stands; the door is untouched.
    expect(w.event.status).toBe("CANCELLED");
    expect(w.orders.get(CASH_A)!.status).toBe("SUCCEEDED");
    expect(w.orders.get(CASH_B)!.status).toBe("SUCCEEDED");
    expect(w.orders.get(POS_PENDING)!.status).toBe("PENDING");
    expect(w.netBalanceCents()).toBe(-2 * PRICED.debitCents);

    // A retry under a new key cannot finish it: the event is already
    // cancelled. This is why the sweep exists.
    await expect(
      cancelEvent(deps, input("cancel-door-orders-key-2")),
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_CANCELLED" });
    expect(w.orders.get(CASH_A)!.status).toBe("SUCCEEDED");

    const sweep = sweepDeps(w);
    const out = await settleDoorOrdersOnCancelledEvents(sweep.deps, {});

    expect(out).toEqual({
      eventCount: 1,
      refundedCashOrderCount: 2,
      failedCashRefundCount: 0,
      voidedPendingPosOrderCount: 1,
      failedPendingPosVoidCount: 0,
      keptPendingPosOrderCount: 0,
      quarantinedPendingPosOrderCount: 0,
      scanFailedEventCount: 0,
    });
    for (const id of [CASH_A, CASH_B]) {
      expect(w.orders.get(id)!.status).toBe("REFUNDED");
      expect(w.reversalsFor(id)).toHaveLength(1);
      expect(w.reversalsFor(id)[0]!.metadata).toMatchObject({
        via: "event_cancel",
        actorHumanId: null,
      });
    }
    expect(w.orders.get(POS_PENDING)!.status).toBe("CANCELLED");
    // The organiser no longer owes fee + tax on cash they hand back.
    expect(w.netBalanceCents()).toBe(0);
    expect(sweep.reportError).not.toHaveBeenCalled();
  });
});

describe("settleDoorOrdersOnCancelledEvents", () => {
  it("does nothing when no cancelled event has open door orders", async () => {
    const w = await doorWorld();
    const sweep = sweepDeps(w);

    const out = await settleDoorOrdersOnCancelledEvents(sweep.deps, {});

    expect(out).toEqual({
      eventCount: 0,
      refundedCashOrderCount: 0,
      failedCashRefundCount: 0,
      voidedPendingPosOrderCount: 0,
      failedPendingPosVoidCount: 0,
      keptPendingPosOrderCount: 0,
      quarantinedPendingPosOrderCount: 0,
      scanFailedEventCount: 0,
    });
    // A PUBLISHED event's door is not the sweep's business.
    expect(w.orders.get(CASH_A)!.status).toBe("SUCCEEDED");
    expect(w.tx.orders.listCancelledEventIdsWithOpenDoorOrders).toHaveBeenCalledWith(
      { limit: 50, excludeOrderIds: [] },
    );
  });

  it("is idempotent: a second run finds nothing and writes nothing", async () => {
    const w = await doorWorld();
    (w.event as { status: string }).status = "CANCELLED";
    await settleDoorOrdersOnCancelledEvents(sweepDeps(w).deps, {});
    const ledgerRows = w.ledger.entries.length;
    const auditRows = w.auditRows.length;

    const again = await settleDoorOrdersOnCancelledEvents(sweepDeps(w).deps, {});

    expect(again.eventCount).toBe(0);
    expect(w.ledger.entries).toHaveLength(ledgerRows);
    expect(w.auditRows).toHaveLength(auditRows);
  });

  it("counts and reports what it could not settle, and settles the rest", async () => {
    const w = await doorWorld();
    w.addPendingCardSale(POS_PAID);
    (w.event as { status: string }).status = "CANCELLED";
    w.failOnOrderIds.add(CASH_A);
    const sweep = sweepDeps(w, makePayments(new Set([POS_PAID])));

    const out = await settleDoorOrdersOnCancelledEvents(sweep.deps, {});

    expect(out).toMatchObject({
      eventCount: 1,
      refundedCashOrderCount: 1,
      failedCashRefundCount: 1,
      voidedPendingPosOrderCount: 1,
      // The paid sale is KEPT, not failed: see the quarantine tests below.
      failedPendingPosVoidCount: 0,
      keptPendingPosOrderCount: 1,
    });
    expect(reportsAt(sweep.reportError, "refundCashOrders")[0]![1]).toMatchObject({
      extra: { orderId: CASH_A },
    });
    expect(
      reportsAt(sweep.reportError, "voidPendingPosOrders")[0]![1],
    ).toMatchObject({ extra: { orderId: POS_PAID } });
    expect(w.orders.get(CASH_B)!.status).toBe("REFUNDED");
    expect(w.orders.get(POS_PENDING)!.status).toBe("CANCELLED");
  });

  it("with no payment processor configured, the card voids fail loudly instead of cancelling an order under a live PaymentIntent", async () => {
    const w = await doorWorld();
    (w.event as { status: string }).status = "CANCELLED";
    const sweep = sweepDeps(w, null);

    const out = await settleDoorOrdersOnCancelledEvents(sweep.deps, {});

    // No processor is a refusal no retry here can fix: kept, not failed.
    expect(out.keptPendingPosOrderCount).toBe(1);
    expect(out.failedPendingPosVoidCount).toBe(0);
    expect(out.refundedCashOrderCount).toBe(2);
    expect(w.orders.get(POS_PENDING)!.status).toBe("PENDING");
    const [report] = reportsAt(sweep.reportError, "voidPendingPosOrders");
    expect((report![0] as Error).message).toBe("no_payment_processor");
  });

  it("rejects unknown input keys (strict)", async () => {
    const w = await doorWorld();
    await expect(
      settleDoorOrdersOnCancelledEvents(sweepDeps(w).deps, { force: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("the sweep never rewrites an old cancellation (code review 2026-10-07)", () => {
  it("a cancelled event whose cash sales carry no debit (sold before the door was priced) and an old comp is not touched", async () => {
    const w = makeCashWorld();
    w.addLegacyCashOrder(LEGACY_CASH, 3000);
    w.addCompCashOrder(OLD_COMP);
    (w.event as { status: string }).status = "CANCELLED";
    const sweep = sweepDeps(w);

    const out = await settleDoorOrdersOnCancelledEvents(sweep.deps, {});

    expect(out.eventCount).toBe(0);
    expect(w.orders.get(LEGACY_CASH)!.status).toBe("SUCCEEDED");
    expect(w.orders.get(OLD_COMP)!.status).toBe("SUCCEEDED");
    expect(w.tickets.get(LEGACY_CASH)!.every((t) => t.status !== "REFUNDED")).toBe(
      true,
    );
    expect(w.auditRows).toHaveLength(0);
    expect(w.ledger.entries).toHaveLength(0);
  });

  it("on an event with both, it refunds only the sale with an unreversed debit", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(CASH_A);
    w.addLegacyCashOrder(LEGACY_CASH, 3000);
    w.addCompCashOrder(OLD_COMP);
    (w.event as { status: string }).status = "CANCELLED";

    const out = await settleDoorOrdersOnCancelledEvents(sweepDeps(w).deps, {});

    expect(out).toMatchObject({ eventCount: 1, refundedCashOrderCount: 1 });
    expect(w.orders.get(CASH_A)!.status).toBe("REFUNDED");
    expect(w.reversalsFor(CASH_A)).toHaveLength(1);
    expect(w.orders.get(LEGACY_CASH)!.status).toBe("SUCCEEDED");
    expect(w.orders.get(OLD_COMP)!.status).toBe("SUCCEEDED");
    expect(
      w.auditRows.filter((r) => r.action === "pos_cash_refund").map((r) => r.entityId),
    ).toEqual([CASH_A]);
  });

  it("the live cancellation still refunds every cash order, comps and old sales included", async () => {
    const w = makeCashWorld();
    w.addLegacyCashOrder(LEGACY_CASH, 3000);
    w.addCompCashOrder(OLD_COMP);
    w.setRole("OWNER");

    const out = await cancelEvent(cancelDeps(w).deps, input());

    expect(out.refundedCashOrderCount).toBe(2);
    expect(w.orders.get(LEGACY_CASH)!.status).toBe("REFUNDED");
    expect(w.orders.get(OLD_COMP)!.status).toBe("REFUNDED");
  });
});

describe("a door card sale the sweep cannot void is reported once, then left quiet", () => {
  it("paid PaymentIntent: the first run keeps it and reports it once; later runs skip it without probing Stripe or reporting", async () => {
    const w = makeCashWorld();
    w.addPendingCardSale(POS_PAID);
    (w.event as { status: string }).status = "CANCELLED";
    const payments = makePayments(new Set([POS_PAID]));
    const quarantine = createCartReapQuarantine();

    const first = sweepDeps(w, payments, quarantine);
    const out1 = await settleDoorOrdersOnCancelledEvents(first.deps, {});
    expect(out1).toMatchObject({
      eventCount: 1,
      keptPendingPosOrderCount: 1,
      failedPendingPosVoidCount: 0,
    });
    const reports = reportsAt(first.reportError, "voidPendingPosOrders");
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { outcome: "kept" },
      extra: { orderId: POS_PAID },
    });
    expect(w.orders.get(POS_PAID)!.status).toBe("PENDING");

    const probes = payments.cancelPaymentIntent.mock.calls.length;
    const second = sweepDeps(w, payments, quarantine);
    const out2 = await settleDoorOrdersOnCancelledEvents(second.deps, {});

    // The quarantined order is kept out of the event scan: nothing to do.
    expect(out2).toMatchObject({
      eventCount: 0,
      keptPendingPosOrderCount: 0,
      failedPendingPosVoidCount: 0,
    });
    expect(second.reportError).not.toHaveBeenCalled();
    expect(payments.cancelPaymentIntent.mock.calls.length).toBe(probes);
    expect(w.tx.orders.listCancelledEventIdsWithOpenDoorOrders).toHaveBeenLastCalledWith(
      { limit: 50, excludeOrderIds: [POS_PAID] },
    );
  });

  it("a quarantined sale on an event that still has other work is skipped, and the rest is settled", async () => {
    const w = makeCashWorld();
    w.addPendingCardSale(POS_PAID);
    (w.event as { status: string }).status = "CANCELLED";
    const payments = makePayments(new Set([POS_PAID]));
    const quarantine = createCartReapQuarantine();
    await settleDoorOrdersOnCancelledEvents(
      sweepDeps(w, payments, quarantine).deps,
      {},
    );

    // New work on the same event: a cash sale the cancellation missed.
    await w.addPricedCashOrder(CASH_A);
    const run = sweepDeps(w, payments, quarantine);
    const out = await settleDoorOrdersOnCancelledEvents(run.deps, {});

    expect(out).toMatchObject({
      eventCount: 1,
      refundedCashOrderCount: 1,
      quarantinedPendingPosOrderCount: 1,
      keptPendingPosOrderCount: 0,
      failedPendingPosVoidCount: 0,
    });
    expect(reportsAt(run.reportError, "voidPendingPosOrders")).toHaveLength(0);
  });

  it("a Stripe outage may clear on its own: counted as FAILED every run (not quarantined), reported each time", async () => {
    const w = makeCashWorld();
    w.addPendingCardSale(POS_PENDING);
    (w.event as { status: string }).status = "CANCELLED";
    const payments = makePayments(new Set(), { down: true });
    const quarantine = createCartReapQuarantine();

    for (let run = 0; run < 2; run++) {
      const s = sweepDeps(w, payments, quarantine);
      const out = await settleDoorOrdersOnCancelledEvents(s.deps, {});
      expect(out).toMatchObject({
        eventCount: 1,
        failedPendingPosVoidCount: 1,
        keptPendingPosOrderCount: 0,
      });
      expect(reportsAt(s.reportError, "voidPendingPosOrders")[0]![1]).toMatchObject(
        { tags: { outcome: "failed" } },
      );
    }
    expect(quarantine.size()).toBe(0);
    expect(w.orders.get(POS_PENDING)!.status).toBe("PENDING");
  });
});

describe("cancelling is not bound by the Editor's 7-day window (owner ruling 2026-10-07)", () => {
  it("a cancel 8 days after the event ended still refunds the cash and reverses every debit", async () => {
    const w = await doorWorld();
    // The world's event ends at NOW.
    w.setNow(new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000));
    const { deps } = cancelDeps(w);

    const out = await cancelEvent(deps, input());

    expect(out).toMatchObject({ refundedCashOrderCount: 2, failedCashRefundCount: 0 });
    expect(w.reversalsFor(CASH_A)).toHaveLength(1);
    expect(w.reversalsFor(CASH_B)).toHaveLength(1);
    expect(w.netBalanceCents()).toBe(0);
  });
});
