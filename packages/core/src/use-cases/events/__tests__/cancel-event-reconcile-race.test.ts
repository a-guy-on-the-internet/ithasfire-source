import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { OrderItemRecord, OrderRecord } from "@th/ports/repos/orders";
import type { Repos } from "@th/ports/repos";
import type { TxRepos } from "@th/ports/repos";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { reconcileStripeFullRefund } from "../../orders/reconcile-stripe-full-refund";
import { buildRefundMetadata } from "../../orders/_shared/dispute-refund-guard";
import {
  groupReversalsByPayee,
  writeRefundDebitsForOrder,
  writeTransferReversalCreditsForOrder,
} from "../../orders/_shared/write-refund-debits";

/**
 * Regression: the cancel-event × reconcile-webhook race that starved the
 * TRANSFER_REVERSAL_CREDIT (reviewer-confirmed BLOCKING).
 *
 * cancel-event holds the refund mutex only around its Stripe
 * reversal+refund per order, RELEASES it, and runs its ledger transaction
 * (debits + reversal credits — cancel-event.ts, the
 * `writeRefundDebitsForOrder` / `writeTransferReversalCreditsForOrder`
 * block) at the END, unguarded. The `charge.refunded` webhook that cancel's
 * own refund fires can land in that gap:
 *
 *   1. cancel reverses the payee's 9,500¢ transfer and refunds the buyer
 *      at Stripe (mutex held), then releases the mutex;
 *   2. the webhook's reconcile acquires the now-free mutex and commits a
 *      REFUND_DEBIT under ITS key. Since the fee-netting change the cancel
 *      refund withholds the Stripe fee (9,700¢ of a 10,000¢ charge), so
 *      Stripe reports it PARTIAL and the reconciler's PARTIAL arm runs:
 *      it debits the proportional 9,215¢ (= 9,700 × 9,500 / 10,000) and,
 *      because cancel stamped the item ids on the refund, flips the named
 *      item, voids its ticket, frees its seat and marks the order;
 *   3. cancel's ledger tx then recomputes `credit − Σ priors` (= 285¢),
 *      writes only that remainder — and under the OLD debit-linked pairing,
 *      `writeTransferReversalCreditsForOrder` paired against cancel's own
 *      debit alone (or, pre-netting, found `debits: []`), reported
 *      `reversal_without_debit` drift, and NEVER wrote the 9,500¢ credit.
 *      The payee had physically returned 9,500¢ via the Stripe reversal,
 *      the ledger said they owed it again → repaid twice. Invisible to
 *      verify-ledger: an UNDER-written reversal credit violates nothing.
 *
 * The fix (cross-key fallback pairing in
 * `writeTransferReversalCreditsForOrder`) heals EVERY ordering: the credit
 * clamps to `Σ all REFUND_DEBITs − Σ existing TRANSFER_REVERSAL_CREDITs`
 * per (order, payee) — whoever wrote the debit — preserving the
 * verify-ledger conservation invariant
 * (Σ reversal credits ≤ Σ refund debits per cell,
 * `listConservationViolations` in the prisma payee-ledger adapter).
 *
 * This test drives the REAL reconcile use case for step 2 and mirrors
 * cancel-event's exact ledger-tx calls for step 3 (cancel-event.ts itself is
 * owned by another workstream this round; the race lives entirely in the
 * ledger writers, which both paths share).
 */

const ORDER_ID = "77777777-7777-4777-8777-777777777777";
const ITEM_A = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const TICKET_A = "aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa";
const SEAT_A = "seat-c8";
const PAYEE_ID = "payee-organizer";
const NOW = new Date("2026-08-18T12:00:00.000Z");
// Buyer paid 10,000¢; Stripe's fee 300¢ → cancel refunds 9,700¢ (PARTIAL to
// Stripe). The payee's 9,500¢ credit scales to floor(9,700 × 9,500 / 10,000).
const BUYER_PAID_CENTS = 10_000;
const CANCEL_NET_REFUND_CENTS = 9_700;
const PARTIAL_ARM_DEBIT_CENTS = 9_215;

function makeItem(): OrderItemRecord {
  return {
    id: ITEM_A,
    orderId: ORDER_ID,
    kind: "ticket",
    ticketTypeId: "tt-1",
    qty: 1,
    unitPriceCents: 9500,
    amountCents: 9500,
    meta: { buyerTotalCents: BUYER_PAID_CENTS },
    paidOutAt: new Date("2026-08-01T00:00:00.000Z"),
    refundedAt: null,
    transferredAt: null,
    resaleListingId: null,
    resaleFaceValueCents: null,
    resaleProcessingPassThroughCents: 0,
    resaleProcessingFeeConfigRef: null,
    resaleSaleCutoffAt: null,
    resalePayoutReleaseAt: null,
    resalePayoutStatus: null,
    resalePayoutHeldAt: null,
    resalePayoutHoldReason: null,
    resalePayoutNoticeSentAt: null,
    resalePayoutReminderSentAt: null,
    resalePayoutFinalNoticeSentAt: null,
    status: "active",
  };
}

function makeOrder(): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: "event-1",
    buyerHumanId: "buyer-1",
    amountGrossCents: 9500,
    feesPlatformCents: 500,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_race",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2026-07-01T00:00:00.000Z"),
    paymentMethodType: "card",
    paidOutAt: new Date("2026-08-01T00:00:00.000Z"),
    parentOrderId: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    items: [makeItem()],
  } as OrderRecord;
}

function makeHarness() {
  const order = makeOrder();
  const payeeLedger = createFakePayeeLedgerRepo();
  const reportError = vi.fn();

  const txRepos = {
    orders: {
      getById: vi.fn(async () => order),
      markRefunded: vi.fn(async () => undefined),
    },
    orderItems: {
      updateStatus: vi.fn(async () => undefined),
      recordReleasedSeats: vi.fn(async () => undefined),
    },
    tickets: {
      listByOrderId: vi.fn(async () => []),
      // The partial arm voids the NAMED item's ticket and frees its seat.
      getByOrderItemId: vi.fn(async () => ({
        id: TICKET_A,
        orderItemId: ITEM_A,
        status: "VALID",
        seatId: SEAT_A,
      })),
      setStatus: vi.fn(async () => undefined),
      clearSeatAssignments: vi.fn(async () => undefined),
    },
    seats: { updateStatuses: vi.fn(async () => undefined) },
    feeWaivers: { release: vi.fn(async () => ({ releasedTickets: 0 })) },
    payeeLedger: payeeLedger.repo,
    splits: {
      getForOrder: vi.fn(async () => []),
    },
    promos: {
      releaseHoldsForOrder: vi.fn(async () => undefined),
    },
    audit: {
      log: vi.fn(async () => undefined),
    },
  };

  const repos = {
    orders: {
      findByPaymentIntent: vi.fn(async () => ({
        id: order.id,
        status: order.status,
      })),
      getById: vi.fn(async () => order),
    },
    tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<unknown>) =>
      fn(txRepos),
    ),
  } as unknown as Repos;

  const clock: ClockPort = { now: vi.fn(() => NOW) } as ClockPort;

  const idempotency = {
    begin: vi.fn(async () => true),
    commit: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    // Owner-checked release (refund-mutex.ts): compare-and-delete by token.
    release: vi.fn(async () => true),
    get: vi.fn(async () => null),
    run: vi.fn(),
    purgeExpired: vi.fn(async () => 0),
  } as unknown as IdempotencyPort;

  return { order, payeeLedger, txRepos, repos, clock, idempotency, reportError };
}

/**
 * Step 2 of the interleaving: the webhook's reconcile PARTIAL arm commits.
 * The refund is cancel's own (fee-withholding, so `refunded=false` on the
 * charge) and carries the metadata cancel-event stamps — this is the exact
 * shape a cancellation that died after its Stripe call leaves behind.
 */
async function runWebhookReconcile(h: ReturnType<typeof makeHarness>) {
  const getRefund = vi.fn(async ({ refundId }: { refundId: string }) => ({
    refundId,
    status: "succeeded" as const,
    amountCents: CANCEL_NET_REFUND_CENTS,
    paymentIntentId: "pi_race",
    metadata: buildRefundMetadata({
      useCase: "cancelEvent",
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    }),
  }));
  const result = await reconcileStripeFullRefund(
    {
      repos: h.repos,
      clock: h.clock,
      idempotency: h.idempotency,
      reportError: h.reportError,
      payments: { getRefund },
    },
    {
      paymentIntentId: "pi_race",
      amountRefundedCents: CANCEL_NET_REFUND_CENTS,
      refundId: "re_cancel",
      sourceEventType: "charge.refunded",
      fullyRefundedHint: false,
    },
  );
  expect(getRefund).toHaveBeenCalledWith({ refundId: "re_cancel" });
  return result;
}

/**
 * The partial arm reports `external_partial_refund_after_payout` for a
 * paid-out item (it cannot reverse anything itself — cancel already did).
 * That report is legitimate here; what must NOT fire is any ledger drift
 * report (`refund_ledger_reversal_without_debit` and friends).
 */
function reportedMessages(h: ReturnType<typeof makeHarness>): string[] {
  return h.reportError.mock.calls.map(([err]) =>
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * Step 3 of the interleaving: cancel-event's final ledger tx for this order
 * — the EXACT calls cancel-event.ts makes (debits keyed on its own Stripe
 * refund id, then reversal credits for the reversal it already performed).
 */
async function runCancelLedgerTx(h: ReturnType<typeof makeHarness>) {
  const tx = h.txRepos as unknown as Pick<TxRepos, "payeeLedger" | "splits">;
  const refundDebits = await writeRefundDebitsForOrder(tx, {
    order: { id: ORDER_ID, currency: "usd" },
    refundedItemIds: [ITEM_A],
    refundKey: "re_cancel",
    attemptedFullRefund: true,
    useCase: "cancelEvent",
    reportError: h.reportError,
  });
  const credits = await writeTransferReversalCreditsForOrder(tx, {
    order: { id: ORDER_ID, currency: "usd" },
    refundKey: "re_cancel",
    reversals: groupReversalsByPayee(
      [
        {
          orderItemId: ITEM_A,
          settlementId: null,
          payoutItemId: "payout-item-1",
          payeeId: PAYEE_ID,
          stripeTransferId: "tr_race",
          reversalId: "trr_race",
          reversedCents: 9500,
        },
      ],
      new Map(),
      { useCase: "cancelEvent", orderId: ORDER_ID, reportError: h.reportError },
    ),
    debits: refundDebits,
    useCase: "cancelEvent",
    reportError: h.reportError,
  });
  return { refundDebits, credits };
}

function cellSums(h: ReturnType<typeof makeHarness>) {
  const debits = h.payeeLedger
    .entriesOfType("REFUND_DEBIT")
    .filter((e) => e.payeeId === PAYEE_ID);
  const reversalCredits = h.payeeLedger
    .entriesOfType("TRANSFER_REVERSAL_CREDIT")
    .filter((e) => e.payeeId === PAYEE_ID);
  return {
    debits,
    reversalCredits,
    debitCents: debits.reduce((s, e) => s + e.amountCents, 0),
    reversalCreditCents: reversalCredits.reduce((s, e) => s + e.amountCents, 0),
  };
}

describe("cancel-event × reconcile webhook race (reversal-credit starvation)", () => {
  it("starved ordering: reconcile debits first, cancel's tx still writes the reversal credit via fallback pairing", async () => {
    const h = makeHarness();
    await h.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_ID,
      amountCents: 9500,
      items: { [ITEM_A]: 9500 },
    });

    // 1. cancel-event reversed the transfer + refunded the buyer at Stripe
    //    and RELEASED the mutex (no ledger writes yet — that phase is pure
    //    Stripe). 2. The webhook lands in the gap and commits first:
    const reconcile = await runWebhookReconcile(h);
    expect(reconcile.outcome).toBe("partial_refund_reconciled");
    expect(cellSums(h).debitCents).toBe(PARTIAL_ARM_DEBIT_CENTS);

    // The partial arm HEALED the dead cancellation from the stamped
    // metadata: item flipped (3-arg — the tax share died with cancel's
    // tx), ticket voided, seat released, order REFUNDED (a lone item;
    // cancelEvent's stamp also reads transferred siblings as terminal),
    // fee waiver + promo holds released.
    expect(h.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
    );
    expect(h.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_A,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(h.txRepos.seats.updateStatuses).toHaveBeenCalledWith(
      expect.objectContaining({ seatIds: [SEAT_A], status: "AVAILABLE" }),
    );
    expect(h.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      undefined,
    );
    expect(h.txRepos.feeWaivers.release).toHaveBeenCalledWith(ORDER_ID);
    expect(h.txRepos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(h.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stripe_partial_refund_reconciled",
        data: expect.objectContaining({
          namedOrderItemIds: [ITEM_A],
          flippedOrderItemIds: [ITEM_A],
          newOrderStatus: "REFUNDED",
          releasedSeatIds: [SEAT_A],
        }),
      }),
    );

    // 3. cancel-event's final ledger tx runs.
    const { refundDebits, credits } = await runCancelLedgerTx(h);

    // Cancel's own debit recomputes to the REMAINDER the proportional
    // partial-arm debit left (9,500 − 9,215)…
    expect(refundDebits).toHaveLength(1);
    expect(refundDebits[0]).toMatchObject({
      payeeId: PAYEE_ID,
      debitCents: 9500 - PARTIAL_ARM_DEBIT_CENTS,
    });

    // …and the reversal credit IS STILL WRITTEN for the FULL reversed
    // amount, paired cross-key across BOTH debits. Before the fix: credit
    // clamped to cancel's own debit (or, pre-netting, credits === []),
    // drift report fired, payee repaid twice.
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ payeeId: PAYEE_ID, creditCents: 9500 });

    const cell = cellSums(h);
    // Two debits that sum to the credit — no doubles.
    expect(cell.debits).toHaveLength(2);
    expect(cell.debitCents).toBe(9500);
    // The physically-reversed 9,500¢ is credited…
    expect(cell.reversalCreditCents).toBe(9500);
    // …pairing debits and reversal to net zero (spec §4.2)…
    expect(cell.debitCents - cell.reversalCreditCents).toBe(0);
    // …and the credit links to a debit row that actually exists.
    expect(cell.debits.map((d) => d.id)).toContain(
      cell.reversalCredits[0]!.relatedEntryId,
    );
    // Conservation invariant (verify-ledger `listConservationViolations`):
    // Σ reversal credits ≤ Σ refund debits per (order, payee).
    expect(cell.reversalCreditCents).toBeLessThanOrEqual(cell.debitCents);

    // No ledger DRIFT report — this is a healed ordering. The only report
    // is the partial arm's paid-out notice, which is not drift.
    expect(reportedMessages(h)).toEqual([
      "external_partial_refund_after_payout",
    ]);

    // Replaying cancel's ledger tx (crash-retry) changes nothing.
    const before = h.payeeLedger.entries.length;
    await runCancelLedgerTx(h);
    expect(h.payeeLedger.entries.length).toBe(before);
    expect(reportedMessages(h)).toEqual([
      "external_partial_refund_after_payout",
    ]);
  });

  it("normal ordering: cancel's tx first, the late webhook adds nothing", async () => {
    const h = makeHarness();
    await h.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_ID,
      amountCents: 9500,
      items: { [ITEM_A]: 9500 },
    });

    const { refundDebits, credits } = await runCancelLedgerTx(h);
    expect(refundDebits).toHaveLength(1);
    expect(credits).toHaveLength(1);

    const reconcile = await runWebhookReconcile(h);
    expect(reconcile.outcome).toBe("partial_refund_reconciled");

    const cell = cellSums(h);
    // The webhook's partial arm targets 9,215¢ against 9,500¢ of priors →
    // no second debit, no touched credits — and, having written no debit,
    // no paid-out notice either. Nothing reported at all.
    expect(cell.debits).toHaveLength(1);
    expect(cell.debitCents).toBe(9500);
    expect(cell.reversalCreditCents).toBe(9500);
    expect(reportedMessages(h)).toEqual([]);
  });

  it("genuinely debit-less reversal still reports reversal_without_debit (the report is not dead)", async () => {
    const h = makeHarness();
    // NO settlement credit and NO debit anywhere: a credit here would gift
    // the payee the reversed cents.
    const credits = await writeTransferReversalCreditsForOrder(
      h.txRepos as unknown as Pick<TxRepos, "payeeLedger">,
      {
        order: { id: ORDER_ID, currency: "usd" },
        refundKey: "re_cancel",
        reversals: [
          {
            payeeId: PAYEE_ID,
            reversedCents: 9500,
            reversalIds: ["trr_race"],
            stripeTransferIds: ["tr_race"],
          },
        ],
        debits: [],
        useCase: "cancelEvent",
        reportError: h.reportError,
      },
    );

    expect(credits).toEqual([]);
    expect(h.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT")).toEqual([]);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "refund_ledger_reversal_without_debit",
      }),
      expect.anything(),
    );
  });
});
