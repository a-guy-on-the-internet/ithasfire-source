import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  OrderItemRecord,
  OrderRecord,
  OrdersRepo,
} from "@th/ports/repos/orders";
import type { OrderItemsRepo } from "@th/ports/repos/order-items";
import type { TicketRecord, TicketsRepo } from "@th/ports/repos/tickets";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import type { MailerPort } from "@th/ports/comms/mailer";

import { reconcileStripeFullRefund } from "../reconcile-stripe-full-refund";

const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TICKET_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const TICKET_2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const ORIGINAL_ORDER_ID = "33333333-3333-4333-8333-333333333333";
const ORIGINAL_ORDER_ITEM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BUYER_ID = "44444444-4444-4444-8444-444444444444";
const SELLER_ID = "55555555-5555-4555-8555-555555555555";
const RESALE_LISTING_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-04-20T12:00:00.000Z");

function makeItems(overrides?: Partial<OrderItemRecord>[]): OrderItemRecord[] {
  const base: OrderItemRecord[] = [
    {
      id: ITEM_A,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: "tt-1",
      qty: 1,
      unitPriceCents: 5000,
      amountCents: 5000,
      meta: { buyerTotalCents: 5500 },
      paidOutAt: null,
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
    },
    {
      id: ITEM_B,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: "tt-1",
      qty: 1,
      unitPriceCents: 5000,
      amountCents: 5000,
      meta: { buyerTotalCents: 5500 },
      paidOutAt: null,
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
    },
  ];

  overrides?.forEach((override, index) => {
    if (base[index]) {
      Object.assign(base[index], override);
    }
  });

  return base;
}

function makeOrder(partial: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: "event-1",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 10000,
    feesPlatformCents: 1000,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2026-04-01T00:00:00.000Z"),
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
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
    { id: TICKET_2, status: "SCANNED", scannedAt: NOW },
  ];
}

function makeLogger(): LoggerPort {
  const logger = {
    child: vi.fn(),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort;

  (logger.child as ReturnType<typeof vi.fn>).mockReturnValue(logger);

  return logger;
}

function makeContext(opts?: {
  order?: OrderRecord | null;
  findStatus?: OrderRecord["status"];
  txOrder?: OrderRecord | null;
  tickets?: Array<FakeTicket>;
  ticketByOrderItem?: TicketRecord | null;
  ticketById?: TicketRecord | null;
  listing?: {
    id: string;
    sellerHumanId: string;
    ticketId?: string;
    status?: string;
    buyerOrderId?: string | null;
  };
  txTicketByOrderItem?: TicketRecord | null;
  txTicketById?: TicketRecord | null;
  txListing?: {
    id: string;
    sellerHumanId: string;
    ticketId?: string;
    status?: string;
    buyerOrderId?: string | null;
    eventShareCents?: number | null;
    eventId?: string;
    askPriceCents?: number;
    currency?: string;
  };
}) {
  const order = opts?.order ?? makeOrder();
  const txOrder = opts?.txOrder ?? order;
  const findStatus = opts?.findStatus ?? order?.status ?? "SUCCEEDED";
  const tickets = opts?.tickets ?? makeTickets();
  const txTicketByOrderItem =
    opts?.txTicketByOrderItem === undefined
      ? ({
          id: TICKET_1,
          ownerHumanId: BUYER_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_A,
          status: "VALID",
        } as TicketRecord)
      : opts.txTicketByOrderItem;
  const txTicketById = opts?.txTicketById ?? txTicketByOrderItem;
  const txListing = {
    id: RESALE_LISTING_ID,
    sellerHumanId: SELLER_ID,
    eventShareCents: 500, // priced under the share (a listing with none is closed, FR-015)
    ticketId: TICKET_1,
    status: "SOLD",
    buyerOrderId: ORDER_ID,
    ...opts?.txListing,
  };
  const ticketByOrderItem =
    opts?.ticketByOrderItem === undefined
      ? txTicketByOrderItem
      : opts.ticketByOrderItem;
  const ticketById = opts?.ticketById ?? txTicketById;
  const listing = {
    ...txListing,
    ...opts?.listing,
  };

  const ordersRepo: OrdersRepo = {
    findByPaymentIntent: vi.fn(async () =>
      order
        ? {
            id: order.id,
            status: findStatus,
          }
        : null,
    ) as OrdersRepo["findByPaymentIntent"],
    getById: vi.fn(async () => order) as OrdersRepo["getById"],
    markRefunded: vi.fn(async () => undefined),
  } as unknown as OrdersRepo;

  const orderItemsRepo: OrderItemsRepo = {
    updateStatus: vi.fn(async () => undefined),
    setResaleListingId: vi.fn(async () => undefined),
  } as unknown as OrderItemsRepo;

  const ticketsRepo: TicketsRepo = {
    listByOrderId: vi.fn(async () => tickets),
    getByOrderItemId: vi.fn(async (orderItemId: string) => {
      if (orderItemId !== ITEM_A || !ticketByOrderItem) {
        return null;
      }

      return ticketByOrderItem;
    }),
    getById: vi.fn(async (ticketId: string) => {
      if (ticketId !== TICKET_1 || !ticketById) {
        return null;
      }

      return ticketById;
    }),
    setStatus: vi.fn(async () => true),
    transfer: vi.fn(async () => true),
    restoreAfterResale: vi.fn(async () => undefined),
  } as unknown as TicketsRepo;

  const payeeLedger = createFakePayeeLedgerRepo();

  const txRepos = {
    orders: {
      // The seller's original order is its own row, and a PRIMARY one: the
      // unwind reads its `source` to decide whether the restored item's
      // listing pointer may be written (never on a RESALE item).
      getById: vi.fn(async (id?: string) =>
        id === ORIGINAL_ORDER_ID
          ? ({ id: ORIGINAL_ORDER_ID, source: "PRIMARY", items: [] } as never)
          : txOrder,
      ),
      markRefunded: vi.fn(async () => undefined),
    },
    orderItems: {
      updateStatus: vi.fn(async () => undefined),
      setResaleListingId: vi.fn(async () => undefined),
      // `markOrderTicketsRefunded` reads the items to find the ones this order
      // gave away — their tickets belong to somebody else now and must survive
      // a refund the sender was never paid for.
      listByOrderId: vi.fn(async () => txOrder?.items ?? []),
      // Seat history: the former seat is stamped onto the order item just
      // before the ticket's @unique `seatId` link is cleared.
      recordReleasedSeats: vi.fn(async () => undefined),
    },
    tickets: {
      listByOrderId: vi.fn(async () => tickets),
      getByOrderItemId: vi.fn(async (orderItemId: string) => {
        if (orderItemId !== ITEM_A || !txTicketByOrderItem) {
          return null;
        }

        return txTicketByOrderItem;
      }),
      getById: vi.fn(async (ticketId: string) => {
        if (ticketId !== TICKET_1 || !txTicketById) {
          return null;
        }

        return txTicketById;
      }),
      // The RESALE arm locks the ticket row before it writes the item.
      getByIdForUpdate: vi.fn(async (ticketId: string) =>
        ticketId === TICKET_1 ? (txTicketById ?? txTicketByOrderItem) : null,
      ),
      setStatus: vi.fn(async () => true),
      transfer: vi.fn(async () => true),
      restoreAfterResale: vi.fn(async () => undefined),
      clearSeatAssignments: vi.fn(async () => undefined),
    },
    // Reserved seats of the tickets this reconciliation kills go back on sale.
    seats: {
      updateStatuses: vi.fn(async () => undefined),
      releaseSeats: vi.fn(async () => undefined),
    },
    resaleListings: {
      getById: vi.fn(async () => txListing),
      // The unwind looks for a live listing of the refunded buyer's own.
      getByTicketId: vi.fn(async () => null),
      unwindSale: vi.fn(async () => undefined),
    },
    // NO `settlements` on the tx: cancelForOrder is DELETED — external
    // refunds write REFUND_DEBIT ledger entries instead (spec §4).
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
    // A RESALE unwind reads the order's claims: an APPROVED one cancels the
    // listing instead of putting the ticket back on sale. None by default.
    claims: {
      getByOrderItemId: vi.fn(
        async (_orderItemId: string): Promise<unknown> => null,
      ),
    },
    audit: {
      log: vi.fn(async () => undefined),
    },
  };

  const repos: Repos = {
    orders: ordersRepo,
    orderItems: orderItemsRepo,
    tickets: ticketsRepo,
    resaleListings: {
      getById: vi.fn(async () => listing),
    },
    tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<unknown>) =>
      fn(txRepos),
    ),
  } as unknown as Repos;

  const clock: ClockPort = {
    now: vi.fn(() => NOW),
  } as ClockPort;

  // Fake refund mutex backing (refund-mutex.ts): begin=true → acquired,
  // released via owner-checked release() in the helper's finally. Tests flip
  // begin to false to simulate a competing refund operation holding the order.
  const idempotencyMocks = {
    begin: vi.fn(async () => true),
    commit: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    // Owner-checked release (refund-mutex.ts): compare-and-delete by token.
    release: vi.fn(async () => true),
    get: vi.fn(async () => null),
    run: vi.fn(),
    purgeExpired: vi.fn(async () => 0),
  };
  const idempotency = idempotencyMocks as unknown as IdempotencyPort;

  return { repos, clock, txRepos, payeeLedger, idempotency, idempotencyMocks };
}

describe("reconcileStripeFullRefund", () => {
  it("reconciles a full primary refund and debits each payee's full credit", async () => {
    const ctx = makeContext();
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 10_000,
      items: { [ITEM_A]: 5_000, [ITEM_B]: 5_000 },
    });

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 11000,
        sourceEventType: "charge.refunded",
        fullyRefundedHint: true,
      },
    );

    expect(result.outcome).toBe("reconciled_primary");
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
    );
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_B,
      "refunded",
      NOW,
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledTimes(2);
    expect(ctx.txRepos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
    // Primary orders now get the SAME ledger treatment as resale ones: one
    // REFUND_DEBIT per payee, full credit back, keyed on the payment intent
    // when Stripe supplies no refund id.
    const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      payeeId: "payee-1",
      amountCents: 10_000,
      // No Stripe refund id on charge.refunded → the fallback key is
      // NAMESPACED with the refunded amount (Step C review): a bare PI id
      // would collapse two distinct external refunds on one PI into a
      // single idempotency key, silently deduping the second debit.
      idempotencyKey: `refund-debit:${ORDER_ID}:payee-1:pi:pi_123:11000`,
    });
  });

  // Owner ruling 2026-10-10: a refund of a scanned-in ticket means the person
  // left. The void clears `scannedAt`, so the audit row is the only record
  // that the ticket had admitted someone.
  describe("leftOnRefund on the full arm's audit row", () => {
    const fullRefundInput = {
      paymentIntentId: "pi_123",
      amountRefundedCents: 11000,
      sourceEventType: "charge.refunded" as const,
      fullyRefundedHint: true,
    };
    const reconciledAuditData = (ctx: ReturnType<typeof makeContext>) => {
      const entry = (ctx.txRepos.audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[0] as { action: string; data: Record<string, unknown> })
        .find((e) => e.action === "stripe_refund_reconciled");
      expect(entry).toBeDefined();
      return entry!.data;
    };
    /**
     * Make the fake write what the real one writes, ON THE ROW THE READ
     * RETURNED: a list taken after the void then finds no SCANNED ticket.
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

    it("lists exactly the scanned ticket with its admit time", async () => {
      const admittedAt = new Date("2026-04-19T23:41:07.000Z");
      const tickets = [
        { id: TICKET_1, status: "SCANNED" as const, scannedAt: admittedAt },
        { id: TICKET_2, status: "VALID" as const, scannedAt: null },
      ];
      const ctx = makeContext({ tickets });
      voidInPlace(ctx, tickets);

      const result = await reconcileStripeFullRefund(
        { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
        fullRefundInput,
      );

      expect(result.outcome).toBe("reconciled_primary");
      expect(tickets.map((t) => t.status)).toEqual(["REFUNDED", "REFUNDED"]);
      expect(reconciledAuditData(ctx).leftOnRefund).toEqual([
        { ticketId: TICKET_1, admittedAt: "2026-04-19T23:41:07.000Z" },
      ]);
    });

    it("writes no leftOnRefund key when no refunded ticket had been scanned", async () => {
      const tickets = [
        { id: TICKET_1, status: "VALID" as const, scannedAt: null },
        { id: TICKET_2, status: "VALID" as const, scannedAt: null },
      ];
      const ctx = makeContext({ tickets });
      voidInPlace(ctx, tickets);

      await reconcileStripeFullRefund(
        { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
        fullRefundInput,
      );

      expect(reconciledAuditData(ctx)).not.toHaveProperty("leftOnRefund");
    });
  });

  // Refunds restock (spec 2026-10-09), fix round 2. The webhook arm used to
  // replay `resale_restore_ticket_terminal` into the DLQ for a resale ticket
  // that was already INVALID: the refund never reconciled and no REFUND_DEBIT
  // was written.
  it("reconciles a full resale refund whose ticket is already INVALID: marked, debited, listing CANCELLED", async () => {
    const resaleOrder = makeOrder({
      source: "RESALE",
      parentOrderId: ORIGINAL_ORDER_ID,
      items: [
        {
          ...makeItems()[0],
          meta: {
            buyerTotalCents: 5500,
            resaleListingId: RESALE_LISTING_ID,
            resaleOriginalOrderId: ORIGINAL_ORDER_ID,
            resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
          },
          resaleListingId: RESALE_LISTING_ID,
        },
      ],
    });
    const ctx = makeContext({
      order: resaleOrder,
      txOrder: resaleOrder,
      txTicketByOrderItem: {
        id: TICKET_1,
        ownerHumanId: resaleOrder.buyerHumanId,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "INVALID",
      } as unknown as TicketRecord,
    });
    // The adapter's guard: a terminal ticket is never restored.
    (
      ctx.txRepos.tickets.restoreAfterResale as ReturnType<typeof vi.fn>
    ).mockRejectedValue({
      code: "conflict",
      message: "resale_restore_ticket_terminal",
    });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 5_000,
      items: { [ITEM_A]: 5_000 },
    });

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5500,
        sourceEventType: "charge.refund.updated",
        refundId: "re_123",
      },
    );

    expect(result.outcome).toBe("reconciled_resale");
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
    expect(ctx.txRepos.tickets.restoreAfterResale).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.transfer).not.toHaveBeenCalled();
    expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
      RESALE_LISTING_ID,
      ORDER_ID,
      "CANCELLED",
    );
  });

  // ── The refunded resale buyer listed the ticket again, or sold it on ──
  // Owner ruling 2026-10-11: a ticket bought on resale can be resold. This
  // webhook runs AFTER Stripe has paid the buyer back, so whatever state the
  // ticket is in, the reconcile must commit: order REFUNDED, REFUND_DEBIT
  // written. A throw here rolls that back and replays into the DLQ.
  describe("a resale order whose buyer relisted the ticket", () => {
    const RELIST_ID = "99999999-9999-4999-8999-999999999999";
    const LATER_ITEM_ID = "88888888-8888-4888-8888-888888888888";
    const LATER_ORDER_ID = "77777777-7777-4777-8777-777777777777";
    const LATER_HOLDER_ID = "66666666-6666-4666-8666-666666666666";

    const resaleOrder = () =>
      makeOrder({
        source: "RESALE",
        parentOrderId: ORIGINAL_ORDER_ID,
        items: [
          {
            ...makeItems()[0],
            meta: {
              buyerTotalCents: 5500,
              resaleListingId: RESALE_LISTING_ID,
              resaleOriginalOrderId: ORIGINAL_ORDER_ID,
              resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
            },
            resaleListingId: RESALE_LISTING_ID,
          },
        ],
      });
    const listedTicket = {
      id: TICKET_1,
      ownerHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId: ITEM_A,
      status: "LISTED",
    } as TicketRecord;

    /** The repo calls the relist branches of the unwind make. */
    function withBuyerListing(
      ctx: ReturnType<typeof makeContext>,
      status: "ACTIVE" | "HELD",
    ) {
      const cancel = vi.fn(async () => status === "ACTIVE");
      // The adapter's HELD → CANCELLED compare-and-swap, returning the hold
      // it dropped.
      let relistStatus: string = status;
      const closeHeld = vi.fn(async () => {
        if (relistStatus !== "HELD") return { closed: false, hold: null };
        relistStatus = "CANCELLED";
        return {
          closed: true,
          hold: { buyerHumanId: LATER_HOLDER_ID, heldUntil: NOW },
        };
      });
      const getByIdForUpdate = vi.fn(async () => listedTicket);
      Object.assign(ctx.txRepos.tickets, { getByIdForUpdate });
      Object.assign(ctx.txRepos.resaleListings, {
        getByTicketId: vi.fn(async () => ({
          id: RELIST_ID,
          ticketId: TICKET_1,
          sellerHumanId: BUYER_ID,
          status,
        })),
        cancel,
        closeHeld,
        listOrdersForHold: vi.fn(async () => [
          { id: LATER_ORDER_ID, status: "PENDING", holdExpiresAt: null },
        ]),
        getById: vi.fn(async (id: string) =>
          id === RELIST_ID
            ? {
                id: RELIST_ID,
                ticketId: TICKET_1,
                sellerHumanId: BUYER_ID,
                status: relistStatus,
              }
            : {
                id: RESALE_LISTING_ID,
                sellerHumanId: SELLER_ID,
                eventShareCents: 500, // priced under the share (a listing with none is closed, FR-015)
                ticketId: TICKET_1,
                status: "SOLD",
                buyerOrderId: ORDER_ID,
              },
        ),
      });
      return { cancel, closeHeld, getByIdForUpdate };
    }

    const run = async (
      ctx: ReturnType<typeof makeContext>,
      reportError: ReturnType<typeof vi.fn>,
    ) => {
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-seller",
        amountCents: 5_000,
        items: { [ITEM_A]: 5_000 },
      });
      return reconcileStripeFullRefund(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          reportError,
        },
        {
          paymentIntentId: "pi_123",
          amountRefundedCents: 5500,
          sourceEventType: "charge.refund.updated",
          refundId: "re_123",
        },
      );
    };

    const reportedMessages = (reportError: ReturnType<typeof vi.fn>) =>
      reportError.mock.calls.map(([error]) => (error as Error).message);

    it("ACTIVE listing: closes it, then unwinds the sale and commits the refund", async () => {
      const order = resaleOrder();
      const ctx = makeContext({
        order,
        txOrder: order,
        txTicketByOrderItem: listedTicket,
      });
      const { cancel, getByIdForUpdate } = withBuyerListing(ctx, "ACTIVE");
      const reportError = vi.fn();

      const result = await run(ctx, reportError);

      expect(result.outcome).toBe("reconciled_resale");
      expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID);
      expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
      expect(cancel).toHaveBeenCalledWith(RELIST_ID, BUYER_ID);
      expect(ctx.txRepos.tickets.transfer).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: TICKET_1, toHumanId: SELLER_ID }),
      );
      expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
        RESALE_LISTING_ID,
        ORDER_ID,
        "ACTIVE",
      );
      // Ticket lock, then the buyer's listing, then the sale's listing.
      const lockAt = getByIdForUpdate.mock.invocationCallOrder[0]!;
      const cancelAt = cancel.mock.invocationCallOrder[0]!;
      const unwindAt = (
        ctx.txRepos.resaleListings.unwindSale as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0]!;
      expect(lockAt).toBeLessThan(cancelAt);
      expect(cancelAt).toBeLessThan(unwindAt);
      expect(reportedMessages(reportError)).not.toContain(
        "resale_unwind_ticket_relisted_checkout_in_flight",
      );
    });

    // A third person's checkout holds the buyer's listing. It could never
    // complete (this refund has just marked the buyer's item refunded, and
    // finalize refuses that), so the ticket goes back to the seller, the
    // held listing is closed, and the sale is CANCELLED rather than put
    // back on sale. Reported: somebody's checkout was ended under them.
    it("HELD listing: closes it, returns the ticket to the seller with the sale CANCELLED, and commits the refund, reported", async () => {
      const order = resaleOrder();
      const ctx = makeContext({
        order,
        txOrder: order,
        txTicketByOrderItem: listedTicket,
      });
      const { cancel, closeHeld, getByIdForUpdate } = withBuyerListing(
        ctx,
        "HELD",
      );
      const reportError = vi.fn();

      const result = await run(ctx, reportError);

      expect(result.outcome).toBe("reconciled_resale");
      expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID);
      expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
      expect(cancel).not.toHaveBeenCalled();
      expect(closeHeld).toHaveBeenCalledWith(RELIST_ID);
      expect(ctx.txRepos.tickets.transfer).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: TICKET_1, toHumanId: SELLER_ID }),
      );
      expect(ctx.txRepos.tickets.restoreAfterResale).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: TICKET_1,
          restoredOrderItemId: ORIGINAL_ORDER_ITEM_ID,
        }),
      );
      // Never ACTIVE here, though this reconcile's disposition is
      // restore_active (no approved claim).
      expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledTimes(1);
      expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
        RESALE_LISTING_ID,
        ORDER_ID,
        "CANCELLED",
      );
      // The seller's ticket is not relisted.
      expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalledWith(
        TICKET_1,
        "LISTED",
        expect.anything(),
      );
      // Ticket lock FIRST, before the buyer's item is flipped (the order a
      // later buyer's finalize takes; the reverse deadlocks with it), then
      // the buyer's listing, then the sale's listing.
      const lockAt = getByIdForUpdate.mock.invocationCallOrder[0]!;
      const itemAt = (
        ctx.txRepos.orderItems.updateStatus as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0]!;
      expect(lockAt).toBeLessThan(itemAt);
      const closeAt = closeHeld.mock.invocationCallOrder[0]!;
      const unwindAt = (
        ctx.txRepos.resaleListings.unwindSale as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0]!;
      expect(lockAt).toBeLessThan(closeAt);
      expect(closeAt).toBeLessThan(unwindAt);

      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "resale_unwind_ticket_relisted_checkout_in_flight",
        }),
        expect.objectContaining({
          extra: expect.objectContaining({
            orderId: ORDER_ID,
            ticketRestoredToSeller: true,
            purchasedListingStatusAfter: "CANCELLED",
            checkoutInFlight: expect.objectContaining({
              listingId: RELIST_ID,
              listingClosed: true,
              listingStatusAfter: "CANCELLED",
              holdBuyerHumanId: LATER_HOLDER_ID,
              orders: [{ id: LATER_ORDER_ID, status: "PENDING" }],
            }),
          }),
        }),
      );
    });

    // The buyer's own onward sale commits WHILE this refund waits for the
    // ticket row (the later buyer's finalize holds it). The order was read
    // before the wait with the item still `active`; acting on that read
    // wrote `refunded` over `transferred`, marked the order refunded and
    // debited the first seller for a ticket they never got back. The order
    // is read again under the lock and goes to manual review, exactly as it
    // would had the sale committed a moment earlier.
    it("sold on while the refund waited for the ticket lock: manual review, nothing written, nobody debited", async () => {
      const order = resaleOrder();
      const soldOn = {
        ...order,
        items: order.items.map((item) => ({
          ...item,
          status: "transferred" as const,
          transferredAt: NOW,
        })),
      };
      const ctx = makeContext({
        order,
        txOrder: order,
        txTicketByOrderItem: listedTicket,
      });
      // The lock returns once the later buyer's finalize has committed:
      // every read of the order after it sees the item `transferred`.
      let lockTaken = false;
      const getByIdForUpdate = vi.fn(async () => {
        lockTaken = true;
        return {
          ...listedTicket,
          ownerHumanId: LATER_HOLDER_ID,
          orderId: LATER_ORDER_ID,
          orderItemId: LATER_ITEM_ID,
          status: "VALID",
        } as TicketRecord;
      });
      Object.assign(ctx.txRepos.tickets, { getByIdForUpdate });
      const txGetById = vi.fn(async (id?: string) =>
        id === ORIGINAL_ORDER_ID
          ? ({ id: ORIGINAL_ORDER_ID, source: "PRIMARY", items: [] } as never)
          : lockTaken
            ? soldOn
            : order,
      );
      Object.assign(ctx.txRepos.orders, { getById: txGetById });
      const reportError = vi.fn();

      const result = await run(ctx, reportError);

      expect(result.outcome).toBe("manual_review_required");
      // Read once before the lock and once under it.
      expect(getByIdForUpdate).toHaveBeenCalledWith(TICKET_1);
      expect(txGetById).toHaveBeenCalledTimes(2);
      expect(txGetById.mock.invocationCallOrder[1]!).toBeGreaterThan(
        getByIdForUpdate.mock.invocationCallOrder[0]!,
      );
      expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
      expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
      expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
      expect(ctx.txRepos.tickets.transfer).not.toHaveBeenCalled();
      expect(ctx.txRepos.tickets.restoreAfterResale).not.toHaveBeenCalled();
      expect(ctx.txRepos.resaleListings.unwindSale).not.toHaveBeenCalled();
      expect(ctx.txRepos.audit.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "purchase_unwound_after_refund" }),
      );
      // A person hears about it, with the item that was sold on.
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "stripe_full_refund_needs_manual_review",
        }),
        expect.objectContaining({
          extra: expect.objectContaining({
            orderId: ORDER_ID,
            resaleLinkedTransferredItemIds: [ITEM_A],
          }),
        }),
      );
      expect(reportedMessages(reportError)).not.toContain(
        "resale_unwind_ticket_sold_on",
      );
    });
  });

  it("reconciles a full resale refund and unwinds ownership", async () => {
    const resaleOrder = makeOrder({
      source: "RESALE",
      parentOrderId: ORIGINAL_ORDER_ID,
      items: [
        {
          ...makeItems()[0],
          meta: {
            buyerTotalCents: 5500,
            resaleListingId: RESALE_LISTING_ID,
            resaleOriginalOrderId: ORIGINAL_ORDER_ID,
            resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
          },
          resaleListingId: RESALE_LISTING_ID,
        },
      ],
    });
    const ctx = makeContext({ order: resaleOrder, txOrder: resaleOrder });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 5_000,
      items: { [ITEM_A]: 5_000 },
    });

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5500,
        sourceEventType: "charge.refund.updated",
        refundId: "re_123",
      },
    );

    expect(result.outcome).toBe("reconciled_resale");
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
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
    expect(ctx.txRepos.tickets.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_1,
        fromHumanId: BUYER_ID,
        toHumanId: SELLER_ID,
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
    expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
      RESALE_LISTING_ID,
      ORDER_ID,
      "ACTIVE",
    );
    expect(ctx.txRepos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
    // The seller's credit comes back as a REFUND_DEBIT keyed on the Stripe
    // refund id this webhook reconciles (cancelForOrder is deleted).
    const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      payeeId: "payee-seller",
      amountCents: 5_000,
      idempotencyKey: `refund-debit:${ORDER_ID}:payee-seller:re_123`,
    });
  });

  // organiser-resale-share FR-015: a refund of a sale priced under the removed
  // markup split closes the listing; the seller is told after the commit.
  describe("a resale sale priced under the removed markup split", () => {
    function legacyContext(findStatus?: "REFUNDED") {
      const resaleOrder = makeOrder({
        source: "RESALE",
        parentOrderId: ORIGINAL_ORDER_ID,
        items: [
          {
            ...makeItems()[0],
            meta: {
              buyerTotalCents: 5500,
              resaleListingId: RESALE_LISTING_ID,
              resaleOriginalOrderId: ORIGINAL_ORDER_ID,
              resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
            },
            resaleListingId: RESALE_LISTING_ID,
          },
        ],
      });
      const ctx = makeContext({
        order: resaleOrder,
        txOrder: resaleOrder,
        ...(findStatus ? { findStatus } : {}),
        txListing: {
          id: RESALE_LISTING_ID,
          sellerHumanId: SELLER_ID,
          eventShareCents: null,
          eventId: "event-1",
          askPriceCents: 5000,
          currency: "usd",
        },
      });
      const create = vi.fn(async () => ({ id: "n-1" }));
      Object.assign(ctx.repos, {
        notifications: { create },
        events: { getById: vi.fn(async () => ({ id: "event-1", title: "Sunset Sessions" })) },
      });
      return { ctx, create };
    }
    const input = {
      paymentIntentId: "pi_123",
      amountRefundedCents: 5500,
      sourceEventType: "charge.refunded",
      refundId: "re_123",
    };

    it("closes the listing and tells the seller once the reconcile commits", async () => {
      const h = legacyContext();

      const result = await reconcileStripeFullRefund(
        {
          repos: h.ctx.repos,
          clock: h.ctx.clock,
          idempotency: h.ctx.idempotency,
          publicAppUrl: "https://ithas.fire",
        },
        input,
      );

      expect(result.outcome).toBe("reconciled_resale");
      expect(h.ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
        RESALE_LISTING_ID,
        ORDER_ID,
        "CANCELLED",
      );
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.create).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: SELLER_ID,
          metadata: { variant: "resale.sale-refunded-listing-closed" },
          action: {
            label: "List it again",
            href: `https://ithas.fire/sell/listings/new?orderId=${ORIGINAL_ORDER_ID}`,
          },
        }),
      );
    });

    it("the charge.refunded that follows a refund made in-app finds the order REFUNDED: no second notice", async () => {
      const h = legacyContext("REFUNDED");

      const result = await reconcileStripeFullRefund(
        {
          repos: h.ctx.repos,
          clock: h.ctx.clock,
          idempotency: h.ctx.idempotency,
          publicAppUrl: "https://ithas.fire",
        },
        input,
      );

      expect(result.outcome).toBe("already_refunded");
      expect(h.create).not.toHaveBeenCalled();
    });
  });

  it("treats overlapping duplicate resale reconciliation as a clean no-op unwind replay", async () => {
    const resaleOrder = makeOrder({
      source: "RESALE",
      status: "PART_REFUNDED",
      parentOrderId: ORIGINAL_ORDER_ID,
      items: [
        {
          ...makeItems()[0],
          meta: {
            buyerTotalCents: 5500,
            resaleListingId: RESALE_LISTING_ID,
            resaleOriginalOrderId: ORIGINAL_ORDER_ID,
            resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
          },
          resaleListingId: RESALE_LISTING_ID,
        },
      ],
    });
    const ctx = makeContext({
      order: resaleOrder,
      txOrder: resaleOrder,
      findStatus: "PART_REFUNDED",
      txTicketByOrderItem: null,
      txTicketById: {
        id: TICKET_1,
        ownerHumanId: SELLER_ID,
        orderId: ORIGINAL_ORDER_ID,
        orderItemId: ORIGINAL_ORDER_ITEM_ID,
        status: "VALID",
      } as TicketRecord,
      txListing: {
        id: RESALE_LISTING_ID,
        sellerHumanId: SELLER_ID,
        eventShareCents: 500, // priced under the share (a listing with none is closed, FR-015)
        ticketId: TICKET_1,
        status: "CANCELLED",
        buyerOrderId: null,
      },
    });

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5500,
        sourceEventType: "charge.refunded",
        fullyRefundedHint: true,
      },
    );

    expect(result.outcome).toBe("reconciled_resale");
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(ctx.txRepos.tickets.transfer).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.restoreAfterResale).not.toHaveBeenCalled();
    expect(ctx.txRepos.resaleListings.unwindSale).not.toHaveBeenCalled();
    // No credits were seeded for this order (the earlier internal refund
    // path would have owned the debits) — the ledger write is a reported
    // no-op, never a throw or a duplicate.
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toEqual([]);
  });

  it("reconciles a later full Stripe refund for a PART_REFUNDED order", async () => {
    const partialOrder = makeOrder({
      status: "PART_REFUNDED",
      items: makeItems([
        {
          status: "refunded",
          refundedAt: NOW,
        },
        {},
      ]),
    });
    const ctx = makeContext({
      order: partialOrder,
      txOrder: partialOrder,
      findStatus: "PART_REFUNDED",
      tickets: [{ id: TICKET_2, status: "VALID", scannedAt: null }],
    });

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 11000,
        sourceEventType: "charge.refunded",
        fullyRefundedHint: true,
      },
    );

    expect(result.outcome).toBe("reconciled_primary");
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_B,
      "refunded",
      NOW,
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
  });

  it("returns manual_review_required for a primary order with a resale-linked transferred leg", async () => {
    const order = makeOrder({
      items: makeItems([
        {},
        {
          status: "transferred",
          transferredAt: NOW,
          resaleListingId: null,
          meta: {
            buyerTotalCents: 5500,
            resaleListingId: RESALE_LISTING_ID,
          },
        },
      ]),
    });
    const ctx = makeContext({ order, txOrder: order });
    const logger = makeLogger();
    const reportError = vi.fn();

    const result = await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        logger,
        reportError,
      },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 11000,
        sourceEventType: "charge.refunded",
        fullyRefundedHint: true,
      },
    );

    expect(result.outcome).toBe("manual_review_required");
    // The webhook is acked and never retried, so the review must reach Sentry
    // (warn is not captured).
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          step: "manualReview",
          reason: "manual_review_required",
        }),
        extra: expect.objectContaining({ orderId: ORDER_ID }),
      }),
    );
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "reconcileStripeFullRefund.manual_review_required",
      expect.objectContaining({
        orderId: ORDER_ID,
        paymentIntentId: "pi_123",
        resaleLinkedTransferredItemIds: [ITEM_B],
      }),
    );
  });

  // Owner ruling 2026-10-05 (option b): a RESALE order whose buyer gifted or
  // resold the ticket goes to manual review like PRIMARY. Unwinding would take
  // the ticket from whoever holds it now.
  function giftedResaleOrder() {
    return makeOrder({
      source: "RESALE",
      parentOrderId: ORIGINAL_ORDER_ID,
      items: [
        {
          ...makeItems()[0],
          status: "transferred",
          transferredAt: NOW,
          meta: {
            buyerTotalCents: 5500,
            resaleListingId: RESALE_LISTING_ID,
            resaleOriginalOrderId: ORIGINAL_ORDER_ID,
            resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
          },
          resaleListingId: RESALE_LISTING_ID,
        },
      ],
    });
  }

  it("sends a resale order whose ticket the buyer gave away to manual review, and reports it", async () => {
    const order = giftedResaleOrder();
    const ctx = makeContext({ order, txOrder: order });
    const reportError = vi.fn();

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency, reportError },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5500,
        sourceEventType: "charge.refunded",
        refundId: "re_123",
      },
    );

    expect(result.outcome).toBe("manual_review_required");
    expect(result.orderSource).toBe("RESALE");
    // Nothing settles automatically: no tx, no unwind, no ticket move.
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(ctx.txRepos.resaleListings.unwindSale).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.transfer).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "manualReview" }),
        extra: expect.objectContaining({
          orderId: ORDER_ID,
          orderSource: "RESALE",
          resaleLinkedTransferredItemIds: [ITEM_A],
        }),
      }),
    );
  });

  it("a throwing reporter does not change the manual-review outcome", async () => {
    const order = giftedResaleOrder();
    const ctx = makeContext({ order, txOrder: order });

    const result = await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError: () => {
          throw new Error("sentry down");
        },
      },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5500,
        sourceEventType: "charge.refunded",
        refundId: "re_123",
      },
    );

    expect(result.outcome).toBe("manual_review_required");
  });

  it("a gift that commits after the snapshot is caught on the fresh read inside the tx", async () => {
    const gifted = giftedResaleOrder();
    const snapshot = makeOrder({
      ...gifted,
      items: [{ ...gifted.items[0], status: "active", transferredAt: null }],
    });
    const ctx = makeContext({ order: snapshot, txOrder: gifted });
    const reportError = vi.fn();

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency, reportError },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5500,
        sourceEventType: "charge.refunded",
        refundId: "re_123",
      },
    );

    expect(result.outcome).toBe("manual_review_required");
    expect(ctx.repos.tx).toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(ctx.txRepos.resaleListings.unwindSale).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.transfer).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({
          resaleLinkedTransferredItemIds: [ITEM_A],
        }),
      }),
    );
  });

  it("no-ops when the order is already refunded", async () => {
    const ctx = makeContext({ findStatus: "REFUNDED" });

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 11000,
        sourceEventType: "charge.refunded",
      },
    );

    expect(result.outcome).toBe("already_refunded");
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("reports and skips a partial refund that carries no refund id", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    const logger = makeLogger();

    const result = await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        logger,
        reportError,
      },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5000,
        sourceEventType: "charge.refund.updated",
      },
    );

    // No refund id → no safe idempotency key. Never guess: report loudly
    // (Sentry) and skip so an operator can re-drive the event.
    expect(result.outcome).toBe("partial_refund_ignored");
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "external_partial_refund_missing_refund_id",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "missing_refund_id" }),
      }),
    );
  });

  describe("external partial refunds (the leak door)", () => {
    // Order buyer-side total = 11 000¢ (two items, buyerTotalCents 5 500
    // each). Payee-side credits: 3 500 + 2 300 = 5 800.
    async function seedTwoPayees(ctx: ReturnType<typeof makeContext>) {
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-1",
        amountCents: 3_500,
        items: { [ITEM_A]: 1_750, [ITEM_B]: 1_750 },
      });
      await ctx.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-2",
        amountCents: 2_300,
        items: { [ITEM_A]: 1_150, [ITEM_B]: 1_150 },
      });
    }

    function debitTotals(ctx: ReturnType<typeof makeContext>) {
      const totals = new Map<string, number>();
      for (const entry of ctx.payeeLedger.entriesOfType("REFUND_DEBIT")) {
        totals.set(
          entry.payeeId,
          (totals.get(entry.payeeId) ?? 0) + entry.amountCents,
        );
      }
      return totals;
    }

    it("writes proportional per-payee debits for a single partial refund", async () => {
      const ctx = makeContext();
      const reportError = vi.fn();
      await seedTwoPayees(ctx);

      const result = await reconcileStripeFullRefund(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          reportError,
        },
        {
          paymentIntentId: "pi_123",
          amountRefundedCents: 3000,
          refundId: "re_p1",
          sourceEventType: "charge.refunded",
          fullyRefundedHint: false,
        },
      );

      expect(result.outcome).toBe("partial_refund_reconciled");

      // floor(3000 × 3500 / 11000) = 954, floor(3000 × 2300 / 11000) = 627;
      // Σ = 1581 = floor(3000 × 5800 / 11000) → no remainder units.
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(2);
      expect(debits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payeeId: "payee-1",
            amountCents: 954,
            // Partial keys carry the CUMULATIVE amount suffix so a
            // best-effort (possibly stale) refund id can never key-replay
            // away a later, larger recompute.
            idempotencyKey: `refund-debit:${ORDER_ID}:payee-1:re_p1:3000`,
          }),
          expect.objectContaining({
            payeeId: "payee-2",
            amountCents: 627,
            idempotencyKey: `refund-debit:${ORDER_ID}:payee-2:re_p1:3000`,
          }),
        ]),
      );

      // Ledger only — an amount-level partial has no item granularity, so
      // order/item/ticket statuses stay untouched.
      expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
      expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
      expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
      expect(ctx.txRepos.promos.releaseHoldsForOrder).not.toHaveBeenCalled();

      // Not paid out → no after-payout signal.
      expect(reportError).not.toHaveBeenCalled();

      expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "stripe_partial_refund_reconciled",
          entityId: ORDER_ID,
        }),
      );
    });

    it("nets the payees to exactly zero over sequential partials + full remainder, and replays are inert", async () => {
      const ctx = makeContext();
      await seedTwoPayees(ctx);
      const deps = { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency };

      // Partial #1: cumulative 3 000.
      await reconcileStripeFullRefund(deps, {
        paymentIntentId: "pi_123",
        amountRefundedCents: 3000,
        refundId: "re_1",
        sourceEventType: "charge.refund.updated",
        fullyRefundedHint: false,
      });

      // Partial #2: cumulative 5 000 (this refund was 2 000).
      await reconcileStripeFullRefund(deps, {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5000,
        refundId: "re_2",
        sourceEventType: "charge.refund.updated",
        fullyRefundedHint: false,
      });

      // Incremental math: targets at 5 000 are 1 591 (largest-remainder
      // cent lands on payee-1) and 1 045; minus priors 954 / 627.
      let totals = debitTotals(ctx);
      expect(totals.get("payee-1")).toBe(954 + 637);
      expect(totals.get("payee-2")).toBe(627 + 418);

      // Replay of partial #2 changes NOTHING: same key → same recompute →
      // repo dedupe; cumulative target minus priors is already covered.
      const entryCountBeforeReplay = ctx.payeeLedger.entries.length;
      await reconcileStripeFullRefund(deps, {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5000,
        refundId: "re_2",
        sourceEventType: "charge.refund.updated",
        fullyRefundedHint: false,
      });
      expect(ctx.payeeLedger.entries.length).toBe(entryCountBeforeReplay);
      expect(debitTotals(ctx)).toEqual(totals);

      // Full remainder: the terminal full-refund arm debits
      // `credit − Σ prior debits` per payee.
      const result = await reconcileStripeFullRefund(deps, {
        paymentIntentId: "pi_123",
        amountRefundedCents: 11000,
        refundId: "re_3",
        sourceEventType: "charge.refund.updated",
        fullyRefundedHint: true,
      });
      expect(result.outcome).toBe("reconciled_primary");

      totals = debitTotals(ctx);
      // Net zero to the cent: Σ debits === credit for every payee.
      expect(totals.get("payee-1")).toBe(3_500);
      expect(totals.get("payee-2")).toBe(2_300);
    });

    it("writes the debit AND reports a distinct signal when the order was already paid out — no reversal attempted", async () => {
      const paidOutOrder = makeOrder({
        paidOutAt: new Date("2026-04-10T00:00:00.000Z"),
        items: makeItems([
          { paidOutAt: new Date("2026-04-10T00:00:00.000Z") },
          { paidOutAt: new Date("2026-04-10T00:00:00.000Z") },
        ]),
      });
      const ctx = makeContext({ order: paidOutOrder, txOrder: paidOutOrder });
      const reportError = vi.fn();
      await seedTwoPayees(ctx);

      const result = await reconcileStripeFullRefund(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          reportError,
        },
        {
          paymentIntentId: "pi_123",
          amountRefundedCents: 3000,
          refundId: "re_p1",
          sourceEventType: "charge.refunded",
          fullyRefundedHint: false,
        },
      );

      expect(result.outcome).toBe("partial_refund_reconciled");

      // Debt-carry: the debit IS written (next payout recoups by
      // arithmetic) …
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(2);
      // … but NO automatic transfer reversal from this item-less path.
      expect(ctx.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT")).toEqual(
        [],
      );
      // Distinct operator signal.
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "external_partial_refund_after_payout",
        }),
        expect.objectContaining({
          tags: expect.objectContaining({ reason: "after_payout" }),
        }),
      );
    });

    it("retries a held mutex, then throws the greppable refund_mutex_conflict marker and writes NOTHING", async () => {
      const ctx = makeContext();
      const reportError = vi.fn();
      await seedTwoPayees(ctx);
      // Persistent conflict: every acquisition attempt loses.
      ctx.idempotencyMocks.begin.mockResolvedValue(false);

      // The error must PROPAGATE (webhook outer catch → DLQ) with the
      // distinct marker in its MESSAGE — DLQ rows store stage-prefixed
      // error strings, so this is what makes parked conflicts greppable.
      // A swallowed conflict would silently drop the debit forever.
      await expect(
        reconcileStripeFullRefund(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            idempotency: ctx.idempotency,
            reportError,
          },
          {
            paymentIntentId: "pi_123",
            amountRefundedCents: 3000,
            refundId: "re_p1",
            sourceEventType: "charge.refunded",
            fullyRefundedHint: false,
          },
        ),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
        message: expect.stringContaining("refund_mutex_conflict"),
      });

      // Bounded retry: 3 acquisition attempts (250ms/750ms backoff between).
      expect(ctx.idempotencyMocks.begin).toHaveBeenCalledTimes(3);
      expect(ctx.idempotencyMocks.begin).toHaveBeenCalledWith(
        `refund-op:${ORDER_ID}`,
        600,
        expect.any(String),
      );
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toEqual([]);
      expect(ctx.txRepos.audit.log).not.toHaveBeenCalled();
      // Reported exactly once, on exhaustion — not per attempt.
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: expect.objectContaining({
            reason: "refund_mutex_conflict_exhausted",
          }),
        }),
      );
    }, 15_000);

    it("self-heals a transient mutex conflict on the second attempt with zero DLQ traffic (full arm)", async () => {
      const ctx = makeContext();
      const reportError = vi.fn();
      await seedTwoPayees(ctx);
      // The common self-armed case: the internal refund's tx tail releases
      // the mutex before the first backoff elapses.
      ctx.idempotencyMocks.begin
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);

      const result = await reconcileStripeFullRefund(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          reportError,
        },
        {
          paymentIntentId: "pi_123",
          amountRefundedCents: 11000,
          sourceEventType: "charge.refunded",
          fullyRefundedHint: true,
        },
      );

      expect(result.outcome).toBe("reconciled_primary");
      expect(ctx.idempotencyMocks.begin).toHaveBeenCalledTimes(2);
      // In-process self-heal: no throw, no report, debits written.
      expect(reportError).not.toHaveBeenCalled();
      expect(
        ctx.payeeLedger.entriesOfType("REFUND_DEBIT").length,
      ).toBeGreaterThan(0);
    }, 15_000);

    it("a pre-change plain-refundId debit row makes a suffixed-key redelivery of the SAME refund a no-op (mixed-key migration)", async () => {
      const ctx = makeContext();
      await seedTwoPayees(ctx);

      // Rows written by the PREVIOUS deploy's key scheme (plain refund id —
      // e.g. the two rows the round-1 runtime verification left in the dev
      // DB): amounts are exactly what the old flow wrote for cumulative
      // 3 000 on this order.
      await ctx.payeeLedger.repo.refundDebit({
        idempotencyKey: `refund-debit:${ORDER_ID}:payee-1:re_old`,
        payeeId: "payee-1",
        amountCents: 954,
        currency: "usd",
        orderId: ORDER_ID,
        description: "old-format row",
        sourceKind: "order_refund",
        sourceId: "re_old",
      });
      await ctx.payeeLedger.repo.refundDebit({
        idempotencyKey: `refund-debit:${ORDER_ID}:payee-2:re_old`,
        payeeId: "payee-2",
        amountCents: 627,
        currency: "usd",
        orderId: ORDER_ID,
        description: "old-format row",
        sourceKind: "order_refund",
        sourceId: "re_old",
      });

      // Redelivery of the SAME refund under the NEW `{id}:{cumulative}`
      // scheme: different key string, but Σ-prior-debits is key-shape
      // agnostic, so the cumulative target is already covered.
      const result = await reconcileStripeFullRefund(
        { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
        {
          paymentIntentId: "pi_123",
          amountRefundedCents: 3000,
          refundId: "re_old",
          sourceEventType: "charge.refund.updated",
          fullyRefundedHint: false,
        },
      );

      expect(result.outcome).toBe("partial_refund_reconciled");
      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      // No new rows: the old-format rows fully cover the target.
      expect(debits).toHaveLength(2);
      expect(debits.map((d) => d.idempotencyKey).sort()).toEqual([
        `refund-debit:${ORDER_ID}:payee-1:re_old`,
        `refund-debit:${ORDER_ID}:payee-2:re_old`,
      ]);
    });

    it("a stale fetched refund id cannot key-replay away a later cumulative (amount-suffixed keys)", async () => {
      const ctx = makeContext();
      await seedTwoPayees(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
      };

      // Event #1 (cumulative 3 000) is processed LATE, after refund #2
      // already exists at Stripe — the best-effort refunds.list fetcher
      // hands back the WRONG id (re_2). Under plain-id keys this row would
      // then block event #2's recompute via key-replay.
      await reconcileStripeFullRefund(deps, {
        paymentIntentId: "pi_123",
        amountRefundedCents: 3000,
        refundId: "re_2",
        sourceEventType: "charge.refunded",
        fullyRefundedHint: false,
      });

      // Event #2: SAME refund id, larger cumulative → distinct key →
      // recompute (targets minus Σ ALL priors, key shape irrelevant), not
      // a replay of event #1's row.
      await reconcileStripeFullRefund(deps, {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5000,
        refundId: "re_2",
        sourceEventType: "charge.refund.updated",
        fullyRefundedHint: false,
      });

      const debits = ctx.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(4);
      expect(debits.map((d) => d.idempotencyKey).sort()).toEqual(
        [
          `refund-debit:${ORDER_ID}:payee-1:re_2:3000`,
          `refund-debit:${ORDER_ID}:payee-1:re_2:5000`,
          `refund-debit:${ORDER_ID}:payee-2:re_2:3000`,
          `refund-debit:${ORDER_ID}:payee-2:re_2:5000`,
        ].sort(),
      );
      // Σ per payee is correct to the cent for cumulative 5 000 — no
      // under-debit despite the stale id.
      const totals = debitTotals(ctx);
      expect(totals.get("payee-1")).toBe(954 + 637);
      expect(totals.get("payee-2")).toBe(627 + 418);
    });

    it("ignores a zero-amount partial event without reporting", async () => {
      const ctx = makeContext();
      const reportError = vi.fn();

      const result = await reconcileStripeFullRefund(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          reportError,
        },
        {
          paymentIntentId: "pi_123",
          amountRefundedCents: 0,
          refundId: "re_zero",
          sourceEventType: "charge.refund.updated",
          fullyRefundedHint: false,
        },
      );

      // No money moved → nothing to debit → silence is correct.
      expect(result.outcome).toBe("partial_refund_ignored");
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });
  });

  // ── Reserved seats ────────────────────────────────────────────────────────

  it("returns the seats of the tickets it voids (refund issued in the Stripe dashboard)", async () => {
    const SEAT_1 = "5ea70001-0000-4000-8000-000000000001";
    const SEAT_2 = "5ea70002-0000-4000-8000-000000000002";
    const ctx = makeContext({
      tickets: [
        { id: TICKET_1, status: "VALID", scannedAt: null, seatId: SEAT_1 },
        { id: TICKET_2, status: "SCANNED", scannedAt: NOW, seatId: SEAT_2 },
      ],
    });

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 11000,
        sourceEventType: "charge.refunded",
        fullyRefundedHint: true,
      },
    );

    expect(result.outcome).toBe("reconciled_primary");
    expect(ctx.txRepos.tickets.clearSeatAssignments).toHaveBeenCalledWith([
      TICKET_1,
      TICKET_2,
    ]);
    // SOLD seats, so the HELD-gated `releaseSeats` would no-op — this path
    // must use the unguarded write on ids it just voided in the same tx.
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_1, SEAT_2],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    expect(ctx.txRepos.seats.releaseSeats).not.toHaveBeenCalled();
  });

  it("touches no seat for a GA order", async () => {
    const ctx = makeContext();

    await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 11000,
        sourceEventType: "charge.refunded",
        fullyRefundedHint: true,
      },
    );

    expect(ctx.txRepos.seats.updateStatuses).not.toHaveBeenCalled();
  });
});

// ── Partial refunds that NAME their items (money audit 2026-09-08 #10) ──────
// An internal item refund whose local tx failed after Stripe accepted the
// refund leaves the DB believing item A is still `active`. The refund's
// metadata (stamped by refund-order-items / refund-full-order) says
// otherwise; the partial arm flips exactly those items so no later request
// under a different idempotency key can refund A again.
describe("reconcileStripeFullRefund — partial refund with item metadata", () => {
  function paymentsNaming(
    metadata: Record<string, string> | null,
    refund?: {
      status?: "succeeded" | "pending" | "failed" | "canceled";
      amountCents?: number;
      paymentIntentId?: string | null;
    },
  ) {
    return {
      getRefund: vi.fn(async ({ refundId }: { refundId: string }) => ({
        refundId,
        status: refund?.status ?? ("succeeded" as const),
        // Default: the whole order's buyer-paid total (2 × 5 500), so the
        // amount gate is not what a test is exercising unless it says so.
        amountCents: refund?.amountCents ?? 11_000,
        paymentIntentId:
          refund?.paymentIntentId === undefined ? "pi_123" : refund.paymentIntentId,
        metadata: metadata ?? {},
      })),
    };
  }

  /** The dirty harness has no `feeWaivers`; the REFUNDED branch releases it. */
  function withFeeWaivers(ctx: ReturnType<typeof makeContext>) {
    const release = vi.fn(async () => ({ releasedTickets: 0 }));
    (ctx.txRepos as unknown as { feeWaivers: unknown }).feeWaivers = { release };
    return release;
  }

  function namedA(useCase = "refundOrderItems") {
    return { useCase, orderId: ORDER_ID, orderItemIds: ITEM_A, orderItemCount: "1" };
  }

  function partialInput() {
    return {
      paymentIntentId: "pi_123",
      amountRefundedCents: 3000,
      refundId: "re_named_1",
      sourceEventType: "charge.refunded" as const,
      fullyRefundedHint: false,
    };
  }

  it("flips exactly the named item (3-arg updateStatus, tax attribution NULL), voids its ticket, leaves the sibling alone, and sets PART_REFUNDED", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    // A credit to debit against, so the (unchanged) ledger arm stays silent.
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 3_500,
      items: { [ITEM_A]: 1_750, [ITEM_B]: 1_750 },
    });
    const payments = paymentsNaming({
      useCase: "refundOrderItems",
      orderId: ORDER_ID,
      orderItemIds: ITEM_A,
      orderItemCount: "1",
    });

    const result = await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        payments,
        reportError,
      },
      partialInput(),
    );

    expect(result.outcome).toBe("partial_refund_reconciled");
    expect(payments.getRefund).toHaveBeenCalledWith({ refundId: "re_named_1" });

    // A flipped with NO tax attribution: the quote that computed the share
    // died with the failed tx, and a guessed share must not read as measured.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
    );
    expect(
      (ctx.txRepos.orderItems.updateStatus as ReturnType<typeof vi.fn>).mock
        .calls[0],
    ).toHaveLength(3);
    // A's ticket VALID → REFUNDED; B's ticket never looked up.
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(ctx.txRepos.tickets.getByOrderItemId).not.toHaveBeenCalledWith(
      ITEM_B,
    );
    // B still active → PART_REFUNDED (partial cents passed); the allowance
    // and promo holds come back only when the whole order is gone.
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      3000,
    );
    expect(ctx.txRepos.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    // The proportional ledger debit is unchanged by the flip:
    // floor(3000 × 3500 / 11000) = 954, same as the no-metadata case.
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toEqual([
      expect.objectContaining({ payeeId: "payee-1", amountCents: 954 }),
    ]);
    expect(reportError).not.toHaveBeenCalled();
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stripe_partial_refund_reconciled",
        data: expect.objectContaining({
          namedOrderItemIds: [ITEM_A],
          flippedOrderItemIds: [ITEM_A],
          newOrderStatus: "PART_REFUNDED",
        }),
      }),
    );
  });

  it("sets REFUNDED when the metadata names every ticket item (a fee-withholding full refund reads as partial to Stripe), releasing the fee waiver and promo holds", async () => {
    const ctx = makeContext();
    const feeWaiverRelease = withFeeWaivers(ctx);
    const payments = paymentsNaming({
      useCase: "refundFullOrder",
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_B].join(","),
      orderItemCount: "2",
    });

    await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency, payments },
      partialInput(),
    );

    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(2);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(ITEM_B, "refunded", NOW);
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID, undefined);
    expect(feeWaiverRelease).toHaveBeenCalledWith(ORDER_ID);
    expect(ctx.txRepos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(ORDER_ID);
  });

  // Owner ruling 2026-10-10: a refund of a scanned-in ticket means the person
  // left. The item-named arm voids tickets itself (not through
  // `markOrderTicketsRefunded`), so it records them itself.
  describe("leftOnRefund on the item-named arm's audit row", () => {
    const partialAuditData = (ctx: ReturnType<typeof makeContext>) => {
      const entry = (ctx.txRepos.audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[0] as { action: string; data: Record<string, unknown> })
        .find((e) => e.action === "stripe_partial_refund_reconciled");
      expect(entry).toBeDefined();
      return entry!.data;
    };
    /**
     * One ticket per item, and a `setStatus` that writes ON THE ROW THE READ
     * RETURNED: a list taken after the void then finds no SCANNED ticket.
     */
    function withTickets(
      ctx: ReturnType<typeof makeContext>,
      rows: Array<{ itemId: string; ticket: TicketRecord }>,
    ) {
      (ctx.txRepos.tickets.getByOrderItemId as ReturnType<typeof vi.fn>).mockImplementation(
        async (orderItemId: string) =>
          rows.find((r) => r.itemId === orderItemId)?.ticket ?? null,
      );
      (ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>).mockImplementation(
        async (id: string, status: TicketRecord["status"]) => {
          const row = rows.find((r) => r.ticket.id === id);
          if (row) {
            row.ticket.status = status;
            row.ticket.scannedAt = null;
          }
          return true;
        },
      );
    }
    const ticket = (
      id: string,
      orderItemId: string,
      status: TicketRecord["status"],
      scannedAt: Date | null,
    ) =>
      ({
        id,
        ownerHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId,
        status,
        scannedAt,
      }) as TicketRecord;
    const namingBoth = () =>
      paymentsNaming({
        useCase: "refundFullOrder",
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B].join(","),
        orderItemCount: "2",
      });

    it("lists exactly the scanned ticket with its admit time", async () => {
      const admittedAt = new Date("2026-04-19T23:41:07.000Z");
      const rows = [
        { itemId: ITEM_A, ticket: ticket(TICKET_1, ITEM_A, "SCANNED", admittedAt) },
        { itemId: ITEM_B, ticket: ticket(TICKET_2, ITEM_B, "VALID", null) },
      ];
      const ctx = makeContext();
      withFeeWaivers(ctx);
      withTickets(ctx, rows);

      const result = await reconcileStripeFullRefund(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          payments: namingBoth(),
        },
        partialInput(),
      );

      expect(result.outcome).toBe("partial_refund_reconciled");
      expect(rows.map((r) => r.ticket.status)).toEqual(["REFUNDED", "REFUNDED"]);
      expect(partialAuditData(ctx).leftOnRefund).toEqual([
        { ticketId: TICKET_1, admittedAt: "2026-04-19T23:41:07.000Z" },
      ]);
    });

    it("writes no leftOnRefund key when no refunded ticket had been scanned", async () => {
      const rows = [
        { itemId: ITEM_A, ticket: ticket(TICKET_1, ITEM_A, "VALID", null) },
        { itemId: ITEM_B, ticket: ticket(TICKET_2, ITEM_B, "VALID", null) },
      ];
      const ctx = makeContext();
      withFeeWaivers(ctx);
      withTickets(ctx, rows);

      await reconcileStripeFullRefund(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          payments: namingBoth(),
        },
        partialInput(),
      );

      expect(rows.map((r) => r.ticket.status)).toEqual(["REFUNDED", "REFUNDED"]);
      expect(partialAuditData(ctx)).not.toHaveProperty("leftOnRefund");
    });
  });

  it("a PENDING refund (async ACH / bank / Cash App) flips nothing: the money has not moved yet — ledger only, and NOT a Sentry event", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 3_500,
      items: { [ITEM_A]: 1_750, [ITEM_B]: 1_750 },
    });
    const payments = paymentsNaming(namedA(), { status: "pending" });

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency, payments, reportError },
      partialInput(),
    );

    expect(result.outcome).toBe("partial_refund_reconciled");
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    // In-flight is the HEALTHY shape of an async refund; `charge.refund.updated`
    // re-enters with this id once it succeeds. Reporting it would fire on
    // every working ACH refund.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a FAILED refund reaching a charge.refunded reconcile is an anomaly: flips nothing, ledger only, one report", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 3_500,
      items: { [ITEM_A]: 1_750, [ITEM_B]: 1_750 },
    });
    const payments = paymentsNaming(namedA(), { status: "failed" });

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency, payments, reportError },
      partialInput(),
    );

    expect(result.outcome).toBe("partial_refund_reconciled");
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "refund_metadata_not_succeeded" }),
        extra: expect.objectContaining({ refundId: "re_named_1", status: "failed" }),
      }),
    );
  });

  it("amount gate: the refund must cover the named items' buyer-paid total within max(10 %, 100¢) — 4 950 flips A (5 500 − 550), 4 949 is refused and reported", async () => {
    const ok = makeContext();
    await reconcileStripeFullRefund(
      {
        repos: ok.repos,
        clock: ok.clock,
        idempotency: ok.idempotency,
        payments: paymentsNaming(namedA(), { amountCents: 4_950 }),
      },
      partialInput(),
    );
    expect(ok.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(ITEM_A, "refunded", NOW);

    const short = makeContext();
    const reportError = vi.fn();
    await reconcileStripeFullRefund(
      {
        repos: short.repos,
        clock: short.clock,
        idempotency: short.idempotency,
        reportError,
        payments: paymentsNaming(namedA(), { amountCents: 4_949 }),
      },
      partialInput(),
    );
    expect(short.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(short.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    expect(short.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "refund_metadata_amount_mismatch" }),
        extra: expect.objectContaining({
          refundAmountCents: 4_949,
          namedBuyerPaidCents: 5_500,
          minimumCents: 4_950,
        }),
      }),
    );
  });

  it("a $1 dashboard refund naming every item cannot mark the order REFUNDED — and the gate still bites when cancelEvent names a gifted item", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming(
          { useCase: "refundFullOrder", orderId: ORDER_ID, orderItemIds: [ITEM_A, ITEM_B].join(","), orderItemCount: "2" },
          { amountCents: 100 },
        ),
      },
      { ...partialInput(), amountRefundedCents: 100 },
    );
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: "refund_metadata_amount_mismatch" }) }),
    );

    // The transferred item `cancelEvent` is allowed to flip is bounded by the
    // same gate, and its buyer-paid amount counts toward the named total like
    // any other item's (5 500 + 5 500 → minimum 9 900).
    const gifted = makeContext({
      order: makeOrder({
        items: makeItems([{ status: "transferred", transferredAt: NOW }]),
      }),
    });
    const giftedReport = vi.fn();
    await reconcileStripeFullRefund(
      {
        repos: gifted.repos,
        clock: gifted.clock,
        idempotency: gifted.idempotency,
        reportError: giftedReport,
        payments: paymentsNaming(
          { useCase: "cancelEvent", orderId: ORDER_ID, orderItemIds: [ITEM_A, ITEM_B].join(","), orderItemCount: "2" },
          { amountCents: 100 },
        ),
      },
      { ...partialInput(), amountRefundedCents: 100 },
    );
    expect(gifted.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(gifted.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    expect(gifted.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(giftedReport).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "refund_metadata_amount_mismatch" }),
        extra: expect.objectContaining({
          namedBuyerPaidCents: 11_000,
          minimumCents: 9_900,
        }),
      }),
    );
  });

  it("order-status predicate follows the stamping use case: with B transferred, refundFullOrder metadata naming A → REFUNDED, refundOrderItems metadata → PART_REFUNDED", async () => {
    const transferredB = () =>
      makeOrder({ items: makeItems([{}, { status: "transferred", transferredAt: NOW }]) });

    const full = makeContext({ order: transferredB() });
    const fullRelease = withFeeWaivers(full);
    await reconcileStripeFullRefund(
      {
        repos: full.repos,
        clock: full.clock,
        idempotency: full.idempotency,
        payments: paymentsNaming(namedA("refundFullOrder")),
      },
      partialInput(),
    );
    expect(full.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(full.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID, undefined);
    expect(fullRelease).toHaveBeenCalledWith(ORDER_ID);
    expect(full.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ newOrderStatus: "REFUNDED" }) }),
    );

    const items = makeContext({ order: transferredB() });
    await reconcileStripeFullRefund(
      {
        repos: items.repos,
        clock: items.clock,
        idempotency: items.idempotency,
        payments: paymentsNaming(namedA("refundOrderItems")),
      },
      partialInput(),
    );
    expect(items.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID, 3000);
    expect(items.txRepos.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
  });

  it("cancelEvent metadata reads transferred as terminal too: with B gifted, naming A → REFUNDED (a cancellation voids gifted passes on purpose)", async () => {
    const ctx = makeContext({
      order: makeOrder({
        items: makeItems([{}, { status: "transferred", transferredAt: NOW }]),
      }),
    });
    const release = withFeeWaivers(ctx);
    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        payments: paymentsNaming(namedA("cancelEvent")),
      },
      partialInput(),
    );
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID, undefined);
    expect(release).toHaveBeenCalledWith(ORDER_ID);
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ newOrderStatus: "REFUNDED" }) }),
    );
  });

  // ── The gifted item a cancellation refunded, whose marking tx then died ───
  // `cancelEvent` refunds a GIFTED item (transferred, no resale order behind
  // it) to whoever paid for it, and stamps its id into the refund metadata.
  // It is the only path that does, so it is the only one this arm admits a
  // transferred item for.
  const GIFT_SEAT = "5ea70009-0000-4000-8000-000000000009";

  /**
   * ITEM_A gifted away; its ticket still live, still holding its seat. A
   * credit is seeded so the (unchanged) ledger arm has something to debit and
   * stays silent — these tests assert on `reportError`.
   */
  async function giftedAContext() {
    const ctx = makeContext({
      order: makeOrder({
        items: makeItems([{ status: "transferred", transferredAt: NOW }]),
      }),
      txTicketByOrderItem: {
        id: TICKET_1,
        // The recipient of the gift, not the buyer who paid.
        ownerHumanId: SELLER_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "VALID",
        seatId: GIFT_SEAT,
      } as unknown as TicketRecord,
    });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 3_500,
      items: { [ITEM_A]: 1_750, [ITEM_B]: 1_750 },
    });
    return ctx;
  }

  it("heals a cancellation whose marking tx died: the gifted item cancelEvent NAMED flips, its live ticket is voided, and its seat comes back", async () => {
    const ctx = await giftedAContext();
    const reportError = vi.fn();

    const result = await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        // Net of the withheld Stripe fee: 5 500 − 550.
        payments: paymentsNaming(namedA("cancelEvent"), { amountCents: 4_950 }),
      },
      { ...partialInput(), amountRefundedCents: 4_950 },
    );

    expect(result.outcome).toBe("partial_refund_reconciled");
    // Tax attribution stays NULL — the quote that measured the share died
    // with the transaction, so the 3-arg form is deliberate.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
    );
    // The part that matters: a heal that flips the item and leaves the pass
    // VALID is still a live pass for a cancelled show.
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [GIFT_SEAT],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    // B is still active, so the order is not wholly gone.
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      4_950,
    );
    // Voiding a transferred item kills a THIRD PARTY's pass (the recipient
    // never bought it and never sees the refund), so this branch is not
    // allowed to be silent — it is what makes a forged metadata list an
    // alert rather than an invisible void.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "flipped_transferred_items" }),
        extra: expect.objectContaining({
          orderId: ORDER_ID,
          refundId: "re_named_1",
          metadataUseCase: "cancelEvent",
          flippedTransferredItemIds: [ITEM_A],
        }),
      }),
    );
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stripe_partial_refund_reconciled",
        data: expect.objectContaining({
          namedOrderItemIds: [ITEM_A],
          flippedOrderItemIds: [ITEM_A],
          flippedTransferredOrderItemIds: [ITEM_A],
          newOrderStatus: "PART_REFUNDED",
          releasedSeatIds: [GIFT_SEAT],
        }),
      }),
    );
  });

  it("a resale parent whose resale refund FAILED is left alone but still counts terminal: gift A flips, parent B is untouched, order → REFUNDED", async () => {
    // The case the `transferredIsTerminal` clause now uniquely governs. B is
    // transferred AND linked to a resale listing, so `cancelEvent` classified
    // it "keep" (its resale refund did not succeed), kept it out of
    // `refundableAmountsByItem`, and therefore never named it. The filter
    // above only admits transferred items the metadata NAMES, so B cannot be
    // flipped here — yet the order is still REFUNDED, matching cancelEvent's
    // own unconditional `markRefunded(orderId)`.
    const ctx = makeContext({
      order: makeOrder({
        items: makeItems([
          { status: "transferred", transferredAt: NOW },
          {
            status: "transferred",
            transferredAt: NOW,
            resaleListingId: RESALE_LISTING_ID,
          },
        ]),
      }),
      txTicketByOrderItem: {
        id: TICKET_1,
        ownerHumanId: SELLER_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "VALID",
        seatId: GIFT_SEAT,
      } as unknown as TicketRecord,
    });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 3_500,
      items: { [ITEM_A]: 1_750, [ITEM_B]: 1_750 },
    });
    const feeWaiverRelease = withFeeWaivers(ctx);

    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        payments: paymentsNaming(namedA("cancelEvent"), { amountCents: 4_950 }),
      },
      { ...partialInput(), amountRefundedCents: 4_950 },
    );

    // A — the gift — flips and its pass dies.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );

    // B — the resale parent — is not flipped, and its ticket is never even
    // looked up, so nothing of it can be voided or released. Only A's seat
    // comes back.
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalledWith(
      ITEM_B,
      expect.anything(),
      expect.anything(),
    );
    expect(ctx.txRepos.tickets.getByOrderItemId).not.toHaveBeenCalledWith(
      ITEM_B,
    );
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [GIFT_SEAT],
      status: "AVAILABLE",
      updatedAt: NOW,
    });

    // Terminal anyway: no partial amount, so REFUNDED.
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      undefined,
    );
    expect(feeWaiverRelease).toHaveBeenCalledWith(ORDER_ID);
    expect(ctx.txRepos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          flippedOrderItemIds: [ITEM_A],
          flippedTransferredOrderItemIds: [ITEM_A],
          newOrderStatus: "REFUNDED",
        }),
      }),
    );
  });

  it("the door opens for cancelEvent only: a dashboard partial with NO metadata leaves the gifted item alone", async () => {
    const ctx = await giftedAContext();
    const reportError = vi.fn();

    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming(null, { amountCents: 4_950 }),
      },
      { ...partialInput(), amountRefundedCents: 4_950 },
    );

    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.seats.updateStatuses).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("the door opens for cancelEvent only: refundFullOrder metadata naming a gifted item still skips it", async () => {
    const ctx = await giftedAContext();
    const reportError = vi.fn();

    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming(namedA("refundFullOrder")),
      },
      partialInput(),
    );

    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.seats.updateStatuses).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  // ── A LISTED pass named by a refund whose marking tx died ───────────────
  // The same unhealable-pass shape as the gifted case, one status over, and
  // it is NOT cancellation-only. `cancelEvent`'s selection has no listing
  // check — `selectRefundableTicketItems` skips only refunded items and
  // "keep"-classified transferred ones — so it names LISTED items outright.
  // But an ordinary refund reaches the same state by race:
  // `classifyRefundItem` refuses a listed item (`listing_active`), yet the
  // marking tx can die AFTER Stripe paid, leaving the item `active` and the
  // pass VALID — and `create-resale-listing` gates on TICKET status only, so
  // the buyer can then list it. Either way the item must be flipped: its
  // `refunded` status is the only thing `finalizeResalePurchase` can see.
  const LISTED_SEAT = "5ea70009-0000-4000-8000-00000000000a";

  /**
   * ITEM_A up for resale: item still `active` and still pointing at its
   * listing, ticket LISTED, seat still SOLD to it.
   *
   * The listing fake is STATEFUL and models the adapter's status-conditional
   * `cancel` (`updateMany where { id, sellerHumanId, status: "ACTIVE" }`), so
   * a HELD listing silently flips zero rows exactly as Postgres would — which
   * is what the confirm-after-cancel read exists to catch. `getByTicketId` is
   * attached HERE and not to the shared harness, so the missing-fake trap
   * below is real.
   */
  async function listedAContext(opts?: { listingStatus?: string }) {
    const ctx = makeContext({
      order: makeOrder({
        items: makeItems([{ resaleListingId: RESALE_LISTING_ID }]),
      }),
      txTicketByOrderItem: {
        id: TICKET_1,
        eventId: "event-1",
        ownerHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "LISTED",
        seatId: LISTED_SEAT,
      } as unknown as TicketRecord,
    });
    const listing = {
      id: RESALE_LISTING_ID,
      ticketId: TICKET_1,
      sellerHumanId: BUYER_ID,
      status: opts?.listingStatus ?? "ACTIVE",
    };
    const getByTicketId = vi.fn(async (ticketId: string) =>
      ticketId === TICKET_1 ? listing : null,
    );
    const cancel = vi.fn(async (listingId: string, sellerHumanId: string) => {
      // The adapter's CAS: ACTIVE only, and seller-scoped.
      if (
        listingId === listing.id &&
        sellerHumanId === listing.sellerHumanId &&
        listing.status === "ACTIVE"
      ) {
        listing.status = "CANCELLED";
      }
    });
    Object.assign(ctx.txRepos.resaleListings, {
      getByTicketId,
      cancel,
      getById: vi.fn(async (id: string) => (id === listing.id ? listing : null)),
    });
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 3_500,
      items: { [ITEM_A]: 1_750, [ITEM_B]: 1_750 },
    });
    return { ...ctx, listing, getByTicketId, cancel };
  }

  it("heals a cancellation whose marking tx died: the LISTED item flips, its ticket is VOIDED, its OWN listing is cancelled, the pointer is cleared, and its seat comes back", async () => {
    const ctx = await listedAContext();
    const reportError = vi.fn();

    const result = await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        // Net of the withheld Stripe fee: 5 500 − 550.
        payments: paymentsNaming(namedA("cancelEvent"), { amountCents: 4_950 }),
      },
      { ...partialInput(), amountRefundedCents: 4_950 },
    );

    expect(result.outcome).toBe("partial_refund_reconciled");
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
    );
    // The bug: the item flipped `refunded` while the ticket stayed LISTED —
    // a live pass under a live listing, and `expireStaleListings` would have
    // reset it to VALID and handed a refunded buyer a scannable ticket.
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );
    // The other half, and THIS listing only.
    expect(ctx.getByTicketId).toHaveBeenCalledWith(TICKET_1);
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
    expect(ctx.cancel).toHaveBeenCalledWith(RESALE_LISTING_ID, BUYER_ID);
    expect(ctx.listing.status).toBe("CANCELLED");
    expect(ctx.txRepos.orderItems.setResaleListingId).toHaveBeenCalledWith(
      ITEM_A,
      null,
    );
    // Ticket, then item, then listing: the lock order `commit`,
    // `releaseHold` and `expireStaleListings` take. Item before ticket was a
    // 40P01 cycle with the last two (pinned against real Postgres in
    // resale-listing-hold-link.integration.test.ts).
    const voidedAt = (ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>)
      .mock.invocationCallOrder[0]!;
    const flippedAt = (
      ctx.txRepos.orderItems.updateStatus as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0]!;
    expect(voidedAt).toBeLessThan(flippedAt);
    expect(flippedAt).toBeLessThan(ctx.cancel.mock.invocationCallOrder[0]!);
    // Seat back through the shared helper — no duplicate release.
    expect(ctx.txRepos.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [LISTED_SEAT],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    // B is still active, so the order is not wholly gone.
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      4_950,
    );
    // Killing a live listing off the back of a webhook is not allowed to be
    // silent — and there is nothing left unclosed, so exactly one report.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "flipped_listed_items" }),
        extra: expect.objectContaining({
          orderId: ORDER_ID,
          refundId: "re_named_1",
          metadataUseCase: "cancelEvent",
          flippedListedItemIds: [ITEM_A],
          cancelledListingIds: [RESALE_LISTING_ID],
        }),
      }),
    );
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stripe_partial_refund_reconciled",
        data: expect.objectContaining({
          namedOrderItemIds: [ITEM_A],
          flippedOrderItemIds: [ITEM_A],
          flippedListedOrderItemIds: [ITEM_A],
          cancelledResaleListingIds: [RESALE_LISTING_ID],
          newOrderStatus: "PART_REFUNDED",
          releasedSeatIds: [LISTED_SEAT],
        }),
      }),
    );
  });

  it("an ORDINARY refund naming a now-LISTED item heals it the same way: the flip is what stops the seller taking the refund AND the resale proceeds", async () => {
    // The inversion that matters. Refusing to stamp `refunded` here would
    // delete `finalizeResalePurchase`'s ONLY signal (it throws
    // `RESALE_ORIGINAL_ITEM_REFUNDED` on a refunded original item), so a
    // resale purchase would go through and pay the seller on top of the
    // refund they already have — silently. Flip, then close.
    const ctx = await listedAContext();
    const reportError = vi.fn();

    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming(namedA("refundFullOrder"), {
          amountCents: 4_950,
        }),
      },
      { ...partialInput(), amountRefundedCents: 4_950 },
    );

    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(ctx.cancel).toHaveBeenCalledWith(RESALE_LISTING_ID, BUYER_ID);
    expect(ctx.listing.status).toBe("CANCELLED");
    expect(ctx.txRepos.orderItems.setResaleListingId).toHaveBeenCalledWith(
      ITEM_A,
      null,
    );
    // The order is NOT left SUCCEEDED with a live item while Stripe has paid.
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      4_950,
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "flipped_listed_items" }),
      }),
    );
  });

  it("a HELD listing (resale checkout in flight) cannot be cancelled: the item still flips and the pass is still voided, and the stranded listing is reported", async () => {
    // `resaleListings.cancel` is ACTIVE-gated, so the CAS flips zero rows.
    // The trade is deliberate: a stranded PAID resale order is recoverable,
    // an executed double-pay is not — and the flip is what makes the resale
    // finalize abort into manual review instead of paying twice.
    const ctx = await listedAContext({ listingStatus: "HELD" });
    const reportError = vi.fn();

    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming(namedA("refundOrderItems"), {
          amountCents: 4_950,
        }),
      },
      { ...partialInput(), amountRefundedCents: 4_950 },
    );

    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );
    // Untouched: no CAS attempt on a HELD row, and no pointer clear that
    // would pretend the listing is gone.
    expect(ctx.cancel).not.toHaveBeenCalled();
    expect(ctx.listing.status).toBe("HELD");
    expect(ctx.txRepos.orderItems.setResaleListingId).not.toHaveBeenCalled();
    // Two facts, two reports: a live listing's pass was voided, AND the
    // listing is still open for somebody to settle.
    const reasons = reportError.mock.calls.map(
      (call) => (call[1] as { tags: { reason: string } }).tags.reason,
    );
    expect(reasons).toEqual([
      "flipped_listed_items",
      "listed_item_listing_not_closed",
    ]);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          reason: "listed_item_listing_not_closed",
        }),
        extra: expect.objectContaining({
          unclosedResaleListings: [
            {
              orderItemId: ITEM_A,
              listingId: RESALE_LISTING_ID,
              listingStatus: "HELD",
            },
          ],
        }),
      }),
    );
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          flippedListedOrderItemIds: [ITEM_A],
          cancelledResaleListingIds: undefined,
          unclosedResaleListings: [
            {
              orderItemId: ITEM_A,
              listingId: RESALE_LISTING_ID,
              listingStatus: "HELD",
            },
          ],
        }),
      }),
    );
  });

  it("the door still needs metadata: a dashboard partial naming nothing leaves the listed item, its pass and its listing alone", async () => {
    const ctx = await listedAContext();
    const reportError = vi.fn();

    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming(null, { amountCents: 4_950 }),
      },
      { ...partialInput(), amountRefundedCents: 4_950 },
    );

    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    expect(ctx.getByTicketId).not.toHaveBeenCalled();
    expect(ctx.cancel).not.toHaveBeenCalled();
    expect(ctx.listing.status).toBe("ACTIVE");
    expect(ctx.txRepos.seats.updateStatuses).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a mixed named set — one plain item and one LISTED item — flips both, closes only the listed one's listing, and the all-terminal rule closes the order", async () => {
    // Where `allTerminal` and the partial-amount `markRefunded` interact: A
    // (VALID) and B (LISTED) are the order's only ticket items, so naming
    // both leaves nothing live and the order goes REFUNDED with NO partial
    // amount — the fee-waiver allowance and promo holds come back.
    const ctx = makeContext({
      order: makeOrder({
        items: makeItems([{}, { resaleListingId: RESALE_LISTING_ID }]),
      }),
    });
    const feeWaiverRelease = withFeeWaivers(ctx);
    const ticketsByItem: Record<string, TicketRecord> = {
      [ITEM_A]: {
        id: TICKET_1,
        eventId: "event-1",
        ownerHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "VALID",
      } as unknown as TicketRecord,
      [ITEM_B]: {
        id: TICKET_2,
        eventId: "event-1",
        ownerHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_B,
        status: "LISTED",
        seatId: LISTED_SEAT,
      } as unknown as TicketRecord,
    };
    Object.assign(ctx.txRepos.tickets, {
      getByOrderItemId: vi.fn(
        async (orderItemId: string) => ticketsByItem[orderItemId] ?? null,
      ),
    });
    const listing = {
      id: RESALE_LISTING_ID,
      ticketId: TICKET_2,
      sellerHumanId: BUYER_ID,
      status: "ACTIVE",
    };
    const cancel = vi.fn(async () => {
      listing.status = "CANCELLED";
    });
    Object.assign(ctx.txRepos.resaleListings, {
      getByTicketId: vi.fn(async (ticketId: string) =>
        ticketId === TICKET_2 ? listing : null,
      ),
      cancel,
      getById: vi.fn(async () => listing),
    });
    const reportError = vi.fn();

    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming(
          {
            useCase: "cancelEvent",
            orderId: ORDER_ID,
            orderItemIds: [ITEM_A, ITEM_B].join(","),
            orderItemCount: "2",
          },
          { amountCents: 9_900 },
        ),
      },
      { ...partialInput(), amountRefundedCents: 9_900 },
    );

    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(2);
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_2,
      "REFUNDED",
      { scannedAt: null },
    );
    // Only the LISTED one has a listing to close.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(RESALE_LISTING_ID, BUYER_ID);
    // Whole order terminal → NO partial amount, allowance + holds released.
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(
      ORDER_ID,
      undefined,
    );
    expect(feeWaiverRelease).toHaveBeenCalledWith(ORDER_ID);
    expect(ctx.txRepos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          flippedOrderItemIds: [ITEM_A, ITEM_B],
          flippedListedOrderItemIds: [ITEM_B],
          cancelledResaleListingIds: [RESALE_LISTING_ID],
          newOrderStatus: "REFUNDED",
          releasedSeatIds: [LISTED_SEAT],
        }),
      }),
    );
  });

  it("amount gate on a DISCOUNTED order: the bound is the item's refundable BASIS, not its pre-discount buyer-paid figure", async () => {
    // A discount is a separate NEGATIVE line item, so `computeItemBuyerPaid`
    // is pre-discount: 2 × 5 500 sticker on a 9 000 charge. The old bound
    // (5 500 − 550 = 4 950) refused every legitimate refund of A here and
    // fired a FALSE `amount_mismatch`, so the heal never ran on a discounted
    // order. The basis is 9 000 / 2 = 4 500, bound 4 500 − 450 = 4 050.
    const ctx = makeContext({
      order: makeOrder({
        items: [
          ...makeItems([{ resaleListingId: RESALE_LISTING_ID }]),
          {
            ...makeItems()[0],
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            kind: "platform_credit",
            qty: 1,
            unitPriceCents: -2_000,
            amountCents: -2_000,
            meta: null,
          },
        ],
      }),
      txTicketByOrderItem: {
        id: TICKET_1,
        eventId: "event-1",
        ownerHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "LISTED",
        seatId: LISTED_SEAT,
      } as unknown as TicketRecord,
    });
    const listing = {
      id: RESALE_LISTING_ID,
      ticketId: TICKET_1,
      sellerHumanId: BUYER_ID,
      status: "ACTIVE",
    };
    Object.assign(ctx.txRepos.resaleListings, {
      getByTicketId: vi.fn(async () => listing),
      cancel: vi.fn(async () => {
        listing.status = "CANCELLED";
      }),
      getById: vi.fn(async () => listing),
    });
    // A credit to debit against, so the (unrelated) ledger arm stays silent
    // and the reason list below is purely this branch's.
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 3_500,
      items: { [ITEM_A]: 1_750, [ITEM_B]: 1_750 },
    });
    const reportError = vi.fn();

    // 4 100: BELOW the old pre-discount bound of 4 950, above the correct
    // basis bound of 4 050.
    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming(namedA("cancelEvent"), { amountCents: 4_100 }),
      },
      { ...partialInput(), amountRefundedCents: 4_100 },
    );

    // The heal runs instead of being refused.
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ITEM_A,
      "refunded",
      NOW,
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(listing.status).toBe("CANCELLED");
    // And no FALSE mismatch report — only the listed-void alert.
    const reasons = reportError.mock.calls.map(
      (call) => (call[1] as { tags: { reason: string } }).tags.reason,
    );
    expect(reasons).toEqual(["flipped_listed_items"]);
  });

  it("goes red when the tx bag has no resaleListings.getByTicketId (missing-fake trap)", async () => {
    // A fixture that forgets the listing close must FAIL, not void a pass and
    // leave the listing buyable.
    const ctx = await listedAContext();
    (
      ctx.txRepos.resaleListings as unknown as {
        getByTicketId?: unknown;
      }
    ).getByTicketId = undefined;

    await expect(
      reconcileStripeFullRefund(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          payments: paymentsNaming(namedA("cancelEvent"), {
            amountCents: 4_950,
          }),
        },
        { ...partialInput(), amountRefundedCents: 4_950 },
      ),
    ).rejects.toThrow();
  });

  it("a refund attached to ANOTHER PaymentIntent is refused (logged + reported), statuses untouched", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    const logger = makeLogger();
    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        logger,
        reportError,
        payments: paymentsNaming(namedA(), { paymentIntentId: "pi_other" }),
      },
      partialInput(),
    );
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: "refund_metadata_pi_mismatch" }) }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "reconcileStripeFullRefund.refund_metadata_pi_mismatch",
      expect.objectContaining({ refundId: "re_named_1", refundPaymentIntentId: "pi_other" }),
    );
  });

  it("ids the order does not have are reported and the known subset is still flipped", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming({
          useCase: "refundOrderItems",
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ORIGINAL_ORDER_ITEM_ID].sort().join(","),
          orderItemCount: "2",
        }),
      },
      partialInput(),
    );
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(ITEM_A, "refunded", NOW);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "refund_metadata_unknown_items" }),
        extra: expect.objectContaining({ unknownIds: [ORIGINAL_ORDER_ITEM_ID] }),
      }),
    );
  });

  it("a RESALE order is never flipped here (needs the listing unwind) — reported, ledger only", async () => {
    const ctx = makeContext({ order: makeOrder({ source: "RESALE" }) });
    const reportError = vi.fn();
    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming(namedA("reviewClaim")),
      },
      partialInput(),
    );
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: "refund_metadata_resale_order" }) }),
    );
  });

  it("an orderItemCount that disagrees with the id list is unusable", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        reportError,
        payments: paymentsNaming({ ...namedA(), orderItemCount: "3" }),
      },
      partialInput(),
    );
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "refund_metadata_unusable" }),
        extra: expect.objectContaining({ reason: "count_mismatch" }),
      }),
    );
  });

  it("a partial refund with NO metadata keeps today's behaviour: ledger only, statuses untouched", async () => {
    const ctx = makeContext();
    const payments = paymentsNaming(null);

    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency, payments },
      partialInput(),
    );

    expect(result.outcome).toBe("partial_refund_reconciled");
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
  });

  it("without a payments dep (webhook not yet wired) nothing is fetched and statuses stay untouched", async () => {
    const ctx = makeContext();

    await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      partialInput(),
    );

    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
  });

  it("a payments port WITHOUT getRefund (the not-configured / e2e stubs) is treated as no metadata", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();

    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        payments: {},
        reportError,
      },
      partialInput(),
    );

    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "refund_metadata_lookup_failed" }),
      }),
    );
  });

  it("replay is idempotent: an already-refunded named item is skipped and the order status is not rewritten", async () => {
    const order = makeOrder({
      status: "PART_REFUNDED",
      items: makeItems([{ status: "refunded", refundedAt: NOW }]),
    });
    const ctx = makeContext({ order });
    const payments = paymentsNaming({
      useCase: "refundOrderItems",
      orderId: ORDER_ID,
      orderItemIds: ITEM_A,
      orderItemCount: "1",
    });

    await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency, payments },
      partialInput(),
    );

    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalled();
    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
  });

  it("a Stripe read failure is reported and degrades to today's behaviour — the ledger debit still lands", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    await ctx.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-1",
      amountCents: 3_500,
      items: { [ITEM_A]: 1_750, [ITEM_B]: 1_750 },
    });
    const payments = {
      getRefund: vi.fn(async () => {
        throw new Error("stripe_down");
      }),
    };

    const result = await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        payments,
        reportError,
      },
      partialInput(),
    );

    expect(result.outcome).toBe("partial_refund_reconciled");
    expect(ctx.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "reconcileStripeFullRefund",
          step: "externalPartialRefund",
          reason: "refund_metadata_lookup_failed",
        }),
      }),
    );
  });

  it("metadata stamped for ANOTHER order is refused (reported), statuses untouched", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    const payments = paymentsNaming({
      useCase: "refundOrderItems",
      orderId: ORIGINAL_ORDER_ID,
      orderItemIds: ITEM_A,
      orderItemCount: "1",
    });

    await reconcileStripeFullRefund(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ctx.idempotency,
        payments,
        reportError,
      },
      partialInput(),
    );

    expect(ctx.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "refund_metadata_order_mismatch" }),
      }),
    );
  });

  it("reassembles a chunked id list and verifies its hash; a hash mismatch flips nothing", async () => {
    const { createHash } = await import("node:crypto");
    const sorted = [ITEM_A, ITEM_B].sort();
    const hash = createHash("sha256").update(sorted.join(",")).digest("hex");

    const good = makeContext();
    withFeeWaivers(good);
    await reconcileStripeFullRefund(
      {
        repos: good.repos,
        clock: good.clock,
        idempotency: good.idempotency,
        payments: paymentsNaming({
          useCase: "refundOrderItems",
          orderId: ORDER_ID,
          orderItemCount: "2",
          orderItemChunks: "2",
          orderItemIds: ITEM_A,
          orderItemIds2: ITEM_B,
          orderItemIdsHash: hash,
        }),
      },
      partialInput(),
    );
    expect(good.txRepos.orderItems.updateStatus).toHaveBeenCalledTimes(2);

    const bad = makeContext();
    const reportError = vi.fn();
    await reconcileStripeFullRefund(
      {
        repos: bad.repos,
        clock: bad.clock,
        idempotency: bad.idempotency,
        reportError,
        payments: paymentsNaming({
          useCase: "refundOrderItems",
          orderId: ORDER_ID,
          orderItemCount: "2",
          orderItemChunks: "2",
          // second chunk lost → reassembled list no longer matches the hash
          orderItemIds: ITEM_A,
          orderItemIdsHash: hash,
        }),
      },
      partialInput(),
    );
    expect(bad.txRepos.orderItems.updateStatus).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "refund_metadata_unusable" }),
      }),
    );
  });
});

// ── Claim refund notice (owner ruling 2026-10-07) ─────────────────────────────
// A reconcile that marks a RESALE order with an APPROVED claim REFUNDED tells
// the buyer their refund has gone through, once
// (resale/notify-claim-refunded.ts).

describe("reconcileStripeFullRefund — claim refund notice", () => {
  const CLAIM_ID = "77777777-7777-4777-8777-777777777777";
  const REFUNDED_VARIANT = "resale.claim-refunded";

  function resaleOrder(): OrderRecord {
    return makeOrder({
      source: "RESALE",
      parentOrderId: ORIGINAL_ORDER_ID,
      items: [
        {
          ...makeItems()[0]!,
          meta: {
            buyerTotalCents: 5500,
            resaleListingId: RESALE_LISTING_ID,
            resaleOriginalOrderId: ORIGINAL_ORDER_ID,
            resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
          },
          resaleListingId: RESALE_LISTING_ID,
        },
      ],
    });
  }

  function setup(
    opts: {
      order?: OrderRecord;
      claimStatus?: string | null;
      createThrows?: boolean;
      reporterThrows?: boolean;
    } = {},
  ) {
    const order = opts.order ?? resaleOrder();
    const ctx = makeContext({ order, txOrder: order });
    // The order's status follows the tx's markRefunded, so a redelivery
    // reads REFUNDED like it would from the database.
    let status: OrderRecord["status"] = order.status;
    ctx.txRepos.orders.markRefunded.mockImplementation(async () => {
      status = "REFUNDED";
    });
    vi.mocked(ctx.repos.orders.findByPaymentIntent).mockImplementation(
      async () => ({ id: order.id, status }) as never,
    );
    vi.mocked(ctx.repos.orders.getById).mockImplementation(
      async () => ({ ...order, status }) as OrderRecord,
    );

    const claimStatus =
      opts.claimStatus === undefined ? "approved" : opts.claimStatus;
    const getByOrderItemId = vi.fn(async () =>
      claimStatus === null
        ? null
        : {
            id: CLAIM_ID,
            status: claimStatus,
            claimantId: BUYER_ID,
            eventId: "event-1",
          },
    );
    const create = vi.fn(async (_input: { metadata?: { variant?: string } }) => {
      if (opts.createThrows) throw new Error("notifications down");
      return { id: "n-1", createdAt: NOW };
    });
    const send = vi.fn(async () => ({ result: { id: "m", status: "sent" } }));
    const reportError = vi.fn(() => {
      if (opts.reporterThrows) throw new Error("reporter down");
    });
    ctx.txRepos.claims.getByOrderItemId.mockImplementation(getByOrderItemId);
    Object.assign(ctx.repos as object, {
      claims: { getByOrderItemId },
      humans: {
        getByIdWithIdentity: vi.fn(async (id: string) => ({
          human: { id, name: "Buyer", locale: null },
          identity: { email: "buyer@example.com" },
        })),
      },
      events: {
        getById: vi.fn(async () => ({ id: "event-1", title: "Sunset Sessions" })),
      },
      notifications: { create },
    });
    // Real once-semantics: the claim notice's record and the refund mutex
    // both live here.
    const idempotency = createFakeIdempotencyPort();
    const deps = {
      repos: ctx.repos,
      clock: ctx.clock,
      idempotency,
      reportError,
      mailer: { send } as unknown as MailerPort,
      publicAppUrl: "https://ithas.fire",
    };
    const rows = () =>
      create.mock.calls.filter(
        ([input]) => input.metadata?.variant === REFUNDED_VARIANT,
      );
    return { ctx, deps, create, send, reportError, idempotency, rows, getByOrderItemId };
  }

  const chargeRefunded = {
    paymentIntentId: "pi_123",
    amountRefundedCents: 5500,
    sourceEventType: "charge.refunded" as const,
    fullyRefundedHint: true,
  };

  it("sends one notice with the amount Stripe refunded", async () => {
    const { deps, rows, send } = setup();

    const result = await reconcileStripeFullRefund(deps, chargeRefunded);

    expect(result.outcome).toBe("reconciled_resale");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]![0]).toMatchObject({
      humanId: BUYER_ID,
      title: "We've refunded you",
      body: "We refunded $55.00 for the Sunset Sessions resale ticket to the payment method you used. Your bank can take 5 to 10 business days to show it.",
      action: { href: `https://ithas.fire/my-tickets/${ORDER_ID}` },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a redelivery (and the charge.refund.updated twin) sends nothing more", async () => {
    const { deps, rows, send } = setup();

    await reconcileStripeFullRefund(deps, chargeRefunded);
    const again = await reconcileStripeFullRefund(deps, chargeRefunded);
    const twin = await reconcileStripeFullRefund(deps, {
      ...chargeRefunded,
      sourceEventType: "charge.refund.updated",
      refundId: "re_123",
    });

    expect(again.outcome).toBe("already_refunded");
    expect(twin.outcome).toBe("already_refunded");
    expect(rows()).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when review-claim already told the buyer (the race)", async () => {
    const { deps, rows, idempotency } = setup();
    await idempotency.commit(
      `resale-claim-refunded-notice:${CLAIM_ID}`,
      { sentAt: NOW.toISOString() },
      3600,
    );

    const result = await reconcileStripeFullRefund(deps, chargeRefunded);

    expect(result.outcome).toBe("reconciled_resale");
    expect(rows()).toHaveLength(0);
  });

  it("a primary (non-claim) refund gets no claim notice", async () => {
    const { deps, create, getByOrderItemId } = setup({ order: makeOrder() });

    const result = await reconcileStripeFullRefund(deps, {
      ...chargeRefunded,
      amountRefundedCents: 11000,
    });

    expect(result.outcome).toBe("reconciled_primary");
    expect(getByOrderItemId).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["no claim", null],
    ["an open claim", "open"],
    ["a denied claim", "denied"],
  ])("a resale refund with %s gets no claim notice", async (_name, claimStatus) => {
    const { deps, create, send } = setup({ claimStatus });

    const result = await reconcileStripeFullRefund(deps, chargeRefunded);

    expect(result.outcome).toBe("reconciled_resale");
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing when the mailer or app URL is not wired", async () => {
    const { deps, create } = setup();

    const result = await reconcileStripeFullRefund(
      { ...deps, mailer: null },
      chargeRefunded,
    );

    expect(result.outcome).toBe("reconciled_resale");
    expect(create).not.toHaveBeenCalled();
  });

  it("a throwing notifier and reporter never fail the reconcile (no DLQ)", async () => {
    const { deps, ctx, reportError } = setup({
      createThrows: true,
      reporterThrows: true,
    });

    const result = await reconcileStripeFullRefund(deps, chargeRefunded);

    expect(result.outcome).toBe("reconciled_resale");
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "resale.notifyClaimRefunded", reason: "failed" },
      }),
    );
  });

  it("uses the reconciled refund's own amount when the event names it", async () => {
    // An earlier refund already returned $20.00 of the $55.00 charge; the
    // cumulative on the charge is $55.00, the claim's refund itself $35.00.
    const { deps, rows } = setup();
    const getRefund = vi.fn(async () => ({
      refundId: "re_claim",
      status: "succeeded" as const,
      amountCents: 3500,
      paymentIntentId: "pi_123",
      metadata: { useCase: "reviewClaim", orderId: ORDER_ID },
    }));

    await reconcileStripeFullRefund(
      { ...deps, payments: { getRefund } },
      {
        ...chargeRefunded,
        sourceEventType: "charge.refund.updated",
        refundId: "re_claim",
      },
    );

    expect(getRefund).toHaveBeenCalledWith({ refundId: "re_claim" });
    expect(rows()[0]![0]).toMatchObject({
      body: expect.stringContaining("We refunded $35.00 for"),
    });
  });
});

// ── An approved claim's ticket is never put back on sale ────────────────────
// The webhook finishes a claim refund that Stripe left pending (or wins the
// race into review-claim's tx). Staff ruled the ticket bad, so the listing is
// CANCELLED, as review-claim's own success tx does, not restored to ACTIVE.

describe("reconcileStripeFullRefund — RESALE unwind honours an approved claim", () => {
  function resaleOrder(): OrderRecord {
    return makeOrder({
      source: "RESALE",
      parentOrderId: ORIGINAL_ORDER_ID,
      items: [
        {
          ...makeItems()[0]!,
          meta: {
            buyerTotalCents: 5500,
            resaleListingId: RESALE_LISTING_ID,
            resaleOriginalOrderId: ORIGINAL_ORDER_ID,
            resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
          },
          resaleListingId: RESALE_LISTING_ID,
        },
      ],
    });
  }

  async function run(claimStatus: string | null) {
    const order = resaleOrder();
    // A live listing well before any sale cutoff: without a claim it would
    // go straight back to ACTIVE.
    const ctx = makeContext({ order, txOrder: order });
    ctx.txRepos.claims.getByOrderItemId.mockImplementation(async () =>
      claimStatus === null
        ? null
        : { id: "claim-1", status: claimStatus, orderItemId: ITEM_A },
    );
    const result = await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 5500,
        sourceEventType: "charge.refunded",
        fullyRefundedHint: true,
      },
    );
    return { ctx, result };
  }

  it("an approved claim cancels the listing and never relists the ticket", async () => {
    const { ctx, result } = await run("approved");

    expect(result.outcome).toBe("reconciled_resale");
    expect(ctx.txRepos.claims.getByOrderItemId).toHaveBeenCalledWith(ITEM_A);
    expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
      RESALE_LISTING_ID,
      ORDER_ID,
      "CANCELLED",
    );
    // No relist in any call shape.
    expect(
      (ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[1],
      ),
    ).not.toContain("LISTED");
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stripe_refund_reconciled",
        data: expect.objectContaining({ listingDisposition: "cancel" }),
      }),
    );
  });

  it.each([
    ["no claim", null],
    ["an open claim", "open"],
    ["a denied claim", "denied"],
  ])("with %s the listing is restored to ACTIVE as before", async (_n, status) => {
    const { ctx } = await run(status);

    expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
      RESALE_LISTING_ID,
      ORDER_ID,
      "ACTIVE",
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "LISTED",
      { expectedStatus: "VALID" },
    );
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stripe_refund_reconciled",
        data: expect.objectContaining({ listingDisposition: "restore_active" }),
      }),
    );
  });

  it("a PRIMARY order never reads claims", async () => {
    const ctx = makeContext();
    await reconcileStripeFullRefund(
      { repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency },
      {
        paymentIntentId: "pi_123",
        amountRefundedCents: 11000,
        sourceEventType: "charge.refunded",
        fullyRefundedHint: true,
      },
    );
    expect(ctx.txRepos.claims.getByOrderItemId).not.toHaveBeenCalled();
  });
});
