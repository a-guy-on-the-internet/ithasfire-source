"use client";

import { memo, useMemo } from "react";
import { ScrollView } from "react-native";
import { AnimatePresence, Stack, XStack, YStack, getTokens } from "tamagui";

import {
  CAROUSEL_COLUMN_GAP,
  CAROUSEL_ROW_GAP,
  DEFAULT_COLUMN_GAP,
  DEFAULT_ROW_GAP,
  isWeb,
} from "./constants";
import { EventCardSkeleton } from "./EventCardSkeleton";
import { getEventCardWidthForLayout, type EventCardSize } from "./sizes";

/* ── helpers ────────────────────────────────────────────────────────────── */

/**
 * Resolve a Tamagui space token (e.g. `"$4"`) or raw number to its pixel
 * value so we can feed it into a CSS `gap` or `grid-template-columns`.
 */
const resolveSpacePx = (value: string | number | 0): number => {
  if (typeof value === "number") return value;
  const trimmed = value.trim();
  if (trimmed.startsWith("$")) {
    const spaceTokens = getTokens().space;
    const token = spaceTokens[trimmed as keyof typeof spaceTokens];
    if (token != null)
      return typeof token === "number" ? token : (token as { val: number }).val;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
};

/* ── types ──────────────────────────────────────────────────────────────── */

export interface EventGridSkeletonProps {
  rows?: number;
  columns?: number;
  layout?: "grid" | "list" | "carousel";
  animate?: boolean;
  loading?: boolean;
  size?: EventCardSize;
  spacingPreset?: "default" | "flush" | "packed";
  /**
   * Minimum card width used for auto-fill CSS Grid sizing.
   * When provided the grid computes its own column count via
   * `repeat(auto-fill, minmax(minCardWidth, 1fr))` so the skeleton
   * always forms a strict grid regardless of container size.
   *
   * Falls back to `getEventCardWidthForLayout(size, "vertical")` when
   * omitted.
   */
  minCardWidth?: number;
  /**
   * Exact carousel card width to reserve, so the skeleton matches the loaded
   * carousel even when EventGrid has narrowed the card to fit a phone track.
   * Falls back to the design-system width for the size.
   */
  carouselCardWidth?: number;
}

/* ── component ──────────────────────────────────────────────────────────── */

export const EventGridSkeleton = memo<EventGridSkeletonProps>(
  ({
    rows = 3,
    columns = 3,
    layout = "grid",
    animate = true,
    loading = true,
    size = "md",
    spacingPreset = "default",
    minCardWidth,
    carouselCardWidth: carouselCardWidthProp,
  }) => {
    const shouldAnimate = loading && animate !== false;
    const safeColumns = Math.max(1, columns);
    const safeRows = Math.max(1, rows);
    const total = useMemo(
      () => Math.max(1, safeRows * safeColumns),
      [safeColumns, safeRows],
    );
    const cardLayout: "vertical" | "horizontal" =
      layout === "carousel" || layout === "list" ? "horizontal" : "vertical";

    const isFlushCarouselSpacing =
      layout === "carousel" && spacingPreset === "flush";
    const isPackedCarouselSpacing =
      layout === "carousel" && spacingPreset === "packed";
    const rowGap =
      layout === "carousel"
        ? isPackedCarouselSpacing
          ? 0
          : CAROUSEL_ROW_GAP
        : DEFAULT_ROW_GAP;
    const columnGap =
      layout === "carousel"
        ? isFlushCarouselSpacing || isPackedCarouselSpacing
          ? 0
          : CAROUSEL_COLUMN_GAP
        : DEFAULT_COLUMN_GAP;

    // ── carousel ─────────────────────────────────────────────────────────
    if (layout === "carousel") {
      const carouselCardWidth =
        carouselCardWidthProp ?? getEventCardWidthForLayout(size, "horizontal");
      return (
        <YStack gap={rowGap} aria-hidden>
          {/* Carousel skeleton cards are FIXED-width (392px at `md`), so a bare
              XStack of them is wider than its container by construction — on the
              home saved strip that overflowed the page and gave the whole
              document a horizontal scrollbar while the query was in flight.
              Clip the track the same way the loaded carousel does (an identical
              horizontal ScrollView in EventGrid), with scrolling disabled: the
              skeleton is aria-hidden placeholder chrome, so it should bound
              itself without offering a scroll affordance for fake content. */}
          <ScrollView
            horizontal
            scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ flexGrow: 0 }}
          >
            <AnimatePresence initial={false}>
              <XStack gap={columnGap}>
                {Array.from({ length: safeColumns }).map((_, index) => (
                  <Stack
                    key={`carousel-skeleton-${index}`}
                    flexGrow={0}
                    flexShrink={0}
                    width={carouselCardWidth}
                    minWidth={carouselCardWidth}
                    maxWidth={carouselCardWidth}
                    animation={shouldAnimate ? "base" : undefined}
                    enterStyle={shouldAnimate ? { opacity: 0 } : undefined}
                    exitStyle={shouldAnimate ? { opacity: 0 } : undefined}
                  >
                    <EventCardSkeleton
                      animate={animate}
                      loading={loading}
                      layout={cardLayout}
                      size={size}
                    />
                  </Stack>
                ))}
              </XStack>
            </AnimatePresence>
          </ScrollView>
        </YStack>
      );
    }

    // ── list ─────────────────────────────────────────────────────────────
    if (layout === "list") {
      return (
        <YStack gap={rowGap} aria-hidden>
          <AnimatePresence initial={false}>
            {Array.from({ length: Math.min(total, safeRows) }).map(
              (_, index) => (
                <Stack
                  key={`list-skeleton-${index}`}
                  width="100%"
                  animation={shouldAnimate ? "base" : undefined}
                  enterStyle={shouldAnimate ? { opacity: 0 } : undefined}
                  exitStyle={shouldAnimate ? { opacity: 0 } : undefined}
                >
                  <EventCardSkeleton
                    animate={animate}
                    loading={loading}
                    layout="horizontal"
                    size={size}
                  />
                </Stack>
              ),
            )}
          </AnimatePresence>
        </YStack>
      );
    }

    // ── grid (CSS Grid on web, flexbox fallback on native) ───────────────
    const resolvedMinCardWidth =
      minCardWidth ?? getEventCardWidthForLayout(size, "vertical");
    const rowGapPx = resolveSpacePx(rowGap);
    const columnGapPx = resolveSpacePx(columnGap);

    if (isWeb) {
      const gridStyle: React.CSSProperties = {
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, minmax(${resolvedMinCardWidth}px, 1fr))`,
        gridTemplateRows: `repeat(${safeRows}, auto)`,
        gap: `${rowGapPx}px ${columnGapPx}px`,
      };

      return (
        <Stack aria-hidden style={gridStyle as Record<string, unknown>}>
          <AnimatePresence initial={false}>
            {Array.from({ length: total }).map((_, index) => (
              <Stack
                key={`grid-skeleton-${index}`}
                animation={shouldAnimate ? "base" : undefined}
                enterStyle={shouldAnimate ? { opacity: 0 } : undefined}
                exitStyle={shouldAnimate ? { opacity: 0 } : undefined}
              >
                <EventCardSkeleton
                  animate={animate}
                  loading={loading}
                  layout={cardLayout}
                  size={size}
                />
              </Stack>
            ))}
          </AnimatePresence>
        </Stack>
      );
    }

    // Native fallback: percentage-based flex rows (no CSS Grid)
    const gridItemWidthPercent = `${100 / safeColumns}%`;

    return (
      <YStack gap={rowGap} aria-hidden>
        <AnimatePresence initial={false}>
          {Array.from({ length: safeRows }).map((_, rowIndex) => (
            <XStack
              key={`grid-row-${rowIndex}`}
              gap={columnGap}
              flexWrap="wrap"
            >
              {Array.from({ length: safeColumns }).map((_, columnIndex) => {
                const index = rowIndex * safeColumns + columnIndex;
                if (index >= total) {
                  return null;
                }
                return (
                  <Stack
                    key={`grid-skeleton-${rowIndex}-${columnIndex}`}
                    width={gridItemWidthPercent}
                    animation={shouldAnimate ? "base" : undefined}
                    enterStyle={shouldAnimate ? { opacity: 0 } : undefined}
                    exitStyle={shouldAnimate ? { opacity: 0 } : undefined}
                  >
                    <EventCardSkeleton
                      animate={animate}
                      loading={loading}
                      layout={cardLayout}
                      size={size}
                    />
                  </Stack>
                );
              })}
            </XStack>
          ))}
        </AnimatePresence>
      </YStack>
    );
  },
);

EventGridSkeleton.displayName = "EventGridSkeleton";
