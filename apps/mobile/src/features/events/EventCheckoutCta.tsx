import { StyleSheet, Text } from "react-native";

import { SquarePrimaryButton, useColors } from "@th/ui-native";

import type { CheckoutPath } from "@/features/checkout/checkout-eligibility";
import type { EventTicketTypes } from "@/features/events/use-event-detail";

type SellabilityReason = EventTicketTypes["sellability"]["reason"];

const SELLABILITY_NOTES: Partial<Record<SellabilityReason, string>> = {
  sales_closed: "Ticket sales for this event have closed.",
  no_payee: "Tickets aren't available for this event yet.",
  stripe_not_connected: "Tickets aren't available for this event yet.",
};

/**
 * Purchase CTA for the unlocked event detail view, keyed by checkout path
 * (FR-002). `path === null` means eligibility inputs are still loading —
 * render nothing rather than flash the wrong CTA.
 */
export const EventCheckoutCta = ({
  path,
  sellabilityReason,
  onGetTickets,
  onEnterPassword,
  onOpenWebCheckout,
}: {
  path: CheckoutPath | null;
  sellabilityReason: SellabilityReason | null;
  onGetTickets: () => void;
  onEnterPassword: () => void;
  onOpenWebCheckout: () => void;
}) => {
  const colors = useColors();

  switch (path) {
    case "native":
      return (
        <SquarePrimaryButton
          label="Get tickets"
          onPress={onGetTickets}
          accessibilityHint="Starts checkout for this event."
          testID="event-cta-native"
        />
      );
    case "password":
      return (
        <SquarePrimaryButton
          label="Enter password"
          onPress={onEnterPassword}
          accessibilityHint="Opens the event password prompt."
          testID="event-cta-password"
        />
      );
    case "web":
      return (
        <SquarePrimaryButton
          label="Get tickets on ithasfire.com"
          onPress={onOpenWebCheckout}
          accessibilityHint="Opens checkout for this event in the browser."
          testID="event-cta-web"
        />
      );
    case "hidden": {
      const note = sellabilityReason
        ? SELLABILITY_NOTES[sellabilityReason]
        : undefined;
      if (!note) return null;
      return (
        <Text
          style={[styles.note, { color: colors.colorMuted }]}
          testID="event-cta-unavailable"
        >
          {note}
        </Text>
      );
    }
    default:
      return null;
  }
};

/** One themed value → plain geometry sheet + inline colour from `useColors()`. */
const styles = StyleSheet.create({
  note: {
    fontFamily: "Montserrat",
    fontSize: 14,
    lineHeight: 20,
  },
});
