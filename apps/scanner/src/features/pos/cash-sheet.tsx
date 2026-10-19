/**
 * The cash sheet (board S3): what's due, what they handed over, the change.
 *
 * "Cash due" is the server quote's CASH total: ticket + tax, no platform or
 * processing fee (owner ruling 2026-10-08). The received field only works out
 * change; the server refuses an amount below its total (CASH_AMOUNT_SHORT),
 * so Confirm stays off until the amount covers it.
 *
 * A comp is its OWN action ("Comp instead · $0"), never a cash sale with $0
 * typed in: only the Comp action comps. It asks once, because a comp mints
 * tickets and admits them, and only an editor can reverse it.
 *
 * With no due figure (`dueCents === null`: the tax lookup is down) the sheet
 * is comp-only: a comp charges no tax, so it is the one sale that still works.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text as RNText,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { Text } from "@th/ui";
import {
  SquarePrimaryButton,
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { monoLabel } from "../../ui/mono-label";

import { BuyerEmailField } from "./buyer-email-field";
import {
  cashSheetView,
  cashShortCopy,
  cashFractions,
  centsToInput,
  currencySymbol,
  parseCashInput,
  quickCashAmounts,
  sanitizeCashInput,
} from "./cash-tender";
import type { AttemptLock } from "./sale-attempt";
import { SupportNotice } from "./sale-notices";
import { formatMoney } from "./sell-quote";

export type CashSheetProps = {
  currency: string;
  /** The cash total to take, or null for a comp-only sheet (tax down). */
  dueCents: number | null;
  /** "2 × General admission · $40.00 + $3.70 sales tax · no fees", or null. */
  dueSummary: string | null;
  /** The server moved the cash total after the quote (CASH_AMOUNT_SHORT). */
  dueChanged: boolean;
  ticketCount: number;
  buyerEmail: string;
  onBuyerEmailChange: (next: string) => void;
  /** Cash may be pressed (tenderOpen). */
  cashOpen: boolean;
  /** Comp may be pressed (tenderOpen). */
  compOpen: boolean;
  /** The unresolved attempt, if any: freezes the amount, email and Back. */
  lock: AttemptLock | null;
  /** The unresolved-attempt notice (and its Clear sale), or null. */
  notice: ReactNode;
  busy: boolean;
  onConfirmCash: (receivedCents: number) => void;
  onComp: () => void;
  onBack: () => void;
};

export function CashSheet(props: CashSheetProps) {
  const {
    currency,
    dueCents,
    dueSummary,
    dueChanged,
    ticketCount,
    buyerEmail,
    onBuyerEmailChange,
    cashOpen,
    compOpen,
    lock,
    notice,
    busy,
    onConfirmCash,
    onComp,
    onBack,
  } = props;
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const compOnly = dueCents === null;
  const fractions = cashFractions(currency);
  const [amountStr, setAmountStr] = useState(
    dueCents === null ? "" : centsToInput(dueCents, fractions),
  );
  // The comp-only sheet was opened BY choosing "Comp instead", so it opens on
  // the confirm. And a comp still on screen after a lost answer must stay
  // pressable, so the confirm opens itself whenever comp is the locked tender.
  const [confirmingComp, setConfirmingComp] = useState(
    compOnly || lock?.tender === "comp",
  );
  useEffect(() => {
    if (lock?.tender === "comp") setConfirmingComp(true);
  }, [lock]);
  // Same-tick double-tap guard; `busy` drives the visible state.
  const pressRef = useRef(false);
  useEffect(() => {
    if (!busy) pressRef.current = false;
  }, [busy]);

  const received = parseCashInput(amountStr, fractions);
  const view = dueCents === null ? null : cashSheetView(dueCents, received);
  const chips = useMemo(
    () => (dueCents === null ? [] : quickCashAmounts(dueCents)),
    [dueCents],
  );
  const amountLocked = lock !== null || busy;
  const confirmLabel = dueCents === 0 ? "Confirm $0 sale" : "Confirm cash";
  const tickets = `${ticketCount} ${ticketCount === 1 ? "ticket" : "tickets"}`;

  const press = (fn: () => void) => {
    if (pressRef.current || busy) return;
    pressRef.current = true;
    fn();
  };

  return (
    <View style={styles.sheet} testID="sell-cash-sheet">
      {dueCents !== null && (
        <View style={styles.dueBlock}>
          <View style={styles.dueRow}>
            <RNText style={[styles.monoLabel, styles.flexLabel]}>Cash due</RNText>
            <Text style={styles.dueAmount} testID="sell-cash-due">
              {formatMoney(dueCents, currency)}
            </Text>
          </View>
          {dueSummary !== null && !dueChanged && (
            <Text variant="bodySmall" color={colors.colorMuted} style={styles.copy}>
              {dueSummary}
            </Text>
          )}
          {dueChanged && (
            <SupportNotice testID="sell-cash-total-changed">
              The cash total changed since the quote. Cash due is now{" "}
              {formatMoney(dueCents, currency)}. Tell the buyer before you take
              it.
            </SupportNotice>
          )}
        </View>
      )}

      {compOnly && (
        <Text variant="bodySmall" color={colors.colorMuted} style={styles.copy}>
          Tax can't be worked out right now, so cash and card are off. A comp
          charges no tax, so it still works.
        </Text>
      )}

      {notice}

      {dueCents !== null && view !== null && (
        <>
          <RNText style={styles.monoLabel}>Cash received</RNText>
          <View style={[styles.amountField, amountLocked && styles.amountLocked]}>
            <View style={styles.currencySlot}>
              <Text variant="body" weight="bold" style={styles.currencyGlyph}>
                {currencySymbol(currency)}
              </Text>
            </View>
            <TextInput
              accessibilityLabel={`Cash received, in ${currency.toUpperCase()}`}
              testID="sell-cash-amount-input"
              value={amountStr}
              onChangeText={(next) => setAmountStr(sanitizeCashInput(next, fractions))}
              editable={!amountLocked}
              keyboardType={fractions === 0 ? "number-pad" : "decimal-pad"}
              inputMode={fractions === 0 ? "numeric" : "decimal"}
              selectTextOnFocus
              style={styles.amountInput}
              placeholder="0.00"
              placeholderTextColor={colors.placeholder}
            />
          </View>

          <View style={styles.chipRow}>
            <AmountChip
              label="Exact"
              accessibilityLabel={`Exact amount, ${formatMoney(dueCents, currency)}`}
              active={received === dueCents}
              disabled={amountLocked}
              onPress={() => setAmountStr(centsToInput(dueCents, fractions))}
            />
            {chips.map((cents) => (
              <AmountChip
                key={cents}
                label={formatMoney(cents, currency).replace(/\.00$/, "")}
                accessibilityLabel={`They gave ${formatMoney(cents, currency)}`}
                active={received === cents}
                disabled={amountLocked}
                onPress={() => setAmountStr(centsToInput(cents, fractions))}
              />
            ))}
          </View>

          {view.covers ? (
            <View
              style={styles.changeBox}
              testID="sell-cash-change"
              accessible
              accessibilityLabel={`Change ${formatMoney(view.changeCents, currency)}`}
            >
              <RNText style={[styles.monoLabel, styles.flexLabel]}>Change</RNText>
              <Text style={styles.changeAmount}>
                {formatMoney(view.changeCents, currency)}
              </Text>
            </View>
          ) : (
            <SupportNotice testID="sell-cash-short">
              {cashShortCopy(dueCents, received, currency)}
            </SupportNotice>
          )}
        </>
      )}

      <BuyerEmailField
        value={buyerEmail}
        onChange={onBuyerEmailChange}
        locked={lock !== null || busy}
      />

      {/* While the comp is being confirmed, its own panel holds the only
          live buttons: "Confirm cash" beside "Comp them" invited the wrong
          press. */}
      {dueCents !== null && view !== null && !confirmingComp && (
        <View style={styles.ctaRow}>
          <View style={styles.ctaWide}>
            {busy && lock?.tender !== "comp" ? (
              <View style={styles.pending}>
                <ActivityIndicator color={colors.color} />
              </View>
            ) : (
              <SquarePrimaryButton
                testID="sell-cash-confirm-button"
                label={confirmLabel}
                onPress={() => press(() => onConfirmCash(received))}
                disabled={!cashOpen || !view.covers}
              />
            )}
          </View>
          <View style={styles.ctaNarrow}>
            <SquareSecondaryButton
              testID="sell-cash-back-button"
              label="Back"
              onPress={onBack}
              disabled={busy || lock !== null}
            />
          </View>
        </View>
      )}

      {!confirmingComp ? (
        <Pressable
          testID="sell-comp-instead"
          accessibilityRole="button"
          accessibilityLabel={`Comp instead, ${formatMoney(0, currency)}`}
          accessibilityState={{ disabled: !compOpen }}
          disabled={!compOpen}
          onPress={() => setConfirmingComp(true)}
          style={({ pressed }) => [
            styles.compButton,
            pressed && compOpen && styles.compButtonPressed,
            !compOpen && styles.compButtonDisabled,
          ]}
        >
          <Text
            variant="body"
            weight="bold"
            letterSpacing={1}
            textTransform="uppercase"
            color={compOpen ? colors.accentText : colors.colorMuted}
          >
            Comp instead · {formatMoney(0, currency).replace(/\.00$/, "")}
          </Text>
        </Pressable>
      ) : (
        <View style={styles.compConfirm} testID="sell-comp-confirm">
          <Text variant="body" weight="bold" color={colors.color}>
            Comp {tickets}?
          </Text>
          <Text variant="bodySmall" color={colors.color} style={styles.copy}>
            Guest list. No charge, no tax. An Owner, Admin or Editor can undo
            it on the web until 7 days after the event.
          </Text>
          <View style={styles.compButtons}>
            <View style={styles.compButtonSlot}>
              {busy ? (
                <View style={styles.pending}>
                  <ActivityIndicator color={colors.color} />
                </View>
              ) : (
                <SquarePrimaryButton
                  testID="sell-comp-confirm-button"
                  label="Comp them"
                  onPress={() => press(onComp)}
                  disabled={!compOpen}
                />
              )}
            </View>
            <View style={styles.compButtonSlot}>
              <SquareSecondaryButton
                testID="sell-comp-cancel"
                // Not "Back": the sheet's own Back is a different action, and
                // two controls must not share one accessible name.
                label={compOnly ? "Back" : "Don't comp"}
                onPress={() => {
                  if (compOnly) onBack();
                  else setConfirmingComp(false);
                }}
                disabled={busy || lock !== null}
              />
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

function AmountChip({
  label,
  accessibilityLabel,
  active,
  disabled,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active, disabled }}
      style={({ pressed }) => [
        styles.chip,
        (active || pressed) && !disabled && styles.chipActive,
        disabled && styles.chipDisabled,
      ]}
    >
      <Text
        variant="bodySmall"
        weight="bold"
        letterSpacing={1}
        textTransform="uppercase"
        color={disabled ? colors.colorMuted : colors.color}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    sheet: { gap: 16 },
    monoLabel: { ...monoLabel, color: colors.colorMuted },
    dueBlock: { gap: 8 },
    dueRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 8,
    },
    flexLabel: { flexShrink: 1 },
    dueAmount: {
      fontSize: 36,
      lineHeight: 42,
      fontWeight: "800",
      color: colors.color,
      fontVariant: ["tabular-nums"],
    },
    copy: { lineHeight: 20 },

    // One Swiss-bordered rectangle with a fixed `$` slot; the value
    // right-aligns like a calculator readout.
    amountField: {
      flexDirection: "row",
      alignItems: "stretch",
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surface,
      minHeight: 88,
    },
    amountLocked: { backgroundColor: colors.surfaceMuted },
    currencySlot: {
      width: 64,
      alignItems: "center",
      justifyContent: "center",
      borderRightWidth: 2,
      borderRightColor: colors.borderColor,
    },
    currencyGlyph: { fontSize: 28, lineHeight: 34, color: colors.color },
    amountInput: {
      flex: 1,
      minWidth: 0,
      fontSize: 36,
      fontWeight: "700",
      color: colors.color,
      textAlign: "right",
      paddingHorizontal: 16,
      paddingVertical: 0,
      includeFontPadding: false,
      fontVariant: ["tabular-nums"],
    },

    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      minHeight: 44,
      minWidth: 64,
      paddingHorizontal: 14,
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    // `surfaceMuted`, not `surfaceRaised`: on Stub the two are the same value
    // and `surfaceRaised` would leave the picked bill looking unpicked.
    chipActive: { backgroundColor: colors.surfaceMuted },
    // Same as a disabled stepper: soft border, muted fill.
    chipDisabled: {
      borderColor: colors.borderColorSoft,
      backgroundColor: colors.surfaceMuted,
    },

    changeBox: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 8,
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surface,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    changeAmount: {
      fontSize: 28,
      lineHeight: 34,
      fontWeight: "800",
      color: colors.color,
      fontVariant: ["tabular-nums"],
    },

    ctaRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    // 180 + 96 + gap won't fit at 320pt: Back drops under a full-width
    // "Confirm cash" instead of the label wrapping taller than Back.
    ctaWide: { flexGrow: 2, flexBasis: 180 },
    ctaNarrow: { flexGrow: 1, flexBasis: 96 },
    pending: {
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.borderColor,
    },

    // Outlined in accent: the comp goes on the comp audit, and the accent
    // border says "this is different" without competing with Confirm cash.
    compButton: {
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 16,
      borderWidth: 2,
      borderColor: colors.accent,
      // Transparent: an outline is enough to say "different", and a tinted
      // fill out-shouted Confirm cash.
      backgroundColor: "transparent",
    },
    compButtonPressed: { backgroundColor: colors.surfaceMuted },
    compButtonDisabled: {
      borderColor: colors.borderColorSoft,
      backgroundColor: colors.surfaceMuted,
    },
    // Stacked, full width, primary on top: the narrow slot beside "Comp
    // them" left "DON'T COMP" about 48pt wide at 375-430pt.
    compButtons: { flexDirection: "column", gap: 12 },
    compButtonSlot: { alignSelf: "stretch" },
    compConfirm: {
      borderWidth: 2,
      borderColor: colors.accent,
      backgroundColor: colors.surface,
      padding: 16,
      gap: 12,
    },
  });
