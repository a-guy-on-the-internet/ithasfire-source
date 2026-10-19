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
import { quoteItemRefund } from "../quote-item-refund";
import { refundOrderItems } from "../refund-order-items";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TICKET_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const TICKET_2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const TICKET_3 = "33333333-cccc-4ccc-8ccc-333333333333";

const NOW = new Date("2025-06-01T12:00:00.000Z");

function makeItems(): OrderItemRecord[] {
  return [
    {
      id: ITEM_A,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: "tt-ga",
      qty: 1,
      unitPriceCents: 3000,
      amountCents: 3000,
      meta: { buyerTotalCents: 3300 },
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
      unitPriceCents: 3000,
      amountCents: 3000,
      meta: { buyerTotalCents: 3300 },
      paidOutAt: null,
      refundedAt: null,
      transferredAt: null,
      status: "active",
    },
    {
      id: ITEM_C,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: "tt-vip",
      qty: 1,
      unitPriceCents: 3000,
      amountCents: 3000,
      meta: { buyerTotalCents: 3300 },
      paidOutAt: null,
      refundedAt: null,
      transferredAt: null,
      status: "active",
    },
  ];
}

function makeOrder(partial: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: "event-1",
    buyerHumanId: ACTOR_ID,
    amountGrossCents: 9000,
    feesPlatformCents: 900,
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

function makeTickets(): Array<
  Pick<TicketRecord, "id" | "status" | "scannedAt">
> {
  return [
    { id: TICKET_1, status: "VALID", scannedAt: null },
    { id: TICKET_2, status: "VALID", scannedAt: null },
    { id: TICKET_3, status: "VALID", scannedAt: null },
  ];
}

function makeFullTickets(): TicketRecord[] {
  const base = {
    eventId: "event-1",
    ownerHumanId: ACTOR_ID,
    orderId: ORDER_ID,
    orderItemId: null,
    seatId: null,
    code: "TK-001",
    issuedAt: new Date("2025-01-01"),
    scannedAt: null,
  };
  return [
    {
      ...base,
      id: TICKET_1,
      ticketTypeId: "tt-ga",
      orderItemId: ITEM_A,
      status: "VALID",
      code: "TK-001",
    },
    {
      ...base,
      id: TICKET_2,
      ticketTypeId: "tt-ga",
      orderItemId: ITEM_B,
      status: "VALID",
      code: "TK-002",
    },
    {
      ...base,
      id: TICKET_3,
      ticketTypeId: "tt-vip",
      orderItemId: ITEM_C,
      status: "VALID",
      code: "TK-003",
    },
  ];
}

function makeContext(opts?: {
  order?: OrderRecord | null;
  orderForTx?: OrderRecord | null;
  feeCents?: number;
  itemsForTx?: OrderItemRecord[];
  tickets?: Array<Pick<TicketRecord, "id" | "status" | "scannedAt">>;
  fullTickets?: TicketRecord[];
  authAccounts?: Array<{
    providerId: string;
    accountId: string;
    createdAt: Date;
  }>;
  /** Event start (buyer refund window). Default: far after NOW. */
  eventStartsAt?: Date;
  /** Organizer's explicit refund cutoff (null = none). */
  eventRefundCutoffAt?: Date | null;
}) {
  const order = opts?.order ?? makeOrder();
  const orderForTx = opts?.orderForTx ?? order;
  const feeCents = opts?.feeCents ?? 300;
  const itemsForTx = opts?.itemsForTx ?? makeItems();
  const tickets = opts?.tickets ?? makeTickets();
  const fullTickets = opts?.fullTickets ?? makeFullTickets();
  const eventStartsAt =
    opts?.eventStartsAt ?? new Date("2025-12-01T00:00:00.000Z");
  const eventRefundCutoffAt = opts?.eventRefundCutoffAt ?? null;

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
      id === ACTOR_ID ? { id } : null,
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
    listByOrderId: vi.fn(async () => itemsForTx),
    // Ledger-era reversal amounts resolve item → order → credit attribution.
    getById: vi.fn(
      async (id: string) => order?.items.find((i) => i.id === id) ?? null,
    ),
  } as unknown as OrderItemsRepo;

  const ticketsRepo: TicketsRepo = {
    listByOrderId: vi.fn(async () => tickets),
    getById: vi.fn(
      async (id: string) => fullTickets.find((t) => t.id === id) ?? null,
    ) as unknown as TicketsRepo["getById"],
    getByOrderItemId: vi.fn(
      async (orderItemId: string) =>
        fullTickets.find((t) => t.orderItemId === orderItemId) ?? null,
    ) as unknown as TicketsRepo["getByOrderItemId"],
    setStatus: vi.fn(async () => {}),
  } as unknown as TicketsRepo;

  const auditRepo: AuditRepo = {
    log: vi.fn(async () => {}),
  };

  const idempotency = createFakeIdempotencyPort();

  // In-memory payee ledger honoring real key-replay semantics — the refund
  // rule's debits/reversal credits are asserted against its entries.
  const payeeLedger = createFakePayeeLedgerRepo();

  // Build tx repos (used inside the transaction)
  const txRepos = {
    payeeLedger: payeeLedger.repo,
    orders: {
      listTaxLines: vi.fn(async () => []),
      getById: vi.fn(async (id: string) =>
        id === ORDER_ID ? orderForTx : null,
      ),
      markRefunded: vi.fn(async () => {}),
    },
    orderItems: {
      updateStatus: vi.fn(async () => {}),
      listByOrderId: vi.fn(async () => itemsForTx),
      // Seat history: the former seat is stamped onto the order item just
      // before the ticket's @unique `seatId` link is cleared.
      recordReleasedSeats: vi.fn(async () => {}),
    },
    tickets: {
      listByOrderId: vi.fn(async () => tickets),
      getById: vi.fn(
        async (id: string) => fullTickets.find((t) => t.id === id) ?? null,
      ),
      getByOrderItemId: vi.fn(
        async (orderItemId: string) =>
          fullTickets.find((t) => t.orderItemId === orderItemId) ?? null,
      ),
      setStatus: vi.fn(async () => {}),
      clearSeatAssignments: vi.fn(async () => {}),
    },
    // Reserved seats of the tickets this partial refund kills go back on sale.
    seats: {
      updateStatuses: vi.fn(async () => {}),
      releaseSeats: vi.fn(async () => {}),
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
    // SETTLEMENT_CREDIT attribution (same fake instance as the tx repo).
    payeeLedger: payeeLedger.repo,
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
    // items — tests that exercise the pre-cutover junction attach their own
    // orderItemSettlementLines/settlementLines/settlements mocks.
    payoutItems: {
      listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
    },
    tx: vi.fn(async (fn: any) => fn(txRepos)),
  } as unknown as Repos;

  // STATEFUL Stripe-mirroring reversal fake (same pattern as
  // refund-full-order.test.ts): a transfer with a registered capacity
  // REJECTS any reversal whose CUMULATIVE total would exceed it; a repeated
  // idempotency key REPLAYS on the same amount and throws
  // same-key-different-params on a different one — exactly what live Stripe
  // does. `getTransfer` serves the remaining-capacity pre-flight off the
  // SAME cumulative tracking, and `listTransferReversals` serves the
  // retry-recovery path from the recorded reversals (pre-seeded
  // `reversedByTransfer` entries model FOREIGN reversals: consumed
  // capacity, no listed record). Unregistered ids are unbounded.
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

  const notify = vi.fn(async () => ({}) as never);

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

describe("refundOrderItems", () => {
  it("rejects a repeated order item id before touching idempotency or Stripe", async () => {
    const ctx = makeContext();

    // Both ids belong to the order, so the membership check passed; the
    // quote then produced TWO eligible quotes for one item, summed them, and
    // sent 2x the item's share to Stripe while marking the item refunded
    // once. Nothing in the database ever showed the double payment.
    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_A],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    // A rejected request is not an attempt: no `failed:` marker may block the
    // corrected retry for the marker's TTL.
    expect(ctx.idempotency.begin).not.toHaveBeenCalled();
  });

  it("refunds one item → PART_REFUNDED", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.ok).toBe(true);
    expect(out.orderId).toBe(ORDER_ID);
    expect(out.refundId).toBe("re_test_123");
    expect(out.currency).toBe("usd");
    expect(out.newOrderStatus).toBe("PART_REFUNDED");
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.orderItemId).toBe(ITEM_A);

    // Stripe refund called with correct partial amount
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_123",
        amountCents: out.totalRefundedCents,
      }),
    );

    // Item marked as refunded inside tx, with the tax portion of the refund
    // it just received (0 — this order has no tax) and the platform-fee
    // portion (300 — 900 allocated over three equal legacy items).
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      300,
    );

    // Order marked as PART_REFUNDED (partial cents passed)
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      out.totalRefundedCents,
    );

    // Audit log written
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        entityId: ORDER_ID,
        action: "items_refunded",
      }),
    );
  });

  // ── Money audit 2026-09-08 #19 ────────────────────────────────────────────
  // The quote classified the item as `active` OUTSIDE the transaction and
  // Stripe has already moved the money by the time the flip runs. A gift or an
  // email claim that committed in that window WON the row. The refund must not
  // fail late — the money really did move — but the anomaly (somebody holds a
  // pass for a ticket that was simultaneously refunded) has to reach a human.
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

    const out = await refundOrderItems(
      { ...makeDeps(ctx), reportError },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    // Refund completes, amounts untouched by the race — the quote that priced
    // it is the same one Stripe was called with.
    expect(out.ok).toBe(true);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: out.totalRefundedCents }),
    );

    // The raced item is STILL marked refunded: that is what actually happened,
    // and the ticket-void step below it kills the pass the recipient was given.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      300,
    );

    const raced = reportError.mock.calls.filter(
      ([err]) => (err as Error | undefined)?.message === "refund_item_raced_after_quote",
    );
    expect(raced).toHaveLength(1);
    expect(raced[0]![1]).toEqual({
      tags: {
        useCase: "refundOrderItems",
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

    await refundOrderItems(
      { ...makeDeps(ctx), reportError },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    expect(
      reportError.mock.calls.filter(
        ([err]) => (err as Error | undefined)?.message === "refund_item_raced_after_quote",
      ),
    ).toHaveLength(0);
  });

  it("refunds all items → REFUNDED", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_B, ITEM_C],
    });

    expect(out.ok).toBe(true);
    expect(out.newOrderStatus).toBe("REFUNDED");
    expect(out.items).toHaveLength(3);

    // Order marked as fully REFUNDED (no partial cents)
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      undefined,
    );
  });

  it("marks the correct tickets as REFUNDED by orderItemId FK", async () => {
    const ctx = makeContext({ feeCents: 300 });

    await refundOrderItems(
      makeDeps(ctx),
      // Refund one GA item and the VIP item
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_C],
      },
    );

    // Should mark exactly the tickets linked to ITEM_A and ITEM_C as REFUNDED
    const setStatusCalls = (
      ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
    ).mock.calls;

    // Exactly 2 tickets should be marked REFUNDED
    expect(setStatusCalls).toHaveLength(2);

    // Each call should set REFUNDED status
    for (const call of setStatusCalls) {
      expect(call[1]).toBe("REFUNDED");
    }

    // Check the ticket IDs: TICKET_1 (linked to ITEM_A) and TICKET_3 (linked to ITEM_C)
    const refundedTicketIds = setStatusCalls.map(
      (c: any[]) => c[0],
    ) as string[];
    expect(refundedTicketIds).toContain(TICKET_1); // GA ticket linked to ITEM_A
    expect(refundedTicketIds).toContain(TICKET_3); // VIP ticket linked to ITEM_C
    expect(refundedTicketIds).not.toContain(TICKET_2); // GA ticket linked to ITEM_B — not refunded
  });

  it("rejects when any requested item is ineligible", async () => {
    const order = makeOrder();
    // Mark item A as already refunded
    order.items[0]!.status = "refunded";
    order.items[0]!.refundedAt = new Date();
    const ctx = makeContext({ order });

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "items_not_refundable",
    });

    // Stripe should NOT have been called
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("processes paid-out items after reversing transfers (staff path: buyer refunds stop at payout)", async () => {
    const order = makeOrder();
    order.items[0]!.paidOutAt = new Date();
    const ctx = makeContext({ order });

    // Add settlement mocks needed by reverseTransfersForItems.
    // The item has been paid out but there are no settlement lines in the
    // mock, so the reversal helper will gracefully return an empty array.
    (ctx.repos as any).orderItemSettlementLines = {
      listByOrderItemIds: vi.fn(async () => []),
    };
    (ctx.repos as any).settlementLines = {
      getById: vi.fn(async () => null),
    };
    (ctx.repos as any).settlements = {
      getById: vi.fn(async () => null),
    };

    const out = await refundOrderItems(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.ok).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.orderItemId).toBe(ITEM_A);
  });

  it("LEDGER ERA: reverses the PayoutItem's transfer for the PAYEE-side attribution (junction empty)", async () => {
    const order = makeOrder();
    order.items[0]!.paidOutAt = new Date();
    const ctx = makeContext({ order });

    // Post-cutover: nothing writes the junction — the durable plan is the
    // only route back to the transfer. (No `settlements` repo is attached at
    // all: ledger-era results carry payeeId directly, so any settlement
    // lookup would crash rather than pass silently.)
    (ctx.repos as any).orderItemSettlementLines = {
      listByOrderItemIds: vi.fn(async () => []),
    };
    (
      ctx.repos.payoutItems.listTransferredByPlannedOrderItemIds as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue([
      {
        payoutItemId: "pitem-1",
        stripeTransferId: "tr_ledger_items_1",
        payeeId: "payee-1",
        currency: "usd",
        plannedOrderItemIds: [ITEM_A],
        amountCents: 2_600,
        netAmountCents: 2_600,
      },
    ]);
    // The payee's credit attribution — the source the reversal amount MUST
    // come from (the quote's buyer-side refundableCents would exceed what
    // the transfer held).
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 2_600,
      items: { [ITEM_A]: 2_600 },
    });
    // Stripe-mirroring fake: the transfer held exactly 2_600 — any larger
    // (buyer-side) request rejects, exactly like live Stripe.
    const reverseTransfer = vi.fn(
      async (input: { transferId: string; amountCents?: number }) => {
        if ((input.amountCents ?? 0) > 2_600) {
          throw new Error(
            `stripe_transfer_reversal_exceeds_amount:${input.transferId}`,
          );
        }
        return { reversalId: "trr_ledger_1" };
      },
    );
    (ctx.payments as PaymentProcessorPort).reverseTransfer =
      reverseTransfer as PaymentProcessorPort["reverseTransfer"];

    const out = await refundOrderItems(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.ok).toBe(true);
    // Sanity: the buyer-side quote really is larger than the payee-side net,
    // so honouring itemAmounts here would have been rejected by Stripe.
    expect(out.items[0]!.refundedCents).toBeGreaterThan(2_600);
    expect(reverseTransfer).toHaveBeenCalledTimes(1);
    expect(reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_ledger_items_1",
        amountCents: 2_600,
        idempotencyKey: `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}:reverse-transfer:tr_ledger_items_1`,
        metadata: expect.objectContaining({ payoutItemId: "pitem-1" }),
      }),
    );
  });

  it("SEQUENTIAL REFUNDS on one transfer: refund A (6_000), then refund B reads remaining 3_800 and COMPLETES (200 debt)", async () => {
    // The reviewer's exact scenario, driven end-to-end through TWO
    // sequential calls: the payout's transfer sent 9_800 net (10_000
    // payable − 200 Connect fee) covering items A (6_000) and B (4_000).
    // Refund A alone → 6_000 reverses fine. Refund B "a week later" used to
    // request 4_000 — Stripe's cumulative 10_000 > 9_800 → rejection →
    // the buyer's second refund hard-failed until manual intervention.
    // Now the second call pre-flights the transfer, sees remaining 3_800,
    // reverses exactly that, and the 200 shortfall stays as ledger debt.
    const order = makeOrder();
    order.items[0]!.paidOutAt = new Date();
    order.items[1]!.paidOutAt = new Date();
    const ctx = makeContext({ order });

    (ctx.repos as any).orderItemSettlementLines = {
      listByOrderItemIds: vi.fn(async () => []),
    };
    (
      ctx.repos.payoutItems.listTransferredByPlannedOrderItemIds as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue([
      {
        payoutItemId: "pitem-seq",
        stripeTransferId: "tr_seq_items",
        payeeId: "payee-1",
        currency: "usd",
        plannedOrderItemIds: [ITEM_A, ITEM_B],
        amountCents: 10_000,
        netAmountCents: 9_800,
      },
    ]);
    // Live-Stripe mirror: the transfer only ever held the 9_800 net.
    ctx.transferCapacities.set("tr_seq_items", 9_800);
    // Two DISTINCT provider refunds (the shared fake replays one id, which
    // would collide the refund-keyed ledger idempotency keys across calls).
    let refundSeq = 0;
    (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => ({
      refundId: `re_seq_${++refundSeq}`,
      status: "succeeded" as const,
    }));
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 10_000,
      items: { [ITEM_A]: 6_000, [ITEM_B]: 4_000 },
    });

    // ── Refund A: plenty of capacity, full share reverses ──────────────────
    const outA = await refundOrderItems(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });
    expect(outA.ok).toBe(true);
    expect(ctx.payments.reverseTransfer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        transferId: "tr_seq_items",
        amountCents: 6_000,
      }),
    );
    expect(ctx.reversedByTransfer.get("tr_seq_items")).toBe(6_000);

    // ── Refund B, later: pre-flight reads remaining 3_800 ─────────────────
    const outB = await refundOrderItems(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_B],
    });

    // The buyer's refund COMPLETES — the pre-fix behaviour was a hard
    // failure here (Stripe rejecting 6_000 + 4_000 > 9_800).
    expect(outB.ok).toBe(true);
    // One capacity read per call, one reversal per call.
    expect(ctx.payments.getTransfer).toHaveBeenCalledTimes(2);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(2);
    expect(ctx.payments.reverseTransfer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        transferId: "tr_seq_items",
        amountCents: 3_800,
      }),
    );
    // The transfer is exactly exhausted — the fake would have thrown on a
    // single cent more.
    expect(ctx.reversedByTransfer.get("tr_seq_items")).toBe(9_800);

    // Ledger: refund A nets to zero (6_000 debit / 6_000 credit); refund B
    // carries the 200 shortfall as debt (4_000 debit / 3_800 credit).
    const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
    expect(debits.map((d) => d.amountCents)).toEqual([6_000, 4_000]);
    const reversalCredits = ctx.payeeLedger.entriesOfType(
      "TRANSFER_REVERSAL_CREDIT",
    );
    expect(reversalCredits.map((c) => c.amountCents)).toEqual([6_000, 3_800]);
  });

  it("passes reason to Stripe when provided", async () => {
    const ctx = makeContext({ feeCents: 300 });

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
      reason: "requested_by_customer",
    });

    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "requested_by_customer" }),
    );
  });

  it("replays a committed item refund before doing external work", async () => {
    const cachedResponse = {
      ok: true as const,
      orderId: ORDER_ID,
      refundId: "re_cached_123",
      currency: "usd",
      totalRefundedCents: 3200,
      items: [{ orderItemId: ITEM_A, refundedCents: 3200 }],
      newOrderStatus: "PART_REFUNDED" as const,
    };
    const ctx = makeContext({ order: makeOrder({ status: "PART_REFUNDED" }) });

    ctx.idempotency.__store.set(
      `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}`,
      {
        payloadHash: "",
        response: cachedResponse,
      },
    );

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out).toEqual(cachedResponse);
    // The per-order refund mutex begins (and releases) its own `refund-op:`
    // key even on a replay; the USE-CASE record must not be re-claimed.
    expect(ctx.idempotency.__mocks.begin).not.toHaveBeenCalledWith(
      `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}`,
      expect.anything(),
    );
    expect(
      ctx.payments.getProcessingFeeForPaymentIntent,
    ).not.toHaveBeenCalled();
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("reuses stable provider idempotency keys across a retry after crashing before commit", async () => {
    const order = makeOrder();
    order.items[0]!.paidOutAt = NOW;
    const ctx = makeContext({ order });
    const providerRefundRequestsSent: string[] = [];
    const providerReversalRequestsSent: string[] = [];
    const refundResponses = new Map<
      string,
      { refundId: string; status: "succeeded" }
    >();
    const reversalResponses = new Map<string, { reversalId: string }>();

    (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mockImplementation(async (input: { idempotencyKey?: string }) => {
      if (!input.idempotencyKey) {
        throw new Error("missing_refund_idempotency_key");
      }

      const cached = refundResponses.get(input.idempotencyKey);
      if (cached) {
        return cached;
      }

      providerRefundRequestsSent.push(input.idempotencyKey);
      const created = {
        refundId: "re_retry_123",
        status: "succeeded" as const,
      };
      refundResponses.set(input.idempotencyKey, created);
      return created;
    });

    (ctx.payments as PaymentProcessorPort).reverseTransfer = vi.fn(
      async (input: { idempotencyKey?: string }) => {
        if (!input.idempotencyKey) {
          throw new Error("missing_reversal_idempotency_key");
        }

        const cached = reversalResponses.get(input.idempotencyKey);
        if (cached) {
          return cached;
        }

        providerReversalRequestsSent.push(input.idempotencyKey);
        const created = { reversalId: "trr_retry_123" };
        reversalResponses.set(input.idempotencyKey, created);
        return created;
      },
    ) as PaymentProcessorPort["reverseTransfer"];

    (ctx.repos as Repos & Record<string, unknown>).orderItemSettlementLines = {
      listByOrderItemIds: vi.fn(async () => [
        {
          orderItemId: ITEM_A,
          settlementLineId: "sl_retry_123",
          amountCents: 3200,
        },
      ]),
    };
    (ctx.repos as Repos & Record<string, unknown>).settlementLines = {
      getByIds: vi.fn(async () => [
        {
          id: "sl_retry_123",
          settlementId: "sett_retry_123",
        },
      ]),
    };
    (ctx.repos as Repos & Record<string, unknown>).settlements = {
      getByIds: vi.fn(async () => [
        {
          id: "sett_retry_123",
          stripeTransferId: "tr_retry_123",
        },
      ]),
    };

    (ctx.repos.tx as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: any) => {
        const result = await fn(ctx.txRepos);
        if (
          (ctx.repos.tx as ReturnType<typeof vi.fn>).mock.calls.length === 1
        ) {
          throw new Error("crash_after_stripe_before_commit");
        }
        return result;
      },
    );

    await expect(
      refundOrderItems(staffDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      cause: expect.objectContaining({
        message: expect.stringContaining("crash_after_stripe_before_commit"),
      }),
    });

    const out = await refundOrderItems(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.ok).toBe(true);
    expect(providerRefundRequestsSent).toEqual([
      `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}:refund-payment-intent`,
    ]);
    expect(providerReversalRequestsSent).toEqual([
      `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}:reverse-transfer:tr_retry_123`,
    ]);
  });

  it("does not mark items or order refunded when Stripe reports a pending refund", async () => {
    const ctx = makeContext({ feeCents: 300 });
    (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      refundId: "re_pending_123",
      status: "pending",
    });

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toMatchObject({
      code: "transient",
      message: "refund_not_terminal",
      refundStatus: "pending",
    });

    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
  });

  it("works on a PART_REFUNDED order (remaining items)", async () => {
    // Item A already refunded, requesting B
    const items = makeItems();
    items[0]!.status = "refunded";
    items[0]!.refundedAt = new Date();

    const order = makeOrder({ status: "PART_REFUNDED", items });
    const ctx = makeContext({ order, itemsForTx: items, feeCents: 300 });

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_B],
    });

    expect(out.ok).toBe(true);
    // A is already refunded, B now refunded, C still active → PART_REFUNDED
    expect(out.newOrderStatus).toBe("PART_REFUNDED");
  });

  it("rejects when actor is not the order buyer", async () => {
    const otherActorId = "99999999-9999-4999-8999-999999999999";
    const order = makeOrder({
      buyerHumanId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    });
    const ctx = makeContext({ order });
    // Make the other actor resolvable via humansRepo
    (ctx.repos.humans.getById as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => (id === otherActorId ? { id } : null),
    );

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: otherActorId,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });

    // Stripe should NOT have been called
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects transferred items via quoteItemRefund", async () => {
    const order = makeOrder();
    order.items[0]!.status = "transferred";
    order.items[0]!.transferredAt = new Date();
    const ctx = makeContext({ order });

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "items_not_refundable",
    });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("refund amount sums up correctly for multi-item refund", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_C],
    });

    // Each item: 3300 buyerPaid, fee share = 100 each (3300/9900 * 300)
    // Refundable per item = 3200
    expect(out.totalRefundedCents).toBe(6400);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]!.refundedCents).toBe(3200);
    expect(out.items[1]!.refundedCents).toBe(3200);
  });

  // ── Discounted orders (money review 2026-09-15) ───────────────────────────
  //
  // Execution CONSUMES the quote — `quote.totalRefundableCents` is the amount
  // sent to Stripe, `q.refundableCents` the per-item reversal amount and the
  // audit figure — so it can only be as right as the quote. These cases pin
  // that the money actually moved matches the corrected quote: on a discounted
  // order the refund is the item's share of what was CHARGED, not its
  // pre-discount sticker figure. See `lib/orders/refund-item-base.ts`.

  describe("discounted orders", () => {
    const CREDIT_ITEM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    function creditItem(amountCents: number): OrderItemRecord {
      return {
        id: CREDIT_ITEM,
        orderId: ORDER_ID,
        kind: "platform_credit",
        ticketTypeId: null,
        qty: 1,
        unitPriceCents: 0,
        amountCents,
        meta: {},
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      } as unknown as OrderItemRecord;
    }

    function twoTicketItems(): OrderItemRecord[] {
      return [
        { ...makeItems()[0]!, unitPriceCents: 2500, amountCents: 2500, meta: { buyerTotalCents: 2750 } },
        { ...makeItems()[1]!, unitPriceCents: 2500, amountCents: 2500, meta: { buyerTotalCents: 2750 } },
      ];
    }

    it("refunds one item of a discounted order at its proportional share of the CHARGE", async () => {
      // 2,750 + 2,750 − 1,000 credit = a 4,500 charge. Fee 200 → 100/item.
      const items = [...twoTicketItems(), creditItem(-1_000)];
      const ctx = makeContext({
        order: makeOrder({
          amountGrossCents: 5_000,
          feesPlatformCents: 500,
          items,
        }),
        itemsForTx: items,
        feeCents: 200,
      });

      const out = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      });

      // 2,250 base − 100 fee share. Pre-fix this moved 2,650 (2,750 − 100),
      // i.e. the whole 1,000 credit came back to the buyer per item.
      expect(out.totalRefundedCents).toBe(2_150);
      expect(out.items[0]!.refundedCents).toBe(2_150);
      expect(out.newOrderStatus).toBe("PART_REFUNDED");

      // The amount QUOTED is the amount MOVED — execution never recomputes it.
      expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 2_150 }),
      );
    });

    it("refunding EVERY item of a discounted order moves exactly charge − fee, never more", async () => {
      const items = [...twoTicketItems(), creditItem(-1_000)];
      const ctx = makeContext({
        order: makeOrder({
          amountGrossCents: 5_000,
          feesPlatformCents: 500,
          items,
        }),
        itemsForTx: items,
        feeCents: 200,
      });

      const out = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      });

      // 4,500 charged − 200 processor fee = 4,300. Pre-fix: 5,300 against a
      // 4,500 charge, so the platform ate the 1,000 credit.
      expect(out.totalRefundedCents).toBe(4_300);
      expect(out.newOrderStatus).toBe("REFUNDED");
      expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 4_300 }),
      );
    });

    it("a discount that does not divide evenly loses and invents no cent", async () => {
      // −1,000 over three equal 3,300 items: 8,900 / 3 = 2,966.67 →
      // 2,967 / 2,967 / 2,966 by largest remainder (ties to the lowest id).
      const items = [...makeItems(), creditItem(-1_000)];
      const ctx = makeContext({
        order: makeOrder({ items }),
        itemsForTx: items,
        feeCents: 300,
      });

      const out = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B, ITEM_C],
      });

      expect(out.items.map((i) => i.refundedCents)).toEqual([
        2_867, 2_867, 2_866,
      ]);
      expect(out.totalRefundedCents).toBe(8_900 - 300);
      expect(
        out.items.reduce((sum, i) => sum + i.refundedCents, 0),
      ).toBe(out.totalRefundedCents);
    });

    it("REGRESSION GUARD: an UNdiscounted order moves exactly what it moved before", async () => {
      const ctx = makeContext({ feeCents: 300 });

      const out = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B, ITEM_C],
      });

      // 3 × 3,300 = 9,900 charged, fee 300 → 3,200 per item, 9,600 total.
      expect(out.items.map((i) => i.refundedCents)).toEqual([
        3_200, 3_200, 3_200,
      ]);
      expect(out.totalRefundedCents).toBe(9_600);
    });
  });

  describe("buyer in-app notification", () => {
    it("fires order.refund-processed for a loginable buyer after commit", async () => {
      const ctx = makeContext({ feeCents: 300 });

      const out = await refundOrderItems(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
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
            amountCents: out.totalRefundedCents,
            currency: "usd",
            status: "PART_REFUNDED",
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

    it("skips the notification for a guest buyer with no auth accounts", async () => {
      const ctx = makeContext({ feeCents: 300, authAccounts: [] });

      await refundOrderItems(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      });

      expect(ctx.notify).not.toHaveBeenCalled();
    });

    it("never throws or rolls back the refund when notify fails", async () => {
      const ctx = makeContext({ feeCents: 300 });
      ctx.notify.mockRejectedValueOnce(new Error("notify exploded"));

      const out = await refundOrderItems(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      });

      // Refund still succeeded despite the notify failure.
      expect(out.ok).toBe(true);
      expect(out.refundId).toBe("re_test_123");
      expect(ctx.notify).toHaveBeenCalledTimes(1);
    });

    it("does not call notify when no dispatcher is wired", async () => {
      const ctx = makeContext({ feeCents: 300 });

      await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      });

      expect(ctx.notify).not.toHaveBeenCalled();
    });
  });

  // ── The one refund rule (ledger-authoritative-settlement spec §4) ─────────

  describe("REFUND_DEBIT ledger writes", () => {
    it("debits exactly the refunded item's credited contribution on a partial refund", async () => {
      const ctx = makeContext({ feeCents: 300 });
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 8_100,
        items: { [ITEM_A]: 2_700, [ITEM_B]: 2_700, [ITEM_C]: 2_700 },
      });

      const out = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      });

      // Partial math: the debit is ITEM_A's attributed contribution from the
      // credit's metadata — NOT the buyer refund amount (which folds tax and
      // withholds the Stripe fee).
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({
        payeeId: "payee-1",
        amountCents: 2_700,
        orderId: ORDER_ID,
        idempotencyKey: `refund-debit:${ORDER_ID}:payee-1:${out.refundId}`,
      });
      expect(out.newOrderStatus).toBe("PART_REFUNDED");
    });

    it("returns the FULL credit (not Σ metadata) when the last items refund", async () => {
      const ctx = makeContext({ feeCents: 300 });
      // Zero-share omission: Σ items (8_099) < credit (8_100).
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 8_100,
        items: { [ITEM_A]: 2_700, [ITEM_B]: 2_700, [ITEM_C]: 2_699 },
      });

      const out = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B, ITEM_C],
      });

      expect(out.newOrderStatus).toBe("REFUNDED");
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]!.amountCents).toBe(8_100);
    });
  });

  // ── Per-order refund mutex (concurrent-refund double-pay fix) ────────────
  // Item refunds share the `refund-op:${orderId}` mutex with full-order, org,
  // event-cancel, and resale-claim refunds — the disjoint Stripe idempotency
  // namespaces mean Stripe dedupes nothing across those paths.

  describe("per-order refund mutex", () => {
    it("makes ZERO external calls and writes nothing when another refund holds the order", async () => {
      const ctx = makeContext();
      // e.g. a concurrent buyer full-order refund holds the mutex.
      ctx.idempotency.__locks.set(
        `refund-op:${ORDER_ID}`,
        Date.now() + 600_000,
      );

      await expect(
        refundOrderItems(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
        message: "order_refund_in_progress",
      });

      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
      expect(
        ctx.payments.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.idempotency.__mocks.commit).not.toHaveBeenCalled();
      // Never acquired → never released; the holder's lock is untouched.
      expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
      expect(ctx.idempotency.__mocks.release).not.toHaveBeenCalled();
    });

    it("release-on-success: sequential item refunds on the same order both succeed", async () => {
      const ctx = makeContext();

      // Item 1 today…
      const first = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      });
      expect(first.ok).toBe(true);
      // …mutex freed via owner-checked release with the acquire's own token…
      const beginCall = ctx.idempotency.__mocks.begin.mock.calls.find(
        ([key]) => key === `refund-op:${ORDER_ID}`,
      );
      expect(ctx.idempotency.__mocks.release).toHaveBeenCalledWith(
        `refund-op:${ORDER_ID}`,
        beginCall?.[2],
      );

      // …item 2 tomorrow: the mutex MUST be re-acquirable (this is a mutex,
      // not a dedupe record — a lingering hold would break legitimate
      // sequential refunds).
      const second = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_B],
      });
      expect(second.ok).toBe(true);
      expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(2);
    });
  });
});

// ── Dispute guard ─────────────────────────────────────────────────────────
// Same contract as refund-full-order: refuse after the replay lookup and
// before the quote (which already reaches Stripe for the processing fee).
describe("refundOrderItems — dispute guard", () => {
  it.each(["OPEN", "UNDER_REVIEW", "LOST"] as const)(
    "refuses a %s dispute with no processor call and no ledger write",
    async (disputeStatus) => {
      const ctx = makeContext({ order: makeOrder({ disputeStatus }) });

      await expect(
        refundOrderItems(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
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
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.idempotency.__mocks.commit).not.toHaveBeenCalled();
      // A refusal is not an attempt: the use-case key is neither claimed nor
      // marked failed, so a retry once the dispute closes is not locked out
      // for the failed-marker TTL.
      expect(ctx.idempotency.__mocks.begin).not.toHaveBeenCalledWith(
        `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}`,
        expect.anything(),
      );
      expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalledWith(
        `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}`,
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

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.ok).toBe(true);
    expect(out.newOrderStatus).toBe("PART_REFUNDED");
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("replays a committed item refund even when the order is now disputed", async () => {
    const cachedResponse = {
      ok: true as const,
      orderId: ORDER_ID,
      refundId: "re_cached_123",
      currency: "usd",
      totalRefundedCents: 3200,
      items: [{ orderItemId: ITEM_A, refundedCents: 3200 }],
      newOrderStatus: "PART_REFUNDED" as const,
    };
    const ctx = makeContext({
      order: makeOrder({ status: "PART_REFUNDED", disputeStatus: "OPEN" }),
    });
    ctx.idempotency.__store.set(
      `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}`,
      { payloadHash: "", response: cachedResponse },
    );

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out).toEqual(cachedResponse);
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("passes the adapter's typed ORDER_DISPUTED_REFUND_BLOCKED through instead of dependency_failed", async () => {
    const ctx = makeContext();
    const stripeRefusal = new AppError("ORDER_DISPUTED_REFUND_BLOCKED", {
      meta: { paymentIntentId: "pi_123" },
    });
    (
      ctx.payments.refundPaymentIntent as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(stripeRefusal);

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toBe(stripeRefusal);
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("still wraps any other refund failure as dependency_failed", async () => {
    const ctx = makeContext();
    (
      ctx.payments.refundPaymentIntent as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe is down"));

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      message: "refund_payment_intent",
    });
  });

  // ── Buyer refund window + ticket state (audit #1) ─────────────────────────
  // NOW is 2025-06-01T12:00Z. These fixtures put the show BEFORE that so a
  // buyer calling "the morning after" is refused before anything is claimed.

  describe("buyer refund window", () => {
    const PAST_START = new Date("2025-05-31T20:00:00.000Z");
    const REFUND_ITEMS_KEY_PREFIX = "order:refund-items:";

    function expectNoRefundClaim(ctx: ReturnType<typeof makeContext>) {
      // The per-order mutex legitimately claims `refund-op:<orderId>`; the
      // REFUND idempotency key must never be begun (a refusal is not an
      // attempt) and no `failed:` marker may be left behind.
      const refundKeyBegins = ctx.idempotency.__mocks.begin.mock.calls.filter(
        (call) => String(call[0]).startsWith(REFUND_ITEMS_KEY_PREFIX),
      );
      expect(refundKeyBegins).toHaveLength(0);
      expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
      expect(ctx.repos.tx).not.toHaveBeenCalled();
    }

    it("refuses a buyer refund after startsAt (REFUND_WINDOW_CLOSED) — no Stripe, no idempotency claim", async () => {
      const ctx = makeContext({ eventStartsAt: PAST_START });

      await expect(
        refundOrderItems(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        }),
      ).rejects.toMatchObject({ code: "REFUND_WINDOW_CLOSED" });

      expectNoRefundClaim(ctx);
      expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    });

    it("refunds normally before the deadline", async () => {
      const ctx = makeContext({
        eventStartsAt: new Date("2025-06-01T20:00:00.000Z"),
      });

      const out = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      });

      expect(out.ok).toBe(true);
      expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    });

    it("an explicit refundCutoffAt wins over startsAt", async () => {
      const ctx = makeContext({
        eventStartsAt: new Date("2025-06-03T20:00:00.000Z"),
        eventRefundCutoffAt: new Date("2025-06-01T00:00:00.000Z"),
      });

      await expect(
        refundOrderItems(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        }),
      ).rejects.toMatchObject({ code: "REFUND_WINDOW_CLOSED" });

      expectNoRefundClaim(ctx);
    });

    it("org/staff (_skipBuyerCheck) still refund after the show, SCANNED ticket included", async () => {
      const scanned = makeFullTickets();
      scanned[0]!.status = "SCANNED";
      scanned[0]!.scannedAt = PAST_START;
      const ctx = makeContext({
        eventStartsAt: PAST_START,
        fullTickets: scanned,
      });

      const out = await refundOrderItems(
        { ...makeDeps(ctx), _skipBuyerCheck: true },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      );

      expect(out.ok).toBe(true);
      expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
        TICKET_1,
        "REFUNDED",
        { scannedAt: null },
      );
    });

    // Owner ruling 2026-10-10: a refund of a scanned-in ticket means the
    // person left. The void clears `scannedAt`, so the audit row is the only
    // record that the ticket had admitted someone.
    const itemsRefundedAuditData = (ctx: ReturnType<typeof makeContext>) => {
      const entry = (ctx.txRepos.audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[0] as { action: string; data: Record<string, unknown> })
        .find((e) => e.action === "items_refunded");
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
      rows: TicketRecord[],
    ) => {
      (ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>).mockImplementation(
        async (id: string, status: TicketRecord["status"]) => {
          const row = rows.find((t) => t.id === id);
          if (row) {
            row.status = status;
            row.scannedAt = null;
          }
        },
      );
    };

    it("records the scanned ticket, with its admit time, as leftOnRefund on the audit row", async () => {
      const admittedAt = new Date("2026-10-09T23:41:07.000Z");
      const rows = makeFullTickets();
      rows[0]!.status = "SCANNED";
      rows[0]!.scannedAt = admittedAt;
      const ctx = makeContext({ eventStartsAt: PAST_START, fullTickets: rows });
      voidInPlace(ctx, rows);

      // ITEM_A's ticket is SCANNED, ITEM_B's is VALID: both are refunded.
      await refundOrderItems(
        { ...makeDeps(ctx), _skipBuyerCheck: true },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_B],
        },
      );

      expect(rows[0]!.status).toBe("REFUNDED");
      expect(rows[1]!.status).toBe("REFUNDED");
      expect(itemsRefundedAuditData(ctx).leftOnRefund).toEqual([
        { ticketId: TICKET_1, admittedAt: "2026-10-09T23:41:07.000Z" },
      ]);
    });

    it("writes no leftOnRefund key when no refunded ticket had been scanned", async () => {
      const rows = makeFullTickets();
      const ctx = makeContext({ eventStartsAt: PAST_START, fullTickets: rows });
      voidInPlace(ctx, rows);

      await refundOrderItems(
        { ...makeDeps(ctx), _skipBuyerCheck: true },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_B],
        },
      );

      expect(itemsRefundedAuditData(ctx)).not.toHaveProperty("leftOnRefund");
    });

    it("blocks the buyer item path on a nonRefundable order (ORDER_NON_REFUNDABLE)", async () => {
      const ctx = makeContext({ order: makeOrder({ nonRefundable: true }) });

      await expect(
        refundOrderItems(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        }),
      ).rejects.toMatchObject({ code: "ORDER_NON_REFUNDABLE" });

      expectNoRefundClaim(ctx);
    });

    it("a buyer cannot refund a SCANNED ticket (items_not_refundable / already_scanned)", async () => {
      const scanned = makeFullTickets();
      scanned[0]!.status = "SCANNED";
      const ctx = makeContext({ fullTickets: scanned });

      await expect(
        refundOrderItems(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "items_not_refundable",
        ineligibleItems: [{ orderItemId: ITEM_A, reason: "already_scanned" }],
      });

      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
      expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    });
  });

  // ── Listed resale ticket (audit #2) ───────────────────────────────────────

  describe("listed resale ticket", () => {
    it("refuses to refund an item whose ticket is LISTED (listing_active) — ticket and order untouched", async () => {
      const order = makeOrder();
      order.items[0]!.resaleListingId = "listing-1";
      const listed = makeFullTickets();
      listed[0]!.status = "LISTED";
      const ctx = makeContext({ order, fullTickets: listed });

      await expect(
        refundOrderItems(makeDeps(ctx), {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "items_not_refundable",
        ineligibleItems: [{ orderItemId: ITEM_A, reason: "listing_active" }],
      });

      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
      expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
      expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
      expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    });

    it("applies to org/staff too — a listed ticket is never refundable through the item path", async () => {
      const listed = makeFullTickets();
      listed[0]!.status = "LISTED";
      const ctx = makeContext({ fullTickets: listed });

      await expect(
        refundOrderItems(
          { ...makeDeps(ctx), _skipBuyerCheck: true },
          { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
        ),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "items_not_refundable",
      });

      expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    });
  });

  // ── Resale orders take the full-refund path (audit #7) ────────────────────

  it("refuses the item path on a RESALE order (RESALE_ORDER_USE_FULL_REFUND) so the unwind cannot be skipped", async () => {
    const resaleItems = makeItems().slice(0, 1);
    resaleItems[0]!.resaleListingId = "listing-1";
    const ctx = makeContext({
      order: makeOrder({ source: "RESALE", items: resaleItems }),
    });

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toMatchObject({ code: "RESALE_ORDER_USE_FULL_REFUND" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    // A wrong-entry-point refusal is not an attempt: the refund key is never
    // claimed and no `failed:` marker is left to block the full-refund path.
    const refundKeyBegins = ctx.idempotency.__mocks.begin.mock.calls.filter(
      (call) => String(call[0]).startsWith("order:refund-items:"),
    );
    expect(refundKeyBegins).toHaveLength(0);
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
  });

  // ── Reserved seats ────────────────────────────────────────────────────────
  // Partial refunds are exactly where "free the seat" can go wrong: only the
  // QUOTED items' tickets die, and only their seats may come back.

  it("returns the seat of the item it refunds, and only that one", async () => {
    const SEAT_A = "5ea70001-0000-4000-8000-00000000000a";
    const SEAT_B = "5ea70002-0000-4000-8000-00000000000b";
    const fullTickets = makeFullTickets();
    fullTickets[0]!.seatId = SEAT_A;
    fullTickets[1]!.seatId = SEAT_B;
    const ctx = makeContext({ fullTickets });

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(ctx.txRepos.tickets.clearSeatAssignments).toHaveBeenCalledWith([
      TICKET_1,
    ]);
    // `updateStatuses`, not the HELD-gated `releaseSeats`: the seat is SOLD.
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_A],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    expect(ctx.txRepos.seats.releaseSeats).not.toHaveBeenCalled();
    // The ticket the buyer KEPT still owns seat B.
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledTimes(1);
    expect(
      ctx.txRepos.seats.updateStatuses.mock.calls[0]![0].seatIds,
    ).not.toContain(SEAT_B);
  });

  it("touches no seat for GA items", async () => {
    const ctx = makeContext();

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(ctx.txRepos.seats.updateStatuses).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.clearSeatAssignments).not.toHaveBeenCalled();
  });
});

// ── Buyer refunds stop at payout ──────────────────────────────────────────
// docs/decisions/buyer-refunds-stop-at-payout.md: a BUYER cannot self-serve
// a refund of a paid-out item; the quote marks it `already_paid_out` and the
// item path refuses before Stripe. Org / staff (`_skipBuyerCheck`) keep the
// transfer-reversal path — see the staff-path cases above.
describe("refundOrderItems — buyer refunds stop at payout", () => {
  it("a buyer cannot refund a paid-out item (items_not_refundable / already_paid_out) — no Stripe, no reversal, ticket untouched", async () => {
    const order = makeOrder();
    order.items[0]!.paidOutAt = NOW;
    const ctx = makeContext({ order });

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "items_not_refundable",
      ineligibleItems: [{ orderItemId: ITEM_A, reason: "already_paid_out" }],
    });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
  });

  it("a buyer requesting a paid-out item ALONGSIDE a normal one is refused for the whole request (item path is all-or-nothing)", async () => {
    const order = makeOrder();
    order.items[0]!.paidOutAt = NOW;
    const ctx = makeContext({ order });

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "items_not_refundable",
      ineligibleItems: [{ orderItemId: ITEM_A, reason: "already_paid_out" }],
    });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
  });
});

// ── Stripe refund metadata (money audit 2026-09-08 #10) ─────────────────────
// If the local tx fails AFTER Stripe accepted the refund, the DB never learns
// which items were paid back. The refund's metadata names them so the
// `charge.refunded` reconciler can flip exactly those items and a later
// request under a different idempotency key quotes them `already_refunded`.
describe("refundOrderItems — Stripe refund metadata names the items", () => {
  it("stamps useCase, orderId and the exact sorted item ids on the Stripe refund", async () => {
    const ctx = makeContext({ feeCents: 300 });

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_C, ITEM_A],
    });

    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    const call = (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0] as { metadata?: Record<string, string> };
    expect(call.metadata).toEqual({
      useCase: "refundOrderItems",
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_C].join(","),
      orderItemCount: "2",
    });
  });

  it("chunks the id list across orderItemIds/orderItemIds2 under Stripe's 500-char value cap and stamps a SHA-256 of the sorted list (20-item order)", async () => {
    const { createHash } = await import("node:crypto");
    // 20 v4-shaped ids; 13 × 36 + 12 commas = 480 fits one value, 14 does not.
    const bigItemIds = Array.from(
      { length: 20 },
      (_, i) =>
        `${(i + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const items: OrderItemRecord[] = bigItemIds.map((id) => ({
      id,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: "tt-ga",
      qty: 1,
      unitPriceCents: 3000,
      amountCents: 3000,
      meta: { buyerTotalCents: 3300 },
      paidOutAt: null,
      refundedAt: null,
      transferredAt: null,
      status: "active",
    }));
    const fullTickets: TicketRecord[] = bigItemIds.map((id, i) => ({
      id: `${(i + 1).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
      eventId: "event-1",
      ownerHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemId: id,
      seatId: null,
      ticketTypeId: "tt-ga",
      code: `TK-${i}`,
      issuedAt: new Date("2025-01-01"),
      scannedAt: null,
      status: "VALID",
    }));
    const order = makeOrder({ amountGrossCents: 60000, items });
    const ctx = makeContext({
      order,
      itemsForTx: items,
      tickets: fullTickets,
      fullTickets,
      feeCents: 2000,
    });

    const shuffled = [...bigItemIds].reverse();
    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: shuffled,
    });

    const sorted = [...bigItemIds].sort();
    const call = (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0] as { metadata?: Record<string, string> };
    expect(call.metadata).toEqual({
      useCase: "refundOrderItems",
      orderId: ORDER_ID,
      orderItemCount: "20",
      orderItemChunks: "2",
      orderItemIds: sorted.slice(0, 13).join(","),
      orderItemIds2: sorted.slice(13).join(","),
      orderItemIdsHash: createHash("sha256")
        .update(sorted.join(","))
        .digest("hex"),
    });
    for (const value of Object.values(call.metadata!)) {
      expect(value.length).toBeLessThanOrEqual(500);
    }
  });

  it("after the reconciler flipped A from the refund metadata, a buyer request for [A, B] under a new key is refused (already_refunded) and only [B] reaches Stripe for B's share", async () => {
    // The reconciler's write: A `refunded` with no tax attribution (the
    // quote is gone), B still active. Different idempotency key than the
    // original [A] request → no replay; the quote must catch A itself.
    const order = makeOrder();
    order.items[0]!.status = "refunded";
    order.items[0]!.refundedAt = NOW;
    const ctx = makeContext({ order, feeCents: 300 });

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "items_not_refundable",
      ineligibleItems: [{ orderItemId: ITEM_A, reason: "already_refunded" }],
    });
    // A is never refunded twice: the item path is all-or-nothing, so Stripe
    // is not asked for anything on the mixed request.
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_B],
    });
    expect(out.items).toEqual([
      { orderItemId: ITEM_B, refundedCents: out.totalRefundedCents },
    ]);
    // B's share only: 3300 buyer-paid − 100 fee share (300 / 3 items).
    expect(out.totalRefundedCents).toBe(3200);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 3200,
        metadata: expect.objectContaining({ orderItemIds: ITEM_B }),
      }),
    );
  });
});

// ── refundedPlatformFeeCents stamp ──────────────────────────────────────────
// docs/decisions/absorb-refund-returns-platform-fee.md: the platform fee is
// refunded in BOTH modes, and the stamp records the item's share of it beside
// `refundedTaxCents`. Same cents either way — the mode decides who funded it.
describe("refundedPlatformFeeCents stamp", () => {
  function itemWith(
    id: string,
    face: number,
    meta: Record<string, unknown>,
  ): OrderItemRecord {
    return { ...makeItems()[0]!, id, unitPriceCents: face, amountCents: face, meta };
  }

  it("PASS_THROUGH: stamps the item's MEASURED platformFeePerTicketCents (33 on a $10 ticket under the cap), not a pro-rata slice of the order fee", async () => {
    const items = [
      itemWith(ITEM_A, 1000, {
        buyerTotalCents: 1033,
        effectiveFeeMode: "PASS_THROUGH",
        platformFeePerTicketCents: 33,
      }),
      itemWith(ITEM_B, 1000, {
        buyerTotalCents: 1033,
        effectiveFeeMode: "PASS_THROUGH",
        platformFeePerTicketCents: 33,
      }),
      itemWith(ITEM_C, 2000, {
        buyerTotalCents: 2050,
        effectiveFeeMode: "PASS_THROUGH",
        platformFeePerTicketCents: 50,
      }),
    ];
    const order = makeOrder({
      amountGrossCents: 4000,
      feesPlatformCents: 116,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items,
    });
    const ctx = makeContext({ order, itemsForTx: items, feeCents: 150 });

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    // Pro-rata by buyer-paid would have said 29 (1033/4116 × 116); the row
    // says 33, and 33 is what the buyer's refund contains.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      33,
    );
  });

  it("ABSORB: stamps the absorbed 33 the platform gives back — the buyer never paid it and the organiser is not docked it", async () => {
    const absorb = {
      buyerTotalCents: 1000,
      effectiveFeeMode: "ABSORB",
      platformFeePerTicketCents: 33,
    };
    const items = [
      itemWith(ITEM_A, 1000, absorb),
      itemWith(ITEM_B, 1000, absorb),
      itemWith(ITEM_C, 1000, absorb),
    ];
    const order = makeOrder({
      amountGrossCents: 3000,
      feesPlatformCents: 99,
      feePolicySnapshot: { feeMode: "ABSORB" },
      items,
    });
    const ctx = makeContext({ order, itemsForTx: items, feeCents: 117 });

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_B],
    });

    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_B,
      "refunded",
      NOW,
      0,
      33,
    );
  });

  it("legacy items without per-ticket fee meta: allocates feesPlatformCents by buyer-paid weight, and the shares sum to the order fee", async () => {
    // Default fixture: 900 over three equal items with only `buyerTotalCents`.
    const ctx = makeContext({ feeCents: 300 });

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_B],
    });

    const stamped = (
      ctx.txRepos.orderItems.updateStatus as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => [call[0], call[4]]);
    expect(stamped).toEqual([
      [ITEM_A, 300],
      [ITEM_B, 300],
    ]);
    // Three-way split of 900 = 300 each; the un-refunded ITEM_C's 300 is the
    // remainder, so a later refund of it completes the order fee exactly.
  });

  it("zero platform fee: stamps a measured 0, never NULL", async () => {
    const items = makeItems().map((item) => ({
      ...item,
      meta: { buyerTotalCents: 3000 },
    }));
    const order = makeOrder({
      amountGrossCents: 9000,
      feesPlatformCents: 0,
      items,
    });
    const ctx = makeContext({ order, itemsForTx: items, feeCents: 300 });

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0,
      0,
    );
  });
});

// ── Retry after a crash between the Stripe refund and the commit ───────────
// Money audit 2026-09-08 #10, second layer. The first attempt's Stripe
// refund SUCCEEDED and the transaction after it died: the use-case claim
// is released, the items still read `active`. A retry under a DIFFERENT
// idempotency key (the org path's namespace, a new client request) must
// find that refund on the PaymentIntent by its stamped metadata and reuse
// it — never issue another. The `charge.refunded` reconciler closes the
// same hole once the webhook lands; this pre-flight covers the window
// before it does.
describe("refundOrderItems — retry after a crash between Stripe and the commit", () => {
  const ORG_KEY = `org:org-1:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}`;

  async function crashFirstAttempt(ctx: ReturnType<typeof makeContext>) {
    (ctx.repos.tx as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db_connection_lost"),
    );
    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toMatchObject({ code: "dependency_failed" });
    // Stripe accepted the refund; our side recorded nothing.
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    // Released, not failed (lib/idempotency-claim.ts): no 15-minute lockout.
    expect(ctx.idempotency.__mocks.release).toHaveBeenCalledWith(
      `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}`,
      expect.any(String),
    );
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
  }

  it("reuses the first refund under a DIFFERENT idempotency key: no second Stripe refund, the items flip against the first refund id, one ledger debit", async () => {
    const ctx = makeContext({ feeCents: 300 });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 8_100,
      items: { [ITEM_A]: 2_700, [ITEM_B]: 2_700, [ITEM_C]: 2_700 },
    });
    await crashFirstAttempt(ctx);
    const firstCall = (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0] as { amountCents: number };

    // Retry through the org namespace (a distinct use-case key, so the
    // Stripe idempotency key is distinct too — Stripe would NOT dedupe).
    const out = await refundOrderItems(
      { ...staffDeps(ctx), _idempotencyKey: ORG_KEY },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    expect(out.ok).toBe(true);
    expect(out.refundId).toBe("re_test_123");
    expect(out.totalRefundedCents).toBe(firstCall.amountCents);
    // THE money assertion: Stripe was asked exactly once.
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
    const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      idempotencyKey: `refund-debit:${ORDER_ID}:payee-1:re_test_123`,
    });
    expect(ctx.idempotency.__mocks.commit).toHaveBeenCalledWith(
      ORG_KEY,
      expect.objectContaining({
        response: expect.objectContaining({ refundId: "re_test_123" }),
      }),
    );
  });

  it("refuses a retry whose item set only PARTLY overlaps the prior refund ([A] paid, [A, B] requested): typed conflict, no Stripe refund, no tx", async () => {
    const ctx = makeContext({ feeCents: 300 });
    await crashFirstAttempt(ctx);

    await expect(
      refundOrderItems(
        {
          ...staffDeps(ctx),
          _idempotencyKey: `org:org-1:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}:${ITEM_B}`,
        },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_B],
        },
      ),
    ).rejects.toMatchObject({
      code: "REFUND_ALREADY_ISSUED_FOR_ITEMS",
      meta: expect.objectContaining({
        orderId: ORDER_ID,
        refundId: "re_test_123",
        overlappingOrderItemIds: [ITEM_A],
      }),
    });

    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    // Only the crashed first attempt reached the tx.
    expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
  });

  it("refuses when a refund on this PaymentIntent names a DIFFERENT order (invariant breach): typed error, no Stripe refund", async () => {
    const ctx = makeContext({ feeCents: 300 });
    ctx.refundRecords.set("pi_123", [
      {
        refundId: "re_foreign_1",
        amountCents: 100,
        status: "succeeded",
        metadata: {
          useCase: "refundOrderItems",
          orderId: "44444444-4444-4444-8444-444444444444",
          orderItemCount: "1",
          orderItemIds: ITEM_A,
        },
      },
    ]);

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
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

  it("a FAILED prior refund naming the same items moved no money: a new refund is issued", async () => {
    const ctx = makeContext({ feeCents: 300 });
    ctx.refundRecords.set("pi_123", [
      {
        refundId: "re_failed_1",
        amountCents: 3_190,
        status: "failed",
        metadata: {
          useCase: "refundOrderItems",
          orderId: ORDER_ID,
          orderItemCount: "1",
          orderItemIds: ITEM_A,
        },
      },
    ]);

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.ok).toBe(true);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("a prior refund with NO metadata (dashboard refund) is not ours to reuse: a new refund is issued", async () => {
    const ctx = makeContext({ feeCents: 300 });
    ctx.refundRecords.set("pi_123", [
      { refundId: "re_dash_1", amountCents: 500, status: "succeeded", metadata: {} },
    ]);

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.ok).toBe(true);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("a failed refund LISTING is a dependency failure — never swallowed into a fresh refund", async () => {
    const ctx = makeContext({ feeCents: 300 });
    (
      ctx.payments.listRefundsForPaymentIntent as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe_down"));

    await expect(
      refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      message: "list_refunds_for_payment_intent",
    });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("the crashed attempt's refund carries the identity the retry keys on", async () => {
    const ctx = makeContext({ feeCents: 300 });
    await crashFirstAttempt(ctx);

    expect(ctx.refundRecords.get("pi_123")).toEqual([
      {
        refundId: "re_test_123",
        amountCents: expect.any(Number),
        status: "succeeded",
        metadata: {
          useCase: "refundOrderItems",
          orderId: ORDER_ID,
          orderItemCount: "1",
          orderItemIds: ITEM_A,
        },
      },
    ]);
  });
});

// ── Idempotency claim on failure (lib/idempotency-claim.ts) ───────────────
describe("refundOrderItems — idempotency claim on failure", () => {
  const KEY = `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}`;
  const INPUT = { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] };

  it("a transient Stripe failure releases the claim: the same-key retry proceeds immediately", async () => {
    const ctx = makeContext({ feeCents: 300 });
    (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe_timeout"));

    await expect(refundOrderItems(makeDeps(ctx), INPUT)).rejects.toMatchObject({
      code: "dependency_failed",
    });
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();

    const out = await refundOrderItems(makeDeps(ctx), INPUT);
    expect(out.ok).toBe(true);
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

    await expect(refundOrderItems(makeDeps(ctx), INPUT)).rejects.toThrow(
      "idempotency_store_down",
    );
    expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
    expect(
      ctx.idempotency.__mocks.release.mock.calls.filter(([k]) => k === KEY),
    ).toHaveLength(0);
    expect(ctx.idempotency.__mocks.fail).not.toHaveBeenCalled();

    await expect(refundOrderItems(makeDeps(ctx), INPUT)).rejects.toMatchObject({
      code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
    });
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
  });
});

// Owner ruling 2026-10-11: "yeah it should refund 0 because that's what it
// cost. Otherwise we will get taken advantage of".
describe("refundOrderItems — a ticket that cost $0", () => {
  const DISCOUNT_ITEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const CHARGED_CENTS = 5_689;
  const STRIPE_FEE_CENTS = 195;

  /**
   * The shape of dev order f425308e: a $125 VIP a 100% VIP code freed (ITEM_A)
   * beside a paid $50 GA (ITEM_B). Charged 5245 + 444 tax = 5689.
   */
  function freedItems(): OrderItemRecord[] {
    const template = makeItems()[0]!;
    return [
      {
        ...template,
        id: DISCOUNT_ITEM,
        kind: "discount",
        ticketTypeId: null,
        unitPriceCents: -12_500,
        amountCents: -12_500,
        meta: {},
      } as unknown as OrderItemRecord,
      {
        ...template,
        id: ITEM_A,
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
        ...template,
        id: ITEM_B,
        ticketTypeId: "tt-ga",
        unitPriceCents: 5_000,
        amountCents: 5_000,
        meta: {
          buyerTotalCents: 5_245,
          platformFeePerTicketCents: 50,
          processorFeeShareCents: 195,
        },
      },
    ];
  }

  /**
   * One context whose order the test mutates between refunds, so a sequence
   * runs against one ledger and one Stripe fake. The harness does not write
   * item or order status back, so `applyRefund` does what the tx would have.
   */
  function freedContext(items: OrderItemRecord[] = freedItems()) {
    const order = makeOrder({
      amountGrossCents: 5_000,
      feesPlatformCents: 50,
      taxAmountCents: 444,
      items,
    });
    const ctx = makeContext({
      order,
      itemsForTx: items,
      feeCents: STRIPE_FEE_CENTS,
      fullTickets: makeFullTickets().slice(0, 2),
    });
    const applyRefund = (itemIds: string[], status: OrderRecord["status"]) => {
      for (const item of items) {
        if (itemIds.includes(item.id)) {
          item.status = "refunded";
          item.refundedAt = NOW;
        }
      }
      order.status = status;
    };
    return { ctx, order, applyRefund };
  }

  /** The organiser's credit as `createCreditsFromOrder` now attributes it. */
  const seedCredit = (ctx: ReturnType<typeof makeContext>) =>
    ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 4_950,
      items: { [ITEM_B]: 4_950 },
    });

  const quoteOf = async (
    ctx: ReturnType<typeof makeContext>,
    orderItemIds: string[],
  ) =>
    quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds },
    );

  const stripeRefundedCents = (ctx: ReturnType<typeof makeContext>) =>
    (ctx.refundRecords.get("pi_123") ?? []).reduce(
      (sum, record) => sum + record.amountCents,
      0,
    );

  it("(a) refunds the freed ticket alone for $0, with no Stripe call, and still marks it refunded", async () => {
    const { ctx } = freedContext();
    await seedCredit(ctx);
    const quote = await quoteOf(ctx, [ITEM_A]);

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    // Pre-fix: 3871 was sent to Stripe for this ticket.
    expect(quote.totalRefundableCents).toBe(0);
    expect(out.totalRefundedCents).toBe(0);
    expect(out.items).toEqual([{ orderItemId: ITEM_A, refundedCents: 0 }]);
    expect(out.newOrderStatus).toBe("PART_REFUNDED");
    expect(out.refundId).toMatch(/^nocharge_[0-9a-f]{24}$/);

    // No processor call of any kind for the money.
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.listRefundsForPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();

    // The state changes all happen.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
      0, // refundedTaxCents: a measured zero
      0, // refundedPlatformFeeCents
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );
    // 0 is a PARTIAL amount: the order must not close as REFUNDED.
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID, 0);
    expect(ctx.txRepos.feeWaivers.release).not.toHaveBeenCalled();
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "items_refunded",
        data: expect.objectContaining({
          refundId: out.refundId,
          moneyMoved: false,
          totalRefundedCents: 0,
          newOrderStatus: "PART_REFUNDED",
        }),
      }),
    );

    // The organiser is debited nothing for a ticket that earned them nothing.
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
  });

  it("(a) releases the freed ticket's seat and records that a scanned holder left", async () => {
    const { ctx } = freedContext();
    const scannedAt = new Date("2025-05-31T20:00:00.000Z");
    const ticket = {
      ...makeFullTickets()[0]!,
      status: "SCANNED" as const,
      scannedAt,
      seatId: "seat-1",
    };
    ctx.txRepos.tickets.getByOrderItemId.mockImplementation(
      async (orderItemId: string) =>
        orderItemId === ITEM_A ? ticket : null,
    );
    (ctx.repos.tickets.getByOrderItemId as ReturnType<typeof vi.fn>)
      .mockImplementation(async (orderItemId: string) =>
        orderItemId === ITEM_A ? ticket : null,
      );

    // Staff: a buyer cannot refund a scanned ticket.
    const out = await refundOrderItems(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.totalRefundedCents).toBe(0);
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledWith(
      expect.objectContaining({ seatIds: ["seat-1"] }),
    );
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          releasedSeatIds: ["seat-1"],
          leftOnRefund: [
            { ticketId: TICKET_1, admittedAt: scannedAt.toISOString() },
          ],
        }),
      }),
    );
  });

  it("(b) refunds the paid ticket alone for the whole charge less the processing fee", async () => {
    const { ctx } = freedContext();
    await seedCredit(ctx);
    const quote = await quoteOf(ctx, [ITEM_B]);

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_B],
    });

    // Pre-fix: 1623.
    expect(out.totalRefundedCents).toBe(5_494);
    expect(out.totalRefundedCents).toBe(quote.totalRefundableCents);
    expect(out.newOrderStatus).toBe("PART_REFUNDED");
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5_494 }),
    );
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_B,
      "refunded",
      NOW,
      444,
      50,
    );
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ moneyMoved: true }),
      }),
    );
    expect(stripeRefundedCents(ctx)).toBeLessThanOrEqual(CHARGED_CENTS);
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toMatchObject([
      { payeeId: "payee-1", amountCents: 4_950 },
    ]);
  });

  it("(c) refunds both in one request for exactly charge − processing fee", async () => {
    const { ctx } = freedContext();
    const quote = await quoteOf(ctx, [ITEM_A, ITEM_B]);

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_B],
    });

    expect(out.items).toEqual([
      { orderItemId: ITEM_A, refundedCents: 0 },
      { orderItemId: ITEM_B, refundedCents: 5_494 },
    ]);
    expect(out.totalRefundedCents).toBe(CHARGED_CENTS - STRIPE_FEE_CENTS);
    expect(out.totalRefundedCents).toBe(quote.totalRefundableCents);
    expect(out.newOrderStatus).toBe("REFUNDED");
    // One Stripe refund, for the paid ticket's money, naming both items.
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5_494 }),
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledTimes(2);
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      undefined,
    );
  });

  it("(d) freed then paid: $0, then the whole refundable amount; never more than was charged", async () => {
    const { ctx, applyRefund } = freedContext();
    await seedCredit(ctx);

    const freedQuote = await quoteOf(ctx, [ITEM_A]);
    const first = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });
    expect(first.totalRefundedCents).toBe(freedQuote.totalRefundableCents);
    expect(first.totalRefundedCents).toBe(0);
    expect(stripeRefundedCents(ctx)).toBe(0);
    applyRefund([ITEM_A], "PART_REFUNDED");

    const paidQuote = await quoteOf(ctx, [ITEM_B]);
    const second = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_B],
    });
    expect(second.totalRefundedCents).toBe(paidQuote.totalRefundableCents);
    expect(second.totalRefundedCents).toBe(5_494);
    expect(second.newOrderStatus).toBe("REFUNDED");

    expect(first.totalRefundedCents + second.totalRefundedCents).toBe(
      CHARGED_CENTS - STRIPE_FEE_CENTS,
    );
    expect(stripeRefundedCents(ctx)).toBe(5_494);
    expect(stripeRefundedCents(ctx)).toBeLessThanOrEqual(CHARGED_CENTS);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    // The whole credit comes back once, with the paid ticket.
    expect(
      ctx.payeeLedger
        .entriesOfType("REFUND_DEBIT")
        .reduce((sum, entry) => sum + entry.amountCents, 0),
    ).toBe(4_950);
    expect(first.refundId).not.toBe(second.refundId);
  });

  it("(e) paid then freed: the whole refundable amount, then $0 that closes the order with no Stripe call", async () => {
    const { ctx, applyRefund } = freedContext();
    await seedCredit(ctx);

    const paidQuote = await quoteOf(ctx, [ITEM_B]);
    const first = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_B],
    });
    expect(first.totalRefundedCents).toBe(paidQuote.totalRefundableCents);
    expect(first.totalRefundedCents).toBe(5_494);
    expect(first.newOrderStatus).toBe("PART_REFUNDED");
    applyRefund([ITEM_B], "PART_REFUNDED");

    const freedQuote = await quoteOf(ctx, [ITEM_A]);
    const second = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });
    expect(second.totalRefundedCents).toBe(freedQuote.totalRefundableCents);
    expect(second.totalRefundedCents).toBe(0);
    // Every ticket is now refunded: the order closes, the allowance returns.
    expect(second.newOrderStatus).toBe("REFUNDED");
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenLastCalledWith(
      ORDER_ID,
      undefined,
    );
    expect(ctx.txRepos.feeWaivers.release).toHaveBeenCalledTimes(1);

    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripeRefundedCents(ctx)).toBe(5_494);
    expect(stripeRefundedCents(ctx)).toBeLessThanOrEqual(CHARGED_CENTS);
    // The $0 refund writes no second debit: the credit was already returned.
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toMatchObject([
      { amountCents: 4_950 },
    ]);
  });

  it("(f) a ticket PRICED at $0 in a paid order refunds for $0 with no Stripe call", async () => {
    // No discount: ITEM_A is a free tier beside the paid GA. Before this
    // change the refund was refused outright with REFUND_AMOUNT_ZERO.
    const items = freedItems()
      .filter((item) => item.id !== DISCOUNT_ITEM)
      .map((item) =>
        item.id === ITEM_A
          ? {
              ...item,
              unitPriceCents: 0,
              amountCents: 0,
              meta: { buyerTotalCents: 0, platformFeePerTicketCents: 0 },
            }
          : item,
      );
    const { ctx } = freedContext(items);

    const quote = await quoteOf(ctx, [ITEM_A]);
    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(quote.totalRefundableCents).toBe(0);
    expect(out.totalRefundedCents).toBe(0);
    expect(out.newOrderStatus).toBe("PART_REFUNDED");
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );

    // The paid ticket beside it still carries the whole charge.
    const paid = await quoteOf(ctx, [ITEM_B]);
    expect(paid.totalRefundableCents).toBe(CHARGED_CENTS - STRIPE_FEE_CENTS);
  });

  it("a retry of the same $0 refund replays the same refund id and writes nothing twice", async () => {
    const { ctx } = freedContext();
    const input = {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    };

    const first = await refundOrderItems(makeDeps(ctx), input);
    const second = await refundOrderItems(makeDeps(ctx), input);

    expect(second.refundId).toBe(first.refundId);
    expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  /** A ledger-era payout that covered `plannedOrderItemIds` for payee-1. */
  const stubPayout = (
    ctx: ReturnType<typeof makeContext>,
    plannedOrderItemIds: string[],
    amountCents: number,
  ) => {
    (ctx.repos as any).orderItemSettlementLines = {
      listByOrderItemIds: vi.fn(async () => []),
    };
    (
      ctx.repos.payoutItems.listTransferredByPlannedOrderItemIds as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue([
      {
        payoutItemId: "pitem-zero",
        stripeTransferId: "tr_zero_refund",
        payeeId: "payee-1",
        currency: "usd",
        plannedOrderItemIds,
        amountCents,
        netAmountCents: amountCents,
      },
    ]);
  };

  // Review finding, 2026-10-11: the reversal used to be skipped whenever the
  // BUYER amount was $0. Whether there is money to pull back depends on what
  // the payee was paid for the item.
  it("a freed ticket makes no processor call at all: no reversal lookup, no reversal, no refund", async () => {
    // Under the attribution `createCreditsFromOrder` writes, the freed
    // ticket has no share of the credit, is in no payout plan and is never
    // stamped `paidOutAt`, so it is never in the reversal list. Its paid
    // sibling was paid out; that changes nothing for the freed ticket.
    const items = freedItems();
    items[2]!.paidOutAt = new Date("2025-05-01T00:00:00.000Z");
    const { ctx } = freedContext(items);
    await seedCredit(ctx);
    stubPayout(ctx, [ITEM_B], 4_950);

    const out = await refundOrderItems(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.totalRefundedCents).toBe(0);
    expect(
      ctx.repos.payoutItems.listTransferredByPlannedOrderItemIds,
    ).not.toHaveBeenCalled();
    expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.listRefundsForPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payeeLedger.entries.filter((e) => e.type !== "SETTLEMENT_CREDIT"))
      .toEqual([]);
  });

  it("a paid-out cheap ticket whose refund clamps to $0, refunded alone: its transfer is reversed, with no Stripe refund", async () => {
    // Two 20¢ tickets; the processor kept 41¢ of the 40¢ charged, so each
    // ticket's refund clamps to $0. The payee was still paid 18¢ for each.
    const template = makeItems()[0]!;
    const cheap = (id: string): OrderItemRecord => ({
      ...template,
      id,
      unitPriceCents: 20,
      amountCents: 20,
      meta: { buyerTotalCents: 20 },
      paidOutAt: new Date("2025-05-01T00:00:00.000Z"),
    });
    const items = [cheap(ITEM_A), cheap(ITEM_B)];
    const order = makeOrder({
      amountGrossCents: 40,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      items,
    });
    const ctx = makeContext({
      order,
      itemsForTx: items,
      feeCents: 41,
      fullTickets: makeFullTickets().slice(0, 2),
    });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 36,
      items: { [ITEM_A]: 18, [ITEM_B]: 18 },
    });
    stubPayout(ctx, [ITEM_A, ITEM_B], 36);

    const out = await refundOrderItems(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.totalRefundedCents).toBe(0);
    expect(out.refundId).toMatch(/^nocharge_[0-9a-f]{24}$/);
    // No Stripe refund, and no prior-refund lookup for one.
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.listRefundsForPaymentIntent).not.toHaveBeenCalled();
    // The payee's 18¢ for this ticket comes back, exactly as it does when
    // the ticket is refunded beside a sibling.
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_zero_refund",
        amountCents: 18,
      }),
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
        data: expect.objectContaining({
          moneyMoved: false,
          totalRefundedCents: 0,
          transferReversals: [
            expect.objectContaining({ orderItemId: ITEM_A, reversedCents: 18 }),
          ],
        }),
      }),
    );
  });

  it("a failed reversal on a $0 refund aborts it, as on a paid refund: nothing is marked and the claim is released", async () => {
    const template = makeItems()[0]!;
    const items = [
      {
        ...template,
        unitPriceCents: 20,
        amountCents: 20,
        meta: { buyerTotalCents: 20 },
        paidOutAt: new Date("2025-05-01T00:00:00.000Z"),
      },
    ];
    const order = makeOrder({
      amountGrossCents: 20,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      items,
    });
    const ctx = makeContext({
      order,
      itemsForTx: items,
      feeCents: 31,
      fullTickets: makeFullTickets().slice(0, 1),
    });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 18,
      items: { [ITEM_A]: 18 },
    });
    stubPayout(ctx, [ITEM_A], 18);
    (ctx.payments.reverseTransfer as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("stripe_down"));
    const input = {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    };

    await expect(refundOrderItems(staffDeps(ctx), input)).rejects.toBeTruthy();

    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);

    // The same request goes through once the processor answers.
    const retry = await refundOrderItems(staffDeps(ctx), input);
    expect(retry.totalRefundedCents).toBe(0);
    expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
  });

  // ── Credits minted under the OLD attribution ────────────────────────────
  // Between 2026-10-10 (the first `discountedToZero` mark) and this change,
  // `createCreditsFromOrder` attributed a payee's credit by face price, so a
  // freed $125 VIP beside a paid $50 GA took 3536 of the 4950 credit
  // (12500 / 17500) and the GA 1414. Those credits are frozen ledger rows and
  // are NOT rewritten.
  //
  // Exposure: commit 3f783361e (which added `meta.discountedToZero`) is on
  // origin, so the dev deploy and dev databases can hold such credits. The
  // owner said on 2026-10-10 that production had no orders yet, so none
  // existed there as of that date; an order taken in production since then
  // could carry one.
  //
  // Left as it is, not fixed at refund time. Debiting a freed ticket by its
  // refund weight (0) instead of its stored share would have to change both
  // the debit writer (five callers) and the transfer reversal's attribution
  // read. A partial change makes it worse: a $0 debit beside a 3536 reversal
  // clamps the reversal credit to 0, and the organiser loses money that came
  // back through Stripe. It would also not reach "never": the refund that
  // closes the order debits whatever is left of the credit.
  //
  // The two tests below pin what such an order does, so the behaviour is a
  // recorded decision and not a surprise.
  const seedOldAttributionCredit = (ctx: ReturnType<typeof makeContext>) =>
    ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 4_950,
      items: { [ITEM_A]: 3_536, [ITEM_B]: 1_414 },
    });

  it("old attribution, not paid out: the freed ticket's $0 refund debits the organiser its old 3536 share", async () => {
    const { ctx, applyRefund } = freedContext();
    await seedOldAttributionCredit(ctx);

    const freed = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    // The buyer gets $0 and Stripe is not called, but the organiser is
    // debited the share the old credit gave this ticket. If the buyer later
    // refunds the paid ticket too, the total comes out right (second half).
    // If the buyer KEEPS the paid ticket, the organiser stays debited 3536
    // for a ticket that earned them nothing, while still holding only the
    // 1414 the GA's share left them.
    expect(freed.totalRefundedCents).toBe(0);
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toMatchObject([
      { payeeId: "payee-1", amountCents: 3_536 },
    ]);
    applyRefund([ITEM_A], "PART_REFUNDED");

    // Refunding the paid ticket too returns the buyer's whole refundable
    // amount and debits the rest of the credit: 4950 in total, the same as
    // under the new attribution.
    const paid = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_B],
    });
    expect(paid.totalRefundedCents).toBe(CHARGED_CENTS - STRIPE_FEE_CENTS);
    expect(
      ctx.payeeLedger
        .entriesOfType("REFUND_DEBIT")
        .reduce((sum, entry) => sum + entry.amountCents, 0),
    ).toBe(4_950);
  });

  it("old attribution, paid out: the freed ticket's $0 refund reverses its 3536 from the transfer and nets the debit to zero", async () => {
    const items = freedItems();
    items[1]!.paidOutAt = new Date("2025-05-01T00:00:00.000Z");
    items[2]!.paidOutAt = new Date("2025-05-01T00:00:00.000Z");
    const { ctx } = freedContext(items);
    await seedOldAttributionCredit(ctx);
    stubPayout(ctx, [ITEM_A, ITEM_B], 4_950);

    const out = await refundOrderItems(staffDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(out.totalRefundedCents).toBe(0);
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    // The old credit paid the organiser 3536 for this ticket, so that is
    // what is pulled back; debit and reversal credit cancel.
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_zero_refund",
        amountCents: 3_536,
      }),
    );
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toMatchObject([
      { payeeId: "payee-1", amountCents: 3_536 },
    ]);
    expect(
      ctx.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT"),
    ).toMatchObject([{ payeeId: "payee-1", amountCents: 3_536 }]);
  });

  // Review finding, 2026-10-11 (BLOCKING): a $0 refund told the buyer "$0.00
  // is on its way back to your original payment method".
  describe("buyer notice for a $0 refund", () => {
    // The harness order's `eventId` is the placeholder "event-1"; the
    // renderer's schema wants a uuid, as every real order has.
    const render = (payload: Record<string, unknown>, locale: "en" | "es") =>
      renderNotification(
        "order.refund-processed",
        { ...payload, eventId: ORDER_ID },
        { now: NOW, locale },
      );

    it("sends the ticket-returned notice, en and es, on in-app and push", async () => {
      const { ctx } = freedContext();

      const out = await refundOrderItems(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
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

      // What the buyer reads, through the real renderer.
      const en = render(sent.payload, "en");
      expect(en.inApp?.title).toBe("Ticket returned");
      expect(en.inApp?.body).toBe(
        "Your ticket was returned. There is no money to refund for it.",
      );
      expect(en.inApp?.kind).toBe("INFO");
      expect(en.push?.title).toBe("Ticket returned");
      expect(en.push?.body).toBe(en.inApp?.body);
      expect(en.email).toBeUndefined();

      const es = render(sent.payload, "es");
      expect(es.inApp?.title).toBe("Entrada devuelta");
      expect(es.inApp?.body).toBe(
        "Tu entrada fue devuelta. No hay dinero que reembolsar por ella.",
      );

      for (const text of [en.inApp?.body, en.push?.body, es.inApp?.body]) {
        expect(text).not.toMatch(/on its way|de camino/);
      }
    });

    it("names the event and uses the plural when several $0 tickets are returned", async () => {
      // Two free-tier tickets beside the paid GA.
      const template = makeItems()[0]!;
      const freeTier = (id: string): OrderItemRecord => ({
        ...template,
        id,
        unitPriceCents: 0,
        amountCents: 0,
        meta: { buyerTotalCents: 0, platformFeePerTicketCents: 0 },
      });
      const items = [
        freeTier(ITEM_A),
        freeTier(ITEM_C),
        freedItems().find((item) => item.id === ITEM_B)!,
      ];
      const order = makeOrder({
        amountGrossCents: 5_000,
        feesPlatformCents: 50,
        taxAmountCents: 444,
        items,
      });
      const ctx = makeContext({
        order,
        itemsForTx: items,
        feeCents: STRIPE_FEE_CENTS,
      });
      (ctx.repos.events.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "event-1",
        orgId: "org-1",
        humanId: null,
        title: "Sunset Sessions",
        startsAt: new Date("2025-12-01T00:00:00.000Z"),
        refundCutoffAt: null,
      });

      await refundOrderItems(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_C],
      });

      const sent = (ctx.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(sent.payload).toMatchObject({ amountCents: 0, ticketCount: 2 });
      expect(render(sent.payload, "en").inApp).toMatchObject({
        title: "Tickets returned",
        body: "Your tickets for Sunset Sessions were returned. There is no money to refund for them.",
      });
      expect(render(sent.payload, "es").inApp).toMatchObject({
        title: "Entradas devueltas",
        body: "Tus entradas para Sunset Sessions fueron devueltas. No hay dinero que reembolsar por ellas.",
      });
    });

    it("a refund that moved money keeps the refund-processed notice", async () => {
      const { ctx } = freedContext();

      await refundOrderItems(makeDeps(ctx, { withNotify: true }), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_B],
      });

      const sent = (ctx.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(sent.payload).toMatchObject({ amountCents: 5_494, ticketCount: 1 });
      expect(render(sent.payload, "en").inApp).toMatchObject({
        title: "Partial refund processed",
        body: "A partial refund of $54.94 is on its way back to your original payment method.",
        kind: "SUCCESS",
      });
    });
  });
});
