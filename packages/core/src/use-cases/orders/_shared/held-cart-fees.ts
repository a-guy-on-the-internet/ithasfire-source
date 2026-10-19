import { isAppError, isInternalCode } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventTicketTypeSummary } from "@th/types";

import type { TicketDiscount } from "../../../lib/orders/discounted-to-zero";
import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import {
  aggregateItems,
  computeOrderAmounts,
  loadAgreementContext,
  type SeatPrices,
} from "../checkout-helpers";
import {
  lookupFeeWaiverHeadroomForHeldCart,
  waivedTicketsForHold,
} from "../fee-waiver-checkout";
import { toDoorTicketTypeSummaries } from "../../pos/_shared/door-ticket-types";

/**
 * The platform fee `createCheckout` will charge the buyer for their HELD cart
 * with a given set of discounts, stated as the fee itself.
 *
 * Why the server states it, and why not as a change to a figure the page
 * already holds: the fee a held order carries was priced at a different
 * moment with different knowledge. A fresh hold was priced with no promo (so
 * it still carries the fee of a ticket the promo makes free); a cart
 * `createCheckout` already priced was priced WITH one (so that fee is already
 * gone); and a fee waiver ranks the tickets by fee, so freeing one ticket can
 * move the waiver onto another. No single subtraction is right for all three.
 * This is the charge's own computation instead, run on the cart as it stands.
 *
 * The steps are `createCheckout`'s (see its "Promo codes and membership
 * benefits" and "Fee waiver" blocks), on the same `computeOrderAmounts`:
 *
 *   1. price the cart with the discounts, so a ticket they bring down to $0
 *      carries no platform fee (owner ruling 2026-10-10);
 *   2. count the fee-waiver allowance the charge will find: what is free now
 *      plus what this cart itself has reserved, which the charge releases
 *      before it reserves again (`lookupFeeWaiverHeadroomForHeldCart`);
 *   3. re-price with that many tickets waived.
 *
 * Nothing is reserved or written. Two things can still move between this
 * quote and the charge, and both are the charge's to decide: another buyer
 * taking the last ticket of a shared allowance (the charge then takes a fee
 * this quote waived), and a price or fee policy changing. Neither is new;
 * the hold's own waiver estimate has always had the first.
 *
 * `null` means "no statement": the page keeps the fee it has.
 *  - The cart cannot be bought as it stands (a tier off sale, a
 *    pay-what-you-want amount under its minimum, seats that do not cover the
 *    quantity): `createCheckout` refuses the same cart, so there is no fee
 *    to state. Not a fault, not reported.
 *  - A fault while pricing or reading: reported, then `null`, so a promo
 *    preview is never lost to this figure.
 *
 * What the page falls back to without a statement is the fee its order
 * carries. For a fresh hold that is the no-promo fee: right, or HIGH by the
 * fee of a ticket the promo frees. For a cart `createCheckout` already priced
 * it is that charge's own fee: right while the codes are the ones it was
 * priced with, and LOW by a freed ticket's fee only if such a code has since
 * been removed and no statement has arrived for the cart without it. The
 * payment step that follows shows `createCheckout`'s figures before the buyer
 * pays, so that gap is a quote on the details step, never a charge.
 *
 * That last case is why the statement also carries `withoutDiscounts`: the
 * same two figures for this cart with NO discount at all. A statement is for
 * one set of codes; the moment the buyer changes them the page has none for
 * the new set until the server answers, and it shows no discount meanwhile.
 * The fee that belongs beside "no discount" is the no-discount fee, and the
 * page has it from the last statement made for this cart (it depends on the
 * tickets and the allowance, not on the codes). So removing a freeing code
 * from a cart `createCheckout` had priced shows the full-price fee at once,
 * not that charge's smaller one. The gap left is a cart for which no
 * statement has EVER arrived (the preview is down, or the code is removed in
 * the moment after a reload): there the page still has only the order's fee.
 *
 * A free order (the discounts cover every ticket) has no fee: both figures 0.
 */
export type HeldCartFeeFigures = {
  /**
   * What the buyer pays in platform fee: the order's `buyerFeesCents` as
   * `createCheckout` will stamp it.
   */
  buyerPlatformFeeCents: number;
  /**
   * The platform fee a fee waiver takes off this cart, as the charge will
   * apply it: on the tickets that still carry a fee once the discounts are
   * in. The hold's own figure can name a ticket the promo frees instead.
   */
  platformFeeWaivedCents: number;
};

export type HeldCartFees = HeldCartFeeFigures & {
  /**
   * The same figures for this cart if NO discount applied (no code, no
   * membership benefit), with the same allowance. For the page to show
   * beside "no discount" while it has no statement for a changed set of
   * codes. Not a bound on the other figures: with an order-level fee cap AND
   * a waiver, freeing the dearest ticket can leave MORE fee on the rest (the
   * waiver was taking most of the capped fee; with a $5.00 order cap,
   * 2 x $100 + $500 and one waived ticket pay $1.50 undiscounted and $2.50
   * with the $500 ticket freed), so never combine the two with a
   * `min`/`max`; show one or the other.
   */
  withoutDiscounts: HeldCartFeeFigures;
};

export async function quoteHeldCartFees(
  deps: {
    repos: Repos;
    logger?: LoggerPort;
    reportError?: ReporterPort | null;
  },
  params: {
    event: { id: string; orgId: string | null; humanId: string | null };
    /** The buyer the session asserts. */
    buyerHumanId: string | null;
    /** Their own PENDING cart on this event, already verified to be theirs. */
    heldOrderId: string;
    /** The cart, as `createCheckout` will be sent it. */
    selections: ReadonlyArray<{
      ticketTypeId: string;
      qty: number;
      seatIds?: string[];
      donationAmountCents?: number;
    }>;
    /** The event's ticket types as `events.listTicketTypes` lists them, every status. */
    ticketTypes: ReadonlyArray<EventTicketTypeSummary>;
    /** Each picked seat's override (`null`/absent: priced at its tier). */
    seatOverrides: ReadonlyMap<string, number | null>;
    /** `PromoEvaluationResult.ticketDiscounts` for this cart. */
    discounts: ReadonlyArray<TicketDiscount>;
    totalDiscountCents: number;
    now: Date;
    /** Who is asking, for the report's tags. */
    useCase: string;
  },
): Promise<HeldCartFees | null> {
  const { event, now } = params;
  try {
    const items = aggregateItems(
      params.selections.map((selection) => ({
        ticketTypeId: selection.ticketTypeId,
        qty: selection.qty,
        seatIds: selection.seatIds ?? [],
        donationAmountCents: selection.donationAmountCents,
      })),
    );
    // ACTIVE tiers only, as the charge builds its map: a retired tier in the
    // cart is refused there (`ticket_type_not_found`), and so is not priced
    // here. The projection is the shared one the door sale and its quote
    // use, field for field `createCheckout`'s: the raw price, schedule and
    // sales window go to `computeOrderAmounts`, which is where a ticket's
    // price is resolved and its sales window enforced. Nothing here reads
    // them.
    const ticketTypes = toDoorTicketTypeSummaries(
      params.ticketTypes.filter((ticketType) => ticketType.status === "ACTIVE"),
    );
    // Every requested seat has an entry (`computeOrderAmounts` refuses a seat
    // it was given no price for); a seat with no override is `null`.
    const seatPrices: SeatPrices = new Map(
      items.flatMap((item) =>
        item.seatIds.map(
          (seatId) =>
            [seatId, params.seatOverrides.get(seatId) ?? null] as const,
        ),
      ),
    );
    // Reads only; the repos are the same objects a transaction hands out.
    const agreementContext = await loadAgreementContext(
      deps.repos as unknown as TxRepos,
      event.id,
      now,
      { logger: deps.logger, reportError: deps.reportError },
    );
    // The charge's two steps for one set of discounts: price, then waive as
    // many of the tickets that still carry a fee as the allowance covers.
    const price = (
      discounts: ReadonlyArray<TicketDiscount>,
      waivedTickets: number,
    ) =>
      computeOrderAmounts(items, ticketTypes, agreementContext, {
        now,
        reportError: deps.reportError,
        seatPrices,
        ...(discounts.length > 0 ? { discounts } : {}),
        ...(waivedTickets > 0 ? { waivedTickets } : {}),
      });
    const figures = (
      discounts: ReadonlyArray<TicketDiscount>,
      headroomTickets: number,
    ): HeldCartFeeFigures => {
      const unwaived = price(discounts, 0);
      const waivedTickets = waivedTicketsForHold(unwaived, headroomTickets);
      const computation =
        waivedTickets > 0 ? price(discounts, waivedTickets) : unwaived;
      return {
        buyerPlatformFeeCents: computation.buyerFeesCents,
        platformFeeWaivedCents: computation.feesWaivedCents,
      };
    };

    // Priced once before any read of the allowance: a cart the charge
    // refuses is refused here, with nothing looked up.
    const face = price([], 0);
    const { headroomTickets } = await lookupFeeWaiverHeadroomForHeldCart({
      repos: deps.repos,
      event,
      buyerHumanId: params.buyerHumanId,
      heldOrderId: params.heldOrderId,
      now,
      logger: deps.logger,
      reportError: deps.reportError ?? undefined,
      useCase: params.useCase,
    });
    const withoutDiscounts = figures([], headroomTickets);
    if (params.discounts.length === 0) {
      return { ...withoutDiscounts, withoutDiscounts };
    }
    if (face.amountGrossCents - params.totalDiscountCents <= 0) {
      // A free order: claimed, not charged, and it carries no fee.
      return {
        buyerPlatformFeeCents: 0,
        platformFeeWaivedCents: 0,
        withoutDiscounts,
      };
    }
    return { ...figures(params.discounts, headroomTickets), withoutDiscounts };
  } catch (err) {
    if (!isCartRefusal(err)) {
      deps.logger?.error("held_cart_fee_quote_failed", {
        err,
        eventId: event.id,
        orderId: params.heldOrderId,
      });
      reportBestEffort(deps.reportError, err, {
        tags: { useCase: params.useCase, step: "quoteHeldCartFees" },
        extra: { eventId: event.id, orderId: params.heldOrderId },
      });
    }
    return null;
  }
}

/**
 * A refusal the charge would give the buyer for this cart (typed, and not an
 * internal invariant), as opposed to a fault. Both of the shapes the pricing
 * helpers throw: an `AppError` and the older `{ code, message }` literal.
 */
function isCartRefusal(err: unknown): boolean {
  if (isAppError(err)) {
    return !isInternalCode(err.code);
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "invalid_input" || code === "not_found" || code === "conflict";
}
