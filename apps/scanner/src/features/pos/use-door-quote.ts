/**
 * `pos.quoteCart` for the cart on screen, debounced, read into a `QuoteState`.
 *
 * Every cart change (and every settled promo change) asks the server for the
 * card AND cash totals: the same price, fees and tax online checkout charges.
 * Until the answer for THIS cart is in, the state is `updating` and both
 * tenders stay off, so nobody reads out a number the till won't charge.
 */
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, skipToken } from "@tanstack/react-query";

import { trpc } from "../../trpc";
import {
  deriveQuoteState,
  shouldRetryQuote,
  type QuoteInput,
  type QuoteState,
  type SaleItems,
} from "./sell-quote";

/** A run of +/- taps costs one request. */
const QUOTE_DEBOUNCE_MS = 250;

export type DoorQuote = {
  state: QuoteState;
  /** The input the `ready` quote priced; the sale sends exactly these lines. */
  askedInput: QuoteInput | null;
  refetch: () => void;
};

export function useDoorQuote(args: {
  eventId: string;
  lines: Array<{ ticketTypeId: string; qty: number }>;
  /** Settled promo codes, or undefined when none are applied. */
  promoCodes: string[] | undefined;
  /** False while a promo preview is catching up with the cart. */
  promoSettled: boolean;
}): DoorQuote {
  const { eventId, lines, promoCodes, promoSettled } = args;

  const input = useMemo<QuoteInput | null>(() => {
    const items = lines.filter((l) => l.qty > 0);
    const [first, ...rest] = items;
    if (!first) return null;
    return {
      eventId,
      items: [first, ...rest] as SaleItems,
      ...(promoCodes && promoCodes.length > 0 ? { promoCodes } : {}),
    };
  }, [eventId, lines, promoCodes]);

  const inputKey = input ? JSON.stringify(input) : null;
  const [askedInput, setAskedInput] = useState<QuoteInput | null>(null);
  const askedKey = askedInput ? JSON.stringify(askedInput) : null;

  useEffect(() => {
    // An unsettled promo would put unproven codes on the quote; wait for it.
    if (!promoSettled) return;
    const timer = setTimeout(() => setAskedInput(input), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `inputKey` stands in for `input`: a new array identity with the same
    // contents must not restart the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, promoSettled]);

  const query = trpc.pos.quoteCart.useQuery(askedInput ?? skipToken, {
    // Keep the previous answer while the next one loads, so the rows don't
    // collapse and re-grow on every tap. Its amounts read "—" meanwhile.
    placeholderData: keepPreviousData,
    // Only a request that got no answer is retried: TAX_RATE_UNAVAILABLE and
    // every other refusal is the answer.
    retry: shouldRetryQuote,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const state = deriveQuoteState({
    hasCart: input !== null,
    asked: promoSettled && inputKey === askedKey,
    data: query.data,
    isPlaceholderData: query.isPlaceholderData,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  });

  return {
    state,
    askedInput: state.kind === "ready" ? askedInput : null,
    refetch: () => {
      void query.refetch();
    },
  };
}
