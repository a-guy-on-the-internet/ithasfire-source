import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import {
  orderItemRecordSchema,
  orderStatusSchema,
  orderSourceSchema,
} from "@th/schema";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { getMetaString } from "../../lib/orders/meta";
import { fail } from "@th/errors";
import { disputeStatusSchema } from "../disputes/schemas";
import { isBlockedSettlementDisputeStatus } from "../settlements/dispute-statuses";
import { cashRefundWindowClosesAt } from "../../lib/cash-refund-window";
import { classifyCashSale } from "../../lib/orders/classify-cash-sale";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import {
  buyerChargeBreakdownSchema,
  computeBuyerChargeBreakdown,
} from "../../lib/orders/buyer-charge-breakdown";
import { computeAgreementBasis } from "./finalize-from-payment-intent";
import { cashSaleDebitKey } from "../pos/_shared/cash-sale-ledger";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";

// ── Schema ───────────────────────────────────────────────────────────────────

export const getOrgOrderInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  orderId: z.string().uuid(),
});

const outputItemSchema = orderItemRecordSchema
  .pick({
    id: true,
    kind: true,
    ticketTypeId: true,
    qty: true,
    unitPriceCents: true,
    amountCents: true,
    paidOutAt: true,
    refundedAt: true,
    transferredAt: true,
    status: true,
  })
  .extend({
    ticketCode: z.string().nullable().optional(),
    ticketScannedAt: z.coerce.date().nullable().optional(),
    seatId: z.string().nullable().optional(),
    ticketOwnerName: z.string().nullable().optional(),
  });

const billingAddressSchema = z
  .object({
    line1: z.string().nullable(),
    line2: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string().nullable(),
  })
  .nullable();

/**
 * The discount attributed to this order.
 *
 * `code` is NULL for a membership-sourced discount: a benefit has no code, and
 * the ledger's `code` column holds an internal `benefit:{id}` marker that is
 * not a thing anyone can type. Rendering that marker as "the promo code" would
 * put a meaningless string in front of an organiser. `source` tells the UI
 * which line it is looking at.
 */
const promoSchema = z
  .object({
    source: z.enum(["code", "membership"]),
    code: z.string().nullable(),
    amountDiscountCents: z.number().int(),
  })
  .nullable();

export const getOrgOrderOutputSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  eventTitle: z.string(),
  orgName: z.string().nullable(),
  buyerHumanId: z.string().uuid(),
  buyerName: z.string().nullable(),
  buyerEmail: z.string().nullable(),
  amountGrossCents: z.number().int(),
  feesPlatformCents: z.number().int(),
  taxAmountCents: z.number().int(),
  currency: z.string(),
  status: orderStatusSchema,
  source: orderSourceSchema,
  stripePaymentIntentId: z.string().nullable(),
  stripeTaxCalculationId: z.string().nullable(),
  paymentMethodType: z.string().nullable(),
  parentOrderId: z.string().nullable(),
  feePolicySnapshot: z.unknown().nullable(),
  billingAddress: billingAddressSchema,
  promo: promoSchema,
  /**
   * Every promo code typed for this order, normalized, in redemption order.
   * Membership benefits are not codes and are left out (see `promo`). Empty
   * when none. A door sale at $0 with a code here is "free with <CODE>", a
   * sale, never a comp.
   */
  promoCodes: z.array(z.string()),
  /**
   * How the order was collected, as stored: WEB (online checkout), POS (card
   * at the door), CASH (cash or comp at the door).
   */
  paymentChannel: z.enum(["WEB", "POS", "CASH"]),
  /**
   * CASH orders only (null otherwise): the last instant an org member in
   * `ORG_CASH_REFUND_ROLES` (Owner, Admin, Editor, Finance) can refund the
   * sale with `orgRefundCashSale` — event end + 7 days,
   * from the same `cashRefundWindowClosesAt` that refuses it with
   * CASH_REFUND_WINDOW_CLOSED. Past it, only platform staff can. The panel
   * shows the window, or the closed state, from this instead of trying.
   */
  cashRefundableUntil: z.coerce.date().nullable(),
  /**
   * CASH orders only (null otherwise): the cash the buyer handed over, which
   * is exactly what a refund hands back. Computed by
   * `computeExpectedPaymentAmount(order)`, the call the cash refund core
   * (`refundCashOrderInTx`) makes for its `amountReturnedCents`, so the panel
   * and the refund cannot disagree. 0 for a comp or a $0 sale.
   */
  cashAmountPaidCents: z.number().int().nonnegative().nullable(),
  /**
   * CASH orders only (null otherwise): the explicit Comp action, by
   * `classifyCashSale`, the rule the till and `completePosSale` read. A $0
   * sale with no code that was not made with the Comp button is a paid sale.
   */
  isComp: z.boolean().nullable(),
  /**
   * CASH orders only (null otherwise): a $0 sale made free by a promo code
   * (`classifyCashSale`). A sale, never a comp.
   */
  isFreeWithCode: z.boolean().nullable(),
  /**
   * CASH orders only (null otherwise): the amount on this order's
   * CASH_SALE_DEBIT, the row a refund reverses (its tax since the owner
   * ruling of 2026-10-08; fee + tax on a sale recorded before it). Read by
   * the same `cashSaleDebitKey(order.id)` the refund names. 0 when the sale
   * has no debit: a comp, a $0 sale, a tax-free sale, or a cash order
   * recorded before cash debits existed. Still the debit's amount after a
   * refund reversed it.
   */
  cashSaleDebitCents: z.number().int().nonnegative().nullable(),
  occurredAt: z.coerce.date(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
  paidOutAt: z.coerce.date().nullable().optional(),
  /**
   * Mirror of the order's Dispute row. OPEN / UNDER_REVIEW / LOST block
   * refunds (Stripe refuses `charge_disputed`); the admin panel gates the
   * refund affordance on this up front instead of waiting for the server.
   */
  disputeStatus: disputeStatusSchema.nullable(),
  /**
   * Derived from `disputeStatus` by the SAME rule the refund use cases apply
   * (`isBlockedSettlementDisputeStatus`), so the web never re-encodes which
   * statuses block and cannot drift from the server's refusal.
   */
  refundBlockedByDispute: z.boolean(),
  /**
   * The newest Radar early fraud warning on this order that is STILL open on
   * both counts: unresolved locally AND `actionable` per Stripe. The card
   * issuer flagged the charge as likely fraud and a full refund now avoids the
   * chargeback. Null once Stripe flips `actionable` off (refunded / disputed,
   * including out of band — our REFUNDED hook rides `charge.refunded` and can
   * lag or DLQ), once we resolve it, if never warned, or if the lookup failed
   * (reported). Data only — the panel banner is a follow-up.
   */
  earlyFraudWarning: z
    .object({
      fraudType: z.string(),
      stripeCreatedAt: z.coerce.date(),
      actionable: z.literal(true),
    })
    .nullable(),
  items: z.array(outputItemSchema),
  /** Ticket type names keyed by ticketTypeId, for display. */
  ticketTypeNames: z.record(z.string(), z.string()),
  /**
   * What the buyer paid, in total. NOT `amountGrossCents`, which is the
   * ticket money alone (no fees, no tax). On a CASH order it is
   * `cashAmountPaidCents`, the cash a refund hands back, so the panel never
   * shows two different "paid" figures; on every other order it is
   * `charges.totalCents`.
   */
  buyerTotalCents: z.number().int(),
  /**
   * What the buyer paid, split into lines that sum to `totalCents`, by the
   * same `computeBuyerChargeBreakdown` the buyer's own order page reads
   * (`getMyOrder`), so the organizer and the buyer see the same figures.
   *
   * Null when those lines do not sum to `buyerTotalCents`: a legacy cash
   * sale with no per-item buyer totals recorded ABSORB, where the breakdown
   * leaves out the fee the cash refund hands back. The panel then shows the
   * total alone rather than lines that do not add up to it.
   */
  charges: buyerChargeBreakdownSchema.nullable(),
  /**
   * Whether the buyer has been charged, by order status (`chargeStateOf`):
   *
   * - `PAID`: SUCCEEDED, PART_REFUNDED, REFUNDED, DISPUTED. Money was taken
   *   (a refund later does not un-take it).
   * - `PROCESSING`: a delayed-settlement payment (ACH, bank transfer) whose
   *   debit has started (`confirmPayment` moves PENDING → PROCESSING when
   *   the PaymentIntent is `processing`); it becomes SUCCEEDED when the bank
   *   settles. Not yet paid, but not "nothing charged" either.
   * - `NOT_CHARGED`: PENDING (a held cart) or CANCELLED (an expired or
   *   released cart, a voided comp). No money was taken.
   *
   * The panel heads `buyerTotalCents` "Buyer paid" only when PAID, and
   * "Order total" otherwise; its lines then say what the order would cost.
   */
  chargeState: z.enum(["PAID", "PROCESSING", "NOT_CHARGED"]),
  /** `chargeState === "PAID"`. */
  buyerPaid: z.boolean(),
  /**
   * What this sale credited the EVENT: the amount its payout terms divide
   * among their payees (one OrderSplit, then one SETTLEMENT_CREDIT, per
   * payee). Not "the organizer's" credit: with a place/organizer split the
   * organizer gets only its share of it.
   *
   * - `creditState`:
   *   - `CREDITED`: `creditedCents` is the sum of the order's OrderSplit
   *     rows. Also used, with `creditedCents: 0`, when no split exists AND
   *     the rule's figure is 0: a free order (`claimFreeTickets` makes a
   *     PRIMARY SUCCEEDED order and writes no split) has nothing to credit,
   *     which is not the same as a credit still to come.
   *   - `NOT_YET`: no split written and the rule expects a positive credit.
   *     `creditedCents` is null.
   *   - `UNAVAILABLE`: the split read failed (reported, best-effort like
   *     the early-fraud-warning lookup). `creditedCents` is null and the
   *     panel says the credit could not be loaded, never "not credited".
   * - `payeeCount`: how many payees the split rows name (0 unless
   *   CREDITED from rows).
   * - `expectedCreditCents`: the credit rule's figure,
   *   `computeAgreementBasis`, the one place the rule lives. The full
   *   ticket price on an order stamped `organiserCredit: "FULL_PRICE"`
   *   (owner ruling 2026-10-11; sales stamped from 12 October 2026, the
   *   date the help pages give), the price minus the platform fee on an
   *   older one. The marker, not the date, decides.
   * - `ticketPriceCents − platformFeeTakenCents === expectedCreditCents`,
   *   so the panel can show the sum and the organizer can check it with a
   *   calculator (docs/pro-social.md, "One fee, taken once, and the sums
   *   add up").
   *
   * As credited at sale: a refund takes its own debit later, shown on the
   * items. Null where the event is not credited this way (`eventCreditOf`).
   */
  eventCredit: z
    .object({
      ticketPriceCents: z.number().int().nonnegative(),
      platformFeeTakenCents: z.number().int().nonnegative(),
      expectedCreditCents: z.number().int().nonnegative(),
      creditState: z.enum(["CREDITED", "NOT_YET", "UNAVAILABLE"]),
      creditedCents: z.number().int().nonnegative().nullable(),
      payeeCount: z.number().int().nonnegative(),
    })
    .nullable(),
  /**
   * `computeExpectedPaymentAmount(order)`: the paid figure every refund
   * starts from (`refundFullOrder`, the item refunds, the cash refund). The
   * refund confirm names this, so it matches the refund's base even on a
   * legacy order where `buyerTotalCents` (the display breakdown) departs
   * from it (`computeBuyerChargeBreakdown`, "ONE DEPARTURE").
   */
  refundBasePaidCents: z.number().int().nonnegative(),
});

export type GetOrgOrderInput = z.infer<typeof getOrgOrderInputSchema>;
export type GetOrgOrderOutput = z.infer<typeof getOrgOrderOutputSchema>;

export type GetOrgOrderDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
  /**
   * Reports the swallowed best-effort lookups: the early fraud warning and
   * the event credit's split read.
   */
  reportError?: ReporterPort | null;
};

/** Statuses of an order that never took money, so never credited anyone. */
const UNPAID_STATUSES = new Set(["PENDING", "PROCESSING", "CANCELLED"]);

/** Whether the buyer was charged; see `chargeState` in the output schema. */
function chargeStateOf(
  status: string,
): "PAID" | "PROCESSING" | "NOT_CHARGED" {
  if (status === "PROCESSING") return "PROCESSING";
  return UNPAID_STATUSES.has(status) ? "NOT_CHARGED" : "PAID";
}

/**
 * Whether the event is credited for this order by the credit rule. Not
 * for:
 *
 * - RESALE: the organizer side is credited only its share of the markup,
 *   under the event's resale terms (`resolveResaleSellerSplit`); the rest
 *   goes to the seller, whose split sits on the same order.
 * - COMP: nothing was sold; a comp is never finalized and credits no one.
 * - CASH (door cash): the organizer holds the cash itself. The sale writes
 *   no split and no SETTLEMENT_CREDIT (`refundCashOrderInTx`); the panel's
 *   cash figures say what was handed over.
 * - PENDING / PROCESSING / CANCELLED: no money was taken.
 *
 * Card sales (WEB and POS) finalize through `finalizePaymentIntent`, which
 * splits exactly `computeAgreementBasis(order)` across the payout terms.
 */
function isCreditedByRule(order: {
  source: string;
  status: string;
  paymentChannel: "WEB" | "POS" | "CASH";
}): boolean {
  return (
    order.source === "PRIMARY" &&
    order.paymentChannel !== "CASH" &&
    !UNPAID_STATUSES.has(order.status)
  );
}

/**
 * The event's credit: the rule's expected figure and its sum, beside what
 * the ledger's OrderSplit rows say was credited.
 */
function eventCreditOf(
  order: {
    amountGrossCents: number;
    feesPlatformCents: number;
    feePolicySnapshot?: unknown;
  },
  /** The order's OrderSplit rows, or null when the read failed. */
  splits: ReadonlyArray<{ payeeId: string; amountCents: number }> | null,
): {
  ticketPriceCents: number;
  platformFeeTakenCents: number;
  expectedCreditCents: number;
  creditState: "CREDITED" | "NOT_YET" | "UNAVAILABLE";
  creditedCents: number | null;
  payeeCount: number;
} {
  const expectedCreditCents = computeAgreementBasis({
    amountGrossCents: order.amountGrossCents,
    feesPlatformCents: order.feesPlatformCents,
    feePolicySnapshot: order.feePolicySnapshot ?? null,
  });
  // The basis is floored at 0 and never exceeds the (floored) ticket price,
  // so the difference is what the rule took off: 0 on a FULL_PRICE order,
  // the platform fee (capped at the price) on an older one.
  const ticketPriceCents = Math.max(order.amountGrossCents, 0);
  const rule = {
    ticketPriceCents,
    platformFeeTakenCents: ticketPriceCents - expectedCreditCents,
    expectedCreditCents,
  };
  if (splits === null) {
    return {
      ...rule,
      creditState: "UNAVAILABLE",
      creditedCents: null,
      payeeCount: 0,
    };
  }
  if (splits.length === 0) {
    // Nothing to credit (a free order) is credited $0, not pending.
    return expectedCreditCents === 0
      ? { ...rule, creditState: "CREDITED", creditedCents: 0, payeeCount: 0 }
      : { ...rule, creditState: "NOT_YET", creditedCents: null, payeeCount: 0 };
  }
  return {
    ...rule,
    creditState: "CREDITED",
    creditedCents: splits.reduce((sum, row) => sum + row.amountCents, 0),
    payeeCount: new Set(splits.map((row) => row.payeeId)).size,
  };
}

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Retrieves a single order with its items for an org admin.
 * Auth: actor must hold at least FINANCE role on the org.
 */
export async function getOrgOrder(
  deps: GetOrgOrderDeps,
  rawInput: unknown,
): Promise<GetOrgOrderOutput> {
  const logger = deps.logger?.child({ useCase: "getOrgOrder" });
  const input = parseInput(getOrgOrderInputSchema, rawInput);

  // Verify org finance permission
  const permission = await callOrDependencyFailed(
    () =>
      deps.authz.canFinanceOrg({
        actorHumanId: input.actorHumanId,
        orgId: input.orgId,
      }),
    logger,
    {
      action: "authz.canFinanceOrg",
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
    },
  );

  if (!permission.allowed) {
    throw fail("FORBIDDEN");
  }

  // Fetch order
  const order = await callOrDependencyFailed(
    () => deps.repos.orders.getById(input.orderId),
    logger,
    { action: "repos.orders.getById", orderId: input.orderId },
  );

  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  // Verify the order belongs to an event owned by this org
  const event = await deps.repos.events.getById(requireTicketingEventId(order));
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  // Event must belong to the org
  if (event.orgId !== input.orgId) {
    throw fail("ORDER_NOT_IN_ORG");
  }

  // Look up buyer info, promo redemptions, and org name in parallel
  const [buyerWithIdentity, redemptions, org, earlyFraudWarning] =
    await Promise.all([
      deps.repos.humans.getByIdWithIdentity(order.buyerHumanId),
      deps.repos.promos.listRedemptionsByOrderId(order.id),
      deps.repos.organizations.getById(input.orgId),
      // Best-effort, like the desk's display lookups: a fraud-warning read
      // failing must not 500 the order panel. Swallow → null, and report.
      deps.repos.earlyFraudWarnings.findActiveForOrder(order.id).catch((err) => {
        logger?.error("get_org_order.early_fraud_warning_lookup_failed", {
          orderId: order.id,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          deps.reportError?.(err, {
            tags: { useCase: "getOrgOrder", source: "earlyFraudWarning" },
            extra: { orderId: order.id },
          });
        } catch {
          // A throwing reporter never changes behaviour.
        }
        return null;
      }),
    ]);

  // Resolve ticket type names from the event's ticket types
  const eventTicketTypes = await deps.repos.events.listTicketTypes(
    requireTicketingEventId(order),
  );
  const ticketTypeNames: Record<string, string> = {};
  for (const tt of eventTicketTypes) {
    ticketTypeNames[tt.id] = tt.name;
  }

  // Fetch per-item ticket data in a single bulk query
  const ticketsByItemId = new Map<
    string,
    {
      code: string;
      scannedAt: Date | null;
      seatId: string | null;
      ownerHumanId: string;
    }
  >();
  const orderItemIds = order.items.map((item) => item.id);
  if (orderItemIds.length > 0) {
    const tickets = await deps.repos.tickets.listByOrderItemIds(orderItemIds);
    for (const ticket of tickets) {
      if (ticket.orderItemId) {
        ticketsByItemId.set(ticket.orderItemId, {
          code: ticket.code,
          scannedAt: ticket.scannedAt,
          seatId: ticket.seatId,
          ownerHumanId: ticket.ownerHumanId,
        });
      }
    }
  }

  // Resolve unique ticket owner names in a single bulk query
  const ownerIds = new Set<string>();
  for (const t of ticketsByItemId.values()) {
    ownerIds.add(t.ownerHumanId);
  }
  const ownerNames = new Map<string, string | null>();
  if (ownerIds.size > 0) {
    const humans = await deps.repos.humans.getByIds([...ownerIds]);
    for (const human of humans) {
      ownerNames.set(human.id, human.name ?? null);
    }
  }

  // Build billing address
  const billingAddress = order.billingAddressLine1
    ? {
        line1: order.billingAddressLine1,
        line2: order.billingAddressLine2 ?? null,
        city: order.billingCity ?? null,
        state: order.billingState ?? null,
        postalCode: order.billingPostalCode ?? null,
        country: order.billingCountry ?? null,
      }
    : null;

  // An order can now carry TWO redemptions — a typed code and a membership
  // benefit — so "the first row" is no longer a safe stand-in. Prefer the typed
  // one (it has the code an organiser would recognise and search for) and fall
  // back to the benefit, rather than letting row order decide which of the two
  // the organiser sees.
  const typedRedemption = redemptions.find((row) => row.promoId != null);
  const shownRedemption = typedRedemption ?? redemptions[0];
  const promo = shownRedemption
    ? {
        source:
          shownRedemption.promoId != null
            ? ("code" as const)
            : ("membership" as const),
        code: shownRedemption.promoId != null ? shownRedemption.code : null,
        amountDiscountCents: shownRedemption.amountDiscountCents,
      }
    : null;

  // Typed codes only: a membership benefit's ledger `code` is an internal
  // `benefit:{id}` marker, not a code anyone typed.
  const promoCodes = redemptions
    .filter((row) => row.promoId != null)
    .map((row) => row.code);

  // Legacy-safe read: projections built before the column default to WEB.
  const paymentChannel = order.paymentChannel ?? "WEB";
  const cashRefundableUntil =
    paymentChannel === "CASH"
      ? cashRefundWindowClosesAt({
          startsAt: event.startsAt,
          endsAt: event.endsAt ?? null,
        })
      : null;

  // Cash-sale figures, computed here so the panel never re-derives money:
  // the refund's own amount function, the till's comp rule, and the debit
  // row the refund would reverse. Runs only after the org check above.
  let cashSale: {
    cashAmountPaidCents: number | null;
    isComp: boolean | null;
    isFreeWithCode: boolean | null;
    cashSaleDebitCents: number | null;
  } = {
    cashAmountPaidCents: null,
    isComp: null,
    isFreeWithCode: null,
    cashSaleDebitCents: null,
  };
  if (paymentChannel === "CASH") {
    const cashAmountPaidCents = computeExpectedPaymentAmount(order);
    const { isComp, isFreeWithCode } = classifyCashSale({
      totalCents: cashAmountPaidCents,
      promoCodes,
      items: order.items,
    });
    const debit = await callOrDependencyFailed(
      () => deps.repos.payeeLedger.findCashSaleDebit(cashSaleDebitKey(order.id)),
      logger,
      { action: "repos.payeeLedger.findCashSaleDebit", orderId: order.id },
    );
    cashSale = {
      cashAmountPaidCents,
      isComp,
      isFreeWithCode,
      cashSaleDebitCents: debit?.amountCents ?? 0,
    };
  }

  // What the buyer paid. A cash sale's figure is the cash the refund hands
  // back; the breakdown's lines are kept only where they sum to it.
  const breakdown = computeBuyerChargeBreakdown(order);
  const buyerTotalCents =
    cashSale.cashAmountPaidCents ?? breakdown.totalCents;
  const charges =
    breakdown.totalCents === buyerTotalCents ? breakdown : null;
  const chargeState = chargeStateOf(order.status);

  // What the event was credited: read from the ledger (OrderSplit rows),
  // beside the rule's expected figure. Read only where the rule applies.
  // Best-effort, like the early-fraud-warning lookup: a failed read must
  // not 500 the order panel. Swallow → UNAVAILABLE, and report.
  const eventCredit = isCreditedByRule({ ...order, paymentChannel })
    ? eventCreditOf(
        order,
        // `.then` so a synchronous throw lands in the same catch.
        await Promise.resolve()
          .then(() => deps.repos.splits.getForOrder(order.id))
          .catch((err: unknown) => {
            logger?.error("get_org_order.splits_lookup_failed", {
              orderId: order.id,
              err,
            });
            try {
              deps.reportError?.(err, {
                tags: { useCase: "getOrgOrder", source: "splits" },
                extra: { orderId: order.id },
              });
            } catch {
              // A throwing reporter never changes behaviour.
            }
            return null;
          }),
      )
    : null;

  return getOrgOrderOutputSchema.parse({
    id: order.id,
    eventId: order.eventId,
    eventTitle: event.title ?? "Untitled Event",
    orgName: org?.name ?? null,
    buyerHumanId: order.buyerHumanId,
    buyerName: buyerWithIdentity?.human.name ?? null,
    buyerEmail: buyerWithIdentity?.identity.email ?? null,
    amountGrossCents: order.amountGrossCents,
    feesPlatformCents: order.feesPlatformCents,
    taxAmountCents: order.taxAmountCents,
    currency: order.currency,
    status: order.status,
    source: order.source,
    stripePaymentIntentId: order.stripePaymentIntentId,
    stripeTaxCalculationId: order.stripeTaxCalculationId ?? null,
    paymentMethodType: order.paymentMethodType ?? null,
    parentOrderId: order.parentOrderId ?? null,
    feePolicySnapshot: order.feePolicySnapshot ?? null,
    billingAddress,
    promo,
    promoCodes,
    paymentChannel,
    cashRefundableUntil,
    ...cashSale,
    occurredAt: order.occurredAt,
    paidOutAt: order.paidOutAt ?? null,
    disputeStatus: order.disputeStatus ?? null,
    refundBlockedByDispute: isBlockedSettlementDisputeStatus(
      order.disputeStatus,
    ),
    // `actionable: false` reads as "nothing to do": Stripe already saw the
    // refund/dispute, even if our own resolution hook has not caught up.
    earlyFraudWarning:
      earlyFraudWarning && earlyFraudWarning.actionable
        ? {
            fraudType: earlyFraudWarning.fraudType,
            stripeCreatedAt: earlyFraudWarning.stripeCreatedAt,
            actionable: true as const,
          }
        : null,
    items: order.items.map((i) => {
      const ticket = ticketsByItemId.get(i.id);
      return {
        id: i.id,
        kind: i.kind,
        ticketTypeId: i.ticketTypeId,
        qty: Number(i.qty),
        unitPriceCents: i.unitPriceCents,
        amountCents: i.amountCents,
        paidOutAt: i.paidOutAt,
        refundedAt: i.refundedAt,
        transferredAt: i.transferredAt,
        status: i.status,
        ticketCode: ticket?.code ?? null,
        ticketScannedAt: ticket?.scannedAt ?? null,
        // Live seat first; the item's stamped history second. A voided ticket
        // MUST give up `Ticket.seatId` (it is @unique, and a dead row holding
        // it fails the next buyer's mint after they are charged), so for every
        // refunded line the seat only exists on the item now — see
        // `orderItems.recordReleasedSeats`. Without this fallback the org's
        // order detail loses which seat it sold the moment it refunds it.
        seatId:
          ticket?.seatId ?? getMetaString(i.meta, "releasedSeatId") ?? null,
        ticketOwnerName: ticket
          ? (ownerNames.get(ticket.ownerHumanId) ?? null)
          : null,
      };
    }),
    ticketTypeNames,
    buyerTotalCents,
    charges,
    chargeState,
    buyerPaid: chargeState === "PAID",
    eventCredit,
    refundBasePaidCents: computeExpectedPaymentAmount(order),
  });
}
