import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
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
import * as WebBrowser from "expo-web-browser";
import { Calendar, MapPin } from "lucide-react-native";

import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";

import { getWebBaseUrl } from "@/config/api";
import { EventBodyRenderer } from "@/features/events/EventBodyRenderer";
import { EventCheckoutCta } from "@/features/events/EventCheckoutCta";
import { EventGatedView } from "@/features/events/EventGatedView";
import { EventPasswordSheet } from "@/features/events/EventPasswordSheet";
import { EventTicketTypeList } from "@/features/events/EventTicketTypeList";
import { useEventDetail, type EventSeo } from "@/features/events/use-event-detail";
import { formatTicketOrderDateTime } from "@/features/tickets/ticket-format";
import type { DiscoverStackParamList } from "@/navigation/types";
import { ScreenHeading, ScreenSurface, SectionNum } from "@/ui/primitives";

type EventDetailRoute = RouteProp<DiscoverStackParamList, "EventDetail">;
type EventDetailNav = NativeStackNavigationProp<
  DiscoverStackParamList,
  "EventDetail"
>;

const venueLabel = (location: EventSeo["location"]): string | null => {
  if (!location) return null;
  const cityRegion = [location.city, location.region]
    .filter(Boolean)
    .join(", ");
  const parts = [location.name, cityRegion].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
};

const CenteredState = ({ children }: { children: React.ReactNode }) => {
  const styles = useThemedSheet(makeSheet);
  return <View style={styles.center}>{children}</View>;
};

export const EventDetailScreen = () => {
  const route = useRoute<EventDetailRoute>();
  const navigation = useNavigation<EventDetailNav>();
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const { eventSlug } = route.params;

  const detail = useEventDetail(eventSlug);
  const [passwordSheetVisible, setPasswordSheetVisible] = useState(false);

  // Replace the initial nav header title (route param or URL-slug fallback)
  // with the canonical title once it loads.
  const headerTitle = detail.seo?.title ?? detail.gatedPreview?.title;
  useEffect(() => {
    if (headerTitle) navigation.setOptions({ title: headerTitle });
  }, [headerTitle, navigation]);

  const openWebCheckout = useCallback(() => {
    const slug = detail.currentSlug ?? eventSlug;
    void WebBrowser.openBrowserAsync(
      `${getWebBaseUrl()}/events/checkout/${slug}`,
    );
  }, [detail.currentSlug, eventSlug]);

  const handleGetTickets = useCallback(() => {
    // eventId/currentSlug are resolved before the native CTA can render
    // (checkoutPath requires gate + ticket-type data) — guard anyway.
    if (!detail.eventId) return;
    navigation.navigate("Checkout", {
      eventId: detail.eventId,
      eventSlug: detail.currentSlug ?? eventSlug,
      title: detail.seo?.title,
    });
  }, [detail.currentSlug, detail.eventId, detail.seo?.title, eventSlug, navigation]);

  const openPasswordSheet = useCallback(() => {
    setPasswordSheetVisible(true);
  }, []);

  if (detail.status === "loading") {
    return (
      <ScreenSurface testID="event-detail-loading">
        <SafeAreaView style={styles.safe}>
          <CenteredState>
            <ActivityIndicator color={colors.color} />
          </CenteredState>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  if (detail.status === "error") {
    return (
      <ScreenSurface testID="event-detail-error">
        <SafeAreaView style={styles.safe}>
          <CenteredState>
            <Text style={styles.errorText}>Couldn&apos;t load this event.</Text>
            <Pressable onPress={detail.refresh}>
              <Text style={styles.linkText}>Try again</Text>
            </Pressable>
          </CenteredState>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  const refreshControl = (
    <RefreshControl
      refreshing={detail.isRefreshing}
      onRefresh={detail.refresh}
      tintColor={colors.color}
    />
  );

  if (detail.status === "locked") {
    return (
      <ScreenSurface testID="event-detail-locked">
        <SafeAreaView style={styles.safe}>
          <ScrollView
            contentContainerStyle={[
              styles.scroll,
              !detail.gatedPreview && styles.scrollFill,
            ]}
            refreshControl={refreshControl}
          >
            {detail.gatedPreview ? (
              <EventGatedView
                preview={detail.gatedPreview}
                path={detail.checkoutPath}
                onEnterPassword={openPasswordSheet}
                onOpenWebCheckout={openWebCheckout}
              />
            ) : (
              <CenteredState>
                <ActivityIndicator color={colors.color} />
              </CenteredState>
            )}
          </ScrollView>
          {detail.eventId ? (
            <EventPasswordSheet
              eventId={detail.eventId}
              visible={passwordSheetVisible}
              onClose={() => setPasswordSheetVisible(false)}
            />
          ) : null}
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  const seo = detail.seo;
  if (!seo) return null; // unreachable — "ready" implies seo loaded
  const heroImageUrl = seo.images?.[0] ?? null;
  const venue = venueLabel(seo.location);
  const currency = seo.pricing?.currency ?? "USD";
  const sellability = detail.ticketTypes?.sellability;

  return (
    <ScreenSurface testID="event-detail-screen">
      <SafeAreaView style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={refreshControl}
        >
          {heroImageUrl ? (
            <Image
              source={{ uri: heroImageUrl }}
              accessibilityLabel={`${seo.title} hero image`}
              style={styles.hero}
              resizeMode="cover"
            />
          ) : null}

          <View style={styles.header}>
            <SectionNum index="02" label="Event" />
            <ScreenHeading>{seo.title}</ScreenHeading>
            <View style={styles.metaGroup}>
              <View style={styles.metaRow}>
                <Calendar size={15} color={colors.colorMuted} />
                <Text style={styles.metaText}>
                  {formatTicketOrderDateTime(seo.startsAt, {
                    timeZone: seo.timezone ?? undefined,
                  })}
                </Text>
              </View>
              {venue ? (
                <View style={styles.metaRow}>
                  <MapPin size={15} color={colors.colorMuted} />
                  <Text style={styles.metaText}>{venue}</Text>
                </View>
              ) : null}
            </View>
          </View>

          {detail.body?.body != null ? (
            <EventBodyRenderer
              body={detail.body.body}
              imageMap={detail.body.imageMap}
            />
          ) : null}

          <View style={styles.section}>
            <SectionNum index="03" label="Tickets" />
            {detail.ticketTypesPending ? (
              <View style={styles.ticketsLoadingRow}>
                <ActivityIndicator size="small" color={colors.colorMuted} />
                <Text style={styles.ticketsLoadingText}>
                  Loading tickets...
                </Text>
              </View>
            ) : (
              <EventTicketTypeList
                ticketTypes={detail.ticketTypes?.ticketTypes ?? []}
                currency={currency}
                loadFailed={detail.ticketTypesFailed}
              />
            )}
            <EventCheckoutCta
              path={detail.checkoutPath}
              sellabilityReason={
                sellability && !sellability.available
                  ? sellability.reason
                  : null
              }
              onGetTickets={handleGetTickets}
              onEnterPassword={openPasswordSheet}
              onOpenWebCheckout={openWebCheckout}
            />
          </View>
        </ScrollView>
        {detail.eventId ? (
          <EventPasswordSheet
            eventId={detail.eventId}
            visible={passwordSheetVisible}
            onClose={() => setPasswordSheetVisible(false)}
          />
        ) : null}
      </SafeAreaView>
    </ScreenSurface>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    safe: { flex: 1 },
    scroll: { padding: 20, gap: 20, paddingBottom: 32 },
    scrollFill: { flexGrow: 1 },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      gap: 12,
    },
    hero: {
      width: "100%",
      aspectRatio: 16 / 9,
      backgroundColor: c.surfaceMuted,
    },
    header: { gap: 8 },
    metaGroup: { gap: 6, marginTop: 4 },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    metaText: {
      flex: 1,
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 19,
    },
    section: { gap: 12 },
    // Failure copy → `dangerSoft`; the `danger` fill is only ~4.0:1 as text.
    errorText: {
      color: c.dangerSoft,
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
    ticketsLoadingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    ticketsLoadingText: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 20,
    },
  });
