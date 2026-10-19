"use client";

import { useCallback } from "react";
import { useTranslations, useFormatters } from "@th/ui";
import { XStack, YStack } from "tamagui";
import { Info } from "lucide-react";
import { Text } from "@th/ui";
import { fmtCurrency } from "@/lib/format";
import { getListedBuyerAllInDisplayCents } from "@/lib/pricing/buyer-display";
import { isPayWhatYouWant } from "@/lib/pricing/pay-what-you-want";
import { payWhatYouWantListingCopy } from "./pay-what-you-want-copy";
import {
  platformFeeRateLabel,
  type PlatformFeeRateParts,
} from "@/lib/pricing/fee-rate-label";
import { SectionTitle, EventSectionNum } from "./event-content-styled";
import type {
  EventContentTicketType,
  TicketFeeEstimate,
} from "./event-content-types";
import {
  deriveTicketTierState,
  formatEventZonedInstant,
} from "./ticket-tier-state";

export type TicketsSectionProps = {
  /** Consecutive "0N." section label assigned by the parent from the set of
   * visible sections (empty string when unnumbered). */
  sectionNumber?: string;
  ticketTypes: EventContentTicketType[];
  feeMode: "ABSORB" | "PASS_THROUGH" | null;
  feeEstimateMap?: Record<string, TicketFeeEstimate>;
  /**
   * The rate the tooltip's Tax row prints, in basis points — callers pass
   * `taxRateLabelBps(feeRates.taxImpositions)`, null when the charged tax
   * lines sit on different bases (no single percentage produces the amount).
   * The row then shows the amount alone. Never used for money.
   */
  admissionTaxRateBps?: number | null;
  platformFeeLabel?: string | null;
  /**
   * Per-ticket fee policy (pct, cap, floor, fixed): the tooltip then reads "3.33%, max
   * $0.50/ticket" — the label checkout shows — instead of a bare rate that
   * reads like a percentage of the whole order.
   */
  platformFeeRates?: PlatformFeeRateParts | null;
  processorFeeLabel?: string | null;
  mobile: boolean;
  currency: string;
  /**
   * IANA zone of the EVENT (FR-010 / FR-007). Sales windows and price flips are
   * organizer wall-clock decisions about their venue, so they render on the
   * venue's clock — never the reader's. Absent ⇒ NO instant is rendered at all
   * (`formatEventZonedInstant` refuses), and the rows degrade to the zone-free
   * copy: "Not on sale yet", and no price-change line. Stating a wall time on
   * the reader's clock would be confidently wrong for every out-of-zone buyer.
   */
  timezone?: string;
};

export function TicketsSection({
  sectionNumber = "04",
  ticketTypes,
  feeMode,
  feeEstimateMap,
  admissionTaxRateBps,
  platformFeeLabel,
  platformFeeRates,
  processorFeeLabel,
  mobile,
  currency,
  timezone,
}: TicketsSectionProps) {
  const t = useTranslations();
  const fmt = useFormatters();

  const formatPrice = (cents: number) => {
    if (cents === 0) return String(t("common.free"));
    return fmtCurrency(fmt, cents, currency);
  };

  // Toggle tooltip on touch (tap the info icon)
  const handleFeeTooltipToggle = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // On touch devices, toggle focus to trigger :focus-within tooltip
      const anchor = e.currentTarget;
      const focusable = anchor.querySelector<HTMLElement>("[tabindex]");
      if (focusable) {
        if (document.activeElement === focusable) {
          focusable.blur();
        } else {
          focusable.focus();
        }
      }
    },
    [],
  );

  return (
    <YStack gap={10}>
      <SectionTitle>
        <EventSectionNum aria-hidden>{sectionNumber}</EventSectionNum>
        {String(t("eventDetail.ticketsSection"))}
      </SectionTitle>
      <YStack gap={mobile ? 10 : 8}>
        {ticketTypes.map((tt) => {
          // FR-010 / Q-002. Both facts were resolved SERVER-side against the
          // injected clock at the same instant as the price beside them; this
          // only reads them.
          const tierState = deriveTicketTierState(tt);
          const availabilityLabel = (() => {
            const availability = tierState.availability;
            if (!availability) return null;
            if (availability.reason === "sales_ended") {
              // No date: a deadline that has already passed is not something
              // the buyer can act on. "Sales ended" is the whole message.
              return String(t("eventDetail.tierSalesEnded"));
            }
            const at = formatEventZonedInstant(
              availability.opensAt,
              timezone,
              fmt.dateTime,
            );
            return at
              ? String(t("eventDetail.tierOnSaleFrom", { date: at }))
              : // Unrenderable instant (unknown zone id) — still say it is not
                // on sale rather than implying it is.
                String(t("eventDetail.tierNotOnSale"));
          })();
          const priceChangeLabel = (() => {
            if (!tierState.priceChange) return null;
            const at = formatEventZonedInstant(
              tierState.priceChange.at,
              timezone,
              fmt.dateTime,
            );
            if (!at) return null;
            return String(
              t("eventDetail.tierPriceUntil", {
                // The CURRENT effective price — after the flip core sends no
                // `upcomingPriceChange` at all, so this can never read
                // "$20 until <a date in the past>".
                price: formatPrice(tt.priceCents),
                date: at,
                // The price AFTER the flip (Q-002). Naming it is what makes
                // this line unambiguously about price rather than a second
                // sales deadline sitting under the availability notice.
                newPrice: formatPrice(tierState.priceChange.toPriceCents),
              }),
            );
          })();
          const fee = feeEstimateMap?.[tt.id];
          const totalFeeCents = fee
            ? fee.platformFeeCents +
              fee.processorFeeCents +
              fee.taxEstimateCents
            : 0;
          // Stale-guarded: a cached row priced at another face than this
          // tier's reads "Calculating total…", as checkout and the embed do.
          const buyerUnitTotalCents = getListedBuyerAllInDisplayCents({
            priceCents: tt.priceCents,
            buyerUnitTotalCents: fee?.buyerUnitTotalCents,
            buyerUnitPriceCents: fee?.unitPriceCents,
          });
          // Pay what you want: the stored price is always 0. Quote the floor
          // ALL-IN ("From $6.09", fees and tax included, off the row the
          // server priced at the floor), or "Pay what you want" + the
          // suggestion when there is no minimum — the same words the hero,
          // the embed and checkout use (`payWhatYouWantListingCopy`).
          const isPwyw = isPayWhatYouWant(tt);
          const pwywCopy = isPwyw
            ? payWhatYouWantListingCopy(tt, { estimate: fee, formatPrice, t })
            : null;
          // The fee tooltip explains the figure beside it. For a PWYW floor
          // that is the floor's row — shown only once the all-in figure is,
          // so the parts never sit beside "Calculating total…".
          const showFee =
            feeMode === "PASS_THROUGH" &&
            totalFeeCents > 0 &&
            (isPwyw
              ? pwywCopy?.fromCents != null && pwywCopy.fromCents > 0
              : tt.priceCents > 0 && buyerUnitTotalCents != null);

          // Format tax rate for display (e.g. 975 bps → "9.75%")
          const taxRateLabel = admissionTaxRateBps
            ? `${+(admissionTaxRateBps / 100).toFixed(2)}%`
            : null;

          return (
            <div
              key={tt.id}
              className="ticket-type-row"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                paddingTop: mobile ? 14 : 12,
                paddingBottom: mobile ? 14 : 12,
                paddingLeft: mobile ? 16 : 14,
                paddingRight: mobile ? 16 : 14,
                borderRadius: 0,
                backgroundColor: "transparent",
                // Dimmed, never hidden: a buyer who came for the late release
                // needs to see that it exists and when it opens. Same treatment
                // sold-out rows get in the embed list.
                //
                // The dim is applied to the row's CONTENT, not here, and never
                // to `availabilityLabel` — that sentence is what explains the
                // dead row, and dimming it took it to roughly 2.2:1. Opacity
                // multiplies down the tree, so the note cannot re-brighten
                // itself from inside a dimmed ancestor; it has to sit outside
                // the dimmed element.
                // The border was previously dimmed along with the row. On Stub
                // `borderColor` is the ink itself, so leaving it at full
                // strength made an unbuyable row read LESS recessed than
                // before. Soften it by colour instead of opacity — an opacity
                // ancestor here is what dimmed the note in the first place.
                border: `1px solid ${
                  tierState.isBuyable
                    ? "var(--borderColor, #211C16)"
                    : "color-mix(in srgb, var(--borderColor, #211C16) 60%, transparent)"
                }`,
              }}
            >
              <YStack gap={2} flexShrink={1} minWidth={0}>
                <Text
                  style={{
                    fontSize: mobile ? 15 : 16,
                    fontWeight: "500",
                    opacity: tierState.isBuyable ? 1 : 0.6,
                  }}
                  color="$color"
                >
                  {tt.name}
                </Text>
                {availabilityLabel && (
                  <Text
                    style={{ fontSize: mobile ? 12 : 13 }}
                    color="$colorMuted"
                  >
                    {availabilityLabel}
                  </Text>
                )}
                {priceChangeLabel && (
                  <Text
                    style={{
                      fontSize: mobile ? 12 : 13,
                      opacity: tierState.isBuyable ? 1 : 0.6,
                    }}
                    color="$colorMuted"
                  >
                    {priceChangeLabel}
                  </Text>
                )}
              </YStack>
              <div
                className="ticket-type-row__right"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  opacity: tierState.isBuyable ? 1 : 0.6,
                }}
              >
                {/* "{count} available" counts what is LEFT, not what was
                    authored — `capacity` never moves, so this label used to
                    read "250 available" on a tier with 43 left (and stayed at
                    "250 available" on one with none). Falls back to the
                    authored column only for callers that predate the field
                    (stories); the real payload always carries it. A tier with
                    nothing left renders no number at all, as before. */}
                {(tt.remainingCapacity ?? tt.capacity) > 0 && (
                  <Text style={{ fontSize: mobile ? 13 : 14 }} color="$color">
                    {String(
                      t("eventDetail.ticketCapacity", {
                        count: tt.remainingCapacity ?? tt.capacity,
                      }),
                    )}
                  </Text>
                )}
                <XStack gap={4} alignItems="center">
                  <YStack alignItems="flex-end">
                    <Text
                      style={{ fontSize: mobile ? 15 : 16, fontWeight: "700" }}
                      color="$color"
                    >
                      {pwywCopy?.label ??
                        (buyerUnitTotalCents === 0
                          ? String(t("common.free"))
                          : buyerUnitTotalCents == null
                            ? String(t("checkout.calculatingTotal"))
                            : formatPrice(buyerUnitTotalCents))}
                    </Text>
                    {pwywCopy?.hint && (
                      <Text
                        style={{ fontSize: mobile ? 12 : 13 }}
                        color="$colorMuted"
                      >
                        {pwywCopy.hint}
                      </Text>
                    )}
                  </YStack>
                  {showFee && (
                    <div
                      className="fee-tooltip-anchor"
                      onClick={handleFeeTooltipToggle}
                    >
                      <XStack gap={3} alignItems="center">
                        {/* 44×44 hit area around the 15/16px glyph (mobile
                            tap-target floor). Negative margins re-absorb the
                            padding so the VISUAL row layout is unchanged —
                            only the tappable box grows. */}
                        <span
                          tabIndex={0}
                          role="button"
                          aria-label={String(t("eventDetail.feesTapHint"))}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 44,
                            height: 44,
                            margin: mobile ? -14.5 : -14,
                            flexShrink: 0,
                          }}
                        >
                          {/* CSS var, not `theme.color.val`: it has to
                              follow the embed's host text colour. */}
                          <Info
                            size={mobile ? 15 : 16}
                            color="var(--color, #211C16)"
                            aria-hidden="true"
                          />
                        </span>
                      </XStack>
                      <div className="fee-tooltip-content" role="tooltip">
                        <span className="fee-tooltip-row">
                          {String(t("eventDetail.feesPlatform"))} (
                          {platformFeeRateLabel(
                            platformFeeLabel,
                            platformFeeRates,
                            t,
                            (cents) => fmtCurrency(fmt, cents, currency),
                          ) ?? ""}
                          ):{" "}
                          {formatPrice(fee!.platformFeeCents)}
                        </span>
                        <span className="fee-tooltip-row">
                          {String(t("eventDetail.feesProcessing"))} (
                          {processorFeeLabel ?? ""}):{" "}
                          {formatPrice(fee!.processorFeeCents)}
                        </span>
                        {fee!.taxEstimateCents > 0 ? (
                          <span className="fee-tooltip-row">
                            {String(t("eventDetail.feesTax"))}
                            {taxRateLabel ? ` (${taxRateLabel})` : ""}:{" "}
                            {formatPrice(fee!.taxEstimateCents)}
                          </span>
                        ) : (
                          <span
                            className="fee-tooltip-row"
                            style={{ opacity: 0.7, fontStyle: "italic" }}
                          >
                            {String(t("eventDetail.feesTaxNote"))}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </XStack>
              </div>
            </div>
          );
        })}
      </YStack>
    </YStack>
  );
}
