"use client";

import { ChevronRight, Minus, Plus, Ticket } from "lucide-react";
import { useFormatters, useTranslations } from "@th/ui";

import {
  deriveTicketTierState,
  formatEventZonedInstant,
  type TicketTierSellability,
} from "@/components/events/ticket-tier-state";

import {
  BORDER,
  BORDER_SUBTLE,
  STEEL_BLUE,
  STEEL_BLUE_SOFT,
  SURFACE,
  SURFACE_MUTED,
  TEXT,
  TEXT_CAPTION,
  TEXT_INVERTED,
  TEXT_MUTED,
  WARNING,
} from "./embed-theme";
import { formatCurrency } from "./embed-helpers";
import { getListedBuyerAllInDisplayCents } from "@/lib/pricing/buyer-display";
import { defaultChosenAmountCents } from "@/lib/pricing/pay-what-you-want";
import { payWhatYouWantListingCopy } from "@/components/events/pay-what-you-want-copy";
import { PayWhatYouWantAmount } from "@/components/pricing/PayWhatYouWantAmount";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EmbedTicketType = {
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
  /**
   * The AUTHORED capacity column — the tier's configured size. NOT an
   * availability signal: no write path decrements it, which is why the old
   * `capacity <= 0` sold-out test here was essentially never true. Nothing in
   * this component may read it; use `remainingCapacity` / `soldOut`.
   */
  capacity: number;
  /**
   * How many of this tier a buyer can take RIGHT NOW, straight off
   * `embeds.getEventDetail` — `capacity - issued - held`, the same basis
   * checkout refuses on. REQUIRED: every scarcity string on the row is
   * computed from it, and letting a caller omit it is how the widget goes
   * back to quoting a column that never moves.
   */
  remainingCapacity: number;
  /**
   * The SERVER's sold-out verdict (`remainingCapacity <= 0`). Optional only so
   * a fixture can state stock with one field; when absent it is derived from
   * `remainingCapacity`, never from `capacity`.
   */
  soldOut?: boolean;
  currency: string;
  pricingMode?: "FIXED" | "ADJUSTABLE";
  minimumCents?: number | null;
  suggestedCents?: number | null;
  seatSection?: {
    id: string;
    name: string;
    type: "GA" | "RESERVED";
  } | null;
  /**
   * PER-TIER availability (FR-010), exactly as `getEmbedEventDetail` resolved
   * it. Before Phase 2b the widget knew only a whole-event `salesClosed`
   * boolean, so a tier still inside its window and one that opens on Friday
   * rendered identically — with a working +/- stepper on both, and a refusal
   * only at submit. Optional so a stale cached payload renders as it did.
   *
   * IMPORTED, not re-spelled: this file's only use of the value is to hand it
   * to `deriveTicketTierState`, and a private copy of the 7-reason union here
   * has no backstop — it would silently stop matching if core's enum widened,
   * and the widget would fall through to "buyable".
   */
  sellability?: TicketTierSellability;
  /** Q-002 pending price change. Already null once the flip has passed. */
  upcomingPriceChange?: { toPriceCents: number; at: Date | string } | null;
  /** IANA zone of the EVENT — window instants render on the venue's clock. */
  timezone?: string | null;
};

export type EmbedTicketTypeListProps = {
  ticketTypes: EmbedTicketType[];
  quantities: Record<string, number>;
  onQuantityChange: (ticketTypeId: string, delta: number) => void;
  onSelectSeats?: (
    ticketTypeId: string,
    seatSectionId: string,
    seatSectionName: string,
  ) => void;
  donationAmounts?: Record<string, number>;
  onDonationAmountChange?: (ticketTypeId: string, amountCents: number) => void;
  /** Show the amount fields' errors now (Continue refused an amount). */
  showDonationErrors?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function EmbedTicketTypeList({
  ticketTypes,
  quantities,
  onQuantityChange,
  onSelectSeats,
  donationAmounts,
  onDonationAmountChange,
  showDonationErrors = false,
}: EmbedTicketTypeListProps) {
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
          border: `1px dashed ${BORDER}`,
          padding: "48px 24px",
          textAlign: "center",
        }}
      >
        <Ticket size={26} style={{ color: TEXT_CAPTION }} />
        <p
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: TEXT_MUTED,
            margin: 0,
          }}
        >
          Tickets are not available at this time.
        </p>
        <p style={{ fontSize: 13, color: TEXT_CAPTION, margin: 0 }}>
          Check back closer to the event.
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
        border: `1px solid ${BORDER}`,
      }}
    >
      {ticketTypes.map((tt, idx) => {
        const qty = quantities[tt.id] ?? 0;
        // SOLD OUT is still NOT folded into sellability — the two are
        // independent (a tier can be both sold out and not yet on sale), so
        // they are ORed into one "no stepper" decision here rather than merged
        // upstream. What changed is where the fact comes from: the SERVER, on
        // the same `capacity - issued - held` basis checkout refuses on. It
        // used to be `tt.capacity <= 0` — the authored column, which no write
        // path decrements, so a sold-out tier rendered a working +/- inside a
        // partner's iframe and refused the buyer at submit.
        const remaining = tt.remainingCapacity;
        const isSoldOut = tt.soldOut ?? remaining <= 0;
        const tierState = deriveTicketTierState(tt);
        const isUnavailable = isSoldOut || !tierState.isBuyable;
        const availabilityNote = (() => {
          const availability = tierState.availability;
          if (!availability) return null;
          if (availability.reason === "sales_ended") {
            return String(t("eventDetail.tierSalesEnded"));
          }
          const at = formatEventZonedInstant(
            availability.opensAt,
            tt.timezone,
            fmt.dateTime,
          );
          return at
            ? String(t("eventDetail.tierOnSaleFrom", { date: at }))
            : String(t("eventDetail.tierNotOnSale"));
        })();
        const priceChangeNote = (() => {
          if (!tierState.priceChange) return null;
          const at = formatEventZonedInstant(
            tierState.priceChange.at,
            tt.timezone,
            fmt.dateTime,
          );
          if (!at) return null;
          return String(
            t("eventDetail.tierPriceUntil", {
              price: formatCurrency(tt.priceCents, tt.currency),
              date: at,
              // Q-002's whole point: the number it rises TO. Without it the
              // line is just a date sitting under the availability notices,
              // and reads as a second sales deadline.
              newPrice: formatCurrency(
                tierState.priceChange.toPriceCents,
                tt.currency,
              ),
            }),
          );
        })();
        const isSelected = qty > 0;
        const isLast = idx === ticketTypes.length - 1;
        const isReserved = tt.seatSection?.type === "RESERVED";
        const isAdjustable = tt.pricingMode === "ADJUSTABLE";
        // The row's face must be this ticket's face: a cached row from before a
        // price change reads "Calculating total…", never new face + old fees.
        const buyerDisplayPriceCents = getListedBuyerAllInDisplayCents(tt);
        // The main event page's wording (`payWhatYouWantListingCopy`):
        // "From $6.09", the floor ALL-IN off the row the server priced at the
        // floor (the figure the header above already shows), "Calculating
        // total…" until it loads, or "Pay what you want" + the suggestion
        // when there is no floor.
        const pwywCopy = isAdjustable
          ? payWhatYouWantListingCopy(tt, {
              estimate: {
                buyerUnitTotalCents: tt.buyerUnitTotalCents,
                // The floor the row was priced at: a raised or lowered
                // minimum inside the rates' cache window is not quoted.
                unitPriceCents: tt.buyerUnitPriceCents,
              },
              formatPrice: (cents) => formatCurrency(cents, tt.currency),
              t,
            })
          : null;
        const priceLabel = pwywCopy
          ? pwywCopy.label
          : buyerDisplayPriceCents === null
            ? String(t("checkout.calculatingTotal"))
            : buyerDisplayPriceCents === 0
              ? String(t("common.free"))
              : formatCurrency(buyerDisplayPriceCents, tt.currency);

        return (
          <div
            key={tt.id}
            role="listitem"
            aria-label={`${tt.name}, ${priceLabel}${isSoldOut ? ", sold out" : ""}${
              availabilityNote ? `, ${availabilityNote}` : ""
            }`}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 16,
              padding: "14px 20px",
              // The unbuyable dim lives on the row's CONTENT, not on the row,
              // so `availabilityNote` keeps full contrast — it is the sentence
              // that explains the dead control, and at 0.5 it landed near
              // 2.2:1. Opacity multiplies down the tree, so the note cannot
              // re-brighten itself from inside a dimmed ancestor.
              background: isSelected ? STEEL_BLUE_SOFT : SURFACE,
              transition: "background 0.15s",
              ...(!isLast
                ? { borderBottom: `1px solid ${BORDER_SUBTLE}` }
                : {}),
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
                  backgroundColor: STEEL_BLUE,
                }}
                aria-hidden="true"
              />
            )}

            {/* Ticket info. The 160px basis is what lets the row's wrap
                work: with `flex: 1` (basis 0) the column always fit beside
                the 132px stepper, so a 272px iframe squeezed it to 50px and
                "General Admission" ran under the minus button. Now, when
                160px of name cannot sit beside the control, the control
                drops to its own line under the name. */}
            <div
              data-testid="embed-ticket-info"
              style={{ minWidth: 0, flex: "1 1 160px" }}
            >
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
                    fontSize: 14,
                    fontWeight: 700,
                    lineHeight: 1.3,
                    color: isSelected ? STEEL_BLUE : TEXT,
                    margin: 0,
                    // A single word longer than the column breaks rather
                    // than pushing past it.
                    minWidth: 0,
                    overflowWrap: "anywhere",
                  }}
                >
                  {tt.name}
                </p>
                <span
                  data-testid="embed-ticket-price"
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color: isSelected ? STEEL_BLUE : TEXT,
                    textAlign: "right",
                  }}
                >
                  {priceLabel}
                  {pwywCopy?.hint && (
                    <span
                      data-testid="embed-ticket-price-hint"
                      style={{
                        display: "block",
                        fontSize: 11,
                        fontWeight: 400,
                        color: TEXT_MUTED,
                      }}
                    >
                      {pwywCopy.hint}
                    </span>
                  )}
                </span>
              </div>
              <p
                style={{
                  marginTop: 2,
                  fontSize: 12,
                  // "Sold out" was TEXT_CAPTION (#A0A0A0), which is 2.6:1 on a
                  // white host even at full opacity — un-dimming it alone would
                  // not have reached AA. TEXT_MUTED is the same rung the
                  // availability note uses.
                  color: isSoldOut
                    ? TEXT_MUTED
                    : remaining <= 10
                      ? WARNING
                      : TEXT_MUTED,
                  fontWeight: remaining <= 10 && !isSoldOut ? 700 : 400,
                  margin: "3px 0 0",
                  // "Sold out" is an EXPLANATION, like the availability note,
                  // so it keeps full strength. The other three strings this <p>
                  // can render are inventory decoration and dim with the row.
                  opacity: isUnavailable && !isSoldOut ? 0.5 : 1,
                }}
              >
                {/* Scarcity copy reads the REMAINING count, not the authored
                    one — "Only 3 left!" was previously computed from a column
                    that never moves. */}
                {isSoldOut
                  ? "Sold out"
                  : remaining <= 10
                    ? `Only ${remaining} left!`
                    : tt.seatSection?.name
                      ? tt.seatSection.name
                      : `${remaining.toLocaleString()} remaining`}
              </p>
              {/* Sale-window state, on its own line under the capacity note —
                  a DIFFERENT fact from "how many are left", and stacking them
                  keeps a sold-out AND not-yet-open tier honest about both. */}
              {availabilityNote && (
                <p
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: TEXT_MUTED,
                    margin: "3px 0 0",
                  }}
                >
                  {availabilityNote}
                </p>
              )}
              {priceChangeNote && (
                <p
                  style={{
                    fontSize: 12,
                    color: TEXT_CAPTION,
                    margin: "3px 0 0",
                    opacity: isUnavailable ? 0.5 : 1,
                  }}
                >
                  {priceChangeNote}
                </p>
              )}
            </div>

            {/* Right control: Select Seats (reserved) or qty stepper (GA) */}
            {isReserved && tt.seatSection && onSelectSeats ? (
              (() => {
                const sec = tt.seatSection;
                return (
                  <button
                    type="button"
                    disabled={isUnavailable}
                    aria-label={
                      isSelected
                        ? `${qty} seat${qty !== 1 ? "s" : ""} selected for ${tt.name}`
                        : `Select seats for ${tt.name}`
                    }
                    onClick={() => onSelectSeats(tt.id, sec.id, sec.name)}
                    style={{
                      flexShrink: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "7px 14px",
                      fontSize: 12,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      border: isSelected
                        ? `2px solid ${STEEL_BLUE}`
                        : `1px solid ${BORDER}`,
                      background: isSelected ? STEEL_BLUE : SURFACE_MUTED,
                      color: isSelected ? TEXT_INVERTED : TEXT_MUTED,
                      cursor: isUnavailable ? "default" : "pointer",
                      transition: "background 0.15s",
                      // Matches the dim the row used to apply. The GA stepper
                      // beside it already dims its own buttons to 0.3.
                      opacity: isUnavailable ? 0.5 : 1,
                    }}
                  >
                    {isSelected ? (
                      `${qty} seat${qty !== 1 ? "s" : ""} ✓`
                    ) : (
                      <>
                        Select seats <ChevronRight size={12} />
                      </>
                    )}
                  </button>
                );
              })()
            ) : (
              /* 44px control height = the mobile tap-target floor (matches
                 the main checkout's QuantityStepper). Accessible names carry
                 the ticket-type name — with several types on one screen,
                 bare "Increase"/"Decrease" is ambiguous to SR users. */
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0,
                  // Dim the whole stepper, not its leaves: the qty value box
                  // below carries no opacity of its own, so leaf-only dimming
                  // left a full-strength 44px well (border + background + "0")
                  // between two ghosted buttons. Dimming here also re-composites
                  // the buttons' own 0.3 to 0.15, exactly what the old
                  // row-level dim produced.
                  opacity: isUnavailable ? 0.5 : 1,
                }}
              >
                {/* DECREMENT is gated on quantity alone, not on availability.
                    With nothing selected this is identical to before (qty 0 ⇒
                    disabled). The case it protects is a row that went
                    unavailable while the buyer had units in the cart — another
                    buyer took the last of the tier between renders — where a
                    dead minus would trap them at a quantity they cannot
                    reduce and cannot check out. Increment stays blocked. */}
                <button
                  type="button"
                  disabled={qty <= 0}
                  onClick={() => onQuantityChange(tt.id, -1)}
                  aria-label={String(
                    t("checkout.decreaseQuantityFor", { name: tt.name }),
                  )}
                  style={{
                    display: "flex",
                    height: 44,
                    width: 44,
                    alignItems: "center",
                    justifyContent: "center",
                    border: `2px solid ${BORDER}`,
                    background: "transparent",
                    color: qty <= 0 ? TEXT_CAPTION : TEXT_MUTED,
                    cursor: qty <= 0 ? "default" : "pointer",
                    opacity: qty <= 0 ? 0.3 : 1,
                    transition: "opacity 0.15s",
                  }}
                >
                  <Minus size={14} />
                </button>
                <div
                  style={{
                    display: "flex",
                    height: 44,
                    minWidth: 44,
                    alignItems: "center",
                    justifyContent: "center",
                    borderTop: `2px solid ${BORDER}`,
                    borderBottom: `2px solid ${BORDER}`,
                    background: SURFACE_MUTED,
                    fontSize: 14,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color: isSelected ? STEEL_BLUE : TEXT,
                    paddingInline: 4,
                  }}
                  aria-live="polite"
                >
                  {qty}
                </div>
                {/* Also stop at what is actually left — see TicketTypeGrid's
                    note. Blocking INCREMENT (rather than clamping a value) is
                    what keeps a resumed cart safe: a buyer already holding more
                    than the public count shows simply cannot add more, and is
                    never pushed below what they hold. */}
                <button
                  type="button"
                  disabled={
                    isUnavailable ||
                    (typeof remaining === "number" && qty >= remaining)
                  }
                  onClick={() => onQuantityChange(tt.id, 1)}
                  aria-label={String(
                    t("checkout.increaseQuantityFor", { name: tt.name }),
                  )}
                  style={{
                    display: "flex",
                    height: 44,
                    width: 44,
                    alignItems: "center",
                    justifyContent: "center",
                    border: `2px solid ${BORDER}`,
                    background: "transparent",
                    color: isUnavailable ? TEXT_CAPTION : TEXT_MUTED,
                    cursor: isUnavailable ? "default" : "pointer",
                    opacity: isUnavailable ? 0.3 : 1,
                    transition: "opacity 0.15s",
                  }}
                >
                  <Plus size={14} />
                </button>
              </div>
            )}

            {/* The buyer's amount: the main checkout's control — the same
                field, slider, parsing, minimum, $10,000 cap, presets, errors
                and a11y. It used to be a number input that clamped to the
                minimum and snapped while typing, with no upper bound. */}
            {isAdjustable && isSelected && onDonationAmountChange && (
              <div style={{ marginTop: 8, width: "100%" }}>
                <PayWhatYouWantAmount
                  tier={tt}
                  valueCents={
                    donationAmounts?.[tt.id] ?? defaultChosenAmountCents(tt)
                  }
                  onChange={(cents) => onDonationAmountChange(tt.id, cents)}
                  formatPrice={(cents) => formatCurrency(cents, tt.currency)}
                  forceShowError={showDonationErrors}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
