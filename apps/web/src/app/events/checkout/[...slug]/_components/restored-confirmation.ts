import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "@th/trpc";
import { getAppErrorCode } from "@/lib/app-error";

type OrderStatus = inferRouterOutputs<AppRouter>["orders"]["getMyOrder"]["status"];

/**
 * Restoring a confirmation from the URL (`?step=confirmed&order=<id>`, written
 * once an order is confirmed — see `checkout-url-state.ts`).
 *
 * The order is loaded with `orders.getMyOrder`, which is buyer-scoped (another
 * buyer's order is ORDER_NOT_FOUND). The confirmation is shown only for an
 * order of THIS event, in a status the in-session confirmation would show:
 *
 *  - SUCCEEDED: paid.
 *  - PROCESSING: a delayed-payment (ACH) order. In session, `confirmPayment`
 *    writes PROCESSING and answers outcome `processing` for a PaymentIntent
 *    still `processing`, and the page shows the confirmation step with that
 *    answer as its `payment`. A reload lands on the same screen and reads
 *    the same thing from the order's status (`useConfirmedOrder`'s
 *    `payment`).
 *
 * Everything else falls back to the empty ticket picker with a notice:
 * PENDING (never paid, the cart is not a purchase), CANCELLED and REFUNDED
 * (nothing held; "you're all set" would be false), DISPUTED (a chargeback in
 * progress; the order page is the place for it), and PART_REFUNDED: the order
 * changed since the purchase, and the restored view would list the refunded
 * tickets against the original charge, telling the buyer they're all set for
 * tickets they no longer hold. My Tickets shows the order as it is now.
 */
const RESTORABLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "SUCCEEDED",
  "PROCESSING",
]);

/**
 * - "pending": waiting for the session or the order.
 * - "confirm": show the confirmation.
 * - "fallback": DEFINITIVE — this page can't show the order. The empty picker
 *   with a notice, and the confirmed URL is replaced.
 * - "unavailable": TRANSIENT — we couldn't find out just now. The page stays
 *   on the confirmation step, the URL keeps `step=confirmed&order=`, and the
 *   buyer gets a retry. A server hiccup must never say the order can't be
 *   shown, nor erase the URL they bookmarked or reloaded.
 */
export type RestoredConfirmationVerdict =
  | "pending"
  | "confirm"
  | "fallback"
  | "unavailable";

export type RestoreState = "restoring" | "confirmed" | "failed" | null;

/**
 * The fallback's notice belongs to the picker the buyer landed on. The first
 * time the phase leaves "selecting" (a new hold) it is gone for good, so
 * stepping back to the tickets later doesn't bring it back.
 */
export function restoreStateAfterPhase(
  state: RestoreState,
  phase: string,
): RestoreState {
  return state === "failed" && phase !== "selecting" ? null : state;
}

/**
 * "loading" until the session read settles; "unknown" when it FAILED (we
 * can't tell whether anyone is signed in, so nothing definitive follows);
 * "signed-out" only when it settled with no user.
 */
export type RestoreSessionStatus =
  | "loading"
  | "signed-in"
  | "signed-out"
  | "unknown";

/**
 * A `getMyOrder` failure that is an ANSWER: the order is not this buyer's
 * (or does not exist). Every other failure — a 5xx, the network, a timeout,
 * UNAUTHORIZED from a token that failed to mint while the session says a
 * user is signed in — is transient: it says nothing about the order.
 */
export function isDefinitiveRestoreError(error: unknown): boolean {
  return getAppErrorCode(error) === "ORDER_NOT_FOUND";
}

/**
 * UNAUTHORIZED from a tRPC call (the shapes `GlobalQueryErrorLogger` reads).
 * During a restore it arrives only while the session says signed in: a token
 * that failed to mint (transient), or a user with no human row ("Missing
 * actor human id", permanent). Either way the verdict is "unavailable"; this
 * only decides whether to report it (the global logger drops auth errors).
 */
export function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    data?: { code?: unknown };
    shape?: { data?: { code?: unknown } };
  };
  const code = e.data?.code ?? e.shape?.data?.code;
  return String(code ?? "").trim().toUpperCase() === "UNAUTHORIZED";
}

export function restoredConfirmationVerdict({
  eventId,
  session,
  order,
  error,
}: {
  /** The event this checkout page is for. */
  eventId: string;
  session: RestoreSessionStatus;
  /** `getMyOrder`'s output, once loaded. */
  order: { eventId: string; status: OrderStatus } | null | undefined;
  /** `getMyOrder`'s error, if the load failed (null / undefined if not). */
  error: unknown;
}): RestoredConfirmationVerdict {
  // Wait for the session: a signed-in buyer's first render has no session yet.
  if (session === "loading") return "pending";
  // The session read failed: we don't know who this is. Not an answer.
  if (session === "unknown") return "unavailable";
  // Settled, and nobody is signed in. No sign-in round trip: the notice
  // links to My tickets.
  if (session === "signed-out") return "fallback";
  if (error) {
    return isDefinitiveRestoreError(error) ? "fallback" : "unavailable";
  }
  if (!order) return "pending";
  if (order.eventId !== eventId) return "fallback";
  return RESTORABLE_STATUSES.has(order.status) ? "confirm" : "fallback";
}
