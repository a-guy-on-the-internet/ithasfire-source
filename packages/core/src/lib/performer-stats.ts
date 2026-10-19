import type {
  HumanStatsRecord,
  PublicStatsMetrics,
  VerifiedStatsSnapshot,
} from "@th/types/repos/human-stats";

/**
 * Musician EPK verified-stats: the SINGLE source of truth for both call sites
 * that surface performer stats (NFR-001) — the public `stats` block injection
 * (get-my-page / get-public-page) and the booking-request snapshot
 * (create-booking-request, FR-009). Eligibility and the whitelist live here so
 * the two paths can never diverge.
 *
 * The underlying aggregate is computed server-side on a schedule
 * (`compute-human-stats.ts`); nothing here recomputes or trusts client input.
 *
 * KNOWN v1 FOOTNOTE (see spec open_questions): `HumanStats.totalEventsPerformed`
 * can include ownerless COMMUNITY / RSVP listings a performer was attached to.
 * Those contribute 0 attributed tickets while still incrementing the event
 * count, which dilutes `avgDrawPerEvent`. We deliberately accept this in v1 and
 * reuse the existing aggregate AS-IS rather than changing compute-human-stats.
 */

/**
 * Minimum completed performances before a performer's stats are eligible to be
 * shown publicly / shared on a pitch. Below this the public block renders an
 * owner-only "not yet eligible" state and nothing publicly (FR-003).
 */
export const MIN_SHOWS_FOR_STATS = 3;

/** The shape injected into a visible `stats` block for renderer consumption. */
export interface PerformerStatsBlockData {
  eligible: boolean;
  /** ISO timestamp of the source aggregate, or null when never computed. */
  computedAt: string | null;
  metrics: PublicStatsMetrics;
}

export function isPerformerStatsEligible(
  stats: { totalEventsPerformed: number } | null | undefined,
): boolean {
  return (stats?.totalEventsPerformed ?? 0) >= MIN_SHOWS_FOR_STATS;
}

/**
 * Tickets moved via the artist's own share links (channelBreakdown `ref_link`).
 *
 * NOTE: this can UNDER-report — compute-human-stats persists only the top-5
 * channels, so if `ref_link` falls outside that top-5 for a given performer it
 * is absent here and this returns 0. That's acceptable per FR-003 (undercount
 * is fine; overclaim is not).
 */
function refLinkTickets(stats: HumanStatsRecord | null | undefined): number {
  const entry = stats?.channelBreakdown?.find((c) => c.source === "ref_link");
  return entry?.tickets ?? 0;
}

/**
 * Map a HumanStats aggregate → the privacy-whitelisted public metrics. WHITELIST
 * ONLY: never leaks topCities / topPlaceIds / topGenres, the full
 * channelBreakdown, followerCount, or totalConsentedFans (privacy risk per
 * spec). A null aggregate yields a zeroed shape so the owner editor can still
 * render an "eligible: false" state.
 */
export function toPublicStatsSnapshot(
  stats: HumanStatsRecord | null | undefined,
): PublicStatsMetrics {
  return {
    totalEventsPerformed: stats?.totalEventsPerformed ?? 0,
    avgDrawPerEvent: stats?.avgDrawPerEvent ?? null,
    repeatFanCount: stats?.repeatFanCount ?? 0,
    refLinkTickets: refLinkTickets(stats),
    last90DayTickets: stats?.last90DayTickets ?? 0,
    last90DayEvents: stats?.last90DayEvents ?? 0,
  };
}

/**
 * Build the data injected into a `stats` block. `eligible` reflects the
 * threshold; `metrics` is always the whitelisted shape (zeroed when no
 * aggregate exists) so the owner editor can show the not-yet-eligible state.
 */
export function buildPerformerStatsBlockData(
  stats: HumanStatsRecord | null | undefined,
): PerformerStatsBlockData {
  return {
    eligible: isPerformerStatsEligible(stats),
    computedAt: stats ? stats.computedAt.toISOString() : null,
    metrics: toPublicStatsSnapshot(stats),
  };
}

/**
 * Build the persisted booking-request snapshot (FR-009): the whitelisted
 * metrics PLUS the source aggregate's `computedAt`. Caller MUST have already
 * confirmed eligibility — this asserts a non-null aggregate.
 */
export function toVerifiedStatsSnapshot(
  stats: HumanStatsRecord,
): VerifiedStatsSnapshot {
  return {
    ...toPublicStatsSnapshot(stats),
    computedAt: stats.computedAt.toISOString(),
  };
}
