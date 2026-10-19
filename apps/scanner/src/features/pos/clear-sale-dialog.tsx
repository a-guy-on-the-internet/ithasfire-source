/**
 * "Clear this sale?": asked before a tab press, an event switch or Android's
 * back would drop a sale the till must not lose (see `sale-guard.ts`). Same
 * buttons as the web till: Keep it / Clear it anyway. Android back while it
 * is up means Keep it (`useSaleGuardHost`).
 *
 * On open it is announced and takes screen-reader focus, so a VoiceOver or
 * TalkBack user isn't left on the tab they just pressed.
 *
 * An overlay View, not a `<Modal>`: the event chip's picker is itself a
 * Modal that is still closing when this opens, and iOS won't present a second
 * Modal while the first is dismissing.
 */
import { useEffect, useRef } from "react";
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  View,
  findNodeHandle,
} from "react-native";

import { Text } from "@th/ui";
import {
  SquarePrimaryButton,
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import type { LeaveRisk } from "./sale-attempt";

const WHY: Record<LeaveRisk, string> = {
  // Clearing fires a best-effort cancel (`clearForLeave` in use-door-sale.ts),
  // which the server refuses if the card went through.
  card: "A card sale is open. Clearing asks the server to cancel it, but if the card went through, that sale stands. Don't take cash for these tickets.",
  sending:
    "This sale is still being sent. Clearing now doesn't stop it: it may be recorded without you seeing it.",
  unresolved:
    "The last attempt may already be recorded. Clearing doesn't undo it, and ringing these tickets up again would sell them twice.",
};

export function ClearSaleDialog({
  risk,
  onKeep,
  onClear,
}: {
  risk: LeaveRisk;
  onKeep: () => void;
  onClear: () => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const titleRef = useRef<View>(null);
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility("Clear this sale?");
    // react-native-web has no node handles; the announcement covers it.
    if (Platform.OS === "web") return;
    const tag = titleRef.current ? findNodeHandle(titleRef.current) : null;
    if (tag !== null) AccessibilityInfo.setAccessibilityFocus(tag);
  }, []);
  return (
    <View
      style={[StyleSheet.absoluteFill, styles.scrim]}
      accessibilityViewIsModal
      testID="sell-leave-confirm"
    >
      <View style={styles.sheet} accessibilityLiveRegion="polite">
        <View ref={titleRef} accessible accessibilityRole="header">
          <Text variant="body" weight="bold" color={colors.color}>
            Clear this sale?
          </Text>
        </View>
        <Text variant="bodySmall" color={colors.color} style={styles.body}>
          {WHY[risk]}
        </Text>
        <SquarePrimaryButton
          testID="sell-leave-keep"
          label="Keep it"
          onPress={onKeep}
        />
        <SquareSecondaryButton
          testID="sell-leave-clear"
          label="Clear it anyway"
          onPress={onClear}
        />
      </View>
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    scrim: {
      backgroundColor: colors.modalScrim,
      justifyContent: "center",
      padding: 20,
    },
    sheet: {
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.background,
      padding: 20,
      gap: 12,
    },
    body: { lineHeight: 20 },
  });
