import { useCallback, useEffect } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import {
  SquarePrimaryButton,
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { PromoCodeInput } from "@/features/checkout/PromoCodeInput";
import { TicketTypePicker } from "@/features/checkout/TicketTypePicker";
import { useCheckoutState } from "@/features/checkout/use-checkout-state";
import {
  formatTicketCount,
  formatTicketOrderCurrency,
} from "@/features/tickets/ticket-format";
import { trpc } from "@/lib/trpc";
import type { DiscoverStackParamList } from "@/navigation/types";
import { ScreenSurface, SectionNum } from "@/ui/primitives";

type CheckoutRoute = RouteProp<DiscoverStackParamList, "Checkout">;
type CheckoutNav = NativeStackNavigationProp<
  DiscoverStackParamList,
  "Checkout"
>;

const EMPTY_TICKET_TYPES: never[] = [];

const CenteredState = ({ children }: { children: React.ReactNode }) => {
  const styles = useThemedSheet(makeSheet);
  return <View style={styles.center}>{children}</View>;
};

/**
 * GA ticket selection (FR-003): quantity steppers, adjustable amounts, and
 * promo codes. Payment (createCheckout → Payment Sheet) is Step 4 — the
 * "Continue to payment" CTA is intentionally stubbed.
 */
export const CheckoutScreen = () => {
  const route = useRoute<CheckoutRoute>();
  const navigation = useNavigation<CheckoutNav>();
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const { eventId, eventSlug } = route.params;

  // Fresh availability on entry — the detail screen's cache may be stale,
  // so override the client-wide 30s staleTime and refetch on every mount.
  const ticketTypesQuery = trpc.events.listEventTicketTypes.useQuery(
    { eventId },
    { staleTime: 0, refetchOnMount: "always" },
  );
  // Currency + canonical title only — fine to share the detail screen's cache.
  const seoQuery = trpc.events.getEventSeo.useQuery({ slug: eventSlug });

  const headerTitle = seoQuery.data?.title;
  useEffect(() => {
    if (headerTitle) navigation.setOptions({ title: headerTitle });
  }, [headerTitle, navigation]);

  const ticketTypes = ticketTypesQuery.data?.ticketTypes ?? EMPTY_TICKET_TYPES;
  const checkout = useCheckoutState(ticketTypes);

  const refresh = useCallback(() => {
    void Promise.all([ticketTypesQuery.refetch(), seoQuery.refetch()]);
  }, [seoQuery, ticketTypesQuery]);

  const handleContinue = useCallback(() => {
    // TODO(mobile-ga-checkout step 4): orders.createCheckout with
    // checkout.clientKey + checkout.checkoutItems + checkout.promoCodes,
    // then present the Stripe Payment Sheet.
  }, []);

  if (ticketTypesQuery.isPending || (seoQuery.isPending && !seoQuery.data)) {
    return (
      <ScreenSurface testID="checkout-loading">
        <SafeAreaView style={styles.safe}>
          <CenteredState>
            <ActivityIndicator color={colors.color} />
          </CenteredState>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  if (ticketTypesQuery.isError || seoQuery.isError) {
    return (
      <ScreenSurface testID="checkout-error">
        <SafeAreaView style={styles.safe}>
          <CenteredState>
            <Text style={styles.errorText}>Couldn&apos;t load checkout.</Text>
            <Pressable onPress={refresh} accessibilityRole="button">
              <Text style={styles.linkText}>Try again</Text>
            </Pressable>
          </CenteredState>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  const data = ticketTypesQuery.data;
  // Race guard: the event may have changed since the detail screen resolved
  // the native path — reserved seating or a sales-closing flip means this
  // screen can no longer serve the purchase.
  if (!data || data.placeLayoutId !== null || !data.sellability.available) {
    return (
      <ScreenSurface testID="checkout-unavailable">
        <SafeAreaView style={styles.safe}>
          <CenteredState>
            <Text style={styles.errorText}>
              {data && data.placeLayoutId !== null
                ? "This event now uses reserved seating, which isn't available in the app yet."
                : "Tickets for this event aren't available right now."}
            </Text>
            <SquareSecondaryButton
              label="Back to event"
              onPress={() => navigation.goBack()}
              accessibilityHint="Returns to the event details."
              testID="checkout-back-to-event"
            />
          </CenteredState>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  const currency = seoQuery.data?.pricing?.currency ?? "USD";
  const isRefreshing =
    (ticketTypesQuery.isFetching || seoQuery.isFetching) &&
    !ticketTypesQuery.isPending;

  return (
    <ScreenSurface testID="checkout-screen">
      <SafeAreaView style={styles.safe} edges={["bottom", "left", "right"]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.safe}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={refresh}
                tintColor={colors.color}
              />
            }
          >
            <View style={styles.section}>
              <SectionNum index="01" label="Tickets" />
              <TicketTypePicker
                ticketTypes={ticketTypes}
                currency={currency}
                items={checkout.items}
                // FR-010: sale windows render on the EVENT's clock, not the
                // phone's. Already in hand from the SEO query above.
                timezone={seoQuery.data?.timezone}
                onIncrement={checkout.incrementQty}
                onDecrement={checkout.decrementQty}
                onDonationChange={checkout.setDonationCents}
              />
            </View>
            <View style={styles.section}>
              <SectionNum index="02" label="Promo code" />
              <PromoCodeInput
                codes={checkout.promoCodes}
                onAdd={checkout.addPromo}
                onRemove={checkout.removePromo}
              />
            </View>
          </ScrollView>

          <View style={styles.summaryBand} testID="checkout-summary">
            <View style={styles.summaryRow}>
              <Text style={styles.summaryQty}>
                {formatTicketCount(checkout.totalQty)}
              </Text>
              <Text style={styles.summaryAmount}>
                {formatTicketOrderCurrency(
                  checkout.estimatedSubtotalCents,
                  currency,
                )}
              </Text>
            </View>
            <Text style={styles.summaryNote}>
              Estimated subtotal — fees, tax, and discounts are calculated at
              payment.
            </Text>
            <SquarePrimaryButton
              label="Continue to payment"
              onPress={handleContinue}
              disabled={!checkout.hasSelection}
              accessibilityHint="Continues to billing and payment."
              testID="checkout-continue"
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ScreenSurface>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    safe: { flex: 1 },
    scroll: { padding: 20, gap: 24, paddingBottom: 32 },
    section: { gap: 12 },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      gap: 16,
    },
    // Not a hard failure — these read as "unavailable" copy, so they stay on
    // the muted rung rather than taking a danger tone.
    errorText: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
    },
    linkText: {
      color: c.accentText,
      fontFamily: "Montserrat-Medium",
      fontSize: 14,
      textDecorationLine: "underline",
    },
    summaryBand: {
      borderTopWidth: 2,
      borderTopColor: c.borderColor,
      backgroundColor: c.background,
      padding: 20,
      gap: 10,
    },
    summaryRow: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 12,
    },
    summaryQty: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 14,
      letterSpacing: 0.5,
    },
    summaryAmount: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 20,
      fontWeight: "700",
      fontVariant: ["tabular-nums"],
    },
    summaryNote: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 13,
      lineHeight: 18,
    },
  });
