"use client";

import React from "react";
import { Ticket } from "lucide-react";
import { useFormatters, useTranslations, QuantityStepper } from "@th/ui";
import { getListedBuyerAllInDisplayCents } from "@/lib/pricing/buyer-display";
import { defaultChosenAmountCents } from "@/lib/pricing/pay-what-you-want";
import { payWhatYouWantListingCopy } from "@/components/events/pay-what-you-want-copy";
import { PayWhatYouWantAmount } from "@/components/pricing/PayWhatYouWantAmount";
import {
  deriveTicketTierState,
  formatEventZonedInstant,
  type TicketTierSellability,
} from "@/components/events/ticket-tier-state";
import {
  FG as fg,
  fgAlpha,
  FS_BODY,
  FS_SM,
} from "./checkout-tokens";

export type TicketTypeGridItem = {
  id: string;
  name: string;
  priceCents: number;
  buyerUnitTotalCents?: number | null;
  /**
   * The face the per-ticket estimate was priced at (`withBuyerUnitTotals`; a
   * PWYW tier's row is priced at its floor). A row priced at another face is
   * stale and never quoted.
   */
  buyerUnitPriceCents?: number | null;
  pricingMode?: "FIXED" | "ADJUSTABLE";
  minimumCents?: number | null;
  suggestedCents?: number | null;
  /**
   * The AUTHORED capacity column — the tier's configured size. NOT an
   * availability signal: no write path decrements it, which is exactly why the
   * old `capacity <= 0` sold-out test here was essentially never true. Nothing
   * in this component may read it; use `remainingCapacity` / `soldOut`.
   */
  capacity: number;
  /**
   * How many of this tier the buyer can actually take RIGHT NOW, straight off
   * `events.listEventTicketTypes` — `capacity - issued - held`, the same basis
   * checkout refuses on. REQUIRED, deliberately: this is the number every
   * scarcity string on the row is computed from, and letting a caller omit it
   * is how the row silently goes back to quoting the authored column.
   */
  remainingCapacity: number;
  /**
   * The SERVER's sold-out verdict (`remainingCapacity <= 0`). Optional only so
   * a fixture can state stock with one field; when absent it is derived from
   * `remainingCapacity`, never from `capacity`.
   */
  soldOut?: boolean;
  /**
   * PER-TIER availability (FR-010), exactly as `events.listEventTicketTypes`
   * resolved it — the page one click back already renders it, and until this
   * landed the buyer crossed from a dimmed "On sale Fri, Oct 9" row on the
   * public page to a full-opacity row with a live stepper here, and only found
   * out at Continue (`TICKET_TYPE_NOT_YET_ON_SALE`). Fail-closed server-side,
   * but the refusal arrives with the card already out.
   *
   * Optional so a caller that predates FR-010 (stories, a cached payload)
   * renders exactly as before — which is also what every unwindowed tier gets.
   */
  sellability?: TicketTierSellability;
  /** Pending scheduled price change (Q-002). Null/absent once it has passed. */
  upcomingPriceChange?: { toPriceCents: number; at: Date | string } | null;
};

export type TicketTypeGridProps = {
  ticketTypes: TicketTypeGridItem[];
  quantities: Record<string, number>;
  onQuantityChange: (ticketTypeId: string, delta: number) => void;
  formatPrice: (cents: number) => string;
  /** When true, all steppers are disabled (e.g. during payment phase) */
  disabled?: boolean;
  /** Buyer-chosen donation amounts per ticket type (ADJUSTABLE mode). */
  donationAmounts?: Record<string, number>;
  /** Called when buyer changes donation amount for an ADJUSTABLE ticket type. */
  onDonationAmountChange?: (ticketTypeId: string, amountCents: number) => void;
  /**
   * Force the below-minimum / required message on every amount field, even
   * one the buyer has not left yet — set after a refused "Hold tickets".
   */
  showDonationErrors?: boolean;
  /**
   * IANA zone of the EVENT. Window instants and price flips are organizer
   * wall-clock decisions about their venue, so they render on the venue's
   * clock. Absent ⇒ no instant is rendered at all (the formatter refuses
   * rather than silently substituting the reader's zone) and the rows degrade
   * to zone-free copy.
   */
  timezone?: string | null;
};

export const TicketTypeGrid = ({
  ticketTypes,
  quantities,
  onQuantityChange,
  formatPrice,
  disabled = false,
  donationAmounts = {},
  onDonationAmountChange,
  showDonationErrors = false,
  timezone,
}: TicketTypeGridProps) => {
  const t = useTranslations();
  const fmt = useFormatters();

  if (ticketTypes.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          borderRadius: 0,
          border: `1px dashed ${fgAlpha(10)}`,
          padding: "64px 24px",
          textAlign: "center",
        }}
      >
        <Ticket size={28} style={{ color: fgAlpha(15) }} />
        <p
          style={{
            fontSize: FS_SM,
            fontWeight: 500,
            color: fgAlpha(85),
            margin: 0,
          }}
        >
          {String(t("checkout.ticketsNotOnSale"))}
        </p>
        <p style={{ fontSize: FS_SM, color: fgAlpha(75), margin: 0 }}>
          {String(t("checkout.checkBackLater"))}
        </p>
      </div>
    );
  }

  return (
    <div
      role="list"
      aria-label="Ticket types"
      style={{
        overflow: "hidden",
        borderRadius: 0,
        border: `1px solid ${fgAlpha(7)}`,
      }}
    >
      {ticketTypes.map((tt, idx) => {
        const qty = quantities[tt.id] ?? 0;
        // SOLD OUT and SALE WINDOW are independent facts — a tier can be both
        // sold out and not yet on sale — so they are ORed into one "no
        // stepper" decision here rather than merged upstream. Same shape as
        // the embed's list (`EmbedTicketTypeList`), deliberately.
        //
        // Sold-out comes from the SERVER now. It used to be `tt.capacity <= 0`
        // — the authored column, which no write path decrements, so the test
        // was essentially never true: a gone tier rendered a live stepper and
        // the buyer only found out at Continue, when the pre-charge gate
        // refused them with TICKET_TYPE_SOLD_OUT.
        const remaining = tt.remainingCapacity;
        const isSoldOut = tt.soldOut ?? remaining <= 0;
        const tierState = deriveTicketTierState(tt);
        const isUnavailable = isSoldOut || !tierState.isBuyable;
        const availabilityNote = (() => {
          const availability = tierState.availability;
          if (!availability) return null;
          if (availability.reason === "sales_ended") {
            // No date: a deadline that has already passed is not actionable.
            return String(t("eventDetail.tierSalesEnded"));
          }
          const at = formatEventZonedInstant(
            availability.opensAt,
            timezone,
            fmt.dateTime,
          );
          return at
            ? String(t("eventDetail.tierOnSaleFrom", { date: at }))
            : // Unrenderable instant (no zone / unknown zone id) — still say
              // it is not on sale rather than implying it is.
              String(t("eventDetail.tierNotOnSale"));
        })();
        const priceChangeNote = (() => {
          if (!tierState.priceChange) return null;
          const at = formatEventZonedInstant(
            tierState.priceChange.at,
            timezone,
            fmt.dateTime,
          );
          if (!at) return null;
          // BOTH sides quote FACE value, not the fee-inclusive figure in the
          // price label above. The post-flip buyer total is not computable
          // client-side (the fee estimate covers current prices only), and a
          // face→inclusive comparison would fabricate a rise that is partly
          // fees. Face→face is the honest pair, and matches the public page
          // and the embed list.
          return String(
            t("eventDetail.tierPriceUntil", {
              price: formatPrice(tt.priceCents),
              date: at,
              newPrice: formatPrice(tierState.priceChange.toPriceCents),
            }),
          );
        })();
        const isSelected = qty > 0;
        const isLast = idx === ticketTypes.length - 1;
        const isAdjustable = tt.pricingMode === "ADJUSTABLE";
        // The row's face must be this ticket's face: a cached row from before a
        // price change reads "Calculating total…", never new face + old fees.
        const buyerDisplayPriceCents = getListedBuyerAllInDisplayCents(tt);
        const donationCents =
          donationAmounts[tt.id] ?? defaultChosenAmountCents(tt);
        // PWYW: the same label the event page and the embed quote
        // (`payWhatYouWantListingCopy`) — "From $6.09", the floor ALL-IN off
        // the row the server priced at the floor, like every fixed figure on
        // this card; "Calculating total…" until that row loads; or "Pay what
        // you want" with a muted (face) suggestion when there is no minimum.
        // It used to quote the bare floor ("From $5.00"), under what the
        // buyer is charged.
        const pwywCopy = isAdjustable
          ? payWhatYouWantListingCopy(tt, {
              estimate: {
                buyerUnitTotalCents: tt.buyerUnitTotalCents,
                // The floor the row was priced at: a raised or lowered
                // minimum inside the rates' cache window is not quoted.
                unitPriceCents: tt.buyerUnitPriceCents,
              },
              formatPrice,
              t,
            })
          : null;
        const pwywSuggestion = pwywCopy?.hint ?? null;
        const priceLabel = pwywCopy
          ? pwywCopy.label
          : buyerDisplayPriceCents === null
            ? String(t("checkout.calculatingTotal"))
            : buyerDisplayPriceCents === 0
              ? String(t("common.free"))
              : formatPrice(buyerDisplayPriceCents);

        return (
          <div
            key={tt.id}
            role="listitem"
            aria-label={`${tt.name}, ${priceLabel}${pwywSuggestion ? `, ${pwywSuggestion}` : ""}${isSoldOut ? ", sold out" : ""}${
              availabilityNote ? `, ${availabilityNote}` : ""
            }`}
            style={{
              position: "relative",
              display: "flex",
              flexDirection: isAdjustable && isSelected ? "column" : "row",
              alignItems: isAdjustable && isSelected ? "stretch" : "center",
              justifyContent: "space-between",
              gap: isAdjustable && isSelected ? 12 : 16,
              padding: "16px 20px",
              // Dimmed, never hidden: a buyer who came for the late release
              // needs to see it exists and when it opens.
              //
              // The dim lives on the row's CONTENT rather than here, so
              // `availabilityNote` can stay at full strength — it is the
              // sentence that explains the dead stepper, and at 0.5 it landed
              // near 2.2:1. Opacity multiplies down the tree, so a nested
              // override cannot undo an ancestor's dim; the note must sit
              // outside every dimmed element.
              background: isSelected ? fgAlpha(2.5) : "transparent",
              transition: "background 0.15s",
              ...(!isLast ? { borderBottom: `1px solid ${fgAlpha(6)}` } : {}),
            }}
          >
            {/* Selected accent bar */}
            {isSelected && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: 3,
                  backgroundColor: fg,
                }}
              />
            )}

            {/* Top row: name + stepper. width:100% so the stepper hugs the
                right edge of the card regardless of ticket-name length —
                otherwise this wrapper shrink-fits its content and rows with
                different name lengths show the stepper at different x. */}
            <div
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
              }}
            >
              {/* Ticket info */}
              <div style={{ minWidth: 0, flex: 1 }}>
                {/* flexWrap: at 320px the name's min-content + the price's
                    unbreakable "$51.09" exceed the column, and without wrap
                    the price overflowed the info column onto the stepper's
                    Decrease button. Wrapping drops the price to its own line
                    instead; flexShrink 0 keeps the digits from squeezing. */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    flexWrap: "wrap",
                    opacity: isUnavailable ? 0.5 : 1,
                  }}
                >
                  <p
                    style={{
                      fontSize: FS_BODY,
                      fontWeight: 700,
                      lineHeight: 1.3,
                      color: fg,
                      margin: 0,
                      minWidth: 0,
                    }}
                  >
                    {tt.name}
                  </p>
                  <span
                    style={{
                      fontSize: FS_BODY,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      color: fg,
                      // Digits must not squeeze; a worded PWYW label ("Pay
                      // what you want") must be allowed to wrap instead of
                      // running over the stepper at 320px.
                      flexShrink: isAdjustable ? 1 : 0,
                      minWidth: 0,
                    }}
                  >
                    {priceLabel}
                  </span>
                  {pwywSuggestion && (
                    <span
                      style={{
                        fontSize: FS_SM,
                        color: fgAlpha(65),
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {pwywSuggestion}
                    </span>
                  )}
                </div>
                <p
                  style={{
                    marginTop: 2,
                    fontSize: FS_SM,
                    color: isSoldOut
                      ? fgAlpha(75)
                      : remaining <= 10
                        ? "var(--support, #f59e0b)"
                        : fgAlpha(75),
                    margin: "2px 0 0",
                    fontWeight: remaining <= 10 && !isSoldOut ? 700 : 400,
                    // This <p> multiplexes four strings. Three ("Only N left!",
                    // "N remaining", a section name) are inventory decoration on
                    // a dead row and dim happily. "Sold out" is an EXPLANATION —
                    // the same class as the availability note — so it stays at
                    // full strength rather than sitting at ~2.2:1 two lines
                    // above a note that was just fixed for exactly that.
                    opacity: isUnavailable && !isSoldOut ? 0.5 : 1,
                  }}
                >
                  {/* Scarcity copy reads the REMAINING count, not the authored
                      one — "Only 3 left!" was previously computed from a column
                      that never moves, so a tier authored at 3 said it on the
                      day it went on sale and a tier authored at 500 never said
                      it at all. */}
                  {isSoldOut
                    ? String(t("common.soldOut"))
                    : remaining <= 10
                      ? `Only ${remaining} left!`
                      : String(t("common.nRemaining", { count: remaining }))}
                </p>
                {/* Sale-window state on its own line under the capacity note —
                    a DIFFERENT fact from "how many are left", so stacking them
                    keeps a sold-out AND not-yet-open tier honest about both. */}
                {availabilityNote && (
                  <p
                    style={{
                      fontSize: FS_SM,
                      fontWeight: 700,
                      color: fgAlpha(75),
                      margin: "2px 0 0",
                    }}
                  >
                    {availabilityNote}
                  </p>
                )}
                {priceChangeNote && (
                  <p
                    style={{
                      fontSize: FS_SM,
                      color: fgAlpha(65),
                      margin: "2px 0 0",
                      opacity: isUnavailable ? 0.5 : 1,
                    }}
                  >
                    {priceChangeNote}
                  </p>
                )}
              </div>

              {/* Stepper — per-button names carry the ticket-type context so
                  two types on one screen never announce four ambiguous
                  "Increase"/"Decrease" buttons. Dimmed with the rest of the
                  row's content; it is a disabled control, which the contrast
                  rules exempt. */}
              <div style={{ opacity: isUnavailable ? 0.5 : 1 }}>
                {/* An unavailable row with NOTHING selected renders exactly as
                  before: max 0 and a disabled stepper are both two dead
                  buttons. The difference is a row the buyer ALREADY holds
                  units of — now reachable, because their own unexpired hold is
                  part of what consumed the last of the tier (the public count
                  has no order to exclude). Blocking increment is right;
                  blocking DECREMENT would trap them at a quantity they cannot
                  reduce.

                  The `max` below caps at what the server says is actually LEFT,
                  not just at "some". Without it the sold-out case is closed but
                  the QUANTITY case is not: a tier with 3 left would happily let
                  the buyer pick 5, fill in contact + billing, and only then be
                  refused at hold — the same offered-then-refused trip this
                  change exists to remove, one dimension over. `Math.max(…, qty)`
                  is load-bearing for the resume case above: clamping to bare
                  `remainingCapacity` would shove an existing quantity DOWN. */}
                <QuantityStepper
                  value={qty}
                  onStep={(delta) => onQuantityChange(tt.id, delta)}
                  min={0}
                  max={
                    isUnavailable ? qty : Math.max(tt.remainingCapacity, qty)
                  }
                  disabled={(isUnavailable && qty === 0) || disabled}
                  aria-label={tt.name}
                  incrementLabel={String(
                    t("checkout.increaseQuantityFor", { name: tt.name }),
                  )}
                  decrementLabel={String(
                    t("checkout.decreaseQuantityFor", { name: tt.name }),
                  )}
                />
              </div>
            </div>

            {/* Amount for a pay-what-you-want tier the buyer has selected */}
            {isAdjustable && isSelected && (
              <PayWhatYouWantAmount
                tier={tt}
                valueCents={donationCents}
                onChange={(cents) => onDonationAmountChange?.(tt.id, cents)}
                formatPrice={formatPrice}
                disabled={disabled}
                forceShowError={showDonationErrors}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
