// Canonical barrel exports.
//
// IMPORTANT: export only from the category subfolders below. The root-level
// `./<Component>` back-compat re-export shims have been removed; do not add
// new ones.
export * from "./typography";
export * from "./display";
export * from "./forms";
export * from "./feedback";
export * from "./navigation";
export * from "./overlay";
export * from "./notifications";
export * from "./events";
export * from "./location";
export * from "./data";
export * from "./effects";
export * from "./utility";
export * from "./shared";

// Grouped component exports (non-breaking convenience)
export * as feedback from "./feedback";
export * as forms from "./forms";
export * as navigation from "./navigation";
export * as typography from "./typography";
export * as overlay from "./overlay";
export * as data from "./data";
export * as display from "./display";
export * as effects from "./effects";
export * as utility from "./utility";

// Domain groupings
export * as events from "./events";
export * as location from "./location";
export * as eventList from "./event-list";
// Use import-then-export (direct binding) to avoid
// "Indirectly exported binding name … is not found" in Vite ESM dev server.
import {
  EventGrid,
  EventGridSkeleton,
  EventGridFilters,
  useEventGridLayout,
  useEventGridFilters,
  TicketTierRevealProvider,
  // The card `EventGrid` actually renders — the one every event surface on the
  // site shows, and now the only one. It is exported under BOTH names:
  // `EventCard`, which is what it is, and `EventGridCard`, which is what a
  // pile of call sites already import.
  //
  // The alias used to exist because a legacy `events/EventCard.tsx` occupied
  // the good name with a stale card (16:9 art, a `translateY` hover key
  // Tamagui does not recognise, so the lift never rendered) that nothing
  // imported. That file is gone; `EventCard` from `@th/ui` is now the ticket.
  EventCard,
  EventCard as EventGridCard,
  useListingPriceWords,
  listingPriceWordsFrom,
  listingPriceText,
  LISTING_PRICE_WORD_KEYS,
} from "./event-grid";
export {
  EventGrid,
  EventGridSkeleton,
  EventGridFilters,
  useEventGridLayout,
  useEventGridFilters,
  TicketTierRevealProvider,
  EventCard,
  EventGridCard,
  useListingPriceWords,
  listingPriceWordsFrom,
  listingPriceText,
  LISTING_PRICE_WORD_KEYS,
};
export type {
  EventGridProps,
  EventGridFiltersConfig,
  EventGridFilterState,
  EventGridGroupBy,
  EventGridSectionInfo,
  EventGridVariant,
  EventSummary,
  EventSummaryMedia,
  EventBadgeTone,
  EventCardTier,
  EventCardTiersResult,
  UseEventCardTiers,
  TicketTierRevealProviderProps,
  // Both names, for the same reason as `EventCard` / `EventGridCard` above.
  EventCardProps,
  EventCardProps as EventGridCardProps,
  EventCardLayout,
  EventCardLayout as EventGridCardLayout,
  EventCardVariant,
  EventCardSize,
  LocalizedListingPriceWords,
} from "./event-grid";

import { EventListCard, EventListDistance } from "./event-list";
export { EventListCard, EventListDistance };
export type { EventListCardProps, EventListDistanceProps } from "./event-list";
