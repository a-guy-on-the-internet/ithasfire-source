/**
 * The no-tip line under the Sell screen (FR-014).
 *
 * The summary used to end "The posted price is the price paid." That stopped
 * being true when the door began charging what online checkout charges: the
 * posted ticket price is the face, and the card total adds the platform fee,
 * processing fee and tax. Board S2 (owner pick) draws the line as "No tips
 * are collected." alone.
 *
 * `POS_NO_TIP_DISCLOSURE` is FR-014's locked copy. Do not inline-edit it.
 * Revised by owner ruling 2026-10-08: it said "The price you see is the price
 * you pay", which stopped being true once the door showed fees and tax on
 * top of the ticket price. It now says "The total on screen is the total you
 * pay".
 */
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "@th/ui";
import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";

/** FR-014 locked anti-tipping copy, shown under "More info". */
export const POS_NO_TIP_DISCLOSURE =
  "We don't tip. Tipping is a mechanism for the rich to avoid paying their workers a living wage. The total on screen is the total you pay; our staff are paid by us, not you.";

const POS_NO_TIP_SUMMARY = "No tips are collected.";

export function NoTipDisclosure({ testID }: { testID?: string }) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.disclosure} testID={testID}>
      <Text variant="caption" color={colors.colorMuted} style={styles.text}>
        {expanded ? POS_NO_TIP_DISCLOSURE : POS_NO_TIP_SUMMARY}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={
          expanded ? "Less info about tipping" : "More info about tipping"
        }
        onPress={() => setExpanded((value) => !value)}
        style={styles.toggle}
      >
        <Text variant="caption" weight="bold" color={colors.color}>
          {expanded ? "Less" : "More info"}
        </Text>
      </Pressable>
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    disclosure: { marginTop: 8, gap: 8 },
    text: { lineHeight: 18 },
    toggle: {
      alignSelf: "flex-start",
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderWidth: 2,
      borderColor: colors.borderColor,
      justifyContent: "center",
    },
  });
