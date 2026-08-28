import { useCallback } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { DiscoverStackParamList } from "@/navigation/types";
import { ScreenHeading, ScreenSurface, SectionNum } from "@/ui/primitives";

type DiscoverNav = NativeStackNavigationProp<
  DiscoverStackParamList,
  "DiscoverList"
>;
type EventSummary = RouterOutputs["events"]["discoverPublic"]["events"][number];

const EventRow = ({
  event,
  onPress,
}: {
  event: EventSummary;
  onPress: () => void;
}) => {
  const styles = useThemedSheet(makeSheet);
  return (
    <Pressable
      style={({ pressed }) => [styles.listRow, pressed && styles.listRowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={event.title}
    >
      <View style={styles.dateCell}>
        <Text style={styles.dateText} numberOfLines={2}>
          {event.date || "TBA"}
        </Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {event.title}
        </Text>
        <View style={styles.metaRow}>
          {event.venue ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {event.venue}
            </Text>
          ) : null}
          {event.priceLabel ? (
            <Text style={styles.price}>{event.priceLabel}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
};

export const DiscoverScreen = () => {
  const navigation = useNavigation<DiscoverNav>();
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);

  const query = trpc.events.discoverPublic.useQuery({}, { staleTime: 60_000 });

  const handleRefresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  const handlePress = useCallback(
    (event: EventSummary) => {
      navigation.navigate("EventDetail", {
        eventSlug: event.slug ?? event.id,
        eventId: event.id,
        title: event.title,
      });
    },
    [navigation],
  );

  if (query.isLoading) {
    return (
      <ScreenSurface testID="discover-loading">
        <SafeAreaView style={styles.safe} edges={["top"]}>
          <View style={styles.center}>
            <ActivityIndicator color={colors.color} />
          </View>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  if (query.isError) {
    return (
      <ScreenSurface testID="discover-error">
        <SafeAreaView style={styles.safe} edges={["top"]}>
          <View style={styles.center}>
            <Text style={styles.errorText}>Couldn&apos;t load events.</Text>
            <Pressable onPress={handleRefresh}>
              <Text style={styles.linkText}>Try again</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  const events = query.data?.events ?? [];

  return (
    <ScreenSurface testID="discover-screen">
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.header}>
          <SectionNum index="01" label="Upcoming" />
          <ScreenHeading>Discover</ScreenHeading>
        </View>
        <FlatList<EventSummary>
          data={events}
          keyExtractor={(e) => e.id}
          renderItem={({ item }) => (
            <EventRow event={item} onPress={() => handlePress(item)} />
          )}
          // Note: swap to FlashList once @shopify/flash-list v2's generic
          // typing stabilises. FlatList is fine for the v1 event volume
          // (low hundreds at most across regions).
          refreshControl={
            <RefreshControl
              refreshing={query.isFetching && !query.isLoading}
              onRefresh={handleRefresh}
              tintColor={colors.color}
            />
          }
          ListEmptyComponent={() => (
            <View style={styles.center}>
              <Text style={styles.emptyText}>No upcoming events.</Text>
            </View>
          )}
        />
      </SafeAreaView>
    </ScreenSurface>
  );
};

/**
 * Colour-bearing sheet → factory + `useThemedSheet`, per the package's
 * documented rule. `listRow` / `listRowPressed` moved here from the app's
 * deleted shared stylesheet: the Discover feed is their only consumer, so they
 * never belonged in a shared sheet (and `@th/ui-native` correctly omits them).
 */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    safe: { flex: 1 },
    header: {
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 16,
      gap: 4,
    },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      gap: 12,
    },
    listRow: {
      flexDirection: "row",
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 12,
      minHeight: 70,
      backgroundColor: c.surface,
      borderTopWidth: 0,
      borderBottomWidth: 1,
      borderBottomColor: c.borderColorSoft,
    },
    listRowPressed: {
      backgroundColor: c.surfaceMuted,
    },
    // Border is a 2px GRAPHIC (clears the 3:1 non-text floor at the raw
    // accent); the digits inside it are TEXT and take `accentText`.
    dateCell: {
      width: 76,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 8,
      paddingHorizontal: 6,
      borderWidth: 2,
      borderColor: c.accent,
    },
    dateText: {
      fontFamily: "Montserrat-SemiBold",
      fontSize: 12,
      color: c.accentText,
      fontWeight: "700",
      letterSpacing: 0.5,
      textTransform: "uppercase",
      textAlign: "center",
      lineHeight: 14,
    },
    body: { flex: 1, gap: 4, justifyContent: "center" },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    },
    title: {
      fontFamily: "Montserrat-SemiBold",
      fontSize: 16,
      color: c.color,
      fontWeight: "700",
    },
    subtitle: {
      fontFamily: "Montserrat",
      fontSize: 13,
      color: c.colorMuted,
      flex: 1,
    },
    price: {
      fontFamily: "Montserrat-SemiBold",
      fontSize: 13,
      color: c.color,
      fontWeight: "700",
    },
    // Failure copy → `dangerSoft`; the `danger` fill is only ~4.0:1 as text.
    errorText: { color: c.dangerSoft, fontFamily: "Montserrat", fontSize: 14 },
    emptyText: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
    },
    linkText: {
      color: c.accentText,
      fontFamily: "Montserrat-Medium",
      fontSize: 14,
      textDecorationLine: "underline",
    },
  });
