import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import { fail } from "@th/errors";

// ── Schema ───────────────────────────────────────────────────────────────────

export const getCashTillReportInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  /** How many recent sales to return alongside the totals. */
  recentLimit: z.number().int().positive().max(100).default(20),
});

export type GetCashTillReportInput = z.infer<
  typeof getCashTillReportInputSchema
>;

const cashTillSaleSchema = z.object({
  orderId: z.string().uuid(),
  shortId: z.string().nullable(),
  amountCents: z.number().int().nonnegative(),
  ticketCount: z.number().int().nonnegative(),
  /**
   * The explicit Comp action only (`classifyCashSale`, the rule
   * `recordCashSale` reports). A $0 sale with a promo code is not a comp.
   */
  isComp: z.boolean(),
  /**
   * First promo code redeemed on the sale, normalized; null when none. With
   * `amountCents: 0` the row reads "Free with <CODE>".
   */
  promoCode: z.string().nullable(),
  isRefunded: z.boolean(),
  occurredAt: z.date(),
});

export const getCashTillReportOutputSchema = z.object({
  eventId: z.string().uuid(),
  currency: z.string().min(3).max(3),
  /**
   * True when this event has more cash orders than the read scans, so the
   * figures below cover only the most recent slice. Surfaced rather than
   * swallowed: a capped total that looks complete is worse than no total.
   */
  truncated: z.boolean(),
  /**
   * Sales recorded as sales. Excludes comps, sales made free by a promo code
   * and refunds.
   */
  paidSaleCount: z.number().int().nonnegative(),
  /**
   * What should be in the box, in cents. THE number this whole read exists
   * for. Refunded sales are already netted out.
   */
  cashCollectedCents: z.number().int().nonnegative(),
  /**
   * The split of `cashCollectedCents` (spec 2026-10-07 FR-009):
   * `taxCents + platformFeeOwedCents + organiserKeepsCents ===
   * cashCollectedCents`. Tax is owed to the platform (it remits it) and
   * comes out of the organiser's next payout (owner ruling R6).
   * `platformFeeOwedCents` is read from what each order RECORDED: a cash
   * sale since the owner ruling of 2026-10-08 carries no platform fee and
   * adds 0, so the figure is non-zero only for cash sales recorded before
   * it (a UI may hide the row when it is 0).
   */
  taxCents: z.number().int().nonnegative(),
  platformFeeOwedCents: z.number().int().nonnegative(),
  organiserKeepsCents: z.number().int().nonnegative(),
  /** Explicit comps — the guest list. Not $0 sales made free by a code. */
  compSaleCount: z.number().int().nonnegative(),
  compTicketCount: z.number().int().nonnegative(),
  /**
   * Sales whose total is $0 because of a promo code (a 100%-off code makes a
   * $0 SALE, owner ruling; never a comp). Unrefunded only. They add 0 to
   * every money figure above.
   */
  freeWithCodeSaleCount: z.number().int().nonnegative(),
  freeWithCodeTicketCount: z.number().int().nonnegative(),
  paidTicketCount: z.number().int().nonnegative(),
  refundedSaleCount: z.number().int().nonnegative(),
  /** Cash handed back, in cents. Already excluded from `cashCollectedCents`. */
  refundedCents: z.number().int().nonnegative(),
  recentSales: z.array(cashTillSaleSchema),
});

export type GetCashTillReportOutput = z.infer<
  typeof getCashTillReportOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type GetCashTillReportDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * What the door took in cash tonight.
 *
 * WHY THIS EXISTS. A cash sale is recorded as an Order with
 * `paymentChannel: "CASH"` and never enters Settlement, because the organiser
 * is already holding the money and the platform has nothing to move. That is
 * the correct model. Its consequence is that cash is absent from every money
 * surface in the product — payouts, settlement lines, revenue tiles — all of
 * which read the Settlement side. So the till was simultaneously accurate and
 * unreadable, and the one question a person closing a door actually asks
 * ("how much should be in this box?") had no answer anywhere.
 *
 * SCOPE, stated so the next reader does not think it was overlooked: this is
 * EVENT-level, not per-operator. `Order` carries no `soldByHumanId` — the only
 * operator trace a cash sale leaves is the `TicketScan.actorHumanId` written by
 * auto-admit — so attributing a drawer to a person needs a schema change rather
 * than a different query. Reconciling the box is the event-level question and
 * it is answerable today; "who took which sale" is a separate, additive
 * feature.
 *
 * Auth: ORG_SCAN_ROLES — the same role that can take the money can count it.
 * Read-only, so it is safe to poll while a door is running.
 */
export async function getCashTillReport(
  deps: GetCashTillReportDeps,
  rawInput: unknown,
): Promise<GetCashTillReportOutput> {
  const input = parseInput(getCashTillReportInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }

  await requireScannerAccessOnOrg({
    repos: deps.repos,
    authz: deps.authz,
    orgId: event.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const summary = await deps.repos.orders.summarizeCashTillForEvent({
    eventId: input.eventId,
    recentLimit: input.recentLimit,
  });

  return {
    eventId: input.eventId,
    currency: event.currency ?? "usd",
    truncated: summary.truncated,
    paidSaleCount: summary.paidSaleCount,
    cashCollectedCents: summary.cashCollectedCents,
    taxCents: summary.taxCents,
    platformFeeOwedCents: summary.platformFeeOwedCents,
    organiserKeepsCents: summary.organiserKeepsCents,
    compSaleCount: summary.compSaleCount,
    compTicketCount: summary.compTicketCount,
    freeWithCodeSaleCount: summary.freeWithCodeSaleCount,
    freeWithCodeTicketCount: summary.freeWithCodeTicketCount,
    paidTicketCount: summary.paidTicketCount,
    refundedSaleCount: summary.refundedSaleCount,
    refundedCents: summary.refundedCents,
    recentSales: summary.recentSales,
  };
}
