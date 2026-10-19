import type { DisputeStatus } from "@th/types/repos/disputes";
import type { AddressRevealPreset } from "@th/types/repos/events";
import type {
  ResaleSharePayer,
  ResaleShareType,
} from "@th/types/repos/payout-terms";
import {
  PROCESSOR_FEE_MAX_READ_FAILURES,
  PROCESSOR_FEE_RETRY_BACKOFF_MS,
  type ListOrdersMissingProcessorFeeInput,
  type OrderMissingProcessorFee,
  type RecordProcessorFeeReadFailureInput,
  type StampProcessorFeeInput,
} from "@th/types/repos/orders";
import { Prisma as PrismaNamespace, type PrismaClient } from "@prisma/client";
import type {
  BuyerOrderSummary,
  CountDistinctBuyersForOwnerInput,
  CreatePendingOrderInput,
  CreateOrderTaxLinesInput,
  OrderTaxLineRecord,
  ExpiredPendingOrderItem,
  FindOrderForOwnerInput,
  FindOrderForOwnerResult,
  OrderOwnerScope,
  SummarizeBuyerOrdersForOwnerInput,
  GetTaxNexusRollupInput,
  CashTillSummary,
  CollectedTaxTotal,
  SummarizeCashTillForEventInput,
  ListCashSalesForEventInput,
  ListCashSalesForEventResult,
  ListAllOrdersInput,
  ListAllOrdersResult,
  ListEventCompOrdersInput,
  ListEventCompOrdersResult,
  ListExpiredPendingOrdersInput,
  ListOtherPendingInput,
  ListOrdersByBuyerInput,
  ListOrdersByBuyerResult,
  ListOrdersForHumanOwnedEventsInput,
  ListOrdersForHumanOwnedEventsResult,
  ListOrdersForOrgInput,
  ListOrdersForOrgResult,
  ListPendingCartsInput,
  ListPendingCartsResult,
  ListPlatformOrdersItem,
  OrderItemKind,
  OrderItemRecord,
  OrderItemStatus,
  OrderEventAttribution,
  OrderKind,
  OrderRecord,
  OrderSource,
  OrderStatus,
  OrdersRepo,
  PaymentCardChecks,
  PendingCartItem,
  PlatformOrderItemSummary,
  SearchEventAttendeesInput,
  SearchEventAttendeesResult,
  TaxNexusRollupRow,
  TaxSplitTicketItem,
  UpdatePendingOrderItemsInput,
  BulkMigrateOrdersInput,
} from "@th/ports/repos/orders";
import { classifyCashSale } from "@th/core/lib/orders/classify-cash-sale";
import { COMPLETED_ORDER_STATUSES } from "@th/ports/repos/orders";
import { orderIdentifierClauses } from "@th/types/order-identifier";

import type { PrismaClientOrTx } from "./types";

/**
 * `o` (an Order alias) carries a CASH_SALE_DEBIT that no
 * CASH_SALE_DEBIT_REVERSAL points at: fee + tax the organiser still owes on
 * that cash sale. The door sweep's cutover marker (see
 * `listCancelledEventIdsWithOpenDoorOrders`).
 */
const unreversedCashSaleDebitSql = PrismaNamespace.sql`EXISTS (
  SELECT 1 FROM public."PayeeLedgerEntry" d
  WHERE d."orderId" = o."id"
    AND d."type" = 'CASH_SALE_DEBIT'
    AND NOT EXISTS (
      SELECT 1 FROM public."PayeeLedgerEntry" r
      WHERE r."type" = 'CASH_SALE_DEBIT_REVERSAL'
        AND r."relatedEntryId" = d."id"
    )
)`;

/**
 * Assert the event relation on a row from a TICKETING-scoped query.
 *
 * `Order.eventId` is nullable because membership invoices are Orders with no
 * event. Every query below that reads `row.event` is scoped to ticketing —
 * either by an explicit `kind: "TICKETING"` filter or by a relation filter
 * like `event: { orgId }`, which a null relation can never satisfy — so a
 * missing event here is a broken invariant, not a normal absence.
 *
 * Throwing rather than defaulting is deliberate: a silent `?? ""` would render
 * an order list with blank event titles and hide the inconsistency, and these
 * rows feed settlement and payout views.
 */
function requireEvent<T>(event: T | null | undefined, orderId: string): T {
  if (!event) {
    throw new Error(
      `orders repo: order ${orderId} is kind=TICKETING but has no event`,
    );
  }
  return event;
}

/** Same invariant as {@link requireEvent}, for the scalar FK. */
function requireEventId(eventId: string | null, orderId: string): string {
  if (!eventId) {
    throw new Error(
      `orders repo: order ${orderId} is kind=TICKETING but has no eventId`,
    );
  }
  return eventId;
}

/** Narrows any order query to ticketing orders, excluding membership invoices. */
const TICKETING_ONLY = { kind: "TICKETING" } as const;

/**
 * Which redemption represents an order in a one-line summary.
 *
 * An order can carry a typed code AND a membership benefit (one row each in
 * the shared ledger). Prefer the typed one — it is the string an operator
 * would recognise and search for — and fall back to the benefit, reported as
 * a codeless membership line rather than as its internal marker.
 */
function pickShownRedemption(
  redemptions: Array<{
    code: string;
    promoId: string | null;
    amountDiscountCents: number;
  }>,
): { source: "code" | "membership"; code: string | null; amountDiscountCents: number } | null {
  const shown =
    redemptions.find((row) => row.promoId != null) ?? redemptions[0];
  if (!shown) return null;
  return shown.promoId != null
    ? { source: "code", code: shown.code, amountDiscountCents: shown.amountDiscountCents }
    : { source: "membership", code: null, amountDiscountCents: shown.amountDiscountCents };
}

/**
 * Hard cap on the cash-till scan. Chosen well above a real door's nightly
 * volume so it never binds in practice, and low enough that a multi-day
 * festival's history cannot turn a per-sale refetch into a table scan.
 */
const CASH_TILL_SCAN_CAP = 2000;

/**
 * Value-based keyset cursor for `listCashSalesForEvent`:
 * `<occurredAt ISO>|<order id>`, the event-saves scheme. Value-based rather
 * than a Prisma row cursor so the page boundary survives whatever happens to
 * the boundary row; opaque at the port.
 */
export function encodeCashSalesCursor(occurredAt: Date, orderId: string): string {
  return `${occurredAt.toISOString()}|${orderId}`;
}

/**
 * Defensive decode: a malformed cursor returns null, which restarts from the
 * first page. Never a 500, never a hidden row; worst case page 1 again.
 */
export function decodeCashSalesCursor(
  cursor: string,
): { occurredAt: Date; orderId: string } | null {
  const sep = cursor.indexOf("|");
  if (sep <= 0 || sep === cursor.length - 1) return null;
  const occurredAt = new Date(cursor.slice(0, sep));
  if (Number.isNaN(occurredAt.getTime())) return null;
  return { occurredAt, orderId: cursor.slice(sep + 1) };
}

export function makeOrdersRepo(p: PrismaClientOrTx): OrdersRepo {
  return {
    createPending: async (input: CreatePendingOrderInput) => {
      const order = await p.order.create({
        data: {
          ...(input.id ? { id: input.id } : {}),
          eventId: input.eventId,
          kind: input.kind ?? "TICKETING",
          buyerHumanId: input.buyerHumanId,
          amountGrossCents: input.amountGrossCents,
          feesPlatformCents: input.feesPlatformCents ?? 0,
          taxAmountCents: input.taxAmountCents ?? 0,
          currency: input.currency,
          feePolicySnapshot: input.feePolicySnapshot ?? {},
          status: "PENDING",
          stripePaymentIntentId: input.stripePaymentIntentId,
          // MEMBERSHIP orders only. UNIQUE, so a replayed invoice webhook that
          // slipped past the use case's idempotency checks fails here.
          stripeInvoiceId: input.stripeInvoiceId ?? null,
          parentOrderId: input.parentOrderId ?? null,
          source: input.source as any,
          nonRefundable: input.nonRefundable ?? false,
          // Comp provenance. Null for every non-COMP order and for
          // reward-granted comps, which carry no human issuer.
          compReason: input.compReason ?? null,
          compIssuedByHumanId: input.compIssuedByHumanId ?? null,
          billingAddressLine1: input.billingAddressLine1 ?? null,
          billingAddressLine2: input.billingAddressLine2 ?? null,
          billingCity: input.billingCity ?? null,
          billingState: input.billingState ?? null,
          billingPostalCode: input.billingPostalCode ?? null,
          billingCountry: input.billingCountry ?? null,
          stripeTaxCalculationId: input.stripeTaxCalculationId ?? null,
          taxSitusCountry: input.taxSitusCountry ?? null,
          taxSitusState: input.taxSitusState ?? null,
          taxSitusPostal: input.taxSitusPostal ?? null,
          taxRateSource: input.taxRateSource ?? null,
          termsVersion: input.termsVersion ?? null,
          termsAcceptedAt: input.termsAcceptedAt ?? null,
          billingDescriptor: input.billingDescriptor ?? null,
          refundPolicyAckAt: input.refundPolicyAckAt ?? null,
          refundPolicyAckIp: input.refundPolicyAckIp ?? null,
          refundPolicyVersion: input.refundPolicyVersion ?? null,
          refundPolicyText: input.refundPolicyText ?? null,
          checkoutIp: input.checkoutIp ?? null,
          ...(input.paymentChannel
            ? { paymentChannel: input.paymentChannel }
            : {}),
          items: {
            create: input.items.map((it) => ({
              kind: it.kind,
              ticketTypeId: it.ticketTypeId ?? null,
              // Set only on `kind = "membership"` lines.
              membershipId: it.membershipId ?? null,
              qty: it.qty,
              unitPriceCents: it.unitPriceCents,
              amountCents: it.amountCents,
              meta: it.meta ?? {},
              resaleListingId: it.resaleListingId ?? null,
              resaleFaceValueCents: it.resaleFaceValueCents ?? null,
              resaleProcessingPassThroughCents:
                it.resaleProcessingPassThroughCents ?? 0,
              resaleProcessingFeeConfigRef:
                it.resaleProcessingFeeConfigRef ?? null,
              resaleSaleCutoffAt: it.resaleSaleCutoffAt ?? null,
              resalePayoutReleaseAt: it.resalePayoutReleaseAt ?? null,
              resalePayoutStatus: it.resalePayoutStatus ?? null,
              resalePayoutHeldAt: it.resalePayoutHeldAt ?? null,
              resalePayoutHoldReason: it.resalePayoutHoldReason ?? null,
              resalePayoutNoticeSentAt: it.resalePayoutNoticeSentAt ?? null,
              resalePayoutReminderSentAt: it.resalePayoutReminderSentAt ?? null,
              resalePayoutFinalNoticeSentAt:
                it.resalePayoutFinalNoticeSentAt ?? null,
              // Resale share record (organiser-resale-share FR-003).
              resaleClauseType: it.resaleClauseType ?? null,
              resaleClauseBps: it.resaleClauseBps ?? null,
              resaleClauseCents: it.resaleClauseCents ?? null,
              resaleClausePayer: it.resaleClausePayer ?? null,
              resaleClauseTermsId: it.resaleClauseTermsId ?? null,
              resaleClauseTermsVersion: it.resaleClauseTermsVersion ?? null,
              originalUnitPriceCents: it.originalUnitPriceCents ?? null,
              eventShareCents: it.eventShareCents ?? null,
              sharePayer: it.sharePayer ?? null,
            })),
          },
        },
      });
      return {
        id: order.id,
        amountGrossCents: order.amountGrossCents,
        feesPlatformCents: order.feesPlatformCents,
        currency: order.currency,
      };
    },

    createTaxLines: async (input: CreateOrderTaxLinesInput) => {
      if (input.lines.length === 0) return;
      await p.orderTaxLine.createMany({
        data: input.lines.map((line) => ({
          orderId: input.orderId,
          code: line.code,
          label: line.label,
          jurisdiction: line.jurisdiction,
          rateBps: line.rateBps,
          base: line.base,
          collector: line.collector,
          taxableAmountCents: line.taxableAmountCents,
          amountCents: line.amountCents,
        })),
      });
    },

    listTaxLines: async (orderId: string): Promise<OrderTaxLineRecord[]> => {
      const rows = await p.orderTaxLine.findMany({
        where: { orderId },
        // createMany stamps one createdAt per batch, so id breaks the tie
        // deterministically; callers must not read meaning into the order.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return rows.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        code: row.code,
        label: row.label,
        jurisdiction: row.jurisdiction,
        rateBps: row.rateBps,
        base: row.base,
        collector: row.collector,
        taxableAmountCents: row.taxableAmountCents,
        amountCents: row.amountCents,
        createdAt: row.createdAt,
      }));
    },

    listTaxLinesByOrderIds: async (
      orderIds: string[],
    ): Promise<Map<string, OrderTaxLineRecord[]>> => {
      const result = new Map<string, OrderTaxLineRecord[]>();
      if (orderIds.length === 0) return result;
      const rows = await p.orderTaxLine.findMany({
        where: { orderId: { in: [...new Set(orderIds)] } },
        // Same tie-break as `listTaxLines`, so each order's list reads alike.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      for (const row of rows) {
        const list = result.get(row.orderId) ?? [];
        list.push({
          id: row.id,
          orderId: row.orderId,
          code: row.code,
          label: row.label,
          jurisdiction: row.jurisdiction,
          rateBps: row.rateBps,
          base: row.base,
          collector: row.collector,
          taxableAmountCents: row.taxableAmountCents,
          amountCents: row.amountCents,
          createdAt: row.createdAt,
        });
        result.set(row.orderId, list);
      }
      return result;
    },

    getById: async (orderId: string) => {
      const order = await p.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) return null;
      return mapOrder(order);
    },

    getKindsByIds: async (orderIds: string[]) => {
      const result = new Map<string, OrderKind>();
      if (orderIds.length === 0) return result;
      // One batched projection for the whole payout batch — the classification
      // read that replaced the settlement-line join. Ids that name no order
      // are simply absent (the caller treats "unknown kind" as neither
      // ticketing nor membership, the fail-safe direction for the Connect fee).
      const rows = await p.order.findMany({
        where: { id: { in: [...new Set(orderIds)] } },
        select: { id: true, kind: true },
      });
      for (const row of rows) result.set(row.id, row.kind as OrderKind);
      return result;
    },

    updatePendingItems: async (input: UpdatePendingOrderItemsInput) => {
      // Compare-and-set on the cart state the use case accepts: PENDING and
      // not yet claimed by checkout (no PaymentIntent, no terms acceptance).
      // The use case checks this first, but between its read and this write
      // finalize or checkout can move the order on; a blind `update` would
      // then rewrite a paid order's amounts and `feePolicySnapshot` (which
      // decides the organiser credit at finalize). The guarded UPDATE also
      // takes the row lock, so the items swap below cannot race either.
      const run = async (tx: PrismaClientOrTx) => {
        const claimed = await tx.order.updateMany({
          where: {
            id: input.orderId,
            status: "PENDING",
            stripePaymentIntentId: null,
            termsAcceptedAt: null,
          },
          data: {
            amountGrossCents: input.amountGrossCents,
            feesPlatformCents: input.feesPlatformCents ?? 0,
            currency: input.currency,
            feePolicySnapshot: input.feePolicySnapshot ?? {},
          },
        });
        if (claimed.count === 0) return null;

        return tx.order.update({
          where: { id: input.orderId },
          data: {
            items: {
              deleteMany: {},
              create: input.items.map((it) => ({
                kind: it.kind,
                ticketTypeId: it.ticketTypeId ?? null,
                qty: it.qty,
                unitPriceCents: it.unitPriceCents,
                amountCents: it.amountCents,
                meta: it.meta ?? {},
                resaleListingId: it.resaleListingId ?? null,
                resaleFaceValueCents: it.resaleFaceValueCents ?? null,
                resaleProcessingPassThroughCents:
                  it.resaleProcessingPassThroughCents ?? 0,
                resaleProcessingFeeConfigRef:
                  it.resaleProcessingFeeConfigRef ?? null,
                resaleSaleCutoffAt: it.resaleSaleCutoffAt ?? null,
                resalePayoutReleaseAt: it.resalePayoutReleaseAt ?? null,
                resalePayoutStatus: it.resalePayoutStatus ?? null,
                resalePayoutHeldAt: it.resalePayoutHeldAt ?? null,
                resalePayoutHoldReason: it.resalePayoutHoldReason ?? null,
                resalePayoutNoticeSentAt: it.resalePayoutNoticeSentAt ?? null,
                resalePayoutReminderSentAt:
                  it.resalePayoutReminderSentAt ?? null,
                resalePayoutFinalNoticeSentAt:
                  it.resalePayoutFinalNoticeSentAt ?? null,
                // Resale share record (organiser-resale-share FR-003).
                resaleClauseType: it.resaleClauseType ?? null,
                resaleClauseBps: it.resaleClauseBps ?? null,
                resaleClauseCents: it.resaleClauseCents ?? null,
                resaleClausePayer: it.resaleClausePayer ?? null,
                resaleClauseTermsId: it.resaleClauseTermsId ?? null,
                resaleClauseTermsVersion: it.resaleClauseTermsVersion ?? null,
                originalUnitPriceCents: it.originalUnitPriceCents ?? null,
                eventShareCents: it.eventShareCents ?? null,
                sharePayer: it.sharePayer ?? null,
              })),
            },
          },
          include: { items: true },
        });
      };

      // One transaction: inside repos.tx() `p` is already a transaction
      // client; a root client wraps the two statements itself.
      const order =
        "$transaction" in p
          ? await (p as PrismaClient).$transaction((tx) => run(tx))
          : await run(p);

      return order ? mapOrder(order) : null;
    },

    listForOrg: async (
      input: ListOrdersForOrgInput,
    ): Promise<ListOrdersForOrgResult> => {
      const {
        orgId,
        eventId,
        searchQuery,
        status,
        disputeStatuses,
        occurredAtGte,
        occurredAtLte,
        sort = "occurredAt_desc",
        limit = 25,
        offset = 0,
        skipTotal = false,
      } = input;

      const searchWhere = orderSearchWhere(searchQuery);

      const where = {
        ...TICKETING_ONLY,
        ...(status ? { status } : {}),
        ...(disputeStatuses?.length
          ? { disputeStatus: { in: [...disputeStatuses] } }
          : {}),
        ...(eventId ? { eventId } : {}),
        ...(occurredAtGte || occurredAtLte
          ? {
              occurredAt: {
                ...(occurredAtGte ? { gte: occurredAtGte } : {}),
                ...(occurredAtLte ? { lte: occurredAtLte } : {}),
              },
            }
          : {}),
        event: { orgId },
        ...searchWhere,
      } as const;

      const [total, rows] = await Promise.all([
        // `skipTotal` callers get -1, never a plausible-looking 0.
        skipTotal ? Promise.resolve(-1) : p.order.count({ where }),
        p.order.findMany({
          where,
          orderBy: { occurredAt: sort === "occurredAt_asc" ? "asc" : "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            eventId: true,
            buyerHumanId: true,
            amountGrossCents: true,
            feesPlatformCents: true,
            taxAmountCents: true,
            currency: true,
            status: true,
            source: true,
            stripePaymentIntentId: true,
            occurredAt: true,
            disputeStatus: true,
            event: { select: { title: true } },
            buyer: {
              select: { name: true, authUser: { select: { email: true } } },
            },
          },
        }),
      ]);

      return {
        total,
        limit,
        offset,
        items: rows.map((row) => ({
          id: row.id,
          eventId: requireEventId(row.eventId, row.id),
          eventTitle: requireEvent(row.event, row.id).title,
          buyerHumanId: row.buyerHumanId,
          buyerName: row.buyer.name ?? null,
          buyerEmail: row.buyer.authUser?.email ?? null,
          amountGrossCents: row.amountGrossCents,
          feesPlatformCents: row.feesPlatformCents,
          taxAmountCents: row.taxAmountCents,
          currency: row.currency,
          status: row.status as OrderStatus,
          stripePaymentIntentId: row.stripePaymentIntentId,
          occurredAt: row.occurredAt,
          source: row.source as OrderSource,
          disputeStatus: (row.disputeStatus ?? null) as DisputeStatus | null,
        })),
      };
    },

    listForHumanOwnedEvents: async (
      input: ListOrdersForHumanOwnedEventsInput,
    ): Promise<ListOrdersForHumanOwnedEventsResult> => {
      const {
        ownerHumanId,
        eventId,
        orgId,
        searchQuery,
        status,
        disputeStatuses,
        occurredAtGte,
        occurredAtLte,
        sort = "occurredAt_desc",
        limit = 25,
        offset = 0,
        skipTotal = false,
      } = input;

      const searchWhere = orderSearchWhere(searchQuery);

      const where = {
        ...TICKETING_ONLY,
        ...(status ? { status } : {}),
        ...(disputeStatuses?.length
          ? { disputeStatus: { in: [...disputeStatuses] } }
          : {}),
        ...(eventId ? { eventId } : {}),
        ...(occurredAtGte || occurredAtLte
          ? {
              occurredAt: {
                ...(occurredAtGte ? { gte: occurredAtGte } : {}),
                ...(occurredAtLte ? { lte: occurredAtLte } : {}),
              },
            }
          : {}),
        event: {
          humanId: ownerHumanId,
          ...(orgId ? { orgId } : {}),
        },
        ...searchWhere,
      } as const;

      const [total, rows] = await Promise.all([
        // `skipTotal` callers get -1, never a plausible-looking 0.
        skipTotal ? Promise.resolve(-1) : p.order.count({ where }),
        p.order.findMany({
          where,
          orderBy: { occurredAt: sort === "occurredAt_asc" ? "asc" : "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            eventId: true,
            buyerHumanId: true,
            amountGrossCents: true,
            feesPlatformCents: true,
            taxAmountCents: true,
            currency: true,
            status: true,
            source: true,
            stripePaymentIntentId: true,
            occurredAt: true,
            disputeStatus: true,
            event: { select: { title: true, orgId: true } },
            buyer: {
              select: { name: true, authUser: { select: { email: true } } },
            },
          },
        }),
      ]);

      return {
        total,
        limit,
        offset,
        items: rows.map((row) => {
          const event = requireEvent(row.event, row.id);
          return {
            id: row.id,
            eventId: requireEventId(row.eventId, row.id),
            eventTitle: event.title,
            buyerHumanId: row.buyerHumanId,
            buyerName: row.buyer.name ?? null,
            buyerEmail: row.buyer.authUser?.email ?? null,
            amountGrossCents: row.amountGrossCents,
            feesPlatformCents: row.feesPlatformCents,
            taxAmountCents: row.taxAmountCents,
            currency: row.currency,
            status: row.status as OrderStatus,
            stripePaymentIntentId: row.stripePaymentIntentId,
            occurredAt: row.occurredAt,
            orgId: event.orgId,
            source: row.source as OrderSource,
            disputeStatus: (row.disputeStatus ?? null) as DisputeStatus | null,
          };
        }),
      };
    },

    findForOwner: async (
      input: FindOrderForOwnerInput,
    ): Promise<FindOrderForOwnerResult | null> => {
      const identifierClauses: PrismaNamespace.OrderWhereInput[] = [
        ...(input.id ? [{ id: input.id }] : []),
        ...(input.idSuffix
          ? [
              {
                id: {
                  endsWith: input.idSuffix,
                  mode: "insensitive" as const,
                },
              },
            ]
          : []),
      ];

      // No identifier ⇒ nothing to find. Never fall through to a query whose
      // only predicate is the owner scope, which would return an arbitrary
      // order.
      if (identifierClauses.length === 0) return null;

      // TENANCY: the owner scope is ANDed into the SAME where-clause as the
      // identifier. There is deliberately no "fetch then compare ownership"
      // branch — a foreign org's order id and a nonexistent one both fall out
      // of this single query as `null`, so nothing can leak existence.
      //
      // `take: 2`, not `findFirst`: the `idSuffix` arm is only 32 bits and can
      // legitimately match two of the owner's orders. Fetching one extra row
      // lets us detect that and return `null` (see FindOrderForOwnerInput's
      // ambiguity contract) instead of silently presenting an arbitrary row as
      // "the" order. The exact arms are DB-unique, so they can never trip it.
      const rows = await p.order.findMany({
        where: {
          OR: identifierClauses,
          event: ownerEventScopeWhere(input),
        },
        take: 2,
        select: {
          id: true,
          eventId: true,
          buyerHumanId: true,
          amountGrossCents: true,
          currency: true,
          status: true,
          occurredAt: true,
          event: { select: { title: true } },
          buyer: {
            select: { name: true, authUser: { select: { email: true } } },
          },
        },
      });

      // Ambiguous ⇒ no answer, deliberately indistinguishable from no match.
      if (rows.length !== 1) return null;
      const row = rows[0]!;

      return {
        id: row.id,
        eventId: requireEventId(row.eventId, row.id),
        eventTitle: requireEvent(row.event, row.id).title,
        buyerHumanId: row.buyerHumanId,
        buyerName: row.buyer.name ?? null,
        buyerEmail: row.buyer.authUser?.email ?? null,
        amountGrossCents: row.amountGrossCents,
        currency: row.currency,
        status: row.status as OrderStatus,
        occurredAt: row.occurredAt,
      };
    },

    countDistinctBuyersForOwner: async (
      input: CountDistinctBuyersForOwnerInput,
    ): Promise<number> => {
      // DRIVEN FROM `Order`, NOT `Human`, on purpose.
      //
      // The obvious formulation — `p.human.count({ where: { name: ILIKE …,
      // orders: { some } } })` — returns a single aggregate row, which looks
      // strictly better. But `Human.name` has NO index (the table carries only
      // its PK and the ICS-feed token unique), so `name ILIKE '%q%'` is
      // unsargable and the planner is free to drive from `Human`: a full scan
      // of the PLATFORM'S ENTIRE human table on every debounced admin
      // keystroke. That bet cannot be measured away on a dev DB with 28
      // humans, so take the shape whose cost is structurally bounded instead.
      //
      // This groupBy is bounded by the OWNER'S orders. The trade accepted: it
      // materialises one row per distinct buyer (a single id column) rather
      // than one aggregate row. Prisma has no COUNT(DISTINCT), and $queryRaw
      // appears nowhere in this adapter — not worth introducing for this.
      // SAME PREDICATE BUILDER AS THE LISTS — `orderSearchWhere`, not
      // `buyerSearchWhere`. This count is compared directly against a page
      // produced by `listForOrg` / `listForHumanOwnedEvents` (as
      // `counts.attendees.total` vs `.shown`), so the two MUST select from the
      // same set. When they didn't, an id-shaped query rendered a visible
      // attendee row under the header "0 attendees": the list matched the
      // order via its identifier arm, the count only ever looked at buyer
      // name/email. Any future search arm added to one is now added to both by
      // construction.
      const groups = await p.order.groupBy({
        by: ["buyerHumanId"],
        where: {
          // Same TICKETING narrowing as the lists this count is compared
          // against — a membership order must not add an "attendee".
          ...TICKETING_ONLY,
          event: ownerEventScopeWhere(input),
          ...orderSearchWhere(input.searchQuery),
        },
      });

      return groups.length;
    },

    summarizeBuyerOrdersForOwner: async (
      input: SummarizeBuyerOrdersForOwnerInput,
    ): Promise<BuyerOrderSummary[]> => {
      const buyerHumanIds = Array.from(new Set(input.buyerHumanIds));
      if (buyerHumanIds.length === 0) return [];

      // Bounded by the caller's id list (a page of buyers), so this is a
      // single grouped aggregate — never an N+1 over buyers.
      //
      // STATUS-FILTERED to completed checkouts. Without this, a buyer who
      // abandoned three carts yesterday reads as "4 orders · last yesterday"
      // when they have one real purchase from March — a number that actively
      // misinforms, which is the same defect class as a saturating count.
      // A buyer whose orders are ALL pending therefore gets no row back; the
      // caller must read that as zero, not as unknown.
      const groups = await p.order.groupBy({
        by: ["buyerHumanId"],
        where: {
          buyerHumanId: { in: buyerHumanIds },
          event: ownerEventScopeWhere(input),
          status: { in: [...COMPLETED_ORDER_STATUSES] },
        },
        _count: { _all: true },
        _max: { occurredAt: true },
      });

      return groups.map((group) => ({
        buyerHumanId: group.buyerHumanId,
        orderCount: group._count._all,
        lastOrderAt: group._max.occurredAt ?? null,
      }));
    },

    listByBuyer: async (
      input: ListOrdersByBuyerInput,
    ): Promise<ListOrdersByBuyerResult> => {
      const {
        buyerHumanId,
        extraOrderIds,
        statuses,
        sort = "occurredAt_desc",
        limit = 25,
        offset = 0,
      } = input;

      const dedupedExtraIds = extraOrderIds?.length
        ? Array.from(new Set(extraOrderIds))
        : [];

      const buyerOrTransfer: PrismaNamespace.OrderWhereInput =
        dedupedExtraIds.length > 0
          ? { OR: [{ buyerHumanId }, { id: { in: dedupedExtraIds } }] }
          : { buyerHumanId };

      const where: PrismaNamespace.OrderWhereInput = {
        // "My orders" is the ticket list — every field on the item type
        // (eventName, eventStartsAt, eventVenue) is event-shaped. Membership
        // invoices belong in their own list rather than rendering blank rows
        // here.
        ...TICKETING_ONLY,
        ...buyerOrTransfer,
        ...(statuses?.length ? { status: { in: statuses } } : {}),
      };

      const [total, rows] = await Promise.all([
        p.order.count({ where }),
        p.order.findMany({
          where,
          orderBy: { occurredAt: sort === "occurredAt_asc" ? "asc" : "desc" },
          skip: offset,
          take: limit,
          include: {
            event: {
              select: {
                title: true,
                slug: true,
                startsAt: true,
                // Raw privacy inputs only. Whether the holder may see the
                // venue's name is decided in core (`listMyOrders` →
                // `resolveHolderAddress`), never here.
                locationMode: true,
                locationRadiusMeters: true,
                locationLabel: true,
                addressRevealAt: true,
                addressRevealPreset: true,
                locality: true,
                region: true,
                // Raw venue-confirmation inputs; the rule is core's.
                placeId: true,
                orgId: true,
                humanId: true,
                stewardship: true,
                venueConfirmedAt: true,
                venueConfirmationWithdrawnAt: true,
                venueConfirmedPlaceId: true,
                venueConfirmedStartsAt: true,
                place: {
                  select: {
                    name: true,
                    city: true,
                    locationMode: true,
                    locationRadiusMeters: true,
                  },
                },
              },
            },
            _count: { select: { tickets: true } },
            // Tier names for the wallet row's meta line. Selected rather than
            // counted because the NAMES are what gets rendered; `_count` above
            // still carries the quantity, so "N tickets" never depends on this.
            tickets: {
              select: { ticketType: { select: { name: true } } },
              orderBy: { createdAt: "asc" },
            },
            // Inputs of the buyer charge breakdown, decided in core.
            items: { select: { kind: true, amountCents: true, meta: true } },
          },
        }),
      ]);

      return {
        total,
        limit,
        offset,
        items: rows.map((row) => {
          const event = requireEvent(row.event, row.id);

          return {
            id: row.id,
            eventId: requireEventId(row.eventId, row.id),
            eventSlug: event.slug ?? null,
            eventName: event.title,
            eventStartsAt: event.startsAt,
            // Fail-closed mode mapping: only the literal "EXACT" stays EXACT.
            eventLocation: {
              locationMode: event.locationMode === "EXACT" ? "EXACT" : "OBSCURED",
              locationRadiusMeters: event.locationRadiusMeters ?? null,
              locationLabel: event.locationLabel ?? null,
              addressRevealAt: event.addressRevealAt ?? null,
              addressRevealPreset: (event.addressRevealPreset ??
                null) as AddressRevealPreset | null,
              locality: event.locality ?? null,
              region: event.region ?? null,
              placeId: event.placeId ?? null,
              orgId: event.orgId ?? null,
              humanId: event.humanId ?? null,
              stewardship: event.stewardship,
              venueConfirmedAt: event.venueConfirmedAt ?? null,
              venueConfirmationWithdrawnAt:
                event.venueConfirmationWithdrawnAt ?? null,
              venueConfirmedPlaceId: event.venueConfirmedPlaceId ?? null,
              venueConfirmedStartsAt: event.venueConfirmedStartsAt ?? null,
              startsAt: event.startsAt,
              place: event.place
                ? {
                    name: event.place.name,
                    city: event.place.city ?? null,
                    locationMode:
                      event.place.locationMode === "EXACT" ? "EXACT" : "OBSCURED",
                    locationRadiusMeters:
                      event.place.locationRadiusMeters ?? null,
                  }
                : null,
            },
            amountGrossCents: row.amountGrossCents,
            feesPlatformCents: row.feesPlatformCents,
            taxAmountCents: row.taxAmountCents,
            feePolicySnapshot: row.feePolicySnapshot,
            stripePaymentIntentId: row.stripePaymentIntentId ?? null,
            buyerHumanId: row.buyerHumanId,
            chargeLines: (row.items ?? []).map((item) => ({
              kind: item.kind,
              amountCents: item.amountCents,
              meta: item.meta,
            })),
            currency: row.currency,
            status: row.status as OrderStatus,
            occurredAt: row.occurredAt,
            source: row.source as OrderSource,
            ticketCount: row._count.tickets,
            // Distinct, issue-ordered. Two GA tickets are one tier, not two,
            // and a ticket whose type was deleted (`ticketTypeId` is nullable
            // on SetNull) contributes nothing rather than an empty string.
            tiers: Array.from(
              new Set(
                row.tickets
                  .map((ticket) => ticket.ticketType?.name?.trim())
                  .filter((name): name is string => Boolean(name)),
              ),
            ),
          };
        }),
      };
    },

    searchEventAttendees: async (
      input: SearchEventAttendeesInput,
    ): Promise<SearchEventAttendeesResult> => {
      const {
        orgId,
        eventId,
        searchQuery,
        status,
        limit = 25,
        offset = 0,
      } = input;

      // Build buyer search conditions when a search query is provided
      const buyerSearch = searchQuery?.trim()
        ? {
            buyer: {
              OR: [
                {
                  name: {
                    contains: searchQuery.trim(),
                    mode: "insensitive" as const,
                  },
                },
                {
                  authUser: {
                    email: {
                      contains: searchQuery.trim(),
                      mode: "insensitive" as const,
                    },
                  },
                },
              ],
            },
          }
        : {};

      const where: PrismaNamespace.OrderWhereInput = {
        eventId,
        event: { orgId },
        // Only show completed orders (not pending/cancelled)
        ...(status
          ? { status }
          : { status: { in: ["SUCCEEDED", "PART_REFUNDED"] } }),
        ...buyerSearch,
      };

      const [total, rows] = await Promise.all([
        p.order.count({ where }),
        p.order.findMany({
          where,
          orderBy: { occurredAt: "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            buyerHumanId: true,
            amountGrossCents: true,
            currency: true,
            status: true,
            occurredAt: true,
            // A comp IS a $0 order, so without this the attendees table shows
            // it as "$0.00 SUCCEEDED" — visually identical to a genuinely free
            // ticket. Selected so the row can be badged.
            source: true,
            buyer: {
              select: { name: true, authUser: { select: { email: true } } },
            },
            _count: { select: { tickets: true } },
          },
        }),
      ]);

      return {
        total,
        limit,
        offset,
        items: rows.map((row) => ({
          orderId: row.id,
          buyerHumanId: row.buyerHumanId,
          buyerName: row.buyer.name ?? null,
          buyerEmail: row.buyer.authUser?.email ?? null,
          ticketCount: row._count.tickets,
          amountGrossCents: row.amountGrossCents,
          currency: row.currency,
          status: row.status as OrderStatus,
          source: row.source as OrderSource,
          occurredAt: row.occurredAt,
        })),
      };
    },

    listEventCompOrders: async (
      input: ListEventCompOrdersInput,
    ): Promise<ListEventCompOrdersResult> => {
      const { eventId, limit = 25, offset = 0 } = input;

      // eventId + source only. NO status filter: a revoked volunteer reward
      // leaves a CANCELLED comp, and the ledger's job is to show that a comp
      // was issued at all. Served by Order_eventId_occurredAt_idx with `source`
      // filtered in-heap — deliberately un-indexed, see the
      // 20260730120000_order_comp_provenance migration.
      const where: PrismaNamespace.OrderWhereInput = {
        eventId,
        source: "COMP",
      };

      const [total, rows] = await Promise.all([
        p.order.count({ where }),
        p.order.findMany({
          where,
          // `id` breaks ties. Two comps issued in the same millisecond (a
          // batched reward fire) would otherwise be free to swap places between
          // page requests, which under offset paging duplicates one row and
          // drops another.
          orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
          skip: offset,
          take: limit,
          select: {
            id: true,
            occurredAt: true,
            status: true,
            compReason: true,
            // No FK by design — this is an id, not a relation. The use case
            // resolves the display name separately and tolerates a miss.
            compIssuedByHumanId: true,
            buyerHumanId: true,
            buyer: {
              select: { name: true, authUser: { select: { email: true } } },
            },
            items: {
              where: { kind: "ticket" },
              select: {
                qty: true,
                ticketTypeId: true,
                ticketType: { select: { name: true } },
              },
            },
            // THE discriminator between a trigger-issued comp and a
            // hand-issued one with no stamped provenance. Removing this from
            // the select silently collapses every row to HAND_ISSUED — pinned
            // by the adapter test, because the core tests feed the flag in
            // from a fixture and would stay green.
            //
            // `take: 1` needs no `orderBy`: only EXISTENCE is read (the port
            // field is a boolean), so which row comes back cannot matter.
            volunteerRewardGrants: { select: { id: true }, take: 1 },
          },
        }),
      ]);

      return {
        total,
        limit,
        offset,
        items: rows.map((row) => {
          // Group ticket lines by type. `quantity` sums EVERY ticket line,
          // including any with a null ticketTypeId, so the headline count can
          // never under-report what was minted.
          const byType = new Map<
            string,
            { ticketTypeId: string; name: string | null; quantity: number }
          >();
          let quantity = 0;

          for (const item of row.items) {
            quantity += item.qty;
            if (!item.ticketTypeId) continue;
            const existing = byType.get(item.ticketTypeId);
            if (existing) {
              existing.quantity += item.qty;
            } else {
              byType.set(item.ticketTypeId, {
                ticketTypeId: item.ticketTypeId,
                name: item.ticketType?.name ?? null,
                quantity: item.qty,
              });
            }
          }

          return {
            orderId: row.id,
            occurredAt: row.occurredAt,
            status: row.status as OrderStatus,
            recipientHumanId: row.buyerHumanId,
            recipientName: row.buyer.name ?? null,
            recipientEmail: row.buyer.authUser?.email ?? null,
            ticketTypes: [...byType.values()],
            quantity,
            reason: row.compReason ?? null,
            issuedByHumanId: row.compIssuedByHumanId ?? null,
            hasVolunteerRewardGrant: row.volunteerRewardGrants.length > 0,
          };
        }),
      };
    },

    listPendingCarts: async (
      input: ListPendingCartsInput,
    ): Promise<ListPendingCartsResult> => {
      const { buyerHumanId, holdExpiresAfter, limit = 5 } = input;

      // Find PENDING orders for this buyer where at least one item has a holdExpiresAt > now
      const rows = await p.order.findMany({
        where: {
          buyerHumanId,
          status: "PENDING",
        },
        include: {
          event: {
            select: {
              id: true,
              title: true,
              slug: true,
              startsAt: true,
            },
          },
          // Every line — ticket AND discount — so the use case can recover
          // the pre-discount gross and the codes a createCheckout-written
          // cart was priced with. The ticket summary below filters back to
          // `kind === "ticket"`.
          items: {
            include: {
              ticketType: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit * 2, // Fetch extra since we filter in memory
      });

      // Filter to only orders with active holds
      const holdExpiresAfterMs = holdExpiresAfter.getTime();
      const activeOrders: PendingCartItem[] = [];

      for (const row of rows) {
        // Find the latest holdExpiresAt from ticket items
        let latestHoldExpiry: Date | null = null;

        for (const item of row.items) {
          const meta = item.meta as { holdExpiresAt?: string } | null;
          if (meta?.holdExpiresAt) {
            const expiry = new Date(meta.holdExpiresAt);
            if (!latestHoldExpiry || expiry > latestHoldExpiry) {
              latestHoldExpiry = expiry;
            }
          }
        }

        // Only include if hold is still active
        if (
          latestHoldExpiry &&
          latestHoldExpiry.getTime() > holdExpiresAfterMs
        ) {
          const event = requireEvent(row.event, row.id);
          activeOrders.push({
            id: row.id,
            eventId: event.id,
            eventName: event.title,
            eventSlug: event.slug,
            eventStartsAt: event.startsAt,
            amountGrossCents: row.amountGrossCents,
            feesPlatformCents: row.feesPlatformCents,
            lines: row.items.map((item) => ({
              kind: item.kind,
              amountCents: item.amountCents,
              meta: item.meta,
            })),
            currency: row.currency,
            holdExpiresAt: latestHoldExpiry,
            createdAt: row.createdAt,
            // Exactly the lines the old `where: { kind: "ticket" }` read.
            ticketSummary: aggregateTicketSummary(
              row.items.filter((item) => item.kind === "ticket"),
            ),
          });

          if (activeOrders.length >= limit) break;
        }
      }

      return { items: activeOrders };
    },

    updateResaleOrderItemFinanceState: async (input) => {
      const existing = await p.orderItem.findUnique({
        where: { id: input.orderItemId },
        select: orderItemFinanceSelect,
      });
      if (!existing) return null;

      const updated = await p.orderItem.update({
        where: { id: input.orderItemId },
        data: {
          resalePayoutReleaseAt:
            input.resalePayoutReleaseAt !== undefined
              ? input.resalePayoutReleaseAt
              : undefined,
          resalePayoutStatus:
            input.resalePayoutStatus !== undefined
              ? input.resalePayoutStatus
              : undefined,
          resalePayoutHeldAt:
            input.resalePayoutHeldAt !== undefined
              ? input.resalePayoutHeldAt
              : undefined,
          resalePayoutHoldReason:
            input.resalePayoutHoldReason !== undefined
              ? input.resalePayoutHoldReason
              : undefined,
          resalePayoutNoticeSentAt:
            input.resalePayoutNoticeSentAt !== undefined
              ? input.resalePayoutNoticeSentAt
              : undefined,
          resalePayoutReminderSentAt:
            input.resalePayoutReminderSentAt !== undefined
              ? input.resalePayoutReminderSentAt
              : undefined,
          resalePayoutFinalNoticeSentAt:
            input.resalePayoutFinalNoticeSentAt !== undefined
              ? input.resalePayoutFinalNoticeSentAt
              : undefined,
        },
        select: orderItemFinanceSelect,
      });

      return mapOrderItem(updated, updated.orderId);
    },

    cancelPendingOrder: async (
      orderId: string,
      opts?: { expectedPaymentIntentId: string | null },
    ): Promise<boolean> => {
      // Only cancel if status is PENDING — and, when the caller settled a
      // PaymentIntent from an earlier read, only if the order still carries
      // that one (`null` matches IS NULL). See the port.
      const result = await p.order.updateMany({
        where: {
          id: orderId,
          status: "PENDING",
          ...(opts
            ? { stripePaymentIntentId: opts.expectedPaymentIntentId }
            : {}),
        },
        data: {
          status: "CANCELLED",
        },
      });

      return result.count > 0;
    },

    cancelProcessingOrder: async (orderId: string): Promise<boolean> => {
      // Only cancel if status is PROCESSING (delayed payment that failed)
      const result = await p.order.updateMany({
        where: {
          id: orderId,
          status: "PROCESSING",
        },
        data: {
          status: "CANCELLED",
        },
      });

      return result.count > 0;
    },

    cancelCompOrder: async (orderId: string): Promise<boolean> => {
      // Void a revoked volunteer-reward comp: only a SUCCEEDED, source=COMP
      // ($0) order flips to CANCELLED. The guards make this safe against any
      // paid order — there is nothing to refund on a comp. Idempotent: a
      // double-revoke or an already-cancelled order matches nothing.
      const result = await p.order.updateMany({
        where: {
          id: orderId,
          status: "SUCCEEDED",
          source: "COMP",
        },
        data: {
          status: "CANCELLED",
        },
      });

      return result.count > 0;
    },

    clearPaymentIntent: async (orderId: string) => {
      await p.order.update({
        where: { id: orderId },
        data: { stripePaymentIntentId: null },
      });
    },

    linkPaymentIntent: async (orderId: string, piId: string) => {
      try {
        await p.order.update({
          where: { id: orderId },
          data: { stripePaymentIntentId: piId },
        });
      } catch (err: any) {
        // Ignore unique constraint violations — the PI is already linked
        // (createCheckout links it, then the webhook tries again via finalize)
        if (err?.code === "P2002") return;
        throw err;
      }
    },

    linkPaymentIntentIfPending: async (
      orderId: string,
      piId: string,
      opts?: { allowProcessing?: boolean },
    ): Promise<boolean> => {
      // One conditional UPDATE, so a concurrent retire/release/reap that
      // cancels the order cannot interleave between a read and the write.
      // A unique violation (the PI already belongs to ANOTHER order) is NOT
      // swallowed here, unlike `linkPaymentIntent`: createCheckout's PI carries
      // this order's fresh id in its metadata, so that cannot happen, and if it
      // ever does it must surface.
      const result = await p.order.updateMany({
        where: {
          id: orderId,
          status: opts?.allowProcessing
            ? { in: ["PENDING", "PROCESSING"] }
            : "PENDING",
          OR: [
            { stripePaymentIntentId: null },
            { stripePaymentIntentId: piId },
          ],
        },
        data: { stripePaymentIntentId: piId },
      });
      return result.count > 0;
    },

    findByPaymentIntent: async (piId: string) => {
      const o = await p.order.findUnique({
        where: { stripePaymentIntentId: piId },
        select: { id: true, status: true },
      });
      if (!o) return null;
      return { id: o.id, status: o.status as OrderStatus };
    },

    findByStripeInvoiceId: async (stripeInvoiceId: string) => {
      // Deliberately the FULL record, not the `{ id, status }` projection
      // `findByPaymentIntent` returns: the membership invoice path replays this
      // row straight back to the caller as the already-materialised order.
      const order = await p.order.findUnique({
        where: { stripeInvoiceId },
        include: { items: true },
      });
      if (!order) return null;
      return mapOrder(order);
    },

    markSucceeded: async (orderId: string) => {
      await p.order.update({
        where: { id: orderId },
        data: { status: "SUCCEEDED" },
      });
    },

    markProcessing: async (orderId: string) => {
      await p.order.update({
        where: { id: orderId },
        data: { status: "PROCESSING" },
      });
    },

    markSucceededIfOpen: async (orderId: string): Promise<boolean> => {
      const result = await p.order.updateMany({
        where: { id: orderId, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "SUCCEEDED" },
      });
      return result.count > 0;
    },

    markProcessingIfPending: async (orderId: string): Promise<boolean> => {
      const result = await p.order.updateMany({
        where: { id: orderId, status: "PENDING" },
        data: { status: "PROCESSING" },
      });
      return result.count > 0;
    },

    markRefunded: async (orderId: string, partialCents?: number) => {
      // `undefined` is the only "whole order" signal. A partial refund of 0
      // cents (a ticket that cost $0, refunded beside tickets the buyer
      // keeps) is still partial; a truthiness test would have closed the
      // order as REFUNDED.
      await p.order.update({
        where: { id: orderId },
        data: {
          status: partialCents === undefined ? "REFUNDED" : "PART_REFUNDED",
        },
      });
    },

    markRefundedIfSucceeded: async (orderId: string): Promise<boolean> => {
      const result = await p.order.updateMany({
        where: { id: orderId, status: "SUCCEEDED" },
        data: { status: "REFUNDED" },
      });
      return result.count > 0;
    },

    listCancelledEventIdsWithOpenDoorOrders: async ({
      limit,
      excludeOrderIds,
    }) => {
      // Raw SQL because the cash half is a ledger predicate and the ledger
      // has no Prisma relation to Order. Parameterised, never interpolated.
      // The debit predicate is the cutover marker (see the port doc): cash
      // sales from before the door was priced carry no debit and are never
      // listed, so the sweep cannot rewrite an old cancellation.
      const excluded = [...(excludeOrderIds ?? [])];
      const rows = await p.$queryRaw<Array<{ eventId: string }>>(
        PrismaNamespace.sql`
          SELECT o."eventId" AS "eventId"
          FROM public."Order" o
          JOIN public."Event" ev ON ev."id" = o."eventId"
          WHERE ev."status" = 'CANCELLED'
            AND NOT (o."id" = ANY(${excluded}::text[]))
            AND (
              (o."paymentChannel" = 'POS' AND o."status" = 'PENDING')
              OR (
                o."paymentChannel" = 'CASH'
                AND o."status" = 'SUCCEEDED'
                AND ${unreversedCashSaleDebitSql}
              )
            )
          GROUP BY o."eventId"
          ORDER BY MIN(o."occurredAt") ASC, o."eventId" ASC
          LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 500))}
        `,
      );
      return rows.map((r) => r.eventId);
    },

    listSucceededCashOrderIdsForEvent: async ({
      eventId,
      unreversedCashSaleDebitOnly,
      afterId,
      limit,
    }) => {
      const rows = await p.$queryRaw<Array<{ id: string }>>(
        PrismaNamespace.sql`
          SELECT o."id" AS "id"
          FROM public."Order" o
          WHERE o."eventId" = ${eventId}
            AND o."paymentChannel" = 'CASH'
            AND o."status" = 'SUCCEEDED'
            AND o."id" > ${afterId ?? ""}
            AND (${!unreversedCashSaleDebitOnly}::boolean OR ${unreversedCashSaleDebitSql})
          ORDER BY o."id" ASC
          LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 500))}
        `,
      );
      return rows.map((r) => r.id);
    },

    listOpenDoorCardSalesOnCancelledEvents: async (
      cancelledBefore,
      sampleLimit,
    ) => {
      // Same grace rule as the cancelled-event cash invariant: the event's
      // last change must be at or before the cutoff, so a cancellation whose
      // door phase (or the next sweep) is still running is not flagged yet.
      const limit = Math.max(1, Math.min(20, Math.trunc(sampleLimit ?? 20)));
      const rows = await p.$queryRaw<
        Array<{
          orderId: string;
          eventId: string;
          status: "SUCCEEDED" | "PENDING";
          paymentIntentId: string | null;
          currency: string;
          amountGrossCents: number;
          totalCount: bigint;
        }>
      >(PrismaNamespace.sql`
        SELECT
          o."id" AS "orderId",
          ev."id" AS "eventId",
          o."status"::text AS "status",
          o."stripePaymentIntentId" AS "paymentIntentId",
          o."currency" AS "currency",
          o."amountGrossCents" AS "amountGrossCents",
          COUNT(*) OVER ()::bigint AS "totalCount"
        FROM public."Order" o
        JOIN public."Event" ev ON ev."id" = o."eventId"
        WHERE ev."status" = 'CANCELLED'
          AND ev."updatedAt" <= ${cancelledBefore}
          AND o."paymentChannel" = 'POS'
          AND (
            (o."status" = 'SUCCEEDED' AND o."stripePaymentIntentId" IS NOT NULL)
            OR o."status" = 'PENDING'
          )
        ORDER BY ev."updatedAt" ASC, o."id" ASC
        LIMIT ${limit}
      `);
      return {
        total: rows.length > 0 ? Number(rows[0]!.totalCount) : 0,
        rows: rows.map((r) => ({
          orderId: r.orderId,
          eventId: r.eventId,
          status: r.status,
          paymentIntentId: r.paymentIntentId,
          currency: r.currency,
          amountGrossCents: Number(r.amountGrossCents),
        })),
      };
    },

    setPaymentMethodType: async (orderId: string, methodType: string) => {
      await p.order.update({
        where: { id: orderId },
        data: { paymentMethodType: methodType },
      });
    },

    setPaymentCardChecks: async (orderId, checks) => {
      await p.order.update({
        where: { id: orderId },
        data: {
          paymentCardChecks:
            checks === null
              ? PrismaNamespace.JsonNull
              : ({
                  addressLine1Check: checks.addressLine1Check,
                  addressPostalCodeCheck: checks.addressPostalCodeCheck,
                  cvcCheck: checks.cvcCheck,
                } satisfies PrismaNamespace.InputJsonObject),
        },
      });
    },

    markDisputeStatus: async (input) => {
      await p.order.update({
        where: { id: input.orderId },
        data: {
          disputeStatus: input.disputeStatus,
          disputedAt:
            input.disputedAt !== undefined ? input.disputedAt : undefined,
        },
      });
    },

    getEventAttributionByIds: async (
      orderIds: string[],
    ): Promise<Map<string, OrderEventAttribution>> => {
      const result = new Map<string, OrderEventAttribution>();
      if (orderIds.length === 0) return result;
      // ONE batched projection with the event joined, for a whole page of
      // ledger credits — never one query per credit line. Ids that name no
      // order are simply absent (the caller renders "unattributed" rather
      // than dropping the money line).
      const rows = await p.order.findMany({
        where: { id: { in: [...new Set(orderIds)] } },
        select: {
          id: true,
          shortId: true,
          kind: true,
          eventId: true,
          event: { select: { title: true, slug: true, startsAt: true } },
        },
      });
      for (const row of rows) {
        result.set(row.id, {
          orderId: row.id,
          orderCode: row.shortId ?? null,
          kind: row.kind as OrderKind,
          // A MEMBERSHIP order has no event, and a deleted event leaves the
          // relation null under a non-null `eventId`. Both surface as nulls
          // here rather than as a half-populated row.
          eventId: row.event ? row.eventId : null,
          eventTitle: row.event?.title ?? null,
          eventSlug: row.event?.slug ?? null,
          eventStartsAt: row.event?.startsAt ?? null,
        });
      }
      return result;
    },

    listAll: async (
      input: ListAllOrdersInput,
    ): Promise<ListAllOrdersResult> => {
      const {
        orgId,
        eventId,
        buyerHumanId,
        searchQuery,
        status,
        statuses,
        disputeStatuses,
        source,
        occurredAtGte,
        occurredAtLte,
        sort = "occurredAt_desc",
        limit = 25,
        offset = 0,
      } = input;

      const trimmed = searchQuery?.trim();

      // Search buyer name/email OR order ID
      const searchConditions = trimmed
        ? {
            OR: [
              {
                buyer: {
                  OR: [
                    {
                      name: { contains: trimmed, mode: "insensitive" as const },
                    },
                    {
                      authUser: {
                        email: {
                          contains: trimmed,
                          mode: "insensitive" as const,
                        },
                      },
                    },
                  ],
                },
              },
              { id: { contains: trimmed, mode: "insensitive" as const } },
            ],
          }
        : {};

      const orderStatusFilter: PrismaNamespace.OrderWhereInput =
        statuses?.length
          ? { status: { in: statuses } }
          : status
            ? { status }
            : {};
      // Dispute-mirror arm (see resolveOrderStatusFilter in core). ORed with
      // the order-status arm when both are present (multi-select
      // "SUCCEEDED + DISPUTED"); alone it is a plain AND clause. The OR is
      // nested under AND so it can't collide with the search OR below.
      const disputeFilter: PrismaNamespace.OrderWhereInput | null =
        disputeStatuses?.length
          ? { disputeStatus: { in: [...disputeStatuses] } }
          : null;
      const statusFilter: PrismaNamespace.OrderWhereInput =
        disputeFilter && Object.keys(orderStatusFilter).length > 0
          ? { AND: [{ OR: [orderStatusFilter, disputeFilter] }] }
          : (disputeFilter ?? orderStatusFilter);

      const where = {
        ...statusFilter,
        ...(eventId ? { eventId } : {}),
        ...(buyerHumanId ? { buyerHumanId } : {}),
        ...(orgId ? { event: { orgId } } : {}),
        ...(source ? { source } : {}),
        ...(occurredAtGte || occurredAtLte
          ? {
              occurredAt: {
                ...(occurredAtGte ? { gte: occurredAtGte } : {}),
                ...(occurredAtLte ? { lte: occurredAtLte } : {}),
              },
            }
          : {}),
        ...searchConditions,
      } as PrismaNamespace.OrderWhereInput;

      const [total, rows] = await Promise.all([
        p.order.count({ where }),
        p.order.findMany({
          where,
          orderBy: { occurredAt: sort === "occurredAt_asc" ? "asc" : "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            eventId: true,
            kind: true,
            buyerHumanId: true,
            amountGrossCents: true,
            feesPlatformCents: true,
            taxAmountCents: true,
            currency: true,
            status: true,
            source: true,
            stripePaymentIntentId: true,
            paymentMethodType: true,
            occurredAt: true,
            createdAt: true,
            updatedAt: true,
            feePolicySnapshot: true,
            billingCountry: true,
            billingAddressLine1: true,
            billingAddressLine2: true,
            billingCity: true,
            billingState: true,
            billingPostalCode: true,
            stripeTaxCalculationId: true,
            parentOrderId: true,
            event: {
              select: {
                title: true,
                orgId: true,
                org: { select: { name: true } },
              },
            },
            buyer: {
              select: { name: true, authUser: { select: { email: true } } },
            },
            _count: { select: { items: true } },
            promoRedemptions: {
              // NOT `take: 1`: an order can carry a typed code AND a
              // membership benefit, and picking whichever row the planner
              // returned first would hide the code the operator searched for.
              // The mapper below prefers the typed row.
              select: {
                code: true,
                promoId: true,
                amountDiscountCents: true,
              },
              // Total order: two stackable typed codes on one order would
              // otherwise let the planner decide which code the operator sees,
              // and it could differ between two loads of the same page.
              orderBy: [{ redeemedAt: "asc" }, { id: "asc" }],
            },
            items: {
              select: {
                id: true,
                kind: true,
                qty: true,
                unitPriceCents: true,
                amountCents: true,
                status: true,
                paidOutAt: true,
                refundedAt: true,
                transferredAt: true,
                // For the buyer charge breakdown (listPlatformOrders).
                meta: true,
                ticketType: { select: { name: true } },
                ticket: {
                  select: {
                    code: true,
                    scannedAt: true,
                    seatId: true,
                    owner: { select: { name: true } },
                  },
                },
              },
              orderBy: { amountCents: "desc" as const },
            },
          },
        }),
      ]);

      return {
        total,
        limit,
        offset,
        items: rows.map<ListPlatformOrdersItem>((row) => ({
          id: row.id,
          eventId: row.eventId,
          eventTitle: row.event?.title ?? null,
          kind: row.kind as ListPlatformOrdersItem["kind"],
          orgId: row.event?.orgId ?? null,
          orgName: row.event?.org?.name ?? null,
          buyerHumanId: row.buyerHumanId,
          buyerName: row.buyer.name ?? null,
          buyerEmail: row.buyer.authUser?.email ?? null,
          amountGrossCents: row.amountGrossCents,
          feesPlatformCents: row.feesPlatformCents,
          taxAmountCents: row.taxAmountCents,
          currency: row.currency,
          status: row.status as OrderStatus,
          source: row.source as OrderSource,
          stripePaymentIntentId: row.stripePaymentIntentId,
          paymentMethodType: row.paymentMethodType ?? null,
          occurredAt: row.occurredAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          itemCount: row._count.items,
          feePolicySnapshot: row.feePolicySnapshot,
          billingCountry: row.billingCountry ?? null,
          billingAddress: row.billingAddressLine1
            ? {
                line1: row.billingAddressLine1,
                line2: row.billingAddressLine2 ?? null,
                city: row.billingCity ?? null,
                state: row.billingState ?? null,
                postalCode: row.billingPostalCode ?? null,
                country: row.billingCountry ?? null,
              }
            : null,
          stripeTaxCalculationId: row.stripeTaxCalculationId ?? null,
          parentOrderId: row.parentOrderId ?? null,
          promo: pickShownRedemption(row.promoRedemptions),
          items: row.items.map<PlatformOrderItemSummary>((item) => ({
            id: item.id,
            kind: item.kind as OrderItemKind,
            ticketTypeName: item.ticketType?.name ?? null,
            qty: item.qty,
            unitPriceCents: item.unitPriceCents,
            amountCents: item.amountCents,
            status: item.status as OrderItemStatus,
            paidOutAt: item.paidOutAt,
            refundedAt: item.refundedAt,
            transferredAt: item.transferredAt,
            ticketCode: item.ticket?.code ?? null,
            ticketScannedAt: item.ticket?.scannedAt ?? null,
            seatId: item.ticket?.seatId ?? null,
            ticketOwnerName: item.ticket?.owner?.name ?? null,
            meta: item.meta,
          })),
        })),
      };
    },

    listExpiredPending: async (
      input: ListExpiredPendingOrdersInput,
    ): Promise<ExpiredPendingOrderItem[]> => {
      const excludeOrderIds = input.excludeOrderIds ?? [];

      const rows = await p.order.findMany({
        where: {
          status: "PENDING",
          occurredAt: { lt: input.createdBefore },
          // Excluded IN the query, not after it: these ids are the reaper's
          // quarantined carts, and filtering them out afterwards would leave
          // them consuming slots in a `take`-limited page ordered oldest
          // first — which is precisely where a permanently stuck cart lives.
          ...(excludeOrderIds.length > 0
            ? { id: { notIn: excludeOrderIds } }
            : {}),
        },
        select: {
          id: true,
          stripePaymentIntentId: true,
          buyerHumanId: true,
        },
        take: input.limit ?? 200,
        orderBy: { occurredAt: "asc" },
      });

      return rows.map((row) => ({
        id: row.id,
        stripePaymentIntentId: row.stripePaymentIntentId,
        buyerHumanId: row.buyerHumanId,
      }));
    },

    listOtherPending: async (input: ListOtherPendingInput) => {
      const rows = await p.order.findMany({
        where: {
          status: "PENDING",
          buyerHumanId: input.buyerHumanId,
          eventId: input.eventId,
          id: { not: input.excludeOrderId },
        },
        select: {
          id: true,
          stripePaymentIntentId: true,
        },
        take: 50,
        orderBy: { occurredAt: "asc" },
      });

      return rows.map((row) => ({
        id: row.id,
        stripePaymentIntentId: row.stripePaymentIntentId,
      }));
    },

    bulkMigrateToEvent: async (input) => {
      // First, find the IDs of matching orders so we can return them.
      const matching = await p.order.findMany({
        where: {
          eventId: input.sourceEventId,
          status: { in: input.statuses },
        },
        select: { id: true },
      });

      if (matching.length === 0) {
        return { updatedCount: 0, migratedOrderIds: [] };
      }

      const ids = matching.map((o) => o.id);

      const result = await p.order.updateMany({
        where: { id: { in: ids } },
        data: { eventId: input.targetEventId },
      });

      return {
        updatedCount: result.count,
        migratedOrderIds: ids,
      };
    },

    getTaxNexusRollup: async (
      input: GetTaxNexusRollupInput,
    ): Promise<TaxNexusRollupRow[]> => {
      // Raw SQL, not `groupBy`: netting a partial refund out of a situs group
      // needs a per-order aggregate over OrderItem folded into the same
      // grouping, which Prisma's aggregate API cannot express. The alternative
      // — fetch every PART_REFUNDED order in the window and net in JS — is an
      // unbounded read on a 12-month analytics query.
      //
      // Fully REFUNDED orders are excluded by the status filter, exactly as
      // before; only PART_REFUNDED orders have refunded items at all
      // (`markRefunded` sets REFUNDED the moment the last one goes), so the
      // netting is a no-op for the SUCCEEDED rows it also passes over.
      //
      // Tax: Σ `OrderItem.refundedTaxCents` over the order's refunded ticket
      // items — what was ACTUALLY returned to the buyer, stamped at refund
      // execution (see `refund-tax-share.ts`). NULL is "not attributed"
      // (refunds predating the column, and the whole-order paths whose orders
      // leave this rollup on status); SUM skips it, so an unattributed refund
      // degrades to the old overstating behaviour rather than inventing a
      // credit. No backfill: a guessed share must not read as a measured one.
      //
      // Schema-qualified (public.*) so the statement survives a Neon pooled
      // connection waking with an empty search_path — Prisma's own generated
      // SQL always qualifies, and dropping to $queryRaw gives that up.
      //
      // Gross: `amountGrossCents` is order-level and post-discount, so a
      // refunded item's slice of it is not `item.amountCents`. Scale it by the
      // refunded fraction of ticket value instead — exact when every ticket
      // item is refunded, proportional otherwise, and correct on discounted
      // orders. Unlike the tax leg this needs no stamp, so it nets historical
      // partial refunds too.
      //
      // Per-tax-line parts (`taxLineParts`), from the SAME `counted` set in the
      // SAME statement so they cannot drift from the totals above:
      // Only PLATFORM lines with amount > 0 exist for this breakdown — in
      // the charged sums, the line count and the line total alike (ORGANISER
      // lines are disclosed, never charged; a ≤0 line has no column CHECK to
      // rule it out, and counting it on one side only would break Σ).
      // - charged: Σ `OrderTaxLine.amountCents` per (code, jurisdiction).
      // - refunded, exact: an order with exactly one line whose amount EQUALS
      //   taxAmountCents puts its Σ stamps on that line.
      // - unattributed: an order with no line (legacy) contributes its whole
      //   net tax; a lone line that disagrees with taxAmountCents keeps its
      //   charge, refunds nothing, and its order contributes taxAmountCents −
      //   line − Σ stamps (never guess, as `allocateRefundTaxSharesByLine`
      //   empties `byLine` on a mismatch); every other order contributes
      //   taxAmountCents − Σ lines (0 when they agree).
      // - lineMismatchOrderCount: orders whose lines (any number ≥1) disagree
      //   with taxAmountCents, so core can report them — EXCEPT split orders,
      //   which core's allocator flags (`lineMismatch`) and reports one by one
      //   with their id. Each disagreeing order is reported exactly once.
      // - split: an order with ≥2 lines and a refunded ticket item is listed
      //   with its Σ stamps; core splits those per line.
      // Σ lines (charged − refunded) + unattributed − Σ split stamps is then
      // `taxCollectedCents` by construction.
      const rows = await p.$queryRaw<
        Array<{
          country: string | null;
          state: string | null;
          netSalesCents: bigint;
          taxCollectedCents: bigint;
          orderCount: bigint;
          unattributedTaxCents: bigint;
          lineMismatchOrderCount: bigint;
          taxLines: Array<{
            code: string;
            jurisdiction: string;
            chargedCents: number | string;
            refundedCents: number | string;
          }> | null;
          splitOrders: Array<{
            orderId: string;
            taxAmountCents: number | string;
            refundedTaxCents: number | string;
          }> | null;
        }>
      >(PrismaNamespace.sql`
        WITH counted AS (
          SELECT
            o."id",
            o."taxSitusCountry"                              AS "country",
            o."taxSitusState"                                AS "state",
            o."amountGrossCents",
            o."taxAmountCents",
            r."refundedTaxCents",
            r."refundedTicketCents",
            r."ticketCents",
            r."refundedItemCount",
            tl."positiveLineCount",
            tl."platformLineCents"
          FROM public."Order" o
          LEFT JOIN LATERAL (
            SELECT
              COALESCE(SUM(oi."refundedTaxCents") FILTER (
                WHERE oi."status" = 'refunded'
              ), 0)                                          AS "refundedTaxCents",
              COALESCE(SUM(oi."amountCents") FILTER (
                WHERE oi."status" = 'refunded'
              ), 0)                                          AS "refundedTicketCents",
              COALESCE(SUM(oi."amountCents"), 0)              AS "ticketCents",
              COUNT(*) FILTER (
                WHERE oi."status" = 'refunded'
              )                                              AS "refundedItemCount"
            FROM public."OrderItem" oi
            WHERE oi."orderId" = o."id"
              AND oi."kind" = 'ticket'
          ) r ON TRUE
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)                                       AS "positiveLineCount",
              COALESCE(SUM(otl."amountCents"), 0)             AS "platformLineCents"
            FROM public."OrderTaxLine" otl
            WHERE otl."orderId" = o."id"
              AND otl."collector" = 'PLATFORM'
              AND otl."amountCents" > 0
          ) tl ON TRUE
          WHERE o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
            AND o."createdAt" >= ${input.since}
        ),
        -- MATERIALIZED: referenced once, inside a correlated subquery, so PG12+
        -- would otherwise inline it and re-aggregate per output row.
        line_totals AS MATERIALIZED (
          SELECT
            c."country",
            c."state",
            otl."code",
            otl."jurisdiction",
            SUM(otl."amountCents")::bigint                   AS "chargedCents",
            SUM(CASE
              WHEN c."positiveLineCount" = 1
               AND c."platformLineCents" = c."taxAmountCents"
                THEN c."refundedTaxCents"
              ELSE 0
            END)::bigint                                     AS "refundedCents"
          FROM counted c
          JOIN public."OrderTaxLine" otl
            ON otl."orderId" = c."id"
           AND otl."collector" = 'PLATFORM'
           AND otl."amountCents" > 0
          GROUP BY c."country", c."state", otl."code", otl."jurisdiction"
        )
        SELECT
          c."country"                                        AS "country",
          c."state"                                          AS "state",
          COALESCE(SUM(
            c."amountGrossCents" - CASE
              WHEN c."ticketCents" > 0
                THEN ROUND(
                  c."amountGrossCents"::numeric
                    * c."refundedTicketCents"::numeric
                    / c."ticketCents"::numeric
                )
              ELSE 0
            END
          ), 0)::bigint                                      AS "netSalesCents",
          COALESCE(SUM(
            c."taxAmountCents" - COALESCE(c."refundedTaxCents", 0)
          ), 0)::bigint                                      AS "taxCollectedCents",
          COUNT(*)::bigint                                   AS "orderCount",
          COALESCE(SUM(CASE
            -- No line (platformLineCents = 0), or a lone line that disagrees:
            -- the stamps cannot go on a line.
            WHEN c."positiveLineCount" = 0
              OR (c."positiveLineCount" = 1
                  AND c."platformLineCents" <> c."taxAmountCents")
              THEN c."taxAmountCents" - c."platformLineCents"
                     - COALESCE(c."refundedTaxCents", 0)
            ELSE c."taxAmountCents" - c."platformLineCents"
          END), 0)::bigint                                   AS "unattributedTaxCents",
          COUNT(*) FILTER (
            WHERE c."positiveLineCount" >= 1
              AND c."platformLineCents" <> c."taxAmountCents"
              AND NOT (c."positiveLineCount" >= 2
                       AND c."refundedItemCount" > 0)
          )::bigint                                          AS "lineMismatchOrderCount",
          (
            SELECT json_agg(json_build_object(
              'code', lt."code",
              'jurisdiction', lt."jurisdiction",
              'chargedCents', lt."chargedCents",
              'refundedCents', lt."refundedCents"
            ) ORDER BY lt."code", lt."jurisdiction")
            FROM line_totals lt
            WHERE lt."country" IS NOT DISTINCT FROM c."country"
              AND lt."state" IS NOT DISTINCT FROM c."state"
          )                                                  AS "taxLines",
          json_agg(json_build_object(
            'orderId', c."id",
            'taxAmountCents', c."taxAmountCents",
            'refundedTaxCents', c."refundedTaxCents"
          ) ORDER BY c."id") FILTER (
            WHERE c."positiveLineCount" >= 2
              AND c."refundedItemCount" > 0
          )                                                  AS "splitOrders"
        FROM counted c
        GROUP BY c."country", c."state"
        ORDER BY c."country", c."state"
      `);

      return rows.map((row) => ({
        country: row.country ?? null,
        state: row.state ?? null,
        netSalesCents: Number(row.netSalesCents),
        taxCollectedCents: Number(row.taxCollectedCents),
        orderCount: Number(row.orderCount),
        taxLineParts: {
          lines: (row.taxLines ?? []).map((line) => ({
            code: line.code,
            jurisdiction: line.jurisdiction,
            chargedCents: Number(line.chargedCents),
            refundedCents: Number(line.refundedCents),
          })),
          unattributedCents: Number(row.unattributedTaxCents),
          lineMismatchOrderCount: Number(row.lineMismatchOrderCount),
          splitOrders: (row.splitOrders ?? []).map((order) => ({
            orderId: order.orderId,
            taxAmountCents: Number(order.taxAmountCents),
            refundedTaxCents: Number(order.refundedTaxCents),
          })),
        },
      }));
    },

    listTicketItemsForTaxSplit: async (
      orderIds: string[],
    ): Promise<Map<string, TaxSplitTicketItem[]>> => {
      const result = new Map<string, TaxSplitTicketItem[]>();
      if (orderIds.length === 0) return result;
      const rows = await p.orderItem.findMany({
        where: { orderId: { in: [...new Set(orderIds)] }, kind: "ticket" },
        select: {
          id: true,
          orderId: true,
          amountCents: true,
          meta: true,
          status: true,
          refundedTaxCents: true,
        },
        // Deterministic per-order order; the allocator breaks ties by id anyway.
        orderBy: [{ orderId: "asc" }, { id: "asc" }],
      });
      for (const row of rows) {
        const list = result.get(row.orderId) ?? [];
        list.push({
          id: row.id,
          amountCents: row.amountCents,
          meta: row.meta,
          status: row.status as OrderItemStatus,
          refundedTaxCents: row.refundedTaxCents,
        });
        result.set(row.orderId, list);
      }
      return result;
    },

    sumCollectedTaxByCurrency: async (): Promise<CollectedTaxTotal[]> => {
      // Raw SQL for the same reason getTaxNexusRollup uses it: a grouped
      // aggregate over the whole Order table, and fetching every finalized
      // order to sum in JS is unbounded.
      //
      // GROSS, all time, NO refund netting and NO time window — the number is
      // a deliberate UPPER BOUND on tax liability (see `CollectedTaxTotal`
      // for the three ways it overstates and why that is the safe direction).
      // The status filter is copied from getTaxNexusRollup on purpose: fully
      // REFUNDED orders drop out entirely; PART_REFUNDED ones keep their full
      // tax.
      //
      // Currency is lower-cased here so it joins the ledger's and Stripe's
      // lowercase ISO-4217 without the caller guessing at casing. Schema-
      // qualified (public.*) so the statement survives a Neon pooled
      // connection waking with an empty search_path.
      const rows = await p.$queryRaw<
        Array<{
          currency: string;
          taxCollectedCents: bigint;
          orderCount: bigint;
        }>
      >(PrismaNamespace.sql`
        SELECT
          lower(o."currency")                          AS "currency",
          COALESCE(SUM(o."taxAmountCents"), 0)::bigint AS "taxCollectedCents",
          COUNT(*)::bigint                             AS "orderCount"
        FROM public."Order" o
        WHERE o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
        GROUP BY lower(o."currency")
        ORDER BY lower(o."currency") ASC
      `);

      return rows.map((row) => ({
        currency: row.currency,
        // Diagnostic figures, never a transfer input: bigint → number the way
        // the reconciliation reads do, so a pathological total is reported
        // rather than raising 22003 on an ::int cast.
        taxCollectedCents: Number(row.taxCollectedCents),
        orderCount: Number(row.orderCount),
      }));
    },

    listOrdersMissingProcessorFee: async (
      input: ListOrdersMissingProcessorFeeInput,
    ): Promise<OrderMissingProcessorFee[]> => {
      // Prisma, not raw SQL: this is a narrow indexed-ish scan with a small
      // take, not a grouped aggregate, and the typed result is worth more here
      // than hand-written SQL.
      //
      // `stripePaymentIntentId: { not: null }` is load-bearing, not defensive.
      // The fee lives on the charge's balance transaction, so an order with no
      // intent has nothing to read — without this it would be claimed on every
      // run forever and the backlog would never drain.
      //
      // Statuses are the ones that actually CHARGED. CANCELLED is excluded and
      // that is verified rather than assumed: its only writers are
      // cancelPendingOrder (PENDING→), cancelProcessingOrder (PROCESSING→) and
      // cancelCompOrder (a $0 comp void), none of which captured money.
      //
      // BACKOFF + PARK. Oldest-first on its own would hand a row Stripe can
      // never resolve back to the sweep every run, and `limit` such rows
      // would freeze coverage for every newer order. So a row that failed
      // is excluded until its last failure is older than the backoff window,
      // and a row at or past the failure cap is excluded outright (parked).
      // The defaults are the shared constants in @th/types: the use case
      // passes them explicitly, and a caller that omits them gets the same
      // policy rather than a second, quietly different one.
      const retryBackoffMs =
        input.retryBackoffMs ?? PROCESSOR_FEE_RETRY_BACKOFF_MS;
      const maxFailures = input.maxFailures ?? PROCESSOR_FEE_MAX_READ_FAILURES;
      const retryBefore = new Date(input.now.getTime() - retryBackoffMs);
      const rows = await p.order.findMany({
        where: {
          processorFeeCents: null,
          stripePaymentIntentId: { not: null },
          status: {
            in: ["SUCCEEDED", "PART_REFUNDED", "REFUNDED", "DISPUTED"],
          },
          processorFeeReadFailures: { lt: maxFailures },
          OR: [
            { processorFeeReadFailedAt: null },
            { processorFeeReadFailedAt: { lt: retryBefore } },
          ],
        },
        select: {
          id: true,
          stripePaymentIntentId: true,
          currency: true,
          occurredAt: true,
          processorFeeReadFailures: true,
        },
        // Oldest first: the backlog drains deterministically. The backoff
        // and cap above are what keep a permanently failing row from
        // starving newer ones — ordering alone never could.
        orderBy: { occurredAt: "asc" },
        take: input.limit,
      });

      return rows.map((row) => ({
        id: row.id,
        // Non-null by the `not: null` filter; the cast documents that rather
        // than re-checking it.
        stripePaymentIntentId: row.stripePaymentIntentId as string,
        currency: row.currency.toLowerCase(),
        occurredAt: row.occurredAt,
        processorFeeReadFailures: row.processorFeeReadFailures,
      }));
    },

    recordProcessorFeeReadFailure: async (
      input: RecordProcessorFeeReadFailureInput,
    ): Promise<number> => {
      // ONE statement, guarded and RETURNING, rather than updateMany + a
      // read-back: two sweeps failing the same row in the same instant would
      // each read back the other's increment and both believe they parked
      // it. The IS NULL guard is the race gate against a concurrent STAMP —
      // a row whose fee landed between our claim and our failure must not be
      // marked failed. Parameterised through Prisma.sql, never interpolated.
      const rows = await p.$queryRaw<
        Array<{ processorFeeReadFailures: number }>
      >(PrismaNamespace.sql`
        UPDATE public."Order"
        SET "processorFeeReadFailedAt" = ${input.failedAt},
            "processorFeeReadFailures" = "processorFeeReadFailures" + 1
        WHERE "id" = ${input.orderId}
          AND "processorFeeCents" IS NULL
        RETURNING "processorFeeReadFailures"
      `);
      return rows[0]?.processorFeeReadFailures ?? 0;
    },

    stampProcessorFee: async (
      input: StampProcessorFeeInput,
    ): Promise<boolean> => {
      // `updateMany` with the IS NULL guard, not `update`: first write wins.
      // The value comes from an immutable balance transaction, so a second
      // writer would either be writing the same number or a wrong one, and
      // neither should clobber a measurement already taken. A 0-count is a
      // normal race outcome ("someone stamped it first"), not an error.
      const result = await p.order.updateMany({
        where: { id: input.orderId, processorFeeCents: null },
        data: { processorFeeCents: input.feeCents },
      });
      return result.count > 0;
    },

    summarizeCashTillForEvent: async (
      input: SummarizeCashTillForEventInput,
    ): Promise<CashTillSummary> => {
      // One pass over the event's cash orders. A door does tens to low
      // hundreds of these a night, so the row count is small and fetching
      // them beats three groupBy round trips that still could not produce
      // the recent-sales tail.
      //
      // SUCCEEDED, REFUNDED and PART_REFUNDED. PENDING has no place here: a
      // cash sale finalises inside its own transaction, so a PENDING row with
      // `paymentChannel = "CASH"` is a rolled-back attempt, not money in the
      // box. Counting one would tell the operator to expect cash nobody ever
      // handed over.
      //
      // PART_REFUNDED is included even though no code path currently produces
      // it on a CASH order — `refundCashSale` only ever calls `markRefunded`,
      // and the partial-refund path dereferences `order.stripePaymentIntentId!`
      // which is null on cash. That is unreachable BY ACCIDENT rather than by a
      // guard, and the failure mode if it ever becomes reachable is silent: the
      // row would vanish from the totals AND the tail, understating the drawer
      // with nothing anywhere to say why. Cheap to include, so it is included.
      //
      // Capped rather than unbounded: `refreshAfterSale` invalidates this after
      // every sale, and a multi-day festival breaks the "tens to low hundreds
      // per night" assumption this read was sized for. Newest-first ordering
      // means the cap drops the OLDEST rows, so a truncated report understates
      // rather than reporting a wrong recent tail — and `truncated` says so out
      // loud instead of letting a capped total read as a complete one.
      const orders = await p.order.findMany({
        where: {
          eventId: input.eventId,
          paymentChannel: "CASH",
          status: { in: ["SUCCEEDED", "REFUNDED", "PART_REFUNDED"] },
        },
        take: CASH_TILL_SCAN_CAP + 1,
        select: {
          id: true,
          shortId: true,
          amountGrossCents: true,
          feesPlatformCents: true,
          taxAmountCents: true,
          status: true,
          occurredAt: true,
          _count: { select: { tickets: true } },
          // The comp stamp (`meta.comp`) and the priced marker
          // (`meta.buyerTotalCents`) `classifyCashSale` reads. One ticket item
          // is enough: `recordComp` and DOOR_CASH `priceCart` stamp every
          // ticket item of an order alike.
          items: { where: { kind: "ticket" }, take: 1, select: { meta: true } },
          // Typed codes only: a membership benefit's ledger `code` is an
          // internal `benefit:{id}` marker. A refund leaves the redemption in
          // place (it releases PENDING holds only), so a refunded row keeps
          // its code. Same order as `promos.listRedemptionsByOrderId`.
          promoRedemptions: {
            where: { promoId: { not: null } },
            select: { code: true },
            orderBy: [{ redeemedAt: "asc" }, { id: "asc" }],
          },
        },
        orderBy: { occurredAt: "desc" },
      });

      const truncated = orders.length > CASH_TILL_SCAN_CAP;
      const counted = truncated ? orders.slice(0, CASH_TILL_SCAN_CAP) : orders;

      const summary: CashTillSummary = {
        truncated,
        paidSaleCount: 0,
        cashCollectedCents: 0,
        taxCents: 0,
        platformFeeOwedCents: 0,
        organiserKeepsCents: 0,
        compSaleCount: 0,
        compTicketCount: 0,
        freeWithCodeSaleCount: 0,
        freeWithCodeTicketCount: 0,
        paidTicketCount: 0,
        refundedSaleCount: 0,
        refundedCents: 0,
        recentSales: [],
      };

      for (const order of counted) {
        const ticketCount = order._count.tickets;
        // A cash order's total is ticket net of discount + platform fee + tax,
        // as RECORDED on the order. Since the owner ruling of 2026-10-08
        // (cash = no platform fee) recordCashSale prices through priceCart,
        // DOOR_CASH, with no platform fee and no processing fee, so the
        // stored fee is 0 and `platformFeeOwedCents` gets nothing from it.
        // A cash sale recorded before the ruling stored the fee the buyer
        // paid on top, and still reports it. Orders recorded before the door
        // was priced carry 0 fee and 0 tax, and their gross is what the
        // operator typed — so the same sum reads all three.
        //
        // Comp vs free-with-a-code: `classifyCashSale`, the rule
        // `recordCashSale` reports on the done screen. A comp is the explicit
        // Comp action (stamped `meta.comp` on its items); a $0 sale with a
        // promo code is a SALE made free by the code, never a comp (owner
        // ruling). Deliberately not `source === "COMP"`: that marks the
        // organiser's comp-issuing flow, which never routes through the till.
        const feeCents = order.feesPlatformCents;
        const taxCents = order.taxAmountCents;
        const totalCents = order.amountGrossCents + feeCents + taxCents;
        const promoCodes = order.promoRedemptions.map((r) => r.code);
        const { isComp, isFreeWithCode } = classifyCashSale({
          totalCents,
          promoCodes,
          items: order.items,
        });
        const isRefunded = order.status === "REFUNDED";

        if (isRefunded) {
          // A refunded $0 sale (a comp, or free with a code) moved no money
          // either way, so it must not land in the "handed back" tile as
          // "1 refund · $0.00" — on a screen whose whole job is reconciling a
          // drawer, a zero-value refund reads as a discrepancy to chase.
          if (totalCents > 0) {
            summary.refundedSaleCount += 1;
            summary.refundedCents += totalCents;
          }
        } else if (isComp) {
          summary.compSaleCount += 1;
          summary.compTicketCount += ticketCount;
        } else if (isFreeWithCode) {
          // $0 total, so nothing to add to the money or its split.
          summary.freeWithCodeSaleCount += 1;
          summary.freeWithCodeTicketCount += ticketCount;
        } else {
          summary.paidSaleCount += 1;
          summary.cashCollectedCents += totalCents;
          // A refunded sale's debit (tax; fee + tax before 2026-10-08) was
          // reversed on the ledger with it, so only unrefunded sales are
          // split.
          summary.taxCents += taxCents;
          summary.platformFeeOwedCents += feeCents;
          summary.organiserKeepsCents += order.amountGrossCents;
          summary.paidTicketCount += ticketCount;
        }

        if (summary.recentSales.length < input.recentLimit) {
          summary.recentSales.push({
            orderId: order.id,
            shortId: order.shortId,
            amountCents: totalCents,
            ticketCount,
            isComp,
            promoCode: promoCodes[0] ?? null,
            isRefunded,
            occurredAt: order.occurredAt,
          });
        }
      }

      return summary;
    },

    listCashSalesForEvent: async (
      input: ListCashSalesForEventInput,
    ): Promise<ListCashSalesForEventResult> => {
      // The statuses the till counts, for the same reasons (see
      // `summarizeCashTillForEvent`): the list and the till must show the
      // same sales. Rides the (eventId, occurredAt) index.
      //
      // Only the columns the row needs. Deliberately NO buyer columns or
      // relations (buyerHumanId, buyer, billing address, checkoutIp): this
      // read serves the Sell screen, open to Editors and Scanners, and buyer
      // PII stays on Orders. The adapter test pins this select.
      const decoded = input.cursor ? decodeCashSalesCursor(input.cursor) : null;
      const rows = await p.order.findMany({
        where: {
          eventId: input.eventId,
          paymentChannel: "CASH",
          status: { in: ["SUCCEEDED", "REFUNDED", "PART_REFUNDED"] },
          // Strictly after the boundary in (occurredAt desc, id desc) order.
          ...(decoded
            ? {
                OR: [
                  { occurredAt: { lt: decoded.occurredAt } },
                  { occurredAt: decoded.occurredAt, id: { lt: decoded.orderId } },
                ],
              }
            : {}),
        },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        select: CASH_SALE_LIST_SELECT,
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page[page.length - 1];

      return {
        items: page.map((row) => ({
          orderId: row.id,
          status: row.status as "SUCCEEDED" | "REFUNDED" | "PART_REFUNDED",
          occurredAt: row.occurredAt,
          amountGrossCents: row.amountGrossCents,
          feesPlatformCents: row.feesPlatformCents,
          taxAmountCents: row.taxAmountCents,
          ticketCount: row._count.tickets,
          items: row.items.map((item) => ({
            kind: item.kind,
            amountCents: item.amountCents,
            meta: item.meta,
            refundedAt: item.refundedAt,
          })),
          promoCodes: row.promoRedemptions.map((r) => r.code),
        })),
        nextCursor:
          hasMore && last ? encodeCashSalesCursor(last.occurredAt, last.id) : null,
      };
    },
  };
}

/**
 * The whole projection of `listCashSalesForEvent`. Every item of the order
 * (each kind: `computeExpectedPaymentAmount` folds discount and credit items
 * into what the buyer paid) and typed promo codes only (a membership
 * benefit's ledger `code` is an internal `benefit:{id}` marker), in the
 * order `promos.listRedemptionsByOrderId` returns them.
 */
const CASH_SALE_LIST_SELECT = {
  id: true,
  status: true,
  occurredAt: true,
  amountGrossCents: true,
  feesPlatformCents: true,
  taxAmountCents: true,
  _count: { select: { tickets: true } },
  items: {
    select: { kind: true, amountCents: true, meta: true, refundedAt: true },
    orderBy: { id: "asc" },
  },
  promoRedemptions: {
    where: { promoId: { not: null } },
    select: { code: true },
    orderBy: [{ redeemedAt: "asc" }, { id: "asc" }],
  },
} satisfies PrismaNamespace.OrderSelect;

/**
 * The owner scope for order queries, expressed as an `Order.event` relation
 * filter. Mirrors `listForOrg` (`event: { orgId }`) and
 * `listForHumanOwnedEvents` (`event: { humanId }`) so all owner-scoped order
 * reads agree on what "the owner's orders" means.
 */
function ownerEventScopeWhere(
  scope: OrderOwnerScope,
): PrismaNamespace.EventWhereInput {
  return scope.ownerType === "ORGANIZATION"
    ? { orgId: scope.ownerId }
    : { humanId: scope.ownerId };
}

/**
 * The full search predicate for the OWNER-SCOPED order lists: buyer name /
 * email, plus an exact-or-suffix match on the order's own identifiers when the
 * query is id-shaped.
 *
 * WHY the identifier arms exist: FR-012's hand-off routes an admin who found
 * an order by id to `/admin/<slug>/orders?q=<id>`, and that page searches via
 * `listForOrg` — which matched buyer name/email ONLY. So the admin found the
 * order, clicked through, and landed on an empty list at the exact moment they
 * had what they wanted. (`listAll`, the PLATFORM table, always had an id arm;
 * the org tables never did.)
 *
 * TENANCY: this returns only the SEARCH fragment. Both callers AND it with
 * their owner scope (`event: { orgId }` / `event: { humanId }`), which is
 * unchanged — so an id arm cannot widen the result set beyond the owner's own
 * orders. An id belonging to another org still matches nothing here.
 *
 * BEHAVIOUR PRESERVATION: for a non-id-shaped query this emits exactly the
 * `{ buyer: { OR: [name, email] } }` object the callers built inline before,
 * key for key — the `OR` wrapper appears ONLY when an identifier arm exists.
 */
function orderSearchWhere(
  searchQuery: string | null | undefined,
): PrismaNamespace.OrderWhereInput {
  const buyerArm = buyerSearchWhere(searchQuery);
  const identifierArms = orderIdentifierClauses(
    searchQuery,
  ) as PrismaNamespace.OrderWhereInput[];

  if (identifierArms.length === 0) return buyerArm;

  return {
    OR: [
      ...(Object.keys(buyerArm).length > 0 ? [buyerArm] : []),
      ...identifierArms,
    ],
  };
}

/**
 * The buyer-name / buyer-email ARM of an order search predicate. Returns `{}`
 * for an absent or whitespace-only query.
 *
 * PRIVATE TO {@link orderSearchWhere} — do not call this directly from a repo
 * method. It is only part of the predicate; a query built on this arm alone
 * silently disagrees with every query built on the full one, which is exactly
 * how `counts.attendees` came to render "0 attendees" above a visible attendee
 * row. Every owner-scoped order query goes through `orderSearchWhere`.
 */
function buyerSearchWhere(
  searchQuery: string | null | undefined,
): PrismaNamespace.OrderWhereInput {
  const trimmed = searchQuery?.trim();
  if (!trimmed) return {};
  return {
    buyer: {
      OR: [
        { name: { contains: trimmed, mode: "insensitive" as const } },
        {
          authUser: {
            email: { contains: trimmed, mode: "insensitive" as const },
          },
        },
      ],
    },
  };
}

const mapOrder = (order: {
  id: string;
  /** Null for membership invoices — narrow on `kind` rather than null-checking. */
  eventId: string | null;
  kind: string;
  buyerHumanId: string;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  currency: string;
  feePolicySnapshot: unknown;
  status: string;
  stripePaymentIntentId: string | null;
  billingDescriptor?: string | null;
  refundPolicyAckAt?: Date | null;
  refundPolicyAckIp?: string | null;
  refundPolicyVersion?: string | null;
  refundPolicyText?: string | null;
  disputedAt?: Date | null;
  disputeStatus?: string | null;
  checkoutIp?: string | null;
  source: string;
  nonRefundable: boolean;
  occurredAt: Date;
  paidOutAt?: Date | null;
  parentOrderId: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
  billingCountry: string | null;
  stripeTaxCalculationId: string | null;
  taxSitusCountry?: string | null;
  taxSitusState?: string | null;
  taxSitusPostal?: string | null;
  taxRateSource?: string | null;
  paymentMethodType?: string | null;
  paymentCardChecks?: unknown;
  termsVersion?: string | null;
  termsAcceptedAt?: Date | null;
  paymentChannel?: string | null;
  items: Array<{
    id: string;
    kind: string;
    ticketTypeId: string | null;
    qty: number;
    unitPriceCents: number;
    amountCents: number;
    meta: unknown;
    paidOutAt: Date | null;
    refundedAt: Date | null;
    refundedTaxCents: number | null;
    transferredAt: Date | null;
    resaleListingId: string | null;
    resaleFaceValueCents: number | null;
    resaleProcessingPassThroughCents: number;
    resaleProcessingFeeConfigRef: string | null;
    resaleSaleCutoffAt: Date | null;
    resalePayoutReleaseAt: Date | null;
    resalePayoutStatus: string | null;
    resalePayoutHeldAt: Date | null;
    resalePayoutHoldReason: string | null;
    resalePayoutNoticeSentAt: Date | null;
    resalePayoutReminderSentAt: Date | null;
    resalePayoutFinalNoticeSentAt: Date | null;
    resaleClauseType: ResaleShareType | null;
    resaleClauseBps: number | null;
    resaleClauseCents: number | null;
    resaleClausePayer: ResaleSharePayer | null;
    resaleClauseTermsId: string | null;
    resaleClauseTermsVersion: number | null;
    originalUnitPriceCents: number | null;
    eventShareCents: number | null;
    sharePayer: ResaleSharePayer | null;
    status: string;
  }>;
}): OrderRecord => ({
  id: order.id,
  eventId: order.eventId,
  kind: order.kind as OrderRecord["kind"],
  buyerHumanId: order.buyerHumanId,
  amountGrossCents: order.amountGrossCents,
  feesPlatformCents: order.feesPlatformCents,
  taxAmountCents: order.taxAmountCents,
  feePolicySnapshot: order.feePolicySnapshot,
  status: order.status as OrderStatus,
  stripePaymentIntentId: order.stripePaymentIntentId,
  billingDescriptor: order.billingDescriptor ?? null,
  refundPolicyAckAt: order.refundPolicyAckAt ?? null,
  refundPolicyAckIp: order.refundPolicyAckIp ?? null,
  refundPolicyVersion: order.refundPolicyVersion ?? null,
  refundPolicyText: order.refundPolicyText ?? null,
  disputedAt: order.disputedAt ?? null,
  disputeStatus: (order.disputeStatus ?? null) as OrderRecord["disputeStatus"],
  checkoutIp: order.checkoutIp ?? null,
  source: order.source as OrderSource,
  nonRefundable: order.nonRefundable,
  occurredAt: order.occurredAt,
  paidOutAt: order.paidOutAt ?? null,
  currency: order.currency,
  parentOrderId: order.parentOrderId,
  billingAddressLine1: order.billingAddressLine1,
  billingAddressLine2: order.billingAddressLine2,
  billingCity: order.billingCity,
  billingState: order.billingState,
  billingPostalCode: order.billingPostalCode,
  billingCountry: order.billingCountry,
  stripeTaxCalculationId: order.stripeTaxCalculationId,
  taxSitusCountry: order.taxSitusCountry ?? null,
  taxSitusState: order.taxSitusState ?? null,
  taxSitusPostal: order.taxSitusPostal ?? null,
  taxRateSource: order.taxRateSource ?? null,
  paymentMethodType: order.paymentMethodType ?? null,
  paymentCardChecks: mapPaymentCardChecks(order.paymentCardChecks),
  termsVersion: order.termsVersion ?? null,
  termsAcceptedAt: order.termsAcceptedAt ?? null,
  paymentChannel: (order.paymentChannel ??
    "WEB") as OrderRecord["paymentChannel"],
  items: order.items.map((item) => mapOrderItem(item, order.id)),
});

// Tolerant read of the JSON snapshot: a malformed or legacy value reads as
// "not observed" (null) rather than throwing on every order read.
function mapPaymentCardChecks(value: unknown): PaymentCardChecks | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    addressLine1Check: str(raw.addressLine1Check),
    addressPostalCodeCheck: str(raw.addressPostalCodeCheck),
    cvcCheck: str(raw.cvcCheck),
  };
}

const orderItemFinanceSelect = {
  id: true,
  orderId: true,
  kind: true,
  ticketTypeId: true,
  qty: true,
  unitPriceCents: true,
  amountCents: true,
  meta: true,
  paidOutAt: true,
  refundedAt: true,
  refundedTaxCents: true,
  transferredAt: true,
  resaleListingId: true,
  resaleFaceValueCents: true,
  resaleProcessingPassThroughCents: true,
  resaleProcessingFeeConfigRef: true,
  resaleSaleCutoffAt: true,
  resalePayoutReleaseAt: true,
  resalePayoutStatus: true,
  resalePayoutHeldAt: true,
  resalePayoutHoldReason: true,
  resalePayoutNoticeSentAt: true,
  resalePayoutReminderSentAt: true,
  resalePayoutFinalNoticeSentAt: true,
  resaleClauseType: true,
  resaleClauseBps: true,
  resaleClauseCents: true,
  resaleClausePayer: true,
  resaleClauseTermsId: true,
  resaleClauseTermsVersion: true,
  originalUnitPriceCents: true,
  eventShareCents: true,
  sharePayer: true,
  status: true,
} as const;

const mapOrderItem = (
  item: {
    id: string;
    kind: string;
    ticketTypeId: string | null;
    qty: number;
    unitPriceCents: number;
    amountCents: number;
    meta: unknown;
    paidOutAt: Date | null;
    refundedAt: Date | null;
    refundedTaxCents: number | null;
    transferredAt: Date | null;
    resaleListingId: string | null;
    resaleFaceValueCents: number | null;
    resaleProcessingPassThroughCents: number;
    resaleProcessingFeeConfigRef: string | null;
    resaleSaleCutoffAt: Date | null;
    resalePayoutReleaseAt: Date | null;
    resalePayoutStatus: string | null;
    resalePayoutHeldAt: Date | null;
    resalePayoutHoldReason: string | null;
    resalePayoutNoticeSentAt: Date | null;
    resalePayoutReminderSentAt: Date | null;
    resalePayoutFinalNoticeSentAt: Date | null;
    resaleClauseType: ResaleShareType | null;
    resaleClauseBps: number | null;
    resaleClauseCents: number | null;
    resaleClausePayer: ResaleSharePayer | null;
    resaleClauseTermsId: string | null;
    resaleClauseTermsVersion: number | null;
    originalUnitPriceCents: number | null;
    eventShareCents: number | null;
    sharePayer: ResaleSharePayer | null;
    status: string;
  },
  orderId: string,
): OrderItemRecord => ({
  id: item.id,
  orderId,
  kind: item.kind as OrderItemRecord["kind"],
  ticketTypeId: item.ticketTypeId,
  qty: item.qty,
  unitPriceCents: item.unitPriceCents,
  amountCents: item.amountCents,
  meta: item.meta,
  paidOutAt: item.paidOutAt ?? null,
  refundedAt: item.refundedAt ?? null,
  refundedTaxCents: item.refundedTaxCents ?? null,
  transferredAt: item.transferredAt ?? null,
  resaleListingId: item.resaleListingId ?? null,
  resaleFaceValueCents: item.resaleFaceValueCents ?? null,
  resaleProcessingPassThroughCents: item.resaleProcessingPassThroughCents ?? 0,
  resaleProcessingFeeConfigRef: item.resaleProcessingFeeConfigRef ?? null,
  resaleSaleCutoffAt: item.resaleSaleCutoffAt ?? null,
  resalePayoutReleaseAt: item.resalePayoutReleaseAt ?? null,
  resalePayoutStatus:
    (item.resalePayoutStatus as OrderItemRecord["resalePayoutStatus"]) ?? null,
  resalePayoutHeldAt: item.resalePayoutHeldAt ?? null,
  resalePayoutHoldReason: item.resalePayoutHoldReason ?? null,
  resalePayoutNoticeSentAt: item.resalePayoutNoticeSentAt ?? null,
  resalePayoutReminderSentAt: item.resalePayoutReminderSentAt ?? null,
  resalePayoutFinalNoticeSentAt: item.resalePayoutFinalNoticeSentAt ?? null,
  // ── Resale share record (organiser-resale-share FR-003) ──
  resaleClauseType: item.resaleClauseType,
  resaleClauseBps: item.resaleClauseBps,
  resaleClauseCents: item.resaleClauseCents,
  resaleClausePayer: item.resaleClausePayer,
  resaleClauseTermsId: item.resaleClauseTermsId,
  resaleClauseTermsVersion: item.resaleClauseTermsVersion,
  originalUnitPriceCents: item.originalUnitPriceCents,
  eventShareCents: item.eventShareCents,
  sharePayer: item.sharePayer,
  status: item.status as OrderItemRecord["status"],
});

/**
 * Aggregates per-ticket order items (each with qty=1) into a single entry
 * per ticket type. This produces a cleaner summary for the cart recovery UI
 * instead of N separate rows for N tickets of the same type.
 *
 * `unitPriceCents` is the FIRST line's, so it is only the type's price when
 * every line costs the same. A seat with a price override is its own line at
 * its own price (seat-price-overrides spec FR-001), so `seats` carries each
 * held seat with the unit price of the line that holds it: a resumed checkout
 * shows, and quotes, those.
 *
 * @internal Exported for its unit test only.
 */
export function aggregateTicketSummary(
  items: Array<{
    ticketTypeId: string | null;
    ticketType: { name: string } | null;
    qty: number;
    unitPriceCents: number;
    meta: unknown;
  }>,
): Array<{
  ticketTypeId: string;
  ticketTypeName: string;
  qty: number;
  unitPriceCents: number;
  seatIds: string[];
  seats: Array<{ seatId: string; unitPriceCents: number }>;
}> {
  const byType = new Map<
    string,
    {
      ticketTypeName: string;
      qty: number;
      unitPriceCents: number;
      seatIds: string[];
      seats: Array<{ seatId: string; unitPriceCents: number }>;
    }
  >();

  for (const item of items) {
    const ttId = item.ticketTypeId ?? "";
    const meta = item.meta as { seatIds?: string[] } | null;
    const itemSeatIds = Array.isArray(meta?.seatIds) ? meta.seatIds : [];
    // Each held seat at its line's unit price (a line's price is per ticket).
    const itemSeats = itemSeatIds.map((seatId) => ({
      seatId,
      unitPriceCents: item.unitPriceCents,
    }));

    const existing = byType.get(ttId);
    if (existing) {
      existing.qty += item.qty;
      existing.seatIds.push(...itemSeatIds);
      existing.seats.push(...itemSeats);
    } else {
      byType.set(ttId, {
        ticketTypeName: item.ticketType?.name ?? "Unknown",
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        seatIds: [...itemSeatIds],
        seats: itemSeats,
      });
    }
  }

  return Array.from(byType.entries()).map(([ticketTypeId, agg]) => ({
    ticketTypeId,
    ticketTypeName: agg.ticketTypeName,
    qty: agg.qty,
    unitPriceCents: agg.unitPriceCents,
    seatIds: agg.seatIds,
    seats: agg.seats,
  }));
}
