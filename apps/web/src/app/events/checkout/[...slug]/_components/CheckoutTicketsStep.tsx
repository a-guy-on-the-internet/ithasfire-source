"use client";

import nextDynamic from "next/dynamic";

import { useTranslations } from "@th/ui";

import {
  defaultChosenAmountCents,
  isPayWhatYouWant,
} from "@/lib/pricing/pay-what-you-want";
import { PayWhatYouWantAmount } from "@/components/pricing/PayWhatYouWantAmount";
import { TicketTypeGrid } from "./TicketTypeGrid";
import type { PlaceLayout, SeatAvailability } from "./SeatMapPicker";
import type { TicketTypeSummary } from "./useCheckoutState";
import {
  FG,
  sectionHeadingStyle,
  sectionNumStyle,
  sectionPaddingStyle,
} from "./checkout-tokens";

const SeatMapPicker = nextDynamic(
  () => import("./SeatMapPicker").then((m) => ({ default: m.SeatMapPicker })),
  { ssr: false },
);

export type CheckoutTicketsStepProps = {
  placeLayout: PlaceLayout | null;
  displayTicketTypes: TicketTypeSummary[];
  quantities: Record<string, number>;
  onQuantityChange: (ticketTypeId: string, delta: number) => void;
  formatPrice: (cents: number) => string;
  seatAvailability?: SeatAvailability[];
  selectedSeatIds?: Record<string, string[]>;
  onSeatToggle?: (seatId: string, sectionId: string) => void;
  isLoadingSeats: boolean;
  /**
   * Buyer-chosen amounts for pay-what-you-want tiers, and the setter. REQUIRED:
   * without them the grid's amount field is a controlled input that can never
   * change, which is exactly how PWYW shipped unusable here.
   */
  donationAmounts: Record<string, number>;
  onDonationAmountChange: (ticketTypeId: string, amountCents: number) => void;
  /** Show every amount field's error — set after a refused "Hold tickets". */
  showDonationErrors?: boolean;
  /**
   * IANA zone of the EVENT, for the ticket grid's sale-window and price-flip
   * copy. Threaded from the page's already-loaded `event.timezone` rather than
   * added to the `listEventTicketTypes` payload: the zone is an EVENT fact,
   * not a per-tier one, so putting it on every row would repeat it N times on
   * the wire to say the same thing — and this page already has it in hand. (The
   * embed payload carries `timezone` because `getEmbedEventDetail` is the
   * widget's ONLY source for the event; here it is not.)
   */
  timezone?: string | null;
};

export const CheckoutTicketsStep = ({
  placeLayout,
  displayTicketTypes,
  quantities,
  onQuantityChange,
  formatPrice,
  seatAvailability,
  selectedSeatIds,
  onSeatToggle,
  isLoadingSeats,
  donationAmounts,
  onDonationAmountChange,
  showDonationErrors,
  timezone,
}: CheckoutTicketsStepProps) => {
  const t = useTranslations();
  return (
    <section style={sectionPaddingStyle} className="checkout-section-padding">
      <h2 style={sectionHeadingStyle}>
        <span style={sectionNumStyle} aria-hidden>
          01
        </span>
        {String(t("checkout.selectYourTickets"))}
      </h2>
      {placeLayout ? (
        <>
          <SeatMapPicker
            layout={placeLayout}
            ticketTypes={displayTicketTypes}
            quantities={quantities}
            onQuantityChange={onQuantityChange}
            formatPrice={formatPrice}
            seatAvailability={seatAvailability}
            selectedSeatIds={selectedSeatIds}
            onSeatToggle={onSeatToggle}
            isLoadingSeats={isLoadingSeats}
          />
          {/* An ADJUSTABLE tier CAN be linked to a seat section (nothing in
              `assignTicketTypeSections` refuses it), and the seat map has no
              amount field of its own. Without this a seated PWYW buyer could
              never name their price, and the hold guard focused a missing
              input. */}
          {displayTicketTypes
            .filter(
              (tt) => isPayWhatYouWant(tt) && (quantities[tt.id] ?? 0) > 0,
            )
            .map((tt) => (
              <div
                key={tt.id}
                data-testid="seated-pwyw-amount"
                style={{
                  marginTop: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <p style={{ margin: 0, fontWeight: 700, color: FG }}>
                  {tt.name}
                </p>
                <PayWhatYouWantAmount
                  tier={tt}
                  valueCents={
                    donationAmounts[tt.id] ?? defaultChosenAmountCents(tt)
                  }
                  onChange={(cents) => onDonationAmountChange(tt.id, cents)}
                  formatPrice={formatPrice}
                  forceShowError={showDonationErrors}
                />
              </div>
            ))}
        </>
      ) : (
        <TicketTypeGrid
          ticketTypes={displayTicketTypes}
          quantities={quantities}
          onQuantityChange={onQuantityChange}
          formatPrice={formatPrice}
          donationAmounts={donationAmounts}
          onDonationAmountChange={onDonationAmountChange}
          showDonationErrors={showDonationErrors}
          timezone={timezone}
        />
      )}
    </section>
  );
};

CheckoutTicketsStep.displayName = "CheckoutTicketsStep";
