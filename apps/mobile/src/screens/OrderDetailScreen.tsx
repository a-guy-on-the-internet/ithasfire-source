import { useCallback, useEffect } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Calendar,
  ChevronRight,
  CloudOff,
  MapPin,
  QrCode,
} from "lucide-react-native";

import {
  SquareCard,
  SquareSecondaryButton,
  StatusBadge,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";
import { formatOrderCode } from "@th/types";

import { trpc } from "@/lib/trpc";
import { useOrderTickets } from "@/features/tickets/use-order-tickets";
import {
  computeOrderCharges,
  shouldShowChargeRow,
} from "@/features/tickets/order-format";
import {
  formatTicketCode,
  formatTicketCount,
  formatTicketOrderCurrency,
  formatTicketOrderDateTime,
  getTicketOrderStatusDisplay,
  getTicketStatusDisplay,
} from "@/features/tickets/ticket-format";
import { ScreenSurface } from "@/ui/primitives";
import type { TicketsStackParamList } from "@/navigation/types";

type Props = NativeStackScreenProps<TicketsStackParamList, "OrderDetail">;

const ChargeRow = ({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) => {
  const styles = useThemedSheet(makeSheet);
  return (
    <View style={[styles.chargeRow, emphasis ? styles.chargeRowTotal : null]}>
      <Text style={emphasis ? styles.chargeLabelTotal : styles.chargeLabel}>
        {label}
      </Text>
      <Text style={emphasis ? styles.chargeValueTotal : styles.chargeValue}>
        {value}
      </Text>
    </View>
  );
};

const MetaRow = ({
  icon: Icon,
  label,
}: {
  icon: typeof Calendar;
  label: string;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <View style={styles.metaRow}>
      <Icon size={15} color={colors.colorMuted} />
      <Text style={styles.metaText}>{label}</Text>
    </View>
  );
};

export const OrderDetailScreen = ({ route, navigation }: Props) => {
  const { orderId, eventName } = route.params;
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);

  const orderQuery = trpc.orders.getMyOrder.useQuery(
    { orderId },
    { staleTime: 30_000, retry: 1 },
  );
  const order = orderQuery.data;

  // This screen is the only one that knows the event date, so it is the only
  // one that can make the cached entry evictable once the show is over. The
  // pass screen caches without it and falls back to the undated backstop.
  const {
    tickets,
    source,
    cachedAt,
    isLoading: ticketsLoading,
    errorMessage: ticketsError,
    refetch: refetchTickets,
  } = useOrderTickets(orderId, order?.eventStartsAt ?? null);

  useEffect(() => {
    const title = order?.eventName ?? eventName;
    if (title) navigation.setOptions({ title });
  }, [eventName, navigation, order?.eventName]);

  // Bound method, not the query object — the latter is a fresh reference every
  // render, which would defeat the memo.
  const refetchOrder = orderQuery.refetch;
  const handleRefresh = useCallback(() => {
    void refetchOrder();
    refetchTickets();
  }, [refetchOrder, refetchTickets]);

  const openPass = useCallback(
    (ticketId: string) => {
      navigation.navigate("TicketQr", {
        orderId,
        ticketId,
        eventName: order?.eventName ?? eventName,
      });
    },
    [eventName, navigation, order?.eventName, orderId],
  );

  const isLoading = orderQuery.isLoading && ticketsLoading;

  if (isLoading) {
    return (
      <ScreenSurface testID="order-detail-screen">
        <SafeAreaView style={styles.safe} edges={["bottom"]}>
          <View style={styles.centered} testID="order-detail-loading">
            <ActivityIndicator color={colors.color} />
            <Text style={styles.stateText}>Loading order</Text>
          </View>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  // `getMyOrder` is buyer-only: a transfer recipient owns tickets on this
  // order but is denied the order itself (ORDER_NOT_FOUND, deliberately, so
  // existence doesn't leak). So a failed order fetch is only fatal when we
  // also have no tickets — otherwise we show what they legitimately own.
  // `!ticketsLoading` matters: the order query can exhaust its retries while
  // the SecureStore read is still outstanding. Without it, a buyer offline at
  // a door gets a full-screen "Couldn't load this order" that then flips to
  // their cached passes a moment later.
  const nothingToShow =
    orderQuery.isError && !ticketsLoading && tickets.length === 0;

  // Distinguish "you're not the buyer" from "we couldn't reach the server".
  // Both leave `order` undefined, but telling a buyer standing offline at a
  // door that the receipt belongs to someone else is simply false — and this
  // is the exact screen the offline path exists for. A cached ticket list is
  // the tell: it means we're serving from disk, not that access was denied.
  const servingOffline = source === "cache";
  const receiptDenied = orderQuery.isError && !servingOffline;

  if (nothingToShow) {
    return (
      <ScreenSurface testID="order-detail-screen">
        <SafeAreaView style={styles.safe} edges={["bottom"]}>
          <View style={styles.centered} testID="order-detail-error">
            <SquareCard tone="danger" accessibilityRole="alert">
              <StatusBadge label="Unavailable" tone="danger" />
              <Text style={styles.stateTitle}>Couldn&apos;t load this order.</Text>
              <Text style={styles.stateText}>
                {ticketsError ??
                  orderQuery.error?.message ??
                  "This order isn't available on your account."}
              </Text>
              <SquareSecondaryButton
                label="Try again"
                onPress={handleRefresh}
                accessibilityHint="Reloads this order."
              />
            </SquareCard>
          </View>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  const charges = order ? computeOrderCharges(order) : null;
  const status = order ? getTicketOrderStatusDisplay(order.status) : null;

  return (
    <ScreenSurface testID="order-detail-screen">
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={orderQuery.isFetching && !orderQuery.isLoading}
              onRefresh={handleRefresh}
              tintColor={colors.color}
            />
          }
        >
          {order ? (
            <View style={styles.section}>
              <View style={styles.headerRow}>
                <Text style={styles.eventName}>{order.eventName}</Text>
                {status ? (
                  <StatusBadge label={status.label} tone={status.tone} />
                ) : null}
              </View>
              <View style={styles.metaGroup}>
                <MetaRow
                  icon={Calendar}
                  label={formatTicketOrderDateTime(order.eventStartsAt)}
                />
                {order.eventVenue ? (
                  <MetaRow icon={MapPin} label={order.eventVenue} />
                ) : null}
              </View>
              <Text style={styles.orderRef} selectable>
                Order #{formatOrderCode(order.id)}
              </Text>
            </View>
          ) : (
            <View style={styles.section} testID="order-detail-partial">
              <Text style={styles.eventName}>{eventName ?? "Your tickets"}</Text>
              <Text style={styles.stateText}>
                {receiptDenied
                  ? "You hold tickets on this order. The full receipt is only available to the person who bought it."
                  : servingOffline
                    ? "Showing your saved passes. The receipt will load when you're back online."
                    : "Loading the receipt…"}
              </Text>
            </View>
          )}

          {/* ── Tickets ─────────────────────────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeadRow}>
              {/*
                Suppress the count until tickets resolve. The order can come
                back warm from react-query while the ticket list is still in
                flight, and "0 TICKETS" over an empty list reads as "your
                tickets are gone".
              */}
              <Text style={styles.sectionTitle}>
                {ticketsLoading ? "Tickets" : formatTicketCount(tickets.length)}
              </Text>
              {source === "cache" ? (
                <View style={styles.offlineRow} testID="order-offline-notice">
                  <CloudOff size={13} color={colors.colorMuted} />
                  <Text style={styles.offlineText}>
                    Offline
                    {cachedAt
                      ? ` · ${formatTicketOrderDateTime(cachedAt)}`
                      : ""}
                  </Text>
                </View>
              ) : null}
            </View>

            {ticketsError ? (
              <SquareCard tone="danger">
                <Text style={styles.stateText}>{ticketsError}</Text>
                <SquareSecondaryButton
                  label="Retry"
                  onPress={refetchTickets}
                  accessibilityHint="Reloads the ticket codes."
                />
              </SquareCard>
            ) : null}

            {ticketsLoading ? (
              <View style={styles.ticketsLoadingRow} testID="order-tickets-loading">
                <ActivityIndicator color={colors.color} />
                <Text style={styles.stateText}>Loading your passes</Text>
              </View>
            ) : null}

            {tickets.map((ticket, i) => {
              const ticketStatus = getTicketStatusDisplay(ticket.status);
              return (
                <Pressable
                  key={ticket.id}
                  onPress={() => openPass(ticket.id)}
                  style={({ pressed }) => [
                    styles.ticketRow,
                    pressed ? styles.ticketRowPressed : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Show pass for ticket ${i + 1}`}
                  accessibilityHint="Opens the scannable QR code."
                  testID={`order-ticket-${ticket.id}`}
                >
                  <QrCode size={20} color={colors.accentText} />
                  <View style={styles.ticketRowBody}>
                    <Text style={styles.ticketRowTitle}>Ticket {i + 1}</Text>
                    <Text style={styles.ticketRowCode} numberOfLines={1}>
                      {formatTicketCode(ticket.code)}
                    </Text>
                  </View>
                  <StatusBadge
                    label={ticketStatus.label}
                    tone={ticketStatus.tone}
                  />
                  <ChevronRight size={18} color={colors.colorMuted} />
                </Pressable>
              );
            })}
          </View>

          {/* ── Charges (buyer only) ────────────────────────────────────── */}
          {order && charges ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Payment</Text>
              <View style={styles.chargeGroup}>
                <ChargeRow
                  label="Subtotal"
                  value={formatTicketOrderCurrency(
                    charges.subtotalCents,
                    order.currency,
                  )}
                />
                {shouldShowChargeRow(charges.platformFeeCents) ? (
                  <ChargeRow
                    label="Platform fee"
                    value={formatTicketOrderCurrency(
                      charges.platformFeeCents,
                      order.currency,
                    )}
                  />
                ) : null}
                {shouldShowChargeRow(charges.taxCents) ? (
                  <ChargeRow
                    label="Tax"
                    value={formatTicketOrderCurrency(
                      charges.taxCents,
                      order.currency,
                    )}
                  />
                ) : null}
                {shouldShowChargeRow(charges.processingFeeCents) ? (
                  <ChargeRow
                    label="Processing fee"
                    value={formatTicketOrderCurrency(
                      charges.processingFeeCents,
                      order.currency,
                    )}
                  />
                ) : null}
                <ChargeRow
                  label="Total paid"
                  value={formatTicketOrderCurrency(
                    charges.totalCents,
                    order.currency,
                  )}
                  emphasis
                />
              </View>
              <Text style={styles.purchasedAt}>
                Purchased {formatTicketOrderDateTime(order.occurredAt)}
              </Text>
            </View>
          ) : null}

          {order?.organiserName ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Organiser</Text>
              <Text style={styles.metaText}>{order.organiserName}</Text>
              {order.organiserContactEmail ? (
                <Text style={styles.metaText} selectable>
                  {order.organiserContactEmail}
                </Text>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </ScreenSurface>
  );
};

const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    safe: { flex: 1 },
    content: {
      flexGrow: 1,
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 32,
      gap: 24,
    },
    centered: {
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 20,
      gap: 12,
    },
    section: { gap: 12 },
    headerRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
    },
    eventName: {
      flex: 1,
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 20,
      fontWeight: "700",
      lineHeight: 26,
    },
    metaGroup: { gap: 8 },
    metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    metaText: {
      flex: 1,
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 13,
      lineHeight: 18,
    },
    orderRef: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    sectionHeadRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    sectionTitle: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    offlineRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    offlineText: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    ticketRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 60,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surface,
    },
    ticketRowPressed: {
      backgroundColor: c.activeRowTint,
      borderColor: c.borderColorStrong,
    },
    ticketsLoadingRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    ticketRowBody: { flex: 1, gap: 3 },
    ticketRowTitle: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 14,
      fontWeight: "700",
    },
    ticketRowCode: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 12,
      letterSpacing: 0.6,
    },
    chargeGroup: {
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surface,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    chargeRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingVertical: 10,
    },
    chargeRowTotal: {
      borderTopWidth: 2,
      borderTopColor: c.borderColor,
      marginTop: 4,
    },
    chargeLabel: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 13,
    },
    chargeValue: {
      color: c.color,
      fontFamily: "Montserrat-Medium",
      fontSize: 13,
    },
    chargeLabelTotal: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 13,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    chargeValueTotal: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 17,
      fontWeight: "700",
    },
    purchasedAt: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 12,
    },
    stateTitle: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    stateText: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 20,
    },
  });
