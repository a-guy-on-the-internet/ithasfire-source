/**
 * The cart's totals, as the server quoted them: Card | Cash side by side
 * (owner pick, board S2-OptionB).
 *
 * Every figure comes from `pos.quoteCart`. The two columns differ because a
 * card carries the platform and processing fees online checkout charges, and
 * cash carries the tax and neither fee (owner ruling 2026-10-08). While the
 * server hasn't answered for this exact cart the amounts read "—" rather than
 * a number the till won't charge.
 *
 * Tax lookup down (board S4): the total stays "—" and the refusal says why,
 * who can fix it, and that a comp still works.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Text as RNText, StyleSheet, View } from "react-native";

import { Text } from "@th/ui";
import {
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { monoLabel } from "../../ui/mono-label";

import { saleErrorMessage } from "./promo-entry";
import { DangerPanel } from "./sale-notices";
import {
  breakdownRows,
  columnReserveText,
  formatMoney,
  sharedColumnWidth,
  taxRefusalNextStep,
  type BreakdownRow,
  type QuoteState,
} from "./sell-quote";

const DASH = "—";

/** Every amount cell's id for this state (heads, rows, totals). */
function columnCells(state: QuoteState): string[] {
  const quote =
    state.kind === "ready"
      ? state.quote
      : state.kind === "updating"
        ? state.last
        : null;
  const keys = quote ? breakdownRows(quote).map((r) => r.key) : ["subtotal"];
  return ["head", ...keys, "total"].flatMap((k) => [`${k}-card`, `${k}-cash`]);
}

export function QuoteBreakdown({
  state,
  cartCount,
  currency,
  onRetry,
}: {
  state: QuoteState;
  cartCount: number;
  currency: string;
  onRetry: () => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const column = useSharedColumn(columnCells(state), state.kind === "ready");
  const reserveText = columnReserveText(currency);

  if (state.kind === "tax-refused" || state.kind === "error") {
    return (
      <View style={styles.footer} testID="sell-quote-refused">
        <SingleTotalRow />
        {state.kind === "tax-refused" ? (
          <DangerPanel
            title="Tax can't be worked out right now"
            testID="sell-tax-refused"
          >
            <Text variant="bodySmall" color={colors.color} style={styles.copy}>
              The tax lookup isn't answering, so this event can't take
              payments yet. Nothing was charged.
            </Text>
            <Text
              variant="bodySmall"
              color={colors.color}
              style={styles.copy}
              testID="sell-tax-refused-next-step"
            >
              {taxRefusalNextStep(state.canEnterManualTaxRate)}
            </Text>
            <SquareSecondaryButton
              testID="sell-quote-retry"
              label={state.retrying ? "Trying again…" : "Try again"}
              onPress={onRetry}
              disabled={state.retrying}
            />
          </DangerPanel>
        ) : (
          <DangerPanel
            title="Couldn't work out the total"
            testID="sell-quote-error"
          >
            <Text variant="bodySmall" color={colors.color} style={styles.copy}>
              {saleErrorMessage(state.error)}
            </Text>
            <SquareSecondaryButton
              testID="sell-quote-retry"
              label={state.retrying ? "Trying again…" : "Try again"}
              onPress={onRetry}
              disabled={state.retrying}
            />
          </DangerPanel>
        )}
      </View>
    );
  }

  const quote =
    state.kind === "ready"
      ? state.quote
      : state.kind === "updating"
        ? state.last
        : null;
  const settled = state.kind === "ready";
  const rows: BreakdownRow[] = quote
    ? breakdownRows(quote)
    : [{ key: "subtotal", label: "Subtotal", card: null, cash: null }];
  const money = (cents: number | null) =>
    settled && cents !== null ? formatMoney(cents, currency) : DASH;
  // What a screen reader hears for a figure, not "card —".
  const spoken = (cents: number | null, column: "card" | "cash") => {
    if (!settled) return "not available yet";
    if (column === "card" && quote?.card == null) return "not available";
    return cents === null ? "none" : formatMoney(cents, currency);
  };
  const items = `${cartCount} item${cartCount === 1 ? "" : "s"}`;
  const cardTotal = settled && quote?.card ? quote.card.totalCents : null;
  const cashTotal = settled && quote ? quote.cash.totalCents : null;

  return (
    <View
      style={styles.footer}
      testID="sell-quote-breakdown"
      // Read the whole block again when the figures settle, not just the diff.
      accessibilityLiveRegion="polite"
      // Every row spans the footer, so its width is the row width the
      // reserve has to fit beside a label.
      onLayout={(e) => column.reportRow(e.nativeEvent.layout.width)}
    >
      {/* Invisible gauge: the widest figure the columns are sized for, in the
          total's bold face, so "Updating…" and the first settled quote share
          one column width (and the CARD head doesn't move when figures land).
          It gives way when the row can't afford it (`sharedColumnWidth`). */}
      <View
        style={styles.reserve}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onLayout={(e) => column.reportReserve(e.nativeEvent.layout.width)}
      >
        <Text variant="body" weight="bold" style={styles.totalAmount}>
          {reserveText}
        </Text>
      </View>
      <View
        style={styles.row}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {/* The "updating" state sits in the header's empty left cell, so
            nothing below moves when the figures go "—" and come back. */}
        <View style={styles.labelCell}>
          {!settled && (
            <RNText
              style={styles.monoHead}
              numberOfLines={1}
              testID="sell-quote-updating"
            >
              Updating…
            </RNText>
          )}
        </View>
        <Amount column={column} cell="head-card">
          <RNText style={styles.monoHead}>Card</RNText>
        </Amount>
        <Amount column={column} cell="head-cash">
          <RNText style={styles.monoHead}>Cash</RNText>
        </Amount>
      </View>

      {rows.map((row) => {
        const label = row.key === "subtotal" ? `Subtotal · ${items}` : row.label;
        // A discount reads as money taken off: "−$10.00". "—" stays bare.
        const show = (cents: number | null) => {
          const text = money(cents);
          return row.key === "discount" && text !== DASH ? `−${text}` : text;
        };
        const say = (cents: number | null, side: "card" | "cash") => {
          const text = spoken(cents, side);
          return row.key === "discount" && settled && cents !== null
            ? `minus ${text}`
            : text;
        };
        return (
          <View
            key={row.key}
            style={styles.row}
            testID={`sell-quote-row-${row.key}`}
            accessible
            accessibilityLabel={`${label}: card ${say(row.card, "card")}, cash ${say(row.cash, "cash")}`}
          >
            <Text variant="bodySmall" color={colors.color} style={styles.labelCell}>
              {label}
            </Text>
            <Amount column={column} cell={`${row.key}-card`}>
              <Text variant="body" color={colors.color} style={styles.amountText}>
                {show(row.card)}
              </Text>
            </Amount>
            <Amount column={column} cell={`${row.key}-cash`}>
              <Text variant="body" color={colors.color} style={styles.amountText}>
                {show(row.cash)}
              </Text>
            </Amount>
          </View>
        );
      })}

      <View
        style={styles.totalRow}
        testID="sell-quote-total"
        accessible
        accessibilityLabel={`Total: card ${spoken(cardTotal, "card")}, cash ${spoken(cashTotal, "cash")}`}
      >
        {/* Board S2: a thin rule over each total cell, not one across the
            row. The label is always "Total". */}
        <View style={[styles.totalLabelCell, styles.totalRule]}>
          <RNText style={[styles.monoHead, styles.totalLabel]}>Total</RNText>
        </View>
        <View style={styles.totalAmounts}>
          <Amount column={column} cell="total-card" ruled>
            <Text variant="body" weight="bold" style={styles.totalAmount}>
              {money(cardTotal)}
            </Text>
          </Amount>
          <Amount column={column} cell="total-cash" ruled>
            <Text variant="body" weight="bold" style={styles.totalAmount}>
              {money(cashTotal)}
            </Text>
          </Amount>
        </View>
      </View>
    </View>
  );
}

/** The refused/error footer's total: one "—" for the whole row (board S4). */
function SingleTotalRow() {
  const styles = useThemedSheet(makeSheet);
  return (
    <View
      style={styles.totalRow}
      testID="sell-quote-total"
      accessible
      accessibilityLabel="Total: not available"
    >
      <View style={styles.totalLabelCell}>
        <RNText style={[styles.monoHead, styles.totalLabel]}>Total</RNText>
      </View>
      <View style={styles.totalAmounts}>
        <Text variant="body" weight="bold" style={styles.totalAmount}>
          {DASH}
        </Text>
      </View>
    </View>
  );
}

/**
 * One column for every amount: heads, rows and the bold totals share the
 * widest figure's width, so "$47.72" in the total sits flush under "$40.00"
 * at any font scale. Each cell reports its text's NATURAL width (the cell
 * only sets a minimum, so the text never wraps and never measures the
 * column back to itself).
 */
type Column = {
  width: number;
  report: (cell: string, width: number) => void;
  /** The invisible gauge's width (measured in every state). */
  reportReserve: (width: number) => void;
  /** The row's width, which decides whether the gauge applies. */
  reportRow: (width: number) => void;
};

const MIN_COLUMN = 76;
/** The rows' gap (label | card | cash); the reserve's fit counts two. */
const ROW_GAP = 8;

function useSharedColumn(cells: readonly string[], settled: boolean): Column {
  // No reset for an emptied cart: the Sell screen unmounts the breakdown at
  // zero items, so the next cart starts from the minimum on a fresh mount.
  const widths = useRef(new Map<string, number>());
  // Read by `report`, which runs from layout events outside render.
  const settledRef = useRef(settled);
  settledRef.current = settled;
  const reserve = useRef<number | null>(null);
  const rowWidth = useRef<number | null>(null);
  const [width, setWidth] = useState(MIN_COLUMN);
  const recompute = useCallback(() => {
    const next = sharedColumnWidth({
      min: MIN_COLUMN,
      cells: widths.current.values(),
      reserve: reserve.current,
      rowWidth: rowWidth.current,
      gap: ROW_GAP,
    });
    setWidth((prev) => (prev === next ? prev : next));
  }, []);
  const report = useCallback(
    (cell: string, measured: number) => {
      // While the quote updates the cells show "—": measuring them would
      // shrink the column to its minimum and grow it again with the figures.
      // The column keeps its last settled width until figures return; the
      // reserve gauge (reported separately) is its floor in every state.
      if (!settledRef.current) return;
      const w = Math.ceil(measured);
      if (widths.current.get(cell) === w) return;
      widths.current.set(cell, w);
      recompute();
    },
    [recompute],
  );
  const reportReserve = useCallback(
    (measured: number) => {
      const w = Math.ceil(measured);
      if (reserve.current === w) return;
      reserve.current = w;
      recompute();
    },
    [recompute],
  );
  const reportRow = useCallback(
    (measured: number) => {
      const w = Math.floor(measured);
      if (rowWidth.current === w) return;
      rowWidth.current = w;
      recompute();
    },
    [recompute],
  );
  // A row that went away (a discount removed) stops holding the column wide.
  const signature = cells.join("|");
  useEffect(() => {
    if (!settled) return;
    const live = new Set(signature.split("|"));
    let pruned = false;
    for (const key of [...widths.current.keys()]) {
      if (!live.has(key)) {
        widths.current.delete(key);
        pruned = true;
      }
    }
    if (pruned) recompute();
  }, [signature, settled, recompute]);
  return useMemo(
    () => ({ width, report, reportReserve, reportRow }),
    [width, report, reportReserve, reportRow],
  );
}

function Amount({
  column,
  cell,
  ruled = false,
  children,
}: {
  column: Column;
  cell: string;
  ruled?: boolean;
  children: ReactNode;
}) {
  const styles = useThemedSheet(makeSheet);
  return (
    <View
      style={[styles.amountCell, { minWidth: column.width }, ruled && styles.totalRule]}
    >
      {/* Content-sized (the cell aligns it to the end), so this measures
          the figure itself. */}
      <View onLayout={(e) => column.report(cell, e.nativeEvent.layout.width)}>
        {children}
      </View>
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    // Thick top rule: the Swiss separator between the catalogue and money.
    footer: {
      paddingTop: 16,
      borderTopWidth: 2,
      borderTopColor: colors.borderColor,
      marginTop: 8,
      gap: 10,
    },
    reserve: {
      position: "absolute",
      top: 0,
      left: 0,
      opacity: 0,
      alignSelf: "flex-start",
    },
    row: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: ROW_GAP,
    },
    // The label wraps under a large font scale; the amounts never do.
    labelCell: { flex: 1, minWidth: 0 },
    // minWidth comes from the shared column (`useSharedColumn`).
    amountCell: { flexShrink: 0, alignItems: "flex-end" },
    amountText: { textAlign: "right", fontVariant: ["tabular-nums"] },
    copy: { lineHeight: 20 },
    // The DS mono label idiom: column heads and the TOTAL label (board S2).
    monoHead: { ...monoLabel, color: colors.colorMuted },
    // Tops aligned, so the three rules line up. "TOTAL" never breaks
    // mid-word: under a large font scale the two totals wrap to their own
    // line, still flush right under their columns.
    totalRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "flex-start",
      gap: 8,
    },
    totalRule: {
      borderTopWidth: 1,
      borderTopColor: colors.borderColorSoft,
      paddingTop: 8,
    },
    totalLabelCell: { flexGrow: 1, flexShrink: 0 },
    // Same line box as the totals, nudged so the small mono label sits on
    // (about) the totals' baseline.
    totalLabel: { lineHeight: 26, paddingTop: 4 },
    totalAmounts: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      marginLeft: "auto",
    },
    totalAmount: {
      fontSize: 20,
      lineHeight: 26,
      color: colors.color,
      textAlign: "right",
      fontVariant: ["tabular-nums"],
    },
  });
