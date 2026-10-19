export type PageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";
export type PageVisibility = "PUBLIC" | "PRIVATE" | "UNLISTED";

export interface EntityPageRecord {
  id: string;
  ownerType: PageOwnerType;
  ownerId: string;
  slug: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  visibility: PageVisibility;
  allowFollows: boolean;
  showFollowerCount: boolean;
  /** Current content classification (free-form; e.g. "generic" | "musician" | "venue"). */
  category: string | null;
  /**
   * Every category that has ever been template-seeded onto this page. Set-once
   * per category and never cleared, so a category is only ever seeded a single
   * time in a page's lifetime (idempotent seeding — see seed-page-template-blocks).
   */
  templateAppliedCategories: string[];
  /**
   * DERIVED at read time, never stored (ban-that-sticks, 2026-09-29): the
   * page's owner is withheld from public reads because of a ban — a BANNED
   * human, or an org whose every OWNER is banned. Loaded by `getBySlug` (the
   * public read) only; `undefined` elsewhere.
   */
  ownerBanned?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageThemeRecord {
  id: string;
  pageId: string;
  colorPrimary: string | null;
  colorBg: string | null;
  colorText: string | null;
  fontKey: string | null;
  layoutKey: string | null;
}

export interface PageBlockRecord {
  id: string;
  pageId: string;
  kind: string;
  orderIndex: number;
  data: unknown;
  visible: boolean;
  /**
   * Which page surface the block belongs to: "main" (the default page body)
   * or "memberships" (the member-gated Membership tab). Free-form string,
   * validated in core like `kind` (see PAGE_BLOCK_SECTIONS). The adapter
   * always supplies it (defaulting to "main", so existing pages render
   * identically); it is OPTIONAL here so client-side editor snapshots and
   * fixtures that predate it remain valid — consumers must treat absence as
   * "main" (normalizeBlockSection).
   */
  section?: string;
}

export interface UpsertEntityPageInput {
  ownerType: PageOwnerType;
  ownerId: string;
  slug: string;
  displayName: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  visibility?: PageVisibility;
  allowFollows?: boolean;
  showFollowerCount?: boolean;
}

/**
 * One row of a `bulkCreate` insert. CREATE-only, so unlike
 * `UpsertEntityPageInput` there is nothing to preserve: every column the
 * caller omits takes its schema default (`visibility` PUBLIC, `allowFollows`
 * true, `showFollowerCount` false) rather than "leave as-is".
 *
 * `slug` must be a FLAT single URL segment — it is what `/places/[slug]` and
 * `/p/[slug]` resolve on. For places that means
 * `buildPageSlug(name, placeId)`, never `Place.slug`.
 */
export interface BulkCreateEntityPageInput {
  ownerType: PageOwnerType;
  ownerId: string;
  slug: string;
  displayName: string | null;
  bio?: string | null;
}

export interface UpsertPageThemeInput {
  pageId: string;
  colorPrimary?: string | null;
  colorBg?: string | null;
  colorText?: string | null;
  fontKey?: string | null;
  layoutKey?: string | null;
}

export interface UpsertPageBlockInput {
  pageId: string;
  kind: string;
  orderIndex?: number;
  data?: unknown;
  visible?: boolean;
  /** Page surface ("main" | "memberships"); defaults to "main" when omitted. */
  section?: string;
}

export interface UpdatePageBlockInput {
  id: string;
  kind?: string;
  orderIndex?: number;
  data?: unknown;
  visible?: boolean;
}

/**
 * Most recent op-batch ids a draft remembers (newest last). Mirrors the SQL
 * CHECK `PageDraft_applied_batch_ids_check`; core trims to this before
 * calling `writeDraft`, and the adapter refuses a longer list.
 */
export const PAGE_DRAFT_APPLIED_BATCH_IDS_MAX = 100;

/**
 * The shared unpublished draft of one EntityPage (page editor; schema doc on
 * `model PageDraft` in packages/db/prisma/entity-page.prisma). Storage shape
 * only: the four JSON overlays are OPEN objects whose inner shape belongs to
 * core (spec R19), so they are typed as plain records here. Never `null`
 * (the SQL CHECK requires JSON objects; a cleared draft holds `{}`).
 */
export interface PageDraftRecord {
  id: string;
  pageId: string;
  /** Page / theme / block overlay keyed by op path. `data.v` = format version. */
  data: Record<string, unknown>;
  /** Place fields edited on the canvas (venue facts). */
  placePatch: Record<string, unknown>;
  /** Live Place value of each patched field when the draft first touched it. */
  placeBase: Record<string, unknown>;
  /**
   * path → { humanId, at (ISO), rev }: who edited each path last, and in
   * which revision. Reserved keys `$base` → { rev } (the revision the
   * overlay started from, i.e. the last clear) and `$pruned` → { rev }.
   * Shape owned by core (page-draft-ops.ts).
   */
  fieldEditors: Record<string, unknown>;
  /** Most recent op-batch ids, newest last, at most PAGE_DRAFT_APPLIED_BATCH_IDS_MAX. */
  appliedBatchIds: string[];
  /** Only ever increases, for the life of the page (never resets). */
  revision: number;
  /** The revision the last Publish cleared to; null until the first Publish. */
  lastPublishedRevision: number | null;
  /** Plain id, no FK: readers must tolerate an id that no longer resolves. */
  updatedByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Full next state for `writeDraft`: every overlay column is replaced, not
 * merged. Core computes it under the row lock from the locked record.
 */
export interface WritePageDraftInput {
  data: Record<string, unknown>;
  placePatch: Record<string, unknown>;
  placeBase: Record<string, unknown>;
  fieldEditors: Record<string, unknown>;
  /** Already trimmed by core to at most PAGE_DRAFT_APPLIED_BATCH_IDS_MAX. */
  appliedBatchIds: string[];
  revision: number;
  updatedByHumanId: string | null;
}

/**
 * Publish / Discard clear. Overlays reset to `{}`; appliedBatchIds is kept.
 * `lastPublishedRevision` is set only when given (Publish passes the new
 * revision; Discard omits it and the column keeps its value).
 */
export interface ClearPageDraftInput {
  revision: number;
  lastPublishedRevision?: number;
  updatedByHumanId: string | null;
}

/**
 * Public page data returned by getPublicPage / the /p/[slug] route.
 * Includes the page, visible blocks, theme, and a summary of the owning entity.
 */
export interface PublicPageData {
  page: EntityPageRecord;
  blocks: PageBlockRecord[];
  theme: PageThemeRecord | null;
  entity: EntitySummary;
}

/**
 * Minimal public-facing entity data. The page renderer uses this for
 * fallback names, canonical avatars, trust badges, etc.
 */
export type EntitySummary =
  | {
      type: "HUMAN";
      id: string;
      name: string | null;
      /**
       * Self-declared industry jobs (HumanJob enum values, e.g. MUSICIAN).
       * Optional: client-side fallback summaries (editor preview) omit it;
       * the server payloads always populate it.
       */
      jobs?: string[];
      /** Genre tags (relevant when MUSICIAN is in jobs). Optional as above. */
      genreTags?: string[];
      /** Free-text description when OTHER is in jobs. Optional as above. */
      otherJobDescription?: string | null;
      /**
       * True only when this human is performer-enabled AND opted in to
       * receiving organizer booking requests (organizer-booking-requests
       * FR-009). Optional: client-side fallback summaries omit it.
       */
      acceptsBookingRequests?: boolean;
    }
  | {
      type: "ORGANIZATION";
      id: string;
      name: string;
      slug: string;
      trustTier: string;
      trustBadgeLabel: string | null;
      /**
       * True only when this org act is performer-enabled AND opted in to
       * receiving organizer booking requests (organizer-booking-requests
       * FR-009). Optional: client-side fallback summaries omit it.
       */
      acceptsBookingRequests?: boolean;
    }
  | {
      type: "PLACE";
      id: string;
      name: string;
      /**
       * ALREADY REDACTED by `loadEntitySummary` (`redactPlaceLocation`). Null
       * whenever the venue withholds its address — a withheld venue publishes
       * `city`/`region`/`areaLabel` and nothing finer. Never the raw column.
       */
      formattedAddress: string | null;
      city: string | null;
      region: string | null;
      /**
       * True pin for an EXACT venue, obfuscated circle CENTRE for an OBSCURED
       * one with a radius, null when fully hidden. Draw a circle of
       * `locationRadiusMeters` around it, never a pin, unless `locationIsExact`.
       */
      lat: number | null;
      lng: number | null;
      /** False = the address is withheld. Optional: client fallback summaries omit it. */
      locationIsExact?: boolean;
      /** True = fully hidden. Draw no map at all. */
      locationHidden?: boolean;
      /** Obfuscation circle radius in metres; null unless a circle is drawn. */
      locationRadiusMeters?: number | null;
      /** Coarse area label — the only place string a withheld venue publishes. */
      areaLabel?: string | null;
      /** Advertised standing/seated capacity, when the venue has published one. */
      capacity?: number | null;
      /** Public contact phone number, when set. */
      phone?: string | null;
      /** Public website URL, when set. */
      website?: string | null;
      /** Whether this venue is currently opted in to receiving booking requests. */
      acceptsBookingRequests?: boolean;
      /** Derived public flag — true only when the place is VERIFIED. */
      verified?: boolean;
      /**
       * True when the place can be claimed right now (ACTIVE, unverified, no
       * verified owner, no claim in review): the same answer
       * `getPlaceClaimEligibility` gives. Server hint for the hero claim chip.
       * Optional: client fallback summaries omit it, and absent reads as false.
       */
      claimable?: boolean;
      /**
       * Owner opt-in for the PUBLIC attendee/audience review aggregate
       * (venue-rating-block-and-owner-optin FR-004/FR-005). Default false =
       * the audience_stats block renders nothing publicly. Governs ONLY the
       * attendee aggregate — never the performer venue_stats surface (FR-007).
       */
      attendeeReviewsPublic?: boolean;
      /**
       * The PERFORMER-tier switch (venue-track-record-and-review-switch
       * FR-001/FR-003). False = the `venue_stats` block is not loaded.
       * Server-internal like its sibling above; never shipped to a client.
       */
      communityReviewsEnabled?: boolean;
    };

/**
 * Single source of truth for whether a venue surfaces its booking-request CTAs.
 *
 * A PLACE exposes the booking surfaces — the hero "Request to play" button
 * (`PlaceHero`) and the in-column `request_to_play` block (gated in
 * `EntityPageShell`) — only when it is VERIFIED and the owner has opted in.
 * Both call sites use this predicate so the two surfaces can never drift. Strict
 * `=== true` on both fields keeps the boolean semantics identical regardless of
 * the optional fields' `undefined` defaults. Pure + client-safe (no deps).
 */
export function placeAcceptsBookingRequests(entity: EntitySummary): boolean {
  return (
    entity.type === "PLACE" &&
    entity.acceptsBookingRequests === true &&
    entity.verified === true
  );
}

/**
 * Whether a performer entity (HUMAN or ORGANIZATION act) surfaces the
 * "Request to book" CTA (organizer-booking-requests FR-009) — the performer
 * sibling of {@link placeAcceptsBookingRequests}. The server sets
 * `acceptsBookingRequests` only when the entity is performer-enabled AND
 * opted in (`get-public-page`), so a strict `=== true` here is the whole
 * gate; `undefined` (client fallback summaries) stays falsy. Pure +
 * client-safe (no deps).
 */
export function performerAcceptsBookingRequests(
  entity: EntitySummary,
): boolean {
  return (
    (entity.type === "HUMAN" || entity.type === "ORGANIZATION") &&
    entity.acceptsBookingRequests === true
  );
}
