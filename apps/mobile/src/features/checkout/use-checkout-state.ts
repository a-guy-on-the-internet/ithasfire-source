import { useCallback, useMemo, useReducer } from "react";
import { randomUUID } from "expo-crypto";

import {
  addPromoCode,
  checkoutSelectionReducer,
  createInitialCheckoutState,
  estimateSubtotalCents,
  toCheckoutItems,
  totalSelectedQty,
  type AddPromoCodeFailure,
  type CheckoutTicketType,
} from "./checkout-selection";

/**
 * Thin React binding over the pure checkout-selection core (FR-003).
 * All clamping / dedup / money rules live in `checkout-selection.ts` so
 * they stay unit-testable without React or Expo.
 *
 * `clientKey` is the idempotency key for `orders.createCheckout` (Step 4).
 * It is generated once per checkout attempt and stays STABLE across retries
 * of the same attempt; call `rotateClientKey()` when the buyer materially
 * changes the cart so the server doesn't dedupe a genuinely new order.
 */
export const useCheckoutState = (
  ticketTypes: readonly CheckoutTicketType[],
) => {
  const [state, dispatch] = useReducer(
    checkoutSelectionReducer,
    randomUUID,
    createInitialCheckoutState,
  );

  const incrementQty = useCallback((ticketType: CheckoutTicketType) => {
    dispatch({ type: "ADJUST_QTY", ticketType, delta: 1 });
  }, []);

  const decrementQty = useCallback((ticketType: CheckoutTicketType) => {
    dispatch({ type: "ADJUST_QTY", ticketType, delta: -1 });
  }, []);

  const setDonationCents = useCallback(
    (ticketType: CheckoutTicketType, cents: number) => {
      dispatch({ type: "SET_DONATION_CENTS", ticketType, cents });
    },
    [],
  );

  /** Returns the failure reason for inline display, or null on success. */
  const addPromo = useCallback(
    (code: string): AddPromoCodeFailure | null => {
      const result = addPromoCode(state.promoCodes, code);
      if (!result.ok) return result.reason;
      dispatch({ type: "ADD_PROMO_CODE", code });
      return null;
    },
    [state.promoCodes],
  );

  const removePromo = useCallback((code: string) => {
    dispatch({ type: "REMOVE_PROMO_CODE", code });
  }, []);

  const rotateClientKey = useCallback(() => {
    dispatch({ type: "ROTATE_CLIENT_KEY", nextKey: randomUUID() });
  }, []);

  /** Counts only types still present in `ticketTypes` (orphans excluded). */
  const totalQty = useMemo(
    () => totalSelectedQty(state.items, ticketTypes),
    [state.items, ticketTypes],
  );

  /** Display-only estimate — fees/tax/discounts are server-side (FR-010). */
  const estimatedSubtotalCents = useMemo(
    () => estimateSubtotalCents(state.items, ticketTypes),
    [state.items, ticketTypes],
  );

  /** `createCheckout` `items` payload — consumed by Step 4. */
  const checkoutItems = useMemo(
    () => toCheckoutItems(state.items, ticketTypes),
    [state.items, ticketTypes],
  );

  return {
    clientKey: state.clientKey,
    rotateClientKey,
    items: state.items,
    incrementQty,
    decrementQty,
    setDonationCents,
    promoCodes: state.promoCodes,
    addPromo,
    removePromo,
    totalQty,
    hasSelection: totalQty > 0,
    estimatedSubtotalCents,
    checkoutItems,
  };
};
