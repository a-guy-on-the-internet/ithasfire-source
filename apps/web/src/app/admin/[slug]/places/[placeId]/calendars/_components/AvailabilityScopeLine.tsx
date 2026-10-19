"use client";

import { XStack } from "tamagui";
import { Building2, CalendarRange } from "lucide-react";
import { Text, useTranslations } from "@th/ui";

import type { AvailabilityScope } from "./venue-calendars-helpers";

export interface AvailabilityScopeLineProps {
  /** `null` = the place-wide "All calendars" scope. */
  scope: AvailabilityScope;
  /** Visible name of the selected scope. */
  scopeLabel: string;
}

/**
 * "APPLIES TO: <scope>" — the standing reminder that sits next to every
 * availability write surface (each editor's heading, and the blackout add
 * form).
 *
 * The scope used to reach these editors as props that only ever surfaced in
 * `aria-label`s, so a sighted owner editing Thursday's hours had no visible
 * signal that the rows were landing venue-wide. This is deliberately plain
 * text, not a badge: a long calendar name wraps here instead of truncating,
 * and truncating the one fact the line exists to state would defeat it.
 */
export function AvailabilityScopeLine({
  scope,
  scopeLabel,
}: AvailabilityScopeLineProps) {
  const t = useTranslations();
  const Icon = scope === null ? Building2 : CalendarRange;

  return (
    <XStack gap="$1" alignItems="center" flexWrap="wrap">
      {/* `style`, not a `flexShrink` prop: lucide spreads unknown props onto
          the <svg>, and React would log an invalid-DOM-attribute error. */}
      <Icon
        size={13}
        color="var(--color, #211C16)"
        aria-hidden
        style={{ flexShrink: 0 }}
      />
      {/* flexBasis 200 (NOT flex:1's 0% basis, which never triggers flexWrap):
          a long calendar name wraps onto its own full-width line at 320px
          instead of pushing past the container. */}
      <Text variant="overline" flexGrow={1} flexShrink={1} flexBasis={200}>
        {String(t("admin.calMgrScopeAppliesTo", { scope: scopeLabel }))}
      </Text>
    </XStack>
  );
}
