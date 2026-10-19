/**
 * Done (board D1). Paid, minted, admitted.
 *
 * "Comp" means only the Comp action. A sale a promo code took to $0 shows
 * "$0.00 · Free with CODE", counted as a sale. Change due is the server's
 * figure (`recordCashSale.changeCents`), never the sheet's own sum.
 *
 * "Next sale" is the primary action: there is a queue, and this screen's job
 * is to get out of the way.
 */
import { Text as RNText, StyleSheet, View } from "react-native";

import { formatOrderCode } from "@th/types";
import { Text } from "@th/ui";
import {
  SquarePrimaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { monoLabel } from "../../ui/mono-label";

import { describeDoneSale, type DoneSale } from "./cash-tender";
import { formatMoney } from "./sell-quote";

export function SaleDoneView({
  sale,
  currency,
  onNext,
}: {
  sale: DoneSale;
  currency: string;
  onNext: () => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const words = describeDoneSale(sale, currency);

  return (
    <View style={styles.root} testID="sell-done">
      <Text
        style={styles.headline}
        testID="sell-done-headline"
        accessibilityRole="header"
      >
        {words.headline}
      </Text>
      <Text
        variant="body"
        weight="bold"
        color={colors.color}
        style={styles.center}
        testID="sell-done-summary"
      >
        {words.summary}
      </Text>
      <Text
        variant="body"
        color={sale.autoAdmitted ? colors.success : colors.colorMuted}
        style={styles.center}
      >
        {words.admitted}
      </Text>

      {words.giveBack !== null && (
        <View
          style={styles.giveBack}
          testID="sell-done-give-back"
          accessible
          accessibilityLabel={words.giveBack}
        >
          {/* "Change": the cash sheet's word for the same figure. */}
          <RNText style={styles.monoLabel}>Change</RNText>
          <Text style={styles.giveBackAmount}>
            {formatMoney(sale.changeCents, currency)}
          </Text>
        </View>
      )}

      {sale.seatLabels.length > 0 && (
        <View style={styles.seatBlock} testID="sell-result-seats">
          <RNText style={styles.monoLabel}>Seats</RNText>
          <View style={styles.seatRow}>
            {sale.seatLabels.map((label) => (
              <View key={label} style={styles.seatTag}>
                <Text variant="body" weight="bold" style={styles.seatTagText}>
                  {label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {words.footnote !== null && (
        <Text variant="bodySmall" color={colors.colorMuted} style={styles.center}>
          {words.footnote}
        </Text>
      )}
      {words.receipt !== null && (
        <Text
          variant="bodySmall"
          color={colors.colorMuted}
          style={styles.center}
          testID="sell-done-receipt"
        >
          {words.receipt}
        </Text>
      )}

      <Text variant="caption" color={colors.colorMuted}>
        Order #{formatOrderCode(sale.orderId)}
      </Text>

      <View style={styles.cta}>
        <SquarePrimaryButton
          testID="sell-result-next"
          label="Next sale"
          onPress={onNext}
        />
      </View>
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    root: { alignItems: "center", paddingVertical: 40, gap: 14 },
    monoLabel: { ...monoLabel, color: colors.colorMuted },
    headline: {
      fontSize: 48,
      lineHeight: 56,
      fontWeight: "800",
      color: colors.color,
      textAlign: "center",
      textTransform: "uppercase",
      fontVariant: ["tabular-nums"],
      includeFontPadding: false,
    },
    center: { textAlign: "center" },
    giveBack: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "baseline",
      justifyContent: "center",
      gap: 12,
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surface,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    giveBackAmount: {
      fontSize: 24,
      lineHeight: 30,
      fontWeight: "800",
      color: colors.color,
      fontVariant: ["tabular-nums"],
    },
    seatBlock: {
      alignSelf: "stretch",
      marginTop: 8,
      paddingTop: 16,
      borderTopWidth: 2,
      borderTopColor: colors.borderColor,
      gap: 10,
      alignItems: "center",
    },
    seatRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: 8,
    },
    seatTag: {
      minWidth: 64,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surface,
      alignItems: "center",
    },
    seatTagText: { fontSize: 18, letterSpacing: 1, color: colors.color },
    cta: { alignSelf: "stretch", marginTop: 16 },
  });
