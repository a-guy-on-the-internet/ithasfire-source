/**
 * Promo-code entry for the Sell screen: an input + Apply, and a removable
 * chip per applied code showing what it took off. Presentational only: all
 * validation, previewing and staleness live in `promo-entry.ts`, and the
 * codes reach the total through `pos.quoteCart`.
 *
 * Moved out of `sell-screen.tsx` unchanged apart from `locked`, which
 * freezes the codes while a sale attempt is unresolved (the codes are part
 * of the sale the server may already hold).
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { Text } from "@th/ui";
import {
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { MAX_PROMO_CODES, type PromoState } from "./promo-entry";
import { formatMoney } from "./sell-quote";

export function PromoEntry({
  state,
  value,
  onChangeValue,
  onApply,
  onRemove,
  canApply,
  locked,
  currency,
}: {
  state: PromoState;
  value: string;
  onChangeValue: (next: string) => void;
  onApply: () => void;
  onRemove: (code: string) => void;
  canApply: boolean;
  /** An unresolved sale attempt holds these codes: no adding or removing. */
  locked: boolean;
  currency: string;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const atMax = state.codes.length >= MAX_PROMO_CODES;
  const applyDisabled =
    locked || !canApply || state.isPreviewing || value.trim().length === 0;
  // The button's laid-out width (it grows with the text size), held while
  // the spinner stands in so the field beside it doesn't jump.
  const [applyWidth, setApplyWidth] = useState<number | null>(null);

  return (
    <View style={styles.promoBlock} testID="sell-promo-block">

      {state.codes.length > 0 && (
        <View style={styles.promoChipRow}>
          {state.codes.map((code) => {
            const application = state.applications.find(
              (entry) => entry.normalizedCode === code,
            );
            return (
              <View
                key={code}
                style={styles.promoChip}
                testID={`sell-promo-chip-${code}`}
              >
                <Text
                  variant="bodySmall"
                  weight="bold"
                  style={styles.promoChipCode}
                >
                  {code}
                </Text>
                {application && (
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    style={styles.promoChipAmount}
                  >
                    −{formatMoney(application.discountCents, currency)}
                  </Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove promo code ${code}`}
                  testID={`sell-promo-remove-${code}`}
                  onPress={() => onRemove(code)}
                  disabled={locked}
                  style={({ pressed }) => [
                    styles.promoChipRemove,
                    pressed && styles.promoChipRemovePressed,
                  ]}
                >
                  {({ pressed }) => (
                    <Text
                      variant="body"
                      weight="bold"
                      style={[
                        styles.promoChipRemoveGlyph,
                        pressed && styles.promoChipRemoveGlyphPressed,
                      ]}
                    >
                      ×
                    </Text>
                  )}
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      {!atMax && (
        <View style={styles.promoEntryRow}>
          <TextInput
            // Board S2: no heading over the field; the placeholder names it,
            // and so does this label once something is typed.
            accessibilityLabel="Promo code"
            testID="sell-promo-input"
            value={value}
            onChangeText={onChangeValue}
            editable={!locked}
            // Guarded: an unguarded keyboard "done" during an in-flight apply
            // would invalidate the first candidate code silently.
            onSubmitEditing={() => {
              if (!applyDisabled) onApply();
            }}
            // The server caps a code at 64 chars; without this a long paste
            // returns a Zod issue dump instead of a promo error.
            maxLength={64}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            returnKeyType="done"
            style={[styles.promoInput, locked && styles.promoInputLocked]}
            placeholder="Promo code"
            placeholderTextColor={colors.placeholder}
          />
          <View
            style={[
              styles.promoApplySlot,
              state.isPreviewing && applyWidth !== null && { width: applyWidth },
            ]}
            onLayout={(e) => {
              if (state.isPreviewing) return;
              const w = e.nativeEvent.layout.width;
              setApplyWidth((prev) => (prev === w ? prev : w));
            }}
          >
            {state.isPreviewing ? (
              <View style={styles.promoApplyPending}>
                <ActivityIndicator color={colors.color} />
              </View>
            ) : (
              <SquareSecondaryButton
                testID="sell-promo-apply-button"
                label="Apply"
                accessibilityLabel="Apply promo code"
                onPress={onApply}
                disabled={applyDisabled}
              />
            )}
          </View>
        </View>
      )}

      {atMax && (
        <Text variant="caption" color={colors.colorMuted}>
          Maximum of {MAX_PROMO_CODES} codes per sale.
        </Text>
      )}

      {state.error !== null && (
        <View
          style={styles.promoError}
          accessibilityLiveRegion="polite"
          testID="sell-promo-error"
        >
          {/* `dangerSoft`, not `danger` — the latter is the GRAPHIC rung
              (4.17:1) and is only used for this block's border. */}
          <Text variant="bodySmall" weight="bold" color={colors.dangerSoft}>
            {state.error}
          </Text>
        </View>
      )}
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    // The buyer email field's locked look, so a sale in flight reads the
    // same on both inputs.
    promoInputLocked: {
      backgroundColor: colors.surfaceMuted,
      color: colors.colorMuted,
    },
    // ── Promo entry ────────────────────────────────────────────────────
    promoBlock: { gap: 12 },
    promoEntryRow: { flexDirection: "row", alignItems: "stretch", gap: 12 },
    // Matches the 52px Swiss button height so the input and Apply align.
    promoInput: {
      flex: 1,
      // Lets the field shrink beside Apply on a 320pt screen instead of
      // pushing Apply off the edge (react-native-web sizes a bare input
      // to its intrinsic width).
      minWidth: 0,
      minHeight: 52,
      paddingHorizontal: 14,
      paddingVertical: 0,
      // Quiet, as board S2 draws it: a sentence-case placeholder in the body
      // face. A typed code still reads in capitals (`autoCapitalize`).
      fontSize: 16,
      fontWeight: "400",
      color: colors.color,
      backgroundColor: colors.surface,
      borderWidth: 2,
      borderColor: colors.borderColor,
      includeFontPadding: false,
    },
    // Sized to the label (never shrunk) so "APPLY" can't break mid-word at
    // any text size; the field gives way instead (`promoInput.minWidth: 0`).
    // 104 is the floor; while pending the slot holds the button's measured
    // width, so the spinner is the button's size at any text size.
    promoApplySlot: { minWidth: 104, flexShrink: 0, justifyContent: "center" },
    promoApplyPending: {
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.borderColor,
    },

    promoChipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    // Applied code + what it took off + a dedicated remove target. Outlined
    // in accent so it reads as an active modifier on the total above it.
    promoChip: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 2,
      borderColor: colors.accent,
      backgroundColor: colors.accentTint,
      paddingLeft: 12,
      minHeight: 44,
      gap: 8,
    },
    promoChipCode: { fontSize: 14, letterSpacing: 1, color: colors.color },
    promoChipAmount: { fontSize: 14, color: colors.accentText },
    // 44×44 minimum tap target, separated by a hairline from the label so a
    // fat-fingered press can't be mistaken for tapping the chip itself.
    promoChipRemove: {
      width: 44,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      borderLeftWidth: 2,
      borderLeftColor: colors.accent,
    },
    promoChipRemovePressed: { backgroundColor: colors.structure },
    promoChipRemoveGlyph: {
      fontSize: 20,
      lineHeight: 24,
      color: colors.color,
    },
    promoChipRemoveGlyphPressed: { color: colors.onStructure },
    // Outlined block, matching the comp / off-cart banner convention: status
    // is border + text, never a coloured fill behind body copy.
    promoError: {
      borderWidth: 2,
      borderColor: colors.danger,
      backgroundColor: colors.dangerTint,
      padding: 12,
    },
  });
