"use client";

import type { CSSProperties } from "react";
import { styled, XStack, YStack } from "tamagui";
import { Text } from "@th/ui";

import {
  NO_VALUE,
  QUEUE_SIGNALS,
  signalMeaning,
  signalTitle,
  signalTotalLabel,
  signalWindowLabel,
  type QueueSignal,
  type QueueThresholds,
  type QueueTotals,
} from "./image-moderation-ops.helpers";

/**
 * The five queue-health counts, each a button that opens its drill-down.
 *
 * ZERO IS THE HEALTHY VALUE FOR ALL FIVE, so a zero is deliberately the
 * quietest thing on the tile: muted figure, hairline left rule. Nothing here
 * goes red — several of these counts are non-zero on a perfectly healthy day
 * (a few genuine content holds), and a tile that cries wolf at 1 is a tile
 * people stop reading. Non-zero earns ink and the accent rule; that is the
 * whole difference.
 *
 * A TILE READING ZERO CAN MEAN "NOTHING OLD", NOT "NOTHING". `awaitingReview`
 * counts only holds older than 24h and `orphanedRecent` only the last 2h, so
 * six images flagged this morning render as `0` and the orphan table can hold
 * thousands while the tile says zero. The all-time total arrives as a SECOND
 * LINE and the primary figure is left exactly as it was — those five counts are
 * what the hourly Discord alert pages on, predicate for predicate, and
 * decoupling this page from the alert would be a worse bug than the one it
 * fixes. See `signalTotalLabel`, which also suppresses the line when the total
 * and the window agree.
 *
 * AUTO-FIT, NOT AUTO-FILL. This is a closed set of exactly five tiles, not an
 * open collection: `auto-fill` would mint a sixth empty track on a wide
 * console and leave the row visibly ragged. The design-system rule the grid
 * section is actually protecting — never a media-query column count — still
 * holds.
 */

const TILE_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))",
  gap: 16,
  width: "100%",
  alignItems: "stretch",
};

const TABULAR: CSSProperties = { fontVariantNumeric: "tabular-nums" };

/**
 * A `<button>` centres its text by default, which would centre every wrapped
 * label in the tile. Lives on `style` rather than in the styled config:
 * Tamagui's Stack style props have no `textAlign` (it is a text-layout
 * property, not a view one) and the styled() call is a type error.
 */
const TILE_TEXT: CSSProperties = { textAlign: "left" };

const Tile = styled(YStack, {
  name: "ModerationSignalTile",
  tag: "button",
  alignItems: "flex-start",
  gap: "$2",
  padding: "$4",
  minWidth: 0,
  borderWidth: 1,
  borderRadius: 0,
  borderColor: "$borderColor",
  borderLeftWidth: 3,
  backgroundColor: "$surface",
  cursor: "pointer",
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },

  variants: {
    // Hover/press live in the styled config, not as props: `hoverStyle` passed
    // as a prop MERGES with the variant's rather than replacing it, so a
    // per-instance override here would silently compound.
    interactive: {
      true: {
        hoverStyle: { backgroundColor: "$surfaceMuted" },
        pressStyle: { backgroundColor: "$backgroundPress" },
      },
      false: { cursor: "default" },
    },
    /** A count above zero earns the accent rule. */
    active: {
      true: { borderLeftColor: "$accent" },
      false: { borderLeftColor: "$borderColorSoft" },
    },
    /** The tile whose drill-down is open. */
    selected: {
      true: {
        borderWidth: 2,
        borderLeftWidth: 3,
        borderColor: "$color",
        backgroundColor: "$surfaceMuted",
      },
    },
  } as const,

  defaultVariants: {
    interactive: true,
    active: false,
  },
});

export type SignalTilesProps = {
  counts: Record<QueueSignal, number> | undefined;
  thresholds: QueueThresholds | undefined;
  /** All-time counterparts to the two windowed tiles. `snapshot.totals`. */
  totals: QueueTotals | undefined;
  selected: QueueSignal | null;
  onSelect: (signal: QueueSignal) => void;
};

export function SignalTiles({
  counts,
  thresholds,
  totals,
  selected,
  onSelect,
}: SignalTilesProps) {
  const ready = counts !== undefined && thresholds !== undefined;

  return (
    <div style={TILE_GRID}>
      {QUEUE_SIGNALS.map((signal) => {
        const count = counts?.[signal];
        const title = signalTitle(signal);
        const windowLabel = thresholds
          ? signalWindowLabel(signal, thresholds)
          : NO_VALUE;
        // The visible em dash is correct on screen but reads as literally
        // nothing to a screen reader, which would announce "Overdue for scan:
        // unknown, ." — say the same thing the count says instead.
        const windowAria = thresholds ? windowLabel : "window unknown";
        const isSelected = selected === signal;
        const totalLabel = signalTotalLabel(signal, count, totals);

        return (
          <Tile
            key={signal}
            interactive={ready}
            active={ready && (count ?? 0) > 0}
            selected={isSelected}
            disabled={!ready}
            aria-pressed={isSelected}
            // An aria-label REPLACES the inner text as the accessible name,
            // so it carries every part of the tile — including the meaning
            // line, which a screen reader would otherwise never hear.
            aria-label={`${title}: ${count ?? "unknown"}, ${windowAria}${
              totalLabel ? `, ${totalLabel}` : ""
            }. ${signalMeaning(signal)}`}
            style={TILE_TEXT}
            onPress={ready ? () => onSelect(signal) : undefined}
          >
            <Text
              variant="overline"
              tone="muted"
              // Labels wrap rather than clip: "Objects missing" is two words
              // and a 200px track is the narrow end of the auto-fit range.
              style={{ whiteSpace: "normal" }}
            >
              {title}
            </Text>

            <XStack
              gap="$2"
              alignItems="baseline"
              flexWrap="wrap"
              flexShrink={1}
              minWidth={0}
            >
              {/* `tag="span"`: a COUNT is data, not a document heading — the
                  h3 variant is borrowed for its scale only, matching the stat
                  cards on /platform/fees. h2 (40px) is hero scale in a 200px
                  track and reads as alarm on a page whose healthy state is
                  five zeros. */}
              <Text
                variant="h3"
                tag="span"
                weight="bold"
                tone={ready && (count ?? 0) > 0 ? "default" : "muted"}
                style={TABULAR}
              >
                {ready ? count : NO_VALUE}
              </Text>
              <Text variant="caption" tone="muted">
                {windowLabel}
              </Text>
            </XStack>

            {/* The total sits UNDER the figure, in the tile's quietest type —
                it is context for the count, not a second count. Rendered only
                when it differs from the window (see `signalTotalLabel`): "0 /
                0 waiting in total" costs a reader attention and says nothing. */}
            {totalLabel ? (
              <Text variant="caption" tone="muted" style={TABULAR}>
                {totalLabel}
              </Text>
            ) : null}

            <Text variant="caption" tone="muted">
              {signalMeaning(signal)}
            </Text>
          </Tile>
        );
      })}
    </div>
  );
}
