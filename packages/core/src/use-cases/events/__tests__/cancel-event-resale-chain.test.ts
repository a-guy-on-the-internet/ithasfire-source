/**
 * Cancelling an event whose tickets changed hands on resale more than once
 * (owner ruling 2026-10-11: a ticket can be resold any number of times).
 *
 * The rule under test is the one-hop rule applied to every hop, last buyer
 * first: a resale buyer is refunded on their own order, the seller's
 * proceeds are unwound, and the item the ticket was bought from is refunded
 * only once that refund succeeded. A hop that is not refunded stops every
 * hop before it, before their money moves.
 *
 * The repos here are a small in-memory world, not call-recording mocks: the
 * real `assertResaleOrderCanBeUnwound` and `unwindResaleOrderAfterRefund`
 * run against it, so "the ticket is back on B's item when B's unwind looks"
 * is observed, not assumed. Lock order and the ledger's keys on a real
 * database are proven in
 * `packages/adapters/test/integration/cancel-event-resale-chain.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderItemRecord, OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";

const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const ACTOR_ID = "20000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-10-12T12:00:00.000Z");

type TicketRow = {
  id: string;
  ownerHumanId: string;
  orderId: string;
  orderItemId: string | null;
  status: string;
  scannedAt: Date | null;
};
type ListingRow = {
  id: string;
  ticketId: string;
  sellerHumanId: string;
  status: string;
  buyerOrderId: string | null;
  expiresAt: Date | null;
  saleCutoffAt: Date | null;
};

function makeItem(
  id: string,
  orderId: string,
  paidCents: number,
  overrides: Partial<OrderItemRecord> = {},
): OrderItemRecord {
  return {
    id,
    orderId,
    kind: "ticket",
    ticketTypeId: "tt-1",
    qty: 1,
    unitPriceCents: paidCents,
    amountCents: paidCents,
    meta: { buyerTotalCents: paidCents },
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
    ...overrides,
  } as OrderItemRecord;
}

function makeOrder(
  id: string,
  buyerHumanId: string,
  source: "PRIMARY" | "RESALE",
  items: OrderItemRecord[],
  overrides: Partial<OrderRecord> = {},
): OrderRecord {
  const gross = items.reduce((sum, item) => sum + item.amountCents, 0);
  return {
    id,
    eventId: EVENT_ID,
    buyerHumanId,
    amountGrossCents: gross,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: `pi_${id}`,
    source,
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    items,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    ...overrides,
  } as OrderRecord;
}

/**
 * The world a cancellation runs in. `addChain` writes what the sales
 * themselves leave behind: the first person buys from the organizer, each
 * later person buys the previous one's listing.
 */
function createWorld() {
  const orders = new Map<string, OrderRecord>();
  const tickets = new Map<string, TicketRow>();
  const listings = new Map<string, ListingRow>();
  const ledger = createFakePayeeLedgerRepo();
  /** PaymentIntent id → the charge's processing fee. */
  const stripeFees = new Map<string, number>();
  /** PaymentIntents whose refund the processor declines. */
  const declined = new Set<string>();
  /** The order `listAll` hands the event's orders back in. */
  let listOrder: string[] | null = null;

  const itemById = (itemId: string) => {
    for (const order of orders.values()) {
      const item = order.items.find((candidate) => candidate.id === itemId);
      if (item) return item;
    }
    return null;
  };

  /**
   * One ticket sold `paid.length - 1` times on resale. `paid[0]` is what the
   * first buyer paid the organizer; `paid[n]` what buyer n paid buyer n-1.
   * Ids are `<name>-O<n>` (order), `<name>-i<n>` (item), `<name>-L<n>` (the
   * listing order n was bought through), `<name>-H<n>` (the human).
   */
  async function addChain(
    name: string,
    paid: number[],
    options: {
      /** Leave `resaleOriginalOrderItemId` off this hop's item (hop index). */
      unlinkedHop?: number;
      /** Put the ticket's first item on an existing primary order. */
      onPrimaryOrder?: OrderRecord;
    } = {},
  ) {
    const human = (n: number) => `${name}-H${n}`;
    const orderId = (n: number) =>
      n === 0 && options.onPrimaryOrder
        ? options.onPrimaryOrder.id
        : `${name}-O${n}`;
    const itemId = (n: number) => `${name}-i${n}`;
    const last = paid.length - 1;

    for (let n = 0; n <= last; n += 1) {
      const sold = n < last;
      const item = makeItem(itemId(n), orderId(n), paid[n]!, {
        status: sold ? "transferred" : "active",
        transferredAt: sold ? NOW : null,
        ...(n > 0
          ? {
              resaleListingId: `${name}-L${n}`,
              meta: {
                buyerTotalCents: paid[n]!,
                resaleListingId: `${name}-L${n}`,
                resaleOriginalOrderId: orderId(n - 1),
                ...(options.unlinkedHop === n
                  ? {}
                  : { resaleOriginalOrderItemId: itemId(n - 1) }),
              },
            }
          : {}),
      });
      if (n === 0 && options.onPrimaryOrder) {
        const primary = options.onPrimaryOrder;
        primary.items.push(item);
        primary.amountGrossCents += item.amountCents;
      } else {
        orders.set(
          orderId(n),
          makeOrder(orderId(n), human(n), n === 0 ? "PRIMARY" : "RESALE", [item], {
            parentOrderId: n === 0 ? null : orderId(n - 1),
          }),
        );
      }
      if (n > 0) {
        listings.set(`${name}-L${n}`, {
          id: `${name}-L${n}`,
          ticketId: `${name}-T`,
          sellerHumanId: human(n - 1),
          status: "SOLD",
          buyerOrderId: orderId(n),
          expiresAt: null,
          saleCutoffAt: null,
        });
      }
      // Whoever was paid for sale n: the organizer for the first, the
      // previous holder after that. One payee per sale keeps the debits
      // readable by name.
      await ledger.seedCredit({
        orderId: orderId(n),
        payeeId: n === 0 ? `${name}-organizer` : `payee-${human(n - 1)}`,
        amountCents: paid[n]!,
        items: { [itemId(n)]: paid[n]! },
        idempotencyKey: `seed:${name}:${n}`,
      });
    }
    tickets.set(`${name}-T`, {
      id: `${name}-T`,
      ownerHumanId: human(last),
      orderId: orderId(last),
      orderItemId: itemId(last),
      status: "VALID",
      scannedAt: null,
    });
    return { orderId, itemId, human, ticketId: `${name}-T` };
  }

  const txRepos = {
    events: {
      getById: vi.fn(async () => event),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => {
        event.status = "CANCELLED";
        return event;
      }),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "OWNER" as const,
      })),
    },
    orders: {
      listTaxLinesByOrderIds: vi.fn(async () => new Map()),
      listAll: vi.fn(async ({ statuses }: { statuses?: string[] }) => {
        const ids = listOrder ?? [...orders.keys()];
        const items = ids
          .map((id) => orders.get(id)!)
          .filter((order) => !statuses || statuses.includes(order.status));
        return { items: structuredClone(items), total: items.length };
      }),
      // A copy, as a database read is: what the caller holds does not change
      // under it when a later write lands.
      getById: vi.fn(async (orderId: string) => {
        const order = orders.get(orderId);
        return order ? structuredClone(order) : null;
      }),
      markRefunded: vi.fn(async (orderId: string) => {
        orders.get(orderId)!.status = "REFUNDED";
      }),
      listSucceededCashOrderIdsForEvent: vi.fn(async () => []),
    },
    orderItems: {
      getById: vi.fn(async (itemId: string) => {
        const item = itemById(itemId);
        return item ? structuredClone(item) : null;
      }),
      listByOrderId: vi.fn(async (orderId: string) =>
        structuredClone(orders.get(orderId)?.items ?? []),
      ),
      // What the adapter writes for each status.
      updateStatus: vi.fn(async (itemId: string, status: string, at: Date) => {
        const item = itemById(itemId)!;
        item.status = status as OrderItemRecord["status"];
        item.refundedAt = status === "refunded" ? at : null;
        item.transferredAt =
          status === "transferred"
            ? at
            : status === "refunded"
              ? item.transferredAt
              : null;
        return true;
      }),
      setResaleListingId: vi.fn(
        async (itemId: string, listingId: string | null) => {
          itemById(itemId)!.resaleListingId = listingId;
        },
      ),
    },
    tickets: {
      getById: vi.fn(async (id: string) => {
        const ticket = tickets.get(id);
        return ticket ? { ...ticket } : null;
      }),
      getByIdForUpdate: vi.fn(async (id: string) => {
        const ticket = tickets.get(id);
        return ticket ? { ...ticket } : null;
      }),
      getByOrderItemId: vi.fn(async (itemId: string) => {
        const ticket = [...tickets.values()].find(
          (candidate) => candidate.orderItemId === itemId,
        );
        return ticket ? { ...ticket } : null;
      }),
      listByOrderId: vi.fn(async (orderId: string) =>
        [...tickets.values()]
          .filter((ticket) => ticket.orderId === orderId)
          .map((ticket) => ({ ...ticket })),
      ),
      setStatus: vi.fn(
        async (
          id: string,
          status: string,
          opts?: { expectedStatus?: string },
        ) => {
          const ticket = tickets.get(id)!;
          if (opts?.expectedStatus && ticket.status !== opts.expectedStatus) {
            return false;
          }
          ticket.status = status;
          return true;
        },
      ),
      transfer: vi.fn(
        async (input: {
          ticketId: string;
          fromHumanId: string;
          toHumanId: string;
        }) => {
          const ticket = tickets.get(input.ticketId)!;
          if (ticket.ownerHumanId !== input.fromHumanId) return false;
          ticket.ownerHumanId = input.toHumanId;
          return true;
        },
      ),
      restoreAfterResale: vi.fn(
        async (input: {
          ticketId: string;
          restoredOrderId: string | null;
          restoredOrderItemId: string | null;
        }) => {
          const ticket = tickets.get(input.ticketId)!;
          if (input.restoredOrderId) ticket.orderId = input.restoredOrderId;
          ticket.orderItemId = input.restoredOrderItemId;
          ticket.status = "VALID";
          ticket.scannedAt = null;
        },
      ),
    },
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
      getById: vi.fn(async (id: string) => {
        const listing = listings.get(id);
        return listing ? { ...listing } : null;
      }),
      getByTicketId: vi.fn(async (ticketId: string) => {
        const live = [...listings.values()].find(
          (listing) =>
            listing.ticketId === ticketId &&
            (listing.status === "ACTIVE" || listing.status === "HELD"),
        );
        return live ? { ...live } : null;
      }),
      unwindSale: vi.fn(
        async (listingId: string, _orderId: string, status: string) => {
          const listing = listings.get(listingId)!;
          listing.status = status;
          listing.buyerOrderId = null;
        },
      ),
    },
    payeeLedger: ledger.repo,
    // The refund writer checks the checkout's split rows against the
    // ledger's credits; this world keeps none.
    splits: { getForOrder: vi.fn(async () => []) },
    images: {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    audioUploads: {
      listByEventIdIncludingDeleted: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
    eventChangeNotices: { create: vi.fn(async () => undefined) },
    audit: { log: vi.fn(async (_row: unknown) => undefined) },
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  };

  const event = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Resale Chain Event",
    slug: "resale-chain-event",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as unknown as TxRepos),
    ),
  } as unknown as Repos;

  const refunds: Array<{ orderId: string; amountCents: number }> = [];
  const refundPaymentIntent = vi.fn(
    async (input: { paymentIntentId: string; amountCents: number }) => {
      if (declined.has(input.paymentIntentId)) {
        throw new Error("stripe_refund_declined");
      }
      refunds.push({
        orderId: input.paymentIntentId.replace(/^pi_/, ""),
        amountCents: input.amountCents,
      });
      return {
        refundId: `re_${input.paymentIntentId}`,
        status: "succeeded" as const,
      };
    },
  );
  const reportError = vi.fn();
  const idempotency = createFakeIdempotencyPort();

  const deps: CancelEventDeps = {
    repos,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    payments: {
      refundPaymentIntent,
      getProcessingFeeForPaymentIntent: vi.fn(
        async ({ paymentIntentId }: { paymentIntentId: string }) => ({
          feeCents: stripeFees.get(paymentIntentId) ?? 0,
        }),
      ),
    } as unknown as CancelEventDeps["payments"],
    idempotency,
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
    reportError,
  };

  return {
    deps,
    orders,
    tickets,
    listings,
    ledger,
    stripeFees,
    declined,
    reportError,
    txRepos,
    addChain,
    setListOrder: (ids: string[]) => {
      listOrder = ids;
    },
    cancel: (clientKey = "cancel-chain-key-1") =>
      cancelEvent(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        clientKey,
      }),
    /** Order ids whose Stripe refund went through, in the order sent. */
    refundedOrderIds: () => refunds.map((refund) => refund.orderId),
    refundedCents: (orderId: string) =>
      refunds
        .filter((refund) => refund.orderId === orderId)
        .reduce((sum, refund) => sum + refund.amountCents, 0),
    /** REFUND_DEBIT cents by payee, and how many rows wrote them. */
    debits: () => {
      const rows = ledger.entriesOfType("REFUND_DEBIT");
      const byPayee: Record<string, number> = {};
      for (const row of rows) {
        byPayee[row.payeeId] = (byPayee[row.payeeId] ?? 0) + row.amountCents;
      }
      return { byPayee, rows: rows.length };
    },
    statusOf: (orderId: string) => orders.get(orderId)!.status,
    itemStatusOf: (itemId: string) => itemById(itemId)!.status,
    cancelledAudit: () => {
      const row = txRepos.audit.log.mock.calls
        .map(([entry]) => entry as { action: string; data: Record<string, unknown> })
        .find((entry) => entry.action === "cancelled");
      return row?.data;
    },
    /** Messages this run reported, minus nothing: every report is listed. */
    reported: () =>
      reportError.mock.calls.map(([err]) => (err as Error)?.message),
    /** Each report's tags and extra, in the order they were sent. */
    reports: () =>
      reportError.mock.calls.map(
        ([, context]) =>
          context as {
            tags: Record<string, string>;
            extra: Record<string, unknown>;
          },
      ),
  };
}

describe("cancelEvent over a resale chain", () => {
  it("A → B → C: refunds C, then B, then A, debits each seller once and voids the ticket on A's order", async () => {
    const world = createWorld();
    const chain = await world.addChain("x", [2500, 3000, 4000]);
    world.stripeFees.set("pi_x-O0", 103);
    world.stripeFees.set("pi_x-O1", 117);
    world.stripeFees.set("pi_x-O2", 146);

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 3, failedRefundCount: 0 });
    expect(world.refundedOrderIds()).toEqual(["x-O2", "x-O1", "x-O0"]);
    // Each buyer: what they paid less that charge's processing fee.
    expect(world.refundedCents("x-O2")).toBe(4000 - 146);
    expect(world.refundedCents("x-O1")).toBe(3000 - 117);
    expect(world.refundedCents("x-O0")).toBe(2500 - 103);
    // Each seller gives back what that sale credited them, in one row.
    expect(world.debits()).toEqual({
      byPayee: { "payee-x-H1": 4000, "payee-x-H0": 3000, "x-organizer": 2500 },
      rows: 3,
    });
    expect(
      [0, 1, 2].map((n) => [
        world.statusOf(chain.orderId(n)),
        world.itemStatusOf(chain.itemId(n)),
      ]),
    ).toEqual([
      ["REFUNDED", "refunded"],
      ["REFUNDED", "refunded"],
      ["REFUNDED", "refunded"],
    ]);
    // The ticket walked back to A and died with A's order.
    expect(world.tickets.get(chain.ticketId)).toMatchObject({
      ownerHumanId: "x-H0",
      orderId: "x-O0",
      orderItemId: "x-i0",
      status: "REFUNDED",
    });
    // Both sales closed, neither put back on sale.
    expect(world.listings.get("x-L1")!.status).toBe("CANCELLED");
    expect(world.listings.get("x-L2")!.status).toBe("CANCELLED");
    // B's purchase was not refunded yet when C's unwind handed B the
    // ticket, so nothing is reported as "returned to a refunded buyer".
    expect(world.reported()).toEqual([]);
    expect(world.cancelledAudit()).toMatchObject({
      failedOrderIds: [],
      failedRefundReasons: [],
    });
  });

  it("A → B → C → D: three hops unwind in order", async () => {
    const world = createWorld();
    const chain = await world.addChain("x", [2000, 2500, 3000, 3500]);

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 4, failedRefundCount: 0 });
    expect(world.refundedOrderIds()).toEqual(["x-O3", "x-O2", "x-O1", "x-O0"]);
    expect(world.debits()).toEqual({
      byPayee: {
        "payee-x-H2": 3500,
        "payee-x-H1": 3000,
        "payee-x-H0": 2500,
        "x-organizer": 2000,
      },
      rows: 4,
    });
    expect(world.tickets.get(chain.ticketId)).toMatchObject({
      ownerHumanId: "x-H0",
      orderItemId: "x-i0",
      status: "REFUNDED",
    });
    expect(world.reported()).toEqual([]);
  });

  it("refunds last buyer first whatever order the orders are listed in", async () => {
    const permutations = [
      ["x-O0", "x-O1", "x-O2", "x-O3"],
      ["x-O3", "x-O2", "x-O1", "x-O0"],
      ["x-O1", "x-O3", "x-O0", "x-O2"],
      ["x-O2", "x-O0", "x-O3", "x-O1"],
      ["x-O1", "x-O2", "x-O3", "x-O0"],
    ];
    for (const listOrder of permutations) {
      const world = createWorld();
      await world.addChain("x", [2000, 2500, 3000, 3500]);
      world.setListOrder(listOrder);

      const result = await world.cancel();

      expect(result, listOrder.join(",")).toMatchObject({
        refundedOrderCount: 4,
        failedRefundCount: 0,
      });
      expect(world.refundedOrderIds(), listOrder.join(",")).toEqual([
        "x-O3",
        "x-O2",
        "x-O1",
        "x-O0",
      ]);
      expect(world.tickets.get("x-T")!.status).toBe("REFUNDED");
      expect(world.reported()).toEqual([]);
    }
  });

  it("the last buyer's refund fails: no earlier hop is refunded, each says why, and A's item stays transferred", async () => {
    const world = createWorld();
    const chain = await world.addChain("x", [2000, 2500, 3000, 3500]);
    world.declined.add("pi_x-O3");

    const result = await world.cancel();

    // D failed at the processor; C and B are refused because of it. A's
    // order has nothing refundable and is skipped, as with one hop.
    expect(result).toMatchObject({ refundedOrderCount: 0, failedRefundCount: 3 });
    expect(world.refundedCents("x-O2")).toBe(0);
    expect(world.refundedCents("x-O1")).toBe(0);
    expect(world.refundedCents("x-O0")).toBe(0);
    expect(world.debits()).toEqual({ byPayee: {}, rows: 0 });
    expect(world.cancelledAudit()).toMatchObject({
      failedOrderIds: ["x-O3", "x-O2", "x-O1"],
      failedRefundReasons: [
        { orderId: "x-O2", reason: "later_resale_not_refunded" },
        { orderId: "x-O1", reason: "later_resale_not_refunded" },
      ],
    });
    expect(
      [0, 1, 2, 3].map((n) => [
        world.statusOf(chain.orderId(n)),
        world.itemStatusOf(chain.itemId(n)),
      ]),
    ).toEqual([
      ["SUCCEEDED", "transferred"],
      ["SUCCEEDED", "transferred"],
      ["SUCCEEDED", "transferred"],
      ["SUCCEEDED", "active"],
    ]);
    // D still holds the ticket; nothing was unwound.
    expect(world.tickets.get(chain.ticketId)).toMatchObject({
      ownerHumanId: "x-H3",
      orderItemId: "x-i3",
      status: "VALID",
    });
    expect(world.txRepos.tickets.transfer).not.toHaveBeenCalled();
    // Nothing retries the two refused orders, so each is reported.
    expect(
      world
        .reports()
        .filter((report) => report.tags.stage === "resale_unwind_precheck"),
    ).toEqual([
      {
        tags: {
          useCase: "cancelEvent",
          stage: "resale_unwind_precheck",
          reason: "later_resale_not_refunded",
        },
        extra: { orderId: "x-O2", parentOrderId: "x-O1", eventId: EVENT_ID },
      },
      {
        tags: {
          useCase: "cancelEvent",
          stage: "resale_unwind_precheck",
          reason: "later_resale_not_refunded",
        },
        extra: { orderId: "x-O1", parentOrderId: "x-O0", eventId: EVENT_ID },
      },
    ]);
  });

  it("a throwing reporter does not change what a refused hop does", async () => {
    const world = createWorld();
    await world.addChain("x", [2000, 2500, 3000, 3500]);
    world.declined.add("pi_x-O3");
    world.reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 0, failedRefundCount: 3 });
    expect(world.refundedOrderIds()).toEqual([]);
    expect(world.cancelledAudit()).toMatchObject({
      failedOrderIds: ["x-O3", "x-O2", "x-O1"],
      failedRefundReasons: [
        { orderId: "x-O2", reason: "later_resale_not_refunded" },
        { orderId: "x-O1", reason: "later_resale_not_refunded" },
      ],
    });
    expect(world.reportError).toHaveBeenCalled();
  });

  it("a middle hop's refund is declined after the later hop was refunded: the later buyer keeps their refund, the middle buyer holds the ticket unrefunded, and the first sale is untouched", async () => {
    const world = createWorld();
    // A → B → C, with B's own refund (x-O1) declined at the processor.
    const chain = await world.addChain("x", [2500, 3000, 4000]);
    world.declined.add("pi_x-O1");

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 1, failedRefundCount: 1 });
    // C is refunded, and B (who sold to C) is debited for that sale alone.
    expect(world.refundedOrderIds()).toEqual(["x-O2"]);
    expect(world.refundedCents("x-O2")).toBe(4000);
    expect(world.debits()).toEqual({ byPayee: { "payee-x-H1": 4000 }, rows: 1 });
    // The ticket is back on B's item, live.
    expect(world.tickets.get(chain.ticketId)).toMatchObject({
      ownerHumanId: "x-H1",
      orderId: "x-O1",
      orderItemId: "x-i1",
      status: "VALID",
    });
    // B's own purchase failed at the processor and is not refunded; A's is
    // never attempted and its item still says it was sold.
    expect(world.cancelledAudit()).toMatchObject({ failedOrderIds: ["x-O1"] });
    expect(world.refundedCents("x-O1")).toBe(0);
    expect(world.refundedCents("x-O0")).toBe(0);
    expect(
      [0, 1, 2].map((n) => [
        world.statusOf(chain.orderId(n)),
        world.itemStatusOf(chain.itemId(n)),
      ]),
    ).toEqual([
      ["SUCCEEDED", "transferred"],
      ["SUCCEEDED", "active"],
      ["REFUNDED", "refunded"],
    ]);
  });

  it("a middle hop that refunds nothing after the later hop was refunded is failed and reported, not skipped in silence", async () => {
    const world = createWorld();
    // A → B → C. The processing fee on B's charge is the whole of what B
    // paid, so B's plan refunds $0 and a RESALE order's $0 plan is skipped.
    const chain = await world.addChain("x", [2500, 3000, 4000]);
    world.stripeFees.set("pi_x-O1", 3000);

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 1, failedRefundCount: 1 });
    expect(world.refundedOrderIds()).toEqual(["x-O2"]);
    expect(world.cancelledAudit()).toMatchObject({
      failedOrderIds: ["x-O1"],
      failedRefundReasons: [{ orderId: "x-O1", reason: "resale_hop_skipped" }],
    });
    expect(world.reported()).toEqual(["cancel_event_resale_hop_skipped"]);
    expect(world.reports()).toEqual([
      {
        tags: { useCase: "cancelEvent", stage: "resale_hop_skipped" },
        extra: { orderId: "x-O1", parentOrderId: "x-O0", eventId: EVENT_ID },
      },
    ]);
    // B was debited for C's sale and holds the ticket; A's sale is untouched.
    expect(world.debits()).toEqual({ byPayee: { "payee-x-H1": 4000 }, rows: 1 });
    expect(world.tickets.get(chain.ticketId)).toMatchObject({
      ownerHumanId: "x-H1",
      orderItemId: "x-i1",
      status: "VALID",
    });
    expect(world.statusOf("x-O1")).toBe("SUCCEEDED");
    expect(world.itemStatusOf("x-i0")).toBe("transferred");
  });

  it("a throwing reporter does not change what a skipped middle hop does", async () => {
    const world = createWorld();
    await world.addChain("x", [2500, 3000, 4000]);
    world.stripeFees.set("pi_x-O1", 3000);
    world.reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 1, failedRefundCount: 1 });
    expect(world.refundedOrderIds()).toEqual(["x-O2"]);
    expect(world.cancelledAudit()).toMatchObject({
      failedRefundReasons: [{ orderId: "x-O1", reason: "resale_hop_skipped" }],
    });
  });

  it("a middle hop is disputed: the buyer after it is refunded and unwound, the hops before it are not", async () => {
    const world = createWorld();
    // A → B → C → D, with C's charge (x-O2) under dispute.
    const chain = await world.addChain("x", [2000, 2500, 3000, 3500]);
    (world.orders.get("x-O2") as { disputeStatus?: string }).disputeStatus =
      "OPEN";

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 1, failedRefundCount: 2 });
    expect(world.refundedOrderIds()).toEqual(["x-O3"]);
    // D is refunded, C (who sold to D) is debited for it, and the ticket is
    // back with C, whose own purchase waits on the dispute.
    expect(world.debits()).toEqual({ byPayee: { "payee-x-H2": 3500 }, rows: 1 });
    expect(world.tickets.get(chain.ticketId)).toMatchObject({
      ownerHumanId: "x-H2",
      orderItemId: "x-i2",
      status: "VALID",
    });
    expect(world.cancelledAudit()).toMatchObject({
      failedRefundReasons: [
        { orderId: "x-O2", reason: "disputed" },
        { orderId: "x-O1", reason: "later_resale_not_refunded" },
      ],
    });
    expect(world.statusOf("x-O1")).toBe("SUCCEEDED");
    expect(world.itemStatusOf("x-i1")).toBe("transferred");
    expect(world.statusOf("x-O0")).toBe("SUCCEEDED");
    expect(world.itemStatusOf("x-i0")).toBe("transferred");
  });

  it("the last buyer is disputed: nobody in the chain is refunded", async () => {
    const world = createWorld();
    await world.addChain("x", [2500, 3000, 4000]);
    (world.orders.get("x-O2") as { disputeStatus?: string }).disputeStatus =
      "UNDER_REVIEW";

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 0, failedRefundCount: 2 });
    expect(world.refundedOrderIds()).toEqual([]);
    expect(world.cancelledAudit()).toMatchObject({
      failedRefundReasons: [
        { orderId: "x-O2", reason: "disputed" },
        { orderId: "x-O1", reason: "later_resale_not_refunded" },
      ],
    });
    expect(world.itemStatusOf("x-i0")).toBe("transferred");
    expect(world.tickets.get("x-T")!.ownerHumanId).toBe("x-H2");
  });

  it("two chains on one event are independent: one unwinds whole while the other stops at its failed last hop", async () => {
    const world = createWorld();
    await world.addChain("x", [2500, 3000, 4000]);
    await world.addChain("y", [1000, 1500, 2000]);
    world.declined.add("pi_y-O2");
    // Interleaved, so neither chain is contiguous in the input.
    world.setListOrder(["y-O0", "x-O1", "y-O1", "x-O0", "y-O2", "x-O2"]);

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 3, failedRefundCount: 2 });
    expect(world.refundedOrderIds()).toEqual(["x-O2", "x-O1", "x-O0"]);
    expect(world.debits()).toEqual({
      byPayee: { "payee-x-H1": 4000, "payee-x-H0": 3000, "x-organizer": 2500 },
      rows: 3,
    });
    expect(world.tickets.get("x-T")).toMatchObject({
      ownerHumanId: "x-H0",
      status: "REFUNDED",
    });
    expect(world.tickets.get("y-T")).toMatchObject({
      ownerHumanId: "y-H2",
      orderItemId: "y-i2",
      status: "VALID",
    });
    expect(world.cancelledAudit()).toMatchObject({
      failedRefundReasons: [
        { orderId: "y-O1", reason: "later_resale_not_refunded" },
      ],
    });
    expect(world.itemStatusOf("y-i0")).toBe("transferred");
  });

  it("a primary order with one ticket resold twice and one kept: both are refunded when the chain unwinds", async () => {
    const world = createWorld();
    const primary = makeOrder("p-O", "p-H0", "PRIMARY", [
      makeItem("p-kept", "p-O", 2500),
    ]);
    world.orders.set(primary.id, primary);
    world.tickets.set("p-kept-T", {
      id: "p-kept-T",
      ownerHumanId: "p-H0",
      orderId: "p-O",
      orderItemId: "p-kept",
      status: "VALID",
      scannedAt: null,
    });
    await world.addChain("x", [2500, 3000, 4000], { onPrimaryOrder: primary });

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 3, failedRefundCount: 0 });
    expect(world.refundedOrderIds()).toEqual(["x-O2", "x-O1", "p-O"]);
    expect(world.refundedCents("p-O")).toBe(5000);
    expect(world.itemStatusOf("p-kept")).toBe("refunded");
    expect(world.itemStatusOf("x-i0")).toBe("refunded");
    expect(world.statusOf("p-O")).toBe("REFUNDED");
    expect(world.tickets.get("x-T")!.status).toBe("REFUNDED");
    expect(world.tickets.get("p-kept-T")!.status).toBe("REFUNDED");
  });

  it("a primary order with one ticket resold twice and one kept: only the kept ticket is refunded when the chain's last hop fails", async () => {
    const world = createWorld();
    const primary = makeOrder("p-O", "p-H0", "PRIMARY", [
      makeItem("p-kept", "p-O", 2500),
    ]);
    world.orders.set(primary.id, primary);
    world.tickets.set("p-kept-T", {
      id: "p-kept-T",
      ownerHumanId: "p-H0",
      orderId: "p-O",
      orderItemId: "p-kept",
      status: "VALID",
      scannedAt: null,
    });
    await world.addChain("x", [2500, 3000, 4000], { onPrimaryOrder: primary });
    world.declined.add("pi_x-O2");

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 1, failedRefundCount: 2 });
    expect(world.refundedOrderIds()).toEqual(["p-O"]);
    expect(world.refundedCents("p-O")).toBe(2500);
    expect(world.itemStatusOf("p-kept")).toBe("refunded");
    // The resold item keeps its revenue: C still holds a paid claim on it.
    expect(world.itemStatusOf("x-i0")).toBe("transferred");
    expect(world.tickets.get("x-T")).toMatchObject({
      ownerHumanId: "x-H2",
      status: "VALID",
    });
  });

  it("a later purchase that does not name the item it bought: the hop before it fails closed as sold on", async () => {
    const world = createWorld();
    // C's item (hop 2) lost `resaleOriginalOrderItemId`.
    await world.addChain("x", [2500, 3000, 4000], { unlinkedHop: 2 });

    const result = await world.cancel();

    // C is the holder and is refunded; its unwind resolves B's item through
    // the parent order. B's own refund was decided before that, from links
    // alone, and nothing said C's purchase came from B's item.
    expect(world.refundedOrderIds()).toEqual(["x-O2"]);
    expect(result).toMatchObject({ refundedOrderCount: 1, failedRefundCount: 1 });
    expect(world.cancelledAudit()).toMatchObject({
      failedRefundReasons: [{ orderId: "x-O1", reason: "sold_on" }],
    });
    expect(world.refundedCents("x-O1")).toBe(0);
    expect(world.refundedCents("x-O0")).toBe(0);
    expect(world.itemStatusOf("x-i0")).toBe("transferred");
  });

  it("resale orders that name each other's items are failed closed and reported, with no money moved", async () => {
    const world = createWorld();
    await world.addChain("x", [2500, 3000, 4000]);
    // Corrupt links: B's item says it was bought from C's item, and C's
    // from B's. No hop is last.
    const b = world.orders.get("x-O1")!;
    (b.items[0]!.meta as Record<string, unknown>).resaleOriginalOrderItemId =
      "x-i2";

    const result = await world.cancel();

    expect(world.refundedOrderIds()).toEqual([]);
    // Both resale orders, and A's order with them: with B's link rewritten
    // nothing names A's item any more, and a transferred item nobody names
    // would read as a gift. Looped links switch gift detection off, so A's
    // order fails closed instead of being refunded as one.
    expect(result).toMatchObject({ refundedOrderCount: 0, failedRefundCount: 3 });
    expect(world.cancelledAudit()).toMatchObject({
      failedOrderIds: ["x-O1", "x-O2", "x-O0"],
      failedRefundReasons: [
        { orderId: "x-O1", reason: "resale_chain_unorderable" },
        { orderId: "x-O2", reason: "resale_chain_unorderable" },
      ],
    });
    expect(world.reported()).toEqual([
      "cancel_event_resale_chain_unorderable",
      "cancel_event_resale_chain_unorderable",
      "cancel_event_gift_detection_disabled",
    ]);
    expect(world.debits().rows).toBe(0);
    expect(world.itemStatusOf("x-i0")).toBe("transferred");
    expect(world.tickets.get("x-T")!.ownerHumanId).toBe("x-H2");
  });

  it("a throwing reporter does not change what an unorderable chain does", async () => {
    const world = createWorld();
    await world.addChain("x", [2500, 3000, 4000]);
    const b = world.orders.get("x-O1")!;
    (b.items[0]!.meta as Record<string, unknown>).resaleOriginalOrderItemId =
      "x-i2";
    world.reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 0, failedRefundCount: 3 });
    expect(world.refundedOrderIds()).toEqual([]);
  });

  it("a replay of the same cancellation returns the stored result and moves nothing again", async () => {
    const world = createWorld();
    await world.addChain("x", [2500, 3000, 4000]);

    const first = await world.cancel("cancel-chain-replay");
    const second = await world.cancel("cancel-chain-replay");

    expect(second).toEqual(first);
    expect(world.refundedOrderIds()).toEqual(["x-O2", "x-O1", "x-O0"]);
    expect(world.debits().rows).toBe(3);
  });

  it("one hop is unchanged: the resale buyer, then the original buyer", async () => {
    const world = createWorld();
    await world.addChain("x", [5000, 6000]);
    world.stripeFees.set("pi_x-O0", 175);
    world.stripeFees.set("pi_x-O1", 204);
    world.setListOrder(["x-O0", "x-O1"]);

    const result = await world.cancel();

    expect(result).toMatchObject({ refundedOrderCount: 2, failedRefundCount: 0 });
    expect(world.refundedOrderIds()).toEqual(["x-O1", "x-O0"]);
    expect(world.refundedCents("x-O1")).toBe(6000 - 204);
    expect(world.refundedCents("x-O0")).toBe(5000 - 175);
    expect(world.debits()).toEqual({
      byPayee: { "payee-x-H0": 6000, "x-organizer": 5000 },
      rows: 2,
    });
  });
});
