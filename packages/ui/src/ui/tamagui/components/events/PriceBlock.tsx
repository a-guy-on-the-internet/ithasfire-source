import { memo } from "react";
import { Platform } from "react-native";
import { YStack, styled, useThemeName, type GetProps } from "tamagui";

import { spaceTokens } from "../../tokens/space";
import { Text } from "../typography/Text";

/**
 * PriceBlock — Design System v2 molecule (section 05).
 *
 * Centered column on the accent fill: 700 tabular-figure amount over a 600
 * uppercase label (Montserrat). Foreground is `$onBrandSecondary` (ink on
 * orange) — NEVER white on
 * the orange fill (3.16:1, fails AA; see colors.ts). The `free` variant swaps
 * to the amber support fill with `$onSupport` ink.
 */
/**
 * The block's vertical metrics, as the numbers the JSX below actually uses.
 *
 * Exported because the poster hard-codes this block's height:
 * `POSTER_PRICE_BLOCK_H` in `EventCard.tsx` is derived from
 * {@link PRICE_BLOCK_HEIGHT}, and the poster's scrim uses it to stop its
 * content column above the block. Change a line-height or the padding here and
 * the constant follows; `PriceBlock.test.tsx` checks the rendered block uses
 * these same numbers, so a literal typed straight into the JSX fails there
 * instead of printing the ledger's bottom row under the block.
 *
 * `paddingY` is READ from the `$3` space token rather than restated, so the
 * frame's `paddingVertical: "$3"` and this arithmetic cannot disagree about
 * what `$3` is.
 */
export const PRICE_BLOCK_METRICS = {
  paddingY: spaceTokens.$3,
  amountLineHeight: 21,
  gap: 3,
  labelLineHeight: 12,
} as const;

/** Height of a LABELLED block on one line per row: 12 + 21 + 3 + 12 + 12. */
export const PRICE_BLOCK_HEIGHT =
  PRICE_BLOCK_METRICS.paddingY * 2 +
  PRICE_BLOCK_METRICS.amountLineHeight +
  PRICE_BLOCK_METRICS.gap +
  PRICE_BLOCK_METRICS.labelLineHeight;

const PriceBlockFrame = styled(YStack, {
  name: "PriceBlock",
  alignItems: "center",
  justifyContent: "center",
  gap: PRICE_BLOCK_METRICS.gap,
  // `$3` — PRICE_BLOCK_METRICS.paddingY reads this token's value.
  paddingVertical: "$3",
  paddingHorizontal: "$4",
  minWidth: 84,
  backgroundColor: "$brandSecondary",

  variants: {
    free: {
      true: {
        backgroundColor: "$support",
      },
      false: {},
    },
    /**
     * Sold out — the QUIET block (v2 `.priceblock--soldout`): raised surface,
     * muted ink. It is quiet, not dimmed. Nothing here drops opacity: a
     * sold-out event at 42% reads as a rendering fault rather than as
     * unavailable, and sold-out events are social proof a thin marketplace
     * needs (DS D-093).
     */
    soldOut: {
      true: {
        backgroundColor: "$surfaceRaised",
      },
      false: {},
    },
  } as const,

  defaultVariants: {
    free: false,
    soldOut: false,
  },
});

export interface PriceBlockProps extends Omit<
  GetProps<typeof PriceBlockFrame>,
  "children" | "free" | "soldOut"
> {
  /** Price amount, e.g. "$45" or "FREE". */
  amount: string;
  /** Small uppercase context label, e.g. "From" / "RSVP". */
  label?: string;
  /** Free/RSVP variant — amber support fill with ink foreground. */
  free?: boolean;
  /**
   * Sold out — quiet raised-surface block with muted ink. Wins over `free`
   * when both are set: a sold-out free event is sold out first.
   */
  soldOut?: boolean;
  /**
   * Hold the amount and the label to ONE line each (`white-space: nowrap`).
   *
   * Off by default: a block in flow — the `TicketStub`'s price column — must
   * wrap a long localised label rather than grow sideways past its frame. The
   * POSTER passes it, because there the block's height is a compile-time
   * constant ({@link PRICE_BLOCK_HEIGHT}) and a wrapped row would make the real
   * block taller than the space the scrim clears for it. Overflowing sideways
   * is free there: the block is anchored `right: 0 / bottom: 0` and grows
   * leftward into art the scrim has already cleared.
   */
  nowrap?: boolean;
  testId?: string;
}

const isWeb = Platform.OS === "web";

export const PriceBlock = memo<PriceBlockProps>(
  ({
    amount,
    label,
    free = false,
    soldOut = false,
    nowrap = false,
    testId,
    ...rest
  }) => {
    const foreground = soldOut
      ? "$colorMuted"
      : free
        ? "$onSupport"
        : "$onBrandSecondary";
    // Stub theme pairs white onBrandSecondary with #E2481D (~4.1:1 — AA-large
    // only); this block's 16px/8.5px text is small, so ride the deeper
    // brandSecondaryHover fill there (#B93312, white ≈ 6:1). See colors.ts.
    const isStub = useThemeName()?.startsWith("stub") ?? false;
    // `white-space` is a web-only property; React Native has no such style
    // and a native `Text` stays on one line through `numberOfLines` instead.
    // Nothing native passes `nowrap` today, so this only keeps the prop from
    // handing RN a style key it does not know.
    const oneLine = nowrap && isWeb;
    const paidStubFill =
      !free && !soldOut && isStub
        ? { backgroundColor: "$brandSecondaryHover" as const }
        : {};

    return (
      <PriceBlockFrame
        free={free && !soldOut}
        soldOut={soldOut}
        {...paidStubFill}
        {...(testId
          ? isWeb
            ? { "data-testid": testId }
            : { testID: testId }
          : {})}
        {...rest}
      >
        {/* v2 .priceblock .amt is 700 / 16px / tabular digits. Up a rung: the
            amount is the whole point of the block and it competes with a
            photograph behind it on the poster.

            One line only when the caller asks (`nowrap`) — see the prop. */}
        <Text
          variant="span"
          fontSize={18}
          lineHeight={PRICE_BLOCK_METRICS.amountLineHeight}
          weight="bold"
          color={foreground}
          textAlign="center"
          style={{
            fontVariantNumeric: "tabular-nums",
            ...(oneLine ? { whiteSpace: "nowrap" as const } : {}),
          }}
        >
          {amount}
        </Text>
        {label ? (
          // The v2 literal is 8.5px at 85% opacity. Both halves are dropped
          // here, deliberately.
          //
          // Opacity is the expensive one: 85% white on the #B93312 fill takes
          // 5.92:1 down to ~4.6:1, and it spends that on an 8.5px tracked
          // label sitting on a saturated ground — the place in the system with
          // the least contrast headroom to give away. Full strength is free.
          //
          // The size follows for the same reason: at 8.5px "FROM" was a
          // texture under the amount rather than a word, which is what made
          // the price read as hard to parse even where the number itself
          // cleared AA.
          <Text
            variant="span"
            weight="semibold"
            fontSize={9.5}
            lineHeight={PRICE_BLOCK_METRICS.labelLineHeight}
            letterSpacing={1.6}
            textTransform="uppercase"
            color={foreground}
            textAlign="center"
            // One line only when asked, same as the amount above.
            {...(oneLine ? { style: { whiteSpace: "nowrap" as const } } : {})}
          >
            {label}
          </Text>
        ) : null}
      </PriceBlockFrame>
    );
  },
);

PriceBlock.displayName = "PriceBlock";
