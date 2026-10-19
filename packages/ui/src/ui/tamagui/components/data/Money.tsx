import { memo } from "react";
import {
  formatMoneyCents,
  formatPriceCents,
  type FormatMoneyCentsOptions,
} from "@th/types";

import { Text, type TextProps } from "../typography/Text";

/**
 * The money primitive. Every amount the product renders goes through this.
 *
 * Two things it enforces that were previously decided per call site:
 *
 * **Integers in cents, never floats.** The prop is `cents`, and a float is a
 * type error rather than a rounding bug discovered at settlement. There were 48
 * files hand-rolling `Intl.NumberFormat` or `.toFixed(2)` when this landed;
 * every one of them was a chance for a price on a card, in a table and on a
 * printed ticket to disagree by a cent or a symbol.
 *
 * **Cents are shown or hidden deliberately.** `$45` beside `$8.74` reads as a
 * mistake, so any column of figures passes `showCents="always"`. Discovery
 * surfaces — a card badge, a price range — use `"auto"`, where a whole amount
 * drops its fraction.
 *
 * `Money.format()` returns the same string without rendering, for CSV, email
 * subject lines and print. Same rule, one implementation.
 */

export type MoneyShowCents =
  /** `4500 → "$45"`, `4550 → "$45.50"`. Discovery and browse surfaces. */
  | "auto"
  /** `4500 → "$45.00"`. Any column of figures — summaries, tables, receipts. */
  | "always";

export interface MoneyProps extends Omit<TextProps, "children"> {
  /** Integer minor units. Floats are a bug; bigint is accepted for core math. */
  cents: number | bigint;
  /** ISO 4217. Default "USD". */
  currency?: string;
  /** BCP-47. Default "en-US". */
  locale?: string;
  /** Default `"always"` — the safe choice, since a stray `$45` in a column of
      cents is the more damaging error. */
  showCents?: MoneyShowCents;
  /**
   * How to render exactly zero.
   *
   * `"amount"` (default) renders `$0.00`. `"free"` renders the word FREE.
   *
   * The design system's own `Money` renders FREE at zero unconditionally; this
   * one does not, deliberately. A zero TAX row, a zero FEE row and a zero
   * REFUND row are all legitimately `$0.00`, and a component cannot tell them
   * apart from a free ticket by looking at the number. Price surfaces opt in.
   */
  zero?: "amount" | "free";
  /** The word rendered when `zero="free"`. Translate at the call site. */
  freeLabel?: string;
}

const formatValue = (
  cents: number | bigint,
  showCents: MoneyShowCents,
  options: FormatMoneyCentsOptions,
): string =>
  showCents === "always"
    ? formatMoneyCents(cents, options)
    : formatPriceCents(cents, options);

// Tabular figures are not cosmetic: proportional digits stop a column of
// prices lining up on the decimal, which is the one thing a column of prices
// exists to do. Applied via `style` — Tamagui's Paragraph has no prop for it.
const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

const MoneyComponent = memo<MoneyProps>(function Money({
  cents,
  currency,
  locale,
  showCents = "always",
  zero = "amount",
  freeLabel = "FREE",
  style,
  ...textProps
}) {
  const isZero = typeof cents === "bigint" ? cents === 0n : cents === 0;

  if (isZero && zero === "free") {
    return (
      <Text
        // The support amber is reserved for exactly two things, and this is
        // one of them (the other is a claimed bar past 80%). It is not a
        // general-purpose highlight.
        color="$support"
        style={[TABULAR, style] as never}
        {...textProps}
      >
        {freeLabel}
      </Text>
    );
  }

  return (
    <Text style={[TABULAR, style] as never} {...textProps}>
      {formatValue(cents, showCents, { currency, locale })}
    </Text>
  );
});

/**
 * The string form. Same rule as the component, for contexts that cannot render
 * one — CSV cells, email subjects, `aria-label`s, print templates.
 */
const format = (
  cents: number | bigint,
  {
    showCents = "always",
    ...options
  }: FormatMoneyCentsOptions & { showCents?: MoneyShowCents } = {},
): string => formatValue(cents, showCents, options);

export const Money = Object.assign(MoneyComponent, { format });
