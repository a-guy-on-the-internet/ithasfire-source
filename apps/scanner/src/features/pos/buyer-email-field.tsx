/**
 * "Buyer email (optional)": shown on every payment step (owner pick E1).
 *
 * Applies to card, cash and comp alike; the server emails the ticket and an
 * itemised receipt. A field the operator had to open first would be a field
 * nobody fills at a busy door.
 *
 * Locked after an attempt that got no answer: the address is part of the
 * sale the server may already hold, and a changed one would be a different
 * sale under the same key.
 */
import { StyleSheet, TextInput, View } from "react-native";

import { Text } from "@th/ui";
import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";

import { emailBlocksSale } from "./sell-quote";

export function BuyerEmailField({
  value,
  onChange,
  locked,
}: {
  value: string;
  onChange: (next: string) => void;
  locked: boolean;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const invalid = emailBlocksSale(value);
  return (
    <View style={styles.block} testID="sell-buyer-email-block">
      <Text variant="bodySmall" weight="bold" color={colors.color}>
        Buyer email (optional)
      </Text>
      <TextInput
        accessibilityLabel="Buyer email, optional"
        accessibilityHint="We send their ticket and an itemised receipt."
        testID="sell-buyer-email"
        value={value}
        onChangeText={onChange}
        editable={!locked}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        keyboardType="email-address"
        inputMode="email"
        returnKeyType="done"
        maxLength={254}
        placeholder="name@example.com"
        placeholderTextColor={colors.placeholder}
        style={[
          styles.input,
          invalid && styles.inputInvalid,
          locked && styles.inputLocked,
        ]}
      />
      <Text
        variant="caption"
        color={invalid ? colors.dangerSoft : colors.colorMuted}
        style={styles.help}
      >
        {invalid
          ? "That doesn't look like an email address. Fix it or clear it to take payment."
          : "We send their ticket and an itemised receipt. No account, no marketing."}
      </Text>
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    block: { gap: 8 },
    input: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 0,
      fontSize: 16,
      color: colors.color,
      backgroundColor: colors.surface,
      borderWidth: 2,
      borderColor: colors.borderColor,
      includeFontPadding: false,
    },
    inputInvalid: { borderColor: colors.danger },
    inputLocked: {
      backgroundColor: colors.surfaceMuted,
      color: colors.colorMuted,
    },
    help: { lineHeight: 18 },
  });
