/**
 * What the confirmation step knows about the order's payment.
 *
 * - `paid`: the money moved. A SUCCEEDED order, a `confirmed` answer from
 *   `orders.confirmPayment`, or a free order (nothing to pay).
 * - `processing`: Stripe accepted a delayed method (US bank debit) whose money
 *   has not moved. The order is PROCESSING, no tickets are issued yet, and the
 *   debit can still fail days later. It must not read as paid (owner,
 *   2026-10-14).
 * - `unknown`: anything else. PENDING, CANCELLED or REFUNDED status, a
 *   confirm whose answer was lost (`PAYMENT_FAILED` with an order id), or a
 *   read that failed or has not landed. Never shown as paid either.
 */
export type ConfirmedPayment = "paid" | "processing" | "unknown";

/** An `orders.getMyOrder` status as the confirmation's payment. */
export function paymentFromOrderStatus(status: string): ConfirmedPayment {
  if (status === "SUCCEEDED") return "paid";
  if (status === "PROCESSING") return "processing";
  return "unknown";
}

/**
 * `orders.confirmPayment`'s `outcome` as the confirmation's payment. A missing
 * outcome (an API older than this page, during a deploy) is `unknown`.
 */
export function paymentFromConfirmOutcome(
  outcome: "confirmed" | "processing" | undefined,
): ConfirmedPayment {
  if (outcome === "confirmed") return "paid";
  if (outcome === "processing") return "processing";
  return "unknown";
}

/**
 * What the stepper's step 4 says: a `ConfirmedPayment`, or `checking` while a
 * confirmation RESTORED from the URL is still being read (a neutral label:
 * neither "Confirmed" nor "Not confirmed" until the order's status is in).
 */
export type StepperPayment = ConfirmedPayment | "checking";

/**
 * Step 4's payment for every state of the confirmation, so nothing defaults
 * to "Confirmed" (owner, 2026-10-14: only a known-paid order reads as
 * confirmed).
 *  - `ready`: the order's own payment.
 *  - `restore-unavailable`: the order could not be checked → `unknown`.
 *  - `loading` during a restore: `checking`.
 *  - otherwise (`loading` / `unavailable` in session, a redirect return):
 *    what this page learned when it confirmed (`sessionPayment`: the
 *    server's confirm answer, `paid` for a free order, else `unknown`).
 */
export function stepperPayment(
  view:
    | { status: "ready"; payment: ConfirmedPayment }
    | { status: "loading" | "unavailable" | "restore-unavailable" },
  { restoring, sessionPayment }: {
    restoring: boolean;
    sessionPayment: ConfirmedPayment;
  },
): StepperPayment {
  if (view.status === "ready") return view.payment;
  if (view.status === "restore-unavailable") return "unknown";
  if (view.status === "loading" && restoring) return "checking";
  return sessionPayment;
}
