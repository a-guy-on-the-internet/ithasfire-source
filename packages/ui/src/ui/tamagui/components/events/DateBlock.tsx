import { memo } from "react";
import { Platform } from "react-native";
import { YStack, styled, type GetProps } from "tamagui";

import { Text } from "../typography/Text";

/**
 * DateBlock — Design System v2 molecule (section 05).
 *
 * The date as an object: a torn-off column of month / day / weekday. Shared by
 * the Ticket Stub, the wallet card and standalone date callouts, which is what
 * makes a browse card, a wallet row and a printed ticket read as one family.
 * Content only — callers own any framing border.
 *
 * The month and weekday are tracked-uppercase micro-labels and ride IBM Plex
 * Mono (2026-08-26). The day numeral does NOT: at 36px/900 it is display type,
 * and the sans is what carries display weight in this system.
 */
const DateBlockFrame = styled(YStack, {
  name: "DateBlock",
  alignItems: "center",
  gap: 2,
  paddingVertical: "$4",
  paddingHorizontal: "$3",
});

export interface DateBlockProps extends Omit<
  GetProps<typeof DateBlockFrame>,
  "children"
> {
  /** Short month label, e.g. "Aug" (rendered uppercase). */
  month: string;
  /** Day of month, e.g. "15" / "02". */
  day: string;
  /** Short weekday label, e.g. "Sat" (rendered uppercase). */
  weekday?: string;
  testId?: string;
}

const isWeb = Platform.OS === "web";

export const DateBlock = memo<DateBlockProps>(
  ({ month, day, weekday, testId, ...rest }) => (
    <DateBlockFrame
      {...(testId
        ? isWeb
          ? { "data-testid": testId }
          : { testID: testId }
        : {})}
      {...rest}
    >
      {/* The mono label idiom at the `xs` rung — 10px / 2.5px / 600. */}
      <Text
        variant="overline"
        fontSize={10}
        lineHeight={13}
        letterSpacing={2.5}
        tone="accent"
        textAlign="center"
      >
        {month}
      </Text>
      {/* v2 .dateblock .day — 900 / 36px / line-height 1 / -1 tracking */}
      <Text
        variant="span"
        fontFamily="$heading"
        fontSize={36}
        lineHeight={36}
        letterSpacing={-1}
        weight="black"
        textAlign="center"
      >
        {day}
      </Text>
      {weekday ? (
        // Same idiom, muted — the weekday is context, not the headline.
        <Text
          variant="overline"
          fontSize={10}
          lineHeight={12}
          letterSpacing={2}
          tone="muted"
          textAlign="center"
        >
          {weekday}
        </Text>
      ) : null}
    </DateBlockFrame>
  ),
);

DateBlock.displayName = "DateBlock";
