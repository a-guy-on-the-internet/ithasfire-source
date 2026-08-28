import { useCallback } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Calendar, MapPin, Receipt, Search, Ticket } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

import {
  SquareCard,
  SquareSecondaryButton,
  StatusBadge,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  formatTicketCode,
  formatTicketCount,
  formatTicketOrderCurrency,
  formatTicketOrderDateTime,
  getTicketStatusDisplay,
  getTicketOrderStatusDisplay,
  isPastTicketOrder,
} from "./ticket-format";

type TicketOrder = RouterOutputs["orders"]["listMyOrders"]["items"][number];
type OrderTicket =
  RouterOutputs["orders"]["listMyOrderTickets"]["tickets"][number];

type TicketOrdersListProps = {
  ListHeaderComponent?: ReactNode;
  emptyTitle?: string;
  emptyBody?: string;
  testID?: string;
  /**
   * Opens the order. Optional so the list stays usable in surfaces with no
   * stack to push onto (the Profile summary, tests); when omitted the cards
   * render inert rather than as dead buttons.
   */
  onSelectOrder?: (order: TicketOrder) => void;
};

const OrderMetaRow = ({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <View style={styles.metaRow}>
      <Icon size={15} color={colors.colorMuted} />
      <Text style={styles.metaText} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
};

type TicketOrderCardProps = {
  order: TicketOrder;
  tickets: OrderTicket[];
  ticketsLoading: boolean;
  ticketsErrorMessage: string | null;
  onRetryTickets: () => void;
};

const TicketRow = ({
  ticket,
  index,
}: {
  ticket: OrderTicket;
  index: number;
}) => {
  const styles = useThemedSheet(makeSheet);
  const status = getTicketStatusDisplay(ticket.status);

  return (
    <View style={styles.ticketRow} testID={`ticket-${ticket.id}`}>
      <View style={styles.ticketRowHeader}>
        <Text style={styles.ticketLabel}>Ticket {index + 1}</Text>
        <StatusBadge label={status.label} tone={status.tone} />
      </View>
      <Text
        style={styles.ticketCode}
        selectable
        accessibilityLabel={`Ticket code ${ticket.code}`}
      >
        {formatTicketCode(ticket.code)}
      </Text>
      {ticket.scannedAt ? (
        <Text style={styles.ticketSubtext}>
          Scanned {formatTicketOrderDateTime(ticket.scannedAt)}
        </Text>
      ) : null}
    </View>
  );
};

const TicketDetails = ({
  order,
  tickets,
  ticketsLoading,
  ticketsErrorMessage,
  onRetryTickets,
}: TicketOrderCardProps) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);

  if (ticketsLoading) {
    return (
      <View
        style={styles.ticketStateRow}
        testID={`ticket-details-loading-${order.id}`}
      >
        <ActivityIndicator color={colors.color} />
        <Text style={styles.ticketStateText}>Loading ticket codes</Text>
      </View>
    );
  }

  if (ticketsErrorMessage) {
    return (
      <View
        style={styles.ticketErrorBox}
        testID={`ticket-details-error-${order.id}`}
      >
        <StatusBadge label="Ticket details unavailable" tone="danger" />
        <Text style={styles.ticketStateText}>{ticketsErrorMessage}</Text>
        <SquareSecondaryButton
          label="Retry"
          onPress={onRetryTickets}
          accessibilityHint="Reloads the ticket codes for this order."
        />
      </View>
    );
  }

  if (!tickets.length) {
    return (
      <View
        style={styles.ticketStateRow}
        testID={`ticket-details-empty-${order.id}`}
      >
        <Ticket size={15} color={colors.colorMuted} />
        <Text style={styles.ticketStateText}>
          No ticket codes found for this order.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.ticketRows}>
      {tickets.map((ticket, index) => (
        <TicketRow key={ticket.id} ticket={ticket} index={index} />
      ))}
    </View>
  );
};

const TicketOrderCard = ({
  order,
  tickets,
  ticketsLoading,
  ticketsErrorMessage,
  onRetryTickets,
}: TicketOrderCardProps) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const status = getTicketOrderStatusDisplay(order.status);
  const isPast = isPastTicketOrder(order.eventStartsAt);

  return (
    <View
      style={[styles.orderCard, isPast ? styles.orderCardPast : null]}
      testID={`ticket-order-${order.id}`}
    >
      <View style={styles.orderHeader}>
        <Text style={styles.eventName} numberOfLines={2}>
          {order.eventName}
        </Text>
        <StatusBadge label={status.label} tone={status.tone} />
      </View>

      <View style={styles.metaGroup}>
        <OrderMetaRow
          icon={Calendar}
          label={formatTicketOrderDateTime(order.eventStartsAt)}
        />
        {order.eventVenue ? (
          <OrderMetaRow icon={MapPin} label={order.eventVenue} />
        ) : null}
        <OrderMetaRow
          icon={Ticket}
          label={formatTicketCount(order.ticketCount)}
        />
      </View>

      <View style={styles.purchaseRow}>
        <View style={styles.purchaseLabelRow}>
          <Receipt size={15} color={colors.colorMuted} />
          <Text style={styles.purchaseLabel}>Subtotal</Text>
        </View>
        <Text style={styles.amountText}>
          {formatTicketOrderCurrency(order.amountGrossCents, order.currency)}
        </Text>
      </View>

      <View style={styles.ticketDetailsGroup}>
        <Text style={styles.ticketDetailsTitle}>Ticket codes</Text>
        <TicketDetails
          order={order}
          tickets={tickets}
          ticketsLoading={ticketsLoading}
          ticketsErrorMessage={ticketsErrorMessage}
          onRetryTickets={onRetryTickets}
        />
      </View>
    </View>
  );
};

/**
 * Local, not from `@th/ui-native`: the package deliberately ships no
 * `LoadingState`, since the scanner's loading affordances are camera-overlay
 * scrims rather than a list placeholder.
 */
const LoadingState = () => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <View style={styles.stateContainer} testID="ticket-orders-loading">
      <ActivityIndicator color={colors.color} />
      <Text style={styles.stateText}>Loading tickets</Text>
    </View>
  );
};

const ErrorState = ({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) => {
  const styles = useThemedSheet(makeSheet);
  return (
    <View style={styles.stateContainer} testID="ticket-orders-error">
      <SquareCard tone="danger" accessibilityRole="alert">
        <StatusBadge label="Unable to load" tone="danger" />
        <Text style={styles.stateTitle}>Couldn&apos;t load tickets.</Text>
        <Text style={styles.stateText}>{message}</Text>
        <SquareSecondaryButton
          label="Try again"
          onPress={onRetry}
          accessibilityHint="Reloads your ticket orders."
        />
      </SquareCard>
    </View>
  );
};

const EmptyState = ({ title, body }: { title: string; body: string }) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <View style={styles.stateContainer} testID="ticket-orders-empty">
      <SquareCard muted>
        <View style={styles.emptyIconBox}>
          <Search size={28} color={colors.colorMuted} />
        </View>
        <Text style={styles.stateTitle}>{title}</Text>
        <Text style={styles.stateText}>{body}</Text>
      </SquareCard>
    </View>
  );
};

export const TicketOrdersList = ({
  ListHeaderComponent,
  emptyTitle = "No tickets yet",
  emptyBody = "Tickets you buy through Ithas Fire will appear here.",
  testID = "ticket-orders-list",
  onSelectOrder,
}: TicketOrdersListProps) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const query = trpc.orders.listMyOrders.useQuery(
    { limit: 50 },
    { staleTime: 30_000 },
  );

  const orders = (query.data?.items ?? []) as TicketOrder[];
  const ticketQueries = trpc.useQueries((t) =>
    orders.map((order) =>
      t.orders.listMyOrderTickets(
        { orderId: order.id },
        { enabled: query.isSuccess, staleTime: 30_000 },
      ),
    ),
  );
  const ticketCount = orders.reduce(
    (total: number, order: TicketOrder) => total + order.ticketCount,
    0,
  );
  const isRefreshing =
    (query.isFetching && !query.isLoading) ||
    ticketQueries.some(
      (ticketQuery) => ticketQuery.isFetching && !ticketQuery.isLoading,
    );

  const handleRefresh = useCallback(() => {
    void Promise.all([
      query.refetch(),
      ...ticketQueries.map((ticketQuery) => ticketQuery.refetch()),
    ]);
  }, [query, ticketQueries]);

  const renderHeader = useCallback(
    () => (
      <>
        {ListHeaderComponent}
        {orders.length > 0 ? (
          <View style={styles.summaryRow}>
            <Text style={styles.summaryText}>
              {formatTicketCount(ticketCount)} across {orders.length}{" "}
              {orders.length === 1 ? "order" : "orders"}
            </Text>
          </View>
        ) : null}
      </>
    ),
    // `styles` is memoised per theme by `useThemedSheet`'s WeakMap cache, so
    // it only changes identity on a theme flip — which is exactly when this
    // header does need to re-render.
    [ListHeaderComponent, orders.length, styles, ticketCount],
  );

  const renderEmpty = useCallback(() => {
    if (query.isLoading) return <LoadingState />;
    if (query.isError) {
      return (
        <ErrorState
          message={query.error.message}
          onRetry={() => void query.refetch()}
        />
      );
    }
    return <EmptyState title={emptyTitle} body={emptyBody} />;
  }, [emptyBody, emptyTitle, query]);

  return (
    <FlatList<TicketOrder>
      testID={testID}
      data={query.isError ? [] : orders}
      keyExtractor={(order) => order.id}
      renderItem={({ item, index }) => {
        const ticketQuery = ticketQueries[index];
        const card = (
          <TicketOrderCard
            order={item}
            tickets={ticketQuery?.data?.tickets ?? []}
            ticketsLoading={!ticketQuery || ticketQuery.isLoading}
            ticketsErrorMessage={
              ticketQuery?.isError === true
                ? ticketQuery.error.message || "Couldn't load ticket details."
                : null
            }
            onRetryTickets={() => {
              void ticketQuery?.refetch();
            }}
          />
        );

        return (
          <View style={styles.itemPadding}>
            {onSelectOrder ? (
              <Pressable
                onPress={() => onSelectOrder(item)}
                accessibilityRole="button"
                accessibilityLabel={`${item.eventName}, ${formatTicketCount(item.ticketCount)}`}
                accessibilityHint="Opens the order and its scannable passes."
                testID={`ticket-order-open-${item.id}`}
                style={({ pressed }) => (pressed ? styles.cardPressed : null)}
              >
                {card}
              </Pressable>
            ) : (
              card
            )}
          </View>
        );
      }}
      ListHeaderComponent={renderHeader}
      ListEmptyComponent={renderEmpty}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={handleRefresh}
          tintColor={colors.color}
        />
      }
      contentContainerStyle={styles.content}
    />
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    content: {
      flexGrow: 1,
      paddingBottom: 28,
    },
    itemPadding: {
      paddingHorizontal: 20,
    },
    separator: { height: 12 },
    // Press feedback lives on the wrapper, not the card, so the card's own
    // border/fill treatment (including the muted past-order variant) survives.
    cardPressed: { opacity: 0.7 },
    summaryRow: {
      marginHorizontal: 20,
      marginBottom: 12,
      paddingTop: 12,
      borderTopWidth: 2,
      borderTopColor: c.borderColor,
    },
    summaryText: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 12,
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    orderCard: {
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surface,
      padding: 16,
      gap: 14,
    },
    // Past orders recede: inset fill + hairline edge instead of the 2px rule.
    orderCardPast: {
      backgroundColor: c.surfaceMuted,
      borderColor: c.borderColorSoft,
    },
    orderHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
    },
    eventName: {
      flex: 1,
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 16,
      fontWeight: "700",
      lineHeight: 21,
    },
    metaGroup: { gap: 8 },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    metaText: {
      flex: 1,
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 13,
      lineHeight: 18,
    },
    purchaseRow: {
      borderTopWidth: 1,
      borderTopColor: c.borderColorSoft,
      paddingTop: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    purchaseLabelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    purchaseLabel: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      fontWeight: "500",
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    amountText: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 15,
      fontWeight: "700",
    },
    ticketDetailsGroup: {
      borderTopWidth: 1,
      borderTopColor: c.borderColorSoft,
      paddingTop: 12,
      gap: 10,
    },
    ticketDetailsTitle: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      fontWeight: "500",
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    ticketRows: { gap: 10 },
    ticketRow: {
      borderTopWidth: 1,
      borderTopColor: c.borderColorSoft,
      paddingTop: 10,
      gap: 7,
    },
    ticketRowHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 10,
    },
    ticketLabel: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      fontWeight: "500",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    ticketCode: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 14,
      fontWeight: "700",
      lineHeight: 19,
    },
    ticketSubtext: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 12,
      lineHeight: 17,
    },
    ticketStateRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    ticketErrorBox: {
      borderTopWidth: 1,
      borderTopColor: c.borderColorSoft,
      paddingTop: 10,
      gap: 10,
    },
    ticketStateText: {
      flex: 1,
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 13,
      lineHeight: 18,
    },
    stateContainer: {
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 20,
      paddingVertical: 28,
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
    emptyIconBox: {
      width: 56,
      height: 56,
      borderWidth: 2,
      borderColor: c.borderColor,
      alignItems: "center",
      justifyContent: "center",
    },
  });
