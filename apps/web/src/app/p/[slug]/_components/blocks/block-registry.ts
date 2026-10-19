import type { ComponentType } from "react";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { AboutBlock } from "./AboutBlock";
import { LinksBlock } from "./LinksBlock";
import { PhotosBlock } from "./PhotosBlock";
import { UpcomingEventsBlock } from "./UpcomingEventsBlock";
import { AnnouncementsBlock } from "./AnnouncementsBlock";
import { FaqBlock } from "./FaqBlock";
import { LocationMapBlock } from "./LocationMapBlock";
import { CapacityInfoBlock } from "./CapacityInfoBlock";
import { HouseRulesBlock } from "./HouseRulesBlock";
import { AmenitiesBlock } from "./AmenitiesBlock";
import { TechSpecsBlock } from "./TechSpecsBlock";
import { BookingInfoBlock } from "./BookingInfoBlock";
import { RequestToPlayBlock } from "./RequestToPlayBlock";
import { RateVenueBlock } from "./RateVenueBlock";
import { GenreTagsBlock } from "./GenreTagsBlock";
import { VideoBlock } from "./VideoBlock";
import { PressBlock } from "./PressBlock";
import { RiderBlock } from "./RiderBlock";
import { MissionBlock } from "./MissionBlock";
import { TeamBlock } from "./TeamBlock";
import { ShowsBlock } from "./ShowsBlock";
import { PastShowsBlock } from "./PastShowsBlock";
import { StatsBlock } from "./StatsBlock";
import { TrackRecordBlock } from "./TrackRecordBlock";
import { VenueStatsBlock } from "./VenueStatsBlock";
import { AudienceStatsBlock } from "./AudienceStatsBlock";
import { MusicBlock } from "./MusicBlock";
import { TracksBlock } from "./TracksBlock";
import {
  ResidentArtistsBlock,
  ManagedPlacesBlock,
  PastEventsBlock,
} from "./StubBlocks";

// ── Registry type ──────────────────────────────────────────────────────────

export type BlockComponent = ComponentType<{ block: PageBlockRecord }>;

/**
 * Maps a block `kind` string to the React component that renders it.
 *
 * To add a new block kind:
 *   1. Create a component in this directory (see existing blocks for pattern).
 *   2. Add the kind → component mapping here.
 *   3. If the kind is entity-type-restricted, add it to the appropriate
 *      config in `packages/core/src/use-cases/entity-pages/block-config.ts`.
 */
export const BLOCK_REGISTRY: ReadonlyMap<string, BlockComponent> = new Map<
  string,
  BlockComponent
>([
  // ── Universal ────────────────────────────────────────────────────────
  ["about", AboutBlock],
  ["links", LinksBlock],
  ["photos", PhotosBlock],
  ["upcoming_events", UpcomingEventsBlock],
  ["announcements", AnnouncementsBlock],
  ["faq", FaqBlock],

  // ── Performer / EPK ─────────────────────────────────────────────────
  // This registry is a flat kind→component map; owner eligibility lives in
  // block-config `ownerTypes`, not here. `music`/`video`/`press`/`genre_tags`
  // are HUMAN + ORGANIZATION (bands); `shows`/`tracks`/`stats`/`past_shows`/
  // `rider` stay HUMAN-only.
  ["shows", ShowsBlock],
  ["music", MusicBlock],
  ["tracks", TracksBlock],
  ["video", VideoBlock],
  ["press", PressBlock],
  ["stats", StatsBlock],
  ["past_shows", PastShowsBlock],
  ["rider", RiderBlock],
  ["genre_tags", GenreTagsBlock],

  // ── Place / venue ───────────────────────────────────────────────────
  // `booking_info` is PLACE + HUMAN + ORGANIZATION (see block-config).
  ["location_map", LocationMapBlock],
  ["capacity_info", CapacityInfoBlock],
  ["house_rules", HouseRulesBlock],
  ["amenities", AmenitiesBlock],
  ["tech_specs", TechSpecsBlock],
  ["resident_artists", ResidentArtistsBlock],
  ["booking_info", BookingInfoBlock],
  ["request_to_play", RequestToPlayBlock],
  ["rate_venue", RateVenueBlock],
  // Pinned, server-injected (venue-track-record-and-review-switch FR-011).
  ["track_record", TrackRecordBlock],
  ["venue_stats", VenueStatsBlock],
  ["audience_stats", AudienceStatsBlock],

  // ── Org-only ────────────────────────────────────────────────────────
  ["team", TeamBlock],
  ["mission", MissionBlock],
  ["managed_places", ManagedPlacesBlock],
  ["past_events", PastEventsBlock],
]);

/**
 * Look up the component for a given block kind.
 * Returns `undefined` when no renderer is registered (caller should use BlockFallback).
 */
export function getBlockComponent(kind: string): BlockComponent | undefined {
  return BLOCK_REGISTRY.get(kind);
}
