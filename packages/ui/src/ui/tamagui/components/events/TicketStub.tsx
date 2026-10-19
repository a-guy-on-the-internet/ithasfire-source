"use client";

import { memo, useMemo } from "react";
import { Platform } from "react-native";
import { Stack, XStack, YStack, styled, useThemeName } from "tamagui";
import type { GetProps } from "tamagui";

import {
  elevationTokens,
  type ElevationThemeName,
} from "../../tokens/elevation";
import { Text } from "../typography/Text";
import { ClaimedBar } from "./ClaimedBar";
import { DateBlock, type DateBlockProps } from "./DateBlock";
import { PriceBlock, type PriceBlockProps } from "./PriceBlock";

/**
 * TicketStub — Design System v2 organism (section 06, renderer B).
 *
 * Higher-character, medium-density event renderer for curated lists (4–10
 * events, editorial feel, max 2 columns — never auto-fill grids). Columns:
 * DateBlock | body (kicker tag, 900 title, muted where-line) | PriceBlock,
 * separated from the date by a 2px dashed tear line with die-cut punch
 * holes; a full-width footer row carries the ClaimedBar.
 *
 * Native notes: the dashed tear line may render solid on iOS/Android
 * (per-side dashed borders are a web strength) and the hard offset Stub
 * shadow is web-only — both degrade to a clean solid-ruled stub.
 */
const StubFrame = styled(YStack, {
  name: "TicketStub",
  width: "100%",
  maxWidth: 560,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  // Punch holes overhang the top/bottom edges (die-cut illusion).
  overflow: "visible",

  variants: {
    pressable: {
      true: {
        cursor: "pointer",
        hoverStyle: {
          borderColor: "$accent",
        },
        pressStyle: {
          scale: 0.99,
        },
        focusStyle: {
          outlineWidth: 2,
          outlineStyle: "solid",
          outlineColor: "$focus",
          outlineOffset: 2,
        },
      },
      false: {},
    },
  } as const,

  defaultVariants: {
    pressable: false,
  },
});

const DateColumn = styled(Stack, {
  name: "TicketStubDateColumn",
  width: 100,
  flexShrink: 0,
  alignItems: "center",
  justifyContent: "center",
  position: "relative",
  // v2 tear line — 2px dashed vertical rule between date and body.
  borderRightWidth: 2,
  borderRightColor: "$borderColor",
  borderStyle: "dashed",
});

/**
 * Punch hole — the ONE sanctioned circular exception in the v2 system:
 * these are die-cut holes, not UI chrome. Background-colored so they read
 * as cut-outs against the page.
 */
const PunchHole = styled(Stack, {
  name: "TicketStubPunchHole",
  position: "absolute",
  right: -8,
  width: 14,
  height: 14,
  borderRadius: 999,
  backgroundColor: "$background",
  borderWidth: 2,
  borderColor: "$borderColor",
  zIndex: 1,
});

const BodyColumn = styled(YStack, {
  name: "TicketStubBody",
  flex: 1,
  minWidth: 0,
  paddingVertical: "$4",
  paddingHorizontal: "$5",
  gap: 6,
  justifyContent: "center",
});

/**
 * The price column is BOUNDED, and that is what keeps a long price inside the
 * stub. `flexShrink: 0` alone sizes the column to the block's max-content
 * width, the label on one line, however long. At 320px, "$1,234.56+" over
 * "Desde el precio de entrada" made a 231px block that ran 63px past the
 * stub's right border (the frame is `overflow: visible` for the punch holes)
 * and crushed the title column to its padding. Wrapping alone does not help:
 * a column sized to max-content never asks its label to wrap.
 *
 * So the column stops at 45% of the row, the block inside it is allowed to
 * shrink (`flexShrink={1}` at the call site), and the label wraps at word
 * boundaries. 45% still fits that amount unbroken at 320px. `overflow:
 * hidden` is the backstop for an amount that is one unbreakable token wider
 * than that: it clips inside the border instead of spilling past it. A
 * normal price ("$45" / "From") never reaches the cap and lays out exactly
 * as before.
 */
const PriceColumn = styled(XStack, {
  name: "TicketStubPriceColumn",
  flexShrink: 0,
  maxWidth: "45%",
  overflow: "hidden",
  alignItems: "stretch",
  borderLeftWidth: 2,
  borderLeftColor: "$borderColor",
});

const Footer = styled(XStack, {
  name: "TicketStubFooter",
  width: "100%",
  borderTopWidth: 1,
  borderTopColor: "$borderColorSoft",
  paddingVertical: "$2",
  paddingHorizontal: "$5",
});

export interface TicketStubProps extends Omit<
  GetProps<typeof StubFrame>,
  "children" | "pressable"
> {
  /** Date column content. */
  date: Pick<DateBlockProps, "month" | "day" | "weekday">;
  /** Kicker category tag above the title, e.g. "Food & Drink". */
  category?: string;
  title: string;
  /** Muted where-line, e.g. "Franklin Fairgrounds · 12:00 PM". */
  where?: string;
  /** Price column content; omit to drop the price column. */
  price?: Pick<PriceBlockProps, "amount" | "label" | "free">;
  /** Percent claimed for the footer bar; hidden when absent or ≤ 0. */
  claimedPercent?: number;
  /** Localized "NN% claimed" label override for the footer bar. */
  claimedLabel?: string;
  /**
   * Fill for the tear-line punch holes. They fake die-cuts, so this MUST
   * match the surface the stub sits on — default `$background` is only
   * correct when the stub renders directly on the page canvas; pass
   * `$surface`/`$surfaceMuted` etc. when placing the stub inside a panel.
   */
  holeColor?: GetProps<typeof Stack>["backgroundColor"];
  onPress?: () => void;
  /** Web: renders the stub as an anchor for real-link semantics. */
  href?: string;
  testId?: string;
}

const isWeb = Platform.OS === "web";

export const TicketStub = memo<TicketStubProps>(
  ({
    date,
    category,
    title,
    where,
    price,
    claimedPercent,
    claimedLabel,
    holeColor,
    onPress,
    href,
    testId,
    ...rest
  }) => {
    const themeName = useThemeName();
    const shadow = useMemo(() => {
      const elevation =
        elevationTokens[themeName as ElevationThemeName] ??
        elevationTokens.ember;
      return elevation.card;
    }, [themeName]);

    const pressable = Boolean(onPress || href);
    const showClaimed =
      typeof claimedPercent === "number" && claimedPercent > 0;

    const linkProps =
      isWeb && href
        ? ({ tag: "a", href, style: { textDecoration: "none" } } as Record<
            string,
            unknown
          >)
        : {};

    return (
      <StubFrame
        pressable={pressable}
        onPress={onPress}
        role={isWeb && pressable ? "link" : undefined}
        accessibilityRole={pressable ? "link" : undefined}
        accessibilityLabel={pressable ? title : undefined}
        tabIndex={isWeb && pressable && !href ? 0 : undefined}
        // Hard offset print-style shadow (Stub theme); "none" elsewhere.
        // Web-only: multi-part CSS shadow strings don't map to native.
        {...(isWeb && shadow !== "none"
          ? { style: { boxShadow: shadow } }
          : {})}
        {...(testId
          ? isWeb
            ? { "data-testid": testId }
            : { testID: testId }
          : {})}
        {...linkProps}
        {...rest}
      >
        <XStack width="100%" alignItems="stretch">
          <DateColumn>
            <DateBlock
              month={date.month}
              day={date.day}
              weekday={date.weekday}
            />
            <PunchHole
              top={-9}
              {...(holeColor ? { backgroundColor: holeColor } : {})}
              {...(isWeb ? { "aria-hidden": true } : {})}
            />
            <PunchHole
              bottom={-9}
              {...(holeColor ? { backgroundColor: holeColor } : {})}
              {...(isWeb ? { "aria-hidden": true } : {})}
            />
          </DateColumn>

          <BodyColumn>
            {category ? (
              <Text variant="kicker" tone="accent">
                {category}
              </Text>
            ) : null}
            {/* v2 .demostub h4 — 900 / uppercase / 16px / line-height 1.2 */}
            <Text
              variant="span"
              fontFamily="$heading"
              fontSize={16}
              lineHeight={19}
              weight="black"
              textTransform="uppercase"
            >
              {title}
            </Text>
            {where ? (
              // v2 .demostub .where — 11.5px / muted
              <Text
                variant="span"
                fontSize={11.5}
                lineHeight={14}
                tone="muted"
                truncate
              >
                {where}
              </Text>
            ) : null}
          </BodyColumn>

          {price ? (
            <PriceColumn>
              <PriceBlock
                amount={price.amount}
                label={price.label}
                free={price.free}
                // Fit the bounded column (see PriceColumn) so the label wraps
                // rather than the block overflowing. Tamagui stacks default
                // to `flexShrink: 0`.
                flexShrink={1}
              />
            </PriceColumn>
          ) : null}
        </XStack>

        {showClaimed ? (
          <Footer>
            <ClaimedBar
              percent={claimedPercent}
              label={claimedLabel}
              testId={testId ? `${testId}-claimed` : undefined}
            />
          </Footer>
        ) : null}
      </StubFrame>
    );
  },
);

TicketStub.displayName = "TicketStub";
