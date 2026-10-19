export interface HumanStatsRecord {
  id: string;
  humanId: string;
  totalEventsPerformed: number;
  totalTicketsAttributed: number;
  avgDrawPerEvent: number | null;
  topCities:
    | { city: string; state?: string; country: string; tickets: number }[]
    | null;
  topPlaceIds: string[] | null;
  topGenres: string[] | null;
  channelBreakdown: { source: string; tickets: number }[] | null;
  totalConsentedFans: number;
  repeatFanCount: number;
  followerCount: number;
  last90DayTickets: number;
  last90DayEvents: number;
  computedAt: Date;
}

/**
 * The privacy-whitelisted subset of `HumanStatsRecord` that is safe to surface
 * publicly (the musician EPK `stats` block) and to snapshot onto a booking
 * request. Deliberately EXCLUDES topCities/topPlaceIds/topGenres, the full
 * channelBreakdown, followerCount, and totalConsentedFans — see
 * `packages/core/src/lib/performer-stats.ts` for the single source of truth
 * that produces this shape.
 */
export interface PublicStatsMetrics {
  totalEventsPerformed: number;
  avgDrawPerEvent: number | null;
  repeatFanCount: number;
  /** Tickets moved via the artist's own share links (channelBreakdown `ref_link`). */
  refLinkTickets: number;
  last90DayTickets: number;
  last90DayEvents: number;
}

/**
 * A point-in-time copy of a performer's whitelisted stats, attached to a
 * booking request when the sender opts to share verified numbers with a venue
 * (FR-009). Carries the source aggregate's `computedAt` (ISO string) so the
 * venue sees exactly how fresh the snapshot is — it is never a live number.
 */
export interface VerifiedStatsSnapshot extends PublicStatsMetrics {
  /** ISO timestamp copied from the source `HumanStatsRecord.computedAt`. */
  computedAt: string;
}
