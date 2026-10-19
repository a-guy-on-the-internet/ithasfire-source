import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { CashSaleListRow } from "@th/ports/repos/orders";
import { fail } from "@th/errors";

import { cashRefundWindowClosesAt } from "../../lib/cash-refund-window";
import { parseInput } from "../../lib/io";
import { classifyCashSale } from "../../lib/orders/classify-cash-sale";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import {
  ORG_SCAN_ROLES,
  requireScannerAccessOnOrg,
  type ScannerAccessResult,
} from "../../lib/rbac";
import { ORG_CASH_REFUND_ROLES } from "./org-refund-cash-sale";

// ── Schema ───────────────────────────────────────────────────────────────────

/** Largest page the list serves; a bigger `limit` is cut to this. */
export const LIST_EVENT_CASH_SALES_MAX_LIMIT = 50;

export const listEventCashSalesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    /** The org the actor is acting for; the event must belong to it. */
    orgId: z.uuid(),
    eventId: z.uuid(),
    /** `nextCursor` from the previous page. Opaque. */
    cursor: z.string().min(1).max(200).optional(),
    limit: z
      .number()
      .int()
      .positive()
      .default(25)
      .transform((n) => Math.min(n, LIST_EVENT_CASH_SALES_MAX_LIMIT)),
  })
  .strict();

export type ListEventCashSalesInput = z.input<
  typeof listEventCashSalesInputSchema
>;

const eventCashSaleSchema = z.object({
  orderId: z.uuid(),
  soldAt: z.date(),
  ticketCount: z.number().int().nonnegative(),
  /**
   * What the buyer paid, which is what a refund hands back:
   * `computeExpectedPaymentAmount`, the sum `orgRefundCashSale` returns as
   * `amountReturnedCents`. 0 for a comp and for a sale made free by a code.
   */
  amountPaidCents: z.number().int().nonnegative(),
  /** First typed promo code on the sale, or null. */
  promoCode: z.string().nullable(),
  /** The explicit Comp action only (`classifyCashSale`). */
  isComp: z.boolean(),
  /** $0 because of a promo code: a SALE, never a comp (owner ruling). */
  isFreeWithCode: z.boolean(),
  /**
   * Only SUCCEEDED can be refunded. PART_REFUNDED is listed for parity with
   * the till; no cash path writes it today.
   */
  status: z.enum(["SUCCEEDED", "REFUNDED", "PART_REFUNDED"]),
  /** When the cash refund ran (stamped on its ticket items); null otherwise. */
  refundedAt: z.date().nullable(),
});

export const listEventCashSalesOutputSchema = z.object({
  items: z.array(eventCashSaleSchema),
  nextCursor: z.string().nullable(),
  /**
   * The org refund window's close (`cashRefundWindowClosesAt`: event end + 7
   * days, inclusive). A member whose role may refund (`canRefund`) can until
   * this instant; after it, only platform staff.
   */
  refundableUntil: z.date(),
  /**
   * Whether the caller may refund a cash sale: a role in
   * `ORG_CASH_REFUND_ROLES`, the set `orgRefundCashSale` gates on, or
   * platform staff (ADMIN).
   */
  canRefund: z.boolean(),
  /**
   * False when the caller is platform staff (ADMIN), whom
   * `orgRefundCashSale` does not hold to `refundableUntil`. The Refund button
   * shows when `canRefund && (!refundWindowApplies || now <= refundableUntil)`
   * and the row is SUCCEEDED.
   */
  refundWindowApplies: z.boolean(),
});

export type ListEventCashSalesOutput = z.infer<
  typeof listEventCashSalesOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type ListEventCashSalesDeps = {
  repos: Repos;
  /** The platform-admin override and the staff check behind the window. */
  authz: Pick<AuthZPort, "hasStaffRole">;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Every cash sale of one event, newest first, keyset-paged: the list the Sell
 * screen refunds from (owner ruling 2026-10-08). Editors refund cash from
 * Sell, not from Orders, so each row carries what the refund needs and
 * nothing about the buyer: no email, name or address. Orders keeps buyer PII
 * for Owner/Admin/Finance.
 *
 * AUTH: the till's gate (`requireScannerAccessOnOrg`, ORG_SCAN_ROLES) on
 * `orgId`, checked before the event is read. An event that is not this org's
 * answers EVENT_NOT_FOUND, so the read is no oracle for other orgs' event
 * ids. A Scanner may list but `canRefund` is false: the refund
 * (`orgRefundCashSale`) is ORG_CASH_REFUND_ROLES (Owner, Admin, Editor,
 * Finance). A Finance member may refund but cannot list here (not in
 * ORG_SCAN_ROLES); they refund from Orders. A platform admin (with or
 * without a membership, of any role) passes as the till's override does, may
 * refund, and is not held to the window: `refundCapability` reads the
 * refund's own role set.
 *
 * "Sold by" is not on the row: `Order` records no seller (see
 * `getCashTillReport`).
 */
export async function listEventCashSales(
  deps: ListEventCashSalesDeps,
  rawInput: unknown,
): Promise<ListEventCashSalesOutput> {
  const input = parseInput(listEventCashSalesInputSchema, rawInput);

  const access = await requireScannerAccessOnOrg({
    repos: deps.repos,
    authz: deps.authz,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const event = await deps.repos.events.getById(input.eventId);
  if (!event || event.orgId !== input.orgId) {
    throw fail("EVENT_NOT_FOUND");
  }

  const { canRefund, refundWindowApplies } = await refundCapability(deps, {
    actorHumanId: input.actorHumanId,
    access,
  });

  const page = await deps.repos.orders.listCashSalesForEvent({
    eventId: event.id,
    cursor: input.cursor ?? null,
    limit: input.limit,
  });

  return listEventCashSalesOutputSchema.parse({
    items: page.items.map(toListRow),
    nextCursor: page.nextCursor,
    refundableUntil: cashRefundWindowClosesAt({
      startsAt: event.startsAt,
      endsAt: event.endsAt ?? null,
    }),
    canRefund,
    refundWindowApplies,
  });
}

/**
 * What `orgRefundCashSale` would let this caller do, decided the way it
 * decides it:
 *  - its gate is `requireScannerAccessOnOrg` with ORG_CASH_REFUND_ROLES, the
 *    constant read below, so a member in that set passes by membership (of
 *    the roles this list admits: Owner, Admin, Editor), and anyone else (a
 *    Scanner here) passes only through the platform-ADMIN override;
 *  - its `checkRefundable` holds an org member to the window unless they are
 *    also platform ADMIN, and never holds the platform override.
 * The platform override already proved ADMIN in the gate above; any member
 * is asked once.
 */
async function refundCapability(
  deps: ListEventCashSalesDeps,
  args: { actorHumanId: string; access: ScannerAccessResult },
): Promise<{ canRefund: boolean; refundWindowApplies: boolean }> {
  if (args.access.via === "platform_admin") {
    return { canRefund: true, refundWindowApplies: false };
  }
  const staff = await deps.authz.hasStaffRole({
    actorHumanId: args.actorHumanId,
    requiredRoles: ["ADMIN"],
  });
  return {
    canRefund:
      ORG_CASH_REFUND_ROLES.includes(args.access.role) || staff.allowed,
    refundWindowApplies: !staff.allowed,
  };
}

function toListRow(row: CashSaleListRow) {
  // The refund's own sum, so the row and the refund never disagree.
  const amountPaidCents = computeExpectedPaymentAmount({
    amountGrossCents: row.amountGrossCents,
    feesPlatformCents: row.feesPlatformCents,
    taxAmountCents: row.taxAmountCents,
    items: row.items,
  });
  // Classified on that same amount, as `completePosSale` does, so a row that
  // reads $0 with a code is the row that says "free with <CODE>".
  const { isComp, isFreeWithCode } = classifyCashSale({
    totalCents: amountPaidCents,
    promoCodes: row.promoCodes,
    items: row.items.filter((item) => item.kind === "ticket"),
  });
  return {
    orderId: row.orderId,
    soldAt: row.occurredAt,
    ticketCount: row.ticketCount,
    amountPaidCents,
    promoCode: row.promoCodes[0] ?? null,
    isComp,
    isFreeWithCode,
    status: row.status,
    refundedAt: row.status === "SUCCEEDED" ? null : latestRefundedAt(row),
  };
}

/** The cash refund stamps every ticket item alike; take the latest stamp. */
function latestRefundedAt(row: CashSaleListRow): Date | null {
  let latest: Date | null = null;
  for (const item of row.items) {
    if (item.kind !== "ticket" || !item.refundedAt) continue;
    if (!latest || item.refundedAt.getTime() > latest.getTime()) {
      latest = item.refundedAt;
    }
  }
  return latest;
}
