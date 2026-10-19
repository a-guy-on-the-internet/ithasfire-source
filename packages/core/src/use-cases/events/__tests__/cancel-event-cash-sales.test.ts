import { describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { orgRefundCashSale } from "../../pos/org-refund-cash-sale";
import { refundCashSale } from "../../pos/refund-cash-sale";
import {
  ACTOR_ID,
  EVENT_ID,
  NOW,
  ORG_ID,
  PRICED,
  makeCashWorld,
  type CashWorld,
} from "../../pos/__tests__/cash-refund-world";
import { refundCashOrdersForCancelledEvent } from "../_shared/refund-cash-orders-for-cancelled-event";
import { cancelEvent, type CancelEventDeps } from "../cancel-event";

/**
 * Owner ruling 2026-10-07 ("Cancel + Editor action"): cancelling an event
 * refunds every door cash sale — order REFUNDED, tickets voided, and its
 * CASH_SALE_DEBIT reversed, so the organiser who hands the cash back does
 * not also pay the platform fee + tax. Card orders are refunded exactly as
 * before. The cash phase runs after the cancellation commits, one
 * transaction per order, and never throws.
 */

const CARD_ID = "c0000000-0000-4000-8000-00000000a001";
const CASH_A = "c0000000-0000-4000-8000-00000000a002";
const CASH_B = "c0000000-0000-4000-8000-00000000a003";
const COMP_ID = "c0000000-0000-4000-8000-00000000a004";
const REFUNDED_CASH = "c0000000-0000-4000-8000-00000000a005";
const LEGACY_ID = "c0000000-0000-4000-8000-00000000a006";
const FREE_WEB = "c0000000-0000-4000-8000-00000000a007";
const CASH_IDS = [CASH_A, CASH_B, COMP_ID, LEGACY_ID] as const;
const PRICED_CASH_IDS = [CASH_A, CASH_B, REFUNDED_CASH] as const;

async function buildMix(): Promise<CashWorld> {
  const w = makeCashWorld();
  await w.addCardOrder(CARD_ID);
  await w.addPricedCashOrder(CASH_A);
  await w.addPricedCashOrder(CASH_B);
  w.addCompCashOrder(COMP_ID);
  w.addLegacyCashOrder(LEGACY_ID, 3000);
  w.addFreeWebOrder(FREE_WEB);
  // Refunded at the till before the show was called off.
  await w.addPricedCashOrder(REFUNDED_CASH);
  w.setRole("EDITOR");
  await refundCashSale(
    { repos: w.repos, clock: w.clock },
    { actorHumanId: ACTOR_ID, orderId: REFUNDED_CASH },
  );
  // Cancelling needs Owner or Admin.
  w.setRole("OWNER");
  return w;
}

function cancelDeps(w: CashWorld) {
  const reportError = vi.fn();
  const refundPaymentIntent = vi.fn(async () => ({
    refundId: "re_card",
    status: "succeeded" as const,
  }));
  const deps: CancelEventDeps = {
    repos: w.repos,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    payments: {
      refundPaymentIntent,
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 100 })),
    } as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
    reportError,
  };
  return { deps, reportError, refundPaymentIntent };
}

const input = (clientKey = "cancel-cash-mix-key-1") => ({
  actorHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  clientKey,
});

const cashReports = (reportError: ReturnType<typeof vi.fn>) =>
  reportError.mock.calls.filter(([, ctx]) =>
    String((ctx as { tags?: { step?: string } })?.tags?.step ?? "").startsWith(
      "refundCashOrders",
    ),
  );

describe("cancelEvent — door cash sales", () => {
  it("refunds every cash order once, reverses each debit once, and leaves the card refund as it was", async () => {
    const w = await buildMix();
    const { deps, reportError, refundPaymentIntent } = cancelDeps(w);
    const debitsBefore = w.ledger.entriesOfType("CASH_SALE_DEBIT");
    expect(debitsBefore).toHaveLength(3);

    const out = await cancelEvent(deps, input());

    expect(out).toMatchObject({
      status: "CANCELLED",
      refundedOrderCount: 1,
      failedRefundCount: 0,
      refundedCashOrderCount: CASH_IDS.length,
      failedCashRefundCount: 0,
      cashRefundScanFailed: false,
    });

    // Card: refunded through Stripe exactly as before.
    expect(refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(w.orders.get(CARD_ID)!.status).toBe("REFUNDED");
    expect(
      w.ledger.entriesOfType("REFUND_DEBIT").map((e) => e.orderId),
    ).toEqual([CARD_ID]);
    // Card orders never reach the cash refund.
    expect(
      w.auditRows.filter(
        (r) => r.action === "pos_cash_refund" && r.entityId === CARD_ID,
      ),
    ).toHaveLength(0);

    // Cash: every order REFUNDED, every ticket voided.
    for (const id of CASH_IDS) {
      expect(w.orders.get(id)!.status).toBe("REFUNDED");
      expect(w.tickets.get(id)!.every((t) => t.status === "REFUNDED")).toBe(
        true,
      );
    }
    // Each priced sale's debit reversed exactly once — the one the till
    // already refunded included.
    for (const id of PRICED_CASH_IDS) {
      expect(w.reversalsFor(id)).toHaveLength(1);
    }
    const reversals = w.ledger.entriesOfType("CASH_SALE_DEBIT_REVERSAL");
    expect(reversals).toHaveLength(3);
    // Every cash debit nets to zero; comps and legacy sales wrote nothing.
    const cashDebitCents = w.ledger
      .entriesOfType("CASH_SALE_DEBIT")
      .reduce((s, e) => s + e.amountCents, 0);
    expect(reversals.reduce((s, e) => s + e.amountCents, 0)).toBe(
      cashDebitCents,
    );
    expect(cashDebitCents).toBe(3 * PRICED.debitCents);

    // Item stamps: the full fee and tax, as the till refund stamps them.
    expect(
      w.orders
        .get(CASH_A)!
        .items.map((i) => [i.refundedPlatformFeeCents, i.refundedTaxCents]),
    ).toEqual([
      [175, 261],
      [175, 261],
    ]);

    // Attributed to the cancellation on the audit trail and the ledger.
    const cancelRefunds = w.auditRows.filter(
      (r) => r.action === "pos_cash_refund" && r.data.via === "event_cancel",
    );
    expect(cancelRefunds.map((r) => r.entityId).sort()).toEqual(
      [...CASH_IDS].sort(),
    );
    expect(
      w.reversalsFor(CASH_A)[0]!.metadata as Record<string, unknown>,
    ).toMatchObject({ via: "event_cancel", actorHumanId: ACTOR_ID });

    // A free online order is not cash: left as the cancellation always left it.
    expect(w.orders.get(FREE_WEB)!.status).toBe("SUCCEEDED");

    // Cash buyers are phantom walk-ups: the cancellation notice's money-aware
    // cohort is the card buyer only, so no cash buyer is told "refunded".
    const [[notice]] = w.tx.eventChangeNotices.create.mock
      .calls as unknown as Array<
      [{ payload: { buyers: Array<{ humanId: string }> } }]
    >;
    expect(notice.payload.buyers.map((b) => b.humanId)).toEqual([
      w.orders.get(CARD_ID)!.buyerHumanId,
    ]);

    // A clean cancellation reports nothing, card path included.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a re-run writes nothing new: the replay returns the stored result, a new key is refused, the phase itself finds nothing", async () => {
    const w = await buildMix();
    const { deps } = cancelDeps(w);
    const first = await cancelEvent(deps, input());
    const ledgerRows = w.ledger.entries.length;
    const auditRows = w.auditRows.length;

    // Same key inside the TTL: the stored response, nothing re-run.
    await expect(cancelEvent(deps, input())).resolves.toEqual(first);
    // A fresh key: the event is already CANCELLED.
    await expect(
      cancelEvent(deps, input("cancel-cash-mix-key-2")),
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_CANCELLED" });
    // The phase on its own (a resumed run): every cash order is REFUNDED.
    const resumed = await refundCashOrdersForCancelledEvent(
      { repos: w.repos },
      { eventId: EVENT_ID, actorHumanId: ACTOR_ID, now: NOW, scope: "all" },
    );
    expect(resumed).toEqual({
      refundedCount: 0,
      failedCount: 0,
      scanFailed: false,
    });

    expect(w.ledger.entries).toHaveLength(ledgerRows);
    expect(w.auditRows).toHaveLength(auditRows);
  });

  it("one cash order failing is reported and counted; the rest are refunded; an Editor can finish it", async () => {
    const w = await buildMix();
    const { deps, reportError } = cancelDeps(w);
    w.failOnOrderIds.add(CASH_A);

    const out = await cancelEvent(deps, input());

    expect(out).toMatchObject({
      status: "CANCELLED",
      refundedCashOrderCount: CASH_IDS.length - 1,
      failedCashRefundCount: 1,
      cashRefundScanFailed: false,
    });
    // The failed order is untouched: still SUCCEEDED, its debit still owed.
    expect(w.orders.get(CASH_A)!.status).toBe("SUCCEEDED");
    expect(w.reversalsFor(CASH_A)).toHaveLength(0);
    // The others went through.
    expect(w.orders.get(CASH_B)!.status).toBe("REFUNDED");
    expect(w.reversalsFor(CASH_B)).toHaveLength(1);
    expect(w.orders.get(COMP_ID)!.status).toBe("REFUNDED");

    const reports = cashReports(reportError);
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { useCase: "cancelEvent", step: "refundCashOrders" },
      extra: { eventId: EVENT_ID, orderId: CASH_A },
    });

    // The recovery path: an Editor refunds it after the fact.
    w.failOnOrderIds.delete(CASH_A);
    w.setRole("EDITOR");
    const finished = await orgRefundCashSale(
      { repos: w.repos, authz: w.authz, clock: w.clock },
      { actorHumanId: ACTOR_ID, orgId: ORG_ID, orderId: CASH_A },
    );
    expect(finished.feeAndTaxNoLongerOwedCents).toBe(PRICED.debitCents);
    expect(w.reversalsFor(CASH_A)).toHaveLength(1);
  });

  it("a failed scan is reported and flagged, and the cancellation still succeeds", async () => {
    const w = await buildMix();
    const { deps, reportError } = cancelDeps(w);
    w.tx.orders.listSucceededCashOrderIdsForEvent.mockRejectedValueOnce(
      new Error("cash scan timed out"),
    );

    const out = await cancelEvent(deps, input());

    expect(out).toMatchObject({
      status: "CANCELLED",
      refundedCashOrderCount: 0,
      failedCashRefundCount: 0,
      cashRefundScanFailed: true,
    });
    const reports = cashReports(reportError);
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { step: "refundCashOrders.scan" },
    });
  });

  it("a throwing reporter does not change the outcome", async () => {
    const w = await buildMix();
    const { deps } = cancelDeps(w);
    deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    w.failOnOrderIds.add(CASH_A);

    await expect(cancelEvent(deps, input())).resolves.toMatchObject({
      failedCashRefundCount: 1,
      refundedCashOrderCount: CASH_IDS.length - 1,
    });
  });
});
