import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  useColors,
  useStyles,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { formatTicketTypePriceLabel } from "@/features/events/EventTicketTypeList";
import type { EventTicketTypes } from "@/features/events/use-event-detail";
import { formatTicketOrderCurrency } from "@/features/tickets/ticket-format";
import {
  clampDonationCents,
  formatCentsAsDollarsInput,
  maxSelectableQty,
  parseDollarsToCents,
  type CheckoutItems,
} from "./checkout-selection";
import { describeTierSaleState } from "./tier-sale-state";

type TicketType = EventTicketTypes["ticketTypes"][number];

/**
 * Per-unit amount input for ADJUSTABLE (pay-what-you-want) types, revealed
 * once qty > 0. Keeps a local text draft while focused; commits on blur /
 * submit by parsing to integer cents via `parseDollarsToCents` (exact
 * integer arithmetic — safe only because of its `Number.isSafeInteger`
 * overflow guard) and clamping to ≥ minimumCents via the pure core.
 */
const AdjustableAmountField = ({
  ticketType,
  currency,
  valueCents,
  onCommit,
}: {
  ticketType: TicketType;
  currency: string;
  valueCents: number;
  onCommit: (cents: number) => void;
}) => {
  const colors = useColors();
  const shared = useStyles();
  const styles = useThemedSheet(makeSheet);
  const [draft, setDraft] = useState(() =>
    formatCentsAsDollarsInput(valueCents),
  );
  const [focused, setFocused] = useState(false);

  // Re-sync the draft if the committed value changes while not editing.
  useEffect(() => {
    if (!focused) setDraft(formatCentsAsDollarsInput(valueCents));
  }, [focused, valueCents]);

  const commit = () => {
    const parsed = parseDollarsToCents(draft);
    const next = clampDonationCents(ticketType, parsed ?? valueCents);
    onCommit(next);
    setDraft(formatCentsAsDollarsInput(next));
  };

  const minimumCents = ticketType.minimumCents ?? 0;

  return (
    <View style={styles.amountField}>
      <Text style={styles.amountLabel}>Amount per ticket</Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onSubmitEditing={commit}
        keyboardType="decimal-pad"
        inputMode="decimal"
        returnKeyType="done"
        accessibilityLabel={`Amount per ticket for ${ticketType.name}`}
        accessibilityHint={
          minimumCents > 0
            ? `At least ${formatTicketOrderCurrency(minimumCents, currency)}.`
            : undefined
        }
        placeholder={formatCentsAsDollarsInput(minimumCents)}
        placeholderTextColor={colors.placeholder}
        style={[shared.input, focused ? shared.inputFocused : null]}
        testID={`amount-input-${ticketType.id}`}
      />
      {minimumCents > 0 ? (
        <Text style={styles.amountHelper}>
          At least {formatTicketOrderCurrency(minimumCents, currency)}
        </Text>
      ) : null}
    </View>
  );
};

const StepperButton = ({
  label,
  accessibilityLabel,
  onPress,
  disabled,
  testID,
}: {
  label: "−" | "+";
  accessibilityLabel: string;
  onPress: () => void;
  disabled: boolean;
  testID?: string;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.stepperButton,
        pressed && !disabled ? styles.stepperButtonPressed : null,
        disabled ? styles.stepperButtonDisabled : null,
      ]}
      testID={testID}
    >
      {({ pressed }) => (
        <Text
          style={[
            styles.stepperButtonText,
            {
              // The pressed fill is `structure` — dark in both themes — so the
              // glyph inverts with it rather than staying `color`.
              color: disabled
                ? colors.colorMuted
                : pressed
                  ? colors.onStructure
                  : colors.color,
            },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
};

/**
 * Ticket selection list (FR-003): one row per ticket type with a − / count /
 * + stepper bounded 0..min(capacity, 10). ADJUSTABLE types reveal a per-unit
 * amount input once selected. Mirrors EventTicketTypeList's Swiss styling.
 */
export const TicketTypePicker = ({
  ticketTypes,
  currency,
  items,
  timezone,
  onIncrement,
  onDecrement,
  onDonationChange,
}: {
  ticketTypes: TicketType[];
  currency: string;
  items: CheckoutItems;
  /**
   * IANA zone of the EVENT (FR-010). Sale windows are the organizer's
   * wall-clock decision about their venue, so they render on the venue's clock.
   * Absent ⇒ no time is rendered at all; the row degrades to "Not on sale yet".
   */
  timezone?: string | null;
  onIncrement: (ticketType: TicketType) => void;
  onDecrement: (ticketType: TicketType) => void;
  onDonationChange: (ticketType: TicketType, cents: number) => void;
}) => {
  const styles = useThemedSheet(makeSheet);

  if (ticketTypes.length === 0) {
    return (
      <Text style={styles.emptyText}>
        No ticket types are listed for this event yet.
      </Text>
    );
  }

  return (
    <View style={styles.list} testID="ticket-type-picker">
      {ticketTypes.map((ticketType, index) => {
        const priceLabel = formatTicketTypePriceLabel(ticketType, currency);
        const item = items[ticketType.id];
        const qty = item?.qty ?? 0;
        const maxQty = maxSelectableQty(ticketType);
        const soldOut = maxQty === 0;
        // SOLD OUT and SALE WINDOW are independent facts — a tier can be both —
        // so they are ORed into one "no stepper" decision here. The window
        // verdict is the server's, resolved against its clock alongside the
        // price; this only reads it.
        const saleState = describeTierSaleState(
          ticketType.sellability,
          timezone,
        );
        const unavailable = soldOut || !saleState.isBuyable;

        return (
          <View
            key={ticketType.id}
            style={[
              styles.row,
              index === ticketTypes.length - 1 && styles.rowLast,
            ]}
          >
            <View style={styles.rowMain}>
              <View style={styles.rowInfo}>
                {/* Dimmed, never hidden: a buyer who came for the late release
                    needs to see it exists and when it opens. The dim sits on
                    the name/price — NOT on the row — so `saleNote` below keeps
                    full contrast. */}
                <View
                  style={[
                    // Reproduces rowInfo's gap, which the old flat layout got
                    // from the parent — nesting name+price would otherwise
                    // close the 2px between them.
                    styles.rowInfoPrimary,
                    unavailable && styles.contentUnavailable,
                  ]}
                >
                  <Text style={styles.name} numberOfLines={2}>
                    {ticketType.name}
                  </Text>
                  <Text style={styles.price}>{priceLabel}</Text>
                </View>
                {/* Window state on its own line — a DIFFERENT fact from "sold
                    out", so a tier that is both stays honest about both. Full
                    strength on purpose: this is the sentence that explains the
                    dead stepper beside it. */}
                {saleState.note ? (
                  <Text
                    style={styles.saleNote}
                    testID={`sale-note-${ticketType.id}`}
                  >
                    {saleState.note}
                  </Text>
                ) : null}
              </View>
              {unavailable ? (
                soldOut ? (
                  // NOT dimmed. When a tier is sold out inside its sale window
                  // there is no stepper and no `saleNote`, so this is the ONLY
                  // text explaining the missing control — the same role the
                  // note plays, and the same reason it must stay legible.
                  <Text style={styles.soldOut}>Sold out</Text>
                ) : null
              ) : (
                <View
                  style={styles.stepper}
                  accessible
                  accessibilityRole="adjustable"
                  accessibilityLabel={`${ticketType.name} quantity`}
                  accessibilityValue={{ text: `${qty} selected` }}
                  accessibilityActions={[
                    { name: "increment" },
                    { name: "decrement" },
                  ]}
                  onAccessibilityAction={(event) => {
                    if (event.nativeEvent.actionName === "increment") {
                      onIncrement(ticketType);
                    } else if (event.nativeEvent.actionName === "decrement") {
                      onDecrement(ticketType);
                    }
                  }}
                >
                  <StepperButton
                    label="−"
                    accessibilityLabel={`Remove one ${ticketType.name} ticket`}
                    onPress={() => onDecrement(ticketType)}
                    disabled={qty === 0}
                    testID={`stepper-decrement-${ticketType.id}`}
                  />
                  <Text
                    style={styles.stepperCount}
                    testID={`qty-${ticketType.id}`}
                  >
                    {qty}
                  </Text>
                  <StepperButton
                    label="+"
                    accessibilityLabel={`Add one ${ticketType.name} ticket`}
                    onPress={() => onIncrement(ticketType)}
                    disabled={qty >= maxQty}
                    testID={`stepper-increment-${ticketType.id}`}
                  />
                </View>
              )}
            </View>
            {ticketType.pricingMode === "ADJUSTABLE" && qty > 0 ? (
              <AdjustableAmountField
                ticketType={ticketType}
                currency={currency}
                valueCents={item?.donationAmountCents ?? 0}
                onCommit={(cents) => onDonationChange(ticketType, cents)}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    list: {
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surfaceMuted,
    },
    row: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.borderColorSoft,
    },
    // Last row: the container's own 2px border closes the list — a 1px
    // borderBottom here would double up against it.
    rowLast: { borderBottomWidth: 0 },
    // Applied to the row's CONTENT, never to the row itself, and never to
    // `saleNote`. Dimming the whole row also dimmed the one sentence that
    // explains WHY the row is dead ("On sale Friday at 10am"), pushing it to
    // roughly 2.2:1. The disabled control is exempt from the contrast rules;
    // the sentence explaining it is not. Opacity multiplies down the tree, so
    // a nested override cannot claw contrast back — the note has to sit
    // OUTSIDE anything carrying this style.
    contentUnavailable: { opacity: 0.5 },
    rowMain: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    rowInfo: { flex: 1, gap: 2 },
    rowInfoPrimary: { gap: 2 },
    name: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 15,
      fontWeight: "700",
      lineHeight: 20,
    },
    price: {
      color: c.accentText,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 14,
      fontWeight: "700",
      letterSpacing: 0.5,
    },
    saleNote: {
      color: c.colorMuted,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 13,
      fontWeight: "700",
      lineHeight: 18,
    },
    soldOut: {
      color: c.colorMuted,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    stepper: {
      flexDirection: "row",
      alignItems: "center",
      gap: 0,
    },
    stepperButton: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surface,
    },
    stepperButtonPressed: {
      backgroundColor: c.structure,
      borderColor: c.structure,
    },
    stepperButtonDisabled: {
      backgroundColor: c.surfaceMuted,
      borderColor: c.borderColorSoft,
    },
    stepperButtonText: {
      fontFamily: "Montserrat-SemiBold",
      fontSize: 20,
      fontWeight: "700",
      lineHeight: 24,
    },
    stepperCount: {
      minWidth: 44,
      textAlign: "center",
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 16,
      fontWeight: "700",
      fontVariant: ["tabular-nums"],
    },
    amountField: { gap: 6 },
    amountLabel: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 12,
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    amountHelper: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 13,
      lineHeight: 18,
    },
    emptyText: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 20,
    },
  });
