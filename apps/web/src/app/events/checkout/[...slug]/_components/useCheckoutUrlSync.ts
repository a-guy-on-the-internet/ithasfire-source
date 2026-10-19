"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  checkoutUrlSnapshot,
  mergeCheckoutSearch,
  readCheckoutSearch,
  takeSignInAmounts,
  type CheckoutPhase,
} from "./checkout-url-state";

// ─────────────────────────────────────────────────────────────────────────────
// useCheckoutUrlSync
//
// Two-way bridge between the checkout state and the URL query string:
//
//   1. On mount, reads the URL and applies ticket quantities to the cart. Only
//      runs once — subsequent renders are driven by the user's actual
//      interactions, not the URL. Promo URL seeds are validated by Checkout
//      before entering ordinary promo state.
//
//   2. On every state change, debounces and rewrites the URL through the
//      native `history.replaceState` so the back/forward stack doesn't fill up
//      with intermediate quantity tweaks. NOT `router.replace`: this route is
//      dynamic, so every router call was a real RSC round-trip — 797ms on a
//      Slow 4G connection, re-running getFeatureGates / resolveEventSlug /
//      fetchEventGateState / listEventTicketTypes / getEventWaiver /
//      getPublicPlaceLayout on the server for the privilege of writing
//      `?step=payment` into the address bar. The App Router patches
//      `history.pushState`/`replaceState` and dispatches ACTION_RESTORE, so
//      `usePathname` and `useSearchParams` still see the new URL — without a
//      fetch. (Verified against next@16.3.0-preview.8,
//      `client/components/app-router.js`.)
//
// The cart steps are *reflected* in the URL but not used to drive navigation —
// deep-link to `step=payment` won't fast-forward the user past hold/details,
// because those require server-side state (orderId, clientSecret) we can't
// restore from a query string.
//
// The one step that DOES restore is `step=confirmed&order=<id>`, written once
// the order is confirmed (with the cart's `t`/`p`/`a` dropped). The read path
// here only declines to seed the cart for it; `Checkout` reads the order id
// and restores that order's confirmation, buyer-scoped, or falls back to an
// empty picker.
// ─────────────────────────────────────────────────────────────────────────────

const URL_WRITE_DEBOUNCE_MS = 200;

export type UseCheckoutUrlSyncArgs = {
  phase: CheckoutPhase;
  quantities: Record<string, number>;
  promoCodes: readonly string[];
  /**
   * The page's order. Once the phase is `confirmed`/`done`, the URL names it
   * (`step=confirmed&order=`) instead of the cart.
   */
  orderId?: string | null;
  /** Valid ticket-type IDs. Quantities from the URL are filtered against this so a stale link can't inject ghost line items. */
  validTicketTypeIds: readonly string[];
  /** Apply an initial quantity for a ticket type. Called once per matching URL entry on mount. */
  onSeedQuantity: (ticketTypeId: string, qty: number) => void;
  /**
   * Apply a pay-what-you-want amount carried back by THIS tab's sign-in
   * redirect (`a=` nonce → sessionStorage). Called once per matching entry on
   * mount. The write path never emits `a`, so the param is stripped on the
   * first URL write.
   */
  onSeedDonationAmount?: (ticketTypeId: string, amountCents: number) => void;
};

export function useCheckoutUrlSync({
  phase,
  quantities,
  promoCodes,
  orderId = null,
  validTicketTypeIds,
  onSeedQuantity,
  onSeedDonationAmount,
}: UseCheckoutUrlSyncArgs) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── Read path ───────────────────────────────────────────────────────
  // Seed initial state from URL exactly once. We keep the search params
  // captured in a ref so re-renders don't reapply them and clobber user
  // interactions.
  const hasSeededRef = useRef(false);
  useEffect(() => {
    if (hasSeededRef.current) return;
    hasSeededRef.current = true;
    const snapshot = readCheckoutSearch(searchParams ?? new URLSearchParams());
    // A confirmed URL names an ORDER, not a cart: never seed from it, even if
    // a stale or crafted `t=` rides along (the reload-buys-again bug).
    // `Checkout` restores that order's confirmation instead.
    if (snapshot.orderId) return;
    const allowedIds = new Set(validTicketTypeIds);
    for (const [ttId, qty] of Object.entries(snapshot.quantities)) {
      if (!allowedIds.has(ttId)) continue;
      onSeedQuantity(ttId, qty);
    }
    // Amounts arrive ONLY from this tab's own sign-in redirect: `a=` is a
    // nonce, and `takeSignInAmounts` finds nothing for one this tab did not
    // stash — so a crafted link pre-fills nothing. Even then, only tiers the
    // same URL also selects (`t=`) are seeded.
    const carried = takeSignInAmounts(snapshot.amountsToken);
    for (const [ttId, cents] of Object.entries(carried)) {
      if (!allowedIds.has(ttId)) continue;
      if (!(snapshot.quantities[ttId] > 0)) continue;
      onSeedDonationAmount?.(ttId, cents);
    }
    // We intentionally omit searchParams / onSeedQuantity from deps — this effect
    // must run once on mount only. Re-running would clobber live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Write path ──────────────────────────────────────────────────────
  // Build the next URL on every render. Compare against the last-written
  // value so we only touch history when something actually changed.
  // Debounced so rapid quantity tweaks don't thrash the history API.
  const lastWrittenRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!pathname) return;

    // Preserve any unrelated params (e.g. ?resume=, ?ref=) that other code
    // owns. We merge our keys on top of whatever is currently in the URL.
    // A confirmed order writes `step=confirmed&order=` and drops the cart.
    const mergedString = mergeCheckoutSearch(
      searchParams?.toString() ?? "",
      checkoutUrlSnapshot({ phase, orderId, quantities, promoCodes }),
    );
    if (mergedString === lastWrittenRef.current) return;

    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => {
      if (typeof window === "undefined") return;
      const nextUrl = mergedString ? `${pathname}?${mergedString}` : pathname;
      // Pure client-state→URL reflection (cart step/quantities/promo, or the
      // confirmed order).
      //
      // `null` as the state, NOT `window.history.state`. The App Router's
      // patched `replaceState` short-circuits to the UNPATCHED implementation
      // when the state it is handed already carries `__NA`, which would leave
      // usePathname/useSearchParams reading a stale URL — silently, with no
      // error. Passing null lets the patch copy the internal history state
      // across itself and notify the router. `useCheckoutUrlSync.test.ts` pins
      // this; do not "tidy" it into passing the current state through.
      //
      // This is not free, just cheap: the patch dispatches ACTION_RESTORE,
      // which rebuilds the router's cache node tree and clears
      // `previousNextUrl`. Inert on this route (no interception, no parallel
      // routes) and, unlike `router.replace`, it costs no RSC round-trip and
      // raises no progress bar.
      //
      // try/catch because Safari throws SecurityError past roughly 100 history
      // writes per 30s. The 200ms debounce caps us at 5/s, so this is
      // unreachable in practice — but an uncaught throw inside a setTimeout is
      // Sentry noise, and it would skip the `lastWrittenRef` write below and
      // leave the hook rewriting the same URL forever.
      try {
        window.history.replaceState(null, "", nextUrl);
      } catch {
        // Nothing to recover: the URL is a reflection of state we still hold.
      }
      lastWrittenRef.current = mergedString;
    }, URL_WRITE_DEBOUNCE_MS);

    return () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    };
  }, [phase, orderId, quantities, promoCodes, pathname, searchParams]);
}
