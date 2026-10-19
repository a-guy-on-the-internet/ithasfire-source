"use client";

import { memo, useCallback, useState } from "react";
import { Platform } from "react-native";
import { XStack, YStack, styled } from "tamagui";
import type { GetProps } from "tamagui";

import { Text } from "../typography/Text";
import { monoScale } from "../../tokens/typography";

/**
 * LineupRow — the catalogue tier ("renderer C" / `EventLineupRow` in the design
 * system).
 *
 * Maximum-density, text-first event renderer for full catalogs and schedule
 * pages. Needs ≥5 rows to read as a lineup; below that use cards.
 *
 * ## Rows must be wrapped in `Lineup`
 *
 * The design system's D-099: a "table-like rows" component is **a container
 * plus rows, never free-standing rows**. Two things depend on the container:
 *
 * 1. **Cross-row column alignment.** The tail tracks (category, price) are
 *    fixed widths — `CATEGORY_TRACK` / `PRICE_TRACK` — so every row's tails
 *    begin at the same x. Sized tails are the design system's own
 *    `@supports not (subgrid)` fallback, and unlike CSS subgrid they need no
 *    grid at all, so the same rule holds on native. Without them a wider price
 *    ("Sold out" against "$12") shifts that row's title independently and the
 *    columns visibly ragged down the page.
 * 2. **The structural top rule.** Rows carry a bottom hairline only; the 2px
 *    rule above the first row belongs to the container. Rows owning both edges
 *    is what doubled every interior hairline and made each call site
 *    hand-patch `borderTopWidth={index === 0 ? 1 : 0}`.
 *
 * ## The when-column is optional
 *
 * Catalog pages with structured start times pass `dateLabel` for the aligned
 * tabular-digit date rail; surfaces whose events only carry a pre-formatted
 * human date string (e.g. unified search) omit it and fold the date into
 * `subtitle` — the row still reads name-first with the same hover.
 *
 * `compact` narrows the when-column, drops the name to the h4 step and lets it
 * wrap, and hides the category (first thing to go under density pressure) —
 * consumers pass it from their own breakpoint hook so column alignment
 * survives without media queries fighting the desktop track widths.
 *
 * Hover/focus: raised row fill; the name shifts 8px and takes accent
 * (~160ms ease-out on web; instant on native).
 */

const isWeb = Platform.OS === "web";

/**
 * Tail track widths. Fixed, not `auto` — see the container note above; these
 * are what guarantee the category and price columns line up across rows.
 */
const CATEGORY_TRACK = 110;
/** Wide enough for the longest label the slot carries ("From $62.35"). */
const PRICE_TRACK = 100;

/**
 * When-column width. The design system sizes this track `max-content` against
 * the widest row; measured against the reference lineup that resolves to
 * ~117.5px, and the column can never be narrower than its longest string
 * (D-101 — `SAT · 10:30 PM` must not wrap or collide with the title).
 */
const WHEN_TRACK = 118;
/**
 * Compact drops the weekday from the time line (see `toLineupWhen`), so the
 * longest string this track can hold is a half-hour evening start — "10:30 PM",
 * ~60px at the mono 2xs step. The track must stay wider than that: the time
 * line is `nowrap`, so undersizing it does not tighten the row, it pushes the
 * string out of its column and into the title (D-101 — sizing this track under
 * its content converts a wrap into a collision).
 */
const WHEN_TRACK_COMPACT = 72;

/** Container-owned structural rule above the first row. */
export const Lineup = styled(YStack, {
  name: "Lineup",
  width: "100%",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
});

const RowFrame = styled(XStack, {
  name: "LineupRow",
  width: "100%",
  alignItems: "center",
  gap: "$5",
  paddingVertical: "$4",
  paddingHorizontal: "$2",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColorSoft",

  variants: {
    /** Tighter gutter once the row is down to two tracks. */
    compact: {
      true: { gap: "$4" },
      false: {},
    },
    pressable: {
      true: {
        cursor: "pointer",
        hoverStyle: {
          backgroundColor: "$surfaceRaised",
        },
        focusStyle: {
          outlineWidth: 2,
          outlineStyle: "solid",
          outlineColor: "$focus",
          outlineOffset: -2,
        },
        pressStyle: {
          backgroundColor: "$surfaceRaised",
        },
      },
      false: {},
    },
  } as const,

  defaultVariants: {
    pressable: false,
    compact: false,
  },
});

const WhenColumn = styled(YStack, {
  name: "LineupRowWhen",
  width: WHEN_TRACK,
  flexShrink: 0,

  variants: {
    compact: {
      true: { width: WHEN_TRACK_COMPACT },
      false: {},
    },
  } as const,

  defaultVariants: {
    compact: false,
  },
});

export interface LineupRowProps
  extends Omit<GetProps<typeof RowFrame>, "children" | "pressable" | "compact"> {
  /**
   * Bold uppercase date line (tabular digits), e.g. "JUL 24". Zero-pad the day
   * at the call site so a column of dates aligns optically (D-100). Optional:
   * when omitted the when-column is not rendered and the name starts
   * flush-left (for surfaces without a structured start time).
   */
  dateLabel?: string;
  /** Uppercase tracked time line under the date, e.g. "FRI · 10 PM". */
  timeLabel?: string;
  /** Event name — the 900-weight uppercase middle track. */
  name: string;
  /** Muted prose meta under the name (venue / context). Plain body — no
   *  micro-label treatment. */
  subtitle?: string;
  /** Category label, e.g. "Music". Mono accent, no chip. Hidden in `compact`. */
  category?: string;
  /**
   * Hold the category track open on rows that have no `category`, so the price
   * column still lines up across the list. Set it from the LIST, not the row —
   * `events.some(e => e.category)` — because the cost is asymmetric: reserving
   * it spends a fixed 110px of the title's width on every row, which on a
   * narrow surface (the /search column beside the map) is the difference
   * between a readable title and "DOLORES…". Reserve only when something in
   * the list will actually fill it.
   */
  reserveCategory?: boolean;
  /** Bold accent price (tabular digits), e.g. "$12". */
  price?: string;
  /**
   * Density mode for narrow catalog containers: narrower when-column, smaller
   * name that wraps, category hidden. Pass from the consumer's own breakpoint
   * hook.
   */
  compact?: boolean;
  onPress?: () => void;
  /** Web: renders the row as an anchor for real-link semantics. */
  href?: string;
  testId?: string;
}

const NAME_TRANSITION = "color 160ms ease-out, transform 160ms ease-out";

/** Tabular digits keep the date rail and the price column optically aligned. */
const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

export const LineupRow = memo<LineupRowProps>(
  ({
    dateLabel,
    timeLabel,
    name,
    subtitle,
    category,
    reserveCategory = false,
    price,
    compact = false,
    onPress,
    href,
    testId,
    onHoverIn,
    onHoverOut,
    onFocus,
    onBlur,
    ...rest
  }) => {
    const pressable = Boolean(onPress || href);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const active = pressable && (hovered || focused);

    const handleHoverIn = useCallback(
      (event: unknown) => {
        setHovered(true);
        (onHoverIn as ((e: unknown) => void) | undefined)?.(event);
      },
      [onHoverIn],
    );
    const handleHoverOut = useCallback(
      (event: unknown) => {
        setHovered(false);
        (onHoverOut as ((e: unknown) => void) | undefined)?.(event);
      },
      [onHoverOut],
    );
    const handleFocus = useCallback(
      (event: unknown) => {
        setFocused(true);
        (onFocus as ((e: unknown) => void) | undefined)?.(event);
      },
      [onFocus],
    );
    const handleBlur = useCallback(
      (event: unknown) => {
        setFocused(false);
        (onBlur as ((e: unknown) => void) | undefined)?.(event);
      },
      [onBlur],
    );

    const linkProps =
      isWeb && href
        ? ({ tag: "a", href, style: { textDecoration: "none" } } as Record<
            string,
            unknown
          >)
        : {};

    // Price — mono lg / 700 / accent. On the desktop row it is the last fixed
    // tail track; in `compact` the tracks collapse to when + name, so it moves
    // under the title (matching the design system's ≤640px rule) rather than
    // competing with the name for a track barely wider than one word.
    const priceNode = price ? (
      <Text
        variant="span"
        fontFamily="$mono"
        fontSize={monoScale.lg.fontSize}
        lineHeight={17}
        letterSpacing={monoScale.lg.letterSpacing}
        weight="bold"
        tone="accent"
        width={compact ? undefined : PRICE_TRACK}
        flexShrink={0}
        whiteSpace="nowrap"
        style={TABULAR}
      >
        {price}
      </Text>
    ) : null;

    return (
      <RowFrame
        pressable={pressable}
        compact={compact}
        onPress={onPress}
        role={isWeb && pressable ? "link" : undefined}
        accessibilityRole={pressable ? "link" : undefined}
        accessibilityLabel={pressable ? name : undefined}
        tabIndex={isWeb && pressable && !href ? 0 : undefined}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        onFocus={handleFocus}
        onBlur={handleBlur}
        {...(testId
          ? isWeb
            ? { "data-testid": testId }
            : { testID: testId }
          : {})}
        {...linkProps}
        {...rest}
      >
        {dateLabel ? (
          <WhenColumn compact={compact}>
            {/* Date line — mono 13 / 700 / +1 / ink. */}
            <Text
              variant="span"
              fontFamily="$mono"
              fontSize={13}
              lineHeight={16}
              letterSpacing={1}
              textTransform="uppercase"
              weight="bold"
              style={TABULAR}
            >
              {dateLabel}
            </Text>
            {timeLabel ? (
              // Time line — mono 2xs / muted, at the design system's own
              // tighter +1.8 tracking. `nowrap`: this is a fixed-format field
              // and half-hour starts are the norm for music events, so a
              // wrapped meta line would add 16px to one row and break the
              // vertical rhythm of the tier that exists for alignment (D-101).
              <Text
                variant="span"
                fontFamily="$mono"
                fontSize={monoScale["2xs"].fontSize}
                lineHeight={14}
                letterSpacing={1.8}
                textTransform="uppercase"
                tone="muted"
                whiteSpace="nowrap"
                style={TABULAR}
              >
                {timeLabel}
              </Text>
            ) : null}
          </WhenColumn>
        ) : null}

        {/* Name + optional muted subtitle share the fluid middle track (flex:1
            so the category and price keep their fixed tail tracks). Only the
            name takes the hover accent + 8px shift; the subtitle stays put. */}
        <YStack flex={1} minWidth={0} gap="$1">
          {/* Name — h3 step / 900 / uppercase / −0.8, poster leading; h4 step
              in compact, where it is allowed to wrap. Hover: accent + 8px
              shift (keyboard parity via onFocus/onBlur, not :focus-visible). */}
          <Text
            variant="span"
            fontFamily="$heading"
            fontSize={compact ? 19 : 21.4}
            lineHeight={compact ? 21 : 22.5}
            letterSpacing={-0.8}
            weight="black"
            textTransform="uppercase"
            minWidth={0}
            truncate={!compact}
            color={active ? "$accent" : "$color"}
            x={active ? 8 : 0}
            {...(isWeb ? { style: { transition: NAME_TRANSITION } } : {})}
          >
            {name}
          </Text>
          {subtitle ? (
            <Text
              variant="span"
              fontSize={13}
              lineHeight={17}
              tone="muted"
              minWidth={0}
              truncate
            >
              {subtitle}
            </Text>
          ) : null}
          {compact ? priceNode : null}
        </YStack>

        {/* Category — mono 2xs accent, no chip. Fixed track so it aligns down
            the page; held open as an empty spacer on categoryless rows (only
            when the list opted in) so they do not pull the price column left. */}
        {!compact && (category || reserveCategory) ? (
          <YStack width={CATEGORY_TRACK} flexShrink={0}>
            {category ? (
              <Text
                variant="span"
                fontFamily="$mono"
                weight="semibold"
                fontSize={monoScale["2xs"].fontSize}
                lineHeight={13}
                letterSpacing={monoScale["2xs"].letterSpacing}
                textTransform="uppercase"
                tone="accent"
                truncate
              >
                {category}
              </Text>
            ) : null}
          </YStack>
        ) : null}

        {compact ? null : priceNode}
      </RowFrame>
    );
  },
);

LineupRow.displayName = "LineupRow";
