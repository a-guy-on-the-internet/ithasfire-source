import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { classifyCashSale } from "../../lib/orders/classify-cash-sale";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import { fail } from "@th/errors";
import { requireTicketingEventId } from "../orders/_shared/require-ticketing-order";

// ── Schema ───────────────────────────────────────────────────────────────────

export const completePosSaleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export type CompletePosSaleInput = z.infer<typeof completePosSaleInputSchema>;

const ticketSummarySchema = z.object({
  ticketId: z.string().uuid(),
  code: z.string(),
  ticketTypeId: z.string().uuid().nullable(),
  ticketTypeName: z.string().nullable(),
  status: z.enum(["VALID", "SCANNED", "REFUNDED", "INVALID", "VOID"]),
  scannedAt: z.date().nullable(),
});

export const completePosSaleOutputSchema = z.object({
  orderId: z.string().uuid(),
  status: z.enum([
    "PENDING",
    "PROCESSING",
    "SUCCEEDED",
    "PART_REFUNDED",
    "REFUNDED",
    "CANCELLED",
    "DISPUTED",
  ]),
  paymentChannel: z.enum(["WEB", "POS", "CASH"]),
  /** What the buyer was charged, in cents (fees and tax included). */
  amountCents: z.number().int().nonnegative(),
  /**
   * Total promo discount on this sale, in cents (sum of unreleased promo
   * holds). 0 when no codes were applied.
   */
  discountCents: z.number().int().nonnegative(),
  /**
   * The promo codes on this sale (unreleased holds with a code), normalized,
   * oldest first. Empty when none. A CASH sale with codes and
   * `amountCents: 0` is "free with <CODE>", not a comp.
   */
  promoCodes: z.array(z.string()),
  /**
   * CASH only: the explicit Comp action (`classifyCashSale`, the rule the
   * till report and `recordCashSale` share). A $0 sale with a promo code is
   * not a comp. Always false for a card sale.
   */
  isComp: z.boolean(),
  ticketCount: z.number().int().nonnegative(),
  tickets: z.array(ticketSummarySchema),
});

export type CompletePosSaleOutput = z.infer<typeof completePosSaleOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type CompletePosSaleDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Read-only finaliser for the scanner Sell screen.
 *
 * Returns the current Order state and the minted tickets so the operator
 * can show the QR(s) on the SaleResultView. Safe to poll while a card
 * sale's PaymentIntent.succeeded webhook is in flight.
 *
 * For CASH orders the result is immediate — `recordCashSale` finalises
 * inline. For POS card orders this returns whatever state the existing
 * webhook + confirm-payment pipeline has reached.
 *
 * Auth: ORG_SCAN_ROLES on the event's org. Personal events are rejected.
 *
 * @throws `not_found` — orderId does not exist
 * @throws `forbidden` — actor lacks scanner role on the event's org, or
 *   the order is on a personal event (no Payee, not POS-eligible)
 * @throws `invalid_input` — order is not a POS / CASH channel order
 *   (use the regular order-detail endpoints for WEB orders)
 */
export async function completePosSale(
  deps: CompletePosSaleDeps,
  rawInput: unknown,
): Promise<CompletePosSaleOutput> {
  const input = parseInput(completePosSaleInputSchema, rawInput);

  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  const event = await deps.repos.events.getById(requireTicketingEventId(order));
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

  const paymentChannel =
    (order as { paymentChannel?: "WEB" | "POS" | "CASH" }).paymentChannel ??
    "WEB";

  if (paymentChannel === "WEB") {
    throw fail("NOT_A_POS_ORDER");
  }

  const tickets = await deps.repos.tickets.listByOrderId(order.id);

  // Promo discount for the SaleResultView ("you saved $X"). Holds are the
  // right source for both channels: still PENDING while a card sale's
  // webhook is in flight, CONFIRMED after finalise / inline cash confirm.
  // RELEASED holds (abandoned or refunded sales) don't count.
  const promoHolds = await deps.repos.promos.listHoldsForOrder(order.id);
  const liveHolds = promoHolds.filter((hold) => hold.status !== "RELEASED");
  const discountCents = liveHolds.reduce(
    (sum, hold) => sum + hold.amountDiscountCents,
    0,
  );
  // Typed codes only (a membership hold's `code` is an internal
  // `benefit:{id}` marker), oldest first so the list reads the same on
  // every poll.
  const promoCodes = liveHolds
    .filter((hold) => hold.promoId != null)
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.code.localeCompare(b.code),
    )
    .map((hold) => hold.code);
  const amountCents = computeExpectedPaymentAmount(order);

  // Resolve ticket-type names so the SaleResultView can render
  // "VIP" / "GA" alongside the QR. One short list — no N+1.
  const ticketTypeSummaries = await deps.repos.events.listTicketTypes(event.id);
  const nameByTicketType = new Map(
    ticketTypeSummaries.map((tt) => [tt.id, tt.name] as const),
  );

  const ticketDetails = tickets.map((t) => ({
    ticketId: t.id,
    code: t.code,
    ticketTypeId: t.ticketTypeId,
    ticketTypeName: t.ticketTypeId
      ? (nameByTicketType.get(t.ticketTypeId) ?? null)
      : null,
    status: t.status,
    scannedAt: t.scannedAt,
  }));

  deps.logger?.info("pos.complete_sale.success", {
    actorHumanId: input.actorHumanId,
    orderId: order.id,
    eventId: event.id,
    paymentChannel,
    orderStatus: order.status,
    ticketCount: ticketDetails.length,
  });
  deps.metrics?.increment("pos.complete_sale.success", {
    eventId: event.id,
    channel: paymentChannel,
    status: order.status,
  });

  return completePosSaleOutputSchema.parse({
    orderId: order.id,
    status: order.status,
    paymentChannel,
    // What the buyer was charged, not the ticket face. Both channels go
    // through `computeExpectedPaymentAmount`, the sum the finalize
    // AMOUNT_MISMATCH guard checks against the PaymentIntent. A card sale's
    // ticket items carry `buyerTotalCents` (face + platform fee + processing
    // share; spec 2026-10-07 FR-002), plus the order's tax. A cash sale's
    // items carry `buyerTotalCents` too (the face alone: no platform fee
    // since the owner ruling of 2026-10-08, no processing share; face +
    // platform fee on a cash sale recorded before it), plus its tax; a
    // comp's are 0. Cash orders recorded
    // before the door was priced carry none and take that function's
    // fallback branch (`amountGrossCents + feesPlatformCents`).
    amountCents,
    discountCents,
    promoCodes,
    // The same rule the till report reads (`summarizeCashTillForEvent`) and
    // `recordCashSale` reports, so the done screen, this read and the till
    // never disagree: the explicit comp only. A 100%-off promo sale is a $0
    // SALE (owner ruling), not a comp.
    isComp:
      paymentChannel === "CASH" &&
      classifyCashSale({ totalCents: amountCents, promoCodes, items: order.items })
        .isComp,
    ticketCount: ticketDetails.length,
    tickets: ticketDetails,
  });
}
