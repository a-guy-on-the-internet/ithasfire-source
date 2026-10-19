import type { PageVisibility } from "./entity-pages";

import type { EventLocationMode } from "./events";

import type { PlaceOwnerType } from "./place-verification";

export type PlaceStatus = "ACTIVE" | "SUSPENDED" | "ARCHIVED";

export type PlaceVerificationStatus =
  | "UNVERIFIED"
  | "VERIFIED"
  | "PENDING"
  | "REJECTED";

export type PlaceWebsiteSource = "TRUSTED_IMPORT" | "USER_STUB" | "UNKNOWN";

export interface PlaceRecord {
  id: string;
  name: string;
  /** When the place row was created. Surfaced in admin tables. */
  createdAt: Date;
  /** Last persisted update. Useful for "edited 2d ago" hints. */
  updatedAt: Date;
  formattedAddress: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  capacity: number | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  /**
   * Provenance of `website`. Only TRUSTED_IMPORT unlocks the claim
   * email-domain fast-track (FR-010). Existing rows are UNKNOWN.
   */
  websiteSource: PlaceWebsiteSource;
  /**
   * Normalized lowercase address used for dedup/search. Surfaced so use cases
   * can detect address changes (e.g. to decide whether to refresh the cached
   * tax rate). Null on legacy rows created before the column existed.
   */
  addressHash: string | null;
  /**
   * Cached admission tax rate in basis points (e.g. 975 = 9.75%). Null = not
   * yet resolved or tax-free jurisdiction. Looked up via the tax provider on
   * place create / address change and as a publish-time safety net.
   */
  admissionTaxRateBps: number | null;
  /** Source of the cached rate: "ziptax" | "manual" | "seed" | null. */
  taxRateSource: string | null;
  /** When the cached rate was last fetched. Null until first lookup. */
  taxRateFetchedAt: Date | null;
  /**
   * IANA timezone (e.g. "America/Chicago"), derived from the place's address
   * coordinates on create / address change (venue-hierarchy FR-004; same
   * lookup-and-cache lifecycle as the admission tax rate above). Null until
   * the first successful lookup — consumers fall back to the platform-default
   * zone.
   */
  timezone: string | null;
  /**
   * ADDRESS PRIVACY — the same three-state model an Event carries, on the venue
   * itself (place-address-withholding). Reuses `EventLocationMode` so an event
   * can inherit the venue's state directly rather than translating between two
   * enums that would drift.
   *
   *   EXACT                       → full public address + coordinates.
   *   OBSCURED + radius non-null  → public map is an obfuscated circle.
   *   OBSCURED + radius null      → FULLY HIDDEN: no map, no coordinates, no
   *                                 street address on ANY public surface.
   *
   * NEVER PROJECT `formattedAddress` / `addressLine1` / `addressLine2` /
   * `postalCode` / `lat` / `lng` OFF THIS RECORD ONTO A PUBLIC SURFACE. Route
   * them through `redactPlaceLocation`
   * (packages/core/src/lib/location/redact-place-location.ts), which is
   * fail-closed on this field: anything other than the literal "EXACT" is
   * treated as withheld.
   */
  locationMode: EventLocationMode;
  /**
   * Public pre-reveal precision for an OBSCURED place: obfuscation radius in
   * metres, or NULL = FULLY HIDDEN (no public coordinate at all — the
   * documented sentinel, identical to `Event.locationRadiusMeters`). Ignored
   * while `locationMode` is EXACT.
   */
  locationRadiusMeters: number | null;
  /**
   * Coarse, publishable area label for a withheld place (e.g. "East
   * Nashville") — the mirror of `Event.locationLabel`, and the ONLY place
   * string a withheld venue publishes. Null falls back to "city, region".
   */
  locationLabel: string | null;
  status: PlaceStatus;
  verificationStatus: PlaceVerificationStatus;
  /** Whether this place appears in the public venue directory / autocomplete. */
  listedInDirectory: boolean;
  /** Whether this verified venue accepts inbound booking requests from performers. */
  acceptsBookingRequests: boolean;
  /**
   * The venue owner's standing consent to OWNERLESS community listings at this
   * place (community-listings-at-claimed-venues FR-001). Read ONLY through
   * `isVenueConfirmed` — it is the third arm of the confirmation derivation,
   * never a stored verdict. Accepted listings also OCCUPY their slot for
   * booking availability. Reset to false when ownership is revoked.
   */
  acceptsCommunityListings: boolean;
  /**
   * Owner opt-in that publishes the ATTENDEE/customer review aggregate on the
   * public venue page (venue-rating-block-and-owner-optin FR-004). Default
   * false = private owner feedback. Governs ONLY the attendee aggregate — never
   * performer (PlaceReview) data.
   */
  attendeeReviewsPublic: boolean;
  /**
   * The PERFORMER-tier switch (venue-track-record-and-review-switch FR-001,
   * reversing 2026-07-23 FR-007). False = the place refuses new `PlaceReview`
   * submissions and hides every public performer surface; rows already
   * written stay readable by the owner. Governs ONLY the performer tier —
   * never `attendeeReviewsPublic` / `AttendeeReview` / `audience_stats`.
   * Column default true; `upsertPlace` defaults a withheld-location place to
   * false at creation (R3).
   */
  communityReviewsEnabled: boolean;
  orgIdsWithAccess: string[];
  humanIdsWithAccess: string[];
  /** FK to the place-level default PRIMARY PayoutTerms. */
  defaultPrimaryPayoutTermsId: string | null;
  /** FK to the place-level default RESALE PayoutTerms. */
  defaultResalePayoutTermsId: string | null;
}

export type PlaceOwnerInput =
  | { kind: "org"; orgId: string }
  | { kind: "human"; humanId: string };

export interface PlaceAddressInput {
  formatted: string;
  /**
   * OMITTED = leave the stored `addrLine1` alone (NULL on create), like the
   * other optional fields below. `updateCommunityPlace`'s name-only edit
   * omits it so a stored NULL line is not rewritten as `""`.
   */
  line1?: string;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode: string;
}

export interface PlaceGeoInput {
  lat?: number | null;
  lng?: number | null;
}

/**
 * OMITTING an optional field means "leave the stored value alone"; passing an
 * explicit `null` means "clear it".
 *
 * This distinction is load-bearing and was invisible here for a long time,
 * which is how a whole bug class grew: the adapter used to coerce `undefined`
 * to `null`, so any caller that rebuilt a place from a `PlaceRecord` just to
 * flip ONE field silently wiped every field it didn't re-send.
 * `set-default-payout-terms` rebuilt from only formatted/line1/countryCode and
 * therefore nulled city/region/postcode/capacity, reset an ARCHIVED venue to
 * ACTIVE, and demoted a VERIFIED venue to UNVERIFIED; `toggle-place-directory-
 * listing` omitted `geo` and erased the venue's coordinates.
 *
 * If you are rebuilding a place to change one thing, send ONLY that thing —
 * do not defensively re-send `?? null` values, which is how a "preserve"
 * becomes a "clear". Regression tests:
 * `packages/adapters/src/db/prisma/__tests__/places-upsert-preserve.test.ts`.
 */
export interface UpsertPlaceInput {
  placeId?: string | null;
  owner?: PlaceOwnerInput | null;
  /**
   * Whether the upserted `owner` ownership row is verified. Defaults to `true`
   * to preserve every existing caller (org/human create paths). The claim flow
   * passes `false` to write a PROVISIONAL ownership that grants no edit access.
   */
  ownerVerified?: boolean;
  name: string;
  address: PlaceAddressInput;
  geo?: PlaceGeoInput | null;
  capacity?: number | null;
  phone?: string | null;
  website?: string | null;
  /** Provenance marker for `website` (FR-010 fast-track gate). */
  websiteSource?: PlaceWebsiteSource;
  status?: PlaceStatus;
  verificationStatus?: PlaceVerificationStatus;
  /** Whether this place appears in the public venue directory / autocomplete. */
  listedInDirectory?: boolean;
  /** Whether this verified venue accepts inbound booking requests from performers. */
  acceptsBookingRequests?: boolean;
  /**
   * Venue-owner consent to ownerless COMMUNITY listings at this place (FR-001).
   * OMITTED = preserve the stored value (see the note above) — only send it
   * when you mean to change it.
   */
  acceptsCommunityListings?: boolean;
  /**
   * ADDRESS PRIVACY. OMITTED = preserve the stored value (see the note above);
   * only send it when you mean to change it.
   *
   * On CREATE the adapter does NOT invent a value — `upsertPlace` decides,
   * and the public "add a venue" flow picks OBSCURED so that someone listing
   * their home is withheld by default rather than by settings-page visit.
   */
  locationMode?: EventLocationMode;
  /**
   * Obfuscation radius in metres (100..50,000, DB-CHECKed), or `null` =
   * FULLY HIDDEN. OMITTED preserves; explicit `null` sets the fully-hidden
   * sentinel — which is why this one's `null` is MEANINGFUL, not a clear.
   */
  locationRadiusMeters?: number | null;
  /** Coarse public area label for a withheld place. OMITTED preserves. */
  locationLabel?: string | null;
  /** Owner opt-in to publish the attendee/customer review aggregate (FR-004). */
  attendeeReviewsPublic?: boolean;
  /**
   * Performer-review switch (FR-001). OMITTED preserves; the adapter never
   * invents a value on CREATE — `upsertPlace` decides (R3).
   */
  communityReviewsEnabled?: boolean;
  /** FK to the place-level default PRIMARY PayoutTerms. */
  defaultPrimaryPayoutTermsId?: string | null;
  /** FK to the place-level default RESALE PayoutTerms. */
  defaultResalePayoutTermsId?: string | null;
}

export interface PlaceSitemapEntryRecord {
  placeId: string;
  /**
   * The place's EntityPage slug — the ONLY identifier `/p/[slug]` resolves on.
   * Deliberately NOT `Place.slug` (a multi-segment directory key that no route
   * resolves). Null when the place has no EntityPage row.
   *
   * A NON-NULL slug here is NOT permission to publish it — read it together
   * with {@link PlaceSitemapEntryRecord.pageVisibility}. The sitemap use case
   * drops any row that is not publishable.
   */
  pageSlug: string | null;
  /**
   * The page's owner-set visibility, carried so the POLICY stays in core
   * (`lib/entity-page-visibility`) rather than being buried in a repo `where`.
   *
   * Both non-PUBLIC values must stay out of the sitemap, for different reasons:
   *   · PRIVATE — `get-public-page` throws PAGE_NOT_FOUND and the route 404s,
   *     so publishing it feeds crawlers a guaranteed dead URL;
   *   · UNLISTED — renders fine, but the owner was promised "it stays out of
   *     search and browse" when they chose it. A sitemap is precisely the
   *     crawler-discovery surface that promise excludes.
   * Null when the place has no EntityPage.
   */
  pageVisibility: PageVisibility | null;
  updatedAt: Date | null;
}

export interface BulkCreatePlaceInput {
  id: string;
  name: string;
  address: PlaceAddressInput;
  geo?: PlaceGeoInput | null;
  /**
   * OMITTING `owner` creates an UNOWNED place — the cold-start bulk-import
   * state, and the one the platform CSV importer uses for scraped venues.
   *
   * This is load-bearing, not a convenience: `getPlaceClaimEligibility` reads
   * `getVerifiedOwnershipForPlace` and returns `already_claimed` /
   * `verified_owner_exists` the moment ANY verified ownership row exists. The
   * importer used to stamp the importing staff human as a VERIFIED owner of
   * every scraped venue, which permanently pushed the venue's real operator off
   * the claim path and onto the dispute path. No owner ⇒ no ownership row ⇒
   * the venue stays `claimable`.
   *
   * Unlike `UpsertPlaceInput` — where omitted and `null` mean different things
   * (preserve vs. clear) — this is a CREATE-only input, so there is nothing to
   * preserve: an explicit `null` is exactly equivalent to omitting the field.
   * Pinned by `places-bulk-create-ownership.test.ts`.
   */
  owner?: PlaceOwnerInput | null;
  capacity?: number | null;
  phone?: string | null;
  website?: string | null;
  /**
   * Provenance of `website`. Defaults to `UNKNOWN` in the adapter — bulk import
   * is NOT trusted by default.
   *
   * `TRUSTED_IMPORT` must be an explicit opt-in from a curated feed, because it
   * arms the FR-010 claim fast-track (auto-verify an email_domain_match with no
   * admin review). Neither scraped importer — the platform CSV paste nor the MCP
   * `import_places` tool — sets it.
   */
  websiteSource?: PlaceWebsiteSource;
  listedInDirectory?: boolean;
}

/** Sortable columns for the accessible-places listing (admin Places table). */
export type ListAccessiblePlacesSortField =
  | "name"
  | "created"
  | "capacity"
  | "status";

/**
 * Sort applied in SQL BEFORE pagination (a page is a window over the fully
 * sorted result set, not a client-side reshuffle of one page).
 */
export interface ListAccessiblePlacesSort {
  field: ListAccessiblePlacesSortField;
  direction: "asc" | "desc";
}

/**
 * Lifecycle scope for the accessible-places listing.
 * - "active": status != ARCHIVED (includes SUSPENDED)
 * - "archived": status == ARCHIVED
 * - "all": no status constraint
 */
export type ListAccessiblePlacesStatusFilter = "active" | "archived" | "all";

/**
 * Row returned by {@link ListAccessiblePlacesByHumanInput} listings:
 * a PlaceRecord plus list-only aggregates.
 */
export interface PlaceListItemRecord extends PlaceRecord {
  /**
   * Number of PUBLISHED events located at this place (Event.placeId FK).
   * Deliberately scoped to PUBLISHED only — the listing includes
   * globally-VERIFIED venues the actor does NOT own, and counting other
   * organizers' DRAFT/CANCELLED/etc. rows would leak cross-tenant activity
   * metadata. Events have no soft-delete column (deletion is a hard delete
   * via the object-deletion outbox), so no deleted-rows exclusion is needed.
   */
  eventsCount: number;
}

export interface ListAccessiblePlacesByHumanInput {
  humanId: string;
  orgIds?: string[];
  /**
   * Case-insensitive substring over `name`, `city` and — for EXACT places
   * ONLY — the street `address`. A venue that withholds its address is never
   * matched on its street: inclusion in the result would answer "does the
   * street contain this text?" (see the adapter).
   */
  query?: string;
  limit?: number;
  offset?: number;
  /**
   * Sort applied BEFORE pagination. Defaults to name asc (stable id
   * tiebreak). `capacity` sorts nulls last in both directions.
   */
  sort?: ListAccessiblePlacesSort;
  /**
   * Lifecycle scope, applied BEFORE pagination and reflected in
   * pageInfo.total (so pagination never lies about filtered rows).
   * undefined = LEGACY behavior: status == ACTIVE only. Every pre-existing
   * caller (event-builder place picker, org-admin search, bookings hub)
   * relies on that scope, so the default deliberately preserves it —
   * pass an explicit value to opt into the wider scopes.
   */
  status?: ListAccessiblePlacesStatusFilter;
  /**
   * When true, include unverified places created/owned by the actor human or one of their orgs.
   * Verified places are always included.
   */
  includeOwnedUnverified?: boolean;
  /**
   * When true, only return places where the actor human or one of their orgs
   * has an ownership record. Globally verified places that the actor does NOT
   * own are excluded. Useful for the admin "my places" view.
   */
  ownedOnly?: boolean;
  /**
   * `ownedOnly` + `orgIds` normally means "this ORG's venues, and only those"
   * — the event-builder / place-picker case, where a venue the person happens
   * to own personally is not one the org can use. Set this to ALSO include the
   * actor's own directly-owned places in that scope.
   *
   * The personal admin context is the caller: it is a HUB, not a tenant, so
   * "your venues" there means the ones you hold yourself PLUS the ones your
   * orgs hold. Defaults to false so every existing org-scoped picker keeps its
   * exact result set.
   */
  includeActorOwnedWithOrgs?: boolean;
}

/**
 * Input for the OWNER-centric, actor-free place lookup
 * ({@link PlacesRepo.listOwnedBySubject}).
 *
 * Unlike {@link ListAccessiblePlacesByHumanInput} — which asks "what can this
 * ACTOR reach?" and therefore requires a `humanId` — this asks "what does this
 * SUBJECT own?". Public surfaces (the embed widget read paths) have no actor
 * at all, so they cannot use the accessible-by-human lister.
 */
export interface ListOwnedPlacesBySubjectInput {
  ownerType: PlaceOwnerType;
  ownerId: string;
  /** Cap on returned places. Adapter clamps to a sane maximum. */
  limit?: number;
}

/**
 * Input for {@link PlacesRepo.listWithheldOwnedNearPoint}: the SUBJECTS whose
 * places may be returned (a human directly, and the orgs the caller has
 * already filtered to the ones the human may manage), and the point.
 */
export interface ListWithheldOwnedNearPointInput {
  /** Places this human owns directly (verified, unrevoked). */
  humanId: string;
  /** Places these orgs own (verified, unrevoked). Empty = none. */
  orgIds: readonly string[];
  lat: number;
  lng: number;
  /**
   * Search half-width in metres around the point. The adapter matches a
   * bounding box at least this wide; the caller measures the true distance.
   * Clamped to [1, 1000].
   */
  withinMeters: number;
  /** Cap on returned places. Default 5, clamped to [1, 20]. */
  limit?: number;
}

/**
 * Input for the staff-facing "list all places" query.
 * Supports filtering by verification status and free-text search.
 */
export interface ListAllPlacesInput {
  verificationStatus?: PlaceVerificationStatus[];
  status?: PlaceStatus[];
  /** When set, filter by the directory-listing flag. */
  listedInDirectory?: boolean;
  /**
   * When set, only these place ids (exact match, ANDed with the other
   * filters). An empty array matches nothing; `listPlatformPlaces`
   * refuses one before it gets here.
   */
  placeIds?: string[];
  query?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Place slug types — DELIBERATELY EMPTY
// ---------------------------------------------------------------------------
//
// `Place.slug` is deprecated. It was a multi-segment DIRECTORY key
// (`{country}/{region}/{name}--{shortId}`, literal `/` included) that no route
// ever resolved: `/places/[slug]` and `/p/[slug]` are single non-catch-all
// segments and they resolve the place's `EntityPage.slug`, a separate FLAT
// slug (`{name}-{id8}`). Nothing mints it and nothing reads it any more, so
// `PlaceSlugContext` / `AssignPlaceSlugInput` / `RecordPlaceSlugHistoryInput`
// / `PlaceSlugResolution` are gone along with the repo methods that used them.
// The column and `PlaceSlugHistory` are dropped separately.
//
// A place's addressable slug is `EntityPage.slug`. Use that, or `placeId`.
