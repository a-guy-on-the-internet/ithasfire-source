// ─────────────────────────────────────────────────────────────────────────────
// What Stripe says became of an order's PaymentIntent
//
// A confirm that errored or never answered is not proof that nothing was
// charged, so before the widget tells a buyer their payment failed, or lets
// an order go and invites them to buy again, it asks Stripe.
// ─────────────────────────────────────────────────────────────────────────────

import type { EmbedTicketCode } from "./embed-tickets";

/** Stripe took the payment (or is clearing it): the order is paid for. */
export const isPaidStatus = (status: string | null | undefined): boolean =>
  status === "succeeded" || status === "processing";

/**
 * What the payment form reports about a payment nobody could confirm or rule
 * out:
 *
 * - "settled": its confirm ended (an error, or a throw) and Stripe could not
 *   be asked what became of the PaymentIntent.
 * - "still-out": its confirm has not answered and may yet land a charge.
 * - "late-settled": a confirm reported "still-out" has now ended unpaid.
 */
export type UnknownOutcomeReport = "settled" | "still-out" | "late-settled";

/** The two PaymentIntent statuses that mean the buyer has paid. */
export type PaidStatus = "succeeded" | "processing";

/** `status` as a paid status, or null when it is not one. */
export const asPaidStatus = (
  status: string | null | undefined,
): PaidStatus | null =>
  status === "succeeded" || status === "processing" ? status : null;

/**
 * What the widget holds about an order it could not show a confirmation for,
 * kept per order under its PaymentIntent's client secret:
 *
 * - `confirmsStillOut`: confirms the payment form stopped waiting for, which
 *   may yet land a charge (see `UnknownOutcomeReport`).
 * - `stripeSaid`: Stripe's browser side said this order was paid, and the
 *   server has not confirmed the order. Null when Stripe never said so.
 * - `serverSaid`: the server's answer once it has been asked and said the
 *   payment went through ("confirmed") or is clearing ("processing"). Null
 *   while the outcome is unknown. "confirmed" means only that the payment
 *   went through: the server answers a repeat ask from its record of the
 *   finalize, which outlives a later refund.
 */
export type UnknownOutcome = {
  confirmsStillOut: number;
  stripeSaid: PaidStatus | null;
  serverSaid: "confirmed" | "processing" | null;
};

/** A record for an order nothing is known about yet. */
export const NOTHING_KNOWN: UnknownOutcome = {
  confirmsStillOut: 0,
  stripeSaid: null,
  serverSaid: null,
};

/**
 * What the server answered when asked about an order
 * (`embeds.confirmGuestPayment`), or "unanswered" when the call failed or
 * nobody answered in time. "unanswered" is never "not paid".
 *
 * - `final`: the server refused in a way asking again cannot change (the
 *   order can no longer be finalized, the secret is not this order's, the
 *   page may not host this embed). The widget then offers no "Check again".
 *   It still does not say the tickets will not come: the Stripe webhook
 *   finalizes an order whatever this endpoint refused.
 * - `rateLimited`: the endpoint's budget is spent for now. Not final, and
 *   the widget stops asking about further orders.
 */
export type EmbedServerAnswer =
  // `tickets`: see `EmbedServerOutcome` (ask-embed-server.ts).
  | { outcome: "confirmed"; orderId: string; tickets?: EmbedTicketCode[] }
  | { outcome: "processing"; orderId: string }
  | { outcome: "not_paid"; orderId: string; paymentIntentStatus: string }
  | { outcome: "unanswered"; final: boolean; rateLimited?: boolean };

/**
 * An earlier order's record after the server was asked about it. Null when
 * the answer settles that the order was not charged and will not be, so the
 * record is forgotten.
 *
 * - "confirmed" / "processing": the buyer paid for that order, and is told.
 * - "not_paid" settles it only under `settlesAsUnpaid`, and never for an
 *   order Stripe's browser side said was paid: the two disagree, and a
 *   disagreement is an unknown outcome, not "you were not charged".
 * - Anything else leaves the record as it was.
 *
 * An answer that changes nothing returns the SAME record, so a caller can
 * tell news from a repeat by identity.
 */
export function earlierOrderAfterServerAnswer(
  record: UnknownOutcome,
  answer: EmbedServerAnswer,
): UnknownOutcome | null {
  if (answer.outcome === "confirmed" || answer.outcome === "processing") {
    if (record.serverSaid === answer.outcome) return record;
    return { ...record, serverSaid: answer.outcome };
  }
  if (
    answer.outcome === "not_paid" &&
    record.stripeSaid === null &&
    record.serverSaid === null &&
    settlesAsUnpaid(answer.paymentIntentStatus, record.confirmsStillOut)
  ) {
    return null;
  }
  return record;
}

/**
 * Whether Stripe's answer settles that an order was NOT charged and will not
 * be. A canceled PaymentIntent always does. "requires_payment_method" does
 * only once no confirm of ours is still out: while one is, that status is
 * what the PaymentIntent reads right up to the moment the confirm lands.
 */
export const settlesAsUnpaid = (
  status: string | null | undefined,
  confirmsStillOut: number,
): boolean =>
  status === "canceled" ||
  (status === "requires_payment_method" && confirmsStillOut === 0);
