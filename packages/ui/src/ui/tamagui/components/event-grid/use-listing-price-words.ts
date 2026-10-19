import { useMemo } from "react";

import {
  ENGLISH_LISTING_PRICE_WORDS,
  renderListingPrice,
  type ListingPrice,
  type ListingPriceWords,
} from "@th/types/money";

import { useTranslations } from "../../../../locale";

/**
 * The words a listing price is printed with, in the viewer's language, plus
 * the "See details" placeholder that stands in when there is no price.
 */
export interface LocalizedListingPriceWords extends ListingPriceWords {
  seeDetails: string;
}

/**
 * Catalog keys behind {@link LocalizedListingPriceWords}. `search.freePlus`,
 * `eventDetail.payWhatYouWant` and `eventCard.seeDetails` live in the WEB
 * app's catalog (`apps/web/src/i18n/messages/{en,es}.ts`), which the web's
 * locale provider deep-merges over this package's `en.json`. Outside that
 * provider (Storybook, a bare test render) the translator returns the KEY
 * itself, so each word falls back to the English the server would print.
 */
export const LISTING_PRICE_WORD_KEYS = {
  free: "search.free",
  freePlus: "search.freePlus",
  payWhatYouWant: "eventDetail.payWhatYouWant",
  fromPrice: "search.fromPrice",
  seeDetails: "eventCard.seeDetails",
} as const;

type Translate = (key: string, values?: Record<string, string>) => unknown;

/** Build the words from any translator (`useTranslations()` from `@th/ui`). */
export function listingPriceWordsFrom(t: Translate): LocalizedListingPriceWords {
  const word = (key: string, fallback: string): string => {
    const value = String(t(key) ?? "");
    return value && value !== key ? value : fallback;
  };
  return {
    free: word(LISTING_PRICE_WORD_KEYS.free, ENGLISH_LISTING_PRICE_WORDS.free),
    freePlus: word(
      LISTING_PRICE_WORD_KEYS.freePlus,
      ENGLISH_LISTING_PRICE_WORDS.freePlus,
    ),
    payWhatYouWant: word(
      LISTING_PRICE_WORD_KEYS.payWhatYouWant,
      ENGLISH_LISTING_PRICE_WORDS.payWhatYouWant,
    ),
    fromPrice: (formattedAmount) => {
      const key = LISTING_PRICE_WORD_KEYS.fromPrice;
      const value = String(t(key, { price: formattedAmount }) ?? "");
      return value && value !== key
        ? value
        : ENGLISH_LISTING_PRICE_WORDS.fromPrice(formattedAmount);
    },
    seeDetails: word(LISTING_PRICE_WORD_KEYS.seeDetails, "See details"),
  };
}

/** {@link LocalizedListingPriceWords} for the current locale. */
export function useListingPriceWords(): LocalizedListingPriceWords {
  const t = useTranslations();
  return useMemo(() => listingPriceWordsFrom(t), [t]);
}

/**
 * A listing's price text in the viewer's language. The structured
 * `listingPrice` wins whenever the producer sent one (`null` included, which
 * means "no price"); a producer that sent only the English `priceLabel` gets
 * that string back. Returns `null` for "no price" — the caller decides
 * whether to print `words.seeDetails` or nothing.
 */
export function listingPriceText(
  event: { listingPrice?: ListingPrice | null; priceLabel?: string | null },
  words: LocalizedListingPriceWords,
): string | null {
  if (event.listingPrice !== undefined) {
    return event.listingPrice
      ? renderListingPrice(event.listingPrice, words)
      : null;
  }
  const label = event.priceLabel;
  // "See details" is the English placeholder for "no price".
  return label && label !== "See details" ? label : null;
}
