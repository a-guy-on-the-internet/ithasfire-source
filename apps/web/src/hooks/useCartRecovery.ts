"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth/auth-client";
import { publicRuntimeEnv } from "@/config/env.public";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { trpc } from "@/trpc";

export interface ActiveCart {
  id: string;
  eventId: string;
  eventName: string;
  eventSlug: string | null;
  eventStartsAt: Date | null;
  amountGrossCents: number;
  /** RECORDED platform fee; under ABSORB the organiser pays it, not the buyer. */
  feesPlatformCents: number;
  /**
   * The fee mode the hold was priced under (null if unrecorded). The banner
   * uses it to say what checkout adds on top of the subtotal.
   */
  feeMode: "ABSORB" | "PASS_THROUGH" | null;
  currency: string;
  holdExpiresAt: Date | null;
  createdAt: Date;
  ticketSummary: Array<{
    ticketTypeId: string;
    ticketTypeName: string;
    qty: number;
    unitPriceCents: number;
    seatIds: string[];
  }>;
}

interface UseCartRecoveryOptions {
  /** Whether to check for active carts on mount. Defaults to true. */
  checkOnMount?: boolean;
  /** Current order ID if on checkout page (to exclude from recovery prompts) */
  currentOrderId?: string;
}

interface UseCartRecoveryReturn {
  /** Active carts that can be recovered */
  activeCarts: ActiveCart[];
  /** Whether we're checking for active carts */
  isLoading: boolean;
  /** Dismiss a cart (releases the hold) */
  dismissCart: (orderId: string) => Promise<void>;
  /** Refresh the active carts list */
  refresh: () => void;
}

/**
 * Hook for cart recovery feature.
 *
 * Checks for active cart holds when user is logged in and returns carts
 * that can be recovered (resumed checkout).
 *
 * Also handles sendBeacon on page visibility change to release holds
 * when user navigates away from checkout.
 */
export function useCartRecovery(
  options: UseCartRecoveryOptions = {},
): UseCartRecoveryReturn {
  const { checkOnMount = true, currentOrderId } = options;

  const [activeCarts, setActiveCarts] = useState<ActiveCart[]>([]);
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const isSignedIn = Boolean(session?.user);
  const releaseCartMutation = trpc.orders.releaseCartHold.useMutation();

  // No token mint here: the tRPC token resolver waits for the session to
  // settle and mints for signed-in users, and the retry fetch re-mints on a
  // 401 or on a GET 207 sent without a token.
  const activeCartsQuery = trpc.orders.getActiveCartHolds.useQuery(
    {},
    {
      enabled: checkOnMount && isSignedIn && !isSessionPending,
      staleTime: 60_000, // 1 minute
      refetchOnWindowFocus: true,
      retry: false,
    },
  );

  // Update state when query data changes, excluding current order
  useEffect(() => {
    if (activeCartsQuery.data?.carts) {
      const filtered: ActiveCart[] = activeCartsQuery.data.carts.filter(
        (cart: ActiveCart) => cart.id !== currentOrderId,
      );
      setActiveCarts(filtered);
    }
  }, [activeCartsQuery.data, currentOrderId]);

  const dismissCart = useCallback(
    async (orderId: string) => {
      try {
        await releaseCartMutation.mutateAsync({ orderId });
        // Remove from local state immediately
        setActiveCarts((prev) => prev.filter((cart) => cart.id !== orderId));
      } catch (error) {
        console.error("Failed to dismiss cart:", error);
      }
    },
    [releaseCartMutation],
  );

  const refresh = useCallback(() => {
    void activeCartsQuery.refetch();
  }, [activeCartsQuery]);

  return {
    activeCarts,
    isLoading: activeCartsQuery.isLoading,
    dismissCart,
    refresh,
  };
}

interface UseCartHoldReleaseOptions {
  /** The order ID to release on page close */
  orderId: string | null;
  /** The event ID for the order */
  eventId: string;
  /**
   * Release NOTHING while true: a payment is submitting (a redirect method —
   * Amazon Pay, Cash App — navigates away mid-confirm, and the release
   * cancelled its PaymentIntent), a redirect return is still being verified,
   * or the order is confirming / paid. Read at the moment of leaving.
   */
  suppressRelease?: boolean;
}

/**
 * Hook to release cart hold via sendBeacon when user leaves checkout page.
 *
 * Uses the Page Visibility API and sendBeacon for reliable delivery
 * even when the page is being closed.
 */
export function useCartHoldRelease(options: UseCartHoldReleaseOptions): void {
  const { orderId, eventId, suppressRelease = false } = options;
  const orderIdRef = useRef(orderId);
  // Assigned during render, not in an effect: the leave can come in the same
  // tick as the change (Stripe navigating away right after "submitting").
  const suppressReleaseRef = useRef(suppressRelease);
  suppressReleaseRef.current = suppressRelease;

  // Keep ref in sync
  useEffect(() => {
    orderIdRef.current = orderId;
  }, [orderId]);

  // The unmount release, waiting one tick to see whether the page really left.
  const pendingUnmountReleaseRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    eventId: string;
  } | null>(null);

  useEffect(() => {
    // React re-ran this effect without the page leaving: Strict Mode's
    // mount → unmount → mount in development. Its cleanup's release was for
    // the cart the page is still showing; a page opened on a cart
    // (`?resumeOrderId=`) cancelled it on arrival. A pending release for
    // ANOTHER event is a real leave and goes out.
    const pending = pendingUnmountReleaseRef.current;
    if (pending?.eventId === eventId) {
      clearTimeout(pending.timer);
      pendingUnmountReleaseRef.current = null;
    }

    const sendRelease = (currentOrderId: string) => {
      // Use the dedicated cart release endpoint (supports sendBeacon's text/plain)
      const baseUrl = publicRuntimeEnv.apiBaseUrl ?? "";
      const endpoint = `${baseUrl}/api/cart/release`;

      const payload = JSON.stringify({
        orderId: currentOrderId,
        eventId,
      });

      // sendBeacon returns true if the browser successfully queued the request
      const queued = navigator.sendBeacon(endpoint, payload);
      if (!queued) {
        // Fallback: try fetch with keepalive (works for small payloads)
        void fetch(endpoint, {
          method: "POST",
          body: payload,
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          credentials: "include",
        }).catch(traceIgnoredError("cart.recovery.dismissBeacon"));
        // Cron will clean up eventually if the beacon was lost.
      }
    };
    /** The order to release on leaving now, or null (none, or suppressed). */
    const orderToRelease = (): string | null => {
      if (suppressReleaseRef.current) return null;
      return orderIdRef.current;
    };

    // Release on beforeunload (page close / hard navigation) AND on
    // component unmount (client-side navigation away from checkout).
    // We deliberately do NOT release on visibilitychange ("hidden") because
    // that fires when the user simply alt-tabs or switches browser tabs,
    // which would kill an active hold while the user is still checking out.
    const handleBeforeUnload = () => {
      const currentOrderId = orderToRelease();
      if (currentOrderId) sendRelease(currentOrderId);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      // Client-side navigation unmounts the checkout — release the hold
      // so the PENDING order doesn't linger as a ghost cart in recovery.
      // The order and the gate are read NOW, at the leave; the send waits a
      // tick, cancelled above if the effect runs again first.
      const currentOrderId = orderToRelease();
      if (!currentOrderId) return;
      pendingUnmountReleaseRef.current = {
        eventId,
        timer: setTimeout(() => {
          pendingUnmountReleaseRef.current = null;
          sendRelease(currentOrderId);
        }, 0),
      };
    };
  }, [eventId]);
}

/**
 * Convenience wrapper for useCartHoldRelease with simpler API.
 */
export function useCartRelease(
  orderId: string | null,
  eventId: string,
  options: { suppressRelease?: boolean } = {},
): void {
  useCartHoldRelease({
    orderId,
    eventId,
    suppressRelease: options.suppressRelease,
  });
}
