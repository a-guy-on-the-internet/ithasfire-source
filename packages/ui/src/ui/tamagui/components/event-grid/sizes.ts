export type EventCardSize = "sm" | "md" | "lg";

type EventCardLayout = "vertical" | "horizontal";

/**
 * 3:2 landscape — the ticket's art window.
 *
 * This is what the height reservations below are computed from, so it must
 * stay in step with `CARD_ART_ASPECT_RATIO` in `EventCard.tsx`: the card draws
 * the ratio, this file predicts how tall the result will be (min-heights,
 * skeleton geometry). They disagreed at 4:3 vs 3:2 and the skeleton→card swap
 * jumped.
 */
export const DEFAULT_MEDIA_ASPECT_RATIO = 3 / 2;
export const HORIZONTAL_MEDIA_WIDTH_RATIO = 0.4;

interface EventCardSizeConfig {
  /** Target card width when rendered in grid layouts. */
  gridWidth: number;
  /** Target card width when rendered in horizontal layouts or carousels. */
  horizontalWidth: number;
  /**
   * Minimum height to reserve for the card's BODY — title, meta, claimed bar.
   *
   * Not the foot: that is a sibling below this box and brings its own height.
   * These numbers came down when the full-width "View details" button left the
   * body (the foot replaced it); at the old values the reservation outlived
   * the thing it was reserving room for and every card carried a band of dead
   * space between its meta and its foot rule.
   */
  contentMinHeight: number;
  /** Preferred size for the favorite toggle button. */
  favoriteButtonSize: number;
}

const EVENT_CARD_SIZES: Record<EventCardSize, EventCardSizeConfig> = {
  sm: {
    gridWidth: 240,
    horizontalWidth: 360,
    contentMinHeight: 116,
    favoriteButtonSize: 36,
  },
  md: {
    gridWidth: 272,
    horizontalWidth: 392,
    contentMinHeight: 128,
    favoriteButtonSize: 40,
  },
  lg: {
    gridWidth: 320,
    horizontalWidth: 440,
    contentMinHeight: 140,
    favoriteButtonSize: 44,
  },
} as const;

export const getEventCardSizeConfig = (
  size: EventCardSize,
): EventCardSizeConfig => EVENT_CARD_SIZES[size];

export const getEventCardWidthForLayout = (
  size: EventCardSize,
  layout: EventCardLayout,
): number => {
  const config = getEventCardSizeConfig(size);
  return layout === "horizontal" ? config.horizontalWidth : config.gridWidth;
};

export const getEventCardMediaDimensions = (
  size: EventCardSize,
  layout: EventCardLayout,
): { width: number; height: number } => {
  if (layout === "horizontal") {
    const width = Math.round(
      getEventCardWidthForLayout(size, layout) * HORIZONTAL_MEDIA_WIDTH_RATIO,
    );
    return {
      width,
      height: Math.round(width / DEFAULT_MEDIA_ASPECT_RATIO),
    };
  }

  const width = getEventCardWidthForLayout(size, layout);
  return {
    width,
    height: Math.round(width / DEFAULT_MEDIA_ASPECT_RATIO),
  };
};

export const EVENT_CARD_SIZE_OPTIONS: EventCardSize[] = ["sm", "md", "lg"];

export const getEventCardMinHeight = (
  size: EventCardSize,
  layout: EventCardLayout,
): number => {
  const config = getEventCardSizeConfig(size);
  const media = getEventCardMediaDimensions(size, layout);

  if (layout === "horizontal") {
    return Math.max(media.height, config.contentMinHeight);
  }

  return media.height + config.contentMinHeight;
};
