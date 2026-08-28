import { useCallback, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import { TicketOrdersList } from "@/features/tickets/TicketOrdersList";
import { pruneExpiredOrderTickets } from "@/features/tickets/ticket-cache";
import { ScreenHeading, ScreenSurface, SectionNum } from "@/ui/primitives";
import type { TicketsStackParamList } from "@/navigation/types";

type Props = NativeStackScreenProps<TicketsStackParamList, "TicketsList">;

export const TicketsScreen = ({ navigation }: Props) => {
  // Drop cached codes for shows that are over. Runs on mount of the tickets
  // tab — frequent enough to keep the keychain tidy, and the one moment the
  // user is demonstrably thinking about tickets. Fire-and-forget: it must
  // never delay the list.
  useEffect(() => {
    void pruneExpiredOrderTickets();
  }, []);

  const handleSelectOrder = useCallback(
    (order: { id: string; eventName: string }) => {
      navigation.navigate("OrderDetail", {
        orderId: order.id,
        eventName: order.eventName,
      });
    },
    [navigation],
  );

  return (
    <ScreenSurface testID="tickets-screen">
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <TicketOrdersList
          onSelectOrder={handleSelectOrder}
          ListHeaderComponent={
            <View style={styles.header}>
              <SectionNum index="03" label="Owned" />
              <ScreenHeading>My Tickets</ScreenHeading>
            </View>
          }
          emptyTitle="No tickets yet"
          emptyBody="Tickets you buy through Ithas Fire will appear here for at-gate scanning."
        />
      </SafeAreaView>
    </ScreenSurface>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 4,
  },
});
