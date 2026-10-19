"use client";

import type { ReactNode } from "react";
import { styled, YStack } from "tamagui";

import { Text } from "@th/ui";

/**
 * The notice strip of the price panel: why a price can't be set, what a
 * scheduled change does, what is wrong with a stored price.
 *
 * Same treatment as the builder's `EventTimezoneNote` strip (`AdoptedNote`,
 * which is not exported): square, a 2px accent rule on the leading edge, muted
 * fill. Accent is the rule only, never the text, so it reads as an aside the
 * organizer should see before typing, not as an error.
 */
const Strip = styled(YStack, {
  paddingVertical: 8,
  paddingHorizontal: 10,
  borderRadius: 0,
  borderLeftWidth: 2,
  borderLeftColor: "$accent",
  backgroundColor: "$surfaceMuted",
  gap: 6,
});

export type SeatPriceNoticeProps = {
  /** The bold lead sentence: the fact. */
  title: string;
  /** What it means for the seats, in plain words. */
  children?: ReactNode;
  /** A link out (payouts, contact). At most one. */
  action?: ReactNode;
  testId?: string;
};

export function SeatPriceNotice({
  title,
  children,
  action,
  testId,
}: SeatPriceNoticeProps) {
  return (
    <Strip role="note" data-testid={testId}>
      <Text variant="caption">
        <Text tag="span" variant="caption" weight="bold">
          {title}
        </Text>
        {children ? <> {children}</> : null}
      </Text>
      {action}
    </Strip>
  );
}

SeatPriceNotice.displayName = "SeatPriceNotice";
