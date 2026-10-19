import type { ReactNode } from "react";

import type { ListingPrice } from "@th/types/money";

export type EventBadgeTone = "promo" | "hot" | "cold" | "default";

export interface EventSummaryMedia {
  url: string;
  alt: string;
  aspectRatio?: number;
}

export interface EventSummary {
  id: string;
  title: string;
  date: string;
  venue: string;
  /** The listing price in ENGLISH, as the server words it. */
  priceLabel: string;
  /**
   * The same price as data (`resolveListingPrice` in `@th/types/money`). When
   * present (`null` included, meaning "no price") the card words it in the
   * viewer's language and ignores `priceLabel`. Absent on producers that only
   * send the English string.
   */
  listingPrice?: ListingPrice | null;
  /**
   * True when the event is genuinely free (no paid tiers). Drives the amber
   * support price badge without string-matching the localized `priceLabel`.
   * Optional — absent reads as paid (badge stays accent).
   */
  isFree?: boolean;
  /**
   * No tickets left. Renders the QUIET sold-out block and hides the claimed
   * bar — at FULL contrast. Never dim a sold-out card: 42% opacity reads as
   * broken rather than as unavailable, and a sold-out show is social proof a
   * thin marketplace needs.
   *
   * Optional and currently unset by every mapper — the card supports the state
   * ahead of a producer for it.
   */
  soldOut?: boolean;
  /**
   * Serial printed in the ticket foot, e.g. "001984". Flavour, not data.
   * Omit and the card derives one from `id`, which is what every surface does
   * today — a browse card has no order behind it to carry a real number.
   */
  serial?: string;
  slug?: string | null;
  media?: EventSummaryMedia;
  badge?: {
    text: string;
    tone?: EventBadgeTone;
  };
  favorite?: boolean;
  /** Event gate type — PASSWORD, APPLICATION, or NONE (omitted when NONE). */
  gateType?: "NONE" | "PASSWORD" | "APPLICATION";
  /** Distance from the viewer in kilometres. */
  distanceKm?: number;
  /** ISO 8601 start time (useful for client-side date filtering). */
  startsAt?: string;
  /**
   * The event's IANA zone (`Event.timezone`), the zone `date` above was
   * formatted in. The DB-backed mappers (`countryEventToDto`,
   * `localEventToDto`, `discoverEventToDto`) set it, and so does the
   * search-backed `discoveredEventToDto` (from the indexed `timezone`).
   *
   * The card's date derivations (`deriveCardStamp`: poster stamp, Date Stub,
   * meta-line time) read `startsAt` in this zone, or in
   * `DEFAULT_VENUE_TIMEZONE` when absent (a producer with no zone, or a search
   * document indexed before the zone was stored). That agrees with `date`
   * whenever the producer sent the zone `date` was formatted in. Never the renderer's
   * zone: that made the server (UTC) and the
   * browser print different text, a hydration mismatch. And one card must
   * never stamp SEP 2 above a line reading SEP 3.
   */
  timezone?: string | null;
  /** Tags / categories attached to the event. */
  tags?: string[];
  /** Discriminator — "event" for published, "scraped" for community-sourced. */
  kind?: "event" | "scraped";
  /**
   * True when the event repeats on a recurrence schedule (a single Event that
   * surfaces as one recurring card). Renders a subtle "Recurring" meta label.
   */
  isRecurring?: boolean;
}

export interface EventGridRenderContext {
  index: number;
  sectionId?: string;
}

export interface EventGridSectionInfo {
  id: string;
  label: ReactNode;
  events: EventSummary[];
}

export interface EventGridGroupByCustomConfig {
  key: (event: EventSummary) => string;
  label?: (groupKey: string, events: EventSummary[]) => ReactNode;
  sortSections?: (a: EventGridSectionInfo, b: EventGridSectionInfo) => number;
  getSectionId?: (groupKey: string) => string;
}

export type EventGridGroupBy =
  | "none"
  | "date"
  | "venue"
  | EventGridGroupByCustomConfig;

export type EventGridVariant = "grid" | "list" | "carousel" | "auto";

export interface EventGridCarouselIndicatorConfig {
  enabled?: boolean;
  trackColor?: string;
  fillColor?: string;
  height?: number | string;
  borderRadius?: number | string;
}

export interface EventGridPaginationConfig {
  pageIndex: number;
  pageSize: number;
  onPageChange: (nextPageIndex: number) => void;
}

export interface EventGridFilterState {
  search?: string;
  dateRange?: {
    start?: string;
    end?: string;
  };
  categoryIds?: string[];
  venueIds?: string[];
  organizerIds?: string[];
  priceRange?: {
    min?: number;
    max?: number;
  };
}

export interface FilterOption {
  id: string;
  label: string;
  count?: number;
  description?: ReactNode;
}

export interface EventGridFiltersConfig {
  enabled?: boolean;
  state?: EventGridFilterState;
  defaultState?: EventGridFilterState;
  onChange?: (state: EventGridFilterState) => void;
  availableCategories?: FilterOption[];
  availableVenues?: FilterOption[];
  availableOrganizers?: FilterOption[];
  dateLimits?: {
    min?: string;
    max?: string;
  };
  priceRange?: {
    min?: number;
    max?: number;
    step?: number;
  };
  renderControls?: (
    state: EventGridFilterState,
    helpers: {
      update: (partial: Partial<EventGridFilterState>) => void;
      clear: () => void;
    },
  ) => ReactNode;
}
