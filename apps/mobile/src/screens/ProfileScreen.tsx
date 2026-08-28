import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@th/ui-native";

import { useAuthSession } from "@/features/auth/use-auth-session";
import { TicketOrdersList } from "@/features/tickets/TicketOrdersList";
import { ScreenHeading, ScreenSurface, SectionNum } from "@/ui/primitives";

export const ProfileScreen = () => {
  const { user } = useAuthSession();
  const colors = useColors();
  const displayName = user?.name?.trim() || "Profile";

  return (
    <ScreenSurface testID="profile-screen">
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <TicketOrdersList
          ListHeaderComponent={
            <View style={styles.header}>
              <SectionNum index="04" label="You" />
              <ScreenHeading>{displayName}</ScreenHeading>
              {user?.email ? (
                <Text style={[styles.email, { color: colors.colorMuted }]}>
                  {user.email}
                </Text>
              ) : null}
              <Text style={[styles.subtitle, { color: colors.colorMuted }]}>
                Your purchased tickets and orders
              </Text>
            </View>
          }
          emptyTitle="No tickets yet"
          emptyBody="Your purchased tickets will appear here after checkout."
          testID="profile-ticket-orders-list"
        />
      </SafeAreaView>
    </ScreenSurface>
  );
};

/**
 * Two themed values only, so this stays a plain geometry sheet and the colour
 * is applied inline from `useColors()` — the package's documented cut-off for
 * wrapping a sheet in a `useThemedSheet` factory.
 */
const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 4,
  },
  email: {
    fontFamily: "Montserrat",
    fontSize: 14,
    marginTop: 4,
  },
  subtitle: {
    fontFamily: "Montserrat",
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
});
