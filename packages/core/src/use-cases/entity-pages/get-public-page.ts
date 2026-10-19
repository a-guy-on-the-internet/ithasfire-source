import { z } from "zod";

import { parseInput } from "../../lib/io";
import { venueConfirmedFilterFor } from "../../lib/venue-confirmation";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { sanitizeAnnouncementHtml } from "../../lib/announcement-html";
import type { AnnouncementRecord } from "@th/types/repos/announcements";
import type { EventRecord } from "@th/types/repos/events";
import { TRACK_RECORD_EVENT_STATUSES } from "@th/types/repos/events";
import { fail } from "@th/errors";
import type {
  EntityPageRecord,
  PublicPageData,
  EntitySummary,
  PageBlockRecord,
} from "@th/types/repos/entity-pages";
import { normalizeBlockSection } from "./block-sections";
import { entitySummarySchema, loadEntitySummary } from "./entity-summary";
import { PUBLIC_LINEUP_ROLES } from "../../lib/event-human-roles";
import {
  toHumanShowSummary,
  PAST_SHOWS_LIMIT,
} from "../event-humans/list-human-shows";
import {
  loadHumanUpcomingEventItems,
  publicVenueNameFor,
} from "./derive-human-upcoming-events";
import { resolveVenueConfirmedByEvent } from "../../lib/venue-confirmation";
import {
  isPerformerStatsEligible,
  buildPerformerStatsBlockData,
} from "../../lib/performer-stats";
import {
  placePublicSnapshotSchema,
  type PlacePublicSnapshot,
} from "../place-reviews/anonymization-policy";
import {
  attendeeReviewSnapshotSchema,
  type AttendeeReviewSnapshot,
} from "../attendee-reviews/aggregation-policy";
import {
  deriveTrackRecordView,
  type Cadence,
} from "../place-reviews/track-record-policy";
import {
  listPlaceLineupHistory,
  type LineupHistoryAct,
} from "../place-reviews/list-place-lineup-history";
import type { PlaceRecord } from "@th/ports/repos/places";
import { resolveCategory } from "./page-templates";
import { findCommunityAttribution } from "./community-handover-state";
import { gatePublicPageImages } from "./gate-page-images";

const DERIVED_ANNOUNCEMENT_LIMIT = 10;
const DERIVED_UPCOMING_EVENTS_LIMIT = 8;
/** Acts on the venue page's "recently" line (FR-011: ≤8, newest first). */
const TRACK_RECORD_RECENT_ACTS = 8;
/**
 * How far back the track-record loader reads past events. The read-time
 * derivations need the trailing 180 days (cadence) and the current calendar
 * year in the place's zone (showsThisYear) — 400 days covers both from any
 * date, so a venue with years of history is never paged in full on a public
 * read. `showsHosted` / `firstShowAt` / `lastShowAt` come from the STORED
 * `PlaceStats` columns and are not bounded by this window.
 */
const TRACK_RECORD_EVENT_WINDOW_DAYS = 400;
/** Matches the events adapter's `maxLimit` (100); a larger ask is clamped. */
const TRACK_RECORD_EVENT_PAGE_SIZE = 100;
/**
 * Hard cap on event rows read per page render. ~2.5 shows a day for 400 days;
 * a room past that undercounts `showsThisYear` (and only that) rather than
 * paging forever. Logged when hit.
 */
const TRACK_RECORD_EVENT_CAP = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Five years is well beyond any real listing horizon — wide enough that the
// window never excludes a genuine upcoming show. Mirrors PlaceEventsSection.
const FIVE_YEARS_MS = 1000 * 60 * 60 * 24 * 365 * 5;

// ── Schemas ────────────────────────────────────────────────────────────────

export const getPublicPageInputSchema = z
  .object({
    slug: z.string().trim().min(1).max(200),
  })
  .strict();

export const getPublicPageOutputSchema = z
  .object({
    page: z.object({
      id: z.string(),
      ownerType: z.enum(["HUMAN", "ORGANIZATION", "PLACE"]),
      ownerId: z.string(),
      slug: z.string(),
      displayName: z.string().nullable(),
      bio: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      bannerUrl: z.string().nullable(),
      visibility: z.enum(["PUBLIC", "PRIVATE", "UNLISTED"]),
      allowFollows: z.boolean(),
      showFollowerCount: z.boolean(),
      category: z.string().nullable().default(null),
      templateAppliedCategories: z.array(z.string()).default([]),
      createdAt: z.date(),
      updatedAt: z.date(),
    }),
    blocks: z.array(
      z.object({
        id: z.string(),
        pageId: z.string(),
        kind: z.string(),
        orderIndex: z.number(),
        data: z.unknown(),
        visible: z.boolean(),
        /**
         * Page surface; defaults to "main". In THIS (public) output it is
         * always "main" — non-main sections are member-gated and dropped
         * before expansion (see the filter in `getPublicPage`).
         */
        section: z.string().default("main"),
      }),
    ),
    theme: z
      .object({
        id: z.string(),
        pageId: z.string(),
        colorPrimary: z.string().nullable(),
        colorBg: z.string().nullable(),
        colorText: z.string().nullable(),
        fontKey: z.string().nullable(),
        layoutKey: z.string().nullable(),
      })
      .nullable(),
    entity: entitySummarySchema,
    /**
     * PLACE pages only (moderator place page spec, D6 / D7, FR-006): present
     * while a community moderator's write is newer than the page's latest
     * owner handover (Keep / Clear), so the page says the community keeps
     * it. Derived from audit rows, never stored. Null otherwise and for
     * every HUMAN / ORGANIZATION page.
     */
    communityAttribution: z
      .object({
        maintainedByCommunity: z.literal(true),
        /** ISO string: crosses the ISR / RSC cache boundary as text. */
        lastUpdatedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
    /** When true the caller received a historical slug and should redirect to page.slug. */
    redirect: z.boolean().optional(),
  })
  .strict();

export type GetPublicPageInput = z.infer<typeof getPublicPageInputSchema>;
export type GetPublicPageOutput = z.infer<typeof getPublicPageOutputSchema>;

// ── Deps ───────────────────────────────────────────────────────────────────

export type GetPublicPageDeps = {
  repos: Pick<
    Repos,
    | "entityPages"
    | "humans"
    | "organizations"
    | "places"
    | "announcements"
    | "events"
    | "eventHumans"
    | "humanStats"
    | "placeStats"
    | "reviewAggregates"
    // Performer booking-acceptance gate for HUMAN/ORG summaries (FR-009).
    | "performerProfiles"
    // Availability-onboarding FR-005: the shared entity loader counts a
    // PLACE's availability rows to fold "has hours" into acceptance.
    | "calendars"
    // The PLACE summary's `claimable` hint (shared claim-state helper).
    | "placeVerificationRequests"
    // A PLACE page's community attribution (community-handover-state.ts).
    | "audit"
    // The image review gate: a community moderator's page images stay
    // hidden until approved (gate-page-images.ts).
    | "imageModerationRecords"
  >;
  logger?: LoggerPort;
  /**
   * Best-effort Sentry hook for the swallow branches on this path (repo
   * Sentry convention): a corrupt venue_stats / audience_stats snapshot is
   * failed CLOSED (the block renders nothing), and a failed track_record
   * lineup read degrades to an empty acts line — in each case the page render
   * still succeeds, so the failure must be reported explicitly or it stays
   * invisible.
   */
  reportError?: ReporterPort;
};

/**
 * The data payload injected into a visible `venue_stats` block on a public
 * PLACE page (booking-review-data-weave FR-004/FR-005). Fully server-built —
 * the owner's stored block data contributes ONLY `heading`. The block is
 * omitted from the public payload entirely when there is no publishable
 * snapshot (missing, invalid, or below the headline threshold), so a renderer
 * can trust `snapshot.headline` to be present.
 */
export type VenueStatsBlockData = {
  /** Trusted server-injection marker — renderers must require this. */
  dataSource: "venue_stats";
  /** Owner-editable heading, when set. */
  heading?: string;
  /** Anonymization-policy snapshot; `headline` is guaranteed present. */
  snapshot: PlacePublicSnapshot & {
    headline: NonNullable<PlacePublicSnapshot["headline"]>;
  };
  /** ISO timestamp of the snapshot recompute, or null when unknown. */
  snapshotAt: string | null;
};

/**
 * The data payload injected into a visible `audience_stats` block on a public
 * PLACE page (attendee-reviews FR-005). Verified-attendee testimony — the
 * fan-side sibling of {@link VenueStatsBlockData} (performer testimony), kept
 * deliberately distinct. Fully server-built from the ReviewAggregate(PLACE)
 * snapshot; the owner's stored block data contributes ONLY `heading`. The block
 * is OMITTED from the public payload entirely when there is no publishable
 * aggregate (missing, invalid, or below MIN_REVIEWERS), so a renderer can trust
 * `snapshot.summary` to be present.
 */
export type AudienceStatsBlockData = {
  /** Trusted server-injection marker — renderers must require this. */
  dataSource: "audience_stats";
  /** Owner-editable heading, when set. */
  heading?: string;
  /** Attendee-review snapshot; `summary` is guaranteed present. */
  snapshot: AttendeeReviewSnapshot & {
    summary: NonNullable<AttendeeReviewSnapshot["summary"]>;
  };
  /** ISO timestamp of the snapshot recompute, or null when unknown. */
  snapshotAt: string | null;
};

/**
 * The data payload injected into a `track_record` block on a public PLACE
 * page (venue-track-record-and-review-switch FR-011, rulings R6 / R8 / R9).
 * "THE DOOR": built from things that HAPPENED — PUBLISHED venue-confirmed
 * shows that have ENDED, and lineups that are already public — never from
 * testimony. Fully server-built; the owner's stored block data contributes
 * ONLY `heading`.
 *
 * PINNED: unlike `venue_stats` / `audience_stats`, this block is NEVER
 * omitted. A place with no history gets the ZERO SHAPE (`showsHosted: 0`,
 * nulls, `[]`) so the renderer shows an empty state rather than the block
 * vanishing — the owner has no hand on it, and neither does the data.
 *
 * NOTHING ATTENDANCE-SHAPED LIVES HERE (NFR-004, R4). `checkedInAvg`,
 * `checkedInTotal`, `scannedEventCount` and the derived `attendanceBand` are
 * served ONLY inside the request-to-play read; the loader below builds this
 * payload by positive construction so none of them can ride along, and the
 * public-page test asserts the key set.
 *
 * Dates are ISO strings, like every other date in this file's payloads
 * (`snapshotAt`, upcoming-event `date`): this output crosses the ISR/JSON
 * cache boundary, where a `Date` would silently become a string anyway.
 */
export type TrackRecordBlockData = {
  /** Trusted server-injection marker — renderers must require this. */
  dataSource: "track_record";
  /** Owner-editable heading, when set. */
  heading?: string;
  /** Stored `PlaceStats.showsHosted` — ended, published, venue-confirmed. */
  showsHosted: number;
  /** Shows ended in the current calendar year in the place's timezone. */
  showsThisYear: number;
  /** ISO `endsAt` of the first show, or null when none. */
  firstShowAt: string | null;
  /** Years since the first show, floored to a half; null under half a year. */
  yearsRunning: number | null;
  /** ISO `endsAt` of the most recent show, or null when none. */
  lastShowAt: string | null;
  /** Median-gap bucket over the trailing 180 days; null under 3 shows. */
  cadence: Cadence | null;
  /** ISO start of the current cadence run ("weekly since …"); null with it. */
  cadenceSince: string | null;
  /** Most recent acts first, at most {@link TRACK_RECORD_RECENT_ACTS}. */
  recentActs: ReadonlyArray<{
    /**
     * Opaque per-act identity (the React key) from `listPlaceLineupHistory` —
     * a hash prefix for a linked act, the folded stage name otherwise; never
     * a raw id. Two acts can share a name, so name is not an identity.
     */
    key: string;
    name: string;
    /** `/humans/{slug}` for a linked act with a page; null otherwise. */
    profileUrl: string | null;
    /** Distinct shows this act has played here. */
    timesPlayed: number;
  }>;
  /** Every distinct act that has played here (the "All N acts →" link). */
  allActsCount: number;
  /**
   * The place's IANA timezone, for the renderers to format `firstShowAt` /
   * `lastShowAt` / `cadenceSince` in the VENUE's calendar (spec FU-001: the
   * two surfaces formatted in UTC and a hardcoded zone and disagreed by a
   * day on a late show). Null when the place row was not loaded (zero shape
   * before the place read) or carries none. Not attendance-shaped (NFR-004).
   */
  timeZone: string | null;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function getPublicPage(
  deps: GetPublicPageDeps,
  rawInput: unknown,
): Promise<GetPublicPageOutput> {
  const logger = deps.logger?.child({ useCase: "getPublicPage" });

  const execute = async (): Promise<GetPublicPageOutput> => {
    const input = parseInput(getPublicPageInputSchema, rawInput);

    let page = await deps.repos.entityPages.getBySlug(input.slug);
    let isRedirect = false;

    // If the slug doesn't match a current page, check slug history for redirects.
    if (!page) {
      const currentSlug = await deps.repos.entityPages.resolveSlugHistory(
        input.slug,
      );
      if (currentSlug) {
        page = await deps.repos.entityPages.getBySlug(currentSlug);
        isRedirect = true;
      }
    }

    if (!page) {
      throw fail("PAGE_NOT_FOUND");
    }

    // Respect visibility: PRIVATE pages are never served publicly.
    if (page.visibility === "PRIVATE") {
      throw fail("PAGE_NOT_FOUND");
    }

    // Ban that sticks (2026-09-29): a BANNED human's page, and the page of an
    // org whose every OWNER is banned, answer exactly like a missing page.
    // `ownerBanned` is derived by the adapter at read time, so reactivating
    // the human brings the page back.
    if (page.ownerBanned === true) {
      throw fail("PAGE_NOT_FOUND");
    }

    // Load canonical entity data in parallel with blocks + theme.
    const [blocks, theme, entity, communityAttribution] = await Promise.all([
      deps.repos.entityPages.listBlocks(page.id),
      deps.repos.entityPages.getTheme(page.id),
      requireEntitySummary(deps, page.ownerType, page.ownerId),
      // Not swallowed: a failed read fails the render rather than showing
      // a moderator-written page as the place's own.
      page.ownerType === "PLACE"
        ? findCommunityAttribution(deps.repos, page.id).then((found) =>
            found
              ? {
                  maintainedByCommunity: true as const,
                  lastUpdatedAt: found.lastUpdatedAt.toISOString(),
                }
              : null,
          )
        : Promise.resolve(null),
    ]);

    // Only return visible, MAIN-section blocks for the public page.
    //
    // Non-"main" sections (today: "memberships") are dropped UNCONDITIONALLY,
    // not split downstream: this output is the public, anonymously-cacheable
    // payload (ISR HTML + RSC flight), so member-only content must never
    // enter it at all — a server component forwarding these blocks to any
    // client component serialises them into the HTML for every anonymous
    // viewer. Member-gated blocks are served exclusively by the authed
    // `memberships.memberBlocks` procedure (listMemberBlocks), which verifies
    // the caller's membership first.
    //
    // A page image the image review has not approved is absent from the
    // public payload (avatar, banner, block images), and so from the OG
    // tags built from it. One batched lookup; see gate-page-images.ts.
    const gated = await gatePublicPageImages(
      deps.repos,
      page,
      blocks.filter(
        (b) => b.visible && normalizeBlockSection(b.section) === "main",
      ),
    );

    // A venue page seeded before the pinned `track_record` existed gets one
    // SYNTHESIZED here (spec FU-004) — see `withSyntheticTrackRecord`.
    const visibleBlocks = await expandDerivedBlocks(
      deps,
      gated.page,
      withSyntheticTrackRecord(gated.page, gated.blocks),
      entity,
    );

    return getPublicPageOutputSchema.parse({
      page: gated.page,
      blocks: visibleBlocks,
      theme,
      entity,
      communityAttribution,
      ...(isRedirect ? { redirect: true } : {}),
    });
  };

  if (logger) {
    return logger.withTime("getPublicPage", execute);
  }
  return execute();
}

// ── Entity resolution ──────────────────────────────────────────────────────

/**
 * The public page's missing-owner policy over the shared loader: a page whose
 * owner row has vanished is not renderable publicly, so it 404s exactly as it
 * did when the switch lived here. The SHAPE of the entity is the shared
 * loader's business (see entity-summary.ts) — only this policy is local, and it
 * differs deliberately from the editor's, which degrades to `entity: null`.
 */
async function requireEntitySummary(
  deps: GetPublicPageDeps,
  ownerType: string,
  ownerId: string,
): Promise<EntitySummary> {
  const entity = await loadEntitySummary(deps, ownerType, ownerId);
  if (!entity) throw fail("OWNER_NOT_FOUND");
  return entity;
}

async function expandDerivedBlocks(
  deps: GetPublicPageDeps,
  page: EntityPageRecord,
  blocks: PageBlockRecord[],
  entity: EntitySummary,
): Promise<PageBlockRecord[]> {
  if (blocks.length === 0) return blocks;

  const hasAnnouncements = blocks.some(
    (block) => block.kind === "announcements",
  );
  const announcementItems = hasAnnouncements
    ? await loadAnnouncementItems(deps, page)
    : null;

  // Auto-populate `upcoming_events` blocks from the entity's real published
  // upcoming events. PLACE entities derive from their venue calendar; ORGANIZATION
  // entities derive from their owned events (the org "standard" template leads
  // with this zone). HUMAN entities derive from their real performances via the
  // SAME repo path the `shows` block uses — but ONLY when no `shows` block is
  // among the blocks being expanded: HumanEntityLayout zones both kinds into
  // one "Upcoming shows" zone, so deriving both would list every event twice.
  // A HUMAN with zero upcoming performances keeps their stored static
  // `data.events` (the loader returns null) — an owner-curated list must not
  // be wiped to empty.
  const hasUpcomingEvents = blocks.some(
    (block) => block.kind === "upcoming_events",
  );
  // DELIBERATE divergence from get-my-page: `blocks` here is the VISIBLE set
  // (the caller pre-filters), so a HIDDEN `shows` block does NOT suppress the
  // HUMAN derivation — the public page can't double-list what it never renders.
  // The editor counterpart counts ALL blocks because it genuinely renders
  // hidden ones. Do not "unify" the two checks: making the editor count only
  // visible blocks (or public count hidden ones) reintroduces double-listing
  // on one surface or the other.
  const hasShowsBlock = blocks.some((block) => block.kind === "shows");
  const upcomingEventItems = hasUpcomingEvents
    ? entity.type === "PLACE"
      ? await loadPlaceUpcomingEventItems(deps, entity)
      : entity.type === "ORGANIZATION"
        ? await loadOrgUpcomingEventItems(deps, entity)
        : entity.type === "HUMAN" && !hasShowsBlock
          ? await loadHumanUpcomingEventItems(deps, page.ownerId)
          : null
    : null;

  // Musician EPK derived data (HUMAN pages only). Each query is guarded by a
  // block-presence check; blocks here are already visibility-filtered. An
  // ELIGIBLE visible `stats` block gets its data server-rebuilt; an ineligible
  // one is OMITTED from the public output entirely (FR-003 — render nothing
  // publicly). `statsBlockData` is null when ineligible (or no stats block).
  const isHuman = entity.type === "HUMAN";
  // Venue review stats (PLACE pages only, booking-review-data-weave FR-004):
  // like the HUMAN `stats` block, a visible `venue_stats` block is rebuilt
  // entirely server-side; `venueStatsData` is null when there is nothing
  // publishable and the block is then omitted from the output.
  const isPlace = entity.type === "PLACE";
  const [
    upcomingShows,
    pastShows,
    statsBlockData,
    trackRecordData,
    venueStatsData,
    audienceStatsData,
  ] = await Promise.all([
    isHuman && blocks.some((b) => b.kind === "shows")
      ? loadHumanShows(deps, page.ownerId, "upcoming")
      : Promise.resolve(null),
    isHuman && blocks.some((b) => b.kind === "past_shows")
      ? loadHumanShows(deps, page.ownerId, "past")
      : Promise.resolve(null),
    isHuman && blocks.some((b) => b.kind === "stats")
      ? loadPublicStatsData(deps, page.ownerId)
      : Promise.resolve(null),
    // The door's record (venue-track-record-and-review-switch FR-011). No
    // switch gates it and it is never omitted: the loader returns the zero
    // shape for a place with no history. Only a visible `track_record` block
    // triggers the read (the kind is pinned, so on a venue page that is
    // every page).
    isPlace && blocks.some((b) => b.kind === "track_record")
      ? loadTrackRecordData(deps, page.ownerId)
      : Promise.resolve(null),
    // Performer-review switch (venue-track-record-and-review-switch FR-003,
    // reversing 2026-07-23 FR-007): a place that turned performer reviews off
    // publishes no venue_stats — the loader is skipped outright. Fail-closed
    // like its sibling below: only an explicit `true` loads.
    isPlace &&
    entity.type === "PLACE" &&
    entity.communityReviewsEnabled === true &&
    blocks.some((b) => b.kind === "venue_stats")
      ? loadVenueStatsData(deps, page.ownerId, entity.communityReviewsEnabled)
      : Promise.resolve(null),
    // FR-005 opt-in gate: the public attendee aggregate renders ONLY when the
    // owner has published it (Place.attendeeReviewsPublic). Skip the load
    // entirely when false — the block is then omitted from the public payload.
    isPlace &&
    entity.type === "PLACE" &&
    entity.attendeeReviewsPublic === true &&
    blocks.some((b) => b.kind === "audience_stats")
      ? loadAudienceStatsData(deps, page.ownerId, entity.attendeeReviewsPublic)
      : Promise.resolve(null),
  ]);

  const expanded = blocks.map((block): PageBlockRecord | null => {
    if (block.kind === "shows" && upcomingShows) {
      return {
        ...block,
        data: { ...toBlockData(block.data), dataSource: "shows", events: upcomingShows },
      };
    }

    if (block.kind === "past_shows" && pastShows) {
      return {
        ...block,
        data: { ...toBlockData(block.data), dataSource: "shows", events: pastShows },
      };
    }

    if (block.kind === "stats") {
      // FR-003: an ineligible stats block renders nothing publicly — drop it
      // from the output entirely (never emit `{eligible:false}` here; that
      // state is owner-editor-only). An eligible block is fully server-built,
      // never spreading the owner's raw stored `data` (NFR-001).
      return statsBlockData ? { ...block, data: statsBlockData } : null;
    }

    if (block.kind === "track_record") {
      // venue-track-record FR-011: server-built like `venue_stats` below, but
      // NEVER omitted on a PLACE page — an empty history is the zero shape,
      // not a missing block (the kind is pinned; R6). On a non-PLACE page the
      // kind is invalid and the loader never ran: drop it rather than echo
      // the owner's stored `data`. Only `heading` is taken from stored data,
      // extracted explicitly so forged keys can't ride along.
      if (!trackRecordData) return null;
      const heading = toBlockData(block.data).heading;
      return {
        ...block,
        data: {
          ...(typeof heading === "string" ? { heading } : {}),
          ...trackRecordData,
        },
      };
    }

    if (block.kind === "venue_stats") {
      // booking-review-data-weave FR-004/FR-005: same mechanism as `stats`
      // above. No publishable snapshot (missing / invalid / below the
      // headline threshold) → OMIT the block from the public payload
      // entirely. When publishable, the data is fully server-built from the
      // anonymization-policy snapshot — never live PlaceStats columns and
      // never the owner's stored `data`, except the one owner-editable field
      // (`heading`), extracted explicitly so forged keys can't ride along.
      if (!venueStatsData) return null;
      const heading = toBlockData(block.data).heading;
      return {
        ...block,
        data: {
          ...(typeof heading === "string" ? { heading } : {}),
          ...venueStatsData,
        },
      };
    }

    if (block.kind === "audience_stats") {
      // attendee-reviews FR-005: identical mechanism to `venue_stats`. No
      // publishable aggregate (missing / invalid / below MIN_REVIEWERS) → OMIT
      // the block from the public payload entirely. When publishable, the data
      // is fully server-built from the ReviewAggregate(PLACE) snapshot — never
      // live review rows and never the owner's stored `data`, except the one
      // owner-editable field (`heading`), extracted explicitly so forged keys
      // can't ride along.
      if (!audienceStatsData) return null;
      const heading = toBlockData(block.data).heading;
      return {
        ...block,
        data: {
          ...(typeof heading === "string" ? { heading } : {}),
          ...audienceStatsData,
        },
      };
    }

    if (block.kind === "upcoming_events" && upcomingEventItems) {
      return {
        ...block,
        data: {
          ...toBlockData(block.data),
          // HUMAN derivation reuses the performances path, so it carries the
          // same trusted `shows` marker the `shows` block derivation emits.
          dataSource:
            entity.type === "ORGANIZATION"
              ? "org"
              : entity.type === "PLACE"
                ? "place"
                : "shows",
          events: upcomingEventItems,
        },
      };
    }

    if (block.kind === "announcements" && announcementItems) {
      return {
        ...block,
        data: {
          ...toBlockData(block.data),
          dataSource: "announcements",
          announcements: announcementItems,
        },
      };
    }

    if (block.kind === "location_map" && entity.type === "PLACE") {
      // The summary is ALREADY redacted (`loadEntitySummary` →
      // `redactPlaceLocation`), so a withheld venue arrives here with a null
      // `formattedAddress` and either an obfuscated centre or no coordinates
      // at all. `areaLabel` is preferred over the city/region fallback because
      // it is the label the venue CHOSE to publish. `radiusMeters` / `hidden`
      // ride along so the map draws a circle (or nothing) rather than a pin.
      return {
        ...block,
        data: {
          ...toBlockData(block.data),
          dataSource: "place",
          address:
            entity.formattedAddress ??
            entity.areaLabel ??
            formatPlaceRegion(entity),
          lat: entity.lat ?? undefined,
          lng: entity.lng ?? undefined,
          isExact: entity.locationIsExact !== false,
          hidden: entity.locationHidden === true,
          radiusMeters: entity.locationRadiusMeters ?? undefined,
        },
      };
    }

    return block;
  });

  // Drop any blocks the expansion omitted (an ineligible public stats block,
  // or a venue_stats/audience_stats block with no publishable snapshot).
  return expanded.filter((block): block is PageBlockRecord => block !== null);
}

async function loadAnnouncementItems(
  deps: GetPublicPageDeps,
  page: EntityPageRecord,
): Promise<ReturnType<typeof toAnnouncementItem>[]> {
  if (page.ownerType === "ORGANIZATION") {
    const result = await deps.repos.announcements.listPublicForOrgEntityPage({
      orgId: page.ownerId,
      limit: DERIVED_ANNOUNCEMENT_LIMIT,
      offset: 0,
    });
    return result.items.map(toAnnouncementItem);
  }

  if (page.ownerType === "HUMAN") {
    const result = await deps.repos.announcements.listPublicForSenderEntityPage(
      {
        humanId: page.ownerId,
        limit: DERIVED_ANNOUNCEMENT_LIMIT,
        offset: 0,
      },
    );
    return result.items.map(toAnnouncementItem);
  }

  return [];
}

async function loadHumanShows(
  deps: GetPublicPageDeps,
  humanId: string,
  when: "upcoming" | "past",
): Promise<ReturnType<typeof toHumanShowSummary>[]> {
  const performances = await deps.repos.eventHumans.listPerformancesByHuman({
    humanId,
    roles: PUBLIC_LINEUP_ROLES,
    when,
    now: new Date(),
    limit: when === "past" ? PAST_SHOWS_LIMIT : undefined,
  });
  // PUBLIC page (security review M1): the venue is named only when it
  // vouches for the show; otherwise the coarse location label, else null.
  // One place read per distinct venue, never per show.
  const confirmedByEvent = await resolveVenueConfirmedByEvent(
    deps,
    performances.map((p) => ({ ...p, id: p.eventId })),
    { useCase: "getPublicPage" },
  );
  return performances.map((performance) => ({
    ...toHumanShowSummary(performance),
    venueName:
      publicVenueNameFor(
        performance,
        confirmedByEvent.get(performance.eventId) === true,
      ) ?? null,
  }));
}

async function loadPublicStatsData(
  deps: GetPublicPageDeps,
  humanId: string,
): Promise<Record<string, unknown> | null> {
  const stats = await deps.repos.humanStats.findByHumanId(humanId);
  // FR-003: below the eligibility threshold, render NOTHING publicly — return
  // null so the caller omits the block from the output entirely (the
  // owner-facing "not yet eligible" hint lives in get-my-page only). When
  // eligible, emit the whitelisted server-built payload — never derived from
  // the block's stored `data` (NFR-001).
  if (!isPerformerStatsEligible(stats)) {
    return null;
  }
  return { dataSource: "stats", ...buildPerformerStatsBlockData(stats) };
}

function emptyTrackRecordData(
  timeZone: string | null = null,
): Omit<TrackRecordBlockData, "heading"> {
  return {
    dataSource: "track_record",
    showsHosted: 0,
    showsThisYear: 0,
    firstShowAt: null,
    yearsRunning: null,
    lastShowAt: null,
    cadence: null,
    cadenceSince: null,
    recentActs: [],
    allActsCount: 0,
    timeZone,
  };
}

/** Id prefix of a track_record block synthesized on the public read (FU-004). */
export const SYNTHETIC_TRACK_RECORD_ID_PREFIX = "synthetic:track_record:";

/**
 * Spec FU-004 (rulings R6 / R9). `track_record` is pinned at PLACE:venue
 * template revision 4, but template seeding runs only on the OWNER's editor
 * load (`getMyPage`) — so an unclaimed venue, whose owner never opens the
 * editor, would never show the one block whose whole value is that the owner
 * has no hand on it. Fixed on the READ, not by storing more state: a venue
 * page with no visible MAIN-section `track_record` gets one synthesized into
 * the public payload, which `expandDerivedBlocks` then fills exactly as it
 * fills a stored one (the stored block data contributes only `heading`, and
 * a synthetic block has none).
 *
 *   · A stored block always wins — never two.
 *   · Venue pages only: PLACE owner AND a venue category — the stored
 *     `category` when set, else the one `getMyPage` would seed
 *     (`resolveCategory`), so a future non-venue PLACE template does not get
 *     a venue block. HUMAN / ORGANIZATION pages never do.
 *   · Position mirrors the template: directly after `photos`; without one,
 *     directly before `venue_stats`; else last. The public layouts order by
 *     ARRAY position within a priority bucket, so the splice is what places
 *     it; `orderIndex` is set half a step off its neighbour so a consumer
 *     sorting by it agrees rather than tying.
 *   · Stable id (`synthetic:track_record:<pageId>`) so React keys and any
 *     cache diffing stay steady across renders. It is not a row: nothing may
 *     mutate by it (the editor path never sees it — it seeds the real row).
 */
function withSyntheticTrackRecord(
  page: EntityPageRecord,
  blocks: PageBlockRecord[],
): PageBlockRecord[] {
  if (page.ownerType !== "PLACE") return blocks;
  // `getMyPage` always RESOLVES a PLACE to "venue" and ignores the stored
  // column; honouring a stored non-venue category here is forward-looking —
  // no reachable state stores one for a PLACE today.
  const category =
    page.category ??
    resolveCategory(page.ownerType, { performerEnabled: false });
  if (category !== "venue") return blocks;
  if (blocks.some((block) => block.kind === "track_record")) return blocks;

  const photosAt = blocks.findIndex((block) => block.kind === "photos");
  const venueStatsAt = blocks.findIndex((block) => block.kind === "venue_stats");
  let insertAt: number;
  let orderIndex: number;
  if (photosAt >= 0) {
    insertAt = photosAt + 1;
    orderIndex = blocks[photosAt]!.orderIndex + 0.5;
  } else if (venueStatsAt >= 0) {
    insertAt = venueStatsAt;
    orderIndex = blocks[venueStatsAt]!.orderIndex - 0.5;
  } else {
    insertAt = blocks.length;
    orderIndex =
      blocks.reduce((max, block) => Math.max(max, block.orderIndex), -1) + 1;
  }

  const synthetic: PageBlockRecord = {
    id: `${SYNTHETIC_TRACK_RECORD_ID_PREFIX}${page.id}`,
    pageId: page.id,
    kind: "track_record",
    orderIndex,
    data: {},
    visible: true,
    section: "main",
  };
  return [...blocks.slice(0, insertAt), synthetic, ...blocks.slice(insertAt)];
}

/**
 * venue-track-record-and-review-switch FR-011. Reads the STORED `PlaceStats`
 * track-record columns directly (NOT `publicSnapshot`, which is performer
 * testimony on a weekly cadence), the trailing window of ended shows for the
 * read-time derivations, and the public lineup history. Always resolves to a
 * payload — the zero shape when the place has no stats row yet (the job has
 * not run for it) or has hosted nothing.
 *
 * Throws like its siblings on a failed stats / events read (nothing to fall
 * back to; the page is wrong without them). The ONE swallow is the lineup
 * arm — see `loadTrackRecordLineup`.
 */
async function loadTrackRecordData(
  deps: GetPublicPageDeps,
  placeId: string,
): Promise<Omit<TrackRecordBlockData, "heading">> {
  // The place row is read FIRST, for its timezone ("this year" is the
  // VENUE's calendar year, and the renderers format every date in it — even
  // on the zero shape, FU-001) and for the confirmation filter (only
  // venue-owned or venue-stamped shows are the venue's history). A row that
  // vanished between the summary load and here fails CLOSED to the zero
  // shape with no zone, as the sibling upcoming-events loader fails closed
  // to an empty filter.
  const place = await deps.repos.places.getById(placeId);
  if (!place) return emptyTrackRecordData();
  const timeZone = place.timezone ?? null;

  const stats = await deps.repos.placeStats.getByPlaceId(placeId);
  // `!(x > 0)` rather than `x <= 0`: a row from before the track-record
  // columns existed (or a partial fake) carries `undefined`, which must read
  // as "nothing hosted", not as a number to derive from.
  if (!stats || !(stats.showsHosted > 0)) return emptyTrackRecordData(timeZone);

  const now = new Date();
  const [pastEventEnds, lineup] = await Promise.all([
    listTrackRecordEventEnds(deps, place, now),
    // An ARCHIVED place has no public lineup to show — `listPlaceLineupHistory`
    // would refuse it with a typed error on every render. That is an INPUT
    // condition, not a failure: skip the read, serve an empty acts line, and
    // report nothing (consistent with the request-to-play read answering
    // null for archived). The swallow inside `loadTrackRecordLineup` stays
    // for genuine failures.
    place.status === "ARCHIVED"
      ? Promise.resolve({ recent: [], allActsCount: 0 })
      : loadTrackRecordLineup(deps, placeId, now),
  ]);

  // `checkedInAvg` is deliberately NOT handed to the view (NFR-004, R4): the
  // band it would derive is served only by the request-to-play read. Passing
  // null means nothing attendance-shaped is even computed on this path.
  const view = deriveTrackRecordView({
    stats: { firstShowAt: stats.firstShowAt, checkedInAvg: null },
    pastEventEnds,
    now,
    timeZone: place.timezone,
  });

  return {
    dataSource: "track_record",
    showsHosted: stats.showsHosted,
    // `showsHosted` is the STORED column (recomputed every 15 minutes) while
    // `showsThisYear` is counted LIVE from event rows, so a show that ended
    // since the last recalculation can make "N this year" exceed the total.
    // Clamp so the ledger never reads "12 hosted, 13 this year".
    showsThisYear: Math.min(view.showsThisYear, stats.showsHosted),
    firstShowAt: toIsoOrNull(stats.firstShowAt),
    yearsRunning: view.yearsRunning,
    lastShowAt: toIsoOrNull(stats.lastShowAt),
    cadence: view.cadence,
    cadenceSince: toIsoOrNull(view.cadenceSince),
    recentActs: lineup.recent.map((act) => ({
      key: act.key,
      name: act.name,
      profileUrl: act.profileUrl,
      timesPlayed: act.timesPlayed,
    })),
    allActsCount: lineup.allActsCount,
    timeZone,
  };
}

/**
 * `endsAt` of every venue-confirmed PUBLISHED-or-COMPLETED (R10) show that ended in the trailing
 * {@link TRACK_RECORD_EVENT_WINDOW_DAYS}, on the RULED `endsAt` basis (a row
 * without one — a projection gap — falls back to `startsAt`, as the
 * recalculation job does). Ends after `now` are dropped by the view.
 */
async function listTrackRecordEventEnds(
  deps: GetPublicPageDeps,
  place: PlaceRecord,
  now: Date,
): Promise<Date[]> {
  const from = new Date(now.getTime() - TRACK_RECORD_EVENT_WINDOW_DAYS * DAY_MS);
  const venueConfirmedFor = venueConfirmedFilterFor(place);
  const ends: Date[] = [];
  let offset = 0;

  while (ends.length < TRACK_RECORD_EVENT_CAP) {
    const page = await deps.repos.events.listPublishedByPlace({
      placeId: place.id,
      from,
      to: now,
      status: "past",
      limit: TRACK_RECORD_EVENT_PAGE_SIZE,
      offset,
      venueConfirmedFor,
      // R10: a show `completeEvent` closed out still happened.
      statuses: TRACK_RECORD_EVENT_STATUSES,
    });
    for (const event of page.items) {
      ends.push(event.endsAt ?? event.startsAt);
    }
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.pageInfo.total) break;
  }

  if (ends.length >= TRACK_RECORD_EVENT_CAP) {
    deps.logger?.warn("entity-pages.track-record.event-cap", {
      placeId: place.id,
      cap: TRACK_RECORD_EVENT_CAP,
    });
  }
  return ends;
}

/**
 * The lineup arm of the track record — the ONE swallow on this path
 * (NFR-003). `listPlaceLineupHistory` is its own use case with its own gates
 * (unknown / archived place → typed error) and a brand-new adapter query; a
 * failure there must degrade the acts line to empty, not take down every
 * venue page (the block is pinned, so every venue page carries it). Reported
 * via `reportError` and logged at ERROR (warn is not captured) so the
 * degradation is never silent.
 */
async function loadTrackRecordLineup(
  deps: GetPublicPageDeps,
  placeId: string,
  now: Date,
): Promise<{ recent: LineupHistoryAct[]; allActsCount: number }> {
  try {
    const history = await listPlaceLineupHistory(
      {
        repos: deps.repos,
        clock: { now: () => now },
        ...(deps.logger ? { logger: deps.logger } : {}),
      },
      { placeId, recentLimit: TRACK_RECORD_RECENT_ACTS, now },
    );
    return { recent: history.recent, allActsCount: history.allActsCount };
  } catch (err) {
    deps.logger?.error("entity-pages.track-record-lineup.failed", {
      placeId,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "getPublicPage", step: "trackRecordLineup" },
        extra: { placeId },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return { recent: [], allActsCount: 0 };
  }
}

function toIsoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

async function loadVenueStatsData(
  deps: GetPublicPageDeps,
  placeId: string,
  communityReviewsEnabled: boolean,
): Promise<Omit<VenueStatsBlockData, "heading"> | null> {
  // FR-003 defense in depth: the READ itself refuses to serve performer stats
  // for a place whose switch is off — not merely the call-site check. Not a
  // swallow (nothing failed), so nothing to report.
  if (communityReviewsEnabled !== true) return null;

  const stats = await deps.repos.placeStats.getByPlaceId(placeId);
  // No snapshot published yet → nothing to show. NEVER fall back to live
  // PlaceStats columns — the weekly snapshot is the anonymity policy boundary
  // (place-review-anonymization FR-001/FR-003).
  if (!stats || stats.publicSnapshot == null) return null;

  const parsed = placePublicSnapshotSchema.safeParse(stats.publicSnapshot);
  if (!parsed.success) {
    // Corrupt/incompatible snapshot: fail CLOSED for anonymity (block renders
    // nothing; the page render still succeeds) — and make the swallow visible
    // to operators (repo Sentry convention; matches getPlacePublicStats).
    deps.logger?.error("entity-pages.venue-stats-snapshot.invalid", {
      placeId,
      issues: parsed.error.issues,
    });
    try {
      deps.reportError?.(parsed.error, {
        tags: { useCase: "getPublicPage", step: "venueStatsSnapshot" },
        extra: { placeId },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return null;
  }

  // `{ version: 1 }` without a headline slice = below the per-slice
  // k-thresholds — publish nothing, not zeroes.
  const headline = parsed.data.headline;
  if (headline === undefined) return null;

  return {
    dataSource: "venue_stats",
    snapshot: { ...parsed.data, headline },
    snapshotAt: stats.publicSnapshotAt
      ? stats.publicSnapshotAt.toISOString()
      : null,
  };
}

async function loadAudienceStatsData(
  deps: GetPublicPageDeps,
  placeId: string,
  attendeeReviewsPublic: boolean,
): Promise<Omit<AudienceStatsBlockData, "heading"> | null> {
  // FR-005 defense in depth: the READ itself refuses to serve the attendee
  // aggregate unless the owner has opted in — not merely the block-visibility
  // check at the call site. A false flag renders nothing publicly.
  if (!attendeeReviewsPublic) return null;

  const row = await deps.repos.reviewAggregates.getBySubject({
    subjectType: "PLACE",
    subjectId: placeId,
  });
  // No aggregate published yet → nothing to show. NEVER fall back to live
  // AttendeeReview rows — the weekly snapshot is the anonymity policy boundary
  // (attendee-reviews FR-003/FR-004).
  if (!row || row.snapshot == null) return null;

  const parsed = attendeeReviewSnapshotSchema.safeParse(row.snapshot);
  if (!parsed.success) {
    // Corrupt/incompatible snapshot: fail CLOSED for anonymity (block renders
    // nothing; the page render still succeeds) — and make the swallow visible
    // to operators (repo Sentry convention; matches loadVenueStatsData).
    deps.logger?.error("entity-pages.audience-stats-snapshot.invalid", {
      placeId,
      issues: parsed.error.issues,
    });
    try {
      deps.reportError?.(parsed.error, {
        tags: { useCase: "getPublicPage", step: "audienceStatsSnapshot" },
        extra: { placeId },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return null;
  }

  // `{ version: 1 }` without a summary = below MIN_REVIEWERS — publish nothing,
  // not zeroes.
  const summary = parsed.data.summary;
  if (summary === undefined) return null;

  return {
    dataSource: "audience_stats",
    snapshot: { ...parsed.data, summary },
    snapshotAt: row.computedAt ? row.computedAt.toISOString() : null,
  };
}

async function loadPlaceUpcomingEventItems(
  deps: GetPublicPageDeps,
  entity: Extract<EntitySummary, { type: "PLACE" }>,
): Promise<ReturnType<typeof toUpcomingEventItem>[]> {
  const now = new Date();
  const to = new Date(now.getTime() + FIVE_YEARS_MS);
  // Confirmed-only (venue-confirmation spec, docs/specs/2026-08-27): the
  // venue's public page lists its own events and the third-party ones it
  // vouched for — never an unconfirmed claim on its room. The summary carries
  // no owner ids, so the place row is read for them (the SQL predicate is
  // `isVenueConfirmed`). A vanished row — the summary was built from it a
  // moment ago — fails CLOSED on BOTH row-derived arms: empty owner sets, and
  // `acceptsCommunityListings: false` so a vanished place consents to nothing.
  // Only the stamp arm, which reads the event alone, can still match.
  const place = await deps.repos.places.getById(entity.id);
  const page = await deps.repos.events.listPublishedByPlace({
    placeId: entity.id,
    from: now,
    to,
    status: "upcoming",
    limit: DERIVED_UPCOMING_EVENTS_LIMIT,
    offset: 0,
    // A banned owner's events are withheld from the venue's page.
    excludeBannedOwners: true,
    venueConfirmedFor: venueConfirmedFilterFor(
      place ?? {
        id: entity.id,
        orgIdsWithAccess: [],
        humanIdsWithAccess: [],
        acceptsCommunityListings: false,
      },
    ),
  });
  return page.items.map((record) => toUpcomingEventItem(record, entity.name));
}

async function loadOrgUpcomingEventItems(
  deps: GetPublicPageDeps,
  entity: Extract<EntitySummary, { type: "ORGANIZATION" }>,
): Promise<ReturnType<typeof toUpcomingEventItem>[]> {
  const now = new Date();
  const to = new Date(now.getTime() + FIVE_YEARS_MS);
  const page = await deps.repos.events.listPublishedByOrg({
    orgId: entity.id,
    from: now,
    to,
    status: "upcoming",
    limit: DERIVED_UPCOMING_EVENTS_LIMIT,
    offset: 0,
  });
  // Org events aren't pinned to one venue, so no venueName is injected — the
  // renderer omits the line when it's absent (unlike the PLACE path, which
  // always names the host venue).
  return page.items.map((record) => toUpcomingEventItem(record));
}

function toUpcomingEventItem(record: EventRecord, venueName?: string) {
  return {
    id: record.id,
    title: record.title,
    date: record.startsAt.toISOString(),
    ...(venueName ? { venueName } : {}),
    ...(record.slug ? { slug: record.slug } : {}),
  };
}

function toAnnouncementItem(announcement: AnnouncementRecord) {
  return {
    id: announcement.id,
    title: announcement.subject,
    bodyHtml: sanitizeAnnouncementHtml(announcement.bodyHtml),
    date: (announcement.sentAt ?? announcement.createdAt).toISOString(),
  };
}

function toBlockData(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>) }
    : {};
}

function formatPlaceRegion(
  place: Extract<EntitySummary, { type: "PLACE" }>,
): string | undefined {
  return [place.city, place.region].filter(Boolean).join(", ") || undefined;
}
