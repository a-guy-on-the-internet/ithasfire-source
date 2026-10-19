"use client";

import type { ReactNode } from "react";
import { styled, YStack } from "tamagui";

import { Checkbox, Text, useTranslations } from "@th/ui";
import {
  CURRENT_CHARGEBACK_TERMS_TEXT,
  CURRENT_CHARGEBACK_TERMS_VERSION,
} from "@th/core/lib/payments/chargeback-terms";

/**
 * The organizer chargeback / payout-hold terms, rendered the same way on the
 * two surfaces that record acceptance:
 *
 *   • the event builder's pre-publish dialog (`BuilderPublishDialogs.tsx`) —
 *     the version-agnostic backstop, and
 *   • the payouts page (`admin/[slug]/payouts`, Stripe account) — the strict gate, since
 *     `stripeConnect.initiateOnboarding` refuses an owner without a
 *     CURRENT-version acceptance.
 *
 * The text and version come straight from `@th/core` (same source the server
 * snapshots into the acceptance record), never from a copy in the web app.
 */

export const CHARGEBACK_TERMS_VERSION = CURRENT_CHARGEBACK_TERMS_VERSION;

const CHARGEBACK_TERMS_PARAGRAPHS: readonly string[] =
  CURRENT_CHARGEBACK_TERMS_TEXT.split("\n\n");

const TermsScroll = styled(YStack, {
  name: "ChargebackTermsScroll",
  gap: "$3",
  overflow: "scroll",
  paddingVertical: "$3",
  borderRadius: 0,
  // The region is a keyboard tab stop (`tabIndex=0`) so its overflow is
  // reachable without a pointer; the ring makes that stop visible.
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$focus",
    outlineOffset: 2,
  },
  variants: {
    frame: {
      // Builder dialog: top/bottom rules only (the Modal supplies the box).
      rules: {
        borderTopWidth: 2,
        borderTopColor: "$borderColorStrong",
        borderBottomWidth: 2,
        borderBottomColor: "$borderColorStrong",
      },
      // Inline on a page: a full visible border, strict Swiss.
      box: {
        borderWidth: 1,
        borderColor: "$borderColor",
        paddingHorizontal: "$3",
        backgroundColor: "$surface",
      },
    },
  } as const,
  defaultVariants: {
    frame: "rules",
  },
});

export type ChargebackTermsBodyProps = {
  /** `rules` (dialog, default) or `box` (inline on a page). */
  frame?: "rules" | "box";
  /** Bounded height so the terms never become a wall. */
  maxHeight?: number;
  /**
   * Taller bound below the `sm` breakpoint, where the column is narrow and
   * each paragraph wraps to many more lines. Defaults to `maxHeight`.
   */
  maxHeightMobile?: number;
  /** DOM id — lets a disclosure button point at the region via `aria-controls`. */
  id?: string;
  /** Accessible name for the region. Defaults to the terms title. */
  "aria-label"?: string;
  testId?: string;
};

/**
 * Every paragraph of the terms in a bounded, scrollable, keyboard-reachable
 * region. The count is whatever `CURRENT_CHARGEBACK_TERMS_TEXT` splits into —
 * nothing here truncates or assumes a fixed number.
 */
export function ChargebackTermsBody({
  frame = "rules",
  maxHeight = 260,
  maxHeightMobile,
  id,
  "aria-label": ariaLabel,
  testId,
}: ChargebackTermsBodyProps) {
  const t = useTranslations();

  return (
    <TermsScroll
      frame={frame}
      id={id}
      role="region"
      tabIndex={0}
      aria-label={ariaLabel ?? String(t("admin.ebChargebackTermsTitle"))}
      maxHeight={maxHeightMobile ?? maxHeight}
      $gtSm={{ maxHeight }}
      data-testid={testId}
    >
      {CHARGEBACK_TERMS_PARAGRAPHS.map((paragraph) => (
        <Text key={paragraph} variant="bodySmall">
          {paragraph}
        </Text>
      ))}
    </TermsScroll>
  );
}

export type ChargebackTermsAcceptCheckboxProps = {
  /** Unique per page — the checkbox id and the default `testIdBase`. */
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Overrides the builder's checkout/publish-flavoured helper line. */
  description?: ReactNode;
  testIdBase?: string;
};

/**
 * The single acceptance control. Both surfaces use the same label so the
 * acknowledgement reads identically wherever it is recorded.
 */
export function ChargebackTermsAcceptCheckbox({
  id,
  checked,
  onCheckedChange,
  disabled,
  description,
  testIdBase,
}: ChargebackTermsAcceptCheckboxProps) {
  const t = useTranslations();

  return (
    <Checkbox
      id={id}
      label={String(t("admin.ebChargebackTermsCheckboxLabel"))}
      description={
        description ?? String(t("admin.ebChargebackTermsCheckboxDescription"))
      }
      checked={checked}
      onCheckedChange={(next) => {
        onCheckedChange(next === true);
      }}
      disabled={disabled}
      size="md"
      testIdBase={testIdBase ?? id}
    />
  );
}
