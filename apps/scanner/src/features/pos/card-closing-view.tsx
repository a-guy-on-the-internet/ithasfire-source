/**
 * A card sale the till is closing, or couldn't close.
 *
 * Shown after Cancel / Back on the Tap to Pay screen while `pos.cancelSale`
 * runs, and kept up when the answer was not "closed": the card may have gone
 * through (paid at Stripe, the webhook not finalised), or the cancel didn't
 * get a clear answer. There is no Cash button here on purpose: a card the
 * server says was paid, or might have been, must never be followed by cash
 * for the same tickets. The parent polls `pos.completeSale` and moves on by
 * itself.
 *
 * Layout: a mono state label ("CARD SALE NOT CLOSED") over a MUTED amount, so
 * the big figure doesn't read as "paid"; then the one instruction in bold
 * ("Don't take cash for these tickets."), then why. There is no in-screen
 * Clear (see `CloseOutcome` in sale-attempt.ts): leaving the tab asks
 * "Clear this sale?".
 */
import { ActivityIndicator, Text as RNText, StyleSheet, View } from "react-native";

import { Text } from "@th/ui";
import {
  SquarePrimaryButton,
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { monoLabel } from "../../ui/mono-label";

import { CLOSING_VIEW, type CloseView } from "./sale-attempt";
import { formatMoney } from "./sell-quote";

export function CardClosingView({
  amountCents,
  currency,
  view,
  busy,
  onCheckAgain,
  onStartNewSale,
}: {
  amountCents: number;
  currency: string;
  /** Null while the first close is still running. */
  view: CloseView | null;
  busy: boolean;
  onCheckAgain: () => void;
  /** Opens the root "Clear this sale?" confirm; never clears by itself. */
  onStartNewSale: () => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const shown = view ?? CLOSING_VIEW;
  const first = view === null;
  return (
    <View style={styles.root} testID="sell-card-closing">
      <View style={styles.head}>
        <RNText style={styles.stateLabel} testID="sell-card-closing-label">
          {shown.label}
        </RNText>
        <Text style={styles.amount}>{formatMoney(amountCents, currency)}</Text>
      </View>

      <View
        style={styles.notice}
        accessibilityLiveRegion="polite"
        testID="sell-card-closing-message"
      >
        <Text variant="body" weight="bold" color={colors.color}>
          Don't take cash for these tickets.
        </Text>
        <Text variant="body" color={colors.color} style={styles.copy}>
          {shown.explanation}
        </Text>
      </View>

      {shown.settling && (
        <View style={styles.settling} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.color} />
          <Text variant="body" color={colors.color}>
            {first ? "Closing…" : "Confirming…"}
          </Text>
        </View>
      )}

      {!first && (
        <>
          {shown.settling || shown.deadEnd ? (
            // It moves on by itself (settling), or asking again repeats the
            // same answer (dead end): checking by hand is only the back-up.
            <SquareSecondaryButton
              testID="sell-card-check-again"
              label={busy ? "Checking…" : "Check again"}
              onPress={onCheckAgain}
              disabled={busy}
            />
          ) : (
            <SquarePrimaryButton
              testID="sell-card-check-again"
              label={busy ? "Checking…" : "Check again"}
              onPress={onCheckAgain}
              disabled={busy}
            />
          )}
          {shown.deadEnd && (
            <SquareSecondaryButton
              testID="sell-card-start-new-sale"
              label="Start a new sale"
              onPress={onStartNewSale}
            />
          )}
        </>
      )}
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    root: { paddingVertical: 32, gap: 20 },
    head: { alignItems: "center", gap: 6 },
    stateLabel: { ...monoLabel, color: colors.colorMuted, textAlign: "center" },
    // Muted: an amount on this screen is what the card was ASKED for, not
    // what was paid.
    amount: {
      fontSize: 40,
      lineHeight: 48,
      fontWeight: "800",
      color: colors.colorMuted,
      textAlign: "center",
      fontVariant: ["tabular-nums"],
    },
    notice: {
      borderWidth: 2,
      borderColor: colors.support,
      backgroundColor: colors.supportTint,
      padding: 16,
      gap: 8,
    },
    copy: { lineHeight: 22 },
    settling: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
    },
  });
