/**
 * Notices the Sell flow shares between the cart, the cash sheet and the card
 * reader screen.
 *
 * Status is border + text on a tint, never a coloured fill behind body copy
 * (the comp / off-cart banner convention this screen already used).
 */
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "@th/ui";
import {
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { cardClearedCopy, type CardClearedKind } from "./sale-attempt";

/**
 * Amber "tell the buyer" / "wait" notice. Amber, not red: nothing failed,
 * the operator has something to say or do before the buyer pays.
 */
export function SupportNotice({
  children,
  testID,
}: {
  children: ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <View
      style={styles.support}
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      <Text variant="bodySmall" color={colors.color} style={styles.body}>
        {children}
      </Text>
    </View>
  );
}

/**
 * Left after "Clear it anyway" on an open card sale. An instruction ("Don't
 * take cash for the $X card sale you cleared"), not an error, so amber with a
 * bold title, not the red error
 * banner. Held by the app root (`sale-guard.ts`), so cart edits and opening
 * the cash sheet don't clear it; the next completed sale or Dismiss does.
 */
export function CardClearedNotice({
  kind,
  amount,
  onDismiss,
}: {
  kind: CardClearedKind;
  /** The cleared card sale's total, already formatted, or null if unknown. */
  amount: string | null;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const copy = cardClearedCopy(kind, amount);
  return (
    <View
      style={[styles.support, styles.cleared]}
      accessibilityLiveRegion="polite"
      testID="sell-card-cleared"
    >
      <Text variant="body" weight="bold" color={colors.color}>
        {copy.title}
      </Text>
      <Text variant="bodySmall" color={colors.color} style={styles.body}>
        {copy.body}
      </Text>
      <View style={styles.dismissRow}>
        <SquareSecondaryButton
          testID="sell-card-cleared-dismiss"
          label="Dismiss"
          accessibilityLabel={`Dismiss: ${copy.title}`}
          onPress={onDismiss}
        />
      </View>
    </View>
  );
}

/** Red-bordered refusal block: a heading, lines of copy, and its way out. */
export function DangerPanel({
  title,
  children,
  testID,
}: {
  title: string;
  children?: ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <View
      style={styles.danger}
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      <Text variant="body" weight="bold" color={colors.color}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/**
 * The "this sale may already be recorded" notice, with a Clear sale that asks
 * first. Clearing throws the key away; ringing the same tickets up again
 * under a new key would sell them twice if the lost attempt went through.
 */
export function UnresolvedSaleNotice({
  message,
  canClear,
  onClear,
  testID,
}: {
  message: string;
  /** Only once the key may hold a sale; a plain lock is cleared by a replay. */
  canClear: boolean;
  onClear: () => void;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const [asking, setAsking] = useState(false);
  return (
    <View style={styles.stack}>
      <SupportNotice testID={testID}>{message}</SupportNotice>
      {canClear && !asking && (
        <SquareSecondaryButton
          testID="sell-clear-unresolved"
          label="Clear sale"
          onPress={() => setAsking(true)}
        />
      )}
      {canClear && asking && (
        <View style={styles.confirm} testID="sell-clear-unresolved-confirm">
          <Text variant="body" weight="bold" color={colors.color}>
            Clear this sale?
          </Text>
          <Text variant="bodySmall" color={colors.color} style={styles.body}>
            The last attempt may already be recorded. Clearing doesn't undo
            it, and ringing these tickets up again would sell them twice.
          </Text>
          <View style={styles.row}>
            <View style={styles.slot}>
              <SquareSecondaryButton
                label="Keep it"
                onPress={() => setAsking(false)}
              />
            </View>
            <View style={styles.slot}>
              <SquareSecondaryButton
                testID="sell-clear-unresolved-yes"
                label="Clear it anyway"
                onPress={() => {
                  setAsking(false);
                  onClear();
                }}
              />
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    support: {
      borderWidth: 2,
      borderColor: colors.support,
      backgroundColor: colors.supportTint,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
    danger: {
      borderWidth: 2,
      borderColor: colors.danger,
      backgroundColor: colors.surface,
      padding: 16,
      gap: 10,
    },
    body: { lineHeight: 20 },
    cleared: { gap: 8 },
    dismissRow: { alignSelf: "flex-start", minWidth: 140 },
    stack: { gap: 12 },
    confirm: {
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surface,
      padding: 16,
      gap: 10,
    },
    row: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    slot: { flexGrow: 1, flexBasis: 120 },
  });
