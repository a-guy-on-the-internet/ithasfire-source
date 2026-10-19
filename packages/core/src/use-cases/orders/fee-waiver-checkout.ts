import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { FeeWaiverRecord } from "@th/types";

import {
  collectWaivableTicketFees,
  type OrderComputation,
} from "./checkout-helpers";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";

export type FeeWaiverCheckoutOutcome = {
  /** Tickets on this order whose platform fee is covered by an allowance. */
  waivedTickets: number;
  /** Platform fee forgone across every allowance consumed by this order. */
  feeWaivedCents: number;
  waiverIds: string[];
};

const NO_WAIVER: FeeWaiverCheckoutOutcome = {
  waivedTickets: 0,
  feeWaivedCents: 0,
  waiverIds: [],
};

/**
 * The ONE waiver lookup: which allowances apply to this buyer at this event.
 * Shared by the charge (`reserveFeeWaiverForCheckout`, on its transaction)
 * and the hold's estimate (`lookupFeeWaiverHeadroomForHold`, BEFORE its
 * transaction) so the two can't resolve different allowances.
 */
function resolveApplicableWaivers(
  repos: Pick<TxRepos, "feeWaivers">,
  event: { orgId: string | null; humanId: string | null },
  buyerHumanId: string | null,
  now: Date,
) {
  return repos.feeWaivers.resolveApplicable({
    buyerHumanId,
    organizerOrgId: event.orgId,
    organizerHumanId: event.orgId ? null : event.humanId,
    at: now,
  });
}

/**
 * How many tickets of fee-waiver allowance a HOLD can count on — read-only,
 * nothing reserved, and run BEFORE the hold's transaction.
 *
 * Best-effort, so it must not run inside the transaction: a failed SELECT
 * aborts a Postgres transaction, and swallowing it there turns the hold's
 * next statement into a 25P02 blamed on the wrong line (engineering
 * standards, "Swallowing an error inside a transaction", shape 1). Takes the
 * full `Repos` bag so passing a transaction handle is a compile error.
 *
 * Each applicable allowance contributes its headroom (granted − used). A
 * cart the hold updates never holds a reservation of its own (reservations
 * are made by `createCheckout`, and a cart with a PaymentIntent is refused by
 * `updateOrderItems`), so headroom is what the charge will find.
 *
 * NEVER throws: a broken lookup prices the hold at full fee — what the
 * charge would also show without a waiver — and reports via `reportError`.
 */
export async function lookupFeeWaiverHeadroomForHold(params: {
  repos: Repos;
  eventId: string;
  buyerHumanId: string | null;
  now: Date;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /**
   * Who is estimating, for the report's tags. The cart hold by default; the
   * door's Sell-screen quote (`quotePosCart`) passes its own.
   */
  useCase?: string;
}): Promise<{ headroomTickets: number }> {
  const { repos, eventId, buyerHumanId, now, logger, reportError } = params;
  try {
    const event = await repos.events.getById(eventId);
    // Unknown event: the transaction refuses it properly (EVENT_NOT_FOUND).
    if (!event) return { headroomTickets: 0 };
    const applicable = await resolveApplicableWaivers(
      repos,
      event,
      buyerHumanId,
      now,
    );
    return {
      headroomTickets: applicable.reduce(
        (sum, waiver) =>
          sum + Math.max(0, waiver.ticketsGranted - waiver.ticketsUsed),
        0,
      ),
    };
  } catch (err) {
    logger?.error("fee_waiver_estimate_failed", { err, eventId });
    reportBestEffort(reportError, err, {
      tags: {
        useCase: params.useCase ?? "updateOrderItems",
        step: "estimateFeeWaiver",
      },
      extra: { eventId },
    });
    return { headroomTickets: 0 };
  }
}

/**
 * How many tickets of fee-waiver allowance the CHARGE of the buyer's own
 * pending cart will find: what is free now, plus what that cart itself has
 * reserved. Read-only, nothing reserved.
 *
 * `lookupFeeWaiverHeadroomForHold` is right for a cart that holds no
 * reservation. A cart `createCheckout` already priced (a declined card, a
 * reloaded payment step) does hold one, and the next `createCheckout` retires
 * that cart FIRST, which releases the reservation, and only then looks the
 * allowance up. So that reservation is back in the allowance by the time the
 * charge reads it, and a quote that left it out would price a fee the charge
 * does not take.
 *
 * A reservation counts only if its allowance would still apply once released:
 * not REVOKED, inside its window at `now`, and granted to this buyer or to
 * this event's organiser (the filter `resolveApplicable` runs, as it reads
 * AFTER the release: the release gives the allowance headroom again and
 * re-opens an EXHAUSTED one). Anything else is left out, which quotes the
 * fee HIGHER, never lower.
 *
 * NEVER throws, like the hold's lookup: a broken read counts no reservation
 * (the higher quote) and reports via `reportError`.
 */
export async function lookupFeeWaiverHeadroomForHeldCart(params: {
  repos: Repos;
  event: { id: string; orgId: string | null; humanId: string | null };
  buyerHumanId: string | null;
  /** The buyer's own PENDING cart, already checked to be theirs. */
  heldOrderId: string;
  now: Date;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  useCase: string;
}): Promise<{ headroomTickets: number }> {
  const { repos, event, buyerHumanId, heldOrderId, now, logger, reportError } =
    params;
  const free = await lookupFeeWaiverHeadroomForHold({
    repos,
    eventId: event.id,
    buyerHumanId,
    now,
    logger,
    reportError,
    useCase: params.useCase,
  });
  let ownReservedTickets = 0;
  try {
    const redemptions = await repos.feeWaivers.listRedemptionsByOrder(
      heldOrderId,
    );
    for (const redemption of redemptions) {
      if (redemption.status !== "RESERVED" || redemption.ticketsReserved <= 0) {
        continue;
      }
      const waiver = await repos.feeWaivers.getById(redemption.waiverId);
      if (
        waiver &&
        waiverAppliesOnceReleased(waiver, event, buyerHumanId, now)
      ) {
        ownReservedTickets += redemption.ticketsReserved;
      }
    }
  } catch (err) {
    ownReservedTickets = 0;
    logger?.error("fee_waiver_own_reservation_lookup_failed", {
      err,
      eventId: event.id,
      orderId: heldOrderId,
    });
    reportBestEffort(reportError, err, {
      tags: { useCase: params.useCase, step: "ownFeeWaiverReservation" },
      extra: { eventId: event.id, orderId: heldOrderId },
    });
  }
  return { headroomTickets: free.headroomTickets + ownReservedTickets };
}

/**
 * `resolveApplicable`'s filter for one allowance as it will read once this
 * cart's reservation is released: not revoked, inside its window, and granted
 * to this buyer or this organiser.
 */
function waiverAppliesOnceReleased(
  waiver: FeeWaiverRecord,
  event: { orgId: string | null; humanId: string | null },
  buyerHumanId: string | null,
  now: Date,
): boolean {
  // EXHAUSTED counts: the release re-opens an exhausted allowance (it is
  // exhausted BECAUSE of reservations like this one). REVOKED never comes back.
  if (waiver.status === "REVOKED") return false;
  if (waiver.effectiveFrom.getTime() > now.getTime()) return false;
  if (waiver.effectiveTo && waiver.effectiveTo.getTime() <= now.getTime()) {
    return false;
  }
  if (waiver.side === "BUYER") {
    return (
      waiver.subjectType === "HUMAN" &&
      buyerHumanId !== null &&
      waiver.subjectId === buyerHumanId
    );
  }
  // ORGANIZER: the event's org, or its human when the event has no org.
  if (waiver.subjectType === "ORG") {
    return event.orgId !== null && waiver.subjectId === event.orgId;
  }
  return (
    waiver.subjectType === "HUMAN" &&
    event.orgId === null &&
    event.humanId !== null &&
    waiver.subjectId === event.humanId
  );
}

/**
 * The tickets a hold prices as waived: the allowance headroom found BEFORE
 * the transaction, capped at the fee-bearing tickets on this order (the same
 * ladder `reserveFeeWaiverForCheckout` reserves against). Pure — safe inside
 * the transaction.
 */
export function waivedTicketsForHold(
  computation: OrderComputation,
  headroomTickets: number,
): number {
  return Math.min(
    collectWaivableTicketFees(computation).length,
    Math.max(0, headroomTickets),
  );
}

/**
 * Reserves fee-waiver allowance for a checkout, if any applies.
 *
 * Reserve-at-checkout (not at payment success) is deliberate: the platform fee
 * is quoted to the buyer and baked into the PaymentIntent amount, so the
 * allowance must be committed at the moment we promise the discount. The cost
 * is that an abandoned cart holds allowance until `release` runs — which is why
 * the expiry sweep and the refund path both call `feeWaivers.release(orderId)`.
 *
 * Consumes across MULTIPLE allowances when one is too small to cover the whole
 * order; each successive waiver prices against the remaining (still descending)
 * slice of the fee ladder.
 *
 * Runs ON the checkout transaction, after the superseded cart has been
 * retired: that retirement RELEASES the cart's own reservation, and only a
 * lookup on the same transaction sees that allowance again (a lookup before
 * the transaction would miss an allowance the superseded cart had used up,
 * and the retry would charge the full fee).
 *
 * Does NOT catch. The only swallowed condition is the business one — an
 * allowance that lost a race reports `reservedTickets: 0` and the next is
 * tried (engineering standards, "Swallowing an error inside a transaction",
 * shape 2). A failed statement used to be caught here and the checkout
 * continued on an aborted transaction: the next statement raised 25P02 and
 * the checkout failed anyway, blamed on the wrong line. Now the real error
 * propagates and the transaction rolls back.
 */
export async function reserveFeeWaiverForCheckout(params: {
  tx: TxRepos;
  event: { id: string; orgId: string | null; humanId: string | null };
  orderId: string;
  buyerHumanId: string | null;
  computation: OrderComputation;
  now: Date;
  logger?: LoggerPort;
}): Promise<FeeWaiverCheckoutOutcome> {
  const { tx, event, orderId, buyerHumanId, computation, now, logger } =
    params;

  // Ladder of per-ticket platform fees, most expensive first. Empty when the
  // order is free, fully capped, or in ABSORB with a zero fee — nothing to
  // waive, so don't burn allowance.
  let remainingLadder = collectWaivableTicketFees(computation);
  if (remainingLadder.length === 0) {
    return NO_WAIVER;
  }

  const applicable = await resolveApplicableWaivers(
    tx,
    event,
    buyerHumanId,
    now,
  );

  if (applicable.length === 0) {
    return NO_WAIVER;
  }

  let waivedTickets = 0;
  let feeWaivedCents = 0;
  const waiverIds: string[] = [];

  for (const waiver of applicable) {
    if (remainingLadder.length === 0) break;

    const result = await tx.feeWaivers.reserve({
      waiverId: waiver.id,
      orderId,
      waivableTicketFeesCents: remainingLadder,
    });

    if (result.reservedTickets <= 0) {
      // Lost a race for the last ticket of this allowance — try the next.
      continue;
    }

    waivedTickets += result.reservedTickets;
    feeWaivedCents += result.feeWaivedCents;
    waiverIds.push(waiver.id);
    remainingLadder = remainingLadder.slice(result.reservedTickets);
  }

  if (waivedTickets > 0) {
    logger?.info("fee_waiver_reserved", {
      orderId,
      eventId: event.id,
      waivedTickets,
      feeWaivedCents,
      waiverIds,
    });
  }

  return { waivedTickets, feeWaivedCents, waiverIds };
}
