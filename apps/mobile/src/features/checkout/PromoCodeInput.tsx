import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Tag, X } from "lucide-react-native";

import {
  SquareSecondaryButton,
  useColors,
  useStyles,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import {
  MAX_PROMO_CODES,
  type AddPromoCodeFailure,
} from "./checkout-selection";

const FAILURE_MESSAGES: Record<AddPromoCodeFailure, string> = {
  too_short: "Promo codes are at least 3 characters.",
  too_long: "That code looks too long. Check it and try again.",
  duplicate: "That code is already added.",
  limit_reached: `You can add up to ${MAX_PROMO_CODES} promo codes.`,
};

/**
 * Promo code entry (FR-003): a collapsed "Have a promo code?" affordance
 * that expands to an input + Add button, plus rows for each added code.
 *
 * Codes are NOT validated against the server here — `orders.createCheckout`
 * validates and applies them at payment time (Step 4). This component only
 * enforces the input-schema shape (trim, length 3..64, max 5, deduped).
 */
export const PromoCodeInput = ({
  codes,
  onAdd,
  onRemove,
}: {
  codes: readonly string[];
  /** Returns a failure reason for inline display, or null when added. */
  onAdd: (code: string) => AddPromoCodeFailure | null;
  onRemove: (code: string) => void;
}) => {
  const colors = useColors();
  const shared = useStyles();
  const styles = useThemedSheet(makeSheet);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = useCallback(() => {
    const failure = onAdd(draft);
    if (failure) {
      setError(FAILURE_MESSAGES[failure]);
      return;
    }
    setDraft("");
    setError(null);
  }, [draft, onAdd]);

  const showForm = expanded || codes.length > 0;

  if (!showForm) {
    return (
      <Pressable
        onPress={() => setExpanded(true)}
        accessibilityRole="button"
        accessibilityLabel="Have a promo code?"
        accessibilityHint="Shows the promo code input."
        hitSlop={8}
        style={styles.affordance}
        testID="promo-code-expand"
      >
        <Tag size={15} color={colors.accentText} />
        <Text style={styles.affordanceText}>Have a promo code?</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.container} testID="promo-code-input">
      <View style={styles.inputRow}>
        <TextInput
          value={draft}
          onChangeText={(value) => {
            setDraft(value);
            setError(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={handleAdd}
          placeholder="Promo code"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="done"
          accessibilityLabel="Promo code"
          style={[
            shared.input,
            styles.input,
            focused ? shared.inputFocused : null,
          ]}
          testID="promo-code-field"
        />
        <SquareSecondaryButton
          label="Add"
          onPress={handleAdd}
          disabled={draft.trim().length === 0}
          accessibilityHint="Adds the promo code to this order."
          testID="promo-code-add"
        />
      </View>

      {error ? (
        <Text style={styles.errorText} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {codes.length > 0 ? (
        <View style={styles.codeList}>
          {codes.map((code, index) => (
            <View
              key={code}
              style={[
                styles.codeRow,
                index === codes.length - 1 && styles.codeRowLast,
              ]}
            >
              <Tag size={14} color={colors.accentText} />
              <Text style={styles.codeText} numberOfLines={1}>
                {code}
              </Text>
              <Pressable
                onPress={() => onRemove(code)}
                accessibilityRole="button"
                accessibilityLabel={`Remove promo code ${code}`}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.removeButton,
                  pressed ? styles.removeButtonPressed : null,
                ]}
                testID={`promo-code-remove-${code}`}
              >
                {/* `structure` is dark in BOTH themes, so the glyph has to
                    invert with the pressed fill or it disappears on Stub. */}
                {({ pressed }) => (
                  <X
                    size={16}
                    color={pressed ? colors.onStructure : colors.color}
                  />
                )}
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    affordance: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      alignSelf: "flex-start",
    },
    affordanceText: {
      color: c.accentText,
      fontFamily: "Montserrat-Medium",
      fontSize: 14,
      textDecorationLine: "underline",
    },
    container: { gap: 10 },
    inputRow: {
      flexDirection: "row",
      alignItems: "stretch",
      gap: 10,
    },
    input: { flex: 1 },
    errorText: {
      color: c.dangerSoft,
      fontFamily: "Montserrat",
      fontSize: 13,
      lineHeight: 18,
    },
    codeList: {
      borderWidth: 1,
      borderColor: c.borderColor,
      backgroundColor: c.surfaceMuted,
    },
    codeRow: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderBottomWidth: 1,
      borderBottomColor: c.borderColorSoft,
    },
    codeRowLast: { borderBottomWidth: 0 },
    codeText: {
      flex: 1,
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 14,
      fontWeight: "700",
      letterSpacing: 0.5,
    },
    removeButton: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: c.borderColor,
      backgroundColor: c.surface,
    },
    removeButtonPressed: {
      backgroundColor: c.structure,
      borderColor: c.structure,
    },
  });
