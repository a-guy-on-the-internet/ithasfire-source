"use client";

// Temporary local stand-ins for @th/ui Money/DateTime, which are not in main
// yet; swap back when they land. Mirrors `Money`'s props and its
// `Money.format()` string form so the call sites change import + tag only.

import { memo } from "react";
import { Text, type TextProps } from "@th/ui";
import { formatCents } from "@th/core/lib/currency-utils";

export interface MoneyTextFormatOptions {
  /** ISO 4217. Default "USD". */
  currency?: string;
  /** BCP-47. Default "en-US". */
  locale?: string;
}

export interface MoneyTextProps
  extends Omit<TextProps, "children">,
    MoneyTextFormatOptions {
  /** Integer minor units. Floats are a bug; bigint is accepted for core math. */
  cents: number | bigint;
}

/**
 * The string form — CSV, email, `aria-label`, print. `formatCents` handles
 * zero-decimal currencies (JPY etc.) via `currencyFractionDigits`.
 */
const format = (
  cents: number | bigint,
  { currency = "USD", locale = "en-US" }: MoneyTextFormatOptions = {},
): string =>
  formatCents(typeof cents === "bigint" ? Number(cents) : cents, currency, locale);

// Tabular figures are not cosmetic: proportional digits stop a column of
// amounts lining up on the decimal.
const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

const MoneyTextComponent = memo<MoneyTextProps>(function MoneyText({
  cents,
  currency,
  locale,
  fontFamily = "$mono",
  style,
  ...textProps
}) {
  return (
    <Text fontFamily={fontFamily} style={[TABULAR, style] as never} {...textProps}>
      {format(cents, { currency, locale })}
    </Text>
  );
});

export const MoneyText = Object.assign(MoneyTextComponent, { format });
