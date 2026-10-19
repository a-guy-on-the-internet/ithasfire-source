"use client";

import { XStack, YStack } from "tamagui";
import { Building2, CalendarRange } from "lucide-react";
import { StyledSelect, Text, useTranslations } from "@th/ui";

import type { AvailabilityScope } from "./venue-calendars-helpers";

const SELECT_ID = "availability-scope-select";
const STATEMENT_ID = "availability-scope-statement";

export interface AvailabilityScopePanelProps {
  /** Current select value (the sentinel for place-wide, or a calendar id). */
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  /** Resolved scope the editors below write to. `null` = place-wide. */
  scope: AvailabilityScope;
  /** Visible name of the selected scope. */
  scopeLabel: string;
}

/**
 * The "Applies to" control and the SENTENCE that resolves it, as one object.
 *
 * The scope select used to sit on its own as a small unlabelled dropdown, so
 * an owner could open this page, set Thursday's hours, and never register that
 * they'd written VENUE-WIDE rows — the default scope is place-wide
 * (`calendarId: null`), which is correct but invisible. Pairing the control
 * with a statement of its consequence ("…apply to every calendar at this
 * venue") makes the broad scope impossible to edit past.
 *
 * Place-wide gets the heavier treatment (accent rule, raised fill): it is the
 * default AND the more consequential of the two, so it's the one that must
 * announce itself. Accent is used only as a 6px rule — it carries no text
 * (`$accent` has no AA foreground in either polarity).
 */
export function AvailabilityScopePanel({
  value,
  options,
  onChange,
  scope,
  scopeLabel,
}: AvailabilityScopePanelProps) {
  const t = useTranslations();
  const isPlaceWide = scope === null;
  const scopeLabelText = String(t("admin.calMgrScopeLabel"));

  return (
    <YStack
      gap="$2"
      padding="$3"
      // Sides written out rather than `borderWidth` + a `borderLeftWidth`
      // override: shorthand-vs-longhand ordering in the generated atomic CSS
      // is not something to bet a 6px rule on.
      borderTopWidth={2}
      borderRightWidth={2}
      borderBottomWidth={2}
      borderLeftWidth={6}
      borderTopColor="$borderColor"
      borderRightColor="$borderColor"
      borderBottomColor="$borderColor"
      // Accent as a RULE only — `$accent` has no AA foreground in either
      // polarity, so no text ever sits on it.
      borderLeftColor={isPlaceWide ? "$accent" : "$borderColor"}
      backgroundColor={isPlaceWide ? "$surfaceRaised" : "transparent"}
      testID={
        isPlaceWide ? "availability-scope-all" : "availability-scope-calendar"
      }
    >
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        {isPlaceWide ? (
          <Building2 size={16} color="var(--color, #211C16)" aria-hidden />
        ) : (
          <CalendarRange size={16} color="var(--color, #211C16)" aria-hidden />
        )}
        <Text tag="label" htmlFor={SELECT_ID} variant="overline">
          {scopeLabelText}
        </Text>
      </XStack>

      {/* maxWidth on the wrapper, not the select: at 320px the select still
          fills the panel, and it never stretches past a readable measure on a
          wide admin viewport. */}
      <YStack maxWidth={320} width="100%">
        <StyledSelect
          value={value}
          options={options}
          onChange={onChange}
          fullWidth
          selectId={SELECT_ID}
          ariaLabel={scopeLabelText}
          ariaDescribedBy={STATEMENT_ID}
          testId="availability-scope"
        />
      </YStack>

      <Text id={STATEMENT_ID} variant="bodySmall">
        {isPlaceWide
          ? String(t("admin.calMgrScopeStatementAll"))
          : String(
              t("admin.calMgrScopeStatementCalendar", {
                calendar: scopeLabel,
              }),
            )}
      </Text>
    </YStack>
  );
}
