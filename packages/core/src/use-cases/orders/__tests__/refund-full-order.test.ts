import { describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type {
  PaymentProcessorPort,
  PaymentRefundStatus,
} from "@th/ports/payment-processor-port";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { OrdersRepo, OrderRecord } from "@th/ports/repos/orders";
import type {
  OrderItemsRepo,
  OrderItemRecord,
} from "@th/ports/repos/order-items";
import type { TicketsRepo, TicketRecord } from "@th/ports/repos/tickets";
import type { Repos } from "@th/ports/repos";
import type { AuditRepo } from "@th/ports/repos/audit";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { renderNotification } from "../../comms/renderers";
import { refundFullOrder } from "../refund-full-order";
import { staffRefundOrder } from "../staff-refund-order";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACTOR_ID = "99999999-9999-4999-8999-999999999999";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ORIGINAL_ORDER_ID = "33333333-3333-4333-8333-333333333333";
const ORIGINAL_ORDER_ITEM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TICKET_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const TICKET_2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const RESALE_LISTING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const NOW = new Date("2025-06-01T12:00:00.000Z");

function makeItems(overrides?: Partial<OrderItemRecord>[]): OrderItemRecord[] {
  const base: OrderItemRecord[] = [
    {
      id: ITEM_A,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: "tt-ga",
      qty: 1,
      unitPriceCents: 5000,
      amountCents: 5000,
      meta: { buyerTotalCents: 5500 },
      paidOutAt: null,
      refundedAt: null,
      transferredAt: null,
      status: "active",
    },
    {
      id: ITEM_B,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: "tt-ga",
      qty: 1,
      unitPriceCents: 5000,
      amountCents: 5000,
      meta: { buyerTotalCents: 5500 },
      paidOutAt: null,
      refundedAt: null,
      transferredAt: null,
      status: "active",
    },
  ];
  if (overrides) {
    overrides.forEach((o, i) => {
      if (base[i]) Object.assign(base[i], o);
    });
  }
  return base;
}

function makeOrder(partial: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: "event-1",
    buyerHumanId: ACTOR_ID,
    amountGrossCents: 10000,
    feesPlatformCents: 1000,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    parentOrderId: null,
    taxAmountCents: 0,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    paymentMethodType: null,
    items: makeItems(),
    ...partial,
  };
}

type FakeTicket = Pick<TicketRecord, "id" | "status" | "scannedAt"> & {
  seatId?: string | null;
};

function makeTickets(): Array<FakeTicket> {
  return [
    { id: TICKET_1, status: "VALID", scannedAt: null },
    { id: TICKET_2, status: "VALID", scannedAt: null },
  ];
}

function makeContext(opts?: {
  order?: OrderRecord | null;
  orderForTx?: OrderRecord | null;
  feeCents?: number;
  tickets?: Array<FakeTicket>;
  authAccounts?: Array<{
    providerId: string;
    accountId: string;
    createdAt: Date;
  }>;
  /** Event start (buyer refund window). Default: far after NOW. */
  eventStartsAt?: Date;
  /** Organizer's explicit refund cutoff (null = none). */
  eventRefundCutoffAt?: Date | null;
  /**
   * Ticket behind each order item (served by `tickets.getByOrderItemId` on
   * both the root and tx repos). Default: ITEM_A → TICKET_1 VALID, others
   * none — the legacy shape every older case in this file was written against.
   */
  ticketByItemId?: Record<string, TicketRecord | null>;
  /** Claim status per order item (served by `claims.getByOrderItemId`). */
  claimStatusByItemId?: Record<string, string>;
}) {
  const order = opts?.order ?? makeOrder();
  const orderForTx = opts?.orderForTx ?? order;
  const feeCents = opts?.feeCents ?? 300;
  const tickets = opts?.tickets ?? makeTickets();
  const eventStartsAt =
    opts?.eventStartsAt ?? new Date("2025-12-01T00:00:00.000Z");
  const eventRefundCutoffAt = opts?.eventRefundCutoffAt ?? null;
  const ticketByItemId: Record<string, TicketRecord | null> =
    opts?.ticketByItemId ?? {
      [ITEM_A]: {
        id: TICKET_1,
        ownerHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "VALID",
      } as TicketRecord,
    };
  const getTicketByOrderItemId = async (orderItemId: string) =>
    ticketByItemId[orderItemId] ?? null;

  // Default: buyer is a real, loginable account (one linked credential).
  // Tests that exercise the guest path override this to return [].
  const authAccounts = opts?.authAccounts ?? [
    {
      providerId: "credential",
      accountId: ACTOR_ID,
      createdAt: new Date("2025-01-01"),
    },
  ];

  const humansRepo: HumansRepo = {
    getById: vi.fn(async (id: string) =>
      id === ACTOR_ID || id === OTHER_ACTOR_ID ? { id } : null,
    ) as HumansRepo["getById"],
    // A loginable buyer has a VERIFIED email (B2: isLoginableBuyer).
    getByIdWithIdentity: vi.fn(async (id: string) => ({
      human: { id },
      identity: { emailVerified: true },
    })) as unknown as HumansRepo["getByIdWithIdentity"],
    listAuthAccounts: vi.fn(
      async () => authAccounts,
    ) as HumansRepo["listAuthAccounts"],
  } as HumansRepo;

  const ordersRepo: OrdersRepo = {
    listTaxLines: vi.fn(async () => []),
    getById: vi.fn(async (id: string) =>
      id === ORDER_ID ? order : null,
    ) as OrdersRepo["getById"],
    markRefunded: vi.fn(async () => {}),
  } as unknown as OrdersRepo;

  const orderItemsRepo: OrderItemsRepo = {
    updateStatus: vi.fn(async () => {}),
    setResaleListingId: vi.fn(async () => {}),
    // Ledger-era reversal amounts resolve item → order → credit attribution.
    getById: vi.fn(
      async (id: string) => order?.items.find((i) => i.id === id) ?? null,
    ),
  } as unknown as OrderItemsRepo;

  const ticketsRepo: TicketsRepo = {
    listByOrderId: vi.fn(async () => tickets),
    getByOrderItemId: vi.fn(getTicketByOrderItemId),
    setStatus: vi.fn(async () => true),
    transfer: vi.fn(async () => true),
    restoreAfterResale: vi.fn(async () => {}),
  } as unknown as TicketsRepo;

  const auditRepo: AuditRepo = {
    log: vi.fn(async () => {}),
  };

  const idempotency = createFakeIdempotencyPort();

  // In-memory payee ledger honoring real key-replay semantics — the refund
  // rule's debits/reversal credits are asserted against its entries.
  const payeeLedger = createFakePayeeLedgerRepo();

  const txRepos = {
    orders: {
      listTaxLines: vi.fn(async () => []),
      getById: vi.fn(async (id: string) =>
        id === ORDER_ID ? orderForTx : null,
      ),
      markRefunded: vi.fn(async () => {}),
    },
    orderItems: {
      updateStatus: vi.fn(async () => {}),
      setResaleListingId: vi.fn(async () => {}),
      // Seat history: the former seat is stamped onto the order item just
      // before the ticket's @unique `seatId` link is cleared.
      recordReleasedSeats: vi.fn(async () => {}),
    },
    tickets: {
      listByOrderId: vi.fn(async () => tickets),
      getByOrderItemId: vi.fn(getTicketByOrderItemId),
      // The resale unwind locks the ticket row, then looks for a live
      // listing of the refunded buyer's own.
      getByIdForUpdate: vi.fn(
        async (id: string) =>
          Object.values(ticketByItemId).find((t) => t.id === id) ?? null,
      ),
      setStatus: vi.fn(async () => true),
      transfer: vi.fn(async () => true),
      restoreAfterResale: vi.fn(async () => {}),
      clearSeatAssignments: vi.fn(async () => {}),
    },
    // Reserved seats of the tickets this refund kills go back on sale.
    seats: {
      updateStatuses: vi.fn(async () => {}),
      releaseSeats: vi.fn(async () => {}),
    },
    resaleListings: {
      getById: vi.fn(async () => ({
        id: RESALE_LISTING_ID,
        sellerHumanId: OTHER_ACTOR_ID,
        eventShareCents: 500, // priced under the share (a listing with none is closed, FR-015)
      })),
      getByTicketId: vi.fn(async () => null),
      unwindSale: vi.fn(async () => {}),
    },
    // NO `settlements` on the tx: the cancelFor* concepts are DELETED
    // (ledger-authoritative-settlement spec §7) — the refund rule writes
    // REFUND_DEBIT ledger entries instead, and leaving the settlements repo
    // unmocked makes any resurrected settlement mutation an immediate crash
    // rather than a silently-green spy.
    payeeLedger: payeeLedger.repo,
    // The refund-debit writer's partial-miss detector reads splits. Without
    // this fake the read throws, and that failure is now DRIFT-REPORTED
    // (missing_credit_detection_failed) instead of silently swallowed — so
    // a harness with no `splits` would fail every reportError count below.
    // Empty splits = nothing to compare = detection stays silent.
    splits: { getForOrder: vi.fn(async () => []) },
    promos: {
      releaseHoldsForOrder: vi.fn(async () => undefined),
    },
    feeWaivers: {
      release: vi.fn(async () => ({ releasedTickets: 0 })),
    },
    audit: { log: vi.fn(async () => {}) },
  };

  const repos: Repos = {
    humans: humansRepo,
    orders: ordersRepo,
    orderItems: orderItemsRepo,
    tickets: ticketsRepo,
    // Root-level ledger read: ledger-era reversal amounts derive from the
    // SETTLEMENT_CREDIT attribution (same fake instance as the tx repo, so
    // seeded credits are visible to both).
    payeeLedger: payeeLedger.repo,
    claims: {
      getByOrderItemId: vi.fn(async (id: string) => {
        const status = opts?.claimStatusByItemId?.[id];
        return status ? { id: `claim-${id}`, orderItemId: id, status } : null;
      }),
    },
    // The refund-debit writer's partial-miss detector reads splits. Without
    // this fake the read throws, and that failure is now DRIFT-REPORTED
    // (missing_credit_detection_failed) instead of silently swallowed — so
    // a harness with no `splits` would fail every reportError count below.
    // Empty splits = nothing to compare = detection stays silent.
    splits: { getForOrder: vi.fn(async () => []) },
    resaleListings: {
      getById: vi.fn(async () => ({
        id: RESALE_LISTING_ID,
        sellerHumanId: OTHER_ACTOR_ID,
        eventShareCents: 500, // priced under the share (a listing with none is closed, FR-015)
      })),
    },
    audit: auditRepo,
    events: {
      getById: vi.fn(async () => ({
        id: "event-1",
        orgId: "org-1",
        humanId: null,
        startsAt: eventStartsAt,
        refundCutoffAt: eventRefundCutoffAt,
      })),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: "payee-1" })),
      getById: vi.fn(async () => ({
        id: "payee-1",
        stripeAccountId: "acct_123",
      })),
    },
    // Ledger-era transfer resolution (tried FIRST by
    // reverseTransfersForItems). Default: no post-cutover payout covers the
    // items, so resolution falls through to the junction chain below —
    // which is exactly the pre-cutover behaviour the legacy tests assert.
    payoutItems: {
      listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
    },
    orderItemSettlementLines: {
      listByOrderItemIds: vi.fn(async (orderItemIds: string[]) =>
        orderItemIds.map((orderItemId) => ({
          id: `oisl-${orderItemId}`,
          orderItemId,
          settlementLineId: `sl-${orderItemId}`,
          amountCents: 5500,
        })),
      ),
    },
    settlementLines: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          settlementId: `settlement-${id}`,
        })),
      ),
    },
    settlements: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          payeeId: "payee-1",
          stripeTransferId: `tr_${id}`,
        })),
      ),
    },
    tx: vi.fn(async (fn: any) => fn(txRepos)),
  } as unknown as Repos;

  // STATEFUL Stripe-mirroring reversal fake: a transfer with a registered
  // capacity REJECTS any reversal whose cumulative total would exceed it;
  // a repeated idempotency key REPLAYS the original reversal on the same
  // amount and throws same-key-different-params on a different amount —
  // exactly what live Stripe does. Ledger-era tests register
  // `netAmountCents` as the capacity so a buyer-side (over-)request can
  // never pass green here while being impossible in production.
  // Unregistered transfer ids are unconstrained (legacy fixtures don't
  // model transfer amounts). `listTransferReversals` serves the retry-
  // recovery path from the same records; pre-seeded `reversedByTransfer`
  // entries model FOREIGN reversals (consumed capacity, no listed record).
  const transferCapacities = new Map<string, number>();
  const reversedByTransfer = new Map<string, number>();
  const transferReversalRecords = new Map<
    string,
    Array<{
      reversalId: string;
      amountCents: number;
      metadata: Record<string, string>;
    }>
  >();
  const reversalsByIdemKey = new Map<
    string,
    { reversalId: string; amountCents: number | null }
  >();
  let reversalSeq = 0;

  const refundRecords = new Map<
    string,
    Array<{
      refundId: string;
      amountCents: number;
      status: PaymentRefundStatus;
      metadata: Record<string, string>;
    }>
  >();

  const payments: PaymentProcessorPort = {
    getProcessingFeeForPaymentIntent: vi.fn(async () => ({
      feeCents,
      currency: "usd",
      paymentIntentId: "pi_123",
    })),
    // STATEFUL refund fake (money audit 2026-09-08 #10, retry pre-flight):
    // every refund the use case issues is recorded against its PaymentIntent
    // WITH the metadata it stamped, and `listRefundsForPaymentIntent` serves
    // those records back — exactly what `stripe.refunds.list` would return
    // to a retry after a crashed commit. Same constant id as before so the
    // legacy pins on "re_test_123" hold. `refundRecords` is exposed so a test
    // can pre-seed a refund from another path or another order.
    refundPaymentIntent: vi.fn(
      async (input: {
        paymentIntentId: string;
        amountCents?: number;
        metadata?: Record<string, string>;
      }) => {
        const records = refundRecords.get(input.paymentIntentId) ?? [];
        records.push({
          refundId: "re_test_123",
          amountCents: input.amountCents ?? 0,
          status: "succeeded",
          metadata: input.metadata ?? {},
        });
        refundRecords.set(input.paymentIntentId, records);
        return { refundId: "re_test_123", status: "succeeded" as const };
      },
    ),
    listRefundsForPaymentIntent: vi.fn(
      async (input: { paymentIntentId: string }) => [
        ...(refundRecords.get(input.paymentIntentId) ?? []),
      ],
    ),
    reverseTransfer: vi.fn(
      async (input: {
        transferId: string;
        amountCents?: number;
        metadata?: Record<string, string>;
        idempotencyKey?: string;
      }) => {
        if (input.idempotencyKey) {
          const prior = reversalsByIdemKey.get(input.idempotencyKey);
          if (prior) {
            if (prior.amountCents !== (input.amountCents ?? null)) {
              throw new Error(
                `stripe_idempotency_error_same_key_different_params:${input.idempotencyKey}`,
              );
            }
            return { reversalId: prior.reversalId };
          }
        }
        const capacity = transferCapacities.get(input.transferId);
        const already = reversedByTransfer.get(input.transferId) ?? 0;
        const requested =
          input.amountCents ?? (capacity !== undefined ? capacity - already : 0);
        if (capacity !== undefined) {
          if (already + requested > capacity) {
            throw new Error(
              `stripe_transfer_reversal_exceeds_amount:${input.transferId}:${already + requested}>${capacity}`,
            );
          }
          reversedByTransfer.set(input.transferId, already + requested);
        }
        const reversalId = `trr_test_${++reversalSeq}`;
        const records = transferReversalRecords.get(input.transferId) ?? [];
        records.push({
          reversalId,
          amountCents: requested,
          metadata: input.metadata ?? {},
        });
        transferReversalRecords.set(input.transferId, records);
        if (input.idempotencyKey) {
          reversalsByIdemKey.set(input.idempotencyKey, {
            reversalId,
            amountCents: input.amountCents ?? null,
          });
        }
        return { reversalId };
      },
    ),
    // Live-Stripe mirror for the remaining-capacity pre-flight: reads the
    // SAME cumulative tracking the reversal fake enforces, so what the
    // pre-flight reports is exactly what a reversal could still take.
    // Unregistered transfers report unbounded capacity (legacy fixtures
    // don't model transfer amounts — and the legacy arm never reads this).
    getTransfer: vi.fn(async (input: { transferId: string }) => ({
      amountCents:
        transferCapacities.get(input.transferId) ?? Number.MAX_SAFE_INTEGER,
      amountReversedCents: reversedByTransfer.get(input.transferId) ?? 0,
    })),
    listTransferReversals: vi.fn(
      async (input: { transferId: string }) =>
        transferReversalRecords.get(input.transferId) ?? [],
    ),
  } as unknown as PaymentProcessorPort;

  const clock: ClockPort = {
    now: vi.fn(() => NOW),
  } as unknown as ClockPort;

  const notify = vi.fn(
    async (_input: { idempotencyKey?: string; variant?: string }) =>
      ({}) as never,
  );

  return {
    repos,
    payments,
    idempotency,
    clock,
    txRepos,
    notify,
    payeeLedger,
    transferCapacities,
    reversedByTransfer,
    refundRecords,
  };
}

function makeDeps(
  ctx: ReturnType<typeof makeContext>,
  opts?: { withNotify?: boolean },
) {
  return {
    repos: ctx.repos,
    payments: ctx.payments,
    idempotency: ctx.idempotency,
    clock: ctx.clock,
    ...(opts?.withNotify ? { notify: ctx.notify } : {}),
  };
}

/**
 * Staff / org path (`_skipBuyerCheck`). Paid-out items are refundable ONLY
 * here — buyer refunds stop at payout (docs/decisions/buyer-refunds-stop-at-
 * payout.md) — so every transfer-reversal case below runs as staff. The
 * reversal mechanics and amounts are unchanged from when the buyer path
 * could reach them.
 */
function staffDeps(ctx: ReturnType<typeof makeContext>) {
  return { ...makeDeps(ctx), _skipBuyerCheck: true as const };
}

describe("refundFullOrder", () => {
  // ── Happy path: all items active ────────────────────────────────────────

  it("refunds all active items and returns REFUNDED status", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out.ok).toBe(true);
    expect(out.orderId).toBe(ORDER_ID);
    expect(out.refundId).toBe("re_test_123");
    expect(out.currency).toBe("usd");
    expect(out.newOrderStatus).toBe("REFUNDED");

    // amountPaidCents = sum of buyerTotalCents = 5500 + 5500 = 11000
    expect(out.amountPaidCents).toBe(11000);
    // Stripe fees are reported for audit purposes and withheld from the refund.
    expect(out.stripeFeeCents).toBe(300);
    // Refund withholds only the Stripe fee: 11000 - 300 = 10700.
    expect(out.refundedCents).toBe(10700);

    expect(out.refundedItems).toHaveLength(2);
    // Stripe fee 300 split evenly across the two equal items: 150 each.
    expect(out.refundedItems[0]).toEqual({
      orderItemId: ITEM_A,
      refundedCents: 5350,
    });
    expect(out.refundedItems[1]).toEqual({
      orderItemId: ITEM_B,
      refundedCents: 5350,
    });
    expect(out.skippedItems).toHaveLength(0);

    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_123",
        amountCents: 10700,
      }),
    );

    // When all items are terminal, markRefunded is called without partialCents
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      undefined,
    );

    // Each refundable item is individually marked refunded, carrying the tax
    // portion of its refund (0 here — this order has no tax) and the
    // platform-fee portion (500 each — 1000 over two equal legacy items).
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(2);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      500,
    );
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_B,
      "refunded",
      NOW,
      0,
      500,
    );

    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        entityId: ORDER_ID,
        action: "refunded",
      }),
    );
  });

  // ── Money audit 2026-09-08 #19 ────────────────────────────────────────────
  // `classifyRefundItem` judged the items OUTSIDE the transaction and Stripe
  // has already moved the money by the time the flip runs. A gift or an email
  // claim that committed in that window WON the row. The refund must not fail
  // late — the money really did move — but the anomaly (somebody holds a pass
  // for a ticket that was simultaneously refunded) has to reach a human.
  it("still refunds — and reports — an item a transfer grabbed between the quote and the commit", async () => {
    const order = makeOrder();
    const racedOrder: OrderRecord = {
      ...order,
      items: order.items.map((item) =>
        item.id === ITEM_A
          ? { ...item, status: "transferred" as const, transferredAt: NOW }
          : item,
      ),
    };
    const ctx = makeContext({ order, orderForTx: racedOrder, feeCents: 300 });
    const reportError = vi.fn();

    const out = await refundFullOrder(
      { ...makeDeps(ctx), reportError },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    // Amounts identical to the un-raced happy path above — the race changes
    // nothing about what the buyer was paid back.
    expect(out.ok).toBe(true);
    expect(out.refundedCents).toBe(10700);
    expect(out.refundedItems).toEqual([
      { orderItemId: ITEM_A, refundedCents: 5350 },
      { orderItemId: ITEM_B, refundedCents: 5350 },
    ]);

    // The raced item is STILL marked refunded: that is what actually happened,
    // and the ticket-void step kills the pass the recipient was given.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      500,
    );

    const raced = reportError.mock.calls.filter(
      ([err]) => (err as Error | undefined)?.message === "refund_item_raced_after_quote",
    );
    expect(raced).toHaveLength(1);
    expect(raced[0]![1]).toEqual({
      tags: {
        useCase: "refundFullOrder",
        step: "markItemsRefunded",
        reason: "item_not_active_at_commit",
      },
      extra: {
        orderId: ORDER_ID,
        racedItems: [{ orderItemId: ITEM_A, status: "transferred" }],
      },
    });
  });

  it("reports no race when the items are still active at commit", async () => {
    const ctx = makeContext({ feeCents: 300 });
    const reportError = vi.fn();

    await refundFullOrder(
      { ...makeDeps(ctx), reportError },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    expect(
      reportError.mock.calls.filter(
        ([err]) => (err as Error | undefined)?.message === "refund_item_raced_after_quote",
      ),
    ).toHaveLength(0);
  });

  // ── Uniform refund rule across fee modes ────────────────────────────────

  it("ABSORB: refund equals amountPaid minus the Stripe fee", async () => {
    // $35 ticket + $0.50 platform, no tax, ABSORB (buyer paid 3500).
    const items = makeItems([
      {
        unitPriceCents: 3500,
        amountCents: 3500,
        meta: { buyerTotalCents: 3500 },
      },
    ]).slice(0, 1);
    const order = makeOrder({
      amountGrossCents: 3500,
      feesPlatformCents: 50,
      feePolicySnapshot: { feeMode: "ABSORB" },
      items,
    });
    const ctx = makeContext({ order, feeCents: 132 });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    // ABSORB: buyer paid 3500 (platform absorbed). Refund 3500 - 132 = 3368.
    expect(out.amountPaidCents).toBe(3500);
    expect(out.stripeFeeCents).toBe(132);
    expect(out.refundedCents).toBe(3500 - 132);
    expect(out.refundedCents).toBe(out.amountPaidCents - out.stripeFeeCents);
  });

  it("PASS_THROUGH: refund equals amountPaid minus the Stripe fee (platform refunded)", async () => {
    // $35 ticket + $0.50 platform, no tax, PASS_THROUGH (buyer paid 3550 + fee).
    const items = makeItems([
      {
        unitPriceCents: 3500,
        amountCents: 3500,
        meta: {
          buyerTotalCents: 3550,
          effectiveFeeMode: "PASS_THROUGH",
          platformFeePerTicketCents: 50,
        },
      },
    ]).slice(0, 1);
    const order = makeOrder({
      amountGrossCents: 3500,
      feesPlatformCents: 50,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items,
    });
    const ctx = makeContext({ order, feeCents: 137 });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    // PASS_THROUGH: buyer paid 3550 (ticket + platform). Refund 3550 - 137 = 3413.
    // The platform fee is refunded; only the Stripe fee is withheld.
    expect(out.amountPaidCents).toBe(3550);
    expect(out.stripeFeeCents).toBe(137);
    expect(out.refundedCents).toBe(3550 - 137);
    expect(out.refundedCents).toBe(out.amountPaidCents - out.stripeFeeCents);
  });

  // ── Transferred item handling ───────────────────────────────────────────

  it("skips transferred items and refunds the rest (REFUNDED when all terminal)", async () => {
    // Item B is transferred — should be skipped, Item A refunded.
    // Both items are now terminal (refunded + transferred) → REFUNDED status.
    const items = makeItems([
      {},
      { status: "transferred", transferredAt: new Date() },
    ]);
    const order = makeOrder({ items });
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out.ok).toBe(true);
    expect(out.newOrderStatus).toBe("REFUNDED");

    // Only Item A is refunded
    expect(out.refundedItems).toHaveLength(1);
    expect(out.refundedItems[0]!.orderItemId).toBe(ITEM_A);

    // Item B is skipped
    expect(out.skippedItems).toHaveLength(1);
    expect(out.skippedItems[0]).toEqual({
      orderItemId: ITEM_B,
      reason: "already_transferred",
    });

    // Refund = Item A's buyer-paid (5500) minus its allocated Stripe fee share.
    // Fee 300 is allocated across both ticket items (5500 each) → 150 to Item A.
    expect(out.refundedCents).toBe(5350);

    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5350 }),
    );

    // Only Item A's order item status is updated. Its platform-fee share is
    // still its OWN 500 (allocated over both ticket items, not just the
    // refunded one), so the kept item's 500 stays unstamped and Σ stamps ≤
    // feesPlatformCents.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      500,
    );
  });

  it("detects transferred via transferredAt even when status is still active", async () => {
    const items = makeItems([{}, { transferredAt: new Date() }]);
    const order = makeOrder({ items });
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out.skippedItems).toEqual([
      { orderItemId: ITEM_B, reason: "already_transferred" },
    ]);
    expect(out.refundedItems).toHaveLength(1);
  });

  it("throws no_refundable_items when all items are transferred", async () => {
    const items = makeItems([
      { status: "transferred", transferredAt: new Date() },
      { status: "transferred", transferredAt: new Date() },
    ]);
    const order = makeOrder({ items });
    const ctx = makeContext({ order });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "NO_REFUNDABLE_ITEMS" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("fails fast when a primary order still has a resale-linked transferred leg", async () => {
    const items = makeItems([
      {},
      {
        status: "transferred",
        transferredAt: new Date(),
        resaleListingId: null,
        meta: {
          buyerTotalCents: 5500,
          resaleListingId: RESALE_LISTING_ID,
        },
      },
    ]);
    const order = makeOrder({ items });
    const ctx = makeContext({ order });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "primary_order_resale_linked_transfer_requires_manual_review",
    });

    expect(
      ctx.payments.getProcessingFeeForPaymentIntent,
    ).not.toHaveBeenCalled();
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  // ── Auth guard tests ────────────────────────────────────────────────────

  it("throws not_found when actor is not the order buyer", async () => {
    const order = makeOrder({
      buyerHumanId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    });
    const ctx = makeContext({ order });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: OTHER_ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(
      ctx.payments.getProcessingFeeForPaymentIntent,
    ).not.toHaveBeenCalled();
  });

  it("skips buyer check when _skipBuyerCheck is set (staff path)", async () => {
    // Order belongs to a different buyer, but _skipBuyerCheck bypasses the guard
    const order = makeOrder({
      buyerHumanId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    });
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await refundFullOrder(
      { ...makeDeps(ctx), _skipBuyerCheck: true },
      { actorHumanId: OTHER_ACTOR_ID, orderId: ORDER_ID },
    );

    expect(out.ok).toBe(true);
    expect(out.refundedCents).toBeGreaterThan(0);
  });

  it("returns the cached refund response for a successful retry", async () => {
    const cachedResponse = {
      ok: true as const,
      orderId: ORDER_ID,
      refundId: "re_cached_123",
      currency: "usd",
      amountPaidCents: 11000,
      stripeFeeCents: 300,
      refundedCents: 11000,
      refundedItems: [
        { orderItemId: ITEM_A, refundedCents: 5500 },
        { orderItemId: ITEM_B, refundedCents: 5500 },
      ],
      skippedItems: [],
      newOrderStatus: "REFUNDED" as const,
    };
    const ctx = makeContext({ order: makeOrder({ status: "REFUNDED" }) });

    ctx.idempotency.__store.set(`order:refund-full:${ORDER_ID}`, {
      payloadHash: "",
      response: cachedResponse,
    });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out).toEqual(cachedResponse);
    // The per-order refund mutex begins (and releases) its own `refund-op:`
    // key even on a replay; the USE-CASE record must not be re-claimed.
    expect(ctx.idempotency.__mocks.begin).not.toHaveBeenCalledWith(
      `order:refund-full:${ORDER_ID}`,
      expect.anything(),
    );
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(
      ctx.payments.getProcessingFeeForPaymentIntent,
    ).not.toHaveBeenCalled();
  });

  it("does not leak a cached refund replay to a different actor", async () => {
    const ctx = makeContext();

    ctx.idempotency.__store.set(`order:refund-full:${ORDER_ID}`, {
      payloadHash: "",
      response: {
        ok: true,
        orderId: ORDER_ID,
        refundId: "re_cached_123",
        currency: "usd",
        amountPaidCents: 11000,
        stripeFeeCents: 300,
        refundedCents: 11000,
        refundedItems: [
          { orderItemId: ITEM_A, refundedCents: 5500 },
          { orderItemId: ITEM_B, refundedCents: 5500 },
        ],
        skippedItems: [],
        newOrderStatus: "REFUNDED",
      },
    });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: OTHER_ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });

    expect(ctx.idempotency.__mocks.get).not.toHaveBeenCalled();
  });

  it("threads stable provider idempotency keys through transfer reversal and refund (staff path: buyer refunds stop at payout)", async () => {
    const order = makeOrder({
      items: makeItems([{ paidOutAt: NOW }, {}]),
    });
    const ctx = makeContext({ order, feeCents: 300 });

    await refundFullOrder(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: `tr_settlement-sl-${ITEM_A}`,
        idempotencyKey: `order:refund-full:${ORDER_ID}:reverse-transfer:tr_settlement-sl-${ITEM_A}`,
      }),
    );
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `order:refund-full:${ORDER_ID}:refund-payment-intent`,
      }),
    );
    expect(ctx.idempotency.__mocks.commit).toHaveBeenCalledWith(
      `order:refund-full:${ORDER_ID}`,
      expect.objectContaining({
        response: expect.objectContaining({
          refundId: "re_test_123",
        }),
      }),
    );
  });

  it("does not mutate refund state when Stripe reports a failed refund", async () => {
    const ctx = makeContext({ feeCents: 300 });
    (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      refundId: "re_failed_123",
      status: "failed",
    });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      message: "refund_not_succeeded",
      refundStatus: "failed",
    });

    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.idempotency.__mocks.commit).not.toHaveBeenCalled();
    // Released, not failed (lib/idempotency-claim.ts): the same-key retry
    // re-sends the same Stripe key and gets the same refund back.
    expect(ctx.idempotency.__mocks.release).toHaveBeenCalledWith(
      `order:refund-full:${ORDER_ID}`,
      expect.any(String),
    );
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
  });

  // ── markOrderTicketsRefunded behaviour ──────────────────────────────────

  it("only marks VALID/SCANNED tickets as REFUNDED", async () => {
    const tickets: Array<Pick<TicketRecord, "id" | "status" | "scannedAt">> = [
      { id: TICKET_1, status: "VALID", scannedAt: null },
      { id: TICKET_2, status: "INVALID", scannedAt: null },
    ];
    const ctx = makeContext({ feeCents: 300, tickets });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    const setStatusCalls = (
      ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(setStatusCalls).toHaveLength(1);
    expect(setStatusCalls[0]![0]).toBe(TICKET_1);
    expect(setStatusCalls[0]![1]).toBe("REFUNDED");
  });

  it("skips already-REFUNDED tickets in markOrderTicketsRefunded", async () => {
    const tickets: Array<Pick<TicketRecord, "id" | "status" | "scannedAt">> = [
      { id: TICKET_1, status: "REFUNDED", scannedAt: null },
      { id: TICKET_2, status: "VALID", scannedAt: null },
    ];
    const ctx = makeContext({ feeCents: 300, tickets });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    const setStatusCalls = (
      ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(setStatusCalls).toHaveLength(1);
    expect(setStatusCalls[0]![0]).toBe(TICKET_2);
  });

  // ── Reserved seats ──────────────────────────────────────────────────────
  // A refunded seated ticket used to lock its seat FOREVER: mint stamped the
  // seat SOLD and the ticket's `seatId`, and no refund path ever set either
  // back. The seat became unsellable inventory, silently — the next buyer
  // just saw `seat_unavailable`.

  const SEAT_1 = "5ea70001-0000-4000-8000-000000000001";
  const SEAT_2 = "5ea70002-0000-4000-8000-000000000002";

  it("returns the seats of the tickets it refunds", async () => {
    const tickets: FakeTicket[] = [
      { id: TICKET_1, status: "VALID", scannedAt: null, seatId: SEAT_1 },
      { id: TICKET_2, status: "VALID", scannedAt: null, seatId: SEAT_2 },
    ];
    const ctx = makeContext({ feeCents: 300, tickets });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    // The dead tickets let go of their seats (`Ticket.seatId` is @unique —
    // otherwise the next buyer's MINT fails after they are charged) …
    expect(ctx.txRepos.tickets.clearSeatAssignments).toHaveBeenCalledWith([
      TICKET_1,
      TICKET_2,
    ]);
    // … and the seats go back on sale. `updateStatuses`, not `releaseSeats`:
    // these seats are SOLD and `releaseSeats` is HELD-gated, so it would
    // silently no-op and leave them locked.
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_1, SEAT_2],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    expect(ctx.txRepos.seats.releaseSeats).not.toHaveBeenCalled();
  });

  it("does NOT free the seat of a ticket this refund KEPT", async () => {
    // ITEM_B's ticket is SCANNED and the actor is the buyer, so that item is
    // skipped (`already_scanned`) and its ticket stays live — it is a real
    // attendee sitting in seat 2.
    const tickets: FakeTicket[] = [
      { id: TICKET_1, status: "VALID", scannedAt: null, seatId: SEAT_1 },
      { id: TICKET_2, status: "SCANNED", scannedAt: NOW, seatId: SEAT_2 },
    ];
    const ctx = makeContext({
      feeCents: 300,
      tickets,
      ticketByItemId: {
        [ITEM_A]: {
          id: TICKET_1,
          ownerHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_A,
          status: "VALID",
          seatId: SEAT_1,
        } as TicketRecord,
        [ITEM_B]: {
          id: TICKET_2,
          ownerHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_B,
          status: "SCANNED",
          seatId: SEAT_2,
        } as TicketRecord,
      },
    });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.txRepos.tickets.clearSeatAssignments).toHaveBeenCalledWith([
      TICKET_1,
    ]);
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_1],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
  });

  it("touches no seat for a GA order", async () => {
    const ctx = makeContext({ feeCents: 300 });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.txRepos.seats.updateStatuses).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.clearSeatAssignments).not.toHaveBeenCalled();
  });

  it("records the released seats on the refund audit row", async () => {
    const tickets: FakeTicket[] = [
      { id: TICKET_1, status: "VALID", scannedAt: null, seatId: SEAT_1 },
      { id: TICKET_2, status: "VALID", scannedAt: null, seatId: SEAT_2 },
    ];
    const ctx = makeContext({ feeCents: 300, tickets });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        action: "refunded",
        data: expect.objectContaining({
          releasedSeatIds: [SEAT_1, SEAT_2],
        }),
      }),
    );
  });

  it("does NOT free — or kill — the seat of a ticket this order GIFTED away", async () => {
    // REGRESSION, double sell. A buys two seats and gifts the second; the
    // email claim stamps ITEM_B `transferred` and moves only the ticket's
    // OWNER, so TICKET_2 still carries this order's `orderId` and still reads
    // VALID. A then asks for a full refund.
    //
    // A is refunded for ITEM_A only — ITEM_B is `already_transferred` and is
    // skipped, so no money comes back for it. The voiding loop is NOT
    // quote-driven, so before the fix it flipped TICKET_2 REFUNDED anyway
    // (killing B's pass) and then handed SEAT_2 back to the pool, where it was
    // sold to a third buyer: two claims on one seat, the org paid twice for
    // it, and A never refunded.
    const items = makeItems([{}, { status: "transferred", transferredAt: NOW }]);
    const order = makeOrder({ items });
    const tickets: FakeTicket[] = [
      { id: TICKET_1, status: "VALID", scannedAt: null, seatId: SEAT_1 },
      { id: TICKET_2, status: "VALID", scannedAt: null, seatId: SEAT_2 },
    ];
    const ctx = makeContext({
      order,
      feeCents: 300,
      tickets,
      ticketByItemId: {
        [ITEM_A]: {
          id: TICKET_1,
          ownerHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_A,
          status: "VALID",
          seatId: SEAT_1,
        } as TicketRecord,
        [ITEM_B]: {
          id: TICKET_2,
          // Already the recipient's.
          ownerHumanId: OTHER_ACTOR_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_B,
          status: "VALID",
          seatId: SEAT_2,
        } as TicketRecord,
      },
    });

    const result = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    // The gift was not refunded …
    expect(result.refundedItems.map((i) => i.orderItemId)).toEqual([ITEM_A]);
    expect(result.skippedItems).toEqual([
      { orderItemId: ITEM_B, reason: "already_transferred" },
    ]);

    // … so the recipient's pass survives …
    const setStatusCalls = (
      ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(setStatusCalls.map((c) => c[0])).toEqual([TICKET_1]);

    // … and its seat is neither unlinked nor put back on sale.
    expect(ctx.txRepos.tickets.clearSeatAssignments).toHaveBeenCalledWith([
      TICKET_1,
    ]);
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_1],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refunded",
        data: expect.objectContaining({ releasedSeatIds: [SEAT_1] }),
      }),
    );
  });

  // ── Other rejection tests ───────────────────────────────────────────────

  it("throws conflict when order is already refunded", async () => {
    const order = makeOrder({ status: "REFUNDED" });
    const ctx = makeContext({ order });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "ORDER_ALREADY_REFUNDED" });
  });

  it("throws not_found when actor does not exist", async () => {
    const unknownActor = "deadbeef-dead-4ead-8ead-deadbeefbeef";
    const ctx = makeContext();

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: unknownActor,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_FOUND" });
  });

  // ── Tax handling ────────────────────────────────────────────────────────

  it("includes order-level tax in refund amount", async () => {
    // 2 items × 5500 = 11000 item total, tax = 1100 → orderTotalPaidCents = 12100
    const order = makeOrder({ taxAmountCents: 1100 });
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out.ok).toBe(true);
    // amountPaidCents includes tax
    expect(out.amountPaidCents).toBe(12100);
    expect(out.stripeFeeCents).toBe(300);
    // Refund includes tax and platform fee, withholding only the Stripe fee:
    // 12100 - 300 = 11800.
    expect(out.refundedCents).toBe(11800);

    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_123",
        amountCents: 11800,
      }),
    );
  });

  // ── Promo hold release ─────────────────────────────────────────────────

  it("releases promo holds inside the refund transaction", async () => {
    const ctx = makeContext({ feeCents: 300 });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.txRepos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
  });

  it("refuses a buyer's full refund with CLAIM_REFUND_PENDING while an approved resale claim's refund is pending, before any Stripe call or write", async () => {
    const resaleOrder = makeOrder({
      source: "RESALE",
      parentOrderId: ORIGINAL_ORDER_ID,
      items: [
        {
          ...makeItems()[0],
          resaleListingId: RESALE_LISTING_ID,
          meta: { buyerTotalCents: 5500, resaleListingId: RESALE_LISTING_ID },
        },
      ],
    });
    const ctx = makeContext({
      order: resaleOrder,
      orderForTx: resaleOrder,
      claimStatusByItemId: { [ITEM_A]: "approved" },
    });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "CLAIM_REFUND_PENDING" });
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("does not refuse on a claim that is still undecided or denied", async () => {
    const resaleOrder = makeOrder({
      source: "RESALE",
      parentOrderId: ORIGINAL_ORDER_ID,
      items: [
        {
          ...makeItems()[0],
          resaleListingId: RESALE_LISTING_ID,
          meta: { buyerTotalCents: 5500, resaleListingId: RESALE_LISTING_ID },
        },
      ],
    });
    for (const status of ["open", "denied"]) {
      const ctx = makeContext({
        order: resaleOrder,
        orderForTx: resaleOrder,
        claimStatusByItemId: { [ITEM_A]: status },
      });
      await expect(
        refundFullOrder(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
        }),
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it("unwinds resale orders back to the seller instead of marking tickets refunded", async () => {
    const resaleItems = [
      {
        ...makeItems()[0],
        resaleListingId: RESALE_LISTING_ID,
        meta: {
          buyerTotalCents: 5500,
          resaleListingId: RESALE_LISTING_ID,
          resaleOriginalOrderId: ORIGINAL_ORDER_ID,
          resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
        },
      },
    ];
    const resaleOrder = makeOrder({
      source: "RESALE",
      parentOrderId: ORIGINAL_ORDER_ID,
      items: resaleItems,
    });
    const ctx = makeContext({
      order: resaleOrder,
      orderForTx: resaleOrder,
      feeCents: 300,
    });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "LISTED",
      { expectedStatus: "VALID" },
    );
    expect(ctx.txRepos.tickets.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_1,
        fromHumanId: ACTOR_ID,
        toHumanId: OTHER_ACTOR_ID,
        reason: "admin",
        orderId: ORDER_ID,
      }),
    );
    expect(ctx.txRepos.tickets.restoreAfterResale).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_1,
        restoredOrderId: ORIGINAL_ORDER_ID,
        restoredOrderItemId: ORIGINAL_ORDER_ITEM_ID,
      }),
    );
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ORIGINAL_ORDER_ITEM_ID,
      "active",
      NOW,
    );
    expect(ctx.txRepos.orderItems.setResaleListingId).toHaveBeenCalledWith(
      ORIGINAL_ORDER_ITEM_ID,
      RESALE_LISTING_ID,
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "LISTED",
      { expectedStatus: "VALID" },
    );
    expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
      RESALE_LISTING_ID,
      ORDER_ID,
      "ACTIVE",
    );
  });

  // organiser-resale-share FR-015: refunding a sale whose listing was priced
  // under the removed markup split closes the listing, and the seller is told
  // AFTER the refund commits. The notice can never undo or block the refund.
  describe("a resale sale priced under the removed markup split", () => {
    function legacyResaleContext() {
      const resaleOrder = makeOrder({
        source: "RESALE",
        parentOrderId: ORIGINAL_ORDER_ID,
        items: [
          {
            ...makeItems()[0],
            resaleListingId: RESALE_LISTING_ID,
            meta: {
              buyerTotalCents: 5500,
              resaleListingId: RESALE_LISTING_ID,
              resaleOriginalOrderId: ORIGINAL_ORDER_ID,
              resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
            },
          },
        ],
      });
      const ctx = makeContext({
        order: resaleOrder,
        orderForTx: resaleOrder,
        feeCents: 300,
      });
      (ctx.txRepos.resaleListings.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: RESALE_LISTING_ID,
        sellerHumanId: OTHER_ACTOR_ID,
        eventId: "event-1",
        status: "SOLD",
        buyerOrderId: ORDER_ID,
        expiresAt: null,
        saleCutoffAt: null,
        eventShareCents: null,
        askPriceCents: 5000,
        currency: "usd",
      });
      const create = vi.fn(async () => ({ id: "n-1" }));
      Object.assign(ctx.repos, { notifications: { create } });
      const reportError = vi.fn();
      const deps = {
        ...makeDeps(ctx),
        publicAppUrl: "https://ithas.fire",
        reportError,
      };
      return { ctx, deps, create, reportError };
    }
    const relistHref = `https://ithas.fire/sell/listings/new?orderId=${ORIGINAL_ORDER_ID}`;

    it("closes the listing and tells the seller after the refund commits", async () => {
      const h = legacyResaleContext();

      const out = await refundFullOrder(h.deps, {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.newOrderStatus).toBe("REFUNDED");
      expect(h.ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
        RESALE_LISTING_ID,
        ORDER_ID,
        "CANCELLED",
      );
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.create).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: OTHER_ACTOR_ID,
          title: "Your resale was refunded",
          metadata: { variant: "resale.sale-refunded-listing-closed" },
          action: { label: "List it again", href: relistHref },
        }),
      );
      // Written after the commit, never inside the refund's transaction.
      expect(
        h.create.mock.invocationCallOrder[0]!,
      ).toBeGreaterThan(
        h.ctx.idempotency.__mocks.commit.mock.invocationCallOrder[0]!,
      );
    });

    it("a notice that fails to write leaves the refund committed, and is reported", async () => {
      const h = legacyResaleContext();
      h.create.mockRejectedValue(new Error("db down"));

      const out = await refundFullOrder(h.deps, {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.newOrderStatus).toBe("REFUNDED");
      expect(h.ctx.idempotency.__mocks.commit).toHaveBeenCalledWith(
        `order:refund-full:${ORDER_ID}`,
        expect.anything(),
      );
      expect(h.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "db down" }),
        expect.objectContaining({
          tags: { useCase: "sendLegacyRelistNotices", reason: "notice_failed" },
        }),
      );
    });

    it("a replay of the refund sends no second notice", async () => {
      const h = legacyResaleContext();
      const first = await refundFullOrder(h.deps, {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      const replay = await refundFullOrder(h.deps, {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(replay).toEqual(first);
      expect(h.create).toHaveBeenCalledTimes(1);
    });

    it("the staff path tells the seller too", async () => {
      const h = legacyResaleContext();

      await staffRefundOrder(
        {
          ...h.deps,
          authz: { hasStaffRole: vi.fn(async () => ({ allowed: true })) } as never,
        },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          note: "Buyer asked, event moved",
        },
      );

      expect(h.create).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: OTHER_ACTOR_ID,
          action: { label: "List it again", href: relistHref },
        }),
      );
    });
  });

  describe("buyer in-app notification", () => {
    it("fires order.refund-processed for a loginable buyer after commit", async () => {
      const ctx = makeContext({ feeCents: 300 });

      const out = await refundFullOrder(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(ctx.notify).toHaveBeenCalledTimes(1);
      expect(ctx.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: ACTOR_ID,
          variant: "order.refund-processed",
          idempotencyKey: `order-refund:${out.refundId}`,
          payload: expect.objectContaining({
            orderId: ORDER_ID,
            refundId: out.refundId,
            amountCents: out.refundedCents,
            currency: "usd",
            status: "REFUNDED",
          }),
          // Email/SMS forced off — refund email is sent elsewhere.
          channels: expect.objectContaining({
            inApp: { enabled: true },
            email: { enabled: false },
            sms: { enabled: false },
          }),
        }),
      );
    });

    it("uses the SAME order-refund key as refund-order-items (no cross-path double-fire)", async () => {
      // Both refund paths key the notify on order-refund:${refundId} with the
      // shared Stripe refund id, so a buyer can't be notified twice for the
      // same refund regardless of which path executed it.
      const ctx = makeContext({ feeCents: 300 });

      const out = await refundFullOrder(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      const call = ctx.notify.mock.calls[0]?.[0];
      expect(call?.idempotencyKey).toBe(`order-refund:${out.refundId}`);
    });

    it("skips the notification for a guest buyer with no auth accounts", async () => {
      const ctx = makeContext({ feeCents: 300, authAccounts: [] });

      await refundFullOrder(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(ctx.notify).not.toHaveBeenCalled();
    });

    it("never throws or rolls back the refund when notify fails", async () => {
      const ctx = makeContext({ feeCents: 300 });
      ctx.notify.mockRejectedValueOnce(new Error("notify exploded"));

      const out = await refundFullOrder(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.ok).toBe(true);
      expect(out.refundId).toBe("re_test_123");
      expect(ctx.notify).toHaveBeenCalledTimes(1);
    });

    it("does not call notify when no dispatcher is wired", async () => {
      const ctx = makeContext({ feeCents: 300 });

      await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(ctx.notify).not.toHaveBeenCalled();
    });
  });

  // ── The one refund rule: pre-payout refunds write REFUND_DEBITs ───────────
  //
  // This block used to be the DIAGNOSTIC characterisation of the P0 bug
  // (a pre-payout non-resale refund mutated NO settlement, so the payee was
  // still paid — see docs/specs/2026-08-10/completed/settlement-cancellation-
  // granularity.spec.md for the history). The ledger cutover inverts it into
  // the correctness assertion: EVERY refund writes exactly one REFUND_DEBIT
  // per payee (ledger-authoritative-settlement spec §4), pre-payout included,
  // and the settlement-cancellation concept is gone entirely — the tx harness
  // deliberately has NO `settlements` repo, so any resurrected settlement
  // mutation crashes instead of passing a spy.
  describe("the one refund rule: pre-payout refund writes per-payee REFUND_DEBITs", () => {
    it("debits each payee their exact credit when a non-resale order is refunded pre-payout", async () => {
      const ctx = makeContext({ feeCents: 300 });
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 7_000,
        items: { [ITEM_A]: 3_500, [ITEM_B]: 3_500 },
      });
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-2",
        amountCents: 3_000,
        items: { [ITEM_A]: 1_500, [ITEM_B]: 1_500 },
      });

      const out = await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.ok).toBe(true);

      // Sanity: this really is the non-resale, not-yet-paid-out case the
      // old system leaked on.
      const order = await ctx.repos.orders.getById(ORDER_ID);
      expect(order?.source).toBe("PRIMARY");
      expect(order?.items.every((i) => i.paidOutAt === null)).toBe(true);
      expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalled();

      // Exactly one REFUND_DEBIT per payee, to the cent, keyed on the
      // Stripe refund id.
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(2);
      expect(new Map(debits.map((d) => [d.payeeId, d.amountCents]))).toEqual(
        new Map([
          ["payee-1", 7_000],
          ["payee-2", 3_000],
        ]),
      );
      for (const debit of debits) {
        expect(debit.idempotencyKey).toBe(
          `refund-debit:${ORDER_ID}:${debit.payeeId}:${out.refundId}`,
        );
        expect(debit.orderId).toBe(ORDER_ID);
      }
      // Nothing transferred → no reversal → no reversal credit.
      expect(ctx.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT")).toEqual(
        [],
      );
    });

    it("debits the RESALE branch identically — cancelForOrder no longer exists to diverge", async () => {
      const resaleOrder = makeOrder({
        source: "RESALE",
        parentOrderId: ORIGINAL_ORDER_ID,
        items: [
          {
            ...makeItems()[0]!,
            resaleListingId: RESALE_LISTING_ID,
            meta: {
              buyerTotalCents: 5500,
              resaleListingId: RESALE_LISTING_ID,
              resaleOriginalOrderId: ORIGINAL_ORDER_ID,
              resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
            },
          },
        ],
      });
      const ctx = makeContext({
        order: resaleOrder,
        orderForTx: resaleOrder,
        feeCents: 300,
      });
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-seller",
        amountCents: 5_000,
        items: { [ITEM_A]: 5_000 },
      });

      const out = await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      // The old resale-only settlement cancellation is not even mockable
      // anymore: the tx harness carries no settlements repo at all.
      expect("settlements" in ctx.txRepos).toBe(false);

      // The resale refund writes the same per-payee debit as every other
      // path — one rule, no source-based asymmetry.
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({
        payeeId: "payee-seller",
        amountCents: 5_000,
        idempotencyKey: `refund-debit:${ORDER_ID}:payee-seller:${out.refundId}`,
      });
    });

    // Refunds restock (spec 2026-10-09), fix round 2. Stripe is called BEFORE
    // the marking transaction. A resale ticket that is already INVALID (a
    // comp revoked after it was resold) made `restoreAfterResale` throw in
    // that transaction: the buyer was refunded, the order never marked, and
    // no REFUND_DEBIT written, so the seller kept credit for a refunded sale.
    it("a RESALE refund whose ticket is already INVALID still marks the order and writes the debit", async () => {
      const resaleOrder = makeOrder({
        source: "RESALE",
        parentOrderId: ORIGINAL_ORDER_ID,
        items: [
          {
            ...makeItems()[0]!,
            resaleListingId: RESALE_LISTING_ID,
            meta: {
              buyerTotalCents: 5500,
              resaleListingId: RESALE_LISTING_ID,
              resaleOriginalOrderId: ORIGINAL_ORDER_ID,
              resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
            },
          },
        ],
      });
      const ctx = makeContext({
        order: resaleOrder,
        orderForTx: resaleOrder,
        feeCents: 300,
        ticketByItemId: {
          [ITEM_A]: {
            id: TICKET_1,
            ownerHumanId: ACTOR_ID,
            orderId: ORDER_ID,
            orderItemId: ITEM_A,
            status: "INVALID",
          } as unknown as TicketRecord,
        },
      });
      // The adapter's guard: a terminal ticket is never restored.
      (
        ctx.txRepos.tickets.restoreAfterResale as ReturnType<typeof vi.fn>
      ).mockRejectedValue({
        code: "conflict",
        message: "resale_restore_ticket_terminal",
      });
      (
        ctx.txRepos.resaleListings.getById as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        id: RESALE_LISTING_ID,
        sellerHumanId: OTHER_ACTOR_ID,
        eventShareCents: 500, // priced under the share (a listing with none is closed, FR-015)
        status: "SOLD",
        buyerOrderId: ORDER_ID,
      });
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-seller",
        amountCents: 5_000,
        items: { [ITEM_A]: 5_000 },
      });

      const out = await refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalled();
      expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
      expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")[0]).toMatchObject({
        payeeId: "payee-seller",
        idempotencyKey: `refund-debit:${ORDER_ID}:payee-seller:${out.refundId}`,
      });
      // The dead ticket is not handed back; the sale's listing is closed.
      expect(ctx.txRepos.tickets.restoreAfterResale).not.toHaveBeenCalled();
      expect(ctx.txRepos.tickets.transfer).not.toHaveBeenCalled();
      expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
        RESALE_LISTING_ID,
        ORDER_ID,
        "CANCELLED",
      );
    });
  });

  // ── Spec §4.2: post-payout refunds and the transfer reversal ──────────────

  // Every case here runs as STAFF (`staffDeps`): a buyer cannot reach a
  // transfer reversal any more (buyer refunds stop at payout).
  describe("post-payout refund: transfer reversal credits", () => {
    it("writes a TRANSFER_REVERSAL_CREDIT linked to the debit when the reversal succeeds", async () => {
      const paidOutOrder = makeOrder({
        items: makeItems([
          { paidOutAt: new Date("2025-05-01T00:00:00.000Z") },
          { paidOutAt: new Date("2025-05-01T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({
        order: paidOutOrder,
        orderForTx: paidOutOrder,
        feeCents: 300,
      });
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 10_000,
        items: { [ITEM_A]: 5_000, [ITEM_B]: 5_000 },
      });

      const out = await refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      // Full refund → the payee's full credit is debited...
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 10_000,
      });

      // ...and the SUCCESSFUL Stripe reversal credits back — CLAMPED to the
      // debit (Step C review): the reversal is a BUYER-side quantity
      // (11_000 − 300 fee = 10_700 here) while the debit is the PAYEE-side
      // credit share (10_000). Crediting the raw reversal would leave a
      // fully-refunded, fully-clawed-back order at a POSITIVE payee balance
      // that the payable query would pay out as real money. Net-zero is the
      // contract; the 700¢ residual is reported as drift, never minted.
      const reversalCredits = ctx.payeeLedger.entriesOfType(
        "TRANSFER_REVERSAL_CREDIT",
      );
      expect(reversalCredits).toHaveLength(1);
      expect(out.refundedCents).toBe(10_700); // buyer-side, unchanged
      expect(reversalCredits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 10_000, // clamped to the debit — NOT out.refundedCents
        relatedEntryId: debits[0]!.id,
        idempotencyKey: `transfer-reversal:${ORDER_ID}:payee-1:${out.refundId}`,
      });
      // The pair nets to exactly zero on the payee's balance.
      expect(reversalCredits[0]!.amountCents - debits[0]!.amountCents).toBe(0);
    });

    it("lets the debit STAND (no credit, no throw) when nothing reverses", async () => {
      const paidOutOrder = makeOrder({
        items: makeItems([
          { paidOutAt: new Date("2025-05-01T00:00:00.000Z") },
          { paidOutAt: new Date("2025-05-01T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({
        order: paidOutOrder,
        orderForTx: paidOutOrder,
        feeCents: 300,
      });
      // No settlement lines exist for the items → reverseTransfersForItems
      // finds nothing to reverse and returns [] (the "nothing transferred /
      // reversal produced nothing" arm of spec §4.3).
      (
        ctx.repos.orderItemSettlementLines.listByOrderItemIds as ReturnType<
          typeof vi.fn
        >
      ).mockResolvedValue([]);
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 10_000,
        items: { [ITEM_A]: 5_000, [ITEM_B]: 5_000 },
      });

      const out = await refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.ok).toBe(true);
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({ amountCents: 10_000 });
      // The debit stands as debt; no reversal credit compensates it.
      expect(ctx.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT")).toEqual(
        [],
      );
    });

    // ── Ledger-era payouts (post-2026-08-10 cutover) ──────────────────────
    //
    // Post-cutover payouts write NOTHING into the settlement junction — the
    // batch stamps each PayoutItem with `plannedOrderItemIds` +
    // `stripeTransferId` instead. Before the two-era resolution these
    // refunds hit the junction, found [], and silently skipped the Stripe
    // reversal: the platform fronted the buyer's refund while the payee kept
    // the transferred money.

    it("LEDGER ERA: reverses the PayoutItem's transfer for the PAYEE-side attribution when the junction is empty", async () => {
      const paidOutOrder = makeOrder({
        items: makeItems([
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({
        order: paidOutOrder,
        orderForTx: paidOutOrder,
        feeCents: 300,
      });
      // Post-cutover: no junction rows were ever written for this order…
      (
        ctx.repos.orderItemSettlementLines.listByOrderItemIds as ReturnType<
          typeof vi.fn
        >
      ).mockResolvedValue([]);
      // …the durable plan is the ONLY link back to the transfer. The
      // transfer carried exactly the payee's 10_000¢ net — the reversal fake
      // rejects anything beyond it, exactly like live Stripe.
      (
        ctx.repos.payoutItems
          .listTransferredByPlannedOrderItemIds as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          payoutItemId: "pitem-1",
          stripeTransferId: "tr_ledger_1",
          payeeId: "payee-1",
          currency: "usd",
          plannedOrderItemIds: [ITEM_A, ITEM_B],
          amountCents: 10_000,
          netAmountCents: 10_000,
        },
      ]);
      ctx.transferCapacities.set("tr_ledger_1", 10_000);
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 10_000,
        items: { [ITEM_A]: 5_000, [ITEM_B]: 5_000 },
      });

      const out = await refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      // ONE Stripe reversal against the PayoutItem's transfer for the
      // PAYEE-side attribution (5_000 + 5_000), retry-stable key. The
      // buyer-side 10_700 (buyer paid − Stripe fee) MUST NOT be requested:
      // the transfer only ever held 10_000, so 10_700 is a guaranteed Stripe
      // rejection that would abort the buyer's refund. Whole-item refunds
      // are the only shape (every caller marks entire items refunded), so
      // the FULL attribution is the right amount — no scaling.
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          transferId: "tr_ledger_1",
          amountCents: 10_000,
          idempotencyKey: `order:refund-full:${ORDER_ID}:reverse-transfer:tr_ledger_1`,
          metadata: expect.objectContaining({ payoutItemId: "pitem-1" }),
        }),
      );
      // Ledger-era results carry payeeId directly — no settlement lookup.
      expect(ctx.repos.settlements.getByIds).not.toHaveBeenCalled();

      // Debit for the full credit, reversal credit equal → net zero to the
      // cent, with the reversed amount matching the money that ACTUALLY
      // came back.
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 10_000,
      });
      const reversalCredits = ctx.payeeLedger.entriesOfType(
        "TRANSFER_REVERSAL_CREDIT",
      );
      expect(reversalCredits).toHaveLength(1);
      expect(reversalCredits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 10_000,
        relatedEntryId: debits[0]!.id,
        idempotencyKey: `transfer-reversal:${ORDER_ID}:payee-1:${out.refundId}`,
      });
      expect(reversalCredits[0]!.amountCents - debits[0]!.amountCents).toBe(0);
    });

    it("MULTI-PAYEE: every payee's plan covers the SAME items → one reversal per payee's transfer, each for that payee's share", async () => {
      // Booking splits: attributeCreditToItems spreads EVERY payee's credit
      // across ALL ticket items, so both payout plans list [A, B]. The
      // overlap is structural — first-match-wins would send the owner's
      // transfer a 10_700¢ buyer-side reversal (rejected: it only held
      // 6_000) and leave the performer's 4_000 untouched.
      const paidOutOrder = makeOrder({
        items: makeItems([
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({
        order: paidOutOrder,
        orderForTx: paidOutOrder,
        feeCents: 300,
      });
      (
        ctx.repos.orderItemSettlementLines.listByOrderItemIds as ReturnType<
          typeof vi.fn
        >
      ).mockResolvedValue([]);
      (
        ctx.repos.payoutItems
          .listTransferredByPlannedOrderItemIds as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          payoutItemId: "pitem-owner",
          stripeTransferId: "tr_owner",
          payeeId: "payee-owner",
          currency: "usd",
          plannedOrderItemIds: [ITEM_A, ITEM_B],
          amountCents: 6_000,
          netAmountCents: 6_000,
        },
        {
          payoutItemId: "pitem-performer",
          stripeTransferId: "tr_performer",
          payeeId: "payee-performer",
          currency: "usd",
          plannedOrderItemIds: [ITEM_A, ITEM_B],
          amountCents: 4_000,
          netAmountCents: 4_000,
        },
      ]);
      ctx.transferCapacities.set("tr_owner", 6_000);
      ctx.transferCapacities.set("tr_performer", 4_000);
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-owner",
        amountCents: 6_000,
        items: { [ITEM_A]: 3_000, [ITEM_B]: 3_000 },
      });
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-performer",
        amountCents: 4_000,
        items: { [ITEM_A]: 2_000, [ITEM_B]: 2_000 },
      });

      const out = await refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      // The buyer refund completes…
      expect(out.ok).toBe(true);

      // …with TWO reversals, each for that payee's attributed share.
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(2);
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          transferId: "tr_owner",
          amountCents: 6_000,
          metadata: expect.objectContaining({ payoutItemId: "pitem-owner" }),
        }),
      );
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          transferId: "tr_performer",
          amountCents: 4_000,
          metadata: expect.objectContaining({
            payoutItemId: "pitem-performer",
          }),
        }),
      );

      // Per-payee debits and reversal credits net to zero on BOTH sides.
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(new Map(debits.map((d) => [d.payeeId, d.amountCents]))).toEqual(
        new Map([
          ["payee-owner", 6_000],
          ["payee-performer", 4_000],
        ]),
      );
      const reversalCredits = ctx.payeeLedger.entriesOfType(
        "TRANSFER_REVERSAL_CREDIT",
      );
      expect(
        new Map(reversalCredits.map((c) => [c.payeeId, c.amountCents])),
      ).toEqual(
        new Map([
          ["payee-owner", 6_000],
          ["payee-performer", 4_000],
        ]),
      );
    });

    it("NET CAP: the reversal never requests withheld cents — the residual stays as ledger debt", async () => {
      // The payout claimed 10_000 but only 9_300 moved (700 withheld —
      // reserve / Connect fee). Those 700¢ never left the platform, so
      // requesting them back from Stripe is impossible; the reversal is
      // capped at the net and the 700¢ residual stands as debt via the
      // debit/credit asymmetry.
      const paidOutOrder = makeOrder({
        items: makeItems([
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({
        order: paidOutOrder,
        orderForTx: paidOutOrder,
        feeCents: 300,
      });
      (
        ctx.repos.orderItemSettlementLines.listByOrderItemIds as ReturnType<
          typeof vi.fn
        >
      ).mockResolvedValue([]);
      (
        ctx.repos.payoutItems
          .listTransferredByPlannedOrderItemIds as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          payoutItemId: "pitem-withheld",
          stripeTransferId: "tr_withheld",
          payeeId: "payee-1",
          currency: "usd",
          plannedOrderItemIds: [ITEM_A, ITEM_B],
          amountCents: 10_000,
          netAmountCents: 9_300,
        },
      ]);
      // Live-Stripe mirror: the transfer only ever held 9_300.
      ctx.transferCapacities.set("tr_withheld", 9_300);
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 10_000,
        items: { [ITEM_A]: 5_000, [ITEM_B]: 5_000 },
      });

      const out = await refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.ok).toBe(true);
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          transferId: "tr_withheld",
          amountCents: 9_300,
        }),
      );

      // EXACT ledger entries: debit 10_000 (the full credit comes back),
      // reversal credit 9_300 (what ACTUALLY came back) → the payee balance
      // carries −700 as debt, recouped by the next payout's arithmetic.
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 10_000,
      });
      const reversalCredits = ctx.payeeLedger.entriesOfType(
        "TRANSFER_REVERSAL_CREDIT",
      );
      expect(reversalCredits).toHaveLength(1);
      expect(reversalCredits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 9_300,
        relatedEntryId: debits[0]!.id,
      });
      expect(debits[0]!.amountCents - reversalCredits[0]!.amountCents).toBe(
        700,
      );
    });

    it("MIXED ORDER: one ledger-era + one pre-cutover item → two reversals, each on the right transfer", async () => {
      const paidOutOrder = makeOrder({
        items: makeItems([
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
          { paidOutAt: new Date("2025-05-01T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({
        order: paidOutOrder,
        orderForTx: paidOutOrder,
        feeCents: 300,
      });
      // ITEM_A was paid by a post-cutover payout; ITEM_B by a pre-cutover
      // settlement (the default junction mock keeps serving its rows).
      (
        ctx.repos.payoutItems
          .listTransferredByPlannedOrderItemIds as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          payoutItemId: "pitem-A",
          stripeTransferId: "tr_ledger_A",
          payeeId: "payee-1",
          currency: "usd",
          plannedOrderItemIds: [ITEM_A],
          amountCents: 5_000,
          netAmountCents: 5_000,
        },
      ]);
      ctx.transferCapacities.set("tr_ledger_A", 5_000);
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 10_000,
        items: { [ITEM_A]: 5_000, [ITEM_B]: 5_000 },
      });

      await refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      // The junction is consulted ONLY for the item the plan did not cover.
      expect(
        ctx.repos.orderItemSettlementLines.listByOrderItemIds,
      ).toHaveBeenCalledWith([ITEM_B]);

      // Two Stripe reversals, each against its own era's transfer: the
      // ledger era uses the PAYEE-side attribution (5_000 — the buyer-side
      // 5_350 would exceed the transfer); the legacy era keeps its pinned
      // itemAmounts-first buyer-side behaviour (5_350) byte-identically.
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(2);
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          transferId: "tr_ledger_A",
          amountCents: 5_000,
          metadata: expect.objectContaining({ payoutItemId: "pitem-A" }),
        }),
      );
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          transferId: `tr_settlement-sl-${ITEM_B}`,
          amountCents: 5_350,
          metadata: expect.objectContaining({
            settlementId: `settlement-sl-${ITEM_B}`,
          }),
        }),
      );

      // Both eras attribute to the same payee → ONE credit, clamped to the
      // debit (10_350 reversed vs 10_000 credit share).
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({ amountCents: 10_000 });
      const reversalCredits = ctx.payeeLedger.entriesOfType(
        "TRANSFER_REVERSAL_CREDIT",
      );
      expect(reversalCredits).toHaveLength(1);
      expect(reversalCredits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 10_000,
      });
    });

    it("reports ONCE (and carries the debt) when a paid-out item resolves through NEITHER era", async () => {
      const paidOutOrder = makeOrder({
        items: makeItems([
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({
        order: paidOutOrder,
        orderForTx: paidOutOrder,
        feeCents: 300,
      });
      // Junction empty AND no PayoutItem plan covers the items (the
      // payoutItems default already returns []) — the genuine invariant
      // breach: paidOutAt is stamped but no transfer can be found.
      (
        ctx.repos.orderItemSettlementLines.listByOrderItemIds as ReturnType<
          typeof vi.fn
        >
      ).mockResolvedValue([]);
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 10_000,
        items: { [ITEM_A]: 5_000, [ITEM_B]: 5_000 },
      });
      const reportError = vi.fn();

      const out = await refundFullOrder(
        { ...staffDeps(ctx), reportError },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      );

      // The refund still completes (debt-carry) — never blocked on the miss.
      expect(out.ok).toBe(true);
      expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();

      // …but the miss is VISIBLE: reportError fires exactly once with the
      // unresolved item ids (logger.warn alone is not Sentry-captured).
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "reverse_transfers_unresolved_paid_out_items",
        }),
        expect.objectContaining({
          tags: { useCase: "reverseTransfersForItems" },
          extra: expect.objectContaining({
            orderItemIds: [ITEM_A, ITEM_B],
          }),
        }),
      );

      // The debit stands as debt; no reversal credit compensates it.
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({ amountCents: 10_000 });
      expect(ctx.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT")).toEqual(
        [],
      );
    });

    it("SEQUENTIAL REFUND on a partially-reversed transfer: reads Stripe's remaining 3_800 and COMPLETES (200 stays as debt)", async () => {
      // The reviewer scenario's second call: the payout cell's transfer sent
      // 9_800 net (10_000 payable − 200 Connect fee) and an EARLIER refund
      // already reversed 6_000 of it. This refund's attribution is 4_000;
      // the per-call net cap (9_800) would let the full 4_000 through and
      // Stripe would reject the cumulative 10_000 > 9_800 — hard-failing the
      // buyer's refund. The pre-flight reads remaining 3_800 and reverses
      // exactly that; the 200 shortfall stands as ledger debt.
      const paidOutOrder = makeOrder({
        items: makeItems([
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({
        order: paidOutOrder,
        orderForTx: paidOutOrder,
        feeCents: 300,
      });
      (
        ctx.repos.orderItemSettlementLines.listByOrderItemIds as ReturnType<
          typeof vi.fn
        >
      ).mockResolvedValue([]);
      (
        ctx.repos.payoutItems
          .listTransferredByPlannedOrderItemIds as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          payoutItemId: "pitem-seq",
          stripeTransferId: "tr_seq",
          payeeId: "payee-1",
          currency: "usd",
          plannedOrderItemIds: [ITEM_A, ITEM_B],
          amountCents: 10_000,
          netAmountCents: 9_800,
        },
      ]);
      // Live-Stripe mirror: the transfer holds 9_800, 6_000 already
      // reversed by the earlier refund.
      ctx.transferCapacities.set("tr_seq", 9_800);
      ctx.reversedByTransfer.set("tr_seq", 6_000);
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 4_000,
        items: { [ITEM_A]: 2_000, [ITEM_B]: 2_000 },
      });

      const out = await refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      // The buyer refund COMPLETES — this exact shape used to hard-fail on
      // Stripe's cumulative-amount rejection until manual intervention.
      expect(out.ok).toBe(true);
      expect(ctx.payments.getTransfer).toHaveBeenCalledTimes(1);
      expect(ctx.payments.getTransfer).toHaveBeenCalledWith({
        transferId: "tr_seq",
      });
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ transferId: "tr_seq", amountCents: 3_800 }),
      );
      // The fake's cumulative tracking confirms the transfer is now exactly
      // exhausted — the reversal was accepted, not rejected.
      expect(ctx.reversedByTransfer.get("tr_seq")).toBe(9_800);

      // Debit 4_000 (full credit clawback), reversal credit 3_800 (what
      // ACTUALLY came back) → the payee carries 200 as debt.
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 4_000,
      });
      const reversalCredits = ctx.payeeLedger.entriesOfType(
        "TRANSFER_REVERSAL_CREDIT",
      );
      expect(reversalCredits).toHaveLength(1);
      expect(reversalCredits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 3_800,
        relatedEntryId: debits[0]!.id,
      });
      expect(debits[0]!.amountCents - reversalCredits[0]!.amountCents).toBe(
        200,
      );
    });

    it("FULLY-REVERSED transfer: no Stripe call at all, distinct report, refund completes with full debt-carry", async () => {
      const paidOutOrder = makeOrder({
        items: makeItems([
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
          { paidOutAt: new Date("2026-08-12T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({
        order: paidOutOrder,
        orderForTx: paidOutOrder,
        feeCents: 300,
      });
      (
        ctx.repos.orderItemSettlementLines.listByOrderItemIds as ReturnType<
          typeof vi.fn
        >
      ).mockResolvedValue([]);
      (
        ctx.repos.payoutItems
          .listTransferredByPlannedOrderItemIds as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          payoutItemId: "pitem-dead",
          stripeTransferId: "tr_dead",
          payeeId: "payee-1",
          currency: "usd",
          plannedOrderItemIds: [ITEM_A, ITEM_B],
          amountCents: 10_000,
          netAmountCents: 9_800,
        },
      ]);
      // Prior refunds consumed the ENTIRE transfer.
      ctx.transferCapacities.set("tr_dead", 9_800);
      ctx.reversedByTransfer.set("tr_dead", 9_800);
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 4_000,
        items: { [ITEM_A]: 2_000, [ITEM_B]: 2_000 },
      });
      const reportError = vi.fn();

      const out = await refundFullOrder(
        { ...staffDeps(ctx), reportError },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      );

      // The buyer refund still completes; nothing was requested from Stripe.
      expect(out.ok).toBe(true);
      expect(ctx.payments.getTransfer).toHaveBeenCalledTimes(1);
      expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();

      // Distinct signal (not the unresolved-items or no-amount anomalies).
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "reverse_transfers_transfer_fully_reversed",
        }),
        expect.objectContaining({
          tags: { useCase: "reverseTransfersForItems" },
          extra: expect.objectContaining({
            stripeTransferId: "tr_dead",
            payoutItemId: "pitem-dead",
            requestedCents: 4_000,
          }),
        }),
      );

      // Full debt-carry: the debit stands, no reversal credit compensates.
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 4_000,
      });
      expect(ctx.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT")).toEqual(
        [],
      );
    });
  });

  // ── Per-order refund mutex (concurrent-refund double-pay fix) ────────────
  // The Stripe idempotency keys of the refund paths live in DISJOINT
  // namespaces (order:refund-full / order:refund-items / org / event:cancel /
  // claim:review), so Stripe dedupes nothing across paths — the shared
  // `refund-op:${orderId}` mutex is the only cross-path serializer.

  describe("per-order refund mutex", () => {
    it("makes ZERO external calls and writes nothing when another refund holds the order", async () => {
      const ctx = makeContext();
      // Another refund path (e.g. an org item refund) holds the mutex.
      ctx.idempotency.__locks.set(
        `refund-op:${ORDER_ID}`,
        Date.now() + 600_000,
      );

      await expect(
        refundFullOrder(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
        message: "order_refund_in_progress",
      });

      // No money moved, nothing persisted, no use-case record touched.
      expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();
      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
      expect(
        ctx.payments.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.idempotency.__mocks.commit).not.toHaveBeenCalled();
      // Never acquired → never released; the holder's lock is untouched.
      expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
      expect(ctx.idempotency.__mocks.release).not.toHaveBeenCalled();
      // The conflict came from the mutex acquire, with the crash-recovery TTL
      // and a per-acquire owner token (owner-checked release).
      expect(ctx.idempotency.__mocks.begin).toHaveBeenCalledWith(
        `refund-op:${ORDER_ID}`,
        600,
        expect.any(String),
      );
    });

    it("releases the mutex after a successful refund via owner-checked release(key, token)", async () => {
      const ctx = makeContext();

      const out = await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.ok).toBe(true);
      // Owner-checked release with the SAME token the acquire carried — see
      // _shared/refund-mutex.ts for the compare-and-delete semantics.
      const beginCall = ctx.idempotency.__mocks.begin.mock.calls.find(
        ([key]) => key === `refund-op:${ORDER_ID}`,
      );
      const ownerToken = beginCall?.[2];
      expect(ownerToken).toEqual(expect.any(String));
      expect(ctx.idempotency.__mocks.release).toHaveBeenCalledWith(
        `refund-op:${ORDER_ID}`,
        ownerToken,
      );
      // The mutex never uses fail() for release (that was the unconditional
      // overwrite an expired holder could clobber a new holder's lock with).
      expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalledWith(
        `refund-op:${ORDER_ID}`,
        expect.anything(),
        expect.anything(),
      );
    });

    it("releases the mutex when the Stripe refund throws, so a retry re-acquires", async () => {
      const ctx = makeContext();
      (
        ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error("stripe_down"));

      await expect(
        refundFullOrder(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "dependency_failed" });

      // The use case's own claim AND the mutex were both released via the
      // owner-checked primitive — distinct namespaces, distinct tokens.
      expect(ctx.idempotency.__mocks.release).toHaveBeenCalledWith(
        `order:refund-full:${ORDER_ID}`,
        expect.any(String),
      );
      expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
      expect(ctx.idempotency.__mocks.release).toHaveBeenCalledWith(
        `refund-op:${ORDER_ID}`,
        expect.any(String),
      );

      // Retry: mutex re-acquired, refund succeeds.
      const out = await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });
      expect(out.ok).toBe(true);
      expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(2);
    });
  });
});

// ── Dispute guard ─────────────────────────────────────────────────────────
// Stripe refuses to refund a disputed charge (`charge_disputed`). The use case
// refuses FIRST — after the idempotency replay lookup, before any processor
// call or ledger write — with the typed ORDER_DISPUTED_REFUND_BLOCKED.
describe("refundFullOrder — dispute guard", () => {
  it.each(["OPEN", "UNDER_REVIEW", "LOST"] as const)(
    "refuses a %s dispute with no processor call and no ledger write",
    async (disputeStatus) => {
      const ctx = makeContext({ order: makeOrder({ disputeStatus }) });

      await expect(
        refundFullOrder(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
        }),
      ).rejects.toMatchObject({
        code: "ORDER_DISPUTED_REFUND_BLOCKED",
        meta: { orderId: ORDER_ID, paymentIntentId: "pi_123", disputeStatus },
      });

      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
      expect(
        ctx.payments.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();
      expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();
      // No transaction → no item/ticket/order mutation and no ledger entry.
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.idempotency.__mocks.commit).not.toHaveBeenCalled();
      // A refusal is not an attempt: the use-case key is neither claimed nor
      // marked failed, so a retry once the dispute closes is not locked out
      // for the failed-marker TTL.
      expect(ctx.idempotency.__mocks.begin).not.toHaveBeenCalledWith(
        `order:refund-full:${ORDER_ID}`,
        expect.anything(),
      );
      expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalledWith(
        `order:refund-full:${ORDER_ID}`,
        expect.anything(),
      );
    },
  );

  it.each([
    "WON",
    "WARNING_OPEN",
    "WARNING_UNDER_REVIEW",
    "WARNING_CLOSED",
    null,
  ] as const)("proceeds when disputeStatus is %s", async (disputeStatus) => {
    const ctx = makeContext({ order: makeOrder({ disputeStatus }) });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out.ok).toBe(true);
    expect(out.newOrderStatus).toBe("REFUNDED");
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("wins over the status gates: a disputed order explains the dispute, not ORDER_NOT_REFUNDABLE", async () => {
    // markDisputeStatus never touches `status`, but if a future write does,
    // the dispute must still be the reason surfaced.
    const ctx = makeContext({
      order: makeOrder({ status: "DISPUTED", disputeStatus: "OPEN" }),
    });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "ORDER_DISPUTED_REFUND_BLOCKED" });
  });

  it("replays a completed refund even when the order is now disputed", async () => {
    const cachedResponse = {
      ok: true as const,
      orderId: ORDER_ID,
      refundId: "re_cached_123",
      currency: "usd",
      amountPaidCents: 11000,
      stripeFeeCents: 300,
      refundedCents: 11000,
      refundedItems: [
        { orderItemId: ITEM_A, refundedCents: 5500 },
        { orderItemId: ITEM_B, refundedCents: 5500 },
      ],
      skippedItems: [],
      newOrderStatus: "REFUNDED" as const,
    };
    // Refunded earlier; a dispute opened afterwards (a buyer can dispute a
    // refunded charge). The stored result must still replay.
    const ctx = makeContext({
      order: makeOrder({ status: "REFUNDED", disputeStatus: "OPEN" }),
    });
    ctx.idempotency.__store.set(`order:refund-full:${ORDER_ID}`, {
      payloadHash: "",
      response: cachedResponse,
    });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out).toEqual(cachedResponse);
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalledWith(
      `order:refund-full:${ORDER_ID}`,
      expect.anything(),
    );
  });

  it("passes the adapter's typed ORDER_DISPUTED_REFUND_BLOCKED through (dispute opened after the pre-flight)", async () => {
    const ctx = makeContext();
    const stripeRefusal = new AppError("ORDER_DISPUTED_REFUND_BLOCKED", {
      meta: { paymentIntentId: "pi_123" },
    });
    (
      ctx.payments.refundPaymentIntent as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(stripeRefusal);

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toBe(stripeRefusal);

    // Refused by Stripe → nothing recorded as refunded.
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.idempotency.__mocks.commit).not.toHaveBeenCalled();
  });

  it("still wraps any other refund failure as dependency_failed", async () => {
    const ctx = makeContext();
    (
      ctx.payments.refundPaymentIntent as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe is down"));

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      message: "refund_payment_intent",
    });
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  // ── Buyer refund window + ticket state (audit #1) ─────────────────────────
  // NOW is 2025-06-01T12:00Z. A show that already started must refuse a
  // BUYER before the refund key is claimed; staff keep their bypass.

  describe("buyer refund window", () => {
    const PAST_START = new Date("2025-05-31T20:00:00.000Z");
    const REFUND_FULL_KEY_PREFIX = "order:refund-full:";

    function expectNoRefundClaim(ctx: ReturnType<typeof makeContext>) {
      const refundKeyBegins = ctx.idempotency.__mocks.begin.mock.calls.filter(
        (call) => String(call[0]).startsWith(REFUND_FULL_KEY_PREFIX),
      );
      expect(refundKeyBegins).toHaveLength(0);
      expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
      expect(ctx.repos.tx).not.toHaveBeenCalled();
    }

    it("refuses a buyer refund after startsAt (REFUND_WINDOW_CLOSED) — no Stripe, no idempotency claim", async () => {
      const ctx = makeContext({ eventStartsAt: PAST_START });

      await expect(
        refundFullOrder(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "REFUND_WINDOW_CLOSED" });

      expectNoRefundClaim(ctx);
    });

    it("refunds normally before the deadline", async () => {
      const ctx = makeContext({
        eventStartsAt: new Date("2025-06-01T20:00:00.000Z"),
      });

      const out = await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.ok).toBe(true);
      expect(out.newOrderStatus).toBe("REFUNDED");
    });

    it("an explicit refundCutoffAt wins over startsAt", async () => {
      const ctx = makeContext({
        eventStartsAt: new Date("2025-06-03T20:00:00.000Z"),
        eventRefundCutoffAt: new Date("2025-06-01T00:00:00.000Z"),
      });

      await expect(
        refundFullOrder(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "REFUND_WINDOW_CLOSED" });

      expectNoRefundClaim(ctx);
    });

    it("staff (_skipBuyerCheck) still refund after the show", async () => {
      const ctx = makeContext({ eventStartsAt: PAST_START });

      const out = await refundFullOrder(
        { ...makeDeps(ctx), _skipBuyerCheck: true },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      );

      expect(out.ok).toBe(true);
      expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    });

    it("a buyer's SCANNED ticket is skipped (already_scanned) and its ticket is left SCANNED", async () => {
      const scannedTicket = {
        id: TICKET_1,
        ownerHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "SCANNED",
        scannedAt: new Date("2025-06-01T11:00:00.000Z"),
      } as TicketRecord;
      const validTicket = {
        id: TICKET_2,
        ownerHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_B,
        status: "VALID",
      } as TicketRecord;
      const ctx = makeContext({
        ticketByItemId: { [ITEM_A]: scannedTicket, [ITEM_B]: validTicket },
        tickets: [
          { id: TICKET_1, status: "SCANNED", scannedAt: scannedTicket.scannedAt },
          { id: TICKET_2, status: "VALID", scannedAt: null },
        ],
      });

      const out = await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.skippedItems).toEqual([
        { orderItemId: ITEM_A, reason: "already_scanned" },
      ]);
      expect(out.refundedItems.map((i) => i.orderItemId)).toEqual([ITEM_B]);
      expect(out.newOrderStatus).toBe("PART_REFUNDED");
      // Item B: 5500 buyer-paid minus its 150 fee share.
      expect(out.refundedCents).toBe(5350);
      expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 5350 }),
      );

      // Only the refunded item's ticket is flipped; the scanned one stays put.
      const setStatusCalls = (
        ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
      ).mock.calls;
      expect(setStatusCalls.map((c) => c[0])).toEqual([TICKET_2]);
      expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
      expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
        ITEM_B,
        "refunded",
        NOW,
        0,
        500, // its own share of the 1000 fee; the skipped item's 500 is unstamped
      );
    });

    it("staff refund a SCANNED ticket (bypass) — both items refunded, both tickets flipped", async () => {
      const ctx = makeContext({
        ticketByItemId: {
          [ITEM_A]: {
            id: TICKET_1,
            orderItemId: ITEM_A,
            status: "SCANNED",
          } as TicketRecord,
          [ITEM_B]: {
            id: TICKET_2,
            orderItemId: ITEM_B,
            status: "VALID",
          } as TicketRecord,
        },
        tickets: [
          { id: TICKET_1, status: "SCANNED", scannedAt: new Date() },
          { id: TICKET_2, status: "VALID", scannedAt: null },
        ],
      });

      const out = await refundFullOrder(
        { ...makeDeps(ctx), _skipBuyerCheck: true },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      );

      expect(out.skippedItems).toEqual([]);
      expect(out.newOrderStatus).toBe("REFUNDED");
      const setStatusCalls = (
        ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
      ).mock.calls;
      expect(setStatusCalls.map((c) => c[0]).sort()).toEqual(
        [TICKET_1, TICKET_2].sort(),
      );
    });

    // Owner ruling 2026-10-10: a refund of a scanned-in ticket means the
    // person left. The void clears `scannedAt`, so the audit row is the only
    // record that the ticket had admitted someone.
    const refundedAuditData = (ctx: ReturnType<typeof makeContext>) => {
      const entry = (ctx.txRepos.audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[0] as { action: string; data: Record<string, unknown> })
        .find((e) => e.action === "refunded");
      expect(entry).toBeDefined();
      return entry!.data;
    };

    /**
     * Make the fake write what the real one writes, ON THE ROW THE READ
     * RETURNED: a list taken after the void then finds no SCANNED ticket and
     * no admit time, so these tests fail if the order is ever swapped.
     */
    const voidInPlace = (
      ctx: ReturnType<typeof makeContext>,
      rows: Array<{ id: string; status: string; scannedAt: Date | null }>,
    ) => {
      (ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>).mockImplementation(
        async (id: string, status: string) => {
          const row = rows.find((t) => t.id === id);
          if (row) {
            row.status = status;
            row.scannedAt = null;
          }
          return true;
        },
      );
    };

    it("lists only the voided scanned ticket when another scanned ticket is kept out of the refund", async () => {
      const admittedAt = new Date("2026-10-09T23:41:07.000Z");
      // ITEM_B was gifted away (item `transferred`) and the recipient has
      // since been scanned in: it is SCANNED and kept (`already_transferred`).
      const rows = [
        { id: TICKET_1, status: "SCANNED", scannedAt: admittedAt },
        { id: TICKET_2, status: "SCANNED", scannedAt: admittedAt },
      ];
      const ctx = makeContext({
        order: makeOrder({
          items: makeItems([
            {},
            { status: "transferred", transferredAt: new Date() },
          ]),
        }),
        ticketByItemId: {
          [ITEM_A]: {
            id: TICKET_1,
            orderItemId: ITEM_A,
            status: "SCANNED",
            scannedAt: admittedAt,
          } as TicketRecord,
          [ITEM_B]: {
            id: TICKET_2,
            orderItemId: ITEM_B,
            status: "SCANNED",
            scannedAt: admittedAt,
          } as TicketRecord,
        },
        tickets: rows,
      });
      voidInPlace(ctx, rows);

      const out = await refundFullOrder(
        { ...makeDeps(ctx), _skipBuyerCheck: true },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      );

      expect(out.skippedItems).toEqual([
        { orderItemId: ITEM_B, reason: "already_transferred" },
      ]);
      expect(rows[0]!.status).toBe("REFUNDED");
      expect(rows[1]!.status).toBe("SCANNED");
      expect(refundedAuditData(ctx).leftOnRefund).toEqual([
        { ticketId: TICKET_1, admittedAt: "2026-10-09T23:41:07.000Z" },
      ]);
    });

    it("records the scanned ticket, with its admit time, as leftOnRefund on the audit row", async () => {
      const admittedAt = new Date("2026-10-09T23:41:07.000Z");
      const rows = [
        { id: TICKET_1, status: "SCANNED", scannedAt: admittedAt },
        { id: TICKET_2, status: "VALID", scannedAt: null as Date | null },
      ];
      const ctx = makeContext({
        ticketByItemId: {
          [ITEM_A]: {
            id: TICKET_1,
            orderItemId: ITEM_A,
            status: "SCANNED",
            scannedAt: admittedAt,
          } as TicketRecord,
          [ITEM_B]: {
            id: TICKET_2,
            orderItemId: ITEM_B,
            status: "VALID",
          } as TicketRecord,
        },
        tickets: rows,
      });
      voidInPlace(ctx, rows);

      await refundFullOrder(
        { ...makeDeps(ctx), _skipBuyerCheck: true },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      );

      expect(rows[0]!.status).toBe("REFUNDED");
      expect(refundedAuditData(ctx).leftOnRefund).toEqual([
        { ticketId: TICKET_1, admittedAt: "2026-10-09T23:41:07.000Z" },
      ]);
    });

    it("writes no leftOnRefund key when no refunded ticket had been scanned", async () => {
      const ctx = makeContext({
        tickets: [
          { id: TICKET_1, status: "VALID", scannedAt: null },
          { id: TICKET_2, status: "VALID", scannedAt: null },
        ],
      });

      await refundFullOrder(
        { ...makeDeps(ctx), _skipBuyerCheck: true },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      );

      expect(refundedAuditData(ctx)).not.toHaveProperty("leftOnRefund");
    });
  });

  // ── Listed resale ticket (audit #2) ───────────────────────────────────────

  describe("listed resale ticket", () => {
    const listedTicket = {
      id: TICKET_1,
      ownerHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemId: ITEM_A,
      status: "LISTED",
    } as TicketRecord;

    it("skips a listed item (listing_active) for the buyer and refunds only the rest", async () => {
      const items = makeItems([{ resaleListingId: RESALE_LISTING_ID }, {}]);
      const ctx = makeContext({
        order: makeOrder({ items }),
        ticketByItemId: {
          [ITEM_A]: listedTicket,
          [ITEM_B]: {
            id: TICKET_2,
            orderItemId: ITEM_B,
            status: "VALID",
          } as TicketRecord,
        },
        tickets: [
          { id: TICKET_1, status: "LISTED", scannedAt: null },
          { id: TICKET_2, status: "VALID", scannedAt: null },
        ],
      });

      const out = await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.skippedItems).toEqual([
        { orderItemId: ITEM_A, reason: "listing_active" },
      ]);
      expect(out.refundedItems.map((i) => i.orderItemId)).toEqual([ITEM_B]);
      expect(out.newOrderStatus).toBe("PART_REFUNDED");
      // Arity-independent on purpose: a `not.toHaveBeenCalledWith` with a
      // fixed matcher count passes vacuously the day the call grows an
      // argument (it did, for `refundedPlatformFeeCents`).
      expect(
        (
          ctx.txRepos.orderItems.updateStatus as ReturnType<typeof vi.fn>
        ).mock.calls.map((call) => call[0]),
      ).not.toContain(ITEM_A);
      // The LISTED ticket is never touched.
      const setStatusCalls = (
        ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
      ).mock.calls;
      expect(setStatusCalls.map((c) => c[0])).toEqual([TICKET_2]);
    });

    it("applies to staff too, and a lone listed item means NO_REFUNDABLE_ITEMS (no Stripe call)", async () => {
      const items = makeItems([{ resaleListingId: RESALE_LISTING_ID }, {}]).slice(
        0,
        1,
      );
      const ctx = makeContext({
        order: makeOrder({ items }),
        ticketByItemId: { [ITEM_A]: listedTicket },
        tickets: [{ id: TICKET_1, status: "LISTED", scannedAt: null }],
      });

      await expect(
        refundFullOrder(
          { ...makeDeps(ctx), _skipBuyerCheck: true },
          { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
        ),
      ).rejects.toMatchObject({ code: "NO_REFUNDABLE_ITEMS" });

      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
      expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    });

    it("a LISTED ticket alone (resaleListingId already null) is still listing_active", async () => {
      const ctx = makeContext({
        ticketByItemId: {
          [ITEM_A]: listedTicket,
          [ITEM_B]: {
            id: TICKET_2,
            orderItemId: ITEM_B,
            status: "VALID",
          } as TicketRecord,
        },
      });

      const out = await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.skippedItems).toEqual([
        { orderItemId: ITEM_A, reason: "listing_active" },
      ]);
    });
  });
});

// ── Buyer refunds stop at payout ──────────────────────────────────────────
// docs/decisions/buyer-refunds-stop-at-payout.md: once an item's revenue has
// been paid out, a BUYER cannot self-serve a refund of it — the money is the
// payee's. Staff / org (`_skipBuyerCheck`) keep reversing the transfer and
// refunding; cancel-event classifies paid-out items with its own inline rule
// and is untouched. Same rule the eligibility screen has always shown
// (`order_already_paid_out`).
describe("refundFullOrder — buyer refunds stop at payout", () => {
  const PAID_OUT_AT = new Date("2025-05-20T00:00:00.000Z");
  const bothTickets = () => ({
    ticketByItemId: {
      [ITEM_A]: {
        id: TICKET_1,
        ownerHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "VALID",
      } as TicketRecord,
      [ITEM_B]: {
        id: TICKET_2,
        ownerHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_B,
        status: "VALID",
      } as TicketRecord,
    },
    tickets: [
      { id: TICKET_1, status: "VALID" as const, scannedAt: null },
      { id: TICKET_2, status: "VALID" as const, scannedAt: null },
    ],
  });

  it("a buyer's full refund SKIPS the paid-out item (already_paid_out): no reversal, its ticket stays VALID, its item stays active", async () => {
    const ctx = makeContext({
      order: makeOrder({ items: makeItems([{ paidOutAt: PAID_OUT_AT }, {}]) }),
      feeCents: 300,
      ...bothTickets(),
    });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out.skippedItems).toEqual([
      { orderItemId: ITEM_A, reason: "already_paid_out" },
    ]);
    expect(out.refundedItems).toEqual([
      // Item B: 5500 buyer-paid minus its 150 fee share — the same number
      // the scanned-ticket skip pins, so the amount formula is untouched.
      { orderItemId: ITEM_B, refundedCents: 5350 },
    ]);
    expect(out.refundedCents).toBe(5350);
    expect(out.newOrderStatus).toBe("PART_REFUNDED");
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5350 }),
    );

    // The payee's money is theirs: nothing is clawed back.
    expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();
    expect(ctx.payments.getTransfer).not.toHaveBeenCalled();
    expect(
      ctx.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT"),
    ).toEqual([]);

    // The paid-out item's ticket is NOT voided and its item is NOT touched —
    // the voiding loop reads every ticket on the order, so the keep-list
    // must name `already_paid_out` or the buyer would lose a pass they were
    // not refunded for.
    const setStatusCalls = (
      ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(setStatusCalls.map((c) => c[0])).toEqual([TICKET_2]);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_B,
      "refunded",
      NOW,
      0,
      500, // its own share of the 1000 fee; the paid-out item's 500 is unstamped
    );
  });

  it("a buyer's full refund where EVERY item is paid out throws NO_REFUNDABLE_ITEMS — no Stripe call, no reversal, nothing written", async () => {
    const ctx = makeContext({
      order: makeOrder({
        items: makeItems([
          { paidOutAt: PAID_OUT_AT },
          { paidOutAt: PAID_OUT_AT },
        ]),
      }),
      feeCents: 300,
      ...bothTickets(),
    });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "NO_REFUNDABLE_ITEMS" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
  });

  // The refusal is a POLICY refusal, not an attempt — same rule as the
  // dispute guard and the refund window: it must run BEFORE the shared
  // `order:refund-full:${orderId}` key is claimed. Claiming it and then
  // `fail`ing it leaves a `failed:` marker for the key's TTL (300 s), which
  // locks a staff / org whole-order refund of the SAME order out with
  // IDEMPOTENCY_LOCK_IN_PROGRESS for five minutes after a buyer merely asked.
  function expectNoRefundFullKeyClaim(ctx: ReturnType<typeof makeContext>) {
    const refundKeyBegins = ctx.idempotency.__mocks.begin.mock.calls.filter(
      (call) => String(call[0]).startsWith("order:refund-full:"),
    );
    expect(refundKeyBegins).toHaveLength(0);
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
    // The pre-check is a pure read of the items + tickets: no Stripe read.
    expect(ctx.payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
  }

  it("a buyer's all-paid-out refusal claims no order:refund-full key and marks nothing failed (the staff path on the same order is unchanged)", async () => {
    // What this proves is the two mock assertions below (no `begin` on the
    // refund-full key, no `fail`). The staff call afterwards is NOT a lockout
    // probe — the fake port's `fail` deletes the lock, so a re-`begin` would
    // succeed even on the old code — it pins that the staff path's amounts
    // are untouched by the hoisted buyer pre-check.
    const ctx = makeContext({
      order: makeOrder({
        items: makeItems([
          { paidOutAt: PAID_OUT_AT },
          { paidOutAt: PAID_OUT_AT },
        ]),
      }),
      feeCents: 300,
      ...bothTickets(),
    });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "NO_REFUNDABLE_ITEMS" });

    expectNoRefundFullKeyClaim(ctx);

    // Staff on the same order, right after: the reversal path is untouched
    // by the buyer pre-check, and the key was never marked failed.
    const out = await refundFullOrder(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });
    expect(out.refundedCents).toBe(10_700);
    expect(out.refundedItems).toEqual(
      expect.arrayContaining([
        { orderItemId: ITEM_A, refundedCents: 5350 },
        { orderItemId: ITEM_B, refundedCents: 5350 },
      ]),
    );
    expect(out.refundedItems).toHaveLength(2);
    expect(out.skippedItems).toEqual([]);
    expect(out.newOrderStatus).toBe("REFUNDED");
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(2);
  });

  it("a buyer's all-scanned refusal (the other buyer-only skip) is refused before the key is claimed too", async () => {
    const scannedAt = new Date("2025-06-01T11:00:00.000Z");
    const ctx = makeContext({
      feeCents: 300,
      ticketByItemId: {
        [ITEM_A]: {
          id: TICKET_1,
          ownerHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_A,
          status: "SCANNED",
          scannedAt,
        } as TicketRecord,
        [ITEM_B]: {
          id: TICKET_2,
          ownerHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_B,
          status: "SCANNED",
          scannedAt,
        } as TicketRecord,
      },
      tickets: [
        { id: TICKET_1, status: "SCANNED", scannedAt },
        { id: TICKET_2, status: "SCANNED", scannedAt },
      ],
    });

    await expect(
      refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "NO_REFUNDABLE_ITEMS" });

    expectNoRefundFullKeyClaim(ctx);
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("staff (_skipBuyerCheck) on an all-listed order still claim the key and release it — the pre-check is buyer-only", async () => {
    // A staff refusal for "nothing refundable" is thrown inside the attempt:
    // the key is claimed, then released (abandonClaim; an AppError refusal
    // is not a deterministic `invalid_input`). Pins that the hoisted
    // pre-check never runs for staff.
    const ctx = makeContext({
      ticketByItemId: {
        [ITEM_A]: {
          id: TICKET_1,
          ownerHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_A,
          status: "LISTED",
        } as TicketRecord,
        [ITEM_B]: {
          id: TICKET_2,
          ownerHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_B,
          status: "LISTED",
        } as TicketRecord,
      },
    });

    await expect(
      refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ code: "NO_REFUNDABLE_ITEMS" });

    expect(ctx.idempotency.__mocks.begin).toHaveBeenCalledWith(
      `order:refund-full:${ORDER_ID}`,
      expect.any(Number),
      expect.any(String),
    );
    expect(ctx.idempotency.__mocks.release).toHaveBeenCalledWith(
      `order:refund-full:${ORDER_ID}`,
      expect.any(String),
    );
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
  });

  it("staff (_skipBuyerCheck) on the same mixed order still reverse the paid-out item's transfer and refund BOTH items for the unchanged 10_700", async () => {
    const ctx = makeContext({
      order: makeOrder({ items: makeItems([{ paidOutAt: PAID_OUT_AT }, {}]) }),
      feeCents: 300,
      ...bothTickets(),
    });

    const out = await refundFullOrder(
      { ...makeDeps(ctx), _skipBuyerCheck: true },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    expect(out.skippedItems).toEqual([]);
    // Direct items come before reversal items in the output; the SET is
    // what matters here.
    expect(out.refundedItems).toEqual(
      expect.arrayContaining([
        { orderItemId: ITEM_A, refundedCents: 5350 },
        { orderItemId: ITEM_B, refundedCents: 5350 },
      ]),
    );
    expect(out.refundedItems).toHaveLength(2);
    // 2 × 5500 buyer-paid − 300 Stripe fee: the pre-decision amount.
    expect(out.refundedCents).toBe(10_700);
    expect(out.newOrderStatus).toBe("REFUNDED");
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: `tr_settlement-sl-${ITEM_A}`,
        idempotencyKey: `order:refund-full:${ORDER_ID}:reverse-transfer:tr_settlement-sl-${ITEM_A}`,
      }),
    );
    const setStatusCalls = (
      ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(setStatusCalls.map((c) => c[0]).sort()).toEqual(
      [TICKET_1, TICKET_2].sort(),
    );
  });
});

// ── Stripe refund metadata (money audit 2026-09-08 #10) ─────────────────────
describe("refundFullOrder — Stripe refund metadata names the items", () => {
  it("stamps useCase, orderId and the sorted refunded item ids on the Stripe refund", async () => {
    const ctx = makeContext();

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    const call = (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0] as { metadata?: Record<string, string> };
    expect(call.metadata).toEqual({
      useCase: "refundFullOrder",
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_B].sort().join(","),
      orderItemCount: "2",
    });
  });
});

// ── refundedPlatformFeeCents stamp ──────────────────────────────────────────
// docs/decisions/absorb-refund-returns-platform-fee.md: the platform fee is
// refunded in BOTH modes; the stamp records each item's share of it beside
// `refundedTaxCents`, from the same allocation over the same ticket items.
describe("refundedPlatformFeeCents stamp", () => {
  it("ABSORB: stamps the 50 the platform absorbed at checkout and gives back now", async () => {
    const items = makeItems([
      {
        unitPriceCents: 3500,
        amountCents: 3500,
        meta: {
          buyerTotalCents: 3500,
          effectiveFeeMode: "ABSORB",
          platformFeePerTicketCents: 50,
        },
      },
    ]).slice(0, 1);
    const order = makeOrder({
      amountGrossCents: 3500,
      feesPlatformCents: 50,
      feePolicySnapshot: { feeMode: "ABSORB" },
      items,
    });
    const ctx = makeContext({ order, feeCents: 132 });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      50,
    );
  });

  it("PASS_THROUGH: stamps the 50 the buyer paid on top and gets back", async () => {
    const items = makeItems([
      {
        unitPriceCents: 3500,
        amountCents: 3500,
        meta: {
          buyerTotalCents: 3550,
          effectiveFeeMode: "PASS_THROUGH",
          platformFeePerTicketCents: 50,
        },
      },
    ]).slice(0, 1);
    const order = makeOrder({
      amountGrossCents: 3500,
      feesPlatformCents: 50,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items,
    });
    const ctx = makeContext({ order, feeCents: 137 });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      50,
    );
  });

  it("legacy meta: allocates the order fee by buyer-paid weight and the stamps sum to it (1000 → 500 + 500)", async () => {
    const ctx = makeContext({ feeCents: 300 });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    const stamped = (
      ctx.txRepos.orderItems.updateStatus as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[4] as number);
    expect(stamped).toEqual([500, 500]);
    expect(stamped.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("zero platform fee: stamps a measured 0 on every item, never NULL", async () => {
    const order = makeOrder({ feesPlatformCents: 0 });
    const ctx = makeContext({ order, feeCents: 300 });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    const stamped = (
      ctx.txRepos.orderItems.updateStatus as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[4]);
    expect(stamped).toEqual([0, 0]);
  });
});

// ── Retry after a crash between the Stripe refund and the commit ───────────
// Money audit 2026-09-08 #10, second layer. The full path's use-case key is
// per-order (`order:refund-full:${orderId}`), so a same-path retry finds the
// released key and re-enters with the SAME Stripe idempotency key — which
// Stripe only honours for 24h, and which the item path's namespace never
// shares. The pre-flight lists the PaymentIntent's refunds and reuses the
// one whose stamped metadata names exactly these items.
describe("refundFullOrder — retry after a crash between Stripe and the commit", () => {
  it("reuses the first refund: no second Stripe refund, items flip against the first refund id, one ledger debit", async () => {
    const ctx = makeContext({ feeCents: 300 });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 10_700,
      items: { [ITEM_A]: 5_350, [ITEM_B]: 5_350 },
    });
    (ctx.repos.tx as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db_connection_lost"),
    );
    await expect(
      refundFullOrder(makeDeps(ctx), { actorHumanId: ACTOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "dependency_failed" });
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    // Released, not failed: the retry below runs at once, no 15-min lockout.
    expect(ctx.idempotency.__mocks.release).toHaveBeenCalledWith(
      `order:refund-full:${ORDER_ID}`,
      expect.any(String),
    );
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out.ok).toBe(true);
    expect(out.refundId).toBe("re_test_123");
    expect(out.refundedCents).toBe(10_700);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.payments.listRefundsForPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_123",
    });
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      expect.any(Number),
      expect.anything(),
    );
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_B,
      "refunded",
      NOW,
      expect.any(Number),
      expect.anything(),
    );
    const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      amountCents: 10_700,
      idempotencyKey: `refund-debit:${ORDER_ID}:payee-1:re_test_123`,
    });
  });

  it("reuses a crashed ITEM-path refund that named every item (different key namespace, same set)", async () => {
    const ctx = makeContext({ feeCents: 300 });
    // What `refundOrderItems([A, B])` left at Stripe after its tx died: the
    // same amount this path computes for [A, B] (11 000 buyer-paid − 300 fee).
    ctx.refundRecords.set("pi_123", [
      {
        refundId: "re_items_1",
        amountCents: 10_700,
        status: "succeeded",
        metadata: {
          useCase: "refundOrderItems",
          orderId: ORDER_ID,
          orderItemCount: "2",
          orderItemIds: [ITEM_A, ITEM_B].sort().join(","),
        },
      },
    ]);

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out.ok).toBe(true);
    expect(out.refundId).toBe("re_items_1");
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("refuses when a crashed item refund covered only [A]: typed conflict, no Stripe refund, no tx", async () => {
    const ctx = makeContext({ feeCents: 300 });
    ctx.refundRecords.set("pi_123", [
      {
        refundId: "re_items_a",
        amountCents: 5_350,
        status: "succeeded",
        metadata: {
          useCase: "refundOrderItems",
          orderId: ORDER_ID,
          orderItemCount: "1",
          orderItemIds: ITEM_A,
        },
      },
    ]);

    await expect(
      refundFullOrder(makeDeps(ctx), { actorHumanId: ACTOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({
      code: "REFUND_ALREADY_ISSUED_FOR_ITEMS",
      meta: expect.objectContaining({
        orderId: ORDER_ID,
        refundId: "re_items_a",
        overlappingOrderItemIds: [ITEM_A],
      }),
    });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("refuses when a refund on this PaymentIntent names a DIFFERENT order: typed error, no Stripe refund", async () => {
    const ctx = makeContext({ feeCents: 300 });
    ctx.refundRecords.set("pi_123", [
      {
        refundId: "re_foreign_1",
        amountCents: 100,
        status: "succeeded",
        metadata: {
          useCase: "refundFullOrder",
          orderId: "44444444-4444-4444-8444-444444444444",
          orderItemCount: "1",
          orderItemIds: ITEM_A,
        },
      },
    ]);

    await expect(
      refundFullOrder(makeDeps(ctx), { actorHumanId: ACTOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({
      code: "REFUND_METADATA_ORDER_MISMATCH",
      meta: expect.objectContaining({
        orderId: ORDER_ID,
        refundId: "re_foreign_1",
        metadataOrderId: "44444444-4444-4444-8444-444444444444",
      }),
    });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("a failed refund LISTING is a dependency failure — never swallowed into a fresh refund", async () => {
    const ctx = makeContext({ feeCents: 300 });
    (
      ctx.payments.listRefundsForPaymentIntent as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe_down"));

    await expect(
      refundFullOrder(makeDeps(ctx), { actorHumanId: ACTOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      message: "list_refunds_for_payment_intent",
    });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });
});

// ── Idempotency claim on failure (lib/idempotency-claim.ts) ───────────────
// The real adapters keep a `failed` record for 15 minutes and refuse `begin`
// while it lives, so a transient failure RELEASES the claim instead. A
// `commit` that throws after the refund committed must NOT release it: the
// retry would redo committed work.
describe("refundFullOrder — idempotency claim on failure", () => {
  const KEY = `order:refund-full:${ORDER_ID}`;

  it("a transient Stripe failure releases the claim: the same-key retry proceeds immediately", async () => {
    const ctx = makeContext({ feeCents: 300 });
    (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe_timeout"));

    await expect(
      refundFullOrder(staffDeps(ctx), { actorHumanId: ACTOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "dependency_failed" });
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();

    const out = await refundFullOrder(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });
    expect(out.ok).toBe(true);
    // Same Stripe idempotency key both times: Stripe dedupes the pair.
    const keys = (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mock.calls.map(([args]) => (args as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([
      `${KEY}:refund-payment-intent`,
      `${KEY}:refund-payment-intent`,
    ]);
  });

  it("a commit that throws after the refund committed keeps the claim: the retry is refused, no second Stripe call", async () => {
    const ctx = makeContext({ feeCents: 300 });
    ctx.idempotency.__mocks.commit.mockRejectedValueOnce(
      new Error("idempotency_store_down"),
    );

    await expect(
      refundFullOrder(staffDeps(ctx), { actorHumanId: ACTOR_ID, orderId: ORDER_ID }),
    ).rejects.toThrow("idempotency_store_down");
    expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
    expect(
      ctx.idempotency.__mocks.release.mock.calls.filter(([k]) => k === KEY),
    ).toHaveLength(0);
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();

    await expect(
      refundFullOrder(staffDeps(ctx), { actorHumanId: ACTOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
  });

  it("a lost release (claim no longer ours) is reported, tagged refundFullOrder", async () => {
    const ctx = makeContext({ feeCents: 300 });
    (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe_timeout"));
    // The use-case claim's release runs first (the mutex's runs in its
    // `finally` afterwards).
    ctx.idempotency.__mocks.release.mockResolvedValueOnce(false);
    const reportError = vi.fn();

    await expect(
      refundFullOrder(
        { ...staffDeps(ctx), reportError },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    const lost = reportError.mock.calls.filter(
      ([, ctx2]) =>
        (ctx2 as { tags?: { stage?: string } })?.tags?.stage ===
        "idempotency_claim_lost_on_abandon",
    );
    expect(lost).toHaveLength(1);
    expect(lost[0]![1]).toMatchObject({
      tags: { useCase: "refundFullOrder" },
      extra: { key: KEY },
    });
  });
});

// Owner ruling 2026-10-11: "yeah it should refund 0 because that's what it
// cost. Otherwise we will get taken advantage of".
describe("refundFullOrder — a ticket that cost $0", () => {
  const DISCOUNT_ITEM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  /**
   * The shape of dev order f425308e: a $125 VIP a 100% VIP code freed (ITEM_A)
   * beside a paid $50 GA (ITEM_B). Charged 5245 + 444 tax = 5689; the
   * processor kept 195.
   */
  function freedOrder(): OrderRecord {
    const [vip, ga] = makeItems([
      {
        ticketTypeId: "tt-vip",
        unitPriceCents: 12_500,
        amountCents: 12_500,
        meta: {
          buyerTotalCents: 12_500,
          discountedToZero: true,
          platformFeePerTicketCents: 0,
          processorFeeShareCents: 0,
        },
      },
      {
        meta: {
          buyerTotalCents: 5_245,
          platformFeePerTicketCents: 50,
          processorFeeShareCents: 195,
        },
      },
    ]);
    return makeOrder({
      amountGrossCents: 5_000,
      feesPlatformCents: 50,
      taxAmountCents: 444,
      items: [
        {
          ...vip!,
          id: DISCOUNT_ITEM,
          kind: "discount",
          ticketTypeId: null,
          unitPriceCents: -12_500,
          amountCents: -12_500,
          meta: {},
        } as unknown as OrderItemRecord,
        vip!,
        ga!,
      ],
    });
  }

  const ticket = (
    id: string,
    orderItemId: string,
    status: TicketRecord["status"],
    scannedAt: Date | null = null,
  ) =>
    ({
      id,
      ownerHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemId,
      status,
      scannedAt,
    }) as TicketRecord;

  it("(c) a full refund returns exactly charge − processing fee, all of it for the paid ticket", async () => {
    const ctx = makeContext({
      order: freedOrder(),
      feeCents: 195,
      ticketByItemId: {
        [ITEM_A]: ticket(TICKET_1, ITEM_A, "VALID"),
        [ITEM_B]: ticket(TICKET_2, ITEM_B, "VALID"),
      },
    });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 4_950,
      items: { [ITEM_B]: 4_950 },
    });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    // Unchanged in total (5689 − 195); pre-fix the split was 3871 / 1623.
    expect(out.refundedCents).toBe(5_494);
    expect(out.refundedItems).toEqual([
      { orderItemId: ITEM_A, refundedCents: 0 },
      { orderItemId: ITEM_B, refundedCents: 5_494 },
    ]);
    expect(out.newOrderStatus).toBe("REFUNDED");
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5_494 }),
    );
    // Stamps: the freed ticket gave back no tax and no platform fee.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      0,
    );
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_B,
      "refunded",
      NOW,
      444,
      50,
    );
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toMatchObject([
      { amountCents: 4_950 },
    ]);
  });

  /**
   * The buyer has the paid GA up for resale (skipped: `listing_active`) and
   * refunds the order: only the freed VIP is refundable, and it cost $0.
   */
  function listedGaContext() {
    const order = freedOrder();
    order.items.find((item) => item.id === ITEM_B)!.resaleListingId =
      RESALE_LISTING_ID;
    return makeContext({
      order,
      feeCents: 195,
      ticketByItemId: {
        [ITEM_A]: ticket(TICKET_1, ITEM_A, "VALID"),
        [ITEM_B]: ticket(TICKET_2, ITEM_B, "LISTED"),
      },
      tickets: [
        { id: TICKET_1, status: "VALID", scannedAt: null },
        { id: TICKET_2, status: "LISTED", scannedAt: null },
      ],
    });
  }

  it("refunds $0 with no Stripe call when the freed ticket is the only refundable one", async () => {
    // Before this change the refund was refused with REFUND_AMOUNT_ZERO.
    const ctx = listedGaContext();
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 4_950,
      items: { [ITEM_B]: 4_950 },
    });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(out.refundedCents).toBe(0);
    expect(out.refundedItems).toEqual([
      { orderItemId: ITEM_A, refundedCents: 0 },
    ]);
    expect(out.skippedItems).toEqual([
      { orderItemId: ITEM_B, reason: "listing_active" },
    ]);
    expect(out.newOrderStatus).toBe("PART_REFUNDED");
    expect(out.refundId).toMatch(/^nocharge_[0-9a-f]{24}$/);

    // No processor call of any kind: the freed ticket has no share of the
    // credit, is in no payout plan and is never stamped `paidOutAt`, so
    // there is no reversal to look up either.
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.listRefundsForPaymentIntent).not.toHaveBeenCalled();
    expect(
      ctx.repos.payoutItems.listTransferredByPlannedOrderItemIds,
    ).not.toHaveBeenCalled();
    expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();

    // The freed ticket is voided; the listed one stays on resale.
    const setStatusCalls = (
      ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(setStatusCalls.map((c) => c[0])).toEqual([TICKET_1]);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      0,
    );
    // 0 is a PARTIAL amount: the order must not close as REFUNDED.
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID, 0);
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refunded",
        data: expect.objectContaining({
          refundId: out.refundId,
          moneyMoved: false,
          refundedCents: 0,
          newOrderStatus: "PART_REFUNDED",
        }),
      }),
    );
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
  });

  // Review finding, 2026-10-11 (BLOCKING): a $0 refund told the buyer "$0.00
  // is on its way back to your original payment method".
  it("tells the buyer the ticket was returned, en and es, and never that money is on its way", async () => {
    const ctx = listedGaContext();

    const out = await refundFullOrder(makeDeps(ctx, { withNotify: true }), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.notify).toHaveBeenCalledTimes(1);
    const sent = (ctx.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent).toMatchObject({
      humanId: ACTOR_ID,
      variant: "order.refund-processed",
      idempotencyKey: `order-refund:${out.refundId}`,
      payload: {
        orderId: ORDER_ID,
        refundId: out.refundId,
        amountCents: 0,
        currency: "usd",
        status: "PART_REFUNDED",
        ticketCount: 1,
      },
      channels: {
        inApp: { enabled: true },
        email: { enabled: false },
        sms: { enabled: false },
      },
    });

    // What the buyer reads, through the real renderer. (The harness order's
    // `eventId` is the placeholder "event-1"; the schema wants a uuid.)
    const render = (locale: "en" | "es") =>
      renderNotification(
        "order.refund-processed",
        { ...sent.payload, eventId: ORDER_ID, eventTitle: "Sunset Sessions" },
        { now: NOW, locale },
      );
    const en = render("en");
    expect(en.inApp?.title).toBe("Ticket returned");
    expect(en.inApp?.body).toBe(
      "Your ticket for Sunset Sessions was returned. There is no money to refund for it.",
    );
    expect(en.inApp?.kind).toBe("INFO");
    expect(en.push?.title).toBe("Ticket returned");
    expect(en.push?.body).toBe(en.inApp?.body);
    expect(en.email).toBeUndefined();

    const es = render("es");
    expect(es.inApp?.title).toBe("Entrada devuelta");
    expect(es.inApp?.body).toBe(
      "Tu entrada para Sunset Sessions fue devuelta. No hay dinero que reembolsar por ella.",
    );

    for (const text of [en.inApp?.body, en.push?.body, es.inApp?.body]) {
      expect(text).not.toMatch(/on its way|de camino/);
    }
  });

  // Review finding, 2026-10-11: the reversal used to be skipped whenever the
  // BUYER amount was $0. Whether there is money to pull back depends on what
  // the payee was paid for the item.
  describe("a paid-out cheap ticket whose refund clamps to $0", () => {
    /** One 20¢ ticket, paid out; the processor kept 31¢ of the 20¢ charged. */
    async function cheapPaidOutContext() {
      const order = makeOrder({
        amountGrossCents: 20,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        items: makeItems([
          {
            unitPriceCents: 20,
            amountCents: 20,
            meta: { buyerTotalCents: 20 },
            paidOutAt: new Date("2026-08-12T00:00:00.000Z"),
          },
        ]).slice(0, 1),
      });
      const ctx = makeContext({
        order,
        orderForTx: order,
        feeCents: 31,
        ticketByItemId: { [ITEM_A]: ticket(TICKET_1, ITEM_A, "VALID") },
        tickets: [{ id: TICKET_1, status: "VALID", scannedAt: null }],
      });
      (
        ctx.repos.orderItemSettlementLines.listByOrderItemIds as ReturnType<
          typeof vi.fn
        >
      ).mockResolvedValue([]);
      (
        ctx.repos.payoutItems
          .listTransferredByPlannedOrderItemIds as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          payoutItemId: "pitem-cheap",
          stripeTransferId: "tr_cheap",
          payeeId: "payee-1",
          currency: "usd",
          plannedOrderItemIds: [ITEM_A],
          amountCents: 18,
          netAmountCents: 18,
        },
      ]);
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 18,
        items: { [ITEM_A]: 18 },
      });
      return ctx;
    }

    it("reverses the payee's transfer and makes no Stripe refund", async () => {
      const ctx = await cheapPaidOutContext();

      const out = await refundFullOrder(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });

      expect(out.refundedCents).toBe(0);
      expect(out.newOrderStatus).toBe("REFUNDED");
      expect(out.refundId).toMatch(/^nocharge_[0-9a-f]{24}$/);
      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
      expect(ctx.payments.listRefundsForPaymentIntent).not.toHaveBeenCalled();
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
      expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ transferId: "tr_cheap", amountCents: 18 }),
      );
      // The debit and the reversal credit net to zero on the payee's balance.
      expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toMatchObject([
        { payeeId: "payee-1", amountCents: 18 },
      ]);
      expect(
        ctx.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT"),
      ).toMatchObject([{ payeeId: "payee-1", amountCents: 18 }]);
      expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "refunded",
          data: expect.objectContaining({
            moneyMoved: false,
            refundedCents: 0,
            transferReversals: [
              expect.objectContaining({
                orderItemId: ITEM_A,
                reversedCents: 18,
              }),
            ],
          }),
        }),
      );
    });

    it("a failed reversal aborts the refund, as on a paid refund: nothing is marked and the retry goes through", async () => {
      const ctx = await cheapPaidOutContext();
      (ctx.payments.reverseTransfer as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("stripe_down"));
      const input = { actorHumanId: ACTOR_ID, orderId: ORDER_ID };

      await expect(refundFullOrder(staffDeps(ctx), input)).rejects.toBeTruthy();

      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
      expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);

      const retry = await refundFullOrder(staffDeps(ctx), input);
      expect(retry.refundedCents).toBe(0);
      expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
    });
  });
});
