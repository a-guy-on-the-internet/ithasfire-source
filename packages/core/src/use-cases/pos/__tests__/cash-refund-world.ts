import { vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { ledgerEntryBalanceDeltaCents } from "../../payouts/_shared/ledger-entry-delta";
import { cashSaleDebitKey } from "../_shared/cash-sale-ledger";

/**
 * A small stateful world for the cash refund paths: orders, their items,
 * tickets and tax lines, the org membership, and the payee ledger (the
 * shared in-memory fake, which honours the adapter's reversal contract).
 * Every write the shared refund core makes lands on this state, so tests
 * assert what the order LOOKS like afterwards, not which mocks were called.
 *
 * Shared by `org-refund-cash-sale.test.ts` and the cancel-event cash test.
 */

export const ORG_ID = "c0000000-0000-4000-8000-0000000000a1";
export const OTHER_ORG_ID = "c0000000-0000-4000-8000-0000000000a2";
export const EVENT_ID = "c0000000-0000-4000-8000-0000000000e1";
export const ACTOR_ID = "c0000000-0000-4000-8000-000000000001";
export const PAYEE_ID = "c0000000-0000-4000-8000-0000000000b1";
export const NOW = new Date("2026-10-07T23:00:00.000Z");

export type Role =
  | "OWNER"
  | "ADMIN"
  | "EDITOR"
  | "FINANCE"
  | "SCANNER"
  | "VIEWER"
  | null;

type Item = Record<string, any> & { id: string };
type Ticket = { id: string; orderId: string; status: string; seatId: null };
type Order = Record<string, any> & { id: string; items: Item[] };

/**
 * The priced cash sale every test uses: 2 GA at $25 face + $1.75 platform
 * fee each (buyer total 2675), tax 522 on one PLATFORM line. Total handed
 * back 5872; the debit is fee + tax = 350 + 522 = 872.
 */
export const PRICED = {
  face: 2500,
  feePerTicket: 175,
  buyerTotalPerTicket: 2675,
  feesPlatformCents: 350,
  taxAmountCents: 522,
  totalCents: 2 * 2675 + 522,
  debitCents: 350 + 522,
} as const;

export function makeCashWorld() {
  const event: EventRecord = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Door Night",
    slug: "door-night",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as EventRecord;

  const orders = new Map<string, Order>();
  const tickets = new Map<string, Ticket[]>();
  const taxLines = new Map<string, unknown[]>();
  const ledger = createFakePayeeLedgerRepo();
  const auditRows: Array<{ action: string; entityId: string; data: any }> = [];
  /** Orders whose ticket read throws — a per-order failure on demand. */
  const failOnOrderIds = new Set<string>();
  let role: Role = "EDITOR";
  /** Whether the actor holds the platform ADMIN staff role. */
  let staffAdmin = false;
  /** Whether that staff member has a passkey or TOTP enrolled. */
  let staffSecondFactor = true;
  let now = NOW;

  /** The order's CASH_SALE_DEBIT exists and no reversal points at it. */
  const hasUnreversedDebit = (orderId: string): boolean =>
    ledger.entries.some(
      (d) =>
        d.orderId === orderId &&
        d.type === "CASH_SALE_DEBIT" &&
        !ledger.entries.some(
          (r) =>
            r.type === "CASH_SALE_DEBIT_REVERSAL" && r.relatedEntryId === d.id,
        ),
    );

  const findItem = (itemId: string): Item | undefined => {
    for (const order of orders.values()) {
      const item = order.items.find((i) => i.id === itemId);
      if (item) return item;
    }
    return undefined;
  };

  /**
   * Child ids carry the order's own last 4 hex digits, so two orders never
   * share an item, ticket or buyer id (order ids differ only at the end).
   */
  const childId = (prefix: string, orderId: string, n: number) =>
    `${prefix}0000000-0000-4000-8000-${orderId.slice(-4)}${n
      .toString(16)
      .padStart(8, "0")}`;

  const ticketRows = (orderId: string, count: number): Ticket[] =>
    Array.from({ length: count }, (_, i) => ({
      id: childId("e", orderId, i),
      orderId,
      status: "SCANNED",
      seatId: null,
    }));

  const baseOrder = (id: string, occurredAt: Date): Order => ({
    id,
    eventId: EVENT_ID,
    buyerHumanId: childId("b", id, 0),
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: null,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt,
    paymentMethodType: null,
    paymentChannel: "CASH",
    paidOutAt: null,
    parentOrderId: null,
    amountGrossCents: 0,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    items: [],
  });

  const ticketItem = (orderId: string, n: number, meta: unknown, face: number) => ({
    id: childId("d", orderId, n),
    orderId,
    kind: "ticket",
    ticketTypeId: "c0000000-0000-4000-8000-0000000000d1",
    qty: 1,
    unitPriceCents: face,
    amountCents: face,
    meta,
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    resaleListingId: null,
    status: "active",
  });

  async function addPricedCashOrder(
    id: string,
    opts: { occurredAt?: Date } = {},
  ): Promise<Order> {
    const order = baseOrder(id, opts.occurredAt ?? NOW);
    order.amountGrossCents = 2 * PRICED.face;
    order.feesPlatformCents = PRICED.feesPlatformCents;
    order.taxAmountCents = PRICED.taxAmountCents;
    order.items = [0, 1].map((n) =>
      ticketItem(
        id,
        n,
        {
          platformFeePerTicketCents: PRICED.feePerTicket,
          buyerTotalCents: PRICED.buyerTotalPerTicket,
          buyerUnitTotalCents: PRICED.buyerTotalPerTicket,
        },
        PRICED.face,
      ),
    );
    orders.set(id, order);
    tickets.set(id, ticketRows(id, 2));
    taxLines.set(id, [
      {
        id: `${id}-line`,
        orderId: id,
        code: "TN_SALES",
        label: "Sales tax",
        jurisdiction: "US-TN",
        rateBps: 975,
        base: "BUYER_TOTAL",
        collector: "PLATFORM",
        taxableAmountCents: 2 * PRICED.buyerTotalPerTicket,
        amountCents: PRICED.taxAmountCents,
        createdAt: NOW,
      },
    ]);
    // What `recordCashSale` writes in the sale's transaction.
    await ledger.repo.cashSaleDebit({
      idempotencyKey: cashSaleDebitKey(id),
      payeeId: PAYEE_ID,
      amountCents: PRICED.debitCents,
      currency: "usd",
      orderId: id,
      description: `Door cash sale — order ${id}`,
      sourceKind: "pos_cash_sale",
      sourceId: id,
    });
    return order;
  }

  /** A $0 comp: no fee, no tax, no debit. */
  function addCompCashOrder(id: string, opts: { occurredAt?: Date } = {}) {
    const order = baseOrder(id, opts.occurredAt ?? NOW);
    order.items = [
      ticketItem(
        id,
        0,
        {
          comp: true,
          platformFeePerTicketCents: 0,
          buyerTotalCents: 0,
          buyerUnitTotalCents: 0,
        },
        0,
      ),
    ];
    orders.set(id, order);
    tickets.set(id, ticketRows(id, 1));
    return order;
  }

  /**
   * A cash order recorded before the door was priced: the operator's typed
   * gross, no buyer totals, no fee, no tax, no debit.
   */
  function addLegacyCashOrder(
    id: string,
    grossCents: number,
    opts: { occurredAt?: Date } = {},
  ) {
    const order = baseOrder(id, opts.occurredAt ?? NOW);
    order.amountGrossCents = grossCents;
    order.items = [ticketItem(id, 0, {}, grossCents)];
    orders.set(id, order);
    tickets.set(id, ticketRows(id, 1));
    return order;
  }

  /** An online card order (for the cancellation mix). */
  async function addCardOrder(id: string) {
    const order = baseOrder(id, NOW);
    order.paymentChannel = "WEB";
    order.stripePaymentIntentId = `pi_${id.slice(-6)}`;
    order.paymentMethodType = "card";
    order.amountGrossCents = 2500;
    order.feesPlatformCents = 175;
    order.items = [
      ticketItem(
        id,
        0,
        { platformFeePerTicketCents: 175, buyerTotalCents: 2675 },
        2500,
      ),
    ];
    orders.set(id, order);
    tickets.set(id, ticketRows(id, 1));
    const itemId = order.items[0]!.id;
    await ledger.seedCredit({
      orderId: id,
      payeeId: PAYEE_ID,
      amountCents: 2500,
      items: { [itemId]: 2500 },
    });
    return order;
  }

  /**
   * A door card sale still PENDING: started at the till, not yet tapped (or
   * tapped and not yet finalised). `channel: "WEB"` makes it an online cart
   * instead, which the door phases must leave to the cart reaper.
   */
  function addPendingCardSale(
    id: string,
    opts: { channel?: "POS" | "WEB" } = {},
  ) {
    const order = baseOrder(id, NOW);
    order.status = "PENDING";
    order.paymentChannel = opts.channel ?? "POS";
    order.stripePaymentIntentId = `pi_${id.slice(-6)}`;
    order.amountGrossCents = 2500;
    order.items = [ticketItem(id, 0, { buyerTotalCents: 2675 }, 2500)];
    orders.set(id, order);
    return order;
  }

  /** A free online order: SUCCEEDED, no PaymentIntent, not cash. */
  function addFreeWebOrder(id: string) {
    const order = baseOrder(id, NOW);
    order.paymentChannel = "WEB";
    order.items = [ticketItem(id, 0, { buyerTotalCents: 0 }, 0)];
    orders.set(id, order);
    tickets.set(id, ticketRows(id, 1));
    return order;
  }

  const listAll = vi.fn(
    async (input: {
      eventId?: string | null;
      statuses?: string[];
      source?: string;
      limit?: number;
      offset?: number;
    }) => {
      const matching = [...orders.values()].filter(
        (o) =>
          (!input.eventId || o.eventId === input.eventId) &&
          (!input.statuses || input.statuses.includes(o.status)) &&
          (!input.source || o.source === input.source),
      );
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 100;
      return {
        items: matching.slice(offset, offset + limit).map((o) => ({
          id: o.id,
          stripePaymentIntentId: o.stripePaymentIntentId,
          amountGrossCents: o.amountGrossCents,
          feesPlatformCents: o.feesPlatformCents,
        })),
        total: matching.length,
        limit,
        offset,
      };
    },
  );

  const ordersRepo = {
    getById: vi.fn(async (id: string) => orders.get(id) ?? null),
    listAll,
    listTaxLines: vi.fn(async (id: string) => taxLines.get(id) ?? []),
    listTaxLinesByOrderIds: vi.fn(
      async (ids: string[]) =>
        new Map(
          ids
            .filter((id) => taxLines.has(id))
            .map((id) => [id, taxLines.get(id)!]),
        ),
    ),
    markRefunded: vi.fn(async (id: string, partialCents?: number) => {
      const order = orders.get(id);
      if (order) order.status = partialCents ? "PART_REFUNDED" : "REFUNDED";
    }),
    // The door void's claim: PENDING → CANCELLED, once.
    cancelPendingOrder: vi.fn(async (id: string) => {
      const order = orders.get(id);
      if (!order || order.status !== "PENDING") return false;
      order.status = "CANCELLED";
      return true;
    }),
    // The sweep's scan: cancelled events still carrying a cash sale with an
    // unreversed CASH_SALE_DEBIT, or a PENDING door card sale; quarantined
    // orders excluded. Mirrors the adapter's SQL.
    listCancelledEventIdsWithOpenDoorOrders: vi.fn(
      async (input: { limit: number; excludeOrderIds?: readonly string[] }) => {
        const excluded = new Set(input.excludeOrderIds ?? []);
        const ids = new Set<string>();
        for (const o of orders.values()) {
          if (excluded.has(o.id)) continue;
          const open =
            (o.paymentChannel === "CASH" &&
              o.status === "SUCCEEDED" &&
              hasUnreversedDebit(o.id)) ||
            (o.paymentChannel === "POS" && o.status === "PENDING");
          if (open && o.eventId === event.id && event.status === "CANCELLED") {
            ids.add(o.eventId);
          }
        }
        return [...ids].slice(0, input.limit);
      },
    ),
    // The cancellation's cash candidates: SUCCEEDED CASH orders by id,
    // keyset-paged; optionally only those with an unreversed debit.
    listSucceededCashOrderIdsForEvent: vi.fn(
      async (input: {
        eventId: string;
        unreversedCashSaleDebitOnly: boolean;
        afterId?: string | null;
        limit: number;
      }) =>
        [...orders.values()]
          .filter(
            (o) =>
              o.eventId === input.eventId &&
              o.paymentChannel === "CASH" &&
              o.status === "SUCCEEDED" &&
              o.id > (input.afterId ?? "") &&
              (!input.unreversedCashSaleDebitOnly || hasUnreversedDebit(o.id)),
          )
          .map((o) => o.id)
          .sort()
          .slice(0, input.limit),
    ),
    // The cash refund's claim: SUCCEEDED → REFUNDED, once.
    /**
     * The adapter's contract over this world's state: CASH orders of the
     * event in SUCCEEDED / REFUNDED / PART_REFUNDED, (occurredAt, id) desc,
     * keyset cursor `<iso>|<id>`. Promo codes come from `order.promoCodes`
     * (tests set it), ticket count from the ticket rows.
     */
    listCashSalesForEvent: vi.fn(
      async (input: { eventId: string; cursor: string | null; limit: number }) => {
        const key = (o: Order) => [o.occurredAt.getTime(), o.id] as const;
        const after = input.cursor
          ? (() => {
              const [iso, id] = input.cursor!.split("|");
              return [new Date(iso!).getTime(), id!] as const;
            })()
          : null;
        const rows = [...orders.values()]
          .filter(
            (o) =>
              o.eventId === input.eventId &&
              o.paymentChannel === "CASH" &&
              ["SUCCEEDED", "REFUNDED", "PART_REFUNDED"].includes(o.status),
          )
          .sort((a, b) => {
            const [at, ai] = key(a);
            const [bt, bi] = key(b);
            return bt - at || (bi < ai ? -1 : bi > ai ? 1 : 0);
          })
          .filter((o) => {
            if (!after) return true;
            const [t, id] = key(o);
            return t < after[0] || (t === after[0] && id < after[1]);
          });
        const page = rows.slice(0, input.limit);
        const last = page[page.length - 1];
        return {
          items: page.map((o) => ({
            orderId: o.id,
            status: o.status,
            occurredAt: o.occurredAt,
            amountGrossCents: o.amountGrossCents,
            feesPlatformCents: o.feesPlatformCents,
            taxAmountCents: o.taxAmountCents,
            ticketCount: (tickets.get(o.id) ?? []).length,
            items: o.items.map((i) => ({
              kind: i.kind,
              amountCents: i.amountCents,
              meta: i.meta,
              refundedAt: i.refundedAt ?? null,
            })),
            promoCodes: (o.promoCodes as string[] | undefined) ?? [],
          })),
          nextCursor:
            rows.length > input.limit && last
              ? `${last.occurredAt.toISOString()}|${last.id}`
              : null,
        };
      },
    ),
    markRefundedIfSucceeded: vi.fn(async (id: string) => {
      const order = orders.get(id);
      if (!order || order.status !== "SUCCEEDED") return false;
      order.status = "REFUNDED";
      return true;
    }),
  };

  const tx = {
    orders: ordersRepo,
    events: {
      getById: vi.fn(async (id: string) => (id === event.id ? event : null)),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => {
        (event as { status: string }).status = "CANCELLED";
        return event;
      }),
    },
    authz: {
      getOrgMembership: vi.fn(async (q: { orgId: string }) =>
        role && q.orgId === ORG_ID
          ? { orgId: ORG_ID, humanId: ACTOR_ID, role }
          : null,
      ),
    },
    tickets: {
      listByOrderId: vi.fn(async (orderId: string) => {
        if (failOnOrderIds.has(orderId)) {
          throw new Error(`ticket read failed for ${orderId}`);
        }
        return tickets.get(orderId) ?? [];
      }),
      setStatus: vi.fn(async (ticketId: string, status: string) => {
        for (const list of tickets.values()) {
          const t = list.find((x) => x.id === ticketId);
          if (t) t.status = status;
        }
      }),
      clearSeatAssignments: vi.fn(async () => undefined),
    },
    orderItems: {
      updateStatus: vi.fn(
        async (
          itemId: string,
          status: string,
          at?: Date,
          refundedTaxCents?: number,
          refundedPlatformFeeCents?: number | null,
        ) => {
          const item = findItem(itemId);
          if (!item) return;
          item.status = status;
          if (status === "refunded") item.refundedAt = at ?? NOW;
          if (refundedTaxCents !== undefined) {
            item.refundedTaxCents = refundedTaxCents;
          }
          if (refundedPlatformFeeCents !== undefined) {
            item.refundedPlatformFeeCents = refundedPlatformFeeCents;
          }
        },
      ),
      listByOrderId: vi.fn(async (id: string) => orders.get(id)?.items ?? []),
      recordReleasedSeats: vi.fn(async () => undefined),
      setResaleListingId: vi.fn(async () => undefined),
    },
    seats: {
      updateStatuses: vi.fn(async () => undefined),
      releaseSeats: vi.fn(async () => undefined),
    },
    promos: { releaseHoldsForOrder: vi.fn(async () => undefined) },
    feeWaivers: { release: vi.fn(async () => ({ releasedTickets: 0 })) },
    payeeLedger: ledger.repo,
    audit: {
      log: vi.fn(async (row: { action: string; entityId: string; data: any }) => {
        auditRows.push(row);
      }),
    },
    // ── What `cancelEvent`'s marking transaction touches besides orders ──
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
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
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
    // The card refund's missing-credit check reads the order's splits.
    splits: {
      getForOrder: vi.fn(async (orderId: string) =>
        orders.get(orderId)?.stripePaymentIntentId
          ? [{ orderId, payeeId: PAYEE_ID, amountCents: 2500 }]
          : [],
      ),
    },
    searchReindexMarks: { mark: vi.fn(async () => undefined) },
  };

  const repos = {
    ...tx,
    // A transaction that throws rolls back what this world can roll back:
    // order and ticket statuses (the refund's claim flips the order first,
    // before the step that fails).
    tx: vi.fn(async (fn: (t: TxRepos) => Promise<unknown>) => {
      const orderStatuses = new Map(
        [...orders].map(([id, o]) => [id, o.status] as const),
      );
      const ticketStatuses = new Map(
        [...tickets.values()].flat().map((t) => [t, t.status] as const),
      );
      try {
        return await fn(tx as unknown as TxRepos);
      } catch (err) {
        for (const [id, status] of orderStatuses) orders.get(id)!.status = status;
        for (const [t, status] of ticketStatuses) t.status = status;
        throw err;
      }
    }),
  } as unknown as Repos;

  /** The payee's balance through the ledger's own sign table. */
  const netBalanceCents = () =>
    ledger.entries.reduce(
      (sum, e) =>
        sum +
        ledgerEntryBalanceDeltaCents({
          type: e.type,
          amountCents: e.amountCents,
          idempotencyKey: e.idempotencyKey,
          relatedEntryType: null,
        }),
      0,
    );

  return {
    event,
    orders,
    tickets,
    ledger,
    auditRows,
    failOnOrderIds,
    tx,
    repos,
    clock: { now: () => now },
    /**
     * The platform authz port: ADMIN staff only when `setStaffAdmin(true)`.
     * As the real port does, it refuses an ADMIN with no second factor
     * (`setStaffSecondFactor(false)`) and says that is why.
     */
    authz: {
      hasStaffRole: vi.fn(
        async (): Promise<{ allowed: boolean; secondFactorRequired?: true }> =>
          staffAdmin && !staffSecondFactor
            ? { allowed: false, secondFactorRequired: true }
            : { allowed: staffAdmin },
      ),
    },
    setRole: (r: Role) => {
      role = r;
    },
    setStaffAdmin: (v: boolean) => {
      staffAdmin = v;
    },
    /** False: the platform ADMIN has neither a passkey nor TOTP enrolled. */
    setStaffSecondFactor: (enrolled: boolean) => {
      staffSecondFactor = enrolled;
    },
    setNow: (d: Date) => {
      now = d;
    },
    addPricedCashOrder,
    addCompCashOrder,
    addLegacyCashOrder,
    addCardOrder,
    addPendingCardSale,
    addFreeWebOrder,
    netBalanceCents,
    reversalsFor: (orderId: string) =>
      ledger
        .entriesOfType("CASH_SALE_DEBIT_REVERSAL")
        .filter((e) => e.orderId === orderId),
  };
}

export type CashWorld = ReturnType<typeof makeCashWorld>;
