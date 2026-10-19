/**
 * The Sell screen's catalogue: one row per door-sellable ticket type, with a
 * square stepper. The unit price shown is the event-page face price per
 * ticket; what the cart COSTS comes from the server quote below it.
 *
 * Moved out of `sell-screen.tsx` unchanged apart from `locked`, which freezes
 * the cart while a sale attempt is unresolved (the cart is part of the sale
 * the server may already hold).
 */
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "@th/ui";
import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";

import { formatMoney } from "./sell-quote";

export type TicketTypeRow = {
  id: string;
  name: string;
  unitPriceCents: number;
  capacityRemaining: number;
  /**
   * Per-tier sales-window state (time-based-ticket-pricing FR-010), already
   * turned into operator copy by `describeSaleState`. Optional: absent means
   * sellable. SURFACING ONLY: `pos.startSale` / `pos.recordCashSale` re-check
   * server-side and are the only thing that may refuse a sale.
   */
  saleState?: { isSellable: boolean; note: string | null };
};

export function TicketTypeRows({
  ticketTypes,
  cartByTicketType,
  currency,
  locked,
  onAdjust,
}: {
  ticketTypes: TicketTypeRow[];
  cartByTicketType: ReadonlyMap<string, number>;
  currency: string;
  locked: boolean;
  onAdjust: (ticketTypeId: string, delta: number) => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <>
      {ticketTypes.map((tt) => {
        const inCart = cartByTicketType.get(tt.id) ?? 0;
        // FR-010: a tier outside its sales window can never be added. The
        // server refuses it anyway; this stops the operator finding out at
        // the card reader. Deliberately ORed with capacity rather than
        // merged upstream — "sold out" and "not on sale yet" are separate
        // facts and a tier can be both.
        const isSellable = tt.saleState?.isSellable !== false;
        const atCapacity =
          locked || !isSellable || inCart >= tt.capacityRemaining;
        const cannotRemove = locked || inCart === 0;
        return (
          <View
            key={tt.id}
            style={[styles.row, !isSellable && styles.rowUnavailable]}
            testID={`sell-door-item-${tt.id}`}
          >
            <View style={styles.rowMain}>
              <Text variant="body" weight="bold" style={styles.ttName}>
                {tt.name}
              </Text>
              <Text variant="bodySmall" color={colors.colorMuted}>
                {formatMoney(tt.unitPriceCents, currency)} ·{" "}
                {tt.capacityRemaining} left
              </Text>
              {tt.saleState?.note && (
                <Text
                  variant="bodySmall"
                  weight="bold"
                  color={colors.colorMuted}
                  testID={`sell-door-item-state-${tt.id}`}
                >
                  {tt.saleState.note}
                </Text>
              )}
            </View>
            <View style={styles.stepper}>
              <Pressable
                accessibilityLabel={`Remove one ${tt.name}`}
                accessibilityRole="button"
                onPress={() => onAdjust(tt.id, -1)}
                style={({ pressed }) => [
                  styles.stepperBtn,
                  pressed && !cannotRemove && styles.stepperBtnPressed,
                  cannotRemove && styles.stepperBtnDisabled,
                ]}
                disabled={cannotRemove}
              >
                {({ pressed }) => (
                  <Text
                    variant="body"
                    weight="bold"
                    style={[
                      styles.stepperBtnText,
                      pressed &&
                        !cannotRemove &&
                        styles.stepperBtnTextPressed,
                      cannotRemove && styles.stepperBtnTextDisabled,
                    ]}
                  >
                    −
                  </Text>
                )}
              </Pressable>
              <Text variant="body" weight="bold" style={styles.stepperQty}>
                {inCart}
              </Text>
              <Pressable
                accessibilityLabel={`Add one ${tt.name}`}
                accessibilityRole="button"
                onPress={() => onAdjust(tt.id, 1)}
                style={({ pressed }) => [
                  styles.stepperBtn,
                  pressed && !atCapacity && styles.stepperBtnPressed,
                  atCapacity && styles.stepperBtnDisabled,
                ]}
                disabled={atCapacity}
              >
                {({ pressed }) => (
                  <Text
                    variant="body"
                    weight="bold"
                    style={[
                      styles.stepperBtnText,
                      pressed &&
                        !atCapacity &&
                        styles.stepperBtnTextPressed,
                      atCapacity && styles.stepperBtnTextDisabled,
                    ]}
                  >
                    +
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        );
      })}

    </>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    // Ticket-type rows separated by a 1px hairline, no radii.
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderColorSoft,
      gap: 12,
    },
    // FR-010: dimmed, never hidden. A door team that cannot see the 8pm tier
    // concludes it was never configured and starts improvising.
    rowUnavailable: { opacity: 0.5 },
    rowMain: { flex: 1, gap: 4 },
    ttName: { fontSize: 18, color: colors.color },

    // Square stepper buttons — 48px tap target, 2px border, no radius.
    stepper: { flexDirection: "row", alignItems: "center", gap: 8 },
    stepperBtn: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.borderColor,
    },
    // `structure` fill + `onStructure` glyph — the same inversion
    // `secondaryButtonPressed` uses. The previous value was `progressTrack`,
    // which (a) is documented as "track behind a progress bar", so retuning the
    // progress bar would have silently retuned this, and (b) REPLACED the rest
    // fill rather than compositing over it, resolving its alpha against the
    // canvas for a 1.08:1 Stub / 1.06:1 Ember state delta — no visible press on
    // the control that sets the quantity being charged.
    stepperBtnPressed: {
      backgroundColor: colors.structure,
      borderColor: colors.structure,
    },
    stepperBtnTextPressed: { color: colors.onStructure },
    // Tokens, not `opacity: 0.3` — at that alpha the +/- glyph measured
    // ~1.6:1 against its own washed-out fill, on the control an operator uses
    // to set the quantity they are about to charge for.
    stepperBtnDisabled: {
      backgroundColor: colors.surfaceMuted,
      borderColor: colors.borderColorSoft,
    },
    stepperBtnTextDisabled: { color: colors.colorMuted },
    stepperBtnText: { fontSize: 24, color: colors.color, lineHeight: 28 },
    stepperQty: {
      minWidth: 32,
      textAlign: "center",
      fontSize: 18,
      color: colors.color,
    },

  });
