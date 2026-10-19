"use client";

import React from "react";
import { YStack } from "tamagui";
import { Text } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// The three primitives every section of the expanded order panel is built
// from. They live here rather than inside `OrderDetailPanel` so a sibling
// section (`OrderSplitsSection`) can reuse them instead of growing a second,
// slightly-different copy of the same rule and letting the two drift.
// ─────────────────────────────────────────────────────────────────────────────

/** The hairline that opens a new section. Rule above, never a boxed card. */
export function SectionDivider() {
  return (
    <YStack paddingTop="$2" borderTopWidth={1} borderTopColor="$borderColor" />
  );
}

/**
 * A section's label. `id` is optional but should be supplied (and scoped by
 * order id) when the section is wrapped in `aria-labelledby` — several order
 * panels can be expanded at once, so an unscoped id would be duplicated in the
 * document.
 */
export function SectionHeader({
  children,
  id,
}: {
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <Text variant="overline" id={id}>
      {children}
    </Text>
  );
}

/**
 * An id/code run. Select-all so support can copy it in one click.
 *
 * NOTE: still on Montserrat with an explicit size rather than the mono label
 * idiom — the panel predates the two-font decision (2026-08-26), under which
 * ids and codes belong to IBM Plex Mono. Moving it is a visual change to every
 * id in the panel and is deliberately left to its own pass; amounts already
 * route through `MoneyText`, which is on `$mono`.
 */
export function MonoText({
  children,
  size = 12,
}: {
  children: React.ReactNode;
  size?: number;
}) {
  return (
    <Text
      variant="body"
      style={{
        fontSize: size,
        userSelect: "all",
      }}
    >
      {children}
    </Text>
  );
}
