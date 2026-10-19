"use client";

import type { MutableRefObject } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Stack, XStack, YStack, getTokens, useThemeName } from "tamagui";

import {
  elevationTokens,
  getShadowOverflowPx,
  type ElevationThemeName,
} from "../../tokens/elevation";
import { Button } from "../forms/Button";
import { Text } from "../typography/Text";
import {
  EventCard,
  type EventCardLayout,
  type EventCardProps,
} from "./EventCard";
import { EventGridFilters } from "./EventGridFilters";
import { EventGridSkeleton } from "./EventGridSkeleton";
import {
  CAROUSEL_COLUMN_GAP,
  CAROUSEL_PEEK_PX,
  CAROUSEL_ROW_GAP,
  DEFAULT_COLUMN_GAP,
  DEFAULT_ROW_GAP,
  LIST_ROW_GAP,
  MIN_CAROUSEL_CARD_WIDTH,
  MOBILE_BREAKPOINT,
  TABLET_BREAKPOINT,
  isWeb,
} from "./constants";

// ── Grid content reveal animation (web) ───────────────────────────────────
const gridRevealStyleTagId = "event-grid-reveal-animations";
if (
  isWeb &&
  typeof document !== "undefined" &&
  !document.getElementById(gridRevealStyleTagId)
) {
  const style = document.createElement("style");
  style.id = gridRevealStyleTagId;
  style.innerHTML = `
    @keyframes eventGridFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .event-grid-content-reveal {
      animation: eventGridFadeIn 0.3s ease-out both;
    }
    @media (prefers-reduced-motion: reduce) {
      .event-grid-content-reveal { animation: none !important; }
    }
  `;
  document.head.appendChild(style);
}
import { useEventGridLayout } from "./use-event-grid-layout";
import {
  getEventCardMinHeight,
  getEventCardWidthForLayout,
  type EventCardSize,
} from "./sizes";
import type {
  EventGridCarouselIndicatorConfig,
  EventGridFilterState,
  EventGridFiltersConfig,
  EventGridGroupBy,
  EventGridPaginationConfig,
  EventGridRenderContext,
  EventGridSectionInfo,
  EventGridVariant,
  EventSummary,
} from "./types";

const defaultTestIdBase = "event-grid";

type CarouselMetrics = {
  contentWidth: number;
  containerWidth: number;
};

type EventCardOverrideProps = Pick<
  EventCardProps,
  "minHeight" | "maxHeight" | "flexGrow"
>;

// Grid rows are equal-height siblings (design-system-v2 §5: "Card internals |
// FLEX | column + margin-top:auto to pin footers; equal-height siblings"). Each
// item wrapper is the grid item and already stretches to the row height, but
// it's a *column* flex container — its card sizes to its own content on that
// main axis, so a row of cards ended at four different heights (which the flat
// card hid and the v2 offset shadow makes read as ragged). Growing the card to
// fill its wrapper lines the bottom edges up; ContentStack's `flex={1}` then
// hands the slack to the body so the footer button's `marginTop="auto"` pins to
// a shared baseline across the row. Only the grid variants opt in: carousel
// cards are already fixed-height, and list rows are content-height by design.
const GRID_CARD_OVERRIDES: EventCardOverrideProps = { flexGrow: 1 };

// ── The feature poster's grid cell ────────────────────────────────────────
//
// A `span 2` in an auto-fill grid is gated on the CONTAINER's own width, never
// the viewport's (DS D-096). The grid needs three real columns before spanning
// two of them means anything — below that, "span 2" of a 2-column grid spans
// the whole grid, and the poster becomes a full-width slab beside nothing.
//
// A viewport media query cannot express this: the grid's width depends on
// gutters, sidebars and nesting, so no breakpoint is correct for every
// placement. `@container` asks the grid itself.
//
// The threshold is computed per grid from its OWN track floor and gap rather
// than hardcoded at the DS's 864 (which is 3×272 + 2×24) — this grid's
// `minCardWidth` is a prop, so 864 would be wrong the moment a caller changes
// it. Rules are injected once per distinct threshold.
const FEATURE_CELL_CLASS = "th-egrid-feature";
const featureRuleIds = new Set<string>();

const ensureFeatureSpanRule = (thresholdPx: number) => {
  if (!isWeb || typeof document === "undefined") return null;
  const id = `th-egrid-feature-${thresholdPx}`;
  const cls = `${FEATURE_CELL_CLASS}-${thresholdPx}`;
  if (featureRuleIds.has(id) || document.getElementById(id)) {
    featureRuleIds.add(id);
    return cls;
  }
  const style = document.createElement("style");
  style.id = id;
  // The `@supports` guard is the fallback, and it fails SAFE: where container
  // queries are unavailable the poster is simply a normal cell. A normal cell
  // is always correct; a full-grid poster never is.
  style.innerHTML = `
    @supports (container-type: inline-size) {
      @container (min-width: ${thresholdPx}px) {
        .${cls} { grid-column: span 2; grid-row: span 2; }
      }
    }
  `;
  document.head.appendChild(style);
  featureRuleIds.add(id);
  return cls;
};

const resolveAutomationProps = (testId?: string, qaId?: string) => {
  if (!testId) {
    return {};
  }

  if (isWeb) {
    return {
      "data-testid": testId,
      ...(qaId ? { "data-qa": qaId } : {}),
    } as Record<string, unknown>;
  }

  return {
    testID: testId,
    ...(qaId ? { accessibilityLabel: qaId } : {}),
  } as Record<string, unknown>;
};

const sanitizeSectionId = (value: string, fallback = "section") => {
  const trimmed = value.trim().toLowerCase();
  const slug = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : fallback;
};

const groupEvents = (
  events: EventSummary[],
  groupBy: EventGridGroupBy | undefined,
): EventGridSectionInfo[] => {
  if (!events.length) {
    return [];
  }

  if (!groupBy || groupBy === "none") {
    return [
      {
        id: "default",
        label: "",
        events,
      },
    ];
  }

  const sectionsMap = new Map<string, EventSummary[]>();
  const order: string[] = [];

  const isCustomGroup = typeof groupBy === "object";

  const getKey: (event: EventSummary) => string = (() => {
    if (groupBy === "date") {
      return (event) => event.date ?? "";
    }
    if (groupBy === "venue") {
      return (event) => event.venue ?? "";
    }
    if (isCustomGroup) {
      return groupBy.key;
    }
    return () => "";
  })();

  events.forEach((event) => {
    const rawKey = getKey(event) ?? "";
    const key = rawKey === "" ? "unspecified" : rawKey;
    if (!sectionsMap.has(key)) {
      sectionsMap.set(key, []);
      order.push(key);
    }
    sectionsMap.get(key)?.push(event);
  });

  const sections: EventGridSectionInfo[] = order.map((key) => {
    const baseId =
      isCustomGroup && groupBy.getSectionId
        ? groupBy.getSectionId(key)
        : sanitizeSectionId(key, key === "unspecified" ? "section" : key);
    const eventsForSection = sectionsMap.get(key) ?? [];

    const label =
      isCustomGroup && groupBy.label
        ? groupBy.label(key, eventsForSection)
        : key;

    return {
      id: baseId,
      label,
      events: eventsForSection,
    };
  });

  if (isCustomGroup && groupBy.sortSections) {
    return [...sections].sort(groupBy.sortSections);
  }

  return sections;
};

const resolveVariant = (
  variant: EventGridVariant | undefined,
  width: number,
): Exclude<EventGridVariant, "auto"> => {
  if (variant && variant !== "auto") {
    return variant;
  }

  if (width <= 0) {
    return "grid";
  }

  if (width <= MOBILE_BREAKPOINT) {
    return "carousel";
  }

  if (width < TABLET_BREAKPOINT) {
    return "carousel";
  }

  return "grid";
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const isZeroSpacingValue = (value: string | number | undefined): boolean => {
  if (value === undefined) {
    return false;
  }

  if (typeof value === "number") {
    return value === 0;
  }

  const normalized = value.trim();
  return normalized === "0" || normalized === "$0";
};

/**
 * Resolve a spacing token or number to its numeric pixel value.
 * Handles Tamagui space tokens (`"$4"` → 16) and raw numbers.
 */
const resolveGapPx = (gap: string | number | undefined): number => {
  if (gap === undefined) return 0;
  if (typeof gap === "number") return gap;
  const trimmed = gap.trim();
  if (trimmed.startsWith("$")) {
    const spaceTokens = getTokens().space;
    const token = spaceTokens[trimmed as keyof typeof spaceTokens];
    if (token != null)
      return typeof token === "number" ? token : (token as { val: number }).val;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Compute a CSS width string for a grid item that accounts for flex gap.
 * With `gap` in a flexbox row, each item's width must subtract its share
 * of the total gap so items don't overflow the container.
 */
const gridItemWidth = (columns: number, gapPx: number): string => {
  if (columns <= 1 || gapPx <= 0) return `${100 / columns}%`;
  const totalGap = (columns - 1) * gapPx;
  return `calc(${100 / columns}% - ${totalGap / columns}px)`;
};

const computeActiveFilterCount = (state: EventGridFilterState | undefined) => {
  if (!state) {
    return 0;
  }
  let count = 0;
  if (state.search) count += 1;
  if (state.dateRange?.start || state.dateRange?.end) count += 1;
  if (state.categoryIds?.length) count += 1;
  if (state.venueIds?.length) count += 1;
  if (state.organizerIds?.length) count += 1;
  if (
    state.priceRange?.min !== undefined ||
    state.priceRange?.max !== undefined
  )
    count += 1;
  return count;
};

export interface EventGridProps {
  events?: EventSummary[] | null;
  loading?: boolean;
  variant?: EventGridVariant;
  spacingPreset?: "default" | "flush" | "packed";
  pageSize?: number;
  maxRows?: number;
  minCardWidth?: number;
  cardSize?: EventCardSize;
  spacing?: {
    row?: number | string;
    column?: number | string;
  };
  carouselIndicator?: EventGridCarouselIndicatorConfig;
  groupBy?: EventGridGroupBy;
  filters?: EventGridFiltersConfig & { enabled?: boolean };
  /**
   * Render ONE event in this grid as the portrait feature poster, spanning two
   * tracks and two rows once the grid is genuinely three columns wide.
   *
   * An event id, not an index, and that is the point: the poster reverses type
   * out over an organizer's photograph, so it is only legitimate where somebody
   * curated the event and can vouch for the image (DS D-092). "Whatever sorted
   * first" is not a curator. A card whose event has no media renders as a
   * normal ticket regardless — a poster with no art is a caption on a slab.
   *
   * One per grid, and one per PAGE: if the page already has a curated feature
   * band, it has spent its slot.
   */
  featuredEventId?: string;
  renderCard?: (
    event: EventSummary,
    context: EventGridRenderContext,
  ) => React.ReactNode;
  renderSectionHeader?: (section: EventGridSectionInfo) => React.ReactNode;
  renderEmptyState?: React.ReactNode | (() => React.ReactNode);
  onFavoriteToggle?: (
    eventId: string,
    nextFavorite: boolean,
    context: EventGridRenderContext,
  ) => void;
  onCardPress?: (event: EventSummary, context: EventGridRenderContext) => void;
  pagination?: EventGridPaginationConfig;
  testIdBase?: string;
  qaId?: string;
  nestedScrollEnabled?: boolean;
  skeletonRows?: number;
  skeletonColumns?: number;
  ariaLabel?: string;
}

const defaultEmptyState = (
  <YStack
    gap="$2"
    alignItems="center"
    justifyContent="center"
    paddingVertical="$6"
  >
    <Text variant="h6" weight="bold">
      No events to show
    </Text>
    <Text variant="body" tone="muted" textAlign="center">
      Try adjusting your filters or check back later for new events.
    </Text>
  </YStack>
);

export const EventGrid = memo<EventGridProps>(
  ({
    events,
    loading,
    variant = "auto",
    spacingPreset = "default",
    pageSize,
    maxRows,
    minCardWidth,
    cardSize = "md",
    spacing,
    carouselIndicator,
    groupBy = "none",
    filters,
    featuredEventId,
    renderCard,
    renderSectionHeader,
    renderEmptyState,
    onFavoriteToggle,
    onCardPress,
    pagination,
    testIdBase = defaultTestIdBase,
    qaId,
    nestedScrollEnabled,
    skeletonRows,
    skeletonColumns,
    ariaLabel = "Event list",
  }) => {
    const resolvedCardSize = cardSize;
    const defaultGridCardWidth = getEventCardWidthForLayout(
      resolvedCardSize,
      "vertical",
    );
    const baseCarouselCardWidth = getEventCardWidthForLayout(
      resolvedCardSize,
      "horizontal",
    );
    const carouselCardHeight = getEventCardMinHeight(
      resolvedCardSize,
      "horizontal",
    );
    const layout = useEventGridLayout({
      minCardWidth: minCardWidth ?? defaultGridCardWidth,
      maxRows,
    });
    // The carousel card is a fixed 392px at `md` — wider than a phone viewport,
    // so on mobile the very first card was already clipped at rest and no card
    // was ever fully readable. Cap it to the measured track, reserving
    // CAROUSEL_PEEK_PX so the next card still peeks in and advertises the
    // scroll. Only kicks in when the track is genuinely too narrow; desktop
    // keeps the design-system width. `width <= 0` means "not measured yet".
    const carouselCardWidth =
      layout.width > 0 &&
      layout.width < baseCarouselCardWidth + CAROUSEL_PEEK_PX
        ? Math.max(MIN_CAROUSEL_CARD_WIDTH, layout.width - CAROUSEL_PEEK_PX)
        : baseCarouselCardWidth;
    const resolvedVariant = resolveVariant(variant, layout.width);
    const resolvedSpacingPreset = spacingPreset ?? "default";
    const containerRef =
      layout.containerRef as MutableRefObject<HTMLElement | null>;

    const filtersEnabled = filters ? (filters.enabled ?? true) : false;
    const isFiltersControlled =
      filtersEnabled && typeof filters?.state !== "undefined";

    const [internalFilterState, setInternalFilterState] =
      useState<EventGridFilterState>(filters?.defaultState ?? {});

    useEffect(() => {
      if (!filtersEnabled || isFiltersControlled) {
        return;
      }
      setInternalFilterState(filters?.defaultState ?? {});
    }, [filters?.defaultState, filtersEnabled, isFiltersControlled]);

    const filterState = filtersEnabled
      ? isFiltersControlled
        ? (filters?.state ?? {})
        : internalFilterState
      : undefined;

    const setFilterState = useCallback(
      (updater: (prev: EventGridFilterState) => EventGridFilterState) => {
        if (!filtersEnabled) {
          return;
        }

        if (isFiltersControlled) {
          const base = filters?.state ?? filters?.defaultState ?? {};
          const next = updater(base);
          filters?.onChange?.(next);
          return;
        }

        setInternalFilterState((prev) => {
          const next = updater(prev);
          filters?.onChange?.(next);
          return next;
        });
      },
      [
        filters?.defaultState,
        filters?.onChange,
        filters?.state,
        filtersEnabled,
        isFiltersControlled,
      ],
    );

    const clearFilters = useCallback(() => {
      setFilterState(() => filters?.defaultState ?? {});
    }, [filters?.defaultState, setFilterState]);

    const updateFilters = useCallback(
      (partial: Partial<EventGridFilterState>) => {
        setFilterState((prev) => ({ ...prev, ...partial }));
      },
      [setFilterState],
    );

    const handleFiltersChange = useCallback(
      (next: EventGridFilterState) => {
        setFilterState(() => next);
      },
      [setFilterState],
    );

    const activeFilterCount = useMemo(
      () => computeActiveFilterCount(filterState),
      [filterState],
    );

    const totalEvents = events?.length ?? 0;
    const safeColumns = Math.max(1, layout.columns);

    const finiteRows = Number.isFinite(layout.rows)
      ? (layout.rows as number)
      : undefined;
    const defaultRows =
      finiteRows ?? Math.max(1, Math.ceil(totalEvents / safeColumns));
    const computedPageSize = pageSize ?? Math.max(1, safeColumns * defaultRows);

    const isPaginationControlled = Boolean(
      pagination && typeof pagination.pageIndex === "number",
    );
    const [internalPageIndex, setInternalPageIndex] = useState(0);

    useEffect(() => {
      if (isPaginationControlled) {
        return;
      }
      setInternalPageIndex(0);
    }, [computedPageSize, totalEvents, filterState, isPaginationControlled]);

    const currentPageIndex = isPaginationControlled
      ? pagination!.pageIndex
      : internalPageIndex;

    const totalPages = Math.max(
      1,
      Math.ceil(Math.max(0, totalEvents) / computedPageSize),
    );
    const clampedPageIndex = clamp(currentPageIndex, 0, totalPages - 1);

    useEffect(() => {
      if (clampedPageIndex === currentPageIndex) {
        return;
      }
      if (isPaginationControlled) {
        pagination?.onPageChange(clampedPageIndex);
      } else {
        setInternalPageIndex(clampedPageIndex);
      }
    }, [
      clampedPageIndex,
      currentPageIndex,
      isPaginationControlled,
      pagination,
    ]);

    const emitPageChange = useCallback(
      (nextIndex: number) => {
        const clamped = clamp(nextIndex, 0, totalPages - 1);
        if (isPaginationControlled) {
          pagination?.onPageChange(clamped);
        } else {
          setInternalPageIndex(clamped);
          pagination?.onPageChange?.(clamped);
        }
      },
      [isPaginationControlled, pagination, totalPages],
    );

    const shouldPaginate = resolvedVariant === "grid" && totalPages > 1;
    const pageStartIndex = shouldPaginate
      ? clampedPageIndex * computedPageSize
      : 0;
    const pageEndIndex = shouldPaginate
      ? pageStartIndex + computedPageSize
      : totalEvents;

    const visibleEvents = useMemo(
      () => (events ? events.slice(pageStartIndex, pageEndIndex) : []),
      [events, pageEndIndex, pageStartIndex],
    );

    const sections = useMemo(
      () => groupEvents(visibleEvents, groupBy),
      [groupBy, visibleEvents],
    );
    const isCarousel = resolvedVariant === "carousel";
    const isFlushCarouselSpacing =
      isCarousel && resolvedSpacingPreset === "flush";
    const isPackedCarouselSpacing =
      isCarousel && resolvedSpacingPreset === "packed";
    const isList = resolvedVariant === "list";
    const defaultRowGap = isCarousel
      ? CAROUSEL_ROW_GAP
      : isList
        ? LIST_ROW_GAP
        : DEFAULT_ROW_GAP;
    const defaultColumnGap = isCarousel
      ? CAROUSEL_COLUMN_GAP
      : DEFAULT_COLUMN_GAP;
    const forcedRowGap = isPackedCarouselSpacing ? 0 : undefined;
    const forcedColumnGap =
      isCarousel && (isFlushCarouselSpacing || isPackedCarouselSpacing)
        ? 0
        : undefined;
    const rowGapValue =
      typeof forcedRowGap !== "undefined"
        ? forcedRowGap
        : typeof spacing?.row !== "undefined"
          ? spacing.row
          : defaultRowGap;
    const columnGapValue =
      typeof forcedColumnGap !== "undefined"
        ? forcedColumnGap
        : typeof spacing?.column !== "undefined"
          ? spacing.column
          : defaultColumnGap;
    const sectionGapValue = isPackedCarouselSpacing ? 0 : rowGapValue;
    const shouldRemoveCarouselPadding =
      isCarousel && isZeroSpacingValue(columnGapValue);
    const carouselHorizontalPadding = shouldRemoveCarouselPadding ? 0 : "$2";

    // The v2 .democard shadow paints below the card's box (Stub: 4px down) and
    // box shadows never count as scrollable overflow, so the carousel's
    // horizontal ScrollView (`overflow-y: hidden`) clips it flush at the card's
    // bottom edge. Reserve exactly the shadow's overflow on the track. Gated on
    // the live theme's token so the flat themes (`card: "none"` → 0) and native
    // (the shadow is a web-only inline style — see EventCard) gain no dead space.
    const themeName = useThemeName();
    const carouselShadowGutter = useMemo(() => {
      if (!isWeb) {
        return 0;
      }
      const elevation =
        elevationTokens[themeName as ElevationThemeName] ??
        elevationTokens.ember;
      return getShadowOverflowPx(elevation.card);
    }, [themeName]);

    const indicatorEnabled = Boolean(carouselIndicator?.enabled);
    const indicatorTrackColor = carouselIndicator?.trackColor ?? "$borderColor";
    const indicatorFillColor = carouselIndicator?.fillColor ?? "$color";
    const indicatorHeightValue = carouselIndicator?.height ?? 4;
    const indicatorBorderRadius =
      carouselIndicator?.borderRadius ?? indicatorHeightValue;

    const [carouselProgress, setCarouselProgress] = useState<
      Record<string, number>
    >({});
    const carouselMetricsRef = useRef<Record<string, CarouselMetrics>>({});

    const syncCarouselProgress = useCallback(
      (sectionKey: string, offsetX = 0) => {
        if (!indicatorEnabled) {
          return;
        }
        const metrics = carouselMetricsRef.current[sectionKey];
        if (!metrics) {
          return;
        }
        const totalScrollable = Math.max(
          0,
          metrics.contentWidth - metrics.containerWidth,
        );
        const normalized =
          totalScrollable <= 0 ? 1 : clamp(offsetX / totalScrollable, 0, 1);
        setCarouselProgress((prev) => {
          if (prev[sectionKey] === normalized) {
            return prev;
          }
          return {
            ...prev,
            [sectionKey]: normalized,
          };
        });
      },
      [indicatorEnabled],
    );

    const updateCarouselMetrics = useCallback(
      (sectionKey: string, partial: Partial<CarouselMetrics>) => {
        if (!indicatorEnabled) {
          return;
        }
        const previous = carouselMetricsRef.current[sectionKey] ?? {
          contentWidth: 0,
          containerWidth: 0,
        };
        const nextMetrics: CarouselMetrics = {
          ...previous,
          ...partial,
        };
        carouselMetricsRef.current[sectionKey] = nextMetrics;
        if (nextMetrics.contentWidth > 0 && nextMetrics.containerWidth > 0) {
          syncCarouselProgress(sectionKey);
        }
      },
      [indicatorEnabled, syncCarouselProgress],
    );

    const handleCarouselScroll = useCallback(
      (sectionKey: string, event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (!indicatorEnabled) {
          return;
        }
        syncCarouselProgress(sectionKey, event.nativeEvent.contentOffset.x);
      },
      [indicatorEnabled, syncCarouselProgress],
    );

    const handleFavoriteToggle = useCallback(
      (event: EventSummary, next: boolean, context: EventGridRenderContext) => {
        onFavoriteToggle?.(event.id, next, context);
      },
      [onFavoriteToggle],
    );

    const handleCardPress = useCallback(
      (event: EventSummary, context: EventGridRenderContext) => {
        onCardPress?.(event, context);
      },
      [onCardPress],
    );

    const resolvedDefaultCardLayout: EventCardLayout =
      resolvedVariant === "carousel" || resolvedVariant === "list"
        ? "horizontal"
        : "vertical";

    const renderDefaultCard = useCallback(
      (
        event: EventSummary,
        context: EventGridRenderContext,
        overrides?: EventCardOverrideProps,
      ) => (
        <EventCard
          key={event.id}
          event={event}
          size={resolvedCardSize}
          layout={resolvedDefaultCardLayout}
          dense={isList}
          renderContext={context}
          onFavoriteToggle={onFavoriteToggle ? handleFavoriteToggle : undefined}
          onPress={
            onCardPress ? () => handleCardPress(event, context) : undefined
          }
          testIdBase={`${testIdBase}-card-${event.id}`}
          qaId={`${qaId ?? testIdBase}-card-${event.id}`}
          {...overrides}
        />
      ),
      [
        featuredEventId,
        handleCardPress,
        handleFavoriteToggle,
        isList,
        onCardPress,
        onFavoriteToggle,
        qaId,
        resolvedCardSize,
        resolvedDefaultCardLayout,
        testIdBase,
      ],
    );

    const renderCardContent = useCallback(
      (
        event: EventSummary,
        context: EventGridRenderContext,
        overrides?: EventCardOverrideProps,
      ) => {
        if (renderCard) {
          return renderCard(event, context);
        }
        return renderDefaultCard(event, context, overrides);
      },
      [renderCard, renderDefaultCard],
    );

    const renderSection = useCallback(
      (
        section: EventGridSectionInfo,
        sectionIndex: number,
        sectionStartIndex: number,
      ) => {
        const sectionKey = section.id ?? `section-${sectionIndex}`;
        const automationId = `${testIdBase}-section-${sectionKey}`;
        const automationQa = `${qaId ?? testIdBase}-section-${sectionKey}`;
        const hasHeader =
          groupBy !== "none" &&
          section.label !== undefined &&
          section.label !== null &&
          !(
            typeof section.label === "string" &&
            section.label.trim().length === 0
          );

        const headerNode = hasHeader ? (
          renderSectionHeader ? (
            renderSectionHeader(section)
          ) : typeof section.label === "string" ? (
            <Text variant="subtitle" weight="bold">
              {section.label}
            </Text>
          ) : (
            section.label
          )
        ) : null;

        const shouldShowIndicator =
          indicatorEnabled && resolvedVariant === "carousel";
        const sectionProgress = carouselProgress[sectionKey] ?? 0;
        const indicatorAutomationId = `${automationId}-carousel-indicator`;
        const indicatorAutomationQa = `${automationQa}-carousel-indicator`;
        const carouselTrackAutomationId = `${automationId}-carousel-track`;
        const carouselTrackAutomationQa = `${automationQa}-carousel-track`;

        return (
          <YStack
            key={sectionKey}
            gap={sectionGapValue}
            {...resolveAutomationProps(automationId, automationQa)}
          >
            {headerNode}
            {resolvedVariant === "carousel" ? (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  nestedScrollEnabled={nestedScrollEnabled}
                  contentContainerStyle={{ flexGrow: 0 }}
                  onLayout={
                    indicatorEnabled
                      ? (event) =>
                          updateCarouselMetrics(sectionKey, {
                            containerWidth: event.nativeEvent.layout.width,
                          })
                      : undefined
                  }
                  onContentSizeChange={
                    indicatorEnabled
                      ? (contentWidth) =>
                          updateCarouselMetrics(sectionKey, {
                            contentWidth,
                          })
                      : undefined
                  }
                  onScroll={
                    indicatorEnabled
                      ? (event) => handleCarouselScroll(sectionKey, event)
                      : undefined
                  }
                  scrollEventThrottle={16}
                >
                  <XStack
                    {...resolveAutomationProps(
                      carouselTrackAutomationId,
                      carouselTrackAutomationQa,
                    )}
                    {...(isWeb ? { gap: columnGapValue } : {})}
                    paddingHorizontal={carouselHorizontalPadding}
                    {...(carouselShadowGutter > 0
                      ? { paddingBottom: carouselShadowGutter }
                      : {})}
                    flexDirection="row"
                  >
                    {section.events.map((event, index) => {
                      const context: EventGridRenderContext = {
                        index: sectionStartIndex + index,
                        sectionId: section.id,
                      };
                      const applyInlineSpacing =
                        !isWeb && index < section.events.length - 1;
                      const shouldConstrainWidth =
                        resolvedVariant === "carousel";
                      const cardHeightValue = shouldConstrainWidth
                        ? carouselCardHeight
                        : undefined;
                      const wrapperHeightProps = cardHeightValue
                        ? {
                            minHeight: cardHeightValue,
                            maxHeight: cardHeightValue,
                          }
                        : undefined;
                      const cardOverrides = cardHeightValue
                        ? ({
                            minHeight: cardHeightValue,
                            maxHeight: cardHeightValue,
                          } satisfies EventCardOverrideProps)
                        : undefined;
                      return (
                        <Stack
                          key={event.id}
                          flexGrow={0}
                          flexShrink={0}
                          width={
                            shouldConstrainWidth ? carouselCardWidth : undefined
                          }
                          maxWidth={
                            shouldConstrainWidth ? carouselCardWidth : undefined
                          }
                          minWidth={
                            shouldConstrainWidth ? carouselCardWidth : undefined
                          }
                          marginRight={
                            applyInlineSpacing ? columnGapValue : undefined
                          }
                          {...wrapperHeightProps}
                        >
                          {renderCardContent(event, context, cardOverrides)}
                        </Stack>
                      );
                    })}
                  </XStack>
                </ScrollView>
                {shouldShowIndicator ? (
                  <YStack
                    {...resolveAutomationProps(
                      indicatorAutomationId,
                      indicatorAutomationQa,
                    )}
                    paddingHorizontal={carouselHorizontalPadding}
                  >
                    <Stack
                      width="100%"
                      height={indicatorHeightValue}
                      backgroundColor={indicatorTrackColor}
                      borderRadius={indicatorBorderRadius}
                      overflow="hidden"
                    >
                      <Stack
                        width={`${sectionProgress * 100}%`}
                        height="100%"
                        backgroundColor={indicatorFillColor}
                        borderRadius={indicatorBorderRadius}
                      />
                    </Stack>
                  </YStack>
                ) : null}
              </>
            ) : resolvedVariant === "list" ? (
              <YStack gap={rowGapValue}>
                {section.events.map((event, index) => {
                  const context: EventGridRenderContext = {
                    index: sectionStartIndex + index,
                    sectionId: section.id,
                  };
                  return (
                    <Stack key={event.id} width="100%">
                      {renderCardContent(event, context)}
                    </Stack>
                  );
                })}
              </YStack>
            ) : isWeb ? (
              (() => {
                const trackFloor = minCardWidth ?? defaultGridCardWidth;
                const colGapPx = resolveGapPx(columnGapValue);
                // Three real columns is the point at which "span 2" stops
                // meaning "span everything" — see `ensureFeatureSpanRule`.
                const featureClass = featuredEventId
                  ? ensureFeatureSpanRule(trackFloor * 3 + colGapPx * 2)
                  : null;
                return (
                  <Stack
                    style={
                      {
                        display: "grid",
                        gridTemplateColumns: `repeat(auto-fill, minmax(${trackFloor}px, 1fr))`,
                        // Every row the same height, so every card is the same
                        // height. Default `auto` rows are sized per row by their
                        // own tallest card, so one gated event carrying an extra
                        // meta line made its whole ROW 22px taller than the row
                        // above it — cards visibly changing size down the page
                        // for a reason the reader cannot see. `1fr` resolves
                        // against the largest row in an auto-height grid, which
                        // equalises them without a hardcoded card height: no
                        // card pays for a claimed bar or a gate row unless
                        // something in THIS grid actually renders one.
                        gridAutoRows: "1fr",
                        gap: `${resolveGapPx(rowGapValue)}px ${colGapPx}px`,
                        // The query the span rule asks. Without this the
                        // @container rule has nothing to measure and the
                        // poster silently stays a normal cell.
                        containerType: "inline-size",
                      } as Record<string, unknown>
                    }
                  >
                    {section.events.map((event, index) => {
                      const context: EventGridRenderContext = {
                        index: sectionStartIndex + index,
                        sectionId: section.id,
                      };
                      const isFeatured =
                        Boolean(featuredEventId) && event.id === featuredEventId;
                      return (
                        <Stack
                          key={event.id}
                          alignItems="flex-start"
                          {...(isFeatured && featureClass
                            ? ({ className: featureClass } as Record<string, unknown>)
                            : {})}
                        >
                          {renderCardContent(event, context, GRID_CARD_OVERRIDES)}
                        </Stack>
                      );
                    })}
                  </Stack>
                );
              })()
            ) : (
              <Stack
                flexDirection="row"
                flexWrap="wrap"
                gap={columnGapValue}
                rowGap={rowGapValue}
              >
                {section.events.map((event, index) => {
                  const context: EventGridRenderContext = {
                    index: sectionStartIndex + index,
                    sectionId: section.id,
                  };
                  const itemWidth = gridItemWidth(
                    safeColumns,
                    resolveGapPx(columnGapValue),
                  );
                  return (
                    <Stack
                      key={event.id}
                      width={itemWidth}
                      maxWidth="100%"
                      alignItems="flex-start"
                    >
                      {renderCardContent(event, context, GRID_CARD_OVERRIDES)}
                    </Stack>
                  );
                })}
              </Stack>
            )}
          </YStack>
        );
      },
      [
        carouselCardHeight,
        carouselCardWidth,
        carouselHorizontalPadding,
        carouselProgress,
        carouselShadowGutter,
        columnGapValue,
        defaultGridCardWidth,
        groupBy,
        handleCarouselScroll,
        indicatorBorderRadius,
        indicatorEnabled,
        indicatorFillColor,
        indicatorHeightValue,
        indicatorTrackColor,
        minCardWidth,
        nestedScrollEnabled,
        qaId,
        renderCardContent,
        renderSectionHeader,
        resolvedVariant,
        rowGapValue,
        sectionGapValue,
        safeColumns,
        testIdBase,
        updateCarouselMetrics,
      ],
    );

    const baseIndexOffset = shouldPaginate ? pageStartIndex : 0;

    const sectionNodes = useMemo(() => {
      let runningIndex = 0;
      return sections.map((section, index) => {
        const sectionStartIndex = baseIndexOffset + runningIndex;
        runningIndex += section.events.length;
        return renderSection(section, index, sectionStartIndex);
      });
    }, [baseIndexOffset, renderSection, sections]);

    if (loading ?? typeof events === "undefined") {
      // When width hasn't been measured yet (0), safeColumns is 1. For the CSS
      // Grid skeleton path (web, "grid" variant) that uses auto-fill, we need
      // enough items to fill a typical viewport — default to 3 columns so the
      // skeleton grid doesn't look "smooshed" into a single narrow column.
      const unmeasured = layout.width <= 0;
      // `safeColumns` is derived from the *grid* card width (272 at `md`), which
      // is the wrong ruler for a carousel whose cards are 392 — it produced ~2
      // extra cards per row. The skeleton track is clipped now, so the goal is
      // simply "enough to fill the viewport plus one peeking at the edge",
      // measured against the carousel card's own width.
      const carouselSkeletonColumns = unmeasured
        ? 3
        : Math.ceil(layout.width / carouselCardWidth) + 1;
      const skeletonColumnsValue =
        skeletonColumns ??
        (resolvedVariant === "carousel"
          ? carouselSkeletonColumns
          : unmeasured && resolvedVariant === "grid"
            ? 3
            : safeColumns);
      const skeletonRowsValue =
        skeletonRows ??
        (Number.isFinite(layout.rows) ? (layout.rows as number) : 3);
      return (
        <YStack
          ref={isWeb ? containerRef : undefined}
          onLayout={layout.handleLayout}
          gap={rowGapValue}
          {...resolveAutomationProps(
            `${testIdBase}-container`,
            `${qaId ?? testIdBase}-container`,
          )}
          role="region"
          aria-label={ariaLabel}
        >
          {filtersEnabled && filters ? (
            filters.renderControls ? (
              filters.renderControls(filterState ?? {}, {
                update: updateFilters,
                clear: clearFilters,
              })
            ) : (
              <EventGridFilters
                state={filterState ?? {}}
                onChange={handleFiltersChange}
                availableCategories={filters.availableCategories}
                availableOrganizers={filters.availableOrganizers}
                availableVenues={filters.availableVenues}
                dateLimits={filters.dateLimits}
                priceRange={filters.priceRange}
                testIdBase={`${testIdBase}-filters`}
                qaId={`${qaId ?? testIdBase}-filters`}
              />
            )
          ) : null}
          <EventGridSkeleton
            rows={skeletonRowsValue}
            columns={resolvedVariant === "list" ? 1 : skeletonColumnsValue}
            layout={
              resolvedVariant === "carousel"
                ? "carousel"
                : resolvedVariant === "list"
                  ? "list"
                  : "grid"
            }
            size={resolvedCardSize}
            spacingPreset={resolvedSpacingPreset}
            minCardWidth={minCardWidth ?? defaultGridCardWidth}
            carouselCardWidth={carouselCardWidth}
          />
        </YStack>
      );
    }

    const hasEvents = visibleEvents.length > 0;
    const emptyStateNode =
      typeof renderEmptyState === "function"
        ? renderEmptyState()
        : (renderEmptyState ?? defaultEmptyState);

    return (
      <YStack
        ref={isWeb ? containerRef : undefined}
        onLayout={layout.handleLayout}
        gap={rowGapValue}
        {...resolveAutomationProps(
          `${testIdBase}-container`,
          `${qaId ?? testIdBase}-container`,
        )}
        role="region"
        aria-label={ariaLabel}
      >
        {filtersEnabled && filters ? (
          filters.renderControls ? (
            filters.renderControls(filterState ?? {}, {
              update: updateFilters,
              clear: clearFilters,
            })
          ) : (
            <EventGridFilters
              state={filterState ?? {}}
              onChange={handleFiltersChange}
              availableCategories={filters.availableCategories}
              availableOrganizers={filters.availableOrganizers}
              availableVenues={filters.availableVenues}
              dateLimits={filters.dateLimits}
              priceRange={filters.priceRange}
              testIdBase={`${testIdBase}-filters`}
              qaId={`${qaId ?? testIdBase}-filters`}
            />
          )
        ) : null}

        <Text
          variant="bodySmall"
          tone="muted"
          className={isWeb ? "event-grid-content-reveal" : undefined}
          {...resolveAutomationProps(
            `${testIdBase}-result-count`,
            `${qaId ?? testIdBase}-result-count`,
          )}
          aria-live="polite"
        >
          {hasEvents
            ? `Showing ${visibleEvents.length}${shouldPaginate ? ` of ${totalEvents}` : ""} events${shouldPaginate ? ` (page ${clampedPageIndex + 1} of ${totalPages})` : ""}`
            : "No events"}
          {activeFilterCount > 0
            ? ` • ${activeFilterCount} filters active`
            : ""}
        </Text>

        {hasEvents ? (
          <YStack gap={rowGapValue}>{sectionNodes}</YStack>
        ) : (
          emptyStateNode
        )}

        {shouldPaginate ? (
          <XStack gap="$3" alignItems="center" justifyContent="flex-end">
            <Button
              variant="ghost"
              size="$2"
              onPress={() => emitPageChange(clampedPageIndex - 1)}
              disabled={clampedPageIndex === 0}
              {...resolveAutomationProps(
                `${testIdBase}-pagination-prev`,
                `${qaId ?? testIdBase}-pagination-prev`,
              )}
            >
              Previous
            </Button>
            <Text variant="bodySmall" tone="muted">
              Page {clampedPageIndex + 1} of {totalPages}
            </Text>
            <Button
              variant="ghost"
              size="$2"
              onPress={() => emitPageChange(clampedPageIndex + 1)}
              disabled={clampedPageIndex >= totalPages - 1}
              {...resolveAutomationProps(
                `${testIdBase}-pagination-next`,
                `${qaId ?? testIdBase}-pagination-next`,
              )}
            >
              Next
            </Button>
          </XStack>
        ) : null}
      </YStack>
    );
  },
);

EventGrid.displayName = "EventGrid";
