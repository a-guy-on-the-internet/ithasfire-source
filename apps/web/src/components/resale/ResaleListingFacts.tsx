"use client";

import { Text, useTranslations, useFormatters } from "@th/ui";

import { fmtCurrency } from "@/lib/format";
import {
  originalPriceLine,
  originalPriceText,
  type TicketTypePricing,
} from "@/lib/resale/original-price";

export type ResaleListingFactsInput = {
  askPriceCents: number;
  currency: string;
  originalPriceCents?: number | null;
  eventShareCents?: number | null;
  sharePayer?: "SELLER" | "BUYER" | null;
  ticketTypePricing?: TicketTypePricing | null;
};

/**
 * The two lines a buyer reads under the price (organiser-resale-share FR-007,
 * FR-009): the original price, then how much goes to the people who put on the
 * night and who pays it. Both come from the listing read; nothing is added up
 * here. A listing from before the share existed has neither and renders
 * nothing. Render it under the price, as a fragment: the parent's column
 * supplies the gap.
 */
export function ResaleListingFacts({
  listing,
  showShare = true,
}: {
  listing: ResaleListingFactsInput;
  /** False where the share is already a row of its own (checkout, BUYER payer). */
  showShare?: boolean;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const money = (cents: number) => fmtCurrency(fmt, cents, listing.currency);

  const original = originalPriceText(
    originalPriceLine(listing),
    t,
    money,
  );
  const share = listing.eventShareCents;
  const shareText =
    showShare && share != null && share > 0 && listing.sharePayer
      ? String(
          t(
            listing.sharePayer === "BUYER"
              ? "resell.shareToEventBuyer"
              : "resell.shareToEventSeller",
            {
              amount: money(share),
              ticket: money(listing.askPriceCents),
            },
          ),
        )
      : null;

  return (
    <>
      {original ? (
        <Text variant="caption" tone="muted" data-testid="resale-original-price">
          {original}
        </Text>
      ) : null}
      {shareText ? (
        <Text variant="caption" tone="muted" data-testid="resale-event-share">
          {shareText}
        </Text>
      ) : null}
    </>
  );
}
