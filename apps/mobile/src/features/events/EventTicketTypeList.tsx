import { StyleSheet, Text, View } from "react-native";

import { useThemedSheet, type NativePalette } from "@th/ui-native";

import { formatTicketOrderCurrency } from "@/features/tickets/ticket-format";
import type { EventTicketTypes } from "@/features/events/use-event-detail";

type TicketType = EventTicketTypes["ticketTypes"][number];

/**
 * Price label for a ticket type row. ADJUSTABLE (pay-what-you-want) types
 * show "From X" using suggested → minimum → list price, in that order.
 * All amounts are server-provided integer cents — no client math.
 */
export const formatTicketTypePriceLabel = (
  ticketType: Pick<
    TicketType,
    "priceCents" | "pricingMode" | "minimumCents" | "suggestedCents"
  >,
  currency: string,
): string => {
  if (ticketType.pricingMode === "ADJUSTABLE") {
    const fromCents =
      ticketType.suggestedCents ??
      ticketType.minimumCents ??
      ticketType.priceCents;
    return `From ${formatTicketOrderCurrency(fromCents, currency)}`;
  }
  if (ticketType.priceCents === 0) return "Free";
  return formatTicketOrderCurrency(ticketType.priceCents, currency);
};

export const EventTicketTypeList = ({
  ticketTypes,
  currency,
  loadFailed = false,
}: {
  ticketTypes: TicketType[];
  currency: string;
  loadFailed?: boolean;
}) => {
  const styles = useThemedSheet(makeSheet);

  if (loadFailed && ticketTypes.length === 0) {
    return (
      <Text style={styles.emptyText}>
        {"Couldn't load tickets. Pull to refresh to try again."}
      </Text>
    );
  }
  if (ticketTypes.length === 0) {
    return (
      <Text style={styles.emptyText}>
        No ticket types are listed for this event yet.
      </Text>
    );
  }

  return (
    <View style={styles.list} testID="event-ticket-types">
      {ticketTypes.map((ticketType, index) => {
        const priceLabel = formatTicketTypePriceLabel(ticketType, currency);
        return (
          <View
            key={ticketType.id}
            style={[
              styles.row,
              index === ticketTypes.length - 1 && styles.rowLast,
            ]}
            accessible
            accessibilityLabel={`${ticketType.name}, ${priceLabel}`}
          >
            <Text style={styles.name} numberOfLines={2}>
              {ticketType.name}
            </Text>
            <Text style={styles.price}>{priceLabel}</Text>
          </View>
        );
      })}
    </View>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    list: {
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surfaceMuted,
    },
    row: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.borderColorSoft,
    },
    // Last row: the container's own 2px border closes the list — a 1px
    // borderBottom here would double up against it.
    rowLast: { borderBottomWidth: 0 },
    name: {
      flex: 1,
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 15,
      fontWeight: "700",
      lineHeight: 20,
    },
    price: {
      color: c.accentText,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 14,
      fontWeight: "700",
      letterSpacing: 0.5,
    },
    emptyText: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 20,
    },
  });
