"use client";

import { useEffect, useRef } from "react";
import * as Sentry from "@sentry/nextjs";
import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "@th/trpc";
import { trpc } from "@/trpc";

import {
  paymentFromOrderStatus,
  type ConfirmedPayment,
} from "./confirmed-payment";
import type { ConfirmationOrderItem } from "./OrderConfirmation";
import {
  isDefinitiveRestoreError,
  isUnauthorizedError,
  restoredConfirmationVerdict,
  type RestoreSessionStatus,
  type RestoredConfirmationVerdict,
} from "./restored-confirmation";

/** The order the confirmation screen totals. */
export type ConfirmedOrder = {
  /** The page order's id — it is only used for the order it IS. */
  id?: string;
  amountGrossCents: number;
  feesPlatformCents: number;
  buyerFeesCents: number;
  processorFeeCents: number | null;
  taxAmountCents: number;
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  creditAppliedCents?: number | null;
  items?: ConfirmationOrderItem[];
};

export type ConfirmedOrderView =
  | {
      status: "ready";
      order: ConfirmedOrder;
      /** The confirmed order's own selection, when it came from the server. */
      quantities: Record<string, number> | null;
      /**
       * Whether the order's money moved (see `ConfirmedPayment`). Where this
       * hook loaded the full order (a restore, a redirect return), its
       * server status. On the in-session path, the page's own answer from
       * `orders.confirmPayment` (`sessionPayment`): no second read.
       */
      payment: ConfirmedPayment;
    }
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      /**
       * A RESTORE that could not be checked just now (a transient failure:
       * see `restoredConfirmationVerdict`). Says nothing about the order —
       * never that it was paid — and offers a retry.
       */
      status: "restore-unavailable";
      retry: () => void;
      /** A retry is in flight. */
      retrying: boolean;
    };

/** `orders.getMyOrder`'s output — the parts read here. */
type MyOrder = Pick<
  inferRouterOutputs<AppRouter>["orders"]["getMyOrder"],
  "charges" | "items" | "status"
>;

/**
 * `orders.getMyOrder` as the confirmation's order. Its `charges` are what the
 * buyer was charged, as lines that add to `totalCents`; the confirmation
 * totals subtotal + platform + processing (PASS_THROUGH) + tax − credit, so
 * it prints exactly `charges.totalCents`.
 */
export function confirmedOrderFromMyOrder(myOrder: MyOrder): {
  order: ConfirmedOrder;
  quantities: Record<string, number>;
} {
  const { charges } = myOrder;
  const ticketItems = myOrder.items.filter((item) => item.kind === "ticket");
  const quantities: Record<string, number> = {};
  for (const item of ticketItems) {
    if (!item.ticketTypeId) continue;
    quantities[item.ticketTypeId] =
      (quantities[item.ticketTypeId] ?? 0) + item.qty;
  }
  return {
    order: {
      amountGrossCents: charges.subtotalCents,
      feesPlatformCents: charges.platformFeeCents,
      buyerFeesCents: charges.platformFeeCents,
      processorFeeCents: charges.processingFeeCents,
      taxAmountCents: charges.taxCents,
      // The confirmation prints the buyer's fees as paid rows only in
      // PASS_THROUGH; in ABSORB the platform fee shows as "Included" and the
      // processing row is hidden. An older ABSORB order can still carry fee
      // lines the buyer DID pay (`computeBuyerChargeBreakdown`'s
      // fees-from-charge branch, which gives the platform fee its share
      // first): any fee in the buyer's breakdown was paid, so it is a paid
      // row, and the rows then sum to `charges.totalCents`.
      feeMode:
        charges.platformFeeCents + charges.processingFeeCents > 0
          ? "PASS_THROUGH"
          : charges.buyerFeeMode,
      // `creditCents` is zero or negative; the confirmation subtracts it.
      creditAppliedCents: -charges.creditCents,
      items: ticketItems.map((item) => ({
        kind: item.kind,
        ticketTypeId: item.ticketTypeId,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.amountCents,
      })),
    },
    quantities,
  };
}

/**
 * The order the confirmation screen shows.
 *
 * Normally the page already holds it (the hold, then createCheckout's
 * stamped figures). A Stripe REDIRECT RETURN is a fresh page load with no
 * order — and so is a 3-D Secure confirm that outlasted the hold — so the
 * confirmation used to total the PRE-HOLD ESTIMATE, as a cash total, for a
 * paid order. Then this loads the order `confirmPayment` confirmed
 * (`orders.getMyOrder`) and shows its charged totals; until it arrives the
 * screen says it is loading, and never an estimate.
 *
 * A RELOAD of the confirmed URL (`?step=confirmed&order=`) takes the same
 * path, with `restore` set: the order is loaded only once the buyer is known
 * to be signed in, and it is shown only on a "confirm" verdict
 * (`restoredConfirmationVerdict`: this event, a status the in-session
 * confirmation shows). Until then — and on a "fallback", for the one render
 * before the page drops back to the picker — the view is "loading", never the
 * order and never "unavailable". A TRANSIENT failure (5xx, network, a token
 * that failed to mint, the session read failing) is "restore-unavailable":
 * the page stays on the confirmation step with a retry, and the confirmed URL
 * stays as it is.
 */
export function useConfirmedOrder({
  isConfirmed,
  orderId,
  pageOrder,
  sessionPayment = "unknown",
  restore = null,
}: {
  isConfirmed: boolean;
  orderId: string | null;
  pageOrder: ConfirmedOrder | null;
  /**
   * What this page learned about the payment when it confirmed it: the
   * `orders.confirmPayment` outcome, `paid` for a free order, `unknown`
   * otherwise. Used with the page's own order; a server-loaded order's
   * status wins over it.
   */
  sessionPayment?: ConfirmedPayment;
  /** Set while restoring a confirmation from the URL (see above). */
  restore?: {
    eventId: string;
    session: RestoreSessionStatus;
    /** Re-read the session, when that read is what failed. */
    refetchSession?: () => unknown;
    /** That session re-read is in flight (better-auth `isRefetching`). */
    sessionRefetching?: boolean;
  } | null;
}): ConfirmedOrderView & {
  /** Null unless `restore` is set. */
  restoreVerdict: RestoredConfirmationVerdict | null;
} {
  // The page's order counts only if it is THE confirmed order (a stale
  // snapshot of another order — a resumed cart, a retired hold — does not).
  const usablePageOrder =
    pageOrder && pageOrder.id === orderId ? pageOrder : null;
  const needsServerOrder =
    isConfirmed &&
    !usablePageOrder &&
    Boolean(orderId) &&
    // A restore asks only for a signed-in buyer: signed out, it falls back
    // without a request that can only be refused.
    (!restore || restore.session === "signed-in");
  const query = trpc.orders.getMyOrder.useQuery(
    { orderId: orderId ?? "" },
    {
      enabled: needsServerOrder,
      staleTime: 60_000,
      // While restoring, every failure is shown inline, so never also as the
      // global toast. A link to an order that is not this buyer's is an
      // expected refusal: not reported at all. Other failures reach the
      // console and Sentry through GlobalQueryErrorLogger — EXCEPT
      // auth-class ones (UNAUTHORIZED / FORBIDDEN), which it drops before
      // Sentry; UNAUTHORIZED is reported by the effect below instead. The
      // non-restore path (a Stripe redirect return) keeps the default
      // handling.
      ...(restore
        ? { meta: { silentWhen: isDefinitiveRestoreError, noToast: true } }
        : {}),
    },
  );
  // UNAUTHORIZED while the session says signed in: the global logger drops
  // it, and it can be permanent (a user with no human row: "Missing actor
  // human id"), leaving the buyer on "couldn't load" with nothing reported.
  // Report it once per order id per page life — not per render or retry.
  // A throwing reporter must change nothing.
  const reportedUnauthorizedRef = useRef<Set<string>>(new Set());
  const restoreSession = restore?.session ?? null;
  const queryError = query.error;
  useEffect(() => {
    if (restoreSession !== "signed-in" || !orderId) return;
    if (!isUnauthorizedError(queryError)) return;
    if (reportedUnauthorizedRef.current.has(orderId)) return;
    reportedUnauthorizedRef.current.add(orderId);
    try {
      Sentry.captureException(queryError, {
        tags: { area: "checkout.restore", kind: "unauthorized-with-session" },
        extra: { orderId },
      });
    } catch {
      // Reporting is best-effort; the page shows "unavailable" regardless.
    }
  }, [restoreSession, orderId, queryError]);

  if (restore && !usablePageOrder) {
    const restoreVerdict = restoredConfirmationVerdict({
      eventId: restore.eventId,
      session: restore.session,
      order: query.data,
      error: query.error,
    });
    if (restoreVerdict === "confirm" && query.data) {
      const { order, quantities } = confirmedOrderFromMyOrder(query.data);
      return {
        status: "ready",
        order,
        quantities,
        payment: paymentFromOrderStatus(query.data.status),
        restoreVerdict,
      };
    }
    if (restoreVerdict === "unavailable") {
      const { refetchSession } = restore;
      return {
        status: "restore-unavailable",
        restoreVerdict,
        // A failed SESSION read retries the session (the order query is off
        // until signed in), so its in-flight flag is the session's. Defensive
        // only: better-auth 1.6.x clears `error` in `onRequest`, so during a
        // session retry the restore reads "loading" and this view unmounts.
        retrying:
          restore.session === "unknown"
            ? Boolean(restore.sessionRefetching)
            : query.isFetching,
        // The session read failed: re-read it (the order query then runs on
        // its own once signed in). Otherwise ask for the order again; a
        // definitive answer goes through the normal verdict.
        retry: () => {
          if (restore.session === "unknown") void refetchSession?.();
          else void query.refetch();
        },
      };
    }
    return { status: "loading", restoreVerdict };
  }
  if (usablePageOrder) {
    return {
      status: "ready",
      order: usablePageOrder,
      quantities: null,
      payment: sessionPayment,
      restoreVerdict: null,
    };
  }
  if (query.data) {
    const { order, quantities } = confirmedOrderFromMyOrder(query.data);
    return {
      status: "ready",
      order,
      quantities,
      payment: paymentFromOrderStatus(query.data.status),
      restoreVerdict: null,
    };
  }
  if (query.isError) return { status: "unavailable", restoreVerdict: null };
  return { status: "loading", restoreVerdict: null };
}
