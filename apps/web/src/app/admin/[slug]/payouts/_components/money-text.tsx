"use client";

import { Text, monoScale, type TextProps } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// Money in a table cell or a breakdown row: IBM Plex Mono at the `lg` rung
// (13px / 0.4px), the design system's "prices, large meta" pair, with tabular
// digits so columns of figures align. One component so the ledger, the
// tranche gross and the line amounts cannot drift onto different faces.
// The register's three headline figures are the exception and stay on
// Montserrat 700 — they are display type, not a column.
// ─────────────────────────────────────────────────────────────────────────────

const figureStyle = { fontVariantNumeric: "tabular-nums" } as const;

export function MoneyText({ style, ...props }: TextProps) {
  return (
    <Text
      variant="body"
      fontFamily="$mono"
      fontSize={monoScale.lg.fontSize}
      letterSpacing={monoScale.lg.letterSpacing}
      lineHeight={20}
      style={[figureStyle, ...(Array.isArray(style) ? style : style ? [style] : [])]}
      {...props}
    />
  );
}
