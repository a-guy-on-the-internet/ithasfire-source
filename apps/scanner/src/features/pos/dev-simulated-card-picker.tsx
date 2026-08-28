/**
 * DevSimulatedCardPicker — non-production-only chip row that selects
 * which test card the Stripe Terminal simulator will "tap" next.
 *
 * Stripe's simulator defaults to 4242 (Visa, success). To exercise
 * the decline / insufficient-funds / expired branches in SellScreen
 * without touching real money, we call `setSimulatedCard(cardNumber)`
 * before discovery so the simulator emits the chosen brand/outcome.
 *
 * This component renders `null` in production builds — `getAppEnv()`
 * is the gate, NOT a runtime feature flag, because the test cards
 * have no meaning against the real Tap to Pay reader.
 */
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "@th/ui";

import { getAppEnv } from "../../lib/capabilities";
import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";

export type SimulatedTestCard = {
  label: string;
  cardNumber: string;
};

// Stripe-documented test PANs. See:
// https://docs.stripe.com/terminal/references/testing#standard-test-cards
export const SIMULATED_TEST_CARDS: readonly SimulatedTestCard[] = [
  { label: "Visa", cardNumber: "4242424242424242" },
  { label: "Decline", cardNumber: "4000000000000002" },
  { label: "Insuff.", cardNumber: "4000000000009995" },
  { label: "Expired", cardNumber: "4000000000000069" },
];

export const DEFAULT_SIMULATED_TEST_CARD = SIMULATED_TEST_CARDS[0]!.cardNumber;

export function DevSimulatedCardPicker({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (cardNumber: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  if (getAppEnv() === "production") return null;

  return (
    <View style={styles.row} testID="dev-simulated-card-picker">
      <Text
        variant="caption"
        color={colors.colorMuted}
        letterSpacing={1}
        textTransform="uppercase"
        style={styles.label}
      >
        Sim card
      </Text>
      {SIMULATED_TEST_CARDS.map((card) => {
        const isSelected = card.cardNumber === selected;
        return (
          <Pressable
            key={card.cardNumber}
            onPress={() => onSelect(card.cardNumber)}
            style={[styles.chip, isSelected && styles.chipSelected]}
            accessibilityRole="button"
            accessibilityLabel={`Simulate ${card.label} card`}
            accessibilityState={{ selected: isSelected }}
            testID={`dev-sim-card-${card.label.toLowerCase()}`}
          >
            <Text
              variant="caption"
              weight="bold"
              color={isSelected ? colors.accentText : colors.colorMuted}
            >
              {card.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 12,
    },
    label: {
      marginRight: 4,
    },
    chip: {
      minHeight: 44,
      minWidth: 80,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderWidth: 1,
      borderColor: colors.borderColorSoft,
      alignItems: "center",
      justifyContent: "center",
    },
    chipSelected: {
      borderColor: colors.accent,
    },
  });
